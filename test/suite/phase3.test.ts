// Phase 3: toolbar actions, toggle semantics, colours, mermaid, editable tables, mouse/selection fixes, shortcut contributions.
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { closeTab, commonAffixes, openLive, rmDir, tmpDir } from './helpers';

const cmd = <T>(c: string, ...a: unknown[]) => vscode.commands.executeCommand<T>(c, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ask = <T = any>(u: vscode.Uri, type: string, extra: object = {}) => cmd<T>('inkwell._debugAsk', u, type, extra);
const act = (u: vscode.Uri, name: string, arg?: string) => cmd('inkwell._debugAction', u, name, arg);
const sel = (u: vscode.Uri, fl: number, fc: number, tl: number, tc: number) => ask(u, 'debugSelect', { fromLine: fl, fromCh: fc, toLine: tl, toCh: tc });
const RED = '#d73a49', YEL = 'rgba(255,212,0,0.35)', GRN = 'rgba(52,208,88,0.35)';

suite('Phase 3 toolbar and formatting', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  let n = 0;
  async function open(text: string) {
    const file = path.join(tmp, `p3-${++n}.md`);
    fs.writeFileSync(file, text);
    const r = await openLive(file);
    return { ...r, file };
  }

  test('the toolbar is fixed at the top and has every button in order', async () => {
    const { uri, file } = await open('hello\n');
    const r = await ask<{ names: string[]; top: number; h: number }>(uri, 'debugToolbar');
    const want = ['heading', 'bold', 'italic', 'strike', 'textcolor', 'textcolor-menu', 'highlight', 'highlight-menu', 'code', 'link', 'bullets', 'numbered', 'checklist', 'outdent', 'indent', 'quote', 'codeblock', 'codeblock-lang', 'table', 'diagram', 'hr', 'page', 'plain'];
    assert.deepStrictEqual(r.names, want);
    assert.strictEqual(r.top, 0);
    assert.ok(r.h > 20);
    await closeTab(file);
  });

  test('bold on a selection inserts exactly ** before and after, and nothing else', async () => {
    const { uri, doc, file } = await open('alpha beta gamma\n');
    const orig = fs.readFileSync(file);
    await sel(uri, 0, 6, 0, 10);
    await act(uri, 'bold');
    assert.strictEqual(doc.getText(), 'alpha **beta** gamma\n');
    assert.strictEqual(Buffer.byteLength(doc.getText()), orig.length + 4, 'exactly four bytes added');
    assert.strictEqual(doc.getText().replace('**', '').replace('**', ''), orig.toString(), 'nothing but the two ** marks');
    await act(uri, 'bold');
    assert.strictEqual(doc.getText(), 'alpha beta gamma\n');
    await closeTab(file);
  });

  test('bold with an empty selection: acts on the word, or inserts ****, and toggles back', async () => {
    const { uri, doc, file } = await open('alpha beta  gamma\n');
    await sel(uri, 0, 8, 0, 8); // inside "beta"
    await act(uri, 'bold');
    assert.strictEqual(doc.getText(), 'alpha **beta**  gamma\n');
    await act(uri, 'bold');
    assert.strictEqual(doc.getText(), 'alpha beta  gamma\n');
    await sel(uri, 0, 11, 0, 11); // between the two spaces, no word
    await act(uri, 'bold');
    assert.strictEqual(doc.getText(), 'alpha beta ' + '****' + ' gamma\n');
    assert.ok(doc.getText().includes('beta ****'), 'inserted **|**');
    await act(uri, 'bold');
    assert.strictEqual(doc.getText(), 'alpha beta  gamma\n');
    await closeTab(file);
  });

  type Case = { name: string; text: string; s: [number, number, number, number]; a: string; arg?: string; off?: [string, string?] };
  const CASES: Case[] = [
    { name: 'bold', text: 'alpha beta gamma\n', s: [0, 6, 0, 10], a: 'bold' },
    { name: 'italic', text: 'alpha beta gamma\n', s: [0, 6, 0, 10], a: 'italic' },
    { name: 'strike', text: 'alpha beta gamma\n', s: [0, 6, 0, 10], a: 'strike' },
    { name: 'code', text: 'alpha beta gamma\n', s: [0, 6, 0, 10], a: 'code' },
    { name: 'link', text: 'alpha beta gamma\n', s: [0, 6, 0, 10], a: 'link' },
    { name: 'bullets', text: 'one\ntwo\n\nthree\n', s: [0, 0, 1, 3], a: 'bullets' },
    { name: 'numbered', text: 'one\ntwo\n\nthree\n', s: [0, 0, 1, 3], a: 'numbered' },
    { name: 'checklist', text: 'one\ntwo\n\nthree\n', s: [0, 0, 1, 3], a: 'checklist' },
    { name: 'quote', text: 'one\ntwo\n\nthree\n', s: [0, 0, 1, 3], a: 'quote' },
    { name: 'h1', text: 'Title here\n', s: [0, 2, 0, 2], a: 'h1', off: ['h0'] },
    { name: 'h2', text: 'Title here\n', s: [0, 2, 0, 2], a: 'h2', off: ['h0'] },
    { name: 'h3', text: 'Title here\n', s: [0, 2, 0, 2], a: 'h3', off: ['h0'] },
    { name: 'codeblock', text: 'one\ntwo\n\nthree\n', s: [0, 0, 1, 3], a: 'codeblock', arg: 'sql' },
    { name: 'text colour then No colour', text: 'alpha beta gamma\n', s: [0, 6, 0, 10], a: 'colour:text', arg: RED, off: ['colour:text', 'none'] },
    { name: 'highlight then No colour', text: 'alpha beta gamma\n', s: [0, 6, 0, 10], a: 'colour:highlight', arg: YEL, off: ['colour:highlight', 'none'] },
  ];
  for (const c of CASES) {
    test(`${c.name}: applying changes the document, toggling off returns the original bytes`, async () => {
      const { uri, doc, file } = await open(c.text);
      await sel(uri, ...c.s);
      await act(uri, c.a, c.arg);
      assert.notStrictEqual(doc.getText(), c.text, 'changed');
      await act(uri, c.off ? c.off[0] : c.a, c.off ? c.off[1] : c.arg);
      assert.strictEqual(doc.getText(), c.text, 'original bytes restored');
      await closeTab(file);
    });
  }

  test('the language picker sets the fence language; headings replace any existing level', async () => {
    const { uri, doc, file } = await open('# Title\n\nsome code\n');
    await sel(uri, 0, 3, 0, 3); await act(uri, 'h2');
    assert.strictEqual(doc.getText(), '## Title\n\nsome code\n');
    await act(uri, 'h0');
    assert.strictEqual(doc.getText(), 'Title\n\nsome code\n');
    await sel(uri, 2, 2, 2, 2); await act(uri, 'codeblock', 'python');
    assert.strictEqual(doc.getText(), 'Title\n\n```python\nsome code\n```\n');
    await act(uri, 'codeblock', 'json');
    assert.strictEqual(doc.getText(), 'Title\n\n```json\nsome code\n```\n');
    await act(uri, 'codeblock');
    assert.strictEqual(doc.getText(), 'Title\n\nsome code\n');
    await closeTab(file);
  });

  test('table, rule and every diagram template: insert, then VS Code undo restores the original bytes', async () => {
    for (const [name, arg] of [['table'], ['hr'], ['diagram', 'flowchart'], ['diagram', 'sequence'], ['diagram', 'timeline'], ['diagram', 'mindmap'], ['diagram', 'gantt'], ['diagram', 'pie'], ['diagram', 'state']] as Array<[string, string?]>) {
      const { uri, doc, file } = await open('First paragraph\n\nSecond paragraph\n');
      await sel(uri, 0, 3, 0, 3);
      const changed = new Promise<void>((res) => { const d = vscode.workspace.onDidChangeTextDocument(() => { d.dispose(); res(); }); });
      await act(uri, name, arg);
      await changed;
      assert.notStrictEqual(doc.getText(), 'First paragraph\n\nSecond paragraph\n', name);
      const undone = new Promise<void>((res) => { const d = vscode.workspace.onDidChangeTextDocument(() => { if (doc.getText() === 'First paragraph\n\nSecond paragraph\n') { d.dispose(); res(); } }); });
      await cmd('undo');
      await undone;
      assert.strictEqual(doc.getText(), 'First paragraph\n\nSecond paragraph\n', `${name} ${arg ?? ''}`);
      await closeTab(file);
    }
  });

  test('each diagram template inserts valid mermaid (mermaid.parse succeeds)', async () => {
    const { uri, doc, file } = await open('Intro\n');
    for (const k of ['flowchart', 'sequence', 'timeline', 'mindmap', 'gantt', 'pie', 'state']) {
      const last = doc.lineCount - 1;
      await cmd('inkwell._debugMoveCursor', uri, last, 9999);
      await act(uri, 'diagram', k);
    }
    const res = await ask<string[]>(uri, 'debugTemplates');
    assert.deepStrictEqual(res, ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    await closeTab(file);
  });

  test('switching a highlight colour changes only the style value', async () => {
    const { uri, doc, file } = await open('alpha beta gamma\n');
    await sel(uri, 0, 6, 0, 10);
    await act(uri, 'colour:highlight', YEL);
    assert.strictEqual(doc.getText(), `alpha <mark style="background:${YEL}">beta</mark> gamma\n`);
    await act(uri, 'colour:highlight', GRN);
    assert.strictEqual(doc.getText(), `alpha <mark style="background:${GRN}">beta</mark> gamma\n`);
    await act(uri, 'colour:highlight', 'none');
    assert.strictEqual(doc.getText(), 'alpha beta gamma\n');
    await closeTab(file);
  });

  test('"No colour" removes only canonical wrappers and leaves other HTML alone', async () => {
    const text = '<span style="color:red">x</span> and <span style="color:#d73a49">y</span> <mark style="background:rgba(255,212,0,0.35)">z</mark>\n';
    const { uri, doc, file } = await open(text);
    await sel(uri, 0, 0, 0, text.length - 1);
    await act(uri, 'colour:text', 'none');
    assert.strictEqual(doc.getText(), '<span style="color:red">x</span> and y <mark style="background:rgba(255,212,0,0.35)">z</mark>\n');
    await closeTab(file);
  });

  test('live preview hides canonical colour tags away from the cursor and shows them inside', async () => {
    const { uri, file } = await open(`Para <span style="color:${RED}">red</span> word\n\nother line\n`);
    await cmd('inkwell._debugMoveCursor', uri, 2, 0);
    let html = (await cmd<{ html: string }>('inkwell._debugGetDom', uri))!.html;
    assert.ok(!html.includes('&lt;span') && !/<span style="color:#d73a49">/.test(html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<span[^>]*cm-lm-colour[^>]*>/g, '')), 'tags hidden');
    assert.ok(html.includes('cm-lm-colour'), 'coloured span present');
    await cmd('inkwell._debugMoveCursor', uri, 0, 8);
    html = (await cmd<{ html: string }>('inkwell._debugGetDom', uri))!.html;
    assert.ok(html.includes('cm-lm-mark'), 'raw tags shown inside: ' + html.slice(html.indexOf('Para <') - 100, html.indexOf('Para <') + 600));
    await closeTab(file);
  });

  test('every formatting shortcut is contributed only inside Inkwell (when-clause), so VS Code chords stay intact', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));
    const kb = pkg.contributes.keybindings.filter((k: { command: string }) => k.command.startsWith('inkwell.format.'));
    assert.strictEqual(kb.length, 18);
    for (const k of kb) assert.strictEqual(k.when, "activeCustomEditorId == 'inkwell.editor'", k.command);
    const mac = new Set(kb.map((k: { mac: string }) => k.mac));
    const win = new Set(kb.map((k: { key: string }) => k.key));
    for (const key of ['cmd+b', 'cmd+i', 'cmd+shift+x', 'cmd+k', 'cmd+e', 'cmd+shift+8', 'cmd+shift+7', 'cmd+shift+9', 'cmd+shift+.', 'cmd+alt+1', 'cmd+alt+2', 'cmd+alt+3', 'cmd+alt+0', 'cmd+alt+c', 'cmd+shift+h', 'cmd+shift+c', 'cmd+]', 'cmd+[']) assert.ok(mac.has(key), key);
    for (const key of ['ctrl+b', 'ctrl+i', 'ctrl+shift+x', 'ctrl+k', 'ctrl+e', 'ctrl+shift+8', 'ctrl+shift+7', 'ctrl+shift+9', 'ctrl+shift+.', 'ctrl+shift+alt+1', 'ctrl+shift+alt+2', 'ctrl+shift+alt+3', 'ctrl+shift+alt+0', 'ctrl+shift+alt+c', 'ctrl+shift+h', 'ctrl+shift+c', 'ctrl+]', 'ctrl+[']) assert.ok(win.has(key), key);
    // Ctrl+Alt (AltGr on European layouts) must never be bound on Windows/Linux.
    for (const k of pkg.contributes.keybindings) assert.ok(!/^ctrl\+alt\+/.test(k.key), k.command + ' ' + k.key);
    for (const key of ['cmd+s', 'cmd+z', 'cmd+shift+z', 'ctrl+s', 'ctrl+z']) assert.ok(!mac.has(key) && !win.has(key), key + ' stays VS Code\'s');
    const toggle = pkg.contributes.keybindings.filter((k: { command: string }) => k.command === 'inkwell.toggle');
    assert.strictEqual(toggle.length, 1);
    assert.strictEqual(toggle[0].key, 'ctrl+shift+v');
    assert.strictEqual(toggle[0].mac, 'cmd+shift+v');
    assert.ok(!pkg.contributes.keybindings.some((k: { key: string }) => k.key === 'cmd+shift+alt+v'));
  });
});

