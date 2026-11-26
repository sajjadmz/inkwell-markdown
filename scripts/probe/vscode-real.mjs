// Real VS Code driver: launches the downloaded VS Code with this extension, attaches over CDP, and drives the
// Inkwell webview with REAL (trusted) OS-level-equivalent input via the window page's mouse/keyboard.
// Usage: node scripts/probe/vscode-real.mjs [scenario ...]   (no args = all). Ground truth = the file on disk after Cmd+S.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { chromium } from 'playwright';
import { pathToFileURL } from "node:url";
import { ROOT } from '../demo/lib.mjs';

const CODE = path.join(ROOT, '.vscode-test/vscode-darwin-arm64-1.147.0/Visual Studio Code.app/Contents/MacOS/Code');
export const FIXTURE = [
  'Intro paragraph before the list.', '',
  '- First item', '- Second item with `inline code` here', '- Third item', '- Fourth item', '',
  '---', '', '## 1. Overview', '',
  '| Area | Description | Owner | Status |', '| --- | --- | --- | --- |',
  '| Alpha | This is a long cell. It has several sentences in it. Here is another one to wrap the cell onto multiple lines. | Team A | Active |',
  '| Beta | Some **bold words** appear in this long cell. And a second sentence follows it. Then a third sentence too. | See [x](a.md) | Planned |',
  '| Gamma | Another long description with many words that should wrap across lines in the rendered table cell. | Team C | Now |', '',
  'Final normal paragraph after the table.', ''].join('\n');

let proc, tmp, file, page, fr;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const M = process.platform === 'darwin' ? 'Meta' : 'Control';

export async function launch(content = FIXTURE) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-real-'));
  file = path.join(tmp, globalThis.INKWELL_DOC || 'doc.md'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
  fs.mkdirSync(`${tmp}/ud/User`, { recursive: true });
  fs.writeFileSync(`${tmp}/ud/User/settings.json`, JSON.stringify({ 'workbench.editorAssociations': { '*.md': 'inkwell.editor' }, 'chat.disableAIFeatures': true,
    'workbench.startupEditor': 'none', 'window.restoreWindows': 'none', 'update.mode': 'none', 'telemetry.telemetryLevel': 'off' }));
  proc = spawn(CODE, [`--extensionDevelopmentPath=${ROOT}`, `--user-data-dir=${tmp}/ud`, `--extensions-dir=${tmp}/ext`,
    '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--remote-debugging-port=9333', '--new-window', file], { stdio: 'ignore' });
  let browser;
  for (let i = 0; i < 60 && !browser; i++) { await sleep(1000); try { browser = await chromium.connectOverCDP('http://127.0.0.1:9333'); } catch {} }
  if (!browser) throw new Error('could not attach');
  for (let i = 0; i < 60; i++) {
    const pgs = browser.contexts().flatMap((c) => c.pages());
    page = pgs.find((p) => /workbench/.test(p.url())) || pgs[0];
    if (page) { fr = await findFrame(2000); if (fr) break; }
    await sleep(1000);
  }
  if (!fr) throw new Error('webview frame not found');
  await sleep(1000);
  return { page, fr, file };
}
async function findFrame(ms = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (const f of page.frames()) { try { if (await f.evaluate(() => !!document.querySelector('#lm-toolbar') && !!document.querySelector('.cm-content'))) return f; } catch {} }
    await sleep(300);
  }
  return null;
}
export async function close() { try { await page.context().browser().close(); } catch {} try { proc.kill('SIGKILL'); } catch {} try { execSync(`pkill -9 -f "${tmp}" || true`); } catch {} }

export const disk = () => fs.readFileSync(file, 'utf8');
export const save = async () => { await page.keyboard.press(`${M}+s`); await sleep(500); return disk(); };
export const reset = async (content = FIXTURE) => { await page.keyboard.press(`${M}+s`); await sleep(400); fs.writeFileSync(file, content); await sleep(1500); };
export const loc = (sel, opts) => fr.locator(sel, opts);
export const active = () => fr.evaluate(() => [...document.querySelectorAll('#lm-toolbar .lm-tb.active')].map((b) => b.dataset.action));
export const activeEl = () => fr.evaluate(() => { const a = document.activeElement; return a ? a.tagName + '.' + (a.className || '') : null; });
export const toast = () => fr.evaluate(() => document.querySelector('.lm-toast')?.textContent ?? null);
export const cellInfo = () => fr.evaluate(() => { const c = document.activeElement?.closest?.('td,th'); return c ? { text: c.textContent, inner: c.innerText, html: c.innerHTML } : null; });
export async function clickBox(l, where = 'center') {
  const b = await l.boundingBox(); const x = where === 'end' ? b.x + b.width - 3 : where === 'start' ? b.x + 3 : b.x + b.width / 2; const y = b.y + b.height / 2;
  await page.mouse.click(x, y); await sleep(250);
}
export const cellAtEnd = async (txt) => { const c = loc('td,th', { hasText: txt }).last(); await c.scrollIntoViewIfNeeded(); const b = await c.boundingBox(); await page.mouse.click(b.x + b.width - 4, b.y + b.height - 6); await page.keyboard.press('Meta+ArrowRight'); await sleep(250); return c; };
export const clearToast = () => fr.evaluate(() => document.querySelectorAll('.lm-toast').forEach((t) => t.remove()));
export const tb = async (a) => { await clearToast(); await loc(`#lm-toolbar [data-action="${a}"]`).click(); await sleep(250); };
export const menu = async (a, label) => { await tb(a); await loc('.lm-menu .lm-mi', { hasText: label }).first().click(); await sleep(250); };
export const type = async (s) => { await page.keyboard.type(s, { delay: 15 }); await sleep(200); };
export const key = async (k, n = 1) => { for (let i = 0; i < n; i++) await page.keyboard.press(k); await sleep(200); };
export const edSel = () => fr.evaluate(() => { const s = getSelection(); return s.toString(); });
const log = (...a) => console.log(...a);
const lineOf = (t, w) => t.split('\n').filter((l) => l.includes(w));

const gamma = () => disk().split('\n').find((l) => l.includes('Gamma'));
const state = async (label) => { const a = await active(); const ae = await activeEl(); log(`  [${label}] active=${JSON.stringify(a)} focus=${ae} toast=${await toast()}`); };
const clickPara = async (txt) => { const l = loc('.cm-line', { hasText: txt }).first(); await l.scrollIntoViewIfNeeded(); const b = await l.boundingBox(); await page.mouse.click(b.x + 20, b.y + b.height / 2); await sleep(300); };
const clickLineEnd = async (txt) => { await clickPara(txt); await key('Meta+ArrowRight'); };
const nowCell = async () => { const c = loc('td', { hasText: 'Now' }).first(); await c.scrollIntoViewIfNeeded(); const b = await c.boundingBox(); await page.mouse.click(b.x + b.width - 6, b.y + b.height / 2); await key('Meta+ArrowRight'); return c; };
const brCheck = async (label) => { const ci = await cellInfo(); const cell = loc('td', { hasText: /Now/ }).first(); const inner = await cell.innerText(); const tc = await cell.textContent(); log(`  [${label}] focusedCell=${JSON.stringify(ci && ci.text)} html=${JSON.stringify(ci && ci.html)} | innerText=${JSON.stringify(inner)} | visible<br>=${/<br>/i.test(inner) || /<br>/i.test(tc)}`); };
const wc = async (a, c = 'blue') => { await page.mouse.move(0, 0); };

