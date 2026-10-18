// Voice-first lint for MCP tool results, based on Amazon's public Alexa+ MCP add-on design guide.
// Every rule cites the page it comes from. Most checks are heuristics (regular expressions over text): they point
// at something worth a look, they do not certify anything. Amazon's own certification and Local Inspector remain
// the reference. Pure functions, no DOM: runs in the browser and in Node tests.

const DOCS = 'https://developer.amazon.com/docs/alexaplus/add-ons/';
export const SOURCES = {
  functional: { label: 'Alexa+ functional requirements', url: `${DOCS}functional-requirements.html` },
  displayModes: { label: 'Alexa+ display modes', url: `${DOCS}mcp-addon-display-modes.html` },
  toolsSchema: { label: 'Alexa+ tools, schema and data design', url: `${DOCS}mcp-addon-tools-schema-data-design.html` },
  layout: { label: 'Alexa+ layout and rendering', url: `${DOCS}mcp-addon-layout-and-rendering.html` },
  policy: { label: 'Alexa+ policy requirements', url: `${DOCS}policy-requirements.html` },
  mcpApps: { label: 'MCP Apps spec 2026-01-26', url: 'https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx' },
  mcpTools: { label: 'MCP spec 2025-11-25, tools', url: 'https://modelcontextprotocol.io/specification/2025-11-25/server/tools' },
};

