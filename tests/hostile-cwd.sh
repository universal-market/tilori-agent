#!/bin/sh
# Runs bin/tilori-agent from a hostile directory: a bunfig.toml preload, a
# .env redirecting TILORI_HOME, and ./bun, ./tilori-agent, ./dirname and
# ./readlink on a "." or empty PATH entry must have no effect. Includes a
# negative control on plain Bun.
set -eu
case "$0" in */*) here=${0%/*} ;; *) here=. ;; esac
repo=$(cd "$here/.." && pwd -P)
realbun=$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")
[ -x "$realbun" ] || { echo "skip: bun not installed"; exit 0; }
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
p="$t/project"; m="$t/markers"; good="$t/home"
mkdir -p "$p" "$m" "$good" "$t/bunbin" && chmod 700 "$good"
ln -s "$realbun" "$t/bunbin/bun"
printf 'preload = ["./evil.ts"]\n' > "$p/bunfig.toml"
printf 'require("fs").writeFileSync(%s, "x");\n' "\"$m/preload\"" > "$p/evil.ts"
printf 'TILORI_HOME=%s/evil\n' "$p" > "$p/.env"
hostile="bun tilori-agent dirname readlink"
for n in $hostile; do
  printf '#!/bin/sh\ntouch "%s/%s"\necho hijacked\n' "$m" "$n" > "$p/$n"; chmod +x "$p/$n"
done
fail() { echo "FAIL: $*" >&2; exit 1; }
expect="$good/.config/tilori/agents/wren.key"

# Negative control: plain Bun from the project dir honours both files. Plain
# Bun's .env home is refused unless listed in "homes" (UNI-751), so the
# control lists it; the runs through bin/tilori-agent below must still use
# the default home.
mkdir -p "$good/.config/tilori" && chmod 700 "$good/.config" "$good/.config/tilori"
printf '{"homes": ["%s/evil"]}\n' "$p" > "$good/.config/tilori/config.json"
chmod 600 "$good/.config/tilori/config.json"
out=$(cd "$p" && env -i HOME="$good" "$realbun" "$repo/src/cli.ts" key-path --agent wren 2>&1) || true
[ -e "$m/preload" ] || fail "control: preload did not run (test not meaningful)"
[ "$out" = "$p/evil/agents/wren.key" ] || fail "control: .env not applied (test not meaningful): $out"
rm -f "$m/preload"

no_markers() { for f in preload $hostile; do [ -e "$m/$f" ] && fail "$1: hostile $f ran"; done; :; }

sys="$t/bunbin:/usr/bin:/bin"
for path in ".:$sys" ":$sys" "$sys:" "$sys::x"; do
  out=$(cd "$p" && env -i HOME="$good" PATH="$path" "$repo/bin/tilori-agent" key-path --agent wren 2>&1) \
    || fail "PATH=$path: exit $? ($out)"
  [ "$out" = "$expect" ] || fail "PATH=$path: $out"
  no_markers "PATH=$path"
done
# PATH starting with "." or an empty entry and bun found only via BUN_INSTALL.
mkdir -p "$t/bi/bin" && ln -s "$realbun" "$t/bi/bin/bun"
for path in ".:/usr/bin:/bin" ":/usr/bin:/bin"; do
  out=$(cd "$p" && env -i HOME="$good" PATH="$path" BUN_INSTALL="$t/bi" "$repo/bin/tilori-agent" key-path --agent wren 2>&1) \
    || fail "PATH=$path (bun via BUN_INSTALL): exit $? ($out)"
  [ "$out" = "$expect" ] || fail "PATH=$path (bun via BUN_INSTALL): $out"
  no_markers "PATH=$path (bun via BUN_INSTALL)"
done
# Through a symlink (as bun link installs it), with bun found via BUN_INSTALL.
ln -s "$repo/bin/tilori-agent" "$t/link"
out=$(cd "$p" && env -i HOME="$good" PATH=".:/usr/bin:/bin" BUN_INSTALL="$t/bi" "$t/link" key-path --agent wren 2>&1) \
  || fail "symlink: $out"
[ "$out" = "$expect" ] || fail "symlink: $out"
no_markers symlink
# Run by a relative path from the project directory, so $0 must be made
# absolute (via $PWD) before cd /, and then followed through the symlink.
for path in ".:/usr/bin:/bin" ":/usr/bin:/bin"; do
  out=$(cd "$p" && env -i HOME="$good" PATH="$path" BUN_INSTALL="$t/bi" ../link key-path --agent wren 2>&1) \
    || fail "relative \$0, PATH=$path: $out"
  [ "$out" = "$expect" ] || fail "relative \$0, PATH=$path: $out"
  no_markers "relative \$0, PATH=$path"
done

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
no_markers "symlink chain"
echo "hostile-cwd: ok"
