#!/usr/bin/env bash
# Tests for deploy/monitor/security-alerts.sh (Issue #786): reading GitHub's secret scanning / Dependabot alert
# feeds and turning them into an exit code (0 clear / 1 alerts / 2 unreadable) plus a body that is safe to
# publish. No network: gh is a stub on PATH answering from env.
#
# Why the "safe to publish" part is the centre of this file: the live API (measured 2026-09-13) returns the
# LEAKED CREDENTIAL ITSELF in `.secret`, along with the file path, line numbers and a permalink to the blob.
# security-alerts.sh's stdout is copied verbatim into a PUBLIC Issue, so any of those fields reaching stdout
# turns the alarm into the exploit. The canary below is a fake key in the real format; every test asserts it
# never appears in the output.
#   bash deploy/test/security-alerts.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../monitor/security-alerts.sh"
PASS=0; FAIL=0

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"; mkdir -p "$BIN"

# A fake credential in the shape the real alert carries. NOT a real key: 39 chars of filler after the prefix,
# and it matches .gitleaks.toml's allowlist for this test file. If this string ever shows up in the script's
# stdout, the monitoring would publish the secret it is warning about.
CANARY="AIzaSyTESTTESTTESTTESTTESTTESTTESTTESTX"
CANARY_PATH="packages/etl/test/fixtures/example/leaky.html"
CANARY_SHA="0123456789abcdef0123456789abcdef01234567"

cat > "$BIN/gh" <<'STUB'
#!/usr/bin/env bash
echo "gh $*" >> "$STUB_LOG"
url=${*: -1}
case "$url" in
  *secret-scanning/alerts*)
    [ -n "${G_SECRET_RC:-}" ] && { echo "${G_SECRET_ERR:-gh: HTTP 403 Resource not accessible by integration}" >&2; exit "$G_SECRET_RC"; }
    printf '%s' "${G_SECRET_JSON-[]}" ;;
  *dependabot/alerts*)
    [ -n "${G_DEP_RC:-}" ] && { echo "${G_DEP_ERR:-gh: HTTP 403 Resource not accessible by integration}" >&2; exit "$G_DEP_RC"; }
    printf '%s' "${G_DEP_JSON-[]}" ;;
  *) echo "unexpected url $url" >&2; exit 1 ;;
esac
STUB
chmod +x "$BIN/gh"

# One secret-scanning alert, with EVERY sensitive field the live API really returns (measured 2026-09-13).
# The whole point is that the script is handed all of this and prints none of it.
alert_json() {
  python3 -c '
import json,sys
print(json.dumps([{
 "number": 1,
 "state": "open",
 "html_url": "https://github.com/o/r/security/secret-scanning/1",
 "secret_type": "google_api_key",
 "secret_type_display_name": "Google API Key",
 "secret": sys.argv[1],
 "publicly_leaked": True,
 "first_location_detected": {
   "path": sys.argv[2], "start_line": 14, "end_line": 14,
   "blob_sha": sys.argv[3], "commit_sha": sys.argv[3],
   "html_url": "https://github.com/o/r/blob/" + sys.argv[3] + "/" + sys.argv[2] + "#L14-L14"}}]))' "$CANARY" "$CANARY_PATH" "$CANARY_SHA"
}
dependabot_json() {
  python3 -c '
import json
print(json.dumps([
 {"number": 7, "state": "open", "security_advisory": {"severity": "high", "summary": "x"},
  "dependency": {"package": {"name": "some-package"}, "manifest_path": "pnpm-lock.yaml"}},
 {"number": 8, "state": "open", "security_advisory": {"severity": "high", "summary": "y"},
  "dependency": {"package": {"name": "other-package"}, "manifest_path": "pnpm-lock.yaml"}},
 {"number": 9, "state": "open", "security_advisory": {"severity": "critical", "summary": "z"},
  "dependency": {"package": {"name": "third-package"}, "manifest_path": "pnpm-lock.yaml"}}]))'
}

fail() { echo "    x $1"; CURRENT_FAILED=1; }
assert_contains() { [[ "$1" == *"$2"* ]] || fail "$3: expected to contain [$2] in: $1"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] || fail "$3: expected NOT to contain [$2] in: $1"; }

