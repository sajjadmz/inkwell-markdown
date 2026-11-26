// Lists inside a table cell. A cell shows its Markdown source as plain text, one line per <br>. A line that starts with "- ", "1. " or "☐ "
// is a list item: Enter continues the list, Enter on an empty item ends it, Backspace right after the prefix removes it, and the numbered
// lines that follow are numbered again (only the digits change). Pure functions on the cell's displayed text; null = do the normal thing.

const CELL_PRE = /^( {0,3})((?:[-*+] (?:\[[ xX]\] )?)|(?:\d{1,9}[.)] )|(?:[☐☑] ))/;
const NUM = /^( {0,3})(\d{1,9})([.)]) /;

export interface CellEdit { from: number; to: number; insert: string; caret: number }

function lineBounds(text: string, a: number): { ls: number; le: number } {
  const ls = a > 0 ? text.lastIndexOf('\n', a - 1) + 1 : 0;
  const nl = text.indexOf('\n', a);
  return { ls, le: nl < 0 ? text.length : nl };
}
const nextPrefix = (p: string): string => {
  const m = /^( {0,3})(\d{1,9})([.)]) $/.exec(p);
  if (m) return `${m[1]}${parseInt(m[2], 10) + 1}${m[3]} `;
  if (/^( {0,3})[☐☑] $/.test(p)) return p.replace(/[☐☑]/, '☐');
  return p.replace(/\[[ xX]\]/, '[ ]');
};

/** Renumbers the run of numbered lines that starts at line `from` (consecutive lines, same delimiter), counting on from `n`. Returns the new text of that run and its end. */
function renumberRun(text: string, from: number, n: number, delim: string): { text: string; end: number } {
  let pos = from; let out = ''; let end = from;
  const all: number[] = [];
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos); const le = nl < 0 ? text.length : nl;
    const line = text.slice(pos, le); const m = NUM.exec(line);
    if (!m || m[3] !== delim) break;
    all.push(parseInt(m[2], 10));
    out += (out ? '\n' : '') + `${m[1]}${n + all.length - 1}${m[3]} ` + line.slice(m[0].length);
    end = le; if (nl < 0) break; pos = nl + 1;
  }
  return { text: out, end };
}

/** Enter in a cell. */
export function cellEnter(text: string, a: number, b: number): CellEdit | null {
  const { ls, le } = lineBounds(text, a);
  const line = text.slice(ls, le); const m = CELL_PRE.exec(line);
  if (!m) return null;
  const p = m[0].length;
  if (a === b && a === le && line.slice(p).trim() === '') return { from: ls, to: le, insert: '', caret: ls }; // an empty item: the list ends
  if (a < ls + p) return null; // inside the prefix: an ordinary line break
  const np = nextPrefix(m[0]);
  const rest = text.slice(b, Math.max(b, le));
  let insert = '\n' + np + rest; let end = Math.max(b, le);
  const nm = /^( {0,3})(\d{1,9})([.)]) $/.exec(m[0]);
  if (nm && le < text.length) { // the numbered lines below go on counting
    const n = parseInt(nm[2], 10) + 1;
    const run = renumberRun(text, le + 1, n + 1, nm[3]);
    if (run.text) { insert += '\n' + run.text; end = run.end; }
  }
  return { from: a, to: end, insert, caret: a + 1 + np.length };
}

/** Backspace right after a list prefix removes the prefix and keeps the text. */
export function cellBackspace(text: string, a: number, b: number): CellEdit | null {
  if (a !== b) return null;
  const { ls, le } = lineBounds(text, a);
  const m = CELL_PRE.exec(text.slice(ls, le));
  if (!m || a !== ls + m[0].length) return null;
  const nm = /^( {0,3})(\d{1,9})([.)]) $/.exec(m[0]);
  let insert = text.slice(ls + m[0].length, le); let end = le;
  if (nm && le < text.length) { // the numbered lines below close the gap: they go on from the numbered line above, or keep their own start
    const above = ls > 0 ? NUM.exec(text.slice(text.lastIndexOf('\n', ls - 2) + 1, ls - 1)) : null;
    const start = above && above[3] === nm[3] ? parseInt(above[2], 10) + 1 : null;
    if (start !== null) { const run = renumberRun(text, le + 1, start, nm[3]); if (run.text) { insert += '\n' + run.text; end = run.end; } }
  }
  return { from: ls, to: end, insert, caret: ls };
}
