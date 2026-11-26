// Double-space full stop (the macOS habit): typing a space right after "word " turns the two spaces into ". ".
// Pure rules live here so the editor and the table cells share them.
import { EditorView } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { isolateHistory } from '@codemirror/commands';

export type DoubleSpaceMode = 'auto' | 'on' | 'off';
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
let mode: DoubleSpaceMode = 'auto';
export const setDoubleSpaceMode = (m: unknown): void => { mode = m === 'on' || m === 'off' ? m : 'auto'; };
/** "auto" follows the user's own computer (the webview runs on it), so a remote Linux host does not switch it off for a Mac. */
export const doubleSpaceOn = (): boolean => mode === 'on' || (mode === 'auto' && isMac);

/** The character before the first space must end a word: a letter or digit, or a closing ) ] " ' (also curly) or the end of bold / italic / code. */
const ENDS_WORD = /[\p{L}\p{N})\]"'”’*_`]$/u;
const LIST_MARKER_ONLY = /^[ \t>]*(?:\d{1,9}[.)]?|[-*+])$/;
const TASK_MARKER_ONLY = /^[ \t>]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ xX]\]$/;

const CLOSE_TAG = /<\/(?:span|mark|b|i|u|s|del|strong|em)>$/;
const CLOSER_AT_START = /^(?:\*{1,3}|~~|_{1,3}|<\/(?:span|mark|b|i|u|s|del|strong|em)>)/;
const TAG_NAME = /^<\/([a-z]+)>$/;
const isPunct = (c: string): boolean => /[\p{P}\p{S}]/u.test(c);

/** How many characters of the emphasis character `ch` are still open (an opener without its closer) in `text`. */
function openCount(text: string, ch: string): number {
  let open = 0;
  const re = ch === '*' ? /\*+/g : ch === '_' ? /_+/g : /~+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > 0 && text[m.index - 1] === '\\') continue; // an escaped marker
    const prev = m.index > 0 ? text[m.index - 1] : ''; const next = text[m.index + m[0].length] ?? '';
    const canOpen = next !== '' && !/\s/.test(next) && (prev === '' || /\s/.test(prev) || isPunct(prev) || ch === '*');
    const canClose = prev !== '' && !/\s/.test(prev);
    if (ch === '_' && /[\p{L}\p{N}]/u.test(prev) && /[\p{L}\p{N}]/u.test(next)) continue; // inside a word
    if (canClose && open > 0) open = Math.max(0, open - m[0].length);
    else if (canOpen) open += m[0].length;
  }
  return open;
}

/** How many unclosed `<tag ...>` openers are in `text`. */
function openTags(text: string, tag: string): number {
  const o = (text.match(new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'gi')) ?? []).length;
  const c = (text.match(new RegExp(`</${tag}>`, 'gi')) ?? []).length;
  return o - c;
}

/** What to do on the second space: the two typed spaces and the first `eat` characters after them become `text`, the caret goes after it. */
export interface PeriodPlan { eat: number; text: string }

/**
 * `before` is the text of the line (or table-cell line) up to the caret, which ends with the first space;
 * `after` is the rest of that line. Pure string rules only (code, links and tags are checked by the callers).
 * Returns null when no full stop is wanted. With the caret right before closing markers (`**bold|**`), the full stop goes inside
 * them and the space after them: `**bold.** `.
 */
export function periodPlan(before: string, after: string): PeriodPlan | null {
  if (!before.endsWith(' ')) return null;
  const w = before.slice(0, -1);
  const endsOk = ENDS_WORD.test(w) || CLOSE_TAG.test(w) || /[^\s~]~~$/.test(w);
  if (!endsOk) return null; // also rules out punctuation . , ; : ! ? and a second space
  if (!/[\p{L}\p{N}]/u.test(w)) return null; // "***", "- *" ...: no word at all
  if (LIST_MARKER_ONLY.test(w) || TASK_MARKER_ONLY.test(w)) return null; // "1 " + space must not make a list
  // Closing markers straight after the caret: the full stop goes in front of them.
  let used = 0; let closers = '';
  for (;;) {
    const m = CLOSER_AT_START.exec(after.slice(used));
    if (!m) break;
    const tok = m[0];
    let ok: boolean;
    if (tok.startsWith('<')) ok = openTags(w, TAG_NAME.exec(tok)![1]) > 0;
    else ok = openCount(w + after.slice(0, used), tok[0]) >= tok.length;
    if (!ok) break;
    closers += tok; used += tok.length;
  }
  if (used > 0) {
    const rest = after.slice(used);
    if (/^[.,;:!?\u2026)\]]/.test(rest)) return null;
    return { eat: used + (rest.startsWith(' ') ? 1 : 0), text: '.' + closers + ' ' };
  }
  if (after.startsWith(' ')) return null;
  return { eat: 0, text: '. ' };
}
export const periodAllowed = (before: string, after: string): boolean => periodPlan(before, after) !== null;

