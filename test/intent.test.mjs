import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankTools, fillArguments, followUpCall, valueForParam, parseYesNo, askFor, keywordBrain, modelVisible, flatten } from '../web/lib/intent.js';
import { coerceValue } from '../web/lib/schema-form.js';

const T = {
  find: { name: 'find_drinks', title: 'Find drinks', description: 'Find drinks on the menu by kind.', inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['hot', 'iced', 'tea'] }, max_price: { type: 'number' } }, required: ['kind'] } },
  order: { name: 'order_drink', title: 'Order a drink', description: 'Order one drink for pickup.', inputSchema: { type: 'object', properties: { drink: { type: 'string' }, size: { type: 'string', enum: ['small', 'medium', 'large'] }, confirmation_token: { type: 'string' } }, required: ['drink', 'size'] } },
  hours: { name: 'store_hours', title: 'Store hours', description: 'When the shop opens and closes.', inputSchema: { type: 'object', properties: {} } },
  echo: { name: 'echo', description: 'Echoes back the input string', inputSchema: { type: 'object', properties: { message: { type: 'string', description: 'Message to echo' } }, required: ['message'] } },
  sum: { name: 'get-sum', description: 'Returns the sum of two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  appOnly: { name: 'refresh_card', description: 'Refresh the card', inputSchema: { type: 'object' }, _meta: { ui: { visibility: ['app'] } } },
};
const all = Object.values(T);

test('ranking: name and title words count most; app-only tools are never picked', () => {
  assert.equal(rankTools('Alexa, find iced drinks', all)[0].tool.name, 'find_drinks');
  assert.equal(rankTools('when do you close? store hours please', all)[0].tool.name, 'store_hours');
  assert.equal(rankTools('get the sum of 2 and 3', all)[0].tool.name, 'get-sum');
  assert.ok(!rankTools('refresh the card', all).some((r) => r.tool.name === 'refresh_card'));
  assert.equal(modelVisible(T.appOnly), false);
  assert.deepEqual(rankTools('banana', all), []);
});

test('filling: enums, numbers, one free-text parameter', () => {
  assert.deepEqual(fillArguments('find iced drinks under 5 dollars', T.find), { arguments: { kind: 'iced', max_price: 5 }, missing: [] });
  assert.deepEqual(fillArguments('order a large oat latte please', T.order), { arguments: { size: 'large', drink: 'large oat latte' }, missing: [] });
  assert.deepEqual(fillArguments('echo hello from the kitchen', T.echo), { arguments: { message: 'hello from the kitchen' }, missing: [] });
  assert.deepEqual(fillArguments('sum of two and 3', T.sum), { arguments: { a: 2, b: 3 }, missing: [] });
  assert.deepEqual(fillArguments('order a drink', T.order).missing, ['drink', 'size']);
});

test('the keyword brain routes or explains', () => {
  const r = keywordBrain.route('find tea', all);
  assert.equal(r.tool.name, 'find_drinks');
  assert.deepEqual(r.arguments, { kind: 'tea' });
  const none = keywordBrain.route('play some jazz', all);
  assert.equal(none.tool, undefined);
  assert.match(none.say, /not sure/);
});

test('spoken answers become typed values', () => {
  assert.deepEqual(valueForParam('Large, please.', T.order.inputSchema.properties.size), { value: 'large' });
  assert.ok(valueForParam('extra big', T.order.inputSchema.properties.size).error);
  assert.deepEqual(valueForParam('about twelve', { type: 'integer' }), { value: 12 });
  assert.deepEqual(valueForParam('yeah', { type: 'boolean' }), { value: true });
  assert.deepEqual(valueForParam('milk, eggs and bread', { type: 'array', items: { type: 'string' } }), { value: ['milk', 'eggs', 'bread'] });
  assert.equal(parseYesNo('Yes, go ahead'), true);
  assert.equal(parseYesNo('no thanks'), false);
  assert.equal(parseYesNo('make it a medium'), null);
  assert.equal(askFor('size', T.order.inputSchema.properties.size), 'Which size: small, medium or large?');
  assert.equal(askFor('drink', {}), 'What should the drink be?');
});

test('follow-up: a yes re-calls the tool with the token it returned', () => {
  const result = { structuredContent: { kind: 'quote', confirmation_token: 'abc123', quote: { total: 5.96 } } };
  const next = followUpCall({ tool: T.order, args: { drink: 'latte', size: 'large' }, result, tools: all });
  assert.deepEqual(next, { tool: T.order, arguments: { drink: 'latte', size: 'large', confirmation_token: 'abc123' } });
});

test('follow-up: a yes calls a confirm tool with plan_id from plan.id and the exact words', () => {
  const propose = { name: 'propose_plan', inputSchema: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] } };
  const confirm = { name: 'confirm_plan', inputSchema: { type: 'object', properties: { plan_id: { type: 'string' }, user_confirmation: { type: 'string' } }, required: ['plan_id', 'user_confirmation'] } };
  const result = { structuredContent: { plan: { id: 'p_9', total: 380 } } };
  const next = followUpCall({ tool: propose, args: { goal: 'x' }, result, tools: [propose, confirm], utterance: 'Yes, book it.' });
  assert.deepEqual(next, { tool: confirm, arguments: { plan_id: 'p_9', user_confirmation: 'Yes, book it.' } });
  assert.equal(followUpCall({ tool: T.hours, result: { structuredContent: {} }, tools: all }), null);
});

test('flatten keeps full paths and last keys', () => {
  assert.deepEqual(flatten({ a: { b: 1, c: { d: 'x' } }, e: [1] }), { 'a.b': 1, b: 1, 'a.c.d': 'x', d: 'x', e: [1] });
});

test('form values are coerced to the schema', () => {
  assert.deepEqual(coerceValue({ type: 'integer', minimum: 1 }, '3'), { value: 3 });
  assert.ok(coerceValue({ type: 'integer' }, '2.5').error);
  assert.ok(coerceValue({ type: 'number', maximum: 10 }, '11').error);
  assert.deepEqual(coerceValue({ type: 'array', items: { type: 'number' } }, '1, 2,3'), { value: [1, 2, 3] });
  assert.deepEqual(coerceValue({ type: 'object' }, '{"a":1}'), { value: { a: 1 } });
  assert.ok(coerceValue({ type: 'object' }, '[1]').error);
  assert.deepEqual(coerceValue({ type: 'boolean' }, false), { value: false });
  assert.deepEqual(coerceValue({ type: 'string' }, '  '), { empty: true });
});

test('HTTP brain: uses the endpoint, refuses unknown or app-only tools, falls back to keywords', async () => {
  const { httpBrain } = await import('../web/lib/intent.js');
  const answer = (body) => async () => ({ ok: true, json: async () => body });
  const ok = await httpBrain({ url: '/brain', fetchImpl: answer({ tool: 'order_drink', arguments: { drink: 'chai' } }) }).route('a chai please', all);
  assert.equal(ok.tool.name, 'order_drink');
  assert.deepEqual(ok.missing, ['size']);
  const say = await httpBrain({ url: '/brain', fetchImpl: answer({ say: 'Which shop?' }) }).route('x', all);
  assert.equal(say.say, 'Which shop?');
  const bad = await httpBrain({ url: '/brain', fetchImpl: answer({ tool: 'refresh_card' }) }).route('find tea', all);
  assert.equal(bad.tool.name, 'find_drinks');
  assert.match(bad.brainError, /unknown tool/);
  const down = await httpBrain({ url: '/brain', fetchImpl: async () => { throw new Error('offline'); } }).route('store hours', all);
  assert.equal(down.tool.name, 'store_hours');
});
