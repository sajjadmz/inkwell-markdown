// Word-like list editing. Pure functions on an EditorState (they return a TransactionSpec or null = "not for me, do the normal thing"),
// plus one transaction filter that renumbers ordered lists after the user's own edits.
//
//   Enter       end of an item: new item with the next marker (checklist: unchecked; loose list: blank line first).
//               middle of an item: splits it. start of the text: an empty item appears above. empty item: ends the list
//               (top level) or moves the item up one level (nested). Lines of a quote continue with "> ".
//   Shift+Enter a soft line break inside the same item, indented to the item's text column.
//   Backspace   right after a marker: removes the marker and keeps the text.
//   Delete      at the end of an item's text: the next item's text joins this one (its marker goes).
//   renumber    after the user's own change to a numbered list, the items that follow are numbered consecutively again.
//
// Nothing here runs for remote changes, undo/redo, or when a list is only opened or navigated.
import { ChangeSet, EditorSelection, EditorState, Transaction, type ChangeSpec, type Line, type TransactionSpec } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { isolateHistory } from '@codemirror/commands';
import type { SyntaxNode, Tree } from '@lezer/common';
import { indentList } from './format';
import { parsePre, mapAcrossPrefix, type Pre } from './listprefix';

const isOrdered = (marker: string): boolean => /^\d/.test(marker);
const colsOf = (ws: string): number => { let c = 0; for (const ch of ws) c += ch === '\t' ? 4 - (c % 4) : 1; return c; };

const BLOCKED = new Set(['FencedCode', 'CodeBlock', 'Table', 'HTMLBlock', 'CommentBlock', 'ProcessingInstructionBlock', 'Blockquote', 'FrontMatter']);

function treeOf(state: EditorState): Tree { return ensureSyntaxTree(state, state.doc.length, 150) ?? syntaxTree(state); }

export interface Item {
  node: SyntaxNode; list: SyntaxNode; mline: Line; pre: Pre; ordered: boolean; num: number; nested: boolean; onMarkerLine: boolean;
  /** the item has no text and nothing below its marker line */
  empty: boolean;
}

/** The list item the line belongs to (its marker line, or a line of its paragraph), or null when the line is not plain list text. */
export function itemForLine(state: EditorState, tree: Tree, line: Line): Item | null {
  const doc = state.doc;
  const pre = parsePre(line.text);
  let li: SyntaxNode | null = null;
  let onMarkerLine = false;
  if (pre.marker) {
    const n = tree.resolveInner(line.from + pre.markerAt, 1);
    if (n.name === 'ListMark' && n.parent) { li = n.parent; onMarkerLine = true; }
  }
  if (!li) {
    if (line.text.slice(pre.len).trim() === '') return null;
    for (let n: SyntaxNode | null = tree.resolveInner(line.from + pre.markerAt, 1); n; n = n.parent) {
      if (n.name === 'ListItem') { li = n; break; }
      if (BLOCKED.has(n.name)) return null;
    }
    if (!li) return null;
  }
  const list = li.parent; if (!list) return null;
  const mline = doc.lineAt(li.from);
  const mp = parsePre(mline.text);
  if (!mp.marker) return null;
  const mark = li.getChild('ListMark'); if (!mark || mark.from !== mline.from + mp.markerAt) return null;
  const ordered = isOrdered(mp.marker);
  const empty = mline.text.slice(mp.len).trim() === '' && li.to <= mline.to;
  return { node: li, list, mline, pre: mp, ordered, num: ordered ? parseInt(mp.marker, 10) : 0, nested: list.parent?.name === 'ListItem', onMarkerLine, empty };
}

const itemsOf = (list: SyntaxNode): SyntaxNode[] => list.getChildren('ListItem');
/** A list is loose when a blank line separates two of its items. */
function isLoose(state: EditorState, list: SyntaxNode): boolean {
  const its = itemsOf(list);
  const lastLine = (li: SyntaxNode): number => { // the last line of the item's own content (a trailing quote mark of an empty quote line does not count)
    let to = li.from;
    for (let c = li.firstChild; c; c = c.nextSibling) if (c.name !== 'QuoteMark') to = Math.max(to, c.to);
    return state.doc.lineAt(to).number;
  };
  for (let i = 0; i + 1 < its.length; i++) if (state.doc.lineAt(its[i + 1].from).number - lastLine(its[i]) > 1) return true;
  return false;
}
const quoteBlank = (q: string): string => q.trimEnd();

