#!/usr/bin/env bash
# shellcheck disable=SC2016  # **このファイルは単一引用符が要点。** 検査に食わせる「文字どおりの行」を
# 組み立てるので、`$BIN` や `$T` は**展開させてはいけない**（展開したら検査に別の文字列が渡る）。
# Tests for scripts/ci/gh-flags.sh (Issue #814)。
#
# **この検査自身をテストするときに、同じ罠を踏まないこと。**
# #814 の事故は「スタブと実装が同じ誤りを共有した」こと。だからここでは 2 種類のテストを書く:
#   (1) **偽の gh** で検査そのものの挙動を測る（フラグの照合・実在しないサブコマンド・gh 不在）
#   (2) **本物の gh** に `secret set --body-file` を食わせて、**#814 が実際に落ちること**を見る
#       ——(1) だけだと、偽 gh の help の書式についての私の思い込みを測っているだけになる。
#   bash scripts/ci/test/gh-flags.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
SCRIPT="$ROOT/scripts/ci/gh-flags.sh"
PASS=0; FAIL=0
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

fail() { echo "    x $1"; CURRENT_FAILED=1; }
assert_eq() { [[ "$2" == "$1" ]] || fail "$3: expected [$1] got [$2]"; }
assert_contains() { [[ "$1" == *"$2"* ]] || fail "$3: expected to contain [$2] in:
$1"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] || fail "$3: expected NOT to contain [$2] in:
$1"; }
test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}

# ---- 使い捨ての repo を作って、その中の scripts/ に検査したい行を置く ------------------------
# **この作業ツリーを書き換えない**（#814 の指示。他の担当者が同時に走っている）。
# gh-flags.sh は `git rev-parse --show-toplevel` から走るので、repo でなければならない。
mkrepo() { # mkrepo <行...> → $TMP/repo を作り、scripts/probe.sh にその行を書く
  rm -rf "$TMP/repo"
  mkdir -p "$TMP/repo/scripts" "$TMP/repo/deploy"
  git -C "$TMP/repo" init -q
  { echo '#!/usr/bin/env bash'; printf '%s\n' "$@"; } > "$TMP/repo/scripts/probe.sh"
}

run() { # run [env...] → OUT / STATUS（$TMP/repo の中で gh-flags.sh を走らせる）
  set +e
  OUT=$(cd "$TMP/repo" && env "$@" bash "$SCRIPT" 2>&1)
  STATUS=$?
  set -e
}

# ---- 偽の gh: 「どの help を返すか」をここに一次資料として書き写す --------------------------
# **本物の `gh secret set --help` から書き写した**（gh 2.89.0、2026-09-14 実測）。
# 実在しないサブコマンドを引かれたら、**本物と同じく親の help を exit 0 で返す**
# （実測: `gh secret zzset --help` は `USAGE\n  gh secret <command> [flags]` を出して 0 で返る）。
FAKE="$TMP/fakebin"; mkdir -p "$FAKE"
cat > "$FAKE/gh" <<'EOT'
#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then echo "gh version 0.0.0-fake"; exit 0; fi
sub="$1 ${2:-}"
case "$sub" in
  "secret set")
    cat <<'H'
USAGE
  gh secret set <secret-name> [flags]

FLAGS
  -a, --app string     Set the application for a secret
  -b, --body string    The value for the secret (reads from standard input if not specified)
      --no-store       Print the encrypted value instead of storing it

INHERITED FLAGS
      --help                     Show help for command
  -R, --repo [HOST/]OWNER/REPO   Select another repository
H
    ;;
  "issue create")
    cat <<'H'
USAGE
  gh issue create [flags]

FLAGS
  -b, --body string      Supply a body
  -F, --body-file file   Read body text from file
  -l, --label name       Add labels by name
  -t, --title string     Supply a title

INHERITED FLAGS
      --help                     Show help for command
  -R, --repo [HOST/]OWNER/REPO   Select another repository
H
    ;;
  *)
    # **実在しないサブコマンド**——本物と同じく親の help を出して 0 で返る。
    # **INHERITED FLAGS まで書き写すこと。** 最初はここを省いて `USAGE` と `AVAILABLE COMMANDS` だけに
    # していたが、それだと親 help から**フラグが 1 つも取れず**、USAGE の検査を外しても
    # `--repo` が「無いフラグ」として落ちてしまい、**テストが正しい理由で通っていなかった**
    # （変異 M3 が生き残って気づいた。実測: 本物の `gh secret zzset --help` は `--help` と `--repo` を出す）。
    printf 'USAGE\n  gh %s <command> [flags]\n\nAVAILABLE COMMANDS\n  list\n\nINHERITED FLAGS\n      --help                     Show help for command\n  -R, --repo [HOST/]OWNER/REPO   Select another repository\n' "$1"
    ;;
