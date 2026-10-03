#!/usr/bin/env bash
# Issue #536: a branch cut from an old `main` shows up as a PR that deletes the lines main gained in the
# meantime. It happened 7 times over 2026-09-05..06 (#470 / #485 / #477 / #517 / and the PO three times);
# what was on the chopping block were the lessons and the checks written that same day.
# `git diff --stat` does not show it for a docs-only PR ("1 file changed"), and nothing in CI knew.
#
#   scripts/ci/stale-base.sh [<base-ref>] [<head-ref>]     defaults: origin/main HEAD
#     exit 0 — nothing of the base's is on the chopping block
#     exit 1 — lines the base gained after the merge-base are missing from this branch (names every line)
#            — OR (Issue #565) <base-ref> is a remote-tracking ref and does not match what the remote
#              actually has right now (nobody ran `git fetch`). Only checked when a matching remote is
#              registered and reachable; see the block below for why silence elsewhere is deliberate.
#     exit 2 — usage / a ref that does not resolve  (an unresolvable base is NOT reported as clean)
#
#   scripts/ci/stale-base.sh --data-freshness [<base-ref>] [<head-ref>]     Issue #1156
#     exit 0 — data/**/meta.json の fetchedAt がどれも後退していない（見た件数を必ず出す）
#     exit 1 — どれかの fetchedAt が <base-ref> より古い（data/ が丸ごと巻き戻る形）
#            — OR fetchedAt を**測れなかった**（読めない／無い／日付として解釈できない）。
#              「測れなかった」を「古くない」として通さない（#1158）
#     **残っている限界（この PR では直していない）**: `stale-base` という check-run 名は
#     `scripts/po/merge-when-green.sh` の `NONREQUIRED_CHECKS` に入っている（#858）。理由は
#     `--net-deletions` が「赤いが通してよい」が正常に起こる検査だから（実地 5 件中 3 件）。
#     **この `--data-freshness` step はそちらではない**——赤なら必ず rebase が答えで、
#     「赤いまま通してよい」場合が無い。だが 3 つの step が 1 つの job（= 1 つの check-run 名）に
#     同居しているので、**`--allow-nonrequired-red` はこの step の赤も一緒に通す。**
#     分けるには job を割る必要があり、それは branch protection の必須一覧
#     （packages/etl/test/branch-protection-jobs.test.ts）に触る別の判断なので、ここでは触らない。
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
# ── What this does NOT catch, and why it is a different layer (#504) ────────────────────────────
#   Once the branch has been rebased, the merge-base IS the base tip, so "what did the base gain since
#   the merge-base" answers "nothing" — and it answers that whether or not the base's lines are still
#   there. Measured: `git rebase -X theirs origin/main`, and a hand resolution that overwrites the file
#   with the branch's version, both delete all 12 of the base's lines and both make the default mode
#   print `ok`. What is needed to tell those apart (where the branch was cut from) is destroyed by the
#   rebase — it is not in the refs any more, so no amount of care in this mode recovers it.
#   That is what `--verify` is for: it is handed the lines and looks for them, and never asks where the
#   merge-base is. The failure message points at it, and the `ok` message keeps pointing at it for as
#   long as the file of at-risk lines is lying around — because `ok` is exactly what the default mode
#   says after a bad rebase.
#   CI runs the default mode, and sees the PR before it is rebased, which is when the question can still
#   be answered. A branch rebased badly *before* it is ever pushed is outside what this can see: the
#   evidence is gone by then. That is the "this layer cannot" kind of gap, not the "could but did not".
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
  echo "       $0 --net-deletions [<base-ref>] [<head-ref>]" >&2
  echo "       $0 --data-freshness [<base-ref>] [<head-ref>]" >&2
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

