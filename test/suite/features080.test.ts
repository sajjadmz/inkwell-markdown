// 0.8.0 features: F1 double-space full stop, F2 indent / outdent (lists), F3 hanging indent, F4 pictures.
// Each feature is tested across its whole family of contexts (text, heading, list, quote, table cell, code ...), with negatives and Undo.
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';
import { closeTab, openLive, rmDir, tmpDir, waitUntil, VIEW } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pics = require('../../../dist/pictures.js') as any;

const cmd = <T>(c: string, ...a: unknown[]) => vscode.commands.executeCommand<T>(c, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ask = <T = any>(u: vscode.Uri, type: string, extra: object = {}) => cmd<T>('inkwell._debugAsk', u, type, extra);
const act = (u: vscode.Uri, name: string, arg?: string) => cmd('inkwell._debugAction', u, name, arg);
const sel = (u: vscode.Uri, fl: number, fc: number, tl: number, tc: number) => ask(u, 'debugSelect', { fromLine: fl, fromCh: fc, toLine: tl, toCh: tc });
const MAC = process.platform === 'darwin';
const md = new MarkdownIt({ html: false });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1), Buffer.from([0xff, 0xd9])]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>');

async function setConfig(key: string, value: string | undefined): Promise<void> {
  await vscode.workspace.getConfiguration('inkwell').update(key, value, vscode.ConfigurationTarget.Global);
}
async function openIn(dir: string, name: string, text: string) {
  const file = path.join(dir, name); fs.writeFileSync(file, text);
  const r = await openLive(file);
  await cmd('workbench.action.focusActiveEditorGroup'); await ask(r.uri, 'debugFocus');
  return { ...r, file };
}
const press = (u: vscode.Uri, key: string, extra: { shift?: boolean; code?: string; meta?: boolean; ctrl?: boolean } = {}) =>
  ask<{ defaultPrevented: boolean }>(u, 'debugKey', { key, meta: extra.meta ?? false, ctrl: extra.ctrl ?? false, shift: !!extra.shift, code: extra.code });
const undoKey = (u: vscode.Uri) => ask(u, 'debugKey', { key: 'z', meta: MAC, ctrl: !MAC });
const redoKey = (u: vscode.Uri) => ask(u, 'debugKey', { key: 'z', meta: MAC, ctrl: !MAC, shift: true });

