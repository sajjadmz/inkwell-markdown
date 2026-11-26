// Phase 2b: live-preview decorations must never change the document; checkbox clicks make one-character edits;
// Markdown opens in Inkwell by default but diffs stay in the text editor.
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { FIXTURES, VIEW, closeTab, expectedBytes, findTab, openLive, rmDir, tmpDir, webviewText } from './helpers';

const cmd = <T>(c: string, ...a: unknown[]) => vscode.commands.executeCommand<T>(c, ...a);
const FIXES = ['showcase.md', 'frontmatter.md', 'table.md', 'code-block.md', 'task-list.md', 'crlf.md', 'bom.md', 'tabs.md', 'lf.md', 'no-trailing-newline.md'];

suite('Live preview', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  const copy = (name: string, as = name) => { const f = path.join(tmp, as); fs.copyFileSync(path.join(FIXTURES, name), f); return f; };

  for (const name of FIXES) {
    test(`decorations never change ${name}: cursor visits every line, file bytes and dirty flag unchanged`, async () => {
      const file = copy(name, 'a-' + name);
      const orig = fs.readFileSync(file);
      const { uri, doc } = await openLive(file);
      const lines = (await webviewText(uri))!.split('\n').length;
      for (let l = 0; l < lines; l++) {
        await cmd('inkwell._debugMoveCursor', uri, l, 0);
        assert.ok(!doc.isDirty, `dirty after moving to line ${l}`);
      }
      await cmd('inkwell._debugMoveCursor', uri, lines - 1, 9999);
      assert.strictEqual(doc.getText().replace(/\r\n/g, '\n'), await webviewText(uri), 'webview text equals document text');
      assert.ok(!doc.isDirty, 'not dirty');
      await closeTab(file);
      assert.deepStrictEqual(fs.readFileSync(file), orig, 'bytes unchanged on disk');
    });
  }

  test('rendered DOM hides the marks and shows widgets when the cursor is away', async () => {
    const file = copy('showcase.md', 'dom.md');
    const { uri } = await openLive(file);
    await cmd('inkwell._debugMoveCursor', uri, 99, 0);
    await new Promise((r) => setTimeout(r, 1200)); // language for the code block loads on demand
    const { html } = (await cmd<{ html: string }>('inkwell._debugGetDom', uri))!;
    for (const needle of ['lm-h1', 'cm-lm-strong', 'cm-lm-link', 'lm-bullet', 'lm-checkbox', 'lm-tablewrap', 'lm-imgwrap', 'lm-fm-widget', 'lm-quote', 'lm-hr', 'class="token ']) {
      assert.ok(html.includes(needle), `DOM contains ${needle}`);
    }
    assert.ok(!html.includes('# Heading one'), 'the # mark is hidden');
    assert.ok(!html.includes('**bold**'), 'the ** marks are hidden');
    await closeTab(file);
  });

  test('inline HTML <b>, <i>, <u> tags are hidden and their formatting shown; bytes unchanged', async () => {
    const file = path.join(tmp, 'tags.md');
    const src = 'top\n\n<i><span style="color:#e03e2d">Note: italic red</span></i>\n\n<b>Answer:</b> plain <u>under</u> and <I>caps</I>\n\nend\n';
    fs.writeFileSync(file, src);
    const { uri, doc } = await openLive(file);
    await cmd('inkwell._debugMoveCursor', uri, 6, 0);
    await new Promise((r) => setTimeout(r, 300));
    const { html } = (await cmd<{ html: string }>('inkwell._debugGetDom', uri))!;
    for (const raw of ['&lt;i&gt;', '&lt;/i&gt;', '&lt;b&gt;', '&lt;/b&gt;', '&lt;u&gt;', '&lt;I&gt;']) assert.ok(!html.includes(raw), `${raw} is hidden`);
    assert.ok(/font-style: ?italic/.test(html), 'italic shown');
    assert.ok(/font-weight: ?bold/.test(html), 'bold shown');
    assert.ok(/text-decoration: ?underline/.test(html), 'underline shown');
    await cmd('inkwell._debugMoveCursor', uri, 4, 2);
    await new Promise((r) => setTimeout(r, 300));
    const h2 = (await cmd<{ html: string }>('inkwell._debugGetDom', uri))!.html;
    assert.ok(/cm-lm-mark">(<[^>]*>)*&lt;(<[^>]*>)*b(<[^>]*>)*&gt;/.test(h2), 'tags are shown on the line being edited');
    assert.ok(!doc.isDirty, 'not dirty');
    await closeTab(file);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), src, 'bytes unchanged');
  });

  test('a checkbox click changes exactly "[ ]" to "[x]" and nothing else', async () => {
    const file = copy('task-list.md', 'b.md');
    const orig = fs.readFileSync(file);
    const { uri, doc } = await openLive(file);
    await cmd('inkwell._debugMoveCursor', uri, 0, 0);
    await cmd('inkwell._debugClickCheckbox', uri, 0);
    assert.ok(doc.isDirty);
    const before = orig.toString('utf8'), after = doc.getText();
    assert.strictEqual(after.length, before.length, 'same length');
    const diffs = [...before].map((c, i) => (c === after[i] ? -1 : i)).filter((i) => i >= 0);
    assert.deepStrictEqual(diffs.length, 1, 'exactly one character differs');
    assert.strictEqual(before.slice(diffs[0] - 1, diffs[0] + 2), '[ ]');
    assert.strictEqual(after.slice(diffs[0] - 1, diffs[0] + 2), '[x]');
    assert.strictEqual(await webviewText(uri), after);
    await doc.save();
    assert.deepStrictEqual(fs.readFileSync(file), expectedBytes(orig, [{ fromLine: 2, fromCh: 3, toLine: 2, toCh: 4, insert: 'x' }]));
    // And back again (the second box is the first one's "done" sibling: click #1 un-checks "done task").
    await cmd('inkwell._debugClickCheckbox', uri, 1);
    assert.ok(doc.getText().includes('- [ ] done task'));
    await doc.save();
    await closeTab(file);
  });

  test('a markdown file opens in Inkwell by default', async () => {
    const file = copy('lf.md', 'c.md');
    const uri = vscode.Uri.file(file);
    const ready = cmd('inkwell._debugWhenReady', uri);
    await cmd('vscode.open', uri);
    await ready;
    assert.ok(findTab(file, VIEW), 'opened with the Inkwell editor');
    await closeTab(file);
  });

  test('diff views and compare keep using the text editor', async () => {
    const a = copy('lf.md', 'd1.md'), b = copy('crlf.md', 'd2.md');
    await cmd('vscode.diff', vscode.Uri.file(a), vscode.Uri.file(b), 'a vs b');
    await new Promise((r) => setTimeout(r, 500));
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(input instanceof vscode.TabInputTextDiff, 'a diff editor, not a custom editor');
    await cmd('workbench.action.closeActiveEditor');
  });

  test('mixed line endings: one information notice per file per session', async () => {
    const file = path.join(tmp, 'mixed.md');
    fs.writeFileSync(file, 'one\r\ntwo\nthree\r\n');
    const orig = fs.readFileSync(file);
    const { uri } = await openLive(file);
    assert.strictEqual(await cmd('inkwell._debugEolNotified', uri), true);
    await closeTab(file);
    assert.deepStrictEqual(fs.readFileSync(file), orig, 'file untouched');
    const clean = copy('crlf.md', 'clean.md');
    const o2 = await openLive(clean);
    assert.strictEqual(await cmd('inkwell._debugEolNotified', o2.uri), false);
    await closeTab(clean);
  });
});

