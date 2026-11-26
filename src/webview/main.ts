// Webview: a CodeMirror 6 editor kept in sync with the VS Code TextDocument (see sync.ts).
// It never writes files. Undo/redo are CodeMirror's own history: local edits only (remote changes are added with
// addToHistory(false)); an undo is an ordinary local change that the sync client sends to the document.
import { Annotation, ChangeSet, Compartment, EditorState, Transaction, type TransactionSpec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, undo, redo, undoDepth, redoDepth } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { livePreview, setBaseUri, setFrozen, refreshPreview, hooks, markCellFormat } from './livepreview';
import { initTooltips, TOOLTIP_CSS } from './tooltip';
import { Toolbar, TOOLBAR_CSS, type ToolbarState } from './toolbar';
import { FindBar, FIND_CSS } from './findbar';
import { findField } from './findcore';
import * as F from './format';
import * as L from './listedit';
import { cellFormat, cellInline } from './cellfmt';
import { doubleSpaceInput, setDoubleSpaceMode, doubleSpaceOn } from './spaces';
import { picturesIn, pictureOnlyPaste, readBase64, MAX_PICTURE_BYTES, type Pic } from './pictures';
import { setMermaidDark, parseMermaid } from './mermaidwidget';
import baseCss from './base.css';
import { SyncClient, offsetOf, normalizeEol, type ToClient, type LineChange } from './sync';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();
const root = document.getElementById('root')!;
const baseStyle = document.createElement('style');
baseStyle.id = 'lm-base';
baseStyle.textContent = baseCss;
document.head.appendChild(baseStyle);
const themeEl = document.getElementById('theme')!;

const remote = Annotation.define<boolean>();
let view: EditorView | undefined;
let baseUri: string | undefined;

const sync = new SyncClient(
  (m) => vscode.postMessage(m),
  (s) => { console.warn('[inkwell]', s); vscode.postMessage({ type: 'log', text: s }); },
  (s) => vscode.postMessage({ type: 'notice', text: s }),
);

// Code-block colours: tags are mapped to the Prism class names that the crossnote prism themes colour,
// so fenced code looks like Markdown Preview Enhanced.
const cls = (c: string) => `token ${c}`;
const highlight = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: cls('comment') },
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.self], class: cls('keyword') },
  { tag: [t.string, t.special(t.string), t.character], class: cls('string') },
  { tag: [t.number, t.integer, t.float], class: cls('number') },
  { tag: [t.bool, t.atom, t.null, t.constant(t.name), t.unit], class: cls('boolean') },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], class: cls('function') },
  { tag: [t.className, t.typeName, t.namespace], class: cls('class-name') },
  { tag: [t.tagName], class: cls('tag') },
  { tag: [t.attributeName], class: cls('attr-name') },
  { tag: [t.attributeValue], class: cls('attr-value') },
  { tag: [t.propertyName, t.labelName], class: cls('property') },
  { tag: [t.variableName, t.definition(t.variableName)], class: cls('variable') },
  { tag: [t.operator, t.compareOperator, t.arithmeticOperator, t.logicOperator, t.updateOperator, t.definitionOperator], class: cls('operator') },
  { tag: [t.punctuation, t.bracket, t.separator, t.angleBracket, t.squareBracket, t.paren, t.brace], class: cls('punctuation') },
  { tag: [t.regexp, t.escape], class: cls('regex') },
  { tag: [t.inserted], class: cls('inserted') },
  { tag: [t.deleted], class: cls('deleted') },
]);

hooks.undo = () => { if (view) undo(view); };
hooks.redo = () => { if (view) redo(view); };

/** Cmd/Ctrl-click on a link or image destination asks the extension to open it. */
function linkAt(v: EditorView, pos: number): string | null {
  for (let n = syntaxTree(v.state).resolveInner(pos, 1) as { name: string; parent: unknown; from: number; to: number; getChild(n: string): { from: number; to: number } | null } | null; n; n = n.parent as typeof n) {
    if (n.name === 'URL') return v.state.sliceDoc(n.from, n.to);
    if (n.name === 'Link' || n.name === 'Image') { const u = n.getChild('URL'); return u ? v.state.sliceDoc(u.from, u.to) : null; }
    if (n.name === 'Autolink') return v.state.sliceDoc(n.from + 1, n.to - 1);
  }
  return null;
}

/**
 * Undo safety. CodeMirror's history replays the inverse of a local edit at positions mapped through every later change. When another
 * program rewrites the very text a local edit touched (reverts it, reformats it), those positions no longer match and an Undo would
 * damage the neighbouring text. So the places local edits touched are tracked (in current document coordinates, merged), and a remote
 * change that overlaps or is adjacent to one of them starts the history afresh. Remote changes elsewhere keep Undo working.
 */
const historyComp = new Compartment();
let touched: Array<[number, number]> = [];
function addTouched(from: number, to: number): void {
  touched.push([from, to]);
  touched.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of touched) { const l = merged[merged.length - 1]; if (l && r[0] <= l[1]) l[1] = Math.max(l[1], r[1]); else merged.push([r[0], r[1]]); }
  while (merged.length > 400) { // keep it small: join the two closest neighbours (only makes the check stricter)
    let k = 0, best = Infinity; for (let i = 0; i + 1 < merged.length; i++) { const g = merged[i + 1][0] - merged[i][1]; if (g < best) { best = g; k = i; } }
    merged.splice(k, 2, [merged[k][0], merged[k + 1][1]]);
  }
  touched = merged;
}
function trackLocal(tr: Transaction): void {
  if (touched.length) touched = touched.map(([a, b]) => [tr.changes.mapPos(a, -1), tr.changes.mapPos(b, 1)] as [number, number]);
  tr.changes.iterChangedRanges((_fa, _ta, fb, tb) => addTouched(fb, tb));
}
/** Before a remote change is applied: does it overlap or touch a place the local undo history refers to? */
function hitsHistory(cs: ChangeSet): boolean {
  if (!view || (!undoDepth(view.state) && !redoDepth(view.state))) { touched = []; return false; }
  let hit = false;
  cs.iterChangedRanges((fa, ta) => { for (const [a, b] of touched) if (fa <= b && ta >= a) hit = true; });
  return hit;
}
function resetHistory(): void {
  touched = [];
  if (!view) return;
  view.dispatch({ effects: historyComp.reconfigure([]), annotations: [remote.of(true), Transaction.addToHistory.of(false)] });
  view.dispatch({ effects: historyComp.reconfigure(history()), annotations: [remote.of(true), Transaction.addToHistory.of(false)] });
}
const NOTE_UNDO_FRESH = 'This file was changed by another program, so Undo starts fresh.';

