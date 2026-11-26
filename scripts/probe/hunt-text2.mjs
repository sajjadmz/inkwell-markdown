import { start } from './hunt-lib.mjs';
const H = await start();
const L = async () => (await H.lines());
const orig = await H.doc();
const d = orig; const k1 = d.indexOf('plain line'), k2 = d.indexOf('Third line')+5;
await H.selRange(k1,k2);
await H.key('Meta+b'); console.log('2-line bold   ', JSON.stringify((await L()).slice(4,6)));
await H.key('Meta+b'); console.log('2-line bold again (expect off)', JSON.stringify((await L()).slice(4,6)));
await H.key('Meta+z'); await H.key('Meta+z'); console.log('undo x2 restored?', (await H.doc()) === orig);
// stack bold+italic multi-line then undo each
await H.selRange(k1,k2); await H.key('Meta+b'); await H.key('Meta+i'); console.log('b+i', JSON.stringify((await L()).slice(4,6)));
await H.key('Meta+z'); console.log('undo i', JSON.stringify((await L()).slice(4,6))); await H.key('Meta+z'); console.log('undo b', (await H.doc())===orig);
// mixed selection: plain + italic
await H.selectEd('Plain words and **bold words** and *italic words*'); await H.key('Meta+i'); console.log('mixed italic', JSON.stringify((await L())[2]));
await H.key('Meta+z');
await H.selectEd('Plain words and **bold words** and *italic words*'); await H.key('Meta+b'); console.log('mixed bold', JSON.stringify((await L())[2]), JSON.stringify(await H.edSel()));
await H.key('Meta+z');
// whole line bold then italic then toolbar
await H.selectEd('bold words'); await H.tb('bold'); console.log('toolbar bold on bold (off)', JSON.stringify((await L())[2]));
await H.tb('italic'); console.log('toolbar italic', JSON.stringify((await L())[2]), JSON.stringify(await H.edSel()));
await H.tb('strike'); await H.tb('code'); console.log('strike+code', JSON.stringify((await L())[2]), JSON.stringify(await H.edSel()));
await H.tb('code'); await H.tb('strike'); console.log('off', JSON.stringify((await L())[2]));
await H.tb('link'); console.log('link', JSON.stringify((await L())[2]), JSON.stringify(await H.edSel()));
await H.tb('link'); console.log('link again', JSON.stringify((await L())[2]), JSON.stringify(await H.edSel()));
await H.key('Meta+z'); await H.key('Meta+z');
await H.menu('textcolor-menu','Red'); console.log('red', JSON.stringify((await L())[2]), JSON.stringify(await H.edSel()));
await H.menu('highlight-menu','Yellow'); console.log('hl', JSON.stringify((await L())[2]), JSON.stringify(await H.edSel()));
await H.tb('textcolor'); console.log('textcolor btn again', JSON.stringify((await L())[2]));
await H.menu('textcolor-menu','No colour'); console.log('no colour', JSON.stringify((await L())[2]));
await H.menu('highlight-menu','No colour'); console.log('no hl', JSON.stringify((await L())[2]));
// toolbar active state
const act = async (l) => console.log('ACTIVE', l, JSON.stringify(await H.active()));
await H.selRange(orig.indexOf('bold words')+3, orig.indexOf('bold words')+3); await H.wait(300); await act('caret in bold');
await H.selRange(orig.indexOf('italic words')+3, orig.indexOf('italic words')+3); await H.wait(300); await act('caret in italic');
await H.close();
