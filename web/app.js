// mcp-voice-host: a voice-first MCP Apps host. Connect any Streamable HTTP MCP server, talk or type, and see what
// an Alexa+-style device would say and show: Echo Show 15, Echo Show 8, the Alexa phone app, and a screenless Echo Dot.
// Voice states on the device: idle, listening, thinking, speaking, asking (waiting for an answer or a yes).
import { McpHttpClient, UI_MIME } from './lib/mcp-client.js';
import { AppsHost } from './lib/apps-host.js';
import { DEVICES, DEVICE_IDS, hostContextFor } from './lib/devices.js';
import { keywordBrain, httpBrain, modelVisible, valueForParam, askFor, parseYesNo, followUpCall, isConsequential } from './lib/intent.js';
import { lintCall, lintTools, lintResource, speechOf, summarize, severityRank, finding } from './lib/lint.js';
import { createBrowserTts, createHttpTts, createCaptionsOnly } from './lib/tts.js';
import { buildForm } from './lib/schema-form.js';
import UI from './design-system/motion.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const store = {
  get(k, d) { try { const v = localStorage.getItem('mvh.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mvh.' + k, JSON.stringify(v)); } catch {} },
};
const params = new URLSearchParams(location.search);
const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 10 17 19 7"/></svg>';
const titleOf = (t) => t?.title || t?.annotations?.title || String(t?.name || '').replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

// ---------- state ----------
const S = {
  config: null,
  device: DEVICE_IDS.includes(params.get('device')) ? params.get('device') : store.get('device', innerWidth < 700 ? 'phone' : 'show15'),
  mcp: null,
  tools: [],
  resources: [],
  resourceCache: new Map(),
  pending: null, // { kind: 'slot' | 'confirm' | 'followup', ... }
  busy: false,
  findings: [],
  calls: 0,
  displayMode: 'inline',
  last: null, // last tool call shown { tool, args, result }
};
if (!DEVICE_IDS.includes(S.device)) S.device = 'show15';

// ---------- inspector: traffic ----------
function logTraffic(kind, label, payload, meta = {}) {
  const li = document.createElement('li');
  li.className = kind;
  const now = new Date();
  const t = now.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(now.getMilliseconds()).padStart(3, '0');
  const method = payload?.method || (payload && 'result' in payload ? 'result' : payload?.error ? 'error' : '');
  const name = payload?.params?.name ? ` <i>${esc(payload.params.name)}</i>` : '';
  const ms = meta.ms !== undefined ? `<span class="ms">${meta.ms} ms</span>` : '';
  li.innerHTML = `<details><summary><span class="dir">${esc(label)}</span><span class="t">${t}</span><span class="m">${esc(method)}${name}</span>${ms}</summary></details>`;
  li.querySelector('details').append(Object.assign(document.createElement('pre'), { textContent: JSON.stringify(payload, null, 2).slice(0, 12000) }));
  const log = $('#log');
  log.append(li);
  while (log.children.length > 400) log.firstElementChild.remove();
  if (!$('#trafficView').hidden && !$('#inspector').hidden) li.scrollIntoView({ block: 'end' });
}
function showSession() {
  const m = S.mcp;
  $('#sessionInfo').innerHTML = m?.protocolVersion
    ? `protocol <em>${esc(m.protocolVersion)}</em> · Streamable HTTP · session <em>${esc(m.sessionId || 'none (stateless)')}</em> · ${S.config?.proxy ? 'through the local proxy' : 'direct from the browser'} · views isolated by <em>${esc(S.config?.sandbox?.isolation === 'origin' ? 'a separate origin' : 'an opaque origin')}</em>`
    : 'No session.';
}

// ---------- inspector: lint ----------
const SEV = { error: { word: 'Error', cls: 'critical' }, warn: { word: 'Warning', cls: 'warn' }, info: { word: 'Note', cls: 'info' } };
function addFindings(list) {
  if (!list.length) return;
  for (const f of list) {
    // the same rule on the same tool is shown once, with a counter
    const same = S.findings.find((x) => x.rule === f.rule && x.tool === f.tool && x.message === f.message);
    if (same) { same.count = (same.count || 1) + 1; same.at = Date.now(); continue; }
    S.findings.push({ ...f, at: Date.now() });
  }
  renderLint();
}
function renderLint() {
  const n = summarize(S.findings);
  const c = $('#lintCount');
  const important = n.error + n.warn;
  c.hidden = !important;
  c.textContent = important;
  c.className = 'count' + (n.error ? ' has-error' : '');
  $('#lintToggle').setAttribute('aria-label', `Voice lint, ${n.error} errors, ${n.warn} warnings`);
  const parts = [n.error && `${n.error} error${n.error > 1 ? 's' : ''}`, n.warn && `${n.warn} warning${n.warn > 1 ? 's' : ''}`, n.info && `${n.info} note${n.info > 1 ? 's' : ''}`].filter(Boolean);
  $('#lintSum').textContent = S.findings.length
    ? `${parts.join(', ')} after ${S.calls} tool call${S.calls === 1 ? '' : 's'}${S.tools.length ? ` and ${S.tools.length} tool definitions` : ''}.`
    : S.calls ? `No findings after ${S.calls} tool call${S.calls === 1 ? '' : 's'}.` : 'No findings yet. Every tool result is checked against Amazon’s public Alexa+ add-on design guide.';
  const sorted = [...S.findings].sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.at - a.at);
  $('#lintList').replaceChildren(...sorted.map((f) => {
    const li = document.createElement('li');
    li.className = 'lint-item';
    li.innerHTML = `<p class="li-head"><span class="ui-status ui-status--${SEV[f.severity].cls}">${SEV[f.severity].word}</span><b>${esc(f.title)}</b>${f.count > 1 ? `<span class="li-count">×${f.count}</span>` : ''}</p>
      <p class="li-msg">${f.tool ? `<code>${esc(f.tool)}</code> ` : ''}${esc(f.message)}</p>
      ${f.excerpt ? `<p class="li-excerpt">${esc(f.excerpt)}</p>` : ''}
      <p class="li-rule">“${esc(f.guideline)}”</p>
      <p class="li-src"><a href="${esc(f.source.url)}" target="_blank" rel="noopener">${esc(f.source.label)}</a>${f.heuristic ? ' · heuristic check' : ''}</p>`;
    return li;
  }));
}

