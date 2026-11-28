#!/bin/sh
# UNI-1178 S0: an in-repo equivalent of the checks tilori-claude makes on the
# bundled CLI (plugins/universal-market/vendor/tilori-agent.js), run against a
# bundle built from this checkout. Nothing is downloaded and nothing is
# written outside a temp dir. Run by scripts/check.sh.
#
# What tilori-claude asserts about the bundle, and what this does:
#   tools/bundle-agent.sh --verify  rebuilds with `bun build src/cli.ts
#     --target=bun` and compares byte for byte: this builds twice and compares
#     (the bundle is reproducible). Its release-asset and SOURCE sha checks
#     need a release and gh, so they are not mirrored.
#   tests/runtimes.sh, tests/hostile-cwd.sh  the bundle runs under bun
#     --no-env-file and under node 22.18+, from "/" or a hostile project dir
#     (a bunfig.toml preload, a .env, "." first on PATH) without any of it
#     taking effect: here the real bundle runs from such a dir.
#   tests/stop-check-hook.sh, headers-sentinel.sh, key-header.sh,
#   setup-command.sh, config-command.sh  these test the plugin's shell
#     scripts against stub CLIs, so they cannot run here. What the plugin
#     relies on from the bundle (the hook JSON, the headers line, the usage and
#     error text) is instead the S0 snapshot suites, re-run with every
#     subprocess case pointed at the bundle (S0_CLI): tests/s0-hooks.test.ts
#     and tests/s0-cli-text.test.ts, under bun and, when node 22.18+ exists,
#     under node.
set -eu
cd "$(dirname "$0")/.."
BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"
t=$(mktemp -d); trap 'chmod -R u+rwx "$t" 2>/dev/null; rm -rf "$t"' EXIT
chmod 700 "$t"
fail() { echo "bundle-check: FAIL: $*" >&2; exit 1; }
sys=/usr/bin:/bin

echo "-- build twice, byte for byte"
mkdir "$t/a" "$t/b"
"$BUN" build src/cli.ts --target=bun --outfile "$t/a/tilori-agent.js" >/dev/null
"$BUN" build src/cli.ts --target=bun --outfile "$t/b/tilori-agent.js" >/dev/null
cmp -s "$t/a/tilori-agent.js" "$t/b/tilori-agent.js" || fail "two builds differ"
bundle="$t/a/tilori-agent.js"
[ -s "$bundle" ] || fail "empty bundle"

echo "-- a hostile project directory has no effect on the bundle"
# run-agent.sh starts the bundle from "/" (so a bunfig.toml in the project is
# never read) and with --no-env-file; this checks the part the bundle owns:
# with those flags, a project's .env and relative-PATH executables change
# nothing, and the output equals the source's.
p="$t/project"; m="$t/markers"; h="$t/home"
mkdir -p "$p" "$m" "$h/.config/tilori/agents"
chmod 700 "$h" "$h/.config" "$h/.config/tilori" "$h/.config/tilori/agents"
printf 'fake-key-for-s0\n' >"$h/.config/tilori/agents/wren.key"; chmod 600 "$h/.config/tilori/agents/wren.key"
printf '{"url":"https://tilori.example.test/mcp/tilori/v1","default_agent":"wren"}\n' >"$h/.config/tilori/config.json"
chmod 600 "$h/.config/tilori/config.json"
printf 'TILORI_EVIL=1\nTILORI_HOME=%s\nTILORI_AGENT=evil\n' "$p" >"$p/.env"
for n in bun node dirname readlink tilori-agent sh; do
  printf '#!/bin/sh\ntouch "%s/%s"\necho hijacked\n' "$m" "$n" >"$p/$n"; chmod +x "$p/$n"
done
want="$h/.config/tilori/agents/wren.key"
# Negative control: plain Bun from that directory does load the .env.
out=$(cd "$p" && env -i HOME="$h" PATH="$sys" "$BUN" "$bundle" key-path 2>&1 || true)
[ "$out" != "$want" ] || fail "control: the project .env was not loaded, so this test would prove nothing"
for path in ".:$sys" ":$sys" "$sys"; do
  out=$(cd "$p" && env -i HOME="$h" PATH="$path" "$BUN" --no-env-file "$bundle" key-path 2>&1) || fail "bundle key-path from the hostile dir, PATH=$path: exit $? ($out)"
  [ "$out" = "$want" ] || fail "bundle key-path from the hostile dir, PATH=$path: $out"
  src=$(cd "$p" && env -i HOME="$h" PATH="$path" "$BUN" --no-env-file "$OLDPWD/src/cli.ts" key-path 2>&1) || fail "source key-path failed"
  [ "$src" = "$out" ] || fail "bundle and source key-path differ"
  help_b=$(cd "$p" && env -i HOME="$h" PATH="$path" "$BUN" --no-env-file "$bundle" help 2>&1) || fail "bundle help: exit $?"
  help_s=$(cd "$p" && env -i HOME="$h" PATH="$path" "$BUN" --no-env-file "$OLDPWD/src/cli.ts" help 2>&1) || fail "source help: exit $?"
  [ "$help_b" = "$help_s" ] || fail "bundle help differs from source help (PATH=$path)"
  for f in bun node dirname readlink tilori-agent sh; do [ ! -e "$m/$f" ] || fail "hostile $f ran (PATH=$path)"; done
done
help_src=$help_s

node=$(command -v node || true)
node_ok=
if [ -n "$node" ]; then
  v=$("$node" --version 2>/dev/null | sed 's/^v//') || v=
  major=${v%%.*}; rest=${v#*.}; minor=${rest%%.*}
  case "$major.$minor" in
    *[!0-9.]* | . | "") ;;
    *) if [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 18 ]; }; then node_ok=1; fi ;;
  esac
fi
if [ -n "$node_ok" ]; then
  echo "-- the bundle under node $v, from the hostile directory"
  out=$(cd "$p" && env -i HOME="$h" PATH="$sys" "$node" "$bundle" help 2>&1) || fail "bundle help under node: exit $?"
  [ "$out" = "$help_src" ] || fail "bundle help under node differs from source help"
  for f in bun node dirname readlink tilori-agent sh; do [ ! -e "$m/$f" ] || fail "hostile $f ran under node"; done
else
  echo "-- node 22.18+ not found: the node run is SKIPPED" >&2
fi

echo "-- S0 hook, headers and CLI-text snapshots against the bundle (bun)"
# The isolating runner's rules: a temp HOME, no TILORI_* variables.
snap() { # snap <runtime> : runs the subprocess-based S0 suites against the bundle
  th="$t/testhome-$(basename "$1")"; mkdir -p "$th"; chmod 700 "$th"
  env -u TILORI_HOME -u TILORI_AGENT -u TILORI_URL -u UPDATE_S0 -u TMUX HOME="$th" PATH="$(dirname "$BUN"):$PATH" \
    S0_CLI="$bundle" S0_RUNTIME="$1" "$BUN" test ./tests/s0-hooks.test.ts ./tests/s0-cli-text.test.ts >"$t/snap.log" 2>&1 \
    || { tail -40 "$t/snap.log" >&2; fail "S0 snapshots differ when run through the bundle ($1)"; }
}
snap "$BUN"
if [ -n "$node_ok" ]; then
  echo "-- S0 hook, headers and CLI-text snapshots against the bundle (node)"
  snap "$node"
fi
echo "bundle-check: ok"
