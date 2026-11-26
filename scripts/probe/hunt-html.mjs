import { start } from './hunt-lib.mjs';
const H = await start();
const orig = await H.doc();
const last = async () => (await H.lines()).slice(-2)[0];
// move caret away so the line is rendered
await H.selRange(0,0); await H.wait(300);
const html = await H.fr.evaluate(() => { const l = [...document.querySelectorAll('.cm-line')].find(x => x.textContent.includes('html')); return l ? l.innerHTML : 'none'; });
console.log('rendered line (caret away):', html);
// caret inside it
await H.selectEd('bold html'); await H.wait(300);
console.log('active toolbar when selecting inside <b>:', JSON.stringify(await H.active()));
await H.key('Meta+b'); console.log('Cmd+B in <b>:', JSON.stringify(await last()));
await H.key('Meta+z');
await H.selectEd('ital html'); await H.key('Meta+i'); console.log('Cmd+I in <i>:', JSON.stringify(await last()));
await H.key('Meta+z');
await H.selectEd('under html'); await H.key('Meta+b'); console.log('Cmd+B in <u>:', JSON.stringify(await last()));
await H.key('Meta+z');
// html in table cell
await H.close();
const G = await start('probe-hunt4.md');
const TL = async () => (await G.lines()).filter((l) => l.startsWith('|'));
await G.cell('B1').click(); await G.wait(200);
console.log('cell shows', JSON.stringify(await G.cellText()));
await G.selectCell('B1'); await G.key('Meta+b'); console.log('Cmd+B inside <b>:', JSON.stringify((await TL())[2]));
await G.key('Meta+z'); await G.page.keyboard.press('Escape'); await G.wait(300);
console.log('rendered cell:', await G.f.locator('td').first().innerHTML());
await G.cell('H1').click(); await G.key('ArrowUp'); await G.wait(200);
console.log('ArrowUp from header active:', JSON.stringify(await G.fr.evaluate(() => document.activeElement.tagName + ' ' + window.__view.state.selection.main.head)));
await G.close();
