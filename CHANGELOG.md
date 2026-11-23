# Changelog

## 0.6.0

- New: hover notes on every toolbar button, dropdown and dropdown item, and on the table bar and handles. They show the action name and the shortcut for your system.
- Fixed: Undo/Redo (Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z, Ctrl+Y) now work in the editor. They undo only your own edits, never changes made by another editor or tool, and also work inside table cells.

## 0.5.0

- Version renumbered to 0.5.0; same content as 0.4.1.

## 0.4.1

- Clearer, step-by-step instructions for installing, opening files and choosing the default editor, written for people who don't code (including what the Command Palette is and how to open it from the menu bar).

## 0.4.0 - First public release

- Live-preview Markdown editor: headings, bold, italic, strikethrough, inline code, links, quotes and rules are shown styled; the Markdown symbols appear on the line you are editing.
- Toolbar and Word-style shortcuts for Mac, Windows and Linux (Ctrl+Shift+Alt for headings on Windows and Linux, because of AltGr).
- Editable tables with a floating bar to add, delete and align rows and columns.
- Text colour and highlighter, stored as plain HTML tags.
- Mermaid diagrams that redraw as you type, with starters for seven diagram types.
- Syntax-coloured code blocks (about 100 languages) and clickable task-list checkboxes.
- 18 page styles from Markdown Preview Enhanced; Auto follows the VS Code theme.
- Opens `.md` and `.markdown` by default; "Open in Inkwell" in the Explorer and tab menus; "Inkwell: Toggle open by default".
- Cmd/Ctrl+Shift+V switches between Inkwell and plain text.
- Edits go to the document as minimal text changes; VS Code handles save and undo. More than 150 automated tests run on macOS, Windows and Linux.