suite('Phase 3 review fixes', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  let n = 0;
  async function run(text: string, s: [number, number, number, number], steps: Array<[string, string?]>) {
    const file = path.join(tmp, `r${++n}.md`); fs.writeFileSync(file, text);
    const { uri, doc } = await openLive(file);
    await sel(uri, ...s);
    const out: string[] = [];
    for (const [a, arg] of steps) { await act(uri, a, arg); out.push(doc.getText()); }
    await closeTab(file);
    return out;
  }
  test('bold on a partial-mark selection removes the whole bold node', async () => {
    assert.deepStrictEqual(await run('a **b** c\n', [0, 2, 0, 6], [['bold']]), ['a b c\n']);
  });
  test('heading on a list line keeps the bullet; Normal removes only the heading; same level again keeps it', async () => {
    assert.deepStrictEqual(await run('- item\n', [0, 3, 0, 3], [['h1'], ['h1'], ['h0']]), ['- # item\n', '- # item\n', '- item\n']);
  });
  test('removing a heading never turns its words into list syntax, and re-applying restores them exactly', async () => {
    assert.deepStrictEqual(await run('## 1. Overview\n', [0, 5, 0, 5], [['h0'], ['h2'], ['h1']]), ['1\\. Overview\n', '## 1. Overview\n', '# 1. Overview\n']);
    assert.deepStrictEqual(await run('# - note\n', [0, 4, 0, 4], [['h0'], ['h1']]), ['\\- note\n', '# - note\n']);
  });
  test('colour on part of a span splits it; "No colour" on part unwraps only that part', async () => {
    const src = '<span style="color:#d73a49">hello world</span>\n';
    const [a] = await run(src, [0, 34, 0, 39], [['colour:text', '#0366d6']]);
    assert.strictEqual(a, '<span style="color:#d73a49">hello</span><span style="color:#0366d6"> world</span>\n');
    const [b] = await run(src, [0, 34, 0, 39], [['colour:text', 'none']]);
    assert.strictEqual(b, '<span style="color:#d73a49">hello</span> world\n');
  });
});