export const scenarios = {
  async trusted() {
    const p = fr.evaluate(() => new Promise((r) => addEventListener('keydown', (e) => r(e.isTrusted), { once: true })));
    await clickPara('Intro'); await page.keyboard.press('Shift'); log('  isTrusted keydown =', await p);
  },
  async cellEnter() {
    await nowCell(); await brCheck('before'); await key('Enter'); await type('next'); await brCheck('after Enter+next focused');
    log('  line count text in cell (rect heights):', await fr.evaluate(() => { const c = document.activeElement.closest('td'); return [c.getBoundingClientRect().height, getComputedStyle(c).lineHeight]; }));
    await save(); log('  disk:', gamma());
    await clickPara('Final normal'); await sleep(300); await brCheck('after click away'); log('  disk:', gamma());
    await reset();
    await nowCell(); await key('Enter', 2); await type('x'); await save(); log('  Enter x2 + x ->', gamma());
    await brCheck('enter2 focused');
    // Backspace over the breaks
    await key('Backspace', 1); await key('Backspace', 1); await save(); log('  after 2 Backspace (removing x then a break) ->', gamma());
    await key('Backspace', 1); await save(); log('  after 3rd Backspace ->', gamma());
    await clickPara('Final normal'); await brCheck('away');
    // Enter at start
    await reset(); const c = await nowCell(); await key('Meta+ArrowLeft'); await key('Enter'); await type('y'); await save(); log('  Enter at start + y ->', gamma()); await brCheck('start focused');
    await clickPara('Final normal'); await brCheck('start away');
    // Enter in middle of long cell
    await reset(); const l = loc('td', { hasText: 'Another long description' }).first(); const b = await l.boundingBox(); await page.mouse.click(b.x + 60, b.y + 12); await key('Enter'); await type('Z'); await save(); log('  Enter mid long cell ->', gamma());
    // undo
    await key(`${M}+z`); await save(); log('  undo ->', gamma()); await key(`${M}+z`); await save(); log('  undo2 ->', gamma());
    await key(`${M}+Shift+z`); await save(); log('  redo ->', gamma());
  },
  async toolbarState() {
    const cells = ['Alpha', 'Team A', 'Now', 'bold words', 'x', 'Planned', 'Description'];
    for (const t of cells) { const c = loc('td,th', { hasText: t }).first(); await c.scrollIntoViewIfNeeded(); const b = await c.boundingBox(); await page.mouse.click(b.x + 10, b.y + b.height / 2); await sleep(300); await state('cell ' + t); }
    await clickPara('Intro paragraph'); await state('paragraph');
    await clickPara('First item'); await state('bullet item 1');
    await clickPara('inline code'); await state('bullet w/ code');
    await clickPara('Overview'); await state('H2 line');
    await clickPara('Final normal'); await state('final paragraph');
    // cell with list line
    await nowCell(); await key('Meta+ArrowLeft'); await type('- '); await state('cell line starting "- "'); await key(`Escape`);
    await clickPara('Intro paragraph'); await state('paragraph after cell');
    await nowCell(); await state('cell after para'); await clickPara('Third item'); await state('bullet after cell');
  },
  async cellToolbar() {
    const acts = ['bullets', 'numbered', 'checklist', 'bold', 'italic', 'strike', 'code', 'codeblock', 'link', 'textcolor', 'highlight', 'quote', 'table', 'hr'];
    for (const a of acts) {
      await reset(); await nowCell(); await key('Meta+Shift+ArrowLeft');
      const before = await activeEl(); await tb(a); const after = await activeEl();
      await sleep(300); const t = await toast(); await save();
      log(`  ${a}: focus ${before} -> ${after}; toast=${JSON.stringify(t)}; line=${gamma()}; selAfter=${JSON.stringify(await edSel())}`);
      await key('Escape');
    }
    for (const [a, l] of [['heading', 'Heading 1'], ['heading', 'Heading 2'], ['heading', 'Heading 3'], ['heading', 'Normal text'], ['diagram', 'Flowchart'], ['codeblock-lang', 'js']]) {
      await reset(); await nowCell(); await key('Meta+Shift+ArrowLeft'); try { await tb(a); const mi = await loc('.lm-menu .lm-mi').allInnerTexts(); await loc('.lm-menu .lm-mi', { hasText: l }).first().click(); await sleep(300); log(`  ${a}>${l}: menu=${mi.length} focus=${await activeEl()} toast=${JSON.stringify(await toast())} line=${(await save(), gamma())} docChanged=${disk() !== FIXTURE}`); } catch (e) { log('  ', a, l, 'ERR', e.message.split('\n')[0]); }
      await key('Escape');
    }
    // colour dropdown items
    for (const a of ['textcolor', 'highlight']) { await reset(); await nowCell(); await key('Meta+Shift+ArrowLeft'); const car = loc(`#lm-toolbar [data-action="${a}"] ~ [data-menu]`).first(); try { await car.click(); const items = await loc('.lm-menu .lm-mi').allInnerTexts(); log('  ' + a + ' menu', items.join('|')); await loc('.lm-menu .lm-mi').nth(1).click(); await sleep(300); await save(); log('   -> ', gamma(), 'focus', await activeEl()); } catch (e) { log('  colour menu ERR', e.message.split('\n')[0]); } }
  },
  async headingText() {
    const H = async (l) => { await menu('heading', l); };
    const line = (w) => disk().split('\n').find((x) => x.includes(w));
    for (const [where, w] of [['paragraph', 'Intro paragraph'], ['bullet', 'Third item'], ['heading', 'Overview']]) {
      await reset(); await clickPara(w); await key('Meta+ArrowLeft');
      for (const l of ['Heading 1', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 3', 'Normal text', 'Normal text']) {
        await H(l); await save();
        log(`  ${where}: ${l} -> ${JSON.stringify(line(w))} sel=${JSON.stringify(await edSel())} focus=${await activeEl()} headingLabel=${await fr.evaluate(() => document.querySelector('.lm-hlabel').textContent)}`);
      }
      // selection survives for second action?
      await reset(); await clickPara(w); await page.keyboard.press('Meta+ArrowLeft'); await page.keyboard.press('Meta+Shift+ArrowRight'); await H('Heading 2'); const s1 = await edSel(); await tb('bold'); await save(); log(`  ${where}: select line, H2 then bold: sel-after-H2=${JSON.stringify(s1)} -> ${JSON.stringify(line(w))}`);
    }
  },
  async colour() {
    const line = () => disk().split('\n').find((x) => x.includes('Intro'));
    const sel = async () => { await clickPara('Intro'); await key('Meta+ArrowLeft'); await key('Shift+ArrowRight', 5); };
    await sel(); await tb('textcolor'); await save(); log('  text colour btn:', line(), 'sel=', JSON.stringify(await edSel()));
    await tb('textcolor'); await save(); log('  again same:', line(), 'sel=', JSON.stringify(await edSel()));
    await tb('highlight'); await save(); log('  highlight on top:', line(), 'sel=', JSON.stringify(await edSel()));
    await tb('highlight'); await save(); log('  highlight again:', line(), 'sel=', JSON.stringify(await edSel()));
    await tb('bold'); await save(); log('  bold stacked:', line(), 'sel=', JSON.stringify(await edSel()));
    // dropdown choose a different colour
    await reset(); await sel(); const items = {};
    for (const a of ['textcolor', 'highlight']) {
      await loc(`#lm-toolbar [data-action="${a}"]`).first().evaluate((b) => b.nextElementSibling && b.nextElementSibling.click());
      await sleep(200); const its = await loc('.lm-menu .lm-mi').allInnerTexts(); items[a] = its; log('  menu', a, its.join('|'));
      if (its.length) { await loc('.lm-menu .lm-mi').nth(2).click(); await sleep(300); await save(); log('   choose #3:', line(), 'sel=', JSON.stringify(await edSel())); }
      if (its.length) { await loc(`#lm-toolbar [data-action="${a}"]`).first().evaluate((b) => b.nextElementSibling.click()); await sleep(200); await loc('.lm-menu .lm-mi').nth(3).click(); await sleep(300); await save(); log('   change to #4:', line(), 'sel=', JSON.stringify(await edSel())); await loc(`#lm-toolbar [data-action="${a}"]`).first().evaluate((b) => b.nextElementSibling.click()); await sleep(200); await loc('.lm-menu .lm-mi', { hasText: /no /i }).first().click().catch(() => {}); await sleep(300); await save(); log('   No colour:', line(), 'sel=', JSON.stringify(await edSel())); }
    }
    await key(`${M}+z`); await save(); log('  undo:', line());
  },
  async shortcuts() {
    const line = (w) => disk().split('\n').find((x) => x.includes(w));
    const K = (mods, k) => `${mods.join('+')}${mods.length ? '+' : ''}${k}`;
    const list = [['bold', ['Meta'], 'b'], ['italic', ['Meta'], 'i'], ['strike', ['Meta', 'Shift'], 'x'], ['link', ['Meta'], 'k'], ['code', ['Meta'], 'e'], ['bullets', ['Meta', 'Shift'], '8'], ['numbered', ['Meta', 'Shift'], '7'],
      ['checklist', ['Meta', 'Shift'], '9'], ['quote', ['Meta', 'Shift'], '.'], ['h1', ['Meta', 'Alt'], '1'], ['h2', ['Meta', 'Alt'], '2'], ['h3', ['Meta', 'Alt'], '3'], ['h0', ['Meta', 'Alt'], '0'],
      ['codeblock', ['Meta', 'Alt'], 'c'], ['highlight', ['Meta', 'Shift'], 'h'], ['textcolor', ['Meta', 'Shift'], 'c']];
    for (const [name, mods, k] of list) {
      await reset(); await clickPara('Intro paragraph'); await key('Meta+ArrowLeft'); await key('Shift+ArrowRight', 5);
      await page.keyboard.press(K(mods, k)); await sleep(500); await save();
      log(`  [text] ${name} (${K(mods, k)}): ${JSON.stringify(line('ntro') || line('Intro'))} focus=${await activeEl()} dialog=${await page.locator('.quick-input-widget:visible, .monaco-dialog-box:visible').count()}`);
      await page.keyboard.press('Escape'); await sleep(200);
    }
    for (const [name, mods, k] of list) {
      await reset(); await nowCell(); await key('Meta+Shift+ArrowLeft'); await page.keyboard.press(K(mods, k)); await sleep(500); await save();
      log(`  [cell] ${name}: ${JSON.stringify(gamma())} toast=${JSON.stringify(await toast())} focus=${await activeEl()}`);
      await page.keyboard.press('Escape'); await sleep(200);
    }
  },
  async floatbar() {
    const rects = () => fr.evaluate(() => { const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]; };
      const sel = getSelection(); const sr = sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0).getBoundingClientRect() : null;
      return { floatbar: document.querySelector('.lm-floatbar:not([hidden])') ? r(document.querySelector('.lm-floatbar')) : null, sel: sr && [Math.round(sr.left), Math.round(sr.top), Math.round(sr.right), Math.round(sr.bottom)], toolbar: r(document.getElementById('lm-toolbar')), hint: r(document.querySelector('.lm-tblhint')), handles: [...document.querySelectorAll('.lm-tblhandle')].map(r) }; });
    const w = loc('.cm-line', { hasText: 'Intro paragraph' }).first(); const b = await w.boundingBox(); await page.mouse.dblclick(b.x + 40, b.y + b.height / 2); await sleep(400); log('  text dblclick:', JSON.stringify(await rects()));
    const c = loc('td', { hasText: 'Now' }).first(); const cb = await c.boundingBox(); await page.mouse.click(cb.x + 8, cb.y + 8); await sleep(400); log('  in cell:', JSON.stringify(await rects()), 'cell', JSON.stringify(cb));
    await page.mouse.dblclick(cb.x + 10, cb.y + 10); await sleep(400); log('  cell word selected:', JSON.stringify(await rects()), await edSel());
  },
  async undoScroll() {
    await clickPara('Intro paragraph'); await key('Meta+ArrowLeft'); await key('Shift+ArrowRight', 5); await tb('bold'); await save(); log('  bold:', disk().split('\n')[0]);
    await key(`${M}+z`); await save(); log('  undo:', disk().split('\n')[0]); await key(`${M}+Shift+z`); await save(); log('  redo:', disk().split('\n')[0]);
  },
};
scenarios.extra = async function () {
  // codeblock in text: shortcut + toolbar
  await clickPara('Intro paragraph'); await key('Meta+ArrowLeft'); await key('Meta+Shift+ArrowRight');
  await page.keyboard.press('Meta+Alt+c'); await sleep(400); await save(); log('  codeblock shortcut (line selected):', JSON.stringify(disk().split('\n').slice(0, 5)));
  await key(`${M}+z`); await tb('codeblock'); await save(); log('  codeblock toolbar:', JSON.stringify(disk().split('\n').slice(0, 5)));
  await reset(); await clickPara('Intro paragraph'); await page.keyboard.press('Meta+Alt+c'); await sleep(400); await save(); log('  codeblock shortcut (caret only):', JSON.stringify(disk().split('\n').slice(0, 5)));
  // bullet -> cell state, then edit in cell
  await reset(); await clickPara('Third item'); await state('bullet'); await nowCell(); await state('cell right after bullet'); await type('q'); await sleep(500); await state('cell after typing');
  await key('Enter'); await type('r'); await sleep(500); await state('cell after Enter (second line)');
  // stacking
  await reset(); await clickPara('Intro'); await key('Meta+ArrowLeft'); await key('Shift+ArrowRight', 5);
  await page.keyboard.press('Meta+Shift+c'); await sleep(250); await page.keyboard.press('Meta+Shift+h'); await sleep(250); await page.keyboard.press('Meta+b'); await sleep(250); await save(); log('  colour+highlight+bold:', disk().split('\n').find((l) => l.includes('Intro')), 'sel=', JSON.stringify(await edSel()));
  await page.keyboard.press('Meta+b'); await sleep(250); await save(); log('  bold again:', disk().split('\n').find((l) => l.includes('Intro')));
  await page.keyboard.press('Meta+Shift+c'); await sleep(250); await save(); log('  colour again:', disk().split('\n').find((l) => l.includes('Intro')));
  // undo/redo in cell
  await reset(); await nowCell(); await type('AB'); await key('Enter'); await type('CD'); await save(); log('  typed:', gamma());
  await page.keyboard.press('Meta+z'); await sleep(300); await save(); log('  undo1:', gamma()); await page.keyboard.press('Meta+z'); await sleep(300); await save(); log('  undo2:', gamma());
  await page.keyboard.press('Meta+Shift+z'); await sleep(300); await save(); log('  redo1:', gamma()); await page.keyboard.press('Meta+Shift+z'); await sleep(300); await save(); log('  redo2:', gamma());
  // undo after toolbar bold in cell
  await reset(); await nowCell(); await key('Meta+Shift+ArrowLeft'); await tb('bold'); await save(); log('  cell bold:', gamma()); await page.keyboard.press('Meta+z'); await sleep(300); await save(); log('  undo:', gamma()); await page.keyboard.press('Meta+Shift+z'); await sleep(300); await save(); log('  redo:', gamma());
  // Cmd+Shift+V toggle exists in VS Code
  await reset(); await clickPara('Intro'); await page.keyboard.press('Meta+Shift+v'); await sleep(1500); log('  Cmd+Shift+V -> editors frames with inkwell:', (await page.frames().length), 'cm?', await page.locator('.monaco-editor').count());
};

