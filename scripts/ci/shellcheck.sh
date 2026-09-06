#!/usr/bin/env bash
# Issue #154: the ONE list of shell targets for shellcheck, used identically by CI (ci.yml) and by hand.
# Issue #552: and the ONE pinned version, for the same reason -- the list being shared did not stop CI and a
# developer from linting with different shellchecks and getting different answers.
#   scripts/ci/shellcheck.sh                    → shellcheck -x <every target>  (exit status = shellcheck's)
#   scripts/ci/shellcheck.sh --list             → print the targets, one per line (sorted, repo-relative)
#   scripts/ci/shellcheck.sh --pinned-version   → print the pinned version (x.y.z), nothing else
# Targets = under scripts/ and deploy/ (node_modules skipped): every *.sh, plus every extensionless file whose
# first line is a bash/sh shebang (e.g. scripts/po/test/fake-bin/gh). Run from the repo root.
#
# Why the version is pinned (#552, from #542): `ubuntu-latest` ships whatever shellcheck it ships, so the same
# tree gets different answers over time and between machines. Measured on this repo's own probes:
#   `i+=1`            → 0.9.0 says nothing;         0.10.0/0.11.0 say SC2324 (a real bug: it appends, not adds)
#   an uncalled fn    → 0.9.0/0.10.0 say SC2317;    0.11.0 says SC2329
# So "shellcheck passed" is only a claim about a particular version. Refusing to run under any other version
# is the point: a silent pass from the wrong version is worse than no run at all, because it looks like a run.
#
# To bump the pin, see docs/ops/shellcheck.md. Both this line and .github/workflows/ci.yml must move together;
# scripts/ci/test/shellcheck.test.sh fails if only one of them does.
set -euo pipefail

SHELLCHECK_PINNED_VERSION=0.11.0

list_targets() {
  local f
  find scripts deploy -type d -name node_modules -prune -o -type f -print | while IFS= read -r f; do
    if [[ $f == *.sh ]]; then echo "$f"
    elif [[ $f != */*.* ]] && head -c 64 "$f" 2>/dev/null | head -n1 | grep -qE '^#!.*(/| )(ba)?sh( |$)'; then echo "$f"
    fi
  done | LC_ALL=C sort
}

# The version shellcheck reports, or empty if it cannot be run at all. `shellcheck --version` prints a
# header and then `version: x.y.z`; take that line and nothing else.
found_version() {
  shellcheck --version 2>/dev/null | sed -n 's/^version: *//p' | head -n1
}

require_pinned_version() {
  local found; found=$(found_version)
  if [[ -z $found ]]; then
    echo "shellcheck.sh: shellcheck が見つかりません（必要な版: $SHELLCHECK_PINNED_VERSION）。" \
         "導入方法は docs/ops/shellcheck.md を参照してください。" >&2
    exit 3
  fi
  if [[ $found != "$SHELLCHECK_PINNED_VERSION" ]]; then
    echo "shellcheck.sh: 版が違います。見つかった版=$found / 必要な版=$SHELLCHECK_PINNED_VERSION" >&2
    echo "  版が違うと指摘も違います（実測: \`i+=1\` は 0.9.0 では無警告、0.10.0 以降は SC2324）。" >&2
    echo "  違う版で通しても「通った」とは言えないので、ここで止めます。docs/ops/shellcheck.md を参照してください。" >&2
    exit 3
  fi
}

case "${1:-}" in
  --list) list_targets ;;
  --pinned-version) echo "$SHELLCHECK_PINNED_VERSION" ;;
  "")
    require_pinned_version
    mapfile -t targets < <(list_targets)
    [[ ${#targets[@]} -gt 0 ]] || { echo "shellcheck.sh: no targets found (run from the repo root)" >&2; exit 2; }
    shellcheck -x "${targets[@]}" ;;
  *) echo "usage: $0 [--list|--pinned-version]" >&2; exit 2 ;;
esac
