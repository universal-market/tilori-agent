#!/bin/sh
# Runs the tests under a fresh temp HOME with TILORI_HOME unset, so nothing
# can reach the real ~/.config/tilori. tests/setup.ts refuses to run otherwise.
set -eu
cd "$(dirname "$0")/.."
BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
chmod 700 "$t"
env -u TILORI_HOME -u TILORI_AGENT -u TILORI_URL HOME="$t" PATH="$(dirname "$BUN"):$PATH" "$BUN" test ./tests "$@"