function createView(text: string): EditorView {
  const v = new EditorView({
    parent: root,
    state: EditorState.create({
      doc: text,
      extensions: [
        keymap.of([
          { key: 'Mod-z', run: undo, preventDefault: true, stopPropagation: true },
          { key: 'Mod-Shift-z', run: redo, preventDefault: true, stopPropagation: true },
          { key: 'Mod-y', run: redo, preventDefault: true, stopPropagation: true },
          // Tab / Shift+Tab move a list item in or out; anywhere else Tab keeps its usual behaviour.
          { key: 'Tab', run: (vw) => tabIndent(vw, 1), shift: (vw) => tabIndent(vw, -1) },
          // Lists work like Word: Enter continues (or ends) a list, Shift+Enter breaks the line inside the item, Backspace removes a marker.
          { key: 'Enter', run: (vw) => listCmd(vw, L.enterSpec), shift: (vw) => listCmd(vw, L.softBreakSpec) },
          { key: 'Backspace', run: (vw) => listCmd(vw, L.backspaceSpec) },
          { key: 'Delete', run: (vw) => listCmd(vw, L.deleteSpec) },
          ...defaultKeymap,
        ]),
        historyComp.of(history()),
        L.listRenumber((tr) => !tr.annotation(remote)), // numbered lists are renumbered after the user's own edits, never for the file's changes
        EditorView.lineWrapping,
        EditorView.inputHandler.of((vw, from, to, text) => doubleSpaceInput(vw, from, to, text)),
        markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false }),
        livePreview,
        findField,
        syntaxHighlighting(highlight),
        EditorView.domEventHandlers({
          keydown(e) { if (e.key === 'Escape') tabMayLeave = true; else if (e.key !== 'Tab' && e.key !== 'Shift') tabMayLeave = false; return false; },
          beforeinput(e, vw) {
            if (e.inputType === 'historyUndo') { e.preventDefault(); undo(vw); return true; }
            if (e.inputType === 'historyRedo') { e.preventDefault(); redo(vw); return true; }
            return false;
          },
          mousedown(e, vw) {
            // Freeze the live-preview reveal until the button is released, so text cannot shift during a drag-select.
            if (e.button === 0) {
              vw.dispatch({ effects: setFrozen.of(true) });
              const up = () => { window.removeEventListener('mouseup', up, true); vw.dispatch({ effects: setFrozen.of(false) }); };
              window.addEventListener('mouseup', up, true);
            }
            const modified = e.metaKey || e.ctrlKey;
            const onLink = e.button === 0 && !e.shiftKey && !!(e.target as HTMLElement).closest?.('.cm-lm-link');
            if (!modified && !onLink) return false;
            const pos = vw.posAtCoords({ x: e.clientX, y: e.clientY });
            if (pos === null) return false;
            const href = linkAt(vw, pos);
            if (!href) return false;
            if (modified) { e.preventDefault(); vscode.postMessage({ type: 'openLink', href }); return true; }
            // A plain click opens a link only while the cursor is elsewhere, and only on mouseup without a drag:
            // the mousedown itself is left alone so drag-selecting across link text still works.
            const doc = vw.state.doc; const n = doc.lineAt(pos).number;
            if (vw.state.selection.ranges.some((r) => doc.lineAt(r.from).number <= n && doc.lineAt(r.to).number >= n)) return false;
            const x0 = e.clientX, y0 = e.clientY;
            const up = (u: MouseEvent) => {
              window.removeEventListener('mouseup', up, true);
              if (Math.abs(u.clientX - x0) < 4 && Math.abs(u.clientY - y0) < 4 && vw.state.selection.main.empty) vscode.postMessage({ type: 'openLink', href });
            };
            window.addEventListener('mouseup', up, true);
            return false;
          },
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged || u.selectionSet) scheduleToolbar();
          if (u.state.field(findField) !== u.startState.field(findField)) findbar.sync();
          if (!u.docChanged) return;
          for (const t of pendingPics.values()) if (t.kind === 'editor') { t.from = u.changes.mapPos(t.from, 1); t.to = u.changes.mapPos(t.to, 1); }
          for (const tr of u.transactions) {
            if (!tr.docChanged) continue;
            if (!tr.annotation(remote)) { sync.local(tr.changes); trackLocal(tr); }
            else if (touched.length) touched = touched.map(([a, b]) => [tr.changes.mapPos(a, -1), tr.changes.mapPos(b, 1)] as [number, number]);
          }
        }),
      ],
    }),
  });
  if (location.protocol === "http:") (window as unknown as { __view?: EditorView }).__view = v; // demo/probe harness only, never in VS Code
  return v;
}

/** Make the view show `text`, touching only the differing middle so the cursor keeps its place. */
function replaceText(text: string): void {
  if (!view) { view = createView(text); return; }
  const cur = view.state.doc.toString();
  let a = 0;
  const max = Math.min(cur.length, text.length);
  while (a < max && cur.charCodeAt(a) === text.charCodeAt(a)) a++;
  let b = 0;
  while (b < max - a && cur.charCodeAt(cur.length - 1 - b) === text.charCodeAt(text.length - 1 - b)) b++;
  applyRemote(ChangeSet.of({ from: a, to: cur.length - b, insert: text.slice(a, text.length - b) }, cur.length));
}

/** Applies a change that did not come from this editor's own user; stale Undo steps are dropped first if it touches them. */
function applyRemote(changes: ChangeSet): void {
  if (!view) return;
  const stale = hitsHistory(changes);
  view.dispatch({ changes, annotations: [remote.of(true), Transaction.addToHistory.of(false)] });
  if (stale) { resetHistory(); pageToast(caretAnchor(), NOTE_UNDO_FRESH); }
}

function scrollToFragment(f: string): void {
  // Phase 2a: scroll to the matching heading line in the source (2b maps this to rendered headings).
  if (!view) return;
  const slug = (s: string) => s.trim().toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-');
  const doc = view.state.doc;
  for (let i = 1; i <= doc.lines; i++) {
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(doc.line(i).text);
    if (m && slug(m[1]) === slug(f)) { view.dispatch({ effects: EditorView.scrollIntoView(doc.line(i).from, { y: 'start' }) }); return; }
  }
}

function applyHostMessage(m: ToClient): void {
  const op = sync.receive(m);
  if (!op) return;
  if (op.kind === 'replace') replaceText(op.text);
  else applyRemote(op.changes);
}

function debugEdit(c: LineChange): void {
  const doc = view!.state.doc;
  const from = offsetOf(doc, c.fromLine, c.fromCh);
  const to = offsetOf(doc, c.toLine, c.toCh);
  if (from < 0 || to < from) throw new Error('debug edit out of range');
  view!.dispatch({ changes: { from, to, insert: normalizeEol(c.insert) }, userEvent: 'input.type' });
}

