import { start } from './hunt-lib.mjs';
const H = await start();
const orig = await H.doc();
const act = async (l) => console.log('ACTIVE', l.padEnd(28), JSON.stringify(await H.active()));
let i = orig.indexOf('bold words')+3; await H.selRange(i,i); await H.wait(300); await act('editor caret in bold');
i = orig.indexOf('italic words')+3; await H.selRange(i,i); await H.wait(300); await act('editor caret in italic');
i = orig.indexOf('Second')+3; await H.selRange(i,i); await H.wait(300); await act('editor caret plain');
// in cell: bold cell
await H.close();
const G = await start('probe-hunt2.md');
await G.cell('bold cell').click(); await G.wait(300);
await G.caretCell(5); await G.wait(300);
console.log('cell text', JSON.stringify(await G.cellText()));
console.log('ACTIVE caret in **bold** in cell', JSON.stringify(await G.active()));
await G.caretCell(25); await G.wait(300);
console.log('ACTIVE caret in *it* in cell', JSON.stringify(await G.active()));
await G.close();
