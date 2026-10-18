import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ViewBridge, APPS_PROTOCOL_VERSION } from '../web/lib/bridge.js';
import { buildCsp, injectCspMeta, cleanDomains } from '../web/lib/csp.js';
import { hostContextFor } from '../web/lib/devices.js';

function makeBridge(extra = {}) {
  const sent = [];
  const calls = [];
  const events = {};
  const mcp = {
    callTool: async (name, args) => { calls.push([name, args]); return { content: [{ type: 'text', text: `ran ${name}` }] }; },
    readResource: async (uri) => ({ contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: '<p>x</p>' }] }),
  };
  const tools = [
    { name: 'refresh', _meta: { ui: { visibility: ['app'] } } },
    { name: 'search' },
    { name: 'secret', _meta: { ui: { visibility: ['model'] } } },
  ];
  let ctx = { theme: 'dark', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'], containerDimensions: { width: 1184 } };
  const on = new Proxy({}, { get: (_, k) => (...a) => { (events[k] ||= []).push(a); } });
  const b = new ViewBridge({ post: (m) => sent.push(m), mcp, hostContext: () => ctx, tools, on, ...extra });
  return { b, sent, calls, events, setCtx: (c) => (ctx = { ...ctx, ...c }) };
}
const req = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
const note = (method, params = {}) => ({ jsonrpc: '2.0', method, params });

test('ui/initialize answers with protocol, capabilities and the host context', async () => {
  const { b, sent } = makeBridge();
  await b.handle(req(1, 'ui/initialize', { protocolVersion: APPS_PROTOCOL_VERSION, appInfo: { name: 'v' } }));
  const r = sent[0];
  assert.equal(r.id, 1);
  assert.equal(r.result.protocolVersion, '2026-01-26');
  assert.ok(r.result.hostCapabilities.serverTools);
  assert.equal(r.result.hostContext.theme, 'dark');
});

test('nothing reaches the View before initialized; then tool-input precedes tool-result, once each', async () => {
  const { b, sent } = makeBridge();
  b.start({ toolName: 'search', args: { q: 'tea' } });
  b.contextChanged({ theme: 'light' });
  assert.equal(sent.length, 0);
  await b.handle(req(1, 'ui/initialize'));
  await b.handle(note('ui/notifications/initialized'));
  b.setResult({ content: [{ type: 'text', text: 'ok' }] });
  b.setResult({ content: [{ type: 'text', text: 'again' }] });
  await b.handle(note('ui/notifications/initialized'));
  assert.deepEqual(sent.map((m) => m.method || 'response'), ['response', 'ui/notifications/tool-input', 'ui/notifications/tool-result']);
  assert.deepEqual(sent[1].params, { arguments: { q: 'tea' } });
  b.contextChanged({ theme: 'light' });
  assert.equal(sent.at(-1).method, 'ui/notifications/host-context-changed');
});

test('a View can only call tools visible to apps', async () => {
  const { b, sent, calls, events } = makeBridge();
  await b.handle(req(1, 'tools/call', { name: 'refresh', arguments: { a: 1 } }));
  await b.handle(req(2, 'tools/call', { name: 'search', arguments: {} }));
  await b.handle(req(3, 'tools/call', { name: 'secret', arguments: {} }));
  await b.handle(req(4, 'tools/call', { name: 'unknown' }));
  assert.deepEqual(calls.map((c) => c[0]), ['refresh', 'search']);
  assert.equal(sent.find((m) => m.id === 3).error.code, -32602);
  assert.equal(sent.find((m) => m.id === 4).error.code, -32602);
  assert.equal(events.toolResult.length, 2);
});

test('display modes: host ∩ view; the result is always returned', async () => {
  const { b, sent, events } = makeBridge();
  await b.handle(req(1, 'ui/initialize', { appCapabilities: { availableDisplayModes: ['inline'] } }));
  assert.deepEqual(sent[0].result.hostContext.availableDisplayModes, ['inline']);
  await b.handle(req(2, 'ui/request-display-mode', { mode: 'fullscreen' }));
  assert.deepEqual(sent.at(-1).result, { mode: 'inline' });
  assert.equal(events.displayMode, undefined);
  const two = makeBridge();
  await two.b.handle(req(1, 'ui/request-display-mode', { mode: 'fullscreen' }));
  assert.deepEqual(two.sent.at(-1).result, { mode: 'fullscreen' });
  assert.deepEqual(two.events.displayMode, [['fullscreen']]);
});