function nextMarker(state: EditorState, it: Item): string {
  if (!it.ordered) return it.pre.marker;
  const nums = itemsOf(it.list).map((li) => parseInt(parsePre(state.doc.lineAt(li.from).text).marker, 10));
  const lazy = nums.length >= 2 && nums.every((n) => n === nums[0]); // "1. 1. 1." stays "1."
  return (lazy ? it.num : it.num + 1) + it.pre.marker.slice(-1);
}
/** The text in front of an item's text for a new sibling of `it` (without the quote marks). */
function itemPrefix(it: Item, marker: string): string {
  const task = it.pre.task ? '[ ]' + (it.pre.task.slice(3) || ' ') : '';
  return it.pre.ws + marker + (it.pre.gap || ' ') + task;
}

const withHistory = (spec: TransactionSpec, event: string): TransactionSpec => ({ ...spec, userEvent: event, annotations: isolateHistory.of('full'), scrollIntoView: true });

// ---------------------------------------------------------------------------------------------------------- Enter
export function enterSpec(state: EditorState): TransactionSpec | null {
  if (state.selection.ranges.length !== 1) return null;
  const r = state.selection.main; const doc = state.doc;
  const line = doc.lineAt(r.from);
  const tree = treeOf(state);
  const it = itemForLine(state, tree, line);
  if (it) return enterInItem(state, it, line, r.from, r.to);
  const ps = enterOnEmptyMarker(state, tree, line, r.from, r.to);
  if (ps) return ps;
  return enterInQuote(state, tree, line, r.from, r.to);
}

function enterInItem(state: EditorState, it: Item, line: Line, from: number, to: number): TransactionSpec | null {
  const doc = state.doc; const q = it.pre.q;
  const loose = isLoose(state, it.list);
  const blank = loose ? quoteBlank(q) + '\n' : '';
  const emptyCaret = from === to;
  if (it.onMarkerLine && it.empty && emptyCaret) { // Enter on an empty item: the list ends here, or the item moves out one level
    if (it.nested) {
      const r = indentList(state, -1);
      if (r.spec) return withHistory(r.spec, 'input.enter');
    }
    const at = line.from + q.length;
    return withHistory({ changes: { from: at, to: line.to, insert: '' }, selection: { anchor: at } }, 'input.enter');
  }
  const textStart = line.from + (it.onMarkerLine ? it.pre.len : parsePre(line.text).markerAt);
  if (it.onMarkerLine && emptyCaret && from <= textStart && line.text.slice(it.pre.len).trim() !== '') { // Enter before the text: an empty item appears above
    const at = line.from + q.length;
    const ins = itemPrefix(it, it.pre.marker) + '\n' + blank + q;
    return withHistory({ changes: { from: at, insert: ins }, selection: { anchor: textStart + ins.length } }, 'input.enter');
  }
  const next = itemPrefix(it, nextMarker(state, it));
  const f = Math.max(from, textStart), t = Math.max(to, f);
  if (!it.onMarkerLine && from <= textStart) { // start of a continuation line: that line becomes the new item
    const ins = blank + q + next;
    return withHistory({ changes: { from: line.from, to: t, insert: ins }, selection: { anchor: line.from + ins.length } }, 'input.enter');
  }
  const ins = '\n' + blank + q + next;
  return withHistory({ changes: { from: f, to: t, insert: ins }, selection: { anchor: f + ins.length } }, 'input.enter');
}

/**
 * "- " or "1. " alone on the first line under an item's text is not a list item for the Markdown parser yet (an empty marker cannot
 * start a list inside a paragraph), but to the user it is an empty item: Enter moves it out one level, next to the item above.
 */
function enterOnEmptyMarker(state: EditorState, tree: Tree, line: Line, from: number, to: number): TransactionSpec | null {
  const pre = parsePre(line.text);
  if (from !== to || !pre.marker || pre.task || line.text.slice(pre.len).trim() !== '' || pre.ws === '') return null;
  let parent: SyntaxNode | null = null;
  for (let n: SyntaxNode | null = tree.resolveInner(line.from + pre.markerAt, 1); n; n = n.parent) {
    if (n.name === 'ListItem') { parent = n; break; }
    if (BLOCKED.has(n.name)) return null;
  }
  if (!parent) return null;
  const pit = itemForLine(state, tree, state.doc.lineAt(parent.from));
  if (!pit) return null;
  const marker = pit.ordered ? (pit.num + 1) + pit.pre.marker.slice(-1) : pit.pre.marker; // the item takes the style of the list it joins
  const text = pit.pre.q + pit.pre.ws + marker + (pre.gap || ' ');
  return withHistory({ changes: { from: line.from, to: line.to, insert: text }, selection: { anchor: line.from + text.length } }, 'input.enter');
}