// ------------------------------------------------------------------------------------------------------------- F1
suite('0.8.0 F1: double-space full stop', () => {
  const tmp = tmpDir();
  suiteSetup(async () => { await setConfig('doubleSpacePeriod', 'on'); });
  suiteTeardown(async () => { await setConfig('doubleSpacePeriod', undefined); rmDir(tmp); });
  const flag = async (u: vscode.Uri) => (await ask(u, 'debugQuery')).doubleSpace as boolean;

  const POS = ['Hello world', '# Heading word', '- list item', '> quote text', '- [ ] task item', '1. numbered item', 'He said "hello"', '(see note)', '[bracket]', 'it\u2019s \u2019quoted\u2019', 'a \u201cquote\u201d', '**bold**', '*it*', '_it_', '`code`', 'year 2026', 'caf\u00e9', '## H2 end', '  - nested item', '> - quoted list item'];
  test('typing a space after "word " gives ". " in text, headings, lists, checklists, quotes, after closers and in nested lists', async () => {
    const { uri, doc, file } = await openIn(tmp, 'f1a.md', POS.join('\n') + '\n');
    for (let i = 0; i < POS.length; i++) {
      await cmd('inkwell._debugMoveCursor', uri, i, POS[i].length);
      await ask(uri, 'debugTypeText', { text: '  ' });
      assert.strictEqual(doc.lineAt(i).text, POS[i] + '. ', `line ${i}: ${POS[i]}`);
    }
    await closeTab(file);
  });

  const NEG = ['Hello.', 'Hello,', 'Hello;', 'Hello:', 'Hello!', 'Hello?', 'Hello\u2026', '', '1', '1)', '- [ ]', '***', '-', '> ', 'Hello \u2014', 'end -'];
  test('never after . , ; : ! ? \u2026, at the start of a line, after a bare list marker, or after another space', async () => {
    const { uri, doc, file } = await openIn(tmp, 'f1b.md', NEG.join('\n') + '\n');
    for (let i = 0; i < NEG.length; i++) {
      await cmd('inkwell._debugMoveCursor', uri, i, NEG[i].length);
      await ask(uri, 'debugTypeText', { text: '  ' });
      assert.strictEqual(doc.lineAt(i).text, NEG[i] + '  ', `line ${i}: ${JSON.stringify(NEG[i])}`);
    }
    await closeTab(file);
  });

  test('a third space after the full stop stays a plain space', async () => {
    const { uri, doc, file } = await openIn(tmp, 'f1c.md', 'Hello\n');
    await cmd('inkwell._debugMoveCursor', uri, 0, 5);
    await ask(uri, 'debugTypeText', { text: '   ' });
    assert.strictEqual(doc.lineAt(0).text, 'Hello.  ');
    await closeTab(file);
  });

  test('not inside inline code, code blocks, front matter, link addresses, HTML tags, comments', async () => {
    const T = ['`some code here`', '[a](http://x.com/ab)', '<span class=word>x</span>', '```', 'code line', '```', '    indented code', '<!-- note word -->', '', 'plain word'].join('\n') + '\n';
    const { uri, doc, file } = await openIn(tmp, 'f1d.md', '---\ntitle: word\n---\n\n' + T);
    const before = doc.getText();
    const at = (needle: string, off = needle.length): [number, number] => { const lines = before.split('\n'); const i = lines.findIndex((l) => l.includes(needle)); return [i, lines[i].indexOf(needle) + off]; };
    const cases: Array<[number, number]> = [at('title: word'), at('`some code here`', 5), at('/ab', 3), at('class=word', 10), at('code line'), at('    indented code'), at('note word', 9)];
    for (const [l, c] of cases) {
      await cmd('inkwell._debugMoveCursor', uri, l, c);
      const was = doc.getText();
      await ask(uri, 'debugTypeText', { text: '  ' });
      assert.ok(!doc.lineAt(l).text.includes('. '), `no full stop on line ${l}: ${JSON.stringify(doc.lineAt(l).text)}`);
      assert.strictEqual(doc.getText().length, was.length + 2, 'the two spaces were typed as they are');
    }
    // and normal text right after all of that still works
    const [pl, pc] = at('plain word');
    await cmd('inkwell._debugMoveCursor', uri, pl, pc);
    await ask(uri, 'debugTypeText', { text: '  ' });
    assert.strictEqual(doc.lineAt(pl).text, 'plain word. ');
    await closeTab(file);
  });

  test('a selection is replaced by the space, never turned into a full stop; mid-line spaces beside another space are left alone', async () => {
    const { uri, doc, file } = await openIn(tmp, 'f1e.md', 'one two\nword  next\n');
    await sel(uri, 0, 0, 0, 3);
    await ask(uri, 'debugTypeText', { text: ' ' });
    assert.strictEqual(doc.lineAt(0).text, '  two');
    await cmd('inkwell._debugMoveCursor', uri, 1, 5);
    await ask(uri, 'debugTypeText', { text: ' ' }); // "word |" + space with a space already after the caret
    assert.strictEqual(doc.lineAt(1).text, 'word   next');
    await closeTab(file);
  });

  test('one Undo gives back the two spaces; the next Undo removes the typing; Redo reapplies the full stop', async () => {
    const { uri, doc, file } = await openIn(tmp, 'f1f.md', 'Hello world\n\nsecond\n');
    await cmd('inkwell._debugMoveCursor', uri, 0, 11);
    await ask(uri, 'debugTypeText', { text: '  ' });
    assert.strictEqual(doc.lineAt(0).text, 'Hello world. ');
    await undoKey(uri); await waitUntil(() => doc.lineAt(0).text === 'Hello world  ', 'undo gives two spaces');
    await undoKey(uri); await waitUntil(() => doc.lineAt(0).text === 'Hello world', 'second undo');
    await redoKey(uri); await waitUntil(() => doc.lineAt(0).text === 'Hello world  ', 'redo 1');
    await redoKey(uri); await waitUntil(() => doc.lineAt(0).text === 'Hello world. ', 'redo 2');
    await doc.save();
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'Hello world. \n\nsecond\n');
    await closeTab(file);
  });

  test('the caret ends after the ". " so typing goes on in place', async () => {
    const { uri, doc, file } = await openIn(tmp, 'f1g.md', 'Hello world\n');
    await cmd('inkwell._debugMoveCursor', uri, 0, 11);
    await ask(uri, 'debugTypeText', { text: '  Next sentence' });
    assert.strictEqual(doc.lineAt(0).text, 'Hello world. Next sentence');
    await closeTab(file);
  });

  test('not while an IME is composing', async () => {
    const { uri, doc, file } = await openIn(tmp, 'f1h.md', 'Hello world\n');
    await cmd('inkwell._debugMoveCursor', uri, 0, 11);
    await ask(uri, 'debugTypeText', { text: '  ', composing: true });
    assert.strictEqual(doc.lineAt(0).text, 'Hello world  ');
    await closeTab(file);
  });

  const CELLS = '| a | b |\n| --- | --- |\n| hello | x |\n| `co de` | [l](http://u.com) |\n| x<br>y | z. |\n| plain | 1 |\n';
  test('table cells: full stop in a cell, one Undo; never in code, link addresses, after punctuation, at the start of a line or while composing', async () => {
    const { uri, doc, file } = await openIn(tmp, 'f1i.md', CELLS);
    const cellText = (r: number, c: number) => ask<string>(uri, 'debugTable', { r, c, op: 'toolbar', at: 0 }).then(() => null);
    void cellText;
    const caretIn = (r: number, c: number, at: number) => ask(uri, 'debugTable', { r, c, op: 'toolbar', at });
    const type = (text: string, composing = false) => ask<string>(uri, 'debugTypeCell', { text, composing });
    // positive: end of "hello"
    await caretIn(1, 0, 5);
    assert.strictEqual(await type('  '), 'hello. ');
    await waitUntil(() => doc.lineAt(2).text === '| hello. | x |', 'document has the full stop');
    await type('Next');
    await waitUntil(() => doc.lineAt(2).text === '| hello. Next | x |', 'typing continues');
    // undo takes the typed text, then the full stop
    await undoKey(uri); await waitUntil(() => doc.lineAt(2).text !== '| hello. Next | x |', 'undo typed');
    await undoKey(uri); await waitUntil(() => doc.lineAt(2).text === '| hello | x |', 'undo full stop');
    // inside inline code
    await caretIn(2, 0, 3); // "`co| de`"
    assert.ok(!(await type('  ')).includes('. '), 'not inside code');
    // in a link address
    await caretIn(2, 1, 16); // "[l](http://u.com|)"
    assert.ok(!(await type('  ')).includes('. '), 'not inside a link address');
    // after a full stop already there ("z.")
    await caretIn(3, 1, 2);
    assert.strictEqual(await type('  '), 'z.  ');
    // end of the second line inside the cell ("x\ny"), then the start of a line
    await caretIn(3, 0, 3);
    assert.ok((await type('  ')).endsWith('y. '), 'second line of a cell');
    await caretIn(3, 0, 2);
    assert.strictEqual((await type('  ')).startsWith('x\n  y'), true, 'start of a line inside a cell');
    // only digits (would make a list) and IME composition
    await caretIn(4, 1, 1);
    assert.strictEqual(await type('  '), '1  ');
    await caretIn(4, 0, 5);
    assert.strictEqual(await type('  ', true), 'plain  ');
    await closeTab(file);
  });

  test('the setting: off stops it, on starts it, auto follows the computer (Mac = on)', async () => {
    const { uri, doc, file } = await openIn(tmp, 'f1j.md', 'Hello world\n');
    await setConfig('doubleSpacePeriod', 'off');
    await waitUntil(async () => !(await flag(uri)), 'off reaches the page');
    await cmd('inkwell._debugMoveCursor', uri, 0, 11);
    await ask(uri, 'debugTypeText', { text: '  ' });
    assert.strictEqual(doc.lineAt(0).text, 'Hello world  ');
    await setConfig('doubleSpacePeriod', 'auto');
    await waitUntil(async () => (await flag(uri)) === MAC, 'auto follows the platform');
    await setConfig('doubleSpacePeriod', 'on');
    await waitUntil(() => flag(uri), 'on');
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));
    const p = pkg.contributes.configuration.properties['inkwell.doubleSpacePeriod'];
    assert.deepStrictEqual(p.enum, ['auto', 'on', 'off']); assert.strictEqual(p.default, 'auto');
    await closeTab(file);
  });
});

