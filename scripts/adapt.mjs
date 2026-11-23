// Build-time adapter: rewrites crossnote theme CSS (written for rendered HTML: `html body h1`, `body p`, ...)
// into selectors for the CodeMirror live-preview DOM (`.cm-line.lm-h1`, `.cm-lm-strong`, ...).
// Rules that cannot be mapped (dl, math, task-list classes, ...) are dropped. `report` collects what was dropped.

const LINE = { h1: 'lm-h1', h2: 'lm-h2', h3: 'lm-h3', h4: 'lm-h4', h5: 'lm-h5', h6: 'lm-h6', p: 'lm-p', blockquote: 'lm-quote', pre: 'lm-pre', li: 'lm-li', hr: 'lm-hr' };
const MARK = { code: '.cm-lm-code', a: '.cm-lm-link', strong: '.cm-lm-strong', b: '.cm-lm-strong', em: '.cm-lm-em', i: '.cm-lm-em', del: '.cm-lm-del', s: '.cm-lm-del' };
const TABLE = new Set(['table', 'thead', 'tbody', 'tr', 'th', 'td']);
const PAGE_CLASSES = new Set(['markdown-preview', 'crossnote', 'preview-container']);

function splitTop(s, sepRe) {
  // split on top level (outside [] and ()) matches of single-char separators
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if ('[('.includes(ch)) depth++;
    else if ('])'.includes(ch)) depth--;
    if (depth === 0 && sepRe.test(ch)) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Split `a > b c` into [{comb, compound}] keeping combinators. */
function parts(sel) {
  const res = []; let depth = 0, cur = '', comb = '';
  const flush = () => { if (cur) { res.push({ comb, compound: cur }); cur = ''; comb = ''; } };
  for (const ch of sel.trim()) {
    if ('[('.includes(ch)) depth++;
    if ('])'.includes(ch)) depth--;
    if (depth === 0 && /[\s>+~]/.test(ch)) { flush(); comb += ch; } else cur += ch;
  }
  flush();
  return res.map((p) => ({ comb: p.comb.replace(/\s+/g, ' '), compound: p.compound }));
}

function tagOf(compound) { const m = /^([a-zA-Z][a-zA-Z0-9]*)(.*)$/.exec(compound); return m ? { tag: m[1].toLowerCase(), rest: m[2] } : { tag: '', rest: compound }; }
const PSEUDO_ONLY = /^(?::{1,2}[a-z-]+(?:\([^)]*\))?)*$/;

