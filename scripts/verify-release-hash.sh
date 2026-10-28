#!/bin/sh
# Checks a tilori-agent release's tilori-agent.js.sha256 asset against the
# release-hash workflow run that made it, read-only through gh:
#
#   sh scripts/verify-release-hash.sh v0.1.6 [path/to/vendor/SOURCE]
#
# 1. The asset was uploaded by github-actions[bot].
# 2. A successful release-hash run for the tag exists that ran either on the
#    tag push itself, or as a dispatch on main whose commit is on main. A run
#    from any other branch could have used an edited workflow, so it doesn't
#    count.
# 3. That run's log shows the same tag, commit and sha256 as the asset.
# 4. The asset's commit is the tag's commit and is on main (reviewed code).
# 5. With a SOURCE path (tilori-claude's plugins/tilori/vendor/SOURCE), its
#    lines equal the asset's.
# Only the newest 50 release-hash runs are searched; an older release fails
# to verify (closed), and can be re-proved by dispatching the workflow again.
# Needs gh with read access to the repo. Runs no repo code and writes nothing
# outside a temp dir.
set -eu
repo=${REPO:-universal-market/tilori-agent}
tag=${1:-}
source_file=${2:-}
printf '%s\n' "$tag" | grep -Eqx 'v[0-9]+\.[0-9]+\.[0-9]+' || { echo "usage: sh scripts/verify-release-hash.sh <vX.Y.Z> [SOURCE]" >&2; exit 2; }
fail() { echo "verify-release-hash: $*" >&2; exit 1; }
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT

uploader=$(gh api "repos/$repo/releases/tags/$tag" --jq '.assets[] | select(.name=="tilori-agent.js.sha256") | .uploader.login' 2>/dev/null) \
  || fail "no release for $tag (dispatch: gh workflow run release-hash.yml --ref main -f tag=$tag)"
[ "$uploader" = "github-actions[bot]" ] || fail "asset uploader is '${uploader:-none}', not github-actions[bot]"
gh release download "$tag" -R "$repo" -p tilori-agent.js.sha256 -O "$t/asset"
field() { sed -n "s/^$1=//p" "$2"; }
commit=$(field commit "$t/asset"); sha=$(field sha256 "$t/asset")
[ "$(field tag "$t/asset")" = "$tag" ] || fail "asset is for tag '$(field tag "$t/asset")'"
printf '%s\n' "$sha" | grep -Eqx '[0-9a-f]{64}' || fail "asset has no sha256"

on_main() { s=$(gh api "repos/$repo/compare/$1...main" --jq .status 2>/dev/null) && { [ "$s" = ahead ] || [ "$s" = identical ]; }; }
tag_commit=$(gh api "repos/$repo/commits/$tag" --jq .sha)
[ "$commit" = "$tag_commit" ] || fail "asset commit $commit is not the tag's commit $tag_commit"
on_main "$commit" || fail "commit $commit is not on main"

# Newest qualifying run whose log names this tag decides.
gh run list -R "$repo" -w release-hash.yml -L 50 --json databaseId,event,headBranch,headSha,conclusion \
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
  # Every sha256= line in the log must agree, so a confusing log fails.
  logged=$(grep -Eo 'sha256=[0-9a-f]{64}' "$t/log" | cut -d= -f2 | sort -u)
  [ "$logged" = "$sha" ] || fail "run $id logged sha256 $(echo $logged), asset says $sha"
  grep -Eq "commit=$commit\$" "$t/log" || fail "run $id did not log commit $commit"
  found=$id; break
done < "$t/runs"
[ -n "$found" ] || fail "no successful release-hash run for $tag on the tag push or on main"

if [ -n "$source_file" ]; then
  grep -v '^#' "$source_file" | diff - "$t/asset" >/dev/null || fail "$source_file differs from the asset"
fi
echo "verify-release-hash: $tag ok: sha256 $sha, commit $commit, run $found${source_file:+, matches $source_file}"
