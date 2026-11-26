// 0.8.0 QA fixes: Esc in the find bar never moves the caret unless the user picked a match; Undo after an outside change can never
// replay stale edits; double-space full stop beside closing markers; block indent / outdent; numbered items restart at 1 when
// nested; Tab in plain text keeps the focus; wrapped lines of list items inside quotes hang under the item text.
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';
import { closeTab, openLive, rmDir, tmpDir, waitUntil } from './helpers';

const cmd = <T>(c: string, ...a: unknown[]) => vscode.commands.executeCommand<T>(c, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ask = <T = any>(u: vscode.Uri, type: string, extra: object = {}) => cmd<T>('inkwell._debugAsk', u, type, extra);
const act = (u: vscode.Uri, name: string, arg?: string) => cmd('inkwell._debugAction', u, name, arg);
const sel = (u: vscode.Uri, fl: number, fc: number, tl: number, tc: number) => ask(u, 'debugSelect', { fromLine: fl, fromCh: fc, toLine: tl, toCh: tc });
const MAC = process.platform === 'darwin';
const md = new MarkdownIt({ html: false });
const wv = (u: vscode.Uri) => cmd<string>('inkwell._debugGetWebviewText', u);
const toast = (u: vscode.Uri) => ask<string | null>(u, 'debugToast');
const fd = (u: vscode.Uri, op: string, extra: object = {}) => ask<any>(u, 'debugFind', { op, ...extra });
const key = (u: vscode.Uri, k: string, o: { code?: string; shift?: boolean; meta?: boolean; ctrl?: boolean } = {}) => ask<{ defaultPrevented: boolean }>(u, 'debugKey', { key: k, meta: false, ctrl: false, shift: false, ...o });
const mod = (o: { shift?: boolean } = {}) => ({ meta: MAC, ctrl: !MAC, ...o });
const undoKey = (u: vscode.Uri) => key(u, 'z', mod());
const redoKey = (u: vscode.Uri) => key(u, 'z', mod({ shift: true }));
const setConfig = (k: string, v: string | undefined) => vscode.workspace.getConfiguration('inkwell').update(k, v, vscode.ConfigurationTarget.Global);
const replaceAll = async (doc: vscode.TextDocument, text: string) => {
  const e = new vscode.WorkspaceEdit(); e.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
  await vscode.workspace.applyEdit(e);
};

let n = 0;
async function openIn(dir: string, name: string, text: string) {
  const file = path.join(dir, name); fs.writeFileSync(file, text);
  const r = await openLive(file);
  await cmd('workbench.action.focusActiveEditorGroup'); await ask(r.uri, 'debugFocus');
  return { ...r, file };
}

// ------------------------------------------------------------------------------------------------------------- 1: Esc in find
suite('0.8.0 fixes 1: Esc in the find bar never moves the caret by itself', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  const D3 = 'Apple one\n\nsecond para here\n\nApple three\n';
  async function remember(uri: vscode.Uri) { await fd(uri, 'open'); await fd(uri, 'query', { value: 'Apple' }); await fd(uri, 'close', { keep: false }); }

  test('open with the remembered query, Esc at once: the caret is where it was and the next keystroke goes there', async () => {
    const { uri, doc, file } = await openIn(tmp, `e${++n}.md`, D3);
    await remember(uri);
    await cmd('inkwell._debugMoveCursor', uri, 2, 'second para here'.length);
    await key(uri, 'f', { code: 'KeyF', ...mod() });
    let s = await fd(uri, 'state'); assert.strictEqual(s.open, true); assert.strictEqual(s.query, 'Apple'); assert.ok(s.count >= 1);
    await key(uri, 'Escape', { code: 'Escape' });
    s = await fd(uri, 'state'); assert.strictEqual(s.open, false);
    assert.strictEqual(s.sel.from, s.sel.to, 'nothing is selected'); assert.strictEqual(s.sel.from, doc.offsetAt(new vscode.Position(2, 16)));
    await ask(uri, 'debugTypeText', { text: 'X' });
    assert.strictEqual(doc.lineAt(2).text, 'second para hereX'); assert.strictEqual(doc.lineAt(0).text, 'Apple one'); assert.strictEqual(doc.lineAt(4).text, 'Apple three');
    await closeTab(file);
  });
  test('a selection that was there is restored too', async () => {
    const { uri, doc, file } = await openIn(tmp, `e${++n}.md`, D3);
    await remember(uri);
    await sel(uri, 2, 7, 2, 11); // "para"
    await key(uri, 'f', { code: 'KeyF', ...mod() });
    await key(uri, 'Escape', { code: 'Escape' });
    const s = await fd(uri, 'state'); assert.strictEqual(s.sel.text, 'para');
    await ask(uri, 'debugTypeText', { text: 'Z' }); assert.strictEqual(doc.lineAt(2).text, 'second Z here');
    await closeTab(file);
  });
  test('the user moved to a match (typed, Next, Enter): Esc selects it, like Word', async () => {
    const { uri, file, doc } = await openIn(tmp, `e${++n}.md`, D3);
    await cmd('inkwell._debugMoveCursor', uri, 2, 3);
    await fd(uri, 'open'); await fd(uri, 'query', { value: 'Apple' });
    await key(uri, 'Escape', { code: 'Escape' });
    let s = await fd(uri, 'state'); assert.strictEqual(s.sel.text, 'Apple', 'typing the query chose a match');
    await cmd('inkwell._debugMoveCursor', uri, 2, 3);
    await fd(uri, 'open'); await fd(uri, 'press', { value: 'next' });
    await key(uri, 'Escape', { code: 'Escape' });
    s = await fd(uri, 'state'); assert.strictEqual(s.sel.text, 'Apple', 'Next chose a match');
    await cmd('inkwell._debugMoveCursor', uri, 2, 3);
    await key(uri, 'f', { code: 'KeyF', ...mod() }); await key(uri, 'Enter', { code: 'Enter' }); await key(uri, 'Escape', { code: 'Escape' });
    s = await fd(uri, 'state'); assert.strictEqual(s.sel.text, 'Apple', 'Enter chose a match');
    void doc;
    await closeTab(file);
  });
  test('the close button behaves like Esc', async () => {
    const { uri, file } = await openIn(tmp, `e${++n}.md`, D3);
    await remember(uri);
    await cmd('inkwell._debugMoveCursor', uri, 2, 4);
    await fd(uri, 'open'); await fd(uri, 'press', { value: 'close' });
    const s = await fd(uri, 'state'); assert.strictEqual(s.sel.from, s.sel.to);
    await closeTab(file);
  });
  const T = 'intro\n\n| a | b |\n| --- | --- |\n| Apple x | y |\n| second cell | z |\n| Apple q | w |\n';
  test('table cell: open and Esc puts the caret back in the same cell; typing lands there, not in another row', async () => {
    const { uri, doc, file } = await openIn(tmp, `e${++n}.md`, T);
    await remember(uri);
    await ask(uri, 'debugTable', { r: 2, c: 0, op: 'toolbar', at: 6 }); // "second| cell"
    await key(uri, 'f', { code: 'KeyF', ...mod() });
    await key(uri, 'Escape', { code: 'Escape' });
    const s = await fd(uri, 'state');
    assert.ok(s.cellSel, 'a cell has the focus'); assert.strictEqual(s.cellSel.r, '2'); assert.strictEqual(s.cellSel.c, '0'); assert.strictEqual(s.cellSel.from, 6); assert.strictEqual(s.cellSel.to, 6);
    const text = await ask<string>(uri, 'debugTypeCell', { text: 'Q' });
    assert.strictEqual(text, 'secondQ cell');
    await waitUntil(() => doc.getText().includes('| secondQ cell | z |'), 'typed in the cell the caret was in');
    assert.ok(doc.getText().includes('| Apple x | y |') && doc.getText().includes('| Apple q | w |'));
    await closeTab(file);
  });
  test('table cell match chosen by the user: Esc focuses that cell with the match selected', async () => {
    const { uri, file } = await openIn(tmp, `e${++n}.md`, T);
    await cmd('inkwell._debugMoveCursor', uri, 0, 2);
    await fd(uri, 'open'); await fd(uri, 'query', { value: 'Apple q' });
    await key(uri, 'Escape', { code: 'Escape' });
    const s = await fd(uri, 'state'); assert.ok(s.cellSel); assert.strictEqual(s.cellSel.text, 'Apple q'); assert.strictEqual(s.cellSel.r, '3');
    await closeTab(file);
  });
});

