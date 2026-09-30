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
# 個人アドレス（#1111）: **このファイルにも実在のアドレスは書かない。**
# ローカル部は架空（`taro.yamada`）、ドメインだけが実在の個人メール提供者。組み立てて作る。
MAILDOM_G="g""mail.com"           # 事故 3 件（#1092 / #1103 / #1108）のドメインはすべてこれ
MAILDOM_Y="ya""hoo.co.jp"
PERSONAL_ADDR="taro.yamada@$MAILDOM_G"

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

# ---- #1123: index と枝を壊す形（両方のゲートを素通りしていた） -----------------------------------
#
# **`git rm -r --cached .` は 2 つのゲートを両方素通りした**（origin/main で実測。#1115 のレビュー）:
#   ゲート 1（`scripts/po/test/worktree-audit.test.sh` の allowlist）は
#     **その筋書きで実行された git しか見ない**ので、到達しない枝に書くと見えない
#     （実測: `unreadable` 枝に入れて `passed: 21  failed: 0`）。
#   ゲート 2（この規則）は **`git rm` という語を持っていなかった**
#     （実測: 候補 25 形のうち HIT 5 / MISS 20。`reset --hard` `clean` `checkout --force`
#      `restore` `stash` の 5 形だけを持っていた）。
# **`git rm -r --cached .` は追跡を全部外す**——作業ファイルは残るが、次のコミットが全削除になる。
# **#1057 の事故そのもの**（引き継いだ worktree の staged が他人の成果物を消す）。
#
# ここで足す形はすべて「未コミットの作業／他人の成果物が実際に失われる」ことを根拠にしている:
#   git rm --cached / -r / -f    index から外す・作業ファイルを消す（`--cached` は次のコミットで全削除）
#   git worktree remove          ツリーごと消す（未 push の成果物が消える。#1087 で実際に消える寸前だった）
#   git update-ref -d            参照を消す（そのコミットが到達不能になる）
#   git branch -D                マージしていない枝を消す（-d と違い確認しない）
t_destructive_git_index_and_ref_forms_fail() {
  local i=0 form
  for form in "$G rm -r --cached ." "$G rm --cached file" "$G rm -rf --cached ." \
              "$G rm --cached -r ." "$G rm -f file" "$G rm -q data/old.json" \
              "$G worktree remove /path/to/wt" "$G worktree remove --force /path/to/wt" \
              "$G update-ref -d refs/heads/x" "$G branch -D mybranch" "$G branch -D -r origin/x"; do
    i=$((i+1)); repo "dgi$i"; add scripts/dev/harness.sh "$form"; run
    assert_eq 1 "$STATUS" "[$form] → fail: $OUT"
    assert_contains "$OUT" "destructive-git" "[$form] rule name"
    assert_contains "$OUT" "scripts/dev/harness.sh" "[$form] names the file"
  done
}
# **足しすぎていないこと。** ここに並ぶ形は「未コミットの作業を 1 つも失わない」ので落としてはいけない
# （落とすと正当な使い方が止まり、誰かがこの規則ごと外す——#557 で得た教訓）。
#   git worktree list / add      一覧を出す・作る（`worktree-audit.sh` が実際に呼ぶ形）
#   git worktree prune           **消えたツリーの登録だけ**を掃除する（作業ツリーには触らない。
#                                作法（developer.md）が幽霊 worktree の掃除にこれを薦めている）
#   git branch -d                マージ済みでなければ git 自身が断る
#   git update-ref refs/… <sha>  参照を進める（-d が無ければ消さない）
#   git rm --dry-run / -n        何もしない
t_destructive_git_index_and_ref_safe_forms_pass() {
  local i=0 form
  for form in "$G worktree list --porcelain" "$G worktree add /path -b feat/x origin/main" \
              "$G worktree prune" "$G worktree unlock /path" "$G branch -d mybranch" \
              "$G branch --list" "$G update-ref refs/heads/x HEAD" \
              "$G rm --dry-run --cached ." "$G rm -n --cached ."; do
    i=$((i+1)); repo "dgs$i"; add scripts/x.sh "$form"; run
    assert_eq 0 "$STATUS" "[$form] → pass: $OUT"
  done
}
# ---- #1123 レビュー: `git` の前置きオプションを挟むと全形が素通りしていた ------------------------
#
# **`git +(` はサブコマンドが `git` の直後に来ることを要求する。** **前置きオプションが入ると全滅した。**
# **これは #1123 が作った穴ではなく、#542 からずっと在った**（`reset --hard` / `clean` /
# `restore` / `stash` / `checkout -f` も同じく素通りした。実測 18 形で HIT 3 / MISS 15）。
#
# **とりわけ危ないのは `-C <path>`**: **問題の当事者 `scripts/po/worktree-audit.sh` は
# git 呼び出し 5 本中 4 本が `git -C "$path"` 形**である。
# **#1057 をあのファイルに書き込む最も自然な形が、規則に掛からなかった。**
#
# **前置きオプションの一覧は git(1) の「OPTIONS」から採った**（値を取るもの／取らないものを分けて
# 書く必要がある: `-C <path>` は次の語を食うが `--no-pager` は食わない）。
t_destructive_git_global_options_do_not_shield() {
  local i=0 form
  for form in "$G -C \"\$p\" rm -r --cached ." "$G --git-dir=/x rm -r --cached ." \
              "$G -c user.name=x rm -r --cached ." "$G --no-pager rm -r --cached ." \
              "$G -C /a -C /b rm -r --cached ." "$G --no-pager -C \"\$p\" rm --cached ." \
              "$G -C \"\$p\" reset --hard" "$G -C \"\$p\" clean -xfd" \
              "$G -C \"\$p\" restore ." "$G -C \"\$p\" stash" "$G -C \"\$p\" checkout -f ." \
              "$G --work-tree=/x reset --hard" "$G -P rm --cached ." \
              "$G --exec-path=/x rm --cached ." "$G -C \"\$p\" update-ref -d refs/heads/x"; do
    i=$((i+1)); repo "dgg$i"; add scripts/dev/harness.sh "$form"; run
    assert_eq 1 "$STATUS" "[$form] → fail: $OUT"
    assert_contains "$OUT" "destructive-git" "[$form] rule name"
  done
}
# **例外を持つ形（`worktree remove` / `branch -D`）も同じ穴を持っていた。** 別 regex なので別に固定する。
t_destructive_git_global_options_do_not_shield_sweep_forms() {
  local i=0 form
  for form in "$G -C \"\$p\" worktree remove /x" "$G -C \"\$p\" branch -D foo" \
              "$G --no-pager worktree remove /x" "$G -c core.x=1 branch -D foo"; do
    i=$((i+1)); repo "dggs$i"; add scripts/po/other-tool.sh "$form"; run
    assert_eq 1 "$STATUS" "[$form] → fail: $OUT"
    assert_contains "$OUT" "destructive-git" "[$form] rule name"
  done
}
# **前置きオプションを許したことで、無害な形を落としていないこと**（足しすぎの検査）。
# **`-C` は次の語を食う**ので、`git -C /x status` の `status` をサブコマンドとして読めること
# ——読めなければ「`-C` の値」と「サブコマンド」の境界がずれている。
t_destructive_git_global_options_keep_safe_forms_passing() {
  local i=0 form
  for form in "$G -C \"\$p\" status --porcelain" "$G -C \"\$p\" worktree list --porcelain" \
              "$G -C \"\$p\" diff --cached --name-status" "$G -C \"\$p\" log -1 --format=%ct" \
              "$G -C \"\$p\" rev-parse --git-path index" "$G -C \"\$p\" branch -d foo" \
              "$G -C \"\$p\" reset --mixed" "$G -C \"\$p\" rm --dry-run --cached ." \
              "$G -c user.name=x commit --amend --no-edit" "$G --no-pager log -1"; do
    i=$((i+1)); repo "dggp$i"; add scripts/x.sh "$form"; run
    assert_eq 0 "$STATUS" "[$form] → pass: $OUT"
  done
}
# ---- #1123 レビュー: regex は持っていたがテストが固定していなかった 2 形（#557 と同じ型） -------
#
# **`branch +$MID-[A-Za-z]*D[A-Za-z]*` を `-D` に、`(-d|--delete)` を `(-d)` に縮めても
# 54/0 緑だった**（レビュアーの実測）。**regex が持っているだけでは守りにならない。**
# **`git branch -rD foo` は実際に消す**（`-r` と `-D` が融合した形）。
t_destructive_git_fused_and_long_flags_fail() {
  local i=0 form
  for form in "$G branch -rD foo" "$G branch -Dr foo" "$G branch --delete --force foo" \
              "$G update-ref --delete refs/heads/x" "$G worktree remove --force /x" \
              "$G clean -xfd" "$G clean -fdx" "$G clean -dxf" "$G rm -rf --cached ."; do
    i=$((i+1)); repo "dgfl$i"; add scripts/po/other-tool.sh "$form"; run
    assert_eq 1 "$STATUS" "[$form] → fail: $OUT"
    assert_contains "$OUT" "destructive-git" "[$form] rule name"
  done
}
# **正当な用途の例外は 1 ファイルだけ、しかも「そのファイルの存在理由がそれ」であるものに限る。**
# `scripts/po/worktree-sweep.sh` は**マージ済みの worktree を片付けるための道具**なので、
# `git worktree remove` と `git branch -D` がその本体である（#726）。**例外はこのファイルだけ。**
# **他のファイルに同じ行を書いたら落ちる**ことを、同じ 2 形で対にして固定する
# （例外が「どこでも通る」方向に広がったら、この対が崩れる）。
t_destructive_git_worktree_sweep_is_the_only_exception() {
  local i=0 form
  for form in "$G worktree remove \"\$path\"" "$G branch -D \"\$branch\""; do
    i=$((i+1))
    repo "dgx$i"; add scripts/po/worktree-sweep.sh "$form"; run
    assert_eq 0 "$STATUS" "[$form] worktree-sweep.sh では通る: $OUT"
    repo "dgy$i"; add scripts/po/other-tool.sh "$form"; run
    assert_eq 1 "$STATUS" "[$form] 別のファイルでは落ちる: $OUT"
    assert_contains "$OUT" "destructive-git" "[$form] rule name"
  done
}
# ---- #1123 レビュー後: `$GLOBAL` を足してあらわになった正当な用途（3 ファイル 6 行） -------------
#
# **`git -C` 形を読めるようにしたら、旧規則が見逃していた真陽性 6 行が出た**（偽陽性ではない）。
# **例外は「ファイル × 形」の組で与える。** ファイルだけ／形だけでは広すぎる。
# **対にして固定する**: 例外のファイルでは通り、**別のファイルでは同じ行が落ちる**。
t_destructive_git_per_file_form_exceptions() {
  local i=0
  # merge-when-green.sh: **自分が作った一時 worktree** を後片付けする（担当者のツリーではない）
  i=$((i+1)); repo "dgpf$i"; add scripts/po/merge-when-green.sh "$G -C \"\$root\" worktree remove --force \"\$wt\""; run
  assert_eq 0 "$STATUS" "merge-when-green の worktree remove は通る: $OUT"
  i=$((i+1)); repo "dgpf$i"; add scripts/po/other.sh "$G -C \"\$root\" worktree remove --force \"\$wt\""; run
  assert_eq 1 "$STATUS" "別ファイルの worktree remove は落ちる: $OUT"
  # mutate.test.sh: **「他人の stash を奪わない」ことを確かめる検査**が使い捨て repo に stash を積む
  i=$((i+1)); repo "dgpf$i"; add scripts/dev/test/mutate.test.sh "$G -C \"\$R\" stash -q -u"; run
  assert_eq 0 "$STATUS" "mutate.test.sh の stash は通る: $OUT"
  i=$((i+1)); repo "dgpf$i"; add scripts/dev/test/other.test.sh "$G -C \"\$R\" stash -q -u"; run
  assert_eq 1 "$STATUS" "別ファイルの stash は落ちる: $OUT"
  # **形は混ざらない**: stash の例外ファイルに worktree remove を書いたら落ちる（逆も同じ）
  i=$((i+1)); repo "dgpf$i"; add scripts/dev/test/mutate.test.sh "$G worktree remove /x"; run
  assert_eq 1 "$STATUS" "stash 例外のファイルでも worktree remove は落ちる: $OUT"
  i=$((i+1)); repo "dgpf$i"; add scripts/po/merge-when-green.sh "$G stash"; run
  assert_eq 1 "$STATUS" "worktree remove 例外のファイルでも stash は落ちる: $OUT"
  # **例外は「その形」だけ**: どの例外ファイルでも `git rm` は落ちる
  local f
  for f in scripts/po/worktree-sweep.sh scripts/po/merge-when-green.sh scripts/dev/test/mutate.test.sh; do
    i=$((i+1)); repo "dgpf$i"; add "$f" "$G rm -r --cached ."; run
    assert_eq 1 "$STATUS" "[$f] 例外ファイルでも $G rm は落ちる: $OUT"
  done
}
# **例外の穴（実装中に実測で踏んだ）**: 例外を「行」で外す形にすると、**例外の語と別の破壊的な形を
# 1 行に同居させるだけで、行ごと落ちて素通りする**。`grep` は行単位なので、この穴は
# 「行を外す」設計に必ず付いてくる。**実測した素通り**（origin/main ではなく、この PR の途中の実装で）:
#   scripts/po/worktree-sweep.sh に
#   `git rm -r --cached .; git reset --hard; git worktree remove --force /x` → **clean**
# **いまは例外の在る形を別の正規表現に分け、一般の形からは 1 ファイルも外していない**ので落ちる。
t_destructive_git_exception_does_not_shield_the_same_line() {
  local i=0 form
  for form in "$G rm -r --cached .; $G worktree remove /x" \
              "$G worktree remove /x; $G reset --hard" \
              "$G branch -D x && $G rm --cached ." \
              "$G worktree remove /x  # $G rm はここでは使わない"; do
    i=$((i+1)); repo "dgh$i"; add scripts/po/worktree-sweep.sh "$form"; run
    assert_eq 1 "$STATUS" "[$form] 例外のファイルでも同居は落ちる: $OUT"
    assert_contains "$OUT" "destructive-git" "[$form] rule name"
  done
}
# **行末コメントの中のサブコマンドは落ちる**（**既存の振る舞い。#1123 が変えたものではない**）。
# 実測して確かめた: origin/main の `reset +--hard` も同じで、
# `git checkout main  # git reset --hard は使わない` は**落ちる**。
# **`MID` が `#` を除くのは「フラグを探す範囲」の話**で、**サブコマンド名そのものには効かない**
# （`git reset --hard` / `git rm` は `MID` を通らずに直接並んでいる）。
# **行頭コメント（`# …`）だけが通る**（`grep -v '^[^:]+:[0-9]+: *#'` が落としている）。
# **この非対称を固定しておく**——次の人が「コメントなら通るはず」と考えて穴を作らないため。
t_destructive_git_subcommand_in_trailing_comment_is_flagged() {
  local i=0 form
  for form in "$G checkout main  # $G reset --hard は使わない" \
              "echo ok  # $G rm --cached は使わない"; do
    i=$((i+1)); repo "dgt$i"; add scripts/x.sh "$form"; run
    assert_eq 1 "$STATUS" "[$form] 行末コメントの中でも落ちる（既存の振る舞い）: $OUT"
  done
  # 行頭コメントは通る（対比）
  repo dgt0; add scripts/x.sh "# $G rm --cached は使わない（#1123）"; run
  assert_eq 0 "$STATUS" "行頭コメントは通る: $OUT"
}
# `worktree-sweep.sh` は**失敗したときのログ文**に `git worktree remove` という語を含む（124 行目）。
# **呼び出しではない**ので落としてはいけない。**例外はこのファイル全体なので通る**が、
# **例外が無いファイルでログ文に書いた場合は落ちる**——それは受け入れる（語を書かずに
# `log "片付けに失敗しました"` と書けばよい。**偽陽性の代償は 1 行の書き換えで済む**）。
t_destructive_git_sweep_log_message_passes() {
  repo dgl
  add scripts/po/worktree-sweep.sh "log \"残す \$path (\$branch): $G worktree remove が失敗しました\""
  run
  assert_eq 0 "$STATUS" "例外ファイルのログ文は通る: $OUT"
}
# **母数（#757）**: 「0 件」と「1 本も見ていない」を同じ緑にしない。
# `GIT_FILES` のパスの綴りが変わったり `ls-files` が空を返したりすると、
# **静的検査は「全部の行を見る」という前提のほうが先に壊れる**。件数は常に出す。
t_destructive_git_prints_denominator() {
  repo dgn; add scripts/a.sh "echo ok"; add deploy/b.sh "echo ok"; add docs/c.md "docs"; run
  assert_eq 0 "$STATUS" "exit: $OUT"
  # scripts/a.sh と deploy/b.sh の 2 本だけが対象（README.md と docs/c.md は対象外）
  assert_contains "$OUT" "destructive-git: 2 file(s) scanned" "母数を出す"
}
# **対象が 0 本なら、それは clean ではない**（fixture-secret が #757 で通った道と同じ）。
# `scripts/` `deploy/` `.github/` のどれかが在るのに 0 本になったら、走査対象の抽出が壊れている。
# **この repo では起こり得ない**（125 本在る。実測）が、**0 本を緑で通すと気づけない。**
t_destructive_git_zero_files_is_not_clean() {
  repo dgz; add docs/only.md "何も走査対象が無い repo"; run
  assert_eq 0 "$STATUS" "対象ディレクトリが 1 つも無ければ 0 本が正しい: $OUT"
  assert_contains "$OUT" "destructive-git: 0 file(s) scanned" "0 本でも母数は出す"
}
# ---- #1123 レビュー: 走査範囲を「ディレクトリ」から「シェルスクリプトであること」に広げた -------
#
# **3 ディレクトリだけを見ていたのに「全行を見る」と書いていた**（#1122 と同じ型）。
# **レビュアーの実測**: `packages/etl/test/mutants/comparator-shape.mutants.sh`（**追跡された `.sh`**）に
# `git rm -r --cached .` を入れると **clean で素通り**した。
# **そのファイルはまさに変異ハーネスの記録**であり、**`destructive-git` が最も守るべき種類**である
# （#542 の事故 3 件はすべて変異ハーネスだった）。
# **広げる代償は 1 本だけだと先に数えた**（3 ディレクトリの外の追跡 `.sh` は実測 1 本:
# `packages/etl/test/mutants/comparator-shape.mutants.sh`）。
#
# **`packages/etl/` を含むパスはここでは使わない**（実測で踏んだ）: `fixture-secret` 規則（#757）が
# **`packages/etl/` が在るのに `test/fixtures/` が 0 本なら exit 2** にするので、
# **この検査の合否が別の規則に乗っ取られる。** 見たいのは走査範囲だけなので、
# **同じ「3 ディレクトリの外の `.sh`」を別の場所で作る。**
t_destructive_git_covers_shell_scripts_outside_the_three_dirs() {
  local i=0 f
  for f in test/mutants/comparator-shape.mutants.sh apps/web/tools/helper.sh tools/x.sh a.sh; do
    i=$((i+1)); repo "dgsh$i"; add "$f" "$G rm -r --cached ."; run
    assert_eq 1 "$STATUS" "[$f] → fail: $OUT"
    assert_contains "$OUT" "destructive-git" "[$f] rule name"
    assert_contains "$OUT" "$f" "[$f] names the file"
  done
}
# **広げすぎていないこと。** **`docs/` は依然として対象外**（この規則の理由を文章で書けなくなる。
# #542 の設計。`docs/` 配下の `.sh` もそのまま対象外にしてある——手順書に例を置く余地を残す）。
# **`.sh` でない追跡ファイルも対象外**（`.ts` / `.md` / `.json`。**追跡 10,430 本を全部見るわけではない**）。
t_destructive_git_does_not_cover_docs_or_non_shell() {
  local i=0 f
  for f in docs/ops/example.sh docs/WORKING_AGREEMENT.md src/a.ts README.md notes.txt; do
    i=$((i+1)); repo "dgns$i"; add "$f" "$G rm -r --cached ."; run
    assert_eq 0 "$STATUS" "[$f] → pass（対象外）: $OUT"
  done
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


# ── personal-address（#1111）─────────────────────────────────────────────
# 2026-09-28 に 3 本の PR が計 7 行の個人アドレスを追跡ファイルに入れかけた（#1092 1 / #1103 1 / #1108 5）。
# 3 本ともレビュアーが見つけた。gitleaks も forbidden-patterns も 1 件も落としていない。

# 1. 事故 3 件が実際に書いた 3 つの形（散文 / コード文字列 / 表の行）をそれぞれ落とす。
t_personal_address_prose_string_and_table_fail() {
  repo pa
  add "packages/etl/test/fixtures/tokushima/ok.html" "<p>ok</p>"   # #757 の母数 error を避けるため
  add "docs/WORKING_AGREEMENT.md" " * **\`$PERSONAL_ADDR\`（利用者本人の個人アドレス）はここに書かない。**"
  add "packages/etl/test/x.test.ts" "    \"$PERSONAL_ADDR\", // 利用者本人"
  add "docs/ops/notes.md" " * $PERSONAL_ADDR   github.com/sakai          id=15643"
  run
  assert_eq 1 "$STATUS" "exit"
  assert_contains "$OUT" "personal-address" "rule named"
  assert_contains "$OUT" "docs/WORKING_AGREEMENT.md" "散文の形（#1103 が書いた形）"
  assert_contains "$OUT" "packages/etl/test/x.test.ts" "コード文字列の形（#1108 が書いた形）"
  assert_contains "$OUT" "docs/ops/notes.md" "表の行の形（#1108 が書いた形）"
  assert_not_contains "$OUT" "$PERSONAL_ADDR" "アドレス本体はログに出さない（出したらログが事故になる）"
}

# 2. `Name <addr>` の形（#1092 が書いた形。git の author 表記をそのまま貼ると必ずこうなる）
t_personal_address_in_author_notation_fails() {
  repo paauth
  # **名前も SHA も架空にする**（#1126 レビュー）——最初ここに実在コミットの SHA と
  # 利用者本人の実名を書いていた。**個人アドレスを止める検査が、個人の実名を入れていた。**
  add "docs/ops/board-audit-log.tsv" "0000000 の author → Taro Yamada <$PERSONAL_ADDR>"
  run
  assert_eq 1 "$STATUS" "exit (#1092 が書いた author 表記の形)"
  assert_contains "$OUT" "docs/ops/board-audit-log.tsv" "file named"
}

# 3. **偽陽性の検査（これが無いと使えない）**: 架空アドレスは素通りする。
#    綴りは packages/etl/test/fake-addresses.ts が 1 か所で持つ（#1111）。
t_fake_addresses_pass() {
  repo pafake
  add "packages/etl/test/fixtures/tokushima/ok.html" "<p>ok</p>"   # #757 の母数 error を避けるため
  add "packages/etl/test/a.test.ts" 'const A = ["person@example.com", "x@example.com", "bot@claude.ai", "x@example.invalid", "noreply@anthropic.com", "someone@example.com", "t@example.invalid", "a.b_c%d+e-f@example.com"];'
  add "docs/x.md" "連絡先は 120390190+uonoko1@users.noreply.github.com（数字 ID 付き noreply）"
  run
  assert_eq 0 "$STATUS" "架空アドレスと noreply は素通りする: $OUT"
}

# 4. 第三者の実在アドレスのうち、**機関の連絡先**は落とさない。
#    フィクスチャの県庁 HTML には lg.jp の窓口アドレスが入っている（実測: 10 ファイル）。
#    これを落とすと、直した人が検査ごと外す。
t_institutional_addresses_pass() {
  repo painst
  add "packages/etl/test/fixtures/tokushima/gaiyou.html" '<a href="mailto:gikai@pref.tokushima.lg.jp">議会事務局</a>'
  add "apps/web/app/lib/x.ts" 'const CSS = "rtal_m@d.css";'
  run
  assert_eq 0 "$STATUS" "機関アドレスと CSS の断片は通す: $OUT"
}

# 5. 別の個人メール提供者でも落ちる（規則が 1 ドメインの逐語になっていないこと）。
t_personal_address_other_consumer_domain_fails() {
  repo paoth; add "docs/a.md" "author: hanako.suzuki@$MAILDOM_Y"
  run
  assert_eq 1 "$STATUS" "exit (提供者が変わっても落ちる)"
  assert_contains "$OUT" "personal-address" "rule named"
}

# 6. 大文字小文字を変えても落ちる（貼り直しで綴りが揺れる）。
t_personal_address_is_case_insensitive() {
  repo pacase; add "docs/a.md" "TARO.YAMADA@$(printf '%s' "$MAILDOM_G" | tr '[:lower:]' '[:upper:]')"
  run
  assert_eq 1 "$STATUS" "exit (大文字でも落ちる)"
}

# 6b. **ローカル部が短くても落ちる**（#1126 レビューで見つかった素通り）。
#     **ローカル部の量指定子を `+` → `{3,}` に狭める変異が 43 件を全部緑で通り抜けた**——
#     **フィクスチャのローカル部が全部 3 文字以上だったため。** 1〜2 文字を明示的に置く。
t_personal_address_short_local_part_fails() {
  repo pashort
  add "docs/a.md" "a@$MAILDOM_G"
  add "docs/b.md" "ab@$MAILDOM_G"
  run
  assert_eq 1 "$STATUS" "exit (1〜2 文字のローカル部でも落ちる)"
  assert_contains "$OUT" "docs/a.md" "1 文字のローカル部"
  assert_contains "$OUT" "docs/b.md" "2 文字のローカル部"
}

# 6c. **末尾が英文のピリオドでも落ちる**（#1126 レビュー。PO も再現）。
#     **英文で最もふつうの形（文末ピリオド）が素通りしていた**——境界が `.` を除いていたため。
t_personal_address_trailing_period_fails() {
  repo padot
  add "docs/a.md" "連絡先は taro.yamada@$MAILDOM_G."
  add "docs/b.md" "連絡先は taro.yamada@$MAILDOM_G。"
  add "docs/c.md" "連絡先は taro.yamada@$MAILDOM_G"
  run
  assert_eq 1 "$STATUS" "exit (文末ピリオド・句点・境界なしの 3 形すべて)"
  assert_contains "$OUT" "docs/a.md" "英文の文末ピリオド（これが素通りしていた）"
  assert_contains "$OUT" "docs/b.md" "日本語の句点"
  assert_contains "$OUT" "docs/c.md" "境界なし"
}

# 6d. 提供者名で始まる**別の**ドメインは落とさない（境界から `.` を外した副作用の確認）。
t_domain_with_extra_letters_is_not_flagged() {
  repo paext; add "docs/a.md" "taro@${MAILDOM_G}x への連絡"
  run
  assert_eq 0 "$STATUS" "提供者名で始まるだけの別ドメインは落とさない: $OUT"
}

# 7. 母数（#757 と同じ作法）: 走査した追跡ファイル数を必ず出す。
#    「0 件検出」と「1 本も読めていない」を同じ緑にしない。
t_personal_address_denominator_is_reported() {
  repo paden; add "src/a.ts" "export const x = 1;"
  run
  assert_eq 0 "$STATUS" "exit"
  assert_contains "$OUT" "personal-address:" "母数を出す"
  assert_contains "$OUT" "file(s) scanned" "母数の単位"
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
test_case "destructive git: rm --cached / worktree remove / update-ref -d / branch -D も落ちる (#1123)" t_destructive_git_index_and_ref_forms_fail
test_case "worktree list/add/prune・branch -d・rm --dry-run は通る (#1123)" t_destructive_git_index_and_ref_safe_forms_pass
test_case "git の前置きオプション（-C 等）で素通りしない (#1123 レビュー)" t_destructive_git_global_options_do_not_shield
test_case "前置きオプション: worktree remove / branch -D も素通りしない (#1123 レビュー)" t_destructive_git_global_options_do_not_shield_sweep_forms
test_case "前置きオプションを許しても無害な形は通る (#1123 レビュー)" t_destructive_git_global_options_keep_safe_forms_passing
test_case "融合フラグ（-rD）と長い綴り（--delete --force）も落ちる (#1123 レビュー)" t_destructive_git_fused_and_long_flags_fail
test_case "worktree remove / branch -D の例外は worktree-sweep.sh だけ (#1123)" t_destructive_git_worktree_sweep_is_the_only_exception
test_case "例外は「ファイル × 形」の組で、形は混ざらない (#1123 レビュー)" t_destructive_git_per_file_form_exceptions
test_case "例外の語と同居させても素通りしない (#1123)" t_destructive_git_exception_does_not_shield_the_same_line
test_case "行末コメントの中のサブコマンドは落ちる（既存の振る舞い） (#1123)" t_destructive_git_subcommand_in_trailing_comment_is_flagged
test_case "worktree-sweep.sh のログ文は通る (#1123)" t_destructive_git_sweep_log_message_passes
test_case "destructive git: 母数を出す (#1123/#757)" t_destructive_git_prints_denominator
test_case "destructive git: 対象 0 本でも母数を出す (#1123/#757)" t_destructive_git_zero_files_is_not_clean
test_case "3 ディレクトリの外の .sh も見る (#1123 レビュー)" t_destructive_git_covers_shell_scripts_outside_the_three_dirs
test_case "docs/ と .sh でないものは対象外のまま (#1123 レビュー)" t_destructive_git_does_not_cover_docs_or_non_shell

test_case "fixture に Google API キー（AIza…）→ fail (#785)" t_fixture_google_maps_key_fails
test_case "fixture に AIza…（クエリ文字列の外）→ fail (#785/#762)" t_fixture_google_key_outside_query_string_fails
test_case "fixture に ?token=<長い値> → fail (#750)" t_fixture_query_token_fails
test_case "サニタイズ済み（REDACTED）の fixture は通る (#785)" t_sanitized_fixture_passes
test_case "普通のクエリ文字列の fixture は通る (#785)" t_ordinary_fixture_query_strings_pass
test_case "fixture-secret: 母数を出す (#757)" t_fixture_secret_denominator_is_reported
test_case "fixture-secret: ETL ありでフィクスチャ 0 本は error (#757)" t_fixture_secret_zero_files_with_etl_is_an_error
test_case "fixture-secret: ETL 無しなら 0 本は正常、母数は出す (#757)" t_fixture_secret_zero_files_without_etl_passes
test_case "fixture-secret: 対象は fixtures のみ (#785)" t_fixture_secret_scope_is_fixtures_only

test_case "個人アドレス: 散文・コード文字列・表の行 → fail (#1111)" t_personal_address_prose_string_and_table_fail
test_case "個人アドレス: Name <addr> の author 表記 → fail (#1111/#1092)" t_personal_address_in_author_notation_fails
test_case "架空アドレス（example.com / claude.ai / example.invalid / noreply）は素通り (#1111)" t_fake_addresses_pass
test_case "機関の連絡先（lg.jp）と CSS の断片は素通り (#1111)" t_institutional_addresses_pass
test_case "個人アドレス: 別の提供者でも fail (#1111)" t_personal_address_other_consumer_domain_fails
test_case "個人アドレス: 大文字小文字を問わない (#1111)" t_personal_address_is_case_insensitive
test_case "個人アドレス: 1〜2 文字のローカル部でも fail (#1126 レビュー)" t_personal_address_short_local_part_fails
test_case "個人アドレス: 英文の文末ピリオドでも fail (#1126 レビュー)" t_personal_address_trailing_period_fails
test_case "提供者名で始まるだけの別ドメインは落とさない (#1126 レビュー)" t_domain_with_extra_letters_is_not_flagged
test_case "personal-address: 母数を出す (#1111/#757)" t_personal_address_denominator_is_reported

echo; echo "passed: $PASS  failed: $FAIL"
[[ $FAIL == 0 ]]
