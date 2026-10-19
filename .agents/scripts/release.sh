#!/usr/bin/env bash
# Repository release dispatcher: the signed-tag release flow from DEVELOPMENT.md.
# Usage: release.sh --dry-run [COMMIT]
#        release.sh --execute [COMMIT]
#   COMMIT   merged main commit to release (default: HEAD)
# --dry-run runs every read-only check, builds the release assets in a
# temporary directory, and prints the planned version, tag, and steps. It
# creates no tag, pushes nothing, and leaves the repository unchanged.
# --execute additionally runs `npm run validate`, creates the signed tag,
# pushes it, waits for the `release` workflow to publish, and prints the
# release URL after checking the published artifact id.
# Environment: RELEASE_REMOTE (default origin), RELEASE_BRANCH (default main),
# RELEASE_WAIT_SECONDS (default 900), RELEASE_POLL_SECONDS (default 10), NODE (default node).
# Exit codes: 64 usage, 65 a release precondition failed, 69 publish failed.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
remote=${RELEASE_REMOTE:-origin} branch=${RELEASE_BRANCH:-main} node=${NODE:-node}
wait_seconds=${RELEASE_WAIT_SECONDS:-900}
die() { echo "release: $2" >&2; exit "$1"; }
usage() { die 64 'usage: release.sh (--dry-run|--execute) [COMMIT]'; }

mode=''
commit_arg=''
for arg in "$@"; do
  case $arg in
    --dry-run|--execute) [[ -z $mode ]] || usage; mode=$arg ;;
    -*) usage ;;
    *) [[ -z $commit_arg ]] || usage; commit_arg=$arg ;;
  esac
done
[[ -n $mode ]] || usage
cd "$root"

commit=$(git rev-parse --verify --quiet "${commit_arg:-HEAD}^{commit}") || die 65 "unknown commit ${commit_arg:-HEAD}"
# Refresh the remote branch and tags so the merged and tag checks see current state; --dry-run
# (which must not change repository state) uses the refs already present.
if [[ $mode == --execute ]]; then
  git fetch --quiet --tags "$remote" "$branch" || die 65 "cannot fetch $remote/$branch"
else
  echo "note: --dry-run does not fetch; $remote/$branch is as of the last fetch" >&2
fi
main_ref="refs/remotes/$remote/$branch"
git rev-parse --verify --quiet "$main_ref" >/dev/null || die 65 "$remote/$branch is not available locally"
git merge-base --is-ancestor "$commit" "$main_ref" || die 65 "commit ${commit:0:12} is not merged into $remote/$branch"

version=$(git show "$commit:package.json" | "$node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 65 "package.json version '$version' is not MAJOR.MINOR.PATCH"
tag=v$version

git show "$commit:docs/devlog/README.md" >/dev/null 2>&1 || die 65 'docs/devlog/ is missing at the release commit'
git grep -qE "^## [0-9-]+ - ${version//./\\.}[: ]" "$commit" -- docs/devlog || die 65 "no devlog release entry for $version"

! git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null || die 65 "tag $tag already exists locally"
remote_tag=$(git ls-remote --tags "$remote" "refs/tags/$tag") || die 65 "cannot read tags from $remote"
[[ -z $remote_tag ]] || die 65 "tag $tag already exists on $remote"

# Package from the release commit itself, never from the working tree. The staged copy links this
# checkout's installed dev dependencies, which the artifact build needs (TypeScript).
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
build_assets() {
  [[ -d $root/node_modules ]] || die 65 'node_modules is missing; run npm ci first'
  git archive --format=tar "$commit" | tar -x -C "$stage"
  ln -s "$root/node_modules" "$stage/node_modules"
  export SOURCE_DATE_EPOCH
  SOURCE_DATE_EPOCH=$(git log -1 --format=%ct "$commit")
  summary=$(bash "$stage/scripts/package-release.sh" "$stage/release" "$tag") || die 65 'release assets failed to build'
  artifact=$("$node" -e 'console.log(JSON.parse(process.argv[1]).artifact)' "$summary")
  [[ $artifact =~ ^[a-f0-9]{64}$ ]] || die 65 'packaged artifact id is not a SHA-256 hash'
  [[ $(cat "$stage/release/artifact-id") == "$artifact" ]] || die 65 'artifact-id asset differs from the artifact id'
}

steps=(
  "validate: npm ci && npm run validate at ${commit:0:12}"
  "package: build the release assets from the commit and record the artifact id"
  "tag: git tag -s $tag -m $tag ${commit:0:12}, then verify the signature"
  "push: git push $remote $tag"
  "publish: the release workflow publishes the GitHub release and assets"
  "verify: the published artifact-id asset equals the locally built artifact id"
)
if [[ $mode == --dry-run ]]; then
  build_assets
  echo "dry-run: nothing was tagged, pushed, or published"
  echo "version: $version"
  echo "tag: $tag"
  echo "commit: $commit"
  echo "artifact: $artifact"
  printf 'step: %s\n' "${steps[@]}"
  exit 0
fi

[[ -z $(git status --porcelain) ]] || die 65 'working tree is not clean'
[[ $(git rev-parse HEAD) == "$commit" ]] || die 65 'check out the release commit before --execute'
npm ci || die 65 'npm ci failed; no tag was created'
npm run validate || die 65 'npm run validate failed; no tag was created'
build_assets
git tag -s "$tag" -m "$tag" "$commit" || die 65 "signing tag $tag failed; no tag was created"
git tag -v "$tag" >/dev/null 2>&1 || { git tag -d "$tag" >/dev/null; die 65 "tag $tag signature did not verify; local tag removed"; }
git push "$remote" "refs/tags/$tag" || die 69 "pushing $tag failed; delete the unpushed local tag with: git tag -d $tag"

deadline=$((SECONDS + wait_seconds))
url=''
while :; do
  if url=$(gh release view "$tag" --json url --jq .url 2>/dev/null) && [[ -n $url ]]; then break; fi
  (( SECONDS < deadline )) || die 69 "release $tag was not visible within ${wait_seconds}s (workflow still running, or gh failed); tag $tag is already pushed"
  sleep "${RELEASE_POLL_SECONDS:-10}"
done
published=$(gh release download "$tag" --pattern artifact-id --output - 2>/dev/null) || die 69 "cannot read the artifact-id asset of $url; tag $tag is already pushed"
[[ $published == "$artifact" ]] || die 69 "published artifact id $published differs from $artifact; tag $tag is already pushed"
echo "release: $url"
echo "artifact: $artifact"
echo "verified: published artifact-id matches the locally built artifact"
