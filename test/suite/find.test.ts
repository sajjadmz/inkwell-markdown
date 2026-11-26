// F5: in-page Find and Replace. The first suites run the search / replace code (src/webview/findcore.ts) directly in Node against
// the Markdown parser; the last ones drive the real find bar in the real webview.
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { closeTab, openLive, rmDir, tmpDir, waitUntil } from './helpers';

// findcore.ts is bundled for node on the fly, with the CodeMirror classes it needs (one copy, so instanceof checks hold).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const esbuild = require('esbuild') as typeof import('esbuild');
const root = path.resolve(__dirname, '../../..');
const bundle = esbuild.buildSync({
  stdin: {
    contents: "export * from './src/webview/findcore'; export { EditorState } from '@codemirror/state'; export { markdown, markdownLanguage } from '@codemirror/lang-markdown'; export { ensureSyntaxTree, syntaxTree } from '@codemirror/language';",
    resolveDir: root, loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
}).outputFiles[0].text;
const mod: any = { exports: {} };
new Function('module', 'exports', 'require', bundle)(mod, mod.exports, require);
const L = mod.exports;

const mk = (doc: string) => {
  const st = L.EditorState.create({ doc, extensions: [L.markdown({ base: L.markdownLanguage }), L.findField] });
  L.ensureSyntaxTree(st, st.doc.length, 5000);
  return st;
};
const O = { matchCase: false, wholeWord: false };
/** The visible text of a document. */
const visibleOf = (doc: string): string => L.buildVisible(mk(doc)).text;
/** The text of every match of `q`. */
const hits = (doc: string, q: string, o: Partial<typeof O> = {}): string[] => {
  const v = L.buildVisible(mk(doc));
  return L.findMatches(v, q, { ...O, ...o }).map((m: any) => v.text.slice(m.s, m.e));
};
/** Replace match number `n` (default the first). Null when the replacement is refused. */
const replace1 = (doc: string, q: string, r: string, n = 0, o: Partial<typeof O> = {}): string | null => {
  const st = mk(doc); const v = L.buildVisible(st);
  const ms = L.findMatches(v, q, { ...O, ...o });
  const e = L.replaceOne(st, v, ms[n], r);
  return e ? st.update({ changes: e }).state.doc.toString() : null;
};
const replaceEvery = (doc: string, q: string, r: string, o: Partial<typeof O> = {}): { doc: string; applied: number; skipped: number } => {
  const st = mk(doc); const v = L.buildVisible(st);
  const res = L.replaceAll(st, v, L.findMatches(v, q, { ...O, ...o }), r);
  return { doc: res.edits.length ? st.update({ changes: res.edits }).state.doc.toString() : doc, applied: res.applied, skipped: res.skipped };
};

suite('Find: what is searched', () => {
  test('Markdown markers are not part of the text: "two months" matches "**two** months"', () => {
    assert.deepStrictEqual(hits('A **two** months here\n', 'two months'), ['two months']);
    assert.deepStrictEqual(hits('A *two* months, ~~two~~ months, ***two*** months\n', 'two months').length, 3);
    assert.deepStrictEqual(hits('**tw**o mon*th*s\n', 'two months'), ['two months']);
  });
  test('bold, italic, strike, code: the text counts, the markers do not', () => {
    assert.strictEqual(visibleOf('a **b** *c* ~~d~~ `e`\n'), 'a b c d e\n');
    assert.deepStrictEqual(hits('x `two months` y\n', 'two months'), ['two months']);
    assert.deepStrictEqual(hits('x **bold**\n', '**'), []);
    assert.deepStrictEqual(hits('x `a*b` y\n', 'a*b'), ['a*b']);
  });
  test('link text is searched, the address and title are not', () => {
    const d = 'See [the docs](https://example.com/needle "needle title") now\n';
    assert.deepStrictEqual(hits(d, 'the docs'), ['the docs']);
    assert.deepStrictEqual(hits(d, 'needle'), []);
    assert.deepStrictEqual(hits(d, 'example'), []);
    assert.deepStrictEqual(hits('[ab][ref]\n\n[ref]: http://needle.example\n', 'needle'), []);
    assert.deepStrictEqual(hits('<http://needle.example>\n', 'needle'), []);
  });
  test('HTML tags and their attributes are not searched; the text between them is', () => {
    assert.strictEqual(visibleOf('x <b>bold</b> y <span style="color:#d73a49">red</span> z\n'), 'x bold y red z\n');
    assert.deepStrictEqual(hits('<span style="color:#d73a49">red</span>\n', 'color'), []);
    assert.deepStrictEqual(hits('<span style="color:#d73a49">red</span>\n', 'span'), []);
    assert.deepStrictEqual(hits('<div class="needle">hi</div>\n', 'needle'), []);
    assert.deepStrictEqual(hits('<div class="needle">hi there</div>\n', 'hi there'), ['hi there']);
    assert.deepStrictEqual(hits('a <mark style="background:rgba(255,212,0,0.35)">two</mark> months\n', 'two months'), ['two months']);
  });
  test('escapes: a backslash escape is one character', () => {
    assert.strictEqual(visibleOf('a \\*not bold\\* b\n'), 'a *not bold* b\n');
    assert.deepStrictEqual(hits('a \\*not bold\\* b\n', '*not bold*'), ['*not bold*']);
    assert.deepStrictEqual(hits('a \\*not bold\\* b\n', '\\'), []);
  });
  test('headings, quotes, lists, tasks, setext headings: markers are not text', () => {
    assert.strictEqual(visibleOf('## Head **x** ##\n\n> quote\n> more\n\n- [ ] task\n- item\n\n1. num\n\nSet\n===\n'), 'Head x\nquote\nmore\ntask\nitem\nnum\nSet\n');
    assert.deepStrictEqual(hits('- [x] done\n', '[x]'), []);
    assert.deepStrictEqual(hits('1. num\n', '1.'), []);
    assert.deepStrictEqual(hits('> quote\n', '>'), []);
    assert.deepStrictEqual(hits('Set\n===\n', '==='), []);
  });
  test('front matter is never searched; the text after it is', () => {
    const d = '---\ntitle: secret needle\n---\n\nneedle in body\n';
    assert.deepStrictEqual(hits(d, 'needle'), ['needle']);
    assert.deepStrictEqual(hits(d, 'secret'), []);
  });
  test('images: neither the address nor the alt text is searched', () => {
    assert.deepStrictEqual(hits('![needle alt](images/needle.png)\n', 'needle'), []);
  });
  test('code blocks are searched (tags inside them are plain text); a rendered mermaid diagram is not', () => {
    assert.deepStrictEqual(hits('```js\nlet <b>needle</b> = 1\n```\n', '<b>needle</b>'), ['<b>needle</b>']);
    assert.deepStrictEqual(hits('```mermaid\ngraph TD\nneedle --> b\n```\n', 'needle'), []);
    assert.deepStrictEqual(hits('    indented needle\n', 'indented needle'), ['indented needle']);
  });
  test('a match never spans paragraphs, lines, headings, cells or a <br>', () => {
    assert.deepStrictEqual(hits('one\n\ntwo\n', 'one two'), []);
    assert.deepStrictEqual(hits('# one\ntwo\n', 'one two'), []);
    assert.deepStrictEqual(hits('one\ntwo\n', 'one two'), []);
    assert.deepStrictEqual(hits('one<br>two\n', 'one two'), []);
    assert.deepStrictEqual(hits('one<br>two\n', 'onetwo'), []);
    assert.deepStrictEqual(hits('| a | b |\n| - | - |\n| one | two |\n', 'one two'), []);
    assert.deepStrictEqual(hits('| a | b |\n| - | - |\n| one | two |\n', 'onetwo'), []);
  });
  test('table cells: header and body text count, the delimiter row and the pipes do not', () => {
    const d = '| Head **one** | b\\|c |\n| :-- | --: |\n| x `y` | two<br>lines |\n';
    assert.strictEqual(visibleOf(d), 'Head one\nb|c\nx y\ntwo\nlines\n');
    assert.deepStrictEqual(hits(d, 'head one'), ['Head one']);
    assert.deepStrictEqual(hits(d, 'b|c'), ['b|c']);
    assert.deepStrictEqual(hits(d, ':--'), []);
    assert.deepStrictEqual(hits(d, 'two lines'), []);
    assert.deepStrictEqual(hits(d, 'lines'), ['lines']);
  });
  test('empty query and a query with nothing in the text find nothing', () => {
    assert.deepStrictEqual(hits('abc\n', ''), []);
    assert.deepStrictEqual(hits('abc\n', 'zzz'), []);
  });
});

suite('Find: case, whole words, counts', () => {
  test('case is ignored unless "Match case" is on', () => {
    assert.strictEqual(hits('Two two TWO tWo\n', 'two').length, 4);
    assert.deepStrictEqual(hits('Two two TWO tWo\n', 'two', { matchCase: true }), ['two']);
    assert.deepStrictEqual(hits('Straße STRASSE\n', 'straße'), ['Straße']);
  });
  test('whole words: not inside longer words, punctuation is a boundary', () => {
    assert.deepStrictEqual(hits('cat concatenate cat. (cat) cats\n', 'cat', { wholeWord: true }).length, 3);
    assert.strictEqual(hits('cat concatenate cat. (cat) cats\n', 'cat').length, 5);
    assert.deepStrictEqual(hits('snake_case case\n', 'case', { wholeWord: true }), ['case']);
    assert.deepStrictEqual(hits('**ca**t and ca\n', 'cat', { wholeWord: true }), ['cat']);
    assert.deepStrictEqual(hits('a.b a.bc\n', 'a.b', { wholeWord: true }).length, 1);
  });
  test('matches do not overlap', () => { assert.strictEqual(hits('aaaa\n', 'aa').length, 2); });
  test('counts: every kind of place is counted once', () => {
    const d = 'two months\n\n**two** months\n\n- two months\n\n| a | two months |\n| - | - |\n| two months | x |\n\n```\ntwo months\n```\n';
    assert.strictEqual(hits(d, 'two months').length, 6);
  });
  test('the query has no line breaks: a pasted newline counts as a space', () => {
    assert.deepStrictEqual(hits('one two\n', 'one\ntwo'), ['one two']);
  });
  test('next and previous wrap around; the position follows the document', () => {
    let st = mk('a x b x c x\n');
    st = st.update({ effects: L.findCfg.of({ active: true, query: 'x', from: 0 }) }).state;
    const f = () => st.field(L.findField);
    assert.strictEqual(f().matches.length, 3); assert.strictEqual(f().cur, 0);
    st = st.update({ effects: L.findCfg.of({ cur: 1 }) }).state; assert.strictEqual(f().cur, 1);
    st = st.update({ effects: L.findCfg.of({ cur: 3 }) }).state; assert.strictEqual(f().cur, 0, 'past the last wraps to the first');
    st = st.update({ effects: L.findCfg.of({ cur: -1 }) }).state; assert.strictEqual(f().cur, 2, 'before the first wraps to the last');
    st = st.update({ changes: { from: 0, insert: 'x ' } }).state;
    assert.strictEqual(f().matches.length, 4, 'typing updates the matches');
    assert.strictEqual(f().matches[f().cur].from, 12, 'the current match keeps its place in the text');
    st = st.update({ effects: L.findCfg.of({ active: false }) }).state;
    assert.strictEqual(f().matches.length, 0, 'closing clears everything');
  });
  test('starting from the cursor: the first match at or after it is current', () => {
    let st = mk('x a x b x\n');
    st = st.update({ effects: L.findCfg.of({ active: true, query: 'x', from: 3 }) }).state;
    assert.strictEqual(st.field(L.findField).cur, 1);
    st = st.update({ effects: L.findCfg.of({ from: 99 }) }).state;
    assert.strictEqual(st.field(L.findField).cur, 0, 'nothing after the cursor: wrap to the first');
  });
});

suite('Find: replace keeps the Markdown valid', () => {
  test('a plain match is replaced, nothing else changes', () => {
    assert.strictEqual(replace1('one two three\n', 'two', 'XX'), 'one XX three\n');
    assert.strictEqual(replace1('one two three\n', 'two', ''), 'one  three\n');
  });
  test('across formatting: the first piece takes the text, the other pieces go, the markers stay', () => {
    assert.strictEqual(replace1('a **two** months z\n', 'two months', 'X'), 'a **X** z\n');
    assert.strictEqual(replace1('a **tw**o mon*th*s z\n', 'two months', 'weeks'), 'a **weeks** z\n');
    assert.strictEqual(replace1('**one two** three\n', 'two three', 'X'), '**one X**\n');
  });
  test('deleting the last word of a styled run takes the space next to the marker with it', () => {
    assert.strictEqual(replace1('**ab cd** ef\n', 'cd', ''), '**ab** ef\n');
    assert.strictEqual(replace1('*cac ca acb*\n', 'acb', ''), '*cac ca*\n');
  });
  test('a style whose text is all deleted goes with its markers (no stray ****)', () => {
    assert.strictEqual(replace1('two **months** z\n', 'two months', 'weeks'), 'weeks z\n');
    assert.strictEqual(replace1('a **two** months z\n', 'two months', ''), 'a  z\n');
    assert.strictEqual(replace1('x **bold** y\n', 'bold', ''), 'x  y\n');
    assert.strictEqual(replace1('x `code` y\n', 'code', ''), 'x  y\n');
    assert.strictEqual(replace1('**bc**\n', 'bc', ' '), null, 'a space alone inside ** ** would turn the line into a horizontal rule');
    assert.strictEqual(replace1('x [link](http://u) y\n', 'link', ''), 'x  y\n');
  });
  test('a replacement that looks like Markdown is written as plain text (escaped when needed)', () => {
    assert.strictEqual(replace1('one two three\n', 'two', '*'), 'one * three\n', 'a lone star is already plain text');
    assert.strictEqual(replace1('one two three\n', 'two', '*a*'), 'one \\*a\\* three\n');
    assert.strictEqual(replace1('one two three\n', 'two', '**x**'), 'one \\*\\*x\\*\\* three\n');
    assert.strictEqual(replace1('one two\n', 'two', '<b>'), 'one \\<b\\>\n');
    assert.strictEqual(replace1('two three\n', 'two', '- item'), '\\- item three\n');
    assert.strictEqual(replace1('two three\n', 'two', '# h'), '\\# h three\n');
    assert.strictEqual(replace1('two three\n', 'two', '1. x'), '1\\. x three\n');
    assert.strictEqual(replace1('a two b\n', 'two', 'x_y'), 'a x_y b\n', 'no escape where none is needed');
  });
  test('inside code the replacement is written exactly as typed', () => {
    assert.strictEqual(replace1('x `two` y\n', 'two', '*a*'), 'x `*a*` y\n');
    assert.strictEqual(replace1('```\ntwo\n```\n', 'two', '<b>'), '```\n<b>\n```\n');
    assert.strictEqual(replace1('```\ntwo\n```\n', 'two', '```'), null, 'cannot close the fence');
  });
  test('replacing inside a link keeps the link; links with other text stay', () => {
    assert.strictEqual(replace1('[two months](http://u.rl)\n', 'two', 'six'), '[six months](http://u.rl)\n');
    assert.strictEqual(replace1('<b>two</b> months\n', 'two months', 'x'), '<b>x</b>\n');
  });
  test('whole paragraph text replaced by nothing is allowed; headings and list items keep their markers', () => {
    assert.strictEqual(replace1('# Title\n', 'Title', 'New'), '# New\n');
    assert.strictEqual(replace1('- [ ] old task\n', 'old', 'new'), '- [ ] new task\n');
    assert.strictEqual(replace1('> old quote\n', 'old', 'new'), '> new quote\n');
  });
  test('every kind of place: setext and ATX headings, HTML blocks, nested lists, quotes with tasks, reference links, hard breaks, emoji', () => {
    assert.strictEqual(replace1('Title text\n==========\n', 'text', 'word'), 'Title word\n==========\n');
    assert.strictEqual(replace1('## old title ##\n', 'old', 'new'), '## new title ##\n');
    assert.strictEqual(replace1('<div>old text</div>\n', 'old', 'new'), '<div>new text</div>\n');
    assert.strictEqual(replace1('<p>old <b>text</b></p>\n', 'old text', 'new'), '<p>new</p>\n', 'an emptied <b></b> goes too');
    assert.strictEqual(replace1('- a\n  - nested old\n    - deeper old\n', 'old', 'new', 1), '- a\n  - nested old\n    - deeper new\n');
    assert.strictEqual(replace1('> - [ ] old task\n', 'old', 'new'), '> - [ ] new task\n');
    assert.strictEqual(replace1('[old text][r]\n\n[r]: http://x\n', 'old', 'new'), '[new text][r]\n\n[r]: http://x\n');
    assert.strictEqual(replace1('line one  \nold two\n', 'old', 'new'), 'line one  \nnew two\n');
    assert.strictEqual(replace1('old\\\nnext\n', 'old', 'new'), 'new\\\nnext\n');
    assert.strictEqual(replace1('text <!-- old --> old\n', 'old', 'new'), 'text <!-- old --> new\n', 'a comment is not text');
    assert.strictEqual(replace1('Emoji 😀 old\n', 'old', '😀'), 'Emoji 😀 😀\n');
    assert.strictEqual(replace1('a \\*b old\n', 'a *b', 'X'), 'X old\n', 'an escape is replaced as one character');
    assert.strictEqual(replace1('- old\n', 'old', '* x'), '- \\* x\n');
    assert.strictEqual(replace1('old text\n', 'old', '1. x'), '1\\. x text\n');
    assert.strictEqual(replace1('old text\n', 'old', '> q'), '\\> q text\n');
  });
  test('Replace all: every match, one set of edits, and a count', () => {
    const r = replaceEvery('two **two** two months `two` [two](u)\n', 'two', 'six');
    assert.strictEqual(r.doc, 'six **six** six months `six` [six](u)\n'); assert.strictEqual(r.applied, 5); assert.strictEqual(r.skipped, 0);
    assert.strictEqual(replaceEvery('abc abc\n', 'abc', 'abcabc').doc, 'abcabc abcabc\n', 'a replacement containing the query is not replaced again');
  });
  test('the replacement is literal text, never a pattern', () => {
    assert.strictEqual(replace1('a b\n', 'a', '$1'), '$1 b\n');
    assert.strictEqual(replace1('a b\n', 'a', '\\n'), '\\n b\n', 'a backslash and an n stay a backslash and an n');
    assert.deepStrictEqual(hits('x (a+b) y\n', '(a+b)'), ['(a+b)'], 'the query is literal too');
    assert.deepStrictEqual(hits('x a.b axb\n', 'a.b'), ['a.b']);
  });
  test('table cells: a pipe is escaped like the cell editor does, rows stay valid', () => {
    const d = '| h1 | h2 |\n| - | - |\n| one two | z |\n';
    assert.strictEqual(replace1(d, 'two', 'a|b'), '| h1 | h2 |\n| - | - |\n| one a\\|b | z |\n');
    assert.strictEqual(replace1(d, 'two', 'a\\|b'), '| h1 | h2 |\n| - | - |\n| one a\\\\\\|b | z |\n', 'a typed backslash and pipe round-trip');
    assert.strictEqual(replace1(d, 'one two', ''), '| h1 | h2 |\n| - | - |\n|  | z |\n');
    assert.strictEqual(replace1(d, 'two', 'x'), '| h1 | h2 |\n| - | - |\n| one x | z |\n');
  });
  test('table cells: header cells, formatted cells, cells with <br>', () => {
    const d = '| Head one | h2 |\n| - | - |\n| a **two** months | line1<br>line2 two |\n';
    assert.strictEqual(replace1(d, 'head', 'Top'), '| Top one | h2 |\n| - | - |\n| a **two** months | line1<br>line2 two |\n');
    assert.strictEqual(replace1(d, 'two months', 'X'), '| Head one | h2 |\n| - | - |\n| a **X** | line1<br>line2 two |\n');
    assert.strictEqual(replace1(d, 'line2 two', 'ok'), '| Head one | h2 |\n| - | - |\n| a **two** months | line1<br>ok |\n');
    assert.strictEqual(replace1(d, 'line1', 'A'), '| Head one | h2 |\n| - | - |\n| a **two** months | A<br>line2 two |\n');
    const e = replaceEvery(d, 'o', '0');
    assert.strictEqual(e.skipped, 0);
    for (const line of e.doc.split('\n').filter((l) => l.startsWith('|'))) assert.strictEqual((line.match(/(?<!\\)\|/g) ?? []).length, 3, line);
  });
  test('table cells: a replacement ending in a backslash cannot swallow the closing pipe', () => {
    const d = '| a | b |\n| - | - |\n| x | y |\n';
    const r = replace1(d, 'x', 'p\\');
    assert.ok(r !== null);
    assert.strictEqual(r!.split('\n')[2].match(/(?<!\\)\|/g)!.length, 3, r!);
  });
  test('nothing else is touched: URLs, front matter and untouched lines stay byte for byte', () => {
    const d = '---\ntitle: two\n---\n\n[two](http://two.example/two) and two\n\n![two](two.png)\n';
    assert.strictEqual(replaceEvery(d, 'two', 'six').doc, '---\ntitle: two\n---\n\n[six](http://two.example/two) and six\n\n![two](two.png)\n');
  });
  test('an impossible replacement is refused, not forced', () => {
    assert.strictEqual(replace1('```\ntwo\n```\n', 'two', '```'), null);
    const r = replaceEvery('```\ntwo\n```\n\ntwo\n', 'two', '```');
    assert.strictEqual(r.applied, 1); assert.strictEqual(r.skipped, 1);
    assert.ok(r.doc.startsWith('```\ntwo\n```\n'));
  });
});

// ---- property test: random styled documents against the Markdown parser as an independent oracle ----
suite('Find: random documents (property test)', () => {
  const KINDS = ['strike', 'bold', 'italic'] as const;
  const NODE: Record<string, [string, string]> = { strike: ['Strikethrough', 'StrikethroughMark'], bold: ['StrongEmphasis', 'EmphasisMark'], italic: ['Emphasis', 'EmphasisMark'] };
  /** The characters a reader sees, with the style flags read straight from the syntax tree. */
  const oracle = (doc: string) => {
    const st = mk(doc);
    const mark = new Array(doc.length).fill(false);
    const flag: boolean[][] = Array.from({ length: doc.length }, () => [false, false, false]);
    L.syntaxTree(st).iterate({
      enter(n: any) {
        if (n.name === 'Escape') mark[n.from] = true; // the backslash of an escape is not a visible character
        KINDS.forEach((k, i) => {
          if (n.name !== NODE[k][0]) return;
          const ms = n.node.getChildren(NODE[k][1]); if (ms.length < 2) return;
          for (const m of ms) for (let p = m.from; p < m.to; p++) mark[p] = true;
          for (let p = ms[0].to; p < ms[ms.length - 1].from; p++) flag[p][i] = true;
        });
      },
    });
    const chars: Array<{ c: string; f: boolean[] }> = [];
    for (let p = 0; p < doc.length; p++) if (!mark[p]) chars.push({ c: doc[p], f: flag[p] });
    return chars;
  };
  let seed = Number(process.env.LM_FIND_SEED ?? 424242);
  const COUNT = Number(process.env.LM_FIND_N ?? 1500); // raise both from the environment for a longer hunt
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const word = () => Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick([...'abcab'])).join('');
  const gen = (depth: number): string => {
    const n = 1 + Math.floor(rnd() * 3); let s = '';
    for (let i = 0; i < n; i++) {
      if (i) s += rnd() < 0.8 ? ' ' : '';
      if (depth > 0 && rnd() < 0.55) { const m = pick(['**', '*', '~~']); s += m + gen(depth - 1) + m; } else s += word();
    }
    return s;
  };
  const wsFree = (xs: Array<{ c: string; f: boolean[] }>) => xs.filter((x) => !/\s/.test(x.c)).map((x) => x.c + x.f.map((b) => (b ? 1 : 0)).join('')).join(',');

  test('random documents (1500 by default): matches are found at the right places, Replace all gives the right text and styles', () => {
    let done = 0, replaced = 0, refused = 0;
    for (let iter = 0; done < COUNT && iter < COUNT * 10; iter++) {
      const paras = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => gen(3));
      const doc = paras.join('\n\n') + '\n';
      const before = oracle(doc);
      const plain = before.map((x) => x.c).join('');
      if (/[*~]/.test(plain)) continue; // the generator made invalid nesting; not a case for this test
      const lines = plain.split('\n').map((l) => l.trim()).filter((l) => l);
      const st = mk(doc); const vis = L.buildVisible(st);
      assert.strictEqual(vis.text, lines.join('\n') + '\n', 'visible text equals what the oracle reads\n' + JSON.stringify(doc));
      // a random substring of one line as the query
      const line = pick(lines); const a = Math.floor(rnd() * line.length); const len = 1 + Math.floor(rnd() * Math.min(8, line.length - a));
      const q = line.slice(a, a + len);
      if (!q.trim()) continue;
      const expected: Array<[number, number]> = []; // [line, column] of every non-overlapping occurrence
      lines.forEach((l, li) => { for (let i = l.indexOf(q); i >= 0; i = l.indexOf(q, i + q.length)) expected.push([li, i]); });
      const ms = L.findMatches(vis, q, { matchCase: true, wholeWord: false });
      const got = ms.map((m: any) => { const before2 = vis.text.slice(0, m.s); const li = before2.split('\n').length - 1; return [li, m.s - (before2.lastIndexOf('\n') + 1)]; });
      assert.deepStrictEqual(got, expected, `matches of ${JSON.stringify(q)} in ${JSON.stringify(doc)}`);
      // Replace all with a random replacement
      const repl = pick(['', 'x', 'yz', 'a', 'ab ba', '*', ' ']);
      const res = L.replaceAll(st, vis, ms, repl);
      done++;
      if (res.skipped) { refused += res.skipped; if (!res.edits.length) continue; }
      replaced += res.applied;
      const out = st.update({ changes: res.edits }).state.doc.toString();
      const after = oracle(out);
      if (!res.skipped) {
        // Expected: the old characters with every match swapped for the replacement, styled like the match's first character.
        // The oracle's characters line up with the visible text (it only has extra blanks and line breaks at line edges).
        const toOracle: number[] = []; let o = 0;
        for (let i = 0; i < vis.text.length; i++) {
          if (vis.text[i] === '\n') { toOracle.push(-1); continue; }
          while (o < before.length && before[o].c !== vis.text[i]) o++;
          toOracle.push(o++);
        }
        const exp: Array<{ c: string; f: boolean[] }> = []; let cur = 0;
        const take = (from: number, to: number) => { for (let i = from; i < to; i++) if (toOracle[i] >= 0) exp.push(before[toOracle[i]]); };
        for (const m of ms) { take(cur, m.s); for (const ch of repl) exp.push({ c: ch, f: before[toOracle[m.s]].f }); cur = m.e; }
        take(cur, vis.text.length);
        assert.strictEqual(wsFree(after), wsFree(exp), `Replace all ${JSON.stringify(q)} -> ${JSON.stringify(repl)}\n${JSON.stringify(doc)}\n${JSON.stringify(out)}`);
      }
      // whatever happened, the result still reads as the same number of paragraphs unless a paragraph was emptied
      const vis2 = L.buildVisible(mk(out));
      assert.ok(vis2.text.split('\n').filter((l: string) => l).length <= lines.length, 'no paragraph appeared out of nowhere');
    }
    assert.ok(done >= COUNT, 'enough valid cases: ' + done);
    assert.ok(replaced > refused * 3, `most replacements go through: ${replaced} done, ${refused} refused`);
  });

  test('Replace on one random match: same text and styles as the plain string replacement', () => {
    let done = 0;
    for (let iter = 0; done < COUNT / 2 && iter < COUNT * 6; iter++) {
      const doc = gen(3) + '\n';
      const before = oracle(doc); const plain = before.map((x) => x.c).join('');
      if (/[*~]/.test(plain)) continue;
      const line = plain.trim(); if (line.length < 3) continue;
      const st = mk(doc); const vis = L.buildVisible(st);
      const a = Math.floor(rnd() * line.length); const q = line.slice(a, a + 1 + Math.floor(rnd() * 5)); if (!q.trim() || q !== q.trim()) continue;
      const ms = L.findMatches(vis, q, { matchCase: true, wholeWord: false }); if (!ms.length) continue;
      const k = Math.floor(rnd() * ms.length); const repl = pick(['', 'q', 'qq rr']);
      const e = L.replaceOne(st, vis, ms[k], repl);
      done++;
      if (!e) continue;
      const out = st.update({ changes: e }).state.doc.toString();
      const wl = (vis.text.slice(0, ms[k].s) + repl + vis.text.slice(ms[k].e)).split('\n').map((l: string) => l.trim()).filter((l: string) => l);
      const want = wl.length ? wl.join('\n') + '\n' : '';
      const norm = (t: string) => (repl === '' ? t.replace(/[ \t]/g, '') : t); // a pure deletion may take a neighbouring space with it
      assert.strictEqual(norm(L.buildVisible(mk(out)).text), norm(want), `${JSON.stringify(doc)} ${JSON.stringify(q)}#${k} -> ${JSON.stringify(repl)} = ${JSON.stringify(out)}`);
    }
  });
});

