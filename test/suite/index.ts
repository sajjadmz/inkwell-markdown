import * as path from 'node:path';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 60000 });
  if (process.env.LM_GREP) mocha.grep(process.env.LM_GREP);
  for (const f of ['sync.test.js', 'safety.test.js', 'editing.test.js', 'theme.test.js', 'links.test.js', 'adversarial.test.js', 'livepreview.test.js', 'phase3.test.js', 'tableprops.test.js', 'adversarial3.test.js', 'adversarial4.test.js', 'images.test.js', 'undo.test.js', 'tooltips.test.js', 'formatfix.test.js', 'features080.test.js', 'find.test.js', 'fixes080.test.js', 'lists.test.js']) mocha.addFile(path.resolve(__dirname, f));
  return new Promise((resolve, reject) =>
    mocha.run((failures) => (failures ? reject(new Error(`${failures} tests failed`)) : resolve())));
}
