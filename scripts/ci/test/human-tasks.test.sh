#!/usr/bin/env bash
# Tests for scripts/human-tasks.sh（#537 が片付いた後に残る「人間にしか打てないコマンド」を 1 本にまとめたもの）。
#
# **このスクリプトは本番に ssh して、stash を消す。** だからテストでは
# **`ssh` / `git` / `curl` をスタブして、実際には何もさせない**（PATH の先頭に偽物を置く）。
# 「呼ばれたこと」は記録したログで確かめる。
#   bash scripts/ci/test/human-tasks.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../../human-tasks.sh"
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

# ---- スタブ: ssh / git / curl を記録するだけの偽物に差し替える -------------------------------
BIN="$TMP/bin"; mkdir -p "$BIN"
cat > "$BIN/ssh" <<'EOT'
#!/usr/bin/env bash
printf 'ssh %s\n' "$*" >> "$STUB_LOG"
[[ "${STUB_SSH_FAIL:-0}" = 1 ]] && exit 255
exit 0
EOT
# **curl のスタブは書き換えるテストがあるので、既定に戻せる形にしておく**
# （書き換えたまま次のテストに漏らすと、そのテストは何を測ったのか分からなくなる）。
restore_curl_stub() {
  cat > "$BIN/curl" <<'EOT'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$STUB_LOG"
# 反映後の期待値を返す（成功の経路を通す）。**#746 以後は 3 つの綴りとも 404 にする。**
case "$*" in
  *"__not-found"*) echo 404 ;;
  *"/compare"*)    echo 200 ;;
  *no-such-page*)  if [[ "$*" == *"%{http_code}"* ]]; then echo 404; else echo "ページが見つかりません"; fi ;;
  *) echo 200 ;;
esac
EOT
  chmod +x "$BIN/curl"
}
restore_curl_stub
# **`getent` をスタブして「名前解決で引けた」経路を作る。**
# **テストに IP リテラルを書かない**（scripts/ci/forbidden-patterns.sh の ip-address 規則。
# RFC 5737 の文書用アドレスでも規則は区別しないし、区別させると本物を通す穴になる）。
cat > "$BIN/getent" <<'EOT'
#!/usr/bin/env bash
printf 'getent %s\n' "$*" >> "$STUB_LOG"
[[ "${STUB_NO_DNS:-0}" = 1 ]] && exit 2
# 出す値は「引けたこと」が分かればよい。ここでは TEST-NET でない予約外の値を組み立てる
printf '%s giinrecord.jp\n' "$(printf '10.%s.%s.%s' 0 0 1)"
EOT
# **`gh` をスタブする。** 本物を呼ぶと**本当に secret が置かれ、ワークフローが起動する。**
# **トークンの値はログに書かない**——長さだけを記録して「標準入力から受け取ったか」を見る
# （フィクスチャにトークンらしき文字列を残さないため。#790 の「やらないこと」）。
cat > "$BIN/gh" <<'EOT'
#!/usr/bin/env bash
printf 'gh %s\n' "$*" >> "$STUB_LOG"
case "$1 $2" in
  "secret set")
    # **標準入力で来たか**を測る。パイプでなければ（端末/クローズ）0 バイトになる
    body=$(cat 2>/dev/null || true)
    printf 'gh-stdin-bytes %s\n' "${#body}" >> "$STUB_LOG"
    [[ "${STUB_GH_SECRET_FAIL:-0}" = 1 ]] && { echo "gh: secret set failed" >&2; exit 1; }
    ;;
  "workflow run")
    [[ "${STUB_GH_RUN_FAIL:-0}" = 1 ]] && { echo "gh: workflow run failed" >&2; exit 1; }
    ;;
  "run list")
    echo "${STUB_GH_RUN_ID:-4242}"
    ;;
  "run watch"|"run view")
    if [[ "${STUB_GH_CONCLUSION:-success}" != success ]]; then
      echo "${STUB_GH_CONCLUSION:-success}"; exit 1
    fi
    echo success
    ;;
