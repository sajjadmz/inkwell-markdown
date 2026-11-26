import { start } from './hunt-lib.mjs';
const H = await start();
const orig = await H.doc();
const TL = async () => (await H.lines()).filter((l) => l.startsWith('|'));
const show = async (l) => { console.log(l.padEnd(26), JSON.stringify((await TL())), '| cell:', JSON.stringify(await H.cellText()), '| sel:', JSON.stringify(await H.cellSel())); await H.check(l); };
// header cell
await H.cell('H1').click(); await H.wait(200);
await H.selectCell('H1'); await H.key('Meta+b'); await show('hdr bold');
await H.key('Meta+i'); await show('hdr +ital');
await H.key('Meta+z'); await show('undo'); await H.key('Meta+z'); await show('undo');
await H.key('Meta+Shift+z'); await show('redo');
// partial overlap in cell
await H.selectCell('H1'); await H.key('Meta+b');
await H.key('Meta+z');
// cell with \|
await H.cell('a|b').click(); await H.wait(200); console.log('cell shows', JSON.stringify(await H.cellText()));
await H.selectCell('a|b'); await H.key('Meta+b'); await show('pipe bold');
await H.key('Meta+b'); await show('pipe bold off');
await H.selectCell('b'); await H.key('Meta+b'); await show('bold just b');
await H.key('Meta+z'); await H.key('Meta+z');await H.key('Meta+z'); await show('undo*3');
// link cell
await H.cell('link').click(); await H.wait(200);
await H.selectCell('link'); await H.key('Meta+b'); await show('link text bold');
await H.key('Meta+k'); await show('Cmd+K on bold link text');
await H.key('Meta+z'); await H.key('Meta+z');
// code cell
await H.cell('code').click(); await H.wait(200); await H.selectCell('`code`'); await H.key('Meta+e'); await show('code cmd+e on `code`');
await H.key('Meta+b'); await show('bold on code');
// toggle bold on selection w/ markers
await H.key('Meta+z'); await H.key('Meta+z');
// br cell
await H.cell('one').click(); await H.wait(200); console.log('br cell shows', JSON.stringify(await H.cellText()));
await H.selectCell(); await H.key('Meta+b'); await show('bold whole br cell');
await H.key('Meta+Shift+8'); await show('bullets on br cell');
await H.key('Meta+Shift+8'); await show('bullets off');
await H.key('Meta+Shift+7'); await show('numbered');
await H.key('Meta+Shift+9'); await show('check');
await H.key('Meta+z'); await H.key('Meta+z');await H.key('Meta+z'); await H.key('Meta+z'); await H.key('Meta+z'); await H.key('Meta+z'); await H.key('Meta+z');
await show('undo all');
console.log('doc restored:', (await H.doc()) === orig);
await H.close();
