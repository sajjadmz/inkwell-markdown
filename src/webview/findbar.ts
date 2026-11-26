// The find bar: Find / Replace as a compact strip under the toolbar. The search itself lives in findcore.ts; this file is the
// page part: the controls, keyboard, the highlights inside table cells, scrolling to the current match.
import { ChangeSet, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { setTip } from './tooltip';
import { buildVisible, cellEditOffset, findCfg, findField, replaceAll, replaceOne, searchText, visibleTextIn, type FindState } from './findcore';

export interface ActiveCell { wrap: HTMLElement; /** The text selected in the cell (as the cell shows it while focused). */ selected: string }
export interface FindHost {
  view(): EditorView | undefined;
  /** Remembers where the focus and the selection are; returns what puts them back. */
  captureFocus(): () => void;
  /** The table cell that has the focus, if any. */
  activeCell(): ActiveCell | null;
  /** Focuses a table cell of a table widget and selects [a, b) of the text it shows while focused. */
  selectInCell(wrap: HTMLElement, r: number, c: number, a: number, b: number): void;
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const FIND_KEYS = isMac
  ? { find: '⌘F', replace: '⌘⌥F', next: '⌘G', prev: '⌘⇧G' }
  : { find: 'Ctrl+F', replace: 'Ctrl+H', next: 'F3', prev: 'Shift+F3' };

const SVG = (inner: string): string => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICON = {
  up: SVG('<path d="m4 10 4-4 4 4"/>'), down: SVG('<path d="m4 6 4 4 4-4"/>'), close: SVG('<path d="m4 4 8 8M12 4l-8 8"/>'),
  open: SVG('<path d="m6 4 4 4-4 4"/>'),
};
const hasHighlights = (): boolean => typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

/** The visible text of a piece of Markdown (what a reader sees), for pre-filling the Find field from a selection in a cell. */
function visibleOfSource(src: string): string | null {
  if (!src || src.length > 300) return null;
  const st = EditorState.create({ doc: src, extensions: [markdown({ base: markdownLanguage })] });
  const t = buildVisible(st).text.replace(/\n$/, '');
  return t && !t.includes('\n') ? t : null;
}

export class FindBar {
  readonly el = document.createElement('div');
  private readonly input = document.createElement('input');
  private readonly rinput = document.createElement('input');
  private readonly count = document.createElement('span');
  private readonly status = document.createElement('span');
  private readonly btn: Record<string, HTMLButtonElement> = {};
  private opened = false;
  private replaceShown = false;
  private origin = 0;
  private restore: (() => void) | null = null;
  private mo: MutationObserver | null = null;
  private raf = 0;
  private reveal = 0;
  private lastQuery = ''; private lastCase = false; private lastWord = false;
  private edited = false;
  /** Did the user pick a match during this bar session (typed a query, Next / Previous / Enter, Replace)? Only then does closing select it. */
  private moved = false;

  constructor(private readonly host: FindHost) {
    this.el.id = 'lm-find'; this.el.hidden = true; this.el.setAttribute('role', 'search');
    const mk = (act: string, html: string, tip: string, cls = ''): HTMLButtonElement => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'lm-fbtn ' + cls; b.dataset.act = act; b.innerHTML = html; setTip(b, tip);
      this.btn[act] = b; return b;
    };
    const row1 = document.createElement('div'); row1.className = 'lm-find-row';
    const row2 = document.createElement('div'); row2.className = 'lm-find-row lm-find-replace';
    this.input.type = 'text'; this.input.className = 'lm-find-in'; this.input.placeholder = 'Find'; this.input.spellcheck = false; this.input.setAttribute('aria-label', 'Find');
    this.input.autocomplete = 'off'; this.input.setAttribute('autocapitalize', 'off');
    this.rinput.type = 'text'; this.rinput.className = 'lm-find-in'; this.rinput.placeholder = 'Replace with'; this.rinput.spellcheck = false; this.rinput.setAttribute('aria-label', 'Replace with');
    this.rinput.autocomplete = 'off';
    this.count.className = 'lm-find-count'; this.count.setAttribute('aria-live', 'polite');
    this.status.className = 'lm-find-status'; this.status.setAttribute('aria-live', 'polite');
    row1.append(
      mk('toggle', ICON.open, `Show or hide Replace (${FIND_KEYS.replace})`, 'lm-find-toggle'), this.input, this.count,
      mk('prev', ICON.up, `Previous match (${FIND_KEYS.prev}, or Shift+Enter)`), mk('next', ICON.down, `Next match (${FIND_KEYS.next}, or Enter)`),
      mk('case', 'Aa', 'Match case', 'lm-find-opt'), mk('word', '<u>ab</u>', 'Whole words only', 'lm-find-opt'),
      mk('close', ICON.close, 'Close (Esc)'),
    );
    row2.append(this.rinput, mk('replace', 'Replace', 'Replace this match and go to the next (Enter)', 'lm-find-text'), mk('all', 'Replace all', 'Replace every match. One Undo puts them all back.', 'lm-find-text'), this.status);
    this.el.append(row1, row2);
    this.btn.toggle.setAttribute('aria-expanded', 'false'); this.btn.case.setAttribute('aria-pressed', 'false'); this.btn.word.setAttribute('aria-pressed', 'false');

    this.el.addEventListener('mousedown', (e) => { if (!(e.target as HTMLElement).closest('input')) e.preventDefault(); });
    this.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null; if (!b || b.disabled) return;
      this.act(b.dataset.act!);
    });
    this.input.addEventListener('input', () => { this.edited = false; this.moved = true; this.setStatus(''); this.push(); });
    this.rinput.addEventListener('input', () => { this.edited = false; });
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    new ResizeObserver(() => this.layout()).observe(this.el);
  }

  get isOpen(): boolean { return this.opened; }
  /** True right after a Replace: Undo / Redo in the bar's fields then act on the document (until something is typed in a field). */
  get docUndoable(): boolean { return this.edited; }
  private view(): EditorView | undefined { return this.host.view(); }
  private st(): FindState | null { const v = this.view(); return v ? v.state.field(findField) : null; }
  private layout(): void { this.el.dispatchEvent(new Event('lm-find-layout', { bubbles: true })); }

  // ---- opening and closing ----
  /** Cmd/Ctrl+F (replace = false) and Cmd+Alt+F / Ctrl+H (replace = true). */
  show(withReplace: boolean): void {
    const v = this.view(); if (!v) return;
    const fresh = !this.opened;
    if (fresh) { this.restore = this.host.captureFocus(); this.moved = false; }
    // Pre-fill from the selection when it is one line of text.
    let pre: string | null = null; let origin = v.state.selection.main.from;
    const cell = this.host.activeCell();
    if (cell) {
      origin = v.posAtDOM(cell.wrap);
      pre = cell.selected ? visibleOfSource(cell.selected) : null;
    } else {
      const r = v.state.selection.main;
      if (!r.empty) pre = visibleTextIn(buildVisible(v.state), r.from, r.to);
    }
    if (pre && pre.trim() && pre.length <= 200) this.input.value = pre;
    this.origin = origin;
    if (withReplace && !this.replaceShown) this.setReplace(true);
    this.opened = true;
    this.el.hidden = false;
    this.layout();
    requestAnimationFrame(() => this.el.classList.add('open'));
    this.lastQuery = ''; // force a refresh
    this.push(true);
    this.observe(true);
    const target = withReplace && this.input.value ? this.rinput : this.input;
    target.focus(); target.select();
  }

  /**
   * Closes the bar. With `keep`, and only if the user picked a match during this session, that match becomes the selection (Word does
   * this). Otherwise (the bar was only opened, with the remembered query) the selection, caret and focus are put back exactly as they
   * were, so the next keystroke never lands somewhere else.
   */
  close(keep = true): void {
    if (!this.opened) return;
    const v = this.view(); const st = this.st();
    const m = keep && this.moved && st && st.cur >= 0 ? st.matches[st.cur] : null;
    this.opened = false; this.edited = false; this.moved = false; this.observe(false);
    this.el.classList.remove('open'); this.el.hidden = true; this.layout();
    this.clearHighlights();
    this.setStatus('');
    if (v) v.dispatch({ effects: findCfg.of({ active: false }) });
    const back = this.restore; this.restore = null;
    const putBack = (): void => { if (back) back(); else v?.focus(); };
    if (m && v) {
      const cell = m.block.cell;
      if (cell?.widget) {
        // The match is in a table cell: focus that cell with the match selected. If the table is not drawn yet, scroll to it and retry.
        const raw = v.state.sliceDoc(cell.cFrom, cell.cTo);
        const a = cellEditOffset(raw, m.from - cell.cFrom), b = cellEditOffset(raw, m.to - cell.cFrom);
        const place = (tries: number): void => {
          const wrap = this.wrapFor(v, cell.tableFrom);
          if (wrap) { this.host.selectInCell(wrap, cell.r, cell.c, a, b); return; }
          if (tries > 0) requestAnimationFrame(() => place(tries - 1)); else putBack();
        };
        const wrap = this.wrapFor(v, cell.tableFrom);
        if (wrap) place(0); else { v.dispatch({ effects: EditorView.scrollIntoView(cell.tableFrom, { y: 'center' }) }); place(10); }
        return;
      }
      v.dispatch({ selection: { anchor: m.from, head: m.to }, effects: EditorView.scrollIntoView(m.from, { y: 'nearest' }) });
      v.focus(); return;
    }
    putBack();
  }

  private setReplace(on: boolean): void {
    this.replaceShown = on; this.el.classList.toggle('replace', on); this.btn.toggle.setAttribute('aria-expanded', String(on)); this.btn.toggle.classList.toggle('on', on);
    this.layout();
  }

  // ---- actions ----
  /** Presses one of the bar's buttons (also used by the tests). */
  press(a: string): void { this.act(a); }
  private act(a: string): void {
    switch (a) {
      case 'toggle': this.setReplace(!this.replaceShown); (this.replaceShown ? this.rinput : this.input).focus(); break;
      case 'prev': this.navigate(-1); break;
      case 'next': this.navigate(1); break;
      case 'case': this.flip('case'); break;
      case 'word': this.flip('word'); break;
      case 'replace': this.replaceCurrent(); break;
      case 'all': this.replaceEverything(); break;
      case 'close': this.close(true); break;
    }
  }
  private flip(w: 'case' | 'word'): void {
    const b = this.btn[w]; const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(on)); b.classList.toggle('on', on);
    this.setStatus(''); this.push();
  }
  setOption(w: 'case' | 'word', on: boolean): void { if ((this.btn[w].getAttribute('aria-pressed') === 'true') !== on) this.flip(w); }
  setQuery(q: string): void { this.moved = true; this.input.value = q; this.setStatus(''); this.push(); }
  setReplacement(t: string): void { this.rinput.value = t.replace(/[\r\n]+/g, ' '); }
  /** Whether the replace row is showing. */
  get replaceOpen(): boolean { return this.replaceShown; }

  /** Sends the query and the options to the editor state. */
  private push(force = false): void {
    const v = this.view(); if (!v) return;
    const q = this.input.value, mc = this.btn.case.getAttribute('aria-pressed') === 'true', ww = this.btn.word.getAttribute('aria-pressed') === 'true';
    if (!force && q === this.lastQuery && mc === this.lastCase && ww === this.lastWord) return;
    this.lastQuery = q; this.lastCase = mc; this.lastWord = ww;
    v.dispatch({ effects: findCfg.of({ active: this.opened, query: q, matchCase: mc, wholeWord: ww, from: this.origin }) });
    this.revealCurrent();
  }

  navigate(dir: 1 | -1): void {
    if (!this.opened) { this.show(false); return; }
    const v = this.view(); const st = this.st(); if (!v || !st || !st.matches.length) return;
    this.moved = true;
    this.setStatus('');
    const next = (st.cur + dir + st.matches.length) % st.matches.length;
    v.dispatch({ effects: findCfg.of({ cur: next }) });
    this.origin = st.matches[next].from;
    this.revealCurrent();
  }

  private replaceCurrent(): void {
    const v = this.view(); const st = this.st();
    if (!v || !st || st.cur < 0 || !st.vis) return;
    const m = st.matches[st.cur]; const repl = this.rinput.value.replace(/[\r\n]+/g, ' ');
    const edits = replaceOne(v.state, st.vis, m, repl);
    if (!edits) {
      this.navigate(1);
      this.setStatus('Skipped one match: replacing it would break the formatting.');
      return;
    }
    const after = ChangeSet.of(edits, v.state.doc.length).mapPos(m.to, 1);
    v.dispatch({ changes: edits, userEvent: 'input.replace', annotations: isolateHistory.of('full'), effects: findCfg.of({ from: after }) });
    this.moved = true; this.origin = after; this.edited = true;
    this.setStatus('');
    this.revealCurrent();
  }

  private replaceEverything(): void {
    const v = this.view(); const st = this.st();
    if (!v || !st || !st.matches.length || !st.vis) return;
    const repl = this.rinput.value.replace(/[\r\n]+/g, ' ');
    const r = replaceAll(v.state, st.vis, st.matches, repl);
    if (!r.edits.length) { this.setStatus(r.skipped ? `Nothing replaced: ${r.skipped} ${r.skipped === 1 ? 'match' : 'matches'} would break the formatting.` : ''); return; }
    v.dispatch({ changes: r.edits, userEvent: 'input.replace', annotations: isolateHistory.of('full'), effects: findCfg.of({ from: 0 }) });
    this.moved = true; this.origin = 0; this.edited = true;
    this.setStatus(`Replaced ${r.applied}` + (r.skipped ? `, skipped ${r.skipped} that would break the formatting` : ''));
  }

  // ---- keyboard ----
  private onKey(e: KeyboardEvent): void {
    if (e.isComposing) return;
    const t = e.target as HTMLElement;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(true); return; }
    if (e.key === 'Enter' && t === this.input) { e.preventDefault(); e.stopPropagation(); this.navigate(e.shiftKey ? -1 : 1); return; }
    if (e.key === 'Enter' && t === this.rinput) { e.preventDefault(); e.stopPropagation(); if ((e.metaKey || e.ctrlKey) && e.altKey) this.replaceEverything(); else this.replaceCurrent(); }
  }

  // ---- state shown in the bar ----
  private setStatus(s: string): void { this.status.textContent = s; }
  /** Called after every editor update that changed the find state. */
  sync(): void {
    const st = this.st(); if (!st) return;
    const n = st.matches.length;
    this.count.textContent = !this.opened || !st.query ? '' : n ? `${st.cur + 1} of ${n}` : 'No results';
    this.count.classList.toggle('none', this.opened && !!st.query && !n);
    for (const k of ['prev', 'next', 'all']) this.btn[k].disabled = !n;
    this.btn.replace.disabled = st.cur < 0;
    this.scheduleCells();
  }
  get info(): { open: boolean; replaceShown: boolean; counter: string; status: string; query: string; replacement: string; count: number; cur: number; cellHighlights: number; currentHighlights: number; focus: string } {
    const st = this.st();
    return { open: this.opened, replaceShown: this.replaceShown, counter: this.count.textContent ?? '', status: this.status.textContent ?? '', query: this.input.value, replacement: this.rinput.value,
      count: st?.matches.length ?? 0, cur: st?.cur ?? -1, cellHighlights: hasHighlights() ? (CSS.highlights.get('lm-find')?.size ?? 0) : -1, currentHighlights: hasHighlights() ? (CSS.highlights.get('lm-find-cur')?.size ?? 0) : -1,
      focus: document.activeElement === this.input ? 'find' : document.activeElement === this.rinput ? 'replace' : (document.activeElement?.className as string) ?? '' };
  }

  // ---- highlights inside table cells and scrolling ----
  private observe(on: boolean): void {
    this.mo?.disconnect(); this.mo = null;
    if (!on) return;
    this.mo = new MutationObserver(() => this.scheduleCells());
    const root = document.getElementById('root'); if (root) this.mo.observe(root, { childList: true, subtree: true, characterData: true });
  }
  private scheduleCells(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.paintCells(); });
  }
  private clearHighlights(): void { if (hasHighlights()) { CSS.highlights.delete('lm-find'); CSS.highlights.delete('lm-find-cur'); } }
  private wrapFor(v: EditorView, tableFrom: number): HTMLElement | null {
    for (const w of document.querySelectorAll('.lm-tablewrap')) { try { if (v.posAtDOM(w) === tableFrom) return w as HTMLElement; } catch { /* not in the view */ } }
    return null;
  }

  /** Marks the matches that are in table cells (the editor marks all the others itself). */
  private paintCells(): void {
    if (!hasHighlights()) return;
    const v = this.view(); const st = this.st();
    if (!v || !st || !this.opened || !st.vis || !st.matches.some((m) => m.block.cell?.widget)) { this.clearHighlights(); return; }
    const all: Range[] = []; const cur: Range[] = [];
    const wraps = new Map<number, HTMLElement>();
    for (const w of document.querySelectorAll('.lm-tablewrap')) { try { wraps.set(v.posAtDOM(w), w as HTMLElement); } catch { /* not in the view */ } }
    const byCell = new Map<string, number[]>();
    st.matches.forEach((m, i) => { const c = m.block.cell; if (c?.widget) { const k = `${c.tableFrom}:${c.r}:${c.c}`; (byCell.get(k) ?? byCell.set(k, []).get(k)!).push(i); } });
    for (const [k, idx] of byCell) {
      const [tf, r, c] = k.split(':').map(Number);
      const wrap = wraps.get(tf); const el = wrap?.querySelector(`[data-r="${r}"][data-c="${c}"]`) as HTMLElement | null;
      if (!el || el.dataset.editing === '1') continue;
      const block = st.matches[idx[0]].block;
      const dom = domText(el);
      const vtext = st.vis.text.slice(block.start, block.end);
      let spans: Array<[number, number]>;
      if (dom.text === vtext) spans = idx.map((i) => [st.matches[i].s - block.start, st.matches[i].e - block.start] as [number, number]);
      else { const found = searchText(dom.text, st.query, st); if (found.length !== idx.length) continue; spans = found; }
      spans.forEach(([s, e], n) => {
        if (e <= s || !dom.nodes[s] || !dom.nodes[e - 1]) return;
        const rg = document.createRange(); rg.setStart(dom.nodes[s]!.node, dom.nodes[s]!.off); rg.setEnd(dom.nodes[e - 1]!.node, dom.nodes[e - 1]!.off + 1);
        (idx[n] === st.cur ? cur : all).push(rg);
      });
    }
    const a = new Highlight(...all, ...cur); const b = new Highlight(...cur); b.priority = 1;
    CSS.highlights.set('lm-find', a); CSS.highlights.set('lm-find-cur', b);
    if (this.reveal && cur.length) { this.reveal = 0; this.scrollTo(cur[0].getBoundingClientRect()); }
  }

  /** Brings the current match into view: the editor scrolls to it; for a table cell the page is scrolled once the cell is drawn. */
  private revealCurrent(): void {
    const v = this.view(); const st = this.st(); if (!v || !st || st.cur < 0) return;
    const m = st.matches[st.cur];
    if (m.block.cell?.widget) {
      this.reveal = 1; setTimeout(() => { this.reveal = 0; }, 1500);
      v.dispatch({ effects: EditorView.scrollIntoView(m.block.cell.tableFrom, { y: 'center' }) });
      this.scheduleCells();
    } else v.dispatch({ effects: EditorView.scrollIntoView(m.from, { y: 'center' }) });
  }
  private scrollTo(r: DOMRect): void {
    const top = (Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lm-tbh')) || 40) + 12;
    if (r.top < top || r.bottom > window.innerHeight - 12) window.scrollBy({ top: r.top - window.innerHeight / 2 + r.height / 2 });
  }
}

