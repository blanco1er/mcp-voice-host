// MCP Apps host bridge (spec 2026-01-26): the JSON-RPC conversation between the host and one View.
// DOM-free on purpose, so the protocol is unit-tested in Node. `apps-host.js` wires it to the sandbox iframes.
//
// Host → View: ui/initialize result, ui/notifications/tool-input, tool-result, tool-cancelled,
//              host-context-changed, ui/resource-teardown.
// View → Host: ui/initialize, ui/notifications/initialized, size-changed, tools/call, resources/read,
//              resources/list, ui/message, ui/open-link, ui/update-model-context, ui/request-display-mode,
//              notifications/message, ping.
// Rules enforced: nothing is sent to the View before `ui/notifications/initialized`; tool-input is sent once and
// before tool-result; a View can only call tools whose visibility includes "app"; display modes are limited to
// what both sides declared.

export const APPS_PROTOCOL_VERSION = '2026-01-26';

export class ViewBridge {
  /**
   * @param {object} o
   * @param {(msg:object) => void} o.post            deliver a message to the View
   * @param {{callTool:Function, readResource:Function, listResources?:Function}} o.mcp
   * @param {() => object} o.hostContext             current host context (theme, displayMode, containerDimensions…)
   * @param {object[]} [o.tools]                     tools/list, for visibility checks
   * @param {object} [o.hostInfo]
   * @param {object} [o.on]  hooks: log, message, openLink, modelContext, displayMode, size, toolResult, initialized
   */
  constructor({ post, mcp, hostContext, tools = [], hostInfo = { name: 'mcp-voice-host', version: '0.1.0' }, on = {} }) {
    Object.assign(this, { postRaw: post, mcp, getContext: hostContext, tools, hostInfo, on });
    this.initialized = false;
    this.appCapabilities = null;
    this.appInfo = null;
    this.call = null; // { toolName, args, result?, cancelled? }
    this.sentInput = false;
    this.sentResult = false;
    this.queue = [];
    this.reqId = 0;
    this.waiters = new Map();
    this.modelContext = null;
    this.closed = false;
  }

  log(dir, msg) { this.on.log?.(dir, msg); }
  post(msg) { if (this.closed) return; this.log('host → view', msg); this.postRaw(msg); }
  notify(method, params) { this.post({ jsonrpc: '2.0', method, params }); }
  // Notifications that must wait for `initialized` are queued, then flushed in order.
  notifyWhenReady(method, params) {
    if (this.initialized) this.notify(method, params);
    else this.queue.push([method, params]);
  }

  /** The tool call this View belongs to. The result may come later (setResult). */
  start({ toolName, args = {}, result = null }) {
    this.call = { toolName, args, result };
    this.flushCall();
  }
  setResult(result) {
    if (!this.call) return;
    this.call.result = result;
    this.flushCall();
  }
  cancel(reason = 'cancelled by the user') {
    if (!this.call || this.sentResult) return;
    this.call.cancelled = reason;
    if (this.initialized) this.notify('ui/notifications/tool-cancelled', { reason });
  }
  flushCall() {
    if (!this.initialized || !this.call) return;
    if (!this.sentInput) { this.sentInput = true; this.notify('ui/notifications/tool-input', { arguments: this.call.args || {} }); }
    if (this.call.result && !this.sentResult) { this.sentResult = true; this.notify('ui/notifications/tool-result', this.call.result); }
    else if (this.call.cancelled && !this.sentResult) this.notify('ui/notifications/tool-cancelled', { reason: this.call.cancelled });
  }

  /** Partial host context update (theme, displayMode, containerDimensions…). */
  contextChanged(patch) {
    if (!patch || !Object.keys(patch).length) return;
    if (this.initialized) this.notify('ui/notifications/host-context-changed', patch);
  }

  /** Ask the View to clean up; resolves when it answers or after `timeout` ms. */
  teardown(reason = 'replaced', timeout = 400) {
    if (!this.initialized || this.closed) { this.closed = true; return Promise.resolve(); }
    const id = `teardown-${++this.reqId}`;
    return new Promise((resolve) => {
      const done = () => { this.waiters.delete(id); this.closed = true; resolve(); };
      this.waiters.set(id, done);
      this.post({ jsonrpc: '2.0', id, method: 'ui/resource-teardown', params: { reason } });
      setTimeout(done, timeout);
    });
  }

