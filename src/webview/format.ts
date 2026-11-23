// Formatting actions. Each function reads an EditorState and returns an ordinary CodeMirror
// TransactionSpec that changes ONLY the characters the action needs (bold adds exactly `**` twice).
// Nothing here touches the sync layer: the transactions flow through the normal edit path.
import { EditorSelection, type ChangeSpec, type EditorState, type TransactionSpec } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';

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

const BLOCK_PREFIX = /^(?:(?:>[ \t]?)*[ \t]*)(?:#{1,6}[ \t]+|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d{1,9}[.)][ \t]+)?/;

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
      while (from < to && isWs(doc.sliceString(from, from + 1))) from++;
      while (to > from && isWs(doc.sliceString(to - 1, to))) to--;
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

/** Ranges to delete when `seg` already carries the mark (either wrapped from outside or selected with its marks), else null. */
function existing(state: EditorState, seg: Seg, kind: Inline): Array<[number, number]> | null {
  const m = MARK[kind]; const ch = m[0]; const len = m.length;
  const star = ch === '*';
  const present = (n: number) => (kind === 'bold' ? n >= 2 : kind === 'italic' ? n % 2 === 1 : n >= len);
  const ok = (n: number) => (kind === 'strike' ? n === 2 : kind === 'code' ? n === 1 : star ? present(n) : n >= len);
  // wrapped from outside
  const nb = runLen(state, seg.from, ch, -1), na = runLen(state, seg.to, ch, 1);
  if (ok(Math.min(nb, na))) return [[seg.from - len, seg.from], [seg.to, seg.to + len]];
  // the selection itself includes the marks
  if (seg.to - seg.from > 2 * len) {
    const nl = runLen(state, seg.from + 0, ch, 1), nr = runLen(state, seg.to, ch, -1);
    const n = Math.min(nl, nr, Math.floor((seg.to - seg.from) / 2));
    if (ok(n)) return [[seg.from, seg.from + len], [seg.to - len, seg.to]];
  }
  return null;
}

/** For a cursor inside already-marked text (not adjacent to the marks), the marks of the enclosing node. */
function viaTree(state: EditorState, pos: number, kind: Inline): Array<[number, number]> | null {
  const n = ancestor(state, pos, NODE[kind].node);
  if (!n) return null;
  const marks = n.getChildren(NODE[kind].mark).map((c): [number, number] => [c.from, c.to]);
  return marks.length >= 2 ? marks : null;
}

/** A selection that only partly covers an existing node of this kind (`**b*` in `**b**`): toggle that whole node off. */
function overlapping(state: EditorState, seg: Seg, kind: Inline): Array<[number, number]> | null {
  let marks: Array<[number, number]> | null = null;
  syntaxTree(state).iterate({
    from: seg.from, to: seg.to,
    enter(n) {
      if (marks || n.name !== NODE[kind].node || n.from >= seg.to || n.to <= seg.from) return;
      const ms = n.node.getChildren(NODE[kind].mark).map((c): [number, number] => [c.from, c.to]);
      if (ms.length >= 2) marks = ms;
    },
  });
  return marks;
}

export function toggleInline(state: EditorState, kind: Inline): TransactionSpec {
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
  const found = segs.map((s) => existing(state, s, kind) ?? (sel.main.empty ? viaTree(state, sel.main.from, kind) : overlapping(state, s, kind)));
  const changes: ChangeSpec[] = [];
  if (found.length && found.every(Boolean)) {
    for (const f of found) for (const [from, to] of f!) changes.push({ from, to });
  } else {
    segs.forEach((s, i) => { if (!found[i]) { changes.push({ from: s.from, insert: m }); changes.push({ from: s.to, insert: m }); } });
  }
  return dispatchSpec(state, changes, 'format.' + kind);
}

/** Which inline marks are active at the selection head (for the toolbar). */
export function activeInline(state: EditorState): Record<Inline, boolean> {
  const pos = state.selection.main.head;
  return { bold: !!ancestor(state, pos, 'StrongEmphasis'), italic: !!ancestor(state, pos, 'Emphasis'), strike: !!ancestor(state, pos, 'Strikethrough'), code: !!ancestor(state, pos, 'InlineCode') };
}

// ---- headings ----
export function headingLevel(state: EditorState): number {
  const l = state.doc.lineAt(state.selection.main.head);
  const m = /^(#{1,6})(?:[ \t]|$)/.exec(l.text);
  return m ? m[1].length : 0;
}

export function setHeading(state: EditorState, level: number): TransactionSpec {
  const lines = selectedLines(state);
  const multi = lines.length > 1;
  const cur = (t: string) => { const m = /^(#{1,6})([ \t]+|$)/.exec(t); return m ? { n: m[1].length, len: m[0].length } : { n: 0, len: 0 }; };
  const target = level > 0 && lines.every((l) => cur(l.text).n === level) ? 0 : level;
  const changes: ChangeSpec[] = [];
  for (const l of lines) {
    if (multi && l.text.trim() === '') continue;
    const c = cur(l.text);
    if (c.n === target) continue;
    if (target === 0) changes.push({ from: l.from, to: l.from + c.len });
    else if (c.n > 0) changes.push({ from: l.from, to: l.from + c.n, insert: '#'.repeat(target) });
    else {
      // A list line becomes a plain heading: its marker is replaced (it is not restored when the heading is removed).
      const lm = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/.exec(l.text);
      changes.push({ from: l.from, to: l.from + (lm ? lm[0].length : 0), insert: '#'.repeat(target) + ' ' });
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
  if (targets.length && targets.every((l) => listKindOf(l.text) === kind)) {
    for (const l of targets) { const m = LIST.exec(l.text)!; changes.push({ from: l.from + m[1].length, to: l.from + m[0].length }); }
  } else {
    let n = 0;
    for (const l of targets) {
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
  }
  return dispatchSpec(state, changes, 'format.' + kind);
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
export function setLink(state: EditorState): TransactionSpec {
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
  const text = from === to ? 'link' : '';
  const inner = from === to ? 'link' : doc.sliceString(from, to);
  const urlStart = from + 1 + inner.length + 2;
  return {
    changes: from === to ? { from, insert: `[${text}](url)` } : [{ from, insert: '[' }, { from: to, insert: '](url)' }],
    selection: EditorSelection.single(urlStart, urlStart + 3), userEvent: 'format.link', scrollIntoView: true,
  };
}

// ---- colour ----
/** value === null removes. Returns null when there is nothing to do. */
export function applyColour(state: EditorState, kind: ColourKind, value: string | null): TransactionSpec {
  const doc = state.doc;
  const sel = state.selection.main;
  const a = doc.lineAt(sel.from), b = doc.lineAt(sel.to);
  const pairs = findColourPairs(doc.sliceString(a.from, b.to), a.from).filter((p) => p.kind === kind && p.open.from <= sel.to && p.close.to >= sel.from);
  const changes: ChangeSpec[] = [];
  if (pairs.length) {
    const same = value !== null && pairs.every((p) => p.value === value);
    const eff = same ? null : value;
    for (const p of pairs) {
      const inner = { from: p.open.to, to: p.close.from };
      let s = Math.max(sel.from, inner.from), e = Math.min(sel.to, inner.to);
      if (sel.empty || (s <= inner.from && e >= inner.to) || e <= s) {
        if (eff === null) changes.push({ from: p.open.from, to: p.open.to }, { from: p.close.from, to: p.close.to });
        else if (p.value !== eff) changes.push({ from: p.valueFrom, to: p.valueTo, insert: eff });
        continue;
      }
      // Partial selection: split the wrapper so only the selected text changes. For text colour the cut points skip
      // adjoining spaces (invisible in a text colour); a highlight keeps them so the highlighted phrase stays whole.
      if (kind === 'text') {
        while (s > inner.from && isWs(doc.sliceString(s - 1, s))) s--;
        while (e < inner.to && isWs(doc.sliceString(e, e + 1))) e++;
      }
      const oldOpen = doc.sliceString(p.open.from, p.open.to), close = CLOSE[kind];
      const midOpen = eff === null ? '' : openTag(kind, eff);
      const leftEmpty = s <= inner.from, rightEmpty = e >= inner.to;
      if (leftEmpty) { if (eff === null) changes.push({ from: p.open.from, to: p.open.to }); else if (p.value !== eff) changes.push({ from: p.valueFrom, to: p.valueTo, insert: eff }); }
      else changes.push({ from: s, insert: close + midOpen });
      if (rightEmpty) { if (eff === null) changes.push({ from: p.close.from, to: p.close.to }); }
      else changes.push({ from: e, insert: (eff === null ? '' : close) + oldOpen });
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
