#!/usr/bin/env bash
# Tests for scripts/ci/forbidden-patterns.sh (Issue #133). Each case builds a throw-away git repo with
# tracked files and runs the check there; nothing here touches the real repo. Test data that would itself
# trip the check (fake keys, IPs) is assembled from pieces so this file stays clean.
#   bash scripts/ci/test/forbidden-patterns.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../forbidden-patterns.sh"
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

# repo <name> → fresh git repo in $R with one clean tracked file
repo() {
  R="$TMP/$1"; mkdir -p "$R"
  git -C "$R" init -q
  echo "# clean" > "$R/README.md"
}
# add <relpath> <content> → write + git add (the check only looks at tracked/staged files)
add() { mkdir -p "$R/$(dirname "$1")"; printf '%s\n' "$2" > "$R/$1"; git -C "$R" add -f "$1"; }
# run [env assignments...] → STATUS / OUT
run() {
  set +e
  (cd "$R" && env "$@" bash "$SCRIPT") > "$TMP/out" 2>&1
  STATUS=$?
  set -e
  OUT=$(cat "$TMP/out")
}

# Pieces (so this file never contains a real-looking secret or IP)
DASH="-----"
KEY_HEADER="${DASH}BEGIN OPENSSH PRIVATE KEY${DASH}"
GH_TOKEN="ghp_$(printf 'A%.0s' $(seq 1 36))"
GH_PAT="github_pat_$(printf 'B%.0s' $(seq 1 30))"
AWS_KEY="AKIA$(printf 'C%.0s' $(seq 1 16))"
IP="203.0.113$(printf '.%s' 10)"

t_clean_repo_passes() {
  repo clean; add "src/a.ts" "export const x = 1;"
  run FORBIDDEN_PATTERNS=
  assert_eq 0 "$STATUS" "exit"
  assert_contains "$OUT" "::warning::" "secret absence is a warning annotation (local run / fork PR), not fatal"
}

t_private_key_header_fails() {
  repo key; add "notes/key.txt" "$KEY_HEADER"
  run
  assert_eq 1 "$STATUS" "exit"
  assert_contains "$OUT" "notes/key.txt" "offending file named"
  assert_contains "$OUT" "private-key" "rule named"
}

t_github_tokens_fail() {
  repo gh; add "a.md" "token $GH_TOKEN"; add "b.md" "pat $GH_PAT"
  run
  assert_eq 1 "$STATUS" "exit"
  assert_contains "$OUT" "a.md" "ghp_ found"
  assert_contains "$OUT" "b.md" "github_pat_ found"
}

t_aws_key_fails() {
  repo aws; add "config.yml" "key: $AWS_KEY"
  run
  assert_eq 1 "$STATUS" "exit"
  assert_contains "$OUT" "config.yml" "AWS key id found"
}

t_tracked_env_file_fails_but_example_is_fine() {
  repo env; add ".env.example" "SITE_ORIGIN="
  run; assert_eq 0 "$STATUS" ".env.example alone passes"
  add ".env" "SECRET=x"; add "apps/web/.env.production" "SECRET=y"
  run
  assert_eq 1 "$STATUS" "exit"
  assert_contains "$OUT" ".env" "real .env named"
  assert_contains "$OUT" "apps/web/.env.production" "nested .env.* named"
  assert_not_contains "$OUT" ".env.example" "example not reported"
}

t_ip_anywhere_fails() {
  repo ip; add "docs/notes.md" "host is $IP"
  run
  assert_eq 1 "$STATUS" "exit"
  assert_contains "$OUT" "docs/notes.md" "IP in docs/ reported"
}

t_ip_inside_deploy_and_docs_ops_fails_too() {
  # The VPS IP used to live exactly here (deploy/README.md, staging-setup.sh) — no directory is exempt (#137 review).
  repo ipdeploy; add "deploy/README.md" "A record -> $IP"; add "docs/ops/deploy.md" "host $IP"
  run
  assert_eq 1 "$STATUS" "exit (deploy/ and docs/ops/ are NOT exempt from the IP rule)"
  assert_contains "$OUT" "deploy/README.md" "IP in deploy/ reported"
  assert_contains "$OUT" "docs/ops/deploy.md" "IP in docs/ops/ reported"
}

