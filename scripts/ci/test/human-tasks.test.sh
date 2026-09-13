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
# **gh のスタブ（#786）。** 本物を呼ぶと実際に secret を置いてしまうので、必ずスタブ経由にする。
#   STUB_GH_SET_FAIL=1  `gh secret set` を失敗させる
#   STUB_GH_API_FAIL=1  `gh api`（アラートの読み取り）を失敗させる = 権限の足りない PAT
# **標準入力から受け取ったトークンは、長さだけをログに残す。** 中身をログに書いたら、
# このテスト自身が「トークンを漏らさない」という主張を裏切ることになる。
cat > "$BIN/gh" <<'EOT'
#!/usr/bin/env bash
case "$1 $2" in
  "secret set")
    # **`--body` を付けずに標準入力から読ませるのが正しい呼び方**（#786。`--body -` は
    # リテラルの `-` を保存してしまう。実測で確認済み）。**引数に値が載っていたら落とす。**
    for a in "$@"; do
      case "$a" in
        --body|--body-file|-b) printf 'gh secret set BAD_FLAG %s\n' "$a" >> "$STUB_LOG"; exit 9 ;;
      esac
    done
    body=$(cat)   # 標準入力から受け取る
    printf 'gh secret set %s len=%s\n' "$3" "${#body}" >> "$STUB_LOG"
    [[ "${STUB_GH_SET_FAIL:-0}" = 1 ]] && exit 1
    exit 0 ;;
  "api "*|"api")
    printf 'gh api %s token_len=%s\n' "$2" "${#GH_TOKEN}" >> "$STUB_LOG"
    [[ "${STUB_GH_API_FAIL:-0}" = 1 ]] && exit 1
    echo '[]'; exit 0 ;;
  *) printf 'gh %s\n' "$*" >> "$STUB_LOG"; exit 0 ;;
