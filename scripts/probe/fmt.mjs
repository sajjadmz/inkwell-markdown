import { serve, open } from '../demo/lib.mjs';
const { server, base } = await serve();
const s = await open(base, { doc: 'probe-fmt.md', theme: 'github-light.css' });
const { page } = s; const fr = page.frames().find((x) => x.url().includes('webview.html'));
const doc = () => fr.evaluate(() => window.__doc());
const line = async (n) => (await doc()).split('\n')[n];
// select a word in the editor via CodeMirror (as a double-click would)
const selectWord = (w) => fr.evaluate((w) => { const v = window.__view; const t = v.state.doc.toString(); const i = t.indexOf(w); v.dispatch({ selection: { anchor: i, head: i + w.length } }); v.focus(); }, w);
const hasView = await fr.evaluate(() => !!window.__view); console.log('view exposed:', hasView);
if (hasView) {
  await selectWord('bold words'); await page.keyboard.press('Meta+b'); await page.waitForTimeout(300);
  console.log('A bold→Cmd+B:', JSON.stringify(await line(2)), 'sel:', await fr.evaluate(() => { const r = window.__view.state.selection.main; return window.__view.state.sliceDoc(r.from, r.to); }));
  await selectWord('Second plain'); await page.keyboard.press('Meta+b'); await page.waitForTimeout(300);
  console.log('B after bold sel:', JSON.stringify(await fr.evaluate(() => { const r = window.__view.state.selection.main; return window.__view.state.sliceDoc(r.from, r.to); })));
  await page.keyboard.press('Meta+i'); await page.waitForTimeout(300);
  console.log('B bold+italic:', JSON.stringify(await line(4)));
}
await s.ctx.close(); await s.browser.close(); server.close();
