// Real clicks: heading menu / bullets / numbering while in a cell, then heading menu back in the editor.
import { serve, open } from '../demo/lib.mjs';
const { server, base } = await serve();
const s = await open(base, { doc: 'probe-table.md', theme: 'github-light.css' });
const { page } = s; const f = page.frameLocator('#wv'); const fr = page.frames().find((x) => x.url().includes('webview.html'));
const doc = () => fr.evaluate(() => window.__doc());
const tb = (a) => f.locator(`#lm-toolbar [data-action="${a}"]`);
console.log('toolbar actions:', await fr.evaluate(() => [...document.querySelectorAll('#lm-toolbar [data-action]')].map((b) => b.dataset.action).join(',')));
const cell = f.locator('td', { hasText: 'Start the two' });
await cell.click(); await page.waitForTimeout(200);
await tb('numbered').click(); await page.waitForTimeout(300); console.log('numbered:', (await doc()).split('\n')[5]);
await tb('numbered').click(); await page.waitForTimeout(300); console.log('numbered off:', (await doc()).split('\n')[5]);
await tb('bullets').click(); await page.waitForTimeout(300); console.log('bullets:', (await doc()).split('\n')[5]);
await cell.click(); await page.waitForTimeout(200);
await tb('heading').click().catch((e) => console.log('heading btn?', e.message.slice(0, 80))); await page.waitForTimeout(200);
const items = f.locator('.lm-menu .lm-mi'); console.log('heading menu items:', await items.allTextContents());
await items.nth(1).click().catch(() => {}); await page.waitForTimeout(300);
console.log('toast:', await fr.evaluate(() => document.querySelector('.lm-toast')?.textContent ?? null));
console.log('doc unchanged by heading:', (await doc()).split('\n')[5]);
// back in the editor: heading should work
await f.locator('.cm-line', { hasText: 'Decisions' }).click(); await page.waitForTimeout(200);
await tb('heading').click(); await page.waitForTimeout(200); await f.locator('.lm-menu .lm-mi').nth(3).click(); await page.waitForTimeout(300);
console.log('editor heading after:', (await doc()).split('\n')[0]);
await s.ctx.close(); await s.browser.close(); server.close();
