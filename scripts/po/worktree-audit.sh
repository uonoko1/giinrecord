#!/usr/bin/env bash
# Issue #1057: 他人の worktree に残った未コミットを、**引き継ぐ前に**分類して出す（読むだけ）。
#
# なぜ要るか（実測）:
#   1. 2026-09-25: PR #1033 の担当者が共有の worktree を引き継いだとき、**前任者の staged に
#      テスト 301 行の削除が残っていた**。`git commit` を叩くだけで消えるところだった。
#   2. 2026-09-27: **PO が同じ形をもう 1 回踏みかけた**。`rp/1043w` に **staged 114 件
#      （うち D が 10 件）** が残っていた。10 件は**いま main に在るファイル**
#      （`.github/workflows/pr-body.yml` は #1050、`data/unmatched/*.json` は #1059）。
#      **worktree が #1043 マージ前のコミットに居るので、main で足されたファイルが
#      「削除」として index に乗る。** ここで commit すると**マージ済みの他人の成果物が消える。**
#   3. 同じ日、`rev1032/wt` は **`UU` が 1 件・最終更新が数分前**だった（レビュアーが解決中）。
#      **これは掃除の対象ではない。**
#
# なぜ「消す」ではなく「見る」にしたか（**倒れる向きの判断**）:
#   `worktree-sweep.sh`（#726）が既に「消す」側を担っている。**足りていないのは
#   「消してよいか」の判定ではなく、「引き継ぐ前に何が残っているかを知る」側**だった。
#   **判定を間違えたときの代償が非対称である**:
#     - 誤って鳴らす（偽陽性） → PO が 1 本余計に目で見る。**失うものは無い**
#     - 誤って消す（偽陰性）   → **他人の成果物が消える。利用者からは検出できない**
#   この repo の原則（「記録が出ない」より「別人の記録が出る」が重い）に合わせ、
#   **この道具は破壊的な git を 1 つも呼ばない**（テストで検査している）。
#   **消す判断は人が下し、`worktree-sweep.sh` が守りを掛けて実行する。**
#
# なぜ `gh` を使わないか（#1057 コメントの選択肢 1 への回答）:
#   PO のコメントは「`--is-ancestor` は squash merge に効かないので、`gh pr view --json state`
#   と組み合わせるか、内容で確かめるか」を問うている。**この道具はどちらも採らない。**
#   **「その枝がマージ済みか」を判定しないと決めた**からである:
#     - **マージ済みかどうかは、残留が危ないかどうかを変えない。** `rp/1043w` が危なかったのは
#       「#1043 がマージ済みだから」ではなく、**index に D が 10 件乗っていたから**である。
#       同じ D は未マージの枝にも乗る（main を取り込みかけて止まれば必ずこの形になる）。
#     - **`gh` に依存すると offline で使えない**。この道具は「commit を叩く前の 1 秒」に
#       走らせたいので、**ネットワークが要る設計にしてはいけない。**
#   **マージ済みかどうかを問うのは `worktree-sweep.sh` の仕事**（あちらは実際に消すので
#   `gh pr list --head <branch> --json state` で MERGED を確かめている。#726 の守り 3）。
#   **`git merge-base --is-ancestor` はこのファイルでは一度も使わない。**
#
# 出す分類（重い順）:
#   1. conflict : `U*`/`*U`/`DD`/`AA` が在る = **誰かが解決の途中**。触ってはいけない
#   2. deletion : staged に `D` が在る = **commit すると他人の成果物が消える**（exit 3 の原因）
#   3. staged   : staged に `M`/`A`/`R` だけ = 上書きされるだけ。**D と同じ重さではない**
#   4. dirty    : 未 stage の変更だけ = commit しても index には入らない
#   （`?? .measure/` `?? .cache/` だけは残留に数えない。#787。**毎回鳴ると鳴っていること自体を見なくなる**）
#
# 終了コード:
#   0 = 残留が無い、または conflict/staged/dirty だけ（**鳴り続けないようにする**。#978）
#   2 = 使い方が違う
#   3 = **staged に D が在る worktree が 1 本以上**（commit で他人の成果物が消える形）
#
# Tests: scripts/po/test/worktree-audit.test.sh（fake `git`。実在のツリーを触らない）
#
# Usage:
#   scripts/po/worktree-audit.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/po/lib.sh
source "$HERE/lib.sh"

case "${1:-}" in
  "") ;;
  *) usage "worktree-audit.sh" ;;
esac