  canUseTool(name) {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) return { ok: false, why: `Unknown tool: ${name}` };
    const v = tool._meta?.ui?.visibility;
    if (Array.isArray(v) && !v.includes('app')) return { ok: false, why: `Tool ${name} is not visible to apps (visibility: ${JSON.stringify(v)})` };
    return { ok: true, tool };
  }

  /** Handle one message from the View. Returns a promise for tests. */
  async handle(m) {
    if (this.closed || !m || m.jsonrpc !== '2.0') return;
    this.log('view → host', m);
    // a response to one of our requests (teardown)
    if (m.id !== undefined && m.id !== null && !m.method) {
      const w = this.waiters.get(m.id);
      if (w) w();
      return;
    }
    const isRequest = m.id !== undefined && m.id !== null;
    const reply = (result) => { if (isRequest) this.post({ jsonrpc: '2.0', id: m.id, result }); };
    const fail = (message, code = -32000) => { if (isRequest) this.post({ jsonrpc: '2.0', id: m.id, error: { code, message } }); };
    const p = m.params || {};
    switch (m.method) {
      case 'ui/initialize': {
        this.appCapabilities = p.appCapabilities || null;
        this.appInfo = p.appInfo || p.clientInfo || null;
        const ctx = this.getContext();
        return reply({
          protocolVersion: APPS_PROTOCOL_VERSION,
          hostInfo: this.hostInfo,
          hostCapabilities: { openLinks: {}, serverTools: {}, serverResources: {}, logging: {} },
          hostContext: { ...ctx, availableDisplayModes: this.displayModes(ctx) },
        });
      }
      case 'ui/notifications/initialized':
        if (this.initialized) return;
        this.initialized = true;
        this.on.initialized?.();
        for (const [method, params] of this.queue.splice(0)) this.notify(method, params);
        this.flushCall();
        return;
      case 'ui/notifications/size-changed':
        this.on.size?.({ width: p.width, height: p.height });
        return;
      case 'notifications/message':
        this.on.viewLog?.(p);
        return;
      case 'ping':
        return reply({});
      case 'tools/call': {
        const can = this.canUseTool(p.name);
        if (!can.ok) return fail(can.why, -32602);
        try {
          const started = Date.now();
          const r = await this.mcp.callTool(p.name, p.arguments || {});
          this.on.toolResult?.({ tool: can.tool, args: p.arguments || {}, result: r, ms: Date.now() - started, from: 'view' });
          return reply(r);
        } catch (err) { return fail(err.message || String(err), err.code ?? -32603); }
      }
      case 'resources/read':
        try { return reply(await this.mcp.readResource(p.uri)); } catch (err) { return fail(err.message || String(err), err.code ?? -32603); }
      case 'resources/list':
        try { return reply({ resources: this.mcp.listResources ? await this.mcp.listResources() : [] }); } catch (err) { return fail(err.message || String(err)); }
      case 'ui/open-link': {
        let url;
        try { url = new URL(p.url); } catch { return fail('Invalid URL'); }
        if (!/^https?:$/.test(url.protocol)) return fail('Invalid URL');
        this.on.openLink?.(url.href);
        return reply({});
      }
      case 'ui/message': {
        const blocks = Array.isArray(p.content) ? p.content : p.content ? [p.content] : [];
        const text = blocks.filter((c) => c && c.type === 'text').map((c) => c.text).join(' ').trim();
        if (!text) return fail('Invalid message format');
        reply({});
        this.on.message?.(text, p.role || 'user');
        return;
      }
      case 'ui/update-model-context':
        this.modelContext = { content: p.content || null, structuredContent: p.structuredContent || null };
        this.on.modelContext?.(this.modelContext);
        return reply({});
      case 'ui/request-display-mode': {
        const ctx = this.getContext();
        const current = ctx.displayMode || 'inline';
        const allowed = this.displayModes(ctx);
        const mode = allowed.includes(p.mode) ? p.mode : current;
        if (mode !== current) this.on.displayMode?.(mode);
        return reply({ mode });
      }
      default:
        if (isRequest) return fail(`Method not found: ${m.method}`, -32601);
    }
  }

  // Modes offered = host modes ∩ modes the View declared (when it declared any).
  displayModes(ctx = this.getContext()) {
    const host = ctx.availableDisplayModes || ['inline'];
    const view = this.appCapabilities?.availableDisplayModes;
    return Array.isArray(view) ? host.filter((m) => view.includes(m)) : host;
  }
}
