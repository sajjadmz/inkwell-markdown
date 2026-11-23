// Phase 3 adversarial tests. Each test states the intended behaviour; a failure is a finding.
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { FIXTURES, closeTab, openLive, rmDir, tmpDir } from './helpers';

const cmd = <T>(c: string, ...a: unknown[]) => vscode.commands.executeCommand<T>(c, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ask = <T = any>(u: vscode.Uri, type: string, extra: object = {}) => cmd<T>('inkwell._debugAsk', u, type, extra);
const act = (u: vscode.Uri, name: string, arg?: string) => cmd('inkwell._debugAction', u, name, arg);
const sel = (u: vscode.Uri, fl: number, fc: number, tl: number, tc: number) => ask(u, 'debugSelect', { fromLine: fl, fromCh: fc, toLine: tl, toCh: tc });
const tbl = (u: vscode.Uri, o: object) => ask(u, 'debugTable', o);
const wv = (u: vscode.Uri) => cmd<string>('inkwell._debugGetWebviewText', u);
/** Number of cells in a source row, counting like GFM (a backslash escapes the next char). */
function cellCount(line: string): number {
  const t = line.trim(); let pipes = 0;
  for (let i = 0; i < t.length; i++) { if (t[i] === '\\') i++; else if (t[i] === '|') pipes++; }
  return pipes - (t.startsWith('|') ? 1 : 0) - (/(^|[^\\])\|$/.test(t) && t.length > 1 ? 1 : 0) + 1;
}
const lines = (s: string) => s.split('\n');

suite('Adversarial 3: table cells', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  let n = 0;
  async function open(text: string) {
    const file = path.join(tmp, `a3-${++n}.md`);
    fs.writeFileSync(file, text);
    const r = await openLive(file);
    return { ...r, file };
  }
  const T = '| a    | b |\n|------|---|\n| 1    | 2 |\n| 3    | 4 |\n';
  /** Every line except `except` is byte-identical to the original. */
  const onlyLine = (orig: string, now: string, except: number[]) => {
    const a = lines(orig), b = lines(now);
    assert.strictEqual(b.length, a.length, 'line count changed: ' + JSON.stringify(now));
    a.forEach((l, i) => { if (!except.includes(i)) assert.strictEqual(b[i], l, `line ${i} was reformatted`); });
  };

  test('pasted multi-line text becomes one line; no other row changes', async () => {
    const { uri, doc, file } = await open(T);
    await tbl(uri, { r: 1, c: 0, text: 'l1\nl2\r\nl3' });
    onlyLine(T, doc.getText(), [2]);
    assert.strictEqual(lines(doc.getText())[2], '| l1 l2 l3    | 2 |');
    await closeTab(file);
  });

  test('"|" and backticks in a cell: pipe escaped, backticks kept, other rows untouched', async () => {
    const { uri, doc, file } = await open(T);
    await tbl(uri, { r: 1, c: 0, text: 'a|b `c|d` e' });
    onlyLine(T, doc.getText(), [2]);
    assert.strictEqual(lines(doc.getText())[2], '| a\\|b `c\\|d` e    | 2 |');
    assert.strictEqual(await wv(uri), doc.getText());
    await closeTab(file);
  });

  test('typing a trailing backslash in a padded cell does not merge it with the next cell', async () => {
    const { uri, doc, file } = await open(T);
    await tbl(uri, { r: 1, c: 0, text: 'x\\' });
    const row = lines(doc.getText())[2];
    assert.strictEqual(cellCount(row), 2, 'row now parses as ' + cellCount(row) + ' cells: ' + row);
    await closeTab(file);
  });

  test('typing a trailing backslash in a COMPACT cell (|a|b|) does not escape the delimiter', async () => {
    const C = '|a|b|\n|-|-|\n|1|2|\n';
    const { uri, doc, file } = await open(C);
    await tbl(uri, { r: 1, c: 0, text: 'x\\' });
    const row = lines(doc.getText())[2];
    assert.strictEqual(cellCount(row), 2, 'row corrupted: ' + row);
    await closeTab(file);
  });

  test('typing a literal backslash-pipe keeps the row at the same number of cells', async () => {
    const { uri, doc, file } = await open(T);
    await tbl(uri, { r: 1, c: 0, text: 'p\\|q' });
    const row = lines(doc.getText())[2];
    assert.strictEqual(cellCount(row), 2, 'row now splits: ' + row);
    await closeTab(file);
  });

  test('emptying a cell completely, then refilling it, touches only that cell', async () => {
    const { uri, doc, file } = await open(T);
    await tbl(uri, { r: 1, c: 0, text: '' });
    onlyLine(T, doc.getText(), [2]);
    assert.strictEqual(cellCount(lines(doc.getText())[2]), 2);
    await tbl(uri, { r: 1, c: 0, text: '1' });
    assert.strictEqual(doc.getText(), T);
    await closeTab(file);
  });

  test('typing at the start and the end of a cell', async () => {
    const { uri, doc, file } = await open(T);
    await tbl(uri, { r: 1, c: 1, text: 'Z2' });
    await tbl(uri, { r: 1, c: 1, text: 'Z2Y' });
    assert.strictEqual(lines(doc.getText())[2], '| 1    | Z2Y |');
    onlyLine(T, doc.getText(), [2]);
    await closeTab(file);
  });

  test('uneven rows: editing the short row, and add/delete column and row, change only what they must', async () => {
    const U = '| h1 | h2 | h3 |\n|:---:|---|--:|\n| x |\n| y | z | w |\n';
    const { uri, doc, file } = await open(U);
    await tbl(uri, { r: 1, c: 0, text: 'X' });
    onlyLine(U, doc.getText(), [2]);
    await tbl(uri, { r: 1, c: 0, text: 'x' });
    assert.strictEqual(doc.getText(), U);
    await tbl(uri, { r: 2, c: 2, op: 'colRight' });
    await tbl(uri, { r: 2, c: 3, op: 'delCol' });
    assert.strictEqual(doc.getText(), U, 'add then delete column restores bytes');
    await tbl(uri, { r: 1, c: 0, op: 'rowBelow' });
    await tbl(uri, { r: 2, c: 0, op: 'delRow' });
    assert.strictEqual(doc.getText(), U);
    await closeTab(file);
  });

  test('alignment :---: : only the delimiter cell changes, and round-trips', async () => {
    const A = '| h1 | h2 |\n|:---:|---|\n| x | y |\n';
    const { uri, doc, file } = await open(A);
    await tbl(uri, { r: 1, c: 0, op: 'alignRight' });
    onlyLine(A, doc.getText(), [1]);
    assert.strictEqual(lines(doc.getText())[1], '|----:|---|');
    await tbl(uri, { r: 1, c: 0, op: 'alignCenter' });
    assert.strictEqual(doc.getText(), A);
    await tbl(uri, { r: 1, c: 0, op: 'alignCenter' }); // already centred: no change
    assert.strictEqual(doc.getText(), A);
    await closeTab(file);
  });

  test('an existing escaped pipe: focusing/editing another cell leaves it byte-identical; same text in it is a no-op', async () => {
    const E = '| a\\|b | c |\n|---|---|\n| 1 | 2 |\n';
    const { uri, doc, file } = await open(E);
    await tbl(uri, { r: 0, c: 0, text: 'a|b' }); // same logical text
    assert.strictEqual(doc.getText(), E);
    await tbl(uri, { r: 1, c: 1, text: '9' });
    assert.strictEqual(doc.getText(), E.replace('| 2 |', '| 9 |'));
    await closeTab(file);
  });

  test('VS Code undo while a cell is focused restores the bytes and the webview agrees', async () => {
    const { uri, doc, file } = await open(T);
    await tbl(uri, { r: 1, c: 0, text: 'changed' });
    assert.notStrictEqual(doc.getText(), T);
    await cmd('undo');
    await sleep(500);
    assert.strictEqual(doc.getText(), T);
    assert.strictEqual(await wv(uri), T);
    await closeTab(file);
  });

  test('an external edit to another row while a cell is focused is kept, and the next cell edit does not clobber it', async () => {
    const { uri, doc, file } = await open(T);
    await tbl(uri, { r: 1, c: 0, text: '1' }); // focus only (no change)
    const e = new vscode.WorkspaceEdit();
    e.replace(doc.uri, new vscode.Range(3, 2, 3, 3), '33');
    await vscode.workspace.applyEdit(e);
    await sleep(500);
    const want = T.replace('| 3 ', '| 33 ');
    assert.strictEqual(doc.getText(), want);
    assert.strictEqual(await wv(uri), want);
    await tbl(uri, { r: 1, c: 0, text: 'ONE' });
    assert.strictEqual(doc.getText(), want.replace('| 1    ', '| ONE    '));
    await closeTab(file);
  });

  test('an external edit to the focused cell itself wins over the stale DOM (no resurrected text)', async () => {
    const { uri, doc, file } = await open(T);
    await tbl(uri, { r: 1, c: 0, text: '1' });
    const e = new vscode.WorkspaceEdit();
    e.replace(doc.uri, new vscode.Range(2, 2, 2, 3), 'EXT');
    await vscode.workspace.applyEdit(e);
    await sleep(500);
    const dom = (await cmd<{ html: string }>('inkwell._debugGetDom', uri))!.html;
    assert.ok(dom.includes('EXT'), 'webview shows the external change');
    assert.ok(doc.getText().includes('| EXT'), doc.getText());
    await closeTab(file);
  });
});

