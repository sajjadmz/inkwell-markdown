// Mermaid diagrams as block widgets. Rendering is asynchronous and debounced; the last good diagram stays
// on screen while the text has a mistake, with the error underneath. The document is never touched.
import { WidgetType, type EditorView } from '@codemirror/view';
import mermaid from 'mermaid';

let dark = false;
let seq = 0;
const byCode = new Map<string, string>(); // source -> svg
const lastGood = new Map<number, string>(); // block index -> svg
interface Live { wrap: HTMLElement; body: HTMLElement; err: HTMLElement; code: string; view: EditorView }
const live = new Map<number, Live>();
const timers = new Map<number, number>();

export function setMermaidDark(d: boolean): boolean {
  if (d === dark) return false;
  dark = d; byCode.clear(); lastGood.clear();
  return true;
}

function init(): void { mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' }); }

/** Renders `code` to SVG text, or throws mermaid's error. */
export async function renderMermaid(code: string): Promise<string> {
  init();
  await mermaid.parse(code);
  const id = 'lm-mmd-' + ++seq;
  try { return (await mermaid.render(id, code)).svg; } finally { document.getElementById('d' + id)?.remove(); document.getElementById(id)?.remove(); }
}

export async function parseMermaid(code: string): Promise<void> { init(); await mermaid.parse(code); }

function schedule(key: number, code: string, delay: number): void {
  const old = timers.get(key); if (old !== undefined) clearTimeout(old);
  timers.set(key, window.setTimeout(async () => {
    timers.delete(key);
    let svg: string | null = null; let error = '';
    try { svg = await renderMermaid(code); } catch (e) { error = String((e as Error)?.message ?? e).split('\n').slice(0, 4).join('\n').slice(0, 400) || 'Diagram error'; }
    const l = live.get(key);
    if (svg !== null) { byCode.set(code, svg); lastGood.set(key, svg); }
    if (!l || l.code !== code) return; // superseded by newer text
    if (svg !== null) { l.body.innerHTML = svg; l.err.textContent = ''; } else l.err.textContent = error;
    l.view.requestMeasure();
  }, delay));
}

export class MermaidWidget extends WidgetType {
  constructor(readonly code: string, readonly key: number, readonly below: boolean) { super(); }
  eq(o: MermaidWidget): boolean { return o.code === this.code && o.key === this.key && o.below === this.below; }
  get estimatedHeight(): number { return 180; }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'lm-mermaid' + (this.below ? ' lm-mermaid-below' : '');
    wrap.contentEditable = 'false';
    const body = document.createElement('div'); body.className = 'lm-mmd-svg';
    const err = document.createElement('div'); err.className = 'lm-mmd-err';
    wrap.append(body, err);
    const cached = byCode.get(this.code);
    const prev = lastGood.get(this.key);
    if (cached) body.innerHTML = cached; else if (prev) body.innerHTML = prev;
    live.set(this.key, { wrap, body, err, code: this.code, view });
    if (!cached) schedule(this.key, this.code, prev ? 300 : 0);
    if (!this.below) {
      wrap.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const from = view.posAtDOM(wrap);
        const doc = view.state.doc;
        const line = doc.lineAt(from);
        const next = doc.line(Math.min(doc.lines, line.number + 1));
        view.dispatch({ selection: { anchor: next.from } });
        view.focus();
      });
    }
    return wrap;
  }
  destroy(dom: HTMLElement): void {
    const l = live.get(this.key);
    if (l && l.wrap === dom) { live.delete(this.key); }
  }
  ignoreEvent(): boolean { return true; }
}
