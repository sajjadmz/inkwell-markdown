import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

export const FIXTURES = path.resolve(__dirname, '../../../test/fixtures');
export const VIEW = 'inkwell.editor';
export const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'lm-'));
// Windows can briefly keep files locked after a tab closes; retry, and never fail a test on temp cleanup.
export const rmDir = (d: string): void => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* temp dir; the OS cleans it */ } };

/** Path equality that survives Windows (drive-letter case, case-insensitive paths, mixed separators). */
export const samePath = (a: string, b: string): boolean => {
  const n = (x: string) => (process.platform === 'win32' ? path.normalize(x).toLowerCase() : path.normalize(x));
  return n(a) === n(b);
};

export function findTab(file: string, viewType?: string): vscode.Tab | undefined {
  return vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => {
    const i = t.input as { uri?: vscode.Uri; viewType?: string } | undefined;
    return !!i?.uri && samePath(i.uri.fsPath, file) && (!viewType || i.viewType === viewType);
  });
}
export async function closeTab(file: string): Promise<void> {
  const tab = findTab(file);
  if (tab) await vscode.window.tabGroups.close(tab);
}

/** Open in Inkwell and wait (event based) until the webview has its text. */
export async function openLive(file: string): Promise<{ uri: vscode.Uri; doc: vscode.TextDocument }> {
  await vscode.extensions.getExtension('sajjadmotamed.inkwell-markdown')!.activate();
  const uri = vscode.Uri.file(file);
  const ready = vscode.commands.executeCommand('inkwell._debugWhenReady', uri);
  await vscode.commands.executeCommand('vscode.openWith', uri, VIEW);
  await ready;
  const doc = vscode.workspace.textDocuments.find((d) => samePath(d.uri.fsPath, file))!;
  return { uri, doc };
}

export interface Edit { fromLine: number; fromCh: number; toLine: number; toCh: number; insert: string }
export const applyWebviewEdit = (uri: vscode.Uri, e: Edit) => vscode.commands.executeCommand('inkwell._debugApplyWebviewEdit', uri, e);
export const webviewText = (uri: vscode.Uri) => vscode.commands.executeCommand<string>('inkwell._debugGetWebviewText', uri);

export function waitFor(cond: () => boolean, event: vscode.Event<unknown>, ms = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (cond()) return resolve();
    const t = setTimeout(() => { d.dispose(); reject(new Error('timed out waiting for condition')); }, ms);
    const d = event(() => { if (cond()) { clearTimeout(t); d.dispose(); resolve(); } });
  });
}

/** Offset of (line, ch) in a string whose lines end in \n or \r\n. */
export function offsetOf(text: string, line: number, ch: number): number {
  let off = 0;
  for (let i = 0; i < line; i++) { off = text.indexOf('\n', off) + 1; }
  return off + ch;
}

/** Independent model of an edit on raw file bytes: BOM kept, inserted \n becomes the file's EOL. */
export function expectedBytes(orig: Buffer, edits: Edit[]): Buffer {
  let s = orig.toString('utf8');
  const bom = s.charCodeAt(0) === 0xfeff;
  if (bom) s = s.slice(1);
  const eol = s.includes('\r\n') ? '\r\n' : '\n';
  for (const e of edits) {
    // Edits are expressed against the document as the webview shows it (\n only, so ch never counts \r).
    const from = offsetOf(s, e.fromLine, e.fromCh);
    const to = offsetOf(s, e.toLine, e.toCh);
    s = s.slice(0, from) + e.insert.replace(/\n/g, eol) + s.slice(to);
  }
  return Buffer.from((bom ? '﻿' : '') + s, 'utf8');
}

/** Length of the common prefix and suffix of two buffers. */
export function commonAffixes(a: Buffer, b: Buffer): { prefix: number; suffix: number } {
  let p = 0; const m = Math.min(a.length, b.length);
  while (p < m && a[p] === b[p]) p++;
  let s = 0;
  while (s < m - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { prefix: p, suffix: s };
}

/** Poll until cond() is true (bounded by ms); asserts with `what` on timeout. */
export async function waitUntil(cond: () => boolean | Promise<boolean>, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out (${ms} ms) waiting for: ${what}`);
}
