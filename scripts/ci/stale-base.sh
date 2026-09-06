#!/usr/bin/env bash
# Issue #536: a branch cut from an old `main` silently deletes the lines main gained in the meantime.
# It happened 7 times over 2026-09-05..06; what was nearly lost were the lessons and the checks written
# that same day. `git diff --stat` does not show it for a docs-only PR ("1 file changed"), and nothing in
# CI knew about it.
#
#   scripts/ci/stale-base.sh [<base-ref>] [<head-ref>]     defaults: origin/main HEAD
#     exit 0 — nothing of the base's is lost
#     exit 1 — the branch would delete lines the base gained after the merge-base (names every line)
#     exit 2 — usage / a ref that does not resolve  (an unresolvable base is NOT reported as clean)
#
# What is measured, and why it is not "there are deletions".
#   Deliberate deletions are legitimate: dropping a check that is no longer needed, a refactor, deleting a
#   file. What is never deliberate is deleting a line the author **never saw**. Per file:
#     M = merge-base(base, head)   what the branch author started from
#     B = base (origin/main)       what is on main now
#     H = head                     what the branch has
#   `gained` = lines in B that are not in M — everything main added since the branch was cut. Nobody on
#   this branch has decided anything about them.
#   Whether they survive depends on how the branch lands, so the comparison is against **what would land**:
#     · the file merges cleanly three-way  → the merge result (git merge-tree). main's lines are in it,
#       so a stale base on its own is not an error. Being BEHIND main is normal.
#     · the file conflicts                 → H's content, because that is what "resolve by taking my
#       side" produces, and that is what happened all 7 times.
#   Comparison is by exact line content as a multiset (`comm` over sorted, occurrence-numbered lines), so
#   a line that legitimately appears N times keeps its N copies.
#
#   This passes, by construction, on: an up-to-date base; a deliberate deletion of lines that existed at
#   M; files main never touched; a line the branch happens to write itself; anything main *deleted*.
#
# Two traps this deliberately avoids (both cost real time on #536):
#   · `git diff | grep -c '^-[^-]'` counts 0 for a deleted line that itself starts with `-` (it reads as
#     `^--`). The agreement file is a bullet list, so that command is blind on exactly the document it is
#     meant to protect. Nothing here parses diff output: file contents are read with `git show`.
#   · A count of deleted lines cannot tell deliberate from accidental. Only the comparison above can.
set -euo pipefail

