import * as crypto from 'crypto';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { loadTheme, listThemes } from './theme';
import { openLink } from './links';

const VIEW_TYPE = 'inkwell.editor';

const MAX_BYTES = 2 * 1024 * 1024; // S6
const STYLE_AUTO = 'auto';

interface Session {
  webview: vscode.Webview;
  ready: boolean;
  /** Document version the webview is known to mirror. */
  version: number;
  /** Set while one webview edit is being applied (used to recognise its own change event). */
  applying: { base: number; acked: boolean; expect: Array<{ fromLine: number; fromCh: number; toLine: number; toCh: number; text: string }> } | null;
  edited: vscode.EventEmitter<void>;
  /** Test only: ordered delivery chains used to inject latency. */
  inChain: Promise<void>;
  outChain: Promise<void>;
  outBusy: number;
  inBusy: number;
  rejects: Map<number, number>;
}

type DebugReply = { value?: unknown; error?: string };

class InkwellProvider implements vscode.CustomTextEditorProvider {
  private readonly sessions = new Map<string, Set<Session>>();
  /** The webview whose panel is active: target of the keyboard-shortcut commands. */
  activeSession: Session | undefined;
  private readonly pending = new Map<string, string>();
  /** Files for which the mixed-line-ending notice was already shown this session. */
  readonly eolNotified = new Set<string>();
  private readonly readyWaiters = new Map<string, Array<() => void>>();
  private readonly asks = new Map<number, (r: DebugReply) => void>();
  private askId = 0;
  readonly out = vscode.window.createOutputChannel('Inkwell');
  /** Test only: maximum random delay (ms) injected on messages to and from the webview. */
  latencyMax = 0;
  readonly stats = { resyncs: 0, staleDrops: 0, rejected: 0, resyncReasons: [] as string[] };

