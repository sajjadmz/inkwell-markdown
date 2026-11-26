// Find and Replace, the part that has no page (DOM) in it, so tests can run it in Node.
//
// WHAT IS SEARCHED: the text a reader sees. buildVisible() turns the document into one string in which Markdown markers
// (`**`, `#`, `>`, list bullets, link addresses, HTML tags, front matter ...) are left out, and remembers for every
// character where it sits in the file. A line break, a `<br>`, the end of a paragraph / heading / table cell is a
// separator ("\n") that no search text can contain, so a match never crosses one.
//
// REPLACE: the replacement goes into the first piece of the match and the other pieces are deleted, every marker stays.
// The result is re-parsed and compared with what it should be (same visible text, same style of every other character);
// anything else is refused, so a replacement can never break the file's formatting or a table.
import { EditorState, StateEffect, StateField, type ChangeSpec, type Range } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { escapeCell, parseRow, unescapeCell } from './table';

type Doc = EditorState['doc'];
export interface Seg { from: number; to: number }

/** YAML front matter at the top of the file ("---" ... "---"): shown as a collapsed "Front matter" label, never searched. */
export function frontMatter(doc: Doc): { to: number; lastLine: number } | null {
  if (doc.lines < 2 || doc.line(1).text.trimEnd() !== '---') return null;
  for (let i = 2; i <= Math.min(doc.lines, 200); i++) {
    const t = doc.line(i).text.trimEnd();
    if (t === '---' || t === '...') return { to: doc.line(i).to, lastLine: i };
  }
  return null;
}

export interface CellInfo { tableFrom: number; tableTo: number; r: number; c: number; widget: boolean; cFrom: number; cTo: number }
/** One searchable run of text: a paragraph, a heading, a code block's text, a table cell ... */
export interface Block {
  id: number; from: number; to: number;
  /** Code or HTML: Markdown does not apply inside, so a replacement is written exactly as typed. */
  raw: boolean;
  /** Code text: HTML tags in it are ordinary text. */
  code: boolean;
  cell?: CellInfo;
  /** Where the block's text sits in Visible.text. */
  start: number; end: number;
}
export interface TagPair { open: Seg; close: Seg; label: string; ci: number }
export interface Visible {
  /** The visible text. "\n" separates lines, cells, `<br>` and blocks. */
  text: string;
  /** Per character: where it starts in the file (-1 for a separator), where it ends, and the block it belongs to. */
  pos: Int32Array; end: Int32Array; blk: Int32Array;
  /** File offset -> index into text (or -1). */
  at: Int32Array;
  blocks: Block[];
  tags: TagPair[];
  /** The tag pairs of each block (by block id). */
  tagsOf: Map<number, TagPair[]>;
}

const TAG_RE = /<\/?[A-Za-z][^<>]*>|<!--[\s\S]*?-->/g;
const HIDE_NODES = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark', 'LinkMark', 'HeaderMark', 'QuoteMark', 'ListMark', 'TaskMarker', 'TableDelimiter', 'CodeInfo', 'LinkTitle', 'LinkLabel', 'Comment', 'ProcessingInstruction', 'HardBreak']);

