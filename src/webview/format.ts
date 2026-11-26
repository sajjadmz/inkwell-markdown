// Formatting actions. Each function reads an EditorState and returns an ordinary CodeMirror
// TransactionSpec that changes ONLY the characters the action needs (bold adds exactly `**` twice).
// Nothing here touches the sync layer: the transactions flow through the normal edit path.
import { ChangeSet, EditorSelection, type ChangeSpec, type EditorState, type TransactionSpec } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { mapAcrossPrefix } from './listprefix';

export type Inline = 'bold' | 'italic' | 'strike' | 'code';
const MARK: Record<Inline, string> = { bold: '**', italic: '*', strike: '~~', code: '`' };
const NODE: Record<Inline, { node: string; mark: string }> = {
  bold: { node: 'StrongEmphasis', mark: 'EmphasisMark' },
  italic: { node: 'Emphasis', mark: 'EmphasisMark' },
  strike: { node: 'Strikethrough', mark: 'StrikethroughMark' },
  code: { node: 'InlineCode', mark: 'CodeMark' },
};

// ---- colours (canonical forms: removal and replacement rely on them being exact) ----
export const TEXT_COLOURS = [
  { name: 'Red', value: '#d73a49' }, { name: 'Orange', value: '#e36209' }, { name: 'Green', value: '#22863a' },
  { name: 'Blue', value: '#0366d6' }, { name: 'Purple', value: '#6f42c1' }, { name: 'Grey', value: '#6a737d' },
];
export const HIGHLIGHTS = [
  { name: 'Yellow', value: 'rgba(255,212,0,0.35)' }, { name: 'Green', value: 'rgba(52,208,88,0.35)' },
  { name: 'Blue', value: 'rgba(3,102,214,0.30)' }, { name: 'Pink', value: 'rgba(255,105,180,0.35)' },
  { name: 'Orange', value: 'rgba(227,98,9,0.35)' }, { name: 'Purple', value: 'rgba(111,66,193,0.35)' },
];
export type ColourKind = 'text' | 'highlight';
const HEX = '#[0-9a-fA-F]{3,8}';
const RGBA = 'rgba\\(\\d{1,3},\\d{1,3},\\d{1,3},(?:0|1|0?\\.\\d+|1\\.0+)\\)';
export const OPEN_RE: Record<ColourKind, RegExp> = {
  text: new RegExp(`<span style="color:(${HEX})">`, 'g'),
  highlight: new RegExp(`<mark style="background:(${RGBA})">`, 'g'),
};
const CLOSE: Record<ColourKind, string> = { text: '</span>', highlight: '</mark>' };
export const openTag = (k: ColourKind, v: string): string => (k === 'text' ? `<span style="color:${v}">` : `<mark style="background:${v}">`);

export interface ColourPair { kind: ColourKind; open: { from: number; to: number }; close: { from: number; to: number }; value: string; valueFrom: number; valueTo: number }

/** Finds canonical wrapper pairs in `text` (which starts at document offset `base`). Pairs never cross a blank line. */
export function findColourPairs(text: string, base = 0): ColourPair[] {
  const out: ColourPair[] = [];
  for (const kind of ['text', 'highlight'] as ColourKind[]) {
    const tags: Array<{ at: number; open: boolean; len: number; value?: string }> = [];
    const re = new RegExp(OPEN_RE[kind].source, 'g');
    for (let m = re.exec(text); m; m = re.exec(text)) tags.push({ at: m.index, open: true, len: m[0].length, value: m[1] });
    const cl = CLOSE[kind];
    for (let i = text.indexOf(cl); i >= 0; i = text.indexOf(cl, i + 1)) tags.push({ at: i, open: false, len: cl.length });
    tags.sort((a, b) => a.at - b.at);
    const stack: typeof tags = [];
    for (const t of tags) {
      if (t.open) { stack.push(t); continue; }
      const o = stack.pop();
      if (!o) continue;
      if (/\n[ \t]*\n/.test(text.slice(o.at, t.at))) continue;
      const prefix = openTag(kind, '').length - 2; // length up to and including the ':' of the style value
      out.push({ kind, open: { from: base + o.at, to: base + o.at + o.len }, close: { from: base + t.at, to: base + t.at + t.len }, value: o.value!, valueFrom: base + o.at + prefix, valueTo: base + o.at + o.len - 2 });
    }
  }
  return out;
}

// ---- helpers ----
const isWs = (c: string) => c === ' ' || c === '\t';

function selectedLines(state: EditorState): Array<{ from: number; to: number; text: string; number: number }> {
  const doc = state.doc; const seen = new Set<number>(); const out: Array<{ from: number; to: number; text: string; number: number }> = [];
  for (const r of state.selection.ranges) {
    const a = doc.lineAt(r.from).number;
    let b = doc.lineAt(r.to).number;
    if (b > a && r.to === doc.line(b).from) b--; // a selection ending at the start of a line does not include that line
    for (let i = a; i <= b; i++) if (!seen.has(i)) { seen.add(i); const l = doc.line(i); out.push({ from: l.from, to: l.to, text: l.text, number: i }); }
  }
  return out;
}

/** Replace a with b changing only the differing middle. */
function diffChange(at: number, a: string, b: string): ChangeSpec | null {
  if (a === b) return null;
  let p = 0; const m = Math.min(a.length, b.length);
  while (p < m && a[p] === b[p]) p++;
  let s = 0;
  while (s < m - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { from: at + p, to: at + a.length - s, insert: b.slice(p, b.length - s) };
}

function ancestor(state: EditorState, pos: number, name: string): SyntaxNode | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) if (n.name === name) return n;
  return null;
}

const dispatchSpec = (state: EditorState, changes: ChangeSpec[], userEvent: string, extra: Partial<TransactionSpec> = {}): TransactionSpec =>
  ({ changes: changes.filter(Boolean), userEvent, scrollIntoView: true, ...extra });

// ---- inline marks ----
interface Seg { from: number; to: number }

