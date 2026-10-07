#!/usr/bin/env bash
# 変異テストのための、共通の「当てる／戻す」道具（Issue #542）。
#
# なぜ git を使わないか:
#   2026-09-06 の1日だけで、変異ハーネスの `git checkout` / `git reset --hard` が
#   担当者の未コミットの作業を3回消した。git の「元に戻す」は HEAD に戻すので、
#   変異と一緒に、その人がまだコミットしていない作業も消す。
#   このスクリプトは `cp` で退避し `cp` で戻す。対象ファイル以外には一切触らない。
#   git の破壊的コマンド（checkout/restore/reset/stash/clean）は1つも呼ばない
#   （scripts/dev/test/mutate.test.sh がソースを見て固定している）。
#
# なぜ「当たったか」を確かめるか:
#   `perl -pi -e` も `sed -i` も、パターンが一致しなくても終了コード 0 を返し、
#   ファイルも変わらない。変異が当たっていないのに当たったつもりで測ると、
#   結果は全部無意味になる（#514 で実際に起きた）。
#   ここでは当てる前後の md5 を比べ、変わっていなければ落とす。
#
# なぜ md5 だけでは足りなかったか（#1114。#514 の対策は半分しか塞いでいなかった）:
#   #514 の事故には2つの形があるのに、md5 は片方しか見ていなかった。
#
#     空振り（ファイルが変わらない）     → md5 で捕まる（exit 3）
#     誤爆（意図と違うものに変わった）   → md5 は通る。緑のまま偽の数字が出る   ← 塞げていなかった
#
#   誤爆のほうが質が悪い。空振りは exit 3 で止まるので少なくとも嘘の数字は出ないが、
#   誤爆は「測定が走って、結果が出て、それが間違っている」。測った本人にしか気づけない。
#
#   2026-09-30 時点で少なくとも6回・4人以上が踏んだ（#1100 が1回、#1115 が2回、#1122 が1回、#1124 が2回。
#   同一の担当者が別 PBI で2回踏んだ疑いも在るが確かめていないので人数は「4人以上」）。
#   どの回も原因は同じで、`--expr` の中の `$` が shell に補間されたこと:
#     ${k2}           → 空に展開され、式が「何にも一致しない正規表現」や別の式に化けた
#     $((residue+1))  → 算術展開で数値になり、意図と違う場所に当たった
#   偽の「52/6」「20 件 fail」「51 tests / 1 fail」が出た。踏んだ人は毎回自力で気づいて測り直したが、
#   気づかなければ PR 本文に載っていた。
#
#   **補間は mutate.sh が呼ばれる前に終わっている。** 受け取った時点で `$` は既に消えているので、
#   「式に `$` が在ったら警告」では1件も捕まらない（むしろ単引用符で正しく書いた `s/(a)(b)/$2$1/`
#   のほうに `$` が残るので、誤検出にしかならない）。捕まえられるのは「何が実際に変わったか」だけ。
#   そこで3つ足した:
#     1. 当たったら必ず差分を標準エラーに出す（何行・どの行が変わったか）。目に入るので飛ばせない。
#     2. --expect '<置換後に含まれるはずの文字列>' で宣言させ、突き合わせる（違えば exit 5）。
#        **ただし「宣言すれば安全」ではない。** 見ているのは「その文字列が在るか」だけなので、
#        **宣言した文字列がたまたま在れば、意図と違う行に当たっていても通る。**
#        実測（#1127 のレビュー）: `s/2/999/g` が 3 行に当たっても、`--expect 'THRESH = 999'`
#        は通ってしまう（宣言した文字列自体は在るため）。**止める力は宣言した分だけ。**
#        **全件に効くのは 1 の差分のほうで、--expect はその上乗せである。**
#     3. --from / --to の逐語置換。perl の式を書かないので、メタ文字も区切り文字も後方参照も効かない。
#        3人が python の逐語置換に逃げたのは、この形が欲しかったから。
#
#   scripts/dev/mutate.sh run --file F --expr E [--file F2 --expr E2 ...] -- <コマンド>
#       退避 → 当てる（当たったか検査）→ コマンド → 必ず戻す。コマンドの終了コードを返す。
#       ふだんはこれだけ使えばよい。
#   scripts/dev/mutate.sh apply F E [F2 E2 ...]   退避して当てる（戻すのは自分でやる）
#   scripts/dev/mutate.sh restore                 退避から戻す（異常終了のあとの復旧もこれ）
#   scripts/dev/mutate.sh status                  変異が当たったままなら 1 を返して名前を出す
#
# E は perl の式（例 's/ORIGINAL/MUTANT/g'）。**必ず単引用符で囲むこと**（$ が shell に食われる。#1114）。
# 式を書きたくないときは --expr の代わりに --from <文字列> --to <文字列> で逐語置換できる。
# 退避は同じ場所に <ファイル>.mutate-sv で置く。
set -euo pipefail