esac
exit 0
EOT
chmod +x "$FAKE/gh"

# ---- 1. 本丸: 存在しないフラグを見つける ----------------------------------------------------
t_unknown_flag_fails() {
  # **#814 の再現そのもの。** `--body-file` は `gh secret set` には無い。
  mkrepo 'printf %s "$T" | gh secret set MY_SECRET --repo o/r --body-file -'
  run "PATH=$FAKE:$PATH"
  assert_eq 1 "$STATUS" "存在しないフラグを見逃している: $OUT"
  assert_contains "$OUT" "gh secret set に存在しないフラグ: --body-file" "どこが違うかを名指しする"
  assert_contains "$OUT" "scripts/probe.sh:2" "ファイルと行を出す"
}
test_case "本丸: gh secret set --body-file（#814 の再現）は落ちる" t_unknown_flag_fails

# ---- 2. 誤検出: 実在するフラグを落とさない --------------------------------------------------
t_known_flags_pass() {
  mkrepo 'printf %s "$T" | gh secret set MY_SECRET --repo o/r' \
         'gh secret set OTHER --repo o/r --app actions --no-store'
  run "PATH=$FAKE:$PATH"
  assert_eq 0 "$STATUS" "実在するフラグで落ちている（誤検出）: $OUT"
}
test_case "誤検出なし: gh secret set の --repo/--app/--no-store は通る" t_known_flags_pass

# **サブコマンドごとに引いていることの証拠。** `--body-file` は
# `gh issue create` には**ある**が `gh secret set` には**無い**（どちらも本番で使っている綴り）。
# サブコマンドを見ない検査は、必ずどちらかを取り違える。
t_same_flag_differs_by_subcommand() {
  mkrepo 'gh issue create --title "$T" --label monitor --body-file "$BODY"'
  run "PATH=$FAKE:$PATH"
  assert_eq 0 "$STATUS" "issue create の --body-file を誤って落としている: $OUT"

  mkrepo 'gh secret set S --body-file -'
  run "PATH=$FAKE:$PATH"
  assert_eq 1 "$STATUS" "secret set の --body-file を見逃している: $OUT"
}
test_case "同じ綴りでもサブコマンドで可否が変わる（issue create は可 / secret set は不可）" t_same_flag_differs_by_subcommand

# ---- 3. gh が無い環境: 黙って緑にしない（#757） ---------------------------------------------
t_no_gh_says_so() {
  mkrepo 'gh secret set S --body-file -'   # **落ちるはずの行**を置いておく
  # **PATH を空にしない**（bash も git も消えて 127 になり、測りたいものが測れない）。
  # 名前だけ実在しない gh を指す——`command -v` が引けない状態はこれで再現できる。
  run "PATH=$PATH" "GH_FLAGS_GH=gh-does-not-exist-814"
  assert_eq 0 "$STATUS" "gh が無ければ通す（落とすと全 PR が赤になる）"
  assert_contains "$OUT" "この検査は走っていません" "**何を測らなかったかを言う**（黙って緑にしない）"
}
test_case "gh が無ければスキップする——だが黙らない（#757）" t_no_gh_says_so

# ---- 4. 抽出が 0 件なら「食い違いゼロ」と区別できないので落とす（#757 の母数） --------------
t_zero_extracted_fails() {
  mkrepo 'echo "この行に gh の呼び出しは無い"'
  run "PATH=$FAKE:$PATH"
  assert_eq 2 "$STATUS" "1 件も拾えないのに緑にしている: $OUT"
  assert_contains "$OUT" "1 件も拾えませんでした" "抽出が壊れたことを言う"
}
test_case "母数 0 は緑にしない（抽出が壊れたのか食い違いが無いのか区別できない）" t_zero_extracted_fails

# ---- 5. 実在しないサブコマンド（本物は親の help を exit 0 で返す） --------------------------
t_unknown_subcommand_fails() {
  mkrepo 'gh secret zzset MY --repo o/r'
  run "PATH=$FAKE:$PATH"
  assert_eq 1 "$STATUS" "実在しないサブコマンドを見逃している: $OUT"
  assert_contains "$OUT" "存在しないサブコマンド: gh secret zzset" "サブコマンドの誤りも名指しする"
}
test_case "実在しないサブコマンドは落ちる（exit 0 の親 help に騙されない）" t_unknown_subcommand_fails

