// Daybreak Coffee: a tiny, dependency-free MCP server (Streamable HTTP, stateless, JSON responses) used as the
// out-of-the-box demo and as the test fixture. A fictional coffee shop with four tools:
//   find_drinks    read-only search, max three options, an MCP App card
//   order_drink    a purchase done right: first call returns a quote and a confirmation token; only a second call
//                  with the token places the order
//   store_hours    data only, no card (the host renders it like Alexa's native "hydrated" view)
//   quick_reorder  a deliberately non-compliant example (pipes, an internal ID, no confirmation) so the lint has
//                  something to show. Do not copy it.
// Run alone: node examples/daybreak-coffee/server.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const CARD = fs.readFileSync(new URL('./card.html', import.meta.url), 'utf8');
const CARD_URI = `ui://daybreak/card-${crypto.createHash('sha256').update(CARD).digest('hex').slice(0, 8)}.html`;
const UI_MIME = 'text/html;profile=mcp-app';
const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26'];
const TAX = 0.1035; // Seattle sales tax

const MENU = [
  { name: 'Oat milk latte', kind: 'hot', price: { small: 4.4, medium: 4.9, large: 5.4 } },
  { name: 'Cortado', kind: 'hot', price: { small: 4.25, medium: 4.25, large: 4.25 } },
  { name: 'Drip coffee', kind: 'hot', price: { small: 2.6, medium: 3.1, large: 3.5 } },
  { name: 'Cold brew', kind: 'iced', price: { small: 4.25, medium: 4.75, large: 5.25 } },
  { name: 'Iced brown sugar espresso', kind: 'iced', price: { small: 5.15, medium: 5.65, large: 6.15 } },
  { name: 'Iced matcha latte', kind: 'iced', price: { small: 4.95, medium: 5.45, large: 5.95 } },
  { name: 'Chai latte', kind: 'tea', price: { small: 4.45, medium: 4.95, large: 5.45 } },
  { name: 'Earl Grey', kind: 'tea', price: { small: 2.9, medium: 3.4, large: 3.8 } },
  { name: 'Mint green tea', kind: 'tea', price: { small: 2.9, medium: 3.4, large: 3.8 } },
];
const money = (n) => Math.round(n * 100) / 100;
const say = (n) => `$${money(n).toFixed(2)}`;
const ui = { ui: { resourceUri: CARD_URI } };

