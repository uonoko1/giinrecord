# shellcheck shell=bash
# Tests for scripts/po/worktree-audit.sh (sourced by run.sh)
#
# **これは「消す」道具ではなく「見る」道具**なので、検査の重心は
#   「危ないものを危ないと言えているか」（取りこぼしが事故になる）に置く。
# **道具自身が破壊的な git を 1 つも呼ばないこと**も検査する（$LOG で見る）。
#
# **ハンドラは別プロセスで source されるので、共通のシェル関数は見えない。**
# `git worktree list --porcelain` の出力は各ハンドラの中に直接書く（最初のブロックがメイン）。

# 実在のツリーを作らずに済むよう、`worktree-audit.sh` は
#   `AUDIT_NOW`（現在時刻の epoch 秒）と `git -C <path> log -1 --format=%ct`
# で「最終更新時刻」を取る。テストはその 2 つを固定する。

t_audit_flags_staged_deletions() {
  local h; h=$(handler <<'EOF'
git_handle() {
  case "$*" in
    "worktree list --porcelain") printf '%s\n' \
      "worktree /repo" "branch refs/heads/main" "" \
      "worktree /wt/deleter" "branch refs/heads/fix/deleter" "" \
      "worktree /wt/modder" "branch refs/heads/fix/modder" "" ;;
    # **#1057 で PO が踏みかけた形**: マージ済み main の 10 件が「削除」として index に乗る
    "-C /wt/deleter status --porcelain") printf '%s\n' \
      "D  .github/workflows/pr-body.yml" "D  data/unmatched/202.json" "M  src/a.ts" ;;
    "-C /wt/deleter diff --cached --name-status") printf '%s\n' \
      "D	.github/workflows/pr-body.yml" "D	data/unmatched/202.json" "M	src/a.ts" ;;
    # 変更だけ（上書きされるだけなので、削除と同じ重さではない）
    "-C /wt/modder status --porcelain") printf '%s\n' "M  src/b.ts" ;;
    "-C /wt/modder diff --cached --name-status") printf '%s\n' "M	src/b.ts" ;;
    *"log -1 --format=%ct") echo 1000000 ;;
    *) ;;
  esac
}
handle() { echo '[]'; }
EOF
)
  AUDIT_NOW=9000000 run_script "$h" worktree-audit.sh
  assert_eq 3 "$STATUS" "**staged の削除が在れば異常終了する（PO が気づける）**: $ERR"
  assert_contains "$ERR" "/wt/deleter" "危ないツリーを名指しする"
  assert_contains "$ERR" "削除が staged" "**D を D として言う**"
  assert_contains "$ERR" "2 件" "**D の件数を数える（3 件でも 1 件でもない）**"
  assert_contains "$ERR" ".github/workflows/pr-body.yml" "**どのファイルが消えるかを挙げる**"
  assert_contains "$ERR" "data/unmatched/202.json" "**挙げるのは 1 件目だけでない**"
  # M は同じ重さではない（削除として数えない）
  assert_not_contains "$ERR" "/wt/modder: 削除が staged" "**M を D と同じに扱わない**"
}
test_case "audit: staged の削除を名指しして異常終了する (#1057)" t_audit_flags_staged_deletions

t_audit_separates_m_from_d() {
  local h; h=$(handler <<'EOF'
git_handle() {
  case "$*" in
    "worktree list --porcelain") printf '%s\n' \
      "worktree /repo" "branch refs/heads/main" "" \
      "worktree /wt/modder" "branch refs/heads/fix/modder" "" ;;
    "-C /wt/modder status --porcelain") printf '%s\n' "M  src/b.ts" "A  src/c.ts" ;;
    "-C /wt/modder diff --cached --name-status") printf '%s\n' "M	src/b.ts" "A	src/c.ts" ;;
    *"log -1 --format=%ct") echo 1000000 ;;
    *) ;;
  esac
}
handle() { echo '[]'; }
EOF
)
  AUDIT_NOW=9000000 run_script "$h" worktree-audit.sh
  # **M/A だけなら異常終了させない**。鳴り続ける監視にしない（#978）
  assert_eq 0 "$STATUS" "**M/A だけでは異常終了しない（鳴り続ける監視にしない）**: $ERR"
  assert_contains "$ERR" "staged 2 件" "staged の総数は出す"
  assert_contains "$ERR" "削除 0" "**削除が 0 であることを明示する（数えていないと区別する）**"
}
test_case "audit: M/A は D と同じ重さにしない (#1057)" t_audit_separates_m_from_d