function enterInQuote(state: EditorState, tree: Tree, line: Line, from: number, to: number): TransactionSpec | null {
  const pre = parsePre(line.text);
  if (!pre.q || pre.marker) return null;
  if (from < line.from + pre.q.length) return null;
  let inQuote = false;
  for (let n: SyntaxNode | null = tree.resolveInner(line.from + pre.q.lastIndexOf('>'), 1); n; n = n.parent) {
    if (n.name === 'Blockquote') { inQuote = true; break; }
    if (BLOCKED.has(n.name)) return null;
  }
  if (!inQuote) return null;
  const content = line.text.slice(pre.q.length);
  if (from === to && content.trim() === '') { // an empty quote line ends the quote (one level)
    const q2 = pre.q.slice(0, pre.q.lastIndexOf('>'));
    return withHistory({ changes: { from: line.from, to: line.to, insert: q2 }, selection: { anchor: line.from + q2.length } }, 'input.enter');
  }
  const ins = '\n' + pre.q;
  return withHistory({ changes: { from, to, insert: ins }, selection: { anchor: from + ins.length } }, 'input.enter');
}

// ---------------------------------------------------------------------------------------------------- Shift+Enter
/** A soft line break that stays in the item: the new line is indented to the column where the item's text starts. */
export function softBreakSpec(state: EditorState): TransactionSpec | null {
  if (state.selection.ranges.length !== 1) return null;
  const r = state.selection.main;
  const line = state.doc.lineAt(r.from);
  const it = itemForLine(state, treeOf(state), line);
  if (!it) return null;
  const textStart = line.from + (it.onMarkerLine ? it.pre.len : parsePre(line.text).markerAt);
  const f = Math.max(r.from, textStart), t = Math.max(r.to, f);
  const p = it.pre;
  const gap = colsOf(p.gap);
  const col = colsOf(p.ws) + p.marker.length + (p.gap === '' || gap > 4 ? 1 : gap);
  const ins = '\n' + p.q + ' '.repeat(col);
  return withHistory({ changes: { from: f, to: t, insert: ins }, selection: { anchor: f + ins.length } }, 'input.softbreak');
}

// ---------------------------------------------------------------------------------------------------- Backspace
const isBlankish = (text: string): boolean => text.replace(/^(?:[ \t]*>)*/, '').trim() === '';

/**
 * Backspace right after a marker removes the marker and keeps the text. Markdown has no marker-less line that stays apart from the
 * item above without a blank line, so a blank line is added in front when the line above is text, and behind when the next line is
 * another item (otherwise the text would read as a continuation of the item above, and a following "3." could not start an item).
 * A nested item keeps its indentation (the text then belongs to the parent item); a top-level one moves to the margin.
 */
