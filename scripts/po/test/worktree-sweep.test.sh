# shellcheck shell=bash
# Tests for scripts/po/worktree-sweep.sh (sourced by run.sh)
#
# **消す道具なので、「消さない」側の検査を厚くする。**
# fake `git` / `gh` を使うので、**このテストは実際には何も消さない**
# （`git worktree remove` が呼ばれたことは $LOG で確かめる）。

# **ハンドラは別プロセスで source されるので、共通のシェル関数は見えない。**
# `git worktree list --porcelain` の出力は各ハンドラの中に直接書く（最初のブロックがメイン）。

t_sweep_dry_run_removes_nothing() {
  local h; h=$(handler <<'EOF'
git_handle() {
  case "$*" in
    "worktree list --porcelain") printf '%s\n' \
      "worktree /repo" "branch refs/heads/main" "" \
      "worktree /wt/clean" "branch refs/heads/feat/clean" "" \
      "worktree /wt/dirty" "branch refs/heads/feat/dirty" "" ;;
    "-C /wt/clean status --porcelain") ;;                 # clean
    "-C /wt/dirty status --porcelain") echo " M a.ts" ;;  # dirty
    *"log --oneline @{u}..HEAD") ;;                       # 0 unpushed
    *) ;;
  esac
}
handle() { echo '[{"state":"MERGED"}]'; }
EOF
)
  run_script "$h" worktree-sweep.sh
  assert_eq 0 "$STATUS" "exit status: $ERR"
  assert_contains "$ERR" "消せる /wt/clean" "clean は消せると出る"
  assert_contains "$ERR" "残す /wt/dirty" "dirty は残す"
  assert_not_contains "$LOG" "$(printf 'worktree\tremove')" "**dry-run では remove を一度も呼ばない**"
  assert_contains "$ERR" "--yes" "実際に消す方法を案内する"
}
test_case "sweep: dry-run は何も消さない" t_sweep_dry_run_removes_nothing

t_sweep_never_touches_main() {
  local h; h=$(handler <<'EOF'
git_handle() {
  case "$*" in
    "worktree list --porcelain") printf '%s\n' \
      "worktree /repo" "branch refs/heads/main" "" \
      "worktree /wt/clean" "branch refs/heads/feat/clean" "" \
      "worktree /wt/dirty" "branch refs/heads/feat/dirty" "" ;;
    *"status --porcelain") ;;
    *"log --oneline @{u}..HEAD") ;;
    *) ;;
  esac
}
handle() { echo '[{"state":"MERGED"}]'; }
EOF
)
  run_script "$h" worktree-sweep.sh --yes
  assert_eq 0 "$STATUS" "exit status: $ERR"
  # **メイン（/repo, main）は一度も status を問われず、remove もされない**
  assert_not_contains "$LOG" "$(printf '\t-C\t/repo\tstatus')" "メインの作業ツリーは調べない"
  assert_not_contains "$LOG" "$(printf 'worktree\tremove\t/repo')" "**メインの作業ツリーを消さない**"
  assert_not_contains "$LOG" "$(printf 'branch\t-D\tmain')" "**main ブランチを消さない**"
}
test_case "sweep: メインの作業ツリーには触れない" t_sweep_never_touches_main

t_sweep_keeps_dirty() {
  local h; h=$(handler <<'EOF'
git_handle() {
  case "$*" in
    "worktree list --porcelain") printf '%s\n' \
      "worktree /repo" "branch refs/heads/main" "" \
      "worktree /wt/clean" "branch refs/heads/feat/clean" "" \
      "worktree /wt/dirty" "branch refs/heads/feat/dirty" "" ;;
    "-C /wt/clean status --porcelain") ;;
    "-C /wt/dirty status --porcelain") echo " M src/a.ts" ;;
    *"log --oneline @{u}..HEAD") ;;
    *) ;;
  esac
}
handle() { echo '[{"state":"MERGED"}]'; }
EOF
)
  run_script "$h" worktree-sweep.sh --yes
  assert_contains "$LOG" "$(printf 'worktree\tremove\t/wt/clean')" "clean は消す"
  assert_not_contains "$LOG" "$(printf 'worktree\tremove\t/wt/dirty')" "**未コミットのあるツリーは消さない**"
  assert_contains "$ERR" "未コミットの変更が 1 件" "残した理由を出す"
}
test_case "sweep: 未コミットの変更があるツリーは消さない" t_sweep_keeps_dirty

