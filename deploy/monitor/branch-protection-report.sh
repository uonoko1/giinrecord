#!/usr/bin/env bash
# Turn branch-protection.sh's exit code into GitHub Issue state (Issue #540; used by branch-protection.yml).
#   branch-protection-report.sh <owner/repo> <branch> <run-url>
#
# This lives in a file, not inline in the workflow, so that it can be TESTED. While it was a `run:` block nothing
# guarded it: a review changed the two Issue titles round, deleted the `set +e`, and dropped the rc=2 branch, and
# the suite stayed at 19 passed for every one of them (#546 review). The mistakes those mutations imitate are the
# exact mistakes this PR was written to fix.
#   Tests: deploy/test/branch-protection-report.test.sh (branch-protection.sh and report.sh are stubs)
#
# The two Issues are DIFFERENT and must not be conflated (#540: an Issue said the protection was weak while it was
# intact and merely unreadable):
#   "…main の保護設定"        the settings were read AND are weak
#   "…main の保護設定を読めない"  the settings could not be read; nothing is known about their strength
#
# Which one is touched for each outcome, and why:
#   rc=0  intact      close BOTH — it was read (so "unreadable" is disproved) and it is fine
#   rc=1  weak        open weak, CLOSE unreadable — it was read, so "unreadable" is disproved too
#   rc=2  unreadable  open unreadable, LEAVE weak ALONE — the strength was never determined, so neither
#                     opening nor closing the weak Issue would be honest
#   else  unexpected  treat as unreadable: the check did not reach a verdict, which is what that Issue means
set -euo pipefail

REPO=${1:-}; BRANCH=${2:-main}; RUN_URL=${3:-}
[ -n "$REPO" ] || { echo "usage: branch-protection-report.sh <owner/repo> <branch> [run-url]" >&2; exit 2; }

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GUARD=${GUARD_CMD:-"bash $HERE/branch-protection.sh"}
REPORT=${REPORT_CMD:-"bash $HERE/report.sh"}

WEAK_TITLE="[monitor] repo: $BRANCH の保護設定"
UNREADABLE_TITLE="[monitor] repo: $BRANCH の保護設定を読めない"

BODY_FILE="${RUNNER_TEMP:-$(mktemp -d)}/branch-protection-body.md"

# `set +e` around the call only. The guard uses its exit code as a VALUE (0/1/2), and under the workflow's default
# shell (`bash -e {0}`) a non-zero substitution ends the step on the spot — measured: it exited 2 without opening a
# single Issue (run 33987618134). `set -e` is restored immediately, so a failing report.sh below still fails the
# step; leaving it off let a failed first report.sh be swallowed while the step stayed green (#546 review).
set +e
out=$($GUARD "$REPO" "$BRANCH"); rc=$?
set -e
echo "$out"

# report.sh failures must not be swallowed: if an Issue cannot be opened or closed, the run has to go red, or the
# monitoring is silently not monitoring. Each call is checked explicitly.
report() { $REPORT "$1" "${@:2}" || { echo "::error::report.sh failed for [$1]"; exit 1; }; }

case $rc in
  0)
    report "$WEAK_TITLE" ok
    report "$UNREADABLE_TITLE" ok
    ;;
  1)
    {
      echo "**$BRANCH の branch protection が弱まっている。** CI を通さずに $BRANCH へ入れる状態かもしれない（#521）。"
      echo
      echo '```'
      echo "$out"
      echo '```'
      echo
      [ -n "$RUN_URL" ] && echo "- run: $RUN_URL"
      echo
      echo "直し方と、緊急時に一時的に外すときの手順は \`docs/ops/deploy.md\`「main の保護設定」。"
      echo "検査が通るようになれば、この Issue は自動で閉じる。"
    } > "$BODY_FILE"
    report "$WEAK_TITLE" fail "$BODY_FILE"
    # The settings WERE read, so "could not read" is disproved — close it rather than leave a stale, wrong Issue
    # open next to the right one. That staleness is #540 itself, with the two sides swapped.
    report "$UNREADABLE_TITLE" ok
    exit 1
    ;;
  *)
    # rc=2, and anything unexpected (e.g. jq exiting 5). Both mean "no verdict was reached", which is what this
    # Issue says. Reporting nothing at all would be worse: the run would go red with no explanation anywhere.
    [ "$rc" = 2 ] || echo "::warning::branch-protection.sh が想定外の終了コード $rc を返した（読めなかった扱いにする）"
    {
      echo "**$BRANCH の保護設定を読めなかった。** 設定が弱いかどうかは**判定できていない**（#540）。"
      echo
      echo '```'
      echo "$out"
      echo '```'
      echo
      [ -n "$RUN_URL" ] && echo "- run: $RUN_URL"
      echo
      echo "**理由は run のログ（stderr）にある。** 認証情報が混ざりうるのでここには転記しない。"
      echo "原因は権限のことが多い。**\`GITHUB_TOKEN\` では branch protection を読めない**"
      echo "（\`permissions:\` に \`administration: read\` を書くのは**誤り**。GitHub が workflow を"
      echo "構文として拒否して、この検査ごと動かなくなる）。**fine-grained PAT が要る＝人間の作業。**"
      echo "手順は \`docs/ops/deploy.md\`「main の保護設定」。"
      echo "読めるようになれば、この Issue は自動で閉じる。"
    } > "$BODY_FILE"
    report "$UNREADABLE_TITLE" fail "$BODY_FILE"
    # The weak Issue is deliberately NOT touched: its subject was never determined this run.
    exit 1
    ;;
esac
