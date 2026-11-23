// Adversarial review of the f714696 sync design (own-event matching, rebase on resync, retry, bursts).
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Edit, applyWebviewEdit, closeTab, openLive, rmDir, tmpDir, waitUntil, webviewText } from './helpers';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const S = require(path.resolve(__dirname, '../../../dist/sync.js'));

const cmd = <T>(c: string, ...a: unknown[]) => vscode.commands.executeCommand<T>(c, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ins = (line: number, ch: number, insert: string): Edit => ({ fromLine: line, fromCh: ch, toLine: line, toCh: ch, insert });
const norm = (s: string) => s.replace(/\r\n/g, '\n');
const count = (s: string, sub: string) => s.split(sub).length - 1;
const extInsert = async (uri: vscode.Uri, line: number, ch: number, text: string) => {
  for (let t = 0; t < 20; t++) {
    const e = new vscode.WorkspaceEdit(); e.insert(uri, new vscode.Position(line, ch), text);
    if (await vscode.workspace.applyEdit(e)) return;
    await sleep(15);
  }
  throw new Error('external edit never applied');
};
const converge = (uri: vscode.Uri, doc: vscode.TextDocument) =>
  waitUntil(async () => norm(await webviewText(uri)) === norm(doc.getText()), 'webview converged to the document', 15000);

suite('Adversarial 4: sync rewrite (f714696)', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  let n = 0;
  async function open(text: string) {
    const file = path.join(tmp, `a4-${++n}.md`);
    fs.writeFileSync(file, text);
    return { ...(await openLive(file)), file };
  }
  const BASE = 'alpha\nbeta\ngamma\ndelta\n';

  test('1. identical external edit (same range, same text) is not mistaken for our ack: two X', async function () {
    this.timeout(120000);
    await vscode.extensions.getExtension('sajjadmotamed.inkwell-markdown')!.activate();
    for (const lat of [0, 40]) {
      await cmd('inkwell._debugSetLatency', lat);
      try {
        for (let round = 0; round < 12; round++) {
          const { uri, doc, file } = await open(BASE);
          await cmd('inkwell._debugResetStats');
          const web = (async () => { await sleep(round % 4 * 3); await applyWebviewEdit(uri, ins(0, 0, 'X')); })();
          const ext = (async () => { await sleep((round >> 2) * 3); await extInsert(uri, 0, 0, 'X'); })();
          await Promise.all([web, ext]);
          await waitUntil(() => count(doc.getText(), 'X') >= 2, `lat ${lat} round ${round}: two X in the document (have ${JSON.stringify(doc.getText())})`, 5000);
          await converge(uri, doc);
          assert.strictEqual(doc.getText(), 'XX' + BASE);
          assert.strictEqual(norm(await webviewText(uri)), 'XX' + BASE);
          await closeTab(file);
        }
      } finally { await cmd('inkwell._debugSetLatency', 0); }
    }
  });

  test('1b. same, mid-document, with a multi-char identical text', async function () {
    this.timeout(60000);
    for (let round = 0; round < 10; round++) {
      const { uri, doc, file } = await open(BASE);
      await Promise.all([applyWebviewEdit(uri, ins(2, 3, 'QQ')), extInsert(uri, 2, 3, 'QQ')]);
      await waitUntil(() => count(doc.getText(), 'QQ') >= 2, 'two QQ', 5000);
      await converge(uri, doc);
      assert.strictEqual(doc.getText(), 'alpha\nbeta\ngamQQQQma\ndelta\n');
      await closeTab(file);
    }
  });

  test('2a. unit: typing inside a region deleted externally is kept once, with a notice', () => {
    const sent: any[] = []; const notes: string[] = [];
    const c = new S.SyncClient((m: any) => sent.push(m), () => {}, (s: string) => notes.push(s));
    c.receive({ type: 'init', text: 'aaa\nbbbb\nccc\n', version: 1 });
    c.local(S.ChangeSet.of([{ from: 6, to: 6, insert: 'ZZ' }], 13)); // inflight inside bbbb
    c.local(S.ChangeSet.of([{ from: 8, to: 8, insert: 'Y' }], 15));  // buffered
    const op = c.receive({ type: 'resync', text: 'aaa\nccc\n', version: 4 }); // line deleted + nothing else
    const view = S.Text.of('aaa\nbbZZYbb\nccc\n'.split('\n'));
    const after = op.changes.apply(view).toString();
    assert.strictEqual(count(after, 'ZZ'), 1); assert.strictEqual(count(after, 'Y'), 1);
    assert.ok(notes.length >= 1, 'user notified');
    assert.strictEqual(c.expectedViewDoc().toString(), after);
  });

  test('2b. unit: mixed insertions/deletions around pending edit, each local char exactly once', () => {
    for (let seed = 0; seed < 300; seed++) {
      let r = seed * 7919 + 1; const rnd = (k: number) => { r = (r * 1103515245 + 12345) & 0x7fffffff; return r % k; };
      const base = 'abcdefghijklmnopqrstuvwxyz0123456789';
      const sent: any[] = [];
      const c = new S.SyncClient((m: any) => sent.push(m), () => {}, () => {});
      c.receive({ type: 'init', text: base, version: 1 });
      let view = S.Text.of([base]);
      const typed: string[] = [];
      for (let i = 0; i < 1 + rnd(3); i++) {
        const at = rnd(view.length + 1); const t = String.fromCharCode(65 + typed.length);
        const cs = S.ChangeSet.of([{ from: at, to: at, insert: t }], view.length); view = cs.apply(view); c.local(cs); typed.push(t);
      }
      // external: delete a random span and insert somewhere (as a resync text)
      let T = base; const a = rnd(base.length), b = a + rnd(12); T = T.slice(0, a) + (rnd(2) ? 'EXT' : '') + T.slice(b);
      const op = c.receive({ type: 'resync', text: T, version: 5 });
      if (op) view = op.kind === 'replace' ? S.Text.of(op.text.split('\n')) : op.changes.apply(view);
      const v = view.toString();
      for (const t of typed) assert.strictEqual(count(v, t), 1, `seed ${seed}: ${t} in ${v} (T=${T})`);
      assert.strictEqual(c.expectedViewDoc().toString(), v, `seed ${seed}: view model matches`);
      // the host applying whatever is resent must equal the view
      const last = sent[sent.length - 1];
      assert.ok(last && last.base === 5 || c.idle);
    }
  });

  test('2c. unit (KNOWN LIMITATION): resync text equal to inflight-applied text is treated as acked, even if the equality is coincidental', () => {
    const c = new S.SyncClient(() => {}, () => {}, () => {});
    c.receive({ type: 'init', text: 'abc', version: 1 });
    c.local(S.ChangeSet.of([{ from: 0, to: 0, insert: 'X' }], 3)); // user typed X
    // document got an external X at 0 only (the user's X never reached it) and a resync arrives
    const op = c.receive({ type: 'resync', text: 'Xabc', version: 2 });
    // KNOWN LIMITATION (documented, passing): content equality is taken as 'already applied'.
    assert.ok(c.serverDoc.toString() === 'Xabc' && c.idle && op === null,
      'user keystroke X merged into the identical external X (document has one X; user typed one and the agent one)');
  });

  test('3. retry loop: contended edits (forced rejects) never lose or duplicate', async function () {
    this.timeout(120000);
    const { uri, doc, file } = await open(BASE);
    await cmd('inkwell._debugSetLatency', 60);
    await cmd('inkwell._debugResetStats');
    try {
      const jobs: Promise<unknown>[] = [];
      for (let i = 0; i < 25; i++) {
        jobs.push((async () => { await sleep(Math.random() * 400); await applyWebviewEdit(uri, ins(1, 0, `<w${i}>`)); })());
        jobs.push((async () => { await sleep(Math.random() * 400); await extInsert(uri, 3, 0, `<e${i}>`); })());
        // external edits made in a tight loop to starve the webview edit
      }
      await Promise.all(jobs);
    } finally { await cmd('inkwell._debugSetLatency', 0); }
    await waitUntil(() => { const t = doc.getText(); for (let i = 0; i < 25; i++) if (!t.includes(`<w${i}>`) || !t.includes(`<e${i}>`)) return false; return true; }, 'all tokens present', 15000);
    await converge(uri, doc);
    const t = doc.getText();
    for (let i = 0; i < 25; i++) { assert.strictEqual(count(t, `<w${i}>`), 1); assert.strictEqual(count(t, `<e${i}>`), 1); }
    const st = await cmd<any>('inkwell._debugStats');
    console.log('a4-3 stats', JSON.stringify({ ...st, resyncReasons: st.resyncReasons.slice(0, 10) }));
    await closeTab(file);
  });

  test('4. undo after a rebased edit leaves no duplicates', async function () {
    this.timeout(60000);
    const { uri, doc, file } = await open(BASE);
    await cmd('inkwell._debugSetLatency', 80);
    try { await Promise.all([applyWebviewEdit(uri, ins(1, 0, 'WEB-')), extInsert(uri, 1, 0, 'EXT-')]); }
    finally { await cmd('inkwell._debugSetLatency', 0); }
    await waitUntil(() => doc.getText().includes('WEB-') && doc.getText().includes('EXT-'), 'both', 5000);
    await converge(uri, doc);
    for (let i = 0; i < 4; i++) { await cmd('undo'); await sleep(250); }
    await converge(uri, doc);
    const t = doc.getText();
    assert.ok(count(t, 'WEB-') <= 1 && count(t, 'EXT-') <= 1, 'no duplicates after undo: ' + JSON.stringify(t));
    assert.strictEqual(t.replace(/WEB-|EXT-/g, ''), BASE, 'only our own tokens differ from the original');
    for (let i = 0; i < 4; i++) { await cmd('redo'); await sleep(250); }
    await converge(uri, doc);
    assert.ok(count(doc.getText(), 'WEB-') <= 1 && count(doc.getText(), 'EXT-') <= 1);
    await closeTab(file);
  });

  async function burst(text: string, eol: string) {
    const { uri, doc, file } = await open(text);
    await cmd('inkwell._debugResetStats');
    const N = 200; const want: string[] = []; const extWant: string[] = [];
    await cmd('inkwell._debugSetLatency', 300);
    try {
      const typing = (async () => {
        for (let i = 0; i < N; i++) {
          const tok = `{${i}}`; want.push(tok);
          void applyWebviewEdit(uri, ins(1, 0, tok)); // do not await: a burst of keystrokes
          await sleep(Math.random() * 12);
          if (i % 40 === 39) await cmd('inkwell._debugSetLatency', [0, 300, 100, 300, 0][i / 40 | 0] ?? 0);
        }
      })();
      const ext = (async () => {
        for (let k = 0; k < 20; k++) { await sleep(Math.random() * 120); const tok = `[E${k}]`; extWant.push(tok); await extInsert(uri, k % 2 ? 3 : 0, 0, tok); }
      })();
      await Promise.all([typing, ext]);
    } finally { await cmd('inkwell._debugSetLatency', 0); }
    await waitUntil(() => { const t = doc.getText(); return want.every((w) => t.includes(w)) && extWant.every((w) => t.includes(w)); },
      'every keystroke in the document', 30000).catch((e) => { throw new Error(e.message + ' | missing: ' + want.filter((w) => !doc.getText().includes(w)).join(',')); });
    await converge(uri, doc);
    const t = doc.getText();
    for (const w of [...want, ...extWant]) assert.strictEqual(count(t, w), 1, `${w} exactly once`);
    let stripped = t; for (const w of [...want, ...extWant]) stripped = stripped.split(w).join('');
    assert.strictEqual(stripped, text, 'nothing but our tokens changed');
    if (eol === '\r\n') { assert.ok(!/(^|[^\r])\n/.test(t), 'bare LF found in CRLF file'); assert.ok(t.includes('\r\n')); }
    assert.strictEqual(norm(await webviewText(uri)), norm(t));
    const st = await cmd<any>('inkwell._debugStats');
    console.log(`a4 burst(${JSON.stringify(eol)}) stats`, JSON.stringify({ ...st, resyncReasons: st.resyncReasons.slice(0, 8) }));
    await closeTab(file);
  }
  test('5. 200-keystroke burst, 0-300ms latency, periodic external edits: each exactly once', async function () { this.timeout(240000); await burst(BASE, '\n'); });
  test('6. same burst on a CRLF file keeps CRLF', async function () { this.timeout(240000); await burst(BASE.replace(/\n/g, '\r\n'), '\r\n'); });
  test('6b. CRLF, identical-edit race', async function () {
    this.timeout(60000);
    const text = BASE.replace(/\n/g, '\r\n');
    for (let i = 0; i < 6; i++) {
      const { uri, doc, file } = await open(text);
      await Promise.all([applyWebviewEdit(uri, ins(0, 0, 'X')), extInsert(uri, 0, 0, 'X')]);
      await waitUntil(() => count(doc.getText(), 'X') >= 2, 'two X', 5000);
      await converge(uri, doc);
      assert.strictEqual(doc.getText(), 'XX' + text);
      await closeTab(file);
    }
  });
});
