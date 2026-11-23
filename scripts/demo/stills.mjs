import { serve, open, ROOT } from './lib.mjs';
import path from 'node:path';
const out = path.join(ROOT, 'images');
const { server, base } = await serve();
for (const [name, dark] of [['hero', false], ['dark', true]]) {
  const { browser, page, f } = await open(base, { theme: dark ? 'github-dark.css' : 'github-light.css', dark, scale: 2, height: 1500, mermaid: true });
  await f.locator('.cm-line', { hasText: 'Next week we will' }).click({ position: { x: 700, y: 8 } });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, name + '.png') });
  await browser.close();
}
server.close();
