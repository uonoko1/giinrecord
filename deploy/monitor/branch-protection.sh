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

# The app allowed to report the three security contexts, as the live API returns it (2026-09-06). `check` is
# reported with app_id null ("any app may report it"), so there is nothing to pin for it — pinning null as the
# expected value would be pinning the weaker state as correct.
SECURITY_APP_ID=15368

problems=()

# gh's stderr is left on stderr: it reaches the JOB LOG (readable only by people who can read Actions) and never
# this script's stdout. Everything printed on stdout is copied verbatim into a GitHub Issue body by
# branch-protection.yml, and this repository is PUBLIC — so an API error message must not be relayed there.
# gh echoes the request's Authorization header in some failures, and redacting it is a denylist: the first version
# of this line matched `gh[pousr]_[A-Za-z0-9]+` and passed `github_pat_11ABCDEFG0aaaa..._bbbb` through untouched
# (the current fine-grained-PAT format contains `_`, so it does not even match `[A-Za-z0-9]+`). Any such list is one
# token format behind. So the message is not printed at all: the reason is in the job log, and the Issue body
# already carries the run URL.
if ! body=$(gh api "repos/$REPO/branches/$BRANCH/protection" 2>/dev/null); then
  # No protection at all (404), no permission, or the API is down. Never treat "could not read" as "fine": that is
  # exactly the state where everything below is unenforced (#484).
  echo "fail branch-protection: $BRANCH の保護設定を読めなかった。保護そのものが外れている可能性がある"
  echo "  gh api が失敗した。理由はこの run のログを見ること（Issue 本文には出さない: 認証情報が混ざりうる）"
  exit 1
fi

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
