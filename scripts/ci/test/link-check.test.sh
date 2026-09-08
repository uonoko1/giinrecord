#!/usr/bin/env bash
# Tests for scripts/ci/link-check.sh (Issue #646): 一次資料 URL の死活を ETL とは別に定期で確かめる。
# curl と sleep をスタブに差し替えて走らせる（ネットワークに出ない）。
#   bash scripts/ci/test/link-check.test.sh
#
# フィクスチャの URL は**公式ドメインだけ**（実在の一次資料と、404 用に example.invalid ではなく
# 同じ公式ドメインの実在しないパス）。サーバーの内部情報（IP・ホスト名・内部パス）は書かない。
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../link-check.sh"
REPO=$(cd "$HERE/../../.." && pwd)
PASS=0; FAIL=0
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

fail() { echo "    x $1"; CURRENT_FAILED=1; }
assert_eq() { [[ "$2" == "$1" ]] || fail "$3: expected [$1] got [$2]"; }
assert_contains() { [[ "$1" == *"$2"* ]] || fail "$3: expected to contain [$2] in: $1"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] || fail "$3: expected NOT to contain [$2] in: $1"; }
test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}

# ---- スタブ ---------------------------------------------------------------------------------
# curl: URL ごとの応答を $TMP/codes（"<url> <code>" または "<url> <code> <exit>"）から引く。
#       呼ばれるたび $TMP/curl.log に "<epoch-ish seq> <url>" を1行足す（順序と件数を数えるため）。
#       ラウンド2 で違う応答を返させるために、"<url>#2 <code>" があれば2回目以降はそちらを使う。
# sleep: 実際には待たず、$TMP/sleep.log に秒数を記録する（間隔と再試行の待ちを検査する）。
BIN="$TMP/bin"; mkdir -p "$BIN"
cat > "$BIN/curl" <<'STUB'
#!/usr/bin/env bash
url=""; ua=""
while [ $# -gt 0 ]; do
  case "$1" in
    -A) ua=$2; shift 2 ;;
    -o|-w|--max-time|--max-filesize) shift 2 ;;
    -sS|-L) shift ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
n=$(grep -c -x -F -- "$url" "$STUB_DIR/curl.urls" 2>/dev/null || true)
printf '%s\n' "$url" >> "$STUB_DIR/curl.urls"
printf 'start\t%s\n' "$url" >> "$STUB_DIR/curl.order"
# STUB_DELAY: 直列なら「開始→終了」が交互に並ぶ。並列に叩けば start が固まる。
# ここで本物の sleep を使う（PATH のスタブ sleep ではなく、絶対パス）。
if [ -n "${STUB_DELAY:-}" ]; then /usr/bin/env -i /bin/sleep "$STUB_DELAY" 2>/dev/null || true; fi
printf 'end\t%s\n' "$url" >> "$STUB_DIR/curl.order"
printf '%s\t%s\n' "$url" "$ua" >> "$STUB_DIR/curl.log"
line=""
if [ "$n" -ge 1 ]; then line=$(grep -m1 -F -- "$url#2 " "$STUB_DIR/codes" || true); fi
[ -n "$line" ] || line=$(grep -m1 -E "^$(printf '%s' "$url" | sed 's/[][\\.^$*+?(){}|\/]/\\&/g') " "$STUB_DIR/codes" || true)
[ -n "$line" ] || { printf '000'; exit 6; }
code=$(printf '%s' "$line" | awk '{print $2}')
ex=$(printf '%s' "$line" | awk '{print ($3 == "" ? 0 : $3)}')
printf '%s' "$code"
exit "$ex"
STUB
cat > "$BIN/sleep" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "${1:-}" >> "$STUB_DIR/sleep.log"
STUB
chmod +x "$BIN/curl" "$BIN/sleep"

# run <urls-file> [env assignments...] → $OUT / $STATUS、ログは $TMP/curl.log 等
run() {
  local urls=$1; shift
  : > "$TMP/curl.log"; : > "$TMP/curl.urls"; : > "$TMP/sleep.log"; : > "$TMP/curl.order"
  set +e
  OUT=$(STUB_DIR="$TMP" PATH="$BIN:$PATH" env "$@" bash "$SCRIPT" --urls "$urls" 2>&1)
  STATUS=$?
  set -e
}

# codes <lines...> → スタブの応答表を書く
codes() { printf '%s\n' "$@" > "$TMP/codes"; }
urls() { printf '%s\n' "$@" > "$TMP/urls"; }

OK_URL=https://www.pref.shimane.lg.jp/gikai/ugoki/gikai_kako/r0802/
GONE_URL=https://www.pref.shimane.lg.jp/gikai/ugoki/saikin/r0806/
GONE_PDF=https://www.pref.shimane.lg.jp/gikai/ugoki/saikin/r0806/index.data/r0806_giinbetu_kekka.pdf