# --data-freshness [<base-ref>] [<head-ref>] — Issue #1156.
#
# 何が壊れていたか。**2026-09-30、`data/` 一式（34 行）が丸ごと巻き戻る形が 4 つのゲートを全部通った。**
# 日次 ETL が `main` に `data/` を入れたあと、分岐済みの枝をそのままマージすると、枝の側は
# 古い `data/` を持っているので `main` の新しい `data/` を上書きする。実測（#1149 / #1127、2026-09-30）:
#
#   origin/main  "fetchedAt": "2026-09-29T23:59:47.817Z"
#   枝           "fetchedAt": "2026-09-29T00:43:05.576Z"
#
#   引数なしの検査    枝は `data/` を 1 行も触っていない（own-data = 0）ので候補にならない  → ok
#   --net-deletions   34 行減って 34 行増える → 差し引き 0（`added >= lost`）             → ok
#   check             `fetchedAt` を見る検査が無い                                          → ok
#   レビュー           大きな差分に埋もれる                                                 → 通った
#
# **行数は打ち消せるが、時刻は打ち消せない。** `--net-deletions` の `added < lost` は「差し引き 0」で
# 通る作りで（それは正しい——意図した書き換えを毎回鳴らさないため）、行の数え方を変えても
# この形には届かない。だから行ではなく**時刻そのもの**を見る。
#
#   base の <対象の meta.json> の fetchedAt  >  head の同じファイルの fetchedAt   → 落ちる
#
# ── 対象は `data/meta.json` 1 件ではない（#1156 のレビューが実測で否定した） ─────────────
# この検査の最初の版は `data/meta.json` だけを見ていた。**`data/meta.json` は `data/` の代表では
# なかった。** 日次 ETL 以外に**月次**のワークフローが 2 本あり、どちらも `data/meta.json` を
# 進めないまま別の `meta.json` を進める:
#   .github/workflows/districts.yml        cron "0 20 1 * *"   data/districts/meta.json のみ
#   .github/workflows/local-assemblies.yml cron "0 20 4 * *"   data/assemblies/*/meta.json
# 実測（probe を組んで確認。`2f136cd1` = `data: districts` は `data/districts/meta.json` だけを
# 触っており、`data/meta.json` を動かしていない）:
#   git diff --numstat origin/main <probe> -- data/  →  54  54  data/districts/meta.json
#   既定モード / --net-deletions / --data-freshness（1 件版）  すべて rc=0（素通り）
# **月次なので巻き戻る幅は 1 か月ぶん。** だから `data/**/meta.json` を全部見る。
#
# 列挙にしない理由（レビューの指摘）: **新しい `data/*/meta.json` が生えると列挙漏れが即穴**になる
# ——denylist の型。`git ls-tree -r -- <pathspec>` で**ツリーから glob で拾う**。
# （`git ls-files` は**未追跡ファイルを見ない**ので使わない。ツリーを読めば、チェックアウトされて
# いないファイルも数えられる。）
# 広げても偽陽性は増えない（実測、開いている枝 9 本 × 13 件 = 母数 117 組 → 増える赤 0 件。
# main 直近 300 コミットで fetchedAt の後退 0 件。13 件すべてが同じ ISO 8601 UTC 形式）。
#
# 型を区別しない理由。当初は「枝のコミットが `data/` を書いた（`git add -A` で拾った）型 B」と
# 「base が古いだけの型 A」を分ける案だった。**実測で型 B は 0 本**（開いていた 10 本すべてを
# `vs-main` と `own-data` で測った結果、#1156 のコメントに在る）。そして**どちらも
# 「古い時刻をマージしようとしている」**ので、どちらも止めてよい。型 A は
# `scripts/po/merge-when-green.sh` の `update-branch`（`:12`）で解消するので、
# 落ちても答えは「rebase せよ」であり、誤報にならない。**`merge-base` を取る必要も無い。**
#
# ── 「測れなかった」を黙って通さない（#1158） ─────────────────────────────────────────
# 対象の `meta.json` が片側に無い／`fetchedAt` が無い／日付として解釈できない
# → **exit 1 で「測れません」と言う。**
# 「比較できなかった」を「古くない」と扱わない。理由は実測: **`gh` はレート制限時に `exit 0` で
# エラー文字列を返し、`jq` は `null` を返して 0 件に見える。** 「0 件」と「取れなかった」の区別が要る。
# head からファイルを消すだけでこの検査を黙らせられる、という抜け道も同じ扱いで塞がる。
# **対象が 1 件も無いときだけ黙る**: 比較の対象がそもそも無いのは「測れなかった」ではない
#   （この検査より前に作られたフィクスチャ・`data/` を持たないチェックアウトが該当する）。
#
# ── 母数（#757） ─────────────────────────────────────────────────────────────────────
# **見たファイル数を、成功時も失敗時も必ず出す。** 「13 件見た」と「1 件しか見ていない」が
# 出力で区別できないと、対象が静かに 1 件に縮んでも同じ顔をする——**この検査の最初の版が
# まさにそれだった**（`data/meta.json` 1 件だけを見て `ok` と言っていた）。
#
# 日付の読み方は `date -u -d` に投げない: ISO 8601 の `Z` 付きの文字列は**辞書順の比較が
# 時刻順の比較と一致する**（固定長・UTC・ゼロ埋め）。外部コマンドに投げるほうが、
# ロケールやエラー時の exit 0 を持ち込む分だけ弱い。形が ISO 8601 かどうかだけを厳密に見て、
# 比較は文字列でする。
if [[ ${1:-} == --data-freshness ]]; then
  shift
  [[ $# -le 2 ]] || usage
  DF_BASE=${1:-origin/main}
  DF_HEAD=${2:-HEAD}
  # 対象は **ツリーの中の名前を正規表現で絞って拾う**。列挙にしない理由は #1156 のレビュー:
  # **新しい `data/*/meta.json` が生えると列挙漏れが即穴になる**（denylist の型）。
  #
  # **シェルの glob も git の pathspec も使わない。** どちらも使えなかった（実測 2026-09-30）:
  #   · `git ls-tree -r -- $VAR`（クォート無し）は、**シェルが作業ツリーに対して先に展開する。**
  #     本番では 13 件に見えるが、それは「チェックアウトされている実体」を数えているだけで、
  #     **ツリーを読んでいない。** 実体が無ければ黙って縮む（`git ls-files` が未追跡を
  #     見ないのと同じ型の罠。**この検査の 1 つ前の版が実際にこれだった**——13 件出るので
  #     正しく見え、pathspec として渡すと 1 件しか当たらない）
  #   · `git ls-tree -r -- 'data/*/meta.json'`（クォートあり）は git の pathspec になるが、
  #     **git の `*` は `/` を跨がない**ので `data/meta.json` の 1 件しか当たらない（実測）
  #   · `:(glob)data/**/meta.json` は `ls-tree` が受け付けない
  #     （`fatal: pathspec magic not supported by this command: 'glob'`。実測）
  # そこで**ツリー全体を列挙して名前で絞る**。深さに依存しない（`data/meta.json` も
  # `data/assemblies/pref-02/meta.json` も同じ式で当たる）。
  DF_RE=${STALE_BASE_META_RE:-^data/([^/]+/)*meta\.json$}
  df_resolve() {
    local sha
    sha=$(git rev-parse --verify --quiet "$1^{commit}") || {
      echo "stale-base: ref を解決できません: $1" >&2
      echo "  origin/main が無いなら  git fetch origin  を先に実行してください。" >&2
      exit 2
    }
    echo "$sha"
  }
  DF_BASE_SHA=$(df_resolve "$DF_BASE")
  DF_HEAD_SHA=$(df_resolve "$DF_HEAD")

  # df_paths <tree-ish> <出力先> → そのツリーに在る対象パスを 1 行 1 件で書く。
  # **ツリーだけを読む**（作業ツリーを見ない）ので、チェックアウトされていないファイルも数える。
  #
  # **`ls-tree` の失敗と `grep` の「0 件」を分ける。** `grep` は 1 件も見つけないと exit 1 を
  # 返し、`set -o pipefail` の下ではパイプライン全体が落ちる——なので `|| :` が要る。
  # だが `ls-tree | tr | grep || :` と一息に書くと、**`|| :` が `ls-tree` の失敗まで飲む。**
  # そうなると「ツリーを読めなかった」が「対象 0 件」に化け、下の `DF_SEEN -eq 0` が
  # **「対象外」と言って exit 0 する**——**測れなかったものが緑になる**。
  # `#1158` で塞いだ「測れなかったを通さない」と同じ穴が、列挙の側に開く。
  # そこで `ls-tree` を**先に単独で**走らせて rc を見る（失敗は呼び出し側で exit 1 の材料）。
  # 到達性の実測: `DF_BASE_SHA` / `DF_HEAD_SHA` は `df_resolve`（`rev-parse --verify
  # <ref>^{commit}`）を通った SHA なので、ここで `ls-tree` が失敗するにはオブジェクトの
  # 欠損が要る（ref の操作では作れなかった）。**到達しにくいが、飲んでよい理由にはならない。**
  df_paths() {
    local tree=$1 out=$2
    git ls-tree -r -z --name-only "$tree" > "$out.raw" 2>/dev/null || return 5
    tr '\0' '\n' < "$out.raw" | LC_ALL=C grep -E "$DF_RE" | LC_ALL=C sort -u > "$out" || :
  }

  # 両側の和集合が対象。**base にしか無いもの（head が消した）も head にしか無いものも見る**
  # ——片側だけに在る形は「測れなかった」であり、黙って通してはいけない（下記）。
  DFTMP=$(mktemp -d); trap 'rm -rf "$DFTMP"' EXIT
  for dfside in "base:$DF_BASE_SHA" "head:$DF_HEAD_SHA"; do
    df_paths "${dfside#*:}" "$DFTMP/${dfside%%:*}-paths" || {
      echo "stale-base --data-freshness: ${dfside%%:*} 側（${dfside#*:}）のツリーを列挙できませんでした（git ls-tree が失敗）。**「列挙できなかった」を「対象 0 件」として通しません。**" >&2
      exit 1
    }
  done
  LC_ALL=C sort -u "$DFTMP/base-paths" "$DFTMP/head-paths" > "$DFTMP/paths"

  # df_read <tree-ish> <path> → fetchedAt を stdout に、状態を終了コードで返す。
  #   0 = 読めた（値を出す） / 3 = そのツリーに blob が無い / 4 = 読めたが値として使えない（理由を出す）
  # **「無い」（3）と「使えない」（4）を分ける**のがこの関数の要点で、上位がそれぞれ別の判断をする。
  df_read() {
    local tree=$1 path=$2 type raw val
    type=$(git cat-file -t "$tree:$path" 2>/dev/null) || return 3
    [[ $type == blob ]] || return 3
    raw=$(git show "$tree:$path") || { echo "blob を読めませんでした"; return 4; }
    # `jq -e` は null / false でも非 0 を返すので、「キーが無い」と「JSON が壊れている」の
    # どちらも非 0 になる。区別は下のメッセージで付ける（両方 exit 1 の材料なので、
    # 検査の判断としては同じ側に落ちる）。
    if ! val=$(printf '%s' "$raw" | jq -re '.fetchedAt' 2>/dev/null); then
      if printf '%s' "$raw" | jq -e . >/dev/null 2>&1; then
        echo "fetchedAt がありません（JSON としては読めました）"
      else
        echo "JSON として読めません"
      fi
      return 4
    fi
    # ISO 8601 の UTC 形式のみ。固定長・ゼロ埋め・UTC なので、この形に限れば辞書順 = 時刻順。
    # ここを緩めると（例えばオフセット付きを通すと）文字列比較が時刻比較でなくなる。
    if [[ ! $val =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$ ]]; then
      echo "日付として解釈できません: $val"
      return 4
    fi
    echo "$val"
    return 0
  }

  df_state() { # <rc> <val> <path> → 出力に書く文字列
    case $1 in
      0) echo "$2" ;;
      3) echo "(このツリーに $3 がありません)" ;;
      *) echo "(測れません: $2)" ;;
    esac
  }

  # 母数（#757）: **見たファイル数**を必ず出す。「13 件見た」と「1 件しか見ていない」を
  # 区別できないと、対象が静かに 1 件に縮んでも出力は同じ顔をする（#1156 の最初の版がそれだった）。
  DF_SEEN=0; DF_STALE=0; DF_UNMEASURABLE=0
  DF_STALE_REPORT="$DFTMP/stale"; DF_UNM_REPORT="$DFTMP/unmeasurable"
  : > "$DF_STALE_REPORT"; : > "$DF_UNM_REPORT"

  while IFS= read -r dfpath; do
    [[ -n "$dfpath" ]] || continue
    DF_SEEN=$((DF_SEEN + 1))
    set +e
    dfbv=$(df_read "$DF_BASE_SHA" "$dfpath"); dfbrc=$?
    dfhv=$(df_read "$DF_HEAD_SHA" "$dfpath"); dfhrc=$?
    set -e
    # 両側に無いのは対象外（和集合から来ているので通常起こらないが、pathspec が
    # ディレクトリ等に当たった場合に備える）。比較するものが無いのは「測れなかった」ではない。
    if [[ $dfbrc == 3 && $dfhrc == 3 ]]; then
      DF_SEEN=$((DF_SEEN - 1))
      continue
    fi
    if [[ $dfbrc != 0 || $dfhrc != 0 ]]; then
      DF_UNMEASURABLE=$((DF_UNMEASURABLE + 1))
      { echo "  $dfpath"
        echo "    $DF_BASE : $(df_state "$dfbrc" "$dfbv" "$dfpath")"
        echo "    この枝   : $(df_state "$dfhrc" "$dfhv" "$dfpath")"
      } >> "$DF_UNM_REPORT"
      continue
    fi
    # 固定長・ゼロ埋めの UTC ISO 8601 に限っているので、辞書順の比較が時刻順の比較になる。
    if [[ $dfhv < $dfbv ]]; then
      DF_STALE=$((DF_STALE + 1))
      { echo "  $dfpath"
        echo "    $DF_BASE : $dfbv"
        echo "    この枝   : $dfhv   ← こちらが古い"
      } >> "$DF_STALE_REPORT"
    fi
  done < "$DFTMP/paths"

  # 対象が 1 件も無い（`data/` を持たないチェックアウト）。比較の対象が無いのは事実であって
  # 「測れなかった」ではない。
  if [[ $DF_SEEN -eq 0 ]]; then
    echo "stale-base --data-freshness: 対象外 — $DF_BASE と $DF_HEAD のどちらにも対象の meta.json がありません（対象の式: $DF_RE）"
    exit 0
  fi

  if [[ $DF_UNMEASURABLE -gt 0 ]]; then
    cat >&2 <<DFUNMEASURABLE
