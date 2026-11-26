// 0.8.0 lists: Enter, Shift+Enter, Backspace, Delete, renumbering and the caret after indent work like Word.
// Two layers: the editing functions on a plain CodeMirror state (every case, fast), and the real webview with real key events,
// the file on disk, CRLF, Undo and changes made by another program.
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { EditorSelection, EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { closeTab, openLive, rmDir, tmpDir, waitUntil } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../../../dist/listedit.js') as any;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const C = require('../../../dist/celllist.js') as any;

// ------------------------------------------------------------------------------------------------ state level
const mk = (doc: string, renumber = true): EditorState => {
  const i = Math.max(0, doc.indexOf('|')); const d = doc.replace('|', '');
  return EditorState.create({ doc: d, selection: EditorSelection.cursor(i), extensions: [markdown({ base: markdownLanguage }), ...(renumber ? [L.listRenumber(() => true)] : [])] });
};
const show = (st: EditorState): string => { const h = st.selection.main.head; const t = st.doc.toString(); return t.slice(0, h) + '|' + t.slice(h); };
type Op = 'enter' | 'soft' | 'bs' | 'del';
const OPS = { enter: L.enterSpec, soft: L.softBreakSpec, bs: L.backspaceSpec, del: L.deleteSpec };
/** Runs the key on `doc` (the caret is the "|") and returns the result with the caret, or null when the editor would do its normal thing. */
const key = (doc: string, op: Op): string | null => { const st = mk(doc); const s = OPS[op](st); return s ? show(st.update(s).state) : null; };
const typed = (doc: string, text: string): string => { const st = mk(doc); const h = st.selection.main.head; return show(st.update({ changes: { from: h, insert: text }, selection: { anchor: h + text.length }, userEvent: 'input.type' }).state); };

suite('Lists (editing functions)', () => {
  const E: Array<[string, string, string]> = [
    // [name, before, after]   Enter
    ['bullet, end', '- a|', '- a\n- |'],
    ['bullet * and +', '* a|\n+ b', '* a\n* |\n+ b'],
    ['numbered, end: next number', '1. a|', '1. a\n2. |'],
    ['numbered, middle of the list: the rest is renumbered', '1. a|\n2. b\n3. c', '1. a\n2. |\n3. b\n4. c'],
    ['numbered ) delimiter', '3) a|\n4) b', '3) a\n4) |\n5) b'],
    ['list starting at 5', '5. a|\n6. b', '5. a\n6. |\n7. b'],
    ['checklist: next item unchecked', '- [x] done|', '- [x] done\n- [ ] |'],
    ['checklist unchecked stays unchecked', '- [ ] a|\n- [x] b', '- [ ] a\n- [ ] |\n- [x] b'],
    ['numbered with a bold start (the owner\'s shape), loose', '1. **Five agents** work|\n\n2. **Every control** x\n\n3. y\n', '1. **Five agents** work\n\n2. |\n\n3. **Every control** x\n\n4. y\n'],
    ['loose list: the new item keeps the list loose (blank line first)', '- a|\n\n- b\n', '- a\n\n- |\n\n- b\n'],
    ['loose, last item', '1. a\n\n2. b|\n', '1. a\n\n2. b\n\n3. |\n'],
    ['tight list stays tight', '- a|\n- b\n', '- a\n- |\n- b\n'],
    ['middle of an item splits it', '- ab|cd', '- ab\n- |cd'],
    ['middle of a numbered item splits it and renumbers the rest', '1. ab|cd\n2. x', '1. ab\n2. |cd\n3. x'],
    ['before the text: an empty item appears above', '1. |a\n2. b', '1. \n2. |a\n3. b'],
    ['a selection is replaced by the break', '- a[b]c'.replace('[b]', '|'), '- a\n- |c'],
    ['"all 1." lists keep their numbers', '1. a\n1. b|\n1. c', '1. a\n1. b\n1. |\n1. c'],
    ['a single "1." goes to 2', '1. a|', '1. a\n2. |'],
    ['9 to 10: the next items are renumbered and keep their children inside', '8. a|\n9. b\n   - child\n10. c', '8. a\n9. |\n10. b\n    - child\n11. c'],
    ['indented item keeps its indentation', '- a\n  - b|', '- a\n  - b\n  - |'],
    ['nested numbered', '1. a\n   1. b|\n   2. c\n2. d', '1. a\n   1. b\n   2. |\n   3. c\n2. d'],
    ['in a quote', '> a|', '> a\n> |'],
    ['list in a quote', '> 1. a|\n> 2. b', '> 1. a\n> 2. |\n> 3. b'],
    ['loose list in a quote', '> - a|\n>\n> - b', '> - a\n>\n> - |\n>\n> - b'],
    ['bullet char and spacing are kept', '-   a|', '-   a\n-   |'],
    ['empty bullet ends the list', '- a\n- |', '- a\n|'],
    ['empty numbered item ends the list', '1. a\n2. |', '1. a\n|'],
    ['empty checklist item ends the list', '- [ ] a\n- [ ] |', '- [ ] a\n|'],
    ['empty item in a quote leaves the quote mark', '> - a\n> - |', '> - a\n> |'],
    ['empty line of a quote ends the quote', '> a\n> |', '> a\n|'],
    ['empty line of a nested quote leaves one level', '> > a\n> > |', '> > a\n> |'],
    ['empty item in the middle: the list goes on and is renumbered', '1. a\n2. |\n3. c', '1. a\n|\n2. c'],
    ['an empty nested item moves out one level', '- a\n  - b\n  - |', '- a\n  - b\n- |'],
    ['an empty nested numbered item joins the list above', '1. a\n   1. b\n   2. |', '1. a\n   1. b\n2. |'],
    ['empty first sub-item (not yet a list item for the parser) moves out', '1. a\n   - |', '1. a\n2. |'],
    ['first item of three (tight)', '1. a|\n2. b\n3. c', '1. a\n2. |\n3. b\n4. c'],
    ['last item of three (tight)', '1. a\n2. b\n3. c|', '1. a\n2. b\n3. c\n4. |'],
    ['last item of a loose list in a quote', '> 1. a\n>\n> 2. b|', '> 1. a\n>\n> 2. b\n>\n> 3. |'],
    ['a list starting at 5 with ) delimiter, loose', '5) a|\n\n6) b', '5) a\n\n6) |\n\n7) b'],
    ['nested inside a loose parent keeps the nested list tight', '1. a\n\n   - x|\n   - y\n\n2. b', '1. a\n\n   - x\n   - |\n   - y\n\n2. b'],
    ['continuation line of an item: Enter makes the next item', '1. a\n   more|\n2. b', '1. a\n   more\n2. |\n3. b'],
    ['a long number', '99. a|\n100. b', '99. a\n100. |\n101. b'],
    ['a plain line is left to the editor', 'hello|', null as unknown as string],
    ['inside a code block is left alone', '```\n- a|\n```', null as unknown as string],
    ['a table row is left alone', '| a | b |\n| - | - |\n| 1. x| |', null as unknown as string],
  ];
  for (const [name, before, after] of E) test(`Enter: ${name}`, () => assert.strictEqual(key(before, 'enter'), after));

  const S: Array<[string, string, string]> = [
    ['bullet', '- a|b', '- a\n  |b'],
    ['numbered: indented to the text', '1. a|', '1. a\n   |'],
    ['numbered 10.', '10. a|', '10. a\n    |'],
    ['checklist: under the text column of the bullet', '- [ ] a|', '- [ ] a\n  |'],
    ['nested', '- a\n  - b|', '- a\n  - b\n    |'],
    ['in a quote', '> - a|', '> - a\n>   |'],
    ['second line of the item stays in the item', '- a\n  b|', '- a\n  b\n  |'],
  ];
  for (const [name, before, after] of S) test(`Shift+Enter: ${name}`, () => assert.strictEqual(key(before, 'soft'), after));
  test('Shift+Enter outside a list is left to the editor', () => assert.strictEqual(key('plain|', 'soft'), null));
  test('Shift+Enter makes a line that is still one item (CommonMark)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const MarkdownIt = require('markdown-it'); const md = new MarkdownIt();
    const r = key('1. a|\n2. b', 'soft')!.replace('|', 'more');
    assert.strictEqual((md.render(r).match(/<li>/g) ?? []).length, 2, md.render(r));
  });

  const B: Array<[string, string, string]> = [
    ['bullet at the margin', '- |a', '|a'],
    ['numbered in a loose list (the owner\'s): text stays, the rest is renumbered', '1. a\n\n2. |b\n\n3. c\n', '1. a\n\n|b\n\n2. c\n'],
    ['numbered in a tight list: set apart by blank lines so it cannot join the item above', '1. a\n2. |b\n3. c', '1. a\n\n|b\n\n2. c'],
    ['first numbered item', '1. |a\n2. b', '|a\n\n1. b'],
    ['last item', '1. a\n2. |b', '1. a\n\n|b'],
    ['checklist: the box goes too', '- [ ] |a', '|a'],
    ['nested: indentation stays, the text becomes a paragraph of the parent', '- p\n\n  - |c\n', '- p\n\n  |c\n'],
    ['nested, tight: blank line set in front', '- p\n  - |c', '- p\n\n  |c'],
    ['in a quote', '> - |a', '> |a'],
    ['empty item', '- a\n- |', '- a\n\n|'],
    ['not right after the marker: the editor does it', '- a|', null as unknown as string],
    ['in the middle of the text: the editor does it', '- ab|c', null as unknown as string],
    ['10. with children: nothing reaches 4 spaces', '10. a\n\n    - c', null as unknown as string],
  ];
  for (const [name, before, after] of B) {
    if (name.startsWith('10.')) continue;
    test(`Backspace: ${name}`, () => assert.strictEqual(key(before, 'bs'), after));
  }
  test('Backspace on "10. " keeps the children from turning into code', () => {
    const r = key('10. |a\n\n    - c\n', 'bs')!;
    assert.strictEqual(r, '|a\n\n  - c\n');
  });
  test('Backspace with a selection is left to the editor', () => {
    const st = EditorState.create({ doc: '- a\n- b', selection: EditorSelection.range(2, 7), extensions: [markdown({ base: markdownLanguage })] });
    assert.strictEqual(L.backspaceSpec(st), null);
  });
  test('Backspace once, then the editor\'s normal Backspace joins with the line above', () => {
    const r1 = key('- a\n\n- |b', 'bs')!; assert.strictEqual(r1, '- a\n\n|b');
    assert.strictEqual(r1.replace('|', ''), '- a\n\nb'); // a second Backspace at the margin is the editor's own and joins lines
    assert.strictEqual(L.backspaceSpec(mk(r1)), null);
  });

  test('Delete at the end of an item joins the next item and renumbers', () => {
    assert.strictEqual(key('1. a|\n2. b\n3. c', 'del'), '1. a|b\n2. c');
    assert.strictEqual(key('- a|\n- b', 'del'), '- a|b');
    assert.strictEqual(key('- a|b\n- c', 'del'), null, 'not at the end: the editor');
    assert.strictEqual(key('- a|\n\n- b', 'del'), null, 'a blank line is next: the editor removes it');
  });

  // ---- renumbering of the user's own edits
  test('typing "2. " at the start of a line: the following items go on from it', () => {
    assert.strictEqual(typed('1. a\n|\n2. b\n3. c', '2. '), '1. a\n2. |\n2. b\n3. c'.replace('2. b\n3. c', '3. b\n4. c'));
  });
  test('typing a marker on a new line below the list: nothing below to renumber', () => {
    assert.strictEqual(typed('1. a\n2. b\n|', '3. '), '1. a\n2. b\n3. |');
  });
  test('typing a marker in the middle of a loose list (the owner\'s second report)', () => {
    assert.strictEqual(typed('1. A\n\n|\n\n2. B\n\n3. C', '2. '), '1. A\n\n2. |\n\n3. B\n\n4. C');
  });
  test('typing the number of the first item restarts there', () => {
    const st = mk('1. a\n2. b\n3. c'); const s = st.update({ changes: { from: 0, to: 1, insert: '5' }, userEvent: 'input.type' }).state;
    assert.strictEqual(s.doc.toString(), '5. a\n6. b\n7. c');
  });
  test('deleting a whole item renumbers the rest', () => {
    const st = mk('1. a\n2. b\n3. c\n'); const s = st.update({ changes: { from: 5, to: 10 }, userEvent: 'delete.line' }).state;
    assert.strictEqual(s.doc.toString(), '1. a\n2. c\n');
  });
  test('deleting the first item: the list still starts at its old first number', () => {
    const st = mk('4. a\n5. b\n6. c\n'); const s = st.update({ changes: { from: 0, to: 5 }, userEvent: 'delete.line' }).state;
    assert.strictEqual(s.doc.toString(), '4. b\n5. c\n');
  });
  test('moving a line down renumbers', () => {
    const st = mk('1. a\n2. b\n3. c\n'); const s = st.update({ changes: [{ from: 0, to: 5 }, { from: 15, insert: '1. a\n' }], userEvent: 'move.line' }).state;
    assert.strictEqual(s.doc.toString(), '1. b\n2. c\n3. a\n');
  });
  test('pasting items into a list renumbers it', () => {
    const st = mk('1. a\n2. b\n3. c\n'); const s = st.update({ changes: { from: 5, insert: '1. x\n2. y\n' }, userEvent: 'input.paste' }).state;
    assert.strictEqual(s.doc.toString(), '1. a\n2. x\n3. y\n4. b\n5. c\n');
  });
  test('9 to 10 keeps the item\'s own continuation lines and children inside it', () => {
    const st = mk('9. a\n10. b\n    - c\n11. d\n'); const s = st.update({ changes: { from: 0, to: 5 }, userEvent: 'delete.line' }).state;
    assert.strictEqual(s.doc.toString(), '9. b\n   - c\n10. d\n');
    const md = new (require('markdown-it'))(); // eslint-disable-line @typescript-eslint/no-require-imports
    assert.match(md.render(s.doc.toString()), /<li>b\s*<ul>\s*<li>c<\/li>/);
  });
  test('"1. 1. 1." lists are left as they are, also when the user edits them', () => {
    const st = mk('1. a\n1. b\n1. c\n'); const s = st.update({ changes: { from: 5, to: 10 }, userEvent: 'delete.line' }).state;
    assert.strictEqual(s.doc.toString(), '1. a\n1. c\n');
  });
  test('nested lists renumber independently of the list around them', () => {
    const st = mk('1. a\n   1. x\n   2. y\n   3. z\n2. b\n'); const s = st.update({ changes: { from: 13, to: 21 }, userEvent: 'delete.line' }).state;
    assert.strictEqual(s.doc.toString(), '1. a\n   1. x\n   2. z\n2. b\n');
  });
  test('a list the change did not reach keeps its numbers', () => {
    const doc = '1. a\n3. b\n7. c\n\ntext\n\n1. x\n2. y\n3. z\n';
    const st = mk(doc); const at = doc.indexOf('1. x');
    const s = st.update({ changes: { from: at + 5, to: at + 10 }, userEvent: 'delete.line' }).state;
    assert.strictEqual(s.doc.toString(), '1. a\n3. b\n7. c\n\ntext\n\n1. x\n2. z\n');
  });
  test('typing in the text of an item changes no numbers, even in a list with odd numbers', () => {
    const doc = '1. a\n3. b\n7. c\n'; const st = mk(doc);
    assert.strictEqual(st.update({ changes: { from: 9, insert: 'xyz' }, userEvent: 'input.type' }).state.doc.toString(), '1. a\n3. bxyz\n7. c\n');
    assert.strictEqual(st.update({ changes: { from: 8, insert: 'q' }, userEvent: 'input.type' }).state.doc.toString(), '1. a\n3. qb\n7. c\n');
  });
  test('undo, redo and remote changes never renumber', () => {
    const st = mk('1. a\n2. b\n3. c\n');
    for (const ue of ['undo', 'redo', 'select', 'input.replace', 'input.toggleTask']) assert.strictEqual(st.update({ changes: { from: 5, to: 10 }, userEvent: ue }).state.doc.toString(), '1. a\n3. c\n', ue);
    const remoteOnly = EditorState.create({ doc: '1. a\n2. b\n3. c\n', extensions: [markdown({ base: markdownLanguage }), L.listRenumber(() => false)] });
    assert.strictEqual(remoteOnly.update({ changes: { from: 5, to: 10 }, userEvent: 'delete.line' }).state.doc.toString(), '1. a\n3. c\n');
  });
  test('the caret stays in the text when numbers change width', () => {
    const st = mk('9. a\n10. b|\n11. c'); const s = st.update({ changes: { from: 0, to: 5 }, userEvent: 'delete.line' }).state;
    assert.strictEqual(show(s), '9. b|\n10. c');
  });
  test('bullets and numbers do not mix up: a bullet list is never renumbered, "1)" and "1." are separate lists', () => {
    const st = mk('1. a\n2. b\n\n1) x\n3) y\n'); const s = st.update({ changes: { from: 0, to: 5 }, userEvent: 'delete.line' }).state;
    assert.strictEqual(s.doc.toString(), '2. b\n\n1) x\n3) y\n'.replace('2. b', '1. b'));
  });
  test('CRLF text in the editor is already LF (the file keeps its line endings): same results', () => {
    assert.strictEqual(key('1. a|\n2. b', 'enter'), '1. a\n2. |\n3. b');
  });

  // ---- cells
  test('cell: Enter continues "- ", "1. " and "☐ " lines, and renumbers the lines below', () => {
    assert.deepStrictEqual(C.cellEnter('- a', 3, 3), { from: 3, to: 3, insert: '\n- ', caret: 6 });
    assert.deepStrictEqual(C.cellEnter('1. a', 4, 4), { from: 4, to: 4, insert: '\n2. ', caret: 8 });
    assert.deepStrictEqual(C.cellEnter('☐ a', 3, 3), { from: 3, to: 3, insert: '\n☐ ', caret: 6 });
    assert.deepStrictEqual(C.cellEnter('☑ a', 3, 3), { from: 3, to: 3, insert: '\n☐ ', caret: 6 });
    assert.deepStrictEqual(C.cellEnter('1. a\n2. b', 4, 4), { from: 4, to: 9, insert: '\n2. \n3. b', caret: 8 });
    assert.deepStrictEqual(C.cellEnter('- ab', 3, 3), { from: 3, to: 4, insert: '\n- b', caret: 6 });
    assert.strictEqual(C.cellEnter('plain', 5, 5), null);
    assert.strictEqual(C.cellEnter('- a', 1, 1), null, 'inside the prefix: an ordinary line break');
  });
  test('cell: Enter on an empty prefixed line removes the prefix; Backspace right after it too', () => {
    assert.deepStrictEqual(C.cellEnter('- a\n- ', 6, 6), { from: 4, to: 6, insert: '', caret: 4 });
    assert.deepStrictEqual(C.cellEnter('1. ', 3, 3), { from: 0, to: 3, insert: '', caret: 0 });
    assert.deepStrictEqual(C.cellBackspace('- a', 2, 2), { from: 0, to: 3, insert: 'a', caret: 0 });
    assert.deepStrictEqual(C.cellBackspace('1. a\n2. b\n3. c', 8, 8), { from: 5, to: 14, insert: 'b\n2. c', caret: 5 });
    assert.strictEqual(C.cellBackspace('- ab', 3, 3), null);
  });
});