test('open-link accepts http(s) only; ui/message accepts the spec object and arrays', async () => {
  const { b, sent, events } = makeBridge();
  await b.handle(req(1, 'ui/open-link', { url: 'javascript:alert(1)' }));
  await b.handle(req(2, 'ui/open-link', { url: 'https://example.com/a' }));
  assert.equal(sent[0].error.message, 'Invalid URL');
  assert.deepEqual(sent[1].result, {});
  assert.deepEqual(events.openLink, [['https://example.com/a']]);
  await b.handle(req(3, 'ui/message', { role: 'user', content: { type: 'text', text: 'Order a cortado' } }));
  await b.handle(req(4, 'ui/message', { role: 'user', content: [{ type: 'text', text: 'Yes' }] }));
  await b.handle(req(5, 'ui/message', { role: 'user', content: { type: 'image' } }));
  assert.deepEqual(events.message.map((m) => m[0]), ['Order a cortado', 'Yes']);
  assert.equal(sent.find((m) => m.id === 5).error.message, 'Invalid message format');
});

test('model context, resources, ping, unknown methods', async () => {
  const { b, sent, events } = makeBridge();
  await b.handle(req(1, 'ui/update-model-context', { structuredContent: { step: 2 } }));
  await b.handle(req(2, 'resources/read', { uri: 'ui://x/y' }));
  await b.handle(req(3, 'ping'));
  await b.handle(req(4, 'weird/method'));
  await b.handle({ hello: 'not json-rpc' });
  assert.deepEqual(b.modelContext.structuredContent, { step: 2 });
  assert.equal(events.modelContext.length, 1);
  assert.equal(sent[1].result.contents[0].uri, 'ui://x/y');
  assert.deepEqual(sent[2].result, {});
  assert.equal(sent[3].error.code, -32601);
  assert.equal(sent.length, 4);
});

test('teardown waits for the View answer (or times out) and closes the bridge', async () => {
  const { b, sent } = makeBridge();
  await b.handle(req(1, 'ui/initialize'));
  await b.handle(note('ui/notifications/initialized'));
  const p = b.teardown('replaced', 2000);
  const td = sent.at(-1);
  assert.equal(td.method, 'ui/resource-teardown');
  await b.handle({ jsonrpc: '2.0', id: td.id, result: {} });
  await p;
  assert.equal(b.closed, true);
  const n = sent.length;
  b.contextChanged({ theme: 'light' });
  assert.equal(sent.length, n, 'a closed bridge sends nothing');
});

test('CSP: spec default without metadata, declared domains only, no injection', () => {
  const d = buildCsp();
  for (const part of ["default-src 'none'", "script-src 'self' 'unsafe-inline'", "img-src 'self' data:", "connect-src 'none'", "frame-src 'none'", "object-src 'none'"]) assert.ok(d.includes(part), part);
  const p = buildCsp({ connectDomains: ['https://api.example.com', "https://x.com; script-src *", "'unsafe-eval'"], frameDomains: ['https://*.youtube.com'] });
  assert.match(p, /connect-src https:\/\/api\.example\.com;/);
  assert.match(p, /frame-src https:\/\/\*\.youtube\.com/);
  assert.doesNotMatch(p, /unsafe-eval|script-src \*/);
  assert.deepEqual(cleanDomains(['wss://live.example.com:8443', 'example.com', 42]), ['wss://live.example.com:8443']);
});

test('CSP meta goes first in <head> and keeps the doctype', () => {
  const out = injectCspMeta('<!doctype html><html><head><title>x</title></head><body></body></html>', "default-src 'none'");
  assert.match(out, /^<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><title>/);
  assert.match(injectCspMeta('<p>bare</p>', 'x'), /^<meta http-equiv/);
  assert.match(injectCspMeta('<!DOCTYPE html><p>x</p>', 'x'), /^<!DOCTYPE html><meta/);
});

test('host context per device: spec fields plus Alexa+ fields', () => {
  const show = hostContextFor('show8', { theme: 'dark', container: { width: 1216, height: 600 } });
  assert.deepEqual(show.containerDimensions, { width: 1216, maxHeight: 600 });
  assert.equal(show.deviceClass, 'show8');
  assert.deepEqual(show.availableDisplayModes, ['inline', 'fullscreen']);
  assert.equal(show.styles.variables['--color-background-primary'], '#000000');
  const phone = hostContextFor('phone');
  assert.equal(phone.platform, 'mobile');
  assert.equal(phone.isMobile, true);
  assert.equal(phone.safeAreaInsets.bottom, 34);
  assert.deepEqual(hostContextFor('dot').availableDisplayModes, []);
});
