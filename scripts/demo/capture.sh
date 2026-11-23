#!/bin/sh
# Regenerates every image in images/ (needs: npm run build, playwright, ffmpeg). Not shipped in the vsix.
set -e
cd "$(dirname "$0")"
node stills.mjs && node gifs.mjs && node mocks.mjs
