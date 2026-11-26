// Formatting inside a table cell. A cell shows its Markdown source as plain text (each <br> as a line break). Instead of
// editing that string by hand, the cell's source goes into a throwaway CodeMirror state with the same Markdown parser as the
// editor, the very same format.ts function runs on it, and the result is turned back into the displayed text. So a cell
// behaves exactly like the editor: Word-style toggling, merging, partial overlaps, links, colours, toolbar state.
import { EditorSelection, EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import * as F from './format';
import { fromEdit, toEdit } from './livepreview';

export interface CellResult { text: string; a: number; b: number }
export interface CellInline { bold: boolean; italic: boolean; strike: boolean; code: boolean; list: string | null }

/** Source (with <br>) behind the displayed text, and the offset mapping both ways. */
function displayedToSource(d: string): { src: string; at(n: number): number } {
  const src = fromEdit(d);
  const last = d.replace(/\r\n/g, '\n').endsWith('\n') ? d.length - 1 : -1; // the one final line break that is never content
  return {
    src,
    at(n: number): number {
      let s = 0;
      for (let k = 0; k < Math.min(n, d.length); k++) s += d[k] === '\n' ? (k === last ? 0 : 4) : 1;
      return Math.min(s, src.length);
    },
  };
}
function sourceToDisplayed(src: string, p: number): number {
  let d = 0;
  for (let i = 0; i < p;) { if (src.startsWith('<br>', i)) { d++; i += 4; } else { d++; i++; } }
  return d;
}

function makeState(src: string, a: number, b: number): EditorState {
  const st = EditorState.create({ doc: src, selection: EditorSelection.single(a, b), extensions: [markdown({ base: markdownLanguage, addKeymap: false })] });
  ensureSyntaxTree(st, st.doc.length, 5000);
  return st;
}

const PREFIX = /^(- |\d+\. |☐ |☑ )/;
const LIST_RE = { bullets: /^- /, numbered: /^\d+\. /, checklist: /^[☐☑] / } as const;

/** Toolbar state at the cell's cursor, from the same parse the editor would use. */
export function cellInline(displayed: string, a: number, b: number): CellInline {
  const m = displayedToSource(displayed);
  const st = makeState(m.src, m.at(a), m.at(b));
  const act = F.activeInline(st);
  const line = displayed.slice(b > 0 ? displayed.lastIndexOf('\n', b - 1) + 1 : 0);
  const list = LIST_RE.bullets.test(line) ? 'bullets' : LIST_RE.numbered.test(line) ? 'numbered' : LIST_RE.checklist.test(line) ? 'checklist' : null;
  return { ...act, list };
}

/**
 * List prefixes go at the start of each line, before any inline markup. A bold/italic/colour run that carries over a line
 * break is closed at the end of the previous line and reopened after the prefix, so the prefix is never inside it.
 */
function cellList(src: string, kind: 'bullets' | 'numbered' | 'checklist'): string {
  const lines = src.split('<br>');
  const re = LIST_RE[kind];
  const on = lines.every((l) => re.test(l));
  if (on) return lines.map((l) => l.replace(re, '')).join('<br>');
  const st = makeState(src, 0, 0);
  const wraps: Array<{ openText: string; closeText: string; from: number; to: number; openTo: number; closeFrom: number }> = [];
  for (const k of ['bold', 'italic', 'strike'] as F.Inline[]) for (const r of F.inlineRegions(st, k, 0, src.length)) wraps.push({ ...r, openTo: r.open.to, closeFrom: r.close.from });
  for (const p of F.findColourPairs(src)) wraps.push({ openText: src.slice(p.open.from, p.open.to), closeText: src.slice(p.close.from, p.close.to), from: p.open.from, to: p.close.to, openTo: p.open.to, closeFrom: p.close.from });
  const out: string[] = [];
  let pos = 0; // source offset of the start of the current line
  lines.forEach((l, i) => {
    const prefix = kind === 'bullets' ? '- ' : kind === 'numbered' ? `${i + 1}. ` : '☐ ';
    const body = l.replace(PREFIX, '');
    let lead = '';
    if (i > 0 && !PREFIX.test(l)) {
      const sepFrom = pos - 4, sepTo = pos;
      const enclosing = wraps.filter((w) => w.openTo <= sepFrom && w.closeFrom >= sepTo).sort((x, y) => x.from - y.from || y.to - x.to);
      if (enclosing.length) {
        const closers = [...enclosing].reverse().map((w) => w.closeText).join('');
        const tail = /[ \t]*$/.exec(out[i - 1])![0];
        out[i - 1] = out[i - 1].slice(0, out[i - 1].length - tail.length) + closers + tail;
        lead = enclosing.map((w) => w.openText).join('');
      }
    }
    out.push(prefix + lead + body);
    pos += l.length + 4; // `pos` follows the ORIGINAL source
  });
  return out.join('<br>');
}

/** Runs one toolbar action on the cell's displayed text and selection. Returns null when there is nothing to change. */
export function cellFormat(displayed: string, a: number, b: number, name: string, arg: string | undefined, lastText: string, lastHighlight: string): CellResult | null {
  const m = displayedToSource(displayed);
  let src2: string; let sa: number, sb: number;
  const list = name === 'bullets' || name === 'numbered' || name === 'checklist' ? name : null;
  if (list) {
    src2 = cellList(m.src, list); sa = 0; sb = src2.length;
  } else {
    const st = makeState(m.src, m.at(a), m.at(b));
    let spec;
    switch (name) {
      case 'bold': spec = F.toggleInline(st, 'bold'); break;
      case 'italic': spec = F.toggleInline(st, 'italic'); break;
      case 'strike': spec = F.toggleInline(st, 'strike'); break;
      case 'code': case 'codeblock': spec = F.toggleInline(st, 'code'); break; // a code block cannot live in a cell: inline code
      case 'link': spec = F.setLink(st); break; // same 'url' placeholder as in normal text
      case 'textcolor': spec = F.applyColour(st, 'text', lastText); break;
      case 'highlight': spec = F.applyColour(st, 'highlight', lastHighlight); break;
      case 'colour:text': spec = F.applyColour(st, 'text', arg === 'none' ? null : arg!); break;
      case 'colour:highlight': spec = F.applyColour(st, 'highlight', arg === 'none' ? null : arg!); break;
      default: return null;
    }
    const tr = st.update(spec);
    src2 = tr.newDoc.toString();
    const r = tr.newSelection.main;
    sa = r.from; sb = r.to;
  }
  if (src2 === m.src && !list) return null;
  const text = toEdit(src2);
  return { text, a: sourceToDisplayed(src2, sa), b: sourceToDisplayed(src2, sb) };
}