usage() { echo "usage: $0 [<base-ref>] [<head-ref>]" >&2; exit 2; }
[[ $# -le 2 ]] || usage
BASE=${1:-origin/main}
HEAD_REF=${2:-HEAD}

resolve() { # <ref> → sha, or exit 2 naming the ref (never silently "clean")
  local sha
  sha=$(git rev-parse --verify --quiet "$1^{commit}") || {
    echo "stale-base: ref を解決できません: $1" >&2
    echo "  origin/main が無いなら  git fetch origin  を先に実行してください。" >&2
    exit 2
  }
  echo "$sha"
}
BASE_SHA=$(resolve "$BASE")
HEAD_SHA=$(resolve "$HEAD_REF")
MERGE_BASE=$(git merge-base "$BASE_SHA" "$HEAD_SHA") || {
  echo "stale-base: $BASE と $HEAD_REF に共通の祖先がありません" >&2; exit 2
}

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# The three-way merge of the two commits, exactly the one GitHub would run. Line 1 is the resulting tree;
# on conflict (exit 1) the remaining lines are the conflicted paths. Any other exit is a real failure.
set +e
git merge-tree --write-tree --name-only "$BASE_SHA" "$HEAD_SHA" > "$TMP/merge" 2> "$TMP/merge.err"
MERGE_STATUS=$?
set -e
if [[ $MERGE_STATUS -gt 1 ]]; then
  echo "stale-base: git merge-tree が失敗しました（$MERGE_STATUS）" >&2
  cat "$TMP/merge.err" >&2
  exit 2
fi
MERGED_TREE=$(head -1 "$TMP/merge")
# Conflicted paths, as an exact-match set (a substring test would let `docs/a.md` cover `docs/a.md.bak`).
tail -n +2 "$TMP/merge" > "$TMP/conflicted"
is_conflicted() { LC_ALL=C grep -qxF -- "$1" "$TMP/conflicted"; }

# multiset <tree-ish> <path> → the file's lines, sorted, each prefixed with its occurrence number, so that
# `comm` on two of these subtracts multisets.
# A path absent from that tree (or not a regular file) yields nothing, and that is a real answer, not an
# error: it is how "main deleted this file" and "the branch never had it" are expressed. `git show` exits
# 128 there, so the existence check is explicit — under `set -o pipefail` a bare `2>/dev/null` would abort
# the whole run and report nothing at all.
multiset() {
  local type
  type=$(git cat-file -t "$1:$2" 2>/dev/null) || return 0
  [[ $type == blob ]] || return 0
  git show "$1:$2" | LC_ALL=C sort | LC_ALL=C awk '{ print ++n[$0] "\t" $0 }' | LC_ALL=C sort
}

# Only files the base changed since the merge-base can have lines to lose.
mapfile -d '' -t CANDIDATES < <(git diff -z --name-only "$MERGE_BASE" "$BASE_SHA")

LOST_TOTAL=0
CONFLICTED_ANY=0
REPORT="$TMP/report"
: > "$REPORT"
for path in "${CANDIDATES[@]}"; do
  [[ -n "$path" ]] || continue
  multiset "$BASE_SHA"   "$path" > "$TMP/b"
  multiset "$MERGE_BASE" "$path" > "$TMP/m"
  LC_ALL=C comm -23 "$TMP/b" "$TMP/m" > "$TMP/gained"   # what main added to this file since we branched
  [[ -s "$TMP/gained" ]] || continue
  # What would land: the merge result, or — when the file conflicts — whatever the branch has, because
  # that is what resolving the conflict in the branch's favour produces.
  if is_conflicted "$path"; then
    CONFLICTED_ANY=1
    multiset "$HEAD_SHA" "$path" > "$TMP/landed"
  else
    multiset "$MERGED_TREE" "$path" > "$TMP/landed"
  fi
  LC_ALL=C comm -23 "$TMP/gained" "$TMP/landed" > "$TMP/lost"
  n=$(wc -l < "$TMP/lost")
  [[ $n -gt 0 ]] || continue
  LOST_TOTAL=$((LOST_TOTAL + n))
  { echo "  $path: $n 行"
    cut -f2- < "$TMP/lost" | head -20 | sed 's/^/    | /'
    [[ $n -le 20 ]] || echo "    | …ほか $((n - 20)) 行"
  } >> "$REPORT"
done

if [[ $LOST_TOTAL -eq 0 ]]; then
  echo "stale-base: ok — $BASE が ${MERGE_BASE:0:8} 以降に足した行は、すべてこの枝に残ります"
  exit 0
fi

cat >&2 <<MSG
stale-base: この枝は $BASE の行を $LOST_TOTAL 行消します。

  $BASE  = ${BASE_SHA:0:8}
  共通の祖先 = ${MERGE_BASE:0:8}   ← ここから枝を切っています

消える行（$BASE には在り、共通の祖先には無く、この枝には残らない行）:
$(cat "$REPORT")

これらは枝を切った後に $BASE に入った行なので、消す判断は誰もしていません。
土台が古いだけです。$BASE に合わせ直してください:

  git fetch origin
  git rebase origin/main

**衝突を「自分の側を採る」で片付けると、上の行はそのまま消えます。**
上の行が残っていることを、rebase のあとにこの検査で確かめてください:

  bash scripts/ci/stale-base.sh

消してよい行だと本当に判断したのなら、その理由を PR 本文に書いてください。
**この検査を外す・対象から除く・行を書き戻さずに黙らせる、のいずれもしないこと。**
MSG
exit 1
