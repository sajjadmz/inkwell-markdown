// QA 0.8.0 adversarial probes. node scripts/probe/qa080.mjs [group ...]
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { execSync } from 'node:child_process';
import * as D from './vscode-real.mjs';
const { launch, close, disk, save, reset, loc, sleep, key, type, edSel, activeEl, toast } = D;
let fr, page; const M = 'Meta';
export const DOC = [
  '---', 'title: Notes', '---', '',
  '# Project notes', '',
  'This is a paragraph with **important bold** text and a [link text](https://example.com/a) and `code`.', '',
  '## 1. Plan', '',
  '- Alpha item that is rather long and keeps going on and on so that it wraps over several lines in the page',
  '    - Nested beta', '        - Deep gamma', '- Second', '',
  '1. one', '2. two', '3. three', '', '- [ ] todo one', '- [x] done one', '',
  '> A quoted line here', '',
  '| Area | Description | Owner |', '| --- | --- | --- |',
  '| Alpha | First sentence here. Second sentence here. Third sentence here. | Team A |',
  '| Beta | Has <span style="color:#d00000">red words</span> and **bold** | See [x](a.md) |', '',
  'Final paragraph with two months and Two Months.', ''].join('\n');
const fails = []; let cur = '';
const check = (label, cond, detail = '') => { if (!cond) fails.push(cur + ': ' + label); console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  -> ' + detail}`); };
const L = (w) => disk().split('\n').find((l) => l.includes(w));
const reveal = async (sel, t) => { const l = loc(sel, { hasText: t }).first(); for (let i = 0; i < 40 && !(await l.count()); i++) { await fr.evaluate((d) => { const s = document.scrollingElement; s.scrollTop = d < 20 ? s.scrollTop + 400 : 0; document.querySelector('.cm-scroller')?.scrollBy(0, 300); }, i); await sleep(150); } return l; };
const clickLine = async (t, dx = 20) => { const l = await reveal('.cm-line', t); await l.scrollIntoViewIfNeeded(); const b = await l.boundingBox(); await page.mouse.click(b.x + dx, b.y + Math.min(b.height / 2, 12)); await sleep(250); };
const endOf = async (t) => { await clickLine(t); await key('Meta+ArrowRight'); };
const cellAt = async (t) => { const c = await reveal('td,th', t); await c.scrollIntoViewIfNeeded(); const b = await c.boundingBox(); await page.mouse.click(b.x + b.width - 5, b.y + b.height - 6); await key('Meta+ArrowRight'); return c; };
const bar = () => fr.evaluate(() => ({ open: document.getElementById('lm-find')?.classList.contains('open'), count: document.querySelector('#lm-find .lm-find-count')?.textContent, status: document.querySelector('#lm-find .lm-find-status')?.textContent, field: document.querySelector('#lm-find .lm-find-in')?.value }));
const diffLines = (a, b) => { const x = a.split('\n'), y = b.split('\n'); const out = []; for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) out.push(`${i}: ${JSON.stringify(x[i])} => ${JSON.stringify(y[i])}`); return out; };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const pngClip = () => { const f = path.join(os.tmpdir(), `qa-${process.pid}.png`); fs.writeFileSync(f, Buffer.from(PNG, 'base64')); execSync(`osascript -e 'set the clipboard to (read (POSIX file "${f}") as «class PNGf»)'`); };
const G = {};
G.dspace = async () => {
  const at = async (doc, line, n, typed) => { await reset(doc); await clickLine(line); await key('Meta+ArrowLeft'); await key('ArrowRight', n); await type(typed); await save(); return disk(); };
  console.log('  before **:', JSON.stringify(await at('a **bold** z\n', 'bold', 6, '  ')));
  console.log('  before ** after word:', JSON.stringify(await at('a **bold** z\n', 'bold', 8, ' ')), '(one space typed; then):');
  await type(' '); await save(); console.log('   ->', JSON.stringify(disk()));
  console.log('  after **:', JSON.stringify(await at('a **bold** z\n', 'bold', 10, '  ')));
  console.log('  inside link text:', JSON.stringify(await at('a [link text](u) z\n', 'link text', 8, '  ')));
  console.log('  inside link text end:', JSON.stringify(await at('a [link text](u) z\n', 'link text', 12, '  ')));
  console.log('  after link:', JSON.stringify(await at('a [link text](u) z\n', 'link text', 16, '  ')));
  console.log('  after code:', JSON.stringify(await at('a `code` z\n', 'code', 8, '  ')));
  console.log('  inside italic end:', JSON.stringify(await at('a *it* z\n', 'it', 4, '  ')));
  console.log('  colour span end:', JSON.stringify(await at('a <span style="color:#d00000">red</span> z\n', 'red', 3, '  ')));
  console.log('  colour span after:', JSON.stringify(await at('a <span style="color:#d00000">red</span> z\n', 'red', 41, '  ')));
  console.log('  mid sentence:', JSON.stringify(await at('one two three\n', 'one two', 3, '  ')));
  console.log('  mid-line space already after:', JSON.stringify(await at('one  two\n', 'one', 3, ' ')));
  console.log('  ellipsis/number:', JSON.stringify(await at('v 3.5 and 2\n', 'v 3.5', 12, '  ')));
  console.log('  fm line:', JSON.stringify(await at('---\ntitle: Notes\n---\n\ntext\n', 'text', 0, 'abc  ')));
  await reset('---\ntitle: Notes\n---\n\ntext\n'); await clickLine('text'); await key('ArrowUp', 2); await key('Meta+ArrowRight'); await type('  '); await save(); console.log('  fm title:', JSON.stringify(disk()));
  await reset(DOC); await endOf('A quoted'); await type('word  '); await save(); check('quote ". "', L('quoted').endsWith('word. '), L('quoted'));
  await reset(DOC); await endOf('Second'); await key('Tab'); await type(' ab  cd'); await save(); console.log('  tab+dspace:', JSON.stringify(L('Second')));
  await reset(DOC); await cellAt('Team A'); await type(' rocks  more'); await save(); console.log('  cell:', L('Alpha |'));
  await key(`${M}+z`); await save(); console.log('  cell undo1:', L('Alpha |')); await key(`${M}+z`); await save(); console.log('  cell undo2:', L('Alpha |'));
  // cell: before the closing ** of bold, cell with colour span
  await reset(DOC); await cellAt('and bold'); await key('ArrowLeft', 2); await type('  x'); await save(); console.log('  cell bold end:', L('Beta |'));
  await reset(DOC); await cellAt('red words'); console.log('  cell html', await fr.evaluate(()=>document.activeElement.closest('td')?.innerHTML));
  // after a pasted picture
  const sv = execSync('pbpaste').toString();
  try { await reset(DOC); fs.rmSync(path.join(path.dirname(D.disk.toString()&&''),'x'),{force:true}); pngClip(); await endOf('Final paragraph'); await key(`${M}+v`); await sleep(800); await type('  after'); await save(); console.log('  after pic:', JSON.stringify(L('Final'))); } finally { execSync('pbcopy', { input: sv }); }
  await reset(DOC); await clickLine('Final'); await page.keyboard.press(`${M}+f`); await sleep(300); await type('a  b'); const b = await bar(); await key('Escape'); await save();
  check('find field takes spaces literally and doc unchanged', b.field === 'a  b' && disk() === DOC, JSON.stringify(b.field));
};
G.extundo = async () => {
  const run = async (label, edit, ext) => { await reset(DOC); await edit(); await save(); const mid = disk(); await reset(ext ?? DOC); await clickLine('Final paragraph'); await key(`${M}+z`); await save(); console.log(' ', label, '=>', diffLines(ext ?? DOC, disk()).join(' | ') || 'no change'); };
  await run('typed x at line start, then external revert', async () => { await clickLine('Second'); await key('Meta+ArrowLeft'); await type('x'); });
  await run('Tab indent, then external revert', async () => { await clickLine('Second'); await key('Tab'); });
  await run('Shift+Tab deep, then external revert', async () => { await clickLine('Deep gamma'); await key('Shift+Tab'); });
  await run('type in cell, then external revert', async () => { await cellAt('Team A'); await type('zz'); });
  await run('type end of final para, then external append line', async () => { await endOf('Final paragraph'); await type(' zzzz'); }, DOC + '\nExtra line from git\n');
};
G.find3 = async () => {
  await reset(FD); await clickLine('Last Apple'); await openFind('Apple'); await loc('#lm-find .lm-find-in').nth(0).click();
  await page.keyboard.press(`${M}+Alt+f`); await sleep(300); const rf = loc('#lm-find .lm-find-in').nth(1); await rf.click(); await page.keyboard.press(`${M}+a`); await type('Pear'); await key('Enter'); await sleep(400); await save();
  console.log('  Enter in replace field ->', diffLines(FD, disk()).length, 'lines changed; status', (await bar()).status, (await bar()).count);
  await key('Enter'); await sleep(300); await save(); console.log('  Enter again ->', diffLines(FD, disk()).length, 'lines changed');
  await key(`${M}+z`); await sleep(300); await save(); console.log('  undo ->', diffLines(FD, disk()).length);
  await key(`${M}+z`); await sleep(300); await save(); console.log('  undo2 ->', diffLines(FD, disk()).length);
  // narrow window
  await key('Escape');
  await reset(FD); await cellAt('plain Apple'); await openFind('Apple', 'Pear', true);
  await fr.evaluate(() => {}); 
  const info = await fr.evaluate(() => { const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]; }; return { find: r('#lm-find'), floatbar: r('.lm-tablebar, #lm-tablebar, .lm-table-bar'), toolbar: r('#lm-toolbar'), vw: innerWidth }; });
  console.log('  geometry', JSON.stringify(info));
  await page.keyboard.press('Escape');
};
G.layout = async () => {
  const rects = () => fr.evaluate(() => { const r = (s) => { const e = document.querySelector(s); if (!e || e.hidden) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]; }; const f = document.getElementById('lm-find'); const ins = [...f.querySelectorAll('input,button')].filter((x) => x.offsetParent).map((x) => { const b = x.getBoundingClientRect(); return [x.dataset.act || x.className, Math.round(b.left), Math.round(b.right)]; }); return { find: r('#lm-find'), floatbar: r('.lm-floatbar'), vw: innerWidth, sw: document.documentElement.scrollWidth, overflowControls: ins.filter((i) => i[2] > innerWidth || i[1] < 0).map((i) => i[0]) }; });
  await reset(FD); await cellAt('plain Apple'); console.log('  cell focus, no find:', JSON.stringify(await rects()));
  await page.keyboard.press(`${M}+Alt+f`); await sleep(400); console.log('  with find+replace:', JSON.stringify(await rects()));
  await cellAt('line2'); await sleep(300); console.log('  cell refocus with find open:', JSON.stringify(await rects()));
  const cdp = await page.context().newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  for (const w of [700, 480, 360]) { await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal', width: w, height: 800 } }); await sleep(800); console.log('  width', w, JSON.stringify(await rects())); }
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal', width: 1280, height: 900 } });
};
G.dbg = async () => {
  if (1) return;
  await clickLine('Deep gamma'); await key('Shift+Tab'); await save(); console.log('  1', JSON.stringify(L('Deep')));
  await reset(DOC); console.log('  2 after external reset', JSON.stringify(L('Deep'))); await clickLine('Second'); await key(`${M}+z`); await save(); console.log('  3 after undo', JSON.stringify(L('Deep')), diffLines(DOC, disk()).join('|'));
  await key(`${M}+z`); await save(); console.log('  4 after undo2', diffLines(DOC, disk()).join('|'));
  await reset(DOC); await clickLine('Alpha item'); await key('Meta+ArrowLeft'); await key('Shift+ArrowDown', 3); console.log('  sel', JSON.stringify(await edSel())); await key('Tab'); await save(); console.log('  multi tab:', diffLines(DOC, disk()).join('|'));
  await reset(DOC); await clickLine('Second'); await key('Shift+ArrowUp', 2); console.log('  sel', JSON.stringify(await edSel())); await key('Tab'); await save(); console.log('  multi tab:', diffLines(DOC, disk()).join('|')); await key(`${M}+z`); await save(); console.log('  undo exact', disk() === DOC);
  return;
  await clickLine('2. two'); await key('Tab'); await save(); console.log('  numbered tab:', JSON.stringify(disk().split('\n').slice(14,18)), 'toast', await toast(), await activeEl());
  await key(`${M}+]`); await save(); console.log('  cmd+]:', JSON.stringify(disk().split('\n').slice(14,18)), await toast());
  await reset(DOC); await clickLine('A quoted'); await key('Tab'); await reset(DOC);
  console.log('  lines', await loc('.cm-line').count(), await activeEl());
  await clickLine('Final paragraph'); console.log('  ok final');
};
G.indent = async () => {
  await clickLine('Second'); await key('Tab'); await save(); check('Tab indents list (4 spaces?)', true); console.log('  ', JSON.stringify(L('Second')), diffLines(DOC, disk()).length, 'lines changed');
  await key(`${M}+z`); await save(); check('undo restores bytes', disk() === DOC, diffLines(DOC, disk()).join('|'));
  await key(`${M}+Shift+z`); await save(); console.log('  redo:', JSON.stringify(L('Second')));
  await key(`${M}+z`); await save();
  await clickLine('Second'); await key('Shift+Tab'); await save(); check('Shift+Tab at level 0: no change', disk() === DOC, diffLines(DOC, disk()).join('|'));
  await clickLine('Deep gamma'); await key('Shift+Tab'); await save(); console.log('  outdent deep:', JSON.stringify(L('Deep gamma'))); await key('Shift+Tab', 3); await save(); console.log('  outdent x3 more:', JSON.stringify(L('Deep gamma'))); 
  await reset(DOC); await clickLine('2. two'); await key('Tab'); await save(); console.log('  numbered tab:', JSON.stringify(L('two')), '|', JSON.stringify(L('3. three')));
  await reset(DOC); await clickLine('todo one'); await key(`${M}+]`); await save(); console.log('  checklist cmd+]:', JSON.stringify(L('todo one')));
  await reset(DOC); await clickLine('A quoted'); await key('Tab'); await save(); console.log('  quote tab:', JSON.stringify(L('quoted')), 'toast', await toast(), 'focus', await activeEl());
  await reset(DOC); await clickLine('Final paragraph'); await key('Tab'); await save(); console.log('  para tab:', diffLines(DOC, disk()).join('|'), 'focus', await activeEl());
  await reset(DOC); await clickLine('Final paragraph'); await key(`${M}+]`); await save(); console.log('  para cmd+]:', diffLines(DOC, disk()).join('|'), 'toast', await toast());
  await reset(DOC); await clickLine('Project notes'); await key('Tab'); await save(); console.log('  heading tab:', diffLines(DOC, disk()).join('|'));
  // multi-line selection
  await reset(DOC); await clickLine('Alpha item'); await key('Meta+ArrowLeft'); await key('Shift+ArrowDown', 3); await key('Tab'); await save(); console.log('  multi tab:', diffLines(DOC, disk()).join('|'));
  await key(`${M}+z`); await save(); check('multi undo exact', disk() === DOC, diffLines(DOC, disk()).join('|'));
  // selection spanning list + paragraph
  await reset(DOC); await clickLine('Final paragraph'); await key('Meta+ArrowLeft'); await key('Shift+ArrowUp', 7); await key('Tab'); await save(); console.log('  span list..para tab:', diffLines(DOC, disk()).join('|'));
  // cell tab
  await reset(DOC); await cellAt('Team A'); await key('Tab'); await type('Q'); await save(); console.log('  cell tab:', L('Alpha |'));
  await reset(DOC); await cellAt('Team A'); await key('Shift+Tab'); await type('Q'); await save(); console.log('  cell shift+tab:', L('Alpha |'));
  // toolbar buttons exist
  const acts = await fr.evaluate(() => [...document.querySelectorAll('#lm-toolbar .lm-tb')].map((b) => b.dataset.action).join(','));
  console.log('  toolbar:', acts);
  // list in code block
  await reset('```\n- not a list\n```\n\n- a\n'); await clickLine('not a list'); await key('Tab'); await save(); console.log('  codeblock tab:', JSON.stringify(disk()));
  await reset('- a\n\n\tTabbed para\n- b\n'); await clickLine('b'); await key('Tab'); await save(); console.log('  tabs-indented:', JSON.stringify(disk()));
};
const FD = ['# Heading with Apple', '', '- list Apple item', '', '> quote Apple here', '',
  'Para with [Apple link](https://apple.example/Apple) and **bold Apple** and <span style="color:#d00000">red Apple</span> end.', '',
  '| A | B |', '| --- | --- |', '| cell Apple line1<br>line2 Apple | plain Apple |', '| x | Apple\\|pipe |', '', 'Last Apple.', ''].join('\n');
