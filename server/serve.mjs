// Local server for mcp-voice-host. Zero dependencies (node:http only).
//
// Two origins, as the MCP Apps spec requires for web hosts:
//   host     http://localhost:<port>          the static app (web/), /config.json, the MCP proxy and /tts
//   sandbox  http://localhost:<sandboxPort>   only sandbox.html, with the View's CSP as an HTTP header
//
// The proxy forwards the page's MCP traffic to the server it names in `x-mvh-target`, server to server: no CORS
// needed, and no browser Origin header (many MCP servers rightly refuse unknown Origins). It is guarded by a
// per-run random token that only a page from this host can read, listens on loopback only, and refuses requests
// from other sites.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { buildCsp } from '../web/lib/csp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WEB_ROOT = path.resolve(HERE, '../web');
const VERSION = JSON.parse(fs.readFileSync(path.resolve(HERE, '../package.json'), 'utf8')).version;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};
// Request headers that make sense to forward to an MCP server.
const FORWARD = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'authorization', 'last-event-id'];

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(data);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(server.address().port); });
  });
}

/**
 * @param {object} o
 * @param {string} [o.server]       default MCP server URL shown at start
 * @param {number} [o.port]         host port (0 = any free port)
 * @param {number} [o.sandboxPort]  sandbox port (0 = any free port)
 * @param {string} [o.bind]         interface, default 127.0.0.1
 * @param {Record<string,string>} [o.headers] headers added to every proxied MCP request (e.g. Authorization)
 * @param {string} [o.ttsUrl]       optional TTS endpoint (POST {text, voice} → audio)
 * @param {string} [o.brainUrl]     optional brain endpoint (POST {utterance, tools} → {tool, arguments} | {say})
 * @param {boolean} [o.proxy]       enable the MCP proxy (default true)
 * @param {string} [o.root]         static root (default web/)
 */
export async function startHost(o = {}) {
  const bind = o.bind || '127.0.0.1';
  const root = path.resolve(o.root || WEB_ROOT);
  const token = crypto.randomBytes(18).toString('base64url');
  const extraHeaders = o.headers || {};
  const proxyOn = o.proxy !== false;
  let hostOrigin = '';
  let sandboxOrigin = '';

  const sameSite = (req) => {
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    if (origin && origin !== hostOrigin && origin !== hostOrigin.replace('localhost', '127.0.0.1')) return false;
    if (site && site !== 'same-origin' && site !== 'none') return false;
    return true;
  };

  async function proxy(req, res) {
    if (!proxyOn) return send(res, 404, { error: 'The proxy is disabled (--no-proxy).' });
    if (req.headers['x-mvh-token'] !== token || !sameSite(req)) return send(res, 403, { error: 'Forbidden: this proxy only serves the mcp-voice-host page that started it.' });
    let target;
    try { target = new URL(req.headers['x-mvh-target']); } catch { return send(res, 400, { error: 'Missing or invalid x-mvh-target URL.' }); }
    if (!/^https?:$/.test(target.protocol)) return send(res, 400, { error: 'Only http and https MCP servers can be proxied.' });
    if (target.port && [String(serverPort), String(sandboxPort)].includes(target.port) && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(target.hostname)) return send(res, 400, { error: 'The proxy cannot target itself.' });
    const headers = {};
    for (const k of FORWARD) if (req.headers[k]) headers[k] = req.headers[k];
    Object.assign(headers, extraHeaders);
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : undefined;
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    let upstream;
    try {
      upstream = await fetch(target, { method: req.method, headers, body, signal: ac.signal, redirect: 'manual' });
    } catch (err) {
      if (ac.signal.aborted) return;
      return send(res, 502, { jsonrpc: '2.0', id: null, error: { code: -32000, message: `The proxy could not reach ${target.origin} (${err.cause?.code || err.message}).` } });
    }
    const out = { 'cache-control': 'no-store' };
    for (const k of ['content-type', 'mcp-session-id', 'www-authenticate']) { const v = upstream.headers.get(k); if (v) out[k] = v; }
    res.writeHead(upstream.status, out);
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).on('error', () => res.end()).pipe(res);
  }

  // /tts and /brain: forward a small JSON POST to the endpoint given on the command line.
  async function forward(req, res, target, what, limit = 64 * 1024) {
    if (!target) return send(res, 404, { error: `No ${what} endpoint configured.` });
    if (req.headers['x-mvh-token'] !== token || !sameSite(req)) return send(res, 403, { error: 'Forbidden.' });
    try {
      const body = await readBody(req, limit);
      const r = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/octet-stream', 'cache-control': 'no-store' });
      if (r.body) Readable.fromWeb(r.body).pipe(res); else res.end();
    } catch (err) { send(res, 502, { error: `The ${what} endpoint is unreachable (${err.message}).` }); }
  }

  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep)) return send(res, 403, 'Forbidden');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, 'Not found');
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  // DNS rebinding guard: a page on evil.example that resolves to 127.0.0.1 would otherwise be "same origin".
  const loopbackHost = (req) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host || '') || bind !== '127.0.0.1';

  const hostServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, hostOrigin || 'http://localhost');
    if (!loopbackHost(req)) return send(res, 421, 'Misdirected request');
    try {
      if (url.pathname === '/proxy') return await proxy(req, res);
      if (url.pathname === '/tts' && req.method === 'POST') return await forward(req, res, o.ttsUrl, 'TTS');
      if (url.pathname === '/brain' && req.method === 'POST') return await forward(req, res, o.brainUrl, 'brain', 1024 * 1024);
      if (url.pathname === '/config.json') {
        return send(res, 200, {
          version: VERSION,
          server: o.server || '',
          proxy: proxyOn ? { url: '/proxy', token } : null,
          sandbox: { url: `${sandboxOrigin}/sandbox.html`, isolation: 'origin' },
          tts: o.ttsUrl ? { provider: 'http', url: '/tts' } : { provider: 'browser' },
          brain: o.brainUrl ? { url: '/brain' } : null,
          headersConfigured: Object.keys(extraHeaders),
        });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      return serveStatic(req, res, url.pathname);
    } catch (err) {
      if (!res.headersSent) send(res, err.status || 500, { error: err.message });
    }
  });

  const sandboxServer = http.createServer((req, res) => {
    const url = new URL(req.url, sandboxOrigin || 'http://localhost');
    if (!loopbackHost(req)) return send(res, 421, 'Misdirected request');
    if (req.method !== 'GET' || (url.pathname !== '/sandbox.html' && url.pathname !== '/')) return send(res, 404, 'Not found');
    let csp = {};
    try { csp = JSON.parse(url.searchParams.get('csp') || '{}'); } catch {}
    fs.readFile(path.join(root, 'sandbox.html'), (err, html) => {
      if (err) return send(res, 500, 'sandbox.html missing');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': buildCsp(csp), 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      res.end(html);
    });
  });

  const serverPort = await listen(hostServer, o.port ?? 0, bind);
  const sandboxPort = await listen(sandboxServer, o.sandboxPort ?? 0, bind);
  const name = bind === '127.0.0.1' || bind === '::1' || bind === 'localhost' ? 'localhost' : bind;
  hostOrigin = `http://${name}:${serverPort}`;
  sandboxOrigin = `http://${name}:${sandboxPort}`;
  return {
    url: hostOrigin + '/' + (o.server ? `?server=${encodeURIComponent(o.server)}` : ''),
    origin: hostOrigin,
    sandboxOrigin,
    port: serverPort,
    sandboxPort,
    token,
    close: () => Promise.all([hostServer, sandboxServer].map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); }))),
  };
}
