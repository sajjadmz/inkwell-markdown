import { start } from './hunt-lib.mjs';
const H = await start('probe-hunt3.md');
const orig = await H.doc();
const TL = async () => (await H.lines()).filter((l) => l.startsWith('|'));
const show = async (l, n=2) => { console.log(l.padEnd(30), JSON.stringify((await TL())[n]), '| sel:', JSON.stringify(await H.cellSel())); await H.check(l); };
await H.cell('plain').click(); await H.wait(200);
// mixed selection: plain+bold
await H.selectCell('plain **bold**'); await H.key('Meta+b'); await show('mixed plain+bold -> Cmd+B');
await H.key('Meta+z');
await H.selectCell('plain **bold** and *ital*'); await H.key('Meta+i'); await show('mixed -> Cmd+I');
await H.key('Meta+z');
// partial overlap selection "in **bo"
await H.selectCell('in **bo'); 
const t = await H.cellText(); await H.fr.evaluate(() => { const c = document.activeElement; const tn = c.firstChild; const i = tn.data.indexOf('plain **bo'); const r = document.createRange(); r.setStart(tn, i + 6); r.setEnd(tn, i + 10); getSelection().removeAllRanges(); getSelection().addRange(r); });
console.log('sel', JSON.stringify(await H.cellSel())); await H.key('Meta+b'); await show('partial overlap Cmd+B');
await H.key('Meta+z');
// cursor inside bold word, empty selection
await H.caretCell(t.indexOf('bold')+2); await H.key('Meta+b'); await show('caret in bold Cmd+B');
await H.key('Meta+z');
await H.caretCell(2); await H.key('Meta+b'); await show('caret in plain Cmd+B');
await H.key('Meta+z');
// click on another cell, then format
await H.cell('second').click(); await H.wait(200); await H.selectCell('second'); await H.key('Meta+b'); await show('other cell bold', 2);
await H.cell('plain').first().click(); await H.wait(200); await H.selectCell('plain'); await H.tb('italic'); await show('back to first via toolbar ital');
await H.tb('bold'); await show('stack bold via toolbar');
await H.key('Meta+z'); await show('undo'); await H.key('Meta+z'); await show('undo');
// arrow out of table
await H.cell('x').click(); await H.key('ArrowUp'); await H.key('ArrowUp'); await H.key('ArrowUp');
console.log('after ArrowUp x3 active:', JSON.stringify(await H.fr.evaluate(() => document.activeElement.tagName + ':' + document.activeElement.textContent.slice(0,10))));
await H.cell('y').click(); await H.key('ArrowDown'); await H.key('ArrowDown');
console.log('after ArrowDown active:', JSON.stringify(await H.fr.evaluate(() => document.activeElement.tagName + ':' + document.activeElement.textContent.slice(0,10) + ' edsel=' + window.__view.state.selection.main.head)));
// bold in editor after leaving table
await H.selectEd('After'); await H.key('Meta+b'); console.log((await H.lines()).slice(-2));
console.log('final table intact', JSON.stringify(await TL()));
await H.close();