// ---- the real find bar in the real webview ----
const cmd = <T>(c: string, ...a: unknown[]) => vscode.commands.executeCommand<T>(c, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAC = process.platform === 'darwin';
const ask = <T = any>(u: vscode.Uri, type: string, extra: object = {}) => cmd<T>('inkwell._debugAsk', u, type, extra);
const fd = (u: vscode.Uri, op: string, extra: object = {}) => ask<any>(u, 'debugFind', { op, ...extra });
const key = (u: vscode.Uri, k: string, o: { code?: string; shift?: boolean; meta?: boolean; ctrl?: boolean; alt?: boolean } = {}) => ask<{ defaultPrevented: boolean }>(u, 'debugKey', { key: k, ...o });
const modKeys = (o: { shift?: boolean } = {}) => ({ meta: MAC, ctrl: !MAC, ...o });

suite('Find: the find bar in the webview', () => {
  const tmp = tmpDir();
  suiteTeardown(() => rmDir(tmp));
  let n = 0;
  const open = async (text: string) => {
    const file = path.join(tmp, `fd${++n}.md`); fs.writeFileSync(file, text);
    const r = await openLive(file);
    await cmd('workbench.action.focusActiveEditorGroup');
    await ask(r.uri, 'debugFocus');
    return { ...r, file };
  };
  const DOC = 'The **two** months pass and *two* months more. Two Months end.\n\n- list two months\n\n| a | b |\n| --- | --- |\n| two months | x |\n| y | **two** months |\n';

  test('typing finds matches as they are seen, with a counter; Next and Previous wrap around', async () => {
    const { uri, file } = await open(DOC);
    let s = await fd(uri, 'open');
    assert.strictEqual(s.open, true); assert.strictEqual(s.counter, '');
    s = await fd(uri, 'query', { value: 'two months' });
    assert.strictEqual(s.count, 6); assert.strictEqual(s.counter, '1 of 6');
    assert.ok(s.cellHighlights >= 2, 'cells are highlighted too: ' + s.cellHighlights);
    s = await fd(uri, 'press', { value: 'next' }); assert.strictEqual(s.counter, '2 of 6');
    for (let i = 0; i < 4; i++) s = await fd(uri, 'press', { value: 'next' });
    assert.strictEqual(s.counter, '6 of 6');
    s = await fd(uri, 'press', { value: 'next' }); assert.strictEqual(s.counter, '1 of 6', 'after the last comes the first');
    s = await fd(uri, 'press', { value: 'prev' }); assert.strictEqual(s.counter, '6 of 6', 'before the first comes the last');
    s = await fd(uri, 'query', { value: 'zzzz' }); assert.strictEqual(s.counter, 'No results'); assert.strictEqual(s.count, 0);
    s = await fd(uri, 'query', { value: '' }); assert.strictEqual(s.counter, ''); assert.strictEqual(s.cellHighlights, 0, 'an empty query highlights nothing');
    await fd(uri, 'close'); await closeTab(file);
  });

  test('options: Match case and Whole words change the counter at once', async () => {
    const { uri, file } = await open('Cat cat concat CAT\n');
    await fd(uri, 'open');
    let s = await fd(uri, 'query', { value: 'cat' }); assert.strictEqual(s.count, 4);
    s = await fd(uri, 'case', { value: true }); assert.strictEqual(s.count, 2);
    s = await fd(uri, 'word', { value: true }); assert.strictEqual(s.count, 1);
    s = await fd(uri, 'case', { value: false }); assert.strictEqual(s.count, 3);
    s = await fd(uri, 'word', { value: false }); assert.strictEqual(s.count, 4);
    await fd(uri, 'close'); await closeTab(file);
  });

  test('Enter / Shift+Enter in the Find field, Cmd/Ctrl+G, F3 and Esc (which selects the current match)', async () => {
    const { uri, file, doc } = await open('one x two x three x\n');
    await fd(uri, 'open'); await fd(uri, 'query', { value: 'x' });
    await key(uri, 'Enter', { code: 'Enter' });
    let s = await fd(uri, 'state'); assert.strictEqual(s.counter, '2 of 3', 'Enter goes to the next match');
    await key(uri, 'Enter', { code: 'Enter', shift: true });
    s = await fd(uri, 'state'); assert.strictEqual(s.counter, '1 of 3', 'Shift+Enter goes back');
    if (MAC) { await key(uri, 'g', { code: 'KeyG', meta: true }); s = await fd(uri, 'state'); assert.strictEqual(s.counter, '2 of 3'); await key(uri, 'g', { code: 'KeyG', meta: true, shift: true }); }
    else { await key(uri, 'F3', { code: 'F3' }); s = await fd(uri, 'state'); assert.strictEqual(s.counter, '2 of 3'); await key(uri, 'F3', { code: 'F3', shift: true }); }
    s = await fd(uri, 'state'); assert.strictEqual(s.counter, '1 of 3');
    await key(uri, 'Enter', { code: 'Enter' });
    await key(uri, 'Escape', { code: 'Escape' });
    s = await fd(uri, 'state');
    assert.strictEqual(s.open, false, 'Esc closes the bar');
    assert.strictEqual(s.sel.text, 'x'); assert.strictEqual(s.sel.from, doc.getText().indexOf('x', 5), 'the second match is selected, like Word');
    assert.strictEqual(s.cellHighlights, 0, 'highlights are gone');
    await closeTab(file);
  });

  test('Cmd/Ctrl+F opens the bar pre-filled with a one-line selection (what the reader sees); Cmd/Ctrl+Alt+F or Ctrl+H opens Replace', async () => {
    const { uri, file, doc } = await open('say **two** months now\nsecond line\n');
    const a = doc.getText().indexOf('**two**');
    await ask(uri, 'debugSelect', { fromLine: 0, fromCh: a, toLine: 0, toCh: a + '**two** months'.length });
    await key(uri, 'f', { code: 'KeyF', ...modKeys() });
    let s = await fd(uri, 'state');
    assert.strictEqual(s.open, true); assert.strictEqual(s.query, 'two months', 'the markers are not copied into the field'); assert.strictEqual(s.counter, '1 of 1');
    assert.strictEqual(s.replaceShown, false);
    await fd(uri, 'close', { keep: false });
    await ask(uri, 'debugSelect', { fromLine: 0, fromCh: 0, toLine: 1, toCh: 3 });
    await key(uri, 'f', { code: 'KeyF', ...modKeys() });
    s = await fd(uri, 'state'); assert.strictEqual(s.query, 'two months', 'a selection over more than one line is not copied; the old query stays');
    await fd(uri, 'close', { keep: false });
    await key(uri, MAC ? 'f' : 'h', { code: MAC ? 'KeyF' : 'KeyH', ...modKeys(), alt: MAC });
    s = await fd(uri, 'state'); assert.strictEqual(s.open, true); assert.strictEqual(s.replaceShown, true);
    await fd(uri, 'close', { keep: false }); await closeTab(file);
  });

  test('Replace: the current match is replaced and the next one becomes current', async () => {
    const { uri, file, doc } = await open('a two b two c two\n');
    await fd(uri, 'open', { replace: true }); await fd(uri, 'query', { value: 'two' }); await fd(uri, 'replacement', { value: 'six' });
    let s = await fd(uri, 'press', { value: 'replace' });
    await waitUntil(() => doc.getText() === 'a six b two c two\n', 'first replaced');
    assert.strictEqual(s.counter, '1 of 2', 'two left, the next one is current'); assert.strictEqual(s.matches[s.cur].from, 'a six b '.length);
    s = await fd(uri, 'press', { value: 'replace' });
    await waitUntil(() => doc.getText() === 'a six b six c two\n', 'second replaced');
    s = await fd(uri, 'press', { value: 'replace' });
    await waitUntil(() => doc.getText() === 'a six b six c six\n', 'third replaced');
    assert.strictEqual(s.counter, 'No results');
    await fd(uri, 'close'); await closeTab(file);
  });

  test('Replace across formatting keeps the formatting valid; an Undo takes it back', async () => {
    const T = 'one **two** months and *two* months\n';
    const { uri, file, doc } = await open(T);
    await fd(uri, 'open', { replace: true }); await fd(uri, 'query', { value: 'two months' }); await fd(uri, 'replacement', { value: 'weeks' });
    await fd(uri, 'press', { value: 'replace' });
    await waitUntil(() => doc.getText() === 'one **weeks** and *two* months\n', 'replaced across the bold run');
    await cmd('inkwell.undo');
    await waitUntil(() => doc.getText() === T, 'one Undo restores it');
    await fd(uri, 'close'); await closeTab(file);
  });

  test('Replace all: one Undo step, the bar reports "Replaced N"', async () => {
    const T = 'two **two** two\n\n- two\n\n| a | b |\n| - | - |\n| two | x two |\n';
    const { uri, file, doc } = await open(T);
    await fd(uri, 'open', { replace: true }); await fd(uri, 'query', { value: 'two' }); await fd(uri, 'replacement', { value: 'six' });
    const s = await fd(uri, 'press', { value: 'all' });
    await waitUntil(() => doc.getText() === T.replace(/two/g, 'six'), 'every match replaced');
    assert.strictEqual(s.status, 'Replaced 6');
    await cmd('inkwell.undo');
    await waitUntil(() => doc.getText() === T, 'one Undo brings every replacement back');
    await key(uri, 'z', { code: 'KeyZ', ...modKeys(), shift: true }); // the key path, with the focus still in the bar
    await waitUntil(() => doc.getText() === T.replace(/two/g, 'six'), 'Redo with the focus in the find bar redoes the Replace all');
    await key(uri, 'z', { code: 'KeyZ', ...modKeys() });
    await waitUntil(() => doc.getText() === T, 'and Undo from the find bar undoes it in one step');
    await fd(uri, 'close'); await closeTab(file);
  });

  test('the Find / Replace commands (keybinding path, for when VS Code gets the key first) work', async () => {
    const { uri, file } = await open('a x b x\n');
    await cmd('inkwell.find');
    await waitUntil(async () => (await fd(uri, 'state')).open, 'inkwell.find opens the bar');
    await fd(uri, 'query', { value: 'x' });
    await cmd('inkwell.findNext');
    await waitUntil(async () => (await fd(uri, 'state')).counter === '2 of 2', 'inkwell.findNext');
    await cmd('inkwell.findPrevious');
    await waitUntil(async () => (await fd(uri, 'state')).counter === '1 of 2', 'inkwell.findPrevious');
    await cmd('inkwell.replace');
    await waitUntil(async () => (await fd(uri, 'state')).replaceShown, 'inkwell.replace shows the Replace row');
    await fd(uri, 'close'); await closeTab(file);
  });

  test('Replace in table cells: pipes are escaped, <br> and header cells work, Esc selects the match in the cell', async () => {
    const T = '| Head two | b |\n| --- | --- |\n| one two | a<br>two b |\n';
    const { uri, file, doc } = await open(T);
    await fd(uri, 'open', { replace: true }); await fd(uri, 'query', { value: 'two' }); await fd(uri, 'replacement', { value: 'x|y' });
    let s = await fd(uri, 'state'); assert.strictEqual(s.count, 3);
    await fd(uri, 'press', { value: 'all' });
    await waitUntil(() => doc.getText() === '| Head x\\|y | b |\n| --- | --- |\n| one x\\|y | a<br>x\\|y b |\n', 'replaced in the header, a body cell and after a <br>');
    await cmd('inkwell.undo');
    await waitUntil(() => doc.getText() === T, 'undone');
    await fd(uri, 'replacement', { value: 'Q' });
    await fd(uri, 'query', { value: 'two' });
    s = await fd(uri, 'state'); assert.strictEqual(s.count, 3);
    await key(uri, 'Escape', { code: 'Escape' });
    s = await fd(uri, 'state');
    assert.strictEqual(s.open, false); assert.ok(s.cellSel, 'a cell has the focus'); assert.strictEqual(s.cellSel.text, 'two', 'the match is selected in its cell');
    await closeTab(file);
  });

  test('matches in a table cell can be found and replaced one at a time', async () => {
    const T = 'intro\n\n| a | b |\n| - | - |\n| find me | x |\n';
    const { uri, file, doc } = await open(T);
    await fd(uri, 'open', { replace: true }); await fd(uri, 'query', { value: 'find me' }); await fd(uri, 'replacement', { value: 'done' });
    const s = await fd(uri, 'press', { value: 'replace' });
    await waitUntil(() => doc.getText() === T.replace('find me', 'done'), 'replaced in the cell');
    assert.strictEqual(s.counter, 'No results');
    await fd(uri, 'close'); await closeTab(file);
  });

  test('the counter follows typing, Undo and edits made outside the page', async () => {
    const { uri, file, doc } = await open('x one x\n');
    await fd(uri, 'open'); let s = await fd(uri, 'query', { value: 'x' });
    assert.strictEqual(s.count, 2);
    await ask(uri, 'debugEdit', { change: { fromLine: 0, fromCh: 0, toLine: 0, toCh: 0, insert: 'x ' } });
    await waitUntil(async () => (await fd(uri, 'state')).count === 3, 'typing adds a match');
    await cmd('inkwell.undo');
    await waitUntil(async () => (await fd(uri, 'state')).count === 2, 'undo takes it away');
    const edit = new vscode.WorkspaceEdit(); edit.insert(doc.uri, new vscode.Position(0, 0), 'x x ');
    await vscode.workspace.applyEdit(edit);
    await waitUntil(async () => (await fd(uri, 'state')).count === 4, 'an outside edit adds two matches');
    await fd(uri, 'close'); await closeTab(file);
  });

  test('a replace that would break the formatting is skipped, and the bar says so', async () => {
    const { uri, file, doc } = await open('```\ntwo\n```\n\ntwo\n');
    await fd(uri, 'open', { replace: true }); await fd(uri, 'query', { value: 'two' }); await fd(uri, 'replacement', { value: '```' });
    const s = await fd(uri, 'press', { value: 'all' });
    await waitUntil(() => doc.getText() === '```\ntwo\n```\n\n\\`\\`\\`\n', 'the safe one replaced, the fence text left alone');
    assert.match(s.status, /Replaced 1, skipped 1/);
    await fd(uri, 'close'); await closeTab(file);
  });

  test('typing in the find field never changes the document', async () => {
    const T = 'hello world\n';
    const { uri, file, doc } = await open(T);
    await fd(uri, 'open'); await fd(uri, 'query', { value: 'hello' });
    await key(uri, 'b', { code: 'KeyB', ...modKeys() }); // Bold shortcut while the find field has the focus
    await sleep(300);
    assert.strictEqual(doc.getText(), T);
    await fd(uri, 'close'); await closeTab(file);
  });
});
