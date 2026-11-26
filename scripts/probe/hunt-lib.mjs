import { serve, open } from '../demo/lib.mjs';
export async function start(doc = 'probe-hunt.md') {
  const { server, base } = await serve();
  const s = await open(base, { doc, theme: 'github-light.css' });
  const { page } = s; const f = page.frameLocator('#wv'); const fr = page.frames().find((x) => x.url().includes('webview.html'));
  const H = {
    page, f, fr, s,
    doc: () => fr.evaluate(() => window.__doc()),
    lines: async () => (await fr.evaluate(() => window.__doc())).split('\n'),
    wait: (n = 200) => page.waitForTimeout(n),
    selectEd: (w, nth = 0) => fr.evaluate(([w]) => { const v = window.__view; const t = v.state.doc.toString(); const i = t.indexOf(w); v.dispatch({ selection: { anchor: i, head: i + w.length } }); v.focus(); }, [w]),
    selRange: (a, b) => fr.evaluate(([a, b]) => { const v = window.__view; v.dispatch({ selection: { anchor: a, head: b } }); v.focus(); }, [a, b]),
    edSel: () => fr.evaluate(() => { const v = window.__view; const r = v.state.selection.main; return v.state.sliceDoc(r.from, r.to); }),
    selectCell: (w) => fr.evaluate((w) => { const c = document.activeElement; const tn = c.firstChild; const i = w ? tn.data.indexOf(w) : 0; if (w && i < 0) throw new Error('no ' + w + ' in ' + tn.data); const r = document.createRange(); r.setStart(tn, i); r.setEnd(tn, w ? i + w.length : tn.data.length); getSelection().removeAllRanges(); getSelection().addRange(r); }, w),
    caretCell: (pos) => fr.evaluate((pos) => { const c = document.activeElement; const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT); let n = pos, t; while ((t = w.nextNode())) { if (n <= t.data.length) { const r = document.createRange(); r.setStart(t, n); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); return; } n -= t.data.length; } }, pos),
    cellSel: () => fr.evaluate(() => getSelection().toString()),
    cellText: () => fr.evaluate(() => document.activeElement.textContent),
    key: async (k) => { await page.keyboard.press(k); await page.waitForTimeout(150); },
    tb: async (a) => { await f.locator(`#lm-toolbar [data-action="${a}"]`).click(); await page.waitForTimeout(150); },
    menu: async (a, label) => { await f.locator(`#lm-toolbar [data-action="${a}"]`).click(); await page.waitForTimeout(100); await f.locator('.lm-menu .lm-mi', { hasText: label }).first().click(); await page.waitForTimeout(150); },
    cell: (txt) => f.locator('td,th', { hasText: txt }).first(),
    close: async () => { await s.ctx.close(); await s.browser.close(); server.close(); },
    active: () => fr.evaluate(() => [...document.querySelectorAll('#lm-toolbar .lm-tb')].filter((b) => /on|active|pressed/.test(b.className) || b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.action)),
  };
  // table validity: each row same pipe count (unescaped), no raw newline in rows
  H.check = async (label) => {
    const L = await H.lines(); const rows = L.filter((l) => l.startsWith('|'));
    const cnt = (l) => (l.replace(/\\\|/g, '').replace(/`[^`]*`/g, (m) => m).match(/\|/g) || []).length;
    const c0 = rows.length ? cnt(rows[0]) : 0; const bad = rows.filter((r) => cnt(r) !== c0);
    const tableLines = L.slice(L.findIndex((l) => l.startsWith('| H1')) , L.findIndex((l) => l.startsWith('| H1')) + rows.length + 3);
    if (bad.length) console.log('  !! PIPE MISMATCH after', label, JSON.stringify(bad));
    return L;
  };
  return H;
}
