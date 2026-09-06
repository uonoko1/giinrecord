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

usage() {
  cat >&2 <<'USAGE'
usage:
  mutate.sh run --file <path> --expr <perl-expr> [--file <path> --expr <expr> ...] -- <cmd> [args...]
  mutate.sh apply <path> <perl-expr> [<path> <perl-expr> ...]
  mutate.sh restore
  mutate.sh status
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
  printf '%s\n' "$abs"
}

sums() { md5sum "$1" | cut -d' ' -f1; }

# find_saves → 作業ツリーに残っている退避ファイルを1行ずつ（.git と node_modules は見ない）
find_saves() {
  local top; top=$(root)
  find "$top" \( -name .git -o -name node_modules \) -prune -o -type f -name "*$SV_EXT" -print | LC_ALL=C sort
}

cmd_status() {
  local saves n
  saves=$(find_saves)
  [[ -n $saves ]] || { echo "mutate: 変異は残っていない"; return 0; }
  n=$(printf '%s\n' "$saves" | wc -l)
  echo "mutate: 変異が当たったままのファイルが $n 件ある（restore で戻す）:" >&2
  local s; while IFS= read -r s; do echo "  ${s%"$SV_EXT"}" >&2; done <<< "$saves"
  return 1
}

cmd_restore() {
  local saves s target n=0
  saves=$(find_saves)
  [[ -n $saves ]] || { echo "mutate: 戻すものが無い（退避ファイルは1つも残っていない）"; return 0; }
  while IFS= read -r s; do
    target=${s%"$SV_EXT"}
    cp -p -- "$s" "$target"
    rm -f -- "$s"
    echo "mutate: 戻した $target"
    n=$((n + 1))
  done <<< "$saves"
  echo "mutate: $n 件戻した"
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

  local -a done_files=()
  local i f e before after
  for i in "${!files[@]}"; do
    f=${files[$i]}; e=${exprs[$i]}
    cp -p -- "$f" "$f$SV_EXT"
    before=$(sums "$f")
    if ! perl -pi -e "$e" -- "$f"; then
      rm -f -- "$f$SV_EXT"
      rollback done_files[@]
      die "perl が失敗した: $e"
    fi
    after=$(sums "$f")
    if [[ $before == "$after" ]]; then
      # perl は空振りでも exit 0 を返す。ここが唯一の検出点。
      cp -p -- "$f$SV_EXT" "$f"; rm -f -- "$f$SV_EXT"
      rollback done_files[@]
      echo "mutate: 変異が当たっていない（パターンが一致しなかった）" >&2
      echo "  ファイル: ${f#"$(root)"/}" >&2
      echo "  式:       $e" >&2
      echo "  md5 が変わっていない: $before" >&2
      exit 3
    fi
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
    cp -p -- "$f$SV_EXT" "$f"; rm -f -- "$f$SV_EXT"
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

  # ここから先は何があっても戻す。Ctrl-C / TERM でも戻す。
  # （KILL では戻せないが、退避は残るので後から restore できる）
  trap 'cmd_restore >&2 || true; trap - INT TERM; kill -s "$1" $$' INT TERM
  set +e
  "${cmd[@]}"
  local st=$?
  set -e
  trap - INT TERM
  cmd_restore
  return $st
}

case "${1-}" in
  run)     shift; cmd_run "$@" ;;
  apply)   shift; apply_pairs "$@" ;;
  restore) shift; (($# == 0)) || usage; cmd_restore ;;
  status)  shift; (($# == 0)) || usage; cmd_status ;;
  *)       usage ;;
esac
