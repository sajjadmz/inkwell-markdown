// The fixed toolbar. Buttons never take focus (mousedown is cancelled), so the editor's selection is untouched.
import { TEXT_COLOURS, HIGHLIGHTS, LANGUAGES, DIAGRAMS } from './format';
import { setTip } from './tooltip';

export interface ToolbarHost {
  run(name: string, arg?: string): void;
  openText(): void;
  setTheme(value: string): void;
}
export interface ToolbarState { bold: boolean; italic: boolean; strike: boolean; code: boolean; heading: number; list: string | null; quote: boolean; codeblock: boolean }

const svg = (body: string) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const txt = (t: string, extra = '') => svg(`<text x="8" y="12.5" text-anchor="middle" font-size="12" font-family="Georgia,serif" fill="currentColor" stroke="none" ${extra}>${t}</text>`);
const ICON: Record<string, string> = {
  heading: txt('H', 'font-family="system-ui,sans-serif" font-weight="700"'),
  bold: txt('B', 'font-family="system-ui,sans-serif" font-weight="800"'),
  italic: txt('I', 'font-style="italic"'),
  strike: svg('<path d="M3 8h10"/><path d="M10.5 4.5C10 3.6 9 3.2 8 3.2c-1.6 0-2.6.8-2.6 2 0 .8.5 1.4 1.4 1.8M5.5 11.5c.5.9 1.4 1.3 2.6 1.3 1.6 0 2.6-.8 2.6-2 0-.6-.3-1.1-.8-1.4"/>'),
  textcolor: svg('<path d="M4.5 11.5 8 3l3.5 8.5M5.6 8.8h4.8"/>'),
  highlight: svg('<path d="M9.5 3 13 6.5 7 12.5H4v-3z"/><path d="M2.5 14.2h11" stroke-width="2"/>'),
  code: svg('<path d="m5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>'),
  link: svg('<path d="M6.8 9.2a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-.7.7M9.2 6.8a2.5 2.5 0 0 0-3.5 0l-2 2a2.5 2.5 0 0 0 3.5 3.5l.7-.7"/>'),
  bullets: svg('<circle cx="3" cy="4" r=".8" fill="currentColor"/><circle cx="3" cy="8" r=".8" fill="currentColor"/><circle cx="3" cy="12" r=".8" fill="currentColor"/><path d="M6.5 4h7M6.5 8h7M6.5 12h7"/>'),
  numbered: svg('<text x="1" y="5.5" font-size="5" fill="currentColor" stroke="none">1</text><text x="1" y="9.5" font-size="5" fill="currentColor" stroke="none">2</text><text x="1" y="13.5" font-size="5" fill="currentColor" stroke="none">3</text><path d="M6.5 4h7M6.5 8h7M6.5 12h7"/>'),
  checklist: svg('<rect x="1.8" y="2.5" width="3.4" height="3.4" rx=".6"/><path d="m2.5 4.3.8.8 1.4-1.6M6.5 4.2h7M6.5 9h7M6.5 13h7"/><rect x="1.8" y="7.3" width="3.4" height="3.4" rx=".6"/>'),
  quote: svg('<path d="M3 4v8M6.5 5h7M6.5 8h7M6.5 11h5"/>'),
  codeblock: svg('<rect x="1.8" y="2.5" width="12.4" height="11" rx="1.5"/><path d="m5.5 6.2-1.8 1.8 1.8 1.8M10.5 6.2l1.8 1.8-1.8 1.8"/>'),
  table: svg('<rect x="1.8" y="2.5" width="12.4" height="11" rx="1.2"/><path d="M1.8 6.5h12.4M1.8 10h12.4M6 2.5v11M10.2 2.5v11"/>'),
  diagram: svg('<rect x="1.8" y="2" width="5" height="3.4" rx=".8"/><rect x="9.2" y="10.6" width="5" height="3.4" rx=".8"/><path d="M4.3 5.4v3.3h7.4v1.9"/>'),
  hr: svg('<path d="M2 8h12"/>'),
  page: svg('<circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor"/>'),
  plain: svg('<path d="M4 1.8h5.5L12.5 5v9.2H4z"/><path d="M9.5 1.8V5h3M6 8h4.5M6 10.5h4.5"/>'),
  caret: svg('<path d="m4.5 6.5 3.5 3.5 3.5-3.5"/>'),
};

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** Shortcut label per OS: ⌘⇧B on macOS, Ctrl+Shift+B elsewhere. `alt` shortcuts add Shift off-Mac (AltGr clash). */
export const keyLabel = (key: string, o: { shift?: boolean; alt?: boolean } = {}): string => isMac
  ? `⌘${o.shift ? '⇧' : ''}${o.alt ? '⌥' : ''}${key}`
  : `Ctrl+${o.shift || o.alt ? 'Shift+' : ''}${o.alt ? 'Alt+' : ''}${key}`;
