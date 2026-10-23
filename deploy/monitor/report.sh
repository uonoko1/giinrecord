#!/usr/bin/env bash
# Turn one check result into GitHub Issue state, with gh (Issue #135; used by run.sh in monitor.yml).
#   report.sh <title> fail <body-file>   open an Issue "<title>" (label monitor) unless one with exactly that title is open
#   report.sh <title> ok                 if an Issue "<title>" is open: comment "recovered" and close it
# The title is the identity (one Issue per environment × check), so a flapping check never piles up Issues.
# gh needs GH_TOKEN with issues:write (the workflow's GITHUB_TOKEN) and runs inside the checkout (repo inferred).
#
# Issue #1185 — **鳴り続けているあいだ、何も言わないのをやめる。**
# 実測: `[monitor] production: data` (#1172) は 2026-10-02T06:20Z に立ち 2026-10-03T22:14Z に閉じた。
# **39 時間開いていて、そのあいだ監視からのコメントは 0 件**（comments 3 件はすべて PO か "Recovered"）。
# 監視は 10 分ごとに正しく鳴っていたが、**鳴った先は Actions のログだった**ので、
# **Issue を見ただけでは 1 回目か 50 回目か、93 時間経っているのかが分からなかった。**
# ここで足すのは 2 段:
#   1. 継続中は毎 round **開いている Issue に経過をコメントする**（経過時間 + いまの理由）。
#      **「黙る」をやめるのが本体。** 10 分ごとなので通知は増えるが、**増えない形が 39 時間の原因だった。**
#   2. 閾値（MONITOR_ESCALATE_HOURS、既定 6h）を越えたら **扱いを変える**:
#      **タイトルの末尾に経過を足し、ラベル `escalated` を足す。**
#      **なぜこの 2 つか**: どちらも **Issue の一覧（`gh issue list` / GitHub の画面）で見える**。
#      本文の先頭だけだと一覧では区別が付かず、**#1172 が 39 時間見られなかった形がそのまま残る。**
#      **改題は 1 回だけ**（`escalated` が既に在れば何もしない）——10 分ごとに改題すると
#      通知が 6 回/時 鳴り、**読まれなくなる。#1185 の本体が「鳴っていたのに読まれない」なので、
#      ここで同じ穴を作らない。**
# **改題しても同一性が壊れないこと**: 検索は `"<素のタイトル>" in:title` の部分一致で引き、
# **接尾辞を剥がして**突き合わせる。これを間違えると 1 回の障害で Issue が無限に増える。
# **復旧時は `escalated` を外してから閉じる**——次の障害が escalated で始まってはいけない。
#
# **運用に残る部分（明示する）**: **ラベルと題を変えても、GitHub の通知を読む人が居なければ届かない。**
# この変更が機械側で保証するのは「Issue を 1 回見れば経過が分かる」ことだけで、
# **「誰かが見る」ことは保証していない。** 外部への push 通知（メール / チャット）は
# この repo に経路が無く、足すには secret が要るので別 Issue。
#   Tests: deploy/test/monitor-probe.test.sh (gh is a stub)
set -euo pipefail

TITLE=${1:-}; STATUS=${2:-}; BODY=${3:-}
case "$STATUS" in
  fail) if [ -z "$TITLE" ] || [ ! -f "$BODY" ]; then echo "usage: report.sh <title> fail <body-file>" >&2; exit 2; fi ;;
  ok)   [ -n "$TITLE" ] || { echo "usage: report.sh <title> ok" >&2; exit 2; } ;;
  *)    echo "usage: report.sh <title> ok|fail [body-file]" >&2; exit 2 ;;
esac
LABEL=${MONITOR_LABEL:-monitor}
ESC_LABEL=${MONITOR_ESCALATE_LABEL:-escalated}
ESC_HOURS=${MONITOR_ESCALATE_HOURS:-6}
# **タイトルに足す接尾辞**。`—`（em dash）区切りにしたのは、素のタイトルに現れない文字だから
# （`[monitor] <env>: <check>` は ASCII だけで出来ている）。剥がすときに誤爆しない。
SUFFIX_SEP=" — "