export function backspaceSpec(state: EditorState): TransactionSpec | null {
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return null;
  const doc = state.doc; const c = state.selection.main.head;
  const line = doc.lineAt(c);
  const tree = treeOf(state);
  const it = itemForLine(state, tree, line);
  if (!it || !it.onMarkerLine) return null;
  const textStart = line.from + it.pre.len;
  if (c !== textStart) return null;
  const q = it.pre.q;
  const keep = it.nested ? it.pre.ws.length : 0;
  const from = line.from + q.length + keep;
  const changes: ChangeSpec[] = [{ from, to: textStart, insert: '' }];
  let caret = from;
  const hasText = (l: Line): boolean => !isBlankish(l.text);
  if (line.number > 1) {
    const prev = doc.line(line.number - 1);
    if (hasText(prev)) {
      let inText = false;
      for (let n: SyntaxNode | null = tree.resolveInner(prev.from + parsePre(prev.text).len, 1); n; n = n.parent) if (n.name === 'Paragraph' || n.name === 'ListItem') { inText = true; break; }
      if (inText) { const ins = quoteBlank(q) + '\n'; changes.push({ from: line.from, insert: ins }); caret += ins.length; }
    }
  }
  if (line.number < doc.lines && line.text.slice(it.pre.len).trim() !== '') {
    const nx = doc.line(line.number + 1);
    const np = parsePre(nx.text);
    if (np.marker && hasText(nx) && itemForLine(state, tree, nx)?.onMarkerLine) changes.push({ from: line.to, insert: '\n' + quoteBlank(q) });
  }
  if (!it.nested) { // lines of the item below its first line keep their relative indentation, but must not reach 4 spaces (that would be code)
    const cc = colsOf(it.pre.ws) + it.pre.marker.length + (it.pre.gap === '' || colsOf(it.pre.gap) > 4 ? 1 : colsOf(it.pre.gap));
    if (cc >= 4) {
      const S = cc - 2; const last = doc.lineAt(it.node.to).number;
      for (let i = line.number + 1; i <= last; i++) {
        const l = doc.line(i); if (!l.text.startsWith(q)) continue;
        const sp = /^ */.exec(l.text.slice(q.length))![0].length;
        if (l.text.slice(q.length).trim() !== '' && sp >= cc) changes.push({ from: l.from + q.length, to: l.from + q.length + Math.min(S, sp), insert: '' });
      }
    }
  }
  return withHistory({ changes, selection: { anchor: caret } }, 'delete.backward');
}

// ------------------------------------------------------------------------------------------------------- Delete
/** Delete at the end of an item's text: the next item's text joins this one, and its marker goes (like joining two paragraphs). */
export function deleteSpec(state: EditorState): TransactionSpec | null {
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return null;
  const doc = state.doc; const c = state.selection.main.head;
  const line = doc.lineAt(c);
  if (c !== line.to || line.number >= doc.lines) return null;
  const tree = treeOf(state);
  const cur = itemForLine(state, tree, line);
  if (!cur) return null;
  const nx = doc.line(line.number + 1);
  const nit = itemForLine(state, tree, nx);
  if (!nit || !nit.onMarkerLine || nit.pre.q !== parsePre(line.text).q) return null;
  return withHistory({ changes: { from: c, to: nx.from + nit.pre.len, insert: '' }, selection: { anchor: c } }, 'delete.forward');
}

// ------------------------------------------------------------------------------------------------- renumbering
const USER_EVENTS = ['input', 'delete', 'move', 'format'];
const NOT_LISTS = ['input.replace', 'input.toggleTask', 'input.table', 'input.format'];

interface Num { item: SyntaxNode; mline: Line; pre: Pre; from: number; digits: number; num: number; touched: boolean; oldList: number; oldIdx: number }

/**
 * After a change the user made, numbers the items that follow it consecutively again (only the digits change; an item whose
 * number gets one digit wider or narrower also moves its own continuation lines by that much so they stay inside it).
 * Returns null when nothing needs to change. Lists the change did not reach, and lists where every item has the same number ("1. 1. 1."), stay as they are.
 */