suite('Snapshot', () => {
  for (const theme of ['github-light', 'github-dark']) {
    test(`snapshot ${theme}`, async function () {
      if (!process.env.LM_SNAPSHOT) return this.skip();
      const lm = vscode.workspace.getConfiguration('inkwell');
      const old = lm.inspect<string>('previewTheme')?.globalValue;
      const file = path.join(FIXTURES, 'showcase.md');
      try {
        await lm.update('previewTheme', theme + '.css', vscode.ConfigurationTarget.Global);
        const { uri, doc } = await openLive(file);
        await new Promise((r) => setTimeout(r, 400));
        await cmd('inkwell._debugMoveCursor', uri, doc.lineCount - 1, 9999);
        let dom = (await cmd<{ html: string; baseUri: string }>('inkwell._debugGetDom', uri))!;
        for (let i = 0; i < 40 && !(dom.html.includes('class="token ') && /class="lm-mmd-svg"><svg/.test(dom.html)); i++) {
          await new Promise((r) => setTimeout(r, 250));
          dom = (await cmd<{ html: string; baseUri: string }>('inkwell._debugGetDom', uri))!;
        }
        const html = dom.html
          .replace(/<script\b[\s\S]*?<\/script>/g, '')
          .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
          .replace(/https:\/\/file(?:\+|%2B)\.vscode-resource\.vscode-cdn\.net\/[^"']*?\/test\/fixtures\//g, '../../test/fixtures/')
          .replace(/<html/, '<!-- Static snapshot of the Inkwell editor (test/fixtures/showcase.md, cursor at the end). Generated by npm run snapshot. -->\n<html');
        const out = path.resolve(FIXTURES, '../../docs/snapshots', theme + '.html');
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, '<!DOCTYPE html>\n' + html);
        await closeTab(file);
      } finally {
        await lm.update('previewTheme', old, vscode.ConfigurationTarget.Global);
      }
    });
  }
});
