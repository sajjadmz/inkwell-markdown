// Custom hover notes on the toolbar, its dropdown items and the table bar.
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { closeTab, openLive, rmDir, tmpDir } from './helpers';

const cmd = <T>(c: string, ...a: unknown[]) => vscode.commands.executeCommand<T>(c, ...a);
const ask = <T = any>(u: vscode.Uri, type: string, extra: object = {}) => cmd<T>('inkwell._debugAsk', u, type, extra);
const MAC = process.platform === 'darwin';

suite('Toolbar hover notes', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  test('controls, dropdown items and the table bar show custom notes; they hide and never touch text or selection', async () => {
    const T = 'hello world\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
    const file = path.join(tmp, 't.md'); fs.writeFileSync(file, T);
    const { uri, doc } = await openLive(file);
    await ask(uri, 'debugSelect', { fromLine: 0, fromCh: 0, toLine: 0, toCh: 5 });
    const hover = (selector: string, op = 'over') => ask(uri, 'debugHover', { selector, op });
    const inside = (r: any) => r.rect.l >= 0 && r.rect.t >= 0 && r.rect.r <= r.vw && r.rect.b <= r.vh;

    let r = await hover('#lm-toolbar [data-action="bold"]');
    assert.ok(r.shown, 'bold note shown');
    assert.strictEqual(r.text, MAC ? 'Bold  ⌘B' : 'Bold  Ctrl+B');
    assert.ok(inside(r), 'inside the viewport'); assert.strictEqual(r.pe, 'none'); assert.strictEqual(r.title, null, 'no native title');
    r = await hover('#lm-toolbar [data-action="bold"]', 'out');
    assert.ok(!r.shown, 'hidden on mouseleave');
    r = await hover('#lm-toolbar [data-action="textcolor-menu"]');
    assert.strictEqual(r.text, 'Choose text colour');
    r = await hover('#lm-toolbar [data-action="heading"]'); assert.strictEqual(r.text, 'Heading');
    r = await hover('#lm-toolbar [data-action="diagram"]'); assert.strictEqual(r.text, 'Insert diagram');
    // a dropdown item
    await ask(uri, 'debugClick', { selector: '#lm-toolbar [data-action="textcolor-menu"]' });
    r = await hover('.lm-menu .lm-mi');
    assert.ok(r.shown && r.text && r.text.length > 0, 'menu item note: ' + r.text);
    assert.ok(inside(r));
    await ask(uri, 'debugClick', { selector: '.lm-menu .lm-mi:last-child' }); // "No colour" closes the menu
    // a table bar button
    await ask(uri, 'debugFocus', { cell: { r: 1, c: 0 } });
    r = await hover('.lm-floatbar button[data-op="rowBelow"]');
    assert.ok(r.shown && /row/i.test(r.text), 'table bar note: ' + r.text);
    assert.ok(inside(r));
    r = await hover('.lm-hrow'); assert.strictEqual(r.text, 'Add row at the end');
    await ask(uri, 'debugSelect', { fromLine: 0, fromCh: 0, toLine: 0, toCh: 5 });
    r = await hover('#lm-toolbar [data-action="italic"]');
    assert.ok(r.same, 'hovering changed neither document nor selection');
    assert.strictEqual(doc.getText().replace('| a | b |', '').length > 0, true);
    await closeTab(file);
  });
});