t_loopback_and_versions_are_not_ips() {
  repo loop; add "src/x.ts" "http://127.0.0.1:8081 and 0.0.0.0 and v1.2.3.4 and 10.0.0.1"
  run
  assert_eq 0 "$STATUS" "exit: loopback, 0.0.0.0, private ranges and version-like strings pass"
}

t_secret_patterns_fail_and_are_not_echoed() {
  repo secret; add "docs/a.md" "see othersite.example and more"
  run FORBIDDEN_PATTERNS=$'othersite\\.example\nanother-host'
  assert_eq 1 "$STATUS" "exit"
  assert_contains "$OUT" "docs/a.md" "file named"
  assert_not_contains "$OUT" "othersite" "the pattern itself is never printed (it is the secret)"
  assert_not_contains "$OUT" "another-host" "no pattern leaks into the log"
}

t_secret_patterns_pass_when_absent() {
  repo secretok; add "docs/a.md" "nothing to see"
  run FORBIDDEN_PATTERNS=$'othersite\\.example\n\n   \nanother-host'
  assert_eq 0 "$STATUS" "exit (blank lines in the secret are ignored)"
  assert_contains "$OUT" "FORBIDDEN_PATTERNS: 2 pattern(s)" "count logged, patterns not"
}

t_secret_patterns_crlf_still_match() {
  repo crlf; add "docs/a.md" "see othersite.example here"
  run FORBIDDEN_PATTERNS=$'othersite\\.example\r\nanother-host\r\n'
  assert_eq 1 "$STATUS" "exit (CRLF line endings in the secret must not disable the check)"
  assert_contains "$OUT" "docs/a.md" "file named"
  assert_contains "$OUT" "FORBIDDEN_PATTERNS: 2 pattern(s)" "count ignores the CR"
}

t_secret_patterns_invalid_regex_is_an_error_not_clean() {
  repo badre; add "docs/a.md" "see othersite.example here"
  run FORBIDDEN_PATTERNS=$'othersite\\.example\n(unclosed['
  assert_eq 2 "$STATUS" "exit (grep error must fail the check, never report clean)"
  assert_not_contains "$OUT" "forbidden-patterns: clean" "not clean"
  assert_contains "$OUT" "grep failed" "error reported"
  assert_not_contains "$OUT" "unclosed" "the broken pattern is not echoed either"
}

t_secret_absent_and_required_is_an_error() {
  # push / schedule / same-repo PR: the secret must be present — a missing or renamed secret must not pass as clean.
  repo required; add "docs/a.md" "nothing to see"
  run FORBIDDEN_PATTERNS= FORBIDDEN_PATTERNS_REQUIRED=true
  assert_eq 2 "$STATUS" "exit (required secret missing → error, not clean)"
  assert_not_contains "$OUT" "forbidden-patterns: clean" "not clean"
  assert_contains "$OUT" "::error::" "GitHub error annotation"
  assert_contains "$OUT" "FORBIDDEN_PATTERNS" "names the secret"
}

t_secret_absent_and_not_required_warns() {
  # fork pull_request: GitHub never passes secrets, so the check is skipped with a visible warning annotation.
  repo notrequired; add "docs/a.md" "nothing to see"
  run FORBIDDEN_PATTERNS= FORBIDDEN_PATTERNS_REQUIRED=false
  assert_eq 0 "$STATUS" "exit"
  assert_contains "$OUT" "::warning::" "GitHub warning annotation"
  assert_contains "$OUT" "forbidden-patterns: clean" "rest of the check still runs"
}

t_secret_present_and_required_passes() {
  repo reqok; add "docs/a.md" "nothing to see"
  run FORBIDDEN_PATTERNS=$'othersite\\.example' FORBIDDEN_PATTERNS_REQUIRED=true
  assert_eq 0 "$STATUS" "exit"
  assert_not_contains "$OUT" "::warning::" "no warning when the secret is set"
}

t_untracked_files_are_ignored() {
  repo untracked; printf '%s\n' "$KEY_HEADER" > "$R/scratch.txt"   # not git-added
  run
  assert_eq 0 "$STATUS" "exit"
}

t_data_dir_is_skipped() {
  repo data; add "data/big.json" "{\"ip\":\"$IP\"}"
  run
  assert_eq 0 "$STATUS" "exit (data/ is the ETL output, never scanned for IPs)"
}

