import { start } from './hunt-lib.mjs';
const H = await start('probe-hunt3.md');
const TL = async () => (await H.lines()).filter((l) => l.startsWith('|'));
const show = async (l, n=2) => { console.log(l.padEnd(30), JSON.stringify((await TL())[n]), '| sel:', JSON.stringify(await H.cellSel())); await H.check(l); };
await H.cell('plain').click(); await H.wait(200);
await H.caretCell(2); await H.key('Meta+k'); await show('Cmd+K empty selection');
await H.selectCell('plain '); await H.key('Meta+b'); await show('bold "plain " w/ trailing space');
await H.key('Meta+z');
await H.selectCell('plain'); await H.key('Meta+k'); await show('link');
await H.key('Meta+k'); await show('link again');
await H.key('Meta+z'); await H.key('Meta+z');
// trailing backslash
await H.selectCell('end'); await H.key('Meta+b'); await H.key('Meta+z');
await H.caretCell((await H.cellText()).length); await H.key('\\'); await show('type backslash at end');
await H.key('Meta+ArrowLeft'); await H.key('Meta+b'); await show('Cmd+B empty sel w backslash');
await H.close();