t_sweep_keeps_unpushed() {
  local h; h=$(handler <<'EOF'
git_handle() {
  case "$*" in
    "worktree list --porcelain") printf '%s\n' \
      "worktree /repo" "branch refs/heads/main" "" \
      "worktree /wt/clean" "branch refs/heads/feat/clean" "" \
      "worktree /wt/dirty" "branch refs/heads/feat/dirty" "" ;;
    *"status --porcelain") ;;
    "-C /wt/clean log --oneline @{u}..HEAD") echo "abc1234 wip" ;;   # 1 unpushed
    *"log --oneline @{u}..HEAD") ;;
    *) ;;
  esac
}
handle() { echo '[{"state":"MERGED"}]'; }
EOF
)
  run_script "$h" worktree-sweep.sh --yes
  assert_not_contains "$LOG" "$(printf 'worktree\tremove\t/wt/clean')" "**push されていないコミットがあるツリーは消さない**"
  assert_contains "$ERR" "push されていないコミットが 1 件" "残した理由を出す"
}
test_case "sweep: push されていないコミットがあるツリーは消さない" t_sweep_keeps_unpushed

t_sweep_keeps_unmerged_pr() {
  local h; h=$(handler <<'EOF'
git_handle() {
  case "$*" in
    "worktree list --porcelain") printf '%s\n' \
      "worktree /repo" "branch refs/heads/main" "" \
      "worktree /wt/clean" "branch refs/heads/feat/clean" "" \
      "worktree /wt/dirty" "branch refs/heads/feat/dirty" "" ;;
    *"status --porcelain") ;;
    *"log --oneline @{u}..HEAD") ;;
    *) ;;
  esac
}
handle() {
  case "$*" in
    *"--head feat/clean"*) echo '[{"state":"OPEN"}]' ;;    # まだ開いている
    *) echo '[]' ;;                                        # PR が無い
  esac
}
EOF
)
  run_script "$h" worktree-sweep.sh --yes
  assert_not_contains "$LOG" "$(printf 'worktree\tremove')" "**MERGED でない PR のツリーは 1 本も消さない**"
  assert_contains "$ERR" "state=OPEN" "OPEN の理由を出す"
  assert_contains "$ERR" "state=null" "PR が無いことも理由に出す（gh --jq は null を返す）"
}
test_case "sweep: PR が MERGED でないツリーは消さない" t_sweep_keeps_unmerged_pr

t_sweep_never_forces() {
  local h; h=$(handler <<'EOF'
git_handle() {
  case "$*" in
    "worktree list --porcelain") printf '%s\n' \
      "worktree /repo" "branch refs/heads/main" "" \
      "worktree /wt/clean" "branch refs/heads/feat/clean" "" \
      "worktree /wt/dirty" "branch refs/heads/feat/dirty" "" ;;
    *"status --porcelain") ;;
    *"log --oneline @{u}..HEAD") ;;
    "worktree remove "*) exit 1 ;;   # **どのツリーでも remove が失敗する状況**
    *) ;;
  esac
}
handle() { echo '[{"state":"MERGED"}]'; }
EOF
)
  run_script "$h" worktree-sweep.sh --yes
  assert_eq 0 "$STATUS" "remove が失敗しても異常終了しない: $ERR"
  assert_not_contains "$LOG" "--force" "**--force には絶対に切り替えない**"
  assert_contains "$ERR" "--force は使いません" "使わないことを明示する"
}
test_case "sweep: remove が失敗しても --force に切り替えない" t_sweep_never_forces

t_sweep_usage() {
  local h; h=$(handler <<'EOF'
git_handle() { echo "should not be called" >&2; exit 99; }
handle() { echo "should not be called" >&2; exit 99; }
EOF
)
  run_script "$h" worktree-sweep.sh --force
  assert_eq 2 "$STATUS" "知らない引数は usage"
  assert_eq "" "$LOG" "**git も gh も一度も呼ばない**"
}
test_case "sweep: 知らない引数では何もしない" t_sweep_usage

# --- Issue #787: 作業ディレクトリ .measure/ で守りが鳴らないようにする ---------------------
#
# **目的は「鳴らなくする」ことではなく、「鳴ったときに本物だと分かる」こと。**
# 守り 1（未コミットがあるなら消さない）は #726 のまま。**除外するのは .measure/ という 1 つの名前だけ。**
# #769（群馬）では `?? .work/` と `?? packages/etl/.work769/` のせいで
# マージ済みのツリーが消えず、**守りが毎回鳴ることで、鳴っていること自体を見なくなっていた。**

