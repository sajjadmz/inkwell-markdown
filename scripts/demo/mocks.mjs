import { chromium } from 'playwright';
import { chromePath, ROOT } from './lib.mjs';
import path from 'node:path';
const b = await chromium.launch({ executablePath: chromePath() });
const p = await b.newPage({ viewport: { width: 900, height: 920 }, deviceScaleFactor: 2 });
await p.goto('file://' + path.join(ROOT, 'scripts/demo/mocks.html'));
await p.locator('#open').screenshot({ path: path.join(ROOT, 'images/open-with.png') });
await p.locator('#pick').screenshot({ path: path.join(ROOT, 'images/default-editor.png') });
await b.close();
