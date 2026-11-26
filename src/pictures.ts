// Pasted / dropped pictures, host side: validation and naming. Pure functions (no vscode import) so the tests can reach them.
import * as path from 'node:path';

export const MAX_PICTURE_BYTES = 25 * 1024 * 1024;
export const PICTURE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] as const;
export const NOTE_SAVE_FIRST = 'Save the file first to paste pictures.';
export const NOTE_TOO_BIG = 'That picture is bigger than 25 MB, so it was not added.';

export type Checked = { ok: true; ext: string; bytes: Buffer } | { ok: false; error: string };

const startsWith = (b: Buffer, sig: number[], at = 0): boolean => sig.every((v, i) => b[at + i] === v);
/** Does the content look like what the extension says? (A cheap guard, not a full image parser.) */
function looksLike(ext: string, b: Buffer): boolean {
  switch (ext) {
    case 'png': return startsWith(b, [0x89, 0x50, 0x4e, 0x47]);
    case 'jpg': case 'jpeg': return startsWith(b, [0xff, 0xd8, 0xff]);
    case 'gif': return startsWith(b, [0x47, 0x49, 0x46, 0x38]);
    case 'webp': return startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8);
    case 'svg': return /<svg[\s>]/i.test(b.subarray(0, 4096).toString('utf8'));
    default: return false;
  }
}

/** Checks one message from the page: extension on the list, base64 only, not too big, content matches. */
export function checkPicture(m: { ext?: unknown; data?: unknown }): Checked {
  if (typeof m.ext !== 'string' || !(PICTURE_EXTS as readonly string[]).includes(m.ext.toLowerCase())) return { ok: false, error: 'Only png, jpg, jpeg, gif, webp and svg pictures can be added.' };
  const ext = m.ext.toLowerCase();
  if (typeof m.data !== 'string') return { ok: false, error: 'That picture could not be read.' };
  if (m.data.length > Math.ceil(MAX_PICTURE_BYTES / 3) * 4 + 4) return { ok: false, error: NOTE_TOO_BIG };
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(m.data)) return { ok: false, error: 'That picture could not be read.' };
  const bytes = Buffer.from(m.data, 'base64');
  if (bytes.length === 0) return { ok: false, error: 'That picture is empty, so it was not added.' };
  if (bytes.length > MAX_PICTURE_BYTES) return { ok: false, error: NOTE_TOO_BIG };
  if (!looksLike(ext, bytes)) return { ok: false, error: `That does not look like a .${ext} picture, so it was not added.` };
  return { ok: true, ext, bytes };
}

/** The note's name as safe file-name text: no folders, no characters that break a path or a Markdown link address. */
export function pictureBase(docPath: string): string {
  let b = path.basename(docPath.replace(/\\/g, '/')).replace(/\.(md|markdown)$/i, '');
  b = b.replace(/[\u0000-\u001f\u007f\\/:*?"<>|%#]/g, '-').replace(/^[.\s-]+/, '').replace(/[.\s]+$/, '');
  if (b.length > 80) b = b.slice(0, 80).replace(/[.\s]+$/, '');
  return b || 'note';
}

const p2 = (n: number): string => String(n).padStart(2, '0');
/** YYYYMMDD-HHMMSS in local time. */
export const stamp = (d: Date): string => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;

/** File name for the nth attempt: `<note>-<stamp>.<ext>`, then `<note>-<stamp>-2.<ext>`, -3 ... */
export const pictureFileName = (base: string, when: Date, ext: string, n: number): string => `${base}-${stamp(when)}${n > 1 ? '-' + n : ''}.${ext}`;

/** `![](images/name.png)`. A path with a space or a bracket is written in the <...> form, which CommonMark allows and which keeps spaces intact. */
export function pictureMarkdown(rel: string): string {
  return /[\s()<>]/.test(rel) ? `![](<${rel}>)` : `![](${rel})`;
}
