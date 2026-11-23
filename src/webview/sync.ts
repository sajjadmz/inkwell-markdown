// Pure sync logic between the CodeMirror view and the VS Code TextDocument (no DOM, no vscode).
// The document is the source of truth. The client keeps:
//   serverDoc  the text of the document at `version`, as last confirmed by the extension
//   inflight   local changes sent to the extension and not yet acknowledged (apply to serverDoc)
//   buffer     local changes made after `inflight` was sent (apply to serverDoc + inflight)
// The view always shows serverDoc + inflight + buffer. Only one edit is in flight at a time.
// Remote changes (external edit, undo/redo, other editor) are rebased over inflight/buffer, so a
// keystroke typed while they arrive is kept. Anything inconsistent triggers a resync, which hands over the
// fresh document text: pending local changes are NEVER discarded, they are rebased over the diff between the
// last confirmed text and the fresh one (an insertion inside a region deleted meanwhile is kept at the
// deletion point and the user is told).
import { ChangeSet, Text } from '@codemirror/state';
export { ChangeSet, Text };

/** A range in VS Code coordinates (0-based line, UTF-16 character) and its replacement text. */
export interface LineChange { fromLine: number; fromCh: number; toLine: number; toCh: number; insert: string }

export type ToClient =
  | { type: 'init'; text: string; version: number }
  | { type: 'ack'; version: number }
  | { type: 'remote'; base: number; version: number; changes: LineChange[] }
  | { type: 'resync'; text: string; version: number }
  /** The host could not apply the edit sent at `version` (nothing changed): resend it. */
  | { type: 'retry'; version: number };

export type ToHost =
  | { type: 'edit'; base: number; changes: LineChange[] }
  | { type: 'needResync'; reason: string };

export type ViewOp = { kind: 'changes'; changes: ChangeSet } | { kind: 'replace'; text: string } | null;

export const normalizeEol = (s: string): string => s.replace(/\r\n?/g, '\n');
const toText = (s: string): Text => Text.of(normalizeEol(s).split('\n'));

export function toLineChanges(cs: ChangeSet, doc: Text): LineChange[] {
  const out: LineChange[] = [];
  cs.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const a = doc.lineAt(fromA);
    const b = doc.lineAt(toA);
    out.push({ fromLine: a.number - 1, fromCh: fromA - a.from, toLine: b.number - 1, toCh: toA - b.from, insert: inserted.sliceString(0, undefined, '\n') });
  });
  return out;
}

/** Offset of (line, ch) in doc, or -1 when it does not exist. */
export function offsetOf(doc: Text, line: number, ch: number): number {
  if (!Number.isInteger(line) || !Number.isInteger(ch) || line < 0 || ch < 0 || line >= doc.lines) return -1;
  const l = doc.line(line + 1);
  return ch > l.length ? -1 : l.from + ch;
}

