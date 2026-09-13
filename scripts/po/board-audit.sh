#!/usr/bin/env bash
# Issue #783: ボードと Issue と PR の食い違いを列挙する（既定は読むだけ）。
#
# なぜ要るか（実測。2026-09-13）:
#   **マージ済みの PR に対応する Issue が 3 件 open のまま残っていた**（#763←#770 / #769←#775 / #771←#776）。
#   3 件とも別の担当者・別の時刻で、**偶然ではなく運用が機能していない。**
#   **`docs/ops/board.md` には同じ形の反省が 4 回書いてある**（ボードを動かさない → 閉じ忘れ →
#   `In Review` を飛ばす → worktree）。**4 回書いて 5 回目が起きた。書くことは対策になっていない。**
#   だから**機械に見させる**。
#
# 見る食い違い（4 種類）:
#   1. closed-pr-open-issue : `Closes/Fixes/Resolves #N` を含む PR が MERGED なのに Issue #N が OPEN（本丸）
#   2. closed-issue-not-done: Issue が CLOSED なのにボードの Status が Done でない（Sprint 26 で 13 件）
#   3. open-issue-done      : Issue が OPEN なのにボードの Status が Done（Done の信頼性が落ちる）
#   4. not-on-board         : Issue がボードに載っていない（Sprint 26 で 157 件）
#   5. inprogress-no-trace  : ボードが `In Progress` なのに作業の痕跡が無い（#809。**列挙するだけ**）
#
# **閉じてよい条件を厳しくしてある**（#569「迷ったら閉じない側に倒す」）:
#   - **`Closes` / `Fixes` / `Resolves` + `#N` の形に限る**（GitHub が自動クローズに使う語）。
#     **本文に `#N` が出るだけでは拾わない**——#763 の検索には無関係な PR #450/#698/#461 が引っかかった。
#   - **その PR が本当に MERGED であることを `gh pr view <n> --json state` で確かめてから**閉じる。
#     **`git merge-base --is-ancestor` は squash では使えない**（#535 で踏んだ）。
#
# **母数を必ず出す**（#757）。「食い違い 0 件」と「そもそも Issue を 1 件も読めていない」が
#   同じ出力になってはいけない。**Issue も PR もボード項目も 0 件なら異常終了する**（exit 4）。
#
# **規則 5（#809）は「鳴らす」ではなく「数えて出す」**:
#   **#781 は起票して `In Progress` にしたまま担当者を立て忘れ、PO が目で見つけるまで誰も作業していなかった。**
#   規則 1〜4 はどれもこれを見つけない（**Issue は OPEN、ボードは In Progress で、矛盾していない**）。
#
#   **「痕跡が無い = 誰も居ない」ではない**（2026-09-14 に PO が実測。worktree の無い 4 件は**4 件とも偽陽性**:
#   起票直後 / monitor が自動で開いた Issue / この Issue 自身 / 優先度を下げたもの）。**だから 2 つで絞る**:
#     (a) **時間の閾値**: ボードの Status を `In Progress` にしてから $STALE_HOURS 時間（既定 24）経ったものだけ。
#         `fieldValueByName.updatedAt`（Status を最後に変えた時刻）が取れることを実測で確かめた。
#         **既定 24 時間の根拠**（実測 2026-09-14、マージ済み PR 50 本）: Issue 起票 → PR 作成は
#         **p50 = 125 分、50 本中 40 本が 6 時間以内**。6 時間を超える 10 本は
#         **3.7 日〜7 日前に起票され、後から着手されたもの**（その間ボードは `Backlog` で `In Progress` ではない）。
#         **24 時間は実測の p50 の 11 倍**で、始めた直後を鳴らさない側に倒してある。
#     (b) **`monitor` ラベルを対象から外す**（`#821` `#547`。**監視が自動で開き自動で閉じる。担当者は要らない**）。
#
#   **痕跡は「どれか 1 つでもあれば作業中」**（`git worktree list` は PO の手元でしか見えないので使わない）:
#     - リモートに `<type>/<番号>-...` という枝がある（**運用の枝名の規約**。実測 322 本すべてこの形）
#     - head がその形の PR がある（枝が消えた後でも残る）
#     - `Closes/Fixes/Resolves #N` を含む PR がある（state を問わない。**作業はあった**）
#
#   **`--fix` の対象にしない。** **担当者を立てるのは PO の判断**であり、
#   **機械には「誰を立てるか」「そもそも立てるべきか」が決められない**
#   （**OPEN なのに Done を自動で戻さない**のと同じ理由）。
#
# 既定は読むだけ（worktree-sweep.sh と同じ設計）。`--fix` を付けたときだけ
#   `gh issue close` と `board-set.sh` を呼ぶ。
#
#   Tests: scripts/po/test/board-audit.test.sh（fake `gh` で実際には何も書き換えない）
#
# Usage:
#   scripts/po/board-audit.sh            # 食い違いを列挙する（読むだけ）
#   scripts/po/board-audit.sh --fix      # 直す（Issue を閉じる／ボードの Status を直す）
#
# 環境変数:
#   STALE_HOURS  規則 5 の閾値（時間。既定 24）
#   PO_NOW       規則 5 の「今」を固定する（ISO8601。テスト用）
#
# 終了コード: 0 食い違い無し / 1 食い違いあり（--fix なら直せなかったものが残る） / 2 使い方 / 4 母数が 0
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/po/lib.sh
source "$HERE/lib.sh"

