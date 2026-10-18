import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startHost } from '../server/serve.mjs';
import { startDemoServer } from '../examples/daybreak-coffee/server.mjs';
import { McpHttpClient } from '../web/lib/mcp-client.js';

// Raw request helper (fetch forbids setting Host and Sec-Fetch-* ourselves).
function raw(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function setup(t) {
  const demo = await startDemoServer();
  const host = await startHost({ server: demo.url });
  t.after(async () => { await host.close(); await demo.close(); });
  return { demo, host };
}

test('config.json exposes the proxy token and a sandbox on another origin', async (t) => {
  const { host, demo } = await setup(t);
  const r = await raw(host.port, '/config.json', { headers: { host: `localhost:${host.port}` } });
  const cfg = JSON.parse(r.body);
  assert.equal(cfg.server, demo.url);
  assert.equal(cfg.proxy.token, host.token);
  assert.equal(cfg.sandbox.isolation, 'origin');
  assert.notEqual(new URL(cfg.sandbox.url).origin, host.origin);
  assert.equal(r.headers['access-control-allow-origin'], undefined, 'no CORS: other sites cannot read the token');
});

test('the proxy forwards MCP traffic with the token and strips the browser Origin', async (t) => {
  const { host, demo } = await setup(t);
  const c = new McpHttpClient(demo.url, { proxy: { url: `${host.origin}/proxy`, token: host.token } });
  const init = await c.initialize();
  assert.equal(init.serverInfo.name, 'daybreak-coffee');
  const r = await c.callTool('store_hours', {});
  assert.match(r.content[0].text, /Pine Street/);
});

test('the proxy refuses requests without the token, from other sites, or for other hosts', async (t) => {
  const { host, demo } = await setup(t);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
  const base = { 'content-type': 'application/json', 'x-mvh-target': demo.url, host: `localhost:${host.port}` };
  assert.equal((await raw(host.port, '/proxy', { method: 'POST', headers: base, body })).status, 403);
  assert.equal((await raw(host.port, '/proxy', { method: 'POST', headers: { ...base, 'x-mvh-token': host.token, origin: 'https://evil.example' }, body })).status, 403);
  assert.equal((await raw(host.port, '/proxy', { method: 'POST', headers: { ...base, 'x-mvh-token': host.token, 'sec-fetch-site': 'cross-site' }, body })).status, 403);
  assert.equal((await raw(host.port, '/proxy', { method: 'POST', headers: { ...base, 'x-mvh-token': host.token, host: `evil.example:${host.port}` }, body })).status, 421, 'DNS rebinding guard');
  assert.equal((await raw(host.port, '/proxy', { method: 'POST', headers: { ...base, 'x-mvh-token': host.token, 'x-mvh-target': 'file:///etc/passwd' }, body })).status, 400);
  const ok = await raw(host.port, '/proxy', { method: 'POST', headers: { ...base, 'x-mvh-token': host.token, origin: host.origin, accept: 'application/json, text/event-stream' }, body });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { jsonrpc: '2.0', id: 1, result: {} });
});

test('the sandbox origin serves only sandbox.html, with the View CSP as a header', async (t) => {
  const { host } = await setup(t);
  const csp = encodeURIComponent(JSON.stringify({ connectDomains: ['https://api.example.com', "'unsafe-eval'"], resourceDomains: ['https://cdn.example.com'] }));
  const r = await raw(host.sandboxPort, `/sandbox.html?csp=${csp}`, { headers: { host: `localhost:${host.sandboxPort}` } });
  assert.equal(r.status, 200);
  const policy = r.headers['content-security-policy'];
  assert.match(policy, /connect-src https:\/\/api\.example\.com/);
  assert.match(policy, /script-src 'self' 'unsafe-inline' https:\/\/cdn\.example\.com/);
  assert.doesNotMatch(policy, /unsafe-eval/);
  assert.match(r.body, /sandbox-proxy-ready/);
  assert.equal((await raw(host.sandboxPort, '/app.js', { headers: { host: `localhost:${host.sandboxPort}` } })).status, 404);
});

test('static files: index, no path traversal, no-store', async (t) => {
  const { host } = await setup(t);
  const h = { host: `localhost:${host.port}` };
  const index = await raw(host.port, '/', { headers: h });
  assert.equal(index.status, 200);
  assert.match(index.body, /MCP Voice Host/);
  assert.equal(index.headers['cache-control'], 'no-store');
  const trav = await raw(host.port, '/../package.json', { headers: h });
  assert.notEqual(trav.status, 200);
  const enc = await raw(host.port, '/%2e%2e/package.json', { headers: h });
  assert.notEqual(enc.status, 200);
});
