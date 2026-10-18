// Renders one MCP App View inside the double-iframe sandbox and connects it to a ViewBridge.
//
//   host page ── postMessage ──> sandbox proxy (other origin) ── postMessage ──> View (inner iframe)
//
// Isolation modes:
//   "origin"  the CLI serves sandbox.html on a second port (a different origin, as the spec requires),
//             with the View's CSP as an HTTP header.
//   "opaque"  static hosting without the CLI: sandbox.html is loaded with sandbox="allow-scripts" only, which
//             gives it an opaque origin; the CSP comes from the injected <meta> tag. Less strict, said in the UI.
import { ViewBridge } from './bridge.js';
import { buildCsp, injectCspMeta } from './csp.js';

export class AppsHost {
  /**
   * @param {object} o
   * @param {HTMLElement} o.container
   * @param {string} o.sandboxUrl       absolute URL of sandbox.html
   * @param {'origin'|'opaque'} o.isolation
   * @param {object} o.mcp              McpHttpClient
   * @param {() => object} o.hostContext
   * @param {() => object[]} o.tools
   * @param {object} [o.on]             forwarded to ViewBridge hooks (+ `size`)
   */
  constructor({ container, sandboxUrl, isolation = 'origin', mcp, hostContext, tools, on = {} }) {
    Object.assign(this, { container, sandboxUrl, isolation, mcp, hostContext, tools, on });
    this.frame = null;
    this.bridge = null;
    this.sandboxOrigin = isolation === 'origin' ? new URL(sandboxUrl).origin : '*';
    this.onWindowMessage = (e) => this.receive(e);
    window.addEventListener('message', this.onWindowMessage);
  }

  get active() { return Boolean(this.frame); }

  async clear(reason = 'replaced') {
    const old = this.bridge, frame = this.frame;
    this.bridge = null; this.frame = null;
    if (old) await old.teardown(reason);
    frame?.remove();
  }

  /**
   * Show a View for one tool call.
   * @param {object} p
   * @param {string} p.html      resources/read text
   * @param {object} [p.meta]    resource `_meta.ui` (csp, permissions, prefersBorder)
   * @param {object} p.tool      tool from tools/list
   * @param {object} p.args
   * @param {object} [p.result]  CallToolResult (or later via setResult)
   */
  async show({ html, meta = {}, tool, args, result }) {
    await this.clear('replaced');
    const policy = buildCsp(meta.csp);
    this.on.csp?.({ uri: meta.uri, policy, isolation: this.isolation });
    const url = new URL(this.sandboxUrl);
    url.searchParams.set('host', location.origin);
    if (this.isolation === 'origin') url.searchParams.set('csp', JSON.stringify(meta.csp || {}));
    const f = document.createElement('iframe');
    f.className = 'app-frame';
    f.title = `${tool.title || tool.name} view`;
    f.setAttribute('sandbox', this.isolation === 'origin' ? 'allow-scripts allow-same-origin allow-forms' : 'allow-scripts allow-forms');
    if (meta.permissions?.microphone || meta.permissions?.camera) f.setAttribute('allow', ['camera', 'microphone'].filter((k) => meta.permissions[k]).join('; '));
    f.src = url.href;
    const bridge = new ViewBridge({
      post: (msg) => f.contentWindow?.postMessage(msg, this.sandboxOrigin),
      mcp: this.mcp,
      hostContext: () => ({ ...this.hostContext(), toolInfo: { tool } }),
      tools: this.tools(),
      on: {
        ...this.on,
        initialized: () => { f.classList.add('in'); clearTimeout(this.initTimer); this.on.initialized?.(); },
      },
    });
    this.pendingHtml = injectCspMeta(html, policy);
    this.pendingMeta = meta;
    this.frame = f;
    this.bridge = bridge;
    bridge.start({ toolName: tool.name, args, result });
    this.container.replaceChildren(f);
    clearTimeout(this.initTimer);
    this.initTimer = setTimeout(() => { if (this.bridge === bridge && !bridge.initialized) { f.classList.add('in'); this.on.noInitialize?.(tool); } }, 3000);
  }

  setResult(result) { this.bridge?.setResult(result); }
  contextChanged(patch) { this.bridge?.contextChanged(patch); }

  receive(e) {
    if (!this.frame || e.source !== this.frame.contentWindow) return;
    if (this.isolation === 'origin' && e.origin !== this.sandboxOrigin) return;
    const m = e.data;
    if (!m || m.jsonrpc !== '2.0') return;
    if (m.method === 'ui/notifications/sandbox-proxy-ready') {
      const params = { html: this.pendingHtml, csp: this.pendingMeta?.csp || {} };
      if (this.pendingMeta?.permissions) params.permissions = this.pendingMeta.permissions;
      this.on.log?.('host→sandbox', { jsonrpc: '2.0', method: 'ui/notifications/sandbox-resource-ready', params: { ...params, html: `[${params.html.length} characters]` } });
      this.frame.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-resource-ready', params }, this.sandboxOrigin);
      return;
    }
    this.bridge?.handle(m);
  }

  destroy() { window.removeEventListener('message', this.onWindowMessage); this.clear('host closed'); }
}