PROJECT_ID="PVT_kwHOBy0CLs4BhHqj"   # 議員レコード スクラムボード (project 2)。board-set.sh と同じ値

FIX=0
case "${1:-}" in
  "") ;;
  --fix) FIX=1 ;;
  *) usage "board-audit.sh [--fix]" ;;
esac

REPO=$(po_repo)

# ---- 1. Issue を全部読む（母数その1）---------------------------------------------------------
# state=all。`gh issue list` は PR を返さない。
declare -A ISSUE_STATE=()
ISSUE_COUNT=0
while IFS=$'\t' read -r num state; do
  [[ -n "$num" ]] || continue
  ISSUE_STATE["$num"]="$state"
  ISSUE_COUNT=$((ISSUE_COUNT+1))
done < <(gh issue list --repo "$REPO" --state all --limit 1000 --json number,state --jq '.[] | [.number, .state] | @tsv')

# ---- 2. ボードを全部読む（母数その2）---------------------------------------------------------
# ページングする。**打ち切ると「載っていない」の誤検出になる**ので hasNextPage を最後まで追う。
declare -A BOARD_STATUS=() BOARD_ITEM=() BOARD_SINCE=() BOARD_LABELS=()
BOARD_COUNT=0
# shellcheck disable=SC2016  # $cursor は GraphQL の変数
BOARD_Q='query($project:ID!,$cursor:String){ node(id:$project){ ... on ProjectV2 {
  items(first:100, after:$cursor){ pageInfo{ hasNextPage endCursor }
    nodes{ id content{ ... on Issue { number labels(first:20){ nodes{ name } } } }
      fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name updatedAt } } } } } } }'
