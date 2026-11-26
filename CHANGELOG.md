# Changelog

## 0.8.0

- New: double space gives a full stop (Mac habit) in text, headings, lists, quotes and table cells; never in code, links or front matter; one Undo restores the spaces. Setting `inkwell.doubleSpacePeriod` (auto / on / off; auto = on for Mac).
- New: Increase / Decrease indent for lists (toolbar, Cmd/Ctrl+] and [, Tab and Shift+Tab on list lines). Only the leading spaces change. Normal text and table cells show a note instead.
- New: wrapped bullet, numbered and checklist items hang under the item text at every nesting level, in every page style.
- New: paste (Cmd/Ctrl+V) or drop pictures: saved to `images/<note>-<date>-<time>.<ext>` next to the file, never overwriting, linked at the cursor or in the table cell. Unsaved files show a note.

- New: Find and Replace in the page (Cmd/Ctrl+F; Cmd+Alt+F on a Mac and Ctrl+H elsewhere for Replace; Cmd+G / F3 for next). Highlights every match, including inside table cells, counts them ("3 of 12"), Match case and Whole words. It searches the visible text, so "two months" finds "**two** months" and link text, but not Markdown symbols, link addresses, HTML tags or front matter. Replace keeps the formatting valid and escapes `|` in table cells; Replace all is one Undo step; a replacement that would break the file is skipped and reported.
- Fixed: opening Find (with the remembered word) and pressing Esc no longer selects a match somewhere else. The cursor or selection, also in a table cell, stays where it was unless you chose a match.
- Fixed: Undo after another program changed the same text you had edited (for example reverted the file) could damage the text next to it. Inkwell now starts Undo fresh in that case and says so; changes elsewhere in the file leave Undo working.
- Fixed: double space now also gives a full stop after a closing `~~` or colour/format tag, and with the cursor before closing marks (`**bold|**`) the full stop goes inside them and the space after them.
- Changed: Tab / Increase indent with several lines selected moves them as one block (relative nesting kept, the item that cannot move stays); Select All no longer shows a note while some items can move.
- Changed: a numbered item can now be indented under the item above it. It restarts at `1.` when it begins a nested list, or continues the nested list it joins; outdent continues the numbering of the level it moves to.
- Fixed: wrapped lines of bullets, numbers and checklists inside quotes now hang under the item text.
- Fixed: Tab in normal text or a quote no longer moves the keyboard focus out of the editor; it shows the note instead (Esc then Tab still moves on).
- New: lists work like Word. Enter at the end of a bullet, numbered or checklist item continues the list (next number, unchecked box, blank line kept in loose lists; quotes and lists in quotes too); in the middle it splits the item; on an empty item it ends the list, or moves a nested item out one level. Shift+Enter breaks the line inside the item, indented to its text. Backspace right after a marker removes it and keeps the text; Delete at the end of an item joins the next one. Lines starting `- `, `1. ` or `☐ ` inside a table cell continue on Enter too.
- New: numbered lists renumber after your own edits (Enter, Backspace/Delete, typing `2. `, paste, moving or deleting lines, indent/outdent, list buttons): only the digits after the change are counted on again, nested lists on their own, `9.` to `10.` keeps the item's continuation lines inside it. Lists you did not touch, "all 1." lists, remote (other program) changes, opening and moving around never renumber; Undo restores the exact bytes.
- Fixed: after Tab / Cmd+] the cursor could end up in front of the number; it now stays in the text, and a selection keeps the same words selected.
- Docs: pictures dropped from Finder need Shift held while dropping (VS Code opens the file otherwise).

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