const BLOCK_PREFIX = /^(?:(?:>[ \t]?)*[ \t]*)(?:(?:[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d{1,9}[.)][ \t]+)?#{1,6}[ \t]+|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d{1,9}[.)][ \t]+)?/; // also \"- ## heading\"

/** Whitespace for trimming and for choosing cut points: a space, a tab, a newline or an inline `<br>`. */
function wsLenAt(doc: EditorState['doc'], pos: number, dir: 1 | -1): number {
  if (dir === 1) {
    const c = doc.sliceString(pos, pos + 1);
    if (c === ' ' || c === '\t' || c === '\n') return 1;
    return doc.sliceString(pos, pos + 4) === '<br>' ? 4 : 0;
  }
  const c = doc.sliceString(pos - 1, pos);
  if (c === ' ' || c === '\t' || c === '\n') return 1;
  return pos >= 4 && doc.sliceString(pos - 4, pos) === '<br>' ? 4 : 0;
}

/** The pieces of the selection to wrap: one per line, trimmed, and not including a line's heading/list/quote prefix. */
function segments(state: EditorState): Seg[] {
  const doc = state.doc; const out: Seg[] = [];
  for (const r of state.selection.ranges) {
    if (r.empty) {
      const w = state.wordAt(r.from);
      out.push(w ? { from: w.from, to: w.to } : { from: r.from, to: r.from });
      continue;
    }
    const a = doc.lineAt(r.from).number, b = doc.lineAt(r.to).number;
    for (let i = a; i <= b; i++) {
      const l = doc.line(i);
      let from = Math.max(l.from, r.from), to = Math.min(l.to, r.to);
      if (from === l.from) from += BLOCK_PREFIX.exec(l.text)![0].length;
      for (let n = wsLenAt(doc, from, 1); from < to && n && from + n <= to; n = wsLenAt(doc, from, 1)) from += n;
      for (let n = wsLenAt(doc, to, -1); to > from && n && to - n >= from; n = wsLenAt(doc, to, -1)) to -= n;
      if (to > from) out.push({ from, to });
    }
  }
  return out;
}

function runLen(state: EditorState, pos: number, ch: string, dir: 1 | -1): number {
  const doc = state.doc; let n = 0;
  if (dir === 1) while (pos + n < doc.length && doc.sliceString(pos + n, pos + n + 1) === ch) n++;
  else while (pos - n > 0 && doc.sliceString(pos - n - 1, pos - n) === ch) n++;
  return n;
}

/** Ranges to delete when an empty pair (`**|**`) sits around the cursor. */
function existing(state: EditorState, seg: Seg, kind: Inline): Array<[number, number]> | null {
  const m = MARK[kind]; const ch = m[0]; const len = m.length;
  const star = ch === '*';
  const present = (n: number) => (kind === 'bold' ? n >= 2 : kind === 'italic' ? n % 2 === 1 : n >= len);
  const ok = (n: number) => (kind === 'strike' ? n === 2 : kind === 'code' ? n === 1 : star ? present(n) : n >= len);
  const nb = runLen(state, seg.from, ch, -1), na = runLen(state, seg.to, ch, 1);
  if (ok(Math.min(nb, na))) return [[seg.from - len, seg.from], [seg.to, seg.to + len]];
  return null;
}

/** A piece of text carrying an inline style: Markdown (`**x**`) or an inline HTML tag pair (`<b>x</b>`). */
export interface StyleRegion { from: number; to: number; open: Seg; close: Seg; openText: string; closeText: string }
const HTML_FAMILY: Partial<Record<Inline, string[]>> = { bold: ['b', 'strong'], italic: ['i', 'em'], strike: ['s', 'del', 'strike'] };
const ALL_HTML = Object.values(HTML_FAMILY).flat() as string[];
const TAG_RE = /^<(\/?)([a-z]+)>$/;

/** The start of the paragraph (run of non-blank lines) around `pos`, and its end. Keeps tree scans local. */
function paraRange(state: EditorState, from: number, to: number): Seg {
  const doc = state.doc;
  let a = doc.lineAt(from).number, b = doc.lineAt(to).number;
  while (a > 1 && doc.line(a - 1).text.trim() !== '') a--;
  while (b < doc.lines && doc.line(b + 1).text.trim() !== '') b++;
  return { from: doc.line(a).from, to: doc.line(b).to };
}

interface Scan { regions: Record<Inline, StyleRegion[]>; marks: Seg[] }
/** Every inline style region (Markdown nodes and matched HTML tags) and every style mark in the paragraph(s) spanning from..to. */
function scan(state: EditorState, from: number, to: number): Scan {
  const range = paraRange(state, from, to);
  const regions: Record<Inline, StyleRegion[]> = { bold: [], italic: [], strike: [], code: [] };
  const marks: Seg[] = [];
  const stacks = new Map<string, Array<{ from: number; to: number }>>();
  const kindOfTag = (name: string): Inline | null => (['bold', 'italic', 'strike'] as Inline[]).find((k) => HTML_FAMILY[k]!.includes(name)) ?? null;
  syntaxTree(state).iterate({
    from: range.from, to: range.to,
    enter(n) {
      if (n.name === 'EmphasisMark' || n.name === 'StrikethroughMark') { marks.push({ from: n.from, to: n.to }); return; }
      if (n.name === 'HTMLTag') {
        const m = TAG_RE.exec(state.doc.sliceString(n.from, n.to));
        if (!m || !ALL_HTML.includes(m[2])) return;
        marks.push({ from: n.from, to: n.to });
        const st = stacks.get(m[2]) ?? []; stacks.set(m[2], st);
        if (!m[1]) { st.push({ from: n.from, to: n.to }); return; }
        const o = st.pop(); if (!o) return;
        const k = kindOfTag(m[2])!;
        regions[k].push({ from: o.from, to: n.to, open: o, close: { from: n.from, to: n.to }, openText: `<${m[2]}>`, closeText: `</${m[2]}>` });
        return;
      }
      for (const k of ['bold', 'italic', 'strike', 'code'] as Inline[]) {
        if (n.name !== NODE[k].node) continue;
        const ms = n.node.getChildren(NODE[k].mark);
        if (ms.length < 2) return;
        const o = ms[0], c = ms[ms.length - 1];
        regions[k].push({ from: n.from, to: n.to, open: { from: o.from, to: o.to }, close: { from: c.from, to: c.to }, openText: MARK[k], closeText: MARK[k] });
      }
    },
  });
  for (const k of Object.keys(regions) as Inline[]) regions[k].sort((a, b) => a.from - b.from || b.to - a.to);
  return { regions, marks };
}

/** The style regions of one kind that are inside the paragraph(s) around from..to (exported for table-cell list handling). */
export function inlineRegions(state: EditorState, kind: Inline, from: number, to: number): StyleRegion[] { return scan(state, from, to).regions[kind]; }

/** The seg widened over any style marks directly touching it, so a selection of just the text counts as covering a node whose marks sit outside it. */
function extend(marks: Seg[], s: Seg): Seg {
  let from = s.from, to = s.to;
  for (let again = true; again;) {
    again = false;
    for (const m of marks) {
      if (m.to === from && m.from < from) { from = m.from; again = true; }
      if (m.from === to && m.to > to) { to = m.to; again = true; }
    }
  }
  return { from, to };
}

/** True when every character of the seg lies inside some region of the kind. */
function covered(regs: StyleRegion[], s: Seg): boolean {
  let cur = s.from;
  for (const r of regs) {
    if (r.from > cur) return false;
    if (r.to > cur) cur = r.to;
    if (cur >= s.to) return true;
  }
  return cur >= s.to;
}

type Edit = { from: number; to?: number; insert?: string };

/** Make the seg carry the style, Word-style: merge with neighbouring or contained runs of the same style, so the result is one clean run. */
function addStyle(regs: StyleRegion[], marks: Seg[], s: Seg, kind: Inline, out: Edit[]): void {
  const ex = extend(marks, s);
  const touching = regs.filter((r) => r.to > ex.from && r.from < ex.to && r.open.to <= ex.to && r.close.from >= ex.from);
  const L = touching.filter((r) => r.from < ex.from).sort((a, b) => a.from - b.from)[0];
  const R = touching.filter((r) => r.to > ex.to).sort((a, b) => b.to - a.to)[0];
  for (const r of touching) {
    if (r === L && r === R) continue;
    if (r !== L) out.push({ from: r.open.from, to: r.open.to });
    if (r !== R) out.push({ from: r.close.from, to: r.close.to });
  }
  const sameKindText = (a: StyleRegion, b: StyleRegion) => a.openText === b.openText;
  if (!L) out.push({ from: s.from, insert: R ? R.openText : MARK[kind] });
  if (!R) out.push({ from: s.to, insert: L ? L.closeText : MARK[kind] });
  // L and R are joined: if they were written differently (`<b>..</b>` against `**..**`), R's closing mark is rewritten to match L's opening one.
  if (L && R && !sameKindText(L, R)) {
    out.push({ from: R.close.from, to: R.close.to, insert: L.closeText });
  }
}

/** Take the style off the seg only: the part of a run outside the seg keeps its style. */
function removeStyle(doc: EditorState['doc'], marks: Seg[], reg: StyleRegion, first: Seg, last: Seg, out: Edit[]): void {
  const lo = extend(marks, first).from, hi = extend(marks, last).to;
  const full = lo <= reg.open.to && hi >= reg.close.from;
  if (full) { out.push({ from: reg.open.from, to: reg.open.to }, { from: reg.close.from, to: reg.close.to }); return; }
  // The cut points move over whitespace so the new opening mark touches a word (`one **two**`), never a space.
  const reopenAt = () => { let p = last.to; for (let n = wsLenAt(doc, p, 1); n && p + n <= reg.close.from; n = wsLenAt(doc, p, 1)) p += n; return p; };
  const closeAt = () => { let p = first.from; for (let n = wsLenAt(doc, p, -1); n && p - n >= reg.open.to; n = wsLenAt(doc, p, -1)) p -= n; return p; };
  if (lo <= reg.open.to) {
    const p = reopenAt();
    out.push({ from: reg.open.from, to: reg.open.to });
    if (p < reg.close.from) out.push({ from: p, insert: reg.openText }); else out.push({ from: reg.close.from, to: reg.close.to });
  } else if (hi >= reg.close.from) {
    const p = closeAt();
    out.push({ from: reg.close.from, to: reg.close.to });
    if (p > reg.open.to) out.push({ from: p, insert: reg.closeText }); else out.push({ from: reg.open.from, to: reg.open.to });
  } else {
    out.push({ from: closeAt(), insert: reg.closeText }, { from: reopenAt(), insert: reg.openText });
  }
}

function toggleClassic(state: EditorState, kind: Inline): TransactionSpec {
  const m = MARK[kind];
  const segs = segments(state);
  const sel = state.selection;
  // Empty selection, no word: bold inserts the pair with the cursor in between (or removes an empty pair).
  if (sel.ranges.length === 1 && sel.main.empty && segs.length === 1 && segs[0].from === segs[0].to) {
    const p = segs[0].from;
    const ex = existing(state, segs[0], kind);
    if (ex) return dispatchSpec(state, ex.map(([from, to]) => ({ from, to })), 'format.' + kind);
    return dispatchSpec(state, [{ from: p, insert: m + m }], 'format.' + kind, { selection: EditorSelection.cursor(p + m.length) });
  }
  const { regions, marks } = scan(state, segs[0]?.from ?? sel.main.from, segs.length ? segs[segs.length - 1].to : sel.main.to);
  const regs = regions[kind];
  const full = segs.map((s) => covered(regs, s));
  const edits: Edit[] = [];
  if (segs.length && full.every(Boolean)) {
    if (sel.main.empty) {
      // The cursor is inside a styled word: the whole run it belongs to is toggled off.
      for (const s of segs) for (const r of regs) if (r.open.to < s.to && r.close.from > s.from) edits.push({ from: r.open.from, to: r.open.to }, { from: r.close.from, to: r.close.to });
    } else {
      for (const r of regs) {
        const mine = segs.filter((s) => r.open.to < s.to && r.close.from > s.from);
        if (mine.length) removeStyle(state.doc, marks, r, mine[0], mine[mine.length - 1], edits);
      }
    }
  } else {
    segs.forEach((s, i) => { if (!full[i]) addStyle(regs, marks, s, kind, edits); });
  }
  const seen = new Set<string>();
  const changes: ChangeSpec[] = edits.filter((e) => { const k = `${e.from}:${e.to ?? ''}:${e.insert ?? ''}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return dispatchSpec(state, changes, 'format.' + kind);
}

// ---- bold / italic / strike on a per-character style model (the Word model) ----
// The inline stretch around the selection is decoded into units (one character, or one atomic token such as a code span, a
// link, an image or an HTML tag) with flags {strike, bold, italic}. The flag is then set or cleared on the selected units, and the
// stretch is re-encoded canonically (strike outermost, then bold, then italic). Unselected units keep their flags exactly.
const FLAGS: Inline[] = ['strike', 'bold', 'italic'];
interface Unit { from: number; to: number; text: string; ws: boolean; f: boolean[]; sel: boolean; outFrom: number; outTo: number }
const ATOMIC = new Set(['InlineCode', 'Link', 'Image', 'Autolink', 'URL', 'Escape', 'Entity', 'HardBreak', 'HTMLTag', 'Comment', 'ProcessingInstruction', 'FootnoteRef']);

/** The inline container (paragraph, heading text, table cell, or a link's label) holding `from`..`to`. */
function inlineContainer(state: EditorState, from: number, to: number): Seg {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(from, 1); n; n = n.parent) {
    if (n.name === 'Link') {
      const ms = n.getChildren('LinkMark');
      if (ms.length >= 2 && from >= ms[0].to && to <= ms[1].from) return { from: ms[0].to, to: ms[1].from };
    } else if (n.name === 'Paragraph' || n.name === 'TableCell') return { from: n.from, to: n.to };
    else if (/^(ATXHeading|SetextHeading)\d$/.test(n.name)) {
      const ms = n.getChildren('HeaderMark');
      if (n.name.startsWith('ATX')) {
        const text = state.doc.sliceString(n.from, n.to);
        const lead = /^#{1,6}[ \t]*/.exec(text)![0].length;
        return { from: n.from + lead, to: ms.length > 1 ? ms[ms.length - 1].from : n.to };
      }
      return { from: n.from, to: ms.length ? ms[0].from : n.to };
    }
  }
  return paraRange(state, from, to);
}

/** Units of cont[rs, re) with their style flags, plus the style nodes found. */
function buildUnits(state: EditorState, cont: Seg, rs: number, re: number, regs?: Record<Inline, StyleRegion[]>): Unit[] {
  const sc = regs ?? scan(state, cont.from, cont.to).regions;
  const nodes: Array<{ idx: number; r: StyleRegion }> = [];
  FLAGS.forEach((k, idx) => { for (const r of sc[k]) if (r.from >= cont.from && r.to <= cont.to) nodes.push({ idx, r }); });
  const markers = new Map<number, number>(); // start -> end of every style mark
  for (const { r } of nodes) { markers.set(r.open.from, r.open.to); markers.set(r.close.from, r.close.to); }
  const atoms = new Map<number, number>();
  syntaxTree(state).iterate({
    from: rs, to: re,
    enter(n) {
      if (!ATOMIC.has(n.name) || n.from < rs || n.to > re) return;
      if (n.name === 'HTMLTag' && markers.get(n.from) === n.to) return false;
      atoms.set(n.from, n.to); return false;
    },
  });
  const units: Unit[] = [];
  for (let p = rs; p < re;) {
    const mk = markers.get(p);
    if (mk !== undefined) { p = mk; continue; }
    const at = atoms.get(p);
    const to = at ?? p + 1;
    const text = state.doc.sliceString(p, to);
    const f = FLAGS.map((_, idx) => nodes.some((x) => x.idx === idx && p >= x.r.open.to && to <= x.r.close.from));
    units.push({ from: p, to, text, ws: /^(?:[ \t\n]|<br\s*\/?>)$/.test(text), f, sel: false, outFrom: 0, outTo: 0 });
    p = to;
  }
  return units;
}

type Variant = { bold: string; italic: string; html?: boolean };
function encode(units: Unit[], flags: boolean[][], v: Variant): string {
  const marks = ['~~', v.bold, v.italic];
  const tags = ['s', 'b', 'i'];
  const cur = [false, false, false];
  let out = '';
  const emit = (f: boolean[]) => {
    const k = [0, 1, 2].find((i) => cur[i] !== f[i]);
    if (k === undefined) return;
    for (let i = 2; i >= k; i--) if (cur[i]) { out += v.html ? `</${tags[i]}>` : marks[i]; cur[i] = false; }
    for (let i = k; i <= 2; i++) if (f[i]) { out += v.html ? `<${tags[i]}>` : marks[i]; cur[i] = true; }
  };
  units.forEach((u, i) => { emit(flags[i]); u.outFrom = out.length; out += u.text; u.outTo = out.length; });
  emit([false, false, false]);
  return out;
}

interface GroupEdit { rs: number; re: number; text: string; units: Unit[] }

function styleGroup(state: EditorState, kind: Inline, cont: Seg, segs: Seg[], caretRun: boolean): GroupEdit | null {
  const sc = scan(state, cont.from, cont.to).regions;
  const idx = FLAGS.indexOf(kind);
  const inCont = FLAGS.flatMap((k) => sc[k].filter((r) => r.from >= cont.from && r.to <= cont.to));
  // The region: the selection plus every style node touching it, and any atomic token it cuts through.
  let rs = Math.min(...segs.map((s) => s.from)), re = Math.max(...segs.map((s) => s.to));
  const atoms: Seg[] = [];
  syntaxTree(state).iterate({ from: cont.from, to: cont.to, enter(n) { if (!ATOMIC.has(n.name) || (n.from <= cont.from && n.to >= cont.to)) return; atoms.push({ from: n.from, to: n.to }); return false; } });
  for (let again = true; again;) {
    again = false;
    for (const r of [...inCont, ...atoms]) {
      if (r.from <= re && r.to >= rs && (r.from < rs || r.to > re)) { rs = Math.min(rs, r.from); re = Math.max(re, r.to); again = true; }
    }
  }
  const units = buildUnits(state, cont, rs, re, sc);
  for (const u of units) u.sel = segs.some((s) => u.from < s.to && u.to > s.from);
  const nonWs = units.filter((u) => u.sel && !u.ws);
  if (!nonWs.length) return null;
  const all = nonWs.every((u) => u.f[idx]);
  if (all && caretRun) {
    // A cursor inside a styled word toggles the whole run that word belongs to.
    let i = units.findIndex((u) => u.sel), j = units.length - 1 - [...units].reverse().findIndex((u) => u.sel);
    while (i > 0 && units[i - 1].f[idx]) i--;
    while (j < units.length - 1 && units[j + 1].f[idx]) j++;
    for (let k = i; k <= j; k++) units[k].sel = true;
  }
  const target = !all;
  const flags = units.map((u) => u.f.map((x, i) => (i === idx && u.sel ? target : x)));
  if (flags.every((f, i) => f.every((x, k) => x === units[i].f[k]))) return null;
  // Whitespace never sits just inside a marker: a space carries a style only when both of its neighbours do.
  units.forEach((u, i) => {
    if (!u.ws) return;
    let a = i - 1, b = i + 1;
    while (a >= 0 && units[a].ws) a--;
    while (b < units.length && units[b].ws) b++;
    for (let k = 0; k < 3; k++) {
      // A level carries over the space only when no outer level changes on either side of it (that would reopen this one at the space).
      let ok = a >= 0 && b < units.length && flags[a][k] && flags[b][k];
      for (let j = 0; ok && j < k; j++) if (flags[a][j] !== flags[b][j]) ok = false;
      flags[i][k] = ok;
    }
  });
  // Keep the file's own marker style (`__`/`_`) where it has one.
  const own = (k: Inline, ch: string) => inCont.length && sc[k].some((r) => r.openText[0] === ch);
  const base: Variant = { bold: own('bold', '_') ? '__' : '**', italic: own('italic', '_') ? '_' : '*' };
  const variants: Variant[] = [base, { bold: '**', italic: '_' }, { bold: '**', italic: '*' }, { bold: '__', italic: '*' }, { bold: '__', italic: '_' }, { bold: '**', italic: '*', html: true }]; // the last resort: HTML tags, which have no flanking rules
  const old = state.doc.sliceString(rs, re);
  for (const v of variants) {
    const text = encode(units, flags, v);
    // Verify in place: the parser must read the new text back with exactly the intended flags.
    const ch = diffChange(rs, old, text);
    const st2 = state.update({ changes: ch ?? [] }).state;
    ensureSyntaxTree(st2, st2.doc.length, 3000);
    const c2 = { from: cont.from, to: cont.to + text.length - old.length };
    const back = buildUnits(st2, c2, rs, rs + text.length);
    if (back.length === units.length && back.every((b, i) => b.text === units[i].text && (units[i].ws || b.f.every((x, k) => x === flags[i][k])))) return { rs, re, text, units };
  }
  return null;
}

export function toggleInline(state: EditorState, kind: Inline): TransactionSpec {
  if (kind === 'code') return toggleClassic(state, kind);
  const sel = state.selection;
  const segs = segments(state);
  if (sel.ranges.length === 1 && sel.main.empty && segs.length === 1 && segs[0].from === segs[0].to) return toggleClassic(state, kind);
  ensureSyntaxTree(state, state.doc.length, 3000);
  const groups = new Map<string, { cont: Seg; segs: Seg[] }>();
  for (const s of segs) {
    const cont = inlineContainer(state, s.from, s.to);
    const key = `${cont.from}:${cont.to}`;
    const g = groups.get(key) ?? { cont, segs: [] }; groups.set(key, g); g.segs.push(s);
  }
  const edits: GroupEdit[] = [];
  for (const g of groups.values()) { const e = styleGroup(state, kind, g.cont, g.segs, sel.main.empty); if (e) edits.push(e); }
  const changes = edits.map((e) => diffChange(e.rs, state.doc.sliceString(e.rs, e.re), e.text)).filter(Boolean) as ChangeSpec[];
  const cs = ChangeSet.of(changes, state.doc.length);
  const where = (p: number) => edits.find((e) => p >= e.rs && p <= e.re);
  const mapStart = (p: number): number => {
    const e = where(p); if (!e) return cs.mapPos(p, -1);
    const base = cs.mapPos(e.rs, -1);
    const u = e.units.find((x) => x.to > p);
    return base + (!u ? e.text.length : p <= u.from ? u.outFrom : u.outFrom + (p - u.from));
  };
  const mapEnd = (p: number): number => {
    const e = where(p); if (!e) return cs.mapPos(p, 1);
    const base = cs.mapPos(e.rs, -1);
    let u: Unit | undefined; for (const x of e.units) if (x.from < p) u = x;
    return base + (!u ? 0 : u.outFrom + Math.min(p - u.from, u.text.length));
  };
  const ranges = sel.ranges.map((r) => {
    if (r.empty) { const e = where(r.from); return EditorSelection.cursor(e && e.units.some((u) => u.to === r.from && !u.ws) ? mapEnd(r.from) : mapStart(r.from)); }
    const a = mapStart(r.from), b = mapEnd(r.to);
    return r.anchor <= r.head ? EditorSelection.range(a, Math.max(a, b)) : EditorSelection.range(Math.max(a, b), a);
  });
  return dispatchSpec(state, changes, 'format.' + kind, { selection: EditorSelection.create(ranges, sel.mainIndex) });
}

/** Which inline marks are active at the selection head (for the toolbar). */
export function activeInline(state: EditorState): Record<Inline, boolean> {
  const pos = state.selection.main.head;
  const { regions } = scan(state, pos, pos);
  const at = (k: Inline) => regions[k].some((r) => r.from <= pos && pos <= r.to);
  return { bold: at('bold'), italic: at('italic'), strike: at('strike'), code: at('code') };
}

// ---- headings ----
// A heading lives after any list marker / quote marker on the line ("- # Title" is a bulleted heading), so the
// bullet, number or quote is kept when a heading is applied or removed, like Word keeps a paragraph's list.
const LINE_PREFIX = /^[ \t]*(?:>[ \t]?)*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/;
const headOf = (t: string) => { const p = LINE_PREFIX.exec(t)![0].length; const m = /^(#{1,6})([ \t]+|$)/.exec(t.slice(p)); return { p, n: m ? m[1].length : 0, len: m ? m[0].length : 0 }; };

export function headingLevel(state: EditorState): number {
  return headOf(state.doc.lineAt(state.selection.main.head).text).n;
}

/**
 * Word-style: choosing a heading level applies it (choosing the same level again keeps it); "Normal text" (0) removes
 * it. Text that would turn into Markdown syntax once the "#" is gone (e.g. "1. Overview" becoming a numbered list) is
 * escaped ("1\. Overview"), and that escape is dropped again when a heading is re-applied, so the words never change.
 */
export function setHeading(state: EditorState, level: number): TransactionSpec {
  const lines = selectedLines(state);
  const multi = lines.length > 1;
  const changes: ChangeSpec[] = [];
  for (const l of lines) {
    if (multi && l.text.trim() === '') continue;
    const h = headOf(l.text);
    const at = l.from + h.p;
    const body = l.text.slice(h.p + h.len);
    if (h.n === level) continue;
    if (level === 0) {
      const esc = h.p === 0 ? (/^(\d{1,9})([.)])([ \t]|$)/.exec(body) ? body.replace(/^(\d{1,9})([.)])/, '$1\\$2') : /^([-*+>]|#{1,6})([ \t]|$)/.test(body) ? '\\' + body : null) : null;
      changes.push(esc !== null ? { from: at, to: l.to, insert: esc } : { from: at, to: at + h.len });
    } else if (h.n > 0) changes.push({ from: at, to: at + h.n, insert: '#'.repeat(level) });
    else {
      const unesc = h.p === 0 ? (/^\d{1,9}\\[.)]/.test(body) ? body.replace(/^(\d{1,9})\\/, '$1') : /^\\([-*+>]|#{1,6})([ \t]|$)/.test(body) ? body.slice(1) : null) : null;
      changes.push(unesc !== null ? { from: at, to: l.to, insert: '#'.repeat(level) + ' ' + unesc } : { from: at, insert: '#'.repeat(level) + ' ' });
    }
  }
  return dispatchSpec(state, changes, 'format.heading');
}

// ---- lists and quotes ----
export type ListKind = 'bullets' | 'numbered' | 'checklist';
const LEAD = /^(?:[ \t]*>)*[ \t]*/;
const LIST = /^((?:[ \t]*>)*[ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(\[[ xX]\][ \t]+)?/;

export function listKindOf(text: string): ListKind | null {
  const m = LIST.exec(text);
  if (!m) return null;
  return /^\d/.test(m[2]) ? 'numbered' : m[4] ? 'checklist' : 'bullets';
}

export function toggleList(state: EditorState, kind: ListKind): TransactionSpec {
  const lines = selectedLines(state);
  const multi = lines.length > 1;
  const targets = lines.filter((l) => !(multi && l.text.trim() === ''));
  const changes: ChangeSpec[] = [];
  const doc = state.doc;
  const tree = ensureSyntaxTree(state, doc.length, 100) ?? syntaxTree(state);
  const isTarget = new Set(targets.map((l) => l.number));
  const blankish = (t: string) => t.replace(/^(?:[ \t]*>)*/, '').trim() === '';
  const isItemLine = (n: number): boolean => { const t = doc.line(n).text; const m = LIST.exec(t); return !!m && tree.resolveInner(doc.line(n).from + m[1].length, 1).name === 'ListMark'; };
  const isTextLine = (n: number): boolean => {
    const l = doc.line(n); if (blankish(l.text)) return false;
    const m = LIST.exec(l.text); const at = l.from + (m ? m[0].length : LEAD.exec(l.text)![0].length);
    for (let x: SyntaxNode | null = tree.resolveInner(at, 1); x; x = x.parent) { if (x.name === 'Paragraph' || x.name === 'ListItem') return true; if (x.name === 'FencedCode' || x.name === 'CodeBlock') return false; }
    return false;
  };
  const blankFor = (l: { text: string }) => (/^(?:[ \t]*>[ \t]?)*/.exec(l.text)![0]).trimEnd();
  // A line that stops being a list item must not join the paragraph above, and the items below it must still start a list: blank lines set it apart.
  const separate = (run: typeof targets, before: boolean, after: boolean) => {
    const first = run[0], last = run[run.length - 1];
    if (before && first.number > 1 && !isTarget.has(first.number - 1) && isTextLine(first.number - 1)) changes.push({ from: first.from, insert: blankFor(first) + '\n' });
    if (after && last.number < doc.lines && !isTarget.has(last.number + 1) && isItemLine(last.number + 1)) changes.push({ from: last.to, insert: '\n' + blankFor(last) });
  };
  const runs: Array<typeof targets> = [];
  for (const l of targets) { const r = runs[runs.length - 1]; if (r && r[r.length - 1].number + 1 === l.number) r.push(l); else runs.push([l]); }
  if (targets.length && targets.every((l) => listKindOf(l.text) === kind)) {
    for (const l of targets) { const m = LIST.exec(l.text)!; changes.push({ from: l.from + m[1].length, to: l.from + m[0].length }); }
    for (const r of runs) separate(r, true, true);
  } else {
    for (const r of runs) {
      let n = 0;
      if (kind === 'numbered') { // a line joining a numbered list above it goes on counting from it
        const f = r[0]; const m0 = LIST.exec(f.text);
        const lead0 = m0 ? m0[1] : LEAD.exec(f.text)![0];
        for (let i = f.number - 1; i >= 1; i--) {
          const t = doc.line(i).text; if (blankish(t)) continue;
          const pm = LIST.exec(t);
          if (pm && /^\d/.test(pm[2]) && pm[1] === lead0 && !(m0 && /^\d/.test(m0[2]))) n = parseInt(pm[2], 10);
          break;
        }
      }
      for (const l of r) {
        n++;
        const m = LIST.exec(l.text);
        const lead = m ? m[1] : LEAD.exec(l.text)![0];
        const old = m ? m[0].slice(lead.length) : '';
        const oldBullet = m && !/^\d/.test(m[2]) ? m[2] : '-';
        const gap = m ? m[3] : ' ';
        const next = kind === 'bullets' ? `${oldBullet}${gap}`
          : kind === 'numbered' ? (m && /^\d/.test(m[2]) ? `${m[2]}${gap}` : `${n}. `)
          : `${oldBullet}${gap}${m?.[4] ?? '[ ] '}`;
        const c = diffChange(l.from + lead.length, old, next);
        if (c) changes.push(c);
      }
      // switching an item between bullets and numbers inside a list of the other kind: the items below must not turn into text of this one
      const last = r[r.length - 1]; const nx = last.number + 1;
      if (kind !== 'numbered' && nx <= doc.lines && !isTarget.has(nx) && isItemLine(nx) && /^\d/.test(LIST.exec(doc.line(nx).text)![2])) separate(r, false, true);
    }
  }
  return dispatchSpec(state, changes, 'format.' + kind);
}

// ---- indent / outdent (lists only) ----
export const NOTE_NOT_A_LIST = 'Indent works on bullet and numbered lists.';
export const NOTE_IN_CELL = "Indent isn't available inside a table cell.";
export const NOTE_CANT_INDENT = "This item can't be indented any further.";
/** quote prefix (">" marks), then the quote's own space, indentation, marker, spaces after it. */
const ITEM = /^((?:[ \t]*>)*)([ \t]*)([-*+]|\d{1,9}[.)])([ \t]*)/;
const markerOf = (t: string): string => ITEM.exec(t)?.[3] ?? '';
const colsOf = (ws: string): number => { let c = 0; for (const ch of ws) c += ch === '\t' ? 4 - (c % 4) : 1; return c; };
interface ItemInfo { n: number; quote: string; wsFrom: number; ws: string; indent: number; contentCol: number; quoteDepth: number }

/** Is this line the first line of a real list item (not code, not a rule, not a setext underline)? */
function itemAt(state: EditorState, n: number, text: string, tree: ReturnType<typeof syntaxTree>): ItemInfo | null {
  const line = state.doc.line(n);
  const o = ITEM.exec(line.text); if (!o) return null;
  if (tree.resolveInner(line.from + o[1].length + o[2].length, 1).name !== 'ListMark') return null; // judged on the original line
  const m = ITEM.exec(text); if (!m) return null;
  const lead = m[2].length && m[1] && m[2].startsWith(' ') ? 1 : 0; // the space after ">" belongs to the quote mark, not to the indentation
  const ws = m[2].slice(lead); const indent = colsOf(ws);
  const gap = colsOf(m[4]); const rest = text.slice(m[0].length);
  const contentCol = indent + m[3].length + (rest.trim() === '' || gap === 0 ? 1 : gap > 4 ? 1 : gap);
  return { n, quote: m[1], wsFrom: line.from + m[1].length + lead, ws, indent, contentCol, quoteDepth: (m[1].match(/>/g) ?? []).length };
}

/** The list lines in the selection (tree-checked), or [] when there are none. */
export function selectedListItems(state: EditorState): number[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
  return selectedLines(state).filter((l) => itemAt(state, l.number, l.text, tree)).map((l) => l.number);
}

/**
 * Increase / decrease indent of the list items in the selection, one level each. Indent nests an item under the item above
 * it by that item's CommonMark content width ("- " = 2 spaces, "1. " = 3, "10. " = 4); outdent moves it back to its parent's
 * level. Only the whitespace in front of the marker changes. `note` explains a no-op to the user.
 */
export function indentList(state: EditorState, dir: 1 | -1): { spec: TransactionSpec | null; note: string | null } {
  const doc = state.doc;
  const tree = ensureSyntaxTree(state, doc.length, 100) ?? syntaxTree(state);
  const targets = selectedLines(state).map((l) => l.number).filter((n) => itemAt(state, n, doc.line(n).text, tree));
  if (!targets.length) return { spec: null, note: NOTE_NOT_A_LIST };
  const cur = new Map<number, string>(); // line text as it will be once the earlier lines of the selection have moved
  const text = (n: number) => cur.get(n) ?? doc.line(n).text;
  const info = (n: number) => itemAt(state, n, text(n), tree);
  const parentOf = (n: number, w: number, strict: boolean, qd: number, orig = false): ItemInfo | null => {
    const tx = (i: number) => (orig ? doc.line(i).text : text(i));
    for (let i = n - 1; i >= 1; i--) {
      const t = tx(i);
      if (t.trim() === '' ) continue;
      const it = orig ? itemAt(state, i, t, tree) : info(i);
      if (it) { if (it.quoteDepth !== qd) return null; if (strict ? it.indent < w : it.indent <= w) return it; continue; }
      const q = /^((?:[ \t]*>)*)[ \t]?/.exec(t)![0];
      if (colsOf(t.slice(q.length).match(/^[ \t]*/)![0]) > 0 && (q.match(/>/g) ?? []).length === qd) continue; // an indented line of an item's text
      return null; // ordinary text: the list starts below it
    }
    return null;
  };
  // The block moves as a whole: an item whose parent is also selected and moved goes along by the same number of columns, so the
  // nesting inside the selection is kept. Any other selected item moves by itself, one level, relative to the item above it.
  const changes: ChangeSpec[] = []; let moved = 0;
  const shift = new Map<number, number>(); // line -> columns it moved
  for (const n of targets) {
    const it = info(n)!; const line = doc.line(n);
    const po = parentOf(n, it.indent, true, it.quoteDepth, true);
    let to: number; let root = true;
    const inherited = po ? shift.get(po.n) : undefined;
    if (inherited) { to = Math.max(0, it.indent + inherited); root = false; }
    else if (dir > 0) { const p = parentOf(n, it.indent, false, it.quoteDepth); if (!p || it.indent >= p.contentCol) continue; to = p.contentCol; }
    else { if (it.indent === 0) continue; const p = parentOf(n, it.indent, true, it.quoteDepth); to = p ? p.indent : 0; }
    if (to === it.indent) continue;
    const ws = /\t/.test(it.ws) ? ' '.repeat(to) : to > it.indent ? it.ws + ' '.repeat(to - it.indent) : it.ws.slice(0, it.ws.length - (it.indent - to));
    const old = text(n); const cut = it.wsFrom - line.from;
    let nt = old.slice(0, cut) + ws + old.slice(cut + it.ws.length);
    if (root) { // a numbered item that starts a new list at its new level restarts at 1; one that joins a list continues it (Word does the same)
      const m = ITEM.exec(nt)!;
      if (/^\d/.test(m[3])) {
        const sib = parentOf(n, to, false, it.quoteDepth);
        const sm = sib ? ITEM.exec(text(sib.n)) : null;
        const num = sib && sib.indent === to && sm && /^\d/.test(sm[3]) ? parseInt(sm[3], 10) + 1 : sib && sib.indent === to && !(sm && /^\d/.test(sm[3])) ? -1 : 1;
        if (num > 0) {
          const at = m[1].length + m[2].length;
          nt = nt.slice(0, at) + num + m[3].slice(-1) + nt.slice(at + m[3].length);
        }
      }
    }
    cur.set(n, nt);
    const c = diffChange(line.from, line.text, nt); if (c) { changes.push(c); moved++; shift.set(n, to - it.indent); }
  }
  if (!moved) return { spec: null, note: dir > 0 ? NOTE_CANT_INDENT : null };
  const cs = ChangeSet.of(changes, doc.length);
  // The caret stays at the same place in the text. A position in front of the text (column 0, inside the marker) goes to the text
  // for a caret; for the ends of a selection it keeps its place relative to the marker, so the same text stays selected.
  const mapEnd = (pos: number, caret: boolean): number => {
    const ln = doc.lineAt(pos); const nt = cur.get(ln.number);
    if (nt === undefined || nt === ln.text) return cs.mapPos(pos, 1);
    return cs.mapPos(ln.from, -1) + mapAcrossPrefix(ln.text, nt, pos - ln.from, caret);
  };
  const sel = EditorSelection.create(state.selection.ranges.map((r) => (r.empty ? EditorSelection.cursor(mapEnd(r.head, true)) : EditorSelection.range(mapEnd(r.anchor, false), mapEnd(r.head, false)))), state.selection.mainIndex);
  return { spec: dispatchSpec(state, changes, 'format.indent', { selection: sel }), note: null };
}

export function toggleQuote(state: EditorState): TransactionSpec {
  const lines = selectedLines(state);
  const Q = /^([ \t]*)>[ \t]?/;
  const changes: ChangeSpec[] = [];
  if (lines.length && lines.every((l) => Q.test(l.text))) {
    for (const l of lines) { const m = Q.exec(l.text)!; changes.push({ from: l.from + m[1].length, to: l.from + m[0].length }); }
  } else {
    const multi = lines.length > 1;
    for (const l of lines) if (!Q.test(l.text)) changes.push({ from: l.from, insert: multi && l.text === '' ? '>' : '> ' });
  }
  return dispatchSpec(state, changes, 'format.quote');
}

// ---- block insertion (table, rule, diagram, code) ----
function insertBlock(state: EditorState, text: string, cursor: (base: number) => { anchor: number; head?: number }): TransactionSpec {
  const doc = state.doc;
  const line = doc.lineAt(state.selection.main.to);
  const blank = line.text.trim() === '';
  const prevBlank = line.number === 1 || doc.line(line.number - 1).text.trim() === '';
  const before = blank ? (prevBlank ? '' : '\n') : '\n\n';
  const nextNonBlank = line.number < doc.lines && doc.line(line.number + 1).text.trim() !== '';
  const after = nextNonBlank ? '\n' : '';
  const at = blank && prevBlank ? line.from : line.to;
  const c = cursor(at + before.length);
  return { changes: { from: at, insert: before + text + after }, selection: EditorSelection.single(c.anchor, c.head ?? c.anchor), userEvent: 'format.insert', scrollIntoView: true };
}

export const TABLE_TEXT = '| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |';
export const insertTable = (s: EditorState): TransactionSpec => insertBlock(s, TABLE_TEXT, (b) => ({ anchor: b + 2, head: b + 10 }));
export const insertRule = (s: EditorState): TransactionSpec => insertBlock(s, '---', (b) => ({ anchor: b + 3 }));

export const DIAGRAMS: Record<string, { label: string; code: string }> = {
  flowchart: { label: 'Flowchart', code: 'flowchart TD\n    A[Start] --> B{Is it working?}\n    B -->|Yes| C[Great]\n    B -->|No| D[Fix it]\n    D --> B' },
  sequence: { label: 'Sequence', code: 'sequenceDiagram\n    participant A as Alice\n    participant B as Bob\n    A->>B: Hello Bob\n    B-->>A: Hi Alice' },
  timeline: { label: 'Timeline', code: 'timeline\n    title Project history\n    2023 : Idea\n    2024 : Prototype : Launch' },
  mindmap: { label: 'Mind map', code: 'mindmap\n  root((Topic))\n    Branch A\n      Leaf 1\n      Leaf 2\n    Branch B' },
  gantt: { label: 'Gantt', code: 'gantt\n    title Project plan\n    dateFormat YYYY-MM-DD\n    section Phase 1\n    Design :a1, 2024-01-01, 7d\n    Build :after a1, 10d' },
  pie: { label: 'Pie', code: 'pie title Share\n    "Alpha" : 40\n    "Beta" : 35\n    "Gamma" : 25' },
  state: { label: 'State', code: 'stateDiagram-v2\n    [*] --> Idle\n    Idle --> Running : start\n    Running --> Idle : stop\n    Running --> [*]' },
};
export function insertDiagram(state: EditorState, key: string): TransactionSpec {
  const d = DIAGRAMS[key];
  const first = d.code.split('\n')[0];
  return insertBlock(state, '```mermaid\n' + d.code + '\n```', (b) => ({ anchor: b + 11, head: b + 11 + first.length }));
}

export const LANGUAGES = ['sql', 'python', 'json', 'yaml', 'bash', 'javascript', 'typescript', 'html', 'css', 'markdown', 'plain'];

export function inFence(state: EditorState): SyntaxNode | null {
  return ancestor(state, state.selection.main.head, 'FencedCode');
}

/** Code block: wraps the selected lines in a fence; inside a fence, removes it (or switches its language when one is given). */
export function codeBlock(state: EditorState, lang?: string): TransactionSpec {
  const doc = state.doc;
  const info = lang === undefined || lang === 'plain' ? '' : lang;
  const fence = inFence(state);
  if (fence) {
    const open = doc.lineAt(fence.from);
    const marks = fence.getChildren('CodeMark');
    const ci = fence.getChild('CodeInfo');
    const cur = ci ? doc.sliceString(ci.from, ci.to).trim() : '';
    if (lang !== undefined && cur !== info) {
      const change: ChangeSpec = ci ? { from: ci.from, to: ci.to, insert: info } : { from: marks[0].to, insert: info };
      return dispatchSpec(state, [change], 'format.codeblock');
    }
    const changes: ChangeSpec[] = [{ from: open.from, to: Math.min(doc.length, open.to + 1) }];
    if (marks.length >= 2) { const close = doc.lineAt(marks[marks.length - 1].from); changes.push({ from: Math.max(open.to + 1, close.from - 1), to: close.to }); }
    return dispatchSpec(state, changes, 'format.codeblock');
  }
  const a = doc.lineAt(state.selection.main.from), b = doc.lineAt(state.selection.main.to);
  const last = b.number > a.number && state.selection.main.to === b.from ? doc.line(b.number - 1) : b;
  const head = '```' + info + '\n';
  return {
    changes: [{ from: a.from, insert: head }, { from: last.to, insert: '\n```' }],
    selection: EditorSelection.cursor(a.from + head.length + (last.to - a.from)),
    userEvent: 'format.codeblock', scrollIntoView: true,
  };
}

// ---- link ----
export function setLink(state: EditorState, placeholder = 'url'): TransactionSpec {
  const doc = state.doc; const sel = state.selection.main;
  const link = ancestor(state, sel.head, 'Link');
  if (link) {
    const marks = link.getChildren('LinkMark');
    if (marks.length >= 2) {
      // Toggle off: keep the text, drop `[` and `](url)`.
      return dispatchSpec(state, [{ from: marks[0].from, to: marks[0].to }, { from: marks[1].from, to: link.to }], 'format.link');
    }
  }
  let from = sel.from, to = sel.to;
  if (sel.empty) { const w = state.wordAt(sel.from); if (w) { from = w.from; to = w.to; } }
    const inner = from === to ? 'link' : doc.sliceString(from, to);
  const urlStart = from + 1 + inner.length + 2;
  return {
    changes: from === to ? { from, insert: `[link](${placeholder})` } : [{ from, insert: '[' }, { from: to, insert: `](${placeholder})` }],
    selection: EditorSelection.single(urlStart, urlStart + placeholder.length), userEvent: 'format.link', scrollIntoView: true,
  };
}

// ---- colour ----
/** value === null removes. Returns null when there is nothing to do. */
export function applyColour(state: EditorState, kind: ColourKind, value: string | null): TransactionSpec {
  const doc = state.doc;
  const sel = state.selection.main;
  const a = doc.lineAt(sel.from), b = doc.lineAt(sel.to);
  const allPairs = findColourPairs(doc.sliceString(a.from, b.to), a.from);
  const pairs = allPairs.filter((p) => p.kind === kind && p.open.from <= sel.to && p.close.to >= sel.from);
  const changes: ChangeSpec[] = [];
  if (pairs.length) {
    const eff = value; // Word: applying the same colour again keeps it (use "No colour" to remove)
    for (const p of pairs) {
      const inner = { from: p.open.to, to: p.close.from };
      // Wrappers of the other kind nested inside this one (a highlight inside a text colour).
      const others = allPairs.filter((o) => o.kind !== kind && o.open.from >= inner.from && o.close.to <= inner.to);
      let s = Math.max(sel.from, inner.from), e = Math.min(sel.to, inner.to);
      if (!(sel.empty || e <= s)) {
        // For text colour the cut points skip adjoining spaces (invisible in a text colour); a highlight keeps them so the highlighted phrase stays whole.
        if (kind === 'text') {
          while (s > inner.from && isWs(doc.sliceString(s - 1, s))) s--;
          while (e < inner.to && isWs(doc.sliceString(e, e + 1))) e++;
        }
        // A cut may never land inside a nested wrapper's tag, or in a way that would cross it: the cut moves out of the tag.
        for (let moved = true; moved;) {
          moved = false;
          for (const o of others) {
            if (s > o.open.from && s <= o.open.to) { s = o.open.from; moved = true; }
            else if (s >= o.close.from && s < o.close.to) { s = o.close.to; moved = true; }
            if (e > o.open.from && e <= o.open.to) { e = o.open.from; moved = true; }
            else if (e >= o.close.from && e < o.close.to) { e = o.close.to; moved = true; }
          }
        }
      }
      if (sel.empty || (s <= inner.from && e >= inner.to) || e <= s) {
        if (eff === null) changes.push({ from: p.open.from, to: p.open.to }, { from: p.close.from, to: p.close.to });
        else if (p.value !== eff) changes.push({ from: p.valueFrom, to: p.valueTo, insert: eff });
        continue;
      }
      // Partial selection: split the wrapper so only the selected text changes. Nested wrappers that a cut passes through are closed and reopened around it.
      const oldOpen = doc.sliceString(p.open.from, p.open.to), close = CLOSE[kind];
      const straddling = (at: number) => others.filter((o) => o.open.to < at && at < o.close.from).sort((x, y) => x.open.from - y.open.from);
      const closes = (list: ColourPair[]) => [...list].reverse().map((o) => CLOSE[o.kind]).join('');
      const opens = (list: ColourPair[]) => list.map((o) => doc.sliceString(o.open.from, o.open.to)).join('');
      const midOpen = eff === null ? '' : openTag(kind, eff);
      const leftEmpty = s <= inner.from, rightEmpty = e >= inner.to;
      if (leftEmpty) { if (eff === null) changes.push({ from: p.open.from, to: p.open.to }); else if (p.value !== eff) changes.push({ from: p.valueFrom, to: p.valueTo, insert: eff }); }
      else { const st = straddling(s); changes.push({ from: s, insert: closes(st) + close + midOpen + opens(st) }); }
      if (rightEmpty) { if (eff === null) changes.push({ from: p.close.from, to: p.close.to }); }
      else { const st = straddling(e); changes.push({ from: e, insert: closes(st) + (eff === null ? '' : close) + oldOpen + opens(st) }); }
    }
    return dispatchSpec(state, changes, 'format.colour');
  }
  if (value === null) return dispatchSpec(state, [], 'format.colour');
  const segs = segments(state);
  const open = openTag(kind, value), close = CLOSE[kind];
  if (segs.length === 1 && segs[0].from === segs[0].to) {
    const p = segs[0].from;
    return dispatchSpec(state, [{ from: p, insert: open + close }], 'format.colour', { selection: EditorSelection.cursor(p + open.length) });
  }
  for (const s of segs) changes.push({ from: s.from, insert: open }, { from: s.to, insert: close });
  return dispatchSpec(state, changes, 'format.colour');
}