// What each rule checks, with the guideline it comes from (shown in the inspector and in the README).
export const RULES = [
  { id: 'speech-formatting', severity: 'warn', heuristic: true, source: 'displayModes', title: 'Formatting characters in spoken text',
    guideline: 'Your tool’s data must remain intelligible without any visual support and be free of text formatting artifacts (such as pipes). Emoji are flagged too: a voice reads them out by name or skips them.' },
  { id: 'speech-url', severity: 'warn', heuristic: true, source: 'displayModes', title: 'Web address in spoken text',
    guideline: 'Voice-only is the always-on baseline: a link cannot be followed by ear.' },
  { id: 'speech-ids', severity: 'warn', heuristic: true, source: 'functional', title: 'Internal ID in spoken text',
    guideline: 'Surface no API codes, tool names, JSON, or internal IDs in any customer-facing response (§2).' },
  { id: 'speech-json', severity: 'warn', heuristic: true, source: 'functional', title: 'JSON as the text content',
    guideline: 'Surface no API codes, tool names, JSON, or internal IDs in any customer-facing response (§2). Alexa’s model paraphrases data, but voice-only devices and other MCP hosts may read text content as is.' },
  { id: 'speech-tool-name', severity: 'warn', heuristic: true, source: 'functional', title: 'Tool name in spoken text',
    guideline: 'Surface no API codes, tool names, JSON, or internal IDs in any customer-facing response (§2).' },
  { id: 'speech-length', severity: 'warn', heuristic: true, source: 'functional', title: 'Spoken answer longer than 30 seconds',
    guideline: 'Keep voice responses under 30 seconds. For longer content, offer to “tell you more” (§9).' },
  { id: 'speech-screen-ref', severity: 'warn', heuristic: true, source: 'functional', title: 'Speech refers to the screen',
    guideline: 'Never reference visual elements (“the card shown”, “tap the button”) on devices without a screen (§9).' },
  { id: 'speech-options', severity: 'warn', heuristic: true, source: 'functional', title: 'More than five options read out',
    guideline: 'Present a maximum of 5 options with key differentiators and offer pagination (§9).' },
  { id: 'voice-only-incomplete', severity: 'warn', heuristic: true, source: 'displayModes', title: 'Answer incomplete without the screen',
    guideline: 'Voice-only is the always-on baseline of an add-on. Complete all critical features entirely by voice (§9).' },
  { id: 'result-empty', severity: 'error', heuristic: false, source: 'toolsSchema', title: 'Tool returned nothing',
    guideline: 'Always return something. If your tool returns no data, Alexa has nothing to work with.' },
  { id: 'error-jargon', severity: 'warn', heuristic: true, source: 'functional', title: 'Technical jargon in an error',
    guideline: 'Every error must give the customer a clear path forward with no technical jargon (§2).' },
  { id: 'error-next-step', severity: 'info', heuristic: true, source: 'functional', title: 'Error without a next step',
    guideline: 'Provide actionable next step for every error (§2).' },
  { id: 'purchase-no-confirmation', severity: 'warn', heuristic: true, source: 'functional', title: 'High-consequence action ran without a confirmation step',
    guideline: 'Require explicit confirmation with key details before any high-consequence action (payment, cancellation, deletion) (§8). Shopping add-ons must protect customers from unintended purchases (policy §16).' },
  { id: 'purchase-breakdown', severity: 'info', heuristic: true, source: 'functional', title: 'Price without a breakdown',
    guideline: 'Communicate the full price breakdown (base price, taxes, fees, total) before purchase confirmation (§8).' },
  { id: 'slow-call', severity: 'warn', heuristic: false, source: 'functional', title: 'Tool call slower than 3 seconds',
    guideline: 'Return results within 3 seconds. If processing takes longer, surface an interim message (§7, §2).' },
  { id: 'cross-modal-amount', severity: 'warn', heuristic: true, source: 'functional', title: 'Spoken amount missing from the data',
    guideline: 'Ensure TTS and on-screen content contain no data contradictions (§10).' },
  { id: 'tracking-params', severity: 'warn', heuristic: false, source: 'toolsSchema', title: 'Tracking parameters in the payload',
    guideline: 'Ship only your own content: no third-party tracking parameters, or upstream deep links.' },
  { id: 'ui-mime', severity: 'error', heuristic: false, source: 'mcpApps', title: 'UI resource with the wrong MIME type',
    guideline: 'mimeType MUST be text/html;profile=mcp-app.' },
  { id: 'ui-uri-hash', severity: 'info', heuristic: true, source: 'layout', title: 'UI resource URI without a content hash',
    guideline: 'Version your resource URI with a content hash, for example ui://…/widget-a3f9c12b.html.' },
  { id: 'ui-no-initialize', severity: 'warn', heuristic: false, source: 'mcpApps', title: 'View never initialized',
    guideline: 'The View sends ui/initialize then ui/notifications/initialized; the Host sends nothing before that.' },
  { id: 'tool-description', severity: 'warn', heuristic: true, source: 'toolsSchema', title: 'Tool description too short',
    guideline: 'Give each tool a clear, concise description that states when to call it, why it’s used, and what it returns.' },
  { id: 'tool-schema', severity: 'error', heuristic: false, source: 'functional', title: 'Invalid inputSchema',
    guideline: 'Provide a valid JSON Schema inputSchema for every tool, with all required parameters declared (§13).' },
  { id: 'tool-param-description', severity: 'info', heuristic: false, source: 'functional', title: 'Parameter without a description',
    guideline: 'Include common synonyms, abbreviations, and alternate spellings in your tool parameter descriptions and enums (§13).' },
  { id: 'tool-overlap', severity: 'info', heuristic: true, source: 'toolsSchema', title: 'Two tools look alike',
    guideline: 'Avoid tools that duplicate or overlap each other’s functionality.' },
];
const RULE = Object.fromEntries(RULES.map((r) => [r.id, r]));

export function finding(id, message, extra = {}) {
  const r = RULE[id];
  return { rule: id, severity: extra.severity || r.severity, title: r.title, message, heuristic: r.heuristic, source: SOURCES[r.source], guideline: r.guideline, ...extra };
}

// ---------- text helpers ----------
// What a voice host says for a tool result: the first text block (MCP `content`), trimmed.
export function speechOf(result) {
  const block = (result?.content || []).find((c) => c && c.type === 'text' && typeof c.text === 'string');
  return block ? block.text.trim() : '';
}
export const wordCount = (s) => (String(s).match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) || []).length;
// About 150 words per minute for a conversational voice (2.5 words a second).
export const speechSeconds = (s) => Math.round((wordCount(s) / 2.5) * 10) / 10;
const excerpt = (text, i, len = 1) => {
  const a = Math.max(0, i - 28), b = Math.min(text.length, i + len + 28);
  return (a > 0 ? '…' : '') + text.slice(a, b).replace(/\s+/g, ' ') + (b < text.length ? '…' : '');
};
function firstMatch(re, text) {
  const m = re.exec(text);
  re.lastIndex = 0;
  return m ? { text: m[0], index: m.index } : null;
}