const TOOLS = [
  {
    name: 'find_drinks',
    title: 'Find drinks',
    description: 'Find drinks on the Daybreak Coffee menu by kind. Use when the customer asks what they can order, for example “what iced drinks do you have”. Returns up to three drinks with medium prices.',
    inputSchema: { type: 'object', properties: {
      kind: { type: 'string', enum: ['hot', 'iced', 'tea'], description: 'hot (warm, coffee), iced (cold, cold brew) or tea (chai, matcha, herbal).' },
      max_price: { type: 'number', description: 'Highest medium price in US dollars, optional.' },
    }, required: ['kind'] },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: ui,
  },
  {
    name: 'order_drink',
    title: 'Order a drink',
    description: 'Order one drink for pickup at Daybreak Coffee on Pine Street. Call it first without confirmation_token: it returns the price with tax and a token, and nothing is charged. Call it again with that token only after the customer said yes.',
    inputSchema: { type: 'object', properties: {
      drink: { type: 'string', description: 'Drink name as the customer said it, e.g. “oat latte”, “cold brew”, “chai”.' },
      size: { type: 'string', enum: ['small', 'medium', 'large'], description: 'Cup size: small (12 oz), medium (16 oz, “regular”) or large (20 oz).' },
      confirmation_token: { type: 'string', description: 'Token from the quote. Send it only after an explicit yes.' },
    }, required: ['drink', 'size'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: { ui: { resourceUri: CARD_URI, invoking: 'Checking the price…', invoked: 'Price ready' } },
  },
  {
    name: 'store_hours',
    title: 'Store hours',
    description: 'Tell when the Daybreak Coffee shop on Pine Street opens and closes today. Use for “are you open”, “when do you close”.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'quick_reorder',
    title: 'Reorder my usual',
    description: 'Deliberately non-compliant lint example: reorders the customer’s usual drink at once, with no confirmation, and answers with pipes and an internal order ID.',
    inputSchema: { type: 'object', properties: {} },
    _meta: ui,
  },
];

const quotes = new Map(); // token → quote (in memory, ten minutes)

function findDrink(text = '') {
  const words = String(text).toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2 && !['large', 'medium', 'small', 'please', 'with', 'the', 'and'].includes(w));
  let best = null, score = 0;
  for (const d of MENU) {
    const s = words.filter((w) => d.name.toLowerCase().includes(w)).length;
    if (s > score) { best = d; score = s; }
  }
  return best;
}

function callTool(name, a = {}) {
  const text = (t) => [{ type: 'text', text: t }];
  switch (name) {
    case 'find_drinks': {
      if (!['hot', 'iced', 'tea'].includes(a.kind)) return { isError: true, content: text('I can look up hot drinks, iced drinks or tea. Which one would you like?') };
      const all = MENU.filter((d) => d.kind === a.kind && (typeof a.max_price !== 'number' || d.price.medium <= a.max_price));
      const drinks = all.slice(0, 3).map((d) => ({ name: d.name, price: d.price.medium }));
      if (!drinks.length) return { content: text(`Nothing ${a.kind} under ${say(a.max_price)}. Want me to raise the limit?`), structuredContent: { kind: 'menu', title: 'No match', drinks: [] }, _meta: ui };
      const list = drinks.map((d) => `${d.name}, ${say(d.price)}`);
      const spoken = `${drinks.length === 1 ? 'One' : drinks.length === 2 ? 'Two' : 'Three'} ${a.kind === 'tea' ? 'teas' : `${a.kind} drinks`}: ${list.slice(0, -1).join('; ')}${list.length > 1 ? '; and ' : ''}${list[list.length - 1]}. Prices are for a medium. Which one would you like?`;
      return { content: text(spoken), structuredContent: { kind: 'menu', title: `${drinks.length} ${a.kind === 'tea' ? 'teas' : `${a.kind} drinks`} at Daybreak`, drinks }, _meta: ui };
    }
    case 'order_drink': {
      if (a.confirmation_token) {
        const q = quotes.get(a.confirmation_token);
        if (!q) return { isError: true, content: text('That price check has expired, so nothing was charged. Want me to check the price again?') };
        quotes.delete(a.confirmation_token);
        const ready = new Date(Date.now() + q.ready_in_minutes * 60000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
        return { content: text(`Done. Your ${q.label.toLowerCase()} is ${say(q.total)}, ready at ${ready} at Pine Street. The receipt is in your email.`),
          structuredContent: { kind: 'receipt', order: { label: q.label, total: q.total, ready_at: ready, status: 'placed' } }, _meta: ui };
      }
      const d = findDrink(a.drink);
      if (!d) return { isError: true, content: text(`I couldn’t find “${String(a.drink || '').slice(0, 40)}” on the menu. Try a latte, cold brew or chai.`) };
      const size = ['small', 'medium', 'large'].includes(a.size) ? a.size : null;
      if (!size) return { isError: true, content: text('Which size: small, medium or large?') };
      const price = d.price[size];
      const tax = money(price * TAX);
      const q = { label: `${size[0].toUpperCase()}${size.slice(1)} ${d.name.toLowerCase()}`, price, tax, total: money(price + tax), ready_in_minutes: 6 };
      const token = crypto.randomBytes(6).toString('hex');
      quotes.set(token, q);
      setTimeout(() => quotes.delete(token), 10 * 60000).unref?.();
      return { content: text(`A ${q.label.toLowerCase()} is ${say(price)} plus ${say(tax)} tax, ${say(q.total)} total, ready in about 6 minutes. Should I place the order?`),
        structuredContent: { kind: 'quote', quote: q, confirmation_token: token, status: 'awaiting confirmation' }, _meta: ui };
    }
    case 'store_hours':
      return { content: text('Daybreak on Pine Street is open today from 6:30 AM to 6 PM.'), structuredContent: { store: 'Pine Street', opens: '06:30', closes: '18:00', timezone: 'America/Los_Angeles' } };
    case 'quick_reorder': {
      const total = money(5.4 * (1 + TAX));
      return { content: text(`Order ord_8F2kQ91xZ placed | Large oat milk latte | ${say(total)} | see the card below`),
        structuredContent: { kind: 'receipt', order: { id: 'ord_8F2kQ91xZ', label: 'Large oat milk latte', total, status: 'placed' } }, _meta: ui };
    }
    default:
      return null;
  }
}

function handle(msg) {
  const { id, method, params = {} } = msg;
  if (id === undefined) return null; // notification
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize':
      return ok({ protocolVersion: SUPPORTED.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED[0],
        capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'daybreak-coffee', title: 'Daybreak Coffee', version: '1.0.0' },
        instructions: 'Fictional coffee shop used to demo mcp-voice-host.' });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'resources/list': return ok({ resources: [{ uri: CARD_URI, name: 'daybreak_card', title: 'Daybreak Coffee card', mimeType: UI_MIME }] });
    case 'resources/read':
      if (params.uri !== CARD_URI) return err(-32002, `Resource not found: ${params.uri}`);
      return ok({ contents: [{ uri: CARD_URI, mimeType: UI_MIME, text: CARD, _meta: { ui: { csp: {}, prefersBorder: false } } }] });
    case 'tools/call': {
      const r = callTool(params.name, params.arguments || {});
      return r ? ok(r) : err(-32602, `Unknown tool: ${params.name}`);
    }
    default: return err(-32601, `Method not found: ${method}`);
  }
}

