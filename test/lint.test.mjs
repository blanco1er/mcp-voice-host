import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintCall, lintTools, lintResource, speechOf, speechSeconds, isConsequential, RULES, SOURCES } from '../web/lib/lint.js';

const text = (t, extra = {}) => ({ content: [{ type: 'text', text: t }], ...extra });
const rules = (findings) => findings.map((f) => f.rule).sort();
const tool = (name, extra = {}) => ({ name, description: 'A tool used in tests, with a long enough description.', inputSchema: { type: 'object', properties: {} }, ...extra });

test('every rule cites an official source', () => {
  for (const r of RULES) {
    assert.ok(SOURCES[r.source], r.id);
    assert.match(SOURCES[r.source].url, /^https:\/\/(developer\.amazon\.com|github\.com\/modelcontextprotocol|modelcontextprotocol\.io)\//, r.id);
    assert.ok(r.guideline.length > 20, r.id);
  }
});

test('a clean, speakable answer has no findings', () => {
  const f = lintCall({ tool: tool('find_drinks'), result: text('Three iced drinks: cold brew, $4.75; iced matcha latte, $5.45; and iced brown sugar espresso, $5.65. Which one would you like?', { structuredContent: { drinks: [{ price: 4.75 }, { price: 5.45 }, { price: 5.65 }] } }) });
  assert.deepEqual(f, []);
});

test('pipes, markdown, IDs, URLs and tool names in speech', () => {
  assert.deepEqual(rules(lintCall({ tool: tool('a'), result: text('Order placed | Large latte | $5.96') })), ['speech-formatting']);
  assert.deepEqual(rules(lintCall({ tool: tool('a'), result: text('**Done.** Your latte is ready.') })), ['speech-formatting']);
  assert.deepEqual(rules(lintCall({ tool: tool('a'), result: text('✅ User provided the requested information!') })), ['speech-formatting']);
  assert.deepEqual(rules(lintCall({ tool: tool('a'), result: text('Order ord_8F2kQ91xZ is placed.') })), ['speech-ids']);
  assert.deepEqual(rules(lintCall({ tool: tool('a'), result: text('Booking 3f2a9c1e-77b0-4c1e-9a7d-1b2c3d4e5f60 is confirmed.') })), ['speech-ids']);
  assert.deepEqual(rules(lintCall({ tool: tool('a'), result: text('Details at https://example.com/orders/12.') })), ['speech-url']);
  const tools = [tool('get_order_status')];
  assert.deepEqual(rules(lintCall({ tool: tools[0], tools, result: text('Call get_order_status again later.') })), ['speech-tool-name']);
});

test('JSON as text content (the Alexa+ lifecycle example shape)', () => {
  const f = lintCall({ tool: tool('search_hotels'), result: { structuredContent: { success: true, count: 0, hotels: [] }, content: [{ type: 'text', text: '{ "success": true, "count": 0, "hotels": []}' }] } });
  assert.deepEqual(rules(f), ['speech-json']);
});

test('length: about 30 seconds at 150 words a minute', () => {
  assert.equal(speechSeconds('one two three four five'), 2);
  const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ') + '.';
  assert.deepEqual(rules(lintCall({ tool: tool('a'), result: text(long) })), ['speech-length']);
});

test('screen references are an error only on a screenless device', () => {
  const r = text('Your order is placed, see the card below for details.');
  assert.equal(lintCall({ tool: tool('a'), result: r, device: 'show8' }).find((f) => f.rule === 'speech-screen-ref').severity, 'info');
  assert.equal(lintCall({ tool: tool('a'), result: r, device: 'dot' }).find((f) => f.rule === 'speech-screen-ref').severity, 'error');
});

test('more than five options read out', () => {
  const list = '1. Cortado\n2. Latte\n3. Mocha\n4. Flat white\n5. Americano\n6. Cold brew';
  assert.ok(rules(lintCall({ tool: tool('a'), result: text(list) })).includes('speech-options'));
});

test('a card with nothing to say fails voice-only', () => {
  const r = { content: [{ type: 'text', text: 'Here you go.' }], structuredContent: { items: [1, 2] }, _meta: { ui: { resourceUri: 'ui://x/card-abc123.html' } } };
  const f = lintCall({ tool: tool('a'), result: r, device: 'dot' });
  assert.equal(f.find((x) => x.rule === 'voice-only-incomplete').severity, 'error');
});

test('empty result and errors', () => {
  assert.deepEqual(rules(lintCall({ tool: tool('a'), result: { content: [] } })), ['result-empty']);
  assert.deepEqual(rules(lintCall({ tool: tool('a'), result: text('HTTP 500 Internal Server Error', { isError: true }) })), ['error-jargon', 'error-next-step']);
  assert.deepEqual(rules(lintCall({ tool: tool('a'), result: text('No rooms are free that night. Try Sunday instead?', { isError: true }) })), []);
});

test('purchases: one-shot orders are flagged, quote-then-confirm is not', () => {
  const quick = tool('quick_reorder', { title: 'Reorder my usual' });
  const f = lintCall({ tool: quick, result: text('Your large latte is ordered, $5.96.', { structuredContent: { total: 5.96, status: 'placed' } }) });
  assert.deepEqual(rules(f), ['purchase-breakdown', 'purchase-no-confirmation']);
  const order = tool('order_drink', { inputSchema: { type: 'object', properties: { drink: { type: 'string' }, confirmation_token: { type: 'string' } } } });
  const quote = lintCall({ tool: order, result: text('A large latte is $5.40 plus $0.56 tax, $5.96 total. Should I place the order?', { structuredContent: { quote: { price: 5.4, tax: 0.56, total: 5.96 } } }) });
  assert.deepEqual(quote, []);
  const done = lintCall({ tool: order, args: { drink: 'latte', confirmation_token: 'abc' }, result: text('Done. Your latte is $5.96.', { structuredContent: { order: { total: 5.96 } } }) });
  assert.deepEqual(done, []);
});

test('isConsequential: annotations first, read-only verbs win', () => {
  assert.equal(isConsequential({ name: 'order_status' }), false);
  assert.equal(isConsequential({ name: 'place_order' }), true);
  assert.equal(isConsequential({ name: 'quick_reorder' }), true);
  assert.equal(isConsequential({ name: 'do_it', annotations: { destructiveHint: true } }), true);
  assert.equal(isConsequential({ name: 'buy_now', annotations: { readOnlyHint: true } }), false);
});

test('slow calls, spoken amounts missing from the data, tracking parameters', () => {
  assert.deepEqual(rules(lintCall({ tool: tool('a'), result: text('Done.', {}), ms: 4200 })), ['slow-call']);
  assert.deepEqual(rules(lintCall({ tool: tool('a'), result: text('That will be $45.99.', { structuredContent: { total: 41.5 } }) })), ['cross-modal-amount']);
  assert.deepEqual(rules(lintCall({ tool: tool('a'), result: text('I found the oat latte you asked about.', { structuredContent: { link: 'https://shop.example/p?utm_source=alexa' } }) })), ['tracking-params']);
});

test('tool definitions: descriptions, schema, overlap', () => {
  const f = lintTools([
    { name: 'a', description: 'Short', inputSchema: { type: 'object', properties: { q: {} }, required: ['q', 'missing'] } },
    { name: 'b', description: 'A long enough description here.', inputSchema: { type: 'string' } },
    { name: 'search_hotels_city', description: 'Search hotels in a city by dates and number of guests', inputSchema: { type: 'object' } },
    { name: 'search_hotels_town', description: 'Search hotels in a town by dates and number of guests', inputSchema: { type: 'object' } },
  ]);
  assert.deepEqual(rules(f), ['tool-description', 'tool-overlap', 'tool-param-description', 'tool-schema', 'tool-schema']);
});

test('UI resources: MIME type and content hash', () => {
  assert.deepEqual(rules(lintResource({ uri: 'ui://x/card-a3f9c12b.html', contents: [{ mimeType: 'text/html;profile=mcp-app' }] })), []);
  assert.deepEqual(rules(lintResource({ uri: 'ui://x/card.html', contents: [{ mimeType: 'text/html' }] })), ['ui-mime', 'ui-uri-hash']);
});

test('speechOf reads the first text block only', () => {
  assert.equal(speechOf({ content: [{ type: 'image', data: '' }, { type: 'text', text: ' Hello. ' }, { type: 'text', text: 'Assistant data' }] }), 'Hello.');
  assert.equal(speechOf({}), '');
});