const RE = {
  pipe: /\s\|\s|\|\s*-{3,}|^\s*\|/m,
  emoji: /\p{Extended_Pictographic}/u,
  markdown: /\*\*[^*]+\*\*|__[^_]+__|^#{1,6}\s|`[^`]+`|^\s*[-*•]\s+\S|\[[^\]]+\]\([^)]+\)|<\/?(b|i|strong|em|br|p|div|span|ul|li)\b[^>]*>/m,
  url: /\bhttps?:\/\/\S+|\bwww\.[a-z0-9-]+\.[a-z]{2,}\S*|\b[\w.+-]+@[\w-]+\.[\w.]+\b/i,
  uuid: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  hex: /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{12,}\b/i,
  prefixedId: /\b[a-z]{2,8}_[A-Za-z0-9]{6,}\b/,
  mixedToken: /\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*[a-z])[A-Za-z0-9]{10,}\b/,
  screen: /\b(on (?:the |your )?(?:screen|display)|shown (?:below|above|here|on)|see (?:the |this )?(?:card|list|table|image|screen)|as you can see|check your (?:display|screen)|(?:tap|click|press|swipe|scroll)\b|the (?:button|card) (?:below|above))/i,
  ordinal: /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/gi,
  enumerated: /^\s*(?:\d{1,2}[.)]|[-*•])\s+\S/gm,
  money: /(?:[$€£]\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:dollars|euros|pounds|USD|EUR|GBP)\b)/gi,
  jargon: /\b(?:HTTP\s?[45]\d\d|[45]\d\d (?:error|bad request|unauthorized|forbidden|not found|internal server error)|error code|exception|stack ?trace|traceback|undefined|null pointer|NaN|ECONN\w+|ETIMEDOUT|errno|invalid_\w+|status code)\b/i,
  nextStep: /\b(try|would you like|you can|please|instead|again|say|ask|check|want me to|shall I|should I|later|another|different)\b/i,
  // High-consequence verbs (purchase, booking, money movement, deletion). Read-only verbs win over them.
  consequential: /\b(buy|purchase|pay|payment|checkout|order|re-?order|book|re-?book|booking|reserve|reservation|transfer|send|charge|subscribe|delete|remove|cancel|refund|confirm)\b/i,
  readOnly: /\b(get|list|find|search|status|show|lookup|look|check|view|track|preview|quote|estimate|read|describe|browse)\b/i,
  confirmParam: /confirm|approval|approve|consent|user_?confirmation|confirmation_?token|token|idempotency|dry_?run|preview/i,
  pendingState: /\b(confirm|should I|shall I|do you want|would you like|say yes|ready to (?:book|order|pay|place)|needs? your (?:ok|yes|approval)|pending)\b/i,
  tracking: /[?&](utm_[a-z]+|fbclid|gclid|mc_eid|msclkid|yclid|igshid)=/i,
};

