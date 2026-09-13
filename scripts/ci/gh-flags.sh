#!/usr/bin/env bash
# Issue #814: **スタブと実装が同じ誤りを共有して緑になった**のを、機械で見つけるための検査。
#
# 何が起きたか（実測 2026-09-13）: PR #798 は `gh secret set --body-file -` を書いた。
# **このフラグは存在しない。** それでも検査 20 件は緑だった——**スタブが同じ誤りを持っていたから。**
# スタブを実装から書けば、両方が同じ嘘を信じる。突き合わせても一致する。
# **変異テストでは原理的に見つからない**（実装を壊せばスタブごと落ちるので、8 変異すべて正しく撃墜していた）。
#
# だからここでは**リポジトリの中どうしを突き合わせない**。**本物の `gh` の `--help` を一次資料にする。**
#   scripts/ci/gh-flags.sh            → 検査する（食い違いがあれば exit 1）
#   scripts/ci/gh-flags.sh --list     → 見つけた <サブコマンド> <フラグ> <ファイル:行> を出す
#
# **なぜ `--help` か（案 A）**——Issue #814 は A / B / C を並べていた。実測して A を選んだ:
#   A `--help` と突き合わせる: **認証も網も要らない**。`HOME=/nonexistent GH_CONFIG_DIR=/nx GH_TOKEN=`
#      でも exit 0 で FLAGS を出す（実測 gh 2.89.0）。副作用ゼロ。
#   B 使うフラグを列挙して人が見る: **人が見る＝守られない**。#814 そのものが「人が見て通した」事故。
#   C `--no-store` で本物を叩く: **認証と網が要る。** 実測:
#        $ echo x | GH_TOKEN=invalid gh secret set ZZ --repo … --no-store
#        failed to fetch public key: HTTP 401: Bad credentials
#      公開鍵を取りに行くので、**トークンが無い CI・オフラインでは走らない**。
#      しかも secrets への書き込み権限を持つトークンを CI に置くことになる。**検査のために権限を増やさない。**
#      （**フラグの解析だけは網より前に起きる**ことは実測した——`--body-file` は 401 より先に
#        `unknown flag` で落ちる。つまり C でも見つかりはする。だが A で同じものが無権限・無通信で取れる。）
#
# **`gh` が無ければスキップする。だが「黙って緑」にはしない**（#757）——理由を 1 行出して exit 0。
# CI（ubuntu-latest）には `gh` が入っているので、そこでは必ず走る。
#   Tests: scripts/ci/test/gh-flags.test.sh
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

# `gh --help` を読む先。テストは GH_FLAGS_GH に偽の gh を置いて、本物を呼ばずに検査そのものを測る。
GH_BIN=${GH_FLAGS_GH:-gh}