# 「作業中かもしれない」と言う閾値（秒）。既定 6 時間。
#
# **根拠（実測 2026-09-27。手元の worktree 22 本の年齢分布を測った。#1070 のレビュー指摘）:**
#   年齢（分、昇順）:
#     1 10 14 27 52 84 115 137 181 245 | 698 699 699 700 795 796 811 896 910 945 988 | 4811
#   感度表（閾値 → 印が付く本数 / 22）:
#     30分 4 / 60分 5 / 2h 7 / **4h 9 / 6h 10 / 8h 10** / 12h 14 / 24h 21 / 48h 21
#
#   **245 分と 698 分の間に大きな空白がある**ので、**4h / 6h / 8h は実質同じ答えを出す**
#   （9〜10 本）。**6h はその平坦部の中央**である。
#   **12h 以上は危ない**: 14/22 → 21/22 と増え、**印がほぼ全部に付いて意味を失う。**
#   短すぎる側も危ない: 30 分だと 4/22 で、`rev1032/wt`（数分前）は拾えるが
#   「昼に始めて夕方に戻ってきた」ツリーを「放置」と呼んでしまう。
#
# **長い側に倒してある**（この印は「触るな」の意味なので、**多めに付くほうが安全**）。
ACTIVE_WINDOW=${ACTIVE_WINDOW:-21600}
# テストから現在時刻を固定するため。**既定は本物の時計**。
NOW=${AUDIT_NOW:-$(date +%s)}

declare -a PATHS=() BRANCHES=()
wt=""; br=""
while IFS= read -r line; do
  case "$line" in
    "worktree "*) wt="${line#worktree }" ;;
    "branch refs/heads/"*) br="${line#branch refs/heads/}" ;;
    "")
      # **メインの作業ツリーも数え、調べる**（#1057 の 3 件のうち 1 件は PO 自身の手元だった）。
      # 調べるだけで触らないので、除外する理由が無い。
      if [[ -n "$wt" ]]; then PATHS+=("$wt"); BRANCHES+=("${br:-（detached HEAD）}"); fi
      wt=""; br=""
      ;;
  esac
done < <(git worktree list --porcelain; echo)

