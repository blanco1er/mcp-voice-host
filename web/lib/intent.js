// Turning an utterance into a tool call, without a language model.
//
// Alexa+ picks tools with its own model. This host has none by default, on purpose: it is a test bench, so it uses a
// transparent keyword matcher (tool name and title count most, then the description and parameter names), fills
// simple arguments (enums, numbers, yes/no, one free-text parameter) and asks for the rest by voice, one parameter at
// a time. A "brain" can replace it: any object with `route(utterance, tools) → {tool, arguments} | {say}`.
import { splitWords, isConsequential } from './lint.js';

const STOP = new Set('a an the to of for and or in on at by with from is are be please can could would you me my i we our it this that what whats how do does ask alexa hey ok okay now just tell let lets give want need some any'.split(' '));
const NUMBER_WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100 };

const stem = (w) => (w.length > 4 && w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
export function tokens(text) {
  return splitWords(text).filter((w) => !STOP.has(w)).map(stem);
}

// Tools the model may call: MCP Apps `visibility: ["app"]` tools are for views only (spec 2026-01-26).
export const modelVisible = (tool) => {
  const v = tool?._meta?.ui?.visibility;
  return !Array.isArray(v) || v.includes('model');
};

function termsOf(tool) {
  const w = new Map();
  const put = (list, weight) => { for (const t of list) w.set(t, Math.max(w.get(t) || 0, weight)); };
  put(tokens(tool.description || '').slice(0, 40), 1);
  put(Object.keys(tool.inputSchema?.properties || {}).flatMap(tokens), 0.75);
  put(tokens(tool.title || tool.annotations?.title || ''), 3);
  put(tokens(tool.name), 3);
  return w;
}

/**
 * Rank tools for an utterance.
 * @returns {{tool:object, score:number}[]} best first; empty when nothing matches
 */
export function rankTools(utterance, tools) {
  const said = new Set(tokens(utterance));
  if (!said.size) return [];
  return tools.filter(modelVisible).map((tool) => {
    let score = 0;
    for (const [t, weight] of termsOf(tool)) if (said.has(t)) score += weight;
    const nameWords = tokens(tool.name);
    if (nameWords.length > 1 && nameWords.every((t) => said.has(t))) score += 2; // the whole name was said
    return { tool, score };
  }).filter((r) => r.score >= 1.5).sort((a, b) => b.score - a.score);
}

export function parseNumbers(text) {
  const out = [];
  const re = /-?\d[\d,]*(?:\.\d+)?|\b[a-z]+\b/gi;
  let m;
  while ((m = re.exec(text))) {
    const s = m[0].toLowerCase();
    if (/^-?\d/.test(s)) out.push({ value: Number(s.replace(/,/g, '')), index: m.index, length: s.length });
    else if (s in NUMBER_WORDS) out.push({ value: NUMBER_WORDS[s], index: m.index, length: s.length });
  }
  return out;
}

export function parseYesNo(text) {
  const t = String(text).toLowerCase().trim();
  if (/^(no|nope|nah|cancel|stop|don'?t|do not|never ?mind|not now|wait)\b/.test(t)) return false;
  if (/^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|confirm|please do|correct|right|absolutely|affirmative)\b/.test(t)) return true;
  return null;
}

const enumMatch = (text, values) => {
  const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const t = ` ${norm(text)} `;
  return values.find((v) => norm(v) && t.includes(` ${norm(v)} `));
};

const typeOf = (p) => (Array.isArray(p?.type) ? p.type.find((x) => x !== 'null') : p?.type) || (p?.enum ? 'string' : undefined);

/** Convert a spoken answer into a value for one schema property. Returns {value} or {error}. */
export function valueForParam(text, prop = {}) {
  const raw = String(text || '').trim().replace(/[.!?]+$/, '');
  if (!raw) return { error: 'empty' };
  if (Array.isArray(prop.enum)) {
    const v = enumMatch(raw, prop.enum);
    return v !== undefined ? { value: v } : { error: `Say one of: ${prop.enum.slice(0, 5).join(', ')}.` };
  }
  const type = typeOf(prop);
  if (type === 'number' || type === 'integer') {
    const n = parseNumbers(raw)[0];
    if (!n) return { error: 'I need a number.' };
    return { value: type === 'integer' ? Math.round(n.value) : n.value };
  }
  if (type === 'boolean') {
    const yn = parseYesNo(raw);
    return yn === null ? { error: 'Say yes or no.' } : { value: yn };
  }
  if (type === 'array') {
    const items = raw.split(/\s*(?:,|\band\b)\s*/).filter(Boolean);
    const itemType = typeOf(prop.items);
    return { value: itemType === 'number' || itemType === 'integer' ? items.map(Number).filter(Number.isFinite) : items };
  }
  if (type === 'object') return { error: 'This parameter needs the form.' };
  return { value: raw };
}

/**
 * Fill what can be filled from the utterance.
 * @returns {{arguments:object, missing:string[]}}  missing = required parameters still unknown, in schema order
 */
export function fillArguments(utterance, tool) {
  const schema = tool?.inputSchema || {};
  const props = schema.properties || {};
  const required = new Set(schema.required || []);
  const args = {};
  const order = Object.keys(props).sort((a, b) => Number(required.has(b)) - Number(required.has(a)));
  const numbers = parseNumbers(utterance).filter((n) => !/^[a-z]/i.test(String(n.value)));
  let n = 0;
  for (const key of order) {
    const p = props[key] || {};
    const type = typeOf(p);
    if (Array.isArray(p.enum)) { const v = enumMatch(utterance, p.enum); if (v !== undefined) args[key] = v; continue; }
    if ((type === 'number' || type === 'integer') && n < numbers.length) { const v = numbers[n++].value; args[key] = type === 'integer' ? Math.round(v) : v; continue; }
    if (type === 'boolean') {
      const words = new Set(splitWords(utterance));
      if (splitWords(key).some((w) => words.has(w))) {
        if (/\b(no|not|without|off|disable|false)\b/i.test(utterance)) args[key] = false;
        else if (/\b(yes|with|on|enable|true)\b/i.test(utterance)) args[key] = true;
      }
    }
  }
  // One free-text parameter: what comes after the tool's own words ("echo hello world" → "hello world").
  const strings = order.filter((k) => typeOf(props[k]) === 'string' && !Array.isArray(props[k].enum) && !(k in args));
  const target = strings.find((k) => required.has(k)) || (strings.length === 1 ? strings[0] : null);
  if (target) {
    const text = freeText(utterance, tool, target);
    if (text) args[target] = text;
  }
  const missing = [...required].filter((k) => !(k in args) && k in props);
  return { arguments: args, missing };
}

function freeText(utterance, tool, key) {
  const nameWords = new Set([...splitWords(tool.name), ...splitWords(tool.title || ''), ...splitWords(key)].map(stem));
  const words = utterance.trim().split(/\s+/);
  let last = -1;
  words.forEach((w, i) => { if (nameWords.has(stem(w.toLowerCase().replace(/[^a-z0-9]/g, '')))) last = i; });
  if (last < 0) return '';
  let rest = words.slice(last + 1);
  while (rest.length && /^(to|for|about|that|saying|says|say|is|of|with|named|called|the|a|an|me|us|some|message|text|:)$/i.test(rest[0].replace(/[^a-z:]/gi, ''))) rest = rest.slice(1);
  while (rest.length && /^(please|thanks|thank|you|now|today)$/i.test(rest[rest.length - 1].replace(/[^a-z]/gi, ''))) rest = rest.slice(0, -1);
  return rest.join(' ').replace(/^["“']|["”'.!?,]+$/g, '').trim();
}

// The spoken question for a missing parameter, from its title or description.
export function askFor(key, prop = {}) {
  const label = (prop.title || splitWords(key).join(' ')).toLowerCase();
  if (Array.isArray(prop.enum) && prop.enum.length <= 5) return `Which ${label}: ${listOr(prop.enum.map(String))}?`;
  const type = typeOf(prop);
  if (type === 'boolean') return `Should ${label} be on? Say yes or no.`;
  return `What ${type === 'number' || type === 'integer' ? 'number for' : 'should the'} ${label}${type === 'number' || type === 'integer' ? '' : ' be'}?`;
}
const listOr = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);

/** The built-in keyword brain. */
export const keywordBrain = {
  name: 'keyword matcher',
  route(utterance, tools) {
    const ranked = rankTools(utterance, tools);
    if (!ranked.length) return { say: suggest(tools), suggestions: tools.filter(modelVisible).slice(0, 3) };
    const best = ranked[0];
    const filled = fillArguments(utterance, best.tool);
    return { tool: best.tool, arguments: filled.arguments, missing: filled.missing, score: best.score, alternatives: ranked.slice(1, 3).map((r) => r.tool) };
  },
};

function suggest(tools) {
  const names = tools.filter(modelVisible).slice(0, 3).map((t) => (t.title || splitWords(t.name).join(' ')).toLowerCase());
  return names.length ? `I’m not sure which tool fits. Try ${listOr(names)}.` : 'This server has no tools I can call.';
}

// Every key of structuredContent, by full dotted path and by last segment (first occurrence wins).
export function flatten(value, prefix = '', out = {}) {
  if (!value || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, p, out);
    else {
      if (!(p in out)) out[p] = v;
      if (!(k in out)) out[k] = v;
    }
  }
  return out;
}

const CONFIRM_TOOL = /confirm|place|approve|complete|checkout|finali[sz]e|commit|execute|submit/i;
const SAID_PARAM = /confirm|utterance|said|user_?(text|words|reply)|approval_?text/i;

/**
 * After a result that asks the customer a yes/no question, find the call a "yes" should make: the same tool again
 * (or a confirm-like tool) with the values the result handed back (a confirmation token, a plan id…). Generic and
 * heuristic: it needs at least one argument that came from the previous structuredContent, and all required ones.
 * @returns {{tool:object, arguments:object}|null}
 */
export function followUpCall({ tool, args = {}, result, tools = [], utterance = 'yes' }) {
  const data = flatten(result?.structuredContent || {});
  if (!Object.keys(data).length) return null;
  const others = tools.filter((t) => t !== tool && t.name !== tool?.name && modelVisible(t) && CONFIRM_TOOL.test(`${t.name} ${t.title || ''}`));
  for (const t of [tool, ...others].filter(Boolean)) {
    const props = t.inputSchema?.properties || {};
    const required = t.inputSchema?.required || [];
    const a = t.name === tool?.name ? { ...args } : {};
    let fromData = 0;
    for (const [k, p] of Object.entries(props)) {
      if (k in a) continue;
      const idOf = /^(.+?)_?id$/i.exec(k);
      const v = k in data ? data[k] : idOf && `${idOf[1]}.id` in data ? data[`${idOf[1]}.id`] : undefined;
      if (v !== undefined && v !== null && typeof v !== 'object') { a[k] = v; fromData++; continue; }
      if (SAID_PARAM.test(k) && typeOf(p) === 'string') a[k] = utterance;
    }
    if (fromData && required.every((k) => k in a)) return { tool: t, arguments: a };
  }
  return null;
}

export { isConsequential };
