#!/usr/bin/env bash
# Issue #284: `etl.yml` の rebuild 入力の中身。名寄せを厳格化したあとの作り直し（docs/ops/etl.md
# 「名寄せを厳格化したあとの作り直し（#230）」）を GitHub Actions から実行するために、ETL を走らせる
# 前に国会側の出力だけを消す。
#
#   scripts/ci/etl-rebuild-prepare.sh <rebuild> <sessions>
#     rebuild  … "yes" のときだけ消す。それ以外（空・"true"・"YES" 等）は何もせず exit 0
#     sessions … 空白区切りの回次。rebuild のときは全 22 回次（REQUIRED_SESSIONS）が必要
#
# 設計（消してはいけないものを消さないための約束）:
# - 既定では発火しない。cron 実行や sessions だけの手動実行では第 1 引数が空になり、何も消さない。
# - 発火する値は "yes" だけ。boolean の true や checkbox のような「うっかり入る」形にしない。
# - 消すのは国会側の出力だけ。地方議会（data/assemblies/ と、data/members の p_* の議員・
#   members/index.json の地方の行）は日次 ETL が書かないので、消すと復元されない。
#   **data/members はディレクトリごと消さない**（国会と地方が同じディレクトリを共有している。#157）。
# - 回次が足りなければ消す前に失敗する。data/ を消したうえで既定の 5 回次だけ流すと、
#   残り 17 回次を引き継ぐ元が無くなり永久に失われる（planSessions の carried は前回出力から作る）。
# - 何を消したかを標準出力と、GITHUB_STEP_SUMMARY があればそこにも書く。
#
# DATA_DIR で対象ディレクトリを差し替えられる（テスト用。既定は data）。
set -euo pipefail

# 作り直しで渡さなければならない回次（docs/ops/etl.md の全 22 回次 = 第200〜221回）。
REQUIRED_SESSIONS=(200 201 202 203 204 205 206 207 208 209 210 211 212 213 214 215 216 217 218 219 220 221)

REBUILD=${1:-}
SESSIONS=${2:-}
DATA_DIR=${DATA_DIR:-data}

# ディレクトリごと消してよい国会側のパス（data/members はここに入れない。下で個別に消す）。
PATHS=(rollcalls bills unmatched unmatched.json meta.json)

say() {
  echo "$1"
  [[ -n ${GITHUB_STEP_SUMMARY:-} ]] && echo "$1" >> "$GITHUB_STEP_SUMMARY"
  return 0
}

if [[ $REBUILD != "yes" ]]; then
  # 既定の経路。ここで必ず戻るので、rebuild を明示しない実行は data/ に触れない。
  echo "rebuild: no (input=[$REBUILD]); data/ is left untouched"
  exit 0
fi

# 回次の検査は削除の前に行う（不足のまま消すと復元できない）。
missing=()
for s in "${REQUIRED_SESSIONS[@]}"; do
  # 空白区切りの完全一致。"21" が "217" に当たらないよう前後の空白ごと見る。
  [[ " $SESSIONS " == *" $s "* ]] || missing+=("$s")
done
if ((${#missing[@]})); then
  {
    echo "rebuild: sessions が不足している。data/ を消していない。"
    echo "  渡された回次: [$SESSIONS]"
    echo "  足りない回次: ${missing[*]}"
    echo "  作り直しは 1 回の dispatch に全 ${#REQUIRED_SESSIONS[@]} 回次を渡す（docs/ops/etl.md）:"
    echo "    ${REQUIRED_SESSIONS[*]}"
  } >&2
  exit 1
fi

say "## ETL rebuild（国会側の data/ を消してから作り直す）"
say ""
say "| 消したパス | 件数（ファイル） |"
say "|---|---|"
total=0
for p in "${PATHS[@]}"; do
  target="$DATA_DIR/$p"
  if [[ -e $target ]]; then
    n=$(find "$target" -type f | wc -l | tr -d ' ')
    rm -rf "$target"
    total=$((total + n))
    say "| \`$target\` | $n |"
  else
    say "| \`$target\` | 0（無かった） |"
  fi
done

# data/members は国会（m_* 参院 / h_* 衆院）と地方（p_*）が共有する（#157）。国会側だけ消す:
#   - m_*.json / h_*.json と、発言の m_*/ h_*/ ディレクトリ（#242）
#   - index.json は地方の行（assemblyId が diet- 以外）だけ残して書き直す
# ディレクトリごと消すと writeDataset の地方行の引き継ぎ（消す前に読む）が空振りし、
# p_*.json 285 件と index.json の地方行が復元されないまま失われる。
members="$DATA_DIR/members"
if [[ -d $members ]]; then
  # m_*.json / h_*.json と、発言ディレクトリ m_*/ h_*/ の中身をあわせて数える。
  n=$(find "$members" -mindepth 1 -maxdepth 1 \( -name 'm_*' -o -name 'h_*' \) -exec find {} -type f \; | wc -l | tr -d ' ')
  find "$members" -mindepth 1 -maxdepth 1 \( -name 'm_*' -o -name 'h_*' \) -exec rm -rf {} +
  total=$((total + n))
  say "| \`$members/{m_*,h_*}\`（国会議員の detail と発言） | $n |"
  if [[ -f $members/index.json ]]; then
    # shellcheck disable=SC2016  # node のスクリプト。${} は JS のテンプレートリテラルで、シェルに展開させない
    kept=$(node -e '
      const fs = require("fs");
      const f = process.argv[1];
      const rows = JSON.parse(fs.readFileSync(f, "utf8"));
      // isDietMemberRow（local-assemblies.ts）と同じ判定: assemblyId が無い／diet- で始まる行が国会。
      const local = rows.filter((m) => m.assemblyId !== undefined && !String(m.assemblyId).startsWith("diet-"));
      fs.writeFileSync(f, JSON.stringify(local));
      console.log(`${rows.length - local.length}/${local.length}`);
    ' "$members/index.json")
    say "| \`$members/index.json\`（国会の行を削除 / 地方の行を保持） | ${kept%/*} / ${kept#*/} |"
  fi
fi
say "| **計** | **$total** |"
say ""
say "地方議会（\`$DATA_DIR/assemblies\`・\`$DATA_DIR/members/p_*\`）は消していない。回次: $SESSIONS"