// ------------------------------------------------------------------------------------------------------------- F2
suite('0.8.0 F2: indent and outdent (lists only)', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  let n = 0;
  const toast = (u: vscode.Uri) => ask<string | null>(u, 'debugToast');
  /** Opens `text`, selects (fl,fc)-(tl,tc), runs the toolbar actions, returns the text after each. */
  async function run(text: string, s: [number, number, number, number], steps: string[]) {
    const { uri, doc, file } = await openIn(tmp, `f2-${++n}.md`, text);
    await sel(uri, ...s);
    const out: string[] = [];
    for (const a of steps) { await act(uri, a); out.push(doc.getText()); }
    const note = await toast(uri);
    await closeTab(file);
    return { out, note };
  }
  const nested = (text: string, inner: string) => { const h = md.render(text); assert.ok(new RegExp(inner).test(h.replace(/\n/g, '')), `${JSON.stringify(text)} renders nested: ${h}`); };

  test('bullet: indent nests under the item above by 2 spaces, and it is real CommonMark nesting', async () => {
    const { out } = await run('- a\n- b\n', [1, 1, 1, 1], ['indent']);
    assert.strictEqual(out[0], '- a\n  - b\n'); nested(out[0], '<li>a<ul><li>b</li></ul></li>');
  });
  test('numbered: 3 spaces for "1. ", 4 for "10. "; a number other than 1 starts the nested list at 1 (Word restarts numbering at a new level)', async () => {
    const a = await run('1. a\n1. b\n', [1, 1, 1, 1], ['indent']);
    assert.strictEqual(a.out[0], '1. a\n   1. b\n'); nested(a.out[0], '<li>a<ol[^>]*><li>b</li></ol></li>');
    const b = await run('10. a\n\n11. b\n', [2, 1, 2, 1], ['indent']);
    assert.strictEqual(b.out[0], '10. a\n\n    1. b\n'); assert.match(md.render(b.out[0]), /<ol start="10">[\s\S]*<ol>/);
    const c = await run('1. a\n2. b\n', [1, 1, 1, 1], ['indent']);
    assert.strictEqual(c.out[0], '1. a\n   1. b\n', 'restarts at 1'); assert.strictEqual(c.note, null); nested(c.out[0], '<li>a<ol[^>]*><li>b</li></ol></li>');
    const d = await run('1. a\n   1. b\n2. c\n', [2, 1, 2, 1], ['indent']);
    assert.strictEqual(d.out[0], '1. a\n   1. b\n   2. c\n', 'it joins the sub-list that is already there'); nested(d.out[0], '<ol[^>]*><li>b</li><li>c</li></ol>');
    const e = await run('1. a\n   1. b\n   2. c\n', [2, 1, 2, 1], ['outdent']);
    assert.strictEqual(e.out[0], '1. a\n   1. b\n2. c\n');
  });
  test('checklist: nests with the "- " width', async () => {
    const { out } = await run('- [ ] a\n- [x] b\n', [1, 3, 1, 3], ['indent']);
    assert.strictEqual(out[0], '- [ ] a\n  - [x] b\n');
  });
  test('a bullet under a numbered item uses the numbered item\'s width, a number under a bullet the bullet\'s', async () => {
    assert.strictEqual((await run('1. a\n- b\n', [1, 0, 1, 0], ['indent'])).out[0], '1. a\n   - b\n');
    assert.strictEqual((await run('- a\n1. b\n', [1, 0, 1, 0], ['indent'])).out[0], '- a\n  1. b\n');
  });
  test('the first item cannot be indented: nothing changes and a note says why', async () => {
    const r = await run('- a\n- b\n', [0, 1, 0, 1], ['indent']);
    assert.strictEqual(r.out[0], '- a\n- b\n'); assert.strictEqual(r.note, "This item can't be indented any further.");
  });
  test('one level beyond the previous item at most: repeated indent stops', async () => {
    const r = await run('- a\n  - b\n- c\n', [2, 0, 2, 0], ['indent', 'indent', 'indent']);
    assert.strictEqual(r.out[0], '- a\n  - b\n  - c\n');
    assert.strictEqual(r.out[1], '- a\n  - b\n    - c\n');
    assert.strictEqual(r.out[2], r.out[1], 'a third press is a no-op');
  });
  test('outdent reverses indent, level by level, and does nothing at the outermost level', async () => {
    const r = await run('- a\n  - b\n    - c\n', [2, 0, 2, 0], ['outdent', 'outdent', 'outdent']);
    assert.strictEqual(r.out[0], '- a\n  - b\n  - c\n'); assert.strictEqual(r.out[1], '- a\n  - b\n- c\n'); assert.strictEqual(r.out[2], r.out[1]);
    assert.strictEqual(r.note, null, 'no note for outdent at the outer level');
  });
  test('multi-line selection: every selected list line moves once; unselected lines stay', async () => {
    const T = '- a\n- b\n- c\n- d\n- e\n';
    const r = await run(T, [1, 1, 3, 1], ['indent']);
    assert.strictEqual(r.out[0], '- a\n  - b\n  - c\n  - d\n- e\n');
    const r2 = await run('- a\n- b\n  - c\n- d\n', [1, 0, 3, 3], ['indent']);
    assert.strictEqual(r2.out[0], '- a\n  - b\n    - c\n  - d\n', 'sub-items keep their relation');
    const r3 = await run('- a\n  - b\n  - c\n', [1, 0, 2, 3], ['outdent']);
    assert.strictEqual(r3.out[0], '- a\n- b\n- c\n');
  });
  test('a selection that mixes list lines with other lines moves only the list lines', async () => {
    const r = await run('- a\n- b\n\ntext\n- c\n', [1, 0, 4, 3], ['indent']);
    assert.strictEqual(r.out[0], '- a\n  - b\n\ntext\n- c\n', 'the item below the paragraph starts a new list, so it stays');
  });
  test('only the whitespace in front of the marker changes: text, trailing spaces, emphasis and emoji are kept byte for byte', async () => {
    const T = '- caf\u00e9 **b**  \n- x \u{1F600} `c`\u00a0 \n';
    const { uri, doc, file } = await openIn(tmp, 'f2-bytes.md', T);
    await sel(uri, 1, 3, 1, 3); await act(uri, 'indent'); await doc.save();
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '- caf\u00e9 **b**  \n  - x \u{1F600} `c`\u00a0 \n');
    await closeTab(file);
  });
  test('CRLF files stay CRLF', async () => {
    const { uri, doc, file } = await openIn(tmp, 'f2-crlf.md', '- a\r\n- b\r\n');
    await sel(uri, 1, 0, 1, 0); await act(uri, 'indent'); await doc.save();
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '- a\r\n  - b\r\n');
    await closeTab(file);
  });
  test('indent and outdent are one Undo step each (also with several lines), and Redo works', async () => {
    const T = '- a\n- b\n- c\n- d\n';
    const { uri, doc, file } = await openIn(tmp, 'f2-undo.md', T);
    await sel(uri, 1, 0, 3, 3); await act(uri, 'indent');
    assert.strictEqual(doc.getText(), '- a\n  - b\n  - c\n  - d\n');
    await undoKey(uri); await waitUntil(() => doc.getText() === T, 'one undo restores every line');
    await redoKey(uri); await waitUntil(() => doc.getText() === '- a\n  - b\n  - c\n  - d\n', 'redo');
    await act(uri, 'outdent'); assert.strictEqual(doc.getText(), T);
    await undoKey(uri); await waitUntil(() => doc.getText() === '- a\n  - b\n  - c\n  - d\n', 'undo outdent');
    await closeTab(file);
  });
  test('the selection stays on the same text after indent', async () => {
    const { uri, file } = await openIn(tmp, 'f2-sel.md', '- a\n- bee\n');
    await sel(uri, 1, 2, 1, 5); await act(uri, 'indent');
    assert.strictEqual((await ask(uri, 'debugSelect', { fromLine: 1, fromCh: 4, toLine: 1, toCh: 7 })).selected, 'bee');
    await closeTab(file);
  });
  test('plain paragraph, heading and quote: a note, nothing changes (indent and outdent)', async () => {
    for (const [name, T, ch] of [['paragraph', 'hello world\n', 1], ['heading', '# Title\n', 1], ['quote', '> quoted\n', 1], ['empty line', '\n', 0], ['indented text', '  indented\n', 1]] as const) {
      for (const a of ['indent', 'outdent']) {
        const r = await run(T, [0, ch, 0, ch], [a]);
        assert.strictEqual(r.out[0], T, `${name} ${a}`);
        assert.strictEqual(r.note, 'Indent works on bullet and numbered lists.', `${name} ${a} note`);
      }
    }
  });
  test('code: list-looking lines in a fenced block or an indented code block are not lists', async () => {
    const T = '```\n- a\n- b\n```\n';
    const r = await run(T, [2, 1, 2, 1], ['indent']);
    assert.strictEqual(r.out[0], T); assert.strictEqual(r.note, 'Indent works on bullet and numbered lists.');
    const r2 = await run('para\n\n    - a\n    - b\n', [3, 5, 3, 5], ['indent']);
    assert.strictEqual(r2.out[0], 'para\n\n    - a\n    - b\n');
  });
  test('a list inside a quote nests inside the quote', async () => {
    const r = await run('> - a\n> - b\n', [1, 4, 1, 4], ['indent', 'outdent']);
    assert.strictEqual(r.out[0], '>   - a\n'.replace('>   - a', '> - a') + '>   - b\n');
    assert.strictEqual(r.out[1], '> - a\n> - b\n');
  });
  test('in a table cell: a note, nothing changes (toolbar and shortcut)', async () => {
    const T = '| a | b |\n| --- | --- |\n| - x | y |\n';
    const { uri, doc, file } = await openIn(tmp, 'f2-cell.md', T);
    await ask(uri, 'debugTable', { r: 1, c: 0, op: 'toolbar', at: 3 });
    await act(uri, 'indent');
    assert.strictEqual(await toast(uri), "Indent isn't available inside a table cell.");
    assert.strictEqual(doc.getText(), T);
    await ask(uri, 'debugClick', { selector: '.lm-toast' }); // keep the page tidy
    await act(uri, 'outdent');
    assert.strictEqual(doc.getText(), T);
    await closeTab(file);
  });
  test('Tab / Shift+Tab move a list item; on other lines Tab is left alone', async () => {
    const { uri, doc, file } = await openIn(tmp, 'f2-tab.md', 'para\n\n- a\n- b\n');
    await cmd('inkwell._debugMoveCursor', uri, 3, 1);
    let r = await press(uri, 'Tab'); assert.ok(r.defaultPrevented);
    assert.strictEqual(doc.getText(), 'para\n\n- a\n  - b\n');
    r = await press(uri, 'Tab', { shift: true }); assert.ok(r.defaultPrevented);
    assert.strictEqual(doc.getText(), 'para\n\n- a\n- b\n');
    r = await press(uri, 'Tab'); await press(uri, 'Tab'); // second one cannot go further: still swallowed so focus does not leave the page
    assert.ok(r.defaultPrevented);
    const before = doc.getText();
    await cmd('inkwell._debugMoveCursor', uri, 0, 2);
    r = await press(uri, 'Tab'); assert.ok(r.defaultPrevented, 'Tab on a paragraph keeps the focus in the editor');
    r = await press(uri, 'Tab', { shift: true }); assert.ok(r.defaultPrevented);
    assert.strictEqual(doc.getText(), before);
    await closeTab(file);
  });
  test('Tab in a table cell still moves to the next cell', async () => {
    const T = '| a | b |\n| --- | --- |\n| x | y |\n';
    const { uri, doc, file } = await openIn(tmp, 'f2-celltab.md', T);
    await ask(uri, 'debugTable', { r: 1, c: 0, op: 'toolbar', at: 1 });
    const r = await press(uri, 'Tab'); assert.ok(r.defaultPrevented);
    assert.strictEqual(doc.getText(), T);
    await closeTab(file);
  });
  test('Cmd+] / Cmd+[ (Ctrl on Windows/Linux) indent and outdent', async () => {
    const { uri, doc, file } = await openIn(tmp, 'f2-keys.md', '- a\n- b\n');
    await cmd('inkwell._debugMoveCursor', uri, 1, 1);
    const k = (key: string, code: string) => press(uri, key, { code, meta: MAC, ctrl: !MAC });
    let r = await k(']', 'BracketRight'); assert.ok(r.defaultPrevented);
    assert.strictEqual(doc.getText(), '- a\n  - b\n');
    r = await k('[', 'BracketLeft'); assert.ok(r.defaultPrevented);
    assert.strictEqual(doc.getText(), '- a\n- b\n');
    await closeTab(file);
  });
  test('forwarded command inkwell.format.indent / outdent reach the page', async () => {
    const { uri, doc, file } = await openIn(tmp, 'f2-cmd.md', '- a\n- b\n');
    await cmd('inkwell._debugMoveCursor', uri, 1, 1);
    await cmd('inkwell.format.indent'); await waitUntil(() => doc.getText() === '- a\n  - b\n', 'indent command');
    await cmd('inkwell.format.outdent'); await waitUntil(() => doc.getText() === '- a\n- b\n', 'outdent command');
    await closeTab(file);
  });
  test('toolbar: both buttons exist after the checklist button, with hover notes that name the shortcut', async () => {
    const { uri, file } = await openIn(tmp, 'f2-tb.md', '- a\n- b\n');
    const tb = await ask<{ names: string[] }>(uri, 'debugToolbar');
    const i = tb.names.indexOf('checklist'); assert.deepStrictEqual(tb.names.slice(i + 1, i + 3), ['outdent', 'indent']);
    const hover = (sel2: string) => ask<{ shown: boolean; text: string }>(uri, 'debugHover', { selector: sel2, op: 'over' });
    assert.strictEqual((await hover('#lm-toolbar [data-action="indent"]')).text, MAC ? 'Increase indent  \u2318]' : 'Increase indent  Ctrl+]');
    assert.strictEqual((await hover('#lm-toolbar [data-action="outdent"]')).text, MAC ? 'Decrease indent  \u2318[' : 'Decrease indent  Ctrl+[');
    await closeTab(file);
  });
  test('the indented item renders nested (live preview) once the caret leaves it', async () => {
    const { uri, doc, file } = await openIn(tmp, 'f2-render.md', '- a\n- b\n\nend\n');
    await cmd('inkwell._debugMoveCursor', uri, 1, 1); await act(uri, 'indent');
    await cmd('inkwell._debugMoveCursor', uri, 3, 1);
    const html = (await cmd<{ html: string }>('inkwell._debugGetDom', uri))!.html;
    assert.ok(/lm-bullet/.test(html));
    assert.strictEqual(doc.getText(), '- a\n  - b\n\nend\n');
    await closeTab(file);
  });
});

