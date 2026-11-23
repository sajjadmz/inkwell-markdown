// Randomised convergence test of the pure sync logic (dist/sync.js) against a model of the host.
import * as assert from 'node:assert';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const S = require(path.resolve(__dirname, '../../../dist/sync.js'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const Text = S.ChangeSet && S.Text as Any;

function rng(seed: number) { return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296; }

suite('Sync convergence', () => {
  test('60 random interleavings of local typing and remote edits converge', () => {
    for (let seed = 1; seed <= 60; seed++) {
      {
      const r = rng(seed);
      const pick = (n: number) => Math.floor(r() * n);
      // Model host: document text + version. Messages travel in FIFO queues with random delivery order between the two.
      let docText = 'alpha\nbeta\ngamma\n\ndelta epsilon\n';
      let version = 1;
      const toHost: Any[] = []; const toClient: Any[] = [];
      const client = new S.SyncClient((m: Any) => toHost.push(m));
      let view = Text.of(docText.split('\n'));
      const apply = (op: ReturnType<typeof client.receive>) => {
        if (!op) return;
        if (op.kind === 'replace') view = Text.of(op.text.split('\n'));
        else view = op.changes.apply(view);
      };
      const lineCh = (t: string, off: number) => { const pre = t.slice(0, off).split('\n'); return { line: pre.length - 1, ch: pre[pre.length - 1].length }; };
      toClient.push({ type: 'init', text: docText, version });
      const hostEdit = (a: number, b: number, text: string) => {
        const p = lineCh(docText, a), q = lineCh(docText, b);
        const ch = { fromLine: p.line, fromCh: p.ch, toLine: q.line, toCh: q.ch, insert: text };
        docText = docText.slice(0, a) + text + docText.slice(b);
        version++;
        toClient.push({ type: 'remote', base: version - 1, version, changes: [ch] });
      };
      const hostReceive = (m: Any) => {
        if (m.type !== 'edit' || m.base !== version) return; // stale: dropped
        const c = m.changes;
        let t = docText;
        // all changes refer to the original text; apply from the end
        const offs = c.map((x: Any) => ({ a: S.offsetOf(Text.of(docText.split('\n')), x.fromLine, x.fromCh), b: S.offsetOf(Text.of(docText.split('\n')), x.toLine, x.toCh), i: x.insert }));
        offs.sort((x: Any, y: Any) => y.a - x.a);
        for (const o of offs) { assert.ok(o.a >= 0 && o.b >= o.a, 'valid range'); t = t.slice(0, o.a) + o.i + t.slice(o.b); }
        docText = t; version++;
        toClient.push({ type: 'ack', version });
      };
      for (let step = 0; step < 400; step++) {
        const x = r();
        if (x < 0.3 && toClient.length) { const m = toClient.shift()!; apply(client.receive(m)); }
        else if (x < 0.5 && toHost.length) { hostReceive(toHost.shift()!); }
        else if (x < 0.7 && client.version >= 0) { // user types or deletes
          const len = view.length; const a = pick(len + 1); const b = Math.min(len, a + (r() < 0.3 ? pick(4) : 0));
          const text = r() < 0.7 ? 'k' + pick(10) : r() < 0.5 ? '\n' : '';
          if (a === b && !text) continue;
          const before = view;
          const cs = S.ChangeSet.of({ from: a, to: b, insert: text }, len);
          view = cs.apply(before);
          client.local(cs);
        } else if (x < 0.85) { // external edit
          const len = docText.length; const a = pick(len + 1); const b = Math.min(len, a + (r() < 0.3 ? pick(5) : 0));
          hostEdit(a, b, r() < 0.7 ? 'E' + pick(10) : '');
        }
        assert.strictEqual(view.toString(), client.expectedViewDoc().toString(), 'view equals serverDoc+inflight+buffer');
      }
      // drain
      for (let guard = 0; guard < 1000 && (toClient.length || toHost.length || !client.idle); guard++) {
        if (toClient.length) apply(client.receive(toClient.shift()!));
        else if (toHost.length) hostReceive(toHost.shift()!);
      }
      assert.ok(client.idle, 'client idle');
      assert.strictEqual(view.toString(), docText, 'view converged to the document');
      }
    }
  });

  test('a resync never drops pending local edits (rebased over the new document text)', () => {
    const sent: Any[] = []; const notices: string[] = [];
    const client = new S.SyncClient((m: Any) => sent.push(m), () => {}, (n: string) => notices.push(n));
    let view = Text.of(['alpha', 'beta', 'gamma']);
    const apply = (op: Any) => { if (!op) return; view = op.kind === 'replace' ? Text.of(op.text.split('\n')) : op.changes.apply(view); };
    apply(client.receive({ type: 'init', text: 'alpha\nbeta\ngamma', version: 1 }));
    const type = (at: number, t: string) => { const cs = S.ChangeSet.of([{ from: at, to: at, insert: t }], view.length); view = cs.apply(view); client.local(cs); };
    type(0, 'ONE '); type(view.length, ' TWO');          // one in flight, one buffered
    apply(client.receive({ type: 'resync', text: 'HEAD\nalpha\nbeta\ngamma\nTAIL', version: 5 }));
    assert.strictEqual(view.toString().replace('ONE ', ''), 'HEAD\nalpha\nbeta\ngamma\nTAIL TWO');
    assert.ok(view.toString().includes('ONE '));
    assert.strictEqual(client.expectedViewDoc().toString(), view.toString());
    assert.strictEqual(sent[sent.length - 1].base, 5, 'rebased edit resent at the new version');
    // the region under the pending edit was deleted externally: the typed text is kept and the user is told
    apply(client.receive({ type: 'resync', text: 'HEAD\nTAIL', version: 6 }));
    assert.ok(view.toString().includes('ONE ') && view.toString().includes(' TWO'), view.toString());
    assert.ok(notices.length > 0, 'user told');
    // an edit already applied by the host (its ack was lost) is not applied twice
    const c2 = new S.SyncClient((m: Any) => sent.push(m));
    c2.receive({ type: 'init', text: 'abc', version: 1 });
    c2.local(S.ChangeSet.of([{ from: 3, to: 3, insert: 'X' }], 3));
    const op = c2.receive({ type: 'resync', text: 'abcX', version: 2 });
    assert.strictEqual(op, null); assert.ok(c2.idle); assert.strictEqual(c2.serverDoc.toString(), 'abcX');
  });
});