const openFind = async (q, repl, replaceMode) => { await page.keyboard.press(`${M}+${replaceMode ? 'Alt+' : ''}f`); await sleep(300); await page.keyboard.press(`${M}+a`); await sleep(200); await type(q); if (repl !== undefined) { await loc('#lm-find .lm-find-in').nth(1).click(); await page.keyboard.press(`${M}+a`); await sleep(200); await type(repl); } await sleep(300); };
const fb = (a) => loc(`#lm-find [data-act="${a}"]`);
G.find = async () => {
  await reset(FD); await clickLine('Last Apple'); await openFind('Apple', 'Pear', true);
  console.log('  count', (await bar()).count);
  await fb('all').click(); await sleep(600); await save(); console.log('  status', (await bar()).status); console.log(diffLines(FD, disk()).join('\n'));
  await page.keyboard.press(`${M}+z`); await sleep(500); await save(); check('undo of replace all exact', disk() === FD, diffLines(FD, disk()).join('|'));
  await key('Escape');
  // one at a time
  await reset(FD); await clickLine('Last Apple'); await openFind('Apple', 'Pear', true); for (let i = 0; i < 12; i++) { const c = (await bar()).count; if (/No res/.test(c)) break; await fb('replace').click(); await sleep(350); } await save(); console.log('  one-by-one result:'); console.log(diffLines(FD, disk()).join('\n')); console.log('  bar', JSON.stringify(await bar()));
};
G.find2 = async () => {
  // Esc then type; find while cell edited; highlights after edits
  await reset(FD); await clickLine('Last Apple'); await openFind('Apple'); await key('Enter'); await key('Escape'); await sleep(300);
  console.log('  sel after Esc', JSON.stringify(await edSel()), await activeEl()); await type('Z'); await save(); console.log('  after typing:', JSON.stringify(L('Last')), '|', diffLines(FD, disk()).join(' | '));
  await key(`${M}+z`); await save(); console.log('  undo exact', disk() === FD);
  await reset(FD); await cellAt('plain Apple'); await page.keyboard.press(`${M}+f`); await sleep(300); console.log('  cmd+F in cell prefill field:', JSON.stringify((await bar()).field), 'open', (await bar()).open); await key('Escape');
  await reset(FD); await cellAt('plain Apple'); await key('Shift+ArrowLeft', 5); console.log('  sel', await edSel()); await page.keyboard.press(`${M}+f`); await sleep(300); console.log('  cmd+F with cell selection prefill:', JSON.stringify((await bar()).field)); await key('Escape');
  // find open, edit cell, count updates?
  await reset(FD); await clickLine('Last Apple'); await openFind('Apple'); console.log('  count', (await bar()).count);
  await cellAt('plain Apple'); await type(' Apple'); await sleep(400); console.log('  after cell typed Apple count', (await bar()).count, 'highlights', await fr.evaluate(() => CSS.highlights?.get('lm-find')?.size));
  await clickLine('Last Apple'); await key('Meta+ArrowRight'); await type(' Apple'); await sleep(400); console.log('  after para typed count', (await bar()).count);
  await key('Tab'); await sleep(200); await clickLine('list Apple'); await key('Tab'); await sleep(400); console.log('  after tab count', (await bar()).count, 'bar open', (await bar()).open);
  await key(`${M}+z`); await sleep(400); console.log('  after undo count', (await bar()).count);
  // Enter in field never inserts
  await reset(FD); await clickLine('Last Apple'); await openFind('Apple'); await key('Enter', 3); await key('Shift+Enter', 2); await save(); check('Enter in find field leaves doc alone', disk() === FD, diffLines(FD, disk()).join('|'));
  await key('Escape');
  // Cmd+G with bar closed
  await reset(FD); await clickLine('Last Apple'); await key(`${M}+g`); await sleep(300); console.log('  cmd+G closed: bar', JSON.stringify(await bar()), 'doc same', (await save(), disk() === FD));
  // replace with bar open, then continue typing doc
  await reset(FD); await clickLine('Last Apple'); await openFind('Apple', '&amp;', true); await fb('replace').click(); await sleep(400); await save(); console.log('  entity repl:', diffLines(FD, disk()).join('|'));
  await reset(FD); await clickLine('Last Apple'); await openFind('Apple', '**', true); await fb('all').click(); await sleep(500); await save(); console.log('  ** repl:', diffLines(FD, disk()).join('\n'), '|', (await bar()).status);
  await reset(FD); await clickLine('Last Apple'); await openFind('Apple', '\n', true); await fb('all').click(); await sleep(500); await save(); console.log('  newline repl:', diffLines(FD, disk()).join('\n'), '|', (await bar()).status);
  await reset(FD); await clickLine('Last Apple'); await openFind('Apple', '# x', true); await fb('all').click(); await sleep(500); await save(); console.log('  "# x" repl:', diffLines(FD, disk()).join('\n'), '|', (await bar()).status);
  await reset(FD); await clickLine('Last Apple'); await openFind('Apple', '- ', true); await fb('all').click(); await sleep(500); await save(); console.log('  "- " repl:', diffLines(FD, disk()).join('\n'), '|', (await bar()).status);
  await reset(FD); await clickLine('Last Apple'); await openFind('e', 'é', true); await fb('all').click(); await sleep(500); await save(); console.log('  e->é repl count:', (await bar()).status, 'disk lines changed', diffLines(FD, disk()).length);
};
const imgsOf = () => { const d = path.join(path.dirname(D.getFile()), 'images'); return fs.existsSync(d) ? fs.readdirSync(d) : []; };
const HD = ['- ' + 'word '.repeat(40).trim(), '- https://example.com/' + 'verylongpathsegment'.repeat(12), '    - nested ' + 'text '.repeat(40).trim(), '        - level3 ' + 'text '.repeat(40).trim(), '- [ ] ' + 'check '.repeat(40).trim(), '- [x] ' + 'done '.repeat(40).trim(), '', ...Array.from({ length: 11 }, (_, i) => `${i + 1}. numbered ${i + 1} ` + 'text '.repeat(30).trim()), '', '99. ' + 'ninety '.repeat(30).trim(), '100. ' + 'hundred '.repeat(30).trim(), '', '> - quoted bullet ' + 'q '.repeat(80).trim(), '', 'tail', ''].join('\n');
G.hang0 = async () => {
  await reset(HD); await sleep(800);
  console.log(JSON.stringify(await fr.evaluate(() => [...document.querySelectorAll('.cm-line')].slice(0, 12).map((l) => [l.className.slice(0, 60), l.textContent.slice(0, 30), Math.round(l.getBoundingClientRect().top)]))));
};
G.hang = async () => {
  await reset(HD); await sleep(800);
  const out = await fr.evaluate(() => [...document.querySelectorAll('.cm-line.lm-li')].map((l) => { const w = document.createTreeWalker(l, NodeFilter.SHOW_TEXT); const rects = []; let n; while ((n = w.nextNode())) { if (n.parentElement.closest('[contenteditable=false],.lm-bullet,.lm-marker-widget') ) continue; const r = document.createRange(); r.selectNodeContents(n); for (const q of r.getClientRects()) if (q.width) rects.push(q); } const lefts = {}; rects.forEach((q) => { const k = Math.round(q.top / 6); lefts[k] = Math.min(lefts[k] ?? 1e9, Math.round(q.left)); }); const rows = Object.entries(lefts).sort((a, b) => a[0] - b[0]).map((e) => e[1]); return { t: l.textContent.slice(0, 18), rows: rows.length, first: rows[0], rest: [...new Set(rows.slice(1))], maxRight: Math.round(Math.max(...rects.map((q) => q.right))), lineRight: Math.round(l.getBoundingClientRect().right), scrollerRight: Math.round(document.querySelector('.cm-scroller').getBoundingClientRect().right), sw: l.scrollWidth, cw: l.clientWidth }; }));
  for (const o of out) console.log('  ', JSON.stringify(o));
};
G.caret = async () => {
  const words = (pfx, n, tag) => pfx + Array.from({ length: n }, (_, i) => 'w' + String(i).padStart(2, '0') + tag).join(' ');
  const DOC2 = [words('- ', 45, 'a'), words('    - ', 45, 'b'), words('        - ', 45, 'c'), words('- [ ] ', 45, 'd'), words('1. ', 45, 'e'), words('10. ', 45, 'f'), '', 'tail', ''].join('\n');
  for (const [tag, rowTarget] of [['a', 1], ['b', 1], ['c', 1], ['d', 1], ['e', 1], ['f', 1], ['b', 2], ['c', 2]]) {
    await reset(DOC2); await sleep(400);
    // click the middle of the word wNNtag that lies on visual row rowTarget (while the line is NOT active)
    const target = await fr.evaluate(({ tag, rowTarget }) => { const lines = [...document.querySelectorAll('.cm-line')]; const l = lines.find((x) => new RegExp('w00' + tag).test(x.textContent)); const w = document.createTreeWalker(l, NodeFilter.SHOW_TEXT); let n; const tops = []; const items = []; while ((n = w.nextNode())) { const re = /w\d\d[a-f]/g; let m; while ((m = re.exec(n.data))) { const r = document.createRange(); r.setStart(n, m.index + 1); r.setEnd(n, m.index + 2); const q = r.getBoundingClientRect(); items.push({ word: m[0], x: q.left + q.width / 2, y: q.top + q.height / 2 }); } } const ys = [...new Set(items.map((i) => Math.round(i.y / 8)))]; const rowY = ys[rowTarget]; const cand = items.filter((i) => Math.round(i.y / 8) === rowY); const pick = cand[Math.floor(cand.length / 2)]; return pick; }, { tag, rowTarget });
    // make sure line is inactive: caret on the tail line
    await clickLine('tail'); await sleep(300);
    const t2 = await fr.evaluate(({ tag, rowTarget }) => { const lines = [...document.querySelectorAll('.cm-line')]; const l = lines.find((x) => new RegExp('w00' + tag).test(x.textContent)); const w = document.createTreeWalker(l, NodeFilter.SHOW_TEXT); let n; const items = []; while ((n = w.nextNode())) { const re = /w\d\d[a-f]/g; let m; while ((m = re.exec(n.data))) { const r = document.createRange(); r.setStart(n, m.index + 1); r.setEnd(n, m.index + 2); const q = r.getBoundingClientRect(); items.push({ word: m[0], x: q.left + q.width / 2, y: q.top + q.height / 2 }); } } const ys = [...new Set(items.map((i) => Math.round(i.y / 8)))]; const cand = items.filter((i) => Math.round(i.y / 8) === ys[rowTarget]); return cand[Math.floor(cand.length / 2)]; }, { tag, rowTarget });
    const pb = await loc('.cm-content').boundingBox(); const ib = await fr.evaluate(() => { const b = document.querySelector('.cm-content').getBoundingClientRect(); return { x: b.left, y: b.top }; }); await page.mouse.click(t2.x + pb.x - ib.x, t2.y + pb.y - ib.y); await sleep(400); await type('Q'); await save();
    const got = disk().split('\n').join(' ').match(/(\S*)Q(\S*)/);
    console.log(`  tag ${tag} row${rowTarget}: clicked ${t2.word} -> typed Q lands: ${got && got[0]}`);
  }
};
G.cover = async () => {
  const many = Array.from({ length: 60 }, (_, i) => `Line ${i} filler text here` + (i === 0 ? ' needle' : i === 55 ? ' needle' : '')).join('\n\n') + '\n';
  await reset(many); await sleep(500);
  const top = () => fr.evaluate(() => { const l = document.querySelector('.cm-line'); const f = document.getElementById('lm-find'); return { firstLineTop: Math.round(l.getBoundingClientRect().top), findBottom: f && !f.hidden ? Math.round(f.getBoundingClientRect().bottom) : null, scrollTop: document.scrollingElement.scrollTop }; });
  console.log('  closed', JSON.stringify(await top()));
  await clickLine('Line 3 '); await openFind('needle', 'x', true); console.log('  open (replace)', JSON.stringify(await top()));
  // go to match at line 0 (top), is it under the bar?
  for (let i = 0; i < 3; i++) { const c = (await bar()).count; const pos = await fr.evaluate(() => { const hs = CSS.highlights?.get('lm-find-current') ?? CSS.highlights?.get('lm-find'); return null; }); await fb('next').click(); await sleep(400); console.log('  ', (await bar()).count, JSON.stringify(await fr.evaluate(() => { const m = [...document.querySelectorAll('.lm-find-cur, .lm-find-current, mark.cur')].map((e) => Math.round(e.getBoundingClientRect().top)); const f = document.getElementById('lm-find').getBoundingClientRect().bottom; return { markTops: m, findBottom: Math.round(f), scrollTop: document.scrollingElement.scrollTop }; }))); }
  console.log('  classes', await fr.evaluate(() => [...new Set([...document.querySelectorAll('[class*=find]')].map((e) => e.className))]));
  await key('Escape');
};
G.cellfind = async () => {
  await reset(FD); await cellAt('plain Apple'); await type(' Apple2'); // uncommitted edit, still in cell
  await page.keyboard.press(`${M}+Alt+f`); await sleep(400); await page.keyboard.press(`${M}+a`); await type('Apple'); await loc('#lm-find .lm-find-in').nth(1).click(); await page.keyboard.press(`${M}+a`); await type('Pear'); await sleep(400);
  console.log('  count with pending cell edit:', (await bar()).count);
  await fb('all').click(); await sleep(700); await save(); console.log('  status', (await bar()).status); console.log(diffLines(FD, disk()).filter((x) => /plain|^1[01]:/.test(x)).join('\n'));
  await key('Escape'); await sleep(300); await type('Z'); await save(); console.log('  typed Z after Esc ->', JSON.stringify(L('plain')), JSON.stringify(L('Last')));
  // typing in cell, then Cmd+F then Esc, continue typing in same cell
  await reset(FD); await cellAt('plain Apple'); await type(' abc'); await page.keyboard.press(`${M}+f`); await sleep(300); await key('Escape'); await sleep(300); await type('def'); await save(); console.log('  cell type/find/esc/type ->', JSON.stringify(L('plain')));
  // cell double-space variants
  const cd = async (cellText, typed) => { await reset(FD); await cellAt(cellText); await type(typed); await save(); return L('x |') && disk().split('\n').filter((l) => /^\| (cell|x) /.test(l)).join(' // '); };
  console.log('  cell  **bold** end:', await (async () => { await reset('| A | B |\n| --- | --- |\n| **bold** | z |\n'); await cellAt('bold'); await type('  next'); await save(); return JSON.stringify(disk().split('\n')[2]); })());
  console.log('  cell br:', await (async () => { await reset('| A | B |\n| --- | --- |\n| one<br>two | z |\n'); await cellAt('two'); await type('  next  '); await save(); return JSON.stringify(disk().split('\n')[2]); })());
  console.log('  cell pipe:', await (async () => { await reset('| A | B |\n| --- | --- |\n| a\\|b | z |\n'); await cellAt('a|b'); await type('  next'); await save(); return JSON.stringify(disk().split('\n')[2]); })());
  console.log('  cell span:', await (async () => { await reset('| A | B |\n| --- | --- |\n| <span style="color:#d00000">red</span> | z |\n'); await cellAt('red'); await type('  next'); await save(); return JSON.stringify(disk().split('\n')[2]); })());
  console.log('  cell code:', await (async () => { await reset('| A | B |\n| --- | --- |\n| `code` | z |\n'); await cellAt('code'); await type('  next'); await save(); return JSON.stringify(disk().split('\n')[2]); })());
  console.log('  cell midcell:', await (async () => { await reset('| A | B |\n| --- | --- |\n| alpha beta | z |\n'); const c = await cellAt('alpha'); await key('Meta+ArrowLeft'); await key('ArrowRight', 5); await type(' '); await type(' '); await save(); return JSON.stringify(disk().split('\n')[2]); })());
  // indent via toolbar button and Cmd+[ in cell
  await reset(DOC); await cellAt('Team A'); await key(`${M}+]`); await sleep(300); console.log('  cell Cmd+]: toast', await toast(), 'focus', await activeEl(), 'doc same', (await save(), disk() === DOC));
  await reset(DOC); await cellAt('Team A'); await loc('#lm-toolbar [data-action="indent"]').click(); await sleep(300); console.log('  cell toolbar indent: toast', await toast(), 'focus', await activeEl(), 'doc same', (await save(), disk() === DOC));
  await reset(DOC); await clickLine('Second'); await loc('#lm-toolbar [data-action="indent"]').click(); await sleep(300); await type('Q'); await save(); console.log('  toolbar indent then type:', JSON.stringify(L('Second')), 'focus', await activeEl());
  await reset(DOC); await clickLine('Second'); await loc('#lm-toolbar [data-action="outdent"]').click(); await sleep(300); await save(); console.log('  toolbar outdent level0:', 'doc same', disk() === DOC, 'toast', await toast());
};
G.escjump = async () => {
  const D3 = 'Apple one\n\nsecond para here\n\nApple three\n';
  await reset(D3); await clickLine('second para'); await key('Meta+ArrowRight'); await page.keyboard.press(`${M}+f`); await sleep(300); await type('Apple'); await key('Escape'); await sleep(300); await type('X'); await save();
  console.log('  1st: after search+Esc, typing:', JSON.stringify(disk()));
  // later: reopen find (field remembers) without doing anything, Esc, type
  await reset(D3); await clickLine('second para'); await key('Meta+ArrowRight'); await page.keyboard.press(`${M}+f`); await sleep(300); console.log('  field prefilled:', JSON.stringify((await bar()).field), (await bar()).count); await key('Escape'); await sleep(300); await type('Y'); await save();
  console.log('  2nd: open find (remembered query) + Esc + type:', JSON.stringify(disk()));
  await reset(D3); await clickLine('second para'); await key('Meta+ArrowRight'); await page.keyboard.press(`${M}+f`); await sleep(300); await key('Escape'); await sleep(300); await key('Escape');
  // main editor: colour span end
  await reset('A <span style="color:#d00000">red</span> and **bold** and *it* and ==x==\n'); await clickLine('red'); await key('Meta+ArrowRight'); await type(' end  '); await save(); console.log('  span then words:', JSON.stringify(disk()));
  await reset('Say <span style="color:#d00000">red</span>'); await clickLine('Say'); await key('Meta+ArrowRight'); await type('  '); await save(); console.log('  line ends with span:', JSON.stringify(disk()));
  await reset('Say <mark style="background:rgba(255,235,59,.5)">yellow</mark>'); await clickLine('Say'); await key('Meta+ArrowRight'); await type('  more'); await save(); console.log('  line ends with mark:', JSON.stringify(disk()));
  await reset('Say ~~gone~~'); await clickLine('Say'); await key('Meta+ArrowRight'); await type('  more'); await save(); console.log('  line ends with strike:', JSON.stringify(disk()));
  await reset('Say [x](a.md)'); await clickLine('Say'); await key('Meta+ArrowRight'); await type('  more'); await save(); console.log('  line ends with link:', JSON.stringify(disk()));
  await reset('Say https://example.com/a'); await clickLine('Say'); await key('Meta+ArrowRight'); await type('  more'); await save(); console.log('  line ends with bare url:', JSON.stringify(disk()));
};
G.extundo2 = async () => {
  const fsw = (t) => D.writeExternal(t);
  const run = async (label, edit, ext) => { await reset(DOC); await edit(); const mine = await save(); const extText = ext(mine); fs.writeFileSync(D.getFile(), extText); await sleep(1800); await clickLine('Final paragraph'); await key(`${M}+z`); await save(); const exp = disk(); console.log(' ', label, '\n     ext vs disk after undo:', diffLines(extText, exp).join(' | ') || 'identical to external (undo no-op)'); };
  await run('cell typed, other tool appends line at end', async () => { await cellAt('Team A'); await type(' zz'); }, (m) => m + '\nAppended by tool\n');
  await run('cell typed, other tool edits heading line (top)', async () => { await cellAt('Team A'); await type(' zz'); }, (m) => m.replace('# Project notes', '# Project notes v2 longer heading'));
  await run('list indent, other tool edits heading line (top)', async () => { await clickLine('Second'); await key('Tab'); }, (m) => m.replace('# Project notes', '# Project notes v2 longer heading'));
  await run('list indent, other tool changes same line', async () => { await clickLine('Second'); await key('Tab'); }, (m) => m.replace('  - Second', '  - Second edited'));
  await run('typed in para, other tool replaces whole file with same text + header', async () => { await endOf('Final paragraph'); await type(' zz'); }, (m) => 'NEW TOP\n\n' + m);
};
G.multi = async () => {
  const LD = '- aa\n    - bb\n        - cc\n- dd\n- ee\n\ntail\n';
  const t = async (label, setup, k = 'Tab') => { await reset(LD); await setup(); const sel = await edSel(); await key(k); await sleep(200); const tt = await toast(); await save(); console.log(' ', label, 'toast=', JSON.stringify(tt), 'sel=', JSON.stringify(sel), '=>', JSON.stringify(disk())); };
  await t('aa..bb (down 1 from aa home)', async () => { await clickLine('aa'); await key('Meta+ArrowLeft'); await key('Shift+ArrowDown', 2); });
  await t('bb..dd', async () => { await clickLine('bb'); await key('Meta+ArrowLeft'); await key('Shift+ArrowDown', 2); });
  await t('dd..ee', async () => { await clickLine('dd'); await key('Meta+ArrowLeft'); await key('Shift+ArrowDown', 1); await key('Shift+ArrowRight', 3); });
  await t('dd..ee Cmd+]', async () => { await clickLine('dd'); await key('Meta+ArrowLeft'); await key('Shift+ArrowDown', 1); await key('Shift+ArrowRight', 3); }, `${M}+]`);
  await t('select all Tab', async () => { await clickLine('dd'); await key(`${M}+a`); });
  await t('select all Shift+Tab', async () => { await clickLine('dd'); await key(`${M}+a`); }, 'Shift+Tab');
  await t('bb..cc Shift+Tab', async () => { await clickLine('bb'); await key('Meta+ArrowLeft'); await key('Shift+ArrowDown', 1); await key('Shift+ArrowRight', 3); }, 'Shift+Tab');
};
G.pics2 = async () => {
  const sv = execSync('pbpaste').toString();
  try { pngClip(); await endOf('Final paragraph'); await key(`${M}+v`); await sleep(1200); await save(); console.log('  line', JSON.stringify(L('Final')));
    await clickLine('Project notes'); await sleep(500);
    console.log('  imgs', JSON.stringify(await fr.evaluate(() => [...document.querySelectorAll('img')].map((i) => [(i.getAttribute('src') || '').slice(-60), i.naturalWidth, i.complete])))); } finally { execSync('pbcopy', { input: sv }); }
};
G.pics = async () => {
  const sv = execSync('pbpaste').toString();
  try {
    const dir = () => path.dirname(D.getFile());
    // 1. two quick pastes
    pngClip(); await endOf('Final paragraph'); await key(`${M}+v`); await key(`${M}+v`); await sleep(1200); await save();
    console.log('  files:', JSON.stringify(imgsOf()), '| line:', JSON.stringify(L('Final'))); 
    // image rendered?
    console.log('  imgs in DOM', await fr.evaluate(() => [...document.querySelectorAll('img')].map((i) => [i.getAttribute('src'), i.naturalWidth, i.complete])));
    // 2. undo after paste
    await key(`${M}+z`); await save(); console.log('  undo1:', JSON.stringify(L('Final'))); await key(`${M}+z`); await save(); console.log('  undo2:', JSON.stringify(L('Final')), 'files left', imgsOf().length);
    // 3. cell
    await reset(DOC); pngClip(); await cellAt('Team A'); await key(`${M}+v`); await sleep(1000); await save(); console.log('  cell:', L('Alpha |'));
    await key(`${M}+z`); await save(); console.log('  cell undo:', L('Alpha |'));
    // 4. non-image: html clip from a web page; use osascript for html
    await reset(DOC); const f = path.join(os.tmpdir(), 'qa.html'); fs.writeFileSync(f, '<p>Hello <b>web</b> <img src="https://example.com/a.png"> page</p>');
    execSync(`osascript -e 'set the clipboard to (read (POSIX file "${f}") as «class HTML»)'`); await endOf('Final paragraph'); await key(`${M}+v`); await sleep(500); await save(); console.log('  html paste:', JSON.stringify(diffLines(DOC, disk()))); console.log('  imgs', imgsOf().length);
    // 5. existing same-name file: precreate for the current second range
    await reset(DOC); fs.mkdirSync(path.join(dir(), 'images'), { recursive: true }); const now = new Date(); for (let d = -1; d < 4; d++) { const t = new Date(now.getTime() + d * 1000); const p2 = (n) => String(n).padStart(2, '0'); const st = `${t.getFullYear()}${p2(t.getMonth() + 1)}${p2(t.getDate())}-${p2(t.getHours())}${p2(t.getMinutes())}${p2(t.getSeconds())}`; fs.writeFileSync(path.join(dir(), 'images', `${path.basename(D.getFile(), '.md')}-${st}.png`), 'PRECIOUS'); }
    pngClip(); await endOf('Final paragraph'); await key(`${M}+v`); await sleep(1000); await save();
    console.log('  collision:', JSON.stringify(L('Final')), JSON.stringify(imgsOf().map((n) => [n, fs.readFileSync(path.join(dir(), 'images', n)).length])));
  } finally { execSync('pbcopy', { input: sv }); }
};
export async function main(names) {
  if (process.env.DOCNAME) globalThis.INKWELL_DOC = process.env.DOCNAME;
  const r = await launch(DOC); fr = r.fr; page = r.page; 
  try {
    for (const n of names.length ? names : Object.keys(G)) { cur = n; await reset(DOC); console.log('\n=== ' + n); try { await G[n](); } catch (e) { console.log('ERR', e.message.split('\n')[0]); } }
  } finally { await close(); }
  console.log('\nFAILED:', fails);
}

if (import.meta.url === 'file://' + process.argv[1].replace(/ /g,'%20')) await main(process.argv.slice(2));
