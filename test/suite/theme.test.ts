import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { FIXTURES, closeTab, openLive, rmDir, tmpDir } from './helpers';

suite('Page style', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  const cols = (uri: vscode.Uri) => vscode.commands.executeCommand<{ bodyBg: string; bodyColor: string; contentBg: string; contentColor: string }>('inkwell._debugGetColours', uri);
  const bg = (uri: vscode.Uri) => vscode.commands.executeCommand<string>('inkwell._debugGetBodyBackground', uri);

  test('github-light.css is white even when VS Code is dark; auto follows VS Code', async () => {
    const wb = vscode.workspace.getConfiguration('workbench');
    const lm = vscode.workspace.getConfiguration('inkwell');
    const oldTheme = wb.inspect<string>('colorTheme')?.globalValue;
    const oldStyle = lm.inspect<string>('previewTheme')?.globalValue;
    const file = path.join(tmp, 'theme.md');
    fs.copyFileSync(path.join(FIXTURES, 'lf.md'), file);
    try {
      await wb.update('colorTheme', 'Default Dark Modern', vscode.ConfigurationTarget.Global);
      await lm.update('previewTheme', 'github-light.css', vscode.ConfigurationTarget.Global);
      const { uri } = await openLive(file);
      assert.strictEqual(await bg(uri), 'rgb(255, 255, 255)', 'light page on a dark VS Code');
      const c = (await cols(uri))!;
      assert.ok(['rgb(255, 255, 255)', 'rgba(0, 0, 0, 0)'].includes(c.contentBg), 'editor content area is white or transparent over the white page: ' + c.contentBg);
      assert.strictEqual(c.bodyColor, 'rgb(51, 51, 51)', 'github-light text colour');
      assert.strictEqual(c.contentColor, c.bodyColor, 'editor text follows the theme text colour');
      await lm.update('previewTheme', 'auto', vscode.ConfigurationTarget.Global);
      await new Promise((r) => setTimeout(r, 300));
      assert.notStrictEqual(await bg(uri), 'rgb(255, 255, 255)', 'auto follows the dark theme');
      const d = (await cols(uri))!;
      assert.ok(d.contentBg === d.bodyBg || d.contentBg === 'rgba(0, 0, 0, 0)', 'dark: content background is the page background (or transparent over it)');
      assert.strictEqual(d.contentColor, d.bodyColor, 'dark: content text equals page text colour');
      assert.notStrictEqual(d.contentColor, 'rgb(51, 51, 51)', 'dark text is not the light theme text');
      await lm.update('previewTheme', 'github-light.css', vscode.ConfigurationTarget.Global);
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(await bg(uri), 'rgb(255, 255, 255)', 'switching back updates the open page');
      await closeTab(file);
    } finally {
      await lm.update('previewTheme', oldStyle, vscode.ConfigurationTarget.Global);
      await wb.update('colorTheme', oldTheme, vscode.ConfigurationTarget.Global);
    }
  });
  test('picking a page style from the toolbar menu changes the page', async () => {
    const lm = vscode.workspace.getConfiguration('inkwell');
    const old = lm.inspect<string>('previewTheme')?.globalValue;
    const file = path.join(tmp, 'menu.md');
    fs.copyFileSync(path.join(FIXTURES, 'lf.md'), file);
    const ask = (u: vscode.Uri, type: string, extra: object = {}) => vscode.commands.executeCommand<any>('inkwell._debugAsk', u, type, extra);
    try {
      await lm.update('previewTheme', 'github-light.css', vscode.ConfigurationTarget.Global);
      const { uri } = await openLive(file);
      assert.strictEqual(await bg(uri), 'rgb(255, 255, 255)');
      await vscode.commands.executeCommand('inkwell._debugAction', uri, 'page');
      const r = await ask(uri, 'debugMenuPick', { label: 'one-dark' });
      assert.ok(r.found, 'one-dark is in the menu: ' + JSON.stringify(r.labels));
      for (let i = 0; i < 40 && vscode.workspace.getConfiguration('inkwell').get('previewTheme') !== 'one-dark.css'; i++) await new Promise((res) => setTimeout(res, 100));
      assert.strictEqual(vscode.workspace.getConfiguration('inkwell').get('previewTheme'), 'one-dark.css', 'setting saved');
      await new Promise((res) => setTimeout(res, 400));
      assert.notStrictEqual(await bg(uri), 'rgb(255, 255, 255)', 'page repainted dark');
      await closeTab(file);
    } finally { await lm.update('previewTheme', old, vscode.ConfigurationTarget.Global); }
  });
});