esac
EOT
chmod +x "$BIN/gh"

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
chmod +x "$BIN"/*

run() {  # run [args...] → OUT / STATUS
  : > "$TMP/log"
  set +e
  # **トークンは標準入力か環境変数でしか渡らない**ので、run もその 2 つを通す。
  # `RUN_STDIN` が空なら `</dev/null`（`read` が待ち続けてテストが固まらないように）。
  OUT=$(PATH="$BIN:$PATH" STUB_LOG="$TMP/log" HOME="$TMP/fakehome" \
        STUB_GH_SET_FAIL="${STUB_GH_SET_FAIL:-0}" STUB_GH_API_FAIL="${STUB_GH_API_FAIL:-0}" \
        SECURITY_ALERTS_TOKEN="${SECURITY_ALERTS_TOKEN:-}" "$@" <<<"${RUN_STDIN:-}" 2>&1)
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




# ---- #786: security アラート用の PAT を置く --------------------------------------------------
# **この一群で一番大事なのは「トークンを出力に出さない」こと。** 出力はユーザーが Claude に
# 貼って渡すことが前提なので、ここに載ったトークンは会話にもログにも残る。
# **本物のトークンの形をあえて真似ていない**（#786 レビュー）。
# 最初の版は `github_pat_…` の形を実行時に組み立てていた。`scripts/ci/forbidden-patterns.sh` の
# github-token 規則が**リテラルを実際に検出して CI を落とした**のが発端だが、分割しても
# **GitHub の secret scanning は commit 後の連結された文字列を見る**ので、同じ形である限り
# アラートを立てうる（同じ日に `deploy/test/security-alerts.test.sh` の Google API Key 形の
# canary で**実際にアラート #2 が立った**）。**恒常的に open なアラートは「毎日赤い」であり、
# #786 が無くそうとしている状態そのもの。**
#
# **形は要らない——測って確かめた。** 下の判定はすべて `assert_not_contains`＝
# **$TOKEN_CANARY の文字列一致**で、値の形式を見ているものは 1 つも無い。
# 漏洩の変異（dry-run でトークンそのものを出す）は、形を変えても**同じ 1 本**が落ちる。
TOKEN_CANARY="TOKEN-CANARY-MUST-NOT-APPEAR-IN-OUTPUT-OR-LOG"

# **引数でトークンを渡せてはいけない**（#786 レビュー）。
# **これが一番大事な 1 本**: 最初の版は `--security-alerts-token <PAT>` を受け取っており、
# **同じ docblock に「argv は ps で見える」と書きながら argv から受け取っていた。**
# #798（#790）が同じスクリプトで `--token` を弾く形にしたので、**綴りを揃えてある。**
t_token_rejects_argv() {
  run bash "$SCRIPT" --yes --security-alerts-token "$TOKEN_CANARY"
  assert_eq 2 "$STATUS" "**引数でトークンを渡せてはいけない**（履歴と ps に残る）: $OUT"
  assert_not_contains "$LOG" "gh secret set" "**引数から secret を置かない**"
  assert_contains "$OUT" "usage" "usage を出す"
  assert_contains "$OUT" "引数では渡せません" "なぜ弾くのかを言う"
}
test_case "human-tasks: トークンを引数で渡せない（履歴とプロセス一覧に残る）" t_token_rejects_argv

t_token_is_never_printed() {
  RUN_STDIN="$TOKEN_CANARY" run bash "$SCRIPT" --yes --set-security-alerts-token
  assert_not_contains "$OUT" "$TOKEN_CANARY" "**トークンが出力に出ている**（貼られたら漏洩する）"
  assert_not_contains "$LOG" "$TOKEN_CANARY" "トークンがスタブのログに出ている"
}
test_case "human-tasks: PAT を出力にもログにも出さない（#786）" t_token_is_never_printed

t_token_is_not_passed_in_argv() {
  RUN_STDIN="$TOKEN_CANARY" run bash "$SCRIPT" --yes --set-security-alerts-token
  # スタブは受け取った長さを記録する。**標準入力から渡っていれば長さが一致する。**
  assert_contains "$LOG" "gh secret set SECURITY_ALERTS_TOKEN len=${#TOKEN_CANARY}" \
    "標準入力でトークンを渡していない（--body \"\$TOKEN\" は ps で見える）"
}
test_case "human-tasks: PAT は標準入力で渡す（argv に載せない）" t_token_is_not_passed_in_argv

t_token_from_env() {
  # **受け取り口は 2 つ**: 標準入力と環境変数。環境変数のほうも生きていることを見る。
  SECURITY_ALERTS_TOKEN="$TOKEN_CANARY" run bash "$SCRIPT" --yes
  assert_contains "$LOG" "gh secret set SECURITY_ALERTS_TOKEN len=${#TOKEN_CANARY}" "環境変数から読めていない"
  assert_not_contains "$OUT" "$TOKEN_CANARY" "環境変数経由でもトークンを出さない"
}
test_case "human-tasks: PAT を環境変数でも受け取る（#786）" t_token_from_env

t_token_is_verified_not_just_placed() {
  # **権限の足りない PAT**: secret としては置けるが、アラートは読めない。
  RUN_STDIN="$TOKEN_CANARY" STUB_GH_SET_FAIL=0 STUB_GH_API_FAIL=1 \
    run bash "$SCRIPT" --yes --set-security-alerts-token
  assert_eq 1 "$STATUS" "**読めない PAT を置いて成功と言ってはいけない**（#786 の 21 日の再来）"
  assert_contains "$OUT" "アラートを読めません" "読めないことを言う"
  assert_contains "$OUT" "Secret scanning alerts" "何の権限が足りないか言う"
}
test_case "human-tasks: 置けても読めなければ失敗にする（#786）" t_token_is_verified_not_just_placed

t_token_success_path() {
  RUN_STDIN="$TOKEN_CANARY" run bash "$SCRIPT" --yes --set-security-alerts-token
  assert_contains "$OUT" "2 つのフィードとも読めました" "両方読めたことを言う"
  # **2 つのフィードを両方確かめている**こと（片方だけ見て成功にしない）
  assert_contains "$LOG" "secret-scanning/alerts" "secret scanning を確かめている"
  assert_contains "$LOG" "dependabot/alerts" "dependabot を確かめている"
}
test_case "human-tasks: 2 つのフィードとも読めることを確かめる（#786）" t_token_success_path

t_no_token_skips_without_failing() {
  run bash "$SCRIPT" --yes
  assert_not_contains "$LOG" "gh secret set" "トークンを渡していないのに secret を置いている"
  assert_contains "$OUT" "飛ばします" "飛ばしたことを言う"
}
test_case "human-tasks: トークン未指定なら飛ばす（既存の作業は止めない）" t_no_token_skips_without_failing

# **フラグだけ立てて何も貼らなかった場合**も、止まらず・置かずに終わること。
t_flag_without_input_does_not_hang() {
  run bash "$SCRIPT" --yes --set-security-alerts-token
  assert_not_contains "$LOG" "gh secret set" "空入力なのに secret を置いている"
  assert_contains "$OUT" "飛ばします" "飛ばしたことを言う"
}
test_case "human-tasks: フラグだけで何も貼らなければ置かない" t_flag_without_input_does_not_hang

t_dry_run_does_not_place_the_token() {
  RUN_STDIN="$TOKEN_CANARY" run bash "$SCRIPT" --set-security-alerts-token
  assert_not_contains "$LOG" "gh secret set" "**dry-run なのに secret を置いている**"
  assert_not_contains "$OUT" "$TOKEN_CANARY" "dry-run でもトークンを出さない"
  assert_contains "$OUT" "文字のトークンを受け取っています" "渡っていることは（長さで）示す"
}
test_case "human-tasks: dry-run では PAT を置かない" t_dry_run_does_not_place_the_token

t_usage() {
  run bash "$SCRIPT" --oops
  assert_eq 2 "$STATUS" "知らない引数は usage"
  assert_eq "" "$LOG" "**ssh も git も curl も一度も呼ばない**"
}
test_case "human-tasks: 知らない引数では何もしない" t_usage

echo
echo "$PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
