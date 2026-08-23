#!/usr/bin/env bash
# Issue #134: production gets code from the last release, data from main.
#   released-ref.sh resolve          → prints the sha of refs/tags/released on origin, or `main` if the tag
#                                      does not exist yet (first run before any Release). Used by deploy-data.yml
#                                      to pick the ref deploy-site.yml builds for production.
#   released-ref.sh overlay <ref>    → replaces ./data with data/ from <ref> on origin (adds AND deletes, so the
#                                      tree equals <ref>'s data/). Code outside data/ is untouched. Empty <ref>
#                                      = no-op (staging / Release build the ref as is).
# Run inside the checked-out repo (actions/checkout leaves remote `origin`). Needs git only.
set -euo pipefail
usage() { echo "usage: $0 resolve | overlay <ref>" >&2; exit 2; }
cmd=${1:-}
case "$cmd" in
  resolve)
    sha=$(git ls-remote --tags origin refs/tags/released | awk '$2 == "refs/tags/released" { print $1 }')
    if [[ -n "$sha" ]]; then echo "$sha"; else echo main; fi ;;
  overlay)
    [[ $# -ge 2 ]] || usage
    ref=$2
    if [[ -z "$ref" ]]; then echo "overlay: no data ref given, skip"; exit 0; fi
    git fetch --quiet --depth=1 origin "$ref"       # fails (and leaves data/ alone) if the ref does not exist
    from=$(git rev-parse FETCH_HEAD)
    rm -rf data
    git checkout --quiet FETCH_HEAD -- data
    echo "overlay: data/ replaced with data/ from $ref @ $from" ;;
  *) usage ;;
esac