window.addEventListener('message', (e) => {
  const m = e.data as { type: string; [k: string]: unknown };
  switch (m.type) {
    case 'init': baseUri = m.baseUri as string; setBaseUri(baseUri); applyHostMessage(m as unknown as ToClient); break;
    case 'ack': case 'remote': case 'resync': case 'retry': applyHostMessage(m as unknown as ToClient); break;
    case 'config': setDoubleSpaceMode(m.doubleSpacePeriod); break;
    case 'pictureResult': pictureResult(m as unknown as { id: number; ok: boolean; md?: string; error?: string; file?: string }); break;
    case 'scroll': scrollToFragment(String(m.fragment ?? '')); break;
    case 'theme':
      themeEl.textContent = String(m.css ?? ''); applyPageColours();
      toolbar.setThemes((m.themes as string[]) ?? [], String(m.current ?? 'auto'));
      break;
    case 'find': doFind(String(m.action)); break; // inkwell.find / replace / findNext / findPrevious forwarded by VS Code
    case 'history': if (view) (m.action === 'redo' ? redo : undo)(view); break; // inkwell.undo / inkwell.redo forwarded by VS Code
    case 'format': { // a shortcut forwarded by VS Code (see package.json keybindings)
      const a = String(m.action);
      runAction(a);
      break;
    }
    case 'debugAction': { // test only: clicks the real toolbar button when there is one
      try { debugAction(String(m.name), m.arg === undefined ? undefined : String(m.arg)); } catch (err) { vscode.postMessage({ type: 'debugReply', id: m.id, error: String(err) }); break; }
      void sync.whenIdle().then(() => vscode.postMessage({ type: 'debugReply', id: m.id, value: true }));
      break;
    }
    case 'debugSelect': { // test only: set a selection range (selection only, never a document change)
      const doc = view!.state.doc;
      const at = (l: unknown, c: unknown) => offsetOf(doc, Number(l), Number(c));
      view!.dispatch({ selection: { anchor: at(m.fromLine, m.fromCh), head: at(m.toLine, m.toCh) } });
      vscode.postMessage({ type: 'debugReply', id: m.id, value: { selected: view!.state.sliceDoc(view!.state.selection.main.from, view!.state.selection.main.to) } });
      break;
    }
    case 'debugTypeOverSelection': { // test only: what typing does with the current selection
      view!.dispatch(view!.state.replaceSelection(String(m.text)), { userEvent: 'input.type' } as never);
      void sync.whenIdle().then(() => vscode.postMessage({ type: 'debugReply', id: m.id, value: true }));
      break;
    }
    case 'debugMouse': { // test only: dispatches real mouse events at a document position (click counts, shift)
      const doc = view!.state.doc; const pos = offsetOf(doc, Number(m.line), Number(m.ch));
      const c = view!.coordsAtPos(pos);
      if (!c) { vscode.postMessage({ type: 'debugReply', id: m.id, error: 'no coordinates' }); break; }
      const x = c.left + 1, y = (c.top + c.bottom) / 2;
      const target = document.elementFromPoint(x, y) ?? view!.contentDOM;
      const clicks = Number(m.clicks ?? 1);
      for (let k = 1; k <= clicks; k++) {
        const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, detail: k, shiftKey: !!m.shift, view: window };
        target.dispatchEvent(new MouseEvent('mousedown', init));
        target.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
        target.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
      }
      const sel = view!.state.selection.main;
      vscode.postMessage({ type: 'debugReply', id: m.id, value: { from: sel.from, to: sel.to, text: view!.state.sliceDoc(sel.from, sel.to) } });
      break;
    }
    case 'debugHeights': {
      const doc = view!.state.doc; const out: unknown[] = [];
      for (let i = 1; i <= doc.lines; i++) { const l = doc.line(i); const c = view!.coordsAtPos(l.from); const b = view!.lineBlockAt(l.from); out.push([i - 1, c ? Math.round(c.top - view!.documentTop) : null, Math.round(b.top), Math.round(b.height), b.type === 0 ? 'T' : 'W']); }
      vscode.postMessage({ type: 'debugReply', id: m.id, value: out });
      break;
    }
    case 'debugCoords': { // test only: does posAtCoords(coordsAtPos(p)) come back to the same line?
      const doc = view!.state.doc; const ln = doc.line(Number(m.line) + 1);
      const pos = Math.min(ln.to, ln.from + 1);
      const c = view!.coordsAtPos(pos);
      const back = c ? view!.posAtCoords({ x: c.left + 1, y: (c.top + c.bottom) / 2 }) : null;
      vscode.postMessage({ type: 'debugReply', id: m.id, value: { expected: Number(m.line), got: back === null ? null : doc.lineAt(back).number - 1, coords: c, blockTop: view!.lineBlockAt(pos).top, blockH: view!.lineBlockAt(pos).height, ct: view!.contentDOM.getBoundingClientRect().top, st: view!.scrollDOM.scrollTop, dt: view!.documentTop } });
      break;
    }
    case 'debugTable': { // test only: drives the real table cell and control elements
      const d = document.querySelector('.lm-tablewrap') as HTMLElement | null;
      const cell = d?.querySelector(`[data-r="${String(m.r)}"][data-c="${String(m.c)}"]`) as HTMLElement | null;
      if (!d || !cell) { vscode.postMessage({ type: 'debugReply', id: m.id, error: 'no table cell' }); break; }
      cell.focus();
      if (m.op === 'barRect') { // test only: scroll the focused cell into view, report bar / row / viewport rects
        cell.scrollIntoView({ block: 'center' });
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const bar = document.querySelector('.lm-floatbar') as HTMLElement | null; const rc = (e: Element | null) => { const r = e?.getBoundingClientRect(); return r ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right } : null; };
          vscode.postMessage({ type: 'debugReply', id: m.id, value: { bar: rc(bar), hidden: bar?.hidden ?? true, row: rc(cell.parentElement), prev: rc(cell.parentElement?.previousElementSibling ?? null), vh: window.innerHeight, vw: window.innerWidth } });
        }));
        break;
      }
      if (m.op === 'handleRow' || m.op === 'handleCol') (d.querySelector(m.op === 'handleRow' ? '.lm-hrow' : '.lm-hcol') as HTMLElement).click();
      else if (m.op === 'ctxmenu') {
        cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }));
        (document.querySelector(`.lm-ctxmenu button[data-op="${String(m.item)}"]`) as HTMLElement).click();
      }
      else if (m.text !== undefined) { cell.textContent = String(m.text); cell.dispatchEvent(new Event('input', { bubbles: true })); }
      else if (m.op === 'Enter' || m.op === 'Tab' || m.op === 'ModEnter') {
        if (m.at !== undefined) { const tn = cell.firstChild ?? cell; const rg = document.createRange(); rg.setStart(tn, Number(m.at)); rg.collapse(true); getSelection()!.removeAllRanges(); getSelection()!.addRange(rg); }
        cell.dispatchEvent(new KeyboardEvent('keydown', { key: m.op === 'ModEnter' ? 'Enter' : String(m.op), metaKey: m.op === 'ModEnter', bubbles: true, cancelable: true }));
      } else if (m.op === 'format') { // select [from, to) of the cell's source text, then run a toolbar action
        const tn = cell.firstChild ?? cell; const rg = document.createRange(); rg.setStart(tn, Number(m.from)); rg.setEnd(tn, Number(m.to)); getSelection()!.removeAllRanges(); getSelection()!.addRange(rg);
        runAction(String(m.action), m.arg === undefined ? undefined : String(m.arg));
      } else if (m.op === 'toolbar') { // test only: put the caret at an offset of the cell's text and report the toolbar state computed for it
        const tn = cell.firstChild ?? cell; const rg = document.createRange(); rg.setStart(tn, Number(m.at)); rg.collapse(true); getSelection()!.removeAllRanges(); getSelection()!.addRange(rg);
        const off = cellOffsets(cell)!;
        vscode.postMessage({ type: 'debugReply', id: m.id, value: cellInline(cell.textContent ?? '', off[0], off[1]) }); break;
      } else if (m.op === 'html') { (document.activeElement as HTMLElement).blur(); void sync.whenIdle().then(() => vscode.postMessage({ type: 'debugReply', id: m.id, value: { html: (d.querySelector(`[data-r="${String(m.r)}"][data-c="${String(m.c)}"]`) as HTMLElement).innerHTML } })); break; }
      else (document.querySelector(`.lm-floatbar button[data-op="${String(m.op)}"]`) as HTMLElement).click();
      void sync.whenIdle().then(() => vscode.postMessage({ type: 'debugReply', id: m.id, value: { cells: [...d.querySelectorAll('td,th')].length } }));
      break;
    }
    case 'debugMermaid': {
      const svgs = document.querySelectorAll('.lm-mermaid svg').length;
      const errors = [...document.querySelectorAll('.lm-mmd-err')].map((e) => e.textContent ?? '').filter(Boolean);
      vscode.postMessage({ type: 'debugReply', id: m.id, value: { svgs, errors } });
      break;
    }
    case 'debugMenuPick': { // test only: real click on the open toolbar menu row whose label matches
      const rows = [...document.querySelectorAll('.lm-menu .lm-mi')] as HTMLElement[];
      const labels = rows.map((r) => r.textContent ?? '');
      const row = rows.find((r) => (r.textContent ?? '').replace(/^✓ /, '').startsWith(String(m.label)));
      if (row) { row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
      vscode.postMessage({ type: 'debugReply', id: m.id, value: { found: !!row, labels } });
      break;
    }
    case 'debugToolbar': {
      const names = [...document.querySelectorAll('#lm-toolbar [data-action]')].map((b) => (b as HTMLElement).dataset.action);
      const bar = document.getElementById('lm-toolbar')!.getBoundingClientRect();
      vscode.postMessage({ type: 'debugReply', id: m.id, value: { names, top: bar.top, h: bar.height, active: [...document.querySelectorAll('#lm-toolbar .active')].map((b) => (b as HTMLElement).dataset.action) } });
      break;
    }
    case 'debugTemplates': { // test only: parse every mermaid block that is in the document
      const blocks = [...view!.state.doc.toString().matchAll(/```mermaid\n([\s\S]*?)\n```/g)].map((x) => x[1]);
      void (async () => {
        const out: string[] = [];
        for (const code of blocks) { try { await parseMermaid(code); out.push('ok'); } catch (err) { out.push(String(err)); } }
        vscode.postMessage({ type: 'debugReply', id: m.id, value: out });
      })();
      break;
    }
    case 'debugQuery':
      vscode.postMessage({ type: 'debugReply', id: m.id, value: { text: view?.state.doc.toString() ?? null, bodyBg: getComputedStyle(document.body).backgroundColor, htmlBg: getComputedStyle(document.documentElement).backgroundColor, ...contentColours(), idle: sync.idle, baseUri, doubleSpace: doubleSpaceOn() } });
      break;
    case 'debugCursor': { // test only: move the cursor (selection only, never a document change)
      const doc = view!.state.doc;
      const ln = doc.line(Math.min(doc.lines, Math.max(1, Number(m.line) + 1)));
      view!.dispatch({ selection: { anchor: Math.min(ln.to, ln.from + Number(m.ch ?? 0)) }, ...(m.scroll ? { effects: EditorView.scrollIntoView(Math.min(ln.to, ln.from + Number(m.ch ?? 0)), { y: 'center' }) } : {}) });
      requestAnimationFrame(() => vscode.postMessage({ type: 'debugReply', id: m.id, value: true }));
      break;
    }
    case 'debugCheckbox': { // test only: a real mousedown on the Nth rendered checkbox
      const boxes = [...document.querySelectorAll('.lm-checkbox')];
      const el = boxes[Number(m.index)];
      if (!el) { vscode.postMessage({ type: 'debugReply', id: m.id, error: `no checkbox #${String(m.index)} (found ${boxes.length})` }); break; }
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      void sync.whenIdle().then(() => vscode.postMessage({ type: 'debugReply', id: m.id, value: true }));
      break;
    }
    case 'debugImages': { // test only: wait for every rendered image to settle, report whether it decoded
      const t0 = Date.now();
      const check = (): void => {
        const imgs = [...document.querySelectorAll('.lm-imgwrap img')] as HTMLImageElement[];
        if (Date.now() - t0 < 6000 && (imgs.length < Number(m.min ?? 0) || imgs.some((i) => !i.complete))) { setTimeout(check, 100); return; }
        vscode.postMessage({ type: 'debugReply', id: m.id, value: imgs.map((i) => ({ src: i.src, ok: i.complete && i.naturalWidth > 0 && i.getBoundingClientRect().width > 0 })) });
      };
      check();
      break;
    }
    case 'debugDom':
      vscode.postMessage({ type: 'debugReply', id: m.id, value: { html: document.documentElement.outerHTML, baseUri } });
      break;
    case 'debugFocus': { // test only: put keyboard focus in the editor (or a table cell), like a click would
      if (m.cell) (document.querySelector(`.lm-tablewrap [data-r="${String((m.cell as {r:number}).r)}"][data-c="${String((m.cell as {c:number}).c)}"]`) as HTMLElement).focus();
      else view!.focus();
      vscode.postMessage({ type: 'debugReply', id: m.id, value: { hasFocus: document.hasFocus(), active: document.activeElement?.className ?? '' } });
      break;
    }
    case 'debugKey': { // test only: a real keydown event on the focused element, as the keyboard would send it
      const target = (document.activeElement as HTMLElement | null) ?? view!.contentDOM;
      const ev = new KeyboardEvent('keydown', { key: String(m.key), code: m.code === undefined ? '' : String(m.code), metaKey: !!m.meta, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, bubbles: true, cancelable: true });
      target.dispatchEvent(ev);
      void sync.whenIdle().then(() => vscode.postMessage({ type: 'debugReply', id: m.id, value: { defaultPrevented: ev.defaultPrevented } }));
      break;
    }
    case 'debugHover': { // test only: hover (mouseover / mouseout) a control, report the tooltip shown after the delay
      const el = document.querySelector(String(m.selector)) as HTMLElement | null;
      if (!el) { vscode.postMessage({ type: 'debugReply', id: m.id, error: 'no element ' + String(m.selector) }); break; }
      const before = { doc: view!.state.doc.toString(), sel: view!.state.selection.main.toJSON() };
      const fire = (t: string) => el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, relatedTarget: t === 'mouseout' ? document.body : null }));
      if (m.op === 'out') fire('mouseout'); else { fire('mouseenter'); fire('mouseover'); }
      setTimeout(() => {
        const tt = document.querySelector('.lm-tooltip') as HTMLElement | null;
        const shown = !!tt && !tt.hidden; const r = tt?.getBoundingClientRect();
        const after = { doc: view!.state.doc.toString(), sel: view!.state.selection.main.toJSON() };
        vscode.postMessage({ type: 'debugReply', id: m.id, value: { shown, text: shown ? tt!.textContent : null, rect: r ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null, vw: window.innerWidth, vh: window.innerHeight, pe: tt ? getComputedStyle(tt).pointerEvents : null, same: JSON.stringify(before) === JSON.stringify(after), title: el.getAttribute('title') } });
      }, Number(m.wait ?? 450));
      break;
    }
    case 'debugTypeText': { // test only: typed text goes through the editor's own input handlers, like a keystroke in the browser
      const v = view!; const text = String(m.text);
      const ime = !!m.composing; if (ime) (v as unknown as { inputState: { composing: number } }).inputState.composing = 1; // pretend an IME is composing
      for (const ch of Array.from(text)) {
        const sr = v.state.selection.main;
        const handled = v.state.facet(EditorView.inputHandler).some((h) => h(v, sr.from, sr.to, ch, () => v.state.update({ changes: { from: sr.from, to: sr.to, insert: ch }, userEvent: 'input.type' })));
        if (!handled) v.dispatch(v.state.update({ changes: { from: sr.from, to: sr.to, insert: ch }, selection: { anchor: sr.from + ch.length }, userEvent: 'input.type' }));
      }
      if (ime) (v as unknown as { inputState: { composing: number } }).inputState.composing = -1;
      void sync.whenIdle().then(() => vscode.postMessage({ type: 'debugReply', id: m.id, value: true }));
      break;
    }
    case 'debugPost': vscode.postMessage(m.msg); setTimeout(() => void sync.whenIdle().then(() => vscode.postMessage({ type: 'debugReply', id: m.id, value: true })), Number(m.wait ?? 600)); break; // test only: send a raw message to the host, as a hostile page might
    case 'debugHang': { // test only: for every list line, the left edge of its first visual line of text and of each wrapped line
      const res: unknown[] = [];
      for (const ln of document.querySelectorAll('.cm-line.lm-li')) {
        const rects: Array<{ l: number; t: number }> = [];
        const w = document.createTreeWalker(ln, NodeFilter.SHOW_TEXT); let t: Node | null;
        while ((t = w.nextNode())) { if ((t.parentElement as HTMLElement).closest('.lm-bullet,.lm-mbox,.lm-wsbox')) continue; const r = document.createRange(); r.selectNodeContents(t); for (const q of Array.from(r.getClientRects())) if (q.width > 0) rects.push({ l: q.left, t: q.top }); }
        if (!rects.length) continue;
        const tops = [...new Set(rects.map((q) => Math.round(q.t)))].sort((a, b) => a - b);
        const left = (tp: number) => Math.min(...rects.filter((q) => Math.round(q.t) === tp).map((q) => q.l));
        res.push({ text: (ln.textContent ?? '').slice(0, 24), first: left(tops[0]), wrapped: tops.slice(1).map(left) });
      }
      vscode.postMessage({ type: 'debugReply', id: m.id, value: res });
      break;
    }
    case 'debugTypeCell': { // test only: a space (or text) typed into the focused cell: the beforeinput the browser would send, then the default insert
      const cell = (document.activeElement as HTMLElement | null)?.closest?.('td,th') as HTMLElement | null;
      if (!cell) { vscode.postMessage({ type: 'debugReply', id: m.id, error: 'no focused cell' }); break; }
      for (const ch of Array.from(String(m.text))) {
        const ev = new InputEvent('beforeinput', { inputType: 'insertText', data: ch, isComposing: !!m.composing, bubbles: true, cancelable: true });
        cell.dispatchEvent(ev);
        if (!ev.defaultPrevented) document.execCommand('insertText', false, ch);
      }
      void sync.whenIdle().then(() => vscode.postMessage({ type: 'debugReply', id: m.id, value: cell.textContent }));
      break;
    }
    case 'debugPaste': { // test only: a paste or drop event carrying real File objects (or just text), sent to the editor or the focused cell
      const dt = new DataTransfer();
      for (const f of (m.files as Array<{ name: string; type: string; b64: string }> | undefined) ?? []) {
        const bin = atob(f.b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        dt.items.add(new File([u], f.name, { type: f.type }));
      }
      if (m.text !== undefined) dt.setData('text/plain', String(m.text));
      const cell = m.cell ? document.querySelector(`.lm-tablewrap [data-r="${String((m.cell as { r: number }).r)}"][data-c="${String((m.cell as { c: number }).c)}"]`) as HTMLElement | null : null;
      if (m.cell && !cell) { vscode.postMessage({ type: 'debugReply', id: m.id, error: 'no such cell' }); break; }
      let ev: Event;
      if (m.kind === 'drop') {
        let x = 10, y = 10;
        if (!cell) { const pos = offsetOf(view!.state.doc, Number(m.line), Number(m.ch)); const c = view!.coordsAtPos(pos); if (c) { x = c.left + 1; y = (c.top + c.bottom) / 2; } }
        else { const b = cell.getBoundingClientRect(); x = b.left + 4; y = b.top + 4; }
        ev = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y });
        (cell ?? document.elementFromPoint(x, y) ?? view!.contentDOM).dispatchEvent(ev);
      } else {
        if (cell) cell.focus(); else view!.focus();
        ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        ((document.activeElement as HTMLElement | null) ?? view!.contentDOM).dispatchEvent(ev);
      }
      const t0 = Date.now();
      const wait = (): void => { if (pendingPics.size && Date.now() - t0 < 8000) { setTimeout(wait, 30); return; } void sync.whenIdle().then(() => vscode.postMessage({ type: 'debugReply', id: m.id, value: { prevented: ev.defaultPrevented, ours: lastPictureEvent === ev, toast: document.querySelector('.lm-toast')?.textContent ?? null } })); };
      setTimeout(wait, 30);
      break;
    }
    case 'debugFind': { // test only: drives the find bar like a user would
      const fail = (err: unknown): void => vscode.postMessage({ type: 'debugReply', id: m.id, error: String(err) });
      try {
        switch (String(m.op)) {
          case 'open': findbar.show(!!m.replace); break;
          case 'query': findbar.setQuery(String(m.value)); break;
          case 'case': findbar.setOption('case', !!m.value); break;
          case 'word': findbar.setOption('word', !!m.value); break;
          case 'replacement': findbar.setReplacement(String(m.value)); break;
          case 'press': findbar.press(String(m.value)); break;
          case 'close': findbar.close(m.keep !== false); break;
          case 'state': break;
          default: throw new Error('unknown find op ' + String(m.op));
        }
      } catch (err) { fail(err); break; }
      requestAnimationFrame(() => requestAnimationFrame(() => void sync.whenIdle().then(() => {
        const st = view!.state.field(findField); const sel = view!.state.selection.main;
        vscode.postMessage({ type: 'debugReply', id: m.id, value: { ...findbar.info, sel: { from: sel.from, to: sel.to, text: view!.state.sliceDoc(sel.from, sel.to) },
          matches: st.matches.slice(0, 300).map((x) => ({ from: x.from, to: x.to, text: st.vis!.text.slice(x.s, x.e), cell: x.block.cell ? [x.block.cell.r, x.block.cell.c] : null, pieces: x.pieces.length })),
          cellSel: (() => { const c = (document.activeElement as HTMLElement | null)?.closest?.('td,th') as HTMLElement | null; const o = c ? cellOffsets(c) : null; return c && o ? { r: c.dataset.r, c: c.dataset.c, text: (c.textContent ?? '').slice(o[0], o[1]), from: o[0], to: o[1] } : null; })() } });
      })));
      break;
    }
    case 'debugToast': vscode.postMessage({ type: 'debugReply', id: m.id, value: document.querySelector('.lm-toast')?.textContent ?? null }); break;
    case 'debugClick': { const el = document.querySelector(String(m.selector)) as HTMLElement | null; el?.click(); vscode.postMessage({ type: 'debugReply', id: m.id, value: !!el }); break; }
    case 'debugEdit':
      try { debugEdit(m.change as LineChange); } catch (err) { vscode.postMessage({ type: 'debugReply', id: m.id, error: String(err) }); break; }
      void sync.whenIdle().then(() => vscode.postMessage({ type: 'debugReply', id: m.id, value: true }));
      break;
  }
});

