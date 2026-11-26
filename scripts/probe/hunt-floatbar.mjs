// Floating table bar covers the row above the active cell: a real mouse click on that cell hits the bar.
import { start } from './hunt-lib.mjs';
const H = await start();
await H.cell('last cell').click(); await H.wait(300);
const hit = await H.fr.evaluate(() => { const c = [...document.querySelectorAll('td')].find(x => x.textContent.startsWith('code')); const q = c.getBoundingClientRect(); const e = document.elementFromPoint(q.left + q.width/2, q.top + q.height/2); return e.closest('.lm-floatbar') ? 'FLOATBAR covers cell' : e.tagName; });
console.log('element at centre of cell above active:', hit);
await H.close();
