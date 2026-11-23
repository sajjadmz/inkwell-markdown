# Contributing

Bug reports and pull requests are welcome at <https://github.com/sajjadmz/inkwell-markdown>.

## Set up

Node.js 20 or later.

```
git clone https://github.com/sajjadmz/inkwell-markdown.git
cd inkwell-markdown
npm ci
npm run build      # bundles dist/
npm test           # builds, then runs the suite in a downloaded VS Code
```

Press F5 in VS Code to start an Extension Development Host with the extension loaded. `npm run package` builds the `.vsix`.

## Ground rules

- The editor must never change text the user did not change. Every editing feature needs a test that checks the document text afterwards; see `test/suite/`.
- Run `npm test` before you open a pull request. CI runs it on macOS, Windows and Linux.
- Keep pull requests small and describe what changed and why.
- The design and decisions are in `docs/spec-v1.1.md`.

## README images

`scripts/demo/` regenerates the screenshots and GIFs with Playwright and ffmpeg (`scripts/demo/capture.sh` after `npm run build`). It is not part of the packaged extension. The two images `open-with.png` and `default-editor.png` are mock-ups.
