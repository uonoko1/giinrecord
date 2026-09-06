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

usage() {
  echo "usage: $0 [<base-ref>] [<head-ref>]" >&2
  echo "       $0 --verify <lines-file> [<head-ref>]" >&2
  exit 2
}

# --verify <file> [<head-ref>] — every `<path>\t<line>` in <file> must still be in <head-ref>.
# This is the mode the failure message points at, and it is the only one that means anything after a
# rebase. The default mode asks "what did the base gain since the merge-base"; a rebase moves the
# merge-base to the base tip, so that question answers "nothing" — measured: `git rebase -X theirs`
# and a hand resolution that overwrites the file with the branch's version both delete all 12 of the
# base's lines and both make the default mode print `ok`.
# --verify does not ask where the merge-base is. It asks whether these exact lines are there.
if [[ ${1:-} == --verify ]]; then
  [[ $# -ge 2 && $# -le 3 ]] || usage
  LINES_FILE=$2
  [[ -r $LINES_FILE ]] || { echo "stale-base: 読めません: $LINES_FILE" >&2; exit 2; }
  VERIFY_HEAD=$(git rev-parse --verify --quiet "${3:-HEAD}^{commit}") || {
    echo "stale-base: ref を解決できません: ${3:-HEAD}" >&2; exit 2; }
  VTMP=$(mktemp -d); trap 'rm -rf "$VTMP"' EXIT
  missing=0; total=0; vprev=""
  while IFS=$'\t' read -r vpath vline; do
    [[ -n "$vpath" ]] || continue
    total=$((total + 1))
    # The blob goes to a file first. `git show … | grep -q` looks right and is wrong: `grep -q` exits at
    # the first match, `git show` takes SIGPIPE, and under `set -o pipefail` the pipeline reports 141 —
    # so **every line that IS present reads as missing**. Measured: 12 present lines, 12 reported missing.
    if [[ $vpath != "$vprev" ]]; then
      vprev=$vpath
      git show "$VERIFY_HEAD:$vpath" > "$VTMP/blob" 2>/dev/null || : > "$VTMP/blob"
    fi
    if ! LC_ALL=C grep -qxF -- "$vline" "$VTMP/blob"; then
      missing=$((missing + 1))
      echo "  無い: $vpath | $vline" >&2
    fi
  done < "$LINES_FILE"
  if [[ $missing -gt 0 ]]; then
    echo "stale-base --verify: $total 行のうち $missing 行が ${3:-HEAD} にありません。" >&2
    echo "  rebase の衝突を自分の側で片付けたときに、これが起きます。両方の追記を残してください。" >&2
    exit 1
  fi
  echo "stale-base --verify: $total 行すべて ${3:-HEAD} にあります"
  exit 0
fi

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
# Line 1 is the resulting tree oid, which is not needed; lines 2.. are the conflicted paths.
# Kept as an exact-match set — a substring test would let `docs/a.md` cover `docs/a.md.bak`.
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
# Iterating BASE_TOUCHED rather than HEAD_TOUCHED is an equivalent mutation and is left as such: for a
# file only the branch touched, `gained` is empty and the loop skips it anyway. Measured on the
# reconstructed #531 shape — both spellings print the same 50 lines. Iterating the base's list is only
# the cheaper of the two, so no test tries to tell them apart.
CANDIDATES=()
for p in "${BASE_TOUCHED[@]}"; do
  [[ -n "$p" ]] || continue
  LC_ALL=C grep -qxF -- "$p" "$TMP/head-touched" && CANDIDATES+=("$p")
done

WOULD_LOSE=0      # the merge itself drops them
DIFF_DELETES=0    # the merge keeps them, but the PR diff shows them as deletions
REPORT="$TMP/report"
: > "$REPORT"
# Where the at-risk lines are written, so the rebase can be checked against them afterwards. Overridable
# only so the tests can read it; the default is a fixed path, not a temp dir, because the message names it.
# Written to a scratch file first and only moved into place when there is something to say. Truncating it
# up front destroys the evidence: the message tells you to rebase and re-run, and a re-run that now finds
# nothing (which is exactly the case worth catching — the merge-base moved) would empty the list it is
# about to be checked against. Measured: it turned `--verify` into "0 行すべてあります".
LINES_OUT=${STALE_BASE_LINES_OUT:-.git/stale-base-lines.tsv}
LINES_TMP="$TMP/lines.tsv"
: > "$LINES_TMP"
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
  # Every at-risk line, as `<path><TAB><line>`, for --verify to re-check after the rebase.
  cut -f2- < "$TMP/lost" | sed "s|^|$path\t|" >> "$LINES_TMP"
done

TOTAL=$((WOULD_LOSE + DIFF_DELETES))
if [[ $TOTAL -eq 0 ]]; then
  echo "stale-base: ok — $BASE が ${MERGE_BASE:0:8} 以降に足した行は、すべてこの枝にあります"
  if [[ -s $LINES_OUT ]]; then
    echo "  前回この検査が挙げた行が $LINES_OUT に残っています。**これで ok とせず**、次を実行してください:"
    echo "    bash $0 --verify $LINES_OUT"
    echo "  （rebase は共通の祖先を動かすので、この検査は行が消えていても ok と言います）"
  fi
  exit 0
fi

mkdir -p "$(dirname "$LINES_OUT")"
cp "$LINES_TMP" "$LINES_OUT"

cat >&2 <<MSG
stale-base: $BASE がこの枝を切ったあとに足した行 $TOTAL 行が、この枝にありません。
  （三方マージが落とす: $WOULD_LOSE 行 ／ マージは残すが diff では削除に見える: $DIFF_DELETES 行）

  $BASE  = ${BASE_SHA:0:8}
  共通の祖先 = ${MERGE_BASE:0:8}   ← ここから枝を切っています

$(cat "$REPORT")

これらは枝を切った後に $BASE に入った行なので、消す判断は誰もしていません。土台が古いだけです。

  git fetch origin
  git rebase origin/main        # 衝突したら、両方の追記を残す形で解決する

そのあと、**上の行が本当に残ったか**をこう確かめてください:

  bash scripts/ci/stale-base.sh --verify $LINES_OUT

**この2つ目のコマンドを飛ばさないこと。** rebase は共通の祖先を $BASE の先端まで動かすので、
**上の行を全部消したままでも、1つ目の検査（引数なし）は ok と言います**（実測: rebase -X theirs、
および衝突を枝の版で上書きする解決で、12 行すべて消えているのに ok）。
**--verify だけが、行そのものを見ています。**

消してよい行だと本当に判断したのなら、その理由を PR 本文に書いてください。
**この検査を外す・対象から除く・行を書き戻さずに黙らせる、のいずれもしないこと。**
MSG
exit 1
