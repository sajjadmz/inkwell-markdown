<p align="center"><img src="images/icon.png" alt="Inkwell Markdown icon" width="96"></p>

# Inkwell Markdown

**Edit Markdown directly on the rendered page.** Headings, tables, checklists, code and diagrams look finished while you type, and the raw Markdown appears only on the line you are editing.

![Inkwell Markdown showing a weekly notes file in the light theme](images/hero.png)

Designed by [sajjadmz](https://github.com/sajjadmz) · Built with [Claude](https://claude.com/claude-code)

## Features

- **Live preview, Obsidian style.** Text is shown styled. Move the cursor into a heading, bold word or link and the Markdown symbols appear; move away and they hide again.
- **A familiar toolbar and Word-style shortcuts.** Bold, italic, lists, headings, links, code blocks and more, with the shortcuts you already know.
- **Editable tables.** Click a cell and type. A small bar adds, deletes and aligns rows and columns.
- **Text colour and highlighter.** Six colours that read well in light and dark themes. Stored as small HTML tags that GitHub and Markdown Preview Enhanced also display.
- **Mermaid diagrams.** Insert a starter flowchart, sequence, timeline, mind map, Gantt, pie or state diagram from the Diagram menu. The diagram redraws as you type.
- **Syntax-coloured code blocks** for about 100 languages, and **clickable checkboxes** in task lists.
- **18 page styles** from Markdown Preview Enhanced (GitHub, One, Atom, Solarized, Monokai and more), following your VS Code theme by default.
- **Safe by design.** It edits your file's text directly. See [Your file is safe](#your-file-is-safe).

### Live preview

![The cursor moves into a heading and bold text; the Markdown symbols appear, then hide again](images/gif-live-preview.gif)

### Toolbar

![Select a sentence, then apply bold, a red text colour and a highlight](images/gif-toolbar.gif)

### Tables

![Click a cell, type, then add a row and a column from the floating bar](images/gif-table.gif)

### Diagrams

![Insert a flowchart, edit a node label and watch the diagram update](images/gif-mermaid.gif)

### Dark theme

![The same note in the dark page style](images/dark.png)

## Install

### In VS Code (no coding needed)

1. Open VS Code.
2. In the left sidebar, click the **Extensions** icon (four small squares, one slightly apart). Or use the menu bar: **View** → **Extensions**.
3. In the search box at the top of that panel, type **Inkwell Markdown**.
4. Click **Inkwell Markdown** by *sajjadmotamed*, then click the blue **Install** button.
5. That's it. Open any `.md` file and it appears in Inkwell (see [How to open a file](#how-to-open-a-file)).

Or install from the [VS Code Marketplace page](https://marketplace.visualstudio.com/items?itemName=sajjadmotamed.inkwell-markdown) by clicking **Install**.

### Cursor, VSCodium and Windsurf

These editors get extensions from [Open VSX](https://open-vsx.org/extension/sajjadmotamed/inkwell-markdown). The steps are the same as above: open the **Extensions** panel, search for **Inkwell Markdown**, click **Install**.

### From a terminal (for coders)

```
code --install-extension sajjadmotamed.inkwell-markdown
```

For Cursor use `cursor --install-extension sajjadmotamed.inkwell-markdown`.

### Build from source

You need Node.js 20 or later.

```
git clone https://github.com/sajjadmz/inkwell-markdown.git
cd inkwell-markdown
npm ci
npm run package
code --install-extension inkwell-markdown-<version>.vsix
```

`<version>` is the number in `package.json` (for example `0.4.0`). To run the tests (they download a copy of VS Code once):

```
npm test
```

## How to open a file

**You don't need to do anything special.** Once Inkwell is installed, it is already the default for Markdown files (files ending in `.md`). Just open one the way you normally would:

1. In VS Code's left sidebar (the **Explorer**, the icon that looks like two sheets of paper), find your Markdown file.
2. **Click it once.** It opens in Inkwell, looking like a formatted document with the toolbar at the top.

**If a file opens as plain text instead** (for example, the `#` and `**` symbols show everywhere):

- **Right-click** the file in the left sidebar and choose **Open in Inkwell**, or
- **Right-click the file's tab** at the top of the editor and choose **Open in Inkwell**.

![An illustration of the Explorer right-click menu with Open in Inkwell highlighted](images/open-with.png)

*Illustration (a mock-up, not a screenshot).*

**To see the raw Markdown text again,** click the **page icon at the far right of Inkwell's toolbar** (its tooltip says *Open as plain text*). To come back, right-click the tab and choose **Open in Inkwell**.

> **Keyboard users:** Cmd+Shift+V (Mac) or Ctrl+Shift+V (Windows and Linux) switches between Inkwell and plain text. This replaces VS Code's built-in Markdown preview shortcut; that preview is still available from the Command Palette (see below).

### What is the "Command Palette"?

Some steps below use the **Command Palette**. It is VS Code's search box for actions: you type what you want to do, then pick it from a list. To open it:

1. Go to the **menu bar** and click **View**. On a Mac the menu bar is at the very top of your screen; on Windows and Linux it is at the top of the VS Code window.
2. Click **Command Palette...**. A search box appears at the top-centre of VS Code.
3. Type the name of the action (for example `Inkwell`). Matching actions appear as you type.
4. **Click** the one you want (or press **Enter**).

Keyboard shortcut for the same box: Cmd+Shift+P (Mac) or Ctrl+Shift+P (Windows and Linux).

## Make it (or stop it being) your default Markdown editor

Inkwell is the default straight after installing, so most people never need this section. Use it if you want Markdown files to open as plain text by default, or to switch back.

**The simple way**

1. Open the **Command Palette** (menu bar: **View** → **Command Palette...**).
2. Type `Inkwell default`.
3. Click **Inkwell: Toggle open by default**.
4. A small message appears in the bottom-right corner:
   - **ON** means Markdown files open in Inkwell.
   - **OFF** means they open as plain text.
5. Do the same again whenever you want to switch back.

**VS Code's own way** (works for any file type)

1. Open any Markdown file.
2. Open the **Command Palette** (menu bar: **View** → **Command Palette...**).
3. Type `Reopen Editor With` and click **View: Reopen Editor With...**.
4. In the list that appears, click **Configure default editor for '*.md'...**.
5. Click **Inkwell** to make it the default, or **Text Editor** for plain text.

![An illustration of VS Code's Reopen Editor With picker listing Inkwell as the default](images/default-editor.png)

*Illustration (a mock-up, not a screenshot). The exact wording can differ slightly between VS Code versions.*

<details>
<summary>For advanced users: what the toggle changes</summary>

The setting `inkwell.openByDefault` shows the current state; change it with the command rather than by hand. Switching OFF adds `*.md` and `*.markdown` entries to `workbench.editorAssociations`; switching ON removes the entries it added.
</details>

## Toolbar

From left to right:

| Button | What it does |
|---|---|
| Heading menu | Heading 1, 2, 3 or normal text |
| **B**, *I*, ~~S~~ | Bold, italic, strikethrough |
| Text colour | Colour the selected text. The arrow opens six colours and "No colour". |
| Highlighter | Highlight the selected text. The arrow opens six colours. |
| Inline code, Link | `code` formatting and a link |
| Bullets, Numbers, Checklist, Quote | Lists and block quotes |
| Code block | Fenced code block. The arrow picks the language. |
| Table | Insert a 3 × 2 table |
| Diagram ▾ | Insert a starter Mermaid diagram: flowchart, sequence, timeline, mind map, Gantt, pie or state |
| Horizontal rule | A divider line |
| Page style | Choose the look of the page |
| Open as plain text | Switch this file to VS Code's text editor |

Pressing a formatting button or shortcut a second time removes that formatting, as in Word.

## Shortcuts

These work only inside the Inkwell editor (except the first row). Save, undo and redo are VS Code's own.

| Action | Mac | Windows / Linux |
|---|---|---|
| Switch Inkwell / plain text | Cmd+Shift+V | Ctrl+Shift+V |
| Bold | Cmd+B | Ctrl+B |
| Italic | Cmd+I | Ctrl+I |
| Strikethrough | Cmd+Shift+X | Ctrl+Shift+X |
| Link | Cmd+K | Ctrl+K |
| Inline code | Cmd+E | Ctrl+E |
| Bulleted list | Cmd+Shift+8 | Ctrl+Shift+8 |
| Numbered list | Cmd+Shift+7 | Ctrl+Shift+7 |
| Checklist | Cmd+Shift+9 | Ctrl+Shift+9 |
| Quote | Cmd+Shift+. | Ctrl+Shift+. |
| Heading 1 / 2 / 3 | Cmd+Alt+1 / 2 / 3 | Ctrl+Shift+Alt+1 / 2 / 3 |
| Normal text | Cmd+Alt+0 | Ctrl+Shift+Alt+0 |
| Code block | Cmd+Alt+C | Ctrl+Shift+Alt+C |
| Highlight (last colour used) | Cmd+Shift+H | Ctrl+Shift+H |
| Text colour (last colour used) | Cmd+Shift+C | Ctrl+Shift+C |

**Why Ctrl+Shift+Alt on Windows and Linux?** On many European keyboard layouts, Ctrl+Alt is the same as AltGr, which types characters such as `@`, `{` and `[`. Using Ctrl+Alt for headings would block those characters, so these shortcuts add Shift.

## Page styles

Inkwell uses the preview themes of Markdown Preview Enhanced. The default, **Auto**, picks `github-light` or `github-dark` to match your VS Code colour theme. Available styles:

`atom-dark`, `atom-light`, `atom-material`, `github`, `github-dark`, `github-light`, `gothic`, `medium`, `monokai`, `newsprint`, `night`, `none`, `one-dark`, `one-light`, `solarized-dark`, `solarized-light`, `vscode`, `vue`

To choose one, use any of these:

- The **Page style** button in the toolbar.
- The Command Palette: **Inkwell: Choose page style**.
- The setting `inkwell.previewTheme` (for example `one-dark.css`, or `auto`).

## Your file is safe

Inkwell edits your file's text directly. When you type, only the characters you change are sent to VS Code, never a rewritten copy of the whole file, so spacing, line endings and anything Inkwell does not display stay exactly as they were. Opening a file and closing it again does not touch it.

VS Code does the saving and undo, so Save, Undo, Redo, dirty markers and Local History work as in any other editor. The behaviour is covered by more than 150 automated tests that run on macOS, Windows and Linux on every change.

## Updates

Install from a Marketplace and updates arrive automatically. VS Code installs a new version in the background; it takes effect after you click **Restart Extensions** in the prompt, or on your next launch.

## Limitations

- Tables inside lists or quotes stay as raw Markdown text.
- No maths (LaTeX) rendering.
- Not available in the browser (vscode.dev, github.dev).
- Files larger than 2 MB open in VS Code's plain text editor.

## Credits

- Page styles come from [Markdown Preview Enhanced](https://github.com/shd101wyy/vscode-markdown-preview-enhanced) / [crossnote](https://github.com/shd101wyy/crossnote) by Yiyi Wang (NCSA licence).
- [CodeMirror 6](https://codemirror.net/) powers the editor and [Mermaid](https://mermaid.js.org/) draws the diagrams.
- Full licence texts: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Version history: [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
