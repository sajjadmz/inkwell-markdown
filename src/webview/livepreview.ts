// Obsidian-style live preview: everything here is a CodeMirror decoration. The document is never changed
// by this file (the only edit is the task checkbox, which is an explicit user click: '[ ]' <-> '[x]').
import { EditorState, StateEffect, StateField, type ChangeSpec, type Range } from '@codemirror/state';
import { setTip } from './tooltip';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common';
import MarkdownIt from 'markdown-it';
import { MermaidWidget } from './mermaidwidget';
import { findColourPairs } from './format';
import { frontMatter } from './findcore';
import { cellEnter, cellBackspace, type CellEdit } from './celllist';
import { doubleSpaceOn, cellPeriodPlan } from './spaces';
import { parseTable, rowIndex, addRow, deleteRow, addColumn, deleteColumn, setAlign, unescapeCell, escapeCell, endsWithBackslash, alignOf, type Row, type Align } from './table';

/** Hooks main.ts fills in so the editable table cells can use VS Code's undo/redo. */
export const hooks = { undo: () => {}, redo: () => {} };
/** While the mouse button is down the live-preview reveal is frozen, so text never shifts under a drag. */
export const setFrozen = StateEffect.define<boolean>();
export const refreshPreview = StateEffect.define<null>();
const frozenField = StateField.define<boolean>({
  create: () => false,
  update(v, tr) { for (const e of tr.effects) if (e.is(setFrozen)) v = e.value; return v; },
});

let baseUri = '';
export const setBaseUri = (u: string): void => { baseUri = u; };

const md = new MarkdownIt({ html: false, linkify: false });

function resolveSrc(src: string): string {
  if (/^(https?:|data:)/i.test(src)) return src;
  try { return new URL(encodeURI(decodeURI(src)), baseUri).href; } catch { return src; }
}

class BulletWidget extends WidgetType {
  constructor(readonly level: number) { super(); }
  eq(o: BulletWidget): boolean { return o.level === this.level; }
  toDOM(): HTMLElement { const s = document.createElement('span'); s.className = 'lm-bullet'; s.textContent = ['•', '◦', '▪'][this.level % 3]; return s; }
  ignoreEvent(): boolean { return false; }
}

/** The only place live preview edits the document: a click flips exactly one character, ' ' <-> 'x'. */
export function toggleTaskAt(view: EditorView, pos: number): boolean {
  const line = view.state.doc.lineAt(pos);
  const m = /^(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\]/.exec(line.text.slice(pos - line.from));
  if (!m) return false;
  const at = pos + m[0].length - 2;
  view.dispatch({ changes: { from: at, to: at + 1, insert: m[1] === ' ' ? 'x' : ' ' }, userEvent: 'input.toggleTask' });
  return true;
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) { super(); }
  eq(o: CheckboxWidget): boolean { return o.checked === this.checked; }
  toDOM(view: EditorView): HTMLElement {
    const i = document.createElement('input');
    i.type = 'checkbox'; i.className = 'task-list-item-checkbox lm-checkbox'; i.checked = this.checked; if (this.checked) i.setAttribute('checked', '');
    i.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); toggleTaskAt(view, view.posAtDOM(i)); });
    i.addEventListener('click', (e) => e.preventDefault());
    return i;
  }
  ignoreEvent(): boolean { return true; }
}

// ---- editable table: always rendered, each cell is a plain-text contenteditable mapped to its source range ----
function tableAt(view: EditorView, dom: HTMLElement): { rows: Row[]; from: number; to: number } | null {
  const pos = view.posAtDOM(dom);
  let n = syntaxTree(view.state).resolveInner(pos, 1) as { name: string; parent: unknown; from: number; to: number } | null;
  while (n && n.name !== 'Table') n = n.parent as typeof n;
  if (!n) return null;
  const doc = view.state.doc;
  const lines: Array<{ from: number; text: string }> = [];
  for (let i = doc.lineAt(n.from).number; i <= doc.lineAt(n.to).number; i++) lines.push({ from: doc.line(i).from, text: doc.line(i).text });
  return { rows: parseTable(lines), from: n.from, to: n.to };
}