# Issue #542: 変異ハーネスが git の破壊的コマンドで「戻す」と、担当者の未コミットの作業が消える
# （2026-09-06 に 3 回起きた）。scripts/ deploy/ .github/ の中では書けないようにする。
# この検査自身が destructive-git 規則に引っかからないよう、テストデータは組み立てて作る
# （ファイル先頭の方針と同じ。生の "git reset --hard" をこのファイルに書かない）。
G=git
t_destructive_git_in_scripts_fails() {
  local i=0 form
  for form in "$G checkout -- ." "$G checkout ." "$G reset --hard" "$G reset --hard HEAD" \
              "$G clean -fd" "$G clean -xfd" "$G stash" "$G stash pop"; do
    i=$((i+1)); repo "dg$i"; add scripts/dev/harness.sh "$form"; run
    assert_eq 1 "$STATUS" "[$form] → fail"
    assert_contains "$OUT" "destructive-git" "[$form] rule name"
    assert_contains "$OUT" "scripts/dev/harness.sh" "[$form] names the file"
  done
}
# #557: `git restore` は git が公式に薦める現代的な書き方で、次に変異ハーネスを書く人が最も自然に選ぶ形。
# docs（.claude/agents/developer.md）と mutate.test.sh は禁じていたのに、CI 規則だけが持っていなかった。
# `git clean` のフラグ分離（-d -f）と `git checkout -f .` も同じく素通りしていた（PO / 担当者が実測）。
# ここに並ぶ形はすべて「使い捨てリポジトリで実行して、未コミットの作業が実際に消えること」を
# 確かめてから足している（tracked の変更 / staged の変更 / 未追跡ファイルのどれが消えるかまで測った）。
t_destructive_git_restore_and_separated_flags_fail() {
  local i=0 form
  for form in "$G restore ." "$G restore --staged --worktree ." "$G restore -- ." \
              "$G restore --source=HEAD path/to/file" "$G restore path/to/file" \
              "$G clean -d -f" "$G clean -f -d" "$G clean --force" "$G clean -d --force" \
              "$G checkout -f ." "$G checkout --force ." "$G checkout -f -- ."; do
    i=$((i+1)); repo "dgr$i"; add scripts/dev/harness.sh "$form"; run
    assert_eq 1 "$STATUS" "[$form] → fail: $OUT"
    assert_contains "$OUT" "destructive-git" "[$form] rule name"
    assert_contains "$OUT" "scripts/dev/harness.sh" "[$form] names the file"
  done
}
# 変異 KILL E（OPT を「どんな語にも当たる」形に広げる）が最初は生き残った。等価変異ではなく、
# 見本の甘さだった: フラグが先頭に来ない形（`git checkout mybranch -f` / `git clean untracked.txt -f`）を
# 1 つも置いていなかった。どちらも実測で未コミットの作業が消える（tracked+staged / untracked）。
# `git clean -f` と `git clean -q -d -f` も置く: 繰り返しグループを使った書き方だと GNU grep の ERE が
# これらを取り落とし、規則が書かれた当の形が黙って通る（実測。素通りしたまま 25/25 緑になっていた）。
t_destructive_git_force_flag_not_first_fails() {
  local i=0 form
  for form in "$G checkout mybranch -f" "$G clean untracked.txt -f" "$G clean -f" \
              "$G clean -q -d -f" "$G checkout -q -f ." "$G clean -x -f"; do
    i=$((i+1)); repo "dgf$i"; add scripts/dev/harness.sh "$form"; run
    assert_eq 1 "$STATUS" "[$form] → fail: $OUT"
    assert_contains "$OUT" "destructive-git" "[$form] rule name"
  done
}
# 行末コメントの中の -f まで拾わないこと（`#` を境界に入れていないと、正当な git checkout main が落ちる。実測）
t_force_flag_in_trailing_comment_is_not_flagged() {
  local i=0 form
  for form in "$G checkout main  # -f は使わない" "$G checkout -b feat/x  # --force しない" \
              "$G clean --dry-run  # -f を付けないこと" "$G checkout --quiet FETCH_HEAD -- data && cp -f a b"; do
    i=$((i+1)); repo "fc$i"; add scripts/x.sh "$form"; run
    assert_eq 0 "$STATUS" "[$form] → pass: $OUT"
  done
}
# 破壊的でないものを足していないこと。`git reset --mixed` は index を戻すだけで作業ツリーを触らない
# （実測: tracked の変更・staged の変更・未追跡のどれも消えない）。落とすと正当な使い方を禁じてしまう。
t_non_destructive_git_forms_still_pass() {
  local i=0 form
  for form in "$G reset --mixed" "$G reset --soft HEAD~1" "$G restore --help" \
              "$G checkout -b feature/x" "$G checkout main" "$G checkout \"\$ref\" -- path/to/file" \
              "$G clean --dry-run" "$G reset HEAD -- file"; do
    i=$((i+1)); repo "nd$i"; add scripts/x.sh "$form"; run
    assert_eq 0 "$STATUS" "[$form] → pass: $OUT"
  done
}
# 正当な使い方まで止めない（止めすぎると、この検査ごと外される）
t_legitimate_git_is_not_flagged() {
  local i=0 form
  for form in "$G checkout --quiet FETCH_HEAD -- data" "$G checkout -b feat/x origin/main" \
              "log \"not inside a $G checkout; update PR manually\"" "$G reset HEAD -- file" \
              "$G clean --dry-run" "$G stashed_things_are_fine=1"; do
    i=$((i+1)); repo "lg$i"; add scripts/x.sh "$form"; run
    assert_eq 0 "$STATUS" "[$form] → pass: $OUT"
  done
}
# scripts/ だけでなく deploy/ と .github/ も対象（3 つとも名指しで固定する）
t_destructive_git_covers_all_three_dirs() {
  local i=0 f
  for f in scripts/a.sh deploy/b.sh .github/workflows/c.yml; do
    i=$((i+1)); repo "d3$i"; add "$f" "$G reset --hard"; run
    assert_eq 1 "$STATUS" "[$f] → fail: $OUT"
    assert_contains "$OUT" "$f" "[$f] names the file"
  done
}
# 対象は scripts/ deploy/ .github/ だけ（docs は説明のために書ける）
t_destructive_git_outside_scripts_is_allowed() {
  repo dgo; add docs/WORKING_AGREEMENT.md "$G reset --hard は未コミットの作業を消す"; run
  assert_eq 0 "$STATUS" "docs では書ける: $OUT"
}
# コメント行は説明なので通す（この規則の理由そのものを書けなくなる）
t_destructive_git_in_comments_is_allowed() {
  repo dgc; add scripts/x.sh "# $G reset --hard は使わない（#542）"; run
  assert_eq 0 "$STATUS" "コメントは通す: $OUT"
}