// ---- toolbar, formatting actions and shortcuts ----
let last: { text?: string; highlight?: string } = {};
try { last = (vscode.getState() as typeof last) ?? {}; } catch { /* no saved state */ }
const toolbar = new Toolbar(
  { run: (n, a) => runAction(n, a), openText: () => vscode.postMessage({ type: 'openAsText' }), setTheme: (v) => vscode.postMessage({ type: 'setTheme', value: v }) },
  last,
);
toolbar.onColour = (k, v) => { if (k === 'text') last.text = v; else last.highlight = v; };
document.body.prepend(toolbar.el);
const findbar: FindBar = new FindBar({
  view: () => view,
  captureFocus: () => {
    const cell = (document.activeElement as HTMLElement | null)?.closest?.('td,th') as HTMLElement | null;
    if (cell && cell.closest('.lm-tablewrap')) { const off = cellOffsets(cell); return () => { if (cell.isConnected) { cell.focus(); if (off) setCellSelection(cell, off[0], off[1]); } else view?.focus(); }; }
    return () => view?.focus();
  },
  activeCell: () => {
    const cell = (document.activeElement as HTMLElement | null)?.closest?.('td,th') as HTMLElement | null;
    const wrap = cell?.closest('.lm-tablewrap') as HTMLElement | null;
    if (!cell || !wrap) return null;
    const off = cellOffsets(cell);
    return { wrap, selected: off && off[1] > off[0] ? (cell.textContent ?? '').slice(off[0], off[1]) : '' };
  },
  selectInCell: (wrap, r, c, a, b) => {
    const cell = wrap.querySelector(`[data-r="${r}"][data-c="${c}"]`) as HTMLElement | null; if (!cell) { view?.focus(); return; }
    cell.focus(); setCellSelection(cell, a, b);
  },
});
toolbar.el.after(findbar.el);
if (location.protocol === 'http:') (window as unknown as { __findbar?: FindBar }).__findbar = findbar; // demo/probe harness only, never in VS Code
const placeBars = (): void => {
  const tb = toolbar.el.offsetHeight, fb = findbar.el.hidden ? 0 : findbar.el.offsetHeight;
  document.documentElement.style.setProperty('--lm-tbtop', tb + 'px');
  document.documentElement.style.setProperty('--lm-tbh', tb + fb + 'px');
};
new ResizeObserver(placeBars).observe(toolbar.el);
findbar.el.addEventListener('lm-find-layout', placeBars);
const tbStyle = document.createElement('style'); tbStyle.textContent = TOOLBAR_CSS + TOOLTIP_CSS + FIND_CSS; initTooltips(); document.head.appendChild(tbStyle);

