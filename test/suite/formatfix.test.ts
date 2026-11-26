// Formatting bug family: the editor and table cells share one implementation (format.ts), so mixed selections, partial overlaps,
// inline HTML, links and nested colours behave the same in both, Word-style.
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { closeTab, openLive, rmDir, tmpDir } from './helpers';

const cmd = <T>(c: string, ...a: unknown[]) => vscode.commands.executeCommand<T>(c, ...a);
const ask = <T = any>(u: vscode.Uri, type: string, extra: object = {}) => cmd<T>('inkwell._debugAsk', u, type, extra);
const act = (u: vscode.Uri, name: string, arg?: string) => cmd('inkwell._debugAction', u, name, arg);
const sel = (u: vscode.Uri, fl: number, fc: number, tl: number, tc: number) => ask(u, 'debugSelect', { fromLine: fl, fromCh: fc, toLine: tl, toCh: tc });
const RED = '#d73a49', YEL = 'rgba(255,212,0,0.35)';

suite('Formatting fixes: editor', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  let n = 0;
  /** Opens `text`, selects the first occurrence of `pick` (or the whole first line), runs the actions, returns the text after each. */
  async function run(text: string, pick: string | [number, number], steps: Array<[string, string?]>): Promise<string[]> {
    const file = path.join(tmp, `f${++n}.md`); fs.writeFileSync(file, text);
    const { uri, doc } = await openLive(file);
    const [a, b] = typeof pick === 'string' ? [text.indexOf(pick), text.indexOf(pick) + pick.length] : pick;
    await sel(uri, 0, a, 0, b);
    const out: string[] = [];
    for (const [s, arg] of steps) { await act(uri, s, arg); out.push(doc.getText()); }
    await closeTab(file);
    return out;
  }
  const P = 'Plain words and **bold words** and *italic words*\n';

  test('7: Italic over a mixed selection italicises all of it (merging inner italics); a second press removes it', async () => {
    const [a, b] = await run(P, 'Plain words and **bold words** and *italic words*', [['italic'], ['italic']]);
    assert.strictEqual(a, '*Plain words and* ***bold words*** *and italic words*\n');
    assert.strictEqual(b, 'Plain words and **bold words** and italic words\n');
  });
  test('7: Bold over a mixed selection merges the inner bold', async () => {
    const [a, b] = await run(P, 'Plain words and **bold words** and *italic words*', [['bold'], ['bold']]);
    assert.strictEqual(a, '**Plain words and bold words and *italic words***\n');
    assert.strictEqual(b, 'Plain words and bold words and *italic words*\n');
  });
  test('7: plain text plus a bold word', async () => {
    const [a] = await run('plain **bold** tail\n', 'plain **bold**', [['bold']]);
    assert.strictEqual(a, '**plain bold** tail\n');
  });
  test('8: a selection that ends inside a bold run bolds the whole selection and never touches unselected text', async () => {
    const [a, b] = await run('and **bold** end\n', 'and **bo', [['bold'], ['bold']]);
    assert.strictEqual(a, '**and bold** end\n');
    assert.strictEqual(b, 'and bo**ld** end\n', 'the second press clears only the selected part');
  });
  test('8: a selection that starts inside a bold run extends it forwards', async () => {
    const [a] = await run('x **bold** and more\n', 'ld** and', [['bold']]);
    assert.strictEqual(a, 'x **bold and** more\n');
  });
  test('8: un-bolding the start of a bold run keeps the rest bold', async () => {
    const [a] = await run('**bold word**\n', '**bold', [['bold']]);
    assert.strictEqual(a, 'bold **word**\n');
  });
  test('8: un-bolding the middle of a bold run splits it', async () => {
    const [a] = await run('**one two three**\n', 'two', [['bold']]);
    assert.strictEqual(a, '**one** two **three**\n');
  });
  test('8: neighbouring runs merge instead of producing ****', async () => {
    const [a] = await run('**a**b\n', 'b', [['bold']]);
    assert.strictEqual(a, '**ab**\n');
  });
  test('9: Bold inside <b>/<strong> removes the tags; Italic inside <i>/<em>; strike inside <s>/<del>/<strike>', async () => {
    for (const [tag, act1] of [['b', 'bold'], ['strong', 'bold'], ['i', 'italic'], ['em', 'italic'], ['s', 'strike'], ['del', 'strike'], ['strike', 'strike']] as const) {
      const [r] = await run(`a <${tag}>word</${tag}> z\n`, 'word', [[act1]]);
      assert.strictEqual(r, 'a word z\n', tag);
    }
  });
  test('9: Bold on plain text next to <b> does not nest ** inside the tag', async () => {
    const [r] = await run('<b>x</b> y\n', 'y', [['bold']]);
    assert.strictEqual(r, '<b>x</b> **y**\n');
  });
  test('nested styles: clear bold from a nested italic, set italic across bold, never crossed marks', async () => {
    assert.deepStrictEqual(await run('**bold *ital* bold**\n', 'ital', [['bold']]), ['**bold** *ital* **bold**\n']);
    assert.deepStrictEqual(await run('*a **b** c*\n', 'b', [['italic']]), ['*a* **b** *c*\n']);
    assert.deepStrictEqual(await run('~~x **y** z~~\n', 'y** z', [['bold']]), ['~~x **y z**~~\n']);
    assert.deepStrictEqual(await run('<b>one</b> two\n', 'one</b> two', [['bold']]), ['**one two**\n']);
    const [r] = await run('**bold *ital* bold**\n', 'bold *it', [['bold']]);
    assert.strictEqual(r.replace(/[*_]/g, ''), 'bold ital bold\n');
  });
  test('6: re-applying the same text colour over text+highlight keeps it (Word), with no crossed tags', async () => {
    const [a, b, c] = await run('Plain words here\n', 'Plain words', [['colour:text', RED], ['colour:highlight', YEL], ['textcolor']]);
    assert.strictEqual(a, `<span style="color:${RED}">Plain words</span> here\n`);
    assert.strictEqual(b, `<span style="color:${RED}"><mark style="background:${YEL}">Plain words</mark></span> here\n`);
    assert.strictEqual(c, b, 'same colour again changes nothing');
  });
  test('6: a partial selection through a nested highlight closes and reopens it, never crossing tags', async () => {
    const src = `<span style="color:${RED}">ab <mark style="background:${YEL}">cd ef</mark> gh</span>\n`;
    const from = src.indexOf('b <mark'), to = src.indexOf('d ef') + 1;
    const [r] = await run(src, [from, to], [['colour:text', '#0366d6']]);
    // Every opening tag is closed in the right order.
    const stack: string[] = [];
    for (const m of r.matchAll(/<(\/?)(span|mark)[^>]*>/g)) { if (m[1]) assert.strictEqual(stack.pop(), m[2], r); else stack.push(m[2]); }
    assert.strictEqual(stack.length, 0, r);
    assert.strictEqual(r.replace(/<[^>]+>/g, ''), 'ab cd ef gh\n');
  });
});