stale-base --data-freshness: $DF_SEEN 件のうち $DF_UNMEASURABLE 件の fetchedAt を**測れません**。

$(cat "$DF_UNM_REPORT")

**「測れなかった」を「古くない」として通しません。** 片側だけファイルが無い／
fetchedAt が無い／日付として解釈できない、のいずれかです。

  · そのファイルを消したのなら、消してよい理由を PR 本文に書いてください
    （**消すとこの検査そのものが黙る**ので、黙らせる形での解決はしないこと）
  · 土台が古いだけなら、base を進めてください:

      gh pr update-branch <PR番号>      # scripts/po/merge-when-green.sh が BEHIND のとき呼ぶのと同じもの
      # または
      git fetch origin && git rebase origin/main
DFUNMEASURABLE
    exit 1
  fi

  if [[ $DF_STALE -gt 0 ]]; then
    cat >&2 <<DFSTALE
stale-base --data-freshness: $DF_SEEN 件のうち $DF_STALE 件の fetchedAt が $DF_BASE より**古い**です。

  $DF_BASE = ${DF_BASE_SHA:0:8}
  この枝   = ${DF_HEAD_SHA:0:8}

$(cat "$DF_STALE_REPORT")

このままマージすると、**$DF_BASE の上のファイル（と同じ更新で入った data/ 一式）が
枝の古い版で上書きされます。** 実測 2026-09-30: この形は引数なしの検査も
\`--net-deletions\` も通りました（枝は data/ を 1 行も触っておらず、差分は減った行数と
増えた行数が等しいので差し引き 0 です。日次の \`data/meta.json\` で 34 行、
月次の \`data/districts/meta.json\` で 54 行）。**行数は打ち消せますが、時刻は打ち消せません。**

**枝が古いだけです。base を進めてください:**

  gh pr update-branch <PR番号>      # scripts/po/merge-when-green.sh が BEHIND のとき呼ぶのと同じもの
  # または
  git fetch origin && git rebase origin/main

**この検査を外す・ファイルを対象から除く・fetchedAt を手で書き換えて黙らせる、のいずれもしないこと。**
DFSTALE
    exit 1
  fi

  echo "stale-base --data-freshness: ok — $DF_SEEN 件の meta.json の fetchedAt は、どれも後退していません（$DF_BASE: ${DF_BASE_SHA:0:8} ／ この枝: ${DF_HEAD_SHA:0:8}）"
  exit 0
fi

# --net-deletions [<base-ref>] [<head-ref>] — Issue #836.
#
# Why a second mode is needed at all. The default mode asks "what did the base gain since the
# merge-base, and is it still here". A rebase moves the merge-base to the base tip, so that question
# answers "nothing" and the mode prints `ok` — the gap its own header documents. `--verify` closes it,
# but only when the at-risk lines were written down BEFORE the rebase.
# Measured on the two real incidents, and that precondition did not hold in either:
#   PR #832 — 286 lines across 3 files, gone already in the FIRST commit that was ever pushed (the
#             branch was rebased before its first push). By `git diff --numstat`, over ALL files:
#             docs/WORKING_AGREEMENT.md +1 -17, docs/research/local-assemblies.md +0 -210,
#             docs/sprints/sprint-28.md +12 -59. All of it was added by #820/#824/#827/#831.
#             The PO has since restored it (#834/#838).
#   PR #761 — 33 lines across 2 files, added by #762 and **still absent from main today** (measured
#             2026-09-14: 25 of the 26 non-blank lines are not in origin/main).
#             docs/DATA_CONTRACT.md +0 -19, packages/etl/test/data-use-policy.test.ts +1 -14.
#             Not a replacement: the removed `mustHave` block asserted the checklist verbatim and is
#             nowhere in main, and the same commit LOWERED `boxes >= 7` back to `boxes >= 6`.
#             #761's own in-place replacements (e.g. ci.yml's `floor 104` → `floor 110`) are NOT
#             reported, because there `added >= lost` — which is the point of the rule.
# So there was no earlier run to write a lines file, and nothing else in refs or the API recovers the
# fork point: measured, the fork point (566399a7) already contained the line, the branch commit's
# AUTHOR date (23:54) is later than the line's landing on main (23:14) because the rebase rewrote it,
# `base.sha` from the API is the CURRENT base tip, and the pre-force-push head is not in the events API.
# Every "reconstruct what the author started from" approach is therefore ruled out by measurement, not
# by taste.
#
# What is still true of both incidents, and needs no history at all:
#   the PR takes more of the base's lines OUT of a file than it puts back, and the file survives.
# That is what this measures. Per file the head still has:
#   lost  = multiset(base) \ multiset(head)      lines of the base that are not in the branch
#   added = multiset(head) \ multiset(base)      lines the branch has that the base does not
#   report when  lost > 0 AND added < lost.
#
# Why `added < lost` and not "lost > 0". Deliberate deletions are legitimate and common; a rule that
# fires on any deletion fires on everything and stops being read. Measured over the last 60 merged PRs:
#   "any deletion of a base line"      → fires on 39 of 60   (unusable)
#   "net deletion, file survives"      → fires on  4 of 60   (#832, #761, #740, #794)
# Of those 4, two are the real incidents. The other two were read by hand and are deliberate:
#   #740 replaced a resolved decision's text in docs/ops/pending-decisions.md (22 out, 14 in)
#   #794 moved the per-prefecture `lossy` code into one shared `lossyNameMatchesOf` (still in main)
# So this is a 2-in-4 signal, not a proof. It fails, and the author says in the PR body which it is —
# the same contract as the default mode. It is NOT a replacement for it: the default mode still catches
# the un-rebased shape, where it names the lines and is exact.
#
# Deleting a whole file is excluded on purpose: that is visible in `git diff --stat` and is a deliberate
# act. This mode is about a file that SURVIVES while quietly losing the base's lines — the shape
# `git diff --stat` renders as "1 file changed" and nobody looks twice at.
if [[ ${1:-} == --net-deletions ]]; then
  shift
  [[ $# -le 2 ]] || usage
  ND_BASE=${1:-origin/main}
  ND_HEAD=${2:-HEAD}
  nd_resolve() {
    local sha
    sha=$(git rev-parse --verify --quiet "$1^{commit}") || {
      echo "stale-base: ref を解決できません: $1" >&2
      echo "  origin/main が無いなら  git fetch origin  を先に実行してください。" >&2
      exit 2
    }
    echo "$sha"
  }
  ND_BASE_SHA=$(nd_resolve "$ND_BASE")
  ND_HEAD_SHA=$(nd_resolve "$ND_HEAD")
  # Lines main gained AFTER this branch was cut are the DEFAULT mode's business, not this one. Counting
  # them here makes the check fire on every open PR the moment main moves — measured on this very branch
  # while writing it: 620 lines across 4 files, every one of them simply main having moved on. They also
  # corrupt the answer in the other direction: main's additions inflate `added` and hide the branch's own
  # deletions (measured in the fixture: 2 real lost lines reported as `ok`).
  # So both sides are restricted to what the branch actually HAD: the merge-base.
  ND_MERGE_BASE=$(git merge-base "$ND_BASE_SHA" "$ND_HEAD_SHA") || {
    echo "stale-base: $ND_BASE と $ND_HEAD に共通の祖先がありません" >&2; exit 2
  }
  NTMP=$(mktemp -d); trap 'rm -rf "$NTMP"' EXIT

  # Same multiset spelling as the default mode: sorted, occurrence-numbered lines, so `comm` subtracts
  # multisets and a line that legitimately appears N times keeps its N copies. Nothing parses diff text
  # (`git diff | grep -c '^-[^-]'` counts 0 for a deleted line that itself starts with `-`, which is
  # every bullet in the document this is meant to protect).
  nd_multiset() {
    local type
    type=$(git cat-file -t "$1:$2" 2>/dev/null) || return 0
    [[ $type == blob ]] || return 0
    git show "$1:$2" | LC_ALL=C sort | LC_ALL=C awk '{ print ++n[$0] "\t" $0 }' | LC_ALL=C sort
  }

  ND_TOTAL=0
  ND_REPORT="$NTMP/report"
  : > "$ND_REPORT"
  ND_LINES_OUT=${STALE_BASE_LINES_OUT:-$(git rev-parse --git-dir)/stale-base-lines.tsv}
  ND_LINES_TMP="$NTMP/lines.tsv"
  : > "$ND_LINES_TMP"

  while IFS= read -r -d '' ndpath; do
    [[ -n "$ndpath" ]] || continue
    # The file must still exist in the head: deleting it outright is a different, visible act.
    ndtype=$(git cat-file -t "$ND_HEAD_SHA:$ndpath" 2>/dev/null) || continue
    [[ $ndtype == blob ]] || continue
    # Binary blobs have no "lines": sorting one yields an artifact count and makes this script's own
    # message binary (measured on the real PR #761 — the re-generated woff2 subset reported
    # "769 行が減り、762 行しか戻っていません", and grep on the output needed `-a`). A re-generated
    # font subset is never a lost lesson, so it is not this check's business.
    # `git diff --numstat` prints `-\t-\t<path>` for a binary path; that is git's own answer to
    # "is this binary", so it is used rather than a guess about extensions.
    if [[ $(git diff --numstat "$ND_BASE_SHA" "$ND_HEAD_SHA" -- "$ndpath" | cut -f1) == "-" ]]; then
      continue
    fi
    nd_multiset "$ND_BASE_SHA"   "$ndpath" > "$NTMP/b"
    nd_multiset "$ND_HEAD_SHA"   "$ndpath" > "$NTMP/h"
    nd_multiset "$ND_MERGE_BASE" "$ndpath" > "$NTMP/m"
    # Only lines that are BOTH on the base now AND were there when the branch was cut: those are the
    # ones this branch definitely saw and then removed. `comm -12` is the intersection.
    LC_ALL=C comm -12 "$NTMP/b" "$NTMP/m" > "$NTMP/had"
    LC_ALL=C comm -23 "$NTMP/had" "$NTMP/h" > "$NTMP/lost"
    # Symmetrically, `added` must only count what the BRANCH added, not what main added since the fork —
    # otherwise main moving on inflates it and hides a real net deletion.
    LC_ALL=C comm -13 "$NTMP/m" "$NTMP/h" > "$NTMP/added"
    nlost=$(wc -l < "$NTMP/lost")
    nadded=$(wc -l < "$NTMP/added")
    [[ $nlost -gt 0 ]] || continue
    [[ $nadded -lt $nlost ]] || continue
    ND_TOTAL=$((ND_TOTAL + nlost))
    { echo "  $ndpath: $nlost 行が減り、$nadded 行しか戻っていません"
      # `cut … | head -20 | sed` dies here: `head` closes the pipe, `cut` takes SIGPIPE, and under
    # `set -o pipefail` the pipeline reports 141, which `set -e` turns into a silent death with no
    # message and no lines file (#836 — measured against the real PR #761, whose diff holds a 769-line
    # woff2 blob: exit 141, zero bytes of output). `head` reads from a file instead, so nothing is
    # writing into a pipe that gets closed early.
    LC_ALL=C head -20 "$NTMP/lost" | cut -f2- | sed 's/^/    | /'
      [[ $nlost -le 20 ]] || echo "    | …ほか $((nlost - 20)) 行"
    } >> "$ND_REPORT"
    cut -f2- < "$NTMP/lost" | awk -v p="$ndpath" 'BEGIN{FS=OFS="\t"} { print p, $0 }' >> "$ND_LINES_TMP"
  done < <(git diff -z --name-only "$ND_BASE_SHA" "$ND_HEAD_SHA")

  if [[ $ND_TOTAL -eq 0 ]]; then
    echo "stale-base --net-deletions: ok — $ND_BASE の行を差し引きで減らしているファイルはありません"
    exit 0
  fi

  mkdir -p "$(dirname "$ND_LINES_OUT")"
  cp "$ND_LINES_TMP" "$ND_LINES_OUT"

  cat >&2 <<NDMSG
stale-base --net-deletions: $ND_BASE の行 $ND_TOTAL 行が、この枝で差し引き減っています。

  $ND_BASE = ${ND_BASE_SHA:0:8}
  この枝   = ${ND_HEAD_SHA:0:8}

$(cat "$ND_REPORT")

**これは「消してはいけない」という意味ではありません。** 意図した削除は正当です。
**言っているのは「$ND_BASE にあった行が、戻ってくる量より多く消えている」という事実だけです。**

**実地で 2 回、これは rebase の事故でした**（#832 が 3 ファイル 286 行、#761 が 2 ファイル 33 行。どちらも
**他人がマージ済みの追記**で、**引数なしの検査は ok と言いました**——rebase が共通の祖先を
動かしたあとで、**何が元々あったかを refs から復元する方法はありません**）。

確かめ方は 2 つです。

  git fetch origin
  git diff $ND_BASE -- <上のファイル>      # 消えている行を実際に読む

**自分が消すと決めた行なら、その理由を PR 本文に書いてください。**
**身に覚えが無いなら、rebase の解決で落ちています。** その行を書き戻してください:

  bash scripts/ci/stale-base.sh --verify $ND_LINES_OUT

**この検査を外す・対象から除く・行を書き戻さずに黙らせる、のいずれもしないこと。**
NDMSG
  exit 1
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

# ── Issue #565: everything below compares against $BASE_SHA — the LOCAL copy of $BASE. Nothing here
# runs `git fetch`, on purpose (a check must not have the side effect of changing the working tree just
# by being run). But if nobody fetched, $BASE_SHA can be a stale `origin/main`, and this script would
# then say "ok" about a comparison that was never against the real base — worse than saying nothing,
# because this check exists specifically to stop a stale base (#552 hit exactly this, three times).
#   Only meaningful for a remote-tracking ref (`origin/main` or `refs/remotes/origin/main`) — a local
#   branch or a bare SHA has no remote to be stale against.
#   `git ls-remote` needs the network; CI has already fetched (fetch-depth: 0, plus an explicit fetch
#   right before this runs — see .github/workflows/ci.yml), so there $BASE_SHA already IS the remote's
#   tip and this finds no difference and stays quiet. If `git ls-remote` itself fails (no network, or no
#   remote named that — true of every existing fixture in stale-base.test.sh, which writes
#   refs/remotes/origin/* directly and never registers a remote called origin), this stays quiet rather
#   than fail: no answer is not evidence of staleness, and a check that started needing the network to
#   pass at all would break offline use. That silence is a real gap, not closed by this change.
if [[ $BASE =~ ^(refs/remotes/)?([^/]+)/(.+)$ ]]; then
  remote_name=${BASH_REMATCH[2]}
  remote_branch=${BASH_REMATCH[3]}
  # `git remote get-url` is only a cheap short-circuit, not a correctness guard: when there is no remote
  # named "$remote_name" (every existing fixture below), `git ls-remote` on it fails the same way this
  # skips — measured, removing this `if` alone changes nothing (equivalent mutation). It is kept so a
  # repo with no such remote does not even attempt a network round-trip.
  if git remote get-url "$remote_name" >/dev/null 2>&1; then
    remote_sha=$(git ls-remote --exit-code "$remote_name" "refs/heads/$remote_branch" 2>/dev/null | cut -f1) || remote_sha=""
    if [[ -n $remote_sha && $remote_sha != "$BASE_SHA" ]]; then
      # Could be a descendant, or an unrelated/older commit from a force-push — either way "your local
      # $BASE does not match the remote right now" is the fact; say that and how to fix it.
      echo "stale-base: 手元の $BASE（${BASE_SHA:0:8}）が、リモートの $remote_name/$remote_branch（${remote_sha:0:8}）と一致しません。" >&2
      echo "  git fetch していないため、古い（または別の）$BASE と比べている可能性があります。" >&2
      echo "  git fetch $remote_name  を実行してから、もう一度実行してください。" >&2
      exit 1
    fi
  fi
fi

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
LINES_OUT=${STALE_BASE_LINES_OUT:-$(git rev-parse --git-dir)/stale-base-lines.tsv}
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
    # Same SIGPIPE trap as the mode above, and the same fix: read with `head` from the file, so no
    # process is writing into a pipe that `head` closes. This mode had the bug too and had simply never
    # been handed a file with more than 20 lost lines big enough to fill the 64 KiB pipe buffer
    # (measured: 200 lost lines / 23,892 B exits 0; 2,000 / 240,893 B exits 141).
    LC_ALL=C head -20 "$TMP/lost" | cut -f2- | sed 's/^/    | /'
    [[ $n -le 20 ]] || echo "    | …ほか $((n - 20)) 行"
  } >> "$REPORT"
  # Every at-risk line, as `<path><TAB><line>`, for --verify to re-check after the rebase.
  # `sed "s|^|$path\t|"` にしない: パスに `|` が入ると区切りと衝突して sed が死に、
  # `set -e` でメッセージも一覧ファイルも出ないまま落ちる（#554 のレビューが実測）。
  cut -f2- < "$TMP/lost" | awk -v p="$path" 'BEGIN{FS=OFS="\t"} { print p, $0 }' >> "$LINES_TMP"
done

TOTAL=$((WOULD_LOSE + DIFF_DELETES))
if [[ $TOTAL -eq 0 ]]; then
  echo "stale-base: ok — $BASE が ${MERGE_BASE:0:8} 以降に足した行は、すべてこの枝にあります"
  if [[ -s $LINES_OUT ]]; then
    echo "  前回この検査が挙げた行が $LINES_OUT に残っています。**これで ok とせず**、次を実行してください:"
    echo "    bash scripts/ci/stale-base.sh --verify $LINES_OUT"
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

そのあと、**上の行が本当に残ったか**をこう確かめてください（手元で）:

  bash scripts/ci/stale-base.sh                    # 上の一覧を $LINES_OUT に書き出す（rebase の前に）
  git rebase origin/main
  bash scripts/ci/stale-base.sh --verify $LINES_OUT

**この2つ目のコマンドを飛ばさないこと。** rebase は共通の祖先を $BASE の先端まで動かすので、
**上の行を全部消したままでも、1つ目の検査（引数なし）は ok と言います**（実測: rebase -X theirs、
および衝突を枝の版で上書きする解決で、12 行すべて消えているのに ok）。
**--verify だけが、行そのものを見ています。**

消してよい行だと本当に判断したのなら、その理由を PR 本文に書いてください。
**この検査を外す・対象から除く・行を書き戻さずに黙らせる、のいずれもしないこと。**
MSG
exit 1