const inCell = (): boolean => !!(document.activeElement as HTMLElement | null)?.closest?.('.lm-tablewrap');

/**
 * Formatting inside a table cell. While a cell has focus it shows its Markdown source as plain text (each <br> as a
 * line break), so formatting edits that text: it wraps or unwraps the selection, Word-style (the same shortcut on
 * text that already has the style removes it), and keeps the same text selected so styles can be stacked. The new
 * text goes in through insertText, so the cell's normal input path writes it to the file and Undo works.
 */
/** A short message shown on the page next to an element (VS Code pop-ups are easy to miss or may be silenced). */
function pageToast(near: HTMLElement, text: string): void {
  document.querySelectorAll('.lm-toast').forEach((t) => t.remove());
  const t = document.createElement('div'); t.className = 'lm-toast'; t.setAttribute('role', 'status'); t.textContent = text;
  document.body.appendChild(t);
  const r = near.getBoundingClientRect();
  t.style.left = Math.max(8, Math.min(r.left, window.innerWidth - t.offsetWidth - 8)) + 'px';
  t.style.top = (r.bottom + 8 + t.offsetHeight < window.innerHeight ? r.bottom + 8 : Math.max(8, r.top - t.offsetHeight - 8)) + 'px';
  setTimeout(() => t.remove(), 4000);
}