function mapSelector(sel, kind) {
  sel = sel.trim();
  if (!sel) return null;
  if (kind === 'prism') {
    if (/^(pre|code)\[class\*=language-\]$/.test(sel)) return '.cm-line.lm-pre';
    return /^\.(token|namespace)/.test(sel) ? sel : null;
  }
  const ps = parts(sel);
  let i = 0;
  while (i < ps.length) {
    const c = ps[i].compound;
    const { tag, rest } = tagOf(c);
    const classes = [...c.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
    const pageLevel = (tag === 'html' || tag === 'body' || tag === '') && (classes.length === 0 ? tag !== '' : classes.every((k) => PAGE_CLASSES.has(k)));
    if (pageLevel && !/[:\[]/.test(rest.replace(/\.[\w-]+/g, ''))) i++; else break;
  }
  const stripped = ps.slice(i);
  if (stripped.length === 0) return sel; // a rule about the page itself: keep verbatim
  const first = tagOf(stripped[0].compound);
  if (TABLE.has(first.tag)) return '.lm-tablewrap ' + stripped.map((p) => p.comb + p.compound).join('').trim();
  if (stripped.length !== 1) return null;
  const { tag, rest } = first;
  if (!PSEUDO_ONLY.test(rest) || /\[/.test(rest)) return null;
  if (tag === 'a' || tag === 'li' || tag === 'h1' || /^h[1-6]$/.test(tag)) { if (/::?(before|after)/.test(rest) && tag !== 'a') return null; }
  if (LINE[tag]) {
    if (/::?(before|after)/.test(rest) && tag !== 'blockquote' && tag !== 'pre') return null;
    return `.cm-line.${LINE[tag]}${rest}`;
  }
  if (MARK[tag]) return MARK[tag] + rest;
  if (tag === 'img') return '.lm-imgwrap img' + rest;
  return null;
}

/**
 * CodeMirror measures a line as its box height and ignores vertical margins, so a margin between paragraphs makes
 * its height map drift from the screen (clicks land lines away). Vertical margins on lines are therefore turned into
 * transparent borders (inside the box, so they are measured) with background-clip:padding-box (so backgrounds do
 * not grow into them). A left border next to them would get a slanted join, so it becomes an inset shadow.
 */
function marginsToBorders(body) {
  const decls = splitTop(body, /;/).map((d) => d.trim()).filter(Boolean);
  let mt, mb, ml, mr; const keep = []; const shadows = [];
  // visible borders on a converted line become inset shadows, so the transparent spacing borders can take their place
  const border = (prop, val, mk) => {
    const toks = val.trim().split(/\s+/);
    const w = toks.find((t) => /^\d*\.?\d+(px|em|rem)$/.test(t));
    const style = toks.find((t) => /^(solid|dashed|dotted|double)$/.test(t)) ?? (w ? 'solid' : 'none');
    const colour = toks.filter((t) => t !== w && t !== style).join(' ') || 'currentColor';
    if (w && style !== 'none' && parseFloat(w) > 0) shadows.push(mk(w, colour));
  };
  const simple = (v) => (v && !/auto|var\(|-\d/.test(v) ? v.trim() : undefined);
  for (const d of decls) {
    const m = /^([a-z-]+)\s*:\s*(.*)$/s.exec(d);
    if (!m) { keep.push(d); continue; }
    const [, prop, val] = m;
    if (prop === 'margin') {
      const v = val.trim().split(/\s+/);
      const [t, r = t, b = t, l = r] = v;
      mt = simple(t); mb = simple(b); ml = r; mr = l === undefined ? r : l; ml = l ?? r; mr = r;
    } else if (prop === 'margin-top') mt = simple(val);
    else if (prop === 'margin-bottom') mb = simple(val);
    else if (prop === 'border-top' || prop === 'border-bottom' || prop === 'border-left') { keep.push({ prop, val, d }); }
    else keep.push(d);
  }
  if (mt === undefined && mb === undefined) return body;
  const plain = [];
  for (const k of keep) {
    if (typeof k === 'string') { plain.push(k); continue; }
    if (k.prop === 'border-top') border(k.prop, k.val, (w, c) => `inset 0 ${w} 0 ${c}`);
    else if (k.prop === 'border-bottom') border(k.prop, k.val, (w, c) => `inset 0 -${w} 0 ${c}`);
    else border(k.prop, k.val, (w, c) => `inset ${w} 0 0 ${c}`);
  }
  let out = plain.join(';');
  if (ml !== undefined) out += `;margin-left:${ml};margin-right:${mr}`;
  out += ';margin-top:0;margin-bottom:0';
  if (mt !== undefined) out += `;border-top:${mt} solid transparent`;
  if (mb !== undefined) out += `;border-bottom:${mb} solid transparent`;
  out += ';background-clip:padding-box';
  if (shadows.length) out += `;box-shadow:${shadows.join(',')}`;
  return out.replace(/^;/, '');
}

export function adaptCss(css, kind, report) {
  let out = '', i = 0;
  const n = css.length;
  while (i < n) {
    // read prelude
    let j = i, depth = 0;
    while (j < n && !(depth === 0 && (css[j] === '{' || css[j] === ';'))) { if (css[j] === '(' || css[j] === '[') depth++; if (css[j] === ')' || css[j] === ']') depth--; j++; }
    const prelude = css.slice(i, j).trim();
    if (j >= n) break;
    if (css[j] === ';') { if (prelude && !prelude.startsWith('@import')) out += prelude + ';'; i = j + 1; continue; }
    // find matching close brace
    let k = j + 1, d = 1;
    while (k < n && d > 0) { if (css[k] === '{') d++; else if (css[k] === '}') d--; k++; }
    const body = css.slice(j + 1, k - 1);
    i = k;
    if (prelude.startsWith('@media')) {
      if (/print/.test(prelude)) continue;
      const inner = adaptCss(body, kind, report);
      if (inner) out += `${prelude}{${inner}}`;
    } else if (prelude.startsWith('@')) {
      out += `${prelude}{${body}}`;
    } else {
      const sels = splitTop(prelude, /,/).map((s) => ({ s, m: mapSelector(s, kind) }));
      const kept = sels.filter((x) => x.m).map((x) => x.m);
      sels.filter((x) => !x.m).forEach((x) => report?.add(x.s.trim()));
      if (kept.length) out += `${[...new Set(kept)].join(',')}{${kept.some((k) => k.startsWith('.cm-line')) ? marginsToBorders(body) : body}}`;
    }
  }
  return out;
}
