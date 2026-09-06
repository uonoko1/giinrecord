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
# なお shellcheck はこの形を報告しない（#527 で実測、rc=0）。だからここで検査する。
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
EARLY_EXIT_SINK='^([A-Za-z_][A-Za-z0-9_]*=[^ \t]*[ \t]+)*(((/usr/bin/|/bin/)?(grep|egrep|fgrep)([ \t]+(-[A-Za-z]*[qlm][A-Za-z]*[0-9]*|--quiet|--silent|--files-with-matches|--max-count(=[0-9]+)?))+([ \t]|$))|((/usr/bin/|/bin/)?head([ \t]|$)))'

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

# collect_offenders <file> → "<file>:<行>\t<本文>" を 0 行以上出す。
# **本番の走査も、検査器自身のテストも、必ずこの関数を通る。**
# 片方だけが通る形にすると、こちらを空にする変異が自己テストに映らない（#527 で実測 24/0）。
collect_offenders() {
  local f=$1 n line
  # **自分が実際に走査したファイルを、検出と同じ関数の中で記録する。**
  # 記録を呼び出し側に置くと、ループの手前で `continue` するだけの変異（#500 の Z2 型）が
  # 記録に映らず、検査だけが静かに縮む（#527 で実測 24/0 で素通り）。
  [ -z "${SCANNED_LOG:-}" ] || echo "$f" >> "$SCANNED_LOG"
  while IFS=$'\t' read -r n line; do
    [ -n "$n" ] || continue
    printf '%s:%s\t%s\n' "$f" "$n" "$line"
  done < <(scan "$f")
}

# ---------------------------------------------------------------------------
# 0. 検査器自身のテスト。落とすべき形／通すべき形を並べて固定する。
#    「違反を書けば落ちる」だけでは、緩めたときに気づけない（#484）。
# ---------------------------------------------------------------------------
echo "== 検査器自身が、落とす形と通す形を正しく分ける =="
SELF="$TMP/self"; mkdir -p "$SELF"
selfcheck() {  # selfcheck <落とすべき=bad|通すべき=good> <名前> <本文>
  local want=$1 name=$2 body=$3 f="$SELF/case.sh" got
  { echo '#!/usr/bin/env bash'; echo 'set -euo pipefail'; printf '%s\n' "$body"; } > "$f"
  # scan は $ROOT からの相対パスを取るので、一時的に ROOT を差し替える
  # **本番の走査と同じ collect_offenders を通す。**
  # 自己テストが scan() を直に呼ぶと、collect_offenders のループを空にする変異
  # （BODY_TO_NOP）が自己テストに映らず、検査だけが静かに死ぬ（#527 で実測 24/0 で素通り）。
  local saved=$ROOT; ROOT=$SELF
  got=$(SCANNED_LOG='' collect_offenders "case.sh" | grep -c . || true)
  ROOT=$saved
  if [ "$want" = bad ] && [ "$got" -ge 1 ]; then ok "検査器: $name を検出する"
  elif [ "$want" = good ] && [ "$got" = 0 ]; then ok "検査器: $name を誤検出しない"
  else bad "検査器: $name は $want のはずだが検出数 $got"; fi
}

# 見本の本文は `|` を変数 P から組み立てる。**この検査ファイル自身が走査対象に入る**ので、
# 見本をそのままリテラルで書くと、検査器が自分の見本を違反として数えてしまう（実際に 1 件出た）。
P='|'

# --- 落とすべき形（早期終了する読み手がパイプの末尾）---
selfcheck bad  "printf ${P} grep -q"          "if printf '%s' \"\$X\" $P grep -q PAT; then :; fi"
selfcheck bad  "echo ${P} grep -Eq"           "if echo \"\$X\" $P grep -Eq PAT; then :; fi"
selfcheck bad  "複数行に折り返したパイプ"     "if printf '%s' \"\$X\" \\
  $P grep -q PAT; then :; fi"
