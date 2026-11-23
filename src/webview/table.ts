// Table model and table edits. Everything is a minimal text change: a cell edit replaces only that cell's
// content, row/column controls insert or delete only the characters of the row or column, and untouched
// rows are never re-aligned or reformatted.
import type { ChangeSpec } from '@codemirror/state';

export interface Cell { from: number; to: number; cFrom: number; cTo: number }
export interface Row { from: number; to: number; text: string; cells: Cell[]; lead: boolean; trail: boolean }
export type Align = 'left' | 'center' | 'right' | 'none';

export function parseRow(text: string, base: number): Row {
  const pipes: number[] = [];
  for (let i = 0; i < text.length; i++) { if (text[i] === '\\') i++; else if (text[i] === '|') pipes.push(i); }
  const firstNon = text.search(/\S/);
  let lastNon = text.length - 1; while (lastNon >= 0 && /\s/.test(text[lastNon])) lastNon--;
  const lead = pipes.length > 0 && pipes[0] === firstNon;
  const trail = pipes.length > 0 && pipes[pipes.length - 1] === lastNon && (pipes.length > 1 || !lead);
  const edges = [...(lead ? [] : [-1]), ...pipes, ...(trail ? [] : [lastNon + 1])];
  const cells: Cell[] = [];
  for (let k = 0; k + 1 < edges.length; k++) {
    const from = edges[k] + 1, to = edges[k + 1];
    const raw = text.slice(from, to);
    const l = raw.length - raw.trimStart().length;
    let cFrom: number, cTo: number;
    if (raw.trim() === '') { cFrom = cTo = from + (raw.length >= 2 ? 1 : 0); }
    else { cFrom = from + l; cTo = to - (raw.length - raw.trimEnd().length); }
    cells.push({ from: base + from, to: base + to, cFrom: base + cFrom, cTo: base + cTo });
  }
  return { from: base, to: base + text.length, text, cells, lead, trail };
}

/** Parses the lines of a table: rows[0] header, rows[1] delimiter, rows[2..] body. */
export function parseTable(lines: Array<{ from: number; text: string }>): Row[] {
  return lines.map((l) => parseRow(l.text, l.from));
}

/**
 * Cell text <-> cell source, an exact inverse pair under GFM rules (a pipe preceded by a backslash does not split a
 * cell, and the one backslash before it is dropped by the parser). In the source, a run of k backslashes that precedes
 * a pipe is written as 2k+1 backslashes, so `\|` typed by the user (a real backslash, then a pipe) survives and never
 * splits the row. Backslashes that do not precede a pipe are left exactly as typed.
 */
export const unescapeCell = (raw: string): string =>
  raw.replace(/(\\+)\|/g, (m, bs: string) => (bs.length % 2 === 1 ? '\\'.repeat((bs.length - 1) / 2) + '|' : m));
export const escapeCell = (text: string): string =>
  text.replace(/[\r\n]+/g, ' ').replace(/(\\*)\|/g, (_m, bs: string) => '\\'.repeat(2 * bs.length + 1) + '|');
/** A cell whose text ends in a backslash must be followed by a space, or the closing pipe would be escaped. */
export const endsWithBackslash = (src: string): boolean => src.endsWith('\\');

export function alignOf(delim: Row, text: (c: Cell) => string, col: number): Align {
  const c = delim.cells[col]; if (!c) return 'none';
  const t = text(c).trim();
  const l = t.startsWith(':'), r = t.endsWith(':');
  return l && r ? 'center' : l ? 'left' : r ? 'right' : 'none';
}

/** The row's text with every cell's characters turned into spaces (pipes kept): a blank row of the same shape. */
function blankOf(row: Row): string {
  const chars = row.text.split('');
  for (const c of row.cells) for (let i = c.from - row.from; i < c.to - row.from; i++) chars[i] = ' ';
  return chars.join('');
}

/** Display row d (0 = header) -> index in `rows`. */
export const rowIndex = (d: number): number => (d === 0 ? 0 : d + 1);

export function addRow(rows: Row[], d: number, where: 'above' | 'below'): ChangeSpec | null {
  if (where === 'above') {
    if (d === 0) return null;
    const ref = rows[rowIndex(d)];
    return { from: ref.from, insert: blankOf(ref) + '\n' };
  }
  if (d === 0) { const delim = rows[1]; return { from: delim.to, insert: '\n' + blankOf(rows[0]) }; }
  const ref = rows[rowIndex(d)];
  return { from: ref.to, insert: '\n' + blankOf(ref) };
}

export function deleteRow(rows: Row[], d: number): ChangeSpec | null {
  if (d === 0 || rows.length <= 2) return null;
  const r = rows[rowIndex(d)];
  return { from: r.from - 1, to: r.to };
}

export function addColumn(rows: Row[], c: number, where: 'left' | 'right'): ChangeSpec[] {
  const out: ChangeSpec[] = [];
  rows.forEach((row, i) => {
    const cell = row.cells[c]; if (!cell) return;
    const w = Math.max(i === 1 ? 3 : 1, cell.to - cell.from);
    const fill = i === 1 ? '-'.repeat(w) : ' '.repeat(w);
    if (where === 'right') {
      if (cell.to < row.to && row.text[cell.to - row.from] === '|') out.push({ from: cell.to + 1, insert: fill + '|' });
      else out.push({ from: cell.to, insert: '|' + fill });
    } else if (cell.from > row.from && row.text[cell.from - row.from - 1] === '|') out.push({ from: cell.from, insert: fill + '|' });
    else out.push({ from: row.from, insert: fill + '|' });
  });
  return out;
}

export function deleteColumn(rows: Row[], c: number): ChangeSpec[] | null {
  if (rows[0].cells.length <= 1) return null;
  const out: ChangeSpec[] = [];
  for (const row of rows) {
    const cell = row.cells[c]; if (!cell) continue;
    const closing = row.text[cell.to - row.from] === '|' && cell.to < row.to;
    out.push(closing ? { from: cell.from, to: cell.to + 1 } : { from: cell.from - 1, to: cell.to });
  }
  return out;
}

export function setAlign(rows: Row[], c: number, a: Align): ChangeSpec | null {
  const cell = rows[1]?.cells[c]; if (!cell) return null;
  const old = rows[1].text.slice(cell.cFrom - rows[1].from, cell.cTo - rows[1].from);
  const l = a === 'left' || a === 'center', r = a === 'right' || a === 'center';
  const next = (l ? ':' : '') + '-'.repeat(Math.max(1, old.length - (l ? 1 : 0) - (r ? 1 : 0))) + (r ? ':' : '');
  if (next === old) return null;
  let p = 0; const m = Math.min(old.length, next.length);
  while (p < m && old[p] === next[p]) p++;
  let s = 0;
  while (s < m - p && old[old.length - 1 - s] === next[next.length - 1 - s]) s++;
  return { from: cell.cFrom + p, to: cell.cFrom + old.length - s, insert: next.slice(p, next.length - s) };
}
