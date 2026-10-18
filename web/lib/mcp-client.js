// Minimal MCP client over Streamable HTTP (MCP spec 2025-11-25). No dependencies, no build step:
// runs unchanged in the browser and in Node 20+ (tests).
//
// - JSON-RPC 2.0 over POST; accepts `application/json` and `text/event-stream` replies.
// - SSE replies are parsed incrementally, so a server can send requests (elicitation, roots, ping) in the middle
//   of a tools/call stream and get its answer before the final result arrives.
// - Keeps `Mcp-Session-Id` when the server issues one and sends `MCP-Protocol-Version` after initialize.
// - Advertises the MCP Apps extension (`io.modelcontextprotocol/ui`, spec 2026-01-26).
// - Optional local proxy: every request goes to `proxy.url` with the real target in `x-mvh-target`
//   (lets the page reach servers that send no CORS headers or reject browser Origins).
// - Every message in or out is reported to `onLog(direction, message, meta)` for the traffic inspector.

export const PROTOCOL_VERSION = '2025-11-25';
export const UI_EXTENSION = 'io.modelcontextprotocol/ui';
export const UI_MIME = 'text/html;profile=mcp-app';

export class McpError extends Error {
  constructor(message, { code, data, status } = {}) {
    super(message);
    this.name = 'McpError';
    Object.assign(this, { code, data, status });
  }
}

// Incremental Server-Sent Events parser (WHATWG event-stream rules, the subset MCP uses: data / event / id).
export function createSseParser(onEvent) {
  let buf = '';
  let data = [];
  let event = '';
  let id = null;
  const dispatch = () => {
    if (data.length) onEvent({ event: event || 'message', data: data.join('\n'), id });
    data = []; event = '';
  };
  return {
    push(chunk) {
      buf += chunk;
      let nl;
      while ((nl = buf.search(/\r\n|\r|\n/)) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + (buf[nl] === '\r' && buf[nl + 1] === '\n' ? 2 : 1));
        if (line === '') { dispatch(); continue; }
        if (line.startsWith(':')) continue;
        const i = line.indexOf(':');
        const field = i < 0 ? line : line.slice(0, i);
        let value = i < 0 ? '' : line.slice(i + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') data.push(value);
        else if (field === 'event') event = value;
        else if (field === 'id') id = value;
      }
    },
    end() { if (buf) { this.push('\n'); } dispatch(); },
  };
}

export class McpHttpClient {
  /**
   * @param {string} url  Streamable HTTP endpoint, e.g. https://example.com/mcp
   * @param {object} [o]
   * @param {Record<string,string>} [o.headers]  extra headers (e.g. Authorization)
   * @param {{url:string, token?:string}} [o.proxy]  same-origin proxy served by the CLI
   * @param {(dir:'out'|'in', msg:object, meta?:object) => void} [o.onLog]
   * @param {(req:{method:string, params:object}) => Promise<object>} [o.onServerRequest]  answer server→client requests
   * @param {(msg:object) => void} [o.onNotification]  server→client notifications
   * @param {typeof fetch} [o.fetch]
   * @param {object} [o.clientInfo]
   */
  constructor(url, o = {}) {
    this.url = url;
    this.headers = o.headers || {};
    this.proxy = o.proxy || null;
    this.onLog = o.onLog || (() => {});
    this.onServerRequest = o.onServerRequest || null;
    this.onNotification = o.onNotification || (() => {});
    this.fetch = o.fetch || ((...a) => globalThis.fetch(...a));
    this.clientInfo = o.clientInfo || { name: 'mcp-voice-host', version: '0.1.0' };
    this.id = 0;
    this.sessionId = null;
    this.protocolVersion = null;
    this.serverInfo = null;
    this.capabilities = null;
    this.instructions = null;
  }