// ---------------------------------------------------------------------------------------------------------------
// 0.8.0 scenarios. All input is TRUSTED (CDP Input.dispatchKeyEvent / mouse, i.e. what the OS would deliver); F4 puts a real
// picture on the macOS system clipboard with osascript and presses Cmd+V.
let fails = 0;
const check = (label, cond, detail = '') => { if (!cond) fails++; log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  -> ' + detail}`); };
const diskLine = (w) => disk().split('\n').find((l) => l.includes(w));
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const OUT = path.join(ROOT, 'scripts/probe/out');

scenarios.f1Period = async function () {
  await reset();
  const trusted = fr.evaluate(() => new Promise((r) => addEventListener('keydown', (e) => r(e.isTrusted), { once: true })));
  await clickLineEnd('Third item'); await page.keyboard.press('Shift'); check('keyboard events are trusted', await trusted === true);
  // text, list item, heading
  await clickLineEnd('Third item'); await type('  more'); await save();
  check('list item: "Third item  more" -> "Third item. more"', diskLine('Third item') === '- Third item. more', diskLine('Third item'));
  await reset(); await clickLineEnd('Overview'); await type('  x'); await save();
  check('heading: "Overview  x" -> "Overview. x"', diskLine('Overview') === '## 1. Overview. x', diskLine('Overview'));
  await reset(); await clickLineEnd('Final normal'); await type('  y'); await save();
  check('after a full stop: stays "paragraph after the table.  y"', diskLine('Final normal') === 'Final normal paragraph after the table.  y', diskLine('Final normal'));
  await reset(); await clickLineEnd('Second item'); await key('ArrowLeft', 11); await type('  z'); await save();
  check('inside inline code: no full stop', diskLine('Second item').includes('`inline  z code`') , diskLine('Second item'));
  // Undo: one Cmd+Z gives back the two spaces
  await reset(); await clickLineEnd('Third item'); await type('  '); await save();
  check('typed two spaces -> ". "', diskLine('Third item') === '- Third item. ', JSON.stringify(diskLine('Third item')));
  await key(`${M}+z`); await save();
  check('one Cmd+Z -> two spaces', diskLine('Third item') === '- Third item  ', JSON.stringify(diskLine('Third item')));
  await key(`${M}+z`); await save();
  check('second Cmd+Z -> original', diskLine('Third item') === '- Third item', JSON.stringify(diskLine('Third item')));
  // table cell
  await reset(); await nowCell(); await type('x  q'); await save();
  check('table cell: "Now" + "x  q" -> "Nowx. q"', diskLine('Gamma').includes('| Nowx. q |'), diskLine('Gamma'));
  await key(`${M}+z`); await key(`${M}+z`); await save();
  log('  cell after 2x Cmd+Z:', diskLine('Gamma').slice(-30));
  await reset(); await nowCell(); await type('  '); await save();
  log('  cell "Now" + two spaces (word ends the cell):', diskLine('Gamma').slice(-24));
  // standalone punctuation guard and start of line
  await reset(); await clickPara('Intro paragraph'); await key('Meta+ArrowLeft'); await type('  '); await save();
  check('start of a line: no full stop', disk().split('\n')[0].startsWith('  Intro'), JSON.stringify(disk().split('\n')[0]));
};

scenarios.f2Indent = async function () {
  await reset();
  await clickPara('Second item'); await key('Meta+]'); await save();
  check('Cmd+] indents "Second item"', diskLine('Second item') === '  - Second item with `inline code` here', JSON.stringify(diskLine('Second item')));
  await key('Meta+['); await save();
  check('Cmd+[ outdents it again', diskLine('Second item') === '- Second item with `inline code` here');
  await key('Tab'); await save();
  check('Tab indents a list line', diskLine('Second item').startsWith('  - Second'), diskLine('Second item'));
  await key('Shift+Tab'); await save();
  check('Shift+Tab outdents', diskLine('Second item').startsWith('- Second'), diskLine('Second item'));
  await tb('indent'); await save();
  check('toolbar Increase indent', diskLine('Second item').startsWith('  - Second'), diskLine('Second item'));
  await key(`${M}+z`); await save();
  check('one Cmd+Z undoes one indent', diskLine('Second item').startsWith('- Second'), diskLine('Second item'));
  await tb('outdent'); await save(); check('outdent at the outer level changes nothing', diskLine('Second item').startsWith('- Second'));
  // first item: refused with a note
  await clickPara('First item'); await clearToast(); await key('Meta+]'); await save();
  check('first item: unchanged + note', diskLine('First item') === '- First item' && /can't be indented/.test(await toast() ?? ''), String(await toast()));
  // multi-line selection
  await reset(); await clickPara('Second item'); await key('Shift+ArrowDown', 2); await key('Shift+Meta+ArrowRight'); await key('Meta+]'); await save();
  check('three lines selected: all indent once', ['Second', 'Third', 'Fourth'].every((w) => diskLine(w).startsWith('  - ')) && diskLine('First item') === '- First item', disk().split('\n').slice(2, 7).join('|'));
  await key(`${M}+z`); await save(); check('one Cmd+Z restores all three', disk() === FIXTURE);
  // paragraph / heading: note, no change
  await reset(); await clearToast(); await clickPara('Intro paragraph'); await key('Meta+]'); await save();
  check('paragraph: note, file unchanged', disk() === FIXTURE && /Indent works on bullet and numbered lists/.test(await toast() ?? ''), String(await toast()));
  await clearToast(); await clickPara('Overview'); await tb('indent'); await save();
  check('heading: note, file unchanged', disk() === FIXTURE && /Indent works on bullet/.test(await toast() ?? ''));
  // paragraph: Tab keeps its usual behaviour (no text change)
  await clickPara('Intro paragraph'); await key('Tab'); await save(); check('Tab on a paragraph does not change the file', disk() === FIXTURE);
  // table cell
  await clearToast(); await nowCell(); await key('Meta+]'); await save();
  check('table cell: note, file unchanged', disk() === FIXTURE && /isn't available inside a table cell/.test(await toast() ?? ''), String(await toast()));
  await clearToast(); await tb('indent'); check('table cell via toolbar: note', /isn't available inside a table cell/.test(await toast() ?? ''));
  await save(); check('...and still unchanged', disk() === FIXTURE);
};

const MEASURE = () => {
  const rows = [];
  for (const ln of document.querySelectorAll('.cm-line.lm-li')) {
    const rects = []; const w = document.createTreeWalker(ln, NodeFilter.SHOW_TEXT); let t;
    while ((t = w.nextNode())) { if (t.parentElement.closest('.lm-bullet,.lm-mbox,.lm-wsbox')) continue; const r = document.createRange(); r.selectNodeContents(t); for (const q of r.getClientRects()) if (q.width > 0) rects.push({ l: q.left, t: q.top }); }
    if (!rects.length) continue;
    const tops = [...new Set(rects.map((q) => Math.round(q.t)))].sort((a, b) => a - b); const left = (tp) => Math.min(...rects.filter((q) => Math.round(q.t) === tp).map((q) => q.l));
    rows.push({ text: ln.textContent.slice(0, 22), first: left(tops[0]), wrapped: tops.slice(1).map(left) });
  }
  return rows;
};
scenarios.f3Hanging = async function () {
  const long = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ');
  const doc = [`- ${long}`, `  - ${long}`, `    - ${long}`, '', `1. ${long}`, `   1. ${long}`, '', `10. ${long}`, '', `- [ ] ${long}`, `  - [x] ${long}`, '', 'end', ''].join('\n');
  fs.mkdirSync(OUT, { recursive: true });
  const settings = `${tmp}/ud/User/settings.json`; const base = JSON.parse(fs.readFileSync(settings, 'utf8'));
  for (const theme of ['github-light.css', 'github-dark.css', 'one-dark.css', 'newsprint.css', 'medium.css']) {
    fs.writeFileSync(settings, JSON.stringify({ ...base, 'inkwell.previewTheme': theme })); await sleep(1500);
    await reset(doc); await clickPara('end'); await sleep(500);
    const rows = await fr.evaluate(MEASURE);
    const wrapped = rows.filter((r) => r.wrapped.length);
    const bad = wrapped.filter((r) => r.wrapped.some((w) => Math.abs(w - r.first) > 0.8));
    check(`${theme}: ${wrapped.length} wrapped items hang under their text`, wrapped.length >= 5 && !bad.length, JSON.stringify(bad));
    await page.screenshot({ path: path.join(OUT, `f3-vscode-${theme.replace('.css', '')}.png`) });
  }
  // caret inside a wrapped item, and click mapping on a wrapped line (trusted mouse)
  fs.writeFileSync(settings, JSON.stringify({ ...base, 'inkwell.previewTheme': 'github-light.css' })); await sleep(1500); await reset(doc); await sleep(500);
  const l = loc('.cm-line', { hasText: 'word0 word1' }).nth(1); await l.scrollIntoViewIfNeeded();
  const b = await l.boundingBox(); await page.mouse.click(b.x + b.width * 0.5, b.y + b.height - 10); await sleep(300);
  const caret = await fr.evaluate(() => { const v = document.querySelector('.cm-content').cmView?.view; const s = getSelection(); return { text: s.anchorNode?.textContent?.slice(0, 20) ?? null, off: s.anchorOffset }; });
  log('  click on 3rd visual line of the nested bullet ->', JSON.stringify(caret));
  const rows = await fr.evaluate(MEASURE); const bad2 = rows.filter((r) => r.wrapped.some((w) => Math.abs(w - r.first) > 0.8));
  check('caret inside a wrapped item: still aligned (raw markers shown)', !bad2.length, JSON.stringify(bad2));
  await page.screenshot({ path: path.join(OUT, 'f3-vscode-active.png') });
  fs.writeFileSync(settings, JSON.stringify(base));
};

const clip = {
  png: () => { const f = path.join(os.tmpdir(), `inkwell-clip-${process.pid}.png`); fs.writeFileSync(f, Buffer.from(PNG_B64, 'base64')); execSync(`osascript -e 'set the clipboard to (read (POSIX file "${f}") as «class PNGf»)'`); },
  text: (t) => execSync('pbcopy', { input: t }),
};
const imgs = () => { const d = path.join(path.dirname(file), 'images'); return fs.existsSync(d) ? fs.readdirSync(d) : []; };
scenarios.f4Paste = async function () {
  const saved = (() => { try { return execSync('pbpaste').toString(); } catch { return ''; } })();
  try {
    await reset();
    fs.rmSync(path.join(path.dirname(file), 'images'), { recursive: true, force: true });
    // 1. picture on the clipboard, Cmd+V in a paragraph
    clip.png(); await clickLineEnd('Final normal'); await key(`${M}+v`); await sleep(800); await save();
    const f1 = imgs();
    check('picture pasted: one file images/doc-<date>-<time>.png', f1.length === 1 && /^doc-\d{8}-\d{6}\.png$/.test(f1[0]), JSON.stringify(f1));
    check('file bytes are the PNG', f1.length === 1 && fs.readFileSync(path.join(path.dirname(file), 'images', f1[0])).subarray(0, 8).toString('hex') === '89504e470d0a1a0a');
    check('link inserted at the caret', f1.length === 1 && diskLine('Final normal') === `Final normal paragraph after the table.![](images/${f1[0]})`, diskLine('Final normal'));
    await sleep(500);
    const shown = await fr.evaluate(() => [...document.querySelectorAll('.lm-imgwrap img')].map((i) => ({ ok: i.complete && i.naturalWidth > 0, w: i.getBoundingClientRect().width })));
    check('the picture is displayed immediately', shown.length === 1 && shown[0].ok && shown[0].w > 0, JSON.stringify(shown));
    await key(`${M}+z`); await save();
    check('Cmd+Z removes the link; file stays', !disk().includes('![](images/') && imgs().length === 1);
    // 2. second paste in the same second never overwrites
    clip.png(); await key(`${M}+v`); await sleep(800); clip.png(); await key(`${M}+v`); await sleep(800);
    const f2 = imgs(); check('more pastes: all files distinct (nothing overwritten)', f2.length === 3 && new Set(f2).size === 3, JSON.stringify(f2));
    // 3. picture into a table cell
    await reset(); clip.png(); await nowCell(); await key(`${M}+v`); await sleep(800); await save();
    check('picture pasted in a table cell', /\| Now!?\[\]|\| Now.*!\[\]\(images\/doc-/.test(diskLine('Gamma')), diskLine('Gamma'));
    // 4. text paste unchanged: plain, multi-line, in a cell
    const before = imgs().length;
    await reset(); clip.text('pasted words'); await clickLineEnd('Third item'); await key(`${M}+v`); await save();
    check('plain text paste unchanged', diskLine('Third item') === '- Third itempasted words', diskLine('Third item'));
    await reset(); clip.text('line A\nline B'); await clickLineEnd('Final normal'); await key(`${M}+v`); await save();
    check('multi-line text paste unchanged', disk().includes('after the table.line A\nline B'), JSON.stringify(disk().slice(-60)));
    await reset(); clip.text('cell A\ncell B'); await nowCell(); await key(`${M}+v`); await save();
    check('multi-line text in a cell unchanged (<br>)', diskLine('Gamma').includes('| Nowcell A<br>cell B |'), diskLine('Gamma'));
    check('no pictures saved by text pastes', imgs().length === before);
  } finally { try { clip.text(saved); } catch {} }
};
scenarios.f4Drop = async function (shift = 0) {
  // Drag-and-drop of a file from Finder: dispatched as trusted CDP drag events (Input.dispatchDragEvent).
  await reset(); fs.rmSync(path.join(path.dirname(file), 'images'), { recursive: true, force: true });
  const src = path.join(os.tmpdir(), 'dropme.png'); fs.writeFileSync(src, Buffer.from(PNG_B64, 'base64'));
  const l = loc('.cm-line', { hasText: 'Final normal' }).first(); await l.scrollIntoViewIfNeeded(); const b = await l.boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [], files: [src], dragOperationsMask: 1 };
  const mods = shift ? { modifiers: 8 } : {}; // 8 = Shift
  const x = b.x + 40, y = b.y + b.height / 2;
  try {
    if (shift) await page.keyboard.down('Shift');
    await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data, ...mods }); await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data, ...mods }); await sleep(300); await cdp.send('Input.dispatchDragEvent', { type: 'drop', x, y, data, ...mods });
    if (shift) await page.keyboard.up('Shift');
  } catch (e) { log('  CDP drag not available:', e.message.split('\n')[0]); }
  await sleep(1200); await save();
  log('  images after drop:', JSON.stringify(imgs()), '| line:', diskLine('Final') ?? disk().slice(-120));
  log('  (VS Code itself may take over file drops on a custom editor; this records what really happened)');
};


