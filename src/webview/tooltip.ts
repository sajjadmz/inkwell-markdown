// Custom tooltips. Native `title` tooltips are slow or missing in VS Code webviews, so every control carries a
// `data-tip` attribute and one delegated listener shows a small hover note. The note never takes focus
// (pointer-events: none, no focusable content), so it cannot change the editor selection or block a click.
const DELAY = 300;
let tip: HTMLElement | null = null;
let current: HTMLElement | null = null;
let timer: number | undefined;

/** Give a control its hover note (and an accessible name); the native title is removed so there is no double tooltip. */
export function setTip(el: HTMLElement, text: string, aria?: string): void {
  el.dataset.tip = text;
  el.removeAttribute('title');
  el.setAttribute('aria-label', aria ?? text.replace(/\s{2,}.*$/, ''));
}

function hide(): void {
  clearTimeout(timer); timer = undefined; current = null;
  if (tip) tip.hidden = true;
}

function show(el: HTMLElement): void {
  if (!el.isConnected) { hide(); return; }
  if (!tip) {
    tip = document.createElement('div'); tip.className = 'lm-tooltip'; tip.setAttribute('role', 'tooltip'); tip.hidden = true;
    document.body.appendChild(tip);
  }
  tip.textContent = el.dataset.tip ?? '';
  tip.hidden = false;
  const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
  const left = Math.max(4, Math.min(r.left + r.width / 2 - w / 2, vw - w - 4));
  let top = r.bottom + 6;
  if (top + h > vh - 4) top = Math.max(4, r.top - h - 6); // no room below: flip above
  tip.style.left = left + 'px'; tip.style.top = top + 'px';
}

export function initTooltips(): void {
  document.addEventListener('mouseover', (e) => {
    const el = (e.target as HTMLElement | null)?.closest?.('[data-tip]') as HTMLElement | null;
    if (el === current) return;
    if (!el) { hide(); return; }
    const visible = !!tip && !tip.hidden;
    clearTimeout(timer); current = el;
    if (visible) show(el); // moving between controls: the new note appears at once
    else timer = window.setTimeout(() => { if (current === el) show(el); }, DELAY);
  }, true);
  document.addEventListener('mouseout', (e) => {
    const rel = (e as MouseEvent).relatedTarget as HTMLElement | null;
    if (current && !(rel && current.contains(rel))) { if (!rel?.closest?.('[data-tip]')) hide(); }
  }, true);
  for (const t of ['mousedown', 'click', 'wheel', 'keydown', 'blur']) window.addEventListener(t, (e) => { if (t !== 'keydown' || (e as KeyboardEvent).key === 'Escape') hide(); }, true);
  window.addEventListener('scroll', hide, true);
}

export const TOOLTIP_CSS = `
.lm-tooltip { position: fixed; z-index: 100; pointer-events: none; max-width: 280px; padding: 4px 8px; border-radius: 4px; white-space: pre; box-sizing: border-box;
  font: 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: var(--vscode-editorHoverWidget-foreground, #1f1f1f); background: var(--vscode-editorHoverWidget-background, #f3f3f3);
  border: 1px solid var(--vscode-editorHoverWidget-border, rgba(128,128,128,.45)); box-shadow: 0 2px 8px rgba(0,0,0,.25); }
.lm-tooltip[hidden] { display: none; }
`;
