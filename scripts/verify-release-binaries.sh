#!/bin/sh
# Checks a tilori-agent release's compiled executables (tilori-agent-<os>-<arch>
# and their .sha256 assets) against the release-binaries workflow run that
# made them, read-only through gh:
#
#   sh scripts/verify-release-binaries.sh v0.1.31 [path/to/tilori-agent-linux-x64 ...]
#
# For each of the four assets:
# 1. The executable and its .sha256 were uploaded by github-actions[bot].
# 2. The .sha256 names this tag, asset and commit, and GitHub's own digest of
#    the uploaded executable equals its sha256.
# 3. A successful release-binaries run for the tag exists that ran either on
#    the tag push itself, or as a dispatch on main whose commit is on main.
#    A run from any other branch could have used an edited workflow, so it
#    doesn't count.
# 4. That run's log shows the same tag and commit, and exactly one sha256 for
#    the asset, the same as the .sha256 file's.
# 5. The commit is the tag's commit and is on main (reviewed code).
# With file paths, each file must be named after one of the assets, and its
# sha256 must equal that asset's (for a file you downloaded or rebuilt).
# Only the newest 50 release-binaries runs are searched; an older release
# fails to verify (closed), and can be re-proved by dispatching the workflow
# again. Needs gh with read access to the repo, and sha256sum or shasum for
# file paths. Runs no repo code and writes nothing outside a temp dir.
set -eu
repo=${REPO:-universal-market/tilori-agent}
tag=${1:-}
printf '%s\n' "$tag" | grep -Eqx 'v[0-9]+\.[0-9]+\.[0-9]+' || { echo "usage: sh scripts/verify-release-binaries.sh <vX.Y.Z> [file ...]" >&2; exit 2; }
shift
fail() { echo "verify-release-binaries: $*" >&2; exit 1; }
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
assets="tilori-agent-linux-x64 tilori-agent-linux-arm64 tilori-agent-darwin-x64 tilori-agent-darwin-arm64"
field() { sed -n "s/^$1=//p" "$2"; }

gh api "repos/$repo/releases/tags/$tag" --jq '.assets[] | [.name, .uploader.login, (.digest // "")] | @tsv' > "$t/assets" 2>/dev/null \
  || fail "no release for $tag (dispatch: gh workflow run release-binaries.yml --ref main -f tag=$tag)"
info() { awk -F '\t' -v n="$1" -v c="$2" '$1 == n { print $c }' "$t/assets"; }

tag_commit=$(gh api "repos/$repo/commits/$tag" --jq .sha)
commit=
for a in $assets; do
  for n in "$a" "$a.sha256"; do
    u=$(info "$n" 2)
    [ "$u" = "github-actions[bot]" ] || fail "$n: uploader is '${u:-none}', not github-actions[bot]"
  done
  gh release download "$tag" -R "$repo" -p "$a.sha256" -O "$t/$a.sha256"
  [ "$(field tag "$t/$a.sha256")" = "$tag" ] || fail "$a.sha256 is for tag '$(field tag "$t/$a.sha256")'"
  [ "$(field asset "$t/$a.sha256")" = "$a" ] || fail "$a.sha256 is for asset '$(field asset "$t/$a.sha256")'"
  sha=$(field sha256 "$t/$a.sha256")
  printf '%s\n' "$sha" | grep -Eqx '[0-9a-f]{64}' || fail "$a.sha256 has no sha256"
  c=$(field commit "$t/$a.sha256")
  [ -z "$commit" ] || [ "$c" = "$commit" ] || fail "$a.sha256 names commit $c, others $commit"
  commit=$c
  [ "$(info "$a" 3)" = "sha256:$sha" ] || fail "$a: GitHub's digest '$(info "$a" 3)' is not sha256:$sha"
  printf '%s %s\n' "$a" "$sha" >> "$t/want"
done
[ "$commit" = "$tag_commit" ] || fail "assets name commit $commit, not the tag's commit $tag_commit"
on_main() { s=$(gh api "repos/$repo/compare/$1...main" --jq .status 2>/dev/null) && { [ "$s" = ahead ] || [ "$s" = identical ]; }; }
on_main "$commit" || fail "commit $commit is not on main"

# Newest qualifying run whose log names this tag decides.
gh run list -R "$repo" -w release-binaries.yml -L 50 --json databaseId,event,headBranch,headSha,conclusion \
  --jq '.[] | select(.conclusion=="success") | [.databaseId,.event,.headBranch,.headSha] | @tsv' > "$t/runs"
tag_re=$(printf '%s' "$tag" | sed 's/\./\\./g')
found=
while IFS="$(printf '\t')" read -r id event branch head; do
  case "$event:$branch" in
    "push:$tag") ;;
    workflow_dispatch:main) on_main "$head" || continue ;;
    *) continue ;;
  esac
  gh run view "$id" -R "$repo" --log > "$t/log" 2>/dev/null || continue
  grep -Eq "tag=$tag_re\$" "$t/log" || continue
  grep -Eq "commit=$commit\$" "$t/log" || fail "run $id did not log commit $commit"
  while read -r a sha; do
    # Every line for the asset must agree, so a confusing log fails.
    logged=$(grep -Eo "asset=$a sha256=[0-9a-f]{64}" "$t/log" | sed 's/.*sha256=//' | sort -u)
    [ "$logged" = "$sha" ] || fail "run $id logged sha256 '$(echo $logged)' for $a, asset says $sha"
  done < "$t/want"
  found=$id; break
done < "$t/runs"
[ -n "$found" ] || fail "no successful release-binaries run for $tag on the tag push or on main"

for f in "$@"; do
  name=${f##*/}
  sha=$(awk -v n="$name" '$1 == n { print $2 }' "$t/want")
  [ -n "$sha" ] || fail "$f is not named after an asset ($assets)"
  if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$f" | cut -d' ' -f1); else got=$(shasum -a 256 "$f" | cut -d' ' -f1); fi
  [ "$got" = "$sha" ] || fail "$f has sha256 $got, the release says $sha"
done
echo "verify-release-binaries: $tag ok: commit $commit, run $found${1:+, local files match}"
while read -r a sha; do echo "  $a $sha"; done < "$t/want"