// ------------------------------------------------------------------------------------------------------------- 2: stale undo
suite('0.8.0 fixes 2: Undo after an outside change cannot replay stale edits', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  const TABLE = 'intro\n\n| Area | Notes |\n| --- | --- |\n| Alpha | First row |\n| Beta | Second row |\n| Gamma | Third row |\n\nend\n';
  const LIST = '# T\n\n- Alpha item\n    - Nested beta\n        - Deep gamma\n- Second\n\n1. one\n2. two\n\nend\n';

  test('typed in a cell, another program reverts the file, Undo: the file stays exactly as the other program left it', async () => {
    const { uri, doc, file } = await openIn(tmp, `x${++n}.md`, TABLE);
    await ask(uri, 'debugTable', { r: 2, c: 1, text: 'Second row edited by me' });
    await waitUntil(() => doc.getText().includes('Second row edited by me'), 'typed');
    await replaceAll(doc, TABLE);
    await waitUntil(async () => (await wv(uri)) === TABLE, 'webview shows the outside text');
    assert.match((await toast(uri)) ?? '', /changed by another program, so Undo starts fresh/);
    await ask(uri, 'debugFocus');
    await undoKey(uri); await sleep(600);
    assert.strictEqual(doc.getText(), TABLE, 'Undo did nothing to the reverted file'); assert.strictEqual(await wv(uri), TABLE);
    await redoKey(uri); await sleep(400);
    assert.strictEqual(doc.getText(), TABLE, 'and Redo has nothing to replay either');
    await closeTab(file);
  });
  test('list outdent, another program reverts the file, Undo: nothing is corrupted', async () => {
    const { uri, doc, file } = await openIn(tmp, `x${++n}.md`, LIST);
    await sel(uri, 4, 4, 4, 4); await act(uri, 'outdent');
    await waitUntil(() => doc.getText() !== LIST, 'outdented');
    await replaceAll(doc, LIST);
    await waitUntil(async () => (await wv(uri)) === LIST, 'webview shows the outside text');
    await undoKey(uri); await sleep(600);
    assert.strictEqual(doc.getText(), LIST); assert.strictEqual(await wv(uri), LIST);
    await closeTab(file);
  });
  test('another program rewrites the same line a local edit touched: history starts fresh', async () => {
    const { uri, doc, file } = await openIn(tmp, `x${++n}.md`, LIST);
    await sel(uri, 5, 8, 5, 8); await ask(uri, 'debugTypeText', { text: ' zz' });
    await waitUntil(() => doc.lineAt(5).text === '- Second zz', 'typed');
    await replaceAll(doc, LIST.replace('- Second', '- Second REWRITTEN'));
    await waitUntil(async () => (await wv(uri)).includes('REWRITTEN'), 'outside edit arrived');
    await undoKey(uri); await sleep(500);
    assert.strictEqual(doc.getText(), LIST.replace('- Second', '- Second REWRITTEN'));
    await closeTab(file);
  });
  test('an outside change somewhere else keeps Undo working (and the outside text)', async () => {
    const { uri, doc, file } = await openIn(tmp, `x${++n}.md`, LIST);
    await sel(uri, 5, 8, 5, 8); await ask(uri, 'debugTypeText', { text: ' zz' });
    await waitUntil(() => doc.lineAt(5).text === '- Second zz', 'typed');
    const e = new vscode.WorkspaceEdit(); e.insert(uri, new vscode.Position(0, 3), 'itle from outside'); e.insert(uri, doc.positionAt(doc.getText().length), 'appended by a tool\n'); await vscode.workspace.applyEdit(e);
    await waitUntil(async () => (await wv(uri)).includes('appended by a tool'), 'outside edit arrived');
    assert.strictEqual(await toast(uri), null, 'no note: history is intact');
    await undoKey(uri);
    await waitUntil(() => doc.lineAt(5).text === '- Second', 'the local edit is undone');
    assert.strictEqual(doc.getText(), LIST.replace('# T', '# Title from outside') + 'appended by a tool\n');
    await closeTab(file);
  });
  test('an outside append right after the place of the last edit counts as touching: history starts fresh', async () => {
    const { uri, doc, file } = await openIn(tmp, `x${++n}.md`, 'one\ntwo\n');
    await sel(uri, 1, 3, 1, 3); await ask(uri, 'debugTypeText', { text: '!' });
    await waitUntil(() => doc.getText() === 'one\ntwo!\n', 'typed');
    const e = new vscode.WorkspaceEdit(); e.insert(uri, new vscode.Position(1, 4), 'X'); await vscode.workspace.applyEdit(e);
    await waitUntil(async () => (await wv(uri)) === 'one\ntwo!X\n', 'outside');
    await undoKey(uri); await sleep(500);
    assert.strictEqual(doc.getText(), 'one\ntwo!X\n');
    await closeTab(file);
  });
});

