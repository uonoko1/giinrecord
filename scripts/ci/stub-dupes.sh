#!/usr/bin/env bash
# Issue #814 / #799: **同じテストファイルの中で、同じ外部コマンドのスタブが 2 回定義されていた。**
#
# 何が起きたか: #798 と #786 が同じ `scripts/ci/test/human-tasks.test.sh` に
# それぞれ `cat > "$BIN/gh"` を置いた。**後勝ちで、先に書かれたほうの約束が黙って消える。**
# 消えたスタブが守っていた assert は、**落ちないのではなく「測らなくなる」**——緑のままになる。
# 見つかったのは偶然（#799 の担当者が統合したときにテスト 4 本が落ちた）。
#
#   scripts/ci/stub-dupes.sh          → 検査する（重複があれば exit 1）
#   scripts/ci/stub-dupes.sh --list   → 見つけた <ファイル> <コマンド> <行> を出す
#
# **関数やテストの中での置き直しは重複ではない**（`restore_curl_stub` のように、
# 既定へ戻すため／その 1 本だけ応答を変えるために、わざとやる形がある。実測 3 か所）。
# **トップレベル（字下げなし）の定義だけ**を数える——#799 の形はそれだった。
#   Tests: scripts/ci/test/gh-flags.test.sh
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

# `cat > "$BIN/<cmd>"` が行頭から始まる行だけを拾う。$BIN 以外の変数名も受ける。
list() {
  local f
  # **`|| true` が要る**: grep は不一致で 1 を返す。`set -e` の下でそれを拾うと
  # ループごと止まり、**1 件も見つからないのに「重複なし」**で緑になる。
  while IFS= read -r f; do
    [[ -f $f ]] || continue
    grep -nE '^cat > "[$][A-Za-z_]+/[a-z0-9_.-]+"' "$f" 2>/dev/null |
      sed -E "s|^([0-9]+):cat > \"[$][A-Za-z_]+/([a-z0-9_.-]+)\".*|$f\t\\2\t\\1|" || true
  done < <(git ls-files -- scripts deploy) | LC_ALL=C sort
}

case "${1:-}" in
  --list) list; exit 0 ;;
  "") ;;
  *) echo "usage: $0 [--list]" >&2; exit 2 ;;
esac

FOUND=$(list)
if [[ -z $FOUND ]]; then
  # **0 件を緑と読み違えない**（#757）。1 本も無いのは検査が壊れている可能性のほうが高い。
  echo "stub-dupes.sh: スタブの定義を 1 件も拾えませんでした。抽出が壊れています。" >&2
  exit 2
fi

DUPES=$(cut -f1,2 <<<"$FOUND" | LC_ALL=C uniq -d)
if [[ -n $DUPES ]]; then
  while IFS=$'\t' read -r f cmd; do
    lines=$(awk -F'\t' -v f="$f" -v c="$cmd" '$1==f && $2==c {printf "%s ", $3}' <<<"$FOUND")
    echo "!! $f: '$cmd' のスタブがトップレベルで 2 回以上定義されています（行 $lines）" >&2
    echo "   **後に書いたほうが勝ち、先のスタブが守っていた assert は黙って測られなくなります**（#799）。" >&2
    echo "   1 つに統合するか、置き直す側を関数かテストの中へ字下げして入れてください。" >&2
  done <<<"$DUPES"
  echo "stub-dupes.sh: $(wc -l <<<"$FOUND") 件のトップレベル定義を見て $(wc -l <<<"$DUPES") 組が重複" >&2
  exit 1
fi
echo "stub-dupes.sh: ok — $(wc -l <<<"$FOUND") 件のトップレベルのスタブ定義に重複なし"