// ------------------------------------------------------------------------------------------------------------- F3
suite('0.8.0 F3: hanging indent for wrapped list items', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  const LONG = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
  const DOC = [`- ${LONG}`, `  - ${LONG}`, `    - ${LONG}`, '', `1. ${LONG}`, `   1. ${LONG}`, '', `10. ${LONG}`, '', `- [ ] ${LONG}`, `  - [x] ${LONG}`, '', '- hard wrapped', '  second source line ' + LONG, '', 'end', ''].join('\n');
  /** Scrolls each list line to the middle of the view in turn and collects the measurements of every rendered list line. */
  async function measure(uri: vscode.Uri, lines: number[]) {
    const seen = new Map<string, { text: string; first: number; wrapped: number[] }>();
    for (const line of lines) {
      await cmd('inkwell._debugAsk', uri, 'debugCursor', { line: 15, ch: 1, scroll: false });
      await ask(uri, 'debugCursor', { line, ch: 1, scroll: true }); await sleep(250);
      await ask(uri, 'debugCursor', { line: 15, ch: 1 }); await sleep(150);
      for (const r of await ask<Array<{ text: string; first: number; wrapped: number[] }>>(uri, 'debugHang')) seen.set(r.text + ':' + line, r);
    }
    return [...seen.values()];
  }
  test('wrapped lines start where the item text starts: bullets, numbers (1. and 10.), checklists, three levels', async () => {
    const { uri, file } = await openIn(tmp, 'f3.md', DOC);
    const rows = await measure(uri, [0, 1, 2, 4, 5, 7, 9, 10, 12]);
    assert.ok(rows.length >= 9, 'measured ' + rows.length);
    for (const r of rows) for (const w of r.wrapped) assert.ok(Math.abs(w - r.first) < 1, `wrapped line at ${w} but text starts at ${r.first}: ${r.text}`);
    assert.ok(rows.filter((r) => r.wrapped.length).length >= 8, 'items really wrapped: ' + rows.filter((r) => r.wrapped.length).length);
    await closeTab(file);
  });
  test('the same holds while the caret is inside the item (raw markers shown)', async () => {
    const { uri, file } = await openIn(tmp, 'f3b.md', DOC);
    for (const line of [0, 1, 2, 4, 5, 7, 9, 10]) {
      await ask(uri, 'debugCursor', { line, ch: 8, scroll: true }); await sleep(250);
      const rows = await ask<Array<{ text: string; first: number; wrapped: number[] }>>(uri, 'debugHang');
      for (const r of rows) for (const w of r.wrapped) assert.ok(Math.abs(w - r.first) < 1, `active line ${line}: wrapped ${w} vs ${r.first}: ${r.text}`);
    }
    await closeTab(file);
  });
  test('deeper levels start further right than shallower ones', async () => {
    const { uri, file } = await openIn(tmp, 'f3c.md', DOC);
    const rows = await measure(uri, [0, 1, 2]);
    const bullets = rows.filter((r) => r.text.startsWith('\u2022') || r.text.startsWith('\u25e6') || r.text.startsWith('\u25aa')).slice(0, 3);
    assert.ok(bullets.length === 3 && bullets[0].first < bullets[1].first && bullets[1].first < bullets[2].first, JSON.stringify(bullets.map((b) => b.first)));
    await closeTab(file);
  });
  test('clicks on wrapped lines land on the clicked position (first and wrapped lines, every list kind)', async () => {
    const { uri, doc, file } = await openIn(tmp, 'f3d.md', DOC);
    for (const line of [0, 1, 2, 4, 5, 7, 9, 10]) {
      const text = doc.lineAt(line).text; const start = text.indexOf('word0');
      await ask(uri, 'debugCursor', { line, ch: 1, scroll: true }); await sleep(250);
      await ask(uri, 'debugCursor', { line: 15, ch: 1 }); await sleep(150);
      for (const ch of [start + 3, start + 90, start + 190, start + 300]) {
        await ask(uri, 'debugCursor', { line: 15, ch: 1 });
        const r = await ask<{ from: number; to: number }>(uri, 'debugMouse', { line, ch, clicks: 1 });
        const want = doc.offsetAt(new vscode.Position(line, ch));
        assert.ok(Math.abs(r.from - want) <= 2, `line ${line} ch ${ch}: caret at ${r.from}, wanted ${want}`);
      }
    }
    await closeTab(file);
  });
});

