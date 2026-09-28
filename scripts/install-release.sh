#!/usr/bin/env bash
set -euo pipefail
[[ $# == 4 ]] || { echo 'usage: install-release.sh NODE ARTIFACT EXPECTED PREFIX' >&2; exit 64; }
node=$1 artifact=$2 expected=$3 prefix=$4
root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
"$node" "$root/verify-artifact.mts" "$artifact" "$expected"
release="$prefix/.local/share/host-monitor/releases/$expected"
if [[ -e "$release" ]]; then
  "$node" "$root/verify-artifact.mts" "$release" "$expected"
else
  install -d -m 755 "$(dirname "$release")"
  stage=$(mktemp -d "$(dirname "$release")/.stage.XXXXXX")
  trap 'rm -rf "$stage"' EXIT
  cp -R "$artifact/." "$stage/"
  "$node" "$root/verify-artifact.mts" "$stage" "$expected"
  chmod -R u=rwX,go=rX "$stage"
  mv "$stage" "$release"
  trap - EXIT
fi
printf '%s\n' "$release"
