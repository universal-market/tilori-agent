#!/bin/sh
# Runs bin/tilori-agent from a hostile directory: a bunfig.toml preload, a
# .env redirecting TILORI_HOME, and ./bun on a "." or empty PATH entry must
# have no effect. Includes a negative control on plain Bun.
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd -P)
realbun=$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")
[ -x "$realbun" ] || { echo "skip: bun not installed"; exit 0; }
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
p="$t/project"; m="$t/markers"; good="$t/home"
mkdir -p "$p" "$m" "$good" "$t/bunbin" && chmod 700 "$good"
ln -s "$realbun" "$t/bunbin/bun"
printf 'preload = ["./evil.ts"]\n' > "$p/bunfig.toml"
printf 'require("fs").writeFileSync(%s, "x");\n' "\"$m/preload\"" > "$p/evil.ts"
printf 'TILORI_HOME=%s/evil\n' "$p" > "$p/.env"
printf '#!/bin/sh\ntouch "%s/bun"\necho hijacked\n' "$m" > "$p/bun"; chmod +x "$p/bun"
fail() { echo "FAIL: $*" >&2; exit 1; }
expect="$good/.config/tilori/agents/wren.key"

# Negative control: plain Bun from the project dir honours both files.
out=$(cd "$p" && env -i HOME="$good" "$realbun" "$repo/src/cli.ts" key-path --agent wren 2>&1) || true
[ -e "$m/preload" ] || fail "control: preload did not run (test not meaningful)"
[ "$out" = "$p/evil/agents/wren.key" ] || fail "control: .env not applied (test not meaningful): $out"
rm -f "$m/preload"

sys="$t/bunbin:/usr/bin:/bin"
for path in ".:$sys" ":$sys" "$sys:" "$sys::x"; do
  out=$(cd "$p" && env -i HOME="$good" PATH="$path" "$repo/bin/tilori-agent" key-path --agent wren 2>&1) \
    || fail "PATH=$path: exit $? ($out)"
  [ "$out" = "$expect" ] || fail "PATH=$path: $out"
  for f in preload bun; do [ -e "$m/$f" ] && fail "PATH=$path: hostile $f ran"; done
  :
done
# Through a symlink (as bun link installs it), with bun found via BUN_INSTALL.
ln -s "$repo/bin/tilori-agent" "$t/link"
mkdir -p "$t/bi/bin" && ln -s "$realbun" "$t/bi/bin/bun"
out=$(cd "$p" && env -i HOME="$good" PATH=".:/usr/bin:/bin" BUN_INSTALL="$t/bi" "$t/link" key-path --agent wren 2>&1) \
  || fail "symlink: $out"
[ "$out" = "$expect" ] || fail "symlink: $out"
for f in preload bun; do [ -e "$m/$f" ] && fail "symlink: hostile $f ran"; done

# A chain of relative symlinks, with a readlink that rejects -f (older macOS).
mkdir -p "$t/a/b" "$t/shim"
ln -s "$repo/bin/tilori-agent" "$t/a/b/real-link"
ln -s b/real-link "$t/a/hop"
ln -s ../a/hop "$t/shim/chain"
r=$(command -v readlink)
printf '#!/bin/sh
case "$1" in -*) echo "readlink: illegal option" >&2; exit 1 ;; esac
exec %s "$@"
' "$r" > "$t/shim/readlink"
chmod +x "$t/shim/readlink"
out=$(cd "$p" && env -i HOME="$good" PATH="$t/shim:.:/usr/bin:/bin" BUN_INSTALL="$t/bi" "$t/shim/chain" key-path --agent wren 2>&1) \
  || fail "symlink chain: $out"
[ "$out" = "$expect" ] || fail "symlink chain: $out"
echo "hostile-cwd: ok"
