// F3 evidence: wrapped list lines hang under the item's text, in every theme, at a narrow width.
// Usage: node scripts/probe/f3-hanging.mjs   (screenshots go to scripts/probe/out/)
import fs from 'node:fs'; import path from 'node:path';
import { chromium } from 'playwright';
import { serve, chromePath, ROOT } from '../demo/lib.mjs';

const out = path.join(ROOT, 'scripts/probe/out'); fs.mkdirSync(out, { recursive: true });
const themes = ['github-light.css', 'github-dark.css', 'one-dark.css', 'newsprint.css', 'medium.css'];
const { server, base } = await serve();
const browser = await chromium.launch({ executablePath: chromePath() });
let bad = 0;
for (const theme of themes) {
  const page = await browser.newPage({ viewport: { width: 520, height: 1500 } });
  await page.goto(`${base}/scripts/demo/webview.html?theme=${theme}&dark=${/dark/.test(theme) ? 1 : 0}&doc=probe-lists.md`);
  await page.locator('.cm-content').waitFor(); await page.waitForTimeout(700);
  // Measure: for each item line, left edge of its first text char vs left edge of the second visual line.
  const rep = await page.evaluate(() => {
    const v = window.__view; const res = [];
    const lines = [...document.querySelectorAll('.cm-line.lm-li')];
    for (const ln of lines) {
      const rects = [];
      const w = document.createTreeWalker(ln, NodeFilter.SHOW_TEXT); let t;
      while ((t = w.nextNode())) { if (t.parentElement.closest('.lm-bullet,.lm-mbox,.lm-wsbox')) continue; const r = document.createRange(); r.selectNodeContents(t); for (const q of r.getClientRects()) if (q.width > 0) rects.push({ l: q.left, t: q.top }); }
      if (!rects.length) continue;
      const tops = [...new Set(rects.map((r) => Math.round(r.t)))].sort((a, b) => a - b);
      const first = Math.min(...rects.filter((r) => Math.round(r.t) === tops[0]).map((r) => r.l));
      const others = tops.slice(1).map((tp) => Math.min(...rects.filter((r) => Math.round(r.t) === tp).map((r) => r.l)));
      res.push({ text: ln.textContent.slice(0, 28), first: Math.round(first * 10) / 10, wrapped: others.map((x) => Math.round(x * 10) / 10) });
    }
    return res;
  });
  console.log(theme); for (const r of rep) { const ok = r.wrapped.length === 0 || r.wrapped.every((x) => Math.abs(x - r.wrapped[0]) < 0.6); console.log(' ', ok ? 'ok ' : 'BAD', JSON.stringify(r)); if (!ok) bad++; }
  await page.screenshot({ path: path.join(out, `f3-${theme.replace('.css', '')}.png`) });
  // active (caret in a wrapped item) state
  await page.evaluate(() => { const v = window.__view; const i = v.state.doc.toString().indexOf('A nested bullet'); v.dispatch({ selection: { anchor: i + 5 } }); v.focus(); });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, `f3-${theme.replace('.css', '')}-active.png`) });
  await page.close();
}
await browser.close(); server.close();
console.log(bad ? `${bad} misaligned` : 'all aligned');