  constructor(private readonly ctx: vscode.ExtensionContext) {
    // Test-only latency knob: never active for real users.
    if (ctx.extensionMode === vscode.ExtensionMode.Test) this.latencyMax = Number(process.env.INKWELL_TEST_LATENCY_MS ?? 0) || 0;
    ctx.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => this.onDocChanged(e)), this.out);
  }

  private log(s: string): void { this.out.appendLine(`${new Date().toISOString()} ${s}`); }

  /** Scroll open viewers of `uri` to a heading id (or remember it until the viewer is ready). */
  scrollTo(uri: vscode.Uri, fragment: string): void {
    const key = uri.toString();
    const views = [...(this.sessions.get(key) ?? [])].filter((s) => s.ready);
    if (views.length) views.forEach((s) => s.webview.postMessage({ type: 'scroll', fragment }));
    else this.pending.set(key, fragment);
  }

  private get dist(): string { return path.join(this.ctx.extensionPath, 'dist'); }

  private themeCss(): string {
    const setting = vscode.workspace.getConfiguration('inkwell').get<string>('previewTheme', STYLE_AUTO);
    const kind = vscode.window.activeColorTheme.kind;
    const dark = kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
    return loadTheme(this.dist, setting, dark).css;
  }

  // ---- test-only helpers (registered only in Test mode) ----
  firstSession(uri: vscode.Uri): Session | undefined { return [...(this.sessions.get(uri.toString()) ?? [])][0]; }
  sessionCount(uri: vscode.Uri): number { return this.sessions.get(uri.toString())?.size ?? 0; }
  whenReady(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    if ([...(this.sessions.get(key) ?? [])].some((s) => s.ready)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('webview not ready')), 30000);
      const w = this.readyWaiters.get(key) ?? [];
      w.push(() => { clearTimeout(t); resolve(); });
      this.readyWaiters.set(key, w);
    });
  }
  ask(s: Session, type: string, extra: object = {}): Promise<unknown> {
    const id = ++this.askId;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.asks.delete(id); reject(new Error(`webview did not answer ${type}`)); }, 10000);
      this.asks.set(id, (r) => { clearTimeout(t); r.error ? reject(new Error(r.error)) : resolve(r.value); });
      void s.webview.postMessage({ type, id, ...extra });
    });
  }

  /** A formatting shortcut (package.json keybinding) was pressed: tell the focused Inkwell webview. */
  format(action: string): void { if (this.activeSession?.ready) void this.activeSession.webview.postMessage({ type: 'format', action }); }

  private delay(): Promise<void> {
    return this.latencyMax > 0 ? new Promise((r) => setTimeout(r, Math.random() * this.latencyMax)) : Promise.resolve();
  }
  /** Send to the webview, in order, with optional injected latency (test only). */
  private post(s: Session, msg: object): void {
    if (this.latencyMax <= 0 && s.outBusy === 0) { void s.webview.postMessage(msg); return; }
    s.outBusy++;
    s.outChain = s.outChain.then(() => this.delay()).then(() => { s.outBusy--; void s.webview.postMessage(msg); });
  }
  /** Handle a webview message, in order, with optional injected latency (test only). */
  private inbound(s: Session, fn: () => void): void {
    if (this.latencyMax <= 0 && s.inBusy === 0) { fn(); return; }
    s.inBusy++;
    s.inChain = s.inChain.then(() => this.delay()).then(() => { s.inBusy--; fn(); });
  }

  private resync(s: Session, doc: vscode.TextDocument, why: string): void {
    this.log(`resync (${why}) ${doc.uri.fsPath} v${doc.version}`);
    this.stats.resyncs++; this.stats.resyncReasons.push(why);
    s.version = doc.version;
    this.post(s, { type: 'resync', text: doc.getText(), version: doc.version });
  }

  private async handleEdit(s: Session, doc: vscode.TextDocument, m: { base?: unknown; changes?: unknown }): Promise<void> {
    const changes = m.changes;
    if (typeof m.base !== 'number' || !Array.isArray(changes) || !changes.length) { this.resync(s, doc, 'malformed edit'); return; }
    if (doc.version !== m.base) { this.stats.staleDrops++; this.log(`stale edit dropped (base ${m.base}, document ${doc.version}); the webview rebases it`); return; }
    const edit = new vscode.WorkspaceEdit();
    const expect: NonNullable<Session['applying']>['expect'] = [];
    for (const c of changes as Array<Record<string, unknown>>) {
      const { fromLine, fromCh, toLine, toCh, insert } = c;
      if (![fromLine, fromCh, toLine, toCh].every((n) => Number.isInteger(n)) || typeof insert !== 'string') { this.resync(s, doc, 'malformed change'); return; }
      const a = new vscode.Position(fromLine as number, fromCh as number);
      const b = new vscode.Position(toLine as number, toCh as number);
      // Never let VS Code silently clamp a position: that would change the wrong characters.
      if (a.isAfter(b) || !doc.validatePosition(a).isEqual(a) || !doc.validatePosition(b).isEqual(b)) { this.resync(s, doc, 'edit outside document'); return; }
      edit.replace(doc.uri, new vscode.Range(a, b), insert);
      expect.push({ fromLine: a.line, fromCh: a.character, toLine: b.line, toCh: b.character, text: insert.replace(/\r\n?/g, '\n') });
    }
    const base = m.base;
    const own = { base, acked: false, expect };
    s.applying = own;
    let ok = false;
    try { ok = await vscode.workspace.applyEdit(edit); } catch (e) { this.log(`applyEdit threw: ${String(e)}`); }
    s.applying = null;
    if (own.acked) {
      // Our own change event was seen and acknowledged. A false result after that changes nothing.
    } else if (ok && doc.version === base) {
      // VS Code made no change (the edit equalled the text). Confirm at the same version.
      this.post(s, { type: 'ack', version: base });
    } else if (ok) {
      // Applied, but its event was not recognised as ours (other changes interleaved): the webview gets
      // those as remote changes and rebases; resync (which rebases pending edits too) settles any doubt.
      this.resync(s, doc, 'applied without own event');
    } else {
      // Rejected (VS Code says the document changed in the meantime). Nothing was applied. If a newer
      // version is on its way the webview rebases and resends by itself; otherwise ask it to resend.
      this.stats.rejected++;
      const n = (s.rejects.get(base) ?? 0) + 1;
      s.rejects.set(base, n);
      this.log(`applyEdit rejected (base ${base}, document ${doc.version}, attempt ${n})`);
      if (n > 5) this.resync(s, doc, 'edit repeatedly rejected');
      else this.post(s, { type: 'retry', version: base });
    }
    s.edited.fire();
  }

  /** Is this change event the one our own pending edit produced (same ranges and text)? */
  private isOwn(e: vscode.TextDocumentChangeEvent, expect: NonNullable<Session['applying']>['expect']): boolean {
    if (e.contentChanges.length !== expect.length) return false;
    const mine = [...e.contentChanges].sort((x, y) => x.rangeOffset - y.rangeOffset);
    const want = [...expect].sort((x, y) => x.fromLine - y.fromLine || x.fromCh - y.fromCh);
    return mine.every((c, i) => c.range.start.line === want[i].fromLine && c.range.start.character === want[i].fromCh && c.range.end.line === want[i].toLine && c.range.end.character === want[i].toCh && c.text.replace(/\r\n?/g, '\n') === want[i].text);
  }

  private onDocChanged(e: vscode.TextDocumentChangeEvent): void {
    if (!e.contentChanges.length) return; // dirty-state change only
    const key = e.document.uri.toString();
    for (const s of this.sessions.get(key) ?? []) {
      if (!s.ready) continue;
      const v = e.document.version;
      if (s.applying && !s.applying.acked && v === s.applying.base + 1 && this.isOwn(e, s.applying.expect)) {
        s.applying.acked = true; s.version = v;
        this.post(s, { type: 'ack', version: v });
        continue;
      }
      if (v !== s.version + 1) { this.resync(s, e.document, 'version gap'); continue; }
      s.version = v;
      this.post(s, {
        type: 'remote', base: v - 1, version: v,
        changes: e.contentChanges.map((c) => ({ fromLine: c.range.start.line, fromCh: c.range.start.character, toLine: c.range.end.line, toCh: c.range.end.character, insert: c.text })),
      });
    }
  }

  /** One-time (per file per session) notice when the file on disk mixes \n and \r\n. Read-only: never touches the file. */
  private async noticeMixedEol(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    if (uri.scheme !== 'file' || this.eolNotified.has(key)) return;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      let crlf = 0, lf = 0;
      for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) { if (i > 0 && bytes[i - 1] === 13) crlf++; else lf++; }
      if (crlf === 0 || lf === 0) return;
      this.eolNotified.add(key);
      void vscode.window.showInformationMessage(`Inkwell: ${path.basename(uri.fsPath)} mixes Windows (CRLF) and Unix (LF) line endings. Saving after an edit will make them consistent: that is VS Code's own behaviour.`);
    } catch { /* unreadable: nothing to report */ }
  }

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const webview = panel.webview;
    // S6: big files go to the plain text editor, CodeMirror is never loaded.
    if (Buffer.byteLength(document.getText(), 'utf8') > MAX_BYTES) {
      webview.html = '<!DOCTYPE html><html><body>This file is larger than 2 MB and opens in the plain text editor.</body></html>';
      void vscode.window.showInformationMessage(`Inkwell: ${path.basename(document.uri.fsPath)} is larger than 2 MB, so it opens in the plain text editor.`);
      void (async () => {
        await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
        panel.dispose();
      })();
      return;
    }
    void this.noticeMixedEol(document.uri);
    const docDir = vscode.Uri.joinPath(document.uri, '..');
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(this.dist), docDir, ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri)],
    };
    const key = document.uri.toString();
    const session: Session = { webview, ready: false, version: -1, applying: null, edited: new vscode.EventEmitter<void>(), inChain: Promise.resolve(), outChain: Promise.resolve(), outBusy: 0, inBusy: 0, rejects: new Map() };
    if (!this.sessions.has(key)) this.sessions.set(key, new Set());
    this.sessions.get(key)!.add(session);
    const baseUri = webview.asWebviewUri(docDir).toString() + '/';
    const nonce = crypto.randomUUID().replace(/-/g, '');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(vscode.Uri.file(this.dist), 'webview.js'));
    webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src 'unsafe-inline'; font-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style id="theme"></style></head>