export function splitWords(name) {
  return String(name || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// Does this tool look like it spends money or destroys something? (annotations first, then its words)
export function isConsequential(tool) {
  const a = tool?.annotations || {};
  if (a.destructiveHint === true) return true;
  if (a.readOnlyHint === true) return false;
  const nameWords = splitWords(tool?.name).join(' ') + ' ' + splitWords(tool?.title || a.title).join(' ');
  if (RE.readOnly.test(nameWords)) return false;
  return RE.consequential.test(nameWords);
}

function hasConfirmationParam(tool) {
  const props = tool?.inputSchema?.properties || {};
  return Object.keys(props).some((k) => RE.confirmParam.test(k));
}

function looksLikeJson(text) {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return false;
  try { JSON.parse(t); return true; } catch { return /^\{\s*"/.test(t); }
}

function countOptions(text) {
  const enumerated = (text.match(RE.enumerated) || []).length;
  const ordinals = new Set((text.match(RE.ordinal) || []).map((w) => w.toLowerCase())).size;
  return Math.max(enumerated, ordinals);
}

// ---------- per call ----------
/**
 * Lint one tool call.
 * @param {object} c
 * @param {object} c.tool     the tool as listed by tools/list
 * @param {object} c.result   the CallToolResult
 * @param {number} [c.ms]     round-trip time
 * @param {string} [c.device] 'show15' | 'show8' | 'phone' | 'dot'
 * @param {object[]} [c.tools] every tool, to spot tool names in speech
 * @returns {object[]} findings
 */
export function lintCall({ tool, args = {}, result, ms, device = 'show8', tools = [] }) {
  const out = [];
  const name = tool?.name || 'tool';
  const add = (id, message, extra) => out.push(finding(id, message, { tool: name, ...extra }));
  const voiceOnly = device === 'dot';
  const speech = speechOf(result);
  const hasStructured = result?.structuredContent && typeof result.structuredContent === 'object' && Object.keys(result.structuredContent).length > 0;
  const hasUi = Boolean(result?._meta?.ui?.resourceUri || tool?._meta?.ui?.resourceUri);

  if (!result || ((!result.content || result.content.length === 0) && !hasStructured)) {
    add('result-empty', 'The result has no content and no structuredContent.');
    return out;
  }

  if (speech) {
    let m;
    if (looksLikeJson(speech)) add('speech-json', 'The first text block is JSON. A voice-only device would read it verbatim.', { excerpt: speech.slice(0, 90) + (speech.length > 90 ? '…' : '') });
    else {
      if ((m = firstMatch(RE.pipe, speech)) || (m = firstMatch(RE.markdown, speech)) || (m = firstMatch(RE.emoji, speech))) add('speech-formatting', `“${m.text.trim()}” would be read aloud or dropped.`, { excerpt: excerpt(speech, m.index, m.text.length) });
      if ((m = firstMatch(RE.uuid, speech)) || (m = firstMatch(RE.hex, speech)) || (m = firstMatch(RE.prefixedId, speech)) || (m = firstMatch(RE.mixedToken, speech))) add('speech-ids', `“${m.text}” looks like an internal identifier.`, { excerpt: excerpt(speech, m.index, m.text.length) });
    }
    if ((m = firstMatch(RE.url, speech))) add('speech-url', `“${m.text.slice(0, 48)}” cannot be used by ear.`, { excerpt: excerpt(speech, m.index, Math.min(m.text.length, 48)) });
    const toolNames = tools.map((t) => t.name).filter((n) => n && n.length > 3 && /[_-]|[a-z][A-Z]/.test(n));
    const said = toolNames.find((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(speech));
    if (said) add('speech-tool-name', `The tool name “${said}” is part of the answer.`, { excerpt: excerpt(speech, speech.indexOf(said), said.length) });
    const secs = speechSeconds(speech);
    if (secs > 30) add('speech-length', `About ${Math.round(secs)} seconds to say (${wordCount(speech)} words at 150 per minute).`);
    if ((m = firstMatch(RE.screen, speech))) add('speech-screen-ref', `“${m.text}” assumes a screen.`, { excerpt: excerpt(speech, m.index, m.text.length), severity: voiceOnly ? 'error' : 'info' });
    const options = countOptions(speech);
    if (options > 5) add('speech-options', `${options} options are read out in one answer.`);
    const amounts = speech.match(RE.money) || [];
    if (amounts.length && hasStructured) {
      const data = JSON.stringify(result.structuredContent);
      const missing = amounts.filter((a) => {
        const n = a.replace(/[^\d.]/g, '').replace(/\.$/, '');
        const num = Number(n);
        return n && !data.includes(n) && !(Number.isFinite(num) && (data.includes(String(num)) || data.includes(String(Math.round(num * 100)))));
      });
      if (missing.length) add('cross-modal-amount', `${missing.join(', ')} is spoken but not found in structuredContent.`);
    }
    if (result.isError) {
      if ((m = firstMatch(RE.jargon, speech)) || looksLikeJson(speech)) add('error-jargon', m ? `“${m.text}” is developer language.` : 'The error is raw JSON.', { excerpt: m ? excerpt(speech, m.index, m.text.length) : speech.slice(0, 80) });
      if (!RE.nextStep.test(speech)) add('error-next-step', 'The error says what failed but not what to do next.', { excerpt: speech.slice(0, 120) });
    }
  }

  const words = wordCount(speech);
  if (!result.isError && (hasStructured || hasUi) && (words < 4 || RE.screen.test(speech) && words < 12)) {
    add('voice-only-incomplete', speech ? `“${speech.slice(0, 60)}” is all a voice-only device would hear.` : 'There is no text content at all: a voice-only device has nothing to say.', { severity: voiceOnly ? 'error' : 'warn' });
  }

  if (!result.isError && isConsequential(tool)) {
    const pending = RE.pendingState.test(speech) || /pending|proposed|awaiting|draft|quote/i.test(JSON.stringify(result.structuredContent || {}).slice(0, 4000));
    if (!hasConfirmationParam(tool) && !pending) add('purchase-no-confirmation', 'Looks like a purchase or a change, and completed in a single call: no confirmation parameter, no pending state.');
    const amounts = speech.match(RE.money) || [];
    const confirming = Object.keys(args).some((k) => RE.confirmParam.test(k));
    if (amounts.length && !confirming && !/\b(total|tax|taxes|fee|fees|subtotal|shipping|delivery)\b/i.test(speech)) add('purchase-breakdown', `${amounts[0]} is spoken without total, taxes or fees.`);
  }

  if (typeof ms === 'number' && ms > 3000) add('slow-call', `${(ms / 1000).toFixed(1)} s round trip${tool?._meta?.ui?.invoking || result?._meta?.ui?.invoking ? '' : ', and no interim “invoking” message is declared'}.`);

  const payload = JSON.stringify({ c: result.content, s: result.structuredContent });
  const t = firstMatch(RE.tracking, payload);
  if (t) add('tracking-params', `“${t.text.replace(/^[?&]/, '')}” found in the payload.`);

  return out;
}

// ---------- per server (tools/list, resources) ----------
export function lintTools(tools = []) {
  const out = [];
  for (const tool of tools) {
    const add = (id, message, extra) => out.push(finding(id, message, { tool: tool.name, ...extra }));
    const d = (tool.description || '').trim();
    if (d.length < 20) add('tool-description', d ? `“${d}” is ${d.length} characters long.` : 'No description.');
    const s = tool.inputSchema;
    if (!s || typeof s !== 'object' || s.type !== 'object') add('tool-schema', s ? `inputSchema.type is “${s.type ?? 'missing'}”, expected “object”.` : 'No inputSchema.');
    else {
      const props = s.properties || {};
      const undeclared = (s.required || []).filter((k) => !(k in props));
      if (undeclared.length) add('tool-schema', `Required but not declared: ${undeclared.join(', ')}.`);
      const bare = Object.entries(props).filter(([, p]) => !p || !(p.description || p.title)).map(([k]) => k);
      if (bare.length) add('tool-param-description', `No description for ${bare.join(', ')}.`);
    }
  }
  // near-duplicate descriptions
  const bag = (t) => new Set(splitWords(`${t.name} ${t.description || ''}`).filter((w) => w.length > 2));
  for (let i = 0; i < tools.length; i++) {
    for (let j = i + 1; j < tools.length; j++) {
      const a = bag(tools[i]), b = bag(tools[j]);
      if (a.size < 4 || b.size < 4) continue;
      const inter = [...a].filter((w) => b.has(w)).length;
      const jaccard = inter / (a.size + b.size - inter);
      if (jaccard >= 0.75) out.push(finding('tool-overlap', `“${tools[i].name}” and “${tools[j].name}” share ${Math.round(jaccard * 100)}% of their words.`, { tool: tools[i].name }));
    }
  }
  return out;
}

export function lintResource({ uri, contents }) {
  const out = [];
  const c = (contents || [])[0];
  if (c && c.mimeType !== 'text/html;profile=mcp-app') out.push(finding('ui-mime', `“${uri}” is served as “${c.mimeType || 'no MIME type'}”.`));
  if (!/[a-f0-9]{6,}|v\d+/i.test(uri.replace(/^ui:\/\/[^/]+/, ''))) out.push(finding('ui-uri-hash', `“${uri}” has no version or hash, so a cache cannot tell old from new.`));
  return out;
}

export const severityRank = { error: 0, warn: 1, info: 2 };
export function summarize(findings) {
  const n = { error: 0, warn: 0, info: 0 };
  for (const f of findings) n[f.severity] = (n[f.severity] || 0) + 1;
  return n;
}