const k = keyLabel;
const TIP: Record<string, string> = {
  bold: `Bold (${k('B')})`, italic: `Italic (${k('I')})`, strike: `Strikethrough (${k('X', { shift: true })})`, code: `Inline code (${k('E')})`, link: `Link (${k('K')})`,
  bullets: `Bulleted list (${k('8', { shift: true })})`, numbered: `Numbered list (${k('7', { shift: true })})`, checklist: `Checklist (${k('9', { shift: true })})`, quote: `Quote (${k('.', { shift: true })})`,
  codeblock: `Code block (${k('C', { alt: true })})`, table: 'Insert table (3 × 2)', hr: 'Horizontal rule', plain: `Open as plain text (${k('V', { shift: true })})`,
};

export class Toolbar {
  readonly el = document.createElement('div');
  private readonly buttons = new Map<string, HTMLElement>();
  private heading!: HTMLElement;
  private menu: HTMLElement | null = null;
  private themes: string[] = []; private currentTheme = 'auto';
  lastText = TEXT_COLOURS[0].value; lastHighlight = HIGHLIGHTS[0].value;
  onColour: (kind: 'text' | 'highlight', v: string) => void = () => {};

  constructor(private readonly host: ToolbarHost, last?: { text?: string; highlight?: string }) {
    if (last?.text) this.lastText = last.text;
    if (last?.highlight) this.lastHighlight = last.highlight;
    this.el.id = 'lm-toolbar';
    this.el.setAttribute('role', 'toolbar');
    this.el.addEventListener('mousedown', (e) => { e.preventDefault(); });
    document.addEventListener('mousedown', (e) => { if (this.menu && !this.menu.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('[data-menu]')) this.closeMenu(); }, true);
    this.build();
  }

  private btn(name: string, icon: string, tip: string, onClick: (b: HTMLElement) => void, extra = ''): HTMLElement {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'lm-tb ' + extra; setTip(b, tip.replace(/ \((.*)\)$/, '  $1'), tip.replace(/ \(.*\)$/, ''));
    b.dataset.action = name; b.innerHTML = icon;
    b.addEventListener('click', () => onClick(b));
    this.buttons.set(name, b); this.el.appendChild(b);
    return b;
  }
  private sep(): void { const s = document.createElement('span'); s.className = 'lm-sep'; this.el.appendChild(s); }
  private plainBtn(name: string): void { this.btn(name, ICON[name], TIP[name], () => this.host.run(name)); }