// ----------------------------------------------------------------------------------------- the real webview
const cmd = <T>(c: string, ...a: unknown[]) => vscode.commands.executeCommand<T>(c, ...a);
const ask = <T = any>(u: vscode.Uri, type: string, extra: object = {}) => cmd<T>('inkwell._debugAsk', u, type, extra);
const act = (u: vscode.Uri, name: string) => cmd('inkwell._debugAction', u, name);
const MAC = process.platform === 'darwin';
const press = (u: vscode.Uri, k: string, shift = false) => ask(u, 'debugKey', { key: k, meta: false, ctrl: false, shift });
const undoKey = (u: vscode.Uri) => ask(u, 'debugKey', { key: 'z', meta: MAC, ctrl: !MAC });
const typeText = (u: vscode.Uri, text: string) => ask(u, 'debugTypeText', { text });
const wvText = async (u: vscode.Uri): Promise<string> => (await ask(u, 'debugQuery')).text as string;

suite('Lists (in the editor)', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  let n = 0;
  async function openText(text: string, caretLine: number, caretCh: number) {
    const file = path.join(tmp, `l${++n}.md`); fs.writeFileSync(file, text);
    const r = await openLive(file);
    await cmd('workbench.action.focusActiveEditorGroup'); await ask(r.uri, 'debugFocus');
    await cmd('inkwell._debugMoveCursor', r.uri, caretLine, caretCh);
    return { ...r, file };
  }
  /** The text the document has once the editor and the document agree. */
  const settled = async (u: vscode.Uri, doc: vscode.TextDocument): Promise<string> => { const w = await wvText(u); await waitUntil(() => doc.getText().replace(/\r\n/g, '\n') === w, 'document follows the editor'); return w; };

  const LOOSE = '# T\n\n1. **Five agents** work in parallel.\n\n2. **Every control** is shown.\n\n3. **Third** one.\n';

  test('owner report 1: Enter at the end of a numbered item continues the list (loose list stays loose)', async () => {
    const { uri, doc, file } = await openText(LOOSE, 4, 31);
    await press(uri, 'Enter'); await typeText(uri, 'X');
    assert.strictEqual(await settled(uri, doc), '# T\n\n1. **Five agents** work in parallel.\n\n2. **Every control** is shown.\n\n3. X\n\n4. **Third** one.\n');
    await closeTab(file);
  });
  test('Enter on the empty new item ends the list; Undo brings the bytes back one step at a time', async () => {
    const { uri, doc, file } = await openText(LOOSE, 4, 31);
    await press(uri, 'Enter'); await press(uri, 'Enter'); await typeText(uri, 'Z');
    assert.strictEqual(await settled(uri, doc), '# T\n\n1. **Five agents** work in parallel.\n\n2. **Every control** is shown.\n\nZ\n\n3. **Third** one.\n');
    await undoKey(uri); // the typed Z
    await undoKey(uri); // the list-ending Enter
    assert.strictEqual(await settled(uri, doc), '# T\n\n1. **Five agents** work in parallel.\n\n2. **Every control** is shown.\n\n3. \n\n4. **Third** one.\n');
    await undoKey(uri); // the first Enter, with its renumbering
    assert.strictEqual(await settled(uri, doc), LOOSE);
    await closeTab(file);
  });
  test('owner report 2: typing "2. " in a list renumbers the items after it', async () => {
    const { uri, doc, file } = await openText('1. A\n\n\n\n2. B\n\n3. C\n', 2, 0);
    await typeText(uri, '2. new');
    assert.strictEqual(await settled(uri, doc), '1. A\n\n2. new\n\n3. B\n\n4. C\n');
    await undoKey(uri);
    assert.ok((await settled(uri, doc)).startsWith('1. A\n\n'), 'undone');
    await closeTab(file);
  });
  test('owner report 3: after Tab / indent the caret is in the text, also when it was in front of the number', async () => {
    for (const ch of [0, 1, 3, 12]) {
      const { uri, doc, file } = await openText(LOOSE, 4, ch);
      await act(uri, 'indent'); await typeText(uri, 'Q');
      const t = await settled(uri, doc);
      assert.ok(t.includes(ch === 12 ? '   1. **Every cQontrol**' : '   1. Q**Every control**'), `ch ${ch}: ${JSON.stringify(t)}`);
      await closeTab(file);
    }
  });
  test('indent renumbers the list it left: 1, 2, 3 -> the item that moved in leaves 1, 2', async () => {
    const { uri, doc, file } = await openText('1. a\n2. b\n3. c\n', 1, 4);
    await act(uri, 'indent');
    assert.strictEqual(await settled(uri, doc), '1. a\n   1. b\n2. c\n');
    await undoKey(uri);
    assert.strictEqual(await settled(uri, doc), '1. a\n2. b\n3. c\n');
    await closeTab(file);
  });
  test('a selection stays on the same text when it is indented', async () => {
    const { uri, doc, file } = await openText('- a\n- bcd\n', 1, 0);
    await ask(uri, 'debugSelect', { fromLine: 1, fromCh: 0, toLine: 1, toCh: 5 });
    await act(uri, 'indent');
    assert.strictEqual(await settled(uri, doc), '- a\n  - bcd\n');
    const r = await ask(uri, 'debugSelect', { fromLine: 1, fromCh: 2, toLine: 1, toCh: 7 });
    assert.strictEqual(r.selected, '- bcd');
    await closeTab(file);
  });
  test('Shift+Enter: a soft line break inside the item, with the text column kept', async () => {
    const { uri, doc, file } = await openText('1. one\n2. two\n', 0, 6);
    await press(uri, 'Enter', true); await typeText(uri, 'more');
    assert.strictEqual(await settled(uri, doc), '1. one\n   more\n2. two\n');
    await press(uri, 'Enter'); await typeText(uri, 'next');
    assert.strictEqual(await settled(uri, doc), '1. one\n   more\n2. next\n3. two\n');
    await closeTab(file);
  });
  test('Backspace right after the marker removes it (Backspace again is the editor\'s)', async () => {
    const { uri, doc, file } = await openText('1. a\n\n2. bc\n\n3. d\n', 2, 3);
    await press(uri, 'Backspace');
    assert.strictEqual(await settled(uri, doc), '1. a\n\nbc\n\n2. d\n');
    await press(uri, 'Backspace');
    assert.strictEqual(await settled(uri, doc), '1. a\nbc\n\n2. d\n');
    await closeTab(file);
  });
  test('Delete at the end of an item joins the next one', async () => {
    const { uri, doc, file } = await openText('1. a\n2. b\n3. c\n', 0, 4);
    await press(uri, 'Delete');
    assert.strictEqual(await settled(uri, doc), '1. ab\n2. c\n');
    await closeTab(file);
  });
  test('a CRLF file keeps its line endings: Enter, renumbering and Undo', async () => {
    const orig = '1. a\r\n2. b\r\n3. c\r\n';
    const { uri, doc, file } = await openText(orig, 0, 4);
    await press(uri, 'Enter'); await typeText(uri, 'x');
    await waitUntil(() => doc.getText() === '1. a\r\n2. x\r\n3. b\r\n4. c\r\n', 'CRLF result');
    await doc.save();
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '1. a\r\n2. x\r\n3. b\r\n4. c\r\n');
    await undoKey(uri); await undoKey(uri);
    await waitUntil(() => doc.getText() === orig, 'undo gives the original bytes');
    await closeTab(file);
  });
  test('checklists, bullets and quotes in the editor', async () => {
    const { uri, doc, file } = await openText('- [x] a\n', 0, 7);
    await press(uri, 'Enter'); await typeText(uri, 'b');
    assert.strictEqual(await settled(uri, doc), '- [x] a\n- [ ] b\n');
    await press(uri, 'Enter'); await press(uri, 'Enter');
    assert.strictEqual(await settled(uri, doc), '- [x] a\n- [ ] b\n\n');
    await closeTab(file);
    const q = await openText('> 1. a\n', 0, 6);
    await press(q.uri, 'Enter'); await typeText(q.uri, 'b');
    assert.strictEqual(await settled(q.uri, q.doc), '> 1. a\n> 2. b\n');
    await closeTab(q.file);
  });
  /** Opens `text`, selects (fl,fc)-(tl,tc), runs the toolbar action. */
  async function toggle(text: string, s: [number, number, number, number], action: string): Promise<string> {
    const { uri, doc, file } = await openText(text, s[0], s[1]);
    await ask(uri, 'debugSelect', { fromLine: s[0], fromCh: s[1], toLine: s[2], toCh: s[3] });
    await act(uri, action);
    const t = await settled(uri, doc);
    await undoKey(uri);
    assert.strictEqual(await settled(uri, doc), text, 'Undo restores the exact bytes');
    await closeTab(file);
    return t;
  }
  test('list button off on a middle item of a tight list: set apart by blank lines, the rest renumbered', async () => {
    assert.strictEqual(await toggle('1. a\n2. b\n3. c\n', [1, 4, 1, 4], 'numbered'), '1. a\n\nb\n\n2. c\n');
    assert.strictEqual(await toggle('- a\n- b\n- c\n', [1, 3, 1, 3], 'bullets'), '- a\n\nb\n\n- c\n');
    assert.strictEqual(await toggle('1. a\n\n2. b\n\n3. c\n', [2, 3, 2, 3], 'numbered'), '1. a\n\nb\n\n2. c\n');
    assert.strictEqual(await toggle('1. a\n2. b\n3. c\n4. d\n', [1, 0, 2, 4], 'numbered'), '1. a\n\nb\nc\n\n2. d\n');
  });
  test('list button on a plain line between two items joins the list and renumbers it', async () => {
    assert.strictEqual(await toggle('1. a\nplain\n2. b\n', [1, 2, 1, 2], 'numbered'), '1. a\n2. plain\n3. b\n');
    assert.strictEqual(await toggle('- a\nplain\n- b\n', [1, 2, 1, 2], 'bullets'), '- a\n- plain\n- b\n');
    assert.strictEqual(await toggle('- [ ] a\nplain\n- [x] b\n', [1, 2, 1, 2], 'checklist'), '- [ ] a\n- [ ] plain\n- [x] b\n');
  });
  test('switching an item between numbers and bullets keeps the other items intact', async () => {
    assert.strictEqual(await toggle('1. a\n2. b\n3. c\n', [1, 4, 1, 4], 'bullets'), '1. a\n- b\n\n2. c\n');
    assert.strictEqual(await toggle('- a\n- b\n- c\n', [1, 3, 1, 3], 'numbered'), '- a\n1. b\n- c\n');
  });
  test('a selection over items and plain lines makes every line an item of the list', async () => {
    assert.strictEqual(await toggle('1. a\nplain\n3. c\nmore\n', [0, 0, 3, 4], 'numbered'), '1. a\n2. plain\n3. c\n4. more\n');
    assert.strictEqual(await toggle('- a\nplain\n- c\n', [0, 0, 2, 3], 'bullets'), '- a\n- plain\n- c\n');
  });
  test('opening or moving through a list never renumbers it', async () => {
    const odd = '1. a\n3. b\n7. c\n\n- x\n\n5. y\n5. z\n';
    const { uri, doc, file } = await openText(odd, 0, 0);
    for (const k of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowRight', 'End']) await press(uri, k);
    await typeText(uri, '');
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(doc.getText(), odd);
    await closeTab(file);
  });
  test('a change made by another program is never renumbered', async () => {
    const { uri, doc, file } = await openText('1. a\n2. b\n3. c\n', 0, 0);
    const ext = new vscode.WorkspaceEdit(); ext.insert(uri, new vscode.Position(1, 0), '9. outside\n'); ext.delete(uri, new vscode.Range(2, 0, 3, 0));
    await vscode.workspace.applyEdit(ext);
    await waitUntil(async () => (await wvText(uri)) === '1. a\n9. outside\n2. b\n', 'the editor shows the other program\'s text');
    await new Promise((r) => setTimeout(r, 400));
    assert.strictEqual(await wvText(uri), doc.getText());
    assert.strictEqual(doc.getText(), '1. a\n9. outside\n2. b\n');
    await closeTab(file);
  });
});
