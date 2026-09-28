# shellcheck shell=bash
# **Do not run this file directly** (#1124). It is sourced by scripts/po/test/run.sh, which
# defines test_case / assert_* / run_script. Running it with `bash` used to print 200 lines of
# `test_case: command not found` and then **exit 0** — an error that looked like a pass.
[[ -n ${PO_TEST_RUN_SH:-} ]] || {
  echo "$(basename "${BASH_SOURCE[0]}"): このファイルは単体では走りません（run.sh が source します）。" >&2
  echo "  bash scripts/po/test/run.sh                       # 全部" >&2
  echo "  bash scripts/po/test/run.sh ${BASH_SOURCE[0]##*/} # このファイルだけ" >&2
  exit 2
}
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

# ---- allowlist: この道具が呼んでよい git の形（#1089） ----------------------------------------
#
# **denylist をやめた理由（実測）**: ここは以前「禁じる 8 個（remove/reset/checkout/clean/restore/
# stash/branch -D/commit）」を名指ししていた。**列挙に無い形は素通りする**——
# **#1070 の 3 度目のレビューが 6 形を注入し、6 通りとも 40/40 緑だった。**
# **そのうち `git rm -r --cached .` は、この道具が存在する理由の事故そのものである**
# （#1057: 引き継いだ worktree の staged が他人の成果物を消す）。
#
# **allowlist が「これで全部」と言えるのは、サブコマンドの集合についてだけである**（#1089 のレビュー）。
# `$LOG` は fake `git` が**その筋書きで実行された呼び出しを 1 行も落とさず**記録している
# （`scripts/po/test/fake-bin/git`）ので、**実行された git については、
# 列挙に無いものはサブコマンドが何であれ落ちる**——**denylist と違って語の列挙に依存しない。**
# **検査を書き足さなくても、次に破壊的な呼び出しを足した人が捕まる。**
# **ただし「実行された git」に限る。** **到達しない枝に置かれた git は `$LOG` に現れない**
# （下の「塞げていない形」の 1 番目）。
#
# 許す 5 形（`scripts/po/worktree-audit.sh` が実際に呼ぶ全部。2026-09-28 実測）:
#   git worktree list --porcelain
#   git -C <path> status --porcelain
#   git -C <path> diff --cached --name-status
#   git -C <path> log -1 --format=%ct
#   git -C <path> rev-parse --git-path index
# **どれも読むだけである**（`worktree list` は `add`/`remove`/`prune` と違い一覧を出すだけ、
# `diff --cached` は index を読むだけ、`rev-parse` はパスを解決するだけ）。
#
# **`-C <path>` は剥がしてから照合する**（path はツリーごとに変わるので逐語では比べられない）。
# **剥がすのは先頭の 1 回だけ**にしてある——`git -C /a -C /b rm .` のように 2 回目を許すと、
# **剥がした残りが `-C /b rm .` になって照合に落ちる**（つまり素通りしない）。
#
# **塞げていない形**（allowlist でも「この道具が壊さない」の全証明にはならない。#1089）:
#   - **実行されない枝に置かれた git は見えない**（**これが一番大きい**。#1089 のレビューが実測）。
#     **検査が見るのは `$LOG` = その 1 筋書きで実際に走った git だけ**なので、
#     **テストが通らない枝に破壊的な呼び出しを書くと素通りする。** **実測 3 形、どれも 42/0 緑**:
#       `unreadable` 枝（status が取れないツリー）に `git rm -rf --cached .`
#       末尾の `exit 0` の直前に `git clean -xfd`
#       `dirty_only` 枝に `git checkout -- .`
#     **これは allowlist にして生まれた穴ではない**——**旧 denylist でも同じく素通りした**
#     （`checkout` は旧 8 語に在ったのに `dirty_only` 枝では 40/0 緑。実測）。
#     **塞ぐには「実行された呼び出し」ではなく「ソースに書かれた呼び出し」を見る必要がある**
#     ——それは `scripts/ci/forbidden-patterns.sh` の `destructive-git` の役割である
#     （**あちらは静的に grep する。両者は役割が違い、二重管理ではない**）。
#     **ただしその規則は `git rm` / `worktree remove` / `update-ref` / `branch -D` を持っていない**
#     ので、**いまは両方のゲートを抜ける形が在る。これは #1123 で扱う。**
#   - **git 以外の道具**: `rm -rf "$path"` / `find -delete` / `>` でのリダイレクト。
#     **fake `git` は git しか記録しないので、この検査の射程外である。**
#     （`scripts/ci/forbidden-patterns.sh` の `destructive-git` も同じ限界を書いている）
#   - **許した 5 形そのものの引数を伸ばす形**: この照合は逐語一致なので
#     `status --porcelain -z` のような変種は**落ちる**（素通りはしない）。**引数を足すなら
#     ここに書き足すことになる**——それが「読むだけか」をレビューで見る機会になる。
#   - **この関数を呼ばないテストを足す形**: 検査は `t_audit_never_destroys` の 1 件だけが呼ぶ。
assert_git_calls_read_only() {
  local log=$1 msg=$2 line rest
  local -a allowed=(
    "worktree	list	--porcelain"
    "status	--porcelain"
    "diff	--cached	--name-status"
    "log	-1	--format=%ct"
    "rev-parse	--git-path	index"
  )
  local seen=0 ok
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    # fake `git` は "git<TAB>引数…" で記録する。git 以外（gh）の行はここでは見ない
    [[ "$line" == "git	"* ]] || continue
    seen=$((seen+1))
    rest="${line#git	}"
    # **先頭の `-C <path>` を 1 回だけ剥がす**（2 回目以降は剥がさない＝照合に落ちる）
    if [[ "$rest" == "-C	"* ]]; then rest="${rest#-C	}"; rest="${rest#*	}"; fi
    ok=0
    for a in "${allowed[@]}"; do [[ "$rest" == "$a" ]] && { ok=1; break; }; done
    [[ $ok == 1 ]] || fail "$msg: 許していない git の呼び出し [$line]
（読み取り専用の 5 形だけを許しています。足すなら assert_git_calls_read_only の allowed に
理由つきで書き足してください——それが「本当に読むだけか」を人が見る機会です）"
  done <<< "$log"
  # **母数を出す（#757）。「1 行も見ていない」を「違反 0」と同じ顔にしない。**
  # **$LOG が空なら照合は何も見ていないので、緑は何の証明にもならない。**
  [[ $seen -gt 0 ]] || fail "$msg: git の呼び出しが \$LOG に 1 行も無い（照合が空振りしています）"
}

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
  # **まず「本当に走った」ことを確かめる**（走らなければ下の照合は空振りで緑になる）
  assert_eq 3 "$STATUS" "D が在るので 3 で終わる: $ERR"
  assert_contains "$LOG" "$(printf '\tstatus\t--porcelain')" "**読む git は呼んでいる（空振りの緑を防ぐ）**"
  # **この道具は 1 つも壊さない。** 読む git **だけ**を呼ぶ。
  #
  # **ここは allowlist である**（#1089）。**以前は「禁じる 8 個」を名指しする denylist だった**が、
  # **列挙に無い破壊的な呼び出しが素通りした**——**レビュアーが 6 形を注入して 6 通りとも 40/40 緑**。
  # **そのうち `git rm -r --cached .` は、この道具が存在する理由の事故そのものである**
  # （#1057: 引き継いだ worktree の staged が他人の成果物を消す）。
  # **denylist は「これで全部」と言えない。allowlist なら言える。**
  # **足す側が検査を書き足さなくても捕まる**のが、この形に変えた理由である。
  assert_git_calls_read_only "$LOG" "**読み取り専用の 5 形以外の git を呼ばない**"
}
test_case "audit: 破壊的な git を 1 つも呼ばない (#1057, allowlist 化 #1089)" t_audit_never_destroys

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

