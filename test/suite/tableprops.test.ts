// Property test: escapeCell/unescapeCell are an exact inverse pair, and the row parsed by markdown-it (the renderer's
// GFM table parser) and by our own parseRow agree on the cell count and cell text.
import * as assert from 'node:assert';
import * as path from 'node:path';
import MarkdownIt from 'markdown-it';

const T = require(path.resolve(__dirname, '../../../dist/table.js')) as {
  escapeCell(t: string): string; unescapeCell(s: string): string; endsWithBackslash(s: string): boolean;
  parseRow(text: string, base: number): { cells: Array<{ cFrom: number; cTo: number }> };
};

suite('Table cell escaping (property)', () => {
  test('random cells with \\ | ` and spaces round-trip through the GFM parser with the right cell count', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const alphabet = ['a', 'b', '\\', '|', '`', ' ', 'x', '\\', '|'];
    const md = new MarkdownIt({ html: false });
    for (let i = 0; i < 3000; i++) {
      const len = Math.floor(rnd() * 9);
      let d = ''; for (let k = 0; k < len; k++) d += alphabet[Math.floor(rnd() * alphabet.length)];
      d = d.trim();
      assert.strictEqual(T.unescapeCell(T.escapeCell(d)), d, 'inverse for ' + JSON.stringify(d));
      const s = T.escapeCell(d);
      for (const compact of [false, true]) {
        const pad = compact ? '' : ' ';
        const cell = s + (T.endsWithBackslash(s) ? ' ' : '');
        const row = `|${pad}${cell}${pad}|${pad}z${pad}|`;
        const src = `|h|h2|\n|-|-|\n${row}\n`;
        const toks = md.parse(src, {});
        const tds = toks.filter((t) => t.type === 'inline').slice(2).map((t) => t.content);
        assert.strictEqual(tds.length, 2, `markdown-it cell count for ${JSON.stringify(row)}`);
        assert.strictEqual(tds[0], s.replace(/\\\|/g, '|'), 'markdown-it cell content for ' + JSON.stringify(row));
        const r = T.parseRow(row, 0);
        assert.strictEqual(r.cells.length, 2, `parseRow cell count for ${JSON.stringify(row)}`);
        assert.strictEqual(T.unescapeCell(row.slice(r.cells[0].cFrom, r.cells[0].cTo)), d, 'parseRow cell text for ' + JSON.stringify(row));
      }
    }
  });
});
