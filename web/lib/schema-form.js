// A small form from a tool's JSON Schema (string, number, integer, boolean, enum, arrays of scalars; anything else
// as JSON). Used for tools that need arguments the voice could not fill, and for elicitation requests.

const typeOf = (p) => (Array.isArray(p?.type) ? p.type.find((x) => x !== 'null') : p?.type) || (p?.enum ? 'string' : 'string');

/** Turn what was typed into the value the schema expects. Pure, tested. */
export function coerceValue(prop = {}, raw) {
  const type = typeOf(prop);
  if (type === 'boolean') return { value: raw === true || raw === 'true' || raw === 'on' };
  const s = typeof raw === 'string' ? raw.trim() : raw;
  if (s === '' || s === undefined || s === null) return { empty: true };
  if (type === 'number' || type === 'integer') {
    const n = Number(String(s).replace(/,/g, ''));
    if (!Number.isFinite(n)) return { error: 'Enter a number.' };
    if (type === 'integer' && !Number.isInteger(n)) return { error: 'Enter a whole number.' };
    if (typeof prop.minimum === 'number' && n < prop.minimum) return { error: `At least ${prop.minimum}.` };
    if (typeof prop.maximum === 'number' && n > prop.maximum) return { error: `At most ${prop.maximum}.` };
    return { value: n };
  }
  if (type === 'array') {
    const t = typeOf(prop.items);
    if (/^\s*\[/.test(s)) { try { return { value: JSON.parse(s) }; } catch { return { error: 'Invalid JSON array.' }; } }
    const items = String(s).split(',').map((x) => x.trim()).filter(Boolean);
    if (t === 'number' || t === 'integer') {
      const nums = items.map(Number);
      return nums.every(Number.isFinite) ? { value: nums } : { error: 'Numbers separated by commas.' };
    }
    return { value: items };
  }
  if (type === 'object') {
    try { const v = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? { value: v } : { error: 'Enter a JSON object.' }; } catch { return { error: 'Enter a JSON object.' }; }
  }
  if (typeof prop.minLength === 'number' && String(s).length < prop.minLength) return { error: `At least ${prop.minLength} characters.` };
  return { value: String(s) };
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const label = (key, p) => p.title || key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/**
 * @param {object} schema  JSON Schema of type object
 * @param {object} [values] prefilled values
 * @param {string} [idPrefix]
 * @returns {{ element: HTMLElement, read(): {values:object, errors:Record<string,string>}, focusFirstEmpty(): void }}
 */
export function buildForm(schema = {}, values = {}, idPrefix = 'f') {
  const props = schema.properties || {};
  const required = new Set(schema.required || []);
  const root = document.createElement('div');
  root.className = 'schema-form';
  const keys = Object.keys(props);
  if (!keys.length) {
    root.innerHTML = '<p class="schema-empty">No parameters.</p>';
  }
  for (const key of keys) {
    const p = props[key] || {};
    const type = typeOf(p);
    const id = `${idPrefix}-${key}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    const field = document.createElement('div');
    field.className = 'ui-field';
    field.dataset.key = key;
    const hint = p.description ? `<span class="ui-field__hint" id="${id}-hint">${esc(p.description)}</span>` : '';
    const req = required.has(key) ? '' : ' <span class="optional">optional</span>';
    const v = values[key] ?? p.default;
    const described = p.description ? ` aria-describedby="${id}-hint"` : '';
    if (type === 'boolean') {
      field.classList.add('is-switch');
      field.innerHTML = `<label class="switch-row" for="${id}"><span class="ui-field__label">${esc(label(key, p))}${req}</span><input class="ui-switch" type="checkbox" role="switch" id="${id}"${v ? ' checked' : ''}${described}></label>${hint}`;
    } else if (Array.isArray(p.enum)) {
      field.innerHTML = `<label class="ui-field__label" for="${id}">${esc(label(key, p))}${req}</label><select class="ui-select" id="${id}"${described}>${required.has(key) ? '' : '<option value="">—</option>'}${p.enum.map((o) => `<option value="${esc(JSON.stringify(o))}"${JSON.stringify(o) === JSON.stringify(v) ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>${hint}`;
    } else {
      const numeric = type === 'number' || type === 'integer';
      const long = type === 'object' || (type === 'string' && (p.maxLength || 0) > 200);
      const shown = v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      const ph = type === 'array' ? 'Comma-separated' : type === 'object' ? '{ … }' : '';
      field.innerHTML = `<label class="ui-field__label" for="${id}">${esc(label(key, p))}${req}</label>${long
        ? `<textarea class="ui-textarea" id="${id}" rows="3"${described} placeholder="${esc(ph)}">${esc(shown)}</textarea>`
        : `<input class="ui-input" id="${id}" type="${({ email: 'email', uri: 'url', date: 'date', 'date-time': 'datetime-local' })[p.format] || 'text'}" ${numeric ? `inputmode="${type === 'integer' ? 'numeric' : 'decimal'}"` : ''} autocomplete="off" enterkeyhint="go" value="${esc(shown)}"${described} placeholder="${esc(ph)}">`}${hint}<span class="ui-field__error" id="${id}-err" hidden></span>`;
    }
    root.append(field);
  }
  return {
    element: root,
    read() {
      const out = {}, errors = {};
      for (const key of keys) {
        const p = props[key] || {};
        const el = root.querySelector(`[data-key="${CSS.escape(key)}"] input, [data-key="${CSS.escape(key)}"] select, [data-key="${CSS.escape(key)}"] textarea`);
        if (!el) continue;
        let raw = el.type === 'checkbox' ? el.checked : el.value;
        if (el.tagName === 'SELECT') { if (raw === '') raw = ''; else { out[key] = JSON.parse(raw); continue; } }
        const r = coerceValue(p, raw);
        if (r.error) errors[key] = r.error;
        else if (r.empty) { if (required.has(key)) errors[key] = 'Required.'; }
        else out[key] = r.value;
        const err = root.querySelector(`#${CSS.escape(el.id)}-err`);
        if (err) { err.hidden = !errors[key]; err.textContent = errors[key] || ''; el.setAttribute('aria-invalid', String(Boolean(errors[key]))); }
      }
      return { values: out, errors };
    },
    focusFirstEmpty() {
      const el = [...root.querySelectorAll('input:not([type=checkbox]), textarea')].find((x) => !x.value) || root.querySelector('input, select, textarea');
      el?.focus();
    },
  };
}