t_sweep_ignores_measure_workdir() {
  local h; h=$(handler <<'EOF'
git_handle() {
  case "$*" in
    "worktree list --porcelain") printf '%s\n' \
      "worktree /repo" "branch refs/heads/main" "" \
      "worktree /wt/measure" "branch refs/heads/docs/measure" "" \
      "worktree /wt/real" "branch refs/heads/docs/real" "" ;;
    # **作業ゴミだけ**: 未追跡の .measure/（ルートとパッケージ配下の両方）と .cache/
    "-C /wt/measure status --porcelain") printf '%s\n' "?? .measure/" "?? packages/etl/.measure/" "?? .cache/" ;;
    # **本物の取りこぼし**: .measure/ と同じツリーに混ざっていても見落とさない
    "-C /wt/real status --porcelain") printf '%s\n' "?? .measure/" " M packages/etl/src/a.ts" ;;
    *"log --oneline @{u}..HEAD") ;;
    *) ;;
  esac
}
handle() { echo '[{"state":"MERGED"}]'; }
EOF
)
  run_script "$h" worktree-sweep.sh --yes
  assert_eq 0 "$STATUS" "exit status: $ERR"
  assert_contains "$LOG" "$(printf 'worktree\tremove\t/wt/measure')" "**.measure/ だけのツリーは消せる（守りが鳴らない）**"
  assert_not_contains "$ERR" "残す /wt/measure" "作業ゴミだけを理由に残さない"
  assert_not_contains "$LOG" "$(printf 'worktree\tremove\t/wt/real')" "**本物の未コミットは .measure/ に紛れても消さない**"
  assert_contains "$ERR" "残す /wt/real" "本物は残す"
  assert_contains "$ERR" "未コミットの変更が 1 件" "**数えるのは本物の 1 件だけ（.measure/ は数に入れない）**"
}
test_case "sweep: .measure/ の作業ディレクトリでは守りが鳴らない (#787)" t_sweep_ignores_measure_workdir

t_sweep_measure_exception_is_narrow() {
  local h; h=$(handler <<'EOF'
git_handle() {
  case "$*" in
    "worktree list --porcelain") printf '%s\n' \
      "worktree /repo" "branch refs/heads/main" "" \
      "worktree /wt/near" "branch refs/heads/docs/near" "" ;;
    # **名前が似ているだけ / 追跡されている変更**: どれも除外してはいけない
    "-C /wt/near status --porcelain") printf '%s\n' \
      "?? .measurements/x.json" \
      "?? packages/etl/.measure-notes.md" \
      "?? data/assemblies/pref-10/new.json" \
      " M .measure/kept.ts" \
      "A  packages/etl/.measure/added.ts" ;;
    *"log --oneline @{u}..HEAD") ;;
    *) ;;
  esac
}
handle() { echo '[{"state":"MERGED"}]'; }
EOF
)
  run_script "$h" worktree-sweep.sh --yes
  assert_not_contains "$LOG" "$(printf 'worktree\tremove\t/wt/near')" "**接頭辞が似ているだけのものを除外しない**"
  assert_contains "$ERR" "未コミットの変更が 5 件" "**5 件すべて数える（追跡済みの .measure/ も含む）**"
}
test_case "sweep: .measure/ の除外は未追跡の .measure/ だけ (#787)" t_sweep_measure_exception_is_narrow

t_sweep_cache_exception_not_widened() {
  local h; h=$(handler <<'EOF'
git_handle() {
  case "$*" in
    "worktree list --porcelain") printf '%s\n' \
      "worktree /repo" "branch refs/heads/main" "" \
      "worktree /wt/cache" "branch refs/heads/feat/cache" "" ;;
    # **#787 より前は `grep -v '^?? .cache'` だったので、下の 2 行は黙って消えていた。**
    # `?? .measure/file.txt` は、.measure/ の中に追跡済みファイルがあるときだけ git が出す形
    # （全部未追跡なら git はディレクトリを `?? .measure/` に畳む）。**つまり本物である。**
    "-C /wt/cache status --porcelain") printf '%s\n' \
      "?? .cacheXYZ" "?? .cache-notes.md" "?? .measure/file.txt" ;;
    *"log --oneline @{u}..HEAD") ;;
    *) ;;
  esac
}
handle() { echo '[{"state":"MERGED"}]'; }
EOF
)
  run_script "$h" worktree-sweep.sh --yes
  assert_not_contains "$LOG" "$(printf 'worktree\tremove\t/wt/cache')" "**.cache で始まるだけのものを除外しない**"
  assert_contains "$ERR" "未コミットの変更が 3 件" "3 件とも数える"
}
test_case "sweep: .cache の除外も広げない（#787 で狭めた）" t_sweep_cache_exception_not_widened