  private build(): void {
    // Heading menu
    this.heading = this.btn('heading', ICON.heading + '<span class="lm-hlabel">Normal</span>' + ICON.caret, 'Heading', (b) => this.openMenu(b, [
      { label: 'Heading 1', hint: k('1', { alt: true }), run: () => this.host.run('h1') }, { label: 'Heading 2', hint: k('2', { alt: true }), run: () => this.host.run('h2') },
      { label: 'Heading 3', hint: k('3', { alt: true }), run: () => this.host.run('h3') }, { label: 'Normal text', hint: k('0', { alt: true }), run: () => this.host.run('h0') },
    ]), 'lm-wide');
    this.heading.dataset.menu = '1';
    this.sep();
    for (const n of ['bold', 'italic', 'strike']) this.plainBtn(n);
    this.colourButton('textcolor', 'Text colour', TEXT_COLOURS, 'text', `Text colour (${k('C', { shift: true })})`);
    this.colourButton('highlight', 'Highlighter', HIGHLIGHTS, 'highlight', `Highlighter (${k('H', { shift: true })})`);
    this.plainBtn('code'); this.plainBtn('link');
    this.sep();
    for (const n of ['bullets', 'numbered', 'checklist', 'quote']) this.plainBtn(n);
    this.sep();
    this.plainBtn('codeblock');
    const cb = this.btn('codeblock-lang', ICON.caret, 'Code block language', (b) => this.openMenu(b, LANGUAGES.map((l) => ({ label: l, run: () => this.host.run('codeblock', l) }))), 'lm-caret');
    cb.dataset.menu = '1';
    this.plainBtn('table');
    const dg = this.btn('diagram', ICON.diagram + ICON.caret, 'Insert diagram', (b) => this.openMenu(b, Object.entries(DIAGRAMS).map(([k, d]) => ({ label: d.label, run: () => this.host.run('diagram', k) }))), 'lm-wide');
    dg.dataset.menu = '1';
    this.plainBtn('hr');
    this.sep();
    const pg = this.btn('page', ICON.page + ICON.caret, 'Page style', (b) => this.openMenu(b, [{ label: 'Auto (follow VS Code)', run: () => this.host.setTheme('auto'), checked: this.currentTheme === 'auto' },
      ...this.themes.map((t) => ({ label: t.replace(/\.css$/, ''), run: () => this.host.setTheme(t), checked: t === this.currentTheme }))]), 'lm-wide');
    pg.dataset.menu = '1';
    this.plainBtn('plain');
  }

  private colourButton(name: string, label: string, palette: Array<{ name: string; value: string }>, kind: 'text' | 'highlight', tip: string): void {
    const main = this.btn(name, ICON[name] + '<i class="lm-swatch"></i>', tip, () => this.host.run(name), 'lm-split-l');
    const set = () => { (main.querySelector('.lm-swatch') as HTMLElement).style.background = kind === 'text' ? this.lastText : this.lastHighlight; };
    set();
    const items = () => [
      ...palette.map((c) => ({ label: c.name, swatch: c.value, run: () => { if (kind === 'text') this.lastText = c.value; else this.lastHighlight = c.value; set(); this.onColour(kind, c.value); this.host.run('colour:' + kind, c.value); } })),
      { label: 'No colour', run: () => this.host.run('colour:' + kind, 'none') },
    ];
    const caret = this.btn(name + '-menu', ICON.caret, 'Choose ' + label.toLowerCase(), (b) => this.openMenu(b, items()), 'lm-split-r lm-caret');
    caret.dataset.menu = '1';
    (main as HTMLElement & { refresh?: () => void }).refresh = set;
  }

  refreshSwatches(): void { for (const n of ['textcolor', 'highlight']) (this.buttons.get(n) as (HTMLElement & { refresh?: () => void }) | undefined)?.refresh?.(); }

  setThemes(list: string[], current: string): void { this.themes = list; this.currentTheme = current; }