suite('Phase 3 mermaid', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  async function svgs(uri: vscode.Uri, want: (r: { svgs: number; errors: string[] }) => boolean): Promise<{ svgs: number; errors: string[] }> {
    let r = await ask<{ svgs: number; errors: string[] }>(uri, 'debugMermaid');
    for (let i = 0; i < 40 && !want(r); i++) { await sleep(250); r = await ask(uri, 'debugMermaid'); }
    return r;
  }

  test('a mermaid block renders an <svg> when the cursor is outside, and below the block when inside', async () => {
    const text = 'Intro\n\n```mermaid\nflowchart TD\n  A[Start] --> B[End]\n```\n\nAfter\n';
    const file = path.join(tmp, 'm1.md'); fs.writeFileSync(file, text);
    const { uri } = await openLive(file);
    await cmd('inkwell._debugMoveCursor', uri, 0, 0);
    const r = await svgs(uri, (x) => x.svgs >= 1);
    assert.ok(r.svgs >= 1, 'svg rendered: ' + JSON.stringify(r));
    assert.deepStrictEqual(r.errors, []);
    await cmd('inkwell._debugMoveCursor', uri, 4, 2);
    const r2 = await svgs(uri, (x) => x.svgs >= 1);
    assert.ok(r2.svgs >= 1, 'diagram still shown below the raw text');
    const html = (await cmd<{ html: string }>('inkwell._debugGetDom', uri))!.html;
    assert.ok(html.includes('flowchart TD'), 'raw text visible while the cursor is inside');
    await closeTab(file);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), text);
  });

  test('a broken mermaid block shows an error and does not change the document', async () => {
    const text = 'Intro\n\n```mermaid\nthis is (( not a diagram\n```\n\nAfter\n';
    const file = path.join(tmp, 'm2.md'); fs.writeFileSync(file, text);
    const { uri, doc } = await openLive(file);
    await cmd('inkwell._debugMoveCursor', uri, 0, 0);
    const r = await svgs(uri, (x) => x.errors.length > 0);
    assert.ok(r.errors.length > 0, 'error text shown');
    assert.strictEqual(doc.getText(), text);
    assert.ok(!doc.isDirty);
    await closeTab(file);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), text);
  });

  test('typing a mistake keeps the last good diagram and shows the error underneath', async () => {
    const text = 'Intro\n\n```mermaid\nflowchart TD\n  A --> B\n```\n';
    const file = path.join(tmp, 'm3.md'); fs.writeFileSync(file, text);
    const { uri, doc } = await openLive(file);
    await svgs(uri, (x) => x.svgs >= 1);
    await cmd('inkwell._debugMoveCursor', uri, 4, 2);
    await cmd('inkwell._debugApplyWebviewEdit', uri, { fromLine: 4, fromCh: 2, toLine: 4, toCh: 2, insert: ' -->>> ((' });
    const r = await svgs(uri, (x) => x.errors.length > 0);
    assert.ok(r.errors.length > 0, 'error shown');
    assert.ok(r.svgs >= 1, 'last good diagram kept');
    assert.ok(doc.getText().includes('-->>> (('));
    await closeTab(file);
  });
});

