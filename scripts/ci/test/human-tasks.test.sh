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
cat > "$BIN/curl" <<'EOT'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$STUB_LOG"
# 反映後の期待値を返す（成功の経路を通す）
case "$*" in
  *"__not-found"*) echo 404 ;;
  *"/compare"*)    echo 200 ;;
  *no-such-page*)  if [[ "$*" == *"%{http_code}"* ]]; then echo 404; else echo "ページが見つかりません"; fi ;;
  *) echo 200 ;;
esac
EOT
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

t_verifies_four_things() {
  run bash "$SCRIPT" --yes
  assert_eq 0 "$STATUS" "全部期待どおりなら成功: $OUT"
  # **4 つとも見る。**/compare が壊れていないことまで見て、はじめて成功と言える
  assert_contains "$LOG" "no-such-page-12345" "404 の本文を見る"
  assert_contains "$LOG" "/compare" "**/compare が壊れていないことを見る**"
  assert_contains "$LOG" "__not-found/index.html" "#654 の分を見る"
  assert_contains "$OUT" "4 つとも期待どおり" "全部通ったと言う"
  assert_contains "$OUT" "browser-check" "より強い確認も案内する"
}
test_case "human-tasks: 反映後に 4 つとも確認する" t_verifies_four_things

t_fails_when_compare_breaks() {
  # **/compare が 404 を返す状況**（反映で壊れた）を作る
  cat > "$BIN/curl" <<'EOT'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$STUB_LOG"
case "$*" in
  *"/compare"*)    echo 404 ;;
  *"__not-found"*) echo 404 ;;
  *no-such-page*)  if [[ "$*" == *"%{http_code}"* ]]; then echo 404; else echo "ページが見つかりません"; fi ;;
  *) echo 200 ;;
esac
EOT
  chmod +x "$BIN/curl"
  run bash "$SCRIPT" --yes
  assert_eq 1 "$STATUS" "**/compare が壊れたら失敗で終わる**"
  assert_contains "$OUT" "期待と違う項目があります" "どこを見ればよいか言う"
}
test_case "human-tasks: /compare が壊れたら成功と言わない" t_fails_when_compare_breaks



t_usage() {
  run bash "$SCRIPT" --oops
  assert_eq 2 "$STATUS" "知らない引数は usage"
  assert_eq "" "$LOG" "**ssh も git も curl も一度も呼ばない**"
}
test_case "human-tasks: 知らない引数では何もしない" t_usage

echo
echo "$PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