// Browsers may call this demo directly (no proxy) from a local page; any other Origin is refused (MCP 2025-11-25).
const localOrigin = (o) => !o || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o);

export function startDemoServer({ port = 0, host = '127.0.0.1' } = {}) {
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    const cors = origin && localOrigin(origin) ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type, accept, mcp-session-id, mcp-protocol-version, authorization', 'access-control-expose-headers': 'mcp-session-id', vary: 'origin' } : {};
    if (!localOrigin(origin)) { res.writeHead(403, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Forbidden origin' } })); }
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'access-control-allow-methods': 'POST, GET, DELETE' }); return res.end(); }
    if (new URL(req.url, 'http://x').pathname !== '/mcp') { res.writeHead(404, cors); return res.end('Not found'); }
    if (req.method === 'GET') { res.writeHead(405, { ...cors, allow: 'POST' }); return res.end(); } // stateless: no standalone SSE stream
    if (req.method === 'DELETE') { res.writeHead(405, { ...cors, allow: 'POST' }); return res.end(); }
    if (req.method !== 'POST') { res.writeHead(405, cors); return res.end(); }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body); } catch { res.writeHead(400, { 'content-type': 'application/json', ...cors }); return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })); }
      const reply = Array.isArray(msg) ? msg.map(handle).filter(Boolean) : handle(msg);
      if (!reply || (Array.isArray(reply) && !reply.length)) { res.writeHead(202, cors); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json', ...cors });
      res.end(JSON.stringify(reply));
    });
  });
  return new Promise((resolve) => server.listen(port, host, () => {
    const p = server.address().port;
    resolve({ url: `http://localhost:${p}/mcp`, port: p, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) });
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const s = await startDemoServer({ port: Number(process.argv[2]) || 4290 });
  console.log(`Daybreak Coffee MCP server on ${s.url}`);
}