SV_EXT=.mutate-sv
# find_saves が刈るディレクトリ名。resolve はこの配下を拒否する。
# 「刈る側」と「拒否する側」がずれると、当たったのに戻らないファイルができる。
PRUNED_DIRS='.git
node_modules'
# apply_pairs が当てたファイルと、当てた直後の md5（run が測定後に照合する）
MUTATED_FILES=(); MUTATED_SUMS=()
# run だけが 1 にする。apply は当てたまま残すのが仕様なので、restore の trap を仕掛けない。
ARM_RESTORE_TRAP=0
TRAP_ARMED=0

usage() {
  cat >&2 <<'USAGE'
変異テストの「当てる／戻す」道具（Issue #542）。git を使わないので、あなたの未コミットの作業は消えない。

  mutate.sh run --file <path> (--expr <perl式> | --from <文字列> --to <文字列>) [--expect <文字列>]
                [--file ... ] -- <cmd> [args...]
      退避 → 当てる → 当たったか確認 → 差分を表示 → <cmd> → 必ず戻す。<cmd> の終了コードを返す。ふだんはこれ。
  mutate.sh apply <path> <perl式> [--expect <文字列>] [<path> <perl式> ...]   退避して当てる（戻すのは自分で restore）
  mutate.sh apply <path> --from <文字列> --to <文字列> [--expect <文字列>]    逐語置換の形
  mutate.sh restore   退避（<path>.mutate-sv）から戻す。異常終了のあとの復旧もこれ
  mutate.sh status    変異が当たったまま残っていれば 1 を返して名指しする

perl 式は **必ず単引用符で囲む**こと。二重引用符だと ${k2} や $((n+1)) が shell に食われて
別の式に化け、しかも「当たりはする」ので md5 は通る（#1114。少なくとも6回・4人以上が踏んだ）。
当たった変異の差分は毎回標準エラーに出る。意図と違う行に当たっていないか、そこで目を通すこと。
--expect に「置換後に含まれるはずの文字列」を宣言すると、違うときだけ exit 5 で止まる。
ただし --expect は「その文字列が在るか」しか見ない。宣言した文字列がたまたま在れば、
意図と違う行に当たっていても通る（止める力は宣言した分だけ。全件に効くのは差分のほう）。

例:
  mutate.sh run --file apps/web/app/routes/member.css --expr 's/font-weight/X/g' \
    -- pnpm --filter web test
  mutate.sh run --file src/tally.ts --from 'residue + 1' --to 'residue' --expect 'return residue;' \
    -- pnpm --filter web test

終了コード: 0 成功 / 1 拒否（外のパス・回収できない場所・退避が残っている・戻せなかった） / 2 使い方
            3 変異が当たらなかった（パターン不一致） / 4 測っている間に変異が外れた（測定は無効）
            5 当たったが --expect の宣言と違う（意図と違う変異。測らせない）
USAGE
  exit 2
}

die() { echo "mutate: $*" >&2; exit 1; }

# root → この作業ツリーのトップ。ここから外は触らない。
root() {
  git rev-parse --show-toplevel 2>/dev/null || die "git の作業ツリーの中で実行すること"
}

