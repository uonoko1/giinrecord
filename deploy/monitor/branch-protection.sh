#!/usr/bin/env bash
# Check that main's branch protection still makes CI unskippable (Issue #521; run by branch-protection.yml).
#   branch-protection.sh <owner/repo> <branch>       exit 0 = intact, 1 = weakened / unreadable
#
# Why this exists: branch protection is GitHub *settings*, not repository content. Weakening it is one API call,
# it leaves nothing in any diff, and no review or CI run can see it. `enforce_admins` was false for an unknown
# length of time and three commits reached main without a single required check running (#521). git even says so
# on the push — "Bypassed rule violations for refs/heads/main" — but that line reads like a rejection, and the
# push succeeds with exit code 0.
#
# So this does NOT try to make bypassing impossible (enforce_admins does that, and an admin can always turn it off
# again). It makes it impossible to do *quietly*: the next scheduled run opens an Issue naming the setting.
# WORKING_AGREEMENT: 「防御は不可能にすることではなく、隠れて通れなくすること」.
#
# What is pinned, and why each one matters if it is lost:
#   enforce_admins        false → admins push straight to main, no check runs at all (the bug this Issue is about)
#   required checks       the SET, not the count. Losing `gitleaks` stops requiring secret scanning; losing
#                         `forbidden-patterns` stops requiring the server-detail check; losing `audit` stops
#                         requiring the dependency advisories; losing `check` stops requiring lint/typecheck/test.
#                         Pinned by name because swapping one context for another keeps the count at 4 (#499).
#   strict                false → a PR can merge without main's newer commits, so the checks that passed were
#                         never run against the code that ends up on main
#   allow_force_pushes    true  → history on main can be rewritten, which erases the record of what was merged
#   allow_deletions       true  → main itself can be deleted
# The expected values are hardcoded HERE, on purpose. Deriving them from the API response would compare the
# settings with themselves and pass whatever they happen to be (#499: 期待値はハードコードする).
#   Tests: deploy/test/branch-protection.test.sh (gh is a stub)
set -euo pipefail

REPO=${1:-}; BRANCH=${2:-main}
[ -n "$REPO" ] || { echo "usage: branch-protection.sh <owner/repo> [branch]" >&2; exit 2; }

# The required status checks that must ALL still be required. Names are the CI job names:
# `check` is .github/workflows/ci.yml; the other three are .github/workflows/security.yml.
REQUIRED_CHECKS=(check gitleaks forbidden-patterns audit)

problems=()

# 2>&1: gh writes API errors to stderr. Capturing them keeps the reason in $body for the report, and keeps it out
# of the job log where it would be printed twice.
if ! body=$(gh api "repos/$REPO/branches/$BRANCH/protection" 2>&1); then
  # No protection at all (404), no permission, or the API is down. Never treat "could not read" as "fine": that is
  # exactly the state where everything below is unenforced (#484).
  echo "fail branch-protection: $BRANCH の保護設定を読めなかった。保護そのものが外れている可能性がある"
  # Print gh's own message, but only the first line and without anything token-shaped.
  echo "  gh: $(printf '%s' "$body" | head -n1 | sed -E 's/gh[pousr]_[A-Za-z0-9]+/<redacted>/g')"
  exit 1
fi

# jq is present on ubuntu-latest runners and is what gh itself uses; parsing JSON with the shell is how checks
# start passing on inputs they never understood (WORKING_AGREEMENT: 言語の構造は、その言語の実装に解かせる).
field() { printf '%s' "$body" | jq -r "$1"; }

[ "$(field '.enforce_admins.enabled')" = "true" ] \
  || problems+=("enforce_admins が false: 管理者は必須チェックを1つも通さずに $BRANCH へ push できる")

[ "$(field '.required_status_checks.strict')" = "true" ] \
  || problems+=("required_status_checks.strict が false: main に追随していないコードのまま緑としてマージできる")

[ "$(field '.allow_force_pushes.enabled')" = "false" ] \
  || problems+=("allow_force_pushes が true: $BRANCH の履歴を書き換えられる")

[ "$(field '.allow_deletions.enabled')" = "false" ] \
  || problems+=("allow_deletions が true: $BRANCH を削除できる")

# The set of required contexts. Missing ones are named one by one; extra ones are fine (a new CI job being
# required is not a weakening) — so this is a subset test, not an equality test.
contexts=$(field '.required_status_checks.checks[]?.context')
for want in "${REQUIRED_CHECKS[@]}"; do
  grep -qxF "$want" <<<"$contexts" \
    || problems+=("必須チェック '$want' が外れている: その検査を通さずにマージできる")
done

if [ ${#problems[@]} -gt 0 ]; then
  echo "fail branch-protection: $REPO の $BRANCH で、CI を必須にしている設定が弱まっている"
  for p in "${problems[@]}"; do echo "  - $p"; done
  echo "  直し方: docs/ops/deploy.md「main の保護設定」"
  exit 1
fi

echo "ok branch-protection: $BRANCH は保護されている（enforce_admins / strict / 必須チェック ${#REQUIRED_CHECKS[@]} 件）"
