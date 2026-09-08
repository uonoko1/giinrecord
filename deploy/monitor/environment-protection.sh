#!/usr/bin/env bash
# Check that the deployment Environments still match the intent recorded in #659 (run by environment-protection.yml).
#   environment-protection.sh <owner/repo>
#     exit 0  the environments match the intent below
#     exit 1  they DRIFTED — the specific environment and setting is named on stdout
#     exit 2  they could NOT BE READ (no permission / API down). The reason goes to stderr.
#             Distinct from 1 on purpose: "we could not look" must not be reported as "it drifted" (#540).
#
# Why this exists: exactly the reason branch-protection.sh exists, one level over. An Environment's
# `protection_rules` are GitHub *settings*, not repository content. Adding a required reviewer is one click in the
# settings UI, it leaves nothing in any diff, and no review or CI run can see it. #660 wrote into the docs that
# `production` has no required reviewers, and its author said so plainly:
#   「environment の protection_rules はリポジトリの中身ではないので、CI からは検証できません。
#     誰かが設定画面で reviewers を付けても、この PR のテストは緑のまま通ります。」
# That is the gap this closes (#661). It does not make the change impossible — it makes it impossible to do
# QUIETLY: the next scheduled run opens an Issue naming the environment.
# WORKING_AGREEMENT: 「防御は不可能にすることではなく、隠れて通れなくすること」.
#
# NOTE ON DIRECTION — this guard is not "stricter is always better".
# branch-protection.sh only ever complains about settings getting WEAKER. Here BOTH directions are a problem, and
# the reason is asymmetric:
#   a rule APPEARING   → the deploy stops and waits for a human. `production-data` deploys daily; a required
#                        reviewer there halts the data pipeline every day, and nobody would connect the stall to a
#                        settings change made weeks earlier.
#   a rule DISAPPEARING → if the intent below ever says a reviewer IS required, losing it silently removes the gate.
# So this compares against a RECORDED INTENT, not against "fewer rules is fine".
#
# ── HOW TO CHANGE THE INTENT ─────────────────────────────────────────────────────────────────────────────────
# The intent is the EXPECTED_RULES table below, and it is hardcoded ON PURPOSE. Deriving it from the API response
# would compare the settings with themselves and pass whatever they happen to be (#499: 期待値はハードコードする).
#
# To require reviewers on `production` (a decision #659 explicitly left open):
#   1. change the line to        EXPECTED_RULES[production]="required_reviewers"
#   2. make the change in GitHub → Settings → Environments → production
#   3. update docs/ops/deploy.md, which states the current intent in prose
#   4. deploy/test/environment-protection.test.sh fixes the table's contents in a separate place; update it too
#      (it is a second, independent copy so that shrinking one alone cannot pass — #521 review)
# The value is a space-separated set of rule `type`s as the API spells them, or the empty string for "no rules".
# Recognised types (GitHub, 2026-09): required_reviewers, wait_timer, branch_policy.
# ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
#   Tests: deploy/test/environment-protection.test.sh (gh is a stub)
set -euo pipefail

REPO=${1:-}
[ -n "$REPO" ] || { echo "usage: environment-protection.sh <owner/repo>" >&2; exit 2; }

# The intent, from #659 (案A). Read the block above before changing anything here.
#   production        承認は置かない。置くとサイトの公開が人待ちになる
#   production-data   データの日次デプロイ。置くと毎日止まる
#   staging           承認は置かない
declare -A EXPECTED_RULES=(
  [production]=""
  [production-data]=""
  [staging]=""
)

problems=()

# gh's stdout is captured to a file so that its stderr can be captured separately in the same call
# (`2>&1 >file` sends stderr to the substitution and stdout to the file — the order matters).
TMP_BODY=$(mktemp); trap 'rm -f "$TMP_BODY"' EXIT

# The API error goes to STDERR, never to stdout. Everything this script prints on stdout is copied verbatim into a
# GitHub Issue body by environment-protection.yml, and this repository is PUBLIC; gh echoes the request's
# Authorization header in some failures. Redacting it would be a denylist, and any such list is one token format
# behind (branch-protection.sh, lines 56-60: the first version matched `gh[pousr]_[A-Za-z0-9]+` and let
# `github_pat_…` straight through). Stderr reaches the job log, which only people who can read Actions can see —
# and it must reach it: sending the message to /dev/null instead made the guard say "see the run log" while the run
# log did not have it either (#507: 検査が指示する手順が、検査を黙らせないか見る).
#
# MEASURED (2026-09-08, run 34218226742): the workflow's default GITHUB_TOKEN, with `permissions: contents: read`
# only, reads this endpoint — rc=0, total_count 3. This is NOT like branch protection, which needs a fine-grained
# PAT that no one has installed yet (#540/#550). No human step is pending for this guard. The exit-2 path below is
# still fully wired, because a token's permissions can be narrowed later and the endpoint can be down.
if ! err=$(gh api "repos/$REPO/environments" 2>&1 >"$TMP_BODY"); then
  # EXIT 2, deliberately distinct from "the settings drifted" (exit 1). Both are failures — "could not read" is
  # never treated as "fine" (#484), since that is exactly the state in which none of the checks below have run.
  # But they need different words: #540 was an Issue saying the protection was weak while it was intact, and a
  # wrong alarm every morning is indistinguishable from a real one.
  echo "fail environment-protection: $REPO の Environment 設定を読めなかった（意図どおりかどうかは判定できていない）"
  printf 'environment-protection: gh api failed: %s\n' "$err" >&2
  echo "  理由はこの run のログ（stderr）に出ている。Issue 本文には出さない: 認証情報が混ざりうる"
  echo "  直し方: docs/ops/deploy.md「Environment の保護設定」"
  exit 2
