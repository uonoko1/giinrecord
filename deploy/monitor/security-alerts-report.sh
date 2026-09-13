#!/usr/bin/env bash
# Turn security-alerts.sh's exit code into GitHub Issue state (Issue #786; used by security-alerts.yml).
#   security-alerts-report.sh <owner/repo> <run-url>
#
# This lives in a file, not inline in the workflow, so that it can be TESTED. While the branch-protection
# equivalent was a `run:` block, nothing guarded it: a review swapped the two Issue titles, deleted the
# `set +e` and dropped the rc=2 branch, and the suite stayed at 19 passed for all three (#546 review).
#   Tests: deploy/test/security-alerts-report.test.sh (security-alerts.sh and report.sh are stubs)
#
# The two Issues are DIFFERENT and must not be conflated (the #540 mistake, and #757's 母数):
#   "…security アラート"        the feeds were READ and they contain open alerts
#   "…security アラートを読めない"  a feed could not be read; whether alerts exist is UNKNOWN
#
#   rc=0  clear       close BOTH — everything was read (so "unreadable" is disproved) and it is empty
#   rc=1  alerts      open alerts, CLOSE unreadable — it was read, so "unreadable" is disproved too
#   rc=2  unreadable  open unreadable, LEAVE alerts ALONE — nothing was determined about whether alerts
#                     exist, so neither opening nor closing that Issue would be honest
#   else  unexpected  treat as unreadable: the check reached no verdict, which is what that Issue means
#
# WHAT GOES IN THE BODY: security-alerts.sh's stdout, which is an ALLOWLIST of kind / count / number — see the
# header of that script for why the alert payloads themselves (`.secret` is the leaked credential in cleartext)
# must never get here. This script adds no alert data of its own; it only frames what it was handed.
set -euo pipefail

REPO=${1:-}; RUN_URL=${2:-}
[ -n "$REPO" ] || { echo "usage: security-alerts-report.sh <owner/repo> [run-url]" >&2; exit 2; }

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GUARD=${GUARD_CMD:-"bash $HERE/security-alerts.sh"}
REPORT=${REPORT_CMD:-"bash $HERE/report.sh"}

ALERTS_TITLE="[monitor] repo: security アラート"
UNREADABLE_TITLE="[monitor] repo: security アラートを読めない"

BODY_FILE="${RUNNER_TEMP:-$(mktemp -d)}/security-alerts-body.md"

# `set +e` around the call only. The guard uses its exit code as a VALUE (0/1/2), and under the workflow's
# default shell (`bash -e {0}`) a non-zero substitution ends the step on the spot without opening a single
# Issue. `set -e` is restored immediately so a failing report.sh below still fails the step (#546 review).
set +e
out=$($GUARD "$REPO"); rc=$?
set -e
echo "$out"

report() { $REPORT "$1" "${@:2}" || { echo "::error::report.sh failed for [$1]"; exit 1; }; }

case $rc in
  0)
    report "$ALERTS_TITLE" ok
    report "$UNREADABLE_TITLE" ok
    ;;
  1)
    {
      echo "**GitHub の security アラートが open のままになっている。**"
      echo
      echo "secret scanning のアラート #1 は 2026-08-23 に立ってから **21 日間誰も見ていなかった**（#786）。"
      echo "中身は本物の漏洩で、その間 CI はずっと緑だった（gitleaks はこの形を検出しない）。"
      echo "**この Issue は、それが二度と 21 日にならないためにある。**"
      echo
      echo '```'
      echo "$out"
      echo '```'
      echo
      echo "- 一覧: https://github.com/$REPO/security"
      [ -n "$RUN_URL" ] && echo "- run: $RUN_URL"
      echo
      echo "**アラートの中身（秘密の値・該当ファイルの行・commit）はここには書かない。**"
      echo "上のリンク先（push 権限が要る）で見ること。ここに転記すると、警告そのものが漏洩になる。"
      echo
      echo "対処の手順は \`docs/ops/monitoring.md\`「GitHub の security アラート」。"
      echo "アラートが 0 件になれば、この Issue は自動で閉じる。"
    } > "$BODY_FILE"
    report "$ALERTS_TITLE" fail "$BODY_FILE"
    # The feeds WERE read, so "could not read" is disproved — close it rather than leave a stale, wrong
    # Issue open next to the right one.
    report "$UNREADABLE_TITLE" ok
    exit 1
    ;;
  *)
    # rc=2, and anything unexpected (jq dying with 5, say). Both mean "no verdict was reached".
    [ "$rc" = 2 ] || echo "::warning::security-alerts.sh が想定外の終了コード $rc を返した（読めなかった扱いにする）"
    {
      echo "**GitHub の security アラートを読めなかった。** open なアラートが有るかどうかは**判定できていない**（#786）。"
      echo
      echo "**これは「アラート 0 件」ではない。** 読めていないことを緑にすると、#786 の 21 日がそのまま戻る。"
      echo
      echo '```'
      echo "$out"
      echo '```'
      echo
      [ -n "$RUN_URL" ] && echo "- run: $RUN_URL"
      echo
      echo "**理由は run のログ（stderr）にある。** 認証情報が混ざりうるのでここには転記しない。"
      echo "原因は権限のことが多い。\`secret-scanning/alerts\` と \`dependabot/alerts\` は"
      echo "既定の \`GITHUB_TOKEN\` では読めず、**fine-grained PAT が要る＝人間の作業**。"
      echo "手順は \`docs/ops/monitoring.md\`「GitHub の security アラート」、"
      echo "打つコマンドは \`bash scripts/human-tasks.sh\`。"
      echo "読めるようになれば、この Issue は自動で閉じる。"
    } > "$BODY_FILE"
    report "$UNREADABLE_TITLE" fail "$BODY_FILE"
    # The alerts Issue is deliberately NOT touched: its subject was never determined this run.
    exit 1
    ;;
esac
