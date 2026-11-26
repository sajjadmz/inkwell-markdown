// Real keyboard/mouse probes of table cells in the demo harness (trusted events, unlike the VS Code test hooks).
import { serve, open } from '../demo/lib.mjs';
const { server, base } = await serve();
const s = await open(base, { doc: 'table.md', theme: 'github-light.css' });
const { page } = s; const f = page.frameLocator('#wv'); const fr = page.frames().find((x) => x.url().includes('webview.html'));
const doc = () => fr.evaluate(() => window.__doc());
const cell = f.locator('td', { hasText: 'Sign-ups' });
await cell.click(); await page.waitForTimeout(200);
await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.type('x'); await page.waitForTimeout(300);
console.log('after Enter+x:', JSON.stringify((await doc()).split('\n')[6]));
console.log('focused:', await fr.evaluate(() => document.activeElement?.outerHTML.slice(0, 120)));
await s.ctx.close(); await s.browser.close(); server.close();