/** The text of a rendered cell, one entry per character telling which text node it is in (a <br> counts as a line break). */
function domText(el: HTMLElement): { text: string; nodes: Array<{ node: Text; off: number } | null> } {
  let text = ''; const nodes: Array<{ node: Text; off: number } | null> = [];
  const walk = (n: Node): void => {
    if (n.nodeType === 3) { const d = (n as Text).data; for (let i = 0; i < d.length; i++) { text += d[i]; nodes.push({ node: n as Text, off: i }); } }
    else if ((n as HTMLElement).tagName === 'BR') { text += '\n'; nodes.push(null); }
    else n.childNodes.forEach(walk);
  };
  el.childNodes.forEach(walk);
  return { text, nodes };
}

export const FIND_CSS = `
#lm-find { position: fixed; top: var(--lm-tbtop, 40px); left: 0; right: 0; z-index: 49; box-sizing: border-box; padding: 5px 8px; display: flex; flex-direction: column; gap: 4px;
  font: 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: var(--lm-fg, #333); user-select: none;
  background: color-mix(in srgb, var(--lm-bg, #fff) 94%, var(--lm-fg, #333)); border-bottom: 1px solid color-mix(in srgb, var(--lm-fg, #333) 18%, transparent);
  transform: translateY(-8px); opacity: 0; transition: transform .14s ease-out, opacity .14s ease-out; }
#lm-find.open { transform: none; opacity: 1; }
#lm-find[hidden] { display: none; }
#lm-find .lm-find-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
#lm-find .lm-find-replace { display: none; padding-left: 30px; }
#lm-find.replace .lm-find-replace { display: flex; }
#lm-find .lm-find-in { all: unset; box-sizing: border-box; flex: 1 1 180px; min-width: 110px; max-width: 360px; height: 26px; padding: 0 8px; border-radius: 5px; user-select: text; cursor: text;
  font: 13px/26px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: var(--lm-fg, #333); background: var(--lm-bg, #fff); border: 1px solid color-mix(in srgb, var(--lm-fg, #333) 28%, transparent); }
#lm-find .lm-find-in:focus { border-color: rgba(56, 139, 253, .9); box-shadow: 0 0 0 1px rgba(56, 139, 253, .6); }
#lm-find .lm-find-in::placeholder { color: color-mix(in srgb, var(--lm-fg, #333) 50%, transparent); }
#lm-find .lm-find-count { min-width: 58px; padding: 0 4px; white-space: nowrap; opacity: .75; }
#lm-find .lm-find-count.none { color: #d1242f; opacity: 1; }
.lm-dark-page #lm-find .lm-find-count.none { color: #ff7b72; }
#lm-find .lm-find-status { padding: 0 6px; opacity: .85; }
#lm-find .lm-fbtn { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; min-width: 26px; height: 26px; padding: 0 5px; border-radius: 5px; cursor: pointer; color: inherit; white-space: nowrap; }
#lm-find .lm-fbtn:hover:not(:disabled) { background: color-mix(in srgb, var(--lm-fg, #333) 14%, transparent); }
#lm-find .lm-fbtn:focus-visible { outline: 2px solid rgba(56, 139, 253, .8); }
#lm-find .lm-fbtn:disabled { opacity: .35; cursor: default; }
#lm-find .lm-fbtn.on { background: color-mix(in srgb, var(--lm-fg, #333) 24%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--lm-fg, #333) 35%, transparent); }
#lm-find .lm-find-opt { font-weight: 600; }
#lm-find .lm-find-text { padding: 0 9px; border: 1px solid color-mix(in srgb, var(--lm-fg, #333) 25%, transparent); }
#lm-find .lm-find-toggle svg { transition: transform .12s; }
#lm-find .lm-find-toggle.on svg { transform: rotate(90deg); }
.cm-content .lm-find { background: rgba(255, 213, 0, .45); border-radius: 2px; color: inherit; }
.cm-content .lm-find.lm-find-cur { background: rgba(255, 140, 0, .8); box-shadow: 0 0 0 1px rgba(200, 90, 0, .9); }
.lm-dark-page .cm-content .lm-find { background: rgba(255, 213, 0, .32); }
.lm-dark-page .cm-content .lm-find.lm-find-cur { background: rgba(255, 150, 20, .72); box-shadow: 0 0 0 1px rgba(255, 190, 80, .9); }
::highlight(lm-find) { background-color: rgba(255, 213, 0, .45); color: inherit; }
::highlight(lm-find-cur) { background-color: rgba(255, 140, 0, .8); color: inherit; }
.lm-dark-page ::highlight(lm-find) { background-color: rgba(255, 213, 0, .32); }
.lm-dark-page ::highlight(lm-find-cur) { background-color: rgba(255, 150, 20, .72); }
@media (max-width: 520px) { #lm-find .lm-find-in { max-width: none; } #lm-find .lm-find-replace { padding-left: 0; } }
`;