const CELL_BLOCK_ONLY = new Set(['h0', 'h1', 'h2', 'h3', 'quote', 'table', 'hr', 'diagram']);
function cellOffsets(cell: HTMLElement): [number, number] | null {
  const sel = window.getSelection(); if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0); if (!cell.contains(r.startContainer) || !cell.contains(r.endContainer)) return null;
  const pre = document.createRange(); pre.selectNodeContents(cell); pre.setEnd(r.startContainer, r.startOffset);
  const a = pre.toString().length; return [a, a + r.toString().length];
}
function setCellSelection(cell: HTMLElement, a: number, b: number): void {
  const at = (n: number): [Node, number] => {
    const w = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT); let t: Node | null; let left = n; let last: Node | null = null;
    while ((t = w.nextNode())) { const len = (t as Text).data.length; if (left <= len) return [t, left]; left -= len; last = t; }
    return last ? [last, (last as Text).data.length] : [cell, 0];
  };
  const [sn, so] = at(a), [en, eo] = at(b); const r = document.createRange(); r.setStart(sn, so); r.setEnd(en, eo);
  const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(r);
}
function replaceCellText(cell: HTMLElement, text: string, a: number, b: number): void {
  if ((cell.textContent ?? '') !== text) {
    const r = document.createRange(); r.selectNodeContents(cell); const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(r);
    markCellFormat(); document.execCommand('insertText', false, text);
  }
  setCellSelection(cell, a, b);
}
function cellAction(name: string, arg?: string): void {
  const cell = (document.activeElement as HTMLElement | null)?.closest?.('td,th') as HTMLElement | null;
  if (!cell) return;
  if (name === 'codeblock') { // a code block cannot live in a cell: with a language chosen do nothing, otherwise use inline code
    pageToast(cell, arg ? 'Code blocks can\'t go inside a table cell. Click outside the table to add one.' : 'Code blocks can\'t go inside a table cell, so this uses inline code.');
    if (arg) return;
  }
  if (name === 'indent' || name === 'outdent') { pageToast(cell, F.NOTE_IN_CELL); return; }
  if (CELL_BLOCK_ONLY.has(name)) { pageToast(cell, 'Headings, quotes, rules, tables and diagrams can\'t go inside a table cell. Click outside the table to use them.'); return; }
  const off = cellOffsets(cell); if (!off) return;
  const r = cellFormat(cell.textContent ?? '', off[0], off[1], name, arg, toolbar.lastText, toolbar.lastHighlight);
  if (r) replaceCellText(cell, r.text, r.a, r.b);
}

/** A stand-in element at the caret, so a note can be placed next to it like next to a real element. */
function caretAnchor(): HTMLElement {
  const c = view?.coordsAtPos(view.state.selection.main.head);
  const r = { left: c?.left ?? 24, right: c?.right ?? 24, top: c?.top ?? 80, bottom: c?.bottom ?? 100, width: 0, height: (c?.bottom ?? 100) - (c?.top ?? 80), x: c?.left ?? 24, y: c?.top ?? 80 };
  return { getBoundingClientRect: () => r } as unknown as HTMLElement;
}

/** Set by Escape, cleared by any other key: the next Tab may leave the editor (keyboard users must be able to get out). */
let tabMayLeave = false;
/**
 * Tab / Shift+Tab: moves list items when the caret or selection is on one. On any other line Tab does nothing but say why
 * (it never moves the keyboard focus out of the editor, and never types a tab), except inside a fenced code block, where it
 * keeps its usual behaviour, and straight after Escape, which lets focus move on.
 */
function listCmd(vw: EditorView, spec: (st: EditorState) => TransactionSpec | null): boolean {
  if (inCell()) return false;
  const s = spec(vw.state);
  if (!s) return false;
  vw.dispatch(s);
  return true;
}
function tabIndent(vw: EditorView, dir: 1 | -1): boolean {
  if (tabMayLeave) { tabMayLeave = false; return false; }
  if (!F.selectedListItems(vw.state).length && F.inFence(vw.state)) return false;
  runAction(dir > 0 ? 'indent' : 'outdent');
  return true;
}

