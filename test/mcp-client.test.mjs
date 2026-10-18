import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { McpHttpClient, McpError, createSseParser, PROTOCOL_VERSION } from '../web/lib/mcp-client.js';
import { startDemoServer } from '../examples/daybreak-coffee/server.mjs';

test('SSE parser handles events split across chunks, CRLF and multi-line data', () => {
  const events = [];
  const p = createSseParser((e) => events.push(e));
  p.push('event: message\r\nid: 7\r\ndata: {"a":');
  p.push('1}\r\n\r\n: comment\n\ndata: line one\ndata: line two\n');
  p.push('\n');
  p.end();
  assert.deepEqual(events, [
    { event: 'message', data: '{"a":1}', id: '7' },
    { event: 'message', data: 'line one\nline two', id: '7' },
  ]);
});

test('initialize, tools/list, tools/call and resources/read against the demo server', async (t) => {
  const demo = await startDemoServer();
  t.after(demo.close);
  const log = [];
  const c = new McpHttpClient(demo.url, { onLog: (dir, msg) => log.push([dir, msg.method || 'reply']) });
  const init = await c.initialize();
  assert.equal(init.protocolVersion, PROTOCOL_VERSION);
  assert.equal(c.serverInfo.name, 'daybreak-coffee');
  // the MCP Apps extension is advertised
  const sent = log.find(([d, m]) => d === 'out' && m === 'initialize');
  assert.ok(sent);
  const tools = await c.listTools();
  assert.deepEqual(tools.map((x) => x.name), ['find_drinks', 'order_drink', 'store_hours', 'quick_reorder']);
  const r = await c.callTool('find_drinks', { kind: 'iced' });
  assert.equal(r.structuredContent.drinks.length, 3);
  const ui = await c.readResource(r._meta.ui.resourceUri);
  assert.equal(ui.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.match(ui.contents[0].text, /ui\/initialize/);
});

test('sends MCP-Protocol-Version after initialize and keeps Mcp-Session-Id', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body);
      seen.push({ method: msg.method, session: req.headers['mcp-session-id'], version: req.headers['mcp-protocol-version'], accept: req.headers.accept });
      if (msg.id === undefined) { res.writeHead(202); return res.end(); }
      const result = msg.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'x', version: '1' } } : { tools: [] };
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'abc-123' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const c = new McpHttpClient(`http://127.0.0.1:${server.address().port}/mcp`);
  await c.initialize();
  await c.listTools();
  assert.equal(seen[0].version, undefined, 'no version header on initialize');
  assert.match(seen[0].accept, /application\/json/);
  assert.match(seen[0].accept, /text\/event-stream/);
  assert.deepEqual(seen.slice(1).map((s) => [s.method, s.session, s.version]), [
    ['notifications/initialized', 'abc-123', '2025-11-25'],
    ['tools/list', 'abc-123', '2025-11-25'],
  ]);
});

test('answers a server request (elicitation) that arrives mid-stream, before the final result', async (t) => {
  let answered = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body);
      if (msg.method === 'tools/call') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 'srv-1', method: 'elicitation/create', params: { message: 'Which size?', requestedSchema: { type: 'object', properties: { size: { type: 'string' } } } } })}\n\n`);
        // the final result only after the client answered
        const wait = setInterval(() => {
          if (!answered) return;
          clearInterval(wait);
          res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `Large it is (${answered.result.content.size}).` }] } })}\n\n`);
        }, 5);
        return;
      }
      if (msg.id === 'srv-1') { answered = msg; res.writeHead(202); return res.end(); }
      res.writeHead(500); res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const c = new McpHttpClient(`http://127.0.0.1:${server.address().port}/mcp`, {
    onServerRequest: async ({ method, params }) => { assert.equal(method, 'elicitation/create'); assert.equal(params.message, 'Which size?'); return { action: 'accept', content: { size: 'large' } }; },
  });
  const r = await c.callTool('order', {});
  assert.equal(r.content[0].text, 'Large it is (large).');
  assert.equal(answered.result.action, 'accept');
});

test('JSON-RPC errors become McpError; HTTP errors explain themselves', async (t) => {
  const demo = await startDemoServer();
  t.after(demo.close);
  const c = new McpHttpClient(demo.url);
  await c.initialize();
  await assert.rejects(c.callTool('nope', {}), (e) => e instanceof McpError && e.code === -32602 && /Unknown tool/.test(e.message));
  const bad = new McpHttpClient(demo.url.replace('/mcp', '/wrong'));
  await assert.rejects(bad.initialize(), (e) => e.code === 404 && /No MCP endpoint/.test(e.message));
  const down = new McpHttpClient('http://127.0.0.1:9/mcp');
  await assert.rejects(down.initialize(), (e) => e.code === 'network');
});

test('pings and roots/list from the server are answered without the UI', async () => {
  const c = new McpHttpClient('http://unused');
  assert.deepEqual(await c.answerServerRequest({ method: 'ping' }), {});
  assert.deepEqual(await c.answerServerRequest({ method: 'roots/list' }), { roots: [] });
  await assert.rejects(c.answerServerRequest({ method: 'sampling/createMessage' }), (e) => e.code === -32601);
});