selfcheck bad  "cmd ${P} head -1"             "v=\$(curl -sI \"\$U\" $P head -1)"
selfcheck bad  "grep -m1"                     "if cat f $P grep -m1 PAT; then :; fi"
selfcheck bad  "grep -l"                      "if cat f $P grep -l PAT; then :; fi"
selfcheck bad  "3段の最後が grep -q"          "if cat f $P sed s/a/b/ $P grep -q PAT; then :; fi"
selfcheck bad  "LC_ALL= を前置した grep -q"   "if cat f $P LC_ALL=C grep -q PAT; then :; fi"
selfcheck bad  "フルパスの grep -q"           "if cat f $P /usr/bin/grep -q PAT; then :; fi"
selfcheck bad  "grep --quiet（長い形）"       "if cat f $P grep --quiet PAT; then :; fi"

# --- 通すべき形（EOF まで読む／パイプでない）---
selfcheck good "here-string の grep -q"       "if grep -q PAT <<<\"\$X\"; then :; fi"
selfcheck good "プロセス置換の grep -q"       "if grep -q PAT < <(cat f); then :; fi"
selfcheck good "ファイル引数の grep -q"       "if grep -q PAT f; then :; fi"
selfcheck good "パイプ末尾が sed"             "v=\$(cat f $P sed s/a/b/)"
selfcheck good "パイプ末尾が awk"             "v=\$(cat f $P awk '{print}')"
selfcheck good "パイプ末尾が wc -l"           "v=\$(cat f $P wc -l)"
selfcheck good "パイプ末尾が grep -c"         "v=\$(cat f $P grep -c . || true)"
selfcheck good "パイプ末尾が sort"            "v=\$(cat f $P sort)"
selfcheck good "${P}${P} はパイプではない"    "grep -q PAT f ${P}${P} echo no"
selfcheck good "コメントの中の ${P} grep -q"  "# cat f $P grep -q PAT"
selfcheck good "文字列の中の ${P} grep -q"    "X=\"cat f $P grep -q PAT\""
selfcheck good "heredoc の中の ${P} grep -q"  "cat <<HD
cat f $P grep -q PAT
HD"

echo "== pipefail のもとで、早期終了する読み手をパイプの末尾に置かない（#527） =="
echo "   検査対象: ${#FILES[@]} ファイル（scripts/ci/shellcheck.sh --list）"

OFFENDERS="$TMP/offenders"; : > "$OFFENDERS"
CHECKED="$TMP/checked"; : > "$CHECKED"
WANT="$TMP/want"; : > "$WANT"
for f in "${FILES[@]}"; do
  # pipefail を使っていないファイルは、この事故が起きない（実測 0/3000）
  grep -q 'pipefail' "$ROOT/$f" 2>/dev/null || continue
  echo "$f" >> "$WANT"                       # 走査されるべき集合（入口）
  SCANNED_LOG="$CHECKED" collect_offenders "$f" >> "$OFFENDERS"
done

NWANT=$(grep -c . "$WANT" || true)
NCHECKED=$(grep -c . "$CHECKED" || true)
# 入口（対象集合）を固定する。痩せたら落とす（#499）。
if [ "$NWANT" -ge 25 ]; then
  ok "pipefail を使うファイルが $NWANT 件ある（入口）"
else
  bad "pipefail を使うファイルが $NWANT 件しかない（対象集合が痩せている）"
fi
# **出口も固定する**（#500 の Z2）。入口を数えるだけでは、
# ループの中で黙って飛ばす変異（`case "$f" in deploy/test/*) continue;;`）に気づけない。
# 件数ではなくファイル名そのものを突き合わせる（件数だけでは入れ替えを見逃す。#499）。
MISSED=$(comm -23 <(sort -u "$WANT") <(sort -u "$CHECKED"))
if [ -z "$MISSED" ]; then
  ok "入口の $NWANT 件を、検出器が 1 件残らず走査した（出口）"
else
  bad "走査されなかったファイルがある（入口 $NWANT 件 / 走査 $NCHECKED 件）:"
  printf '%s\n' "$MISSED" | sed 's/^/      /'
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
