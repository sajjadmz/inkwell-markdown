// Dev aid: prints licence sections for the packages bundled into dist/webview.js (read from the esbuild metafile)
// that THIRD_PARTY_NOTICES.md does not mention yet. Usage: node scripts/notices.mjs >> THIRD_PARTY_NOTICES.md
import fs from 'node:fs';
const meta = JSON.parse(fs.readFileSync('dist/webview-meta.json', 'utf8'));
const notices = fs.readFileSync('THIRD_PARTY_NOTICES.md', 'utf8');
const pk = new Map();
for (const f of Object.keys(meta.outputs['dist/webview.js'].inputs)) {
  let last; for (const r of f.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)) last = r[1];
  if (last) pk.set(last, 1);
}
const groups = new Map(); // licence text -> [{name, version, spdx}]
const missing = [];
for (const name of [...pk.keys()].sort()) {
  if (notices.includes(`### ${name}\n`)) continue;
  const dir = `node_modules/${name}`;
  const p = JSON.parse(fs.readFileSync(`${dir}/package.json`, 'utf8'));
  const file = fs.readdirSync(dir).find((x) => /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i.test(x));
  if (!file) { missing.push(`${name}@${p.version}`); continue; }
  const text = fs.readFileSync(`${dir}/${file}`, 'utf8').trim();
  const spdx = typeof p.license === 'string' ? p.license : p.license?.type ?? (p.licenses ? p.licenses.map((l) => l.type).join(' OR ') : 'see text');
  if (!groups.has(text)) groups.set(text, []);
  groups.get(text).push({ name, version: p.version, spdx });
}
let out = '\n## Mermaid and its bundled dependencies (diagram rendering)\n\n';
out += 'Bundled into `dist/webview.js` by esbuild (minified) for the Mermaid diagram widget. Each group below shares one licence text; the heading lists the packages and their SPDX identifiers.\n';
out += 'Note: `elkjs` is offered under EPL-2.0 OR GPL-3.0-or-later; this extension uses it under EPL-2.0 (source: https://github.com/kieler/elkjs). `dompurify` is offered under MPL-2.0 OR Apache-2.0; both texts are in its licence file below.\n\n';
for (const [text, list] of groups) {
  out += `### ${list.map((x) => `${x.name} ${x.version} (${x.spdx})`).join(', ')}\n\n`;
  out += '```text\n' + text + '\n```\n\n';
}
if (missing.length) out += `Packages shipping no licence file (their package.json declares the licence): ${missing.join(', ')}\n`;
process.stdout.write(out);