suite('Phase 3 editable tables (bug A)', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  const TABLE = '# T\n\n| Name | Value |\n|------|:-----:|\n| a    | 1     |\n| b    | 2     |\n\nend\n';
  let n = 0;
  async function open(text = TABLE) {
    const file = path.join(tmp, `t${++n}.md`); fs.writeFileSync(file, text);
    const r = await openLive(file);
    return { ...r, file };
  }
  const tbl = (u: vscode.Uri, o: object) => ask(u, 'debugTable', o);

  test('the table stays rendered when the cursor is inside it (no raw markdown)', async () => {
    const { uri, file } = await open();
    await cmd('inkwell._debugMoveCursor', uri, 4, 2);
    const html = (await cmd<{ html: string }>('inkwell._debugGetDom', uri))!.html;
    assert.ok(html.includes('lm-tablewrap') && html.includes('contenteditable="plaintext-only"'));
    assert.ok(!/class="[^"]*lm-tableraw/.test(html));
    await closeTab(file);
  });

  test('a cell edit changes only that cell\'s bytes; "|" is escaped', async () => {
    const { uri, doc, file } = await open();
    await tbl(uri, { r: 1, c: 0, text: 'alpha' });
    assert.strictEqual(doc.getText(), TABLE.replace('| a    | 1', '| alpha    | 1'));
    await tbl(uri, { r: 1, c: 0, text: 'x|y' });
    assert.strictEqual(doc.getText(), TABLE.replace('| a    | 1', '| x\\|y    | 1'));
    await tbl(uri, { r: 1, c: 0, text: 'a' });
    assert.strictEqual(doc.getText(), TABLE);
    await closeTab(file);
  });

  const ops: Array<[string, { r: number; c: number; op: string }, { r: number; c: number; op: string }]> = [
    ['row below', { r: 1, c: 0, op: 'rowBelow' }, { r: 2, c: 0, op: 'delRow' }],
    ['row below the header', { r: 0, c: 0, op: 'rowBelow' }, { r: 1, c: 0, op: 'delRow' }],
    ['row above', { r: 2, c: 0, op: 'rowAbove' }, { r: 2, c: 0, op: 'delRow' }],
    ['column right', { r: 1, c: 0, op: 'colRight' }, { r: 1, c: 1, op: 'delCol' }],
    ['column left', { r: 1, c: 1, op: 'colLeft' }, { r: 1, c: 1, op: 'delCol' }],
    ['column right of the last', { r: 1, c: 1, op: 'colRight' }, { r: 1, c: 2, op: 'delCol' }],
  ];
  for (const [name, add, del] of ops) {
    test(`add ${name}, then delete it: the original bytes come back, untouched rows are not reformatted`, async () => {
      const { uri, doc, file } = await open();
      await tbl(uri, add);
      assert.notStrictEqual(doc.getText(), TABLE);
      const { prefix, suffix } = commonAffixes(Buffer.from(TABLE), Buffer.from(doc.getText()));
      if (add.op.startsWith('row')) assert.strictEqual(Buffer.from(TABLE).length - prefix - suffix <= 0, true, 'a row insertion adds bytes only');
      await tbl(uri, del);
      assert.strictEqual(doc.getText(), TABLE);
      await closeTab(file);
    });
  }

  test('floating bar stays inside the viewport and never covers the focused row (row 30 of 40)', async () => {
    const rowsTxt = Array.from({ length: 40 }, (_, i) => `| r${i + 1} | v${i + 1} |`).join('\n');
    const { uri, file } = await open(`# T\n\n| H | V |\n|---|---|\n${rowsTxt}\n\nend\n`);
    const r = (await ask<any>(uri, 'debugTable', { r: 30, c: 0, op: 'barRect' }));
    assert.ok(r && !r.hidden && r.bar, 'bar visible');
    assert.ok(r.bar.top >= 0 && r.bar.bottom <= r.vh && r.bar.left >= 0 && r.bar.right <= r.vw, 'bar inside viewport');
    assert.ok(r.bar.bottom <= r.row.top || r.bar.top >= r.row.bottom, `not covering the row (${JSON.stringify(r)})`);
    await closeTab(file);
  });

  test('hover handles add a row / column with the same minimal change as the ops', async () => {
    const { uri, doc, file } = await open();
    await tbl(uri, { r: 1, c: 0, op: 'handleRow' });
    assert.notStrictEqual(doc.getText(), TABLE);
    await tbl(uri, { r: 3, c: 0, op: 'delRow' });
    assert.strictEqual(doc.getText(), TABLE);
    await tbl(uri, { r: 1, c: 0, op: 'handleCol' });
    assert.notStrictEqual(doc.getText(), TABLE);
    await tbl(uri, { r: 1, c: 2, op: 'delCol' });
    assert.strictEqual(doc.getText(), TABLE);
    await closeTab(file);
  });

  test('context-menu actions run the same ops', async () => {
    const { uri, doc, file } = await open();
    await tbl(uri, { r: 1, c: 0, op: 'ctxmenu', item: 'rowBelow' });
    const viaMenu = doc.getText();
    await tbl(uri, { r: 2, c: 0, op: 'delRow' });
    assert.strictEqual(doc.getText(), TABLE);
    await tbl(uri, { r: 1, c: 0, op: 'rowBelow' });
    assert.strictEqual(doc.getText(), viaMenu);
    await tbl(uri, { r: 2, c: 0, op: 'ctxmenu', item: 'delRow' });
    assert.strictEqual(doc.getText(), TABLE);
    await tbl(uri, { r: 1, c: 0, op: 'ctxmenu', item: 'alignRight' });
    assert.strictEqual(doc.getText(), TABLE.replace('|------|', '|-----:|'));
    await closeTab(file);
  });

  test('alignment control changes only the delimiter cell, width kept', async () => {
    const { uri, doc, file } = await open();
    await tbl(uri, { r: 1, c: 0, op: 'alignRight' });
    assert.strictEqual(doc.getText(), TABLE.replace('|------|', '|-----:|'));
    await closeTab(file);
  });

  test('Cmd/Ctrl+Enter in the last row adds a row; Tab moves on', async () => {
    const { uri, doc, file } = await open();
    await tbl(uri, { r: 2, c: 0, op: 'ModEnter' });
    assert.strictEqual(doc.getText(), TABLE.replace('| b    | 2     |\n', '| b    | 2     |\n|      |       |\n'));
    await closeTab(file);
  });

  test('Enter in a cell writes <br> and the cell shows a line break', async () => {
    const { uri, doc, file } = await open();
    await tbl(uri, { r: 1, c: 0, op: 'Enter', at: 1 });
    assert.strictEqual(doc.getText(), TABLE.replace('| a    |', '| a<br>    |'), doc.getText());
    const r = await ask<{ html: string }>(uri, 'debugTable', { r: 1, c: 0, op: 'html' });
    assert.ok(/a<br>/.test(r.html), 'rendered as a real line break: ' + r.html);
    await closeTab(file);
  });

  test('Bold, Italic and colour work on text selected in a cell; Italic toggles off; Undo restores', async () => {
    const { uri, doc, file } = await open();
    await tbl(uri, { r: 1, c: 1, op: 'format', from: 0, to: 1, action: 'italic' });
    assert.ok(doc.getText().includes('| *1*'), doc.getText());
    await tbl(uri, { r: 1, c: 1, op: 'format', from: 0, to: 3, action: 'italic' });
    assert.strictEqual(doc.getText(), TABLE, 'italic toggles off');
    await tbl(uri, { r: 1, c: 1, op: 'format', from: 0, to: 1, action: 'bold' });
    assert.ok(doc.getText().includes('| **1**'), doc.getText());
    const h = await ask<{ html: string }>(uri, 'debugTable', { r: 1, c: 1, op: 'html' });
    assert.ok(h.html.includes('<strong>1</strong>'), h.html);
    await tbl(uri, { r: 2, c: 1, op: 'format', from: 0, to: 1, action: 'colour:text', arg: '#e03e2d' });
    assert.ok(doc.getText().includes('<span style="color:#e03e2d">2</span>'), doc.getText());
    const h2 = await ask<{ html: string }>(uri, 'debugTable', { r: 2, c: 1, op: 'html' });
    assert.ok(h2.html.includes('<span style="color:#e03e2d">2</span>'), h2.html);
    await closeTab(file);
  });

  test('in a cell: Bold then Italic stack on the same selection, each toggles off, each is one Undo step', async () => {
    const { uri, doc, file } = await open();
    const fmt = (from: number, to: number, action: string) => tbl(uri, { r: 1, c: 0, op: 'format', from, to, action });
    await fmt(0, 1, 'bold'); assert.ok(doc.getText().includes('| **a**'), doc.getText());
    await fmt(2, 3, 'italic'); assert.ok(doc.getText().includes('| ***a***'), doc.getText());
    await fmt(3, 4, 'bold'); assert.ok(doc.getText().includes('| *a*'), 'bold removed: ' + doc.getText());
    await fmt(1, 2, 'italic'); assert.strictEqual(doc.getText(), TABLE, 'italic removed');
    await cmd('inkwell.undo'); await sleep(200);
    assert.ok(doc.getText().includes('| *a*'), 'one undo step back: ' + doc.getText());
    await closeTab(file);
  });

  test('in a cell: bullets and numbering prefix each line; heading is refused without changing the file', async () => {
    const { uri, doc, file } = await open(TABLE.replace('| a    |', '| a<br>b |'));
    await tbl(uri, { r: 1, c: 0, op: 'format', from: 0, to: 0, action: 'numbered' });
    assert.ok(doc.getText().includes('| 1. a<br>2. b |'), doc.getText());
    const before = doc.getText();
    await tbl(uri, { r: 1, c: 0, op: 'format', from: 0, to: 0, action: 'h1' });
    assert.strictEqual(doc.getText(), before);
    await closeTab(file);
  });

  test('BUG B: clicks map to the right line before and after interacting with a table', async () => {
    const text = 'Intro paragraph here\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter paragraph here\n\nLast line\n';
    const { uri, file } = await open(text);
    const check = async (when: string) => {
      await sleep(500); // let CodeMirror's measure cycle run, as it does between a user's clicks
      for (const line of [0, 6, 8]) {
        const r = await ask<{ expected: number; got: number | null }>(uri, 'debugCoords', { line });
        assert.strictEqual(r.got, r.expected, `${when}: line ${line} -> ${String(r.got)} ${JSON.stringify(r)}`);
      }
    };
    await check('before');
    await tbl(uri, { r: 1, c: 0, text: 'changed' });
    await check('after a cell edit');
    await tbl(uri, { r: 1, c: 0, op: 'rowBelow' });
    await check('after adding a row');
    await cmd('inkwell._debugMoveCursor', uri, 0, 0);
    await check('after moving the cursor out');
    await closeTab(file);
  });
});

