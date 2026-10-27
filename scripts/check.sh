#!/bin/sh
# Local checks (no CI needed): typecheck, tests, and a secret scan of tracked files.
set -eu
cd "$(dirname "$0")/.."
BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"
[ -d node_modules ] || "$BUN" install --frozen-lockfile
echo "== typecheck"; ./node_modules/.bin/tsc --noEmit -p .
echo "== tests"; PATH="$(dirname "$BUN"):$PATH" "$BUN" test ./tests
echo "== secret scan"
if git ls-files -z | xargs -0 grep -nE 'mcp_sk_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9]|BEGIN (RSA|EC|OPENSSH) PRIVATE' -- 2>/dev/null | grep -v '^tests/'; then
  echo "possible secret in tracked files" >&2; exit 1
fi
echo "ok"