// ---- F5: Find and Replace ----
const FIND_DOC = ['Intro paragraph with **two** months and two months again.', '', '| Area | Description |', '| --- | --- |', '| Team A | Pays two months |', '| Team B | plain |', '',
  '- First item', '- Second item', '- Third item', '', 'Two Months at the end.', ''].join('\n');
const bar = () => fr.evaluate(() => { const b = document.getElementById('lm-find'); const r = b?.getBoundingClientRect(); const tb = document.getElementById('lm-toolbar').getBoundingClientRect();
  return { open: !!b && !b.hidden && b.classList.contains('open'), count: document.querySelector('#lm-find .lm-find-count')?.textContent ?? '', status: document.querySelector('#lm-find .lm-find-status')?.textContent ?? '',
    replaceRow: !!b && getComputedStyle(b.querySelector('.lm-find-replace')).display !== 'none', field: document.querySelector('#lm-find .lm-find-in')?.value ?? '',
    cellMarks: (window.CSS && CSS.highlights?.get('lm-find')?.size) ?? 0, below: r && Math.abs(r.top - tb.bottom) < 2 }; });
const vsFind = () => page.locator('.find-widget:visible, .simple-find-part:visible, .quick-input-widget:visible').count();
const fieldEl = (n = 0) => loc('#lm-find .lm-find-in').nth(n);
const fbtn = (a) => loc(`#lm-find [data-act="${a}"]`);
/** The search starts from the last position, like Word: step on until the first match is current. */
const toFirst = async () => { for (let i = 0; i < 8 && !/^1 of/.test((await bar()).count); i++) { await fbtn('next').click(); await sleep(150); } };