function renumber(tr: Transaction): TransactionSpec | null {
  const oldDoc = tr.startState.doc, newDoc = tr.newDoc;
  let relevant = false; let singleLine = true; let lo = Infinity, hi = -1, oLo = Infinity, oHi = -1;
  const ordIn = (doc: typeof oldDoc, a: number, b: number): boolean => {
    const l1 = doc.lineAt(a).number, l2 = Math.min(doc.lineAt(b).number, l1 + 400);
    for (let i = l1; i <= l2; i++) if (isOrdered(parsePre(doc.line(i).text).marker)) return true;
    return false;
  };
  tr.changes.iterChanges((fA, tA, fB, tB, ins) => {
    const nl = ins.lines > 1 || (tA > fA && oldDoc.sliceString(fA, tA).includes('\n'));
    if (nl) singleLine = false;
    lo = Math.min(lo, fB); hi = Math.max(hi, tB); oLo = Math.min(oLo, fA); oHi = Math.max(oHi, tA);
    const la = oldDoc.lineAt(fA), lb = newDoc.lineAt(fB);
    const touch = fA < la.from + parsePre(la.text).len || fB < lb.from + parsePre(lb.text).len;
    if ((nl || touch) && (ordIn(oldDoc, fA, tA) || ordIn(newDoc, fB, tB))) relevant = true;
  });
  if (!relevant) return null;

  const ns = tr.state, os = tr.startState;
  const nTree = treeOf(ns), oTree = treeOf(os);
  const inv = tr.changes.invertedDesc;
  let spanFrom = Math.max(0, newDoc.lineAt(lo).from - 1), spanTo = Math.min(newDoc.length, newDoc.lineAt(Math.min(hi, newDoc.length)).to + 1);
  // every ordered list that was there before the change reaches as far as it did, so the pieces a list was split into are found too
  oTree.iterate({ from: Math.max(0, oLo - 1), to: Math.min(oldDoc.length, oHi + 1), enter: (n) => {
    if (n.name === 'OrderedList') { spanFrom = Math.min(spanFrom, tr.changes.mapPos(n.from, -1)); spanTo = Math.max(spanTo, tr.changes.mapPos(n.to, 1)); }
  } });
  const lists: SyntaxNode[] = [];
  nTree.iterate({ from: spanFrom, to: spanTo, enter: (n) => { if (n.name === 'OrderedList') lists.push(n.node); } });
  const edits: ChangeSpec[] = [];
  const shifts = new Map<number, { d: number; q: number }>(); // line number -> columns to add (or remove) in front of the line's text, and where
  const touchedLines = new Set<number>();

  for (const list of lists) {
    const items: Num[] = [];
    for (const li of itemsOf(list)) {
      const mark = li.getChild('ListMark'); if (!mark) continue;
      const mline = newDoc.lineAt(mark.from); const pre = parsePre(mline.text);
      if (mark.from !== mline.from + pre.markerAt) continue;
      const txt = newDoc.sliceString(mark.from, mark.to);
      // untouched = the very same text in front of the item's text, on a line that was a line of its own before
      const lp = inv.mapPos(mline.from, 1);
      const touched = !(oldDoc.lineAt(lp).from === lp && oldDoc.sliceString(lp, lp + pre.len) === newDoc.sliceString(mline.from, mline.from + pre.len));
      let oldList = -1, oldIdx = -1;
      if (!touched) {
        const op = lp + pre.markerAt;
        const on = oTree.resolveInner(op, 1);
        if (on.name === 'ListMark' && on.from === op && on.parent?.parent) {
          oldList = on.parent.parent.from;
          oldIdx = itemsOf(on.parent.parent).findIndex((x) => x.from === on.parent!.from);
        }
      }
      items.push({ item: li, mline, pre, from: mark.from, digits: txt.length - 1, num: parseInt(txt, 10), touched, oldList, oldIdx });
    }
    if (items.length === 0) continue;
    if (items.length >= 2 && items.every((x) => x.num === items[0].num)) continue; // "1. 1. 1." lists stay as they are
    const anyCp = items.some((x) => x.oldIdx >= 0);
    if (!anyCp && !singleLine) continue; // a block pasted or created as a whole keeps its numbers
    // the first item that is new, changed, or no longer follows its old neighbour
    let t = items.length;
    for (let i = 0; i < items.length; i++) {
      const x = items[i];
      if (x.oldIdx < 0) { t = i; break; }
      if (i === 0) { if (x.oldIdx > 0) { t = 0; break; } continue; }
      const p = items[i - 1];
      if (p.oldIdx < 0 || x.oldList !== p.oldList || x.oldIdx !== p.oldIdx + 1) { t = i; break; }
    }
    if (t >= items.length) continue;
    let counter: number;
    if (t === 0) {
      const withCp = items.find((x) => x.oldIdx >= 0);
      if (items[0].oldIdx < 0 && singleLine) counter = items[0].num; // the user typed this number
      else if (withCp) {
        counter = findOldStart(os, oTree, tr, withCp.oldList, withCp.oldIdx) ?? withCp.num - Math.max(0, withCp.oldIdx);
      } else counter = items[0].num;
    } else if (items[t].oldIdx < 0 && singleLine && items[t].touched) counter = items[t].num;
    else counter = items[t - 1].num + 1;
    for (let i = t; i < items.length; i++) {
      const x = items[i]; const target = counter++;
      if (target === x.num) continue;
      const newDigits = String(target).length; const d = newDigits - x.digits;
      edits.push({ from: x.from, to: x.from + x.digits, insert: String(target) });
      touchedLines.add(x.mline.number);
      if (d !== 0 && !/\t/.test(x.pre.ws + x.pre.gap)) {
        const cc = x.pre.ws.length + x.pre.marker.length + (x.pre.gap === '' || x.pre.gap.length > 4 ? 1 : x.pre.gap.length);
        const last = newDoc.lineAt(x.item.to).number;
        for (let n = x.mline.number + 1; n <= last; n++) {
          const l = newDoc.line(n);
          if (!l.text.startsWith(x.pre.q)) continue;
          const rest = l.text.slice(x.pre.q.length);
          if (rest.trim() === '') continue;
          const sp = /^ */.exec(rest)![0].length;
          if (sp < cc || rest[sp] === '\t') continue;
          const e = shifts.get(n); shifts.set(n, { d: (e?.d ?? 0) + d, q: x.pre.q.length });
        }
      }
    }
  }
  for (const [n, s] of shifts) {
    const l = newDoc.line(n); const at = l.from + s.q;
    if (s.d > 0) edits.push({ from: at, insert: ' '.repeat(s.d) }); else if (s.d < 0) edits.push({ from: at, to: at - s.d, insert: '' });
    touchedLines.add(n);
  }
  if (!edits.length) return null;
  const extra = ChangeSet.of(edits, newDoc.length);
  const after = extra.apply(newDoc);
  const mapEnd = (pos: number, caret: boolean): number => {
    const ln = newDoc.lineAt(pos);
    if (!touchedLines.has(ln.number)) return extra.mapPos(pos, 1);
    const nf = extra.mapPos(ln.from, -1);
    return nf + mapAcrossPrefix(ln.text, after.lineAt(nf).text, pos - ln.from, caret);
  };
  const sel = tr.newSelection;
  const ranges = sel.ranges.map((r) => (r.empty ? EditorSelection.cursor(mapEnd(r.head, true))
    : EditorSelection.range(mapEnd(r.anchor, false), mapEnd(r.head, false))));
  const spec: TransactionSpec = {
    changes: tr.changes.compose(extra), selection: EditorSelection.create(ranges, sel.mainIndex), effects: tr.effects, scrollIntoView: tr.scrollIntoView,
    userEvent: userEventOf(tr), filter: false,
  };
  const iso = tr.annotation(isolateHistory); if (iso) spec.annotations = isolateHistory.of(iso);
  return spec;
}

