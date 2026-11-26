// Evidence: wrapped lines of a list item inside a quote hang under the item's text, in every theme, narrow width.
// Usage: node scripts/probe/f7-hanging-quote.mjs   (screenshots go to scripts/probe/out/f7-*.png)
import fs from 'node:fs'; import path from 'node:path';
import { chromium } from 'playwright';
import { serve, chromePath, ROOT } from '../demo/lib.mjs';

const out = path.join(ROOT, 'scripts/probe/out'); fs.mkdirSync(out, { recursive: true });
const themes = ['github-light.css', 'github-dark.css', 'one-dark.css', 'newsprint.css', 'medium.css'];
const { server, base } = await serve();
const browser = await chromium.launch({ executablePath: chromePath() });
let bad = 0;
const measure = () => {
  const res = [];
  for (const ln of document.querySelectorAll('.cm-line.lm-li')) {
    const rects = [];
    const w = document.createTreeWalker(ln, NodeFilter.SHOW_TEXT); let t;
    while ((t = w.nextNode())) { if (t.parentElement.closest('.lm-bullet,.lm-mbox,.lm-wsbox,.cm-lm-mark')) continue; const r = document.createRange(); r.selectNodeContents(t); for (const q of r.getClientRects()) if (q.width > 0) rects.push({ l: q.left, t: q.top }); }
    if (!rects.length) continue;
    const tops = [...new Set(rects.map((r) => Math.round(r.t)))].sort((a, b) => a - b);
    const first = Math.min(...rects.filter((r) => Math.round(r.t) === tops[0]).map((r) => r.l));
    const others = tops.slice(1).map((tp) => Math.min(...rects.filter((r) => Math.round(r.t) === tp).map((r) => r.l)));
    res.push({ text: ln.textContent.slice(0, 28), first: Math.round(first * 10) / 10, wrapped: others.map((x) => Math.round(x * 10) / 10) });
  }
  return res;
};
for (const theme of themes) {
  const page = await browser.newPage({ viewport: { width: 520, height: 1500 } });
  await page.goto(`${base}/scripts/demo/webview.html?theme=${theme}&dark=${/dark/.test(theme) ? 1 : 0}&doc=probe-quote-lists.md`);
  await page.locator('.cm-content').waitFor(); await page.waitForTimeout(700);
  for (const state of ['', '-active']) {
    if (state) { await page.evaluate(() => { const v = window.__view; const i = v.state.doc.toString().indexOf('A quoted bullet'); v.dispatch({ selection: { anchor: i + 5 } }); v.focus(); }); await page.waitForTimeout(300); }
    const rep = await page.evaluate(measure);
    console.log(theme + state);
    for (const r of rep) { const ok = r.wrapped.length === 0 || r.wrapped.every((x) => Math.abs(x - r.wrapped[0]) < 0.6 && Math.abs(x - r.first) < 14 && x > r.first - 0.6); console.log(' ', ok ? 'ok ' : 'BAD', JSON.stringify(r)); if (!ok && !state) bad++; }
    await page.screenshot({ path: path.join(out, `f7-${theme.replace('.css', '')}${state}.png`) });
  }
  await page.close();
}
await browser.close(); server.close();
console.log(bad ? `${bad} misaligned` : 'all aligned');