t_audit_flags_unmerged() {
  local h; h=$(handler <<'EOF'
git_handle() {
  case "$*" in
    "worktree list --porcelain") printf '%s\n' \
      "worktree /repo" "branch refs/heads/main" "" \
      "worktree /wt/conflict" "branch refs/heads/rev/1032" "" ;;
    # **今日 rev1032/wt に実在した形**: UU が 1 件（レビュアーがコンフリクト解決中）
    "-C /wt/conflict status --porcelain") printf '%s\n' \
      "UU scripts/ci/test/pr-closes.test.sh" "M  src/a.ts" ;;
    "-C /wt/conflict diff --cached --name-status") printf '%s\n' "M	src/a.ts" ;;
    *"log -1 --format=%ct") echo 1000000 ;;
    *) ;;
  esac
}
handle() { echo '[]'; }
EOF
)
  AUDIT_NOW=9000000 run_script "$h" worktree-audit.sh
  assert_contains "$ERR" "解決途中" "**U は「作業の途中」として言う**"
  assert_contains "$ERR" "scripts/ci/test/pr-closes.test.sh" "どのファイルが未解決かを挙げる"
  assert_contains "$ERR" "触らないでください" "**触ってはいけないことを言う**"
}
test_case "audit: unmerged (U) があるツリーは触らないと言う (#1057)" t_audit_flags_unmerged

t_audit_reports_recent_activity() {
  local h; h=$(handler <<'EOF'
git_handle() {
  case "$*" in
    "worktree list --porcelain") printf '%s\n' \
      "worktree /repo" "branch refs/heads/main" "" \
      "worktree /wt/live" "branch refs/heads/fix/live" "" \
      "worktree /wt/stale" "branch refs/heads/fix/stale" "" ;;
    "-C /wt/live status --porcelain") printf '%s\n' "M  src/a.ts" ;;
    "-C /wt/live diff --cached --name-status") printf '%s\n' "M	src/a.ts" ;;
    "-C /wt/stale status --porcelain") printf '%s\n' "M  src/b.ts" ;;
    "-C /wt/stale diff --cached --name-status") printf '%s\n' "M	src/b.ts" ;;
    # live は 5 分前、stale は 3 日前
    "-C /wt/live log -1 --format=%ct") echo 8999700 ;;
    "-C /wt/stale log -1 --format=%ct") echo 8740800 ;;
    *) ;;
  esac
}
handle() { echo '[]'; }
EOF
)
  AUDIT_NOW=9000000 run_script "$h" worktree-audit.sh
  assert_contains "$ERR" "作業中かもしれません" "**数分前に動いたツリーは「作業中かもしれない」と言う**"
  assert_contains "$ERR" "/wt/live" "live を名指しする"
  # 3 日前のものには作業中と言わない（そこだけは判断を PO に渡せる）
  local live_line stale_line
  live_line=$(printf '%s\n' "$ERR" | grep -- "/wt/live" || true)
  stale_line=$(printf '%s\n' "$ERR" | grep -- "/wt/stale" || true)
  assert_contains "$live_line" "作業中かもしれません" "live の行に付く"
  assert_not_contains "$stale_line" "作業中かもしれません" "**3 日前のツリーには付けない（毎行に付けたら意味が無い）**"
}
test_case "audit: 最終更新時刻で「作業中かもしれない」を分ける (#1057)" t_audit_reports_recent_activity

t_audit_counts_denominator() {
  local h; h=$(handler <<'EOF'
git_handle() {
  case "$*" in
    "worktree list --porcelain") printf '%s\n' \
      "worktree /repo" "branch refs/heads/main" "" \
      "worktree /wt/a" "branch refs/heads/fix/a" "" \
      "worktree /wt/b" "branch refs/heads/fix/b" "" \
      "worktree /wt/c" "" ;;
    *"status --porcelain") ;;
    *"diff --cached --name-status") ;;
    *"log -1 --format=%ct") echo 1000000 ;;
    *) ;;
  esac
}
handle() { echo '[]'; }
EOF
)
  AUDIT_NOW=9000000 run_script "$h" worktree-audit.sh
  assert_eq 0 "$STATUS" "全部きれいなら 0: $ERR"
  # **母数を出す（#757）。「0 件」と「数えていない」を区別する**
  assert_contains "$ERR" "worktree 4 本" "**母数を出す（メインを含めて数える）**"
  assert_contains "$ERR" "残留 0 本" "0 件であることを明示する"
}
test_case "audit: 母数を必ず出す（0 件と数えていないを分ける） (#1057)" t_audit_counts_denominator