function userEventOf(tr: Transaction): string | undefined {
  const ue = tr.annotation(Transaction.userEvent);
  return typeof ue === 'string' ? ue : undefined;
}

/**
 * Where a piece of an old ordered list that starts at its item number `idx` continues: the old list's first number plus the
 * number of its earlier items that are still there with their marker unchanged (so a list split by removing a marker goes on counting).
 */
function findOldStart(os: EditorState, tree: Tree, tr: Transaction, pos: number, idx: number): number | null {
  for (let x: SyntaxNode | null = tree.resolveInner(pos, 1); x; x = x.parent) {
    if (x.name !== 'OrderedList' || x.from !== pos) continue;
    const its = itemsOf(x); if (!its.length) return null;
    const first = parsePre(os.doc.lineAt(its[0].from).text);
    if (!isOrdered(first.marker)) return null;
    let alive = 0;
    for (let j = 0; j < Math.min(idx, its.length); j++) {
      const l = os.doc.lineAt(its[j].from);
      const len = parsePre(l.text).len;
      if (tr.changes.touchesRange(l.from + 1, l.from + Math.max(1, len - 1)) !== false) continue;
      const np = tr.changes.mapPos(l.from, 1);
      if (tr.newDoc.lineAt(np).from === np && tr.newDoc.sliceString(np, np + len) === l.text.slice(0, len)) alive++;
    }
    return parseInt(first.marker, 10) + alive;
  }
  return null;
}

/** Transaction filter: renumbers ordered lists after the user's own edits. `isLocal` says whether a transaction came from the user (not from the file). */
export function listRenumber(isLocal: (tr: Transaction) => boolean) {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || !isLocal(tr)) return tr;
    if (tr.annotation(Transaction.addToHistory) === false) return tr;
    if (!USER_EVENTS.some((e) => tr.isUserEvent(e)) || NOT_LISTS.some((e) => tr.isUserEvent(e))) return tr;
    let spec: TransactionSpec | null = null;
    try { spec = renumber(tr); } catch { spec = null; } // a list that cannot be analysed is left alone
    return spec ? [spec] : tr;
  });
}