# --- 1. これが存在する理由: 404 を見つける ------------------------------------------------------
t_reports_a_permanent_404() {
  urls "$OK_URL" "$GONE_URL" "$GONE_PDF"
  codes "$OK_URL 200" "$GONE_URL 404" "$GONE_PDF 404"
  run "$TMP/urls"
  assert_eq 1 "$STATUS" "404 があれば非0で終わる"
  assert_contains "$OUT" "fail $GONE_URL 404" "404 の URL が fail で名指しされる"
  assert_contains "$OUT" "fail $GONE_PDF 404" "404 の PDF が fail で名指しされる"
  assert_contains "$OUT" "summary: checked=3 failed=2" "母数と失敗件数が出る"
}

# --- 2. 否定的対照: 生きている URL では騒がない --------------------------------------------------
t_all_alive_is_silent_and_green() {
  urls "$OK_URL" "$GONE_URL"
  codes "$OK_URL 200" "$GONE_URL 200"
  run "$TMP/urls"
  assert_eq 0 "$STATUS" "全部 200 なら 0 で終わる"
  assert_not_contains "$OUT" "fail " "fail が1つも出ない"
  assert_contains "$OUT" "summary: checked=2 failed=0" "failed=0"
}

t_redirect_is_not_a_failure() {
  # -L で追った先が最終ステータス。301 のまま返ってくる形（追跡できない相対リダイレクト等）も
  # 「消えた」ではないので騒がない。
  urls "$OK_URL"
  codes "$OK_URL 301"
  run "$TMP/urls"
  assert_eq 0 "$STATUS" "3xx は fail にしない"
  assert_contains "$OUT" "ok $OK_URL 301" ""
}

t_large_pdf_curl_63_is_not_a_failure() {
  # 実測: 島根の表決 PDF は --max-filesize 65536 を超えるので curl が 63 で終わる。
  # ステータス（200）は既に受け取っているので成功。これを失敗にすると PDF が全部 fail になる。
  urls "$GONE_PDF"
  codes "$GONE_PDF 200 63"
  run "$TMP/urls"
  assert_eq 0 "$STATUS" "curl 63（サイズ超過）は届いている＝成功"
  assert_contains "$OUT" "ok $GONE_PDF 200" ""
}

t_transport_failure_is_a_failure_not_a_pass() {
  # curl が届かなかったとき（DNS 6 / 接続 7 / タイムアウト 28）は 000 として扱う。
  # curl は %{http_code} に何を出すか保証しないので、**終了コードで**決める。
  # ここを「code が空でなければ ok」にすると、届いていないのに緑になる。
  urls "$OK_URL"
  codes "$OK_URL 200 6"
  run "$TMP/urls"
  assert_eq 1 "$STATUS" "curl が届かなかったら失敗"
  assert_contains "$OUT" "fail $OK_URL 000" "ステータスは 000 として報告する"
}

# --- 3. 1回の 404 で騒がない ------------------------------------------------------------------
t_a_blip_does_not_report() {
  # 1回目 503、2回目 200 → 一時的な障害。報告しない。
  urls "$OK_URL"
  codes "$OK_URL 503" "$OK_URL#2 200"
  run "$TMP/urls"
  assert_eq 0 "$STATUS" "2回目に通ったら失敗にしない"
  assert_contains "$OUT" "ok $OK_URL 200" "2回目のステータスで報告する"
  assert_contains "$OUT" "summary: checked=1 failed=0" ""
}

t_two_failures_in_a_row_report() {
  urls "$OK_URL"
  codes "$OK_URL 404"
  run "$TMP/urls"
  assert_eq 1 "$STATUS" "2回とも落ちたら報告する"
  assert_contains "$OUT" "fail $OK_URL 404" ""
}

t_retry_probes_only_the_failed_urls() {
  # 生きている 79 件を叩き直すのは相手に無駄な負荷。落ちた分だけ叩き直す。
  urls "$OK_URL" "$GONE_URL"
  codes "$OK_URL 200" "$GONE_URL 404"
  run "$TMP/urls"
  assert_eq 1 "$(grep -c -F "$OK_URL	" "$TMP/curl.log")" "生きている URL は1回だけ叩く"
  assert_eq 2 "$(grep -c -F "$GONE_URL	" "$TMP/curl.log")" "落ちた URL だけ2回叩く"
}

t_no_retry_round_when_everything_is_alive() {
  urls "$OK_URL" "$GONE_URL"
  codes "$OK_URL 200" "$GONE_URL 200"
  run "$TMP/urls"
  assert_eq 2 "$(wc -l < "$TMP/curl.log" | tr -d ' ')" "全部生きていれば2回目のラウンドは走らない"
  assert_not_contains "$(cat "$TMP/sleep.log")" "60" "再試行の待ち（60s）が入らない"
}