fresh() {
  P="$TMP/$1"; mkdir -p "$P"; LOG="$P/stub.log"; : > "$LOG"
  export STUB_LOG="$LOG"
  unset G_SECRET_JSON G_DEP_JSON G_SECRET_RC G_DEP_RC G_SECRET_ERR G_DEP_ERR
}
run_guard() {
  RC=0
  PATH="$BIN:$PATH" bash "$SCRIPT" "${1:-uonoko1/giinrecord}" > "$P/out" 2> "$P/err" || RC=$?
  OUT=$(cat "$P/out"); ERR=$(cat "$P/err")
}

test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}

t_syntax() { bash -n "$SCRIPT" || fail "bash -n"; }

t_usage() {
  fresh usage
  RC=0; PATH="$BIN:$PATH" bash "$SCRIPT" > "$P/out" 2>&1 || RC=$?
  [[ $RC == 2 ]] || fail "引数なしは exit 2 のはず、got $RC"
}

# ---- rc=0: every feed read, all empty ----
t_clear_exits_zero() {
  fresh clear
  run_guard
  [[ $RC == 0 ]] || fail "空なら exit 0 のはず、got $RC ($OUT)"
  assert_contains "$OUT" "ok security-alerts" "全部空なら ok と言う"
}
# #757 の母数: 「0 件だった」ことを出力に出す。数字が無いと「見たが 0 件」と「見ていない」が区別できない。
t_clear_prints_the_counts() {
  fresh clear_counts
  run_guard
  assert_contains "$OUT" "secret-scanning: open 0 件" "secret scanning の件数を出す"
  assert_contains "$OUT" "dependabot: open 0 件" "dependabot の件数を出す"
}
t_both_feeds_are_actually_requested() {
  fresh feeds
  run_guard
  assert_contains "$(cat "$LOG")" "secret-scanning/alerts" "secret scanning を読んでいる"
  assert_contains "$(cat "$LOG")" "dependabot/alerts" "dependabot を読んでいる"
  assert_contains "$(cat "$LOG")" "state=open" "open のものだけを求めている"
}

# ---- rc=1: open alerts ----
t_secret_alert_exits_one() {
  fresh secret1
  G_SECRET_JSON=$(alert_json) run_guard
  [[ $RC == 1 ]] || fail "open アラートがあれば exit 1 のはず、got $RC ($OUT)"
  assert_contains "$OUT" "fail security-alerts" "fail と言う"
  assert_contains "$OUT" "secret-scanning: open 1 件" "種類と件数を出す"
  assert_contains "$OUT" "Google API Key" "アラートの種類を出す"
}
t_dependabot_alert_exits_one() {
  fresh dep1
  G_DEP_JSON=$(dependabot_json) run_guard
  [[ $RC == 1 ]] || fail "dependabot に open があれば exit 1、got $RC ($OUT)"
  assert_contains "$OUT" "dependabot: open 3 件" "件数は 3"
  assert_contains "$OUT" "high x2" "severity ごとに数える"
  assert_contains "$OUT" "critical x1" "critical も数える"
}
t_links_to_the_security_tab() {
  fresh link
  G_SECRET_JSON=$(alert_json) run_guard
  assert_contains "$OUT" "https://github.com/uonoko1/giinrecord/security" "GitHub 上の URL を出す"
}

