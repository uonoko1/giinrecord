#!/usr/bin/env bash
# merge-when-green.sh <pr>
#   1. refuse unless the PR is OPEN and not a draft
#   2. `gh pr update-branch` when it is BEHIND main
#      if that is refused because the gh OAuth token lacks the `workflow` scope (the PR touches
#      .github/workflows/*), fall back to merging origin/main into the PR head in a temporary
#      worktree and pushing over SSH (#200); a merge conflict aborts with nothing pushed
#   3. poll `gh pr checks` until every check is pass/skipping (fail/cancel → abort)
#      main may move while we wait (another PR merged → BEHIND, strict status checks block the
#      merge): every poll re-checks mergeStateStatus and runs update-branch again (#89, like etl.yml)
#      while waiting on data/refresh only: approve `action_required` workflow runs
#   4. `gh pr merge --squash --delete-branch`
#      refused by the strict base-branch policy → update the branch and **wait for the checks to
#      re-run** before trying again (#392); a fixed sleep is not enough (docker-web takes 1-3 min)
# Before every merge attempt: re-read the PR head and refuse if it moved since we started (#392).
# Before touching anything: refuse if another open PR is based on this branch (#392) — merging
# deletes the head branch, which closes those PRs.
# Env: POLL_INTERVAL (s, default 20), POLL_MAX (default 60), PO_REPO (owner/name override).
# Destructive operations: the squash merge (+ head branch deletion) of the given PR, and — only
# in the workflow-scope fallback — a merge commit of origin/main pushed to the PR head branch.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

DATA_BRANCH="data/refresh"