suite('Formatting fixes: table cells', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  let n = 0;
  const HEAD = '| A | B |\n|---|---|\n';
  async function open(cell: string) {
    const file = path.join(tmp, `c${++n}.md`); fs.writeFileSync(file, `${HEAD}| ${cell} | other |\n`);
    const r = await openLive(file);
    return { ...r, file };
  }
  const tbl = (u: vscode.Uri, o: object) => ask(u, 'debugTable', o);
  const cellLine = (doc: vscode.TextDocument) => doc.getText().split('\n')[2];
  /** Select [pick) of the first body cell and run the actions; returns the row text after each. */
  async function run(cell: string, pick: string | [number, number], steps: Array<[string, string?]>): Promise<string[]> {
    const { uri, doc, file } = await open(cell);
    const shown = cell.replace(/<br>/g, '\n');
    const [from, to] = typeof pick === 'string' ? [shown.indexOf(pick), shown.indexOf(pick) + pick.length] : pick;
    const out: string[] = [];
    for (const [action, arg] of steps) { await tbl(uri, { r: 1, c: 0, op: 'format', from, to, action, arg }); out.push(cellLine(doc)); }
    await closeTab(file);
    return out;
  }
  /** Like run, but each step selects `word` in the cell's CURRENT text. */
  async function runEach(cell: string, word: string, steps: Array<[string, string?]>): Promise<string[]> {
    const { uri, doc, file } = await open(cell);
    const out: string[] = [];
    for (const [action, arg] of steps) {
      const cur = cellLine(doc).slice(2).split(' | ')[0];
      const from = cur.indexOf(word);
      await tbl(uri, { r: 1, c: 0, op: 'format', from, to: from + word.length, action, arg });
      out.push(cellLine(doc));
    }
    await closeTab(file);
    return out;
  }
  const M = 'plain **bold** and *ital* end';

  test('1: mixed selection (plain + bold) Bold merges into one run; Italic over mixed nests cleanly', async () => {
    const [a] = await run(M, 'plain **bold**', [['bold']]);
    assert.strictEqual(a, '| **plain bold** and *ital* end | other |');
    const [b] = await run(M, 'plain **bold** and *ital*', [['italic']]);
    assert.strictEqual(b, '| *plain* ***bold*** *and ital* end | other |');
  });
  test('2: partial overlap: Bold over `**bo` of `**bold**` leaves `bo` plain and `ld` bold', async () => {
    const [a] = await run('**bold**', '**bo', [['bold']]);
    assert.strictEqual(a, '| bo**ld** | other |');
  });
  test('2: a selection ending inside a bold run bolds the whole selection', async () => {
    const [a] = await run('and **bold**', 'and **bo', [['bold']]);
    assert.strictEqual(a, '| **and bold** | other |');
  });
  test('3: empty selection in a word bolds the word, and toggles it back', async () => {
    const [a, b] = await run('plain text', [2, 2], [['bold'], ['bold']]);
    assert.strictEqual(a, '| **plain** text | other |');
    assert.strictEqual(b, '| plain text | other |');
  });
  test('4: Link twice toggles off instead of nesting; link inside a link does not nest', async () => {
    const [a, b] = await run('plain text', 'plain', [['link'], ['link']]);
    assert.strictEqual(a, '| [plain](url) text | other |');
    assert.strictEqual(b, '| plain text | other |');
    const [c] = await run('[plain](http://x.io) text', 'plain', [['link']]);
    assert.strictEqual(c, '| plain text | other |');
  });
  test('5: "No colour" removes the text colour even when a highlight is nested, and the highlight alone likewise', async () => {
    const [a, b, c, d] = await runEach('word here', 'word', [['colour:text', RED], ['colour:highlight', YEL], ['colour:text', 'none'], ['colour:highlight', 'none']]);
    assert.strictEqual(a, `| <span style="color:${RED}">word</span> here | other |`);
    assert.strictEqual(b, `| <span style="color:${RED}"><mark style="background:${YEL}">word</mark></span> here | other |`);
    assert.strictEqual(c, `| <mark style="background:${YEL}">word</mark> here | other |`);
    assert.strictEqual(d, '| word here | other |');
  });
  test('5: re-applying the same text colour in a cell keeps it (Word)', async () => {
    const [, b, c] = await runEach('word here', 'word', [['colour:text', RED], ['colour:highlight', YEL], ['colour:text', RED]]);
    assert.strictEqual(c, b, 'same colour again changes nothing');
  });
  test('9: Bold inside <b> in a cell removes the tags; Italic inside <i>; strike inside <del>', async () => {
    assert.deepStrictEqual(await run('<b>B1</b> x', 'B1', [['bold']]), ['| B1 x | other |']);
    assert.deepStrictEqual(await run('<i>I1</i> x', 'I1', [['italic']]), ['| I1 x | other |']);
    assert.deepStrictEqual(await run('<del>D1</del> x', 'D1', [['strike']]), ['| D1 x | other |']);
  });
  test('12: list actions put the prefix before inline markup, one per line, and are reversible', async () => {
    const [a, b] = await run('**one<br>two**', [0, 0], [['bullets'], ['bullets']]);
    assert.strictEqual(a, '| - **one**<br>- **two** | other |');
    assert.strictEqual(b, '| **one**<br>**two** | other |');
    const [c] = await run('a<br>b', [0, 0], [['checklist']]);
    assert.strictEqual(c, '| ☐ a<br>☐ b | other |');
    const [d] = await run('<span style="color:#d73a49">x<br>y</span>', [0, 0], [['numbered']]);
    assert.strictEqual(d, `| 1. <span style="color:#d73a49">x</span><br>2. <span style="color:#d73a49">y</span> | other |`);
  });
  test('10: toolbar state follows the caret inside a cell', async () => {
    const { uri, file } = await open('**bold** and *it* x');
    const on = async (at: number) => (await tbl(uri, { r: 1, c: 0, op: 'toolbar', at })) as { bold: boolean; italic: boolean };
    const b = await on(4), i = await on(15), p = await on(19);
    assert.deepStrictEqual([b.bold, b.italic], [true, false]);
    assert.deepStrictEqual([i.bold, i.italic], [false, true]);
    assert.deepStrictEqual([p.bold, p.italic], [false, false]);
    await closeTab(file);
  });
  test('each cell format action is one undo step', async () => {
    const { uri, doc, file } = await open('plain text');
    await tbl(uri, { r: 1, c: 0, op: 'format', from: 0, to: 5, action: 'bold' });
    await tbl(uri, { r: 1, c: 0, op: 'format', from: 2, to: 7, action: 'italic' });
    assert.strictEqual(cellLine(doc), '| ***plain*** text | other |');
    await cmd('inkwell.undo'); await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(cellLine(doc), '| **plain** text | other |');
    await closeTab(file);
  });
});