# --- 相対パスの index（メインの作業ツリーの形） (#1070 の 2 度目のレビュー) -------------------------
#
# **`git rev-parse --git-path index` は、返すパスの形がツリーによって違う**（実測 2026-09-28）:
#   ```
#   $ git -C <メインの作業ツリー> rev-parse --git-path index   →  .git/index                  ← **相対**
#   $ git -C <linked worktree>    rev-parse --git-path index   →  /…/.git/worktrees/N/index   ← 絶対
#   ```
#   **手元の 25 本で数えると絶対 24 / 相対 1。相対は 1 本だけ——メインの作業ツリーである。**
#
# **そこが守る対象の中心だった**: #1057 の事故 3 件のうち 1 件（`rp/1043w`）は PO 自身の手元で、
# `worktree-audit.sh` のコメントも「メインの作業ツリーも数え、調べる」と書いている。
#
# **上の 3 件（`t_audit_uses_index_mtime_when_head_is_old` ほか）は fake が `echo "$idx"` で
# 必ず絶対パスを返すので、相対の分岐を一度も通していなかった。** その結果:
#   - **正しい修正（`$path` 基準で解決する）を当てても 36/36 緑**——**パス解決の意味が
#     どこにも固定されていなかった。**
#   - 実害（独立の sandbox で実演。HEAD 3 日前 + index いま = `rev1032/wt` の形）:
#     ```
#     linked worktree から走らせた: deletion … 削除が staged で 1 件（staged 1 件）   ← **印が無い**
#     メインの作業ツリーから      : deletion … — 最終更新は 0 分前。誰かが作業中かもしれません
#     ```
#     **同じツリー・同じ状態で、監査を走らせた cwd だけで答えが変わった。**
#   - 逆向きの偽陽性も実在: cwd に別 repo の `.git/index` が在ると `-f` が真になり、
#     **無関係な repo の mtime を読む**（実測で `最終更新は -29687988 分前`）。
#
# **ここから下の 3 件が、その両方向を固定する。** `$path` を `mktemp -d` の実ディレクトリにして、
# fake git に `.git/index` のような**相対パス**を返させる。

