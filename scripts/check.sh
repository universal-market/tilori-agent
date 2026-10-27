#!/bin/sh
# Checks: typecheck, tests, hostile cwd and a secret scan of tracked files.
# CI runs this on every PR (.github/workflows/check.yml); run it locally too.
set -eu
cd "$(dirname "$0")/.."
BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"
[ -d node_modules ] || "$BUN" install --frozen-lockfile --ignore-scripts
echo "== typecheck"; ./node_modules/.bin/tsc --noEmit -p .
echo "== tests"; PATH="$(dirname "$BUN"):$PATH" "$BUN" test ./tests
echo "== hostile cwd"; PATH="$(dirname "$BUN"):$PATH" sh tests/hostile-cwd.sh
echo "== secret scan"
if git ls-files -z | xargs -0 grep -nE 'mcp_sk_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9]|BEGIN (RSA|EC|OPENSSH) PRIVATE' -- 2>/dev/null | grep -v '^tests/'; then
  echo "possible secret in tracked files" >&2; exit 1
fi
echo "ok"