// ---------- appearance ----------
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const theme = () => document.documentElement.dataset.theme || (darkQuery.matches ? 'dark' : 'light');
function syncThemeButton() {
  const dark = theme() === 'dark';
  const b = $('#theme');
  b.setAttribute('aria-pressed', String(dark));
  b.setAttribute('aria-label', dark ? 'Light appearance' : 'Dark appearance');
  b.querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
}

// ---------- device frame ----------
function slotSize() {
  const s = $('#cardSlot');
  return { width: s.clientWidth || undefined, height: s.clientHeight || undefined };
}
function context() {
  return hostContextFor(S.device, { theme: theme(), displayMode: S.displayMode, container: slotSize(), locale: navigator.language || 'en-US', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
}
let lastCtx = '';
function pushContext() {
  const ctx = context();
  const key = JSON.stringify(ctx);
  if (key === lastCtx) return;
  const prev = lastCtx ? JSON.parse(lastCtx) : {};
  lastCtx = key;
  const patch = Object.fromEntries(Object.entries(ctx).filter(([k, v]) => JSON.stringify(prev[k]) !== JSON.stringify(v)));
  host?.contextChanged(patch);
}
function fit() {
  const d = DEVICES[S.device];
  if (!d.hasScreen) return;
  const room = $('#room');
  const availW = room.clientWidth;
  const top = room.getBoundingClientRect().top + window.scrollY;
  const availH = Math.max(300, window.innerHeight - top - 64);
  const physW = d.css.w * d.scale, physH = d.css.h * d.scale;
  const fullW = physW + 2 * d.bezel, fullH = physH + 2 * d.bezel;
  const wide = window.innerWidth > 1100;
  const s = Math.min(availW / fullW, wide ? availH / fullH : Infinity, d.id === 'phone' ? 0.9 : 1);
  const dev = $('#device');
  dev.style.width = fullW * s + 'px';
  dev.style.height = fullH * s + 'px';
  const bezel = $('#bezel');
  bezel.style.setProperty('--b', d.bezel + 'px');
  bezel.style.width = fullW + 'px';
  bezel.style.height = fullH + 'px';
  bezel.style.transform = `scale(${s})`;
  const box = $('#screenBox');
  box.style.width = physW + 'px';
  box.style.height = physH + 'px';
  const scr = $('#screen');
  scr.style.width = d.css.w + 'px';
  scr.style.height = d.css.h + 'px';
  scr.style.transform = `scale(${d.scale})`;
  pushContext();
}
function setDevice(id) {
  S.device = id; store.set('device', id);
  document.body.dataset.device = id;
  const r = document.querySelector(`input[name="device"][value="${id}"]`);
  if (r && !r.checked) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
  $('#deviceNote').textContent = `${DEVICES[id].label}: ${DEVICES[id].note}.`;
  if (!DEVICES[id].hasScreen) host?.clear('device has no screen');
  requestAnimationFrame(() => { fit(); pushContext(); if (DEVICES[id].hasScreen && S.last && !host?.active) present(S.last.tool, S.last.args, S.last.result, { quiet: true }); });
}

// ---------- MCP Apps host ----------
let host = null;
function makeHost() {
  host?.destroy();
  host = new AppsHost({
    container: $('#cardSlot'),
    sandboxUrl: S.config.sandbox.url,
    isolation: S.config.sandbox.isolation,
    mcp: S.mcp,
    tools: () => S.tools,
    hostContext: context,
    on: {
      log: (dir, msg) => logTraffic('view', dir, msg),
      csp: ({ policy, isolation }) => logTraffic('view', 'host CSP', { method: 'csp', params: { isolation, policy } }),
      size: ({ height }) => { const f = $('#cardSlot iframe'); if (f && height) f.style.height = Math.min(Math.max(80, height), 4000) + 'px'; },
      message: (text) => turn(text, { fromView: true }),
      openLink: (url) => window.open(url, '_blank', 'noopener'),
      modelContext: (c) => logTraffic('view', 'model context', { method: 'ui/update-model-context', params: c }),
      displayMode: (mode) => { S.displayMode = mode; document.body.classList.toggle('fullscreen', mode === 'fullscreen'); requestAnimationFrame(pushContext); },
      toolResult: ({ tool, args, result, ms }) => present(tool, args, result, { ms, fromView: true }),
      noInitialize: (tool) => addFindings([finding('ui-no-initialize', `The view for “${tool.name}” sent no ui/notifications/initialized within 3 seconds.`, { tool: tool.name })]),
    },
  });
}

async function readUi(uri) {
  if (S.resourceCache.has(uri)) return S.resourceCache.get(uri);
  const r = await S.mcp.readResource(uri);
  const c = (r.contents || [])[0] || {};
  const listed = S.resources.find((x) => x.uri === uri);
  const html = typeof c.text === 'string' ? c.text : c.blob ? new TextDecoder().decode(Uint8Array.from(atob(c.blob), (ch) => ch.charCodeAt(0))) : '';
  addFindings(lintResource({ uri, contents: r.contents }));
  const entry = { html, meta: { uri, ...(listed?._meta?.ui || {}), ...(c._meta?.ui || {}) }, mimeType: c.mimeType };
  S.resourceCache.set(uri, entry);
  return entry;
}

// Alexa renders data-only results with its own components ("hydrated"); this host shows a plain equivalent.
function hydrated(tool, result) {
  const d = result?.structuredContent;
  const speech = speechOf(result);
  const fields = [];
  const walk = (v, path) => {
    if (fields.length >= 4) return;
    if (v === null || v === undefined) return;
    if (typeof v !== 'object') { fields.push([path, v]); return; }
    if (Array.isArray(v)) { fields.push([path, `${v.length} item${v.length === 1 ? '' : 's'}`]); return; }
    for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  if (d && typeof d === 'object') walk(d, '');
  const label = (k) => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  const el = document.createElement('div');
  el.className = 'hydrated' + (result?.isError ? ' is-error' : '');
  el.innerHTML = `<p class="hy-ctx"><span>${esc(titleOf(tool))}</span><span>${result?.isError ? 'Error' : 'Data only · rendered by the host'}</span></p>
    <p class="hy-title">${esc(speech || (d ? 'Structured data, no text content' : 'No content'))}</p>
    ${fields.length ? `<dl class="hy-fields">${fields.map(([k, v]) => `<div><dt>${esc(label(k))}</dt><dd>${esc(String(v).slice(0, 80))}</dd></div>`).join('')}</dl>` : ''}`;
  return el;
}

// ---------- voice level (real microphone level while listening) ----------
const BARS = 14;
$('#wave').innerHTML = Array.from({ length: BARS }, (_, i) => `<i style="--i:${i}"></i>`).join('');
const bars = [...$('#wave').children];
let lvl = 0, target = 0, analyser = null, micStream = null, raf = 0;
function levelLoop() {
  const s = document.body.dataset.state;
  if (analyser) {
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    let sum = 0; for (const v of buf) sum += ((v - 128) / 128) ** 2;
    target = Math.min(1, Math.sqrt(sum / buf.length) * 5);
  } else if (s === 'speaking') target *= 0.9;
  else target = 0;
  lvl += (target - lvl) * 0.25;
  document.body.style.setProperty('--lvl', lvl.toFixed(3));
  const t = performance.now() / 1000;
  bars.forEach((b, i) => { const c = Math.exp(-(((i - BARS / 2) / (BARS / 3)) ** 2)); b.style.setProperty('--l', Math.max(0, Math.min(1, lvl * c * (0.6 + 0.4 * Math.sin(t * 9 + i * 1.3)))).toFixed(3)); });
  if (s === 'listening' || s === 'speaking' || lvl > 0.01) raf = requestAnimationFrame(levelLoop);
  else { raf = 0; document.body.style.setProperty('--lvl', '0'); bars.forEach((b) => b.style.setProperty('--l', '0')); }
}
const kickLevel = () => { if (!raf) raf = requestAnimationFrame(levelLoop); };
async function openMicLevel() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = ctx.createAnalyser(); analyser.fftSize = 512;
    ctx.createMediaStreamSource(micStream).connect(analyser);
    analyser._ctx = ctx;
  } catch { analyser = null; }
}
function closeMicLevel() { micStream?.getTracks().forEach((t) => t.stop()); micStream = null; analyser?._ctx?.close?.(); analyser = null; }

// ---------- voice out ----------
let tts = createBrowserTts();
let ttsAbort = null;
function chooseTts(mode) {
  store.set('tts', mode);
  tts.cancel();
  if (mode === 'captions') tts = createCaptionsOnly();
  else if (S.config?.tts?.provider === 'http') tts = createHttpTts({ url: S.config.tts.url, headers: S.config.proxy?.token ? { 'x-mvh-token': S.config.proxy.token } : {} });
  else tts = createBrowserTts();
}
function setReply(text, { error = false } = {}) {
  const el = $('#reply');
  el.classList.toggle('long', text.length > 150);
  el.classList.toggle('err', error);
  el.replaceChildren(...text.split(/(\s+)/).map((w) => (/^\s+$/.test(w) ? document.createTextNode(w) : Object.assign(document.createElement('span'), { className: 'w', textContent: w }))));
  $('#dotSays').textContent = text;
}
function markSaid(charIndex) {
  let i = 0;
  for (const n of $('#reply').childNodes) { if (n.nodeType === 1 && i <= charIndex) n.classList.add('said'); i += n.textContent.length; }
}
async function speak(text) {
  if (!text) return;
  ttsAbort?.abort();
  ttsAbort = new AbortController();
  setState('speaking');
  kickLevel();
  try { await tts.speak(text.length > 600 ? text.slice(0, 600) + '…' : text, { onWord: (i) => { markSaid(i); target = 0.65 + Math.random() * 0.35; }, signal: ttsAbort.signal }); }
  catch (e) { logTraffic('orch', 'voice', { method: 'tts-error', error: { message: e.message } }); }
  finally { markSaid(Infinity); setState(S.pending ? 'asking' : 'idle'); }
}

// ---------- voice in ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function micHint(text, err = false) { const h = $('#micHint'); h.textContent = text; h.classList.toggle('err', err); }
function listen() {
  if (!SR) { micHint('This browser has no speech recognition. Type below, or use Chrome, Edge or Safari.', true); $('#typeInput').focus(); return; }
  if (rec) { rec.stop(); return; }
  tts.cancel(); ttsAbort?.abort();
  rec = new SR();
  rec.lang = navigator.language?.startsWith('en') ? navigator.language : 'en-US';
  rec.interimResults = true; rec.maxAlternatives = 1;
  let final = '';
  rec.onresult = (e) => { final = [...e.results].map((r) => r[0].transcript).join(' '); showHeard(final); };
  rec.onend = () => { rec = null; closeMicLevel(); setState(S.pending ? 'asking' : 'idle'); if (final.trim()) turn(final.trim()); };
  rec.onerror = (e) => {
    rec = null; closeMicLevel(); setState(S.pending ? 'asking' : 'idle');
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') micHint('Microphone blocked. Allow it from the address bar, then tap again, or type below.', true);
    else if (e.error === 'no-speech') micHint('I didn’t hear anything. Tap and speak, or type below.');
    else if (e.error === 'network') micHint('Speech recognition needs a network connection in this browser. Type below instead.', true);
  };
  setState('listening');
  micHint('Listening… tap again to stop.');
  openMicLevel().then(kickLevel);
  try { rec.start(); } catch { rec = null; setState('idle'); }
}

// ---------- the turn ----------
const LABELS = { idle: 'Tap to talk', listening: 'Listening…', thinking: 'Working…', speaking: 'Speaking', asking: 'Waiting for your answer' };
function setState(s) {
  document.body.dataset.state = s;
  $('#voice').dataset.state = s === 'asking' ? 'idle' : s;
  $('#micLabel').textContent = LABELS[s];
  $('#mic').setAttribute('aria-label', s === 'listening' ? 'Stop listening' : 'Talk');
}
function showHeard(text) {
  $('#heard').textContent = text ? `“${text}”` : '';
  $('#heard').classList.toggle('on', Boolean(text));
  $('#dotYou').textContent = text ? `“${text}”` : '';
}
function setAsk(text) {
  $('#ask').hidden = !text;
  if (text) $('#askText').textContent = text;
}
function setBusy(on) {
  S.busy = on;
  const b = $('#send');
  if (on) { b.disabled = true; b.setAttribute('aria-busy', 'true'); b.setAttribute('aria-label', 'Working'); b.innerHTML = '<span class="spin" aria-hidden="true"></span>'; }
  else { b.removeAttribute('aria-busy'); b.setAttribute('aria-label', 'Send'); b.innerHTML = '<svg class="ui-icon"><use href="#i-up"/></svg>'; b.disabled = !$('#typeInput').value.trim(); }
  for (const r of document.querySelectorAll('#toolList .ui-row')) r.toggleAttribute('aria-disabled', on);
}
function showTrail(steps) {
  $('#trail').replaceChildren(...steps.map((s, i) => {
    const li = document.createElement('li');
    li.innerHTML = CHECK;
    li.append(s);
    li.style.animationDelay = `${i * 90}ms`;
    return li;
  }));
}

// Say something without calling a tool (questions, refusals, help).
async function hostSays(text, { ask = null } = {}) {
  setReply(text);
  setAsk(ask);
  if (document.body.dataset.screen === 'home' && DEVICES[S.device].hasScreen) document.body.dataset.screen = 'card';
  await speak(text);
}

async function turn(text, { fromView = false } = {}) {
  text = String(text || '').trim();
  if (!text || S.busy) return;
  if (!S.mcp?.protocolVersion) { showHeard(text); await hostSays('Connect an MCP server first, then ask again.'); return; }
  tts.cancel(); ttsAbort?.abort();
  showHeard(text);
  logTraffic('orch', fromView ? 'view → host' : 'you', { method: 'utterance', params: { text } });
  const p = S.pending;
  if (p) {
    if (p.kind === 'slot') {
      const prop = p.tool.inputSchema?.properties?.[p.key] || {};
      const v = valueForParam(text, prop);
      if (v.error) { await hostSays(v.error === 'empty' ? askFor(p.key, prop) : v.error, { ask: 'Waiting for your answer' }); return; }
      p.args[p.key] = v.value;
      return proceed(p.tool, p.args, { confirmed: p.confirmed });
    }
    const yn = parseYesNo(text);
    if (p.kind === 'confirm' && yn !== null) {
      S.pending = null; setAsk(null);
      if (yn) return proceed(p.tool, p.args, { confirmed: true });
      return hostSays('Okay, I didn’t run it.');
    }
    if (p.kind === 'followup' && yn !== null) {
      S.pending = null; setAsk(null);
      if (!yn) return hostSays('Okay.');
      const next = followUpCall({ tool: p.tool, args: p.args, result: p.result, tools: S.tools, utterance: text });
      if (next) return run(next.tool, next.arguments);
      // No tool can take the yes directly: let the matcher try the words themselves.
    }
    S.pending = null; setAsk(null);
  }
  const route = await brain().route(text, S.tools, { device: S.device, lastTool: S.last?.tool?.name || null });
  if (route.brainError) logTraffic('orch', 'brain', { method: 'brain-error', error: { message: `${route.brainError}; used the keyword matcher instead` } });
  if (!route.tool) {
    await hostSays(route.say);
    return;
  }
  logTraffic('orch', route.by === 'brain' ? 'brain' : 'keyword matcher', { method: 'route', params: { tool: route.tool.name, arguments: route.arguments, missing: route.missing, score: route.score, alternatives: (route.alternatives || []).map((t) => t.name) } });
  return proceed(route.tool, route.arguments || {});
}

let brainCache = null;
function brain() {
  if (!S.config?.brain?.url) return keywordBrain;
  return (brainCache ||= httpBrain({ url: S.config.brain.url, headers: S.config.proxy?.token ? { 'x-mvh-token': S.config.proxy.token } : {} }));
}

// Ask for missing arguments one by one, protect against blind purchases, then call.
async function proceed(tool, args, { confirmed = false } = {}) {
  const schema = tool.inputSchema || {};
  const missing = (schema.required || []).filter((k) => !(k in args) && k in (schema.properties || {}));
  if (missing.length) {
    const key = missing[0];
    const prop = schema.properties[key] || {};
    if (typeOf(prop) === 'object' || (typeOf(prop) === 'array' && typeOf(prop.items) === 'object')) { openToolSheet(tool, args); return hostSays(`${titleOf(tool)} needs details I can’t take by voice. The form is open in the side panel.`); }
    S.pending = { kind: 'slot', tool, args, key, confirmed };
    return hostSays(askFor(key, prop), { ask: 'Waiting for your answer' });
  }
  // Host safety (not the add-on's job, the tester's): a purchase-like tool with no confirmation step of its own.
  const props = Object.keys(schema.properties || {});
  if (!confirmed && isConsequential(tool) && !props.some((k) => /confirm|token|approval|consent|dry_?run|preview/i.test(k))) {
    S.pending = { kind: 'confirm', tool, args };
    return hostSays(`Heads-up: “${titleOf(tool)}” looks like a purchase or a change, and has no confirmation step of its own. Run it anyway?`, { ask: 'Say “yes” to run it' });
  }
  return run(tool, args);
}
const typeOf = (p) => (Array.isArray(p?.type) ? p.type.find((x) => x !== 'null') : p?.type);

async function run(tool, args) {
  setBusy(true);
  setAsk(null);
  setState('thinking');
  if (DEVICES[S.device].hasScreen) document.body.dataset.screen = 'card';
  const interim = tool._meta?.ui?.invoking;
  setReply(interim || '');
  showTrail([`${titleOf(tool)}…`]);
  const started = performance.now();
  let result;
  try {
    result = await S.mcp.callTool(tool.name, args);
  } catch (e) {
    setBusy(false);
    const msg = e.code === 'network' ? 'I couldn’t reach the server, so nothing ran. Check that it’s running, then try again.' : `The server refused the call: ${e.message}`;
    setReply(msg, { error: true });
    setState('idle');
    showTrail([`${titleOf(tool)} failed`]);
    return speak(msg);
  }
  const ms = Math.round(performance.now() - started);
  setBusy(false);
  return present(tool, args, result, { ms });
}

// Show and say one result; lint it.
async function present(tool, args, result, { ms, fromView = false, quiet = false } = {}) {
  S.last = { tool, args, result };
  if (!quiet) {
    S.calls++;
    addFindings(lintCall({ tool, args, result, ms, device: S.device, tools: S.tools }));
    renderLint();
    showTrail([`${titleOf(tool)}${ms !== undefined ? ` · ${ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s'}` : ''}${result?.isError ? ' · error' : ''}`]);
  }
  const speech = speechOf(result);
  const d = DEVICES[S.device];
  const uri = result?._meta?.ui?.resourceUri || tool._meta?.ui?.resourceUri;
  if (d.hasScreen) {
    document.body.dataset.screen = 'card';
    if (fromView && host?.active) { /* the view already shows its own update */ }
    else if (uri && !result?.isError) {
      try {
        const ui = await readUi(uri);
        if (ui.mimeType && ui.mimeType !== UI_MIME) throw new Error('wrong MIME type');
        S.displayMode = 'inline'; document.body.classList.remove('fullscreen');
        await host.show({ html: ui.html, meta: ui.meta, tool, args, result });
      } catch (e) {
        logTraffic('view', 'host', { method: 'ui-error', error: { message: e.message } });
        await host.clear('render failed');
        $('#cardSlot').replaceChildren(hydrated(tool, result));
      }
    } else {
      await host?.clear('replaced');
      $('#cardSlot').replaceChildren(hydrated(tool, result));
    }
  }
  if (quiet) return;
  // A question in the answer: wait for it. A yes may complete the call (confirmation token, plan id…).
  const asks = !result?.isError && /\?\s*$/.test(speech);
  S.pending = asks ? { kind: 'followup', tool, args, result } : null;
  const canYes = asks && followUpCall({ tool, args, result, tools: S.tools });
  setAsk(canYes ? 'Say “yes” to confirm' : asks ? 'Waiting for your answer' : null);
  if (speech) { setReply(speech, { error: Boolean(result?.isError) }); await speak(speech); }
  else { setReply(result?.isError ? 'The tool failed without a message.' : 'No text content: a voice-only device would stay silent.', { error: true }); setState(S.pending ? 'asking' : 'idle'); }
}

// ---------- tools list and sheet ----------
function renderTools() {
  const list = $('#toolList');
  const visible = S.tools.filter(modelVisible);
  const hidden = S.tools.length - visible.length;
  $('#toolsCount').textContent = S.tools.length ? `${visible.length}${hidden ? ` + ${hidden} app-only` : ''}` : '';
  if (!S.tools.length) { list.innerHTML = `<li class="tools-empty">${S.mcp?.protocolVersion ? 'This server lists no tools.' : 'Connect a server to list its tools.'}</li>`; return; }
  list.replaceChildren(...visible.map((t) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ui-row';
    const flags = [t._meta?.ui?.resourceUri ? 'Card' : 'Data only', isConsequential(t) ? 'Consequential' : null].filter(Boolean).join(' · ');
    b.innerHTML = `<div class="ui-row__body"><span class="ui-row__title">${esc(titleOf(t))}</span><span class="ui-row__subtitle">${esc((t.description || 'No description').split(/(?<=\.)\s/)[0].slice(0, 120))}</span></div><span class="ui-row__detail">${esc(flags)}</span><svg class="ui-icon ui-row__chevron"><use href="#i-chev"/></svg>`;
    b.onclick = () => { if (!S.busy) openToolSheet(t, {}); };
    li.append(b);
    return li;
  }));
}
let sheetForm = null, sheetTool = null, sheetResolve = null;
function openToolSheet(tool, values) {
  sheetTool = tool; sheetResolve = null;
  $('#toolSheetTitle').textContent = titleOf(tool);
  $('#toolSheetDesc').textContent = tool.description || '';
  $('#toolSheetRun').textContent = 'Run';
  sheetForm = buildForm(tool.inputSchema || {}, values, 'tool');
  $('#toolSheetFields').replaceChildren(sheetForm.element);
  UI.openSheet($('#toolSheet'));
  setTimeout(() => sheetForm.focusFirstEmpty(), 60);
}
function openElicitation({ message, requestedSchema }) {
  return new Promise((resolve) => {
    sheetTool = null; sheetResolve = resolve;
    $('#toolSheetTitle').textContent = 'The server asks';
    $('#toolSheetDesc').textContent = message || '';
    $('#toolSheetRun').textContent = 'Send';
    sheetForm = buildForm(requestedSchema || {}, {}, 'elicit');
    $('#toolSheetFields').replaceChildren(sheetForm.element);
    UI.openSheet($('#toolSheet'));
    if (DEVICES[S.device].hasScreen) document.body.dataset.screen = 'card';
    setReply(message || 'The server needs more information.');
    speak(message || '');
  });
}
$('#toolSheetCancel').onclick = () => {
  UI.closeSheet($('#toolSheet'), 'cancel');
  if (sheetResolve) { sheetResolve({ action: 'cancel' }); sheetResolve = null; }
};
$('#toolSheet').addEventListener('close', () => { if (sheetResolve) { sheetResolve({ action: 'cancel' }); sheetResolve = null; } });
$('#toolSheetForm').onsubmit = (e) => {
  e.preventDefault();
  const { values, errors } = sheetForm.read();
  if (Object.keys(errors).length) { $('#toolSheetFields').querySelector('[aria-invalid="true"]')?.focus(); return; }
  if (sheetResolve) { const r = sheetResolve; sheetResolve = null; UI.closeSheet($('#toolSheet'), 'ok'); r({ action: 'accept', content: values }); return; }
  UI.closeSheet($('#toolSheet'), 'ok');
  const tool = sheetTool;
  S.pending = null;
  showHeard(`${titleOf(tool)} (form)`);
  logTraffic('orch', 'you', { method: 'form', params: { tool: tool.name, arguments: values } });
  proceed(tool, values);
};

// ---------- connection ----------
function setConn(state, detail = '') {
  document.body.dataset.conn = state;
  const dot = $('#connDot');
  dot.className = 'ui-status ' + ({ ok: 'ui-status--ok', busy: 'ui-status--info', error: 'ui-status--critical' }[state] || '');
  dot.textContent = { ok: 'Connected', busy: 'Connecting…', error: 'Not connected', idle: 'Not connected' }[state];
  $('#connDetail').textContent = detail;
  $('#connect').textContent = state === 'ok' ? 'Reconnect' : 'Connect';
  $('#connect').disabled = state === 'busy';
}
function renderHome() {
  const m = S.mcp;
  const name = m?.serverInfo?.title || m?.serverInfo?.name;
  $('#hwState').textContent = m?.protocolVersion ? 'Connected' : document.body.dataset.conn === 'error' ? 'Offline' : 'Not connected';
  $('#hwTitle').textContent = m?.protocolVersion ? `${name || 'Server'}: ${S.tools.filter(modelVisible).length} tools ready` : document.body.dataset.conn === 'error' ? 'Cannot reach the server.' : 'Connect a server to start.';
  const tries = S.tools.filter(modelVisible).slice(0, 3).map((t) => titleOf(t));
  $('#hwTry').replaceChildren(...tries.map((t) => Object.assign(document.createElement('li'), { textContent: `“${t}”` })));
  $('#barServer').textContent = m?.protocolVersion ? `${name || new URL(m.url).host} · ${m.protocolVersion}` : 'Not connected';
}

async function connect(url) {
  url = String(url || '').trim();
  try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) throw 0; } catch { setConn('error', 'Enter an http or https URL, for example http://localhost:3001/mcp.'); $('#serverUrl').focus(); return; }
  store.set('server', url);
  setConn('busy', new URL(url).host);
  await S.mcp?.close?.();
  S.tools = []; S.resources = []; S.resourceCache.clear(); S.pending = null; S.last = null;
  S.findings = S.findings.filter((f) => !f.server); // keep call findings, reset tool-definition ones
  await host?.clear('server changed');
  document.body.dataset.screen = 'home';
  renderTools(); renderHome();
  S.mcp = new McpHttpClient(url, {
    proxy: S.config.proxy,
    onLog: (dir, msg, meta) => logTraffic(dir === 'out' ? 'out' : 'in', dir === 'out' ? 'host → server' : 'server → host', msg, meta),
    onNotification: (msg) => { if (msg.method === 'notifications/tools/list_changed') refreshTools(); },
    onServerRequest: ({ params: p }) => openElicitation(p || {}),
  });
  makeHost();
  try {
    await S.mcp.initialize();
    showSession();
    await refreshTools();
    S.resources = await S.mcp.listResources().catch(() => []);
    setConn('ok', `${S.mcp.serverInfo?.title || S.mcp.serverInfo?.name || ''} · ${S.tools.length} tools`);
    const params2 = new URLSearchParams(location.search); params2.set('server', url); history.replaceState(null, '', `?${params2}`);
  } catch (e) {
    S.mcp.protocolVersion = null;
    const hint = S.config.proxy ? '' : ' Opened without the CLI: the server must allow this page’s origin (CORS). Run “npx github:blanco1er/mcp-voice-host” to use the local proxy.';
    setConn('error', `${e.message}${e.code === 'network' ? hint : ''}`);
    showSession();
  }
  renderHome();
  renderLint();
}
async function refreshTools() {
  S.tools = await S.mcp.listTools();
  S.findings = S.findings.filter((f) => !f.server);
  addFindings(lintTools(S.tools).map((f) => ({ ...f, server: true })));
  renderTools();
  renderHome();
  $('#typeInput').placeholder = S.tools.length ? titleOf(S.tools.find(modelVisible) || S.tools[0]) : 'Find iced drinks';
}

// ---------- inspector toggles ----------
function openInspector(tab) {
  const insp = $('#inspector');
  const open = insp.hidden || document.querySelector('input[name="insp"]:checked').value !== tab;
  insp.hidden = !open;
  if (open) {
    const r = document.querySelector(`input[name="insp"][value="${tab}"]`);
    if (!r.checked) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
    showTab(tab);
  }
  $('#lintToggle').setAttribute('aria-expanded', String(open && tab === 'lint'));
  $('#trafficToggle').setAttribute('aria-expanded', String(open && tab === 'traffic'));
}
function showTab(tab) {
  $('#lintView').hidden = tab !== 'lint';
  $('#trafficView').hidden = tab !== 'traffic';
  store.set('tab', tab);
  $('#lintToggle').setAttribute('aria-expanded', String(!$('#inspector').hidden && tab === 'lint'));
  $('#trafficToggle').setAttribute('aria-expanded', String(!$('#inspector').hidden && tab === 'traffic'));
  if (tab === 'traffic') $('#log').lastElementChild?.scrollIntoView({ block: 'end' });
}
for (const r of document.querySelectorAll('input[name="insp"]')) r.addEventListener('change', () => r.checked && showTab(r.value));
$('#lintToggle').onclick = () => openInspector('lint');
$('#trafficToggle').onclick = () => openInspector('traffic');
$('#closeInsp').onclick = () => { $('#inspector').hidden = true; showTab(store.get('tab', 'lint')); $('#lintToggle').focus({ preventScroll: true }); };
$('#clearInsp').onclick = () => {
  if (!$('#lintView').hidden) { S.findings = S.findings.filter((f) => f.server); S.calls = 0; renderLint(); }
  else $('#log').replaceChildren();
};

// ---------- wiring ----------
for (const r of document.querySelectorAll('input[name="device"]')) r.addEventListener('change', () => { if (r.checked && r.value !== S.device) setDevice(r.value); });
for (const r of document.querySelectorAll('input[name="tts"]')) r.addEventListener('change', () => r.checked && chooseTts(r.value));
$('#theme').onclick = () => {
  const t = theme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t; store.set('theme', t);
  syncThemeButton(); pushContext();
};
darkQuery.addEventListener('change', () => { syncThemeButton(); pushContext(); });
$('#mic').onclick = listen;
$('#typeInput').addEventListener('input', () => { if (!S.busy) $('#send').disabled = !$('#typeInput').value.trim(); });
$('#typeForm').onsubmit = (e) => { e.preventDefault(); const v = $('#typeInput').value.trim(); if (v && !S.busy) { $('#typeInput').value = ''; $('#send').disabled = true; turn(v); } };
$('#connForm').onsubmit = (e) => { e.preventDefault(); connect($('#serverUrl').value); };
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, dialog')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'l' || e.key === 'L') openInspector('lint');
  else if (e.key === 't' || e.key === 'T') openInspector('traffic');
  else if (e.key === 'Escape' && !$('#inspector').hidden) $('#closeInsp').click();
  else if (e.code === 'Space' && !e.target.closest('button, a')) { e.preventDefault(); listen(); }
});
const tick = () => {
  const now = new Date();
  const hm = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/, '');
  $('#clock').textContent = hm;
  $('#homeTime').textContent = hm;
  $('#homeDate').textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
};

