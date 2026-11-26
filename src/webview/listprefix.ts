// The text in front of a list item's text on its first line, shared by list editing and indent/outdent.
/** quote marks (each with one optional space), indentation, marker, spaces after it, and a task box with its spaces. */
const PREFIX_RE = /^((?:[ \t]*>[ \t]?)*)([ \t]*)(?:([-*+]|\d{1,9}[.)])([ \t]+|$)(\[[ xX]\](?:[ \t]+|$))?)?/;
export interface Pre { q: string; ws: string; marker: string; gap: string; task: string; len: number; markerAt: number }
export function parsePre(text: string): Pre {
  const m = PREFIX_RE.exec(text)!;
  return { q: m[1], ws: m[2], marker: m[3] ?? '', gap: m[4] ?? '', task: m[5] ?? '', len: m[0].length, markerAt: m[1].length + m[2].length };
}

/** Where an offset in a line's old text goes once its prefix (marker, indentation) was rewritten: text keeps its place, a caret in the prefix goes to the text. */
export function mapAcrossPrefix(oldText: string, newText: string, off: number, caret: boolean): number {
  const o = parsePre(oldText), n = parsePre(newText);
  if (off >= o.len) return off + n.len - o.len;
  if (caret) return n.len;
  return off <= o.markerAt ? n.markerAt : n.markerAt + (off - o.markerAt);
}

