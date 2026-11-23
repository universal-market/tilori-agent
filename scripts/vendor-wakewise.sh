#!/bin/sh
# Re-vendor the wakewise TypeScript client from a local wakewise git repo at a pinned commit.
#
# Usage (from tilori-agent repo root):
#   sh scripts/vendor-wakewise.sh <path to the local wakewise repo> aa132693d8d1caf67f3aa716b6b07f406857be1a
#
# Running again at the same <sha> produces a byte-identical vendor/wakewise/ tree.
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: sh scripts/vendor-wakewise.sh <repo> <sha>" >&2
  exit 2
fi

REPO="$1"
SHA="$2"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/vendor/wakewise"
BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"

FULL_SHA="$(git -C "$REPO" rev-parse --verify "${SHA}^{commit}")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git -C "$REPO" archive "$FULL_SHA" ts/src LICENSE NOTICE | tar -x -C "$TMP"

rm -rf "$DEST"
mkdir -p "$DEST"
cp "$TMP/LICENSE" "$TMP/NOTICE" "$TMP/ts/src/index.ts" "$DEST/"
cp -R "$TMP/ts/src/client" "$DEST/client"
rm -rf "$DEST/exec"

"$BUN" -e '
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const dest = process.argv[1];
const commit = process.argv[2];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const paths = walk(dest)
  .map((p) => relative(dest, p).split(sep).join("/"))
  .filter((p) => p !== "VENDOR.json")
  .sort();

const files: Record<string, string> = {};
for (const rel of paths) {
  files[rel] = createHash("sha256").update(readFileSync(join(dest, rel))).digest("hex");
}

const treeInput = paths.map((p) => `${p}\0${files[p]}\n`).join("");
const tree_sha256 = createHash("sha256").update(treeInput, "utf8").digest("hex");

const manifest = {
  upstream: "wakewise",
  commit,
  subpath: "ts/src",
  files,
  tree_sha256,
  excluded: ["ts/src/exec", "ts/tests", "ts/bin", "ts/dist", "ts/node_modules"],
};
writeFileSync(join(dest, "VENDOR.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
' "$DEST" "$FULL_SHA"
