import { serve, open, ROOT, moveTo, center, clickAt, clickLoc } from './lib.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const out = path.join(ROOT, 'images');
const tmp = process.env.DEMO_TMP || '/tmp/inkwell-demo';
fs.mkdirSync(tmp, { recursive: true });
const only = process.argv[2];
const { server, base } = await serve();

async function wordPos(page, f, lineText, word) {
  const r = await f.locator('body').evaluate((_, [lt, w]) => {
    const lines = [...document.querySelectorAll('.cm-line')].filter((l) => l.textContent.includes(lt));
    for (const l of lines) {
      const tw = document.createTreeWalker(l, NodeFilter.SHOW_TEXT);
      let n; while ((n = tw.nextNode())) { const i = n.data.indexOf(w); if (i >= 0) { const g = document.createRange(); g.setStart(n, i); g.setEnd(n, i + w.length); const b = g.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; } }
    }
    return null;
  }, [lineText, word]);
  if (!r) throw new Error('word not found ' + word);
  const fb = await page.locator('#wv').boundingBox();
  return [fb.x + r[0], fb.y + r[1]];
}
const clickWord = async (page, f, line, word, o = {}) => { const [x, y] = await wordPos(page, f, line, word); await clickAt(page, x, y, o); };

async function record(name, opts, scene) {
  if (only && only !== name) return;
  const dir = path.join(tmp, name); fs.rmSync(dir, { recursive: true, force: true });
  const t0 = Date.now();
  const s = await open(base, { ...opts, video: dir });
  const lead = (Date.now() - t0) / 1000;
  await s.page.waitForTimeout(600);
  await scene(s);
  await s.page.waitForTimeout(900);
  await s.ctx.close(); await s.browser.close();
  const webm = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.webm')));
  const pal = path.join(dir, 'pal.png'); const gif = path.join(out, `gif-${name}.gif`);
  const ss = String(Math.max(0, lead - 0.1).toFixed(2));
  const vf = 'fps=12,scale=900:-1:flags=lanczos';
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-ss', ss, '-i', webm, '-vf', `${vf},palettegen=stats_mode=diff`, pal]);
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-ss', ss, '-i', webm, '-i', pal, '-lavfi', `${vf} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, gif]);
  // QA frames: one in the middle and one near the end
  for (const [i, frac] of [[1, 0.35], [2, 0.97]]) {
    const dur = parseFloat(execFileSync('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', gif]).toString());
    execFileSync(FFMPEG, ['-v', 'error', '-y', '-ss', String((dur * frac).toFixed(2)), '-i', gif, '-frames:v', '1', path.join(tmp, `${name}-${i}.png`)]);
  }
  console.log(name, (fs.statSync(gif).size / 1024).toFixed(0) + ' KB');
}

await record('live-preview', {}, async ({ page, f }) => {
  const P = 'Next week we will';
  await clickWord(page, f, P, 'pricing'); await page.waitForTimeout(900);
  await clickWord(page, f, 'Weekly product notes', 'product'); await page.waitForTimeout(1800);
  await clickWord(page, f, 'Quick summary', 'onboarding'); await page.waitForTimeout(1800);
  await clickWord(page, f, 'Quick summary', 'encouraging'); await page.waitForTimeout(1500);
  await clickWord(page, f, P, 'pricing'); await page.waitForTimeout(1500);
});

await record('toolbar', {}, async ({ page, f }) => {
  const [x, y] = await wordPos(page, f, 'Next week we will', 'pricing');
  await moveTo(page, x, y); await page.mouse.click(x, y, { clickCount: 3 }); await page.waitForTimeout(900);
  await clickLoc(page, f.locator('[data-action=bold]')); await page.waitForTimeout(900);
  await clickLoc(page, f.locator('[data-action=textcolor-menu]')); await page.waitForTimeout(600);
  await clickLoc(page, f.locator('.lm-mi', { hasText: 'Red' })); await page.waitForTimeout(1000);
  await clickLoc(page, f.locator('[data-action=highlight]')); await page.waitForTimeout(1200);
  const [a, b] = await wordPos(page, f, 'Details below', 'Tuesday'); await clickAt(page, a, b); await page.waitForTimeout(1500);
});

await record('table', { doc: 'table.md' }, async ({ page, f }) => {
  await clickLoc(page, f.locator('td', { hasText: /^44$/ })); await page.waitForTimeout(900);
  await page.keyboard.press('End');
  await page.keyboard.type(' (-23%)', { delay: 90 }); await page.waitForTimeout(800);
  await clickLoc(page, f.locator('.lm-fb[data-op=rowBelow]')); await page.waitForTimeout(1000);
  await clickLoc(page, f.locator('td', { hasText: '(-23%)' })); await page.waitForTimeout(700);
  await clickLoc(page, f.locator('.lm-fb[data-op=colRight]')); await page.waitForTimeout(1500);
});

await record('mermaid', { doc: 'mermaid.md', mermaid: false }, async ({ page, f }) => {
  const [x, y] = await wordPos(page, f, 'Sketch the flow', 'tweak');
  await clickAt(page, x + 150, y);
  await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  await clickLoc(page, f.locator('[data-action=diagram]')); await page.waitForTimeout(700);
  await clickLoc(page, f.locator('.lm-mi', { hasText: 'Flowchart' }));
  await f.locator('.lm-mermaid svg').first().waitFor(); await page.waitForTimeout(1500);
  await clickWord(page, f, 'A[Start]', 'Start', { clickCount: 2 }); await page.waitForTimeout(800);
  await page.keyboard.type('Kick-off', { delay: 120 }); await page.waitForTimeout(1500);
  await clickWord(page, f, 'C[Great]', 'Great', { clickCount: 2 }); await page.waitForTimeout(600);
  await page.keyboard.type('Ship it', { delay: 120 }); await page.waitForTimeout(1800);
});
server.close();