/** The visible text of the whole document, with the position of every character. */
export function buildVisible(state: EditorState): Visible {
  const doc = state.doc; const n = doc.length; const src = doc.toString();
  const tree = ensureSyntaxTree(state, n, 500) ?? syntaxTree(state);
  const hidden = new Uint8Array(n);
  const hide = (a: number, b: number): void => { for (let i = Math.max(0, a); i < Math.min(n, b); i++) hidden[i] = 1; };
  const escapes = new Map<number, number>(); // backslash offset -> end of the escape
  const codeRanges: Seg[] = [];
  const blocks: Block[] = [];
  const fm = frontMatter(doc);
  const addBlock = (from: number, to: number, kind: 'text' | 'code' | 'html', cell?: CellInfo): void => { if (to >= from) blocks.push({ id: blocks.length, from, to, raw: kind !== 'text', code: kind === 'code', cell, start: 0, end: 0 }); };

  tree.iterate({
    enter(node) {
      const { name, from, to } = node;
      if (fm && name !== 'Document' && from < fm.to) return false;
      switch (name) {
        case 'Paragraph': case 'Task': case 'ATXHeading1': case 'ATXHeading2': case 'ATXHeading3': case 'ATXHeading4': case 'ATXHeading5': case 'ATXHeading6':
        case 'SetextHeading1': case 'SetextHeading2':
          addBlock(from, to, 'text'); break;
        case 'HTMLBlock': addBlock(from, to, 'html'); break;
        case 'FencedCode': {
          const info = node.node.getChild('CodeInfo');
          const closed = node.node.getChildren('CodeMark').length >= 2;
          // A closed ```mermaid block is shown as a diagram, not as text.
          if (closed && info && doc.sliceString(info.from, info.to).trim().toLowerCase() === 'mermaid') return false;
          for (const c of node.node.getChildren('CodeText')) addBlock(c.from, c.to, 'code');
          return false;
        }
        case 'CodeBlock': for (const c of node.node.getChildren('CodeText')) addBlock(c.from, c.to, 'code'); return false;
        case 'Table': {
          const widget = node.node.parent?.name === 'Document';
          const a = doc.lineAt(from).number, b = doc.lineAt(to).number;
          for (let i = a; i <= b; i++) {
            if (i === a + 1) continue; // the "| --- | --- |" row
            const ln = doc.line(i);
            parseRow(ln.text, ln.from).cells.forEach((cell, c) => addBlock(cell.cFrom, cell.cTo, 'text', { tableFrom: from, tableTo: to, r: i === a ? 0 : i - a - 1, c, widget, cFrom: cell.cFrom, cTo: cell.cTo }));
          }
          break;
        }
        case 'InlineCode': codeRanges.push({ from, to }); break;
        case 'Escape': hide(from, from + 1); escapes.set(from, to); break;
        case 'Image': case 'Autolink': hide(from, to); return false;
        case 'Link': {
          const marks = node.node.getChildren('LinkMark');
          if (marks.length >= 2) hide(marks[1].from, to);
          break;
        }
        case 'URL': { const p = node.node.parent?.name; if (p === 'Link' || p === 'Image' || p === 'LinkReference') hide(from, to); break; }
        default: if (HIDE_NODES.has(name)) hide(from, to);
      }
      return undefined;
    },
  });
  blocks.sort((a, b) => a.from - b.from || a.to - b.to);
  blocks.forEach((b, i) => { b.id = i; });

  // Inline HTML (tags, comments): never visible. A <br> is a line break.
  const escapedAt = new Set(escapes.keys());
  const inCode = (p: number): boolean => codeRanges.some((r) => p >= r.from && p < r.to);
  const brAt = new Set<number>();
  const tagList: Array<{ from: number; to: number; text: string; ci: number }> = [];
  blocks.forEach((b, ci) => { if (!b.code) scanTags(src, b, ci, escapedAt, inCode, tagList, hide, brAt); });

  // Build the string.
  const chars: string[] = []; const pos: number[] = []; const end: number[] = []; const blk: number[] = [];
  const sep = (): void => { if (chars.length && chars[chars.length - 1] !== '\n') { chars.push('\n'); pos.push(-1); end.push(-1); blk.push(-1); } };
  const at = new Int32Array(n).fill(-1);
  for (const b of blocks) {
    b.start = chars.length;
    const lastLine = doc.lineAt(Math.min(b.to, n)).number;
    for (let ln = doc.lineAt(b.from).number; ln <= lastLine; ln++) {
      const line = doc.line(ln);
      const a = Math.max(b.from, line.from), z = Math.min(b.to, line.to);
      const items: Array<{ i: number; e: number; ch: string } | null> = []; // null = a <br>
      for (let i = a; i < z; i++) {
        const esc = escapes.get(i);
        if (esc !== undefined) { items.push({ i, e: esc, ch: src[i + 1] }); i = esc - 1; continue; }
        if (brAt.has(i)) items.push(null);
        if (hidden[i]) continue;
        items.push({ i, e: i + 1, ch: src[i] });
      }
      // Text blocks: blanks at both ends of a line (and around a <br>) are not visible. Code and HTML keep theirs.
      const runs: Array<Array<{ i: number; e: number; ch: string }> | null> = [[]];
      for (const it of items) { if (!it) runs.push(null, []); else (runs[runs.length - 1] as Array<{ i: number; e: number; ch: string }>).push(it); }
      for (const run of runs) {
        if (!run) { sep(); continue; }
        if (!b.raw) {
          while (run.length && (run[0].ch === ' ' || run[0].ch === '\t')) run.shift();
          while (run.length && (run[run.length - 1].ch === ' ' || run[run.length - 1].ch === '\t')) run.pop();
        }
        for (const it of run) { at[it.i] = chars.length; chars.push(it.ch); pos.push(it.i); end.push(it.e); blk.push(b.id); }
      }
      sep();
    }
    b.end = chars.length > b.start && chars[chars.length - 1] === '\n' ? chars.length - 1 : chars.length;
    if (b.end < b.start) b.end = b.start;
  }
  // Tag pairs (for the style comparison): same name, properly nested, inside one block.
  const tags: TagPair[] = [];
  const stacks = new Map<string, Array<{ from: number; to: number; ci: number; label: string }>>();
  for (const t of tagList) {
    const m = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)([^>]*)>$/.exec(t.text); if (!m) continue;
    const key = m[2].toLowerCase() + ':' + t.ci;
    const st = stacks.get(key) ?? []; stacks.set(key, st);
    if (!m[1]) { if (!/\/\s*$/.test(m[3]) && !/^br$/i.test(m[2])) st.push({ from: t.from, to: t.to, ci: t.ci, label: `<${m[2].toLowerCase()}${m[3].trim() ? ' ' + m[3].trim() : ''}>` }); continue; }
    const o = st.pop(); if (!o) continue;
    tags.push({ open: { from: o.from, to: o.to }, close: { from: t.from, to: t.to }, label: o.label, ci: t.ci });
  }
  const tagsOf = new Map<number, TagPair[]>();
  for (const t of tags) { const l = tagsOf.get(t.ci) ?? []; tagsOf.set(t.ci, l); l.push(t); }
  return { text: chars.join(''), pos: Int32Array.from(pos), end: Int32Array.from(end), blk: Int32Array.from(blk), at, blocks, tags, tagsOf };
}