cursor=""
while :; do
  page=$(gh api graphql -f query="$BOARD_Q" -F project="$PROJECT_ID" -F cursor="$cursor" \
    --jq '[(.data.node.items.pageInfo.hasNextPage|tostring), (.data.node.items.pageInfo.endCursor // "")],
          (.data.node.items.nodes[] | select(.content.number != null)
            | ["item", (.content.number|tostring), (.fieldValueByName.name // ""), .id,
               (.fieldValueByName.updatedAt // ""),
               ([(.content.labels.nodes // [])[].name] | join(","))])
          | @tsv')
  first_line=1
  has_next="false"; next_cursor=""
  while IFS=$'\t' read -r a b c d e f; do
    if [[ "$first_line" == 1 ]]; then has_next="$a"; next_cursor="$b"; first_line=0; continue; fi
    [[ "$a" == "item" ]] || continue
    BOARD_STATUS["$b"]="$c"
    BOARD_ITEM["$b"]="$d"
    BOARD_SINCE["$b"]="$e"
    BOARD_LABELS["$b"]="$f"
    BOARD_COUNT=$((BOARD_COUNT+1))
  done <<< "$page"
  [[ "$has_next" == "true" && -n "$next_cursor" ]] || break
  cursor="$next_cursor"
done

# ---- 3. マージ済み PR を全部読む（母数その3）-------------------------------------------------
declare -A PR_BODY=()
PR_COUNT=0
while IFS= read -r line; do
  [[ -n "$line" ]] || continue
  n="${line%%$'\t'*}"
  PR_BODY["$n"]="${line#*$'\t'}"
  PR_COUNT=$((PR_COUNT+1))
done < <(gh pr list --repo "$REPO" --state merged --limit 300 --json number,body \
  --jq '.[] | [(.number|tostring), ((.body // "") | gsub("[\r\n\t]"; " "))] | @tsv')

# ---- closing keyword の抽出 ------------------------------------------------------------------
# **`Closes` / `Fixes` / `Resolves`（+ed/+es の語形）に続く `#N` だけを拾う。**
# 本文に `#N` が出るだけのものは拾わない（#763 で #450/#698/#461 が引っかかった形）。
CLOSING_RE='(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]*:?[[:space:]]*#([0-9]+)'

# ---- 3b. 作業の痕跡を集める（規則 5。#809）---------------------------------------------------
# **リモートで見えるものだけを使う**（`git worktree list` は PO の手元にしか無く、CI では常に 0 件）。
#   - リモートの枝（open/closed を問わず、押してあれば見える）
#   - PR の head 枝名（枝が消えた後でも残る）
#   - PR 本文の `Closes #N`（state を問わない。**作業はあった**）
declare -A HAS_TRACE=()
TRACE_BRANCHES=0
while IFS= read -r br; do
  [[ -n "$br" ]] || continue
  TRACE_BRANCHES=$((TRACE_BRANCHES+1))
  # `<type>/<番号>-<slug>` と、type の無い `<番号>-<slug>` の両方を拾う
  n=$(printf '%s\n' "$br" | sed -nE 's|^([a-z]+/)?([0-9]+)-.*$|\2|p')
  [[ -n "$n" ]] && HAS_TRACE["$n"]=1
done < <(gh api "repos/$REPO/branches" --paginate --jq '.[].name' 2>/dev/null || true)

TRACE_PRS=0
while IFS=$'\t' read -r head body; do
  [[ -n "$head" ]] || continue
  TRACE_PRS=$((TRACE_PRS+1))
  n=$(printf '%s\n' "$head" | sed -nE 's|^([a-z]+/)?([0-9]+)-.*$|\2|p')
  [[ -n "$n" ]] && HAS_TRACE["$n"]=1
  while IFS= read -r ref; do
    [[ -n "$ref" ]] && HAS_TRACE["$ref"]=1
  done < <(printf '%s\n' "$body" | grep -oEi "$CLOSING_RE" 2>/dev/null | grep -oE '[0-9]+$' | sort -un || true)
done < <(gh pr list --repo "$REPO" --state all --limit 400 --json headRefName,body \
  --jq '.[] | [(.headRefName // ""), ((.body // "") | gsub("[\r\n\t]"; " "))] | @tsv')

log "読んだ母数: Issue $ISSUE_COUNT 件 / ボード項目 $BOARD_COUNT 件 / マージ済み PR $PR_COUNT 件"

# **#757: 空を「全部きれい」と報告しない。** gh が黙って空を返したら、それは監査ではない。
if [[ "$ISSUE_COUNT" -eq 0 || "$BOARD_COUNT" -eq 0 || "$PR_COUNT" -eq 0 ]]; then
  echo "board-audit: 母数が 0 の系統があります（Issue $ISSUE_COUNT / ボード $BOARD_COUNT / PR $PR_COUNT）。" >&2
  echo "  読めていないだけかもしれないので、**「食い違い無し」とは報告しません**。gh の認証と権限を確かめてください。" >&2
  exit 4
fi

# **grep は不一致で 1 を返す**ので `|| true` で受ける（`set -e` の下で全体が黙って落ちるのを防ぐ）。
closing_refs() { # closing_refs <pr-body> → 閉じる対象の Issue 番号を1行ずつ（無ければ空）
  local hits
  hits=$(printf '%s\n' "$1" | grep -oEi "$CLOSING_RE" || true)
  [[ -n "$hits" ]] || return 0
  printf '%s\n' "$hits" | grep -oE '[0-9]+$' | sort -un
}

# ---- 食い違いを集める ------------------------------------------------------------------------
# 行の形: <種別>\t<issue>\t<現在>\t<あるべき>\t<根拠>
declare -a FINDINGS=()
declare -A MERGED_CACHE=()

pr_is_merged() { # **必ず gh pr view で確かめる**（一覧の絞り込みだけを信じない）
  local n=$1
  if [[ -n "${MERGED_CACHE[$n]:-}" ]]; then [[ "${MERGED_CACHE[$n]}" == "MERGED" ]]; return; fi
  local st
  st=$(gh pr view "$n" --repo "$REPO" --json state --jq '.state' 2>/dev/null || echo "")
  MERGED_CACHE["$n"]="$st"
  [[ "$st" == "MERGED" ]]
}

# 1. Closes #N を含む MERGED な PR があるのに Issue #N が OPEN
# **この規則が見られる PR は半分しかない**（実測 2026-09-13: マージ済み 300 本のうち閉じる語があるのは 150 本）。
# **実際 #770（→#763）と #776（→#771）は閉じる語を一度も書いていなかった**——この 2 件は検出できない。
# **それでも語を緩めない**（#569。本文に番号が出るだけの PR を拾うと、無関係な Issue を閉じる）。
# **代わりに「見えていない範囲」を数えて必ず出す**（#757。沈黙で 100% に見せない）。
PR_WITH_KEYWORD=0
for pr in "${!PR_BODY[@]}"; do
  refs=$(closing_refs "${PR_BODY[$pr]}")
  if [[ -n "$refs" ]]; then PR_WITH_KEYWORD=$((PR_WITH_KEYWORD+1)); fi
  while IFS= read -r issue; do
    [[ -n "$issue" ]] || continue
    [[ "${ISSUE_STATE[$issue]:-}" == "OPEN" ]] || continue
    pr_is_merged "$pr" || continue
    FINDINGS+=("$(printf 'closed-pr-open-issue\t%s\tOPEN\tCLOSED\tPR #%s (merged)' "$issue" "$pr")")
  done <<< "$refs"
done
PR_NO_KEYWORD=$((PR_COUNT - PR_WITH_KEYWORD))
COVERAGE="マージ済み PR $PR_COUNT 件のうち閉じる語があるのは $PR_WITH_KEYWORD 件（$PR_NO_KEYWORD 件は規則 1 の対象外）"
log "$COVERAGE"

# ---- 規則 5 の前準備（#809）-------------------------------------------------------------------
# **「今」を差し込めるようにする**（テストから時刻を固定するため。既定は現在時刻）。
STALE_HOURS=${STALE_HOURS:-24}
NOW_EPOCH=$(date -u -d "${PO_NOW:-now}" +%s)
STALE_SECONDS=$((STALE_HOURS * 3600))
# **担当者を立てない Issue の型**: `monitor` は監視が自動で開き自動で閉じる（`docs/ops/monitoring.md`）。
# **他のラベルは外さない**——`blocked` は `docs/ops/board.md` で `Backlog` に置くと決めてあり、
# **`In Progress` に居ること自体が別の食い違い**なので、黙らせずに鳴らす側に残す。
NO_ASSIGNEE_LABEL="monitor"
INPROGRESS_TOTAL=0; INPROGRESS_TRACED=0; INPROGRESS_EXCLUDED=0; INPROGRESS_RECENT=0

for issue in "${!ISSUE_STATE[@]}"; do
  state="${ISSUE_STATE[$issue]}"
  on_board=0; [[ -n "${BOARD_ITEM[$issue]:-}" ]] && on_board=1
  status="${BOARD_STATUS[$issue]:-}"

  # 4. ボードに載っていない
  if [[ "$on_board" == 0 ]]; then
    FINDINGS+=("$(printf 'not-on-board\t%s\t(載っていない)\tボードに載せる\tissue is %s' "$issue" "$state")")
    continue
  fi
  # 2. Issue が CLOSED なのに Status が Done でない
  if [[ "$state" == "CLOSED" && "$status" != "Done" ]]; then
    FINDINGS+=("$(printf 'closed-issue-not-done\t%s\t%s\tDone\tissue is CLOSED' "$issue" "${status:-(なし)}")")
  fi
  # 3. Issue が OPEN なのに Status が Done
  if [[ "$state" == "OPEN" && "$status" == "Done" ]]; then
    FINDINGS+=("$(printf 'open-issue-done\t%s\tDone\tDone 以外\tissue is OPEN' "$issue")")
  fi
  # 5. In Progress なのに作業の痕跡が無い（#809）。**列挙するだけ。--fix では直さない**
  if [[ "$state" == "OPEN" && "$status" == "In Progress" ]]; then
    INPROGRESS_TOTAL=$((INPROGRESS_TOTAL+1))
    if [[ ",${BOARD_LABELS[$issue]:-}," == *",$NO_ASSIGNEE_LABEL,"* ]]; then
      INPROGRESS_EXCLUDED=$((INPROGRESS_EXCLUDED+1))
    elif [[ -n "${HAS_TRACE[$issue]:-}" ]]; then
      INPROGRESS_TRACED=$((INPROGRESS_TRACED+1))
    else
      since="${BOARD_SINCE[$issue]:-}"
      # **Status の更新時刻が取れなければ鳴らさない**（取れないことを鳴らすと全件鳴る）
      if [[ -z "$since" ]]; then
        INPROGRESS_RECENT=$((INPROGRESS_RECENT+1))
      else
        since_epoch=$(date -u -d "$since" +%s 2>/dev/null || echo "$NOW_EPOCH")
        age=$((NOW_EPOCH - since_epoch))
        if [[ "$age" -ge "$STALE_SECONDS" ]]; then
          FINDINGS+=("$(printf 'inprogress-no-trace\t%s\tIn Progress %s 時間\t担当者を立てるか Status を戻す\t枝も PR も無い（since %s）' \
            "$issue" "$((age / 3600))" "$since")")
        else
          INPROGRESS_RECENT=$((INPROGRESS_RECENT+1))
        fi
      fi
    fi
  fi
done

# **見なかったものを必ず数えて出す**（#757。沈黙で 100% に見せない）
INPROGRESS_SUMMARY=$(printf 'In Progress %s 件（痕跡あり %s 件 / %s %s 件 / %s 時間未満 %s 件）。枝 %s 本・PR %s 本から痕跡を見た' \
  "$INPROGRESS_TOTAL" "$INPROGRESS_TRACED" "$NO_ASSIGNEE_LABEL" "$INPROGRESS_EXCLUDED" \
  "$STALE_HOURS" "$INPROGRESS_RECENT" "$TRACE_BRANCHES" "$TRACE_PRS")
log "$INPROGRESS_SUMMARY"

# ---- 出力 ------------------------------------------------------------------------------------
if [[ ${#FINDINGS[@]} -eq 0 ]]; then
  echo "食い違い 0 件（Issue $ISSUE_COUNT 件 / ボード項目 $BOARD_COUNT 件 / マージ済み PR $PR_COUNT 件 を見た）"
  echo "  ただし $COVERAGE"
  echo "  $INPROGRESS_SUMMARY"
  exit 0
fi

mapfile -t SORTED < <(printf '%s\n' "${FINDINGS[@]}" | sort -t$'\t' -k1,1 -k2,2n)
for row in "${SORTED[@]}"; do
  IFS=$'\t' read -r kind issue now want why <<< "$row"
  printf '%s\t#%s\t現在=%s\tあるべき=%s\t根拠=%s\n' "$kind" "$issue" "$now" "$want" "$why"
done
echo "食い違い ${#SORTED[@]} 件（Issue $ISSUE_COUNT 件 / ボード項目 $BOARD_COUNT 件 / マージ済み PR $PR_COUNT 件 を見た）"
echo "  ただし $COVERAGE"
echo "  $INPROGRESS_SUMMARY"

if [[ "$FIX" == 0 ]]; then
  log "読むだけで終わります。直すには --fix を付けてください"
  exit 1
fi

# ---- --fix ------------------------------------------------------------------------------------
fixed=0; left=0
for row in "${SORTED[@]}"; do
  IFS=$'\t' read -r kind issue _now _want why <<< "$row"
  case "$kind" in
    closed-pr-open-issue)
      # **ここに来るのは pr_is_merged を通ったものだけ**（上のループで確認済み）
      gh issue close "$issue" --repo "$REPO" --comment "$why でマージ済みのため閉じます（scripts/po/board-audit.sh --fix）"
      "$HERE/board-set.sh" "$issue" Done
      fixed=$((fixed+1)) ;;
    closed-issue-not-done|not-on-board)
      if [[ "${ISSUE_STATE[$issue]}" == "CLOSED" ]]; then
        "$HERE/board-set.sh" "$issue" Done
      else
        "$HERE/board-set.sh" "$issue" Backlog
      fi
      fixed=$((fixed+1)) ;;
    inprogress-no-trace)
      # **担当者を立てるのは PO の判断。** **誰を立てるか／そもそも立てるべきかは機械に決められない**
      # （**OPEN なのに Done を自動で戻さない**のと同じ理由）。**ボードも Issue も触らない。**
      log "残す #$issue: In Progress なのに枝も PR も無い。担当者を立てるか Status を戻すかは人が決めてください"
      left=$((left+1)) ;;
    open-issue-done)
      # **Done から自動で動かさない。** どこへ戻すべきか（Ready / In Progress / In Review）は
      # 機械には分からず、**取り違えるとボードがまた嘘をつく**。人が決める。
      log "残す #$issue: OPEN なのに Done。どの Status に戻すかは人が決めてください（board-set.sh）"
      left=$((left+1)) ;;
  esac
done
echo "直した $fixed 件 / 残した $left 件"
[[ "$left" -eq 0 ]] || exit 1
