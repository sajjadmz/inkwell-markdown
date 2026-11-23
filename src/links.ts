// Link handling for the read-only viewer. Everything here only OPENS things; it never writes.
import * as vscode from 'vscode';

export type LinkKind = 'external' | 'anchor' | 'file' | 'rejected';
export interface ResolvedLink { kind: LinkKind; uri?: vscode.Uri; fragment?: string }

const EXTERNAL = new Set(['http', 'https', 'mailto']);
const MARKDOWN_EXT = /\.(md|markdown)$/i;

const decode = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };
/** Windows hrefs use backslashes; Uri paths always use forward slashes. */
const slashes = (s: string): string => s.replace(/\\/g, '/');
const WIN_DRIVE = /^[a-z]:[\\/]/i;

/** Pure: classify an href from the rendered page relative to the document that contains it. */
export function resolveLink(docUri: vscode.Uri, href: string): ResolvedLink {
  const h = (href ?? '').trim();
  if (!h) return { kind: 'rejected' };
  if (h.startsWith('#')) return { kind: 'anchor', fragment: decode(h.slice(1)) };
  const scheme = WIN_DRIVE.test(h) ? null : /^([a-z][a-z0-9+.-]*):/i.exec(h); // `C:/x` is a drive, not a scheme
  if (scheme) {
    if (EXTERNAL.has(scheme[1].toLowerCase())) return { kind: 'external', uri: vscode.Uri.parse(h, true) };
    return { kind: 'rejected' }; // command:, javascript:, file:, data:, vscode:, ...
  }
  if (h.startsWith('//')) return { kind: 'rejected' };
  const hashAt = h.indexOf('#');
  const fragment = hashAt >= 0 ? decode(h.slice(hashAt + 1)) : undefined;
  let p = hashAt >= 0 ? h.slice(0, hashAt) : h;
  const q = p.indexOf('?');
  if (q >= 0) p = p.slice(0, q);
  p = slashes(decode(slashes(p)));
  if (!p) return fragment ? { kind: 'anchor', fragment } : { kind: 'rejected' };
  let uri: vscode.Uri;
  if (WIN_DRIVE.test(p)) {
    uri = vscode.Uri.file(p); // absolute Windows path, e.g. C:/x/y.md
  } else if (p.startsWith('/')) {
    // Root-relative: keep the document's drive letter (/c:/...) when it has one.
    const drive = /^\/[a-z]:/i.exec(docUri.path)?.[0] ?? '';
    uri = docUri.with({ path: drive + p, query: '', fragment: '' });
  } else {
    uri = vscode.Uri.joinPath(docUri, '..', p);
  }
  return { kind: 'file', uri, fragment };
}

/** Act on a link click. `scroll` is told which document/fragment to scroll to once a .md is open. */
export async function openLink(
  docUri: vscode.Uri, href: string, scroll: (uri: vscode.Uri, fragment: string) => void,
): Promise<void> {
  const r = resolveLink(docUri, href);
  if (r.kind === 'external') { await vscode.env.openExternal(r.uri!); return; }
  if (r.kind !== 'file') return; // anchors are handled in the webview; rejected links are ignored
  try { await vscode.workspace.fs.stat(r.uri!); } catch {
    void vscode.window.showWarningMessage(`Inkwell: file not found: ${r.uri!.fsPath}`);
    return;
  }
  if (MARKDOWN_EXT.test(r.uri!.path)) {
    await vscode.commands.executeCommand('vscode.openWith', r.uri, 'inkwell.editor');
    if (r.fragment) scroll(r.uri!, r.fragment);
  } else {
    await vscode.commands.executeCommand('vscode.open', r.uri);
  }
}