# ---- ここが一番大事: 秘密の値が出力に混ざらないこと ----
# 出力は**公開 Issue に逐語で載る**。実測した本物の応答は `.secret` に**平文の鍵そのもの**を持っている。
t_never_prints_the_secret_value() {
  fresh canary
  G_SECRET_JSON=$(alert_json) run_guard
  assert_not_contains "$OUT" "$CANARY" "秘密の値が stdout に出ている（これが出たら警告そのものが漏洩になる）"
  assert_not_contains "$OUT" "AIzaSy" "鍵の接頭辞すら出さない"
}
t_never_prints_the_file_location() {
  fresh canary_loc
  G_SECRET_JSON=$(alert_json) run_guard
  assert_not_contains "$OUT" "$CANARY_PATH" "該当ファイルのパスが出ている"
  assert_not_contains "$OUT" "leaky.html" "ファイル名が出ている"
  assert_not_contains "$OUT" "$CANARY_SHA" "blob/commit の SHA が出ている"
  assert_not_contains "$OUT" "#L14" "該当行へのリンクが出ている"
}
# 許可リストであることの確認: 応答に**知らないフィールドが増えても**出力に出ない。
# API は実際にフィールドが増え続けている（`.validity` / `.publicly_leaked` はこのリポジトリより新しい）。
t_unknown_fields_do_not_leak() {
  fresh unknown_fields
  G_SECRET_JSON='[{"number":1,"secret_type_display_name":"Google API Key","some_future_field":"SHOULD-NOT-APPEAR","secret":"ALSO-NOT"}]' run_guard
  assert_not_contains "$OUT" "SHOULD-NOT-APPEAR" "知らないフィールドの値が出ている（denylist になっている）"
  assert_not_contains "$OUT" "ALSO-NOT" "secret が出ている"
  assert_contains "$OUT" "Google API Key" "種類は出る"
}
t_dependabot_package_names_are_not_printed() {
  fresh dep_pkg
  G_DEP_JSON=$(dependabot_json) run_guard
  # パッケージ名そのものは「何が脆弱か」を公開で名指しすることになる。severity と件数で足りる。
  assert_not_contains "$OUT" "some-package" "パッケージ名を出さない"
  assert_not_contains "$OUT" "third-package" "パッケージ名を出さない"
}

# ---- rc=2: 読めなかった。「0 件」と同じ出力になってはいけない（#757 / #540） ----
t_secret_feed_unreadable_exits_two() {
  fresh unread1
  G_SECRET_RC=1 run_guard
  [[ $RC == 2 ]] || fail "読めなければ exit 2 のはず（0 でも 1 でもない）、got $RC ($OUT)"
  assert_contains "$OUT" "読めなかった" "読めなかったと言う"
  assert_contains "$OUT" "判定できていない" "判定していないと明言する"
  assert_not_contains "$OUT" "ok security-alerts" "読めていないのに ok と言っている"
}
t_dependabot_feed_unreadable_exits_two() {
  fresh unread2
  G_DEP_RC=1 run_guard
  [[ $RC == 2 ]] || fail "dependabot が読めなければ exit 2、got $RC ($OUT)"
  assert_contains "$OUT" "dependabot" "どのフィードが読めなかったか名指しする"
}
# 「読めなかった」と「0 件だった」が同じ出力になってはいけない——これが 21 日の再来を防ぐ境目。
t_unreadable_is_distinguishable_from_zero() {
  fresh distinguish
  run_guard; local clear_out=$OUT clear_rc=$RC
  fresh distinguish2
  G_SECRET_RC=1 run_guard
  [[ "$OUT" != "$clear_out" ]] || fail "読めなかった時の出力が 0 件の時と同一（区別がつかない）"
  [[ $RC != "$clear_rc" ]] || fail "読めなかった時の終了コードが 0 件の時と同一"
  assert_not_contains "$OUT" "secret-scanning: open 0 件" "読めていないのに「0 件」と書いている"
}
# 権限エラーの本文は stderr にだけ出す。gh は失敗時に Authorization ヘッダを出すことがある。
t_api_error_text_stays_off_stdout() {
  fresh errtext
  G_SECRET_RC=1 G_SECRET_ERR="gh: HTTP 403 Authorization: Bearer ghs_SECRETTOKENVALUE" run_guard
  assert_not_contains "$OUT" "ghs_SECRETTOKENVALUE" "API エラー本文が stdout に出ている（Issue に載る）"
  assert_contains "$ERR" "ghs_SECRETTOKENVALUE" "理由は stderr（run のログ）には出す"
}
# 応答が配列でない（エラーオブジェクト・空・HTML）なら、それは 0 件ではなく「読めなかった」。
# `jq length` は {"message":…} に対して 1 を返すので、形を見ずに数えると静かに壊れる。
t_non_array_response_is_unreadable_not_zero() {
  fresh shape1
  G_SECRET_JSON='{"message":"Resource not accessible by integration"}' run_guard
  [[ $RC == 2 ]] || fail "配列でない応答は exit 2 のはず、got $RC ($OUT)"
  # dependabot 側は現に読めて 0 件なので「open 0 件」は出てよい。読めなかった secret-scanning のほうが
  # 0 件として数えられていないことを見る（ここを "open 0 件" で見ると別のフィードに当たって空振りする）。
  assert_not_contains "$OUT" "secret-scanning: open 0 件" "エラーオブジェクトを 0 件と数えている"
  assert_contains "$OUT" "unreadable secret-scanning" "読めなかった側として数える"
}
t_empty_response_is_unreadable_not_zero() {
  fresh shape2
  G_SECRET_JSON='' run_guard
  [[ $RC == 2 ]] || fail "空の応答は exit 2 のはず、got $RC ($OUT)"
}
t_null_response_is_unreadable_not_zero() {
  fresh shape3
  G_SECRET_JSON='null' run_guard
  [[ $RC == 2 ]] || fail "null の応答は exit 2 のはず、got $RC ($OUT)"
}
# 読めなかったフィードがあれば、もう片方に open アラートがあっても exit 2 が勝つ。
# 「アラートがある」と言い切るには全部読めている必要はないが、「無い」と言い切るには要る——
# ここで 1 を返すと、読めなかったフィードの存在が本文から消える。
t_unreadable_wins_over_alerts() {
  fresh mixed
  G_SECRET_RC=1 G_DEP_JSON=$(dependabot_json) run_guard
  [[ $RC == 2 ]] || fail "片方が読めなければ exit 2、got $RC ($OUT)"
  assert_contains "$OUT" "dependabot: open 3 件" "読めたほうの件数は出す"
  assert_contains "$OUT" "読めなかった" "読めなかったことも言う"
}
# 100 件を超えても全部数える（--paginate が複数の JSON 配列を続けて吐く形）。
t_paginated_response_is_summed() {
  fresh paginate
  G_SECRET_JSON='[{"number":1,"secret_type_display_name":"Google API Key"}][{"number":2,"secret_type_display_name":"Slack Token"}]' run_guard
  [[ $RC == 1 ]] || fail "複数ページでも exit 1、got $RC ($OUT)"
  assert_contains "$OUT" "secret-scanning: open 2 件" "ページをまたいで合計する"
  assert_contains "$(cat "$LOG")" "--paginate" "--paginate を付けている"
}