# 走査の対象。scripts/ と deploy/ の **本番のスクリプトだけ**——テストの中の `gh` は
# スタブ宛ての assert 文字列であって、本物に渡る引数ではない。
list_targets() {
  local f
  find scripts deploy -type d -name node_modules -prune -o -type f -print | while IFS= read -r f; do
    case "$f" in
      *.sh) ;;
      */*.*) continue ;;
      *) head -c 64 "$f" 2>/dev/null | head -n1 | grep -qE '^#!.*(/| )(ba)?sh( |$)' || continue ;;
    esac
    case "$f" in */test/*|*.test.sh|*fake-bin*) continue ;; esac
    echo "$f"
  done | LC_ALL=C sort
}

# `gh <sub> [<sub2>] --flag …` の行から「サブコマンド」と「長いフラグ」を取り出す。
#
# **サブコマンドごとに引く**のが要点。`--body-file` は `gh issue create` には**ある**が
# `gh secret set` には**無い**（両方このリポジトリで実際に使っている）。
# サブコマンドを見ない検査は、片方を見逃すか、もう片方を誤検出するかのどちらかになる。
extract() {
  local f line no rest sub sub2 tok
  while IFS= read -r f; do
    while IFS= read -r line; do
      no=${line%%:*}; rest=${line#*:}
      # コメント行は読まない（`# gh secret set --body-file` は実行されない）
      [[ $rest =~ ^[[:space:]]*# ]] && continue
      # `gh ` から後ろだけを見る。1 行に 1 回の呼び出しを仮定する（このリポジトリでは実測でそう）
      rest=${rest#*gh }
      # シェルの引用や変数は剥がさない。**長いフラグの綴りだけ**が要るので、それだけ拾う。
      read -r sub sub2 _ <<<"$rest"
      [[ $sub =~ ^[a-z][a-z-]*$ ]] || continue
      # 第 2 語がサブコマンドなら 2 語で引く（`secret set` / `pr view`）。フラグや引数なら 1 語（`api`）。
      if [[ $sub2 =~ ^[a-z][a-z-]*$ ]]; then sub="$sub $sub2"; fi
      for tok in $rest; do
        # `--flag=value` の形も綴りだけ取る。`--` 単独は終端なので飛ばす。
        tok=${tok%%=*}
        [[ $tok == --?* ]] || continue
        # 引用符やパイプがくっついた語は、綴りが確かでないので見ない（見誤って落とすより出さない側へ）
        [[ $tok =~ ^--[a-z][a-z0-9-]*$ ]] || continue
        printf '%s\t%s\t%s:%s\n' "$sub" "$tok" "$f" "$no"
      done
    done < <(grep -nE '(^|[^A-Za-z0-9_./-])gh [a-z]' "$f" || true)
  done < <(list_targets) | LC_ALL=C sort -u
}

# `gh <sub> --help` の FLAGS/INHERITED FLAGS に載っている長いフラグを出す。
#
# **サブコマンドが実在するかを USAGE 行で確かめる**——実測: `gh secret zzset --help` は
# **親の help を出して exit 0** で返る（`USAGE\n  gh secret <command>`）。
# 「exit 0 だったから実在する」と読むと、綴りを間違えたサブコマンドが全部素通りする。
help_flags() { # help_flags "<sub>" → 長いフラグを 1 行ずつ。実在しないサブコマンドなら exit 1
  local sub=$1 out
  # shellcheck disable=SC2086 # サブコマンドは [a-z-]+ に限っているので語分割してよい
  out=$(HOME=/nonexistent GH_CONFIG_DIR=/nonexistent GH_TOKEN='' GH_ENTERPRISE_TOKEN='' \
        "$GH_BIN" $sub --help 2>/dev/null) || return 1
  # USAGE が `gh <sub> ...` で始まっていなければ、それは親の help（＝そのサブコマンドは無い）
  grep -qE "^  gh $sub( |\$)" <<<"$out" || return 1
  grep -oE '(^|,| )--[a-z][a-z0-9-]*' <<<"$out" | tr -d ' ,' | LC_ALL=C sort -u
}

case "${1:-}" in
  --list) extract; exit 0 ;;
  "") ;;
  *) echo "usage: $0 [--list]" >&2; exit 2 ;;
esac

if ! command -v "$GH_BIN" >/dev/null 2>&1; then
  # **黙って緑にしない**（#757）。何を測らなかったかを名指しして終わる。
  echo "gh-flags.sh: gh が見つからないので**この検査は走っていません**（CI の ubuntu-latest には入っています）。" >&2
  exit 0
fi

FOUND=$(extract)
if [[ -z $FOUND ]]; then
  # **1 件も拾えなければ、検査が壊れている**——「食い違いゼロ」と見分けがつかないので落とす（#757 の母数）。
  echo "gh-flags.sh: gh の呼び出しを 1 件も拾えませんでした。抽出が壊れています（走査対象か正規表現を見てください）。" >&2
  exit 2
fi

HITS=0
LAST_SUB=""; LAST_FLAGS=""; LAST_OK=1
while IFS=$'\t' read -r sub flag where; do
  if [[ $sub != "$LAST_SUB" ]]; then
    LAST_SUB=$sub
    if LAST_FLAGS=$(help_flags "$sub"); then LAST_OK=1; else LAST_OK=0; LAST_FLAGS=""; fi
  fi
  if [[ $LAST_OK == 0 ]]; then
    echo "!! gh に存在しないサブコマンド: gh $sub  ($where)" >&2
    HITS=$((HITS+1)); continue
  fi
  grep -qxF -- "$flag" <<<"$LAST_FLAGS" || {
    echo "!! gh $sub に存在しないフラグ: $flag  ($where)" >&2
    echo "   gh $sub --help に載っている綴りだけを使ってください（#814: --body-file は secret set には無い）。" >&2
    HITS=$((HITS+1))
  }
done <<<"$FOUND"

n=$(wc -l <<<"$FOUND")
if [[ $HITS -gt 0 ]]; then
  echo "gh-flags.sh: $n 件の <サブコマンド,フラグ> を見て $HITS 件が gh の --help に無い" >&2
  exit 1
fi
echo "gh-flags.sh: ok — $n 件の <サブコマンド,フラグ> がすべて gh $("$GH_BIN" --version | sed -n '1s/gh version //p') の --help に載っている"
