// Theme/CSS pipeline: independent of the renderer so the Phase 2 editor can reuse it.
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ThemeCss { css: string; previewTheme: string; prismTheme: string }

const read = (p: string): string => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

/** `setting` is inkwell.previewTheme; `dark` is whether VS Code is in a dark/high-contrast theme. */
export function loadTheme(distDir: string, setting: string, dark: boolean): ThemeCss {
  const styles = path.join(distDir, 'styles');
  const auto = setting === 'auto' || !setting;
  let previewTheme = auto ? (dark ? 'github-dark.css' : 'github-light.css') : path.basename(setting);
  if (!previewTheme.endsWith('.css')) previewTheme += '.css';
  if (!fs.existsSync(path.join(styles, 'preview_theme', previewTheme))) {
    previewTheme = dark ? 'github-dark.css' : 'github-light.css';
  }
  // crossnote pairs each preview theme with a prism theme; github themes map to github / github-dark.
  const base = previewTheme.replace(/\.css$/, '');
  const prismCandidates = [base, base.replace(/-light$/, ''), dark ? 'github-dark' : 'github'];
  const prismTheme = prismCandidates.find((n) => fs.existsSync(path.join(styles, 'prism_theme', n + '.css'))) ?? 'github';
  // Adapted at build time (scripts/adapt.mjs) from crossnote's CSS to the CodeMirror live-preview DOM.
  const css = [
    read(path.join(styles, 'live', 'prism_theme', prismTheme + '.css')),
    read(path.join(styles, 'live', 'preview_theme', previewTheme)),
  ].join('\n');
  return { css, previewTheme, prismTheme: prismTheme + '.css' };
}

export function listThemes(distDir: string): string[] {
  try { return fs.readdirSync(path.join(distDir, 'styles', 'preview_theme')).filter((f) => f.endsWith('.css')); } catch { return []; }
}