total=${#PATHS[@]}
conflicts=0; deletions=0; staged_only=0; dirty_only=0; residue=0; unreadable=0; del_in_conflict=0

for i in "${!PATHS[@]}"; do
  path="${PATHS[$i]}"; branch="${BRANCHES[$i]}"

  if ! st=$(git -C "$path" status --porcelain 2>/dev/null); then
    log "読めない $path ($branch): status が取れませんでした（消えた worktree かもしれません）"
    unreadable=$((unreadable+1)); continue
  fi

  # 作業ディレクトリ（#787 と同じ狭い除外。未追跡の `.measure/` `.cache/` ちょうどだけ）
  st=$(printf '%s\n' "$st" | grep -Ev '^\?\? (.*/)?\.(cache|measure)/$' || true)
  st=$(printf '%s\n' "$st" | grep . || true)
  [[ -z "$st" ]] && continue

  residue=$((residue+1))

  # `U` を含む 2 文字、および `DD` / `AA` が「解決の途中」。
  # **git の未解決の形はこの 7 つで全部**（DD AU UD UA DU AA UU）。
  unmerged=$(printf '%s\n' "$st" | grep -E '^(DD|AU|UD|UA|DU|AA|UU) ' || true)
  n_unmerged=$(printf '%s\n' "$unmerged" | grep -c . || true)

  # staged の内訳は `diff --cached --name-status` で取る。
  # **`status --porcelain` の 1 文字目を読むだけでは足りない**: `UU` の 1 文字目は `U` で
  # index にも並ぶので、`D`/`M` の数え方を揃えるために index の側から数える。
  #
  # **既知の限界（#1070 のレビューで実測）**: **コンフリクト中のパスは
  # `diff --cached` が `U` と返す**（`DD f` の状態で `U f`）ので、
  # **未解決パス自身の削除は `n_del` に入らない。** **運用上の穴にはなっていない**——
  # そのツリーは必ず `conflict` に分類され、**より強い「触らないでください」が出る**ためである。
  # **`n_del` を `status` 側から数え直して直そうとしないこと**: `UU` を `D` に数えると
  # 「解決途中」と「消える」の区別が壊れる（それが #1057 の PO の指摘 2 そのものである）。
  cached=$(git -C "$path" diff --cached --name-status 2>/dev/null || true)
  del_files=$(printf '%s\n' "$cached" | awk -F'\t' '$1 ~ /^D/ {print $2}' | grep . || true)
  n_del=$(printf '%s\n' "$del_files" | grep -c . || true)
  n_staged=$(printf '%s\n' "$cached" | grep -c . || true)

  # 最終更新時刻: **HEAD のコミット時刻と index の mtime の、遅いほう**を使う。
  #   - `log -1 --format=%ct` だけでは足りない: **commit せずに 3 時間編集し続けている**ツリーは
  #     HEAD が古いままなので「放置」に見える（`rev1032/wt` がまさにこの形だった——
  #     HEAD は他人のコミットで、動いているのは index のほうだけ）。
  #   - `stat` だけでも足りない: worktree を作り直した直後は index が新しく見える。
  # **遅いほうを採る = 「作業中かもしれない」を多めに付ける側に倒す**（この印は「触るな」の意味）。
  last=$(git -C "$path" log -1 --format=%ct 2>/dev/null || echo 0)
  is_int "$last" || last=0
  idx_mtime=$(git -C "$path" rev-parse --git-path index 2>/dev/null || true)
  if [[ -n "$idx_mtime" && -f "$idx_mtime" ]]; then
    idx_mtime=$(stat -c %Y "$idx_mtime" 2>/dev/null || echo 0)
    is_int "$idx_mtime" && [[ "$idx_mtime" -gt "$last" ]] && last=$idx_mtime
  fi
  age=$(( NOW - last ))
  active=""
  if [[ "$last" != 0 && "$age" -lt "$ACTIVE_WINDOW" ]]; then
    active=" — 最終更新は $(( age / 60 )) 分前。**誰かが作業中かもしれません**"
  fi

  # **分類は 1 本につき 1 つ**（内訳の合計が残留の本数と合うように。合わないと数字が信用されない）。
  # **重い順**: conflict > deletion > staged > dirty。
  # ただし**印は重ねて出す**——conflict のツリーに D も在れば、D も挙げる（**両方が危ない**）。
  if [[ "$n_unmerged" != "0" ]]; then
    conflicts=$((conflicts+1))
    log "conflict $path ($branch): マージの解決途中が $n_unmerged 件（staged $n_staged 件・うち削除 $n_del 件）${active}"
    printf '%s\n' "$unmerged" | sed 's/^/           /' >&2
    log "           **このツリーには触らないでください**（担当者に確認してから）"
    if [[ "$n_del" != "0" ]]; then
      log "           **さらに、削除が staged で $n_del 件あります。commit すると消えます**:"
      printf '%s\n' "$del_files" | sed 's/^/           D /' >&2
      del_in_conflict=$((del_in_conflict+1))
    fi
  elif [[ "$n_del" != "0" ]]; then
    deletions=$((deletions+1))
    log "deletion $path ($branch): **削除が staged で $n_del 件**（staged $n_staged 件）${active}"
    log "           **ここで git commit すると、この $n_del 件が消えます**:"
    printf '%s\n' "$del_files" | sed 's/^/           D /' >&2
  elif [[ "$n_staged" != "0" ]]; then
    staged_only=$((staged_only+1))
    log "staged   $path ($branch): staged $n_staged 件（削除 0 件）${active}"
    log "           commit すると混ざります。**上書きなので消えはしません**が、内容を確かめてください"
  else
    dirty_only=$((dirty_only+1))
    n_dirty=$(printf '%s\n' "$st" | grep -c . || true)
    log "dirty    $path ($branch): 未 stage の変更が $n_dirty 件（staged 0 件）${active}"
  fi
done

# **母数を必ず出す（#757）。「残留 0 本」と「1 本も調べていない」を同じ顔にしない。**
log "worktree $total 本を調べました: 残留 $residue 本（conflict $conflicts / deletion $deletions / staged $staged_only / dirty $dirty_only）、読めなかったもの $unreadable 本"

# **conflict に分類したツリーの中にも D が在りうる**（今日の rev1032/wt がそれ）。
# **conflict の数に隠れて D が見えなくなってはいけない**ので、別に数えて出す。
[[ "$del_in_conflict" != "0" ]] && log "そのうち conflict のツリー $del_in_conflict 本にも staged の削除が在ります"

if [[ $(( deletions + del_in_conflict )) != "0" ]]; then
  # **バックティックを使わない**: log は二重引用符で受けるので、`git ...` はコマンド置換されて
  # **助言そのものが消える**（2026-09-27 に実測。本物の worktree に当てて気づいた）。
  log "**削除が staged のツリーが $(( deletions + del_in_conflict )) 本あります。commit する前に 'git diff --cached --diff-filter=D' を見てください。**"
  log "index だけ戻すなら 'git reset'（ワークツリーは触りません）。**捨てる前に担当者に確認してください**"
  exit 3
fi
exit 0