# ---- 6. コメント行の綴りは見ない -------------------------------------------------------------
# **human-tasks.sh のコメントには `--body-file` が「これは無い」の説明として書いてある**（#786）。
# それを落とすと、事故の記録を消さないと緑にならなくなる。
t_comments_ignored() {
  mkrepo '# **`gh secret set --body-file -` と書いてはいけない——そんなフラグは無い**（#786）' \
         'printf %s "$T" | gh secret set S --repo o/r'
  run "PATH=$FAKE:$PATH"
  assert_eq 0 "$STATUS" "コメントの中の綴りで落ちている: $OUT"
}
test_case "コメントに書いた「誤りの記録」では落ちない" t_comments_ignored

# ---- 7. テストファイルの中のスタブ宛て文字列は見ない ----------------------------------------
# `scripts/ci/test/*.test.sh` の中の `gh secret set --body-file` は
# **スタブが弾くことを確かめる assert**であって、本物に渡る引数ではない。
t_test_files_skipped() {
  mkrepo 'printf %s "$T" | gh secret set S --repo o/r'
  mkdir -p "$TMP/repo/scripts/test"
  # **綴りが「抽出される形」で書いてあること。** 最初は
  # `assert_contains "$LOG" "gh secret set … --body-file"` と書いていたが、**末尾の `"` が付くので
  # `--body-file"` となり、そもそも抽出の対象外だった**——除外規則を無効にしてもこのテストは通り、
  # **何も測っていなかった**（変異 M8 が生き残って気づいた）。閉じ引用符を後ろの語に回して、
  # 除外規則だけが効いている状態にする。
  { echo '#!/usr/bin/env bash'; echo 'assert_contains "$LOG" "gh secret set BAD --body-file -" "スタブが弾く"'; } \
    > "$TMP/repo/scripts/test/x.test.sh"
  run "PATH=$FAKE:$PATH"
  assert_eq 0 "$STATUS" "テストの中の assert 文字列で落ちている: $OUT"
}
test_case "テストファイルは走査しない（スタブ宛ての assert で落ちない）" t_test_files_skipped

# ---- 8. **本物の gh** で #814 が落ちること -------------------------------------------------
# **偽 gh のテストだけでは、私が help の書式を勘違いしていたら全部空振りする**——#814 そのもの。
# ここだけは本物を使う。**`--help` しか呼ばないので、認証も網も副作用も要らない**（実測）。
t_real_gh_catches_814() {
  if ! command -v gh >/dev/null 2>&1; then echo "    - gh が無いので飛ばす（本物での確認はしていない）"; return 0; fi
  mkrepo 'printf %s "$T" | gh secret set MY --repo o/r --body-file -'
  run "PATH=$PATH"
  assert_eq 1 "$STATUS" "**本物の gh でも #814 を落とせていない**: $OUT"
  assert_contains "$OUT" "--body-file" "どのフラグかを言う"

  # **通る側も本物で見る**（#484）。`gh issue create --body-file` は deploy/monitor/report.sh が実際に使う。
  mkrepo 'gh issue create --title "$T" --label monitor --body-file "$BODY"'
  run "PATH=$PATH"
  assert_eq 0 "$STATUS" "**本物の gh で issue create --body-file を誤って落としている**: $OUT"
}
test_case "本物の gh: secret set --body-file は落ち、issue create --body-file は通る" t_real_gh_catches_814

# ---- 9. 今の作業ツリーが通ること -------------------------------------------------------------
t_repo_is_clean() {
  if ! command -v gh >/dev/null 2>&1; then echo "    - gh が無いので飛ばす"; return 0; fi
  set +e
  OUT=$(cd "$ROOT" && bash "$SCRIPT" 2>&1); STATUS=$?
  set -e
  assert_eq 0 "$STATUS" "この作業ツリーに gh の綴り違いがある: $OUT"
  assert_contains "$OUT" "件の <サブコマンド,フラグ>" "**何件見たかを出す**（0 件を緑と読み違えないため）"
}
test_case "この作業ツリーの gh 呼び出しは全部 --help に載っている" t_repo_is_clean

