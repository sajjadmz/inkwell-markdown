import { start } from './hunt-lib.mjs';
const H = await start();
const orig = await H.doc();
const TL = async () => (await H.lines()).filter((l) => l.startsWith('|'));
const show = async (l, n=4) => { const t = await TL(); console.log(l.padEnd(26), JSON.stringify(t[n]), '| sel:', JSON.stringify(await H.cellSel())); await H.check(l); };
await H.cell('last cell').click(); await H.wait(200);
// block actions in cell
for (const a of ['quote','hr','table','codeblock','bullets']) { await H.selectCell('last'); await H.tb(a); await show('toolbar '+a); }
await H.menu('heading','Heading 1'); await show('heading1');
await H.menu('diagram','Flowchart'); await show('diagram'); console.log('doc unchanged outside?', (await H.doc()) === orig || 'DIFF');
await H.key('Meta+z'); await H.key('Meta+z'); console.log('restored?', (await H.doc()) === orig);
// shortcuts
for (const k of ['Alt+Meta+1','Meta+Shift+.','Alt+Meta+c']) { await H.key(k); await show('key '+k); }
console.log('doc:', (await H.doc()) === orig ? 'same' : JSON.stringify((await H.lines()).slice(0,3)));
// colours in cell
await H.selectCell('last'); await H.menu('textcolor-menu','Red'); await show('red');
await H.tb('textcolor'); await show('textcolor again');
await H.menu('highlight-menu','Yellow'); await show('hl');
await H.tb('highlight'); await show('highlight again');
await H.menu('textcolor-menu','No colour'); await show('no text colour');
await H.menu('highlight-menu','No colour'); await show('no hl');
await H.close();
