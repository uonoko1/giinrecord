#!/usr/bin/env bash
# #1114 の事故そのものを再現して、いまの mutate.sh がそれを見せる／止めるかを測る。
#
# なぜ要るか: PR #1127 の本文に載せた「visible 0→1 / stopped 0→2」という表の出どころが
# 手元のスクリプトにしか無く、レビューで検算できなかった（#1127 のレビュー指摘）。
# 「再現できない数字」は検算できないので、測った道具そのものをリポジトリに置く。
#
#   bash scripts/dev/test/mutate-accident-repro.sh [<mutate.sh のパス>]
#     既定は同じ枝の scripts/dev/mutate.sh。別の版（例: 基点の取り出し）を渡すと比べられる。
#
# 測る 3 つ（いずれも「$ が shell に補間されて式が別物に化けた」あとの形を直に与える）:
#   A  誤爆が目に入るか   意図は 1 行なのに 3 行当たる。意図しない行が出力に現れるか
#   B  --expect が止めるか 宣言と違う変異で、コマンドを走らせずに落ちるか
#   C  逐語なら化けないか  --from/--to なら巻き添えが出ないか
#
# 出力の最後の行が `RESULT visible=<0|1> stopped=<0..2>`。
set -u
M=${1:-}
if [[ -z $M ]]; then
  M=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/mutate.sh
fi
[[ -f $M ]] || { echo "対象が見つからない: $M" >&2; exit 2; }
M=$(cd "$(dirname "$M")" && pwd)/$(basename "$M")

W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
mkdir -p "$W/src"
cd "$W" || exit 99
git init -q -b main
# fixture: 意図は「しきい値の比較 1 箇所」。s/2/999/ に化けると 3 行に当たる。
mk() { printf 'const THRESH = 2;\nif (residue > 2) { warn(); }\nconst pair = "k1-k2";\n' > src/app.ts; }
mk
git add -A
git -c user.name=t -c user.email=t@example.invalid commit -qm init

VISIBLE=0; STOPPED=0

# --- A: $((residue+1)) が展開され、意図の 1 行でなく 3 行に当たった（#1100 / #1115 の形） ---
mk
OUT=$(bash "$M" run --file src/app.ts --expr 's/2/999/' -- true 2>&1); ST=$?
case $OUT in *k1-k999*) VISIBLE=1 ;; esac
echo "A: exit=$ST  意図しない行が見えるか=$([[ $VISIBLE == 1 ]] && echo yes || echo no)"

# --- B: 宣言と違う変異を --expect が止めるか（コマンドを走らせないこと込み） ---
mk; rm -f RAN
OUT=$(bash "$M" run --file src/app.ts --expr 's/k1-/ZZ/' --expect 'k1-k2ZZ' -- touch RAN 2>&1); ST=$?
if [[ $ST == 5 && ! -e RAN ]]; then STOPPED=$((STOPPED+1)); fi
echo "B: exit=$ST  コマンドが走ったか=$([[ -e RAN ]] && echo yes || echo no)（期待: exit=5 / 走らない）"
rm -f RAN

# --- C: 逐語（--from/--to）なら、そもそも巻き添えが出ない ---
mk
OUT=$(bash "$M" run --file src/app.ts --from 'residue > 2' --to 'residue > 999' -- cat src/app.ts 2>&1); ST=$?
if [[ $OUT == *"residue > 999"* && $OUT == *"THRESH = 2"* && $OUT == *"k1-k2"* ]]; then
  STOPPED=$((STOPPED+1))
  echo "C: exit=$ST  狙った 1 行だけが変わった（THRESH と k1-k2 は無傷）"
else
  echo "C: exit=$ST  逐語置換が使えない（この版には --from/--to が無いか、巻き添えが出た）"
fi

echo "RESULT visible=$VISIBLE stopped=$STOPPED"
