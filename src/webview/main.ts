// Webview: a CodeMirror 6 editor kept in sync with the VS Code TextDocument (see sync.ts).
// It never writes files. Undo/redo are CodeMirror's own history: local edits only (remote changes are added with
// addToHistory(false)); an undo is an ordinary local change that the sync client sends to the document.
import { Annotation, EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, undo, redo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { livePreview, setBaseUri, setFrozen, refreshPreview, hooks } from './livepreview';
import { initTooltips, TOOLTIP_CSS } from './tooltip';
import { Toolbar, TOOLBAR_CSS, type ToolbarState } from './toolbar';
import * as F from './format';
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
          ...defaultKeymap,
        ]),
        history(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false }),
        livePreview,
        syntaxHighlighting(highlight),
        EditorView.domEventHandlers({
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
          if (!u.docChanged) return;
          for (const tr of u.transactions) {
            if (tr.docChanged && !tr.annotation(remote)) sync.local(tr.changes);
          }
        }),
      ],
    }),
  });
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
  view.dispatch({ changes: { from: a, to: cur.length - b, insert: text.slice(a, text.length - b) }, annotations: [remote.of(true), Transaction.addToHistory.of(false)] });
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
  else view?.dispatch({ changes: op.changes, annotations: [remote.of(true), Transaction.addToHistory.of(false)] });
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
    case 'scroll': scrollToFragment(String(m.fragment ?? '')); break;
    case 'theme':
      themeEl.textContent = String(m.css ?? ''); applyPageColours();
      toolbar.setThemes((m.themes as string[]) ?? [], String(m.current ?? 'auto'));
      break;
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
          vscode.postMessage({ type: 'debugReply', id: m.id, value: { bar: rc(bar), hidden: bar?.hidden ?? true, row: rc(cell.parentElement), vh: window.innerHeight, vw: window.innerWidth } });
        }));
        break;
      }
      if (m.op === 'handleRow' || m.op === 'handleCol') (d.querySelector(m.op === 'handleRow' ? '.lm-hrow' : '.lm-hcol') as HTMLElement).click();
      else if (m.op === 'ctxmenu') {
        cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }));
        (document.querySelector(`.lm-ctxmenu button[data-op="${String(m.item)}"]`) as HTMLElement).click();
      }
      else if (m.text !== undefined) { cell.textContent = String(m.text); cell.dispatchEvent(new Event('input', { bubbles: true })); }
      else if (m.op === 'Enter' || m.op === 'Tab') cell.dispatchEvent(new KeyboardEvent('keydown', { key: String(m.op), bubbles: true, cancelable: true }));
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
      vscode.postMessage({ type: 'debugReply', id: m.id, value: { text: view?.state.doc.toString() ?? null, bodyBg: getComputedStyle(document.body).backgroundColor, htmlBg: getComputedStyle(document.documentElement).backgroundColor, ...contentColours(), idle: sync.idle, baseUri } });
      break;
    case 'debugCursor': { // test only: move the cursor (selection only, never a document change)
      const doc = view!.state.doc;
      const ln = doc.line(Math.min(doc.lines, Math.max(1, Number(m.line) + 1)));
      view!.dispatch({ selection: { anchor: Math.min(ln.to, ln.from + Number(m.ch ?? 0)) } });
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
      const ev = new KeyboardEvent('keydown', { key: String(m.key), metaKey: !!m.meta, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, bubbles: true, cancelable: true });
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
new ResizeObserver(() => document.documentElement.style.setProperty('--lm-tbh', toolbar.el.offsetHeight + 'px')).observe(toolbar.el);
const tbStyle = document.createElement('style'); tbStyle.textContent = TOOLBAR_CSS + TOOLTIP_CSS; initTooltips(); document.head.appendChild(tbStyle);

const inCell = (): boolean => !!(document.activeElement as HTMLElement | null)?.closest?.('.lm-tablewrap');

function runAction(name: string, arg?: string): void {
  if (!view) return;
  if (name === 'openText') { vscode.postMessage({ type: 'openAsText' }); return; }
  if (inCell()) return; // a table cell has the focus: the editor's own selection is elsewhere, so do nothing
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
  { code: 'KeyC', alt: true, action: 'codeblock' }, { code: 'KeyH', shift: true, action: 'highlight' }, { code: 'KeyC', shift: true, action: 'textcolor' },
];
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
window.addEventListener('keydown', (e) => {
  if (e.isComposing || !(isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) return;
  // Undo / redo: CodeMirror's history, in the editor and in table cells. Stopped here so that VS Code's own
  // forwarding (which would run its native undo) and the inkwell.undo command never also act on this key press.
  const k = e.key.toLowerCase();
  const field = (e.target as HTMLElement | null)?.closest?.('input,textarea,select');
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