esac
exit 0
EOT
chmod +x "$BIN"/*

run() {  # run [args...] → OUT / STATUS
  : > "$TMP/log"
  set +e
  OUT=$(PATH="$BIN:$PATH" STUB_LOG="$TMP/log" HOME="$TMP/fakehome" "$@" 2>&1)
  STATUS=$?
  set -e
  LOG=$(cat "$TMP/log")
}
mkdir -p "$TMP/fakehome"   # ~/.ssh/config が無い端末を再現する

# ---- tests ---------------------------------------------------------------------------------

t_dry_run_does_nothing() {
  run bash "$SCRIPT"
  assert_eq 0 "$STATUS" "dry-run は成功で終わる: $OUT"
  assert_not_contains "$LOG" "ssh " "**dry-run では ssh を実行しない**"
  assert_contains "$OUT" "[dry-run]" "何をするかは出す"
  assert_contains "$OUT" "--yes" "実行の方法を案内する"
}
test_case "human-tasks: dry-run は何も実行しない" t_dry_run_does_nothing

t_falls_back_to_dns() {
  # **人間に IP を用意させない**——`--host` を渡さなくても、名前解決で引く。
  run bash "$SCRIPT" --yes
  assert_contains "$LOG" "getent ahostsv4 giinrecord.jp" "**IP を自分で引く**"
  assert_contains "$LOG" "ssh " "引けたら ssh を呼ぶ"
}
test_case "human-tasks: IP は自分で引く（人間に用意させない）" t_falls_back_to_dns

t_names_the_key() {
  # **`Host giinops` が無い端末では、どの鍵を出すかが決まらず Permission denied になる**
  # （docs/ops/deploy.md。**鍵は ubuntu と同じもので、ユーザー名だけが違う**）。
  # **人間に鍵の場所を用意させない**ので、スクリプトが明示する。
  mkdir -p "$TMP/fakehome/.ssh/sakura-vps"
  : > "$TMP/fakehome/.ssh/sakura-vps/id_ed25519"
  run bash "$SCRIPT" --yes
  assert_contains "$LOG" "IdentitiesOnly=yes" "**どの鍵を出すかを明示する**"
  assert_contains "$LOG" "sakura-vps/id_ed25519" "鍵の場所を明示する"
  rm -rf "$TMP/fakehome/.ssh"
}
test_case "human-tasks: 鍵を明示する（Host giinops が無い端末でも通る）" t_names_the_key

t_fails_when_dns_fails() {
  # **名前解決にも失敗したときだけ**、人間に渡し方を案内して止まる。
  run env STUB_NO_DNS=1 bash "$SCRIPT" --yes
  assert_eq 1 "$STATUS" "接続先が分からなければ失敗で終わる"
  assert_not_contains "$LOG" "ssh " "**接続先が分からないまま ssh を呼ばない**"
  assert_contains "$OUT" "--host" "渡し方を案内する"
}
test_case "human-tasks: 名前解決にも失敗したら ssh を呼ばない" t_fails_when_dns_fails


t_deploy_forces_recreate() {
  run bash "$SCRIPT" --yes
  assert_contains "$LOG" "getent ahostsv4 giinrecord.jp" "**IP を自分で引く（人間に用意させない）**"
  assert_contains "$LOG" "ssh " "ssh を呼ぶ"
  # **--force-recreate が要る**: site.conf は bind mount した単一ファイルなので、
  # git pull では inode が変わるだけでコンテナは古いものを掴んだまま（docs/ops/deploy.md）
  assert_contains "$LOG" "--force-recreate" "**--force-recreate を付ける（これが無いと反映されない）**"
  assert_contains "$LOG" "git -C /opt/giinrecord pull" "先に pull する"
  assert_contains "$LOG" "sudo -n" "NOPASSWD の 2 コマンドだけを使う"
}
test_case "human-tasks: 反映は pull + force-recreate をこの順で打つ" t_deploy_forces_recreate

t_verifies_everything() {
  run bash "$SCRIPT" --yes
  assert_eq 0 "$STATUS" "全部期待どおりなら成功: $OUT"
  # /compare が壊れていないことまで見て、はじめて成功と言える
  assert_contains "$LOG" "no-such-page-12345" "404 の本文を見る"
  assert_contains "$LOG" "/compare" "**/compare が壊れていないことを見る**"
  # **#746: 綴りを 3 つとも見る。** index.html だけを見ていたせいで、
  # 2026-09-13 にこのスクリプトは「4 つとも期待どおり」と報告したのに /__not-found は 200 だった。
  # **URL は行末に来るので、部分一致だと `/__not-found` が `/__not-found/index.html` にも当たってしまう。**
  # **行ごと完全一致で数える**（そうしないと「3 つとも見た」の検算が空回りする）。
  for want in /__not-found /__not-found/ /__not-found/index.html; do
    n=$(printf '%s\n' "$LOG" | grep -c "https://giinrecord.jp${want}\$" || true)
    assert_eq 1 "$n" "**#746: $want をちょうど 1 回叩く**"
  done
  assert_contains "$OUT" "期待どおりです" "全部通ったと言う"
  assert_contains "$OUT" "browser-check" "より強い確認も案内する"
}
test_case "human-tasks: 反映後に /compare と not-found の 3 つの綴りを確認する（#746）" t_verifies_everything

