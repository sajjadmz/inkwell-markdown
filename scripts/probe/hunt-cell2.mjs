import { start } from './hunt-lib.mjs';
const H = await start();
const orig = await H.doc();
const TL = async () => (await H.lines()).filter((l) => l.startsWith('|'));
const show = async (l, n) => { const t = await TL(); console.log(l.padEnd(24), JSON.stringify(n === undefined ? t : t[n]), '| cell:', JSON.stringify(await H.cellText())); await H.check(l); };
const reset = async () => { await H.fr.evaluate((o) => { const v = window.__view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: o } }); }, orig); await H.page.keyboard.press('Escape'); await H.wait(300); };
// Enter at start / middle / end
await H.cell('last cell').click(); await H.wait(200);
await H.caretCell(0); await H.key('Enter'); await show('Enter at start', 4);
await H.caretCell(5); await H.key('Enter'); await show('Enter middle', 4);
await H.key('Enter'); await show('Enter twice', 4);
await H.key('Backspace'); await H.key('Backspace'); await show('2x Backspace', 4);
await H.key('Backspace'); await show('Backspace across br', 4);
await H.key('Meta+ArrowRight'); await H.key('Enter'); await show('Enter at end', 4);
await H.key('x'); await show('+x', 4);
await H.key('Meta+z'); await show('undo', 4); await H.key('Meta+z'); await show('undo', 4);await H.key('Meta+z'); await show('undo', 4);
await H.page.keyboard.press('Escape'); await H.wait(300);
console.log('after Escape row:', JSON.stringify((await TL())[4]), 'rendered:', await H.f.locator('td', {hasText:'last'}).first().innerHTML());
await reset();
// paste multi-line
await H.cell('end').click(); await H.wait(200); await H.selectCell();
await H.fr.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'l1\nl2 | pipe\n\nl4'); document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
await H.wait(300); await show('synthetic paste', 4);
await H.page.context().grantPermissions(['clipboard-read','clipboard-write']).catch(()=>{});
await H.page.evaluate(() => navigator.clipboard.writeText('p1\np2 | q\r\np3')).catch((e)=>console.log('clip err', e.message));
await H.selectCell(); await H.key('Meta+v'); await H.wait(300); await show('real paste', 4);
// Tab, shift tab, cmd+enter
await reset();
await H.cell('a|b').click(); await H.wait(200);
for (const k of ['Tab','Tab','Shift+Tab','Meta+Enter','Meta+Enter','Meta+Enter']) { await H.key(k); console.log(k.padEnd(14), 'active:', JSON.stringify(await H.cellText()), 'rows', (await TL()).length); }
await H.check('tab');
// last cell Tab -> new row
await H.cell('end').click(); await H.key('Tab'); console.log('Tab from last cell:', JSON.stringify(await TL()));
await H.close();
