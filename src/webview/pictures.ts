// Pasted / dropped pictures, page side: find the images in a clipboard or drop, and read them as base64.
export const MAX_PICTURE_BYTES = 25 * 1024 * 1024;
const OK_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
const MIME_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
export interface Pic { file: File; ext: string }

const extOfName = (n: string): string => { const m = /\.([A-Za-z0-9]+)$/.exec(n); return m ? m[1].toLowerCase() : ''; };

/**
 * The pictures in a paste or drop. A paste takes its extension from the content type (a screenshot is always "image.png");
 * a drop keeps the dropped file's own extension. Anything else (other file types) is not a picture and is left alone.
 */
export function picturesIn(dt: DataTransfer | null, origin: 'paste' | 'drop'): Pic[] {
  const out: Pic[] = [];
  for (const f of Array.from(dt?.files ?? [])) {
    const byName = extOfName(f.name);
    const ext = origin === 'drop' && OK_EXT.includes(byName) ? byName : MIME_EXT[f.type] ?? (OK_EXT.includes(byName) ? byName : '');
    if (ext) out.push({ file: f, ext });
  }
  return out;
}

/** A paste that also carries text (Word, a spreadsheet, a web page) stays a text paste: only a bare image, or a copied file whose "text" is just its name, becomes a picture. */
export function pictureOnlyPaste(dt: DataTransfer | null): Pic[] {
  const pics = picturesIn(dt, 'paste');
  if (!pics.length) return [];
  const text = (dt?.getData('text/plain') ?? '').trim();
  if (text && !pics.some((p) => p.file.name === text)) return [];
  return pics;
}

export function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(',') + 1)); };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