// ---- pasted and dropped pictures ----
type PicTarget = { kind: 'editor'; from: number; to: number; n: number } | { kind: 'cell'; cell: HTMLElement; a: number; b: number; n: number };
const pendingPics = new Map<number, PicTarget>();
let picSeq = 0;
let lastPictureEvent: Event | null = null; // test only: did the picture code take this paste / drop?

function placeNote(t: PicTarget | null, text: string): void { pageToast(t && t.kind === 'cell' && t.cell.isConnected ? t.cell : caretAnchor(), text); }

async function sendPictures(pics: Pic[], target: PicTarget): Promise<void> {
  let n = 0;
  for (const p of pics) {
    if (p.file.size > MAX_PICTURE_BYTES) { placeNote(target, 'That picture is bigger than 25 MB, so it was not added.'); continue; }
    const id = ++picSeq;
    const t = { ...target, n: n++ } as PicTarget; // each picture keeps its own insertion point, shifted as the others go in
    pendingPics.set(id, t);
    try { vscode.postMessage({ type: 'pastePicture', id, ext: p.ext, data: await readBase64(p.file) }); }
    catch { pendingPics.delete(id); placeNote(target, 'That picture could not be read.'); }
  }
}

function pictureResult(m: { id: number; ok: boolean; md?: string; error?: string }): void {
  const t = pendingPics.get(m.id); pendingPics.delete(m.id);
  if (!t) return;
  if (!m.ok || !m.md) { placeNote(t, m.error ?? 'The picture could not be added.'); return; }
  if (t.kind === 'cell') {
    if (!t.cell.isConnected) { placeNote(null, `The picture was saved, but the table cell has changed: ${m.md}`); return; }
    t.cell.focus(); setCellSelection(t.cell, t.a, t.b);
    document.execCommand('insertText', false, (t.n > 0 ? ' ' : '') + m.md);
    const off = cellOffsets(t.cell); if (off) { for (const o of pendingPics.values()) if (o.kind === 'cell' && o.cell === t.cell) { o.a = off[1]; o.b = off[1]; } }
    return;
  }
  if (!view) return;
  const insert = (t.n > 0 ? '\n' : '') + m.md;
  view.dispatch({ changes: { from: t.from, to: t.to, insert }, selection: { anchor: t.from + insert.length }, userEvent: 'input.paste', scrollIntoView: true });
  view.focus();
}

/** Where a paste or drop goes: the focused table cell, or the editor's selection (or the drop point). */
function pictureTarget(at?: { x: number; y: number; cell: HTMLElement | null }): PicTarget | null {
  const cell = at ? at.cell : (document.activeElement as HTMLElement | null)?.closest?.('td,th') as HTMLElement | null;
  if (cell && cell.closest('.lm-tablewrap')) {
    if (at) cell.focus();
    const off = cellOffsets(cell) ?? [(cell.textContent ?? '').length, (cell.textContent ?? '').length];
    return { kind: 'cell', cell, a: off[0], b: off[1], n: 0 };
  }
  if (!view) return null;
  if (at) { const pos = view.posAtCoords({ x: at.x, y: at.y }) ?? view.state.selection.main.head; return { kind: 'editor', from: pos, to: pos, n: 0 }; }
  const r = view.state.selection.main;
  return { kind: 'editor', from: r.from, to: r.to, n: 0 };
}

document.addEventListener('paste', (e) => {
  const pics = pictureOnlyPaste(e.clipboardData);
  if (!pics.length) return; // not a picture: text and everything else paste exactly as before
  const inEditor = !!view && (view.hasFocus || !!(e.target as HTMLElement | null)?.closest?.('.cm-editor'));
  if (!inEditor && !inCell()) return;
  const t = pictureTarget(); if (!t) return;
  e.preventDefault(); e.stopPropagation(); lastPictureEvent = e;
  void sendPictures(pics, t);
}, true);
const hasPictureFiles = (dt: DataTransfer | null): boolean => !!dt && (picturesIn(dt, 'drop').length > 0 || Array.from(dt.items ?? []).some((i) => i.kind === 'file' && (i.type.startsWith('image/') || i.type === '')));
document.addEventListener('dragover', (e) => { if (hasPictureFiles(e.dataTransfer)) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; } }, true);
document.addEventListener('drop', (e) => {
  if (!hasPictureFiles(e.dataTransfer)) return;
  e.preventDefault(); e.stopPropagation(); lastPictureEvent = e;
  const pics = picturesIn(e.dataTransfer, 'drop'); if (!pics.length) return;
  const cell = (e.target as HTMLElement | null)?.closest?.('.lm-tablewrap td, .lm-tablewrap th') as HTMLElement | null;
  const t = pictureTarget({ x: e.clientX, y: e.clientY, cell }); if (!t) return;
  if (t.kind === 'editor' && view) view.dispatch({ selection: { anchor: t.from } });
  void sendPictures(pics, t);
}, true);

function runAction(name: string, arg?: string): void {
  if (!view) return;
  if (name === 'openText') { vscode.postMessage({ type: 'openAsText' }); return; }
  if (inCell()) { cellAction(name, arg); return; } // a table cell has the focus: format the text selected in the cell
  const st = view.state;
  let spec;
  switch (name) {
    case 'bold': spec = F.toggleInline(st, 'bold'); break;
    case 'italic': spec = F.toggleInline(st, 'italic'); break;
    case 'strike': spec = F.toggleInline(st, 'strike'); break;
    case 'code': spec = F.toggleInline(st, 'code'); break;
    case 'link': spec = F.setLink(st); break;
    case 'bullets': case 'numbered': case 'checklist': spec = F.toggleList(st, name); break;
    case 'quote': spec = F.toggleQuote(st); break;
    case 'indent': case 'outdent': { const r = F.indentList(st, name === 'indent' ? 1 : -1); if (r.note) pageToast(caretAnchor(), r.note); if (!r.spec) { view.focus(); return; } spec = r.spec; break; }
    case 'h0': case 'h1': case 'h2': case 'h3': spec = F.setHeading(st, Number(name[1])); break;
    case 'codeblock': spec = F.codeBlock(st, arg); break;
    case 'table': spec = F.insertTable(st); break;
    case 'hr': spec = F.insertRule(st); break;
    case 'diagram': spec = F.insertDiagram(st, arg ?? 'flowchart'); break;
    case 'textcolor': spec = F.applyColour(st, 'text', toolbar.lastText); break;
    case 'highlight': spec = F.applyColour(st, 'highlight', toolbar.lastHighlight); break;
    case 'colour:text': spec = F.applyColour(st, 'text', arg === 'none' ? null : arg!); break;
    case 'colour:highlight': spec = F.applyColour(st, 'highlight', arg === 'none' ? null : arg!); break;
    default: return;
  }
  view.dispatch(spec);
  view.focus();
  try { vscode.setState(last); } catch { /* ignore */ }
}

function debugAction(name: string, arg?: string): void {
  const b = document.querySelector(`#lm-toolbar [data-action="${name}"]`) as HTMLElement | null;
  if (arg === undefined && b) { b.click(); return; }
  runAction(name, arg);
}

