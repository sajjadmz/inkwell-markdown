import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { samePath } from './helpers';

// dist/links.js is the same module the extension bundles (built by esbuild in pretest).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const links = require(path.resolve(__dirname, '../../../dist/links.js')) as {
  resolveLink(d: vscode.Uri, h: string): { kind: string; uri?: vscode.Uri; fragment?: string };
  openLink(d: vscode.Uri, h: string, s: (u: vscode.Uri, f: string) => void): Promise<void>;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

suite('Inkwell links', () => {
  const doc = vscode.Uri.file('/a/b/doc.md');
  const r = (h: string) => links.resolveLink(doc, h);

  test('relative file', () => {
    const x = r('6-16-running-cost.md');
    assert.strictEqual(x.kind, 'file'); assert.strictEqual(x.uri!.path, '/a/b/6-16-running-cost.md');
  });
  test('../ with fragment', () => {
    const x = r('../x/y.md#section');
    assert.strictEqual(x.uri!.path, '/a/x/y.md'); assert.strictEqual(x.fragment, 'section');
  });
  test('encoded spaces', () => assert.strictEqual(r('my%20notes/a%20b.md').uri!.path, '/a/b/my notes/a b.md'));
  test('absolute path', () => assert.strictEqual(r('/etc/x.md').uri!.path, '/etc/x.md'));
  test('Windows-style hrefs: backslashes, drive letters, encoded spaces', () => {
    assert.strictEqual(r('..\\other.md').uri!.path, '/a/other.md');
    assert.strictEqual(r('sub\\dir\\a.md#h').uri!.path, '/a/b/sub/dir/a.md');
    assert.strictEqual(r('sub%20dir/a.md').uri!.path, '/a/b/sub dir/a.md');
    assert.strictEqual(r('sub%20dir%5Ca.md').uri!.path, '/a/b/sub dir/a.md');
    const abs = r('C:/x/y.md'); assert.strictEqual(abs.kind, 'file'); assert.strictEqual(abs.uri!.path.toLowerCase(), '/c:/x/y.md');
    assert.strictEqual(r('c:\\x\\y.md').uri!.path.toLowerCase(), '/c:/x/y.md');
    assert.strictEqual(r('D:/a%20b/c.md').uri!.path.toLowerCase(), '/d:/a b/c.md');
    assert.strictEqual(r('C:relative.md').kind, 'rejected'); // `C:` followed by no slash is treated as a scheme
  });
  test('Windows document: relative and root-relative links keep the drive', () => {
    const w = vscode.Uri.file('C:/Users/me/notes/doc.md');
    assert.strictEqual(links.resolveLink(w, '..\\other.md').uri!.path.toLowerCase(), '/c:/users/me/other.md');
    assert.strictEqual(links.resolveLink(w, '/top.md').uri!.path.toLowerCase(), '/c:/top.md');
  });
  test('anchor only', () => { const x = r('#Hello%20World'); assert.strictEqual(x.kind, 'anchor'); assert.strictEqual(x.fragment, 'Hello World'); });
  test('http/https/mailto external', () => {
    for (const h of ['http://a.com/x', 'https://a.com/?q=1#f', 'mailto:me@a.com']) assert.strictEqual(r(h).kind, 'external', h);
  });
  test('rejects dangerous schemes', () => {
    for (const h of ['command:workbench.action.files.save', 'javascript:alert(1)', 'JavaScript:alert(1)', 'vscode://x', 'data:text/html,x', 'file:///etc/passwd', '//evil.com/x', '']) {
      assert.strictEqual(r(h).kind, 'rejected', h);
    }
  });

  test('opening a linked .md leaves both files identical and not dirty', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-links-'));
    const a = path.join(dir, 'a b.md'); const b = path.join(dir, 'b.md');
    fs.writeFileSync(a, '# A\n\n[to b](b.md#sec)\n'); fs.writeFileSync(b, '# B\n\n## Sec\r\ntext\n');
    const [ba, bb] = [fs.readFileSync(a), fs.readFileSync(b)];
    const aUri = vscode.Uri.file(a);
    await vscode.commands.executeCommand('vscode.openWith', aUri, 'inkwell.editor');
    let scrolled = '';
    await links.openLink(aUri, 'b.md#sec', (_u, f) => { scrolled = f; });
    await sleep(2000);
    assert.strictEqual(scrolled, 'sec');
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    assert.ok(tabs.some((t) => (t.input as { uri?: vscode.Uri; viewType?: string })?.uri?.fsPath !== undefined && samePath((t.input as { uri: vscode.Uri }).uri.fsPath, b) && (t.input as { viewType?: string }).viewType === 'inkwell.editor'), 'b opened in Inkwell');
    for (const f of [a, b]) {
      const d = vscode.workspace.textDocuments.find((x) => samePath(x.uri.fsPath, f));
      assert.ok(!d || !d.isDirty, `${f} not dirty`);
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    assert.ok(Buffer.compare(ba, fs.readFileSync(a)) === 0 && Buffer.compare(bb, fs.readFileSync(b)) === 0, 'bytes unchanged');
  });
});