t_audit_covers_detached_head() {
  local h; h=$(handler <<'EOF'
git_handle() {
  case "$*" in
    "worktree list --porcelain") printf '%s\n' \
      "worktree /repo" "branch refs/heads/main" "" \
      "worktree /wt/det" "" ;;
    # **detached HEAD でも残留は起きる**（今日 rev1032/wt も detached だった）
    "-C /wt/det status --porcelain") printf '%s\n' "D  data/members/x.json" ;;
    "-C /wt/det diff --cached --name-status") printf '%s\n' "D	data/members/x.json" ;;
    *"log -1 --format=%ct") echo 1000000 ;;
    *) ;;
  esac
}
handle() { echo '[]'; }
EOF
)
  AUDIT_NOW=9000000 run_script "$h" worktree-audit.sh
  assert_eq 3 "$STATUS" "**detached HEAD でも削除は見逃さない**: $ERR"
  assert_contains "$ERR" "/wt/det" "detached のツリーも調べる"
  assert_contains "$ERR" "data/members/x.json" "消えるファイルを挙げる"
}
test_case "audit: detached HEAD のツリーも調べる (#1057)" t_audit_covers_detached_head

t_audit_never_destroys() {
  local h; h=$(handler <<'EOF'
git_handle() {
  case "$*" in
    "worktree list --porcelain") printf '%s\n' \
      "worktree /repo" "branch refs/heads/main" "" \
      "worktree /wt/bad" "branch refs/heads/fix/bad" "" ;;
    "-C /wt/bad status --porcelain") printf '%s\n' "D  a.ts" "UU b.ts" ;;
    "-C /wt/bad diff --cached --name-status") printf '%s\n' "D	a.ts" ;;
    *"log -1 --format=%ct") echo 8999700 ;;
    *) ;;
  esac
}
handle() { echo '[]'; }
EOF
)
  AUDIT_NOW=9000000 run_script "$h" worktree-audit.sh
  # **まず「本当に走った」ことを確かめる**（走らなければ下の 8 個は空振りで緑になる）
  assert_eq 3 "$STATUS" "D が在るので 3 で終わる: $ERR"
  assert_contains "$LOG" "$(printf '\tstatus\t--porcelain')" "**読む git は呼んでいる（空振りの緑を防ぐ）**"
  # **この道具は 1 つも壊さない。** 読む git だけを呼ぶ
  assert_not_contains "$LOG" "$(printf 'worktree\tremove')" "**worktree remove を呼ばない**"
  assert_not_contains "$LOG" "$(printf '\treset\t')" "**reset を呼ばない**"
  assert_not_contains "$LOG" "$(printf '\tcheckout\t')" "**checkout を呼ばない**"
  assert_not_contains "$LOG" "$(printf '\tclean\t')" "**clean を呼ばない**"
  assert_not_contains "$LOG" "$(printf '\trestore\t')" "**restore を呼ばない**"
  assert_not_contains "$LOG" "$(printf '\tstash')" "**stash を呼ばない（stash はリポジトリ共有）**"
  assert_not_contains "$LOG" "$(printf 'branch\t-D')" "**ブランチを消さない**"
  assert_not_contains "$LOG" "$(printf '\tcommit')" "**commit を呼ばない（それが事故そのもの）**"
}
test_case "audit: 破壊的な git を 1 つも呼ばない (#1057)" t_audit_never_destroys

