import { serve, open } from '../demo/lib.mjs';
const { server, base } = await serve();
const s = await open(base, { doc: 'probe-fmt.md', theme: 'github-light.css' });
const { page } = s; const fr = page.frames().find((x) => x.url().includes('webview.html'));
const setDoc = (t) => fr.evaluate((t) => { const v = window.__view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t } }); }, t);
const selAll1 = () => fr.evaluate(() => { const v = window.__view; const l = v.state.doc.line(1); v.dispatch({ selection: { anchor: l.from, head: l.to } }); v.focus(); });
const cur = () => fr.evaluate(() => window.__view.state.doc.line(1).text);
for (const [t, k] of [['- ## Third item', 'Meta+b'], ['- Third item', 'Meta+b'], ['## Title', 'Meta+b'], ['> quoted', 'Meta+i'], ['1. num', 'Meta+b'], ['- [ ] task', 'Meta+b'], ['- Third item', 'Meta+Shift+x']]) {
  await setDoc(t + '\n\nafter\n'); await selAll1(); await page.keyboard.press(k); await page.waitForTimeout(150);
  const a = await cur(); await page.keyboard.press(k); await page.waitForTimeout(150);
  console.log(JSON.stringify(t), k, '->', JSON.stringify(a), '-> again', JSON.stringify(await cur()));
}
await s.ctx.close(); await s.browser.close(); server.close();
