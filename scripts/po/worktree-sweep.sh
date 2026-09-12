#!/usr/bin/env bash
# Issue #726: マージ済みの git worktree を片付ける。
#
# なぜ要るか:
#   担当者は `git worktree add` で専用ツリーを作る（PO が Issue にそう指示している）。
#   **マージした後、そのツリーを消すのは誰の仕事でもなかった。**
#   #629 で 84 本まで溜まり、2026-09-13 にも 5 本が残っていた（どちらも PO が手で消した）。
#
# なぜ merge-when-green.sh に入れないか（案 A を採らなかった理由。実測）:
#   **担当者はマージ後もツリーを使っている。** 2026-09-09 の実測:
#     #709 の担当者は PR #715 がマージされた後に完了報告を出した（アラートの確認のため）
#     #710 の担当者は PR #719 の CI を見ている最中にマージされた
#   **マージ直後に消すと、担当者が測っている最中のツリーを消すことになる。**
#   だから「マージされたら即」ではなく「PO が明示的に掃除するとき」に動かす。
#
# 安全のために守っていること（**消す道具なので、消さない側に倒す**）:
#   1. **`git status --porcelain` が空でないツリーは消さない**（未コミットの作業がある）
#   2. **push されていないコミットがあるツリーは消さない**（@{u} より進んでいる）
#   3. **PR が MERGED であることを確かめてから消す**（squash なので --is-ancestor は使えない）
#   4. **`--force` は使わない**（未コミットごと消える）
#   5. **メインの作業ツリーは対象外**（`git worktree list` の最初の行）
#   6. **既定は dry-run**。実際に消すには `--yes` が要る
#
#   Tests: scripts/po/test/worktree-sweep.test.sh（fake `git` / `gh` で実際には消さない）
#
# Usage:
#   scripts/po/worktree-sweep.sh            # 何が消えるかだけ出す（dry-run）
#   scripts/po/worktree-sweep.sh --yes      # 実際に消す
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/po/lib.sh
source "$HERE/lib.sh"

APPLY=0
case "${1:-}" in
  "") ;;
  --yes) APPLY=1 ;;
  *) usage "worktree-sweep.sh [--yes]" ;;
esac

REPO=$(po_repo)

# worktree list --porcelain は "worktree <path>" / "branch refs/heads/<name>" / 空行 の繰り返し。
# **最初のブロックはメインの作業ツリー**なので飛ばす（消してはいけない）。
declare -a PATHS=() BRANCHES=()
first=1; wt=""; br=""
while IFS= read -r line; do
  case "$line" in
    "worktree "*) wt="${line#worktree }" ;;
    "branch refs/heads/"*) br="${line#branch refs/heads/}" ;;
    "")
      if [[ -n "$wt" ]]; then
        if [[ "$first" = 1 ]]; then first=0; else PATHS+=("$wt"); BRANCHES+=("$br"); fi
      fi
      wt=""; br=""
      ;;
  esac
done < <(git worktree list --porcelain; echo)

if [[ ${#PATHS[@]} -eq 0 ]]; then log "掃除できる worktree はありません（メインだけ）"; exit 0; fi

swept=0; kept=0
for i in "${!PATHS[@]}"; do
  path="${PATHS[$i]}"; branch="${BRANCHES[$i]}"

  if [[ -z "$branch" ]]; then
    log "残す $path: detached HEAD（どのブランチか分からない）"; kept=$((kept+1)); continue
  fi

  # 1. 未コミットの作業があるツリーは消さない
  dirty=$(git -C "$path" status --porcelain 2>/dev/null | grep -v '^?? .cache' || true)
  if [[ -n "$dirty" ]]; then
    log "残す $path ($branch): 未コミットの変更が $(printf '%s\n' "$dirty" | wc -l | tr -d ' ') 件"
    kept=$((kept+1)); continue
  fi

  # 2. push されていないコミットがあるツリーは消さない
  unpushed=$(git -C "$path" log --oneline '@{u}..HEAD' 2>/dev/null | wc -l | tr -d ' ' || echo unknown)
  if [[ "$unpushed" != "0" ]]; then
    log "残す $path ($branch): push されていないコミットが $unpushed 件（上流が無い場合も含む）"
    kept=$((kept+1)); continue
  fi

  # 3. PR が MERGED であることを確かめる（squash なので --is-ancestor では判定できない）
  state=$(gh pr list --repo "$REPO" --head "$branch" --state all --json state --jq '.[0].state' 2>/dev/null || echo "")
  if [[ "$state" != "MERGED" ]]; then
    log "残す $path ($branch): PR が MERGED ではない（state=${state:-なし}）"
    kept=$((kept+1)); continue
  fi

  if [[ "$APPLY" = 0 ]]; then
    log "消せる $path ($branch): PR は MERGED、未コミット 0、未 push 0"
    swept=$((swept+1)); continue
  fi

  # 4. --force は使わない。失敗したら残す（消せない理由があるということ）
  if git worktree remove "$path" 2>/dev/null; then
    git branch -D "$branch" >/dev/null 2>&1 || log "  （ブランチ $branch は消せませんでした。手で消してください）"
    log "消した $path ($branch)"
    swept=$((swept+1))
  else
    log "残す $path ($branch): git worktree remove が失敗しました（--force は使いません）"
    kept=$((kept+1))
  fi
done

if [[ "$APPLY" = 0 ]]; then
  log "dry-run: 消せる $swept / 残す $kept。実際に消すには --yes を付けてください"
else
  log "消した $swept / 残した $kept"
fi
