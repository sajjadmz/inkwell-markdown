import { serve, open } from '../demo/lib.mjs';
const { server, base } = await serve();
const s = await open(base, { doc: 'probe-fmt.md', theme: 'github-light.css' });
const { page } = s; const fr = page.frames().find((x) => x.url().includes('webview.html'));
const setDoc = (t) => fr.evaluate((t) => { const v = window.__view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t } }); }, t);
const sel = (w, n = 0) => fr.evaluate(([w, n]) => { const v = window.__view; const t = v.state.doc.toString(); let i = -1; for (let k = 0; k <= n; k++) i = t.indexOf(w, i + 1); v.dispatch({ selection: { anchor: i, head: i + w.length } }); v.focus(); }, [w, n]);
const cur = () => fr.evaluate(() => window.__view.state.doc.toString());
const cases = [
  ['**bold *ital* bold**', 'ital', 'Meta+b'],
  ['**bold *ital* bold**', 'bold *it', 'Meta+b'],
  ['*a **b** c*', 'b', 'Meta+i'],
  ['*a **b** c*', 'a **b', 'Meta+b'],
  ['~~x **y** z~~', 'y** z', 'Meta+b'],
  ['<b>one</b> two', 'one</b> two', 'Meta+b'],
];
for (const [t, w, k] of cases) { await setDoc(t); await sel(w); await page.keyboard.press(k); await page.waitForTimeout(150); console.log(JSON.stringify(t), '| sel', JSON.stringify(w), k, '->', JSON.stringify(await cur())); }
await s.ctx.close(); await s.browser.close(); server.close();
