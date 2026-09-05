#!/usr/bin/env bash
# Issue #527: `set -o pipefail` と「早期終了する読み手」を組み合わせたパイプは、確率的に偽になる。
#
# 何が起きるか（#527 で実測）:
#   printf '%s' "$OUT" | grep -q '危険'
# `grep -q` は一致した瞬間に exit 0 で終わる。一致が**先頭のほう**にあると、
# `printf` はまだ残りを書いている最中で、パイプの読み手が消えて **SIGPIPE(141)** で死ぬ。
# `pipefail` はパイプラインの終了ステータスを「最後に 0 以外を返したもの」にするので、
# **grep が 0 を返しているのに、パイプライン全体は 141 = 偽**になる。
#
# 一致が最終行にあるときは grep が EOF まで読むので printf が先に書き終わり、決して落ちない。
# だから #527 は「同じ $OUT で `grep -q '危険'`(1行目) は外れるのに
# `grep -q 'deluser'`(最終行) は通る」という奇妙な形で現れた。
#
# 実測（deploy/test/ops-user-setup.test.sh の該当行、各 2000 回。#527 の PR 本文に測り方あり）:
#   pipefail on  … 危険=90/2000  env_reset=94/2000  !setenv=92/2000 が偽になる
#   pipefail off … 0/2000
#   後続データを 200KB にすると 200/200（100% 再現）
#
# **なぜ検査するか**: これはセキュリティ検査（#333/#336）を確率的に赤くする。
# 「落ちるはずのものが落ちなかった」と区別が付かない赤は、赤の意味を薄める。
# しかも**「一致を期待する」側だけが壊れる**ので、
# 「一致しないことを期待する」検査（NOPASSWD:ALL が無いこと等）は静かに通り続ける。
#
# shellcheck はこの形を報告しない（#527 で実測、rc=0）。だからここで検査する。
#   bash deploy/test/pipefail-sigpipe.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   - $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL - $1"; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# 検査対象は scripts/ci/shellcheck.sh に列挙させる（対象の決め方を自分で発明しない）。
# 「全部数えた」と言うために、対象集合は 1 か所からしか来ないようにする。
mapfile -t FILES < <(cd "$ROOT" && bash scripts/ci/shellcheck.sh --list)
if [ "${#FILES[@]}" -lt 40 ]; then
  bad "検査対象が ${#FILES[@]} 件しか取れなかった（shellcheck.sh --list が壊れている疑い）"
fi

# 早期終了しうる読み手。これらはパイプの**最後**に来ると、書き手を SIGPIPE で殺しうる。
#   grep -q / --quiet / --silent : 最初の一致で終わる
#   grep -m N / --max-count      : N 件目で終わる
#   grep -l / --files-with-matches: ファイルごとに最初の一致で終わる
#   head                          : N 行/N バイトで終わる
# `sed`・`awk`・`wc`・`sort` は EOF まで読むので対象外（#527 で実測 0/2000）。
EARLY_EXIT_SINK='^([A-Za-z_][A-Za-z0-9_]*=[^ \t]*[ \t]+)*(((/usr/bin/|/bin/)?(grep|egrep|fgrep)([ \t]+-[A-Za-z]*[qlm][A-Za-z]*)+([ \t]|$))|((/usr/bin/|/bin/)?head([ \t]|$)))'

# scan <file> → 見つかった行を "行番号<TAB>本文" で標準出力に出す
#
# bash 自身のパーサに読ませてから走査する。コメントが落ち、行継続と複数行のパイプが
# 1 行に正規化される（正規表現で「行」を仮定すると、行継続と複数行パイプで必ず負ける ← 作業合意）。
# heredoc 本体と引用符の中身は潰す。そこに書かれた `|` は構文ではない。
scan() {
  local f=$1 pretty="$TMP/pretty"
  bash --pretty-print "$ROOT/$f" > "$pretty" 2>/dev/null || return 0
  awk -v sink="$EARLY_EXIT_SINK" '
    BEGIN { hd = "" }
    hd != "" { if ($0 == hd || $0 == "\t" hd) { hd = "" } ; next }
    {
      raw = $0
      # heredoc の開始を見たら、終端まで飛ばす
      if (match(raw, /<<-?[ \t]*'"'"'?[A-Za-z_][A-Za-z0-9_]*'"'"'?/)) {
        t = substr(raw, RSTART, RLENGTH)
        sub(/^<<-?[ \t]*/, "", t); gsub(/'"'"'/, "", t)
        hd = t
      }
      s = raw
      gsub(/'"'"'[^'"'"']*'"'"'/, "QQ", s)   # シングルクォートの中身
      gsub(/"[^"]*"/, "QQ", s)               # ダブルクォートの中身
      gsub(/\|\|/, "\001", s)                # || を隠す
      if (index(s, "|") == 0) next
      n = split(s, seg, "|")
      last = seg[n]
      gsub(/\001/, "||", last)
      sub(/;.*$/, "", last)                  # `; then` `; do` などを落とす
      sub(/^[ \t]+/, "", last)
      if (last ~ sink) printf "%d\t%s\n", NR, raw
    }
  ' "$pretty"
}

echo "== pipefail のもとで、早期終了する読み手をパイプの末尾に置かない（#527） =="
echo "   検査対象: ${#FILES[@]} ファイル（scripts/ci/shellcheck.sh --list）"

OFFENDERS="$TMP/offenders"; : > "$OFFENDERS"
CHECKED="$TMP/checked"; : > "$CHECKED"
for f in "${FILES[@]}"; do
  # pipefail を使っていないファイルは、この事故が起きない（実測 0/3000）
  grep -q 'pipefail' "$ROOT/$f" 2>/dev/null || continue
  echo "$f" >> "$CHECKED"
  while IFS=$'\t' read -r n line; do
    [ -n "$n" ] || continue
    printf '%s:%s\t%s\n' "$f" "$n" "$line" >> "$OFFENDERS"
  done < <(scan "$f")
done

NCHECKED=$(grep -c . "$CHECKED" || true)
# 入口（対象集合）を固定する。痩せたら落とす（#499/#500 の教訓）。
if [ "$NCHECKED" -ge 25 ]; then
  ok "pipefail を使うファイルを $NCHECKED 件走査した"
else
  bad "走査したファイルが $NCHECKED 件しかない（対象集合が痩せている）"
fi

NOFF=$(grep -c . "$OFFENDERS" || true)
if [ "$NOFF" = 0 ]; then
  ok "pipefail のもとで早期終了する読み手をパイプの末尾に置いている箇所は無い"
else
  bad "$NOFF 箇所ある（一致が入力の先頭寄りだと、書き手が SIGPIPE で死んで確率的に偽になる）"
  sed 's/^/      /' "$OFFENDERS"
  echo "      直し方: パイプをやめる。"
  echo "        printf '%s' \"\$OUT\" | grep -q PAT   →   grep -q PAT <<<\"\$OUT\""
  echo "        cmd | grep -q PAT                   →   grep -q PAT < <(cmd)"
  echo "      （'|| true' で潰すと、本当に一致しなかった場合まで黙るので不可）"
fi

echo
echo "pass=$PASS fail=$FAIL"
[ "$FAIL" = 0 ]