// ------------------------------------------------------------------------------------------------------------- 3 + 4: double space
suite('0.8.0 fixes 3-4: double-space full stop after and before closing markers', () => {
  const tmp = tmpDir();
  suiteTeardown(async () => { await setConfig('doubleSpacePeriod', undefined); rmDir(tmp); });
  suiteSetup(async () => { await setConfig('doubleSpacePeriod', 'on'); });
  const SPAN = '<span style="color:#d00000">red</span>', MARK = '<mark style="background:rgba(255,235,59,.5)">hi</mark>';

  test('after a closing ~~, </span>, </mark> and the other closing tags: ". " is added', async () => {
    const lines = ['Say ~~gone~~', `Say ${SPAN}`, `Say ${MARK}`, 'Say <b>x</b>', 'Say <i>x</i>', 'Say <u>x</u>', 'Say <s>x</s>', 'Say <del>x</del>', 'Say <strong>x</strong>', 'Say <em>x</em>'];
    const { uri, doc, file } = await openIn(tmp, `d${++n}.md`, lines.join('\n') + '\n');
    for (let i = 0; i < lines.length; i++) {
      await cmd('inkwell._debugMoveCursor', uri, i, lines[i].length);
      await ask(uri, 'debugTypeText', { text: '  ' });
      assert.strictEqual(doc.lineAt(i).text, lines[i] + '. ', `line ${i}: ${lines[i]}`);
    }
    await closeTab(file);
  });
  test('not after an opening ~~ or tag, not after a lone "~~"', async () => {
    const lines = ['Say ~~', `Say <span style="color:#d00000">`, 'Say <b>'];
    const { uri, doc, file } = await openIn(tmp, `d${++n}.md`, lines.join('\n') + '\n');
    for (let i = 0; i < lines.length; i++) {
      await cmd('inkwell._debugMoveCursor', uri, i, lines[i].length);
      await ask(uri, 'debugTypeText', { text: '  ' });
      assert.ok(!doc.lineAt(i).text.includes('. '), `line ${i}: ${doc.lineAt(i).text}`);
    }
    await closeTab(file);
  });
  const SPANO = '<span style="color:#d00000">';
  /** "|" marks the caret; the expectation has a "Q" where the caret must be after the two spaces. */
  const BEFORE: Array<[string, string]> = [
    ['a **bold|** z', 'a **bold.** Qz'], ['a *it|* z', 'a *it.* Qz'], ['a ***bi|*** z', 'a ***bi.*** Qz'], ['a ~~s|~~ z', 'a ~~s.~~ Qz'], ['a _u|_ z', 'a _u._ Qz'],
    ['a <b>x|</b> z', 'a <b>x.</b> Qz'], ['a <i>x|</i> z', 'a <i>x.</i> Qz'], ['a <u>x|</u> z', 'a <u>x.</u> Qz'], ['a <s>x|</s> z', 'a <s>x.</s> Qz'], ['a <del>x|</del> z', 'a <del>x.</del> Qz'],
    ['a <strong>x|</strong> z', 'a <strong>x.</strong> Qz'], ['a <em>x|</em> z', 'a <em>x.</em> Qz'], [`a ${SPANO}red|</span> z`, `a ${SPANO}red.</span> Qz`],
    ['a **_x|_** z', 'a **_x._** Qz'], ['a **bold|**', 'a **bold.** Q'], ['a **bold|**more', 'a **bold.** Qmore'],
  ];
  test('caret right before closing markers: the full stop goes inside, the space after, the caret after that space', async () => {
    for (const [marked, want] of BEFORE) {
      const col = marked.indexOf('|');
      const { uri, doc, file } = await openIn(tmp, `d${++n}.md`, marked.replace('|', '') + '\n');
      await cmd('inkwell._debugMoveCursor', uri, 0, col);
      await ask(uri, 'debugTypeText', { text: '  Q' });
      assert.strictEqual(doc.lineAt(0).text, want, marked);
      await closeTab(file);
    }
  });

  test('one Undo gives back exactly the two typed spaces; Redo reapplies', async () => {
    const { uri, doc, file } = await openIn(tmp, `d${++n}.md`, 'a **bold** z\n');
    await cmd('inkwell._debugMoveCursor', uri, 0, 8);
    await ask(uri, 'debugTypeText', { text: '  ' });
    assert.strictEqual(doc.lineAt(0).text, 'a **bold.** z');
    await undoKey(uri); await waitUntil(() => doc.lineAt(0).text === 'a **bold  ** z', 'two spaces back');
    await redoKey(uri); await waitUntil(() => doc.lineAt(0).text === 'a **bold.** z', 'redo');
    await closeTab(file);
  });
  test('negatives: punctuation right after the markers, an opening marker, code', async () => {
    const cases: Array<[string, number]> = [['a **bold**. z', 8], ['a bold**next** z', 6], ['a `code` z', 7]];
    for (const [line, col] of cases) {
      const { uri, doc, file } = await openIn(tmp, `d${++n}.md`, line + '\n');
      await cmd('inkwell._debugMoveCursor', uri, 0, col);
      await ask(uri, 'debugTypeText', { text: '  ' });
      if (line === 'a bold**next** z') assert.strictEqual(doc.lineAt(0).text, 'a bold. **next** z');
      else assert.strictEqual(doc.lineAt(0).text, line.slice(0, col) + '  ' + line.slice(col), line);
      await closeTab(file);
    }
  });
  test('table cells: after closing ~~ / </span> / </mark>, and before closing markers', async () => {
    const cells = ['~~gone~~', SPAN, MARK, '**bold**', 'x'];
    const T = '| a | b |\n| --- | --- |\n' + cells.map((c) => `| ${c} | z |`).join('\n') + '\n';
    const { uri, doc, file } = await openIn(tmp, `d${++n}.md`, T);
    const caretIn = (r: number, c: number, at: number) => ask(uri, 'debugTable', { r, c, op: 'toolbar', at });
    const type = (text: string) => ask<string>(uri, 'debugTypeCell', { text });
    await caretIn(1, 0, cells[0].length); assert.strictEqual(await type('  '), '~~gone~~. ');
    await caretIn(2, 0, cells[1].length); assert.strictEqual(await type('  '), SPAN + '. ');
    await caretIn(3, 0, cells[2].length); assert.strictEqual(await type('  '), MARK + '. ');
    await caretIn(4, 0, 6); assert.strictEqual(await type('  Q'), '**bold.** Q'); // before the closing **
    await waitUntil(() => doc.lineAt(5).text === '| **bold.** Q | z |', 'document has it');
    await closeTab(file);
  });
});