# **#746 の否定的対照。** 2026-09-13 に本番で実際に起きた状態をそのまま作る:
# **`/__not-found/index.html` は 404 なのに、`/__not-found` と `/__not-found/` は 200。**
# 当時のスクリプトはこの状態で「4 つとも期待どおり」と報告した。**そう言わないことを固定する。**
t_fails_when_only_index_is_fixed() {
  cat > "$BIN/curl" <<'EOT'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$STUB_LOG"
case "$*" in
  *"__not-found/index.html"*) echo 404 ;;   # ← スクリプトが唯一見ていた URL。ここだけ直っていた
  *"__not-found"*)            echo 200 ;;   # ← 末尾なし・スラッシュ付きは 200 のままだった
  *"/compare"*)               echo 200 ;;
  *no-such-page*)  if [[ "$*" == *"%{http_code}"* ]]; then echo 404; else echo "ページが見つかりません"; fi ;;
  *) echo 200 ;;
esac
EOT
  chmod +x "$BIN/curl"
  run bash "$SCRIPT" --yes
  assert_eq 1 "$STATUS" "**index.html だけ 404 でも成功と言わない（#746 で誤報告した状態）**"
  assert_not_contains "$OUT" "期待どおりです" "「期待どおり」と言ってはいけない"
  assert_contains "$OUT" "期待と違う項目があります" "どこを見ればよいか言う"
  restore_curl_stub
}
test_case "human-tasks: /__not-found/index.html だけ 404 では成功と言わない（#746 の誤報告）" t_fails_when_only_index_is_fixed

t_fails_when_compare_breaks() {
  # **/compare が 404 を返す状況**（反映で壊れた）を作る
  cat > "$BIN/curl" <<'EOT'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$STUB_LOG"
case "$*" in
  *"/compare"*)    echo 404 ;;
  *"__not-found"*) echo 404 ;;   # #746: 綴り 3 つとも直っている = 落ちる理由は /compare だけ
  *no-such-page*)  if [[ "$*" == *"%{http_code}"* ]]; then echo 404; else echo "ページが見つかりません"; fi ;;
  *) echo 200 ;;
esac
EOT
  chmod +x "$BIN/curl"
  run bash "$SCRIPT" --yes
  assert_eq 1 "$STATUS" "**/compare が壊れたら失敗で終わる**"
  assert_contains "$OUT" "期待と違う項目があります" "どこを見ればよいか言う"
  restore_curl_stub
}
test_case "human-tasks: /compare が壊れたら成功と言わない" t_fails_when_compare_breaks



t_usage() {
  run bash "$SCRIPT" --oops
  assert_eq 2 "$STATUS" "知らない引数は usage"
  assert_eq "" "$LOG" "**ssh も git も curl も一度も呼ばない**"
}
test_case "human-tasks: 知らない引数では何もしない" t_usage

# ---- #790: BRANCH_PROTECTION_TOKEN の設置 -----------------------------------------------------
# **`Branch protection` ワークフローが 6 日連続で failure だった。** 設計は正しく、
# `GITHUB_TOKEN` では保護設定を読めないので exit 2（読めない）を報告し続けていた（#540 / #547）。
# **人間に残るのは PAT を作って貼ることだけ**にする。**#550 は `BRANCH_PROTECTION_TOKEN`、
# #155 は VPS 監視用の別物**（`/etc/gikailog/monitor.token`）。取り違えないことを固定する。
TOKEN_FIXTURE_PREFIX="github_"   # **本物らしい文字列をフィクスチャに置かない**（#790）
FAKE_TOKEN="${TOKEN_FIXTURE_PREFIX}not-a-real-token-0000"

