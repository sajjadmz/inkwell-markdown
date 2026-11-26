// Bundles the extension host and the webview script, and copies crossnote's
// pre-compiled theme CSS (the npm package ships CSS, not LESS) into dist/styles.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { adaptCss } from './scripts/adapt.mjs';

rmSync('dist', { recursive: true, force: true });
await build({
  entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', bundle: true,
  platform: 'node', format: 'cjs', external: ['vscode'], sourcemap: true, target: 'node18',
});
await build({
  entryPoints: ['src/links.ts'], outfile: 'dist/links.js', bundle: true,
  platform: 'node', format: 'cjs', external: ['vscode'], target: 'node18',
});
await build({
  entryPoints: ['src/webview/sync.ts'], outfile: 'dist/sync.js', bundle: true,
  platform: 'node', format: 'cjs', target: 'node18',
});
await build({
  entryPoints: ['src/webview/table.ts'], outfile: 'dist/table.js', bundle: true,
  platform: 'node', format: 'cjs', target: 'node18', // used by the tests (cell escaping property test)
});
await build({
  entryPoints: ['src/webview/listedit.ts'], outfile: 'dist/listedit.js', bundle: true,
  platform: 'node', format: 'cjs', target: 'node18', external: ['@codemirror/*', '@lezer/*'], // used by the tests (list editing and renumbering on plain editor states)
});
await build({
  entryPoints: ['src/webview/celllist.ts'], outfile: 'dist/celllist.js', bundle: true,
  platform: 'node', format: 'cjs', target: 'node18', // used by the tests (lists inside table cells)
});
await build({
  entryPoints: ['src/pictures.ts'], outfile: 'dist/pictures.js', bundle: true,
  platform: 'node', format: 'cjs', target: 'node18', // used by the tests (picture validation and naming)
});
const wv = await build({
  entryPoints: ['src/webview/main.ts'], outfile: 'dist/webview.js', bundle: true,
  platform: 'browser', format: 'iife', minify: true, metafile: true, legalComments: 'none', target: 'es2022', loader: { '.css': 'text' },
});
writeFileSync('dist/webview-meta.json', JSON.stringify(wv.metafile)); // dev aid: which packages are bundled (not shipped, see .vscodeignore)
const src = 'vendor/crossnote-styles/styles';
mkdirSync('dist/styles', { recursive: true });
for (const d of ['preview_theme', 'prism_theme']) cpSync(`${src}/${d}`, `dist/styles/${d}`, { recursive: true });
cpSync(`${src}/preview.css`, 'dist/styles/preview.css');

// Adapted copies of every theme for the CodeMirror live-preview DOM (see scripts/adapt.mjs).
for (const [d, kind] of [['preview_theme', 'theme'], ['prism_theme', 'prism']]) {
  mkdirSync(`dist/styles/live/${d}`, { recursive: true });
  for (const f of readdirSync(`${src}/${d}`).filter((x) => x.endsWith('.css'))) {
    writeFileSync(`dist/styles/live/${d}/${f}`, adaptCss(readFileSync(`${src}/${d}/${f}`, 'utf8'), kind));
  }
}