// ------------------------------------------------------------------------------------------------------------- 5 + 6: indent
suite('0.8.0 fixes 5-6: block indent / outdent and numbered items', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  async function run(text: string, s: [number, number, number, number], steps: string[]) {
    const { uri, doc, file } = await openIn(tmp, `i${++n}.md`, text);
    await sel(uri, ...s);
    const out: string[] = [];
    for (const a of steps) { await act(uri, a); out.push(doc.getText()); }
    const note = await toast(uri);
    await closeTab(file);
    return { out, note };
  }
  const nested = (text: string, re: string) => assert.ok(new RegExp(re).test(md.render(text).replace(/\n/g, '')), `${JSON.stringify(text)} renders nested: ${md.render(text)}`);

  test('select all: the first item stays, the rest move as a block under it (relative nesting kept)', async () => {
    assert.strictEqual((await run('- a\n- b\n- c\n', [0, 0, 2, 3], ['indent'])).out[0], '- a\n  - b\n  - c\n');
    const r = await run('- a\n- b\n  - c\n- d\n', [0, 0, 3, 3], ['indent']);
    assert.strictEqual(r.out[0], '- a\n  - b\n    - c\n  - d\n'); assert.strictEqual(r.note, null);
    nested(r.out[0], '<li>a<ul><li>b<ul><li>c</li></ul></li><li>d</li></ul></li>');
  });
  test('selection that includes the first item and nested items with 4-space indentation', async () => {
    const T = '- aa\n    - bb\n        - cc\n- dd\n- ee\n\ntail\n';
    const r = await run(T, [0, 0, 4, 4], ['indent', 'outdent']);
    assert.strictEqual(r.out[0], '- aa\n    - bb\n        - cc\n  - dd\n  - ee\n\ntail\n', 'only what can move moves');
  });
  test('a selected child follows its selected parent by the same number of columns', async () => {
    const r = await run('- a\n- b\n    - c\n', [1, 0, 2, 7], ['indent']);
    assert.strictEqual(r.out[0], '- a\n  - b\n      - c\n');
  });
  test('only a note when nothing at all could change', async () => {
    const r = await run('- a\n  - b\n    - c\n', [0, 0, 2, 7], ['indent']);
    assert.strictEqual(r.out[0], '- a\n  - b\n    - c\n'); assert.strictEqual(r.note, "This item can't be indented any further.");
  });
  test('outdent is symmetric: relative nesting kept, the outermost item stays', async () => {
    const r = await run('- a\n  - b\n    - c\n- d\n', [0, 0, 3, 3], ['outdent']);
    assert.strictEqual(r.out[0], '- a\n- b\n  - c\n- d\n');
    const r2 = await run('- aa\n    - bb\n        - cc\n- dd\n- ee\n', [0, 0, 4, 4], ['outdent']);
    assert.strictEqual(r2.out[0], '- aa\n- bb\n    - cc\n- dd\n- ee\n');
  });
  test('one Undo step for the whole block, and Redo', async () => {
    const T = '- a\n- b\n  - c\n- d\n';
    const { uri, doc, file } = await openIn(tmp, `i${++n}.md`, T);
    await sel(uri, 0, 0, 3, 3); await act(uri, 'indent');
    assert.strictEqual(doc.getText(), '- a\n  - b\n    - c\n  - d\n');
    await undoKey(uri); await waitUntil(() => doc.getText() === T, 'one undo restores every line');
    await redoKey(uri); await waitUntil(() => doc.getText() === '- a\n  - b\n    - c\n  - d\n', 'redo');
    await closeTab(file);
  });
  test('numbered: "2. two" under "1. one" nests and restarts at 1; real CommonMark nesting', async () => {
    const r = await run('1. one\n2. two\n3. three\n', [1, 1, 1, 1], ['indent']);
    assert.strictEqual(r.out[0], '1. one\n   1. two\n2. three\n'); assert.strictEqual(r.note, null); // the item after it is counted on (lists renumber, like Word)
    nested(r.out[0], '<li>one<ol[^>]*><li>two</li></ol></li>');
    assert.strictEqual((await run('5. a\n6. b\n', [1, 0, 1, 0], ['indent'])).out[0], '5. a\n   1. b\n');
    assert.strictEqual((await run('1) a\n2) b\n', [1, 0, 1, 0], ['indent'])).out[0], '1) a\n   1) b\n', 'the delimiter is kept');
  });
  test('numbered: joining an existing nested list continues its numbering (9 -> 10 widens the marker)', async () => {
    assert.strictEqual((await run('1. a\n   1. b\n2. c\n', [2, 0, 2, 0], ['indent'])).out[0], '1. a\n   1. b\n   2. c\n');
    const r = await run('1. a\n\n   9. b\n\n2. c\n', [4, 0, 4, 0], ['indent']);
    assert.strictEqual(r.out[0], '1. a\n\n   9. b\n\n   10. c\n'); assert.match(md.render(r.out[0]), /<ol start="9">[\s\S]*b[\s\S]*c[\s\S]*<\/ol>/);
  });
  test('numbered block: first restarts at 1, the others follow', async () => {
    const r = await run('1. a\n2. b\n3. c\n4. d\n', [1, 0, 2, 2], ['indent']);
    assert.strictEqual(r.out[0], '1. a\n   1. b\n   2. c\n2. d\n', 'the moved items restart, the item after them is counted on');
    const r2 = await run('1. a\n2. b\n   1. x\n3. c\n', [1, 0, 2, 5], ['indent']);
    assert.strictEqual(r2.out[0], '1. a\n   1. b\n      1. x\n2. c\n', 'a child keeps its own number');
  });
  test('numbered outdent: previous sibling number + 1 at the new level', async () => {
    assert.strictEqual((await run('1. a\n   1. b\n   2. c\n', [2, 0, 2, 0], ['outdent'])).out[0], '1. a\n   1. b\n2. c\n');
    assert.strictEqual((await run('1. a\n   1. b\n   2. c\n', [1, 0, 1, 0], ['outdent'])).out[0], '1. a\n2. b\n   1. c\n', 'the item left behind is now first in its list');
    assert.strictEqual((await run('9. a\n   1. b\n', [1, 0, 1, 0], ['outdent'])).out[0], '9. a\n10. b\n', '9 -> 10');
  });
  test('indent then outdent a numbered item and back through Undo is byte exact', async () => {
    const T = '1. one\n2. two\n3. three\n';
    const { uri, doc, file } = await openIn(tmp, `i${++n}.md`, T);
    await sel(uri, 1, 1, 1, 1); await act(uri, 'indent'); await act(uri, 'outdent');
    assert.strictEqual(doc.getText(), '1. one\n2. two\n3. three\n');
    await undoKey(uri); await waitUntil(() => doc.getText() === '1. one\n   1. two\n2. three\n', 'undo outdent');
    await undoKey(uri); await waitUntil(() => doc.getText() === T, 'undo indent');
    await closeTab(file);
  });
  test('hanging indent follows the marker width after the number changes (9. / 10.)', async () => {
    const LONG = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const T = `1. a\n\n   9. ${LONG}\n\n2. ${LONG}\n\nend\n`;
    const { uri, doc, file } = await openIn(tmp, `i${++n}.md`, T);
    await sel(uri, 4, 0, 4, 0); await act(uri, 'indent');
    await waitUntil(() => doc.lineAt(4).text.startsWith('   10. word0'), 'joined as 10.');
    await ask(uri, 'debugCursor', { line: 6, ch: 1, scroll: true }); await sleep(300);
    const rows = await ask<Array<{ text: string; first: number; wrapped: number[] }>>(uri, 'debugHang');
    const tens = rows.filter((r) => r.wrapped.length);
    assert.ok(tens.length >= 2, 'both items wrapped: ' + JSON.stringify(rows.map((r) => r.text)));
    for (const r of tens) for (const w of r.wrapped) assert.ok(Math.abs(w - r.first) < 1, `wrapped at ${w}, text starts at ${r.first}: ${r.text}`);
    await closeTab(file);
  });
});

