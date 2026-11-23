// Adversarial data-safety tests (independent review). Not part of the shipped suite until the CPTO decides.
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Edit, applyWebviewEdit, closeTab, commonAffixes, openLive, rmDir, tmpDir, waitFor, webviewText } from './helpers';

const ins = (line: number, ch: number, insert: string): Edit => ({ fromLine: line, fromCh: ch, toLine: line, toCh: ch, insert });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function converged(uri: vscode.Uri, doc: vscode.TextDocument): Promise<string> {
  const want = doc.getText().replace(/\r\n?/g, '\n');
  let shown = await webviewText(uri);
  for (let i = 0; i < 50 && shown !== want; i++) { await sleep(50); shown = await webviewText(uri); }
  return shown;
}
/** VS Code line/char of the first occurrence of `marker` end, splitting lines like VS Code (\r\n | \r | \n). */
function posAfter(text: string, marker: string): { line: number; ch: number; off: number } {
  const off = text.indexOf(marker) + marker.length;
  const pre = text.slice(0, off);
  const parts = pre.split(/\r\n|\r|\n/);
  return { line: parts.length - 1, ch: parts[parts.length - 1].length, off };
}

suite('ADV data safety', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  const write = (name: string, content: string | Buffer) => { const f = path.join(tmp, name); fs.writeFileSync(f, content); return f; };

  const weird: Array<[string, string]> = [
    ['lone-cr', 'one\rtwo\rMARK three\r'],
    ['u2028', 'a b c\nMARK d\n'],
    ['nel-ff', 'a\u0085b\fc\nMARK d\n'],
    ['mixed', 'l1\r\nl2\nl3\rMARK l4\r\nl5\n'],
    ['emoji', '😀 MARK tail\n中文字符 text\n'],
    ['combining', 'éé 😀👨‍👩‍👧 MARK x\n'],
  ];
  for (const [name, content] of weird) {
    test(`ADV1/2 open+close changes zero bytes: ${name}`, async () => {
      const file = write(name + '-oc.md', content);
      const before = fs.readFileSync(file);
      const { doc } = await openLive(file);
      assert.strictEqual(doc.isDirty, false);
      await closeTab(file);
      assert.strictEqual(doc.isDirty, false);
      assert.deepStrictEqual(fs.readFileSync(file), before);
    });
    test(`ADV1/2 edit after special chars hits the intended place: ${name}`, async () => {
      const file = write(name + '-ed.md', content);
      const before = fs.readFileSync(file);
      const { uri, doc } = await openLive(file);
      const p = posAfter(doc.getText(), 'MARK');
      // webview coordinates == VS Code coordinates (both UTF-16 units, line breaks \r\n|\r|\n)
      await applyWebviewEdit(uri, ins(p.line, p.ch, '<<X>>'));
      const text = doc.getText();
      assert.strictEqual(text.indexOf('MARK<<X>>') >= 0, true, `inserted right after MARK: ${JSON.stringify(text)}`);
      assert.strictEqual(text.split('<<X>>').length, 2);
      assert.strictEqual(await converged(uri, doc), text.replace(/\r\n?/g, '\n'));
      await doc.save();
      const after = fs.readFileSync(file);
      // Report (not fail) EOL normalisation by VS Code on mixed-EOL files, but the inserted token must be the only content change.
      const strip = (b: Buffer) => b.toString('utf8').replace('<<X>>', '').replace(/\r\n?/g, '\n');
      assert.strictEqual(strip(after), before.toString('utf8').replace(/\r\n?/g, '\n'), 'only the token was added (modulo EOL)');
      if (!after.toString('utf8').replace('<<X>>', '').endsWith(before.toString('utf8').slice(-1))) console.log('note: EOL changed', name);
      if (Buffer.compare(Buffer.from(after.toString('utf8').replace('<<X>>', '')), before) !== 0) console.log(`NOTE ${name}: bytes differ beyond token (EOL normalisation by VS Code?)`, JSON.stringify(after.toString('utf8')), 'vs', JSON.stringify(before.toString('utf8')));
      else { const { prefix, suffix } = commonAffixes(before, after); assert.ok(prefix + suffix >= before.length); }
      await closeTab(file);
    });
  }

  test('ADV3 200 back-to-back single-char edits then immediate save', async () => {
    const file = write('burst.md', 'start\n');
    const { uri, doc } = await openLive(file);
    const chars = Array.from({ length: 200 }, (_, i) => String.fromCharCode(97 + (i % 26)));
    await Promise.all(chars.map((c, i) => applyWebviewEdit(uri, ins(0, 5 + i, c))));
    await doc.save();
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'start' + chars.join('') + '\n');
    assert.strictEqual(await converged(uri, doc), 'start' + chars.join('') + '\n');
    await closeTab(file);
  });

  test('ADV4 external write while DIRTY never overwrites the unsaved edit', async () => {
    const file = write('dirty.md', '# a\n\nbody\n');
    const { uri, doc } = await openLive(file);
    await applyWebviewEdit(uri, ins(2, 4, ' MINE'));
    assert.ok(doc.isDirty);
    const mine = doc.getText();
    fs.writeFileSync(file, '# EXTERNAL\n');
    await sleep(3000);
    assert.strictEqual(doc.getText(), mine, 'document keeps the user version');
    assert.ok(doc.isDirty, 'still dirty');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '# EXTERNAL\n', 'extension did not write to disk');
    assert.strictEqual(await converged(uri, doc), mine.replace(/\r\n/g, '\n'));
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await closeTab(file);
  });

  test('ADV5 two editors on one file: both directions, no duplication', async () => {
    const file = write('two.md', 'alpha\nbeta\n');
    const { uri, doc } = await openLive(file);
    const ed = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    assert.strictEqual(await vscode.commands.executeCommand('inkwell._debugSessionCount', uri), 1);
    await ed.edit((b) => b.insert(new vscode.Position(0, 5), 'TEXT'));
    assert.strictEqual(await converged(uri, doc), 'alphaTEXT\nbeta\n');
    await applyWebviewEdit(uri, ins(1, 4, 'WEB'));
    assert.strictEqual(doc.getText(), 'alphaTEXT\nbetaWEB\n');
    assert.strictEqual(ed.document.getText(), 'alphaTEXT\nbetaWEB\n');
    assert.strictEqual(await converged(uri, doc), 'alphaTEXT\nbetaWEB\n');
    await doc.save();
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'alphaTEXT\nbetaWEB\n');
    await closeTab(file); await closeTab(file);
  });

  test('ADV6 webview edit, external change, undo: sane, no duplication', async () => {
    const file = write('undo.md', 'one\ntwo\nthree\n');
    const { uri, doc } = await openLive(file);
    await applyWebviewEdit(uri, ins(1, 0, 'WEB '));
    const ext = new vscode.WorkspaceEdit(); ext.insert(uri, new vscode.Position(2, 0), 'EXT ');
    await vscode.workspace.applyEdit(ext);
    const before = doc.getText();
    assert.strictEqual(before, 'one\nWEB two\nEXT three\n');
    const changed = waitFor(() => doc.getText() !== before, vscode.workspace.onDidChangeTextDocument);
    await vscode.commands.executeCommand('undo');
    await changed;
    const t = doc.getText();
    assert.ok(['one\nWEB two\nthree\n', 'one\ntwo\nEXT three\n', 'one\ntwo\nthree\n'].includes(t), 'sane undo result: ' + JSON.stringify(t));
    assert.strictEqual(await converged(uri, doc), t);
    await closeTab(file);
  });
});