# ---- 10-13. スタブの二重定義（#799 が見つけた形）----------------------------------------------
DUPES="$ROOT/scripts/ci/stub-dupes.sh"
mkstub() { # mkstub <ファイル名> <行...>
  rm -rf "$TMP/repo"; mkdir -p "$TMP/repo/scripts/test"
  git -C "$TMP/repo" init -q
  local out="$TMP/repo/scripts/test/$1"; shift
  { echo '#!/usr/bin/env bash'; printf '%s\n' "$@"; } > "$out"
  git -C "$TMP/repo" add -A
}
rund() { set +e; OUT=$(cd "$TMP/repo" && bash "$DUPES" 2>&1); STATUS=$?; set -e; }

t_dupe_stub_fails() {
  # **#799 の再現**: 同じファイルに `gh` のスタブがトップレベルで 2 回。後勝ちで片方が消える。
  mkstub a.test.sh 'BIN=$TMP/bin' \
    'cat > "$BIN/gh" <<'"'"'EOT'"'"'' 'echo one' 'EOT' \
    'cat > "$BIN/gh" <<'"'"'EOT'"'"'' 'echo two' 'EOT'
  rund
  assert_eq 1 "$STATUS" "二重定義を見逃している: $OUT"
  assert_contains "$OUT" "'gh' のスタブがトップレベルで 2 回以上" "何が重複しているか言う"
  assert_contains "$OUT" "scripts/test/a.test.sh" "ファイルを名指しする"
}
test_case "本丸2: 同じファイルで gh スタブが 2 回定義されていたら落ちる（#799 の形）" t_dupe_stub_fails

t_distinct_commands_pass() {
  mkstub a.test.sh 'cat > "$BIN/gh" <<'"'"'EOT'"'"'' 'EOT' 'cat > "$BIN/ssh" <<'"'"'EOT'"'"'' 'EOT'
  rund
  assert_eq 0 "$STATUS" "別々のコマンドを重複と言っている（誤検出）: $OUT"
}
test_case "誤検出なし: gh と ssh は別のコマンド" t_distinct_commands_pass

t_indented_rebind_passes() {
  # **関数の中での置き直しは重複ではない**。human-tasks.test.sh の `restore_curl_stub` がこの形
  # （実測: curl のスタブは 3 か所にあるが、**3 つとも字下げされている**）。
  mkstub a.test.sh 'cat > "$BIN/curl" <<'"'"'EOT'"'"'' 'EOT' \
    'restore_curl_stub() {' '  cat > "$BIN/curl" <<'"'"'EOT'"'"'' 'EOT' '}'
  rund
  assert_eq 0 "$STATUS" "関数の中での置き直しを重複と言っている（誤検出）: $OUT"
}
test_case "誤検出なし: 関数の中での置き直し（restore_curl_stub の形）は通る" t_indented_rebind_passes

t_dupes_zero_fails() {
  rm -rf "$TMP/repo"; mkdir -p "$TMP/repo/scripts"; git -C "$TMP/repo" init -q
  echo '#!/usr/bin/env bash' > "$TMP/repo/scripts/x.sh"; git -C "$TMP/repo" add -A
  rund
  assert_eq 2 "$STATUS" "1 件も拾えないのに緑にしている: $OUT"
  assert_contains "$OUT" "1 件も拾えませんでした" "抽出が壊れたことを言う"
}
test_case "母数 0 は緑にしない（stub-dupes も同じ）" t_dupes_zero_fails

t_dupes_repo_clean() {
  set +e; OUT=$(cd "$ROOT" && bash "$DUPES" 2>&1); STATUS=$?; set -e
  assert_eq 0 "$STATUS" "この作業ツリーにスタブの二重定義がある: $OUT"
  assert_contains "$OUT" "件のトップレベルのスタブ定義" "**何件見たかを出す**"
}
test_case "この作業ツリーにスタブの二重定義は無い" t_dupes_repo_clean

# ---- 14. CI が実際にこの 2 本を走らせているか --------------------------------------------------
# **走らないテストは落ちない**（#533 と同じ根）。ci.yml からこの step を消しても、
# ここが無ければどこも赤くならない。**ci.yml 自身は、どのテストファイルからも消せない。**
t_ci_runs_the_checks() {
  local ci="$ROOT/.github/workflows/ci.yml"
  assert_contains "$(cat "$ci")" "bash scripts/ci/gh-flags.sh" "ci.yml が gh-flags.sh を走らせていない"
  assert_contains "$(cat "$ci")" "bash scripts/ci/stub-dupes.sh" "ci.yml が stub-dupes.sh を走らせていない"
}
test_case "ci.yml がこの 2 本を走らせている（step を消したら落ちる）" t_ci_runs_the_checks

echo
echo "$PASS passed, $FAIL failed"
[[ $FAIL == 0 ]]