# Issue #785: 取得した第三者の HTML をフィクスチャに保存すると、そのページが埋め込んでいる
# 鍵・トークンが一緒に入ってくる。#750（青森 ?token=）と #785（徳島 maps.googleapis.com ?key=AIza…）で
# 2 回起きた。gitleaks v8.30.1 の既定ルールは徳島の形を検出しない（実測: no leaks found）ので、
# ここで塞ぐ。テストデータは組み立てて作る（このファイル自身が本物らしき鍵を含まないため）。
GKEY="AIza$(printf 'D%.0s' $(seq 1 35))"
LONGTOK=$(printf 'e%.0s' $(seq 1 32))

# 1. 徳島の形を逐語で固定する（#762: 「N 個以上」ではなく実際に踏んだ形そのものを押さえる）
t_fixture_google_maps_key_fails() {
  repo fgk
  add "packages/etl/test/fixtures/tokushima/gaiyou.html" \
    "<script src=\"https://maps.googleapis.com/maps/api/js?key=$GKEY&amp;language=ja\"></script>"
  run
  assert_eq 1 "$STATUS" "exit"
  assert_contains "$OUT" "packages/etl/test/fixtures/tokushima/gaiyou.html" "offending fixture named"
  assert_contains "$OUT" "fixture-secret" "rule named"
  assert_not_contains "$OUT" "$GKEY" "鍵の値そのものは出力しない"
}
# 1b. 2 つの形を独立に固定する（#762）。上の 1 本だけだと、徳島の形は ?key= の規則にも当たるので、
#     AIza の規則を丸ごと消しても落ちない（実測: 変異 1 が生き残った）。クエリ文字列の外に置いた
#     AIza の値は、AIza の規則にしか当たらない。
t_fixture_google_key_outside_query_string_fails() {
  repo fgk2
  add "packages/etl/test/fixtures/tokushima/inline.html" "<script>var gmapKey = \"$GKEY\";</script>"
  run
  assert_eq 1 "$STATUS" "exit"
  assert_contains "$OUT" "packages/etl/test/fixtures/tokushima/inline.html" "AIza 単独でも落ちる"
  assert_contains "$OUT" "fixture-secret" "rule named"
}