echo "== deploy/monitor/security-alerts.sh =="
test_case "syntax"                                              t_syntax
test_case "引数なしは exit 2"                                    t_usage
test_case "空なら exit 0"                                        t_clear_exits_zero
test_case "空でも件数（母数）を出す"                              t_clear_prints_the_counts
test_case "2 つのフィードを実際に読んでいる"                      t_both_feeds_are_actually_requested
test_case "secret scanning に open があれば exit 1"              t_secret_alert_exits_one
test_case "dependabot に open があれば exit 1（severity 別）"     t_dependabot_alert_exits_one
test_case "GitHub 上の URL を出す"                               t_links_to_the_security_tab
test_case "秘密の値を出力に出さない"                              t_never_prints_the_secret_value
test_case "該当ファイル・行・SHA を出力に出さない"                 t_never_prints_the_file_location
test_case "知らないフィールドも出さない（許可リスト）"             t_unknown_fields_do_not_leak
test_case "dependabot のパッケージ名を出さない"                   t_dependabot_package_names_are_not_printed
test_case "secret scanning が読めなければ exit 2"                t_secret_feed_unreadable_exits_two
test_case "dependabot が読めなければ exit 2"                     t_dependabot_feed_unreadable_exits_two
test_case "「読めなかった」と「0 件」が区別できる"                 t_unreadable_is_distinguishable_from_zero
test_case "API エラー本文は stdout に出さない"                    t_api_error_text_stays_off_stdout
test_case "配列でない応答は 0 件ではなく読めなかった"              t_non_array_response_is_unreadable_not_zero
test_case "空の応答は 0 件ではなく読めなかった"                    t_empty_response_is_unreadable_not_zero
test_case "null の応答は 0 件ではなく読めなかった"                 t_null_response_is_unreadable_not_zero
test_case "読めなかったほうが優先される"                          t_unreadable_wins_over_alerts
test_case "複数ページを合計する"                                  t_paginated_response_is_summed

echo "-- $PASS passed, $FAIL failed"
[[ $FAIL == 0 ]]