if [[ $# -ne 1 ]] || ! is_int "$1"; then usage "merge-when-green.sh <pr-number>"; fi
PR=$1
REPO=$(po_repo)

# --- 1. state ---------------------------------------------------------------------------------
IFS=$'\t' read -r STATE DRAFT HEAD MERGE_STATE URL HEAD_OID < <(
  gh pr view "$PR" --json state,isDraft,headRefName,mergeStateStatus,url,headRefOid \
    -q '[.state, (.isDraft|tostring), .headRefName, .mergeStateStatus, .url, .headRefOid] | @tsv'
)
log "PR #$PR ($HEAD) state=$STATE draft=$DRAFT mergeState=$MERGE_STATE head=${HEAD_OID:0:7} $URL"
[[ "$STATE" == "OPEN" ]] || die "PR #$PR is $STATE, not OPEN"
[[ "$DRAFT" == "false" ]] || die "PR #$PR is a draft; mark it ready for review first"

# 別の open PR がこのブランチを base にしていないか（#392）。
# 我々は `--delete-branch` でマージするので、**その瞬間 GitHub は上に積まれた PR を CLOSED にする**。
# 実際に踏んだ: #390 をマージしたら、#390 を base にしていた #391 が閉じ、`gh pr reopen` も
# 「base が無い」で通らず、PR を出し直すことになった。作業が消えるわけではないが、
# 気づかなければ「レビュー中だったはずの PR」が黙って消える。
# 先に上の PR の base を切り替えてもらう（それだけで安全にマージできる）ので、ここでは中断する。
# **起動時とマージ直前の両方**で確かめる。起動時だけだと、CI を待っている数分の間に
# 誰かが上に PR を積んだ場合を取り逃がす（assert_head_unchanged はマージ直前に毎回
# 呼ぶのに、こちらだけ1回では非対称）。
assert_no_stacked_prs() {
  local stacked
  stacked=$(gh pr list --repo "$REPO" --base "$HEAD" --state open --json number -q '.[].number' | tr '\n' ' ')
  stacked=${stacked% }
  [[ -n "$stacked" ]] || return 0
  die "PR #$PR ($HEAD) を base にしている open PR があります: ${stacked// /, }
       このままマージするとブランチが消え、それらの PR は GitHub に CLOSED にされます（reopen できません）。
       先に  gh pr edit <番号> --base main  で base を切り替えてください。"
}
assert_no_stacked_prs

# --- 2. bring up to date ----------------------------------------------------------------------
# merge_main_locally — fallback for `gh pr update-branch` being refused because the gh OAuth
# token lacks the `workflow` scope (the PR touches .github/workflows/*, #200). Merges
# origin/main into the PR head in a temporary worktree and pushes it over SSH (SSH keys are not
# limited by OAuth scopes). A merge conflict aborts cleanly: nothing is pushed, the worktree is
# removed, and the script exits with a message; other failures are logged, not fatal.
merge_main_locally() {
  local root tmp wt
  root=$(git rev-parse --show-toplevel 2>/dev/null) \
    || { log "not inside a git checkout; update PR #$PR manually"; return 1; }
  log "update-branch refused (workflow scope) → merging origin/main locally and pushing via SSH"
  git -C "$root" fetch origin \
      "+refs/heads/main:refs/remotes/origin/main" "+refs/heads/$HEAD:refs/remotes/origin/$HEAD" \
    || { log "git fetch failed; update PR #$PR manually"; return 1; }
  tmp=$(mktemp -d)
  wt="$tmp/wt"
  if ! git -C "$root" worktree add --detach "$wt" "origin/$HEAD"; then
    rm -rf "$tmp"
    log "could not create a temporary worktree; update PR #$PR manually"
    return 1
  fi
  if ! git -C "$wt" merge --no-edit origin/main; then
    git -C "$wt" merge --abort || true
    git -C "$root" worktree remove --force "$wt" || true
    rm -rf "$tmp"
    die "origin/main conflicts with $HEAD — resolve the conflict manually (nothing was pushed)"
  fi
  # push できたかを**返り値で伝える**（#392 のレビュー指摘）。呼び出し側はこれを見て
  # repin するかを決める。失敗したのに repin すると、その窓の他人の push を飲み込む。
  local pushed=0
  git -C "$wt" push "git@github.com:$REPO.git" "HEAD:refs/heads/$HEAD" \
    || { pushed=1; log "SSH push of the merged $HEAD failed — push it manually"; }
  git -C "$root" worktree remove --force "$wt" || true
  rm -rf "$tmp"
  return "$pushed"
}

# repin_head — 我々自身がブランチを進めた後（update-branch / ローカルマージ）に基準を取り直す。
# これをしないと、自分で動かした HEAD を「他人が push した」と誤検出して毎回中断してしまう。
#
# **既知の限界（塞げていない窓）**: `gh pr update-branch` は新しい oid を返さないので、
# ここは「今の HEAD」を読み直すしかない。**update-branch が成功してから、この API 読みが
# 返るまで**の1リクエスト分（サブ秒）に人が push すると、それを自分の更新として飲み込む。
# 完全に塞ぐには「新しい HEAD の親に旧 HEAD_OID が含まれるか」まで見る必要がある。
# 窓が極めて狭いのと、docs/WORKING_AGREEMENT.md の「マージ処理を走らせたらそのブランチには
# 触らない」が一次防御になっているので、いまは受け入れている。**「成功時だけ repin すれば
# 完全に安全」ではない**ことを、次に読む人のために書いておく。
repin_head() {
  local oid
  oid=$(gh pr view "$PR" --json headRefOid -q .headRefOid 2>/dev/null || true)
  [[ -n "$oid" ]] && HEAD_OID=$oid
  return 0
}

# assert_head_unchanged — マージ直前に呼ぶ。起動時（またはこちらが更新した時点）の HEAD と
# 今の HEAD がずれていたら**中断する**（#392）。
# PR #389 で踏んだ: マージ処理を起動した後に同じブランチへ push したところ、スクリプトが
# **古い方をマージしてブランチを削除**した。commit は手元に残っていたので cherry-pick で
# 復旧できたが、気づかなければ失われていた。
# 新しい方を勝手にマージしないこと：**検査は古い HEAD に対して走っている**ので、
# 追加分は誰にも検査されないままマージされる。人がやり直すのが正しい。
assert_head_unchanged() {
  local now
  now=$(gh pr view "$PR" --json headRefOid -q .headRefOid)
  [[ "$now" == "$HEAD_OID" ]] && return 0
  die "PR #$PR ($HEAD) の HEAD がこの処理の開始後に動きました（${HEAD_OID:0:7} → ${now:0:7}）。
       追加されたコミットは検査を通っていないので、マージしません。
       新しい HEAD で流し直してください: scripts/po/merge-when-green.sh $PR"
}

# update_if_behind [state] → 0 when an update was attempted (checks will re-run), 1 otherwise.
# A failed update is logged, not fatal: the merge step then surfaces the real blocker. The one
# exception is the workflow-scope refusal, which is handled by merge_main_locally (see above).
update_if_behind() {
  local state=${1:-} err
  [[ -n "$state" ]] || state=$(gh pr view "$PR" --json mergeStateStatus -q .mergeStateStatus)
  [[ "$state" == "BEHIND" ]] || return 1
  log "branch is behind main → gh pr update-branch"
  # **成功したときだけ** repin する（#392 のレビュー指摘）。
  # 無条件に repin すると、更新が失敗した場合も「今の HEAD」を読み直してしまい、
  # **その窓で人が push したコミットを自分の更新として飲み込む**。
  # assert_head_unchanged が守るはずの #389 が、そのまま戻ってくる経路だった。
  # 特に起きやすいのは、ポーリング中に main が動いて BEHIND になる普通の筋。
  if err=$(gh pr update-branch "$PR" 2>&1); then
    repin_head   # 自分で進めた分は「他人の push」ではない
  else
    [[ -n "$err" ]] && printf '%s\n' "$err" >&2
    if [[ "$err" == *workflow*scope* ]]; then
      # ローカルマージ + SSH push。**push が成功したときだけ** repin する
      if merge_main_locally; then repin_head; fi
    else
      log "could not update branch (conflicts? update it manually)"
    fi
  fi
  return 0
}
update_if_behind "$MERGE_STATE" || true

# --- 3. poll checks ---------------------------------------------------------------------------
approve_pending_runs() {
  local run
  # `gh api -q` prints nothing for an empty list; each approval is best-effort (permissions).
  for run in $(gh api "repos/$REPO/actions/runs?branch=$DATA_BRANCH&status=action_required" -q '.workflow_runs[].id'); do
    log "approving action_required run $run"
    gh api -X POST "repos/$REPO/actions/runs/$run/approve" >/dev/null || log "could not approve run $run (approve it in the Actions UI)"
  done
}

# wait_for_green — チェックが全部 pass/skipping になるまで待つ。POLL_MAX を通算で使い切る
# （マージ拒否のたびに待ち直すので、上限をリセットすると無限に粘れてしまう）。
i=0
wait_for_green() {
  while true; do
    i=$((i + 1))
    # exit 8 = checks pending, exit 1 = a check failed or no checks yet; output still carries the facts
    checks=$(gh pr checks "$PR" --json name,bucket -q '.[] | "\(.bucket)\t\(.name)"' || true)
    failed=$(awk -F'\t' '$1=="fail"||$1=="cancel"{print $2}' <<<"$checks")
    pending=$(awk -F'\t' '$1=="pending"{print $2}' <<<"$checks")
    total=$(grep -c . <<<"$checks" || true)
    if [[ -n "$failed" ]]; then
      die "checks failed on PR #$PR: $(tr '\n' ' ' <<<"$failed")"
    fi
    if [[ -z "$pending" && "$total" -gt 0 ]]; then
      if update_if_behind; then
        log "[$i/$POLL_MAX] checks were green on an old base; waiting for them to re-run"
      else
        log "all $total checks green"
        break
      fi
    else
      if [[ "$total" -eq 0 ]]; then log "[$i/$POLL_MAX] no checks reported yet"; else log "[$i/$POLL_MAX] pending: $(tr '\n' ' ' <<<"$pending")"; fi
      update_if_behind || true
      if [[ "$HEAD" == "$DATA_BRANCH" ]]; then approve_pending_runs; fi
    fi
    if [[ "$i" -ge "$POLL_MAX" ]]; then
      die "timed out after $POLL_MAX polls waiting for checks on PR #$PR"
    fi
    sleep "$POLL_INTERVAL"
  done
}
wait_for_green

# --- 4. merge ---------------------------------------------------------------------------------
# 保護は `strict: true`（main に追いついていることが必須）なので、**チェックが緑になってから
# マージするまでの間に別の PR が main に入るとその瞬間だけ古くなり**、GitHub は
# "the base branch policy prohibits the merge" で拒む（mergeStateStatus は CLEAN のまま）。
# 実際に踏んだ（#384）。1 回で諦めず、取り込み直して数回試す。
# 取り込み直した後は **チェックが再実行される** ので、待たずに再試行すると BLOCKED で拒まれる。
# 実際に踏んだ（#392、PR #390）: update-branch の直後に固定 sleep で3回試して全部失敗し、
# `mergeStateStatus` は UNSTABLE、`docker-web` が pending のままだった。
# POLL_INTERVAL×3 ≒ 1分しか待たないのに、docker-web は 1〜3 分かかる。
# **時間で決め打ちせず、状態が緑に戻るまで待つ**（上限は通算の POLL_MAX）。
log "squash-merging PR #$PR and deleting $HEAD"
for attempt in 1 2 3; do
  assert_head_unchanged     # 待っている間に push されたコミットを取り残さない（#392）
  assert_no_stacked_prs     # 待っている間に上へ積まれた PR を巻き添えにしない（#392）
  if gh pr merge "$PR" --squash --delete-branch; then
    echo "merged PR #$PR ($HEAD) $URL"
    exit 0
  fi
  [[ "$attempt" == 3 ]] && die "merge refused 3 times for PR #$PR (see the message above)"
  log "merge refused (attempt $attempt/3); updating the branch and waiting for the checks to re-run"
  if gh pr update-branch "$PR" >/dev/null 2>&1; then repin_head; fi
  # **必ず1回は待つ**（#392 のレビュー指摘）。GitHub がチェックを pending に落とすまでには
  # 数秒〜十数秒あり、その間は「前回の緑」がまだ見える。wait_for_green は緑を見た瞬間に
  # break するので、**待ち直しが 0 回で素通りする**（実測: 3回のマージ試行が 0 秒で終わった）。
  # 直す前の固定 sleep より短くなっていた——#390 の再現条件そのもの。
  i=$((i + 1))
  [[ "$i" -ge "$POLL_MAX" ]] && die "timed out after $POLL_MAX polls waiting for checks on PR #$PR"
  sleep "$POLL_INTERVAL"
  wait_for_green
done