t_audit_no_gh_dependency() {
  local h; h=$(handler <<'EOF'
git_handle() {
  case "$*" in
    "worktree list --porcelain") printf '%s\n' \
      "worktree /repo" "branch refs/heads/main" "" \
      "worktree /wt/a" "branch refs/heads/fix/a" "" ;;
    "-C /wt/a status --porcelain") printf '%s\n' "D  a.ts" ;;
    "-C /wt/a diff --cached --name-status") printf '%s\n' "D	a.ts" ;;
    *"log -1 --format=%ct") echo 1000000 ;;
    *) ;;
  esac
}
# **gh を呼んだらテストを落とす**: この道具は offline でも動かなければ意味が無い
handle() { echo "unexpected: gh was called with: $*" >&2; exit 99; }
EOF
)
  AUDIT_NOW=9000000 run_script "$h" worktree-audit.sh
  assert_eq 3 "$STATUS" "gh 無しで判定できる: $ERR"
  # $LOG には git の行だけ（gh の行は "pr ..." のように git 接頭辞が無い形で入る）
  assert_not_contains "$LOG" "pr list" "**gh pr list を呼ばない（offline で使える）**"
  assert_not_contains "$LOG" "pr view" "**gh pr view を呼ばない**"
}
test_case "audit: gh に依存しない（offline で動く） (#1057)" t_audit_no_gh_dependency

t_audit_skips_measure_workdir() {
  local h; h=$(handler <<'EOF'
git_handle() {
  case "$*" in
    "worktree list --porcelain") printf '%s\n' \
      "worktree /repo" "branch refs/heads/main" "" \
      "worktree /wt/m" "branch refs/heads/fix/m" "" ;;
    # **作業ディレクトリだけのツリーは鳴らさない**（#787 と同じ除外。毎回鳴ると見なくなる）
    "-C /wt/m status --porcelain") printf '%s\n' "?? .measure/" "?? .cache/" ;;
    "-C /wt/m diff --cached --name-status") ;;
    *"log -1 --format=%ct") echo 1000000 ;;
    *) ;;
  esac
}
handle() { echo '[]'; }
EOF
)
  AUDIT_NOW=9000000 run_script "$h" worktree-audit.sh
  assert_eq 0 "$STATUS" "作業ディレクトリだけなら 0: $ERR"
  assert_contains "$ERR" "残留 0 本" "**.measure/ と .cache/ だけなら残留に数えない（#787）**"
}
test_case "audit: .measure/ .cache/ だけでは鳴らない (#1057)" t_audit_skips_measure_workdir

t_audit_usage() {
  local h; h=$(handler <<'EOF'
git_handle() { echo "should not be called" >&2; exit 99; }
handle() { echo "should not be called" >&2; exit 99; }
EOF
)
  run_script "$h" worktree-audit.sh --delete
  assert_eq 2 "$STATUS" "知らない引数は usage"
  assert_eq "" "$LOG" "**git も gh も一度も呼ばない**"
  assert_not_contains "$ERR" "--delete" "**消すという選択肢を案内しない**"
}
test_case "audit: 知らない引数では何もしない (#1057)" t_audit_usage

t_audit_conflict_tree_with_deletions() {
  local h; h=$(handler <<'INNER'
git_handle() {
  case "$*" in
    "worktree list --porcelain") printf '%s\n' \
      "worktree /repo" "branch refs/heads/main" "" \
      "worktree /wt/both" "" ;;
    # **2026-09-27 に rev1032/wt に実在した形**: UU が 1 件 + staged 117 件（うち D が 2 件）。
    # **conflict に分類されても D が見えなくなってはいけない**
    "-C /wt/both status --porcelain") printf '%s\n' \
      "UU scripts/ci/test/pr-closes.test.sh" \
      "D  data/members/h_42df80d20e.json" \
      "D  data/members/h_42df80d20e/speeches.json" \
      "M  src/a.ts" ;;
    "-C /wt/both diff --cached --name-status") printf '%s\n' \
      "D	data/members/h_42df80d20e.json" \
      "D	data/members/h_42df80d20e/speeches.json" \
      "M	src/a.ts" ;;
    *"log -1 --format=%ct") echo 1000000 ;;
    *) ;;
  esac
}
handle() { echo '[]'; }
INNER
)
  AUDIT_NOW=9000000 run_script "$h" worktree-audit.sh
  assert_eq 3 "$STATUS" "**conflict のツリーでも D が在れば 3 で終わる**: $ERR"
  assert_contains "$ERR" "解決途中" "conflict として出す"
  assert_contains "$ERR" "data/members/h_42df80d20e/speeches.json" "**D のファイルを挙げる（conflict に隠さない）**"
  assert_contains "$ERR" "うち削除 2 件" "**conflict の行でも D の件数を出す**"
  assert_contains "$ERR" "conflict のツリー 1 本にも staged の削除が在ります" "**内訳の外に別立てで数える**"
  # 内訳の合計が残留の本数と合う（1 本を 2 回数えない）
  assert_contains "$ERR" "残留 1 本（conflict 1 / deletion 0 / staged 0 / dirty 0）" "**1 本を 2 回数えない**"
}
test_case "audit: conflict と staged の削除が同じツリーに在る場合 (#1057)" t_audit_conflict_tree_with_deletions

