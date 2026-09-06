#!/usr/bin/env bash
# Check that main's branch protection still makes CI unskippable (Issue #521; run by branch-protection.yml).
#   branch-protection.sh <owner/repo> <branch>
#     exit 0  settings intact
#     exit 1  settings WEAKENED — the specific setting is named on stdout
#     exit 2  settings could NOT BE READ (no permission / no protection / API down). The reason goes to stderr.
#             Distinct from 1 on purpose: "we could not look" must not be reported as "it is weak" (#540).
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

# The app allowed to report the three security contexts, as the live API returns it (2026-09-06). `check` is
# reported with app_id null ("any app may report it"), so there is nothing to pin for it — pinning null as the
# expected value would be pinning the weaker state as correct.
SECURITY_APP_ID=15368

problems=()

# gh's stdout is captured to a file so that its stderr can be captured separately in the same call
# (`2>&1 >file` sends stderr to the substitution and stdout to the file — the order matters).
TMP_BODY=$(mktemp); trap 'rm -f "$TMP_BODY"' EXIT

# The API error goes to STDERR, never to stdout. Everything this script prints on stdout is copied verbatim into a
# GitHub Issue body by branch-protection.yml, and this repository is PUBLIC; gh echoes the request's Authorization
# header in some failures. Redacting it is a denylist — the first version matched `gh[pousr]_[A-Za-z0-9]+` and let
# `github_pat_…` through untouched (that format contains `_`, so `[A-Za-z0-9]+` does not even match it), and any
# such list is one token format behind. Stderr reaches the job log, which only people who can read Actions can see.
#
# The first fix sent the error to /dev/null instead, which went too far: the message said "see the run log" while
# the run log did not contain it either — an instruction that could not be followed
# (#507: 検査が指示する手順が、検査を黙らせないか見る).
if ! err=$(gh api "repos/$REPO/branches/$BRANCH/protection" 2>&1 >"$TMP_BODY"); then
  # Could not read the settings: the token lacks `administration: read` (this actually happened and opened #540),
  # the branch is unprotected (404), or the API is down.
  #
  # EXIT 2, deliberately distinct from "the settings are weak" (exit 1). Both are failures — "could not read" is
  # never treated as "fine" (#484), since that is exactly the state in which none of the checks below have run.
  # But they need different words: #540 was opened saying "main の branch protection が弱まっている" while the
  # protection was intact, and a wrong alarm every morning is indistinguishable from a real one.
  echo "fail branch-protection: $BRANCH の保護設定を読めなかった（設定が弱いかどうかは判定できていない）"
  printf 'branch-protection: gh api failed: %s\n' "$err" >&2
  echo "  理由はこの run のログ（stderr）に出ている。Issue 本文には出さない: 認証情報が混ざりうる"
  echo "  権限が足りない場合の直し方: docs/ops/deploy.md「main の保護設定」"
  exit 2
fi
body=$(cat "$TMP_BODY")

# jq is present on ubuntu-latest runners and is what gh itself uses; parsing JSON with the shell is how checks
# start passing on inputs they never understood (WORKING_AGREEMENT: 言語の構造は、その言語の実装に解かせる).
# field <jq-filter> [jq args…]   — extra arguments are passed through to jq (used for --arg)
field() { local f=$1; shift; printf '%s' "$body" | jq -r "$@" "$f"; }

# `jq -r` renders both the boolean true and the string "true" as `true`, so a response carrying
# `"enforce_admins": {"enabled": "true"}` would be accepted here. NOT CHECKED ON PURPOSE: this field is produced by
# GitHub, whose schema types it as a boolean, so the string form cannot arrive from the real API — it can only be
# produced by a stub, i.e. by someone already editing this repository, which the audit below cannot defend against
# anyway. Distinguishing them (`… | type`) would add a branch that no real response can reach. Recorded rather than
# silently skipped (WORKING_AGREEMENT: 検査できない形は、なぜ見ていないかを残す).
[ "$(field '.enforce_admins.enabled')" = "true" ] \
  || problems+=("enforce_admins が false: 管理者は必須チェックを1つも通さずに $BRANCH へ push できる")

[ "$(field '.required_status_checks.strict')" = "true" ] \
  || problems+=("required_status_checks.strict が false: main に追随していないコードのまま緑としてマージできる")

[ "$(field '.allow_force_pushes.enabled')" = "false" ] \
  || problems+=("allow_force_pushes が true: $BRANCH の履歴を書き換えられる")

[ "$(field '.allow_deletions.enabled')" = "false" ] \
  || problems+=("allow_deletions が true: $BRANCH を削除できる")

# Who may push to the branch at all. `restrictions` is ABSENT on a healthy main; adding it grants named accounts
# push access, which is a bypass that none of the settings above can see (a review demonstrated the guard saying
# "ok" while one named user could push straight to main). The same applies to a PR-review bypass list. Only the
# PRESENCE is reported — the accounts listed are people, and this text is copied into a public Issue.
[ "$(field 'has("restrictions") and .restrictions != null')" = "false" ] \
  || problems+=("restrictions が設定されている: 名指しのアカウントが $BRANCH へ直接 push できる")

[ "$(field '(.required_pull_request_reviews.bypass_pull_request_allowances // null) != null')" = "false" ] \
  || problems+=("bypass_pull_request_allowances が設定されている: 名指しのアカウントが PR の要件を迂回できる")

# The set of required contexts. Missing ones are named one by one; extra ones are fine (a new CI job being
# required is not a weakening) — so this is a subset test, not an equality test.
contexts=$(field '.required_status_checks.checks[]?.context')
for want in "${REQUIRED_CHECKS[@]}"; do
  grep -qxF "$want" <<<"$contexts" \
    || problems+=("必須チェック '$want' が外れている: その検査を通さずにマージできる")
done

# A context is identified by name AND by the app that reports it. Keeping the name while pointing it at another
# app_id lets a different integration report `gitleaks` as green (#504: 名前を固定した is not 値を固定した).
# Only the three security contexts are pinned: `check` is required with app_id null ("any app"), and demanding a
# particular app for it would report the current, healthy configuration as broken.
for want in gitleaks forbidden-patterns audit; do
  # shellcheck disable=SC2016  # $c is jq syntax, bound by --arg below, not expanded by the shell
  got=$(field '.required_status_checks.checks[]? | select(.context == $c) | .app_id | tostring' --arg c "$want")
  # missing context is already reported above; only complain when it is present and reported by another app
  [ -z "$got" ] || [ "$got" = "$SECURITY_APP_ID" ] \
    || problems+=("必須チェック '$want' を報告するアプリが変わっている: 別の連携が緑を報告できる")
done

if [ ${#problems[@]} -gt 0 ]; then
  echo "fail branch-protection: $REPO の $BRANCH で、CI を必須にしている設定が弱まっている"
  for p in "${problems[@]}"; do echo "  - $p"; done
  echo "  直し方: docs/ops/deploy.md「main の保護設定」"
  exit 1
fi

echo "ok branch-protection: $BRANCH は保護されている（enforce_admins / strict / 必須チェック ${#REQUIRED_CHECKS[@]} 件）"