/** Select all in a field. (The menu's Select All reaches the page a moment after the key; real typing is never this quick.) */
const selAll = async () => { await page.keyboard.press(`${M}+a`); await sleep(250); };
scenarios.f5Find = async function () {
  await reset(FIND_DOC);
  await clickPara('Intro paragraph');
  await page.keyboard.press(`${M}+f`); await sleep(500);
  let b = await bar();
  check('Cmd+F opens the find bar under the toolbar', b.open && b.below, JSON.stringify(b));
  check("VS Code's own find / quick-input widget did not open", await vsFind() === 0);
  check('the Find field has the focus', /lm-find-in/.test(await activeEl() ?? ''), String(await activeEl()));
  await type('two months'); b = await bar();
  check('typing finds the matches as the reader sees them (4, across **bold** and in a table cell)', b.count === '1 of 4', b.count);
  check('matches in table cells are highlighted', b.cellMarks >= 1, String(b.cellMarks));
  await key('Enter'); check('Enter = next', (await bar()).count === '2 of 4', (await bar()).count);
  await key('Shift+Enter'); check('Shift+Enter = previous', (await bar()).count === '1 of 4', (await bar()).count);
  await key('Shift+Enter'); check('Shift+Enter wraps to the last', (await bar()).count === '4 of 4', (await bar()).count);
  await key('Enter'); check('Enter wraps to the first', (await bar()).count === '1 of 4');
  await key(`${M}+g`); check('Cmd+G = next', (await bar()).count === '2 of 4', (await bar()).count);
  await key(`${M}+Shift+g`); check('Cmd+Shift+G = previous', (await bar()).count === '1 of 4', (await bar()).count);
  check('Cmd+G / Cmd+Shift+G opened no VS Code widget and left the document alone', await vsFind() === 0 && (await save(), disk() === FIND_DOC));
  // (F3 / Shift+F3 are the Windows and Linux keys; on a Mac the same actions are Cmd+G / Cmd+Shift+G, and F3 is left to the system.)
  // hover notes carry the shortcuts
  const tips = await fr.evaluate(() => Object.fromEntries([...document.querySelectorAll('#lm-find button')].map((x) => [x.dataset.act, x.dataset.tip])));
  check('every control has a hover note with its shortcut', ['toggle', 'prev', 'next', 'case', 'word', 'replace', 'all', 'close'].every((k) => tips[k]) && /⌘G/.test(tips.next) && /⌘⇧G/.test(tips.prev) && /Esc/.test(tips.close) && /⌘⌥F/.test(tips.toggle), JSON.stringify(tips));
  // options
  await fbtn('case').click(); await sleep(250); b = await bar();
  check('Match case: "Two Months" no longer counts (4 -> 3)', /of 3$/.test(b.count), b.count);
  await fbtn('case').click(); await fbtn('word').click(); await sleep(250); check('Whole words still finds them', /of 4/.test((await bar()).count), (await bar()).count);
  await fbtn('word').click();
  // Esc selects the current match and puts the focus in the page
  await key('Enter'); await key('Escape'); await sleep(300); b = await bar();
  check('Esc closes the bar', !b.open);
  const sel = await edSel();
  check('Esc selects the current match in the editor', /^two months$/i.test(sel.trim()) || /two/.test(sel), JSON.stringify(sel));
  check('focus is back in the editor', /cm-content/.test(await activeEl() ?? ''), String(await activeEl()));
  // pre-fill from a one-line selection
  await clickPara('Third item'); await key('Meta+ArrowLeft'); await key('Shift+ArrowRight', 7); await page.keyboard.press(`${M}+f`); await sleep(400);
  b = await bar(); check('Cmd+F pre-fills the field with the selected word', b.field === 'Third' && b.count === '1 of 1', JSON.stringify(b));
  await key('Escape');
  // a cell match: Esc selects it inside the cell
  await clickPara('Third item'); await page.keyboard.press(`${M}+f`); await sleep(300); await selAll(); await type('Pays two'); await sleep(300);
  check('the match inside the cell is current', (await bar()).count === '1 of 1', (await bar()).count);
  await key('Escape'); await sleep(300);
  check('Esc selects a table-cell match inside the cell', await fr.evaluate(() => getSelection().toString() === 'Pays two' && !!document.activeElement.closest('td')), JSON.stringify(await fr.evaluate(() => [getSelection().toString(), document.activeElement.tagName])));
  // typing in the field never touches the document
  await clickPara('Intro paragraph'); await page.keyboard.press(`${M}+f`); await sleep(300); await type('xyz'); await key(`${M}+b`); await key(`${M}+z`); await key(`${M}+i`); await sleep(300);
  await save(); check('Bold / Undo / Italic pressed in the Find field leave the document alone', disk() === FIND_DOC, JSON.stringify(disk().slice(0, 80)));
  await key('Escape');
  check('no VS Code find widget at any point', await vsFind() === 0);
  // narrow window: the bar stays usable
  await reset(FIND_DOC);
};