t_audit_measure_exception_is_narrow() {
  local h; h=$(handler <<'INNER'
git_handle() {
  case "$*" in
    "worktree list --porcelain") printf '%s\n' \
      "worktree /repo" "branch refs/heads/main" "" \
      "worktree /wt/near" "branch refs/heads/fix/near" "" ;;
    # **名前が似ているだけ / 追跡されている変更**: どれも除外してはいけない（#787 と同じ狭さ）。
    # `?? .measure/file.txt` は .measure/ の中に追跡済みがあるときだけ出る形＝**本物**。
    "-C /wt/near status --porcelain") printf '%s\n' \
      "?? .measurements/x.json" \
      "?? .cache-notes.md" \
      "?? .measure/file.txt" \
      " M .measure/kept.ts" ;;
    "-C /wt/near diff --cached --name-status") ;;
    *"log -1 --format=%ct") echo 1000000 ;;
    *) ;;
  esac
}
handle() { echo '[]'; }
INNER
)
  AUDIT_NOW=9000000 run_script "$h" worktree-audit.sh
  assert_contains "$ERR" "残留 1 本" "**接頭辞が似ているだけのものを除外しない（残留として数える）**"
  assert_contains "$ERR" "未 stage の変更が 4 件" "**4 件すべて数える。除外は未追跡の .measure/ .cache/ ちょうどだけ**"
}
test_case "audit: .measure/ の除外を広げない (#1057/#787)" t_audit_measure_exception_is_narrow

# --- 目玉: HEAD が古くても index の mtime で「作業中」を見る (#1057) ------------------------------
#
# **これがこの道具の一番効く部分である。** 2026-09-27 の `rev1032/wt` は
# **HEAD が他人のコミットで、動いていたのは index のほうだけ**だった
# （`UU` が 1 件・index の更新は数分前 = レビュアーが解決の途中）。
# **HEAD のコミット時刻だけを見ると「放置」と誤判定し、消してよいツリーに見える。**
#
# **PR #1070 のレビューで、この経路を潰す変異が 33/33 全緑で通ることが分かった**:
#   `s{[[ "$idx_mtime" -gt "$last" ]] && last=$idx_mtime}{true}` → passed: 33 failed: 0
# **index mtime に触れるテストが 1 件も無かった**ので、ここで足す。
#
# 仕掛け: `git rev-parse --git-path index` は **git 呼び出しなので fake git で差し替えられる**。
#   本物のファイルを 1 つ作り、その mtime を `AUDIT_NOW` の 5 分前に置いて、そのパスを返す。
#   HEAD（`log -1 --format=%ct`）は **3 日前**にしておく。

t_audit_uses_index_mtime_when_head_is_old() {
  local dir idx now head_ct idx_mt
  dir=$(mktemp -d); idx="$dir/index"
  : > "$idx"
  now=9000000
  head_ct=$(( now - 3 * 86400 ))   # HEAD は 3 日前（ACTIVE_WINDOW 6h の外）
  idx_mt=$(( now - 300 ))          # index は 5 分前（ACTIVE_WINDOW の内）
  # **実ファイルの mtime を epoch で置く**（スクリプトは stat -c %Y で読む）
  touch -d "@$idx_mt" "$idx"

  local h; h=$(handler <<EOF
git_handle() {
  case "\$*" in
    "worktree list --porcelain") printf '%s\n' \\
      "worktree /repo" "branch refs/heads/main" "" \\
      "worktree /wt/live" "" ;;
    "-C /wt/live status --porcelain") printf '%s\n' "UU b.ts" ;;
    "-C /wt/live diff --cached --name-status") ;;
    # **HEAD は 3 日前**——これだけ見ると「放置」に見える
    "-C /wt/live log -1 --format=%ct") echo $head_ct ;;
    # **index は 5 分前**——本物のファイルを指す
    "-C /wt/live rev-parse --git-path index") echo "$idx" ;;
    *) ;;
  esac
}
handle() { echo '[]'; }
EOF
)
  AUDIT_NOW=$now run_script "$h" worktree-audit.sh
  assert_eq 0 "$STATUS" "exit status: $ERR"
  # **index を見ていれば「5 分前」になる。HEAD だけなら 4320 分前（= 3 日）で印が付かない。**
  assert_contains "$ERR" "作業中かもしれません" "**HEAD が 3 日前でも、index が 5 分前なら作業中と言う**"
  assert_contains "$ERR" "最終更新は 5 分前" "**index の mtime を採る（HEAD の 3 日前ではない）**"
  assert_contains "$LOG" "$(printf 'rev-parse\t--git-path\tindex')" "**index の場所は git に訊く（fake で差し替えられる）**"
  rm -rf "$dir"
}
test_case "audit: HEAD が古くても index の mtime で作業中を見る (#1057)" t_audit_uses_index_mtime_when_head_is_old