/** Same rules for one table cell: the caret offset into the cell's source text (line breaks are "\n" while editing). */
export function cellPeriodPlan(text: string, caret: number): PeriodPlan | null {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
  let lineEnd = text.indexOf('\n', caret); if (lineEnd < 0) lineEnd = text.length;
  const plan = periodPlan(text.slice(lineStart, caret), text.slice(caret, lineEnd));
  if (!plan || insideLiteral(text.slice(0, caret))) return null;
  return plan;
}
export const cellPeriodAllowed = (text: string, caret: number): boolean => cellPeriodPlan(text, caret) !== null;

/**
 * Text-level guard: is the end of `before` inside inline code, a link address or an HTML tag / <autolink>? The syntax tree cannot
 * always say (a space typed into a link address already breaks the link), so the characters are checked too.
 */
export function insideLiteral(before: string): boolean {
  if ((before.match(/`/g) ?? []).length % 2 === 1) return true;
  if (/\]\([^)]*$/.test(before)) return true;
  return /<\/?[A-Za-z][^>]*$/.test(before);
}

const INLINE_BAD = new Set(['InlineCode', 'URL', 'Autolink', 'HTMLTag', 'Comment', 'ProcessingInstruction', 'LinkLabel']);
const BLOCK_BAD = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock', 'CommentBlock', 'ProcessingInstructionBlock', 'Table']);

function frontMatterEnd(state: EditorState): number {
  const doc = state.doc;
  if (doc.lines < 2 || doc.line(1).text.trimEnd() !== '---') return 0;
  for (let i = 2; i <= Math.min(doc.lines, 200); i++) { const t = doc.line(i).text.trimEnd(); if (t === '---' || t === '...') return doc.line(i).to; }
  return 0;
}

/** Would a space typed at `pos` (replacing nothing) become ". " in the main editor? */
export function editorPeriodPlan(state: EditorState, from: number, to: number, text: string): PeriodPlan | null {
  if (text !== ' ' || from !== to || state.selection.ranges.length !== 1) return null;
  const line = state.doc.lineAt(from);
  const before = state.sliceDoc(line.from, from);
  const plan = periodPlan(before, state.sliceDoc(from, line.to));
  if (!plan || insideLiteral(before)) return null;
  const fm = frontMatterEnd(state);
  if (fm && from <= fm) return null;
  const tree = ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
  for (const side of [-1, 1] as const) {
    for (let n: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(from, side); n; n = n.parent) {
      if (BLOCK_BAD.has(n.name) && from >= n.from && from <= n.to) return null;
      if (INLINE_BAD.has(n.name) && from > n.from && from < n.to) return null;
      if (n.name === 'URL' && (n.parent?.name === 'Link' || n.parent?.name === 'Image') && from >= n.from && from <= n.to) return null; // a link's address, caret at either end
    }
  }
  return plan;
}

/**
 * CodeMirror input handler. The second space is typed normally (so the two spaces really are in the document) and is then
 * replaced by ". " in a transaction of its own: one Undo gives back the two spaces, as in macOS.
 */
export function doubleSpaceInput(view: EditorView, from: number, to: number, text: string): boolean {
  if (!doubleSpaceOn() || view.composing || view.compositionStarted) return false;
  const plan = editorPeriodPlan(view.state, from, to, text);
  if (!plan) return false;
  view.dispatch({ changes: { from, insert: ' ' }, selection: { anchor: from + 1 }, userEvent: 'input.type' });
  view.dispatch({ changes: { from: from - 1, to: from + 1 + plan.eat, insert: plan.text }, selection: { anchor: from - 1 + plan.text.length }, userEvent: 'input.type.period', annotations: isolateHistory.of('full'), scrollIntoView: true });
  return true;
}