function scanTags(src: string, b: Block, ci: number, escapedAt: Set<number>, inCode: (p: number) => boolean, out: Array<{ from: number; to: number; text: string; ci: number }>, hide: (a: number, z: number) => void, brAt: Set<number>): void {
  const s = src.slice(b.from, b.to);
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(s); m; m = TAG_RE.exec(s)) {
    const a = b.from + m.index;
    if (escapedAt.has(a - 1) || inCode(a)) continue;
    hide(a, a + m[0].length);
    if (/^<br\s*\/?>$/i.test(m[0])) brAt.add(a);
    out.push({ from: a, to: a + m[0].length, text: m[0], ci });
  }
}

// ---- searching ----
export interface FindOptions { matchCase: boolean; wholeWord: boolean }
export interface Match {
  /** Indices into Visible.text. */
  s: number; e: number;
  /** The runs of consecutive file characters the match covers (more than one when markers sit inside it). */
  pieces: Seg[];
  /** File offset of the first and the end of the last piece. */
  from: number; to: number;
  block: Block;
}

const lc = (c: string): string => { const l = c.toLowerCase(); return l.length === 1 ? l : c; };
const lower = (s: string): string => { let o = ''; for (let i = 0; i < s.length; i++) o += lc(s[i]); return o; };
const isWord = (c: string | undefined): boolean => !!c && /[\p{L}\p{N}_]/u.test(c);

