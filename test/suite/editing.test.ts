// S2 S3 S4 S5 S6 and the sync races, all through the real webview path.
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Edit, FIXTURES, applyWebviewEdit, closeTab, commonAffixes, expectedBytes, findTab, offsetOf, openLive, rmDir, tmpDir, waitFor, waitUntil, webviewText } from './helpers';

const ins = (line: number, ch: number, insert: string): Edit => ({ fromLine: line, fromCh: ch, toLine: line, toCh: ch, insert });
const norm = (s: string) => s.replace(/\r\n/g, '\n');

suite('Editing through the webview', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  const copy = (name: string, as = name) => { const f = path.join(tmp, as); fs.copyFileSync(path.join(FIXTURES, name), f); return f; };

  test('S2 scripted edits change only the edited bytes', async () => {
    const file = copy('lf.md', 's2.md');
    const { uri, doc } = await openLive(file);
    const edits = [ins(2, 5, 'ABC'), { fromLine: 0, fromCh: 2, toLine: 0, toCh: 4, insert: 'xyz' }, ins(0, 0, 'héllo ✓\n'), { fromLine: 4, fromCh: 0, toLine: 5, toCh: 0, insert: '' }];
    for (const e of edits) {
      const before = fs.readFileSync(file);
      await applyWebviewEdit(uri, e);
      assert.ok(doc.isDirty, 'dirty after edit');
      assert.strictEqual(await webviewText(uri), norm(doc.getText()), 'webview and document agree');
      await doc.save();
      const after = fs.readFileSync(file);
      assert.deepStrictEqual(after, expectedBytes(before, [e]), 'bytes equal the independent model');
      // Byte diff: everything before the edit start and after the edit end is identical.
      const text = before.toString('utf8');
      const from = Buffer.byteLength(text.slice(0, offsetOf(text, e.fromLine, e.fromCh)));
      const to = Buffer.byteLength(text.slice(0, offsetOf(text, e.toLine, e.toCh)));
      const { prefix, suffix } = commonAffixes(before, after);
      assert.ok(prefix >= from, `prefix ${prefix} >= ${from}`);
      assert.ok(suffix >= before.length - to, `suffix ${suffix} >= ${before.length - to}`);
    }
    await closeTab(file);
  });

  for (const name of ['crlf.md', 'bom.md', 'no-trailing-newline.md', 'tabs.md', 'lf.md']) {
    test(`S3 ${name} survives an edit and a save`, async () => {
      const file = copy(name, 's3-' + name);
      const orig = fs.readFileSync(file);
      const { uri, doc } = await openLive(file);
      const last = norm(doc.getText()).split('\n');
      const edits = [ins(0, 1, 'Q'), ins(2, 0, 'new line\nsecond\n'), ins(last.length - 1 + 2, last[last.length - 1].length, '!')];
      for (const e of edits) await applyWebviewEdit(uri, e);
      await doc.save();
      const after = fs.readFileSync(file);
      assert.deepStrictEqual(after, expectedBytes(orig, edits));
      if (name === 'crlf.md') assert.ok(!/[^\r]\n/.test(after.toString('latin1')), 'every \\n is still \\r\\n');
      if (name === 'bom.md') assert.deepStrictEqual([...after.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM kept');
      if (name === 'no-trailing-newline.md') assert.notStrictEqual(after[after.length - 1], 0x0a, 'still no final newline');
      if (name === 'tabs.md') assert.ok(after.includes(0x09), 'tab kept');
      await closeTab(file);
    });
  }

  test('S4 external write while open (not dirty) shows in the webview, no extra write', async function () {
    // VS Code's file watcher on Windows CI runners is occasionally slow to report disk changes; that is VS Code, not this extension.
    if (process.platform === 'win32') this.retries(2);
    const file = copy('lf.md', 's4.md');
    const { uri, doc } = await openLive(file);
    const next = '# Rewritten by an agent\n\nnew body\n';
    fs.writeFileSync(file, next);
    const mtime = fs.statSync(file).mtimeMs;
    await waitFor(() => doc.getText() === next, vscode.workspace.onDidChangeTextDocument);
    // The webview must show it too (event: the next answer after the host forwarded the change).
    let shown = await webviewText(uri);
    for (let i = 0; i < 50 && shown !== next; i++) shown = await webviewText(uri);
    assert.strictEqual(shown, next);
    assert.strictEqual(doc.isDirty, false);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), next);
    assert.strictEqual(fs.statSync(file).mtimeMs, mtime, 'extension did not write');
    await closeTab(file);
  });

  test('S5 undo and redo use VS Code history', async () => {
    const file = copy('lf.md', 's5.md');
    const orig = fs.readFileSync(file);
    const { uri, doc } = await openLive(file);
    const text0 = doc.getText();
    await applyWebviewEdit(uri, ins(2, 0, 'TYPED '));
    assert.notStrictEqual(doc.getText(), text0);
    const edited = doc.getText();
    const undone = waitFor(() => doc.getText() === text0, vscode.workspace.onDidChangeTextDocument);
    await vscode.commands.executeCommand('undo');
    await undone;
    assert.strictEqual(await webviewText(uri), norm(text0), 'webview follows undo');
    await doc.save();
    assert.deepStrictEqual(fs.readFileSync(file), orig, 'bytes equal the original');
    const redone = waitFor(() => doc.getText() === edited, vscode.workspace.onDidChangeTextDocument);
    await vscode.commands.executeCommand('redo');
    await redone;
    assert.strictEqual(await webviewText(uri), norm(edited));
    await closeTab(file);
  });

  test('S6 file over 2 MB opens in the plain text editor', async () => {
    const file = path.join(tmp, 'big.md');
    fs.writeFileSync(file, '# big\n' + 'line of text for the size limit\n'.repeat(70000));
    assert.ok(fs.statSync(file).size > 2 * 1024 * 1024);
    const before = fs.readFileSync(file);
    const uri = vscode.Uri.file(file);
    await vscode.commands.executeCommand('vscode.openWith', uri, 'inkwell.editor');
    await waitFor(() => !!findTab(file) && !findTab(file, 'inkwell.editor'), vscode.window.tabGroups.onDidChangeTabs);
    const tab = findTab(file)!;
    assert.ok((tab.input as { uri?: vscode.Uri }).uri && !(tab.input as { viewType?: string }).viewType, 'plain text tab');
    assert.strictEqual(await vscode.commands.executeCommand('inkwell._debugSessionCount', uri), 0, 'CodeMirror never loaded');
    await closeTab(file);
    assert.deepStrictEqual(fs.readFileSync(file), before);
  });

  test('external edit and webview edit at the same time both survive', async () => {
    for (let round = 0; round < 5; round++) {
      const file = copy('lf.md', `race${round}.md`);
      const { uri, doc } = await openLive(file);
      const ext = new vscode.WorkspaceEdit();
      ext.insert(uri, new vscode.Position(0, 0), 'EXT ');
      await Promise.all([applyWebviewEdit(uri, ins(2, 0, 'WEB ')), vscode.workspace.applyEdit(ext)]);
      await waitUntil(() => doc.getText().startsWith('EXT ') && doc.getText().includes('WEB '), 'both edits present in the document');
      const want = doc.getText();
      let shown = await webviewText(uri);
      for (let i = 0; i < 50 && shown !== norm(want); i++) shown = await webviewText(uri);
      assert.strictEqual(shown, norm(want), 'webview converged to the document');
      await closeTab(file);
    }
  });

  test('typing while a remote change arrives keeps the keystroke (same line)', async () => {
    const file = copy('lf.md', 'race-line.md');
    const { uri, doc } = await openLive(file);
    const ext = new vscode.WorkspaceEdit();
    ext.insert(uri, new vscode.Position(2, 0), 'EXT ');
    await Promise.all([applyWebviewEdit(uri, ins(2, 5, 'WEB')), vscode.workspace.applyEdit(ext)]);
    await waitUntil(() => doc.getText().includes('EXT ') && doc.getText().includes('WEB'), 'both edits present in the document');
    let shown = await webviewText(uri);
    for (let i = 0; i < 50 && shown !== norm(doc.getText()); i++) shown = await webviewText(uri);
    assert.strictEqual(shown, norm(doc.getText()));
    await closeTab(file);
  });

  test('stress: 20 rounds of simultaneous external and webview edits with random latency never lose a webview edit', async function () {
    this.timeout(180000);
    const file = copy('lf.md', 'stress.md');
    const { uri, doc } = await openLive(file);
    await vscode.commands.executeCommand('inkwell._debugResetStats');
    await vscode.commands.executeCommand('inkwell._debugSetLatency', 200);
    try {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (let round = 0; round < 20; round++) {
        const ext = new vscode.WorkspaceEdit();
        ext.insert(uri, new vscode.Position(round % 3 === 0 ? 0 : 3, 0), `E${round}_ `);
        const web = (async () => { await sleep(Math.random() * 200); await applyWebviewEdit(uri, ins(1, 0, `W${round}_ `)); })();
        const extP = (async () => { await sleep(Math.random() * 200); for (let t = 0; t < 10 && !(await vscode.workspace.applyEdit(ext)); t++) await sleep(20); })();
        await Promise.all([web, extP]);
        await waitUntil(() => doc.getText().includes(`W${round}_ `) && doc.getText().includes(`E${round}_ `), `round ${round}: both edits in the document (have: ${JSON.stringify(doc.getText().slice(0, 120))})`);
      }
      await vscode.commands.executeCommand('inkwell._debugSetLatency', 0);
      await waitUntil(async () => (await webviewText(uri)) === norm(doc.getText()), 'webview converged to the document');
      const text = doc.getText();
      for (let round = 0; round < 20; round++) assert.ok(text.includes(`W${round}_ `) && text.includes(`E${round}_ `), `round ${round} survived`);
    } finally {
      await vscode.commands.executeCommand('inkwell._debugSetLatency', 0);
    }
    const stats = await vscode.commands.executeCommand<{ resyncs: number; resyncReasons: string[] }>('inkwell._debugStats');
    console.log('stress stats', JSON.stringify(stats));
    await closeTab(file);
  });
});
