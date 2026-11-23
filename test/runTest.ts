import * as path from 'node:path';
import * as fs from 'node:fs';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '../..');
  // Let @vscode/test-electron resolve the platform-specific binary (Code.exe, code, Visual Studio Code.app/...).
  // Recent macOS builds renamed the binary from Electron to Code, so only there fall back when the resolved path is missing.
  let vscodeExecutablePath = await downloadAndUnzipVSCode('stable');
  if (process.platform === 'darwin' && !fs.existsSync(vscodeExecutablePath)) {
    const alt = path.join(path.dirname(vscodeExecutablePath), 'Code');
    if (fs.existsSync(alt)) vscodeExecutablePath = alt;
  }
  // Isolated test profile: no AI chat panel (its input box steals the undo command) and no welcome tab.
  const userDir = path.join(root, '.vscode-test', 'user-data', 'User');
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, 'settings.json'), JSON.stringify({
    'chat.disableAIFeatures': true, 'workbench.startupEditor': 'none', 'files.autoSave': 'off',
    'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
  }, null, 2));
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.resolve(__dirname, 'suite/index'),
    launchArgs: ['--disable-extensions', '--user-data-dir', path.join(root, '.vscode-test', 'user-data')],
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
