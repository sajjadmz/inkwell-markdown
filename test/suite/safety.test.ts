// S1: opening and closing a file in the editor never dirties it or changes bytes.
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { FIXTURES, VIEW, closeTab, findTab, openLive, rmDir, tmpDir, webviewText } from './helpers';

suite('S1 open/close', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  const files = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.md'));
  test('fixtures exist', () => assert.ok(files.length >= 8));

  for (const name of files) {
    test(`open/close leaves ${name} untouched`, async () => {
      const file = path.join(tmp, name);
      fs.copyFileSync(path.join(FIXTURES, name), file);
      const before = fs.readFileSync(file);
      const { uri, doc } = await openLive(file);
      assert.ok(doc, 'document loaded');
      assert.strictEqual(doc.isDirty, false, 'not dirty while open');
      assert.strictEqual((findTab(file)!.input as { viewType?: string }).viewType, VIEW, 'opened in custom editor');
      const shown = await webviewText(uri);
      assert.strictEqual(shown, doc.getText().replace(/\r\n/g, '\n'), 'webview shows the document text');
      await closeTab(file);
      assert.strictEqual(doc.isDirty, false, 'not dirty after close');
      assert.ok(Buffer.compare(before, fs.readFileSync(file)) === 0, 'bytes unchanged');
    });
  }
});