fi
body=$(cat "$TMP_BODY")

# jq parses the JSON; parsing it with the shell is how checks start passing on inputs they never understood
# (WORKING_AGREEMENT: 言語の構造は、その言語の実装に解かせる).
# A response that is not an object with `.environments` as an array is not "zero environments" — it is unreadable.
# Without this, a body of `{}` or `[]` would make every loop below iterate zero times and the guard would print ok
# (#484: a check that can only fail on a written violation is not alive).
if ! printf '%s' "$body" | jq -e 'type == "object" and (.environments | type) == "array"' >/dev/null 2>&1; then
  echo "fail environment-protection: $REPO の Environment 一覧を JSON として解釈できなかった（意図どおりかどうかは判定できていない）"
  printf 'environment-protection: unexpected response shape\n' >&2
  echo "  理由はこの run のログ（stderr）に出ている。Issue 本文には出さない: 認証情報が混ざりうる"
  exit 2
fi

# name<TAB>space-separated sorted rule types, one line per environment. Sorted so that the comparison does not
# depend on the order GitHub happens to return the rules in.
actual=$(printf '%s' "$body" | jq -r '
  .environments[]
  | [.name, ([.protection_rules[]?.type] | sort | join(" "))]
  | @tsv')

seen=()
while IFS=$'\t' read -r name rules; do
  [ -n "$name" ] || continue
  seen+=("$name")
  if [ -z "${EXPECTED_RULES[$name]+set}" ]; then
    # An environment nobody recorded an intent for. Not automatically a weakening — but a deploy target that no
    # document describes is exactly how `production-data` would have slipped in unnoticed, so it is reported.
    problems+=("Environment '$name' は意図の表に無い: 誰も承認要否を決めていないデプロイ先がある")
    continue
  fi
  # Normalise the expected set the same way jq normalised the actual one: split on spaces, drop empties, sort,
  # rejoin with single spaces. Done with bash word-splitting rather than a pipeline — `grep -v` on an empty set
  # exits 1, and under `set -e` that killed the script mid-loop before anything was printed (measured: the guard
  # exited 1 with EMPTY stdout, so the Issue body would have said nothing at all).
  read -r -a want_arr <<< "${EXPECTED_RULES[$name]}"
  want=""
  if [ ${#want_arr[@]} -gt 0 ]; then
    want=$(printf '%s\n' "${want_arr[@]}" | sort | tr '\n' ' ')
    want=${want% }
  fi
  got=$rules
  if [ "$want" != "$got" ]; then
    # Both directions are reported, with the consequence spelled out, because they are different failures.
    if [ -z "$want" ]; then
      problems+=("Environment '$name' に承認/待機のルールが付いた（[$got]）: このデプロイは人の操作を待って止まる")
    elif [ -z "$got" ]; then
      problems+=("Environment '$name' から承認/待機のルールが消えた（期待 [$want]）: 通すはずの関門が無くなっている")
    else
      problems+=("Environment '$name' のルールが変わった（期待 [$want] / 実際 [$got]）")
    fi
  fi
done <<< "$actual"

# The other direction: an environment in the table that the API did not return. Deleting an environment is also a
# settings change with no diff, and a subset test in one direction alone is satisfied for free when the left side
# shrinks (#541: 「痩せたら落とす」の片側だけでは足りない).
for name in "${!EXPECTED_RULES[@]}"; do
  found=0
  for s in ${seen[@]+"${seen[@]}"}; do [ "$s" = "$name" ] && { found=1; break; }; done
  [ "$found" = 1 ] || problems+=("Environment '$name' が存在しない: 意図の表にあるデプロイ先が消えている（表が古いか、設定が消された）")
done

if [ ${#problems[@]} -gt 0 ]; then
  echo "fail environment-protection: $REPO の Environment 設定が、記録された意図（#659）と食い違っている"
  for p in "${problems[@]}"; do echo "  - $p"; done
  echo "  直し方: docs/ops/deploy.md「Environment の保護設定」"
  echo "  意図そのものを変えたのなら、deploy/monitor/environment-protection.sh の EXPECTED_RULES を直す（手順は同ファイル冒頭）"
  exit 1
fi

echo "ok environment-protection: Environment ${#EXPECTED_RULES[@]} 件は意図どおり（承認/待機のルールは置かれていない）"