<body class="crossnote"><div id="root"></div>
<script nonce="${nonce}" src="${script}"></script></body></html>`;

    const sendTheme = () => webview.postMessage({ type: 'theme', css: this.themeCss(), themes: listThemes(this.dist), current: vscode.workspace.getConfiguration('inkwell').get<string>('previewTheme', STYLE_AUTO) });
    if (panel.active) this.activeSession = session;

    const subs: vscode.Disposable[] = [
      webview.onDidReceiveMessage((m: { type: string; [k: string]: unknown }) => {
        switch (m.type) {
          case 'ready': {
            session.ready = true; session.version = document.version;
            void sendTheme();
            void webview.postMessage({ type: 'init', text: document.getText(), version: document.version, baseUri });
            const f = this.pending.get(key);
            if (f) { this.pending.delete(key); void webview.postMessage({ type: 'scroll', fragment: f }); }
            (this.readyWaiters.get(key) ?? []).forEach((r) => r());
            this.readyWaiters.delete(key);
            break;
          }
          case 'edit': this.inbound(session, () => { if (session.ready) void this.handleEdit(session, document, m as { base?: unknown; changes?: unknown }); }); break;
          case 'needResync': this.inbound(session, () => { if (session.ready) this.resync(session, document, `webview asked: ${String(m.reason)}`); }); break;
          case 'notice': if (typeof m.text === 'string') void vscode.window.showInformationMessage(`Inkwell: ${m.text}`); break;
          case 'log': this.log(`webview: ${String(m.text)}`); break;
          case 'openAsText': void vscode.commands.executeCommand('inkwell.openAsText', document.uri); break;
          case 'setTheme':
            if (typeof m.value === 'string' && (m.value === STYLE_AUTO || listThemes(this.dist).includes(m.value))) void vscode.workspace.getConfiguration('inkwell').update('previewTheme', m.value, vscode.ConfigurationTarget.Global);
            break;
          case 'undo': void vscode.commands.executeCommand('undo'); break;
          case 'redo': void vscode.commands.executeCommand('redo'); break;
          case 'openLink':
            if (typeof m.href === 'string') void openLink(document.uri, m.href, (u, frag) => this.scrollTo(u, frag));
            break;
          case 'debugReply': { const f = this.asks.get(m.id as number); if (f) { this.asks.delete(m.id as number); f(m as DebugReply); } break; }
        }
      }),
      panel.onDidChangeViewState((e) => { if (e.webviewPanel.active) this.activeSession = session; else if (this.activeSession === session) this.activeSession = undefined; }),
      vscode.window.onDidChangeActiveColorTheme(sendTheme),
      vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('inkwell.previewTheme')) void sendTheme(); }),
    ];
    panel.onDidDispose(() => { if (this.activeSession === session) this.activeSession = undefined; subs.forEach((s) => s.dispose()); session.edited.dispose(); this.sessions.get(key)?.delete(session); });
  }
}

function activeResource(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as { uri?: vscode.Uri } | undefined;
  return input?.uri ?? vscode.window.activeTextEditor?.document.uri;
}

// Inkwell opens .md files by default through the custom editor's own "default" priority
// (package.json), which needs no settings. This explicit command is the switch for the other direction:
// OFF writes workbench.editorAssociations (*.md -> the text editor), ON removes the entries it wrote.
async function toggleOpenByDefault(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('inkwell');
  const next = !cfg.get<boolean>('openByDefault', true);
  const wb = vscode.workspace.getConfiguration('workbench');
  const assoc = { ...(wb.get<Record<string, string>>('editorAssociations') ?? {}) };
  for (const pat of ['*.md', '*.markdown']) {
    if (next) { if (assoc[pat] === 'default' || assoc[pat] === VIEW_TYPE) delete assoc[pat]; }
    else assoc[pat] = 'default';
  }
  await wb.update('editorAssociations', assoc, vscode.ConfigurationTarget.Global);
  await cfg.update('openByDefault', next, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(`Inkwell: open by default is now ${next ? 'ON' : 'OFF'}.`);
}

async function choosePageStyle(dist: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('inkwell');
  const current = cfg.get<string>('previewTheme', STYLE_AUTO);
  const items: Array<vscode.QuickPickItem & { value: string }> = [
    { label: 'Auto', description: 'follow the VS Code colour theme', value: STYLE_AUTO },
    ...listThemes(dist).map((f) => ({ label: f.replace(/\.css$/, ''), value: f })),
  ].map((i) => ({ ...i, picked: i.value === current, detail: i.value === current ? 'current' : undefined }));
  const pick = await vscode.window.showQuickPick(items, { title: 'Inkwell: Choose page style', placeHolder: `Current: ${current}` });
  if (pick) await cfg.update('previewTheme', pick.value, vscode.ConfigurationTarget.Global);
}

const FORMAT_ACTIONS = ['bold', 'italic', 'strike', 'link', 'code', 'bullets', 'numbered', 'checklist', 'quote', 'h1', 'h2', 'h3', 'h0', 'codeblock', 'highlight', 'textcolor'];
const toUri = (u: vscode.Uri | string): vscode.Uri => (typeof u === 'string' ? vscode.Uri.file(u) : u);

function registerDebugCommands(ctx: vscode.ExtensionContext, p: InkwellProvider): void {
  const need = (u: vscode.Uri | string): { uri: vscode.Uri; s: Session } => {
    const uri = toUri(u); const s = p.firstSession(uri);
    if (!s) throw new Error('no Inkwell webview for ' + uri.fsPath);
    return { uri, s };
  };
  ctx.subscriptions.push(
    vscode.commands.registerCommand('inkwell._debugWhenReady', (u: vscode.Uri | string) => p.whenReady(toUri(u))),
    vscode.commands.registerCommand('inkwell._debugSessionCount', (u: vscode.Uri | string) => p.sessionCount(toUri(u))),
    vscode.commands.registerCommand('inkwell._debugGetWebviewText', async (u: vscode.Uri | string) =>
      ((await p.ask(need(u).s, 'debugQuery')) as { text: string }).text),
    vscode.commands.registerCommand('inkwell._debugGetColours', async (u: vscode.Uri | string) => p.ask(need(u).s, 'debugQuery')),
    vscode.commands.registerCommand('inkwell._debugMoveCursor', async (u: vscode.Uri | string, line: number, ch = 0) => { await p.ask(need(u).s, 'debugCursor', { line, ch }); }),
    vscode.commands.registerCommand('inkwell._debugClickCheckbox', async (u: vscode.Uri | string, index: number) => { await p.ask(need(u).s, 'debugCheckbox', { index }); }),
    vscode.commands.registerCommand('inkwell._debugGetDom', async (u: vscode.Uri | string) => p.ask(need(u).s, 'debugDom')),
    vscode.commands.registerCommand('inkwell._debugEolNotified', (u: vscode.Uri | string) => p.eolNotified.has(toUri(u).toString())),
    vscode.commands.registerCommand('inkwell._debugGetBodyBackground', async (u: vscode.Uri | string) =>
      ((await p.ask(need(u).s, 'debugQuery')) as { bodyBg: string }).bodyBg),
    // Makes a real CodeMirror transaction in the webview; resolves once the extension has applied it.
    vscode.commands.registerCommand('inkwell._debugAction', async (u: vscode.Uri | string, name: string, arg?: string) => { await p.ask(need(u).s, 'debugAction', { name, arg }); }),
    vscode.commands.registerCommand('inkwell._debugSetLatency', (ms: number) => { p.latencyMax = ms; }),
    vscode.commands.registerCommand('inkwell._debugStats', () => p.stats),
    vscode.commands.registerCommand('inkwell._debugResetStats', () => { p.stats.resyncs = 0; p.stats.staleDrops = 0; p.stats.rejected = 0; p.stats.resyncReasons = []; }),
    vscode.commands.registerCommand('inkwell._debugAsk', async (u: vscode.Uri | string, type: string, extra?: object) => p.ask(need(u).s, type, extra ?? {})),
    vscode.commands.registerCommand('inkwell._debugApplyWebviewEdit', async (u: vscode.Uri | string, change: object) => {
      await p.ask(need(u).s, 'debugEdit', { change });
    }),
  );
}

export function activate(ctx: vscode.ExtensionContext): void {
  const provider = new InkwellProvider(ctx);
  if (ctx.extensionMode === vscode.ExtensionMode.Test) registerDebugCommands(ctx, provider);
  ctx.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    ...['inkwell.open', 'inkwell.openInEditor'].map((id) =>
      vscode.commands.registerCommand(id, async (uri?: vscode.Uri) => {
        const target = uri ?? activeResource();
        if (target) await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
      })),
    vscode.commands.registerCommand('inkwell.openAsText', async (uri?: vscode.Uri) => {
      const target = uri ?? activeResource();
      if (target) await vscode.commands.executeCommand('vscode.openWith', target, 'default');
    }),
    vscode.commands.registerCommand('inkwell.toggle', async (uri?: vscode.Uri) => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      const inInkwell = input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE;
      const target = uri ?? activeResource();
      if (target) await vscode.commands.executeCommand('vscode.openWith', target, inInkwell ? 'default' : VIEW_TYPE);
    }),
    vscode.commands.registerCommand('inkwell.toggleOpenByDefault', toggleOpenByDefault),
    ...FORMAT_ACTIONS.map((a) => vscode.commands.registerCommand(`inkwell.format.${a}`, () => provider.format(a))),
    vscode.commands.registerCommand('inkwell.choosePageStyle', () => choosePageStyle(path.join(ctx.extensionPath, 'dist'))),
  );
}

export function deactivate(): void {}