scenarios.f5Replace = async function () {
  await sleep(1500); await reset(FIND_DOC); await sleep(800); await clickPara('Intro paragraph');
  await page.keyboard.press(`${M}+Alt+f`); await sleep(500);
  let b = await bar();
  check('Cmd+Alt+F opens Find with the Replace row', b.open && b.replaceRow, JSON.stringify(b));
  await fieldEl(0).click(); await selAll(); await type('Second'); await fieldEl(1).click(); await selAll(); await type('Zweite'); await sleep(300); await fbtn('replace').click(); await sleep(400); await save();
  check('Replace changes the match', diskLine('Zweite') === '- Zweite item' && b.open !== undefined, String(diskLine('Zweite')));
  check('...and the counter shows no more matches', (await bar()).count === 'No results', (await bar()).count);
  // across formatting
  await fieldEl(0).click(); await selAll(); await type('two months'); await fieldEl(1).click(); await selAll(); await type('six weeks'); await sleep(300); await toFirst();
  check('four matches again', (await bar()).count === '1 of 4', (await bar()).count);
  await fbtn('replace').click(); await sleep(400); await save();
  check('across bold: replacement in the first piece, the rest deleted, markers kept', diskLine('Intro') === 'Intro paragraph with **six weeks** and two months again.', String(diskLine('Intro')));
  check('the next match is now current (3 left)', (await bar()).count === '1 of 3', (await bar()).count);
  await fbtn('replace').click(); await sleep(300); await fbtn('replace').click(); await sleep(400); await save();
  check('Replace walks on: the plain one and the one in the table cell', diskLine('Intro') === 'Intro paragraph with **six weeks** and six weeks again.' && diskLine('Team A') === '| Team A | Pays six weeks |', diskLine('Intro') + ' / ' + diskLine('Team A'));
  // a cell, with a pipe
  await fieldEl(0).click(); await selAll(); await type('Team A'); await fieldEl(1).click(); await selAll(); await type('Team|X'); await sleep(300); await toFirst();
  await fbtn('replace').click(); await sleep(400); await save();
  check('in a table cell, a pipe is escaped and the row stays valid', diskLine('Team') === '| Team\\|X | Pays six weeks |', String(diskLine('Team')));
  // replace all in one undo step
  await fieldEl(0).click(); await selAll(); await type('item'); await fieldEl(1).click(); await selAll(); await type('entry'); await sleep(300);
  const before = (await save(), disk());
  await fbtn('all').click(); await sleep(500); await save(); b = await bar();
  check('Replace all replaces every match', ['First', 'Zweite', 'Third'].every((w) => /entry/.test(diskLine(w))) && !/ item/.test(disk()), disk().split('\n').slice(7, 10).join('|'));
  check('the bar says "Replaced 3"', b.status === 'Replaced 3', b.status);
  await page.keyboard.press(`${M}+z`); await sleep(500); await save();
  check('one Undo (focus still in the bar) brings every replacement back', disk() === before, disk().slice(0, 200));
  await page.keyboard.press(`${M}+Shift+z`); await sleep(500); await save();
  check('Redo does it again', /First entry/.test(disk()), '');
  await key('Escape'); await sleep(300);
  await page.keyboard.press(`${M}+z`); await sleep(400); await save();
  check('after Esc, Cmd+Z in the document undoes the same step', disk() === before, disk().slice(0, 120));
  // invalid replacement is skipped, not forced
  await reset('```\ntwo\n```\n\ntwo\n'); await clickPara('two');
  await page.keyboard.press(`${M}+Alt+f`); await sleep(400); await fieldEl(0).click(); await selAll(); await type('two'); await fieldEl(1).click(); await selAll(); await type('```'); await sleep(300); await fbtn('all').click(); await sleep(500); await save();
  check('a replacement that would break the file is skipped and reported', disk() === '```\ntwo\n```\n\n\\`\\`\\`\n' && /skipped 1/.test((await bar()).status), JSON.stringify(disk()) + ' | ' + (await bar()).status);
  await key('Escape');
};