# 2. 青森の形を逐語で固定する（#750）
# 値は AIza で始まらない（= AIza の規則には当たらない）ので、この 1 本はクエリ文字列の規則だけを固定する。
t_fixture_query_token_fails() {
  repo fqt
  add "packages/etl/test/fixtures/aomori/giin-kaiha.html" \
    "<a href=\"https://example.invalid/web_inquiry/?token=$LONGTOK\">手話で電話</a>"
  run
  assert_eq 1 "$STATUS" "exit"
  assert_contains "$OUT" "packages/etl/test/fixtures/aomori/giin-kaiha.html" "offending fixture named"
  assert_contains "$OUT" "fixture-secret" "rule named"
}

# 3. サニタイズ済みのものが落ちてはいけない（落ちると、直した人が検査ごと外す）
t_sanitized_fixture_passes() {
  repo fsan
  add "packages/etl/test/fixtures/tokushima/gaiyou.html" \
    "<script src=\"https://maps.googleapis.com/maps/api/js?key=REDACTED&amp;language=ja\"></script>"
  add "packages/etl/test/fixtures/nara/18579.html" \
    "<a href=\"https://example.invalid/web_inquiry/?token=REDACTED\">手話で電話</a>"
  run
  assert_eq 0 "$STATUS" "REDACTED はサニタイズ済み: $OUT"
}

# 3b. 短い・普通のクエリ文字列まで落とさない（フィクスチャは普通の HTML で埋まっている）
t_ordinary_fixture_query_strings_pass() {
  repo ford
  add "packages/etl/test/fixtures/tokushima/index.html" \
    "<a href=\"/list.html?key=2024\">一覧</a><a href=\"/x?token=\">空</a><a href=\"/y?id=7310454\">議案</a>"
  run
  assert_eq 0 "$STATUS" "普通のクエリは通す: $OUT"
}

# 4. 母数（#757）: フィクスチャが 1 本も見つからなければ「0 件」ではなく異常。
#    「全部きれい」と「1 本も読めていない」が同じ出力になってはいけない。
t_fixture_secret_denominator_is_reported() {
  repo fden; add "packages/etl/test/fixtures/tokushima/gaiyou.html" "<p>ok</p>"
  run
  assert_eq 0 "$STATUS" "exit"
  assert_contains "$OUT" "fixture-secret: 1 file(s) scanned" "母数を出す"
}
# ETL があるのにフィクスチャが 0 本 → error。パスの付け替えで対象が消えたときに緑にならないため。
t_fixture_secret_zero_files_with_etl_is_an_error() {
  repo fzero; add "packages/etl/src/a.ts" "export const x = 1;"   # ETL はあるがフィクスチャが 1 本も無い
  run
  assert_eq 2 "$STATUS" "ETL ありでフィクスチャ 0 本は clean ではなく error: $OUT"
  assert_contains "$OUT" "fixture-secret" "rule named"
  assert_contains "$OUT" "fixture-secret: 0 file(s) scanned" "母数 0 を明示する"
}
# ETL が無い repo では 0 本が正しい（このファイルのテストが作る使い捨ての repo がまさにそれ）
t_fixture_secret_zero_files_without_etl_passes() {
  repo fzeroo; add "src/a.ts" "export const x = 1;"
  run
  assert_eq 0 "$STATUS" "ETL が無ければ 0 本は正常: $OUT"
  assert_contains "$OUT" "fixture-secret: 0 file(s) scanned" "母数は常に出す"
}

# 対象はフィクスチャ（取得した第三者の HTML）。docs は説明のために書ける。
t_fixture_secret_scope_is_fixtures_only() {
  repo fsc; add "packages/etl/test/fixtures/x/a.html" "<p>ok</p>"
  add "docs/WORKING_AGREEMENT.md" "maps.googleapis.com/maps/api/js?key=$GKEY のような値をフィクスチャに残さない"
  run
  assert_eq 0 "$STATUS" "docs は対象外: $OUT"
}

