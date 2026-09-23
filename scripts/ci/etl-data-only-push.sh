#!/usr/bin/env bash
# Issue #943: データ ETL（etl.yml / districts.yml / local-assemblies.yml）が作るデータ PR の枝を、
# **既定ブランチの現在の tip と突き合わせて**「data/ 以外に 1 件も差分が無い」ことを確かめてから push する。
#
#   scripts/ci/etl-data-only-push.sh <branch>
#
# 何が起きたか（run 35473644787）:
#   ETL は実行に 2 時間かかる。その間に main が進む。枝のコミット自体は data/ しか触っていないが、
#   **枝の土台が 2 時間前の main なので、main 側で進んだファイルは「枝で巻き戻されている」ように見える。**
#   GitHub はそれを「ワークフローを書き換えようとしている」と読み、GITHUB_TOKEN（workflows 権限なし）が
#   push を拒否した。このときの土台の差分は ci.yml のテストファイル数の下限を下げるものだった——
#   **push が通っていれば、検査を弱める変更がデータ更新の PR に紛れて入っていた。**
#   止めたのは権限であって検査ではない。権限は「たまたま止まった」でしかないので、ここで検査する。
#
# 二段構え（片方では足りない）:
#   1. push の直前に origin/main を取り直して rebase する。土台が最新なら data/ 以外の差分は出ない
#   2. それでも data/ 以外に差分が出たら**失敗させる**。1 だけでは、main が push の瞬間に
#      さらに動けば同じ状態になる（そのときは 2 が鳴る）
#
# **比較は三点（...）ではなく tip 同士で行う。** 三点は merge base と比べるので、
# 土台が古いままでも「data/ しか変わっていない」と言ってしまう（実測: docs は PR 本文）。
# GitHub が見ているのは既定ブランチの現在の tip なので、こちらもそれに合わせる。
#
# 数え方（#757: 「0 件」と「数えていない」を区別できない出力を書かない）:
#   差分に出たパスを**全件**列挙し、data/ の中と外に振り分けて**両方の件数**を出す。
#   母数が 0 のときは「差分が 1 件も無い」と明示する。
#
# 環境変数（テスト用。既定は本番の値）:
#   REMOTE          … 既定 origin
#   DEFAULT_BRANCH  … 既定 main
#   ALLOWED_PREFIX  … 既定 data/ （このプレフィックスの下だけが許される）
#   PUSH            … "no" なら push しない（検査と rebase だけ）
#   REBASE          … "no" なら rebase しない。**検査だけを単独で効かせるためのもの**（テスト用）。
#                     PO の言う「2 が本体」——rebase が無くても検査は鳴る、を直接測るために要る。
set -euo pipefail

BRANCH=${1:-}
REMOTE=${REMOTE:-origin}
DEFAULT_BRANCH=${DEFAULT_BRANCH:-main}
ALLOWED_PREFIX=${ALLOWED_PREFIX:-data/}
PUSH=${PUSH:-yes}

if [[ -z $BRANCH ]]; then
  echo "usage: $0 <branch>" >&2
  exit 2
fi

say() {
  echo "$1"
  [[ -n ${GITHUB_STEP_SUMMARY:-} ]] && echo "$1" >> "$GITHUB_STEP_SUMMARY"
  return 0
}

# 1) 土台を最新にする。ETL の実行中に進んだ main を取り込んでから push する。
git fetch "$REMOTE" "$DEFAULT_BRANCH"
BASE="$REMOTE/$DEFAULT_BRANCH"
# 土台が解決できないなら、そこで止める。**解決できないまま進むと `git diff` が 1 行も出さず、
# その 0 件が「data/ の外は 0 件。push する」に化ける**（#757 の「0 件を緑にしない」。
# 実測: REMOTE=. のとき BASE が `./main` になり、git diff は fatal で終わるのに
# 検査は「差分は 1 件も無い」と言って push まで進んだ）。
git rev-parse --verify --quiet "$BASE^{commit}" > /dev/null || {
  echo "FAIL: 土台 $BASE を解決できない。比較できないものを「差分 0 件」と読むと、" >&2
  echo "  検査が素通りする（#757）。REMOTE / DEFAULT_BRANCH と fetch の結果を確かめること。" >&2
  exit 1
}
if [[ ${REBASE:-yes} != "no" ]]; then
  if ! git rebase "$BASE"; then
    git rebase --abort || true
    echo "FAIL: $BASE の上に rebase できなかった（data/ が main 側と衝突している）。" >&2
    echo "  手で確かめる: git fetch $REMOTE && git rebase $BASE" >&2
    exit 1
  fi
fi

# 2) **tip 同士**で突き合わせる。三点（...）は merge base と比べるので、土台の古さを見逃す。
# `mapfile < <(...)` はプロセス置換の終了コードを捨てるので、git diff が落ちても空配列になり
# 「差分 0 件」として通ってしまう。**一度ファイルに落として終了コードを見る。**
DIFF_OUT=$(mktemp); trap 'rm -f "$DIFF_OUT"' EXIT
if ! git diff --name-only "$BASE" HEAD > "$DIFF_OUT"; then
  echo "FAIL: git diff --name-only $BASE HEAD が失敗した。比較できていないので push しない。" >&2
  exit 1
fi
mapfile -t PATHS < "$DIFF_OUT"

inside=0
outside=0
OUTSIDE_PATHS=()
for p in "${PATHS[@]}"; do
  if [[ $p == "$ALLOWED_PREFIX"* ]]; then
    inside=$((inside + 1))
  else
    outside=$((outside + 1))
    OUTSIDE_PATHS+=("$p")
  fi
done

say "## データ PR の枝（\`$BRANCH\`）— $BASE の tip と突き合わせた"
say ""
say "| 区分 | 件数 |"
say "|---|---|"
say "| 差分のあるパス（母数） | ${#PATHS[@]} |"
say "| \`$ALLOWED_PREFIX\` の中 | $inside |"
say "| \`$ALLOWED_PREFIX\` の外 | $outside |"
say ""
if ((${#PATHS[@]} == 0)); then
  say "$BASE の tip との差分は 1 件も無い。"
fi

if ((outside > 0)); then
  {
    echo "FAIL: データ PR の枝に \`$ALLOWED_PREFIX\` 以外の差分が $outside 件ある（母数 ${#PATHS[@]} 件）。push しない。"
    echo "  データ更新の PR は $ALLOWED_PREFIX の下だけを変える。それ以外が混ざるのは、"
    echo "  枝の土台が古いか、ETL が $ALLOWED_PREFIX の外に書いたということである。"
    echo "  $ALLOWED_PREFIX の外のパス:"
    for p in "${OUTSIDE_PATHS[@]}"; do echo "    - $p"; done
  } >&2
  for p in "${OUTSIDE_PATHS[@]}"; do say "- \`$p\`（$ALLOWED_PREFIX の外）"; done
  exit 1
fi

say "\`$ALLOWED_PREFIX\` の外の差分は 0 件（母数 ${#PATHS[@]} 件を全部見た）。push する。"

[[ $PUSH == "no" ]] && exit 0

# 既存ブランチへの force-push も、土台が最新であれば .github/ の差分を含まない。
# 削除してから新規 push するのは従来どおり（PR の履歴を汚さない）。
git push "$REMOTE" --delete "$BRANCH" 2>/dev/null || true
git push "$REMOTE" "$BRANCH"
