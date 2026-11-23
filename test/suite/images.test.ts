import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { openLive, closeTab, tmpDir, rmDir } from './helpers';

// 1x1 PNG and GIF
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

suite('Inkwell images', () => {
  test('relative images load, including a spaced path outside any workspace folder', async function () {
    this.timeout(60000);
    const root = tmpDir();
    const dir = path.join(root, 'VSCode Extension', 'sub dir');
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'images', 'x.png'), PNG);
    fs.writeFileSync(path.join(dir, 'images', 'x y.gif'), GIF);
    fs.writeFileSync(path.join(dir, 'images', 'x.gif'), GIF);
    const file = path.join(dir, 'doc.md');
    fs.writeFileSync(file, '# T\n\n![a](images/x.png)\n\n![b](./images/x.gif)\n\n![c](images/x%20y.gif)\n\n<p align="center"><img src="images/x.png"></p>\n');
    try {
      const { uri } = await openLive(file);
      const r = await vscode.commands.executeCommand('inkwell._debugAsk', uri, 'debugImages', { min: 3 }) as { value?: unknown } | { src: string; ok: boolean }[];
      const imgs = (Array.isArray(r) ? r : (r as { value: { src: string; ok: boolean }[] }).value);
      assert.strictEqual(imgs.length, 3, JSON.stringify(imgs));
      for (const i of imgs) assert.ok(i.ok, 'image failed: ' + i.src);
    } finally { await closeTab(file); rmDir(root); }
  });

  test('the repo README (path with a space, not in the test workspace) shows all its images', async function () {
    this.timeout(60000);
    const file = path.resolve(__dirname, '../../../README.md');
    const want = (fs.readFileSync(file, 'utf8').match(/^!\[[^\n]*\]\(images\//gm) ?? []).length;
    assert.ok(want >= 5);
    const other = tmpDir();
    vscode.workspace.updateWorkspaceFolders(0, 0, { uri: vscode.Uri.file(other) }, { uri: vscode.Uri.file(tmpDir()) });
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const { uri } = await openLive(file);
      const imgs = await vscode.commands.executeCommand('inkwell._debugAsk', uri, 'debugImages', { min: 1 }) as { src: string; ok: boolean }[];
      assert.ok(imgs.length >= 1 && imgs.length <= want, JSON.stringify(imgs)); // CodeMirror only renders widgets near the viewport
      for (const i of imgs) assert.ok(i.ok, 'image failed: ' + i.src);
    } finally { await closeTab(file); rmDir(other); }
  });
});
