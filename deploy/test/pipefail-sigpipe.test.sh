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

TMP=$(mktemp -d); cleanup() { local __rc=$?; rm -rf "$TMP" || echo "warn: cleanup left $TMP behind (not a test failure)" >&2; exit "$__rc"; }; trap cleanup EXIT

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
    # take_subs(s, out): s の中の `$( … )` と `` ` … ` `` の**本体**を out[1..k] に取り出し、
    # 取り出した部分を "QQ" に置き換えた s を返す。
    #
    # **なぜ要るか**（#1225）: 旧実装は `"[^"]*"` でダブルクォートを**行ごと畳んでいた**ので、
    #   echo "- いまの理由: $(sed -n ... | head -1 || true)"
    # が `echo QQ$BODYQQ` になり、**パイプが消えて飛ばされていた**（検出器は「0 件」と報告）。
    # `$( … )` の中身は**文字列リテラルではなく、独立したパイプラインの構文**である。
    # だから「ダブルクォートを畳まない」にするのではなく（`"a | b"` を誤検出する）、
    # **本体を切り離して別のパイプラインとして見る**。
    #
    # **シングルクォートの中の `$(` は展開されない**ので取り出さない。
    # `$((…))`（算術展開）はコマンドではないので除外する。
    function take_subs(s, out, sq0,   i, n, c, sq, res, depth, body, k) {
      n = length(s); sq = sq0; k = 0; res = ""
      for (i = 1; i <= n; i++) {
        c = substr(s, i, 1)
        if (c == "\\") { res = res c substr(s, i+1, 1); i++; continue }
        if (sq) { res = res c; if (c == "'"'"'") sq = 0; continue }
        if (c == "'"'"'") { res = res c; sq = 1; continue }
        if (c == "`") {                      # `` ` … ` `` : 次の ` まで
          i++; body = ""
          while (i <= n && substr(s, i, 1) != "`") {
            if (substr(s, i, 1) == "\\") { body = body substr(s, i, 2); i += 2; continue }
            body = body substr(s, i, 1); i++
          }
          k++; out[k] = body; res = res "QQ"; continue
        }
        if (c == "$" && substr(s, i+1, 1) == "(" && substr(s, i+2, 1) != "(") {
          depth = 1; i += 2; body = ""
          while (i <= n && depth > 0) {
            c = substr(s, i, 1)
            if (c == "\\") { body = body c substr(s, i+1, 1); i += 2; continue }
            if (c == "(") depth++
            else if (c == ")") { depth--; if (depth == 0) break }
            body = body c; i++
          }
          k++; out[k] = body; res = res "QQ"; continue
        }
        res = res c
      }
      SQ_OPEN = sq            # **行をまたぐシングルクォートの状態を呼び出し側に返す**
      return res
    }
    # pipelines(s, out, nout): s と、その中のコマンド置換の本体を**再帰的に**ばらして out[] に積む。
    # 入れ子の `$( echo "$(cmd | head)" )` も届く。
    function pipelines(s, out, nout, sq0,   bodies, rest, j, mysq) {
      delete bodies
      rest = take_subs(s, bodies, sq0)
      # **この呼びの結果を先に確保する。** 下の再帰が SQ_OPEN を上書きするため。
      mysq = SQ_OPEN
      nout++; out[nout] = rest
      # 入れ子の本体は、それ自体が完結したコマンドなので sq=0 から見る
      for (j = 1; j in bodies; j++) nout = pipelines(bodies[j], out, nout, 0)
      SQ_OPEN = mysq
      return nout
    }
    # tail_is_sink(s): s をパイプで分け、末尾のコマンドが早期終了する読み手なら 1。
    # ここに来る s はコマンド置換を剥がした後なので、残る引用符は**文字列リテラル**である。
    function tail_is_sink(s,   t, n, seg, last) {
      t = s
      gsub(/'"'"'[^'"'"']*'"'"'/, "QQ", t)   # シングルクォートの中身
      gsub(/"[^"]*"/, "QQ", t)               # ダブルクォートの中身（リテラルのみ）
      gsub(/\|\|/, "\001", t)                # || を隠す
      if (index(t, "|") == 0) return 0
      n = split(t, seg, "|")
      last = seg[n]
      gsub(/\001/, "||", last)
      sub(/;.*$/, "", last)                  # `; then` `; do` などを落とす
      sub(/^[ \t]+/, "", last)
      return (last ~ sink) ? 1 : 0
    }
    BEGIN { hd = ""; sqcarry = 0 }
    hd != "" { if ($0 == hd || $0 == "\t" hd) { hd = "" } ; next }
    {
      raw = $0
      # heredoc の開始を見たら、終端まで飛ばす
      if (match(raw, /<<-?[ \t]*'"'"'?[A-Za-z_][A-Za-z0-9_]*'"'"'?/)) {
        t = substr(raw, RSTART, RLENGTH)
        sub(/^<<-?[ \t]*/, "", t); gsub(/'"'"'/, "", t)
        hd = t
      }
      # 行自体と、その中のコマンド置換の本体を、**それぞれ別のパイプラインとして**見る
      # **行をまたぐシングルクォートを持ち越す**（#1225）。
      # `bash --pretty-print` は複数行のシングルクォート（awk プログラム等）を**行のまま**残す。
      # 持ち越さないと、その中の注釈に書いた `$(cmd | head)` を**構文として読んでしまう**
      # （実測: この検査ファイル自身の awk の注釈 2 行が誤検出された）。
      delete P
      SQ_OPEN = sqcarry
      np = pipelines(raw, P, 0, sqcarry)
      sqcarry = SQ_OPEN
      for (pi = 1; pi <= np; pi++) {
        if (tail_is_sink(P[pi])) { printf "%d\t%s\n", NR, raw; next }
      }
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

# --- ダブルクォートの中の `$( … )`（#1225）---
# **`$( … )` の中身は構文であって文字列リテラルではない。**
# 旧実装は `"[^"]*"` で行ごと畳んでいたので、`echo "… $(cmd | head -1)"` の
# パイプが消え、**検出器が「0 件」と報告していた**（本番の deploy/monitor/report.sh:98 が素通り）。
selfcheck bad  "\"…\$(cmd ${P} head -1)…\" の中"   "echo \"- reason: \$(sed -n s/a/b/p f $P head -1 || true)\""
selfcheck bad  "\"\$(cmd ${P} grep -q)\" の中"      "echo \"x: \$(cat f $P grep -q PAT)\""
selfcheck bad  "入れ子の \$( \$( ${P} head ) )"      "v=\$(echo \"\$(cat f $P head -2)\")"
selfcheck bad  "バックティックの中の ${P} head"       "v=\`cat f $P head -1\`"

# --- `$( … )` を見るようにしても誤検出してはいけない形（#1225）---
# **正しく書かれた `head -1 < <(…)` を挙げないこと。**
# deploy/test/monitor-probe.test.sh:325 / :964 に実例が在る。
selfcheck good "\$(head -1 < <(cmd))"               "id=\$(head -1 < <(sed -n s/a/b/p f))"
selfcheck good "\$(head -1 < <(cmd ${P} sed))"      "id=\$(head -1 < <(grep -oE x f $P sed s/a/b/))"
selfcheck good "シングルクォートの中の \$(${P}head)" "X='literal \$(cat f $P head -1)'"
# **行をまたぐシングルクォート**（awk / python のプログラムを '…' で渡す形）。
# `bash --pretty-print` はこれを**行のまま**残すので、1 行ずつ見ると
# 途中の行が「開いたシングルクォートの中」だと分からない。
# **持ち越さないと、注釈に書いた `$(cmd | head)` を構文として読んでしまう**
# （実測: この検査ファイル自身の awk の注釈 2 行が誤検出された）。
selfcheck good "行をまたぐ '…' の中の \$(${P}head)" "awk '
  # echo \"x: \$(sed -n s/a/b/p f $P head -1)\"
  { print }
' f"
selfcheck good "\$(cmd ${P} wc -l) の中"            "echo \"n: \$(cat f $P wc -l)\""

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
