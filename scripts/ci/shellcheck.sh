#!/usr/bin/env bash
# Issue #154: the ONE list of shell targets for shellcheck, used identically by CI (ci.yml) and by hand.
#   scripts/ci/shellcheck.sh          → shellcheck -x <every target>  (exit status = shellcheck's)
#   scripts/ci/shellcheck.sh --list   → print the targets, one per line (sorted, repo-relative)
# Targets = under scripts/ and deploy/ (node_modules skipped): every *.sh, plus every extensionless file whose
# first line is a bash/sh shebang (e.g. scripts/po/test/fake-bin/gh). Run from the repo root.
set -euo pipefail

list_targets() {
  local f
  find scripts deploy -type d -name node_modules -prune -o -type f -print | while IFS= read -r f; do
    if [[ $f == *.sh ]]; then echo "$f"
    elif [[ $f != */*.* ]] && grep -qE '^#!.*(/| )(ba)?sh( |$)' < <(head -n1 < <(head -c 64 "$f" 2>/dev/null)); then echo "$f"
    fi
  done | LC_ALL=C sort
}

case "${1:-}" in
  --list) list_targets ;;
  "")
    mapfile -t targets < <(list_targets)
    [[ ${#targets[@]} -gt 0 ]] || { echo "shellcheck.sh: no targets found (run from the repo root)" >&2; exit 2; }
    shellcheck -x "${targets[@]}" ;;
  *) echo "usage: $0 [--list]" >&2; exit 2 ;;
esac
