// Content Security Policy for MCP Apps Views (spec 2026-01-26, "UI Resource" → Host behavior).
// Without `_meta.ui.csp`, the spec's restrictive default applies. Declared domains are added to the matching
// directives only; anything that is not a plain origin (quotes, spaces, semicolons, keywords) is dropped, so a
// resource cannot inject 'unsafe-eval' or a new directive.

const ORIGIN = /^(?:https?|wss?):\/\/(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/i;

export function cleanDomains(list) {
  return Array.isArray(list) ? [...new Set(list.filter((d) => typeof d === 'string' && ORIGIN.test(d.trim())).map((d) => d.trim()))] : [];
}

/** Build the policy string from a `_meta.ui.csp` object (or nothing). */
export function buildCsp(csp = {}) {
  const res = cleanDomains(csp?.resourceDomains);
  const connect = cleanDomains(csp?.connectDomains);
  const frames = cleanDomains(csp?.frameDomains);
  const bases = cleanDomains(csp?.baseUriDomains);
  const r = res.length ? ' ' + res.join(' ') : '';
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline'${r}`,
    `style-src 'self' 'unsafe-inline'${r}`,
    `img-src 'self' data:${r}`,
    `media-src 'self' data:${r}`,
    `font-src 'self' data:${r}`,
    `connect-src ${connect.length ? connect.join(' ') : "'none'"}`,
    `frame-src ${frames.length ? frames.join(' ') : "'none'"}`,
    `base-uri ${bases.length ? bases.join(' ') : "'self'"}`,
    "object-src 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** Insert a CSP meta tag as the first element of <head>, keeping the doctype (no quirks mode). */
export function injectCspMeta(html, policy) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy.replace(/"/g, '&quot;')}">`;
  const s = String(html);
  const head = /<head\b[^>]*>/i.exec(s);
  if (head) return s.slice(0, head.index + head[0].length) + meta + s.slice(head.index + head[0].length);
  const root = /<html\b[^>]*>/i.exec(s);
  if (root) return s.slice(0, root.index + root[0].length) + `<head>${meta}</head>` + s.slice(root.index + root[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(s);
  if (doctype) return doctype[0] + meta + s.slice(doctype[0].length);
  return meta + s;
}