// Example servers: the CLI's demo, the official MCP "everything" server, and a live public add-on.
function renderTries() {
  const tries = [
    S.config.server && { label: S.config.server.includes('localhost') ? 'Local demo' : 'This session’s server', url: S.config.server },
    { label: 'MCP “everything” on :3001', url: 'http://localhost:3001/mcp' },
    { label: 'Mandat (live)', url: 'https://fonzkp2f5pszfit6xmqqiw7qdm0dybyu.lambda-url.us-east-1.on.aws/mcp' },
  ].filter(Boolean);
  $('#connTry').innerHTML = '<span>Try</span>' + tries.map((t) => `<button type="button" class="ui-button ui-button--plain ui-button--sm" data-url="${esc(t.url)}">${esc(t.label)}</button>`).join('');
  for (const b of $('#connTry').querySelectorAll('button')) b.onclick = () => { $('#serverUrl').value = b.dataset.url; connect(b.dataset.url); };
}

// ---------- boot ----------
(async () => {
  const savedTheme = params.get('theme') || store.get('theme', null);
  if (savedTheme === 'light' || savedTheme === 'dark') document.documentElement.dataset.theme = savedTheme;
  UI.init();
  syncThemeButton();
  tick(); setInterval(tick, 15000);
  try {
    const r = await fetch('config.json', { cache: 'no-store' });
    if (!r.ok) throw 0;
    S.config = await r.json();
    S.config.sandbox.url = new URL(S.config.sandbox.url, location.href).href;
  } catch {
    S.config = { server: '', proxy: null, sandbox: { url: new URL('sandbox.html', location.href).href, isolation: 'opaque' }, tts: { provider: 'browser' } };
  }
  const ttsMode = params.get('tts') || store.get('tts', 'voice');
  const ttsRadio = document.querySelector(`input[name="tts"][value="${ttsMode === 'captions' ? 'captions' : 'voice'}"]`);
  ttsRadio.checked = true; ttsRadio.dispatchEvent(new Event('change', { bubbles: true }));
  chooseTts(ttsMode === 'captions' ? 'captions' : 'voice');
  if (!SR) micHint('No speech recognition in this browser: type below (Chrome, Edge and Safari can listen).');
  if (S.config.brain?.url) $('#toolsFoot').textContent = 'Speak or type a request: your brain endpoint picks the tool (the keyword matcher takes over if it fails), and the host asks for anything missing. Or open a tool to fill its form.';
  renderTries();
  setDevice(S.device);
  window.addEventListener('resize', fit);
  new ResizeObserver(() => fit()).observe($('#room'));
  let slotRaf = 0;
  new ResizeObserver(() => { cancelAnimationFrame(slotRaf); slotRaf = requestAnimationFrame(pushContext); }).observe($('#cardSlot'));
  const tab = store.get('tab', 'lint');
  if (params.get('inspector')) openInspector(params.get('inspector'));
  else showTab(tab);
  renderLint(); renderTools(); renderHome(); showSession();
  const url = params.get('server') || S.config.server || store.get('server', '');
  $('#serverUrl').value = url;
  if (url && params.get('connect') !== '0') await connect(url);
  if (params.get('say')) for (const line of params.getAll('say')) { await turn(line); while (S.busy) await new Promise((r) => setTimeout(r, 50)); }
  document.body.dataset.ready = '1';
})();