t_pat_dry_run_reads_aloud() {
  # **deploy.md を開かせない**: 必要な設定をスクリプトが読み上げる。
  run bash "$SCRIPT"
  assert_eq 0 "$STATUS" "dry-run は成功で終わる: $OUT"
  assert_contains "$OUT" "BRANCH_PROTECTION_TOKEN" "**置く secret の名前を言う**"
  assert_contains "$OUT" "uonoko1/giinrecord" "Repository access を言う"
  assert_contains "$OUT" "Administration" "Administration: Read-only を言う"
  assert_contains "$OUT" "Read-only" "Read-only であることを言う"
  assert_contains "$OUT" "Issues" "Issues: Read and write を言う"
  assert_contains "$OUT" "有効期限" "期限を決めさせる"
  assert_contains "$OUT" "docs/ops/board.md" "**期限を控える場所を案内する**"
}
test_case "human-tasks: PAT に必要な設定を読み上げる（deploy.md を開かせない）" t_pat_dry_run_reads_aloud

t_pat_dry_run_does_not_set() {
  # **既定は読むだけ。** `--yes` が無ければ gh を一度も呼ばない。
  run env BRANCH_PROTECTION_TOKEN="$FAKE_TOKEN" bash "$SCRIPT"
  assert_eq 0 "$STATUS" "dry-run は成功で終わる: $OUT"
  assert_not_contains "$LOG" "gh secret set" "**--yes が無ければ secret を置かない**"
  assert_not_contains "$LOG" "gh workflow run" "**--yes が無ければワークフローも起動しない**"
}
test_case "human-tasks: --yes が無ければ secret を置かない" t_pat_dry_run_does_not_set

t_pat_rejects_argv() {
  # **トークンを引数で受け取らない**（`sudo` と同じ理由。シェル履歴とプロセス一覧に残る）。
  # **`--token` という綴りが usage で弾かれることを固定する。**
  run bash "$SCRIPT" --token "$FAKE_TOKEN"
  assert_eq 2 "$STATUS" "**引数でトークンを渡せてはいけない**: $OUT"
  assert_not_contains "$LOG" "gh secret set" "**引数から secret を置かない**"
  assert_not_contains "$OUT" "$FAKE_TOKEN" "**弾くときもトークンを出さない**"
  # 受け取り口は標準入力か環境変数だけ、と usage で言う
  assert_contains "$OUT" "usage" "usage を出す"
}
test_case "human-tasks: トークンを引数で渡せない（履歴とプロセス一覧に残る）" t_pat_rejects_argv

t_pat_sets_from_env() {
  run env BRANCH_PROTECTION_TOKEN="$FAKE_TOKEN" bash "$SCRIPT" --yes
  assert_eq 0 "$STATUS" "置けたら成功: $OUT"
  assert_contains "$LOG" "gh secret set BRANCH_PROTECTION_TOKEN" "**その名前で置く**"
  # **値は標準入力で渡す**（引数に載せない）。スタブは受け取ったバイト数だけ記録する
  assert_contains "$LOG" "gh-stdin-bytes ${#FAKE_TOKEN}" "**標準入力でトークンを渡す**"
  assert_not_contains "$LOG" "$FAKE_TOKEN" "**トークンを引数に載せない**"
  assert_not_contains "$OUT" "$FAKE_TOKEN" "**トークンをログに出さない**"
}
test_case "human-tasks: 環境変数のトークンを標準入力で渡して置く" t_pat_sets_from_env

t_pat_sets_from_stdin() {
  # **貼るだけで済む**: 標準入力から受け取る。
  set +e
  OUT=$(printf '%s\n' "$FAKE_TOKEN" | PATH="$BIN:$PATH" STUB_LOG="$TMP/log" HOME="$TMP/fakehome" \
    bash "$SCRIPT" --yes --set-token 2>&1)
  STATUS=$?
  set -e
  LOG=$(cat "$TMP/log")
  assert_eq 0 "$STATUS" "標準入力からでも置ける: $OUT"
  assert_contains "$LOG" "gh secret set BRANCH_PROTECTION_TOKEN" "その名前で置く"
  assert_contains "$LOG" "gh-stdin-bytes ${#FAKE_TOKEN}" "**標準入力の中身がそのまま渡る（改行は落とす）**"
  assert_not_contains "$OUT" "$FAKE_TOKEN" "**トークンをログに出さない**"
  : > "$TMP/log"
}
test_case "human-tasks: 標準入力に貼ったトークンを置く" t_pat_sets_from_stdin