let tbPending = false;
function scheduleToolbar(): void {
  if (tbPending) return; tbPending = true;
  requestAnimationFrame(() => {
    tbPending = false;
    if (!view) return;
    if (inCell()) {
      const cell = (document.activeElement as HTMLElement).closest('td,th') as HTMLElement | null;
      const off = cell ? cellOffsets(cell) : null;
      // In a cell the editor's own selection is elsewhere: never show its state (e.g. a bullet line above the table).
      const c = cell && off ? cellInline(cell.textContent ?? '', off[0], off[1]) : { bold: false, italic: false, strike: false, code: false, list: null };
      toolbar.update({ bold: c.bold, italic: c.italic, strike: c.strike, code: c.code, heading: 0, list: c.list as never, quote: false, codeblock: false });
      return;
    }
    const st = view.state;
    const a = F.activeInline(st);
    const line = st.doc.lineAt(st.selection.main.head).text;
    toolbar.update({ ...a, heading: F.headingLevel(st), list: F.listKindOf(line), quote: /^[ \t]*>/.test(line), codeblock: !!F.inFence(st) });
  });
}

// Shortcuts (Mac). Also contributed in package.json with `when: activeCustomEditorId == 'inkwell.editor'`, so VS Code
// forwards them as commands. The webview handles the key itself and stops it (preventDefault + stopPropagation in the capture
// phase), so VS Code's forwarding listener (bubble phase) never sees it and the command only fires when the webview did not
// get the key. One path per key press: nothing is timed and no state is shared between the two paths.
const SHORTCUTS: Array<{ code: string; shift?: boolean; alt?: boolean; action: string }> = [
  { code: 'KeyB', action: 'bold' }, { code: 'KeyI', action: 'italic' }, { code: 'KeyX', shift: true, action: 'strike' }, { code: 'KeyK', action: 'link' },
  { code: 'KeyE', action: 'code' }, { code: 'Digit8', shift: true, action: 'bullets' }, { code: 'Digit7', shift: true, action: 'numbered' },
  { code: 'Digit9', shift: true, action: 'checklist' }, { code: 'Period', shift: true, action: 'quote' },
  { code: 'Digit1', alt: true, action: 'h1' }, { code: 'Digit2', alt: true, action: 'h2' }, { code: 'Digit3', alt: true, action: 'h3' }, { code: 'Digit0', alt: true, action: 'h0' },
  { code: 'BracketRight', action: 'indent' }, { code: 'BracketLeft', action: 'outdent' },
  { code: 'KeyC', alt: true, action: 'codeblock' }, { code: 'KeyH', shift: true, action: 'highlight' }, { code: 'KeyC', shift: true, action: 'textcolor' },
];
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
document.addEventListener('selectionchange', () => { if (inCell()) scheduleToolbar(); });
/** Find / Replace shortcuts: Cmd+F, Cmd+Alt+F, Cmd+G, Cmd+Shift+G on a Mac; Ctrl+F, Ctrl+H, F3, Shift+F3 elsewhere. (Mac Cmd+Shift+H stays the highlighter.) */
function findKey(e: KeyboardEvent): 'find' | 'replace' | 'next' | 'prev' | null {
  if (isMac) {
    if (!e.metaKey || e.ctrlKey) return null;
    if (e.code === 'KeyF' && !e.shiftKey) return e.altKey ? 'replace' : 'find';
    if (e.code === 'KeyG' && !e.altKey) return e.shiftKey ? 'prev' : 'next';
    return null;
  }
  if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) return e.code === 'KeyF' ? 'find' : e.code === 'KeyH' ? 'replace' : null;
  if (!e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'F3') return e.shiftKey ? 'prev' : 'next';
  return null;
}
function doFind(a: string): void {
  if (!view) return;
  if (a === 'find') findbar.show(false); else if (a === 'replace') findbar.show(true); else if (a === 'next') findbar.navigate(1); else if (a === 'prev') findbar.navigate(-1);
}
window.addEventListener('keydown', (e) => {
  const fk = e.isComposing ? null : findKey(e);
  if (fk) { e.preventDefault(); e.stopPropagation(); doFind(fk); return; }
  if (e.isComposing || !(isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) return;
  // Undo / redo: CodeMirror's history, in the editor and in table cells. Stopped here so that VS Code's own
  // forwarding (which would run its native undo) and the inkwell.undo command never also act on this key press.
  const k = e.key.toLowerCase();
  const field = (e.target as HTMLElement | null)?.closest?.('input,textarea,select');
  // Typing in the find bar: VS Code must not turn its shortcuts (Undo, Bold ...) into commands for the document.
  // The key is left alone otherwise, so the field itself still undoes, copies and pastes.
  if (field && field.closest('#lm-find') && view && findbar.docUndoable && !e.altKey && (k === 'z' || (k === 'y' && !isMac && !e.shiftKey))) { // right after a Replace, Undo undoes the Replace, not the typing in the field
    e.preventDefault(); e.stopPropagation(); (k === 'y' || e.shiftKey ? redo : undo)(view); return;
  }
  if (field && field.closest('#lm-find') && k === 'a' && !e.shiftKey && !e.altKey) { // Select all in a find field: done here, so it cannot arrive late through VS Code and swallow what is typed next
    e.preventDefault(); e.stopPropagation(); (field as HTMLInputElement).select(); return;
  }
  if (field && field.closest('#lm-find') && !['c', 'v', 'x', 'a', 's', 'w', 'q', 'n', 't', 'p', 'o'].includes(k)) { e.stopPropagation(); return; }
  if (!e.altKey && !field && view && (k === 'z' || (k === 'y' && !isMac && !e.shiftKey))) {
    e.preventDefault(); e.stopPropagation();
    (k === 'y' || e.shiftKey ? redo : undo)(view);
    return;
  }
  // On Windows/Linux Ctrl+Alt is AltGr on many layouts, so Alt shortcuts there are Ctrl+Shift+Alt.
  const s = SHORTCUTS.find((x) => x.code === e.code && (!!x.shift || (!isMac && !!x.alt)) === e.shiftKey && !!x.alt === e.altKey);
  if (!s) return;
  e.preventDefault(); e.stopPropagation();
  runAction(s.action);
}, true);

function contentColours(): { contentBg: string; contentColor: string; bodyColor: string } {
  const c = document.querySelector('.cm-content');
  const cs = c ? getComputedStyle(c) : null;
  return { contentBg: cs?.backgroundColor ?? '', contentColor: cs?.color ?? '', bodyColor: getComputedStyle(document.body).color };
}

/**
 * The crossnote theme paints the page through `html body {background-color}`. Make the whole canvas
 * (the html element too) follow that colour, and tell the browser whether the page is light or dark,
 * so nothing from VS Code's own theme (dark body class, --vscode-* variables, scrollbars) shows through.
 */
function applyPageColours(): void {
  const bg = getComputedStyle(document.body).backgroundColor;
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(bg);
  if (!m || (m[4] !== undefined && Number(m[4]) === 0)) { document.documentElement.style.backgroundColor = ''; document.documentElement.style.colorScheme = ''; return; }
  const lum = (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) / 255;
  document.documentElement.style.backgroundColor = bg;
  const cs = getComputedStyle(document.body).color;
  document.documentElement.style.setProperty('--lm-bg', bg);
  document.documentElement.style.setProperty('--lm-fg', cs);
  document.documentElement.classList.toggle('lm-dark-page', lum < 0.5);
  if (setMermaidDark(lum < 0.5) && view) view.dispatch({ effects: refreshPreview.of(null) });
  document.documentElement.style.colorScheme = lum < 0.5 ? 'dark' : 'light';
}

vscode.postMessage({ type: 'ready' });
