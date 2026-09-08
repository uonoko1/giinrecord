#!/usr/bin/env bash
# Turn environment-protection.sh's exit code into GitHub Issue state (Issue #661; used by environment-protection.yml).
#   environment-protection-report.sh <owner/repo> <run-url>
#
# This lives in a file, not inline in the workflow, so that it can be TESTED. The same logic for branch protection
# was an inline `run:` block, and nothing guarded it: a review swapped the two Issue titles, deleted the `set +e`,
# and dropped the rc=2 branch, and the suite stayed at 19 passed for every one of them (#546 review).
#   Tests: deploy/test/environment-protection-report.test.sh (the guard and report.sh are stubs)
#
# The two Issues are DIFFERENT and must not be conflated (#540: an Issue said the protection was weak while it was
# intact and merely unreadable):
#   "…Environment の保護設定"        the settings were read AND differ from the recorded intent
#   "…Environment の保護設定を読めない"  the settings could not be read; nothing is known about them
#
# Which one is touched for each outcome, and why:
#   rc=0  as intended  close BOTH — it was read (so "unreadable" is disproved) and it matches
#   rc=1  drifted      open drifted, CLOSE unreadable — it was read, so "unreadable" is disproved too
#   rc=2  unreadable   open unreadable, LEAVE drifted ALONE — the settings were never determined, so neither
#                      opening nor closing the drift Issue would be honest
#   else  unexpected   treat as unreadable: the check did not reach a verdict, which is what that Issue means
set -euo pipefail

REPO=${1:-}; RUN_URL=${2:-}
[ -n "$REPO" ] || { echo "usage: environment-protection-report.sh <owner/repo> [run-url]" >&2; exit 2; }

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GUARD=${GUARD_CMD:-"bash $HERE/environment-protection.sh"}
REPORT=${REPORT_CMD:-"bash $HERE/report.sh"}

DRIFT_TITLE="[monitor] repo: Environment の保護設定"
UNREADABLE_TITLE="[monitor] repo: Environment の保護設定を読めない"

BODY_FILE="${RUNNER_TEMP:-$(mktemp -d)}/environment-protection-body.md"

# `set +e` around the call only. The guard uses its exit code as a VALUE (0/1/2), and under the workflow's default
# shell (`bash -e {0}`) a non-zero substitution ends the step on the spot — measured on the branch-protection
# equivalent: it exited 2 without opening a single Issue (run 33987618134). `set -e` is restored immediately, so a
# failing report.sh below still fails the step; leaving it off let a failed first report.sh be swallowed while the
# step stayed green (#546 review).
set +e
out=$($GUARD "$REPO"); rc=$?
set -e
echo "$out"

# report.sh failures must not be swallowed: if an Issue cannot be opened or closed, the run has to go red, or the
# monitoring is silently not monitoring. Each call is checked explicitly.
report() { $REPORT "$1" "${@:2}" || { echo "::error::report.sh failed for [$1]"; exit 1; }; }

case $rc in
  0)
    report "$DRIFT_TITLE" ok
    report "$UNREADABLE_TITLE" ok
    ;;
  1)
    {
      echo "**Environment の保護設定が、記録された意図（#659）と食い違っている。**"
      echo "設定画面での変更は diff にもレビューにも CI にも現れない（#661）。"
      echo
      echo '```'
      echo "$out"
      echo '```'
      echo
      [ -n "$RUN_URL" ] && echo "- run: $RUN_URL"
      echo
      echo "**ルールが付いた場合**: そのデプロイは人の承認を待って止まる。"
      echo "\`production-data\` は日次なので、付いていると毎日止まる。"
      echo "**意図そのものを変えたのなら**、\`deploy/monitor/environment-protection.sh\` の"
      echo "\`EXPECTED_RULES\` と \`docs/ops/deploy.md\` を直す（手順は同スクリプトの冒頭）。"
      echo "検査が通るようになれば、この Issue は自動で閉じる。"
    } > "$BODY_FILE"
    report "$DRIFT_TITLE" fail "$BODY_FILE"
    # The settings WERE read, so "could not read" is disproved — close it rather than leave a stale, wrong Issue
    # open next to the right one. That staleness is #540 itself, with the two sides swapped.
    report "$UNREADABLE_TITLE" ok
    exit 1
    ;;
  *)
    # rc=2, and anything unexpected (e.g. jq exiting 5). Both mean "no verdict was reached", which is what this
    # Issue says. Reporting nothing at all would be worse: the run would go red with no explanation anywhere.
    [ "$rc" = 2 ] || echo "::warning::environment-protection.sh が想定外の終了コード $rc を返した（読めなかった扱いにする）"
    {
      echo "**Environment の設定を読めなかった。** 意図どおりかどうかは**判定できていない**（#540）。"
      echo
      echo '```'
      echo "$out"
      echo '```'
      echo
      [ -n "$RUN_URL" ] && echo "- run: $RUN_URL"
      echo
      echo "**理由は run のログ（stderr）にある。** 認証情報が混ざりうるのでここには転記しない。"
      echo "**この endpoint は既定の \`GITHUB_TOKEN\`（\`contents: read\` のみ）で読めることを実測してある**"
      echo "（2026-09-08）。branch protection と違って PAT は要らない。読めなくなったのなら、"
      echo "権限が絞られたか API 側の障害。手順は \`docs/ops/deploy.md\`「Environment の保護設定」。"
      echo "読めるようになれば、この Issue は自動で閉じる。"
    } > "$BODY_FILE"
    report "$UNREADABLE_TITLE" fail "$BODY_FILE"
    # The drift Issue is deliberately NOT touched: its subject was never determined this run.
    exit 1
    ;;
esac
