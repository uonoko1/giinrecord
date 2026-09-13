#!/usr/bin/env bash
# Issue #823: **測定 PBI の本文を `docs/research/MEASUREMENT-TEMPLATE.md` から起こす。**
#
# なぜ要るか（実測。#823 で PO が 10 本の Issue を走査した）:
#   **PO が 9 回（滋賀 #705/#718・青森 #743・秋田 #753・佐賀 #765・佐賀回転 #773・群馬 #769・
#   沖縄 #774・大分 #780・山梨 #782）手で Issue を書いた。**
#   「記号列を 1 つ回転させる」は 10/10 本に書いてあった。**「y 方向（その行がどの議案か）」は
#   0/10 本だった。** **8 県の測定すべてで y 方向が測られていない**（#819）。
#   **8 人が同じ穴を持った理由は、8 人ではなく、毎回手で書いていた本文の側にある。**
#
#   だから**手で書く経路を無くす**。`--create` まで通せば、PO は本文を 1 文字も手で打たない。
#
# **雛形が唯一の出どころである。** このスクリプトは項目を 1 つも持っていない——
#   すべて MEASUREMENT-TEMPLATE.md から読む。**スクリプトだけ直して雛形が古いまま（またはその逆）が
#   起きない作り**（`sprint-doc-shape.test.ts` が TEMPLATE.md に対してやっているのと同じ考え）。
#   **抜き出せた項目が 0 件なら異常終了する**（exit 4）——#757。
#   **「空の本文を静かに出す」のが、この道具にとっての最悪の壊れ方**である
#   （y 方向が抜けたまま 8 回走った、と同じことが起きる）。
#
#   Tests: scripts/po/test/measure-pbi.test.sh
#          packages/etl/test/measurement-template-shape.test.ts（雛形の中身を逐語で押さえる）
#
# Usage:
#   scripts/po/measure-pbi.sh --pref 熊本 --prior '#618 が 3 本だけ開いた'
#   scripts/po/measure-pbi.sh --pref 熊本 --prior '...' --sprint 29 --create
#
# 終了コード: 0 成功 / 2 使い方 / 4 雛形から項目を抜き出せなかった
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/po/lib.sh
source "$HERE/lib.sh"

TEMPLATE=${MEASURE_TEMPLATE:-$(cd "$HERE/../.." && pwd)/docs/research/MEASUREMENT-TEMPLATE.md}

PREF=""; PRIOR=""; SPRINT=""; CREATE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pref)   PREF=${2:-}; shift 2 ;;
    --prior)  PRIOR=${2:-}; shift 2 ;;
    --sprint) SPRINT=${2:-}; shift 2 ;;
    --create) CREATE=1; shift ;;
    *) usage "measure-pbi.sh --pref <県名> --prior <これまで何本開いたか> [--sprint N] [--create]" ;;
  esac
done
[[ -n "$PREF"  ]] || usage "measure-pbi.sh --pref <県名> --prior <これまで何本開いたか> [--sprint N] [--create]"
[[ -n "$PRIOR" ]] || usage "measure-pbi.sh --pref <県名> --prior <これまで何本開いたか> [--sprint N] [--create]"
[[ -f "$TEMPLATE" ]] || die "雛形が無い: $TEMPLATE
**これが本文の唯一の出どころである。** 消したのなら戻すこと（#823）。"

# section <title> → 雛形の `## <title>` から次の `## ` までを出す（見出しと HTML コメントは除く）
section() {
  awk -v want="## $1" '
    $0 == want { inside = 1; next }
    inside && /^## / { inside = 0 }
    inside { print }
  ' "$TEMPLATE" | awk '
    # HTML コメントを落とす。**1 行で閉じる `<!-- ... -->` も落とす**——
    # 範囲指定だけで書くと、1 行コメントが「開いたまま」になり、以降の本文が全部消える。
    # **実際にそれで「必ず守ること」が 0 行になり、exit 4 が捕まえた**（#823 の実測）。
    /^<!--/ && /-->[[:space:]]*$/ { next }
    /^<!--/ { skip = 1; next }
    skip && /-->[[:space:]]*$/ { skip = 0; next }
    skip { next }
    { print }
  '
}

ITEMS=$(section "測る項目（必須）")
RULES=$(section "必ず守ること（必須）")

# **母数を見る**（#757）。空の本文を静かに出すのが、この道具の最悪の壊れ方である。
n_items=$(printf '%s\n' "$ITEMS" | grep -c '^| [0-9]' || true)
n_rules=$(printf '%s\n' "$RULES" | grep -c '^- ' || true)
if [[ "$n_items" -eq 0 || "$n_rules" -eq 0 ]]; then
  echo "error: 雛形から項目を抜き出せなかった（測る項目 $n_items 行 / 必ず守ること $n_rules 行）: $TEMPLATE" >&2
  echo "**0 件のまま本文を出すと、y 方向が 9 回抜けたのと同じことが起きる**（#823）。" >&2
  exit 4
fi
log "雛形から抜き出した: 測る項目 $n_items 項目 / 必ず守ること $n_rules 項目"

TITLE="[S${SPRINT:-N}] ${PREF}の賛否 PDF を全部測る（${PRIOR}）"

BODY=$(cat <<EOF
## なぜ今これか

**${PREF}について、これまでに開いたのは ${PRIOR}。**
**同じ形で、実装前の全数測定が毎回落とし穴を出している**（青森 2→56 本・秋田 2→154 本・
群馬 8→106 本・沖縄 3→170 本）。**本数は数え方で変わるので、まず機械的に数えること。**

## 測る項目（必須）

**下の表は \`docs/research/MEASUREMENT-TEMPLATE.md\` から機械的に写したものである**
（\`scripts/po/measure-pbi.sh\`）。**${n_items} 項目すべてに答えること。**
**該当しない項目は行を消さず「該当なし」と理由を書く**（消せることが #823 の原因である）。

$ITEMS

## ${PREF}に固有のこと

**\`docs/research/local-assemblies.md\` の${PREF}の節に残っている留保を、ここに書き出すこと。**
凡例にあるが実物を見ていない記号／\`/Rotate\` の有無／文字層の有無／左端の stray な記号／
氏名の欠落（\`𠮷\`）／名簿から抜けている議員——**該当するものを列挙する。**

## 取得のしかた

**\`docs/DATA_CONTRACT.md\` の「一次資料の取得と再公開（#537）」を先に読むこと**（チェックリスト 7 項目）。
\`polite-fetch.ts\` を使い、UA を名乗り、直列、間隔を長めに（#710 の愛知は 2 秒で WAF に当たった）。
**既に取得済みのものは取り直さないこと。**

## 必ず守ること

$RULES

## 成果物

**\`docs/research/local-assemblies.md\` の${PREF}の節。**
**PR 本文に \`Closes #N\` を書くこと**（\`scripts/ci/pr-closes.sh\` が検査する）。
**測った数字を書く。「妥当に見える」は書かない。確かめていないことは「確かめていない」と書く。**

<!-- scripts/po/measure-pbi.sh が docs/research/MEASUREMENT-TEMPLATE.md から起こした本文 (#823) -->
EOF
)

if [[ "$CREATE" == 1 ]]; then
  gh issue create --repo "$(po_repo)" --title "$TITLE" --body "$BODY"
else
  echo "# $TITLE"
  echo
  echo "$BODY"
fi