t_audit_keeps_head_when_index_is_older() {
  # **逆向きも見る**（`stat` だけでは足りない側）: worktree を作り直した直後は index が古く、
  # **HEAD のほうが新しい**。**遅いほうを採る**ので、このときは HEAD が勝たなければならない。
  local dir idx now head_ct idx_mt
  dir=$(mktemp -d); idx="$dir/index"
  : > "$idx"
  now=9000000
  head_ct=$(( now - 600 ))          # HEAD は 10 分前（ACTIVE_WINDOW の内）
  idx_mt=$(( now - 5 * 86400 ))     # index は 5 日前（外）
  touch -d "@$idx_mt" "$idx"

  local h; h=$(handler <<EOF
git_handle() {
  case "\$*" in
    "worktree list --porcelain") printf '%s\n' \\
      "worktree /repo" "branch refs/heads/main" "" \\
      "worktree /wt/fresh" "" ;;
    "-C /wt/fresh status --porcelain") printf '%s\n' " M a.ts" ;;
    "-C /wt/fresh diff --cached --name-status") ;;
    "-C /wt/fresh log -1 --format=%ct") echo $head_ct ;;
    "-C /wt/fresh rev-parse --git-path index") echo "$idx" ;;
    *) ;;
  esac
}
handle() { echo '[]'; }
EOF
)
  AUDIT_NOW=$now run_script "$h" worktree-audit.sh
  assert_contains "$ERR" "最終更新は 10 分前" "**index が古いときは HEAD を採る（遅いほうを採る）**"
  assert_contains "$ERR" "作業中かもしれません" "印は付く"
  rm -rf "$dir"
}
test_case "audit: index が古いときは HEAD を採る（遅いほうを採る） (#1057)" t_audit_keeps_head_when_index_is_older

t_audit_survives_missing_index() {
  # **index が読めないツリーでも落ちない**（消えた worktree・権限・fake が答えない場合）。
  # `set -euo pipefail` なので、ここで止まると**残りの worktree を 1 本も調べない。**
  local h; h=$(handler <<'INNER'
git_handle() {
  case "$*" in
    "worktree list --porcelain") printf '%s\n' \
      "worktree /repo" "branch refs/heads/main" "" \
      "worktree /wt/noidx" "" \
      "worktree /wt/after" "" ;;
    "-C /wt/noidx status --porcelain") printf '%s\n' " M a.ts" ;;
    "-C /wt/noidx diff --cached --name-status") ;;
    "-C /wt/noidx log -1 --format=%ct") echo 1000000 ;;
    # **存在しないパスを返す**（-f で落ちる）
    "-C /wt/noidx rev-parse --git-path index") echo "/nonexistent/path/index" ;;
    "-C /wt/after status --porcelain") printf '%s\n' "D  gone.ts" ;;
    "-C /wt/after diff --cached --name-status") printf '%s\n' "D	gone.ts" ;;
    "-C /wt/after log -1 --format=%ct") echo 1000000 ;;
    *) ;;
  esac
}
handle() { echo '[]'; }
INNER
)
  AUDIT_NOW=9000000 run_script "$h" worktree-audit.sh
  # **index が読めなくても、その後ろの worktree の D を見逃さない**
  assert_eq 3 "$STATUS" "index が読めなくても止まらず、後続の D を見つける: $ERR"
  assert_contains "$ERR" "gone.ts" "**1 本目で止まらず 2 本目まで調べる**"
  assert_contains "$ERR" "worktree 3 本を調べました" "母数は 3 本"
}
test_case "audit: index が読めなくても止まらない (#1057)" t_audit_survives_missing_index