// ------------------------------------------------------------------------------------------------------------- 9: Tab
suite('0.8.0 fixes 9: Tab outside lists keeps the focus in the editor', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  test('Tab / Shift+Tab on a paragraph, a quote or a heading: nothing is typed, focus stays, the note says why', async () => {
    for (const [name, T] of [['paragraph', 'hello world\n\n- [ ] task\n'], ['quote', '> quoted\n\n- [ ] task\n'], ['heading', '# Title\n\n- [ ] task\n']] as const) {
      const { uri, doc, file } = await openIn(tmp, `t${++n}.md`, T);
      await cmd('inkwell._debugMoveCursor', uri, 0, 2);
      for (const shift of [false, true]) {
        const r = await key(uri, 'Tab', { shift }); assert.ok(r.defaultPrevented, `${name} shift=${shift}`);
        assert.strictEqual(doc.getText(), T, name);
        assert.strictEqual(await toast(uri), 'Indent works on bullet and numbered lists.', name);
      }
      await closeTab(file);
    }
  });
  test('inside a fenced code block Tab keeps its old behaviour; Escape then Tab may leave the editor', async () => {
    const { uri, doc, file } = await openIn(tmp, `t${++n}.md`, '```\ncode\n```\n\npara\n');
    await cmd('inkwell._debugMoveCursor', uri, 1, 2);
    let r = await key(uri, 'Tab'); assert.ok(!r.defaultPrevented, 'code block: unchanged behaviour'); assert.strictEqual(doc.getText(), '```\ncode\n```\n\npara\n');
    await cmd('inkwell._debugMoveCursor', uri, 4, 2);
    await key(uri, 'Escape');
    r = await key(uri, 'Tab'); assert.ok(!r.defaultPrevented, 'Escape then Tab leaves the editor');
    r = await key(uri, 'Tab'); assert.ok(r.defaultPrevented, 'the next Tab stays');
    await closeTab(file);
  });
});