  private openMenu(anchor: HTMLElement, items: Array<{ label: string; hint?: string; swatch?: string; checked?: boolean; run: () => void }>): void {
    const had = this.menu && this.menu.dataset.for === anchor.dataset.action;
    this.closeMenu();
    if (had) return;
    const m = document.createElement('div');
    m.className = 'lm-menu'; m.dataset.for = anchor.dataset.action ?? '';
    for (const it of items) {
      const row = document.createElement('div'); row.className = 'lm-mi';
      if (it.swatch) { const s = document.createElement('i'); s.className = 'lm-swatch lg'; s.style.background = it.swatch; row.appendChild(s); }
      const l = document.createElement('span'); l.textContent = (it.checked ? '✓ ' : '') + it.label; row.appendChild(l);
      if (it.hint) { const h = document.createElement('em'); h.textContent = it.hint; row.appendChild(h); }
      setTip(row, it.hint ? `${it.label}  ${it.hint}` : it.label, it.label); row.removeAttribute('aria-label');
      row.addEventListener('click', () => { this.closeMenu(); it.run(); });
      m.appendChild(row);
    }
    m.addEventListener('mousedown', (e) => e.preventDefault());
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(r.left, window.innerWidth - m.offsetWidth - 4)) + 'px';
    m.style.top = r.bottom + 2 + 'px';
    this.menu = m;
  }
  closeMenu(): void { this.menu?.remove(); this.menu = null; }

  /** Highlights the buttons that are active at the selection. */
  update(s: ToolbarState): void {
    const on = (n: string, v: boolean) => this.buttons.get(n)?.classList.toggle('active', v);
    on('bold', s.bold); on('italic', s.italic); on('strike', s.strike); on('code', s.code);
    on('bullets', s.list === 'bullets'); on('numbered', s.list === 'numbered'); on('checklist', s.list === 'checklist');
    on('quote', s.quote); on('codeblock', s.codeblock); on('heading', s.heading > 0);
    const l = this.heading.querySelector('.lm-hlabel'); if (l) l.textContent = s.heading ? 'H' + s.heading : 'Normal';
  }
}

export const TOOLBAR_CSS = `
#lm-toolbar { position: fixed; top: 0; left: 0; right: 0; z-index: 50; display: flex; flex-wrap: wrap; align-items: center; gap: 2px; padding: 4px 8px; box-sizing: border-box;
  font: 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: var(--lm-fg, #333);
  background: color-mix(in srgb, var(--lm-bg, #fff) 94%, var(--lm-fg, #333)); border-bottom: 1px solid color-mix(in srgb, var(--lm-fg, #333) 18%, transparent); user-select: none; }
#lm-toolbar .lm-tb { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 2px; min-width: 28px; height: 28px; padding: 0 5px; border-radius: 5px; cursor: pointer; color: inherit; position: relative; }
#lm-toolbar .lm-tb:hover { background: color-mix(in srgb, var(--lm-fg, #333) 12%, transparent); }
#lm-toolbar .lm-tb.active { background: color-mix(in srgb, var(--lm-fg, #333) 22%, transparent); }
#lm-toolbar .lm-tb svg { display: block; flex: none; }
#lm-toolbar .lm-tb.lm-wide { min-width: 0; }
#lm-toolbar .lm-hlabel { min-width: 38px; text-align: left; padding-left: 2px; }
#lm-toolbar .lm-caret { min-width: 16px; padding: 0 1px; }
#lm-toolbar .lm-split-l { padding-right: 1px; } #lm-toolbar .lm-split-r { margin-left: -3px; }
#lm-toolbar .lm-swatch { position: absolute; left: 7px; right: 7px; bottom: 3px; height: 3px; border-radius: 1px; }
#lm-toolbar .lm-sep { width: 1px; height: 18px; margin: 0 5px; background: color-mix(in srgb, var(--lm-fg, #333) 25%, transparent); }
.lm-menu { position: fixed; z-index: 60; min-width: 150px; padding: 4px; border-radius: 6px; font: 12.5px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: var(--lm-fg, #333);
  background: var(--lm-bg, #fff); border: 1px solid color-mix(in srgb, var(--lm-fg, #333) 25%, transparent); box-shadow: 0 6px 18px rgba(0,0,0,.25); max-height: 70vh; overflow: auto; }
.lm-menu .lm-mi { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 4px; cursor: pointer; white-space: nowrap; }
.lm-menu .lm-mi:hover { background: color-mix(in srgb, var(--lm-fg, #333) 14%, transparent); }
.lm-menu .lm-mi em { margin-left: auto; padding-left: 16px; font-style: normal; opacity: .55; }
.lm-menu .lm-swatch.lg { display: inline-block; width: 14px; height: 14px; border-radius: 3px; border: 1px solid color-mix(in srgb, var(--lm-fg, #333) 30%, transparent); }
`;