t_audit_resolves_relative_index_against_worktree() {
  # **メインの作業ツリーの形**: `rev-parse --git-path index` が `.git/index` を返し、
  # **HEAD は 3 日前・index は 5 分前**（= `rev1032/wt` の形）。
  # **相対パスを `$path` 基準で解決していなければ、印が付かない。**
  local dir now head_ct idx_mt
  dir=$(mktemp -d)
  mkdir -p "$dir/.git"; : > "$dir/.git/index"
  now=9000000
  head_ct=$(( now - 3 * 86400 ))
  idx_mt=$(( now - 300 ))
  touch -d "@$idx_mt" "$dir/.git/index"

  local h; h=$(handler <<EOF
git_handle() {
  case "\$*" in
    "worktree list --porcelain") printf '%s\n' \\
      "worktree $dir" "branch refs/heads/main" "" ;;
    "-C $dir status --porcelain") printf '%s\n' "D  gone.ts" ;;
    "-C $dir diff --cached --name-status") printf 'D\tgone.ts\n' ;;
    "-C $dir log -1 --format=%ct") echo $head_ct ;;
    # **本物のメインの作業ツリーがこう返す**（絶対ではなく相対）
    "-C $dir rev-parse --git-path index") echo ".git/index" ;;
    *) ;;
  esac
}
handle() { echo '[]'; }
EOF
)
  # **cwd は意図的に別の場所にする**（`$TMP` には `.git/index` が無い）。
  # **cwd 基準で解決していると、ここで印が消える。**
  AUDIT_NOW=$now run_script "$h" worktree-audit.sh
  assert_eq 3 "$STATUS" "D が在るので 3: $ERR"
  assert_contains "$ERR" "最終更新は 5 分前" "**相対パスを \$path 基準で解決する（cwd 基準ではない）**"
  assert_contains "$ERR" "作業中かもしれません" "**メインの作業ツリーでも「作業中」の印が付く**"
  assert_not_contains "$ERR" "index が読めず" "**読めているので、読めなかったとは言わない**"
  rm -rf "$dir"
}
test_case "audit: 相対パスの index を worktree 基準で解決する (#1070)" t_audit_resolves_relative_index_against_worktree