// ------------------------------------------------------------------------------------------------------------- 7: hanging in quotes
suite('0.8.0 fixes 7: list items inside quotes hang their wrapped lines', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  const LONG = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
  const DOC = [`> - ${LONG}`, `>   - ${LONG}`, `> 1. ${LONG}`, `> 10. ${LONG}`, `> - [ ] ${LONG}`, '> - hard wrapped', `>   second source line ${LONG}`, '', `> > - ${LONG}`, `> > 1. ${LONG}`, '', 'end', ''].join('\n');
  async function check(uri: vscode.Uri, lines: number[], active: boolean) {
    const seen = new Map<string, { text: string; first: number; wrapped: number[] }>();
    for (const line of lines) {
      if (active) { await ask(uri, 'debugCursor', { line, ch: 8, scroll: true }); await sleep(250); }
      else {
        await ask(uri, 'debugCursor', { line: 11, ch: 1, scroll: false });
        await ask(uri, 'debugCursor', { line, ch: 1, scroll: true }); await sleep(250);
        await ask(uri, 'debugCursor', { line: 11, ch: 1 }); await sleep(150);
      }
      for (const r of await ask<Array<{ text: string; first: number; wrapped: number[] }>>(uri, 'debugHang')) seen.set(r.text + ':' + line, r);
    }
    return [...seen.values()];
  }
  test('wrapped lines start where the item text starts: bullets, numbers, checklists, hard-wrapped lines, nested quotes', async () => {
    const { uri, file } = await openIn(tmp, `q${++n}.md`, DOC);
    const rows = await check(uri, [0, 1, 2, 3, 4, 5, 8, 9], false);
    assert.ok(rows.filter((r) => r.wrapped.length).length >= 7, 'items really wrapped');
    for (const r of rows) for (const w of r.wrapped) assert.ok(Math.abs(w - r.first) < 1, `wrapped line at ${w} but text starts at ${r.first}: ${r.text}`);
    await closeTab(file);
  });
  test('the same while the caret is inside the item (raw markers shown)', async () => {
    const { uri, file } = await openIn(tmp, `q${++n}.md`, DOC);
    const rows = await check(uri, [0, 1, 2, 3, 4, 8, 9], true);
    assert.ok(rows.filter((r) => r.wrapped.length).length >= 5, 'items really wrapped');
    for (const r of rows) for (const w of r.wrapped) assert.ok(Math.abs(w - r.first) < 1, `active: wrapped ${w} vs ${r.first}: ${r.text}`);
    await closeTab(file);
  });
});
