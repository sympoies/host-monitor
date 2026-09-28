#!/usr/bin/env bash
# Package the release assets that infrastructure repositories pin and install.
# Usage: package-release.sh OUTPUT TAG
#   OUTPUT  directory to create; it must not exist yet
#   TAG     release tag; must equal v<package.json version>
# Writes host-monitor-<version>-<artifact>.tar.gz, verify-artifact.mjs,
# install-release.sh, artifact-id and SHA256SUMS to OUTPUT and prints a JSON
# summary. SOURCE_DATE_EPOCH (default 0) fixes archive timestamps so the same
# source reproduces the same tarball bytes. Requires GNU tar, gzip, sha256sum.
set -euo pipefail
[[ $# == 2 ]] || { echo 'usage: package-release.sh OUTPUT TAG' >&2; exit 64; }
out=$1 tag=$2 node=${NODE:-node}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
version=$("$node" -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version' "$root/package.json")
[[ $tag == "v$version" ]] || { echo "release tag $tag does not match package version v$version" >&2; exit 65; }
[[ ! -e $out ]] || { echo "output $out already exists" >&2; exit 64; }
epoch=${SOURCE_DATE_EPOCH:-0}
[[ $epoch =~ ^[0-9]+$ ]] || { echo 'SOURCE_DATE_EPOCH must be an integer' >&2; exit 64; }

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
artifact=$("$node" "$root/scripts/build-artifact.mjs" "$stage/build" | "$node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).artifact))')
"$node" "$root/scripts/verify-artifact.mjs" "$stage/build" "$artifact" >/dev/null
name="host-monitor-$version-$artifact"
mv "$stage/build" "$stage/$name"

mkdir -p "$stage/assets"
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$epoch" \
  --mode='u+rwX,go+rX,go-w' -C "$stage" -cf - "$name" | gzip -n -9 >"$stage/assets/$name.tar.gz"
install -m 644 "$root/scripts/verify-artifact.mjs" "$stage/assets/verify-artifact.mjs"
install -m 755 "$root/scripts/install-release.sh" "$stage/assets/install-release.sh"
printf '%s\n' "$artifact" >"$stage/assets/artifact-id"
(cd "$stage/assets" && sha256sum -- "$name.tar.gz" artifact-id install-release.sh verify-artifact.mjs >SHA256SUMS)

mkdir -p "$(dirname "$out")"
mv "$stage/assets" "$out"
printf '{"version":"%s","artifact":"%s","tarball":"%s.tar.gz"}\n' "$version" "$artifact" "$name"
