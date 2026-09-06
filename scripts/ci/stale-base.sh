#!/usr/bin/env bash
# Issue #536: a branch cut from an old `main` shows up as a PR that deletes the lines main gained in the
# meantime. It happened 7 times over 2026-09-05..06 (#470 / #485 / #477 / #517 / and the PO three times);
# what was on the chopping block were the lessons and the checks written that same day.
# `git diff --stat` does not show it for a docs-only PR ("1 file changed"), and nothing in CI knew.
#
#   scripts/ci/stale-base.sh [<base-ref>] [<head-ref>]     defaults: origin/main HEAD
#     exit 0 — nothing of the base's is on the chopping block
#     exit 1 — lines the base gained after the merge-base are missing from this branch (names every line)
#     exit 2 — usage / a ref that does not resolve  (an unresolvable base is NOT reported as clean)
#
# ── What is measured, and why it is not "there are deletions" ───────────────────────────────────
#   Deliberate deletions are legitimate: dropping a check that is no longer needed, a refactor, deleting
#   a whole file. What is never deliberate is deleting a line the author **never saw**. Per file:
#     M = merge-base(base, head)   what the branch author started from
#     B = base (origin/main)       what is on main now
#     H = head                     what the branch has
#   `gained` = lines in B that are not in M — everything main added since the branch was cut. Nobody on
#   this branch has decided anything about them. `lost` = those that are absent from H.
#   Comparison is by exact line content as a multiset (`comm` over sorted, occurrence-numbered lines), so
#   a line that legitimately appears N times keeps its N copies. Nothing here parses diff output.
#
#   By construction this stays quiet for: an up-to-date base; a deliberate deletion of lines that existed
#   at M; files main never touched; a line the branch happens to write itself; anything main *deleted*.
#
# ── Two severities, because they are two different facts (both fail; see #536) ───────────────────
#   WOULD-LOSE   the three-way merge itself does not keep the lines: the file conflicts, so whoever
#                resolves it decides, and "take my side" — what happened all 7 times — drops them.
#   DIFF-DELETES the three-way merge does keep them (measured with git merge-tree), but they still show
#                up as deletions in `git diff <base> HEAD`, which is the surface every reviewer reads.
#                Measured on the reconstructed #531/#534 shape: `2 insertions(+), 50 deletions(-)` on
#                docs/WORKING_AGREEMENT.md, and a real `git merge --squash` kept all 50 lines.
#                So the merge was safe and the review surface was not: a reviewer cannot tell this apart
#                from a PR that really removes 50 lines, and one rebase resolved the wrong way makes it
#                real. Both are worth a rebase, so both fail — but they are reported as what they are.
#
# ── The trap this deliberately avoids ────────────────────────────────────────────────────────────
#   `git diff | grep -c '^-[^-]'` counts 0 for a deleted line that itself starts with `-`, because the
#   diff renders it as `^--`. docs/WORKING_AGREEMENT.md is a bullet list, so that command is blind on
#   exactly the document it is meant to protect (measured on the #531 shape: `--numstat` says 50,
#   `grep -c '^-[^-]'` says 0). File contents are read with `git show`; no diff text is parsed.
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

# The three-way merge of the two commits, the one GitHub would run. Line 1 is the resulting tree; on
# conflict (exit 1) the remaining lines are the conflicted paths. Any other exit is a real failure.
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

# multiset <tree-ish> <path> → the file's lines, sorted, each prefixed with its occurrence number, so
# that `comm` on two of these subtracts multisets.
# A path absent from that tree (or not a regular file) yields nothing, and that is a real answer, not an
# error: it is how "main deleted this file" and "the branch never had it" are expressed. `git show` exits
# 128 there, so the existence check is explicit — under `set -o pipefail` a bare `2>/dev/null` would
# abort the whole run and report nothing at all (measured: exit 128 with no output).
multiset() {
  local type
  type=$(git cat-file -t "$1:$2" 2>/dev/null) || return 0
  [[ $type == blob ]] || return 0
  git show "$1:$2" | LC_ALL=C sort | LC_ALL=C awk '{ print ++n[$0] "\t" $0 }' | LC_ALL=C sort
}

