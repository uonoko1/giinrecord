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
# 既定は読むだけ（worktree-sweep.sh と同じ設計）。`--fix` を付けたときだけ
#   `gh issue close` と `board-set.sh` を呼ぶ。
#
#   Tests: scripts/po/test/board-audit.test.sh（fake `gh` で実際には何も書き換えない）
#
# Usage:
#   scripts/po/board-audit.sh            # 食い違いを列挙する（読むだけ）
#   scripts/po/board-audit.sh --fix      # 直す（Issue を閉じる／ボードの Status を直す）
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
declare -A BOARD_STATUS=() BOARD_ITEM=()
BOARD_COUNT=0
# shellcheck disable=SC2016  # $cursor は GraphQL の変数
BOARD_Q='query($project:ID!,$cursor:String){ node(id:$project){ ... on ProjectV2 {
  items(first:100, after:$cursor){ pageInfo{ hasNextPage endCursor }
    nodes{ id content{ ... on Issue { number } }
      fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }'
cursor=""
while :; do
  page=$(gh api graphql -f query="$BOARD_Q" -F project="$PROJECT_ID" -F cursor="$cursor" \
    --jq '[(.data.node.items.pageInfo.hasNextPage|tostring), (.data.node.items.pageInfo.endCursor // "")],
          (.data.node.items.nodes[] | select(.content.number != null)
            | ["item", (.content.number|tostring), (.fieldValueByName.name // ""), .id])
          | @tsv')
  first_line=1
  has_next="false"; next_cursor=""
  while IFS=$'\t' read -r a b c d; do
    if [[ "$first_line" == 1 ]]; then has_next="$a"; next_cursor="$b"; first_line=0; continue; fi
    [[ "$a" == "item" ]] || continue
    BOARD_STATUS["$b"]="$c"
    BOARD_ITEM["$b"]="$d"
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

log "読んだ母数: Issue $ISSUE_COUNT 件 / ボード項目 $BOARD_COUNT 件 / マージ済み PR $PR_COUNT 件"

# **#757: 空を「全部きれい」と報告しない。** gh が黙って空を返したら、それは監査ではない。
if [[ "$ISSUE_COUNT" -eq 0 || "$BOARD_COUNT" -eq 0 || "$PR_COUNT" -eq 0 ]]; then
  echo "board-audit: 母数が 0 の系統があります（Issue $ISSUE_COUNT / ボード $BOARD_COUNT / PR $PR_COUNT）。" >&2
  echo "  読めていないだけかもしれないので、**「食い違い無し」とは報告しません**。gh の認証と権限を確かめてください。" >&2
  exit 4
fi

# ---- closing keyword の抽出 ------------------------------------------------------------------
# **`Closes` / `Fixes` / `Resolves`（+ed/+es の語形）に続く `#N` だけを拾う。**
# 本文に `#N` が出るだけのものは拾わない（#763 で #450/#698/#461 が引っかかった形）。
CLOSING_RE='(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]*:?[[:space:]]*#([0-9]+)'
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
done

# ---- 出力 ------------------------------------------------------------------------------------
if [[ ${#FINDINGS[@]} -eq 0 ]]; then
  echo "食い違い 0 件（Issue $ISSUE_COUNT 件 / ボード項目 $BOARD_COUNT 件 / マージ済み PR $PR_COUNT 件 を見た）"
  echo "  ただし $COVERAGE"
  exit 0
fi

mapfile -t SORTED < <(printf '%s\n' "${FINDINGS[@]}" | sort -t$'\t' -k1,1 -k2,2n)
for row in "${SORTED[@]}"; do
  IFS=$'\t' read -r kind issue now want why <<< "$row"
  printf '%s\t#%s\t現在=%s\tあるべき=%s\t根拠=%s\n' "$kind" "$issue" "$now" "$want" "$why"
done
echo "食い違い ${#SORTED[@]} 件（Issue $ISSUE_COUNT 件 / ボード項目 $BOARD_COUNT 件 / マージ済み PR $PR_COUNT 件 を見た）"
echo "  ただし $COVERAGE"

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
    open-issue-done)
      # **Done から自動で動かさない。** どこへ戻すべきか（Ready / In Progress / In Review）は
      # 機械には分からず、**取り違えるとボードがまた嘘をつく**。人が決める。
      log "残す #$issue: OPEN なのに Done。どの Status に戻すかは人が決めてください（board-set.sh）"
      left=$((left+1)) ;;
  esac
done
echo "直した $fixed 件 / 残した $left 件"
[[ "$left" -eq 0 ]] || exit 1