export class SyncClient {
  serverDoc: Text = Text.of(['']);
  version = -1;
  inflight: ChangeSet | null = null;
  buffer: ChangeSet | null = null;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly send: (m: ToHost) => void,
    private readonly log: (s: string) => void = () => {},
    private readonly notify: (s: string) => void = () => {},
  ) {}

  get idle(): boolean { return !this.inflight && !this.buffer; }
  whenIdle(): Promise<void> {
    if (this.idle) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }
  private checkIdle(): void {
    if (!this.idle) return;
    const w = this.idleWaiters; this.idleWaiters = [];
    w.forEach((r) => r());
  }

  /** The text the view must show right now (used for assertions and tests). */
  expectedViewDoc(): Text {
    let d = this.serverDoc;
    if (this.inflight) d = this.inflight.apply(d);
    if (this.buffer) d = this.buffer.apply(d);
    return d;
  }

  /** A user transaction changed the view. */
  local(cs: ChangeSet): void {
    if (this.version < 0 || cs.empty) return;
    this.buffer = this.buffer ? this.buffer.compose(cs) : cs;
    this.flush();
  }

  private flush(): void {
    if (this.inflight || !this.buffer) { this.checkIdle(); return; }
    this.inflight = this.buffer; this.buffer = null;
    this.send({ type: 'edit', base: this.version, changes: toLineChanges(this.inflight, this.serverDoc) });
  }

  private resyncRequest(reason: string): null {
    this.log(`needResync: ${reason}`);
    this.send({ type: 'needResync', reason });
    return null;
  }

  /** Does any pending local change touch [from, to) of serverDoc (inflight) or follow a deletion there (buffer)? */
  private pendingTouches(from: number, to: number): boolean {
    let hit = false;
    if (this.inflight) this.inflight.iterChangedRanges((fa, ta) => { if (fa <= to && ta >= from) hit = true; });
    if (this.buffer) this.buffer.iterChangedRanges((fa) => { if (fa >= from && fa <= to) hit = true; });
    return hit;
  }

  /** Apply a change `r` made by the host to serverDoc; rebase pending local changes over it. */
  private rebase(r: ChangeSet, version: number): ViewOp {
    this.serverDoc = r.apply(this.serverDoc);
    this.version = version;
    let view = r;
    if (this.inflight) {
      const i2 = this.inflight.map(view, true);
      view = view.map(this.inflight, false);
      this.inflight = i2.empty ? null : i2;
    }
    if (this.buffer) {
      const b2 = this.buffer.map(view, true);
      view = view.map(this.buffer, false);
      this.buffer = b2.empty ? null : b2;
    }
    // The edit sent earlier was based on an older version, so the host drops it. Send the rebased one.
    if (this.inflight) this.send({ type: 'edit', base: this.version, changes: toLineChanges(this.inflight, this.serverDoc) });
    else this.flush();
    this.checkIdle();
    return { kind: 'changes', changes: view };
  }

  receive(m: ToClient): ViewOp {
    switch (m.type) {
      case 'init': {
        this.serverDoc = toText(m.text); this.version = m.version; this.inflight = null; this.buffer = null;
        this.checkIdle();
        return { kind: 'replace', text: this.serverDoc.sliceString(0, undefined, '\n') };
      }
      case 'resync': {
        if (this.version < 0) return this.receive({ type: 'init', text: m.text, version: m.version });
        const T = toText(m.text);
        const S = this.serverDoc;
        this.log(`resync from document (version ${m.version}); pending local edits are rebased: ${!this.idle}`);
        // The edit in flight may already be in the document (its ack was lost): then there is nothing to redo.
        if (this.inflight && this.inflight.apply(S).eq(T)) {
          this.serverDoc = T; this.version = m.version; this.inflight = null;
          // Usually our ack was lost, but an identical outside edit at the same spot looks the same: tell the user rather than merge silently.
          this.notify('An outside change matched what you just typed at the same moment, so it appears once. Please check that your text is as intended.');
          this.flush(); this.checkIdle();
          return null;
        }
        const a = S.toString(), b = T.toString();
        let p = 0; const mx = Math.min(a.length, b.length);
        while (p < mx && a.charCodeAt(p) === b.charCodeAt(p)) p++;
        if (p > 0 && p < mx && /[\uDC00-\uDFFF]/.test(a[p])) p--; // do not split a surrogate pair
        let q = 0;
        while (q < mx - p && a.charCodeAt(a.length - 1 - q) === b.charCodeAt(b.length - 1 - q)) q++;
        if (q > 0 && /[\uDC00-\uDFFF]/.test(a[a.length - q])) q--;
        const r = ChangeSet.of(p === a.length - q && p === b.length - q ? [] : [{ from: p, to: a.length - q, insert: b.slice(p, b.length - q) }], a.length);
        if (!this.idle && a.length - q > p && this.pendingTouches(p, a.length - q)) {
          this.notify('Some text you were typing was inside a region that changed at the same moment. Your text was kept; please check that paragraph.');
        }
        return this.rebase(r, m.version);
      }
      case 'retry': {
        if (m.version === this.version && this.inflight) this.send({ type: 'edit', base: this.version, changes: toLineChanges(this.inflight, this.serverDoc) });
        return null;
      }
      case 'ack': {
        if (!this.inflight) return this.resyncRequest('ack without an edit in flight');
        this.serverDoc = this.inflight.apply(this.serverDoc);
        this.version = m.version; this.inflight = null;
        this.flush();
        return null;
      }
      case 'remote': {
        if (m.base !== this.version) return this.resyncRequest(`remote base ${m.base} != ${this.version}`);
        const specs: Array<{ from: number; to: number; insert: string }> = [];
        for (const c of m.changes) {
          const from = offsetOf(this.serverDoc, c.fromLine, c.fromCh);
          const to = offsetOf(this.serverDoc, c.toLine, c.toCh);
          if (from < 0 || to < from) return this.resyncRequest('remote change outside document');
          specs.push({ from, to, insert: normalizeEol(c.insert) });
        }
        let r: ChangeSet;
        try { r = ChangeSet.of(specs, this.serverDoc.length); } catch { return this.resyncRequest('remote change overlap'); }
        return this.rebase(r, m.version);
      }
    }
  }
}