  requestHeaders(extra = {}) {
    const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...this.headers, ...extra };
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    if (this.protocolVersion) h['mcp-protocol-version'] = this.protocolVersion;
    if (this.proxy) {
      h['x-mvh-target'] = this.url;
      if (this.proxy.token) h['x-mvh-token'] = this.proxy.token;
    }
    return h;
  }

  endpoint() { return this.proxy ? this.proxy.url : this.url; }

  // Send one JSON-RPC message. Resolves with the response whose id matches (or null for notifications/responses).
  async post(message, { signal } = {}) {
    const started = Date.now();
    this.onLog('out', message);
    let res;
    try {
      res = await this.fetch(this.endpoint(), { method: 'POST', headers: this.requestHeaders(), body: JSON.stringify(message), signal });
    } catch (err) {
      throw new McpError(`Cannot reach the MCP server (${err.message || err}).`, { code: 'network' });
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (res.status === 202 || res.status === 204) return null;
    const type = res.headers.get('content-type') || '';
    const expectId = message.id;
    if (type.includes('text/event-stream') && res.body) {
      let reply = null;
      const pending = [];
      const parser = createSseParser(({ data }) => {
        if (!data) return;
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        this.onLog('in', msg, { ms: Date.now() - started });
        if (msg.id !== undefined && msg.id === expectId && ('result' in msg || 'error' in msg)) reply = msg;
        else pending.push(this.handleIncoming(msg));
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.push(dec.decode(value, { stream: true }));
        if (reply) { reader.cancel().catch(() => {}); break; }
      }
      parser.end();
      await Promise.allSettled(pending);
      if (!reply && expectId !== undefined) throw new McpError(`${message.method}: the stream ended without a response`, { status: res.status });
      return reply;
    }
    if (type.includes('application/json')) {
      const text = await res.text();
      let reply;
      try { reply = JSON.parse(text); } catch { throw new McpError(`${message.method}: invalid JSON from server (HTTP ${res.status})`, { status: res.status }); }
      const list = Array.isArray(reply) ? reply : [reply];
      let mine = null;
      for (const msg of list) {
        this.onLog('in', msg, { ms: Date.now() - started });
        if (msg && msg.id === expectId && ('result' in msg || 'error' in msg)) mine = msg;
        else if (msg) await this.handleIncoming(msg);
      }
      return mine;
    }
    const body = await res.text().catch(() => '');
    const err = { jsonrpc: '2.0', id: expectId ?? null, error: { code: res.status, message: httpMessage(res.status, body) } };
    this.onLog('in', err, { ms: Date.now() - started, http: res.status });
    return err;
  }

  // Server → client traffic that is not the awaited reply: requests we must answer, or notifications.
  async handleIncoming(msg) {
    if (msg.method && msg.id !== undefined) {
      let response;
      try {
        const result = await this.answerServerRequest(msg);
        response = { jsonrpc: '2.0', id: msg.id, result };
      } catch (err) {
        response = { jsonrpc: '2.0', id: msg.id, error: { code: err.code ?? -32603, message: err.message } };
      }
      await this.post(response).catch(() => {});
      return;
    }
    if (msg.method) this.onNotification(msg);
  }

  async answerServerRequest({ method, params }) {
    if (method === 'ping') return {};
    if (method === 'roots/list') return { roots: [] };
    if (method === 'elicitation/create' && this.onServerRequest) return this.onServerRequest({ method, params });
    throw Object.assign(new Error(`${method} is not supported by this host`), { code: -32601 });
  }

  async request(method, params = {}, opts = {}) {
    const reply = await this.post({ jsonrpc: '2.0', id: ++this.id, method, params }, opts);
    if (!reply) throw new McpError(`${method}: no response`);
    if (reply.error) throw new McpError(reply.error.message || 'Unknown error', reply.error);
    return reply.result;
  }

  notify(method, params) {
    const msg = { jsonrpc: '2.0', method };
    if (params) msg.params = params;
    return this.post(msg);
  }

  async initialize() {
    this.sessionId = null;
    this.protocolVersion = null;
    const r = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        elicitation: { form: {} },
        extensions: { [UI_EXTENSION]: { mimeTypes: [UI_MIME] } },
      },
      clientInfo: this.clientInfo,
    });
    this.protocolVersion = r.protocolVersion;
    this.serverInfo = r.serverInfo || null;
    this.capabilities = r.capabilities || {};
    this.instructions = r.instructions || null;
    await this.notify('notifications/initialized');
    return r;
  }

  // Lists follow `nextCursor` (a server may paginate tools/list and resources/list).
  async listAll(method, key) {
    const out = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const r = await this.request(method, cursor ? { cursor } : {});
      out.push(...(r[key] || []));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    return out;
  }
  listTools() { return this.listAll('tools/list', 'tools'); }
  listResources() { return this.capabilities?.resources ? this.listAll('resources/list', 'resources') : Promise.resolve([]); }
  readResource(uri) { return this.request('resources/read', { uri }); }
  callTool(name, args = {}, opts) { return this.request('tools/call', { name, arguments: args }, opts); }

  // Streamable HTTP: a client SHOULD end its session with DELETE when it no longer needs it.
  async close() {
    if (!this.sessionId) return;
    try { await this.fetch(this.endpoint(), { method: 'DELETE', headers: this.requestHeaders() }); } catch {}
    this.sessionId = null;
  }
}

function httpMessage(status, body) {
  const hint = {
    401: 'The server needs authorization (add a bearer token).',
    403: 'The server refused this request (check the token, or the Origin: try the local proxy).',
    404: 'No MCP endpoint at this URL (most servers use /mcp).',
    405: 'This URL does not accept POST: it is probably not a Streamable HTTP MCP endpoint.',
  }[status];
  const detail = String(body || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return `HTTP ${status}${hint ? `: ${hint}` : ''}${detail && !hint ? ` ${detail}` : ''}`;
}
