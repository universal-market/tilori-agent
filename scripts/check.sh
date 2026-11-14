#!/bin/sh
# Checks: typecheck, tests, hostile cwd and a secret scan of tracked files.
# CI runs this on every PR (.github/workflows/check.yml); run it locally too.
set -eu
cd "$(dirname "$0")/.."
BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"
[ -d node_modules ] || "$BUN" install --frozen-lockfile --ignore-scripts
echo "== typecheck"; ./node_modules/.bin/tsc --noEmit -p .
echo "== tests"; BUN="$BUN" sh scripts/test.sh
echo "== every test file imports the guard first"
# bunfig.toml is read only from the current directory, so each file must run
# tests/setup.ts itself.
for f in tests/*.test.ts; do
  [ "$(head -n 1 "$f")" = "import './setup.ts';" ] || { echo "$f: first line must be import './setup.ts';" >&2; exit 1; }
done
echo "== tests refuse a real home"
# A home outside the temp dir, which can't be written if the guard ever fails:
# from the repo root, one file from tests/, and one by absolute path from /.
refused() {
  if out=$(cd "$1" && env -u TILORI_HOME HOME=/nonexistent PATH="$(dirname "$BUN"):$PATH" "$BUN" test "$2" 2>&1); then
    echo "bun test $2 (from $1) ran with a non-temp HOME" >&2; exit 1
  fi
  echo "$out" | grep -q 'Refusing to run tests' || { echo "$out" >&2; exit 1; }
}
refused . ./tests
refused tests ./core.test.ts
refused / "$PWD/tests/core.test.ts"
echo "== hostile cwd"; PATH="$(dirname "$BUN"):$PATH" sh tests/hostile-cwd.sh
echo "== old plugin names"
# UNI-874 step 5 (Don): the plugin is universal-market now, with no
# backwards compatibility, so no tracked file may name the old id, its tool
# prefix, its commands or its data path. The brackets keep this line from
# matching itself.
if git ls-files -z | xargs -0 grep -nE 'mcp__plugin_tilori[_]|/tilori[:](setup|config)|tilori[@]tilori-claude|tilori-tilori[-]claude' -- 2>/dev/null; then
  echo "old plugin name in tracked files: use universal-market (UNI-902)" >&2; exit 1
fi
echo "== secret scan"
if git ls-files -z | xargs -0 grep -nE 'mcp_sk_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9]|BEGIN (RSA|EC|OPENSSH) PRIVATE' -- 2>/dev/null | grep -v '^tests/'; then
  echo "possible secret in tracked files" >&2; exit 1
fi
echo "ok"