# Candidates = files BOTH sides changed since the merge-base.
#   · the base did not change it   → it has no new lines to lose
#   · the branch did not change it → the branch's copy is the merge-base's copy, git merges it without
#     asking anyone, and the lines always survive. Being BEHIND main is normal and must stay quiet:
#     firing on it would fail every open PR the moment main moves, and a check that fires on everything
#     is a check nobody reads.
# What is left is the shape from #536: **the branch edited a file main also edited, and its copy does
# not have main's new lines.**
mapfile -d '' -t BASE_TOUCHED < <(git diff -z --name-only "$MERGE_BASE" "$BASE_SHA")
mapfile -d '' -t HEAD_TOUCHED < <(git diff -z --name-only "$MERGE_BASE" "$HEAD_SHA")
printf '%s\n' "${HEAD_TOUCHED[@]}" | LC_ALL=C sort -u > "$TMP/head-touched"
CANDIDATES=()
for p in "${BASE_TOUCHED[@]}"; do
  [[ -n "$p" ]] || continue
  LC_ALL=C grep -qxF -- "$p" "$TMP/head-touched" && CANDIDATES+=("$p")
done

WOULD_LOSE=0      # the merge itself drops them
DIFF_DELETES=0    # the merge keeps them, but the PR diff shows them as deletions
REPORT="$TMP/report"
: > "$REPORT"
for path in "${CANDIDATES[@]}"; do
  [[ -n "$path" ]] || continue
  multiset "$BASE_SHA"   "$path" > "$TMP/b"
  multiset "$MERGE_BASE" "$path" > "$TMP/m"
  LC_ALL=C comm -23 "$TMP/b" "$TMP/m" > "$TMP/gained"   # what main added to this file since we branched
  [[ -s "$TMP/gained" ]] || continue
  multiset "$HEAD_SHA" "$path" > "$TMP/h"
  LC_ALL=C comm -23 "$TMP/gained" "$TMP/h" > "$TMP/lost"
  n=$(wc -l < "$TMP/lost")
  [[ $n -gt 0 ]] || continue
  if is_conflicted "$path"; then
    kind="WOULD-LOSE"; note="この枝の側を採って解決すると、そのまま消えます（三方マージは衝突します）"
    WOULD_LOSE=$((WOULD_LOSE + n))
  else
    kind="DIFF-DELETES"; note="三方マージ自体は残しますが、$BASE との diff では削除として出ます"
    DIFF_DELETES=$((DIFF_DELETES + n))
  fi
  { echo "  [$kind] $path: $n 行 — $note"
    cut -f2- < "$TMP/lost" | head -20 | sed 's/^/    | /'
    [[ $n -le 20 ]] || echo "    | …ほか $((n - 20)) 行"
  } >> "$REPORT"
done

TOTAL=$((WOULD_LOSE + DIFF_DELETES))
if [[ $TOTAL -eq 0 ]]; then
  echo "stale-base: ok — $BASE が ${MERGE_BASE:0:8} 以降に足した行は、すべてこの枝にあります"
  exit 0
fi

cat >&2 <<MSG
stale-base: $BASE がこの枝を切ったあとに足した行 $TOTAL 行が、この枝にありません。
  （三方マージが落とす: $WOULD_LOSE 行 ／ マージは残すが diff では削除に見える: $DIFF_DELETES 行）

  $BASE  = ${BASE_SHA:0:8}
  共通の祖先 = ${MERGE_BASE:0:8}   ← ここから枝を切っています

$(cat "$REPORT")

これらは枝を切った後に $BASE に入った行なので、消す判断は誰もしていません。土台が古いだけです。

  git fetch origin
  git rebase origin/main

**衝突を「自分の側を採る」で片付けると、上の行はそのまま消えます。両方の追記を残してください。**
rebase のあと、上の行が戻ったことをこの検査で確かめてください:

  bash scripts/ci/stale-base.sh

消してよい行だと本当に判断したのなら、その理由を PR 本文に書いてください。
**この検査を外す・対象から除く・行を書き戻さずに黙らせる、のいずれもしないこと。**
MSG
exit 1