/** Where `query` occurs in `text` (the visible text, or any other string). Never overlapping. A query has no line breaks. */
export function searchText(text: string, query: string, o: FindOptions): Array<[number, number]> {
  const q0 = query.replace(/[\r\n]+/g, ' ');
  if (!q0) return [];
  const hay = o.matchCase ? text : lower(text), q = o.matchCase ? q0 : lower(q0);
  const out: Array<[number, number]> = [];
  for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + Math.max(1, q.length))) {
    const e = i + q.length;
    if (o.wholeWord && ((isWord(q[0]) && isWord(text[i - 1])) || (isWord(q[q.length - 1]) && isWord(text[e])))) continue;
    out.push([i, e]);
  }
  return out;
}

export function findMatches(vis: Visible, query: string, o: FindOptions): Match[] {
  return searchText(vis.text, query, o).map(([s, e]) => {
    const pieces: Seg[] = [];
    for (let i = s; i < e; i++) {
      const last = pieces[pieces.length - 1];
      if (last && last.to === vis.pos[i]) last.to = vis.end[i]; else pieces.push({ from: vis.pos[i], to: vis.end[i] });
    }
    return { s, e, pieces, from: pieces[0].from, to: pieces[pieces.length - 1].to, block: vis.blocks[vis.blk[s]] };
  });
}

// ---- replacing ----
export interface Edit { from: number; to: number; insert: string }

