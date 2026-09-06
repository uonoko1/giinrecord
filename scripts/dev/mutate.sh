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
#   scripts/dev/mutate.sh run --file F --expr E [--file F2 --expr E2 ...] -- <コマンド>
#       退避 → 当てる（当たったか検査）→ コマンド → 必ず戻す。コマンドの終了コードを返す。
#       ふだんはこれだけ使えばよい。
#   scripts/dev/mutate.sh apply F E [F2 E2 ...]   退避して当てる（戻すのは自分でやる）
#   scripts/dev/mutate.sh restore                 退避から戻す（異常終了のあとの復旧もこれ）
#   scripts/dev/mutate.sh status                  変異が当たったままなら 1 を返して名前を出す
#
# E は perl の式（例 's/ORIGINAL/MUTANT/g'）。退避は同じ場所に <ファイル>.mutate-sv で置く。
set -euo pipefail

SV_EXT=.mutate-sv
# find_saves が刈るディレクトリ名。resolve はこの配下を拒否する。
# 「刈る側」と「拒否する側」がずれると、当たったのに戻らないファイルができる。
PRUNED_DIRS='.git
node_modules'
# apply_pairs が当てたファイルと、当てた直後の md5（run が測定後に照合する）
MUTATED_FILES=(); MUTATED_SUMS=()

usage() {
  cat >&2 <<'USAGE'
変異テストの「当てる／戻す」道具（Issue #542）。git を使わないので、あなたの未コミットの作業は消えない。

  mutate.sh run --file <path> --expr <perl式> [--file <path> --expr <式> ...] -- <cmd> [args...]
      退避 → 当てる → 当たったか確認 → <cmd> → 必ず戻す。<cmd> の終了コードを返す。ふだんはこれ。
  mutate.sh apply <path> <perl式> [<path> <perl式> ...]   退避して当てる（戻すのは自分で restore）
  mutate.sh restore   退避（<path>.mutate-sv）から戻す。異常終了のあとの復旧もこれ
  mutate.sh status    変異が当たったまま残っていれば 1 を返して名指しする

例:
  mutate.sh run --file apps/web/app/routes/member.css --expr 's/font-weight/X/g' \
    -- pnpm --filter web test

終了コード: 0 成功 / 1 拒否（外のパス・回収できない場所・退避が残っている・戻せなかった） / 2 使い方
            3 変異が当たらなかった（パターン不一致） / 4 測っている間に変異が外れた（測定は無効）
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
apply_pairs() {
  (($# >= 2 && $# % 2 == 0)) || usage

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

cmd_run() {
  local -a pairs=() cmd=()
  while (($#)); do
    case $1 in
      --file) [[ ${2-} ]] || usage; pairs+=("$2"); shift 2 ;;
      --expr) [[ ${2-} ]] || usage; pairs+=("$2"); shift 2 ;;
      --)     shift; cmd=("$@"); break ;;
      *)      usage ;;
    esac
  done
  ((${#pairs[@]} >= 2)) || usage
  ((${#cmd[@]} >= 1)) || usage

  apply_pairs "${pairs[@]}"

  # ここから先は INT / TERM / HUP を受けても戻す（KILL では戻せないが、退避は残るので後から restore できる）。
  # trap の本体は「シグナルを受けた時点」で展開されるので、そこに $1 と書くと
  # シグナル名ではなく cmd_run の第1引数（--file）になる。実際そう書いていて壊れていた。
  # シグナル名は trap を仕掛ける時点で埋め込む。
  local sig
  for sig in INT TERM HUP; do
    # shellcheck disable=SC2064  # $sig を「いま」展開したいので、あえて二重引用符
    trap "on_signal $sig" "$sig"
  done
  set +e
  "${cmd[@]}"
  local st=$?
  set -e
  trap - INT TERM HUP

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

# on_signal <シグナル名> → 戻してから、そのシグナルで自分を殺し直す
# （呼び出し元に「シグナルで死んだ」と正しく伝えるための作法）
on_signal() {
  local sig=$1
  trap - INT TERM HUP
  cmd_restore >&2 || true
  kill -s "$sig" -- "$$"
}

case "${1-}" in
  run)     shift; cmd_run "$@" ;;
  apply)   shift; apply_pairs "$@" ;;
  restore) shift; (($# == 0)) || usage; cmd_restore ;;
  status)  shift; (($# == 0)) || usage; cmd_status ;;
  *)       usage ;;
esac