# resolve <path> → 作業ツリー内の絶対パスにする。外なら拒否する。
# 他の worktree（同じリポジトリでも別ディレクトリ）を巻き込まないための唯一の関門。
resolve() {
  local p=$1 top abs dir base
  top=$(root)
  dir=$(dirname -- "$p"); base=$(basename -- "$p")
  [[ -d $dir ]] || die "ディレクトリが無い: $p"
  dir=$(cd -- "$dir" && pwd -P)
  abs="$dir/$base"
  # top 自身も -P で正規化してから比べる（symlink 経由でも同じ判定になるように）
  top=$(cd -- "$top" && pwd -P)
  [[ $abs == "$top"/* ]] || die "この作業ツリーの外は触らない: $p"
  [[ $abs != *"$SV_EXT" ]] || die "退避ファイル自体は対象にできない: $p"
  # find_saves が刈る場所に当てると、退避が孤児になって restore が見つけられない
  # （＝当たったまま「戻すものが無い」と嘘をつく）。受け入れる集合と回収できる集合を一致させる。
  local rel=${abs#"$top"/} seg
  while IFS= read -r seg; do
    [[ $rel == "$seg"/* || $rel == *"/$seg/"* ]] && die "回収できない場所は対象にできない（$seg 配下）: $p"
  done <<< "$PRUNED_DIRS"
  printf '%s\n' "$abs"
}

sums() { md5sum "$1" | cut -d' ' -f1; }

# 当たった変異の差分を何行まで見せるか。事故の形は「1 行のつもりが N 行」なので、
# 全体の行数は必ず出したうえで、本文だけ切る（端末が流れて結局読まれなくなるのを避ける）。
DIFF_MAX_LINES=${MUTATE_DIFF_MAX_LINES:-20}

# 逐語置換（--from / --to）は、値を perl の式に埋め込まず環境変数で渡す。
#   式に埋め込むと、区切り文字 `/` も、正規表現のメタ文字も、置換側の `$1` も効いてしまい、
#   「逐語」でなくなる（そして #1114 の事故と同じで、当たりはするので md5 は通る）。
#   perl は環境変数を %ENV で見るので、パターンは \Q..\E で、置換側は $ENV{...} で受ける。
#   複数ファイル分を同時に持てるように、1 ファイルにつき連番の変数名を使う。
#
#   逐語性を支えているのは2つで、役割が違う（変異で測って分かった。#1114）:
#     \Q..\E        パターン側のメタ文字を殺す。外すと `a.b` が `.` のワイルドカードとして効く
#     $ENV{...}     値を式の本文に埋め込まない。外すと区切りの `/` も置換側の `$1` も効いてしまう
#   `\Q` だけ外しても `./a/b/c` の検査は落ちない（`.` が任意1文字になっても自分自身には一致する）。
#   区切り文字の安全は $ENV{...} のほうが担っている。両方要る。
LITERAL_N=0
# literal_expr <from> <to> → 逐語置換の perl 式を1行で返す（環境変数は export 済みにする）。
#   $() の中で呼ぶと export が親に残らないので、**サブシェルの外で呼ぶこと**。
#   結果は LITERAL_EXPR に置く（戻り値を $() で受け取らせないため）。
LITERAL_EXPR=''
literal_expr() {
  local from=$1 to=$2 n=$LITERAL_N
  LITERAL_N=$((LITERAL_N + 1))
  eval "export MUTATE_FROM_$n=\$from MUTATE_TO_$n=\$to"
  # shellcheck disable=SC2016  # $ENV{...} は perl に渡す文字列。shell に展開させてはいけない（それが #1114 の事故そのもの）
  LITERAL_EXPR='s/\Q$ENV{MUTATE_FROM_'"$n"'}\E/$ENV{MUTATE_TO_'"$n"'}/g'
}

# show_diff <file> <save> → 変異で実際に何行が・どう変わったかを標準エラーに出す。
#   これが #1114 の中心。md5 の対 `a1b2… → c3d4…` は人間に何も伝えないので、
#   「意図と違う行に当たった」が目に入らなかった。差分なら飛ばせない。
#   標準出力には出さない（`-- pnpm test` の出力を集計するのを邪魔しないため）。
show_diff() {
  local file=$1 save=$2 rel n
  rel=${file#"$(root)"/}
  # diff は差分があると exit 1 を返す。ここでは「あるのが当たり前」なので拾い直す。
  local body; body=$(diff -U0 -- "$save" "$file" 2>/dev/null || true)
  # 実際に置き換わった行数（+ 側を数える。@@ とヘッダは除く）
  n=$(printf '%s\n' "$body" | grep -c '^+[^+]' || true)
  [[ -n $n ]] || n=0
  echo "mutate: $rel で $n 行が変わった。意図した変異か、下の差分で確かめること" >&2
  local shown=0 line
  while IFS= read -r line; do
    case $line in
      ---*|+++*|@@*) continue ;;
      [-+]*) ;;
      *) continue ;;
    esac
    if ((shown >= DIFF_MAX_LINES)); then
      echo "  … 以降は省略（全体で $n 行が変わっている。MUTATE_DIFF_MAX_LINES で増やせる）" >&2
      break
    fi
    echo "  $line" >&2
    shown=$((shown + 1))
  done <<< "$body"
}

# 退避と一緒に「当てた直後の md5」を記録する。restore はそれと一致するときだけ上書きする。
# .mutate-sv は crash を越えて残り、しかも gitignore されているので git status からは見えない。
# 記録しないと、翌日その場所に書いた本物の作業を、古い退避が黙って消す
# （この道具が防ごうとしている事故そのものを、git ではなく cp で起こす）。
meta_path() { printf '%s\n' "$1$SV_EXT.md5"; }

# find_saves → 作業ツリーに残っている退避ファイルを1行ずつ（.git と node_modules は見ない）
find_saves() {
  local top; top=$(root)
  local -a prune=(); local d
  while IFS= read -r d; do prune+=(-name "$d" -o); done <<< "$PRUNED_DIRS"
  unset 'prune[-1]'   # 末尾の -o を落とす
  find "$top" \( "${prune[@]}" \) -prune -o -type f -name "*$SV_EXT" -print | LC_ALL=C sort
}

cmd_status() {
  local saves n
  saves=$(find_saves)
  [[ -n $saves ]] || { echo "mutate: 変異は残っていない"; return 0; }
  n=$(printf '%s\n' "$saves" | wc -l)
  echo "mutate: 変異が当たったままのファイルが $n 件ある（restore で戻す）:" >&2
  local s target; while IFS= read -r s; do
    target=${s%"$SV_EXT"}
    if stale "$target"; then
      echo "  $target  ← 当てたときと違う中身。restore は上書きを拒否する" >&2
    else
      echo "  $target" >&2
    fi
  done <<< "$saves"
  return 1
}

# stale <target> → 0 なら「当てたとき」から中身が変わっている（＝誰かが後から書いた）
stale() {
  local target=$1 meta expected
  meta=$(meta_path "$target")
  [[ -f $meta ]] || return 1          # 記録が無い（古い形式）ときは黙って上書きしない判断ができないので、変わっていない扱い
  [[ -f $target ]] || return 1        # 対象が消えているなら退避から書き戻してよい
  expected=$(cat "$meta")
  [[ $(sums "$target") != "$expected" ]]
}

cmd_restore() {
  local saves s target n=0 skipped=0
  saves=$(find_saves)
  [[ -n $saves ]] || { echo "mutate: 戻すものが無い（退避ファイルは1つも残っていない）"; return 0; }
  while IFS= read -r s; do
    target=${s%"$SV_EXT"}
    if stale "$target"; then
      # 当てたときの変異後の中身ではない＝この場所に後から本物の作業が書かれている。
      # 上書きすればそれを消す。人が判断できるように、両方残して落ちる。
      echo "mutate: $target は当てたときと違う中身になっている。上書きしない" >&2
      echo "  変異を当てた直後の md5: $(cat "$(meta_path "$target")")" >&2
      echo "  いまの md5:             $(sums "$target")" >&2
      echo "  当てる前の中身は $s に残してある。中身を見て、要るほうを自分で選ぶこと" >&2
      skipped=$((skipped + 1))
      continue
    fi
    # cp の失敗を握り潰さない。戻せていないのに「戻した」と言うのが最悪。
    if ! cp -p -- "$s" "$target"; then
      echo "mutate: $target を戻せなかった（退避 $s はそのまま残す）" >&2
      return 1
    fi
    # 退避の削除に失敗したら、次の restore が「古い退避」として本物の作業を狙う。
    # 戻せていない場合と同じ重さで落とす。
    if ! rm -f -- "$s" "$(meta_path "$target")"; then
      echo "mutate: $target は戻したが、退避 $s を消せなかった（次回の restore が誤爆する）" >&2
      return 1
    fi
    echo "mutate: 戻した $target"
    n=$((n + 1))
  done <<< "$saves"
  echo "mutate: $n 件戻した"
  [[ $skipped == 0 ]] || return 1
}

# apply_pairs <path> <expr> [...] → 退避 → 当てる → 当たったか検査。
# 1つでも空振りしたら、そこまでに当てたものを全部戻して落とす。
# 「半端に当たった状態」で測らせないため（どの結果も信用できなくなる）。
# 引数の形は <path> <perl式> [--expect <文字列>] の繰り返し。--expect は直前のファイルに係る。
# --from / --to は cmd_apply / cmd_run が先に perl の式に畳んでからここへ来る。
# 走査の結果は PAIR_EXPECTS（位置で files に対応）に置く。
PAIR_EXPECTS=()
apply_pairs() {
  local -a rest=()
  PAIR_EXPECTS=()
  while (($#)); do
    case $1 in
      --expect)
        [[ ${2-} ]] || usage
        ((${#PAIR_EXPECTS[@]} > 0)) || usage        # 係る相手が無い --expect は使い方の誤り
        [[ -z ${PAIR_EXPECTS[-1]} ]] || usage       # 同じファイルに2回は受けない
        PAIR_EXPECTS[${#PAIR_EXPECTS[@]} - 1]=$2; shift 2 ;;
      *)
        [[ ${2-} ]] || usage
        rest+=("$1" "$2"); PAIR_EXPECTS+=(""); shift 2 ;;
    esac
  done
  set -- "${rest[@]}"
  (($# >= 2 && $# % 2 == 0)) || usage
  local -a EXPECTS=("${PAIR_EXPECTS[@]}")

  local existing
  existing=$(find_saves)
  if [[ -n $existing ]]; then
    echo "mutate: 前の変異の退避が残っている。先に restore すること（上書きすると元が消える）:" >&2
    local s; while IFS= read -r s; do echo "  ${s%"$SV_EXT"}" >&2; done <<< "$existing"
    exit 1
  fi

  # 先に全部解決してから触る（途中で拒否されて半端に当たるのを避ける）
  local -a files=() exprs=()
  while (($#)); do
    local f; f=$(resolve "$1")
    [[ -f $f ]] || die "ファイルが無い: $1"
    files+=("$f"); exprs+=("$2"); shift 2
  done

  # 同じ解決済みパスが2回来たら、当てる前に拒否する（#577）。
  # 2回目の `cp -p -- "$f" "$f$SV_EXT"` は「元のファイル」ではなく「1回目の変異で
  # 書き換えた後のファイル」を退避として上書きしてしまう。戻すとその変異済みの
  # 中身が書き戻り、しかも find_saves は退避を1つも見つけられない（1回しか
  # 作られておらず、それも消費済みなので）ため status も気づけない。
  # 1ファイルに複数の変異をかけたいときは --expr を "s/A/X/; s/B/Y/" と連結するのが
  # 正しい使い方なので、ここで一度に受け付けるのは1ファイルにつき1回に限る。
  local dup_i dup_j
  for ((dup_i = 0; dup_i < ${#files[@]}; dup_i++)); do
    for ((dup_j = dup_i + 1; dup_j < ${#files[@]}; dup_j++)); do
      [[ ${files[$dup_i]} != "${files[$dup_j]}" ]] || \
        die "同じファイルを1回の呼び出しで2回渡すことはできない（${files[$dup_i]#"$(root)"/}）。1ファイルに複数の変異をかけたいときは --expr を 's/A/X/; s/B/Y/' のように連結すること"
    done
  done

  # ここより前は disk に何も書いていない（「退避が残っている」拒否もここより前に済んでいる）。
  # だから handler を仕掛けるのはここ。1 行でも書いた後に仕掛けると、その間に殺されたぶんが
  # 戻らない（#1114 の余波。詳しくは arm_restore_trap の上のコメント）。
  # 逆にこれより前で仕掛けると、他人が残した退避を「自分が作ったもの」として戻してしまう。
  arm_restore_trap
  # 見張りも cp より前に立てる（#1255）。trap が走らないことが在るので、こちらが最後の砦。
  start_watchdog

  local -a done_files=()
  local i f e before after
  for i in "${!files[@]}"; do
    f=${files[$i]}; e=${exprs[$i]}
    cp -p -- "$f" "$f$SV_EXT"
    before=$(sums "$f")
    if ! perl -pi -e "$e" -- "$f"; then
      rm -f -- "$f$SV_EXT" "$(meta_path "$f")"
      rollback done_files[@]
      die "perl が失敗した: $e"
    fi
    after=$(sums "$f")
    if [[ $before == "$after" ]]; then
      # perl は空振りでも exit 0 を返す。ここが唯一の検出点。
      cp -p -- "$f$SV_EXT" "$f"; rm -f -- "$f$SV_EXT" "$(meta_path "$f")"
      rollback done_files[@]
      echo "mutate: 変異が当たっていない（パターンが一致しなかった）" >&2
      echo "  ファイル: ${f#"$(root)"/}" >&2
      echo "  式:       $e" >&2
      echo "  md5 が変わっていない: $before" >&2
      exit 3
    fi
    printf '%s\n' "$after" > "$(meta_path "$f")"
    MUTATED_FILES+=("$f"); MUTATED_SUMS+=("$after")
    done_files+=("$f")
    echo "mutate: 当てた ${f#"$(root)"/}  md5 $before → $after"

    # #1114: md5 の対は人間に何も伝えない。実際に何行が・どう変わったかを必ず見せる。
    # 「意図と違う行に当たった」は、これを見れば測る前に気づける。飛ばす操作は無い。
    show_diff "$f" "$f$SV_EXT"

    # --expect が在れば、宣言と突き合わせて自動で止める（目視に頼らない側）。
    local want=${EXPECTS[$i]-}
    if [[ -n $want ]] && ! grep -qF -- "$want" "$f"; then
      cp -p -- "$f$SV_EXT" "$f"; rm -f -- "$f$SV_EXT" "$(meta_path "$f")"
      rollback done_files[@]
      echo "mutate: 当たったが、--expect の宣言と違う（意図と違う変異。測らせない）" >&2
      echo "  ファイル: ${f#"$(root)"/}" >&2
      echo "  式:       $e" >&2
      echo "  --expect: $want" >&2
      echo "  置換後のファイルにこの文字列が無い。式が shell の補間で化けていないか確かめること（#1114）" >&2
      exit 5
    fi
  done
}

# rollback <array-name[@]> → 当て済みのファイルを退避から戻す
rollback() {
  local -a arr=("${!1}")
  local f
  for f in "${arr[@]}"; do
    [[ -f "$f$SV_EXT" ]] || continue
    cp -p -- "$f$SV_EXT" "$f"; rm -f -- "$f$SV_EXT" "$(meta_path "$f")"
    echo "mutate: 巻き戻した ${f#"$(root)"/}" >&2
  done
}

# fold_from_to <args...> → --from X --to Y を perl の逐語置換式に畳んで、
# apply_pairs が読める <path> <expr> [--expect ...] の並びに直す。
# 結果は FOLDED に置く。--expr と --from を同じファイルに両方渡したら拒否する
# （どちらが効くか曖昧なまま測らせない）。
FOLDED=()
fold_from_to() {
  FOLDED=()
  local have_expr=0 have_from=0 from='' to=''
  # 直前のファイルについて --expr / --from の状態を持ち回る。
  flush_pending() {
    if ((have_from)); then
      ((have_expr == 0)) || die "同じファイルに --expr と --from の両方は渡せない（どちらが効くか曖昧になる）"
      [[ -n $from && -n $to ]] || usage        # --from だけ／--to だけは使い方の誤り
      literal_expr "$from" "$to"; FOLDED+=("$LITERAL_EXPR")
    fi
    have_expr=0; have_from=0; from=''; to=''
  }
  local first=1
  while (($#)); do
    case $1 in
      --file)
        [[ ${2-} ]] || usage
        ((first)) || flush_pending
        first=0
        FOLDED+=("$2"); shift 2 ;;
      --expr)
        [[ ${2-} ]] || usage
        ((first == 0)) || usage
        ((have_from == 0)) || die "同じファイルに --expr と --from の両方は渡せない（どちらが効くか曖昧になる）"
        have_expr=1; FOLDED+=("$2"); shift 2 ;;
      --from)
        [[ ${2-} ]] || usage
        ((first == 0)) || usage
        ((have_expr == 0)) || die "同じファイルに --expr と --from の両方は渡せない（どちらが効くか曖昧になる）"
        have_from=1; from=$2; shift 2 ;;
      --to)
        [[ ${2-} ]] || usage
        ((have_from)) || usage                  # --to だけ先に来るのは使い方の誤り
        to=$2; shift 2 ;;
      --expect)
        [[ ${2-} ]] || usage
        flush_pending
        FOLDED+=(--expect "$2"); shift 2
        # --expect を畳んだ時点で、そのファイルの式は確定している。
        first=0 ;;
      *) usage ;;
    esac
  done
  ((first == 0)) || usage
  flush_pending
}

cmd_run() {
  local -a raw=() cmd=()
  while (($#)); do
    case $1 in
      --) shift; cmd=("$@"); break ;;
      *)  raw+=("$1"); shift ;;
    esac
  done
  ((${#raw[@]} >= 2)) || usage
  ((${#cmd[@]} >= 1)) || usage
  fold_from_to "${raw[@]}"
  local -a pairs=("${FOLDED[@]}")

  # 退避を作る前に handler を仕掛けさせる。apply_pairs が最初の cp の直前で arm する
  # （ここで仕掛けると「他人の退避が残っている」拒否より前になり、それを戻してしまう）。
  ARM_RESTORE_TRAP=1
  apply_pairs "${pairs[@]}"

  set +e
  "${cmd[@]}"
  local st=$?
  set -e
  disarm_restore_trap

  # 測っている間に変異が外れていないか確かめる。外れていたら、その測定結果は
  # 「変異なしで測った」ものなので無意味（#514 と同じ形）。exit 0 で済ませない。
  local i f drifted=0
  for i in "${!MUTATED_FILES[@]}"; do
    f=${MUTATED_FILES[$i]}
    [[ -f $f ]] || { drifted=1; echo "mutate: 測っている間に $f が消えた。この測定結果は使えない" >&2; continue; }
    if [[ $(sums "$f") != "${MUTATED_SUMS[$i]}" ]]; then
      drifted=1
      echo "mutate: 測っている間に ${f#"$(root)"/} の変異が外れた。この測定結果は使えない" >&2
      echo "  当てた直後の md5: ${MUTATED_SUMS[$i]}" >&2
      echo "  コマンド終了後:   $(sums "$f")" >&2
    fi
  done

  cmd_restore || return 1
  [[ $drifted == 0 ]] || return 4
  return $st
}

# arm_restore_trap → INT / TERM / HUP を受けたら戻す handler を仕掛ける（run のときだけ）。
#   **必ず「退避を作る cp」より前に呼ぶこと。** これが #1114 の余波の核心である:
#   もとの実装は apply_pairs が全部終わってから cmd_run で trap を仕掛けていたので、
#     cp（退避ができる）→ perl（変異が当たる）→ echo → trap
#   の間ずっと「退避と変異が disk に在るのに handler が無い」瞬間が在った。
#   実測（#1114 の枝と、その基点の両方）:
#     「当てた」のログで kill      基点 16/16 緑 / 枝 24 回中 6 回赤（show_diff が幅を広げた）
#     退避が現れた瞬間に kill      基点 10 回中 9 回赤 / 枝 10 回中 10 回赤
#   **窓は show_diff が作ったのではなく、最初から在った。** だから show_diff を echo の前に
#   動かす（幅を狭める）のではなく、trap を cp より前に出して**窓そのものを無くす**。
#   KILL では戻せないが、退避は残るので後から restore できる。
#   trap の本体は「シグナルを受けた時点」で展開されるので、そこに $1 と書くと
#   シグナル名ではなく呼び出し元の第1引数（--file）になる。実際そう書いていて壊れていた。
#   シグナル名は trap を仕掛ける時点で埋め込む。
arm_restore_trap() {
  ((ARM_RESTORE_TRAP)) || return 0
  ((TRAP_ARMED == 0)) || return 0
  local sig
  for sig in INT TERM HUP; do
    # shellcheck disable=SC2064  # $sig を「いま」展開したいので、あえて二重引用符
    trap "on_signal $sig" "$sig"
  done
  TRAP_ARMED=1
}

# ---- #1255: trap は「仕掛けてあっても走らない」ことがある --------------------------------------
# #1114 で trap を cp より前に出し、「退避が在るのに handler が無い瞬間」は消した。
# それでも #1251 の CI が同じ落ち方（**変異が残り、退避も残る**）を捕まえた。
#
# 原因は窓ではなく、**trap そのものが走らないこと**だった。実測（この枝で特定）:
#   退避が現れた瞬間に SIGTERM   60 回中 1 回 / 80 回中 1 回 / 200 回中 3 回が赤
#   赤い回の標準エラーは必ずこの 1 行だけ:
#     mutate.sh: trap: line 2: unexpected EOF while looking for matching `)'
#   DEBUG trap で追うと **on_signal には一度も入っていない**。
#   bash は trap の「文字列」をシグナルを受けた時点で parse し直す。その瞬間にパーサが
#   $( ) の途中だと、trap の本体を「$( ) の続き」として読んでしまい、閉じ括弧が無いまま
#   EOF に達して落ちる。**handler は走らず、そのままシェルが死ぬ。**
#
# trap の本体をどう綴っても逃げられない（この枝で測った。各回 setsid + グループへ TERM）:
#   "on_signal TERM"（いまの形）  40 回中 1 回 parse error
#   on_signal（引数なしの裸）     40 回中 0 回 → N を増やすと **150 回中 5 回**
#   "{ on_signal TERM; }"         40 回中 1 回 parse error
#   "(on_signal TERM)"            40 回中 1 回 parse error
# **「trap の書き方を直す」では塞げない。** そして SIGKILL では trap は定義上走らない。
#
# だから設計を変える: **死にかけのシェル自身に戻させない。**
# 退避を作る前に、別プロセスの見張りを立てる。見張りは親の死を待ち、
# 親が自分で戻せていなければ（＝退避がまだ在れば）代わりに戻す。
# 見張りは親とは別の bash なので、親のパーサがどんな状態で死のうと関係ない。
# trap は残す（速い経路で、かつ「戻した」のログを人に見せられる）。見張りは最後の砦である。
WATCHDOG_PID=''
WATCHDOG_FLAG=''

# start_watchdog → 親の死を待って、退避が残っていたら戻す見張りを別プロセスで立てる。
#   **必ず「退避を作る cp」より前に呼ぶこと**（理由は trap と同じ。立つ前に殺されたぶんが戻らない）。
#   setsid でプロセスグループの外に出す。出さないと、検査や人が撃つ
#   `kill -TERM -- -<pgid>` が見張りごと殺してしまい、最後の砦が消える。
#   見張りが自分で復元の実装を持つと、本物の restore と挙動がずれていく
#   （stale の判定を持たない見張りは、人の作業を黙って上書きする）。だから
#   見張りは自分自身を `mutate.sh restore` として呼び直す。経路は 1 本に保つ。
start_watchdog() {
  ((ARM_RESTORE_TRAP)) || return 0
  [[ -z $WATCHDOG_PID ]] || return 0
  # 「もう要らない」を見張りに伝える印。親が消すと、見張りは何もせずに去る。
  # ファイルで伝えるのは、親が SIGKILL で死ぬときに「伝え損なう」経路を作らないため
  # （親が死ぬ＝印が残る＝見張りが働く、という向きにしておく）。
  WATCHDOG_FLAG=$(mktemp -t mutate-watchdog.XXXXXX)
  local self=$0 parent=$$ top; top=$(root)
  # shellcheck disable=SC2016  # 見張りの本体は**親のシェルに展開させてはいけない**。
  # 展開すると親の変数が焼き込まれ、親が死んだ後に意味を失う（$flag / $parent が空になる）。
  # 値は位置引数で渡す（下の mutate-watchdog 以降）。
  setsid bash -c '
    flag=$1; parent=$2; self=$3; top=$4
    # 親が死ぬまで待つ。kill -0 は「シグナルを送らずに生存だけ見る」。
    while [[ -e $flag ]] && kill -0 "$parent" 2>/dev/null; do sleep 0.05; done
    # 印が消えていれば、親は正常に終わって自分で戻した。何も触らない。
    [[ -e $flag ]] || exit 0
    rm -f -- "$flag"
    # 親は戻さずに死んだ。退避が残っていれば restore を代わりに走らせる。
    # 残っていなければ（trap が間に合った場合）何もしない。
    cd -- "$top" || exit 0
    bash "$self" status >/dev/null 2>&1 && exit 0
    bash "$self" restore >/dev/null 2>&1 || true
  ' mutate-watchdog "$WATCHDOG_FLAG" "$parent" "$self" "$top" >/dev/null 2>&1 &
  WATCHDOG_PID=$!
  # 親の job table から外す。残すと終了時に "Terminated" が stderr に漏れて、
  # 変異の出力を読んでいる人と、出力を見ている検査の両方を惑わせる。
  disown "$WATCHDOG_PID" 2>/dev/null || true
}

# stop_watchdog → 見張りに「もう要らない」と伝える。
#   印を消すだけで、見張りは次の目覚めで自分から去る。殺しに行かないのは、
#   見張りが setsid で別グループに居て、PID が再利用されている可能性が在るため
#   （知らないプロセスを撃つより、印を消して待つほうが安全側）。
#
#   **退避が 1 つでも残っているなら解除しない。** 「親が終わった」と「戻っている」は別である。
#   - restore が stale で拒否した（人の作業が在るので上書きしない）→ 退避は残る。
#     このとき見張りも同じ restore を呼ぶので、同じ理由で同じように拒否する。何も壊れない。
#   - restore が cp に失敗した → 退避が残る。見張りがもう一度試す。
#   解除する条件を「終わったら」ではなく「戻っていたら」にしておくと、
#   **解除の判断を間違えても安全な側に倒れる**（余計に見張りが残るだけで、何も上書きしない）。
stop_watchdog() {
  [[ -n $WATCHDOG_FLAG ]] || return 0
  [[ -z $(find_saves) ]] || return 0
  rm -f -- "$WATCHDOG_FLAG"
  WATCHDOG_FLAG=''
  WATCHDOG_PID=''
}

# 親がどの経路で終わっても見張りを解除する（exit 3 / exit 5 / die / 正常終了）。
# EXIT の trap は $( ) のサブシェルでは走らない（親の 1 回だけ）ことを確かめてある。
# ここを個々の exit の手前に書くと、必ずどれかを書き落とす。1 か所にする。
trap stop_watchdog EXIT

# disarm_restore_trap → handler を外す（正常経路で自分で戻すとき、二重に戻さないため）
disarm_restore_trap() {
  trap - INT TERM HUP
  TRAP_ARMED=0
}

# on_signal <シグナル名> → 戻してから、そのシグナルで自分を殺し直す
# （呼び出し元に「シグナルで死んだ」と正しく伝えるための作法）
on_signal() {
  local sig=$1
  disarm_restore_trap
  # trap を cp より前に仕掛けたので、「まだ何も当てていない」状態で来ることがある。
  # そこで cmd_restore を呼ぶと「戻すものが無い」が出る。それは restore が二重に走った
  # ときの合図と同じ文言なので、出すと検査の意味が消える（そして人も誤読する）。
  if [[ -n $(find_saves) ]]; then
    cmd_restore >&2 || true
  fi
  kill -s "$sig" -- "$$"
}

# apply は位置引数の形（<path> <expr>）と、--from / --to の形の両方を受ける。
# 後者は --file を書かない形なので、先頭のパスを --file に読み替えてから畳む。
cmd_apply() {
  (($#)) || usage
  local a
  # 逐語の形（--from）が1つでも混ざっているなら --file 形に正規化して fold_from_to に通す。
  # パイプにしない（#527）。grep -q は一致した時点で閉じるので、pipefail のもとでは
  # 書き手の printf が SIGPIPE で死に、結果が確率的に偽になる。
  if grep -qx -- '--from' <<< "$(printf '%s\n' "$@")"; then
    local -a norm=() prev_is_flagval=0
    for a in "$@"; do
      if ((prev_is_flagval)); then norm+=("$a"); prev_is_flagval=0; continue; fi
      case $a in
        --from|--to|--expect|--expr) norm+=("$a"); prev_is_flagval=1 ;;
        *) norm+=(--file "$a") ;;
      esac
    done
    fold_from_to "${norm[@]}"
    apply_pairs "${FOLDED[@]}"
    return
  fi
  apply_pairs "$@"
}

case "${1-}" in
  run)     shift; cmd_run "$@" ;;
  apply)   shift; cmd_apply "$@" ;;
  restore) shift; (($# == 0)) || usage; cmd_restore ;;
  status)  shift; (($# == 0)) || usage; cmd_status ;;
  *)       usage ;;
esac
