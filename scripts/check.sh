#!/bin/sh
# Checks: typecheck, tests, hostile cwd and a secret scan of tracked files.
# CI runs this on every PR (.github/workflows/check.yml); run it locally too.
set -eu
cd "$(dirname "$0")/.."
BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"
[ -d node_modules ] || "$BUN" install --frozen-lockfile --ignore-scripts
echo "== typecheck"; ./node_modules/.bin/tsc --noEmit -p .
echo "== tests"; BUN="$BUN" sh scripts/test.sh
echo "== tests refuse a real home"
# A home outside the temp dir, which can't be written if the guard ever fails.
if out=$(env -u TILORI_HOME HOME=/nonexistent PATH="$(dirname "$BUN"):$PATH" "$BUN" test ./tests 2>&1); then
  echo "bun test ran with a non-temp HOME" >&2; exit 1
fi
echo "$out" | grep -q 'Refusing to run tests' || { echo "$out" >&2; exit 1; }
echo "== hostile cwd"; PATH="$(dirname "$BUN"):$PATH" sh tests/hostile-cwd.sh
echo "== secret scan"
if git ls-files -z | xargs -0 grep -nE 'mcp_sk_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9]|BEGIN (RSA|EC|OPENSSH) PRIVATE' -- 2>/dev/null | grep -v '^tests/'; then
  echo "possible secret in tracked files" >&2; exit 1
fi
echo "ok"