# --- 4. 相手は自治体のサーバー: 間隔・UA・直列 ----------------------------------------------------
t_names_itself_with_a_user_agent() {
  urls "$OK_URL"
  codes "$OK_URL 200"
  run "$TMP/urls"
  assert_contains "$(cat "$TMP/curl.log")" "giinrecord-linkcheck/1.0 (+https://giinrecord.jp)" "UA を名乗る"
}

t_sleeps_between_requests() {
  urls "$OK_URL" "$GONE_URL" "$GONE_PDF"
  codes "$OK_URL 200" "$GONE_URL 200" "$GONE_PDF 200"
  run "$TMP/urls" LINK_CHECK_INTERVAL=1
  # 3件 → 間隔は2回（1件目の前には待たない）
  assert_eq 2 "$(grep -c '^1$' "$TMP/sleep.log")" "リクエストとリクエストの間に1秒あける"
}

t_interval_is_configurable_and_actually_used() {
  urls "$OK_URL" "$GONE_URL"
  codes "$OK_URL 200" "$GONE_URL 200"
  run "$TMP/urls" LINK_CHECK_INTERVAL=7
  assert_eq 1 "$(grep -c '^7$' "$TMP/sleep.log")" "LINK_CHECK_INTERVAL の値で待つ"
}

t_requests_are_sequential_not_parallel() {
  # 相手は自治体のサーバー。同時に何本も掴まない。
  #
  # **「呼ばれた順が一覧の順と同じ」では測れない**（この PBI で実測した罠）: スタブが即座に返るので、
  # `&` でバックグラウンドに送っても順序はたいてい保たれ、並列化の変異が生き残った（19/19 緑のまま）。
  # そこで**各リクエストに実時間の遅延を入れ**、start / end の並びを見る。
  # 直列なら start,end,start,end,… と交互に並ぶ。並列なら start が続けて出る。
  urls "$OK_URL" "$GONE_URL" "$GONE_PDF"
  codes "$OK_URL 200" "$GONE_URL 200" "$GONE_PDF 200"
  run "$TMP/urls" STUB_DELAY=0.4 LINK_CHECK_INTERVAL=0
  assert_eq "start
end
start
end
start
end" "$(cut -f1 "$TMP/curl.order")" "start と end が交互（＝1本ずつ）。並列なら start が固まる"
  # 順序そのものも一覧のとおり
  assert_eq "$OK_URL
$GONE_URL
$GONE_PDF" "$(cut -f1 "$TMP/curl.log")" "URL 一覧の順に叩く"
}

t_retry_waits_before_the_second_round() {
  urls "$OK_URL"
  codes "$OK_URL 404"
  run "$TMP/urls" LINK_CHECK_RETRY_SLEEP=90
  assert_contains "$(cat "$TMP/sleep.log")" "90" "2回目の前に LINK_CHECK_RETRY_SLEEP だけ待つ"
}

# --- 5. データを書き換えない -------------------------------------------------------------------
t_never_writes_to_data() {
  # 「404 を見つけたら直す」をやらない。移動先が正しいかの判断はここの仕事ではない。
  local before after
  before=$(cd "$REPO" && git status --porcelain data 2>/dev/null || true)
  urls "$GONE_URL"; codes "$GONE_URL 404"
  run "$TMP/urls"
  after=$(cd "$REPO" && git status --porcelain data 2>/dev/null || true)
  assert_eq "$before" "$after" "data/ が変わらない"
  # スクリプト本文にも書き込みの手段を持たせない（sed -i / > data/ / writeFileSync）
  assert_not_contains "$(sed 's/#.*//' "$SCRIPT")" "writeFileSync" "本文に書き込み API を持たない"
  assert_not_contains "$(sed 's/#.*//' "$SCRIPT")" "sed -i" "本文に in-place 編集を持たない"
}

# --- 6. 走査が壊れたら黙って緑にならない -----------------------------------------------------------
t_zero_urls_is_an_error_not_a_pass() {
  # 0件を「全部 ok」と読むと、抽出が壊れた瞬間に永久に緑になる（#500: 入口を固定する）。
  : > "$TMP/empty"
  codes "$OK_URL 200"
  run "$TMP/empty"
  assert_eq 2 "$STATUS" "URL が0件なら exit 2（緑にしない）"
  assert_contains "$OUT" "1 件も見つからない" ""
}