suite('Formatting fixes: floating table bar', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  test('11: with the last row focused, the bar does not cover the row above it', async () => {
    const file = path.join(tmp, 'bar.md');
    fs.writeFileSync(file, '# T\n\n| H | V |\n|---|---|\n| a | 1 |\n| b | 2 |\n| c | 3 |\n\nend\n');
    const { uri } = await openLive(file);
    for (const row of [3, 2]) {
      const x = await ask<any>(uri, 'debugTable', { r: row, c: 0, op: 'barRect' });
      assert.ok(x.bar && !x.hidden, 'bar visible');
      const clear = (rc: any) => !rc || x.bar.bottom <= rc.top || x.bar.top >= rc.bottom;
      assert.ok(clear(x.row) && clear(x.prev), JSON.stringify(x));
    }
    await closeTab(file);
  });
});

// ---- property test: bold / italic / strike against the Markdown parser as oracle ----
suite('Formatting fixes: per-character style model (property test)', () => {
  // format.ts is bundled for node on the fly, together with the CodeMirror classes it needs (one copy, so instanceof checks hold).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const esbuild = require('esbuild') as typeof import('esbuild');
  const root = path.resolve(__dirname, '../../..');
  const out = esbuild.buildSync({
    stdin: {
      contents: "export * from './src/webview/format'; export { EditorState, EditorSelection } from '@codemirror/state'; export { markdown, markdownLanguage } from '@codemirror/lang-markdown'; export { ensureSyntaxTree, syntaxTree } from '@codemirror/language';",
      resolveDir: root, loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
  }).outputFiles[0].text;
  const mod: any = { exports: {} };
  new Function('module', 'exports', 'require', out)(mod, mod.exports, require);
  const L = mod.exports;
  const KINDS = ['strike', 'bold', 'italic'] as const;
  const NODE: Record<string, [string, string]> = { strike: ['Strikethrough', 'StrikethroughMark'], bold: ['StrongEmphasis', 'EmphasisMark'], italic: ['Emphasis', 'EmphasisMark'] };

  const mk = (doc: string, a?: number, b?: number) => {
    const st = L.EditorState.create({ doc, selection: a === undefined ? undefined : L.EditorSelection.single(a, b), extensions: [L.markdown({ base: L.markdownLanguage })] });
    L.ensureSyntaxTree(st, st.doc.length, 5000);
    return st;
  };
  /** Visible characters (marker characters dropped) with their flags, read straight from the syntax tree. */
  const visible = (doc: string) => {
    const st = mk(doc);
    const mark = new Array(doc.length).fill(false);
    const flag: boolean[][] = Array.from({ length: doc.length }, () => [false, false, false]);
    const open: Record<string, any[]> = {};
    const TAGS: Record<string, number> = { s: 0, del: 0, strike: 0, b: 1, strong: 1, i: 2, em: 2 };
    L.syntaxTree(st).iterate({
      enter(n: any) {
        if (n.name === 'HTMLTag') {
          const m = /^<(\/?)([a-z]+)>$/.exec(doc.slice(n.from, n.to));
          if (!m || !(m[2] in TAGS)) return;
          const stack = (open[m[2]] ??= []);
          if (!m[1]) { stack.push({ from: n.from, to: n.to }); return; }
          const o = stack.pop(); if (!o) return;
          for (let p = o.from; p < o.to; p++) mark[p] = true;
          for (let p = n.from; p < n.to; p++) mark[p] = true;
          for (let p = o.to; p < n.from; p++) flag[p][TAGS[m[2]]] = true;
          return;
        }
        KINDS.forEach((k, i) => {
          if (n.name !== NODE[k][0]) return;
          const ms = n.node.getChildren(NODE[k][1]);
          if (ms.length < 2) return;
          for (const m of ms) for (let p = m.from; p < m.to; p++) mark[p] = true;
          for (let p = ms[0].to; p < ms[ms.length - 1].from; p++) flag[p][i] = true;
        });
      },
    });
    const chars: Array<{ c: string; pos: number; f: boolean[] }> = [];
    for (let p = 0; p < doc.length; p++) if (!mark[p]) chars.push({ c: doc[p], pos: p, f: flag[p] });
    return chars;
  };

  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const word = () => Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick([...'abcdefgh'])).join('');
  const gen = (depth: number): string => {
    const n = 1 + Math.floor(rnd() * 3);
    let s = '';
    for (let i = 0; i < n; i++) {
      if (i) s += rnd() < 0.8 ? ' ' : '';
      if (depth > 0 && rnd() < 0.55) { const m = pick(['**', '*', '~~']); s += m + gen(depth - 1) + m; } else s += word();
    }
    return s;
  };
  const sameFlags = (a: boolean[], b: boolean[]) => a.every((x, i) => x === b[i]);
  const showCase = (c: object) => JSON.stringify(c);

  test('2000 random documents: every action sets/clears exactly the selected characters and nothing else', () => {
    let done = 0, noop = 0;
    for (let iter = 0; done < 2000 && iter < 20000; iter++) {
      const doc = gen(3);
      const before = visible(doc);
      const plain = before.map((x) => x.c).join('');
      if (plain !== doc.replace(/\*\*|\*|~~/g, '') || /[*~]/.test(plain)) continue; // generator produced something that is not valid nesting
      const r = rnd();
      let a = Math.floor(rnd() * (doc.length + 1)), b = r < 0.12 ? a : Math.floor(rnd() * (doc.length + 1));
      if (a > b) [a, b] = [b, a];
      const k = pick(KINDS), ki = KINDS.indexOf(k);
      const st = mk(doc, a, b);
      if (a === b && !st.wordAt(a)) continue; // no word under the cursor: that case inserts an empty pair, tested elsewhere
      const tr = st.update(L.toggleInline(st, k));
      const res = tr.newDoc.toString();
      const after = visible(res);
      const fail = (why: string) => assert.fail(`${why}\n${showCase({ doc, sel: [a, b], kind: k, result: res })}`);
      if (after.map((x) => x.c).join('') !== plain) fail('visible text changed');
      // expected flags
      let selected: number[];
      if (a === b) {
        const w = st.wordAt(a)!;
        selected = before.map((x, i) => (x.pos >= w.from && x.pos < w.to ? i : -1)).filter((i) => i >= 0);
        if (selected.length && selected.every((i) => before[i].f[ki])) { // the whole run the word is part of
          let lo = selected[0], hi = selected[selected.length - 1];
          while (lo > 0 && before[lo - 1].f[ki]) lo--;
          while (hi < before.length - 1 && before[hi + 1].f[ki]) hi++;
          selected = []; for (let i = lo; i <= hi; i++) selected.push(i);
        }
      } else selected = before.map((x, i) => (x.pos >= a && x.pos < b ? i : -1)).filter((i) => i >= 0);
      const core = selected.filter((i) => !/\s/.test(before[i].c));
      if (!core.length) { if (res !== doc) fail('changed with nothing selected'); noop++; done++; continue; }
      const all = core.every((i) => before[i].f[ki]);
      before.forEach((x, i) => {
        if (/\s/.test(x.c)) return; // whitespace carries no visible style
        const want = x.f.slice();
        if (selected.includes(i)) want[ki] = !all;
        if (!sameFlags(want, after[i].f)) fail(`char #${i} '${x.c}' flags ${JSON.stringify(after[i].f)} expected ${JSON.stringify(want)}`);
      });
      // the selection still covers the same text
      const ns = tr.newSelection.main;
      const was = before.filter((x) => x.pos >= a && x.pos < b && !/\s/.test(x.c)).map((x) => x.c).join('');
      const now = after.filter((x) => x.pos >= ns.from && x.pos < ns.to && !/\s/.test(x.c)).map((x) => x.c).join('');
      if (a !== b && was !== now) fail(`selection moved: "${was}" -> "${now}"`);
      // applying the same action again restores the flags it just cleared (or clears what it just set)
      const st2 = mk(res, ns.anchor, ns.head);
      const res2 = st2.update(L.toggleInline(st2, k)).newDoc.toString();
      const again = visible(res2);
      if (again.map((x) => x.c).join('') !== plain) fail('second press changed the text');
      if (a !== b && all) before.forEach((x, i) => { if (!/\s/.test(x.c) && selected.includes(i) && again[i].f[ki] !== true) fail(`second press did not restore char #${i}`); });
      done++;
    }
    assert.ok(done >= 2000, 'generated enough valid cases: ' + done);
    assert.ok(noop < done / 2);
  });
});
