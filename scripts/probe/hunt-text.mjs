import { start } from './hunt-lib.mjs';
const H = await start();
const L = async () => (await H.lines());
const show = async (label) => console.log(label.padEnd(28), JSON.stringify((await L())[2]), '| sel:', JSON.stringify(await H.edSel()));
// 1. bold plain word, toggle off, selection kept
await H.selectEd('Plain words'); await show('start');
await H.key('Meta+b'); await show('bold');
await H.key('Meta+i'); await show('+italic');
await H.key('Meta+b'); await show('bold off');
await H.key('Meta+i'); await show('italic off');
await H.key('Meta+z'); await show('undo1'); await H.key('Meta+z'); await show('undo2'); await H.key('Meta+z'); await show('undo3');
await H.key('Meta+Shift+z'); await show('redo');
// strike, code, link
await H.selectEd('Plain'); 
for (const [k,n] of [['Meta+Shift+x','strike'],['Meta+e','code']]) { await H.key(k); await show(n); await H.key(k); await show(n+' off'); }
// partial overlap with existing bold
await H.selectEd('and **bold'); await H.selRange((await H.doc()).indexOf('and **bold'), (await H.doc()).indexOf('and **bold')+'and **bo'.length);
await H.key('Meta+b'); await show('overlap bold (and **bo)');
await H.key('Meta+z'); await show('undo');
// cursor in word, empty selection
const d = await H.doc(); const i = d.indexOf('bold words'); await H.selRange(i+2,i+2);
await H.key('Meta+b'); await show('empty sel in bold word'); await H.key('Meta+z');
const j = d.indexOf('Second plain'); await H.selRange(j+3,j+3); await H.key('Meta+b'); console.log('empty in plain:', JSON.stringify((await L())[4])); await H.key('Meta+z');
// two-line span
const k1 = d.indexOf('plain line'), k2 = d.indexOf('Third line')+5;
await H.selRange(k1,k2);
for (const k of ['Meta+b','Meta+i','Meta+Shift+x','Meta+e']) { await H.key(k); console.log('2-line', k, JSON.stringify((await L()).slice(4,6)), JSON.stringify(await H.edSel())); await H.key('Meta+z'); }
await H.selRange(k1,k2); await H.key('Meta+Shift+8'); console.log('2-line bullets', JSON.stringify((await L()).slice(4,6)));
await H.key('Meta+Shift+8'); console.log('2-line bullets off', JSON.stringify((await L()).slice(4,6)));
await H.key('Meta+Shift+7'); console.log('numbered', JSON.stringify((await L()).slice(4,6)));
await H.key('Meta+Shift+9'); console.log('check', JSON.stringify((await L()).slice(4,6)));
await H.key('Meta+Shift+.'); console.log('quote', JSON.stringify((await L()).slice(4,6)));
await H.key('Meta+Shift+.'); console.log('quote off', JSON.stringify((await L()).slice(4,6)));
await H.close();