# --- 7. 本物の data/ から URL を集められる（--list、ネットワークに出ない） ----------------------------
t_list_collects_real_primary_source_urls() {
  local list n
  list=$(cd "$REPO" && bash "$SCRIPT" --list)
  n=$(printf '%s\n' "$list" | sed '/^$/d' | wc -l | tr -d ' ')
  # 実測 83 件（data/assemblies/**/*.json の http(s) 文字列、重複除去。2026-09-08）。
  # 下限だけを置く: 議会が増えれば増えるので上限は固定しないが、抽出が痩せたら落ちる。
  [ "$n" -ge 80 ] || fail "一次資料 URL が $n 件しか集まらない（80 未満）: 抽出が壊れている"
  assert_contains "$list" "https://www.pref.shimane.lg.jp/" "島根の URL が入っている"
  assert_contains "$list" "https://www.pref.mie.lg.jp/" "三重の URL が入っている"
  # 重複していない（同じ PDF が数百の rollcall から参照される。全部叩いたら相手に失礼）
  assert_eq "$n" "$(printf '%s\n' "$list" | sed '/^$/d' | sort -u | wc -l | tr -d ' ')" "重複を除いてある"
  # 集めるのは公式ドメインだけ（data/ に外部ドメインが紛れ込んだら気づく）
  assert_eq "" "$(printf '%s\n' "$list" | sed '/^$/d' | grep -v -E '^https://(www\.pref\.[a-z]+\.(lg\.)?jp|gikai\.pref\.[a-z]+\.lg\.jp|www\.(shugiin|sangiin)\.go\.jp)/' || true)" "公式ドメイン以外が混ざっていない"
}

t_list_does_not_hit_the_network() {
  : > "$TMP/curl.log"
  STUB_DIR="$TMP" PATH="$BIN:$PATH" bash -c "cd '$REPO' && bash '$SCRIPT' --list" > /dev/null
  assert_eq 0 "$(wc -l < "$TMP/curl.log" | tr -d ' ')" "--list は1本も叩かない"
}

# --- 8. ワークフローが実際にこのスクリプトを呼んでいる ---------------------------------------------
# （スクリプトが完璧でも、ワークフローが呼んでいなければ何も起きない。#504: 名前ではなく値を固定する）
t_workflow_calls_this_script() {
  local wf; wf=$(cat "$REPO/.github/workflows/link-check.yml")
  assert_contains "$wf" "scripts/ci/link-check.sh" "link-check.yml がこのスクリプトを呼ぶ"
  assert_contains "$wf" "timeout-minutes:" "job に timeout-minutes がある（#556）"
  assert_contains "$wf" "schedule:" "定期実行がある（ETL が走らないと落ちない、を直すのが目的）"
  assert_contains "$wf" "issues: write" "落ちたら Issue を立てられる権限がある"
}

test_case "404 を fail として報告し、非0で終わる（この仕組みが存在する理由）"       t_reports_a_permanent_404
test_case "否定的対照: 全部生きていれば fail は1件も出ず、0 で終わる"                t_all_alive_is_silent_and_green
test_case "否定的対照: 3xx は失敗にしない"                                          t_redirect_is_not_a_failure
test_case "否定的対照: 大きい PDF（curl 63 = サイズ超過）は失敗にしない"              t_large_pdf_curl_63_is_not_a_failure
test_case "curl が届かなかった（終了コード 6 等）は 000 として失敗にする"                 t_transport_failure_is_a_failure_not_a_pass
test_case "1回だけの失敗（1回目 503 → 2回目 200）は報告しない"                       t_a_blip_does_not_report
test_case "2回続けて落ちたものだけ報告する"                                          t_two_failures_in_a_row_report
test_case "叩き直すのは落ちた URL だけ（生きている分は1回）"                          t_retry_probes_only_the_failed_urls
test_case "全部生きていれば2回目のラウンド自体が走らない"                            t_no_retry_round_when_everything_is_alive
test_case "UA を名乗る"                                                             t_names_itself_with_a_user_agent
test_case "リクエストの間に間隔をあける"                                             t_sleeps_between_requests
test_case "間隔は LINK_CHECK_INTERVAL で変えられ、実際に使われる"                     t_interval_is_configurable_and_actually_used
test_case "並列に叩かない（一覧の順に1本ずつ）"                                       t_requests_are_sequential_not_parallel
test_case "2回目のラウンドの前に待つ"                                               t_retry_waits_before_the_second_round
test_case "404 を見つけても data/ を書き換えない"                                    t_never_writes_to_data
test_case "URL が0件なら緑ではなくエラー（抽出が壊れたら気づく）"                      t_zero_urls_is_an_error_not_a_pass
test_case "本物の data/ から一次資料 URL を集められる（重複なし・公式ドメインのみ）"   t_list_collects_real_primary_source_urls
test_case "--list はネットワークに出ない"                                            t_list_does_not_hit_the_network
test_case "link-check.yml が実際にこのスクリプトを呼んでいる"                         t_workflow_calls_this_script

echo
echo "passed: $PASS   failed: $FAIL"
[[ $FAIL == 0 ]]
