import { serve, open } from '../demo/lib.mjs';
const { server, base } = await serve();
const s = await open(base, { doc: 'probe-fmt.md', theme: 'github-light.css' });
const { page } = s; const fr = page.frames().find((x) => x.url().includes('webview.html'));
await fr.evaluate(() => { const v = window.__view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: 'top\n\n- one\n- # Big item\n- three\n\nend\n' }, selection: { anchor: 0 } }); });
await page.waitForTimeout(300);
console.log(await fr.evaluate(() => [...document.querySelectorAll('.cm-line')].map((l) => l.className.replace('cm-line', '').trim() + ' | ' + l.textContent + ' | ' + getComputedStyle(l).fontSize).join('\n')));
await page.screenshot({ path: process.argv[2], clip: { x: 0, y: 0, width: 700, height: 300 } });
await s.ctx.close(); await s.browser.close(); server.close();