t_pat_not_the_vps_token() {
  # **#155 は VPS 監視用の別の secret。** 取り違えていないことを固定する。
  run env BRANCH_PROTECTION_TOKEN="$FAKE_TOKEN" bash "$SCRIPT" --yes
  assert_not_contains "$LOG" "monitor.token" "**#155（VPS 監視用）の置き場ではない**"
  n=$(printf '%s\n' "$LOG" | grep -c 'gh secret set BRANCH_PROTECTION_TOKEN' || true)
  assert_eq 1 "$n" "**置く secret はちょうど 1 つ**"
  n=$(printf '%s\n' "$LOG" | grep -c 'gh secret set ' || true)
  assert_eq 1 "$n" "**他の secret を置かない**"
}
test_case "human-tasks: 置くのは BRANCH_PROTECTION_TOKEN だけ（#155 と取り違えない）" t_pat_not_the_vps_token

t_pat_runs_workflow_and_shows_result() {
  # **置いたら結果まで見せる**（#790: 赤い期間が終わったことを人間が確かめられるように）。
  run env BRANCH_PROTECTION_TOKEN="$FAKE_TOKEN" bash "$SCRIPT" --yes
  assert_contains "$LOG" "gh workflow run branch-protection.yml" "**ワークフローを起動する**"
  assert_contains "$LOG" "gh run watch" "**終わるまで見る**"
  assert_contains "$OUT" "保護されている" "**結果を読み上げる**"
}
test_case "human-tasks: 置いたあとワークフローを起動して結果まで見せる" t_pat_runs_workflow_and_shows_result

t_pat_fails_when_workflow_red() {
  # **赤いまま「できました」と言わない**（#746 と同じ誤報告をしない）。
  run env BRANCH_PROTECTION_TOKEN="$FAKE_TOKEN" STUB_GH_CONCLUSION=failure bash "$SCRIPT" --yes
  assert_eq 1 "$STATUS" "**ワークフローが赤ければ失敗で終わる**: $OUT"
  assert_not_contains "$OUT" "保護されている" "赤いのに「保護されている」と言わない"
}
test_case "human-tasks: ワークフローが赤ければ成功と言わない" t_pat_fails_when_workflow_red

t_pat_fails_when_secret_set_fails() {
  run env BRANCH_PROTECTION_TOKEN="$FAKE_TOKEN" STUB_GH_SECRET_FAIL=1 bash "$SCRIPT" --yes
  assert_eq 1 "$STATUS" "**置けなければ失敗で終わる**: $OUT"
  assert_not_contains "$LOG" "gh workflow run" "**置けていないのに起動しない**"
}
test_case "human-tasks: secret を置けなければワークフローを起動しない" t_pat_fails_when_secret_set_fails

t_pat_skipped_without_token() {
  # **トークンが無いときは、site.conf の反映を止めない**（#654 の本番反映が先にある）。
  run bash "$SCRIPT" --yes
  assert_eq 0 "$STATUS" "トークンが無くても site.conf の反映は通る: $OUT"
  assert_not_contains "$LOG" "gh secret set" "**トークンが無ければ置かない**"
  assert_contains "$OUT" "BRANCH_PROTECTION_TOKEN" "作り方は読み上げる"
}
test_case "human-tasks: トークンが無くても site.conf の反映は止まらない" t_pat_skipped_without_token

t_no_set_x() {
  # **`set -x` を使わない**（トークンが展開されて出る。#790 の「やらないこと」）。
  n=$(grep -c -E '^[[:space:]]*set[[:space:]]+-[a-z]*x' "$SCRIPT" || true)
  assert_eq 0 "$n" "**set -x を書かない（トークンが展開されて出る）**"
  # **トークンを持つ変数を `echo` / `log` の引数に載せない。**
  # `${#BP_TOKEN}`（長さ）は値ではないので許す。**`printf '%s' "$BP_TOKEN" | gh secret set …`
  # だけが例外**（引数ではなく標準入力に流すための形）で、`gh secret set` が続くことで見分ける。
  # shellcheck disable=SC2016  # '${#' は**展開させたくない文字列そのもの**（長さ取得の綴り）。-F で固定文字列として渡す
  n=$(grep -vE '^[[:space:]]*#' "$SCRIPT" | grep -n -E '(echo|log)[^#]*\$\{?[A-Za-z_]*TOKEN' | grep -cvF '${#' || true)
  assert_eq 0 "$n" "**トークンを echo / log に渡さない**"
  n=$(grep -vE '^[[:space:]]*#' "$SCRIPT" | grep -n -E 'printf[^#]*\$\{?[A-Za-z_]*TOKEN' | grep -cv 'gh secret set' || true)
  assert_eq 0 "$n" "**printf に渡してよいのは gh の標準入力に流すときだけ**"
}
test_case "human-tasks: トークンがログに出る書き方をしていない" t_no_set_x

echo
echo "$PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