const displayRows = (rows: Row[]): Row[] => [rows[0], ...rows.slice(2)];
const ALIGN_CSS: Record<Align, string> = { left: 'left', center: 'center', right: 'right', none: '' };
// ---- table controls: ONE floating bar (and one context menu) on document.body, so neither the table nor the scroller clips it ----
const SVG = (inner: string): string => `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ROWBOX = '<rect x="2.5" y="7.5" width="15" height="5" rx="1"/>';
const COLBOX = '<rect x="7.5" y="2.5" width="5" height="15" rx="1"/>';
const ICON: Record<string, string> = {
  rowAbove: SVG(ROWBOX.replace('y="7.5"', 'y="11.5"').replace('height="5"', 'height="5"') + '<path d="M10 2.5v6M7 5.5h6"/>'),
  rowBelow: SVG(ROWBOX.replace('y="7.5"', 'y="3.5"') + '<path d="M10 11.5v6M7 14.5h6"/>'),
  colLeft: SVG(COLBOX.replace('x="7.5"', 'x="11.5"') + '<path d="M2.5 10h6M5.5 7v6"/>'),
  colRight: SVG(COLBOX.replace('x="7.5"', 'x="3.5"') + '<path d="M11.5 10h6M14.5 7v6"/>'),
  delRow: SVG(ROWBOX + '<path d="M8 8.5l4 3M12 8.5l-4 3" stroke-width="1.5"/>'),
  delCol: SVG(COLBOX + '<path d="M8.5 8l3 4M11.5 8l-3 4" stroke-width="1.5"/>'),
  alignLeft: SVG('<path d="M3 4.5h14M3 8.5h8M3 12.5h14M3 16.5h8"/>'),
  alignCenter: SVG('<path d="M3 4.5h14M6 8.5h8M3 12.5h14M6 16.5h8"/>'),
  alignRight: SVG('<path d="M3 4.5h14M9 8.5h8M3 12.5h14M9 16.5h8"/>'),
  alignNone: SVG('<path d="M3 4.5h14M3 8.5h14M3 12.5h14M3 16.5h9" opacity=".55"/><path d="M14 14l4 4M18 14l-4 4" stroke-width="1.4"/>'),
};
// [op, group, label, tooltip, kind]
const CTL: Array<[string, string, string, string, 'add' | 'del' | 'neutral']> = [
  ['rowAbove', 'Row', 'Above', 'Add row above', 'add'], ['rowBelow', 'Row', 'Below', 'Add row below', 'add'], ['delRow', 'Row', 'Delete', 'Delete this row', 'del'],
  ['colLeft', 'Column', 'Left', 'Add column to the left', 'add'], ['colRight', 'Column', 'Right', 'Add column to the right', 'add'], ['delCol', 'Column', 'Delete', 'Delete this column', 'del'],
  ['alignLeft', 'Align', 'Left', 'Align column left', 'neutral'], ['alignCenter', 'Align', 'Center', 'Centre column', 'neutral'], ['alignRight', 'Align', 'Right', 'Align column right', 'neutral'], ['alignNone', 'Align', 'Reset', 'Default alignment', 'neutral'],
];
const MENU_LABEL: Record<string, string> = { rowAbove: 'Add row above', rowBelow: 'Add row below', delRow: 'Delete row', colLeft: 'Add column left', colRight: 'Add column right', delCol: 'Delete column', alignLeft: 'Align left', alignCenter: 'Align centre', alignRight: 'Align right', alignNone: 'Default alignment' };

interface TableCtx { d: HTMLElement; view: EditorView; cell: HTMLElement }
let ctx: TableCtx | null = null;
let barEl: HTMLElement | null = null;
let menuEl: HTMLElement | null = null;

function ensureTableChrome(): void {
  if (barEl && barEl.isConnected) return;
  barEl = document.createElement('div'); barEl.className = 'lm-floatbar'; barEl.hidden = true;
  let group = '', gEl: HTMLElement | null = null;
  for (const [op, g, label, tip, kind] of CTL) {
    if (g !== group) {
      group = g; gEl = document.createElement('div'); gEl.className = 'lm-fbgroup';
      const t = document.createElement('span'); t.className = 'lm-fbtitle'; t.textContent = g; gEl.appendChild(t); barEl.appendChild(gEl);
    }
    const b = document.createElement('button'); b.type = 'button'; b.dataset.op = op; b.className = 'lm-fb lm-k-' + kind; setTip(b, tip);
    b.innerHTML = ICON[op] + `<span>${label}</span>`;
    gEl!.appendChild(b);
  }
  barEl.addEventListener('mousedown', (e) => e.preventDefault());
  barEl.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button'); if (!b || !ctx) return;
    runOp(b.dataset.op!);
  });
  document.body.appendChild(barEl);
  const re = (): void => { placeBar(); hideMenu(); };
  window.addEventListener('scroll', re, true);
  window.addEventListener('resize', re);
  document.addEventListener('mousedown', (e) => { if (menuEl && !menuEl.contains(e.target as Node)) hideMenu(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); }, true);
}

function runOp(op: string): void {
  if (!ctx) return;
  hideMenu();
  tableOp(ctx.view, ctx.d, op, Number(ctx.cell.dataset.r), Number(ctx.cell.dataset.c));
  requestAnimationFrame(placeBar);
}

function hideBar(): void { if (barEl) barEl.hidden = true; }
/**
 * Puts the bar above the table (below it when there is no room), so it never covers a row: a click on a cell in any row,
 * including the one above the active cell, always reaches that cell. Only when the table fills the whole view does the bar
 * sit at the top or bottom edge of the view, on the side away from the active row.
 */
function placeBar(): void {
  if (!barEl) return;
  if (!ctx || !ctx.cell.isConnected || !ctx.d.contains(document.activeElement)) { hideBar(); return; }
  const row = ctx.cell.parentElement!.getBoundingClientRect();
  const topLimit = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lm-tbh')) || 40;
  if (row.bottom < topLimit || row.top > window.innerHeight) { hideBar(); return; }
  barEl.hidden = false;
  barEl.style.maxWidth = `${window.innerWidth - 16}px`;
  const bw = barEl.offsetWidth, bh = barEl.offsetHeight, gap = 6;
  const tr = ctx.d.querySelector('table')!.getBoundingClientRect();
  const minTop = topLimit + 2, maxTop = window.innerHeight - bh - 2;
  let top = tr.top - bh - gap;
  if (top < minTop) {
    top = tr.bottom + gap;
    if (top > maxTop) top = row.top - minTop > maxTop - row.top ? minTop : maxTop; // the farther edge from the active row
  }
  const left = Math.max(8, Math.min(tr.left, window.innerWidth - bw - 8));
  barEl.style.top = `${Math.round(top)}px`; barEl.style.left = `${Math.round(left)}px`;
}

function hideMenu(): void { if (menuEl) { menuEl.remove(); menuEl = null; } }
function showMenu(x: number, y: number): void {
  hideMenu();
  const m = document.createElement('div'); m.className = 'lm-ctxmenu'; m.setAttribute('role', 'menu');
  let g = '';
  for (const [op, grp, , , kind] of CTL) {
    if (g && g !== grp) { const sp = document.createElement('div'); sp.className = 'lm-ctxsep'; m.appendChild(sp); }
    g = grp;
    const it = document.createElement('button'); it.type = 'button'; it.dataset.op = op; it.className = 'lm-ctxitem lm-k-' + kind; it.setAttribute('role', 'menuitem');
    it.innerHTML = ICON[op] + `<span>${MENU_LABEL[op]}</span>`;
    m.appendChild(it);
  }
  m.addEventListener('mousedown', (e) => e.preventDefault());
  m.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest('button'); if (b) runOp(b.dataset.op!); });
  document.body.appendChild(m); menuEl = m;
  m.style.left = `${Math.max(4, Math.min(x, window.innerWidth - m.offsetWidth - 4))}px`;
  m.style.top = `${Math.max(4, Math.min(y, window.innerHeight - m.offsetHeight - 4))}px`;
}

/** Positions the hover chip and the + handles against the table's edges. */
function placeHandles(d: HTMLElement): void {
  const t = d.querySelector('table') as HTMLElement | null; if (!t) return;
  const right = Math.min(t.offsetLeft + t.offsetWidth, d.clientWidth - 11);
  const hint = d.querySelector('.lm-tblhint') as HTMLElement | null, hr = d.querySelector('.lm-hrow') as HTMLElement | null, hc = d.querySelector('.lm-hcol') as HTMLElement | null;
  if (hint) { hint.style.top = `${t.offsetTop + 2}px`; hint.style.left = `${Math.max(0, t.offsetLeft + t.offsetWidth - hint.offsetWidth - 4)}px`; }
  if (hr) { hr.style.top = `${t.offsetTop + t.offsetHeight - 2}px`; hr.style.left = `${t.offsetLeft + t.offsetWidth / 2 - 11}px`; }
  if (hc) { hc.style.left = `${right - 9}px`; hc.style.top = `${t.offsetTop + t.offsetHeight / 2 - 11}px`; }
}

/**
 * Cell HTML: markdown-it with html off (so nothing unsafe gets through), then only exact, attribute-free formatting
 * tags (<br>, <b>, <i>, <u>, ...) and the canonical colour tags with a validated value are turned back into markup.
 */
const CELL_TAGS = 'b|strong|i|em|u|ins|s|del|strike|sub|sup|small|kbd|cite';
const HEX_RE = '#[0-9a-fA-F]{3,8}', RGBA_RE = 'rgba\\(\\d{1,3},\\d{1,3},\\d{1,3},(?:0|1|0?\\.\\d+|1\\.0+)\\)';
/** While a cell is edited it shows its source with each <br> as a real line break; saving turns them back into <br>. */
/** Set by a toolbar/shortcut format action in a cell, so that change is its own Undo step (like Word). */
let cellFormatPending = false;
export function markCellFormat(): void { cellFormatPending = true; }
// A trailing newline in an editable block is invisible unless doubled, and the browser adds that extra one itself
// when Enter is pressed at the end. So one final "\n" is never content: drop it on the way out, add it on the way in.
export const toEdit = (src: string): string => src.replace(/<br>/g, '\n') + (src.endsWith('<br>') ? '\n' : '');
export const fromEdit = (text: string): string => text.replace(/\r\n/g, '\n').replace(/\n$/, '').replace(/\n/g, '<br>');
function cellHtml(raw: string): string {
  return md.renderInline(raw)
    .replace(/&lt;br\s*\/?&gt;/gi, '<br>')
    .replace(new RegExp(`&lt;(/?)(${CELL_TAGS})&gt;`, 'gi'), '<$1$2>')
    .replace(new RegExp(`&lt;span style=&quot;color:(${HEX_RE})&quot;&gt;`, 'g'), '<span style="color:$1">')
    .replace(new RegExp(`&lt;mark style=&quot;background:(${RGBA_RE})&quot;&gt;`, 'g'), '<mark style="background:$1">')
    .replace(/&lt;\/(span|mark)&gt;/g, '</$1>');
}

/**
 * Double space in a cell: type the second space (so the cell really has the two spaces), then replace both with ". " as one
 * Undo step. Returns true when it handled the key. (A table keeps no trailing spaces, so Undo here takes the full stop back.)
 */
function cellDoubleSpace(el: HTMLElement): boolean {
  const sel = window.getSelection(); if (!sel || !sel.rangeCount) return false;
  const r = sel.getRangeAt(0); if (!r.collapsed || !el.contains(r.startContainer)) return false;
  const pre = document.createRange(); pre.selectNodeContents(el); pre.setEnd(r.startContainer, r.startOffset);
  const at = pre.toString().length; const text = el.textContent ?? '';
  const plan = cellPeriodPlan(text, at); if (!plan) return false;
  document.execCommand('insertText', false, ' ');
  const posAt = (offset: number): [Node, number] | null => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let t: Node | null; let left = offset;
    while ((t = w.nextNode())) { const len = (t as Text).data.length; if (left <= len) return [t, left]; left -= len; }
    return null;
  };
  const start = posAt(at - 1); const end = posAt(at + 1 + plan.eat);
  const now = window.getSelection(); if (!start || !end || !now) return true;
  const rg = document.createRange(); rg.setStart(start[0], start[1]); rg.setEnd(end[0], end[1]);
  now.removeAllRanges(); now.addRange(rg);
  markCellFormat(); document.execCommand('insertText', false, plan.text);
  return true;
}

function buildTable(d: HTMLElement, view: EditorView, text: string): void {
  const rows = parseTable(text.split('\n').map((t, i, all) => ({ from: all.slice(0, i).reduce((n, x) => n + x.length + 1, 0), text: t })));
  const old = d.querySelector('table'); if (old) old.remove();
  const table = document.createElement('table');
  const disp = displayRows(rows);
  disp.forEach((row, r) => {
    const tr = document.createElement('tr');
    row.cells.forEach((cell, c) => {
      const el = document.createElement(r === 0 ? 'th' : 'td');
      const raw = row.text.slice(cell.cFrom - row.from, cell.cTo - row.from);
      el.contentEditable = 'plaintext-only';
      el.dataset.r = String(r); el.dataset.c = String(c); el.dataset.src = unescapeCell(raw);
      el.innerHTML = cellHtml(raw);
      const al = alignOf(rows[1], (x) => rows[1].text.slice(x.cFrom - rows[1].from, x.cTo - rows[1].from), c);
      el.style.textAlign = ALIGN_CSS[al];
      el.spellcheck = false;
      tr.appendChild(el);
    });
    (r === 0 ? (table.tHead ?? table.createTHead()) : (table.tBodies[0] ?? table.createTBody())).appendChild(tr);
  });
  d.appendChild(table);
}

function focusCell(d: HTMLElement, r: number, c: number): void {
  const rowsEl = [...d.querySelectorAll('tr')];
  const tr = rowsEl[Math.min(r, rowsEl.length - 1)];
  const cells = tr ? [...tr.children] as HTMLElement[] : [];
  const el = cells[Math.min(c, cells.length - 1)];
  if (!el) return;
  el.focus();
  const sel = window.getSelection(); const rg = document.createRange(); rg.selectNodeContents(el); rg.collapse(false); sel?.removeAllRanges(); sel?.addRange(rg);
}

function tableOp(view: EditorView, d: HTMLElement, op: string, r: number, c: number): void {
  const t = tableAt(view, d); if (!t) return;
  const rows = t.rows; let changes: ChangeSpecLike[] = []; let focus: [number, number] = [r, c];
  const one = (x: ChangeSpecLike | null) => { if (x) changes = [x]; };
  switch (op) {
    case 'rowAbove': one(addRow(rows, r, 'above')); focus = [r + 1, c]; break;
    case 'rowBelow': one(addRow(rows, r, 'below')); focus = [r + 1, c]; break;
    case 'delRow': one(deleteRow(rows, r)); focus = [Math.max(0, r - 1), c]; break;
    case 'colLeft': changes = addColumn(rows, c, 'left'); focus = [r, c + 1]; break;
    case 'colRight': changes = addColumn(rows, c, 'right'); break;
    case 'delCol': changes = deleteColumn(rows, c) ?? []; focus = [r, Math.max(0, c - 1)]; break;
    default: if (op.startsWith('align')) one(setAlign(rows, c, op.slice(5).toLowerCase() as Align));
  }
  if (!changes.length) return;
  view.dispatch({ changes, userEvent: 'input.table' });
  focusCell(d, focus[0], focus[1]);
}
type ChangeSpecLike = ChangeSpec;

/** Runs a list edit on the cell's text and selection (true = it did something). One insertText, so the cell commits once and Undo is one step. */
function cellListEdit(el: HTMLElement, fn: (text: string, a: number, b: number) => CellEdit | null): boolean {
  const sel = window.getSelection(); if (!sel || !sel.rangeCount) return false;
  const r = sel.getRangeAt(0); if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return false;
  const pre = document.createRange(); pre.selectNodeContents(el); pre.setEnd(r.startContainer, r.startOffset);
  const a = pre.toString().length, b = a + r.toString().length;
  const text = el.textContent ?? '';
  const ed = fn(text, a, b); if (!ed) return false;
  const at = (n: number): [Node, number] => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let t: Node | null; let left = n; let last: Node | null = null;
    while ((t = w.nextNode())) { const len = (t as Text).data.length; if (left <= len) return [t, left]; left -= len; last = t; }
    return last ? [last, (last as Text).data.length] : [el, 0];
  };
  const [sn, so] = at(ed.from), [en, eo] = at(ed.to);
  const rg = document.createRange(); rg.setStart(sn, so); rg.setEnd(en, eo); sel.removeAllRanges(); sel.addRange(rg);
  if (ed.insert === '') document.execCommand('delete'); else document.execCommand('insertText', false, ed.insert);
  const [cn, co] = at(ed.caret); const c = document.createRange(); c.setStart(cn, co); c.collapse(true); sel.removeAllRanges(); sel.addRange(c);
  return true;
}

function wireTable(d: HTMLElement, view: EditorView): void {
  const cellOf = (e: Event): HTMLElement | null => (e.target as HTMLElement).closest?.('td,th') as HTMLElement | null;
  d.addEventListener('focusin', (e) => {
    const el = cellOf(e); if (!el) return;
    if (el.dataset.editing !== '1') { el.dataset.editing = '1'; el.textContent = toEdit(el.dataset.src ?? ''); }
  });
  d.addEventListener('focusout', (e) => {
    const el = cellOf(e); if (!el) return;
    delete el.dataset.editing;
    el.innerHTML = cellHtml(escapeCell(fromEdit(el.textContent ?? '')).trim());
  });
  // Writes the cell's text into its source range. Not while an IME composition is in progress: the text is
  // committed once, on compositionend.
  const commit = (el: HTMLElement): void => {
    const t = tableAt(view, d); if (!t) return;
    const row = t.rows[rowIndex(Number(el.dataset.r))]; const cell = row?.cells[Number(el.dataset.c)];
    if (!cell) return;
    const next = escapeCell(fromEdit(el.textContent ?? '')).trim();
    el.dataset.src = unescapeCell(next);
    const after = view.state.sliceDoc(cell.cTo, cell.cTo + 1);
    const guard = endsWithBackslash(next) && !/\s/.test(after) ? ' ' : ''; // keep the closing pipe unescaped
    if (view.state.sliceDoc(cell.cFrom, cell.cTo) === next && !guard) return;
    const fmt = cellFormatPending; cellFormatPending = false;
    view.dispatch({ changes: { from: cell.cFrom, to: cell.cTo, insert: next + guard }, userEvent: fmt ? 'input.format' : 'input.type', ...(fmt ? { annotations: isolateHistory.of('full') } : {}) });
  };
  d.addEventListener('input', (e) => {
    const el = cellOf(e); if (!el || (e as InputEvent).isComposing) return;
    commit(el);
  });
  d.addEventListener('compositionend', (e) => { const el = cellOf(e); if (el) commit(el); });
  d.addEventListener('beforeinput', (e) => {
    const ie = e as InputEvent;
    if (ie.inputType === 'historyUndo') { e.preventDefault(); hooks.undo(); } else if (ie.inputType === 'historyRedo') { e.preventDefault(); hooks.redo(); }
    else if (ie.inputType === 'insertText' && ie.data === ' ' && !ie.isComposing && doubleSpaceOn()) { const el = cellOf(e); if (el && cellDoubleSpace(el)) e.preventDefault(); }
  });
  d.addEventListener('keydown', (e) => {
    const el = cellOf(e); if (!el) return;
    if (e.isComposing || e.keyCode === 229) return; // an IME is using this key (Enter confirms a candidate)
    const r = Number(el.dataset.r), c = Number(el.dataset.c);
    const all = [...d.querySelectorAll('td,th')] as HTMLElement[];
    const idx = all.indexOf(el);
    const nrows = d.querySelectorAll('tr').length;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); (e.shiftKey ? hooks.redo : hooks.undo)(); return; }
    if (mod && !e.altKey && e.key.toLowerCase() === 'y') { e.preventDefault(); e.stopPropagation(); hooks.redo(); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) { if (idx > 0) focusCell(d, Number(all[idx - 1].dataset.r), Number(all[idx - 1].dataset.c)); }
      else if (idx < all.length - 1) focusCell(d, Number(all[idx + 1].dataset.r), Number(all[idx + 1].dataset.c));
      else tableOp(view, d, 'rowBelow', r, 0);
    } else if (e.key === 'Enter' && !mod) {
      // A Markdown table row is one line, so a line break inside a cell is written as <br>.
      e.preventDefault();
      if (!cellListEdit(el, cellEnter)) document.execCommand('insertText', false, '\n'); // shown as a new line while editing, saved as <br>
    } else if (e.key === 'Enter') { // Cmd/Ctrl+Enter: next row (a new row from the last one)
      e.preventDefault();
      if (r === nrows - 1) tableOp(view, d, 'rowBelow', r, c); else focusCell(d, r + 1, c);
    } else if (e.key === 'Backspace' && !mod && !e.altKey && !e.shiftKey && cellListEdit(el, cellBackspace)) { e.preventDefault(); }
    else if (e.key === 'Escape') { e.preventDefault(); view.focus(); }
    else if (e.key === 'ArrowUp' && r === 0) {
      const t = tableAt(view, d);
      if (t && t.from > 0) { e.preventDefault(); view.dispatch({ selection: { anchor: t.from - 1 } }); view.focus(); }
    } else if (e.key === 'ArrowDown' && r === nrows - 1) {
      const t = tableAt(view, d);
      if (t && t.to < view.state.doc.length) { e.preventDefault(); view.dispatch({ selection: { anchor: t.to + 1 } }); view.focus(); }
    }
  });
  ensureTableChrome();
  const activate = (el: HTMLElement): void => { ctx = { d, view, cell: el }; placeBar(); };
  d.addEventListener('focusin', (e) => { const el = cellOf(e); if (el) activate(el); });
  d.addEventListener('focusout', () => setTimeout(() => { if (ctx?.d === d && !d.contains(document.activeElement)) hideBar(); }, 0));
  d.addEventListener('contextmenu', (e) => {
    const el = cellOf(e); if (!el) return;
    e.preventDefault(); el.focus(); activate(el); showMenu(e.clientX, e.clientY);
  });
  d.addEventListener('mouseenter', () => placeHandles(d));
  d.addEventListener('mousedown', (e) => { if ((e.target as HTMLElement).closest('.lm-tblhint,.lm-tblhandle')) e.preventDefault(); });
  d.addEventListener('click', (e) => {
    const h = (e.target as HTMLElement).closest('.lm-tblhandle,.lm-tblhint') as HTMLElement | null; if (!h) return;
    const cells = [...d.querySelectorAll('td,th')] as HTMLElement[]; if (!cells.length) return;
    const lastRow = Number(cells[cells.length - 1].dataset.r), lastCol = Math.max(...cells.map((x) => Number(x.dataset.c)));
    if (h.classList.contains('lm-tblhint')) { const first = cells[0]; first.focus(); showMenuAt(h); return; }
    tableOp(view, d, h.dataset.op!, lastRow, lastCol);
    requestAnimationFrame(() => placeHandles(d));
  });
}
function showMenuAt(h: HTMLElement): void { const r = h.getBoundingClientRect(); showMenu(r.left, r.bottom + 2); }

class TableWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(o: TableWidget): boolean { return o.text === this.text; }
  get estimatedHeight(): number { return this.text.split('\n').length * 34 + 16; }
  toDOM(view: EditorView): HTMLElement {
    const d = document.createElement('div');
    d.className = 'lm-tablewrap';
    d.contentEditable = 'false';
    const hint = document.createElement('button'); hint.type = 'button'; hint.className = 'lm-tblhint'; hint.textContent = 'Edit table \u22EF'; setTip(hint, 'Table actions: add or delete rows and columns, alignment');
    const hr = document.createElement('button'); hr.type = 'button'; hr.className = 'lm-tblhandle lm-hrow'; hr.dataset.op = 'rowBelow'; setTip(hr, 'Add row at the end'); hr.textContent = '+';
    const hc = document.createElement('button'); hc.type = 'button'; hc.className = 'lm-tblhandle lm-hcol'; hc.dataset.op = 'colRight'; setTip(hc, 'Add column at the end'); hc.textContent = '+';
    d.append(hint, hr, hc);
    buildTable(d, view, this.text);
    wireTable(d, view);
    requestAnimationFrame(() => placeHandles(d));
    return d;
  }
  /** Same widget, new text (usually the user's own typing): keep the DOM so the caret stays where it is. */
  updateDOM(d: HTMLElement, view: EditorView): boolean {
    const rows = parseTable(this.text.split('\n').map((t, i, all) => ({ from: all.slice(0, i).reduce((n, x) => n + x.length + 1, 0), text: t })));
    const disp = displayRows(rows);
    const trs = [...d.querySelectorAll('tr')];
    const same = trs.length === disp.length && trs.every((tr, i) => tr.children.length === disp[i].cells.length);
    if (!same) { buildTable(d, view, this.text); requestAnimationFrame(() => { placeHandles(d); placeBar(); }); return true; }
    disp.forEach((row, r) => row.cells.forEach((cell, c) => {
      const el = trs[r].children[c] as HTMLElement;
      const raw = row.text.slice(cell.cFrom - row.from, cell.cTo - row.from);
      const src = unescapeCell(raw);
      const al = alignOf(rows[1], (x) => rows[1].text.slice(x.cFrom - rows[1].from, x.cTo - rows[1].from), c);
      el.style.textAlign = ALIGN_CSS[al];
      if (el.dataset.editing === '1') { if (fromEdit(el.textContent ?? '').trim() !== src) { el.textContent = toEdit(src); el.dataset.src = src; } return; }
      if (el.dataset.src !== src) { el.dataset.src = src; el.innerHTML = cellHtml(raw); }
    }));
    requestAnimationFrame(() => { placeHandles(d); placeBar(); });
    return true;
  }
  ignoreEvent(): boolean { return true; }
}

/** Language label + Copy button, drawn over the top-right corner of a fenced code block (absolutely positioned, takes no layout space). */
class CodeBarWidget extends WidgetType {
  constructor(readonly lang: string, readonly code: string) { super(); }
  eq(o: CodeBarWidget): boolean { return o.lang === this.lang && o.code === this.code; }
  toDOM(): HTMLElement {
    const d = document.createElement('span'); d.className = 'lm-codebar'; d.contentEditable = 'false';
    if (this.lang) { const l = document.createElement('span'); l.className = 'lm-codelang'; l.textContent = this.lang; d.appendChild(l); }
    const b = document.createElement('button'); b.type = 'button'; b.className = 'lm-codecopy'; b.textContent = 'Copy'; setTip(b, 'Copy code to the clipboard');
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const done = (): void => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1500); };
      const fallback = (): void => { const ta = document.createElement('textarea'); ta.value = this.code; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch { /* ignore */ } ta.remove(); done(); };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(this.code).then(done, fallback); else fallback();
    });
    d.appendChild(b);
    return d;
  }
  ignoreEvent(): boolean { return true; }
}

class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string) { super(); }
  eq(o: ImageWidget): boolean { return o.src === this.src && o.alt === this.alt; }
  get estimatedHeight(): number { return 220; }
  toDOM(view: EditorView): HTMLElement {
    const d = document.createElement('div');
    d.className = 'lm-imgwrap';
    const img = document.createElement('img');
    img.alt = this.alt; img.src = resolveSrc(this.src);
    img.addEventListener('load', () => view.requestMeasure());
    img.addEventListener('error', () => { d.textContent = `[image not found: ${this.alt || this.src}]`; d.classList.add('lm-imgmissing'); view.requestMeasure(); });
    d.appendChild(img);
    return d;
  }
}

class FrontMatterWidget extends WidgetType {
  eq(): boolean { return true; }
  get estimatedHeight(): number { return 30; }
  toDOM(): HTMLElement { const d = document.createElement('div'); d.className = 'lm-fm-widget'; d.textContent = 'Front matter'; return d; }
  ignoreEvent(): boolean { return false; }
}

const HIDE = Decoration.replace({});
const SIMPLE_TAG_STYLE: Record<string, string> = {
  b: 'font-weight:bold', strong: 'font-weight:bold', i: 'font-style:italic', em: 'font-style:italic', cite: 'font-style:italic',
  u: 'text-decoration:underline', ins: 'text-decoration:underline', s: 'text-decoration:line-through', del: 'text-decoration:line-through', strike: 'text-decoration:line-through',
  sub: 'vertical-align:sub;font-size:.8em', sup: 'vertical-align:super;font-size:.8em', small: 'font-size:.85em',
  kbd: 'font-family:var(--lm-mono,monospace);font-size:.85em;padding:0 4px;border:1px solid color-mix(in srgb,currentColor 35%,transparent);border-radius:3px',
};
type Span = { from: number; to: number };
/** Matching <tag>…</tag> pairs (no attributes, case-insensitive) within one paragraph, properly nested per tag name. */
export function findSimpleTagPairs(text: string): Array<{ tag: string; open: Span; close: Span }> {
  const out: Array<{ tag: string; open: Span; close: Span }> = [];
  const stacks = new Map<string, Span[]>();
  const re = /<(\/?)([a-zA-Z]+)>/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const tag = m[2].toLowerCase();
    if (!(tag in SIMPLE_TAG_STYLE)) continue;
    const span = { from: m.index, to: m.index + m[0].length };
    const st = stacks.get(tag) ?? []; stacks.set(tag, st);
    if (!m[1]) { st.push(span); continue; }
    const o = st.pop();
    if (!o || /\n[ \t]*\n/.test(text.slice(o.to, span.from))) continue;
    out.push({ tag, open: o, close: span });
  }
  return out;
}

const markDeco = (cls: string) => Decoration.mark({ class: cls });
const M = { strong: markDeco('cm-lm-strong'), em: markDeco('cm-lm-em'), del: markDeco('cm-lm-del'), code: markDeco('cm-lm-code'), link: markDeco('cm-lm-link'), raw: markDeco('cm-lm-mark') };

interface LineInfo { cls: Set<string>; style?: string }

function build(state: EditorState): DecorationSet {
  const doc = state.doc;
  const tree = ensureSyntaxTree(state, doc.length, 100) ?? syntaxTree(state);
  const out: Array<Range<Decoration>> = [];
  const lines = new Map<number, LineInfo>();
  const covered = new Set<number>(); // lines that are not "blank" paragraph separators
  const sel = state.selection.ranges;
  const activeLines = new Set<number>();
  for (const r of sel) { const a = doc.lineAt(r.from).number, b = doc.lineAt(r.to).number; for (let i = a; i <= b; i++) activeLines.add(i); }
  const touches = (from: number, to: number) => sel.some((r) => r.from <= to && r.to >= from);
  const spanActive = (from: number, to: number) => touches(doc.lineAt(from).from, doc.lineAt(to).to);
  const addLine = (n: number, ...cls: string[]) => { let l = lines.get(n); if (!l) lines.set(n, (l = { cls: new Set() })); cls.forEach((c) => l!.cls.add(c)); return l; };
  const blockLines = (from: number, to: number, cls: string, edges: boolean) => {
    const a = doc.lineAt(from).number, b = doc.lineAt(to).number;
    for (let i = a; i <= b; i++) { addLine(i, cls, 'lm-blk'); covered.add(i); }
    if (edges) { addLine(a, 'lm-first'); addLine(b, 'lm-last'); }
  };
  const hide = (from: number, to: number) => { if (to > from) out.push(HIDE.range(from, to)); };
  const hideWithSpace = (from: number, to: number) => hide(from, doc.sliceString(to, to + 1) === ' ' ? to + 1 : to);

  const fm = frontMatter(doc);
  if (fm) {
    for (let i = 1; i <= fm.lastLine; i++) covered.add(i);
    if (touches(0, fm.to)) for (let i = 1; i <= fm.lastLine; i++) addLine(i, 'lm-fm');
    else out.push(Decoration.replace({ widget: new FrontMatterWidget(), block: true }).range(0, fm.to));
  }

  let mermaidIdx = 0;
  const tagRanges = new Set<string>();
  const hang = new Map<number, { W: string; pad: number; quoted: boolean; markerLine: number }>(); // per list item, filled when its marker is visited
  const depthOf = (n: SyntaxNodeRef): number => { let d = -1; for (let p = n.node.parent; p; p = p.parent) if (p.name === 'BulletList' || p.name === 'OrderedList') d++; return d; };

  tree.iterate({
    enter(node) {
      const { name, from, to } = node;
      if (fm && name !== 'Document' && from < fm.to) return false;
      const parent = node.node.parent?.name;
      switch (name) {
        case 'HTMLTag': tagRanges.add(from + ':' + to); break;
        case 'Paragraph':
          if (parent === 'Document') blockLines(from, to, 'lm-p', true);
          else if (parent === 'ListItem' || parent === 'Task') {
            blockLines(from, to, 'lm-li', false);
            // Lines of the item's text that are not the marker line (hard-wrapped text, further paragraphs) hang like the item's own text.
            const item = parent === 'Task' ? node.node.parent?.parent : node.node.parent;
            const h = item ? hang.get(item.from) : undefined;
            if (h) {
              for (let i = doc.lineAt(from).number; i <= doc.lineAt(to).number; i++) {
                if (i === h.markerLine) continue;
                const cl = doc.line(i);
                const q = h.quoted ? /^(?:[ \t]*>[ \t]?)*/.exec(cl.text)![0].length : 0; // the quote marks in front of the line
                const ws = /^[ \t]*/.exec(cl.text.slice(q))![0].length;
                const P = `calc(${h.pad}em + ${h.W})`;
                const info = addLine(i);
                if (activeLines.has(i)) {
                  if (h.quoted) { // the raw "> " marks and the spaces form one box, so the text still lines up with the item's text
                    const qd = (cl.text.slice(0, q).match(/>/g) ?? []).length; const box = `calc(${qd * 1.1 + h.pad}em + ${h.W})`;
                    info.style = `padding-left:${box};text-indent:calc(-1 * ${box})`;
                    if (q + ws) out.push(Decoration.mark({ class: 'lm-wsbox', attributes: { style: `width:${box}` } }).range(cl.from, cl.from + q + ws));
                  } else {
                    info.style = `padding-left:${P};text-indent:calc(-1 * ${P})`;
                    if (ws) out.push(Decoration.mark({ class: 'lm-wsbox', attributes: { style: `width:${P}` } }).range(cl.from, cl.from + ws));
                  }
                } else { info.style = `padding-left:${P}`; hide(cl.from + q, cl.from + q + ws); }
              }
            }
          }
          else if (parent === 'Blockquote') blockLines(from, to, 'lm-quote', false);
          break;
        case 'ATXHeading1': case 'ATXHeading2': case 'ATXHeading3': case 'ATXHeading4': case 'ATXHeading5': case 'ATXHeading6': {
          const ln = doc.lineAt(from);
          addLine(ln.number, 'lm-h' + name.slice(-1), 'lm-blk', 'lm-first', 'lm-last'); covered.add(ln.number);
          if (!spanActive(from, to)) {
            for (const m of node.node.getChildren('HeaderMark')) {
              if (doc.sliceString(ln.from, m.from).trim() === '') hideWithSpace(m.from, m.to);
              else { let s = m.from; while (s > ln.from && /\s/.test(doc.sliceString(s - 1, s))) s--; hide(s, m.to); }
            }
          } else for (const m of node.node.getChildren('HeaderMark')) out.push(M.raw.range(m.from, m.to));
          break;
        }
        case 'SetextHeading1': case 'SetextHeading2': {
          const a = doc.lineAt(from).number, b = doc.lineAt(to).number;
          for (let i = a; i <= b; i++) { covered.add(i); if (i < b) addLine(i, 'lm-h' + name.slice(-1), 'lm-blk'); }
          addLine(a, 'lm-first'); addLine(b - 1 >= a ? b - 1 : a, 'lm-last');
          if (b > a) { if (!spanActive(from, to)) addLine(b, 'lm-hidden'); else addLine(b, 'lm-h' + name.slice(-1)); }
          break;
        }
        case 'FencedCode': case 'CodeBlock': {
          const a = doc.lineAt(from).number, b = doc.lineAt(to).number;
          for (let i = a; i <= b; i++) covered.add(i);
          const fenced = name === 'FencedCode';
          const closed = fenced && node.node.getChildren('CodeMark').length >= 2;
          const info = node.node.getChild('CodeInfo');
          if (closed && parent === 'Document' && info && doc.sliceString(info.from, info.to).trim().toLowerCase() === 'mermaid') {
            const key = mermaidIdx++;
            const code = b - a >= 2 ? doc.sliceString(doc.line(a + 1).from, doc.line(b - 1).to) : '';
            if (!touches(from, to)) { out.push(Decoration.replace({ widget: new MermaidWidget(code, key, false), block: true }).range(from, to)); return false; }
            out.push(Decoration.widget({ widget: new MermaidWidget(code, key, true), block: true, side: 1 }).range(to));
          }
          const collapsed = fenced && !touches(from, to);
          const s = collapsed ? a + 1 : a, e = collapsed ? (closed ? b - 1 : b) : b;
          if (collapsed) { addLine(a, 'lm-hidden'); if (closed) addLine(b, 'lm-hidden'); }
          for (let i = s; i <= e; i++) addLine(i, 'lm-pre', 'lm-blk');
          if (s <= e && parent === 'Document') { addLine(s, 'lm-first'); addLine(e, 'lm-last'); }
          if (s <= e) { addLine(s, 'lm-codetop'); addLine(e, 'lm-codebot'); }
          if (fenced && collapsed && closed && b - a >= 2) {
            const lang = info ? doc.sliceString(info.from, info.to).trim().split(/\s+/)[0] : '';
            out.push(Decoration.widget({ widget: new CodeBarWidget(lang, doc.sliceString(doc.line(a + 1).from, doc.line(b - 1).to)), side: -1 }).range(doc.line(s).from));
          }
          if (fenced && !collapsed) for (const m of node.node.getChildren('CodeMark')) out.push(M.raw.range(m.from, m.to));
          return false;
        }
        case 'HTMLBlock': case 'CommentBlock': case 'ProcessingInstructionBlock': {
          for (let i = doc.lineAt(from).number; i <= doc.lineAt(to).number; i++) covered.add(i);
          return false;
        }
        case 'Table': {
          const a = doc.lineAt(from).number, b = doc.lineAt(to).number;
          for (let i = a; i <= b; i++) covered.add(i);
          if (parent === 'Document') out.push(Decoration.replace({ widget: new TableWidget(doc.sliceString(from, to)), block: true }).range(from, to));
          else for (let i = a; i <= b; i++) addLine(i, 'lm-tableraw');
          return false;
        }
        case 'HorizontalRule': {
          const ln = doc.lineAt(from);
          addLine(ln.number, 'lm-hr', 'lm-blk', 'lm-first', 'lm-last'); covered.add(ln.number);
          if (!spanActive(from, to)) hide(from, to); else addLine(ln.number, 'lm-active');
          break;
        }
        case 'Blockquote': {
          blockLines(from, to, 'lm-quote', parent === 'Document');
          break;
        }
        case 'QuoteMark':
          if (!spanActive(from, to)) hideWithSpace(from, to); else out.push(M.raw.range(from, to));
          break;
        case 'BulletList': case 'OrderedList':
          if (parent === 'Document') { const b = doc.lineAt(to).number; addLine(b, 'lm-last'); }
          break;
        case 'ListItem': {
          const mark = node.node.getChild('ListMark');
          if (!mark) break;
          const ln = doc.lineAt(mark.from);
          covered.add(ln.number);
          addLine(ln.number, 'lm-li', 'lm-blk');
          const active = spanActive(mark.from, mark.from);
          const level = Math.max(0, depthOf(node));
          const task = node.node.getChild('Task')?.getChild('TaskMarker') ?? null;
          const markerText = doc.sliceString(mark.from, mark.to);
          const bullet = /^[-*+]$/.test(markerText);
          const lead = doc.sliceString(ln.from, mark.from);
          const plain = lead.trim() === ''; // not inside a quote
          const skipWs = (p: number) => { while (p < ln.to && /[ \t]/.test(doc.sliceString(p, p + 1))) p++; return p; };
          const gapEnd = skipWs(mark.to); // marker plus the spaces after it form one box of fixed width, so wrapped lines can hang under the text
          const digits = markerText.length - 1;
          // Width of that box: the same in every theme, and for the same kind of item at every nesting level.
          const W = task ? (active ? (bullet ? '2.4em' : `calc(${digits + 1}ch + 2.2em)`) : '1.4em') : bullet ? '1.4em' : `calc(${digits + 1}ch + .5em)`;
          const pad = level * 1.6;
          hang.set(node.from, { W, pad, quoted: !plain, markerLine: ln.number });
          if (plain) {
            const li = addLine(ln.number);
            if (!active) {
              if (lead.length) hide(ln.from, mark.from);
              li.style = `padding-left:calc(${pad}em + ${W});text-indent:calc(-1 * ${W})`;
            } else {
              const P = `calc(${pad}em + ${W})`;
              li.style = `padding-left:${P};text-indent:calc(-1 * ${P})`;
              if (lead.length) out.push(Decoration.mark({ class: 'lm-wsbox', attributes: { style: `width:${pad}em` } }).range(ln.from, mark.from));
            }
          } else { // inside a quote: the same hanging indent (a quote line has no padding of its own)
            const li = addLine(ln.number);
            const q = /^(?:[ \t]*>[ \t]?)*/.exec(lead)![0].length; const qd = (lead.slice(0, q).match(/>/g) ?? []).length;
            if (!active) {
              if (q < lead.length) hide(ln.from + q, mark.from);
              li.style = `padding-left:calc(${pad}em + ${W});text-indent:calc(-1 * ${W})`;
            } else {
              const box = `${qd * 1.1 + pad}em`; const P = `calc(${box} + ${W})`;
              li.style = `padding-left:${P};text-indent:calc(-1 * ${P})`;
              out.push(Decoration.mark({ class: 'lm-wsbox', attributes: { style: `width:${box}` } }).range(ln.from, mark.from));
            }
          }
          if (!active && task) {
            const checked = /[xX]/.test(doc.sliceString(task.from, task.to));
            out.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(mark.from, skipWs(task.to)));
          } else if (!active && bullet) out.push(Decoration.replace({ widget: new BulletWidget(level) }).range(mark.from, gapEnd));
          else if (task) out.push(Decoration.mark({ class: 'cm-lm-mark lm-mbox', attributes: { style: `width:${W}` } }).range(mark.from, skipWs(task.to)));
          else if (active) out.push(Decoration.mark({ class: 'cm-lm-mark lm-mbox', attributes: { style: `width:${W}` } }).range(mark.from, gapEnd));
          else if (gapEnd > mark.from) out.push(Decoration.mark({ class: 'lm-mbox', attributes: { style: `width:${W}` } }).range(mark.from, gapEnd));
          break;
        }
        case 'StrongEmphasis': case 'Emphasis': case 'Strikethrough': case 'InlineCode': {
          out.push((name === 'StrongEmphasis' ? M.strong : name === 'Emphasis' ? M.em : name === 'Strikethrough' ? M.del : M.code).range(from, to));
          const active = spanActive(from, to);
          for (const m of node.node.getChildren(name === 'InlineCode' ? 'CodeMark' : name === 'Strikethrough' ? 'StrikethroughMark' : 'EmphasisMark')) {
            if (active) out.push(M.raw.range(m.from, m.to)); else hide(m.from, m.to);
          }
          break;
        }
        case 'Link': {
          const marks = node.node.getChildren('LinkMark');
          if (marks.length < 2) break;
          const active = spanActive(from, to);
          if (marks[1].from > marks[0].to) out.push(M.link.range(marks[0].to, marks[1].from));
          if (active) { out.push(M.raw.range(marks[0].from, marks[0].to)); out.push(M.raw.range(marks[1].from, to)); }
          else { hide(marks[0].from, marks[0].to); hide(marks[1].from, to); }
          break;
        }
        case 'Autolink': {
          const active = spanActive(from, to);
          for (const m of node.node.getChildren('LinkMark')) { if (active) out.push(M.raw.range(m.from, m.to)); else hide(m.from, m.to); }
          break;
        }
        case 'URL':
          if (parent !== 'Link' && parent !== 'Image') out.push(M.link.range(from, to));
          break;
        case 'Image': {
          const url = node.node.getChild('URL');
          const marks = node.node.getChildren('LinkMark');
          const ln = doc.lineAt(to);
          if (url) {
            const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : '';
            out.push(Decoration.widget({ widget: new ImageWidget(doc.sliceString(url.from, url.to).replace(/^<|>$/g, ''), alt), block: true, side: 1 }).range(ln.to));
          }
          if (!spanActive(from, to)) {
            hide(from, to);
            const first = doc.lineAt(from);
            if (first.number === ln.number && doc.sliceString(first.from, from).trim() === '' && doc.sliceString(to, first.to).trim() === '') addLine(first.number, 'lm-hidden');
          } else out.push(M.raw.range(from, to));
          return false;
        }
      }
      return undefined;
    },
  });

  if (tagRanges.size) {
    for (const p of findColourPairs(doc.toString())) {
      if (!tagRanges.has(p.open.from + ':' + p.open.to) || !tagRanges.has(p.close.from + ':' + p.close.to)) continue;
      const style = p.kind === 'text' ? `color:${p.value}` : `background:${p.value};border-radius:2px`;
      if (p.close.from > p.open.to) out.push(Decoration.mark({ attributes: { style }, class: 'cm-lm-colour' }).range(p.open.to, p.close.from));
      if (touches(p.open.from, p.close.to)) { out.push(M.raw.range(p.open.from, p.open.to)); out.push(M.raw.range(p.close.from, p.close.to)); }
      else { hide(p.open.from, p.open.to); hide(p.close.from, p.close.to); }
    }
  }

  {
    // Plain inline HTML formatting tags (<b>, <i>, <u>, ...): show the formatting and hide the tags, like the colour tags.
    // A tag at the start of a line parses as an HTML block, not an HTMLTag, so check "not inside code" instead.
    const tree = syntaxTree(state);
    const inCode = (pos: number) => { for (let n: SyntaxNode | null = tree.resolveInner(pos, 1); n; n = n.parent) if (/^(InlineCode|FencedCode|CodeBlock|CodeText|Comment)/.test(n.name)) return true; return false; };
    for (const p of findSimpleTagPairs(doc.toString())) {
      if (inCode(p.open.from) || inCode(p.close.from)) continue;
      if (p.close.from > p.open.to) out.push(Decoration.mark({ attributes: { style: SIMPLE_TAG_STYLE[p.tag] } }).range(p.open.to, p.close.from));
      if (touches(p.open.from, p.close.to)) { out.push(M.raw.range(p.open.from, p.open.to)); out.push(M.raw.range(p.close.from, p.close.to)); }
      else { hide(p.open.from, p.open.to); hide(p.close.from, p.close.to); }
    }
  }

  for (let i = 1; i <= doc.lines; i++) {
    if (!covered.has(i) && doc.line(i).text.trim() === '') { addLine(i, 'lm-blank'); if (activeLines.has(i)) addLine(i, 'lm-active'); }
  }
  for (const [n, info] of lines) {
    const attrs: Record<string, string> = { class: [...info.cls].join(' ') };
    if (info.style) attrs.style = info.style;
    out.push(Decoration.line({ attributes: attrs }).range(doc.line(n).from));
  }
  return Decoration.set(out, true);
}

export const livePreview = [frozenField, StateField.define<DecorationSet>({
  create: (state) => build(state),
  update(value, tr) {
    const frozen = tr.state.field(frozenField);
    const wasFrozen = tr.startState.field(frozenField);
    const refresh = tr.effects.some((e) => e.is(refreshPreview));
    if (frozen && !tr.docChanged && !refresh) return value; // selection-only change during a mouse drag: keep the layout still
    if (tr.docChanged || tr.selection || refresh || wasFrozen !== frozen || syntaxTree(tr.state) !== syntaxTree(tr.startState)) return build(tr.state);
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
})];
