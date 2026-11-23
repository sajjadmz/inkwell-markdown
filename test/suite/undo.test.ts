// Undo / redo through the webview: CodeMirror's own history, reached by the real key path.
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { closeTab, openLive, rmDir, tmpDir, waitUntil } from './helpers';

const cmd = <T>(c: string, ...a: unknown[]) => vscode.commands.executeCommand<T>(c, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ask = <T = any>(u: vscode.Uri, type: string, extra: object = {}) => cmd<T>('inkwell._debugAsk', u, type, extra);
const ins = (line: number, ch: number, insert: string) => ({ fromLine: line, fromCh: ch, toLine: line, toCh: ch, insert });
const MAC = process.platform === 'darwin';

suite('Undo and redo (CodeMirror history)', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  const open = async (name: string, text: string) => {
    const file = path.join(tmp, name); fs.writeFileSync(file, text);
    const r = await openLive(file);
    await cmd('workbench.action.focusActiveEditorGroup');
    await ask(r.uri, 'debugFocus');
    return { ...r, file };
  };
  /** The key press as the webview receives it. */
  const press = (u: vscode.Uri, key: string, shift = false) => ask(u, 'debugKey', { key, meta: MAC, ctrl: !MAC, shift });
  const settle = async () => { await sleep(500); };
  const wv = (u: vscode.Uri) => cmd<string>('inkwell._debugGetWebviewText', u);

  test('Mod-Z in the focused editor reverts the typed text, Mod-Shift-Z redoes it', async () => {
    const T = 'one\ntwo\nthree\n';
    const { uri, doc, file } = await open('u1.md', T);
    await ask(uri, 'debugEdit', { change: ins(1, 0, 'TYPED ') });
    await waitUntil(() => doc.getText() === 'one\nTYPED two\nthree\n', 'typed text in document');
    await press(uri, 'z');
    await waitUntil(() => doc.getText() === T, 'undo reached the document');
    assert.strictEqual(await wv(uri), T);
    await doc.save();
    assert.strictEqual(fs.readFileSync(file, 'utf8'), T, 'bytes equal the original');
    await press(uri, 'z', true);
    await waitUntil(() => doc.getText() === 'one\nTYPED two\nthree\n', 'redo');
    assert.strictEqual(await wv(uri), 'one\nTYPED two\nthree\n');
    await closeTab(file);
  });

  test('the inkwell.undo / inkwell.redo commands (keybinding path) undo and redo', async () => {
    const T = 'one\ntwo\n';
    const { uri, doc, file } = await open('u2.md', T);
    await ask(uri, 'debugEdit', { change: ins(0, 0, 'X') });
    await waitUntil(() => doc.getText() === 'Xone\ntwo\n', 'typed');
    await cmd('inkwell.undo');
    await waitUntil(() => doc.getText() === T, 'undo');
    await cmd('inkwell.redo');
    await waitUntil(() => doc.getText() === 'Xone\ntwo\n', 'redo');
    await closeTab(file);
  });

  test('one key press reverts exactly one history step (no double undo)', async () => {
    const T = 'a\nb\nc\n';
    const { uri, doc, file } = await open('u3.md', T);
    await ask(uri, 'debugEdit', { change: ins(0, 1, '1') }); await sleep(700);
    await ask(uri, 'debugEdit', { change: ins(1, 1, '2') }); await sleep(700);
    await ask(uri, 'debugEdit', { change: ins(2, 1, '3') });
    await waitUntil(() => doc.getText() === 'a1\nb2\nc3\n', 'three edits');
    await press(uri, 'z');
    await waitUntil(() => doc.getText() === 'a1\nb2\nc\n', 'first undo');
    await settle();
    assert.strictEqual(doc.getText(), 'a1\nb2\nc\n', 'still exactly one step undone');
    await cmd('inkwell.undo');
    await waitUntil(() => doc.getText() === 'a1\nb\nc\n', 'second undo');
    await settle();
    assert.strictEqual(doc.getText(), 'a1\nb\nc\n');
    await closeTab(file);
  });

  test('undo after an external edit reverts only the local edit', async () => {
    const T = 'one\ntwo\nthree\n';
    const { uri, doc, file } = await open('u4.md', T);
    await ask(uri, 'debugEdit', { change: ins(1, 0, 'WEB ') });
    await waitUntil(() => doc.getText() === 'one\nWEB two\nthree\n', 'local');
    const ext = new vscode.WorkspaceEdit(); ext.insert(uri, new vscode.Position(2, 0), 'EXT ');
    await vscode.workspace.applyEdit(ext);
    await waitUntil(async () => (await wv(uri)) === 'one\nWEB two\nEXT three\n', 'webview has the external edit');
    await press(uri, 'z');
    await waitUntil(() => doc.getText() === 'one\ntwo\nEXT three\n', 'only WEB reverted');
    await settle();
    assert.strictEqual(doc.getText(), 'one\ntwo\nEXT three\n');
    assert.strictEqual(await wv(uri), 'one\ntwo\nEXT three\n');
    // Nothing more to undo: the external edit (and the initial load) are not in history.
    await press(uri, 'z'); await settle();
    assert.strictEqual(doc.getText(), 'one\ntwo\nEXT three\n', 'a second undo must not touch remote text');
    await closeTab(file);
  });

  test('undo never reverts the initial load', async () => {
    const T = 'start\n';
    const { uri, doc, file } = await open('u5.md', T);
    await press(uri, 'z'); await settle();
    assert.strictEqual(doc.getText(), T);
    assert.strictEqual(await wv(uri), T);
    await closeTab(file);
  });

  test('bold from the toolbar is undone byte for byte', async () => {
    const T = 'hello world\n';
    const { uri, doc, file } = await open('u6.md', T);
    await ask(uri, 'debugSelect', { fromLine: 0, fromCh: 0, toLine: 0, toCh: 5 });
    await cmd('inkwell._debugAction', uri, 'bold');
    await waitUntil(() => doc.getText() === '**hello** world\n', 'bold');
    await press(uri, 'z');
    await waitUntil(() => doc.getText() === T, 'bold undone');
    await closeTab(file);
  });

  test('a table cell edit is undone by Mod-Z inside the cell, byte for byte', async () => {
    const T = '| a | b |\n|---|---|\n| 1 | 2 |\n';
    const { uri, doc, file } = await open('u7.md', T);
    await ask(uri, 'debugTable', { r: 1, c: 1, text: '9' });
    await waitUntil(() => doc.getText() === T.replace('| 2 |', '| 9 |'), 'cell edited');
    await ask(uri, 'debugFocus', { cell: { r: 1, c: 1 } });
    await press(uri, 'z');
    await waitUntil(() => doc.getText() === T, 'cell edit undone');
    await settle();
    assert.strictEqual(doc.getText(), T);
    await ask(uri, 'debugFocus', { cell: { r: 1, c: 1 } });
    await press(uri, 'z', true);
    await waitUntil(() => doc.getText() === T.replace('| 2 |', '| 9 |'), 'cell edit redone');
    await closeTab(file);
  });

  test('a checkbox click is undone', async () => {
    const T = '- [ ] task\n- [ ] other\n';
    const { uri, doc, file } = await open('u8.md', T);
    await cmd('inkwell._debugMoveCursor', uri, 1, 0);
    await cmd('inkwell._debugClickCheckbox', uri, 0);
    await waitUntil(() => doc.getText() === '- [x] task\n- [ ] other\n', 'checked');
    await ask(uri, 'debugFocus');
    await press(uri, 'z');
    await waitUntil(() => doc.getText() === T, 'unchecked');
    await closeTab(file);
  });
});