test_case "forbidden-patterns.sh: bash -n" bash -n "$SCRIPT"
test_case "clean repo passes; unset FORBIDDEN_PATTERNS is a warning" t_clean_repo_passes
test_case "private key header → fail" t_private_key_header_fails
test_case "ghp_ / github_pat_ tokens → fail" t_github_tokens_fail
test_case "AWS access key id → fail" t_aws_key_fails
test_case "tracked .env / .env.* → fail; .env.example allowed" t_tracked_env_file_fails_but_example_is_fine
test_case "IP address → fail" t_ip_anywhere_fails
test_case "IP address inside deploy/ or docs/ops/ → fail too (no exempt directories)" t_ip_inside_deploy_and_docs_ops_fails_too
test_case "loopback / 0.0.0.0 / private ranges / version strings are not IPs" t_loopback_and_versions_are_not_ips
test_case "FORBIDDEN_PATTERNS hit → fail without echoing the pattern" t_secret_patterns_fail_and_are_not_echoed
test_case "FORBIDDEN_PATTERNS absent → pass; blank lines ignored" t_secret_patterns_pass_when_absent
test_case "FORBIDDEN_PATTERNS with CRLF line endings still matches" t_secret_patterns_crlf_still_match
test_case "FORBIDDEN_PATTERNS with an invalid regex → error, not clean" t_secret_patterns_invalid_regex_is_an_error_not_clean
test_case "FORBIDDEN_PATTERNS absent + FORBIDDEN_PATTERNS_REQUIRED=true → error" t_secret_absent_and_required_is_an_error
test_case "FORBIDDEN_PATTERNS absent + not required → ::warning::, still runs" t_secret_absent_and_not_required_warns
test_case "FORBIDDEN_PATTERNS present + required → pass, no warning" t_secret_present_and_required_passes
test_case "untracked files are ignored" t_untracked_files_are_ignored
test_case "data/ is skipped" t_data_dir_is_skipped
test_case "destructive git in scripts/deploy/.github → fail (#542)" t_destructive_git_in_scripts_fails
test_case "destructive git: scripts/ deploy/ .github/ all covered (#542)" t_destructive_git_covers_all_three_dirs
test_case "legitimate git usage is not flagged (#542)" t_legitimate_git_is_not_flagged
test_case "destructive git: restore / 分離フラグの clean / checkout -f も落ちる (#557)" t_destructive_git_restore_and_separated_flags_fail
test_case "破壊的でない git（reset --mixed 等）は通る (#557)" t_non_destructive_git_forms_still_pass
test_case "destructive git: -f が先頭でない形も落ちる (#557)" t_destructive_git_force_flag_not_first_fails
test_case "行末コメントの中の -f は落とさない (#557)" t_force_flag_in_trailing_comment_is_not_flagged
test_case "destructive git outside scripts/ is allowed (#542)" t_destructive_git_outside_scripts_is_allowed
test_case "destructive git in a comment is allowed (#542)" t_destructive_git_in_comments_is_allowed

test_case "fixture に Google API キー（AIza…）→ fail (#785)" t_fixture_google_maps_key_fails
test_case "fixture に AIza…（クエリ文字列の外）→ fail (#785/#762)" t_fixture_google_key_outside_query_string_fails
test_case "fixture に ?token=<長い値> → fail (#750)" t_fixture_query_token_fails
test_case "サニタイズ済み（REDACTED）の fixture は通る (#785)" t_sanitized_fixture_passes
test_case "普通のクエリ文字列の fixture は通る (#785)" t_ordinary_fixture_query_strings_pass
test_case "fixture-secret: 母数を出す (#757)" t_fixture_secret_denominator_is_reported
test_case "fixture-secret: ETL ありでフィクスチャ 0 本は error (#757)" t_fixture_secret_zero_files_with_etl_is_an_error
test_case "fixture-secret: ETL 無しなら 0 本は正常、母数は出す (#757)" t_fixture_secret_zero_files_without_etl_passes
test_case "fixture-secret: 対象は fixtures のみ (#785)" t_fixture_secret_scope_is_fixtures_only

echo; echo "passed: $PASS  failed: $FAIL"
[[ $FAIL == 0 ]]