/** Backslash-escapes the characters of a replacement that Markdown would read as formatting. */
export function mdEscape(text: string, atLineStart: boolean): string {
  let t = text.replace(/[\\`*_[\]<>~&]/g, '\\$&');
  if (atLineStart) t = t.replace(/^([-+#>])/, '\\$1').replace(/^(\d{1,9})([.)])/, '$1\\$2');
  return t;
}

const INLINE_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'del', 'strike', 'sub', 'sup', 'small', 'kbd', 'cite', 'span', 'mark', 'code']);
const SAFE_TO_REMOVE = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark', 'LinkMark', 'URL', 'LinkTitle', 'LinkLabel', 'StrongEmphasis', 'Emphasis', 'Strikethrough', 'InlineCode', 'Link', 'Escape']);

/** The edits that replace one match (null when `mode` does not apply to the block). */
export type PlanMode = 'raw' | 'escaped' | 'trimAfter' | 'trimBefore';
export function planMatch(state: EditorState, vis: Visible, m: Match, repl: string, mode: PlanMode): Edit[] | null {
  const b = m.block;
  if (mode === 'escaped' && b.raw) return null;
  if ((mode === 'trimAfter' || mode === 'trimBefore') && (repl !== '' || b.raw)) return null;
  let R = repl;
  if (mode === 'escaped') R = mdEscape(repl, m.s === 0 || vis.text[m.s - 1] === '\n');
  if (b.cell) R = escapeCell(R);
  const edits: Edit[] = m.pieces.map((p, i) => ({ from: p.from, to: p.to, insert: i === 0 ? R : '' }));
  // Deleting text next to a marker can leave a space against it (`**ab **`), which breaks the style: take one of the neighbouring spaces too.
  if (mode === 'trimAfter') { let p = m.to; while (p < state.doc.length && /[ \t]/.test(state.doc.sliceString(p, p + 1))) p++; if (p > m.to) edits.push({ from: m.to, to: p, insert: '' }); }
  if (mode === 'trimBefore') { let p = m.from; while (p > 0 && /[ \t]/.test(state.doc.sliceString(p - 1, p))) p--; if (p < m.from) edits.push({ from: p, to: m.from, insert: '' }); }
  // A style (bold, italic, strike, code, link) whose text is all deleted would be left empty: take its markers away too.
  const firstEnd = m.pieces[0].to;
  const seen = new Set<string>();
  syntaxTree(state).iterate({
    from: m.from, to: m.to,
    enter(node) {
      if (node.name !== 'StrongEmphasis' && node.name !== 'Emphasis' && node.name !== 'Strikethrough' && node.name !== 'InlineCode' && node.name !== 'Link') return undefined;
      const key = node.from + ':' + node.to;
      if (seen.has(key)) return undefined; seen.add(key);
      removeIfEmptied(vis, m, node.node, R === '', firstEnd, edits);
      return undefined;
    },
  });
  // The same for a pair of formatting tags (`<b>text</b>`).
  for (const t of vis.tagsOf.get(b.id) ?? []) {
    const name = /^<([a-z0-9-]+)/.exec(t.label)?.[1] ?? '';
    if (!INLINE_TAGS.has(name) || t.close.to <= m.from || t.open.from >= m.to) continue;
    let count = 0, ok = true;
    for (let p = t.open.to; p < t.close.from && ok; p++) {
      const i = vis.at[p]; if (i < 0) continue;
      count++;
      if (i < m.s || i >= m.e || (R !== '' && vis.end[i] <= firstEnd)) ok = false;
    }
    if (ok && count) edits.push({ from: t.open.from, to: t.open.to, insert: '' }, { from: t.close.from, to: t.close.to, insert: '' });
  }
  return mergeEdits(edits);
}

/** If every visible character of the style node is part of the match (and none will stay), delete the whole node. */
function removeIfEmptied(vis: Visible, m: Match, node: SyntaxNode, emptyRepl: boolean, firstEnd: number, edits: Edit[]): void {
  const { from, to } = node;
  let count = 0, keeps = false;
  for (let p = from; p < to; p++) {
    const i = vis.at[p];
    if (i < 0) continue;
    count++;
    if (i < m.s || i >= m.e) return; // text of the node stays
    if (vis.end[i] <= firstEnd && !emptyRepl) keeps = true; // part of the piece that receives the replacement
  }
  if (!count || keeps) return;
  const allSafe = (n: SyntaxNode): boolean => { for (let c = n.firstChild; c; c = c.nextSibling) if (!SAFE_TO_REMOVE.has(c.name) || !allSafe(c)) return false; return true; };
  const safe = allSafe(node);
  if (safe) edits.push({ from, to, insert: '' });
}

function mergeEdits(edits: Edit[]): Edit[] {
  const sorted = edits.slice().sort((a, b) => a.from - b.from || a.to - b.to);
  const out: Edit[] = [];
  for (const e of sorted) {
    const last = out[out.length - 1];
    if (last && e.from <= last.to && (e.from < last.to || e.from === last.to && e.to > e.from && last.to > last.from)) {
      last.to = Math.max(last.to, e.to); last.insert += e.insert;
    } else out.push({ ...e });
  }
  return out;
}

/** A style signature per visible character: the chain of syntax nodes around it plus the HTML tag pairs it sits inside. */
function signatures(state: EditorState, vis: Visible, table: Map<string, number>): Int32Array {
  const n = state.doc.length;
  const chain = new Int32Array(n);
  const stack: string[] = [];
  const intern = (s: string): number => { let k = table.get(s); if (k === undefined) { k = table.size + 1; table.set(s, k); } return k; };
  (ensureSyntaxTree(state, n, 500) ?? syntaxTree(state)).iterate({
    // An escape (`\\*`) is only how a character is written, not a style: it does not take part in the comparison.
    enter(node) { if (node.name === 'Escape') return; stack.push(node.name); const id = intern(stack.join('>')); chain.fill(id, node.from, Math.min(n, node.to)); },
    leave(node) { if (node.name !== 'Escape') stack.pop(); },
  });
  const extra = new Map<number, string>();
  for (const t of vis.tags) for (let p = t.open.to; p < t.close.from; p++) extra.set(p, (extra.get(p) ?? '') + t.label);
  const out = new Int32Array(vis.text.length);
  for (let i = 0; i < out.length; i++) {
    if (vis.pos[i] < 0) { out[i] = 0; continue; }
    const x = extra.get(vis.pos[i]);
    out[i] = x ? intern(`${chain[vis.pos[i]]}|${x}`) : chain[vis.pos[i]];
  }
  return out;
}

/** How many blocks of each kind the document has. A replacement must not create or remove a block (an emptied `** **` turns into a rule), except that a paragraph may become empty. */
const STRICT_BLOCKS = new Set(['ATXHeading1', 'ATXHeading2', 'ATXHeading3', 'ATXHeading4', 'ATXHeading5', 'ATXHeading6', 'SetextHeading1', 'SetextHeading2', 'BulletList', 'OrderedList', 'ListItem', 'Blockquote', 'FencedCode', 'CodeBlock', 'HTMLBlock', 'HorizontalRule', 'Table', 'TableHeader', 'TableRow', 'LinkReference', 'CommentBlock', 'ProcessingInstructionBlock']);
function blockCounts(state: EditorState): Map<string, number> {
  const out = new Map<string, number>();
  (ensureSyntaxTree(state, state.doc.length, 500) ?? syntaxTree(state)).iterate({ enter(n) { if (STRICT_BLOCKS.has(n.name) || n.name === 'Paragraph' || n.name === 'Task' || n.name === 'TableCell') out.set(n.name, (out.get(n.name) ?? 0) + 1); } });
  return out;
}

/** Applies the edits to the state and checks the result is exactly the text and styling the replacement should give. */
export function validate(state: EditorState, vis: Visible, matches: Match[], repl: string, edits: Edit[], lenient = false): boolean {
  const cs = state.update({ changes: edits.map((e) => ({ from: e.from, to: e.to, insert: e.insert })) });
  const next = cs.state;
  const table = new Map<string, number>();
  const vis2 = buildVisible(next);
  const sig1 = signatures(state, vis, table), sig2 = signatures(next, vis2, table);
  // What the text should now be: the old text with each match swapped for the replacement, then read the way the page reads it
  // (blanks at the ends of a line are not visible, empty lines and empty blocks leave no trace).
  const exp: Array<{ ch: string; sig: number; raw: boolean }> = [];
  const rawOf = (i: number): boolean => vis.blk[i] >= 0 && vis.blocks[vis.blk[i]].raw;
  let cursor = 0;
  for (const m of matches) {
    for (let i = cursor; i < m.s; i++) exp.push({ ch: vis.text[i], sig: sig1[i], raw: rawOf(i) });
    for (let k = 0; k < repl.length; k++) exp.push({ ch: repl[k], sig: sig1[m.s], raw: m.block.raw });
    cursor = m.e;
  }
  for (let i = cursor; i < vis.text.length; i++) exp.push({ ch: vis.text[i], sig: sig1[i], raw: rawOf(i) });
  let expText = ''; const expSig: number[] = [];
  let seg: typeof exp = [];
  const flush = (): void => {
    if (!seg.length) return;
    let a = 0, z = seg.length;
    if (!seg[0].raw) { while (a < z && (seg[a].ch === ' ' || seg[a].ch === '\t')) a++; while (z > a && (seg[z - 1].ch === ' ' || seg[z - 1].ch === '\t')) z--; }
    for (let i = a; i < z; i++) { expText += seg[i].ch; expSig.push(seg[i].sig); }
    if (z > a) { expText += '\n'; expSig.push(0); }
    seg = [];
  };
  for (const x of exp) { if (x.ch === '\n') flush(); else seg.push(x); }
  flush();
  if (lenient) { // spaces were taken away on purpose: compare everything except blanks
    const strip = (t: string, sig: ArrayLike<number>): string => { let o = ''; for (let i = 0; i < t.length; i++) if (t[i] !== ' ' && t[i] !== '\t') o += t[i] + ':' + sig[i] + ','; return o; };
    if (strip(vis2.text, sig2) !== strip(expText, expSig)) return false;
  } else if (vis2.text !== expText) return false;
  const c1 = blockCounts(state), c2 = blockCounts(next);
  for (const name of new Set([...c1.keys(), ...c2.keys()])) {
    const a = c1.get(name) ?? 0, b = c2.get(name) ?? 0;
    if (STRICT_BLOCKS.has(name) ? a !== b : b > a) return false;
  }
  if (!lenient) for (let i = 0; i < expSig.length; i++) if (expSig[i] !== 0 && sig2[i] !== expSig[i]) return false;
  return true;
}

interface Planned { edits: Edit[]; lenient: boolean }
const MODES: PlanMode[] = ['raw', 'escaped', 'trimAfter', 'trimBefore'];
function tryOne(state: EditorState, vis: Visible, m: Match, repl: string): Planned | null {
  for (const mode of MODES) {
    const edits = planMatch(state, vis, m, repl, mode);
    const lenient = mode === 'trimAfter' || mode === 'trimBefore';
    if (edits && validate(state, vis, [m], repl, edits, lenient)) return { edits, lenient };
  }
  return null;
}

/** Replaces one match. Null when no way of writing it keeps the document valid. */
export function replaceOne(state: EditorState, vis: Visible, m: Match, repl: string): Edit[] | null { return tryOne(state, vis, m, repl)?.edits ?? null; }

export interface ReplaceAllResult { edits: Edit[]; applied: number; skipped: number }
/** Replaces every match in one set of edits (to be applied as one transaction). Matches that cannot be replaced safely are skipped. */
export function replaceAll(state: EditorState, vis: Visible, matches: Match[], repl: string): ReplaceAllResult {
  const deadline = Date.now() + 10000;
  interface Part { good: Match[]; plans: Edit[][]; lenient: boolean; checked: boolean }
  // Try the whole list at once; if the document would not stay valid, split the list in two and try each half, down to one match.
  const solve = (list: Match[]): Part => {
    for (const mode of ['raw', 'escaped'] as const) {
      const plans = list.map((m) => planMatch(state, vis, m, repl, mode));
      if (plans.some((p) => !p)) continue;
      if (validate(state, vis, list, repl, mergeEdits((plans as Edit[][]).flat()))) return { good: list, plans: plans as Edit[][], lenient: false, checked: true };
    }
    if (list.length === 1) { const p = Date.now() < deadline ? tryOne(state, vis, list[0], repl) : null; return p ? { good: list, plans: [p.edits], lenient: p.lenient, checked: true } : { good: [], plans: [], lenient: false, checked: true }; }
    if (Date.now() >= deadline) return { good: [], plans: [], lenient: false, checked: true };
    const h = list.length >> 1; const x = solve(list.slice(0, h)), y = solve(list.slice(h));
    return { good: [...x.good, ...y.good], plans: [...x.plans, ...y.plans], lenient: x.lenient || y.lenient, checked: false };
  };
  const r = solve(matches);
  if (!r.good.length) return { edits: [], applied: 0, skipped: matches.length };
  const edits = mergeEdits(r.plans.flat());
  if (r.checked || validate(state, vis, r.good, repl, edits, r.lenient)) return { edits, applied: r.good.length, skipped: matches.length - r.good.length };
  // Each part is fine alone but they interact (neighbouring matches in one styled run): add the matches one by one, keeping those that still pass.
  const keep: Match[] = []; const keepPlans: Edit[][] = []; let lenient = false;
  for (let i = 0; i < r.good.length && Date.now() < deadline; i++) {
    const tryM = [...keep, r.good[i]]; const tryP = [...keepPlans, r.plans[i]];
    const len: boolean = lenient || r.lenient;
    if (validate(state, vis, tryM, repl, mergeEdits(tryP.flat()), len)) { keep.push(r.good[i]); keepPlans.push(r.plans[i]); lenient = len; }
  }
  if (!keep.length) return { edits: [], applied: 0, skipped: matches.length };
  return { edits: mergeEdits(keepPlans.flat()), applied: keep.length, skipped: matches.length - keep.length };
}

/** Offset in a focused table cell's text (where a <br> is one line break and `\|` is one `|`) of the file offset `p` inside the cell. */
export function cellEditOffset(raw: string, k: number): number {
  return unescapeCell(raw.slice(0, k)).replace(/<br>/g, '\n').length;
}

// ---- the editor state: query, matches, highlights ----
export interface FindState {
  active: boolean; query: string; matchCase: boolean; wholeWord: boolean;
  vis: Visible | null; matches: Match[];
  /** Index of the current match, or -1. */
  cur: number;
  /** File offset where the current match starts: it follows the document as it changes. */
  anchor: number;
  deco: DecorationSet;
}
export interface FindCfg { active?: boolean; query?: string; matchCase?: boolean; wholeWord?: boolean; cur?: number; from?: number }
export const findCfg = StateEffect.define<FindCfg>();

const markAll = Decoration.mark({ class: 'lm-find' });
const markCur = Decoration.mark({ class: 'lm-find lm-find-cur' });

function decorate(matches: Match[], cur: number): DecorationSet {
  const out: Array<Range<Decoration>> = [];
  matches.forEach((m, k) => {
    if (m.block.cell?.widget) return; // drawn inside the table cell by the page
    for (const p of m.pieces) if (p.to > p.from) out.push((k === cur ? markCur : markAll).range(p.from, p.to));
  });
  return Decoration.set(out, true);
}

function compute(state: EditorState, f: FindState, from: number | null, keepAnchor: boolean): FindState {
  if (!f.active || !f.query) return { ...f, vis: null, matches: [], cur: -1, anchor: from ?? f.anchor, deco: Decoration.none };
  const vis = buildVisible(state);
  const matches = findMatches(vis, f.query, f);
  let cur = -1;
  if (matches.length) {
    const at = keepAnchor && from === null ? f.anchor : from ?? f.anchor;
    cur = matches.findIndex((m) => m.from >= at);
    if (cur < 0) cur = 0;
  }
  return { ...f, vis, matches, cur, anchor: cur >= 0 ? matches[cur].from : f.anchor, deco: decorate(matches, cur) };
}

export const findField = StateField.define<FindState>({
  create: () => ({ active: false, query: '', matchCase: false, wholeWord: false, vis: null, matches: [], cur: -1, anchor: 0, deco: Decoration.none }),
  update(v, tr) {
    let f = v; let changed = false; let from: number | null = null; let explicit = -2;
    for (const e of tr.effects) if (e.is(findCfg)) {
      const c = e.value;
      if (c.active !== undefined && c.active !== f.active) { f = { ...f, active: c.active }; changed = true; }
      if (c.query !== undefined && c.query !== f.query) { f = { ...f, query: c.query }; changed = true; }
      if (c.matchCase !== undefined && c.matchCase !== f.matchCase) { f = { ...f, matchCase: c.matchCase }; changed = true; }
      if (c.wholeWord !== undefined && c.wholeWord !== f.wholeWord) { f = { ...f, wholeWord: c.wholeWord }; changed = true; }
      if (c.from !== undefined) { from = c.from; changed = true; }
      if (c.cur !== undefined) explicit = c.cur;
    }
    if (tr.docChanged) {
      f = { ...f, anchor: tr.changes.mapPos(f.anchor, 1) };
      changed = true;
    }
    if (!changed && explicit === -2) return f;
    if (changed) f = compute(tr.state, f, from, true);
    if (explicit !== -2 && f.matches.length) {
      const cur = ((explicit % f.matches.length) + f.matches.length) % f.matches.length;
      f = { ...f, cur, anchor: f.matches[cur].from, deco: decorate(f.matches, cur) };
    }
    return f;
  },
  provide: (fld) => EditorView.decorations.from(fld, (s) => s.deco),
});

/** The visible text of the document inside [from, to), or null when it spans more than one line / block. */
export function visibleTextIn(vis: Visible, from: number, to: number): string | null {
  let first = -1, last = -1;
  for (let i = 0; i < vis.text.length; i++) {
    if (vis.pos[i] < 0 || vis.pos[i] < from || vis.end[i] > to) continue;
    if (first < 0) first = i;
    last = i;
  }
  if (first < 0) return null;
  const t = vis.text.slice(first, last + 1);
  return t.includes('\n') ? null : t;
}