// ------------------------------------------------------------------------------------------------------------- F4
suite('0.8.0 F4: paste and drop pictures', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  const b64 = (b: Buffer) => b.toString('base64');
  const paste = (u: vscode.Uri, files: Array<{ name: string; type: string; b64: string }>, extra: object = {}) =>
    ask<{ prevented: boolean; ours: boolean; toast: string | null }>(u, 'debugPaste', { kind: 'paste', files, ...extra });
  const png = (name = 'image.png') => ({ name, type: 'image/png', b64: b64(PNG) });
  const imagesOf = (dir: string): string[] => (fs.existsSync(path.join(dir, 'images')) ? fs.readdirSync(path.join(dir, 'images')).sort() : []);
  const fresh = () => { const d = fs.mkdtempSync(path.join(tmp, 'd-')); return d; };

  test('Cmd+V of a picture saves images/<note>-<date>-<time>.png next to the file and inserts the link at the caret; the picture shows at once', async () => {
    const dir = fresh();
    const { uri, doc, file } = await openIn(dir, 'my-note.md', 'Before after\n');
    await cmd('inkwell._debugMoveCursor', uri, 0, 7);
    const r = await paste(uri, [png()]);
    assert.ok(r.ours, 'the picture paste is ours');
    const files = imagesOf(dir); assert.strictEqual(files.length, 1);
    assert.match(files[0], /^my-note-\d{8}-\d{6}\.png$/);
    assert.ok(fs.readFileSync(path.join(dir, 'images', files[0])).equals(PNG), 'bytes saved exactly');
    assert.strictEqual(doc.getText(), `Before ![](images/${files[0]})after\n`);
    const imgs = await ask<Array<{ ok: boolean }>>(uri, 'debugImages', { min: 1 });
    assert.ok(imgs.length === 1 && imgs[0].ok, 'the picture is displayed: ' + JSON.stringify(imgs));
    // Undo removes the link; the file stays
    await undoKey(uri); await waitUntil(() => doc.getText() === 'Before after\n', 'undo removes the link');
    assert.strictEqual(imagesOf(dir).length, 1, 'the file stays');
    await closeTab(file);
  });
  test('a note name with spaces: the link uses the <...> form, is valid CommonMark and the picture renders', async () => {
    const dir = fresh();
    const { uri, doc, file } = await openIn(dir, 'my notes (draft).md', 'x\n');
    await cmd('inkwell._debugMoveCursor', uri, 0, 1);
    await paste(uri, [png()]);
    const f = imagesOf(dir)[0];
    assert.match(f, /^my notes \(draft\)-\d{8}-\d{6}\.png$/);
    assert.strictEqual(doc.getText(), `x![](<images/${f}>)\n`);
    assert.match(md.render(doc.getText()), /<img src="images\/my%20notes%20\(draft\)-\d{8}-\d{6}\.png"/);
    const imgs = await ask<Array<{ ok: boolean }>>(uri, 'debugImages', { min: 1 });
    assert.ok(imgs.length === 1 && imgs[0].ok, 'renders in the extension: ' + JSON.stringify(imgs));
    await closeTab(file);
  });
  test('never overwrites: files already there are untouched and the new one gets another name', async () => {
    const dir = fresh();
    const { uri, doc, file } = await openIn(dir, 'clash.md', '\n');
    fs.mkdirSync(path.join(dir, 'images'));
    const stampNow = pics.stamp(new Date());
    // occupy this second and the next two seconds with different content
    const occupied: string[] = [];
    for (let s = 0; s < 3; s++) { const name = `clash-${pics.stamp(new Date(Date.now() + s * 1000))}.png`; fs.writeFileSync(path.join(dir, 'images', name), 'OLD' + s); occupied.push(name); }
    void stampNow;
    await paste(uri, [png(), png()]);
    for (let s = 0; s < occupied.length; s++) assert.strictEqual(fs.readFileSync(path.join(dir, 'images', occupied[s]), 'utf8'), 'OLD' + s, 'existing file untouched');
    const added = imagesOf(dir).filter((f) => !occupied.includes(f));
    assert.strictEqual(added.length, 2, 'two new files: ' + imagesOf(dir).join(','));
    assert.ok(added.every((f) => fs.readFileSync(path.join(dir, 'images', f)).equals(PNG)));
    const links = doc.getText().match(/!\[\]\(images\/[^)]+\)/g) ?? [];
    assert.strictEqual(links.length, 2, doc.getText());
    await closeTab(file);
  });
  test('two pictures in one paste: both saved with different names, both linked, one per line', async () => {
    const dir = fresh();
    const { uri, doc, file } = await openIn(dir, 'two.md', 'x\n');
    await cmd('inkwell._debugMoveCursor', uri, 0, 1);
    await paste(uri, [png('a.png'), { name: 'b.png', type: 'image/png', b64: b64(PNG) }]);
    const files = imagesOf(dir); assert.strictEqual(files.length, 2); assert.notStrictEqual(files[0], files[1]);
    const m = /^x!\[\]\(images\/([^)]+)\)\n!\[\]\(images\/([^)]+)\)\n$/.exec(doc.getText());
    assert.ok(m, doc.getText()); assert.deepStrictEqual([m![1], m![2]].sort(), files);
    await closeTab(file);
  });
  test('dropping files keeps their extension: png, jpg, jpeg, gif, webp (as extension only), svg; other files are ignored', async () => {
    const dir = fresh();
    const { uri, doc, file } = await openIn(dir, 'drop.md', 'line one\n\nline two\n');
    const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(8)]);
    const drop = (files: Array<{ name: string; type: string; b64: string }>, line = 0, ch = 4) => ask<{ prevented: boolean; ours: boolean }>(uri, 'debugPaste', { kind: 'drop', files, line, ch });
    await drop([{ name: 'Shot 1.PNG', type: 'image/png', b64: b64(PNG) }]);
    await drop([{ name: 'p.jpg', type: 'image/jpeg', b64: b64(JPG) }], 2, 3);
    await drop([{ name: 'p.jpeg', type: 'image/jpeg', b64: b64(JPG) }], 2, 3);
    await drop([{ name: 'p.gif', type: 'image/gif', b64: b64(GIF) }], 2, 3);
    await drop([{ name: 'p.webp', type: 'image/webp', b64: b64(WEBP) }], 2, 3);
    await drop([{ name: 'p.svg', type: 'image/svg+xml', b64: b64(SVG) }], 2, 3);
    const exts = imagesOf(dir).map((f) => f.split('.').pop()!).sort();
    assert.deepStrictEqual(exts, ['gif', 'jpeg', 'jpg', 'png', 'svg', 'webp']);
    assert.match(doc.lineAt(0).text, /^line!\[\]\(images\/drop-\d{8}-\d{6}\.png\) one$/, 'dropped at the drop point');
    const r = await drop([{ name: 'notes.pdf', type: 'application/pdf', b64: b64(Buffer.from('%PDF-1.4')) }]);
    assert.strictEqual(r.ours, false, 'a non-picture file is left to the editor'); assert.strictEqual(imagesOf(dir).length, 6, 'nothing saved for it');
    await closeTab(file);
  });
  test('pasting into a focused table cell puts the link in that cell', async () => {
    const dir = fresh();
    const T = '| a | b |\n| --- | --- |\n| x | y |\n';
    const { uri, doc, file } = await openIn(dir, 'cell.md', T);
    await ask(uri, 'debugTable', { r: 1, c: 1, op: 'toolbar', at: 1 });
    const r = await paste(uri, [png()], { cell: { r: 1, c: 1 } });
    assert.ok(r.ours);
    const f = imagesOf(dir)[0];
    await waitUntil(() => doc.lineAt(2).text === `| x | y![](images/${f}) |`, 'link in the cell: ' + doc.lineAt(2).text);
    await closeTab(file);
  });
  test('non-image paste is untouched: plain text, multi-line text, text with an image (Word-style), other files', async () => {
    const dir = fresh();
    const { uri, doc, file } = await openIn(dir, 'text.md', 'abc\n');
    await cmd('inkwell._debugMoveCursor', uri, 0, 3);
    const P = (extra: object) => ask<{ ours: boolean }>(uri, 'debugPaste', { kind: 'paste', files: [], ...extra });
    assert.strictEqual((await P({ text: ' just text' })).ours, false);
    assert.strictEqual(doc.getText(), 'abc just text\n', 'the editor pasted the text as it always did');
    assert.strictEqual((await P({ text: '\nline1\nline2' })).ours, false);
    assert.strictEqual(doc.getText(), 'abc just text\nline1\nline2\n');
    assert.strictEqual((await P({ files: [png()], text: ' with picture' })).ours, false, 'text that comes with the picture wins');
    assert.strictEqual(doc.getText(), 'abc just text\nline1\nline2 with picture\n');
    assert.strictEqual((await P({ files: [{ name: 'a.pdf', type: 'application/pdf', b64: b64(Buffer.from('%PDF')) }] })).ours, false);
    assert.strictEqual(imagesOf(dir).length, 0, 'nothing saved');
    // the same in a cell
    const T = '| a |\n| --- |\n| x |\n';
    const c2 = await openIn(dir, 'c2.md', T);
    await ask(c2.uri, 'debugTable', { r: 1, c: 0, op: 'toolbar', at: 1 });
    const rc = await ask<{ ours: boolean }>(c2.uri, 'debugPaste', { kind: 'paste', files: [], text: 'multi\nline', cell: { r: 1, c: 0 } });
    assert.strictEqual(rc.ours, false);
    assert.strictEqual(imagesOf(dir).length, 0);
    await closeTab(file); await closeTab(c2.file);
  });
  test('a copied file whose "text" is only its own name still counts as a picture', async () => {
    const dir = fresh();
    const { uri, doc, file } = await openIn(dir, 'named.md', 'x\n');
    const r = await paste(uri, [png('shot.png')], { text: 'shot.png' });
    assert.ok(r.ours); assert.strictEqual(imagesOf(dir).length, 1); assert.ok(doc.getText().includes('![](images/'));
    await closeTab(file);
  });
  test('an unsaved (untitled) document: a note, nothing changes, nothing is written', async () => {
    const d = await vscode.workspace.openTextDocument({ language: 'markdown', content: 'hello\n' });
    const ready = cmd('inkwell._debugWhenReady', d.uri);
    await vscode.commands.executeCommand('vscode.openWith', d.uri, VIEW);
    await ready; await cmd('workbench.action.focusActiveEditorGroup'); await ask(d.uri, 'debugFocus');
    const r = await paste(d.uri, [png()]);
    assert.strictEqual(r.toast, 'Save the file first to paste pictures.');
    assert.strictEqual(d.getText(), 'hello\n');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });
  test('the host checks everything the page sends: bad extension, bad base64, wrong content, empty, too big, path tricks', async () => {
    const dir = fresh();
    const { uri, doc, file } = await openIn(dir, 'hostile.md', 'x\n');
    const send = (msg: object) => ask(uri, 'debugPost', { msg: { type: 'pastePicture', id: 9999, ...msg }, wait: 500 });
    await send({ ext: 'exe', data: b64(PNG) });
    await send({ ext: 'png/../../evil', data: b64(PNG) });
    await send({ ext: '../x', data: b64(PNG) });
    await send({ ext: 'png', data: 'not base64!!' });
    await send({ ext: 'png', data: b64(Buffer.from('this is not a png')) });
    await send({ ext: 'png', data: '' });
    await send({ ext: 'png', data: 12345 });
    await send({ ext: 'svg', data: b64(Buffer.from('plain text')) });
    await send({ ext: 'png' });
    await send({ type: 'pastePicture', id: 'x', ext: 'png', data: b64(PNG) });
    assert.strictEqual(imagesOf(dir).length, 0, 'nothing saved: ' + imagesOf(dir).join(','));
    assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f !== 'hostile.md'), [], 'nothing written beside the note either');
    assert.strictEqual(doc.getText(), 'x\n');
    await closeTab(file);
  });
  test('validation and naming helpers: size cap, name sanitising, no path traversal, CommonMark link form', () => {
    assert.strictEqual(pics.MAX_PICTURE_BYTES, 25 * 1024 * 1024);
    assert.strictEqual(pics.checkPicture({ ext: 'png', data: b64(PNG) }).ok, true);
    assert.strictEqual(pics.checkPicture({ ext: 'PNG', data: b64(PNG) }).ok, true);
    const big = pics.checkPicture({ ext: 'png', data: 'A'.repeat(36_000_000) });
    assert.ok(!big.ok && big.error === pics.NOTE_TOO_BIG);
    const justOver = Buffer.alloc(pics.MAX_PICTURE_BYTES + 1); PNG.copy(justOver);
    const o = pics.checkPicture({ ext: 'png', data: justOver.toString('base64') }); assert.ok(!o.ok && o.error === pics.NOTE_TOO_BIG);
    const exact = Buffer.alloc(pics.MAX_PICTURE_BYTES); PNG.copy(exact);
    assert.strictEqual(pics.checkPicture({ ext: 'png', data: exact.toString('base64') }).ok, true);
    for (const ext of ['exe', 'html', 'png ', '.png', 'png\u0000', '', 'svgz', 'bmp', 'tiff', 'ico']) assert.strictEqual(pics.checkPicture({ ext, data: b64(PNG) }).ok, false, ext);
    assert.strictEqual(pics.pictureBase('/a/b/../../etc/passwd.md'), 'passwd');
    assert.strictEqual(pics.pictureBase('C:\\Users\\me\\Notes: 100%.md'), 'Notes- 100-');
    assert.strictEqual(pics.pictureBase('/x/..md'), 'note');
    assert.strictEqual(pics.pictureBase('/x/.hidden.markdown'), 'hidden');
    assert.strictEqual(pics.pictureBase('/x/a#b?c.md'), 'a-b-c');
    assert.ok(pics.pictureBase('/x/' + 'n'.repeat(300) + '.md').length <= 80);
    assert.strictEqual(pics.pictureFileName('n', new Date(2026, 10, 24, 9, 5, 7), 'png', 1), 'n-20261124-090507.png');
    assert.strictEqual(pics.pictureFileName('n', new Date(2026, 10, 24, 9, 5, 7), 'png', 3), 'n-20261124-090507-3.png');
    assert.strictEqual(pics.pictureMarkdown('images/a.png'), '![](images/a.png)');
    assert.strictEqual(pics.pictureMarkdown('images/a b.png'), '![](<images/a b.png>)');
    assert.strictEqual(pics.pictureMarkdown('images/a (1).png'), '![](<images/a (1).png>)');
    assert.match(md.render(pics.pictureMarkdown('images/a (1) b.png')), /<img src="images\/a%20\(1\)%20b\.png"/);
  });
});
