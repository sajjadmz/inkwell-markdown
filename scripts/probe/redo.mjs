import { serve, open } from '../demo/lib.mjs';
const { server, base } = await serve();
const s = await open(base, { doc: 'probe-table.md', theme: 'github-light.css' });
const { page } = s; const f = page.frameLocator('#wv'); const fr = page.frames().find((x) => x.url().includes('webview.html'));
const doc = () => fr.evaluate(() => window.__doc());
const orig = await doc();
const cell = f.locator('td', { hasText: 'Start the two' });
await cell.click(); await page.waitForTimeout(200);
await fr.evaluate(() => { const c = document.activeElement; const tn = c.firstChild; const r = document.createRange(); r.setStart(tn, 5); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); });
await page.keyboard.press('Enter'); await page.keyboard.type('Z'); await page.waitForTimeout(300);
const edited = await doc(); console.log('edited row:', edited.split('\n')[5]);
for (const k of ['Meta+z', 'Meta+z', 'Meta+Shift+z', 'Meta+Shift+z']) { await page.keyboard.press(k); await page.waitForTimeout(250); const d = await doc(); console.log(k.padEnd(13), d === orig ? 'ORIGINAL' : d === edited ? 'EDITED' : 'OTHER: ' + d.split('\n')[5]); }
await s.ctx.close(); await s.browser.close(); server.close();
