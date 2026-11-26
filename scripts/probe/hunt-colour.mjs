// Colour stacking: text colour + highlight nesting, then remove / reapply
import { start } from './hunt-lib.mjs';
const H = await start();
const orig = await H.doc();
const TL = async () => (await H.lines()).filter((l) => l.startsWith('|'));
// --- in cell
await H.cell('last cell').click(); await H.wait(200);
await H.selectCell('last');
await H.menu('textcolor-menu','Red'); await H.menu('highlight-menu','Yellow');
console.log('CELL both   ', JSON.stringify((await TL())[4]), 'sel', JSON.stringify(await H.cellSel()));
await H.menu('textcolor-menu','No colour'); console.log('CELL no text colour (expect only <mark>):', JSON.stringify((await TL())[4]));
await H.key('Meta+z'); await H.key('Meta+z'); await H.key('Meta+z'); console.log('restored', (await H.doc())===orig);
await H.selectCell('last');
await H.menu('highlight-menu','Yellow'); await H.menu('textcolor-menu','Red');
console.log('CELL hl then red', JSON.stringify((await TL())[4]));
await H.menu('highlight-menu','No colour'); console.log('CELL no hl (expect only span):', JSON.stringify((await TL())[4]));
await H.menu('textcolor-menu','Blue'); console.log('CELL change colour', JSON.stringify((await TL())[4]));
await H.page.keyboard.press('Escape'); await H.wait(200);
// --- in editor
await H.fr.evaluate((o) => { const v = window.__view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: o } }); }, orig); await H.wait(300);
await H.selectEd('Plain words');
await H.menu('textcolor-menu','Red'); await H.menu('highlight-menu','Yellow'); console.log('ED both', JSON.stringify((await H.lines())[2]));
await H.tb('textcolor'); console.log('ED textcolor btn again (same colour)', JSON.stringify((await H.lines())[2]));
await H.menu('textcolor-menu','No colour'); console.log('ED no text colour', JSON.stringify((await H.lines())[2]));
await H.close();