suite('Adversarial 3: shortcuts', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  test('executeCommand(format.bold) twice in 100 ms toggles on then off (no suppression without a keydown)', async () => {
    const file = path.join(tmp, 's.md'); fs.writeFileSync(file, 'alpha beta gamma\n');
    const { uri, doc } = await openLive(file);
    await sel(uri, 0, 6, 0, 10);
    await cmd('inkwell.format.bold');
    await sleep(50);
    await cmd('inkwell.format.bold');
    await sleep(300);
    assert.strictEqual(doc.getText(), 'alpha beta gamma\n');
    await closeTab(file);
  });
  test('bold command then immediately the toolbar action: both apply (the token is only created by a keydown)', async () => {
    const file = path.join(tmp, 's2.md'); fs.writeFileSync(file, 'alpha beta gamma\n');
    const { uri, doc } = await openLive(file);
    await sel(uri, 0, 6, 0, 10);
    await cmd('inkwell.format.bold');
    await sleep(100);
    await act(uri, 'bold');
    assert.strictEqual(doc.getText(), 'alpha beta gamma\n');
    await closeTab(file);
  });
});

suite('Adversarial 3: formatting edge cases', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  let n = 0;
  async function run(text: string, s: [number, number, number, number], steps: Array<[string, string?]>) {
    const file = path.join(tmp, `f-${++n}.md`); fs.writeFileSync(file, text);
    const { uri, doc } = await openLive(file);
    await sel(uri, ...s);
    const out: string[] = [];
    for (const [a, arg] of steps) { await act(uri, a, arg); out.push(doc.getText()); }
    await closeTab(file);
    return out;
  }
  test('bold across two paragraphs wraps each paragraph separately, never across the blank line', async () => {
    const [r] = await run('one two\n\nthree four\n', [0, 4, 2, 5], [['bold']]);
    assert.strictEqual(r, 'one **two**\n\n**three** four\n');
  });
  test('bold off with the ** marks inside the selection', async () => {
    const [r] = await run('a **b** c\n', [0, 2, 0, 7], [['bold']]);
    assert.strictEqual(r, 'a b c\n');
  });
  test('bold with a selection that covers only part of the marks does not produce broken markup', async () => {
    const [r] = await run('a **b** c\n', [0, 2, 0, 6], [['bold']]);
    assert.ok(!/\*{4,}b/.test(r) || r === 'a **b** c\n', 'garbled: ' + JSON.stringify(r));
  });
  test('italic inside bold, and back', async () => {
    const [a, b] = await run('**bold text**\n', [0, 7, 0, 11], [['italic'], ['italic']]);
    assert.strictEqual(a, '**bold *text***\n');
    assert.strictEqual(b, '**bold text**\n');
  });
  test('italic on the whole bold text, and back', async () => {
    const [a, b] = await run('**bold text**\n', [0, 2, 0, 11], [['italic'], ['italic']]);
    assert.strictEqual(a, '***bold text***\n');
    assert.strictEqual(b, '**bold text**\n');
  });
  test('heading on a list line keeps the list (UX): a bullet must not become a heading containing "- "', async () => {
    const [r] = await run('- item\n', [0, 3, 0, 3], [['h1']]);
    assert.ok(!r.startsWith('# - '), 'list marker swallowed into heading: ' + JSON.stringify(r));
  });
  test('colour on a partial selection inside an existing colour span recolours only the selection (UX)', async () => {
    const src = '<span style="color:#d73a49">hello world</span>\n';
    const [r] = await run(src, [0, 34, 0, 39], [['colour:text', '#0366d6']]);
    assert.ok(r.includes('hello <span') || r.includes('hello</span>'), 'whole span recoloured: ' + r);
  });
  test('"No colour" on non-canonical HTML leaves the document untouched', async () => {
    for (const src of ['<span style="color: red">x</span>\n', '<span style="color:#d73a49;font-weight:bold">x</span>\n', '<span class="c" style="color:#d73a49">x</span>\n', '<font color="red">x</font>\n']) {
      const [r] = await run(src, [0, 0, 0, src.length - 1], [['colour:text', 'none'], ['colour:highlight', 'none']]);
      assert.strictEqual(r, src);
    }
  });
});

