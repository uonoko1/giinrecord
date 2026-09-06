#!/usr/bin/env bash
# Issue #154: the ONE list of shell targets for shellcheck, used identically by CI (ci.yml) and by hand.
# Issue #552: and the ONE pinned version, for the same reason -- the list being shared did not stop CI and a
# developer from linting with different shellchecks and getting different answers.
#   scripts/ci/shellcheck.sh                    → shellcheck -x <every target>  (exit status = shellcheck's)
#   scripts/ci/shellcheck.sh --list             → print the targets, one per line (sorted, repo-relative)
#   scripts/ci/shellcheck.sh --pinned-version   → print the pinned version (x.y.z), nothing else
#   scripts/ci/shellcheck.sh --pinned-sha256    → print the pinned sha256 of the linux.x86_64 tarball, nothing else
#   scripts/ci/shellcheck.sh --download-url     → print the URL ci.yml downloads the tarball from, nothing else
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
# To bump the pin, see docs/ops/shellcheck.md: change the one line below and nothing else. ci.yml installs
# whatever `--pinned-version` prints, so there is no second copy of the number to keep in step (and
# scripts/ci/test/shellcheck.test.sh fails if a version is ever hardcoded back into the workflow).
#
# Why the sha256 is also pinned (#571, from #552's review): pinning the version number pins the *name*, not
# the bytes. GitHub Releases assets can in principle be replaced (e.g. a compromised maintainer account),
# and ci.yml places this binary in /usr/local/bin as root and then feeds it the whole repository. The
# sha256 below was computed by downloading the asset at the URL --download-url prints and running
# `sha256sum` on it (done twice, on 2026-09-07, both runs agreeing) -- not copied from anyone's report.
set -euo pipefail

SHELLCHECK_PINNED_VERSION=0.11.0
# sha256 of shellcheck-v0.11.0.linux.x86_64.tar.xz, computed by hand (see comment above), not retyped
# from a third party.
SHELLCHECK_PINNED_SHA256=8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198

list_targets() {
  local f
  find scripts deploy -type d -name node_modules -prune -o -type f -print | while IFS= read -r f; do
    if [[ $f == *.sh ]]; then echo "$f"
    elif [[ $f != */*.* ]] && grep -qE '^#!.*(/| )(ba)?sh( |$)' < <(head -n1 < <(head -c 64 "$f" 2>/dev/null)); then echo "$f"
    fi
  done | LC_ALL=C sort
}

# The version shellcheck reports, or empty if it cannot be run at all. `shellcheck --version` prints a
# header and then `version: x.y.z`; take that line and nothing else.
# `set -e` + `pipefail` would kill the script at the substitution below when shellcheck is absent (exit 127)
# before the message explaining what to install ever prints, so failure is swallowed deliberately here.
found_version() {
  command -v shellcheck >/dev/null 2>&1 || return 0
  # パイプを使わない（#527）。`sed` に 1 件で止めさせるので `head` も要らない。
  sed -n 's/^version: *//p;T;q' < <(shellcheck --version 2>/dev/null) || true
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
  --pinned-sha256) echo "$SHELLCHECK_PINNED_SHA256" ;;
  --download-url)
    echo "https://github.com/koalaman/shellcheck/releases/download/v$SHELLCHECK_PINNED_VERSION/shellcheck-v$SHELLCHECK_PINNED_VERSION.linux.x86_64.tar.xz" ;;
  "")
    require_pinned_version
    mapfile -t targets < <(list_targets)
    [[ ${#targets[@]} -gt 0 ]] || { echo "shellcheck.sh: no targets found (run from the repo root)" >&2; exit 2; }
    shellcheck -x "${targets[@]}" ;;
  *) echo "usage: $0 [--list|--pinned-version|--pinned-sha256|--download-url]" >&2; exit 2 ;;
esac