// Lists work like Word (0.8.0): the owner's three reports, on his loose numbered list, checked on the file on disk.
scenarios.lists = async function () {
  const LOOSE = ['# Agents', '', '1. **Five agents** work in parallel on the thing and then more words to make it wrap around the editor width maybe.', '',
    '2. **Every control** is shown here with text that goes on.', '', '3. **Third** one here.', ''].join('\n');
  const atEnd = async (w) => { await clickPara(w); await key('Meta+ArrowRight'); };
  const textStart = async (w, n) => { await clickPara(w); await key('Meta+ArrowLeft'); await key('ArrowRight', n); };
  const diskNow = async () => { await save(); return disk(); };
  const same = async (label, exp) => { const d = await diskNow(); check(label, d === exp, JSON.stringify(d)); };
  // 1. Enter continues the list; Enter on the empty item ends it; Backspace after the marker removes it
  await reset(LOOSE); await atEnd('Every control'); await key('Enter'); await type('Next');
  await same('1 Enter at the end of a numbered item: next number, blank line kept, the rest renumbered', LOOSE.replace('3. **Third**', '3. Next\n\n4. **Third**'));
  await key(`${M}+z`); await key(`${M}+z`); await same('1 two Undos bring the original bytes back', LOOSE);
  await reset(LOOSE); await atEnd('Every control'); await key('Enter'); await key('Enter'); await type('After');
  await same('1 Enter on the empty item ends the list (the numbers go on)', LOOSE.replace('3. **Third**', 'After\n\n3. **Third**'));
  await reset(LOOSE); await atEnd('Every control'); await key('Enter'); await type('2. manual');
  await same('2 (typing the marker yourself is fine too)', LOOSE.replace('3. **Third**', '3. 2. manual\n\n4. **Third**'));
  await reset(LOOSE); await textStart('Every control', 3); await key('Backspace'); await type('Z');
  await same('1 Backspace right after the marker removes it and the text stays; the rest is renumbered', LOOSE.replace('2. **Every', 'Z**Every').replace('3. **Third', '2. **Third'));
  await key('Backspace', 1); await key('Backspace', 1);
  // bullets and checklists
  await reset('- a\n- b\n'); await atEnd('- a'); await key('Enter'); await type('x'); await same('1 bullet', '- a\n- x\n- b\n');
  await reset('- [x] a\n'); await atEnd('a'); await key('Enter'); await type('x'); await same('1 checklist: the new box is empty', '- [x] a\n- [ ] x\n');
  await reset('> a\n'); await atEnd('a'); await key('Enter'); await type('x'); await same('1 quote continues', '> a\n> x\n');
  // 2. typing "2." by hand: the items after it follow
  await reset('1. A\n\n\n\n2. B\n\n3. C\n'); { const l = loc('.cm-line').nth(2); await l.scrollIntoViewIfNeeded(); const bb = await l.boundingBox(); await page.mouse.click(bb.x + 30, bb.y + Math.max(2, bb.height / 2)); await sleep(300); } await type('2. new');
  await same('2 typed "2. " in the middle of a loose list: the following items become 3 and 4', '1. A\n\n2. new\n\n3. B\n\n4. C\n');
  await reset('1. A\n2. B\n3. C\n'); await atEnd('B'); await key('Shift+Home'); await key('Backspace'); await key('Backspace');
  await same('2 deleting a whole item (text, marker, line break) renumbers the rest', '1. A\n2. C\n');
  // 3. the caret after indent
  await reset(LOOSE); await textStart('Every control', 3); await key('Meta+]'); await type('Q');
  await same('3 Cmd+] with the caret at the start of the text: the caret stays in the text', LOOSE.replace('2. **Every', '   1. Q**Every').replace('3. **Third', '2. **Third'));
  await reset(LOOSE); await clickPara('Every control'); await key('Meta+ArrowLeft'); await key('Tab'); await type('Q');
  check('3 Tab with the caret at the start of the line (before the number): it ends in the text', /^   1\. Q\*\*Every/m.test(await diskNow()), JSON.stringify(disk().split('\n')[4]));
  await reset(LOOSE); await atEnd('Every control'); await key('Tab'); await type('Q');
  check('3 Tab with the caret at the end of the line: it stays at the end', /^   1\. \*\*Every control\*\* is shown here with text that goes on\.Q$/m.test(await diskNow()), JSON.stringify(disk().split('\n')[4]));
  await key(`${M}+z`); await key(`${M}+z`); await same('3 Undo twice: exact bytes', LOOSE);
  // Shift+Enter
  await reset(LOOSE); await atEnd('Every control'); await key('Shift+Enter'); await type('more');
  await same('Shift+Enter: a line break inside the same item, indented to its text', LOOSE.replace('goes on.\n', 'goes on.\n   more\n'));
  const xs = await fr.evaluate(() => {
    const first = (l) => { const w = document.createTreeWalker(l, NodeFilter.SHOW_TEXT); let t; while ((t = w.nextNode())) { if (t.parentElement.closest('.lm-mbox,.lm-bullet,.lm-wsbox,.cm-lm-mark')) continue; const m = /\S/.exec(t.data); if (m) { const r = document.createRange(); r.setStart(t, m.index); r.setEnd(t, m.index + 1); return r.getBoundingClientRect().left; } } return null; };
    const lines = [...document.querySelectorAll('.cm-line')];
    const a = lines.find((l) => /Every control/.test(l.textContent)), b = lines.find((l) => l.textContent.trim() === 'more');
    return { item: a && first(a), cont: b && first(b) };
  });
  check('Shift+Enter: the continuation line hangs under the item\'s text (same left edge)', xs.item !== null && xs.cont !== null && Math.abs(xs.item - xs.cont) < 2, JSON.stringify(xs));
  await clickPara('Third'); await sleep(200);
  const xs2 = await fr.evaluate(() => { const lines = [...document.querySelectorAll('.cm-line')]; const a = lines.find((l) => /Every control/.test(l.textContent)), b = lines.find((l) => l.textContent.trim() === 'more'); const x = (l) => { const w = document.createTreeWalker(l, NodeFilter.SHOW_TEXT); let t; while ((t = w.nextNode())) { if (t.parentElement.closest('.lm-mbox,.lm-bullet,.lm-wsbox,.cm-lm-mark')) continue; const m = /\S/.exec(t.data); if (m) { const r = document.createRange(); r.setStart(t, m.index); r.setEnd(t, m.index + 1); return r.getBoundingClientRect().left; } } return null; }; return { item: x(a), cont: x(b) }; });
  check('  ... also when the caret is elsewhere (rendered)', xs2.item !== null && xs2.cont !== null && Math.abs(xs2.item - xs2.cont) < 2, JSON.stringify(xs2));
  // numbers one digit wider
  await reset('8. a\n9. b\n   - c\n10. d\n'); await atEnd('a'); await key('Enter'); await type('x');
  await same('9 to 10: the item that gets a wider number takes its children along', '8. a\n9. x\n10. b\n    - c\n11. d\n');
  // list buttons on items in the middle of a list
  await reset('1. a\n2. b\n3. c\n'); await clickPara('b'); await tb('numbered');
  await same('toolbar Numbers off on a middle item of a tight list: blank lines set it apart, the rest renumbered', '1. a\n\nb\n\n2. c\n');
  await key(`${M}+z`); await same('  ... one Undo gives the exact bytes back', '1. a\n2. b\n3. c\n');
  await reset('1. a\nplain\n2. b\n'); await clickPara('plain'); await tb('numbered');
  await same('toolbar Numbers on a plain line between two items joins and renumbers the list', '1. a\n2. plain\n3. b\n');
  await reset('1. a\n2. b\n3. c\n'); await clickPara('b'); await tb('bullets');
  await same('toolbar Bullets on a numbered item mid-list: the numbers below go on as their own list', '1. a\n- b\n\n2. c\n');
  await reset('1. a\nplain\n3. c\n'); await clickPara('a'); await key('Shift+ArrowDown', 2); await tb('numbered');
  await same('a selection over items and a plain line: all numbered', '1. a\n2. plain\n3. c\n');
  // list in a table cell
  await reset(); await nowCell(); await key('Enter'); await type('- a'); await key('Enter'); await type('b'); await save();
  check('cell: Enter on a "- " line continues the list', /Now<br>- a<br>- b \|$/.test(gamma()), gamma());
  await key('Enter'); await key('Enter'); await type('end'); await save();
  check('cell: Enter on the empty "- " line removes the prefix', /Now<br>- a<br>- b<br>end \|$/.test(gamma()), gamma());
  await reset(); await nowCell(); await key('Enter'); await type('1. a'); await key('Enter'); await type('b'); await key('Enter'); await type('c'); await save();
  check('cell: numbered lines count on', /Now<br>1\. a<br>2\. b<br>3\. c \|$/.test(gamma()), gamma());
  await reset(); await nowCell(); await key('Enter'); await type('☐ a'); await key('Enter'); await type('b'); await save();
  check('cell: "☐ " lines continue', /Now<br>☐ a<br>☐ b \|$/.test(gamma()), gamma());
};

scenarios.f4DropShift = () => scenarios.f4Drop(1);
scenarios.floatbar = scenarios.floatbar;
export async function runAll(names) {
  await launch();
  try {
    for (const n of (names.length ? names : Object.keys(scenarios))) {
      await reset(); log('\n=== ' + n); try { await scenarios[n](); } catch (e) { log('SCENARIO ERROR', n, process.env.DBG ? e.message : e.message.split('\n')[0]); }
    }
  } finally { await close(); }
  if (fails) { console.log(`\n${fails} CHECK(S) FAILED`); process.exitCode = 1; } else console.log('\nall checks passed');
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) await runAll(process.argv.slice(2));
export const getPage = () => page; export const getFr = () => fr;
export const getFile = () => file;