suite('Adversarial 3: click mapping across themes', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  for (const theme of ['newsprint.css', 'medium.css', 'github-light.css']) {
    for (const fx of ['showcase.md', 'table.md', 'code-block.md', 'task-list.md', 'frontmatter.md']) {
      test(`posAtCoords at each line centre returns that line: ${theme} / ${fx}`, async () => {
        const lm = vscode.workspace.getConfiguration('inkwell');
        const old = lm.inspect<string>('previewTheme')?.globalValue;
        await lm.update('previewTheme', theme, vscode.ConfigurationTarget.Global);
        const file = path.join(tmp, `${theme}-${fx}`); fs.copyFileSync(path.join(FIXTURES, fx), file);
        try {
          const text = fs.readFileSync(file, 'utf8');
          const ls = text.split('\n');
          const { uri } = await openLive(file);
          // widget-covered lines legitimately map to the widget's range; test plain text lines only
          const inFence: boolean[] = []; let f = false; let fm = ls[0] === '---';
          ls.forEach((l, i) => { if (/^```/.test(l)) { inFence[i] = true; f = !f; } else inFence[i] = f; if (fm && i > 0 && l === '---') { inFence[i] = true; fm = false; } else if (fm) inFence[i] = true; });
          const bad: string[] = [];
          for (const at of [0, Math.floor(ls.length / 2), ls.length - 1]) {
            await cmd('inkwell._debugMoveCursor', uri, at, 0);
            await sleep(350);
            for (let i = 0; i < ls.length - 1; i++) {
              if (/^\s*\|/.test(ls[i]) || inFence[i] || ls[i].trim() === '') continue;
              const r = await ask<{ expected: number; got: number | null }>(uri, 'debugCoords', { line: i });
              if ((r as any).coords && r.got !== r.expected) bad.push(`cursor@${at} line ${i} -> ${String(r.got)} ${JSON.stringify((r as any).coords)}`);
            }
          }
          assert.deepStrictEqual(bad, []);
          await closeTab(file);
        } finally { await lm.update('previewTheme', old, vscode.ConfigurationTarget.Global); }
      });
    }
  }
});

suite('Adversarial 3: selection across widgets and mermaid payloads', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  test('typing over a selection that spans a table replaces exactly the selected range and the selection covered the table', async () => {
    const T = 'before\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter\n';
    const file = path.join(tmp, 'x1.md'); fs.writeFileSync(file, T);
    const { uri, doc } = await openLive(file);
    const r = await sel(uri, 0, 3, 6, 2) as { selected: string };
    assert.strictEqual(r.selected, T.slice(3, T.indexOf('after') + 2));
    await ask(uri, 'debugTypeOverSelection', { text: 'X' });
    assert.strictEqual(doc.getText(), 'bef' + 'X' + T.slice(T.indexOf('after') + 2));
    await cmd('undo'); await sleep(400);
    assert.strictEqual(doc.getText(), T, 'undo restores everything');
    await closeTab(file);
  });
  test('malicious mermaid: nothing executable ends up in the DOM and the document is unchanged', async () => {
    const T = [
      '```mermaid', 'flowchart TD', '  A[Click] --> B', '  click A call alert(1) "tip"', '  click B href "javascript:alert(2)" _blank', '  C["<img src=x onerror=alert(3)>"] --> D["<script>alert(4)</script>"]', '  style A fill:#f00,stroke:#000', '```', '',
      '```mermaid', 'sequenceDiagram', '  Alice->>Bob: <img src=x onerror=alert(5)>', '  Note over Alice: <a href="javascript:alert(6)">x</a>', '```', ''].join('\n');
    const file = path.join(tmp, 'm.md'); fs.writeFileSync(file, T);
    const { uri, doc } = await openLive(file);
    await cmd('inkwell._debugMoveCursor', uri, 0, 0);
    await cmd('inkwell._debugMoveCursor', uri, 14, 0);
    let r = await ask<{ svgs: number; errors: string[] }>(uri, 'debugMermaid');
    for (let i = 0; i < 40 && r.svgs + r.errors.length < 2; i++) { await sleep(250); r = await ask(uri, 'debugMermaid'); }
    const html = (await cmd<{ html: string }>('inkwell._debugGetDom', uri))!.html;
    const mm = [...html.matchAll(/<svg[^>]*id="lm-mmd[\s\S]*?<\/svg>/g)].map((m) => m[0]).join('\n');
    assert.ok(mm.length > 200 || r.errors.length > 0, 'no diagram svg and no error rendered');
    assert.ok(!/<script/i.test(mm), 'script element');
    const hm = /<[a-z][^>]*\son(error|click|load|mouseover)\s*=/i.exec(mm); assert.ok(!hm, 'inline handler: ' + (hm ? hm[0] : ''));
    const jm = /<a[^>]*(?:xlink:)?href="javascript:/i.exec(mm); assert.ok(!jm, 'javascript: url attribute');
    assert.strictEqual(doc.getText(), T);
    await closeTab(file);
  });
});