t_audit_ignores_cwd_index_for_relative_path() {
  # **偽陽性の側**: cwd に**別 repo の** `.git/index` が在っても、そちらを読んではいけない。
  # 対象のツリーには `.git/index` を**置かない**ので、正しい実装は「読めなかった」と言う。
  # **cwd 基準で解決する実装は、cwd の index（未来の mtime）を読んで印を付けてしまう。**
  local dir cwd now head_ct
  dir=$(mktemp -d); cwd=$(mktemp -d)
  mkdir -p "$cwd/.git"; : > "$cwd/.git/index"
  now=9000000
  head_ct=$(( now - 3 * 86400 ))
  touch -d "@$(( now - 60 ))" "$cwd/.git/index"   # cwd 側は 1 分前（印が付く値）

  local h; h=$(handler <<EOF
git_handle() {
  case "\$*" in
    "worktree list --porcelain") printf '%s\n' \\
      "worktree $dir" "branch refs/heads/main" "" ;;
    "-C $dir status --porcelain") printf '%s\n' "D  gone.ts" ;;
    "-C $dir diff --cached --name-status") printf 'D\tgone.ts\n' ;;
    "-C $dir log -1 --format=%ct") echo $head_ct ;;
    "-C $dir rev-parse --git-path index") echo ".git/index" ;;
    *) ;;
  esac
}
handle() { echo '[]'; }
EOF
)
  # **サブシェルで囲まないこと**: `fail` は `CURRENT_FAILED=1` を立てるだけなので、
  # **`( ... )` の中で assert すると失敗が親に伝わらず、テストが何も主張しなくなる**
  # （変異の分類 4。実測: サブシェル版だと `idx_skipped` を潰す変異が 39/0 で生き残った）。
  # cwd は元に戻す。
  local back; back=$PWD
  cd "$cwd" || { fail "cd \"\$cwd\" に失敗（テストが空振りするので落とす）"; return; }
  AUDIT_NOW=$now run_script "$h" worktree-audit.sh
  cd "$back" || { fail "cd で戻れなかった（後続のテストが別の cwd で走る）"; return; }
  assert_not_contains "$ERR" "作業中かもしれません" "**cwd に在る別 repo の index を読まない（偽陽性）**"
  assert_not_contains "$ERR" "最終更新は 1 分前" "**cwd 側の mtime を採らない**"
  # **黙って飛ばさない**: 読めなかったことをその行と母数の両方で言う（#757）
  assert_contains "$ERR" "index が読めず" "**読めなかったことを、その行で言う**"
  assert_contains "$ERR" "1 本は index の mtime を読めていません" "**読めなかった本数を母数として出す**"
  assert_contains "$ERR" "印が無いことを放置の証拠にしないでください" "**印の不在の意味を言う**"
  rm -rf "$dir" "$cwd"
}
test_case "audit: 相対パスを cwd 基準で解決しない（別 repo の index を読まない） (#1070)" t_audit_ignores_cwd_index_for_relative_path

t_audit_still_handles_absolute_index() {
  # **絶対パスは絶対のまま扱う**（linked worktree の形。手元 25 本のうち 24 本）。
  # **「相対なら足す」を「常に足す」にする改悪**を殺す: `$path/$abs` は存在しないので
  # 印が消え、しかも「読めなかった」が立つ。
  local dir idx now head_ct
  dir=$(mktemp -d); idx="$dir/wt-index"
  : > "$idx"
  now=9000000
  head_ct=$(( now - 3 * 86400 ))
  touch -d "@$(( now - 300 ))" "$idx"

  local h; h=$(handler <<EOF
git_handle() {
  case "\$*" in
    "worktree list --porcelain") printf '%s\n' \\
      "worktree /wt/linked" "branch refs/heads/fix/x" "" ;;
    "-C /wt/linked status --porcelain") printf '%s\n' " M a.ts" ;;
    "-C /wt/linked diff --cached --name-status") ;;
    "-C /wt/linked log -1 --format=%ct") echo $head_ct ;;
    # **絶対パス**（\$path とは無関係な場所を指す。linked worktree は .git/worktrees/N/index）
    "-C /wt/linked rev-parse --git-path index") echo "$idx" ;;
    *) ;;
  esac
}
handle() { echo '[]'; }
EOF
)
  AUDIT_NOW=$now run_script "$h" worktree-audit.sh
  assert_contains "$ERR" "最終更新は 5 分前" "**絶対パスに \$path を足さない（linked worktree の 24/25）**"
  assert_not_contains "$ERR" "index が読めず" "絶対パスは読めている"
  rm -rf "$dir"
}
test_case "audit: 絶対パスの index はそのまま扱う (#1070)" t_audit_still_handles_absolute_index

t_audit_never_shows_negative_age() {
  # **【低】未来のコミット日時で `最終更新は -120 分前` と表示される**（#1070 のレビュー指摘）。
  # **倒れる向きは安全**（印は付く＝「触るな」側）**ので直すのは表示だけ**。
  # **印が消えないことも同じテストで見る**——表示を直すついでに守りを弱めていないか。
  local h; h=$(handler <<'INNER'
git_handle() {
  case "$*" in
    "worktree list --porcelain") printf '%s\n' \
      "worktree /repo" "branch refs/heads/main" "" \
      "worktree /wt/future" "" ;;
    "-C /wt/future status --porcelain") printf '%s\n' " M a.ts" ;;
    "-C /wt/future diff --cached --name-status") ;;
    # **AUDIT_NOW より 2 時間先**のコミット日時（時計のずれ・手で打った --date）
    "-C /wt/future log -1 --format=%ct") echo 9007200 ;;
    *) ;;
  esac
}
handle() { echo '[]'; }
INNER
)
  AUDIT_NOW=9000000 run_script "$h" worktree-audit.sh
  assert_not_contains "$ERR" "-120 分前" "**負の「分前」を表示しない**"
  assert_contains "$ERR" "最終更新は 0 分前" "**未来は 0 分前に丸める**"
  # **表示を直しても、印（＝「触るな」）は弱めない**
  assert_contains "$ERR" "作業中かもしれません" "**未来の時刻でも印は付く（倒れる向きは「触るな」側）**"
}
test_case "audit: 未来のコミット日時で負の「分前」を出さない (#1070)" t_audit_never_shows_negative_age