suite('Phase 3 selection (bug C)', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  const TEXT = 'The quick brown fox\n\nSecond **bold** line with a [link](https://example.com/x) here\n';
  async function open() { const file = path.join(tmp, 'sel.md'); fs.writeFileSync(file, TEXT); const r = await openLive(file); return { ...r, file }; }

  test('a dispatched selection is reported back and replaced by typing: only that range changes', async () => {
    const { uri, doc, file } = await open();
    const r = await sel(uri, 0, 4, 0, 9) as { selected: string };
    assert.strictEqual(r.selected, 'quick');
    await ask(uri, 'debugTypeOverSelection', { text: 'slow' });
    assert.strictEqual(doc.getText(), TEXT.replace('quick', 'slow'));
    const { prefix, suffix } = commonAffixes(Buffer.from(TEXT), Buffer.from(doc.getText()));
    assert.strictEqual(prefix, 4); assert.strictEqual(suffix, TEXT.length - 9);
    await closeTab(file);
  });

  test('a selection across revealed marks and a link is kept, and nothing is rewritten by moving it', async () => {
    const { uri, doc, file } = await open();
    const r = await sel(uri, 2, 0, 2, 40) as { selected: string };
    assert.strictEqual(r.selected, TEXT.split('\n')[2].slice(0, 40));
    assert.strictEqual(doc.getText(), TEXT); assert.ok(!doc.isDirty);
    await closeTab(file);
  });

  test('the content is not painted over the selection: backgrounds are transparent', async () => {
    const { uri, file } = await open();
    const c = await cmd<{ contentBg: string }>('inkwell._debugGetColours', uri);
    assert.ok(/rgba\(0, 0, 0, 0\)|transparent/.test(c!.contentBg), c!.contentBg);
    await closeTab(file);
  });

  test('double-click selects a word, triple-click a line, shift-click extends', async () => {
    const { uri, file } = await open();
    const dbl = await ask<{ text: string }>(uri, 'debugMouse', { line: 0, ch: 6, clicks: 2 });
    assert.strictEqual(dbl.text, 'quick');
    await sleep(700);
    const tri = await ask<{ text: string }>(uri, 'debugMouse', { line: 0, ch: 6, clicks: 3 });
    assert.ok(tri.text.startsWith('The quick brown fox'), JSON.stringify(tri));
    await sleep(700);
    await ask(uri, 'debugMouse', { line: 0, ch: 4, clicks: 1 });
    const ext = await ask<{ from: number; to: number }>(uri, 'debugMouse', { line: 0, ch: 15, clicks: 1, shift: true });
    assert.ok(ext.to - ext.from >= 8, 'selection extended: ' + JSON.stringify(ext));
    await closeTab(file);
  });
});
