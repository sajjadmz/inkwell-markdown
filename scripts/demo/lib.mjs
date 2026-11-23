import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.md': 'text/markdown', '.png': 'image/png', '.svg': 'image/svg+xml' };

export function serve() {
  return new Promise((res) => {
    const s = http.createServer((req, rsp) => {
      const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { rsp.writeHead(404).end(); return; }
      rsp.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' }).end(fs.readFileSync(p));
    }).listen(0, '127.0.0.1', () => res({ server: s, base: `http://127.0.0.1:${s.address().port}` }));
  });
}

export function chromePath() {
  const dir = path.join(process.env.HOME, 'Library/Caches/ms-playwright');
  const h = fs.readdirSync(dir).filter((d) => d.startsWith('chromium_headless_shell-')).sort().pop();
  const base = path.join(dir, h);
  const sub = fs.readdirSync(base).find((d) => d.startsWith('chrome-headless-shell'));
  return path.join(base, sub, 'chrome-headless-shell');
}

export async function open(base, { theme = 'auto', dark = false, video = null, scale = 1, doc = 'notes.md', height = 800, mermaid = false } = {}) {
  const browser = await chromium.launch({ executablePath: chromePath() });
  const ctx = await browser.newContext({ viewport: { width: 1280, height }, deviceScaleFactor: scale,
    ...(video ? { recordVideo: { dir: video, size: { width: 1280, height } } } : {}) });
  const page = await ctx.newPage();
  await page.goto(`${base}/scripts/demo/frame.html?theme=${theme}&dark=${dark ? 1 : 0}&doc=${doc}`);
  const f = page.frameLocator('#wv');
  await f.locator('.cm-content').waitFor();
  if (mermaid) await f.locator('.lm-mermaid svg').first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(500);
  await page.evaluate(() => { const d = document.createElement('div'); d.id = 'fakecursor'; d.style.cssText = 'position:fixed;left:-50px;top:-50px;width:16px;height:16px;z-index:99999;pointer-events:none;background:url("data:image/svg+xml;utf8,<svg xmlns=%27http://www.w3.org/2000/svg%27 width=%2716%27 height=%2724%27><path d=%27M1 1v18l5-4.5 3.5 7.5 2.5-1.2-3.5-7.2H15z%27 fill=%27black%27 stroke=%27white%27 stroke-width=%271.2%27/></svg>") no-repeat;'; document.body.appendChild(d); });
  return { browser, ctx, page, f };
}

export async function moveTo(page, x, y, steps = 18) {
  const cur = (await page.evaluate(() => window.__mx ? [window.__mx, window.__my] : [640, 400]));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t * t * (3 - 2 * t);
    const px = cur[0] + (x - cur[0]) * e, py = cur[1] + (y - cur[1]) * e;
    await page.mouse.move(px, py);
    await page.evaluate(([a, b]) => { window.__mx = a; window.__my = b; const d = document.getElementById('fakecursor'); d.style.left = a + 'px'; d.style.top = b + 'px'; }, [px, py]);
    await page.waitForTimeout(16);
  }
}
export async function center(loc) { const b = await loc.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; }
export async function clickAt(page, x, y, opts = {}) { await moveTo(page, x, y); await page.waitForTimeout(150); await page.mouse.click(x, y, opts); await page.waitForTimeout(500); }
export async function clickLoc(page, loc, opts = {}) { const [x, y] = await center(loc); await clickAt(page, x, y, opts); }