t_audit_counts_unreadable_worktrees() {
  # **status が取れないツリー**（消えた worktree・権限・壊れた .git）。**#1089 まで無検査だった**——
  # **実装は正しかったが固定されていなかった**（変異 2 通り「数えない」「ログに出さない」が
  # どちらも 40/40 緑だった。2026-09-28 実測）。
  # **これは #757 の母数の罠そのものである**: 「調べた結果きれいだった」と
  # **「そもそも読めなかった」を同じ顔にすると、PO は読めていないツリーを安全だと思う。**
  local h; h=$(handler <<'EOF2'
git_handle() {
  case "$*" in
    "worktree list --porcelain") printf '%s\n' \
      "worktree /repo" "branch refs/heads/main" "" \
      "worktree /wt/gone" "branch refs/heads/fix/gone" "" \
      "worktree /wt/ok" "branch refs/heads/fix/ok" "" ;;
    # **ディレクトリごと消えた worktree**（幽霊。git には登録が残る）
    "-C /wt/gone status --porcelain") exit 128 ;;
    "-C /wt/ok status --porcelain") printf '%s\n' "M  a.ts" ;;
    "-C /wt/ok diff --cached --name-status") printf '%s\n' "M	a.ts" ;;
    *"log -1 --format=%ct") echo 1000000 ;;
    *) ;;
  esac
}
handle() { echo '[]'; }
EOF2
)
  AUDIT_NOW=9000000 run_script "$h" worktree-audit.sh
  # **読めないツリーが在っても止まらない**（後続を調べ続ける）
  assert_eq 0 "$STATUS" "読めないツリーが在っても走り切る: $ERR"
  assert_contains "$ERR" "読めない /wt/gone" "**読めなかったツリーを名指しする**"
  assert_contains "$ERR" "status が取れませんでした" "**読めなかった理由を言う**"
  # **母数（#757）**: 読めなかった本数を必ず出す。「0 本」と「数えていない」を分ける
  assert_contains "$ERR" "読めなかったもの 1 本" "**読めなかった本数を数えて出す**"
  # **読めなかったツリーを「残留」に数えない**（status が取れていないので分類できない）
  assert_contains "$ERR" "worktree 3 本" "母数は 3 本（読めないものも母数には入る）"
  assert_contains "$ERR" "残留 1 本" "**残留は読めた 1 本だけ（読めないものを混ぜない）**"
}
test_case "audit: status が読めない worktree を数えて名指しする (#1089)" t_audit_counts_unreadable_worktrees

t_audit_reports_zero_unreadable() {
  # **裏側**: 全部読めたときは「読めなかったもの 0 本」と**明示する**。
  # **0 を書かないと、「読めなかった」の行が無いことが「全部読めた」の証拠にならない**
  # （出さない変異が素通りする。#1089 で実測）。
  local h; h=$(handler <<'EOF2'
git_handle() {
  case "$*" in
    "worktree list --porcelain") printf '%s\n' \
      "worktree /repo" "branch refs/heads/main" "" ;;
    "-C /repo status --porcelain") ;;
    "-C /repo diff --cached --name-status") ;;
    *"log -1 --format=%ct") echo 1000000 ;;
    *) ;;
  esac
}
handle() { echo '[]'; }
EOF2
)
  AUDIT_NOW=9000000 run_script "$h" worktree-audit.sh
  assert_eq 0 "$STATUS" "きれいなら 0: $ERR"
  assert_contains "$ERR" "読めなかったもの 0 本" "**0 本であることを明示する（数えていないと区別する）**"
  assert_not_contains "$ERR" "読めない /" "読めているので、読めなかったとは言わない"
}
test_case "audit: 全部読めたときは「読めなかったもの 0 本」と言う (#1089)" t_audit_reports_zero_unreadable