# The open Issue with this title (the search is a substring match, so filter again). Since #1185 the title may
# carry the escalation suffix, so the comparison strips it: `<title>` and `<title> — 9h 継続` are the SAME Issue.
# Returns one TSV line "<number>\t<createdAt>\t<labels,…>\t<comments>\t<title as it stands now>", or nothing.
# #1286: **いまの題そのものも返す。** 題に入っている経過（`— 9h 継続`）を**読んでから**
# 「更新するか」を決めるので、題を見ずに決めることはできない。
# **欄は末尾に足す**（既存の `cut -f1..4` の位置を動かさないため）。
# **題にタブは入らない**（GitHub の Issue の題は改行もタブも持てない。`[monitor] <env>: <check>` は
# この repo が自分で作る文字列なので、なおさら）。
# **`// []` / `// ""` が要る**: `.labels[]` は labels が null / 欠けていると
# `Cannot iterate over null` で jq 自体が落ち、**`open_issue` が空を返す**。
# **空は「開いている Issue が無い」と同じ形なので、report.sh は新しい Issue を作る**
# ——**1 回の障害で Issue が増殖する。** 実測: stub に本物の jq を通した途端にこれで 7 件落ちた。
export TITLE SUFFIX_SEP   # read by the --jq filter below
open_issue() {
  # shellcheck disable=SC2016  # $ENV.* is jq syntax, expanded by gh, not by the shell
  gh issue list --label "$LABEL" --state open --limit 100 --search "\"$TITLE\" in:title" \
    --json number,title,createdAt,labels,comments \
    --jq 'map(select((.title | split($ENV.SUFFIX_SEP) | .[0]) == $ENV.TITLE))
          | .[0] // empty
          | [(.number|tostring), (.createdAt // ""), ([(.labels // [])[].name] | join(",")), (((.comments // []) | length)|tostring), (.title // "")]
          | @tsv'
}

ROW=$(open_issue)
NUM=''; CREATED=''; LABELS=''; NCOMMENTS=''; TITLE_FULL=''
# **`IFS=$'\t' read` では読まない**（#1198 受け入れ条件 3）。**タブは「IFS の空白文字」なので、
# 連続するタブが 1 つに畳まれ、空の欄が消えて以降がずれる。** 実測（bash 5.2 / 2026-10-05）:
#     ROW=$'5\t2026-10-01T00:00:00Z\t\t4'            ← labels が空の形
#     IFS=$'\t' read -r NUM CREATED LABELS NCOMMENTS   → LABELS=[4] NCOMMENTS=[]
# **壊れるのは 2 つ**: (a) 「すでに escalated か」の判定に数字が入る、
# (b) 報告回数が常に「1 回以上」になる（#1185 の「1 回目か 50 回目か分からない」に戻る）。
# **`cut -f` は欄を畳まない**ので、空欄が在っても位置が動かない。
# **`tr` で区切りを別の文字に替える案は採らない**: ラベル名にその文字が入れば同じ事故になる。
if [ -n "$ROW" ]; then
  NUM=$(printf '%s' "$ROW" | cut -f1)
  CREATED=$(printf '%s' "$ROW" | cut -f2)
  LABELS=$(printf '%s' "$ROW" | cut -f3)
  NCOMMENTS=$(printf '%s' "$ROW" | cut -f4)
  # #1286: いまの題（接尾辞つきのまま）。**`cut -f5` なので上の 4 欄の位置は動いていない。**
  TITLE_FULL=$(printf '%s' "$ROW" | cut -f5)
fi

# elapsed_hours <iso8601> → whole hours since then, or empty when the timestamp is unusable.
# **空を「0 時間」にしない**: createdAt が読めなかったのに「立ったばかり」と書くと、
# **93 時間続いている障害が「1 時間目」に見える**（#1185 が起きた形の縮小版）。
elapsed_hours() {
  # **空文字を date に渡さない**: GNU date は `-d ""` をエラーにせず **今日の 00:00Z** として受ける。
  # 実測（coreutils 9.4 / 2026-10-05T03:09Z）: `date -u -d "" '+%Y-%m-%dT%H:%M:%SZ'` → `2026-10-05T00:00:00Z`
  # （`+%s` は 1791158400。**epoch 0 ではない**）。
  # **だから危険の向きは「56 年前」ではなく「数時間」である**——**もっともらしいので誰も疑わない。**
  # 93 時間続いている障害が「3h 継続」と書かれ、`escalated` の閾値（経過時間で決まる）も取りこぼす。
  # **epoch 0 なら一目で嘘と分かるが、今日の 00:00Z は分からない。** **測れていないなら空を返す。**
  [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]] || return 0
  local ep
  ep=$(date -u -d "$1" +%s 2>/dev/null) || return 0
  [ -n "$ep" ] || return 0
  echo $(( ($(date +%s) - ep) / 3600 ))
}

case "$STATUS" in
  fail)
    if [ -n "$NUM" ]; then
      HOURS=$(elapsed_hours "$CREATED")
      # **+1**: このラウンドも報告なので、本文に出す回数は「これまでのコメント数 + 1」ではなく
      # 「round は少なくとも N 回目」と書く。**正確な連続回数は Issue 側に無い**ので、
      # **コメント数を下限として書き、下限であることを明示する**（#757: 数には母数が要る）。
      ROUNDS=$(( ${NCOMMENTS:-0} + 1 ))
      TMPC=$(mktemp); trap 'rm -f "$TMPC"' EXIT
      {
        if [ -n "$HOURS" ]; then
          echo "**まだ失敗しています（${HOURS}h 継続）。**"
        else
          echo "**まだ失敗しています（経過時間は測れませんでした——この Issue の createdAt を読めませんでした）。**"
        fi
        echo
        # #1225: パイプの末尾に `head -1` を置くと、一致が先頭寄りのとき
        # **書き手（sed）が SIGPIPE で死んで pipefail が rc=141 を返す**。
        # `|| true` は本当に一致しなかった場合まで黙らせるので使えない。
        # `sed` 自身に 1 本目で終わらせる（`q`）ことで**パイプをなくす**。
        echo "- いまの理由: $(sed -n '/^- reason: /{s/^- reason: //p;q;}' "$BODY")"
        echo "- この Issue に報告が入った回数: **${ROUNDS} 回以上**（コメント数からの下限。監視は 10 分ごとに走ります）"
        echo
        echo "最新の判定:"
        echo
        sed 's/^/> /' "$BODY"
      } > "$TMPC"
      gh issue comment "$NUM" --body-file "$TMPC"
      echo "report: #$NUM still failing${HOURS:+ (${HOURS}h)} for '$TITLE'"

      # **扱いを変える**（閾値超え）
      case ",$LABELS," in
        *",$ESC_LABEL,"*)
          # **すでに escalated。ラベルは足し直さない**が、**題の経過は更新しうる**（#1286）。
          #
          # **なぜ更新が要るか（実測。#1286 で PO 自身が踏んだ）**:
          #   #1221 は **111.2h 続いていたのに、題は `— 9h 継続` のまま**だった
          #   （`createdAt 2026-10-06T20:33:20Z`、最後の報告 `2026-10-11T07:19:56Z`、
          #   その時点で既に **106.8h**。2026-10-11T11:40Z 現在 111.2h）。
          #   **改題を 1 回だけにした #1185 の判断で、題の数字は最初の escalate 時点で凍る。**
          #   **PO は `label:monitor` の一覧を題で読んで「9h なら既知の古いもの」と流し、
          #   106 時間・26 回鳴っていた本物を 4 日見落とした。**
          #   **題が通算を表していないので、題では重さが分からなかった。**
          #
          # **それでも 10 分ごとに改題しない**（#1185 の「通知で埋もれると読まれなくなる」は正しい）。
          # **倍々でだけ改題する**: 題の数字が**いまの経過の半分未満**になったときだけ書き換える。
          #   → 改題の回数は経過に対して **log2** で増える。6h から始めて 1 年続いても
          #     **6→12→24→48→96→192→384→768→1536h の 8 回**で、**10 分ごとなら 52,560 回**である。
          #   **「凍る」と「毎回鳴る」の間を、回数の上限が言える形で取る。**
          OLD_H=''
          case "$TITLE_FULL" in
            *"$SUFFIX_SEP"*) OLD_H=${TITLE_FULL##*"$SUFFIX_SEP"}; OLD_H=${OLD_H%%h 継続} ;;
          esac
          # **数字として読めなければ更新しない**（人が題を編集した形で暴れない）。
          if [ -n "$HOURS" ] && [[ "$OLD_H" =~ ^[0-9]+$ ]] && [ "$((OLD_H * 2))" -le "$HOURS" ]; then
            gh issue edit "$NUM" --title "${TITLE}${SUFFIX_SEP}${HOURS}h 継続"
            echo "report: #$NUM title refreshed (${OLD_H}h → ${HOURS}h)"
          fi ;;
        *)
          if [ -n "$HOURS" ] && [ "$HOURS" -ge "$ESC_HOURS" ]; then
            gh label create "$ESC_LABEL" --force --color B60205 \
              --description "監視が立てた Issue が ${ESC_HOURS}h 以上続いている（deploy/monitor/report.sh・#1185）" >/dev/null
            gh issue edit "$NUM" --add-label "$ESC_LABEL" --title "${TITLE}${SUFFIX_SEP}${HOURS}h 継続"
            echo "report: #$NUM escalated (${HOURS}h >= ${ESC_HOURS}h)"
          fi ;;
      esac
    else
      # --force: create or update; keeps the label present without a separate "does it exist" call
      gh label create "$LABEL" --force --color D93F0B --description "opened and closed automatically by the monitoring (docs/ops/monitoring.md)" >/dev/null
      gh issue create --title "$TITLE" --label "$LABEL" --body-file "$BODY"
    fi ;;
  ok)
    if [ -n "$NUM" ]; then
      gh issue comment "$NUM" --body "Recovered: the check passed again at $(date -u +%Y-%m-%dT%H:%M:%SZ)."
      # **`escalated` を外し、題を素に戻してから閉じる**: 次の障害が escalated で始まってはいけないし、
      # 閉じた Issue の題に「9h 継続」が残っていると、後から履歴を読む人に誤読される。
      case ",$LABELS," in
        *",$ESC_LABEL,"*) gh issue edit "$NUM" --remove-label "$ESC_LABEL" --title "$TITLE" ;;
      esac
      gh issue close "$NUM" --reason completed
      echo "report: closed #$NUM for '$TITLE'"
    fi ;;
esac

# **明示的に 0 で終わる。** 直前の `case` に当たる枝が無いと `$?` が残り、
# **report.sh が「報告できなかった」ように見えて run.sh の exit を汚す**（実測でここに踏んだ）。
exit 0
