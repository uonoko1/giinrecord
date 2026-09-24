#!/usr/bin/env bash
# merge-when-green.sh [--allow-nonrequired-red] [--no-review <理由>] <pr>
#   1. refuse unless the PR is OPEN and not a draft
#   1.5 refuse unless a reviewer's report is already on the PR (#1006) — a comment containing one
#      of reviewer.md's verdicts (マージしてよい / 直してから / 反対). Checked BEFORE polling, so a
#      PR that was never reviewed is refused in seconds rather than after 20 minutes of waiting.
#      --no-review <理由> skips it and logs the reason; the reason is not optional.
#   2. `gh pr update-branch` when it is BEHIND main
#      if that is refused because the gh OAuth token lacks the `workflow` scope (the PR touches
#      .github/workflows/*), fall back to merging origin/main into the PR head in a temporary
#      worktree and pushing over SSH (#200); a merge conflict aborts with nothing pushed
#   3. poll `commits/<head>/check-runs` (not `gh pr checks`: its bucket is derived from `status`,
#      which can still read in_progress after `conclusion` is already set — #561) until every
#      check is pass/neutral/skipped (a real conclusion of failure/cancelled/timed_out/
#      action_required/stale → abort). A red check that is NOT a required one only stops us
#      unless --allow-nonrequired-red is given, and it is always read out by name (#858)
#      main may move while we wait (another PR merged → BEHIND, strict status checks block the
#      merge): every poll re-checks mergeStateStatus and runs update-branch again (#89, like etl.yml)
#      while waiting on data/refresh only: approve `action_required` workflow runs
#   4. `gh pr merge --squash --delete-branch`
#      refused by the strict base-branch policy → update the branch and **wait for the checks to
#      re-run** before trying again (#392); a fixed sleep is not enough (docker-web takes 1-3 min)
#      a non-zero exit does NOT mean "not merged": re-read the PR state and finish successfully
#      when our verified head is already MERGED (#434)
# Before every merge attempt: re-read the PR head and refuse if it moved since we started (#392).
# Before touching anything: refuse if another open PR is based on this branch (#392) — merging
# deletes the head branch, which closes those PRs.
# Env: POLL_INTERVAL (s, default 20), POLL_MAX (default 60), PO_REPO (owner/name override).
# Flags: --allow-nonrequired-red — merge even though a non-required check is red (#858). Required
# checks being red still aborts, always. See REQUIRED_CHECKS below for what that means here.
#        --no-review <理由> — merge a PR that has no reviewer report (#1006). The reason is
# mandatory and is written to the log: that log line is the only record of why review was skipped.
# Destructive operations: the squash merge (+ head branch deletion) of the given PR, and — only
# in the workflow-scope fallback — a merge commit of origin/main pushed to the PR head branch.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

DATA_BRANCH="data/refresh"

# --- 必須 / 必須でない検査（#858）-----------------------------------------------------------
# **何が問題だったか**: `wait_for_green` は fail が 1 件でもあれば無条件に die していた。
# `docker-web` は GitHub の必須ステータスチェックではない（branch protection の contexts は
# check / gitleaks / forbidden-patterns / audit の 4 件。**実測 2026-09-21**）ので
# **GitHub はマージを許すのにこの道具だけが止めていた**。PO はその度に手で `gh pr merge` を
# 打って回避しており（この回だけで 3 回）、#389/#392/#414/#434/#446 で積み上げた守り
# （HEAD が動いていないか・上に PR が積まれていないか）が**そのたびに全部飛んでいた**。
#
# **母数**（実測 2026-09-21、直近 12 件のマージ済み PR は全部同じ）: 1 PR につき check-run は **7 件**
#   audit, check, docker-web, forbidden-patterns, gitleaks, pr-closes, stale-base
# このうち **必須 5 件** / **必須でない 2 件（stale-base, docker-web）**。
#
# **なぜ `stale-base` が必須でない側なのか**——**これが #858 の本題である**。
# `stale-base` の 2 つ目の step（`--net-deletions`、#836）は、#846 の担当者自身が
# **「合図であって証拠ではありません（4 件中 2 件が本物）。意図した削除でも落ちるので
# 『PR 本文に理由を書く』運用に依存します」**と書いている。
# **つまり「赤いが通してよい」状態が正常に起こりうる検査**である（実地 5 件中 3 件がそれ）。
# それを「どれか赤なら止める」道具と組み合わせていたのが、PR #856 が詰まった原因だった。
# **「赤いが通してよい」が正常に起こる検査だけが、この抜け道に入る資格を持つ。**
#
# **なぜ `pr-closes` は必須のままなのか**: あれは「本文に `Closes #N`（または
# 『Closes なし（理由）』）を書いたか」を見るだけで、**赤いなら本文を直せば緑にできる**。
# **「赤いが通してよい」状態は起こらない**ので、抜け道に入れる理由が無い。
# （GitHub 側には登録できない——paths 限定・本文依存で「全 PR が永久に pending」になる。
# packages/etl/test/branch-protection-jobs.test.ts の EXEMPT_FROM_REQUIRED に理由がある。
# **だがこの道具は GitHub より厳しくてよい**ので、ここでは必須として扱う。
# 逆は許されない——GitHub が必須にしているものをここで外すと、この道具が保護を跨ぐことになる。）
#
# **知らない名前は必須として扱う**（fail-closed）。新しい job が増えたときに黙って
# 「必須でない」側に落ちると、この道具の守りが痩せる——そこで NONREQUIRED_CHECKS に
# **明示的に列挙された名前だけ**が「必須でない」になる。
#
# 期待値は**ハードコードする**（#499）。実行時に GitHub の protection API を読みに行かない:
# それは管理権限が要り（#540 で実測）、読めないときにこの分岐が黙って緩んでしまう。
REQUIRED_CHECKS=(check gitleaks forbidden-patterns audit pr-closes)
NONREQUIRED_CHECKS=(stale-base docker-web)

# is_required_check <name> → 0 なら「赤ければ絶対にマージしない」
#   REQUIRED_CHECKS にある        → 0（必須）
#   NONREQUIRED_CHECKS にある     → 1（必須でない。--allow-nonrequired-red で通せる）
#   どちらにも無い（知らない名前） → 0（**必須**。fail-closed）
# **REQUIRED_CHECKS を先に引く**のは意図である（変異 M8 で確かめた）: 両方に同じ名前が
# 載ってしまった場合、**必須として扱う側に倒れる**。抜け道が黙って広がるより良い。
#
# **注記（変異 M6、等価変異）**: REQUIRED_CHECKS の走査を丸ごと消しても、この関数の答えは
# 変わらない——2 つの配列が名前空間を分割しており、REQUIRED にある名前は
# NONREQUIRED に無いので、どのみち最後の `return 0`（必須）に落ちるからである。
# それでも配列を引いているのは、上の「両方に載った場合」の優先順位をここで決めているのと、
# **is_known_check が REQUIRED_CHECKS を必要とする**（空にすると本番の 7 件が
# 「知らない検査」になる。変異 M7 で 2 件落ちる）ため。
is_required_check() {
  local name=$1 n
  for n in "${REQUIRED_CHECKS[@]}"; do [[ "$n" == "$name" ]] && return 0; done
  for n in "${NONREQUIRED_CHECKS[@]}"; do [[ "$n" == "$name" ]] && return 1; done
  return 0   # 知らない名前は必須（新しい job が黙って抜け道に落ちない）
}

# is_known_check <name> → 0 なら**どちらかの配列に載っている**。
# 載っていない名前は必須として扱う（上）が、**扱いが正しいかは誰も確かめていない**ので、
# そのことを言う（#858）。ここが無いと REQUIRED_CHECKS は「知らない名前も必須」に
# 吸収されて**挙動に効かない飾り**になり、中身が痩せても誰も気づかない。
is_known_check() {
  local name=$1 n
  for n in "${REQUIRED_CHECKS[@]}" "${NONREQUIRED_CHECKS[@]}"; do [[ "$n" == "$name" ]] && return 0; done
  return 1
}

USAGE='merge-when-green.sh [--allow-nonrequired-red] [--no-review <理由>] <pr-number>'
# `--no-review` の理由の最低文字数（空白を除く）。**実測で決めた**値で、理由は上の分岐にある。
REVIEW_REASON_MIN=7
ALLOW_NONREQUIRED_RED=0
NO_REVIEW_REASON=""
PR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-nonrequired-red) ALLOW_NONREQUIRED_RED=1 ;;
    # **理由は省略できない**（#1006）。`--no-review` だけで通せるなら、それは歯止めではない
    # （`pr-closes.sh` の「`Closes なし` だけでは通さない」と同じ）。
    # 次の引数が無い／別のフラグ／PR 番号だった場合は**理由が書かれていない**ので usage で落とす。
    --no-review)
      # 理由として通るのは、**空白を除いて REVIEW_REASON_MIN 文字以上**のとき。
      #
      # **なぜ「空でない」では足りないか（#1009 のレビューが実測で破った）**:
      # 最初は「空でなく・別のフラグでなく・PR 番号でもない」としていたが、
      # **5 通りで通り抜けられた**——`' '`（空白 1 個）/ `'.'` / `'12.5'`（is_int を小数で回避）/
      # `'-x'`（単ハイフンは `--*` に当たらない）/ 改行 1 個。**どれもマージが成功した。**
      # **`理由:  ` は記録ではない。**
      # とくに効くのは `--no-review . <pr>` で、**タイプ数が `--no-review <pr>` とほぼ変わらない**
      # ——**「1 コマンドでは通せない」という設計目標を、逃げ道の側が真っ先に破る。**
      #
      # **なぜ 7 文字なのか（実測。思いつきの数字ではない）**:
      # `pr-closes.sh` の `Closes なし（理由）` を先例にしたので、**あちらの理由の実物を数えた**
      # （`gh pr list --state all --limit 200` の本文から `Closes なし（…）` を取り出す）:
      #     出現 96 件。うち**説明文の引用**（`理由` / `…` / `a`）が 8 件。
      #     **本物の理由 88 件の最短は 7 文字**（`作業合意の更新`）、中央値 23 文字。
      # **7 文字にすると、この 88 件が 1 件も落ちない**まま、上の 5 通りが全部落ちる。
      # **`pr-closes.sh` の正規表現そのものには揃えなかった**——あちらは
      # 「空白でない文字が 1 つ以上」なので、**空白 1 個は落とすが `.` は通す**（実測）。
      # **`.` が通る時点で、この逃げ道では目的を果たさない。**
      #
      # **これは「良い理由か」の判定ではない**（機械には分からない。`pr-closes.sh` と同じ）。
      # **見ているのは「人が一度立ち止まって書いたか」だけ**で、長さはその代理でしかない。
      reason=${2:-}
      # 空白（改行・タブを含む）を除いた長さで測る。`' '` も `$'\n'` もこれで 0 になる。
      reason_bare=${reason//[[:space:]]/}
      if [[ $# -lt 2 || "$reason" == --* || ${#reason_bare} -lt $REVIEW_REASON_MIN ]]; then
        usage "$USAGE
       --no-review には理由が要ります（空白を除いて $REVIEW_REASON_MIN 文字以上）。
       例: --no-review 'レビュアーを立てられない障害中'
       **短すぎる理由は記録になりません。** ここに書いたものが、
       「なぜレビューを飛ばしたのか」が残る唯一の場所になります。"
      fi
      NO_REVIEW_REASON=$reason; shift ;;
    *) if [[ -z "$PR" ]] && is_int "$1"; then PR=$1; else usage "$USAGE"; fi ;;
  esac
  shift
done
[[ -n "$PR" ]] || usage "$USAGE"
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

# --- 1.5 レビュー済みか（#1006）-----------------------------------------------------------------
# **何が起きたか**: 2026-09-23〜24 に **33 本の PR が 1 件もレビューされずにマージされた**
# （実測 `gh pr list --state merged` の `mergedAt`: **PO 31 本 / bot 2 本**。09-23 が 21 本、09-24 が 12 本）。
# `.claude/agents/README.md` の「PO がやってはいけないこと」には
# **「レビュー無しでマージする」が明記されていた**。手順に書いてあっても止まらなかった。
# そのあと PO は PR #1001 に「**道具に歯止めを置きました**」と書いたが、**事実に反していた**
# （レビュアーが発見し、PO も検算した）: `reviewed` ラベルは存在せず、この道具の検査は 0 件で、
# 歯止めは**セッションのスクラッチパッドにしか無かった**——そして 2026-09-25 に
# セッションが再起動して **exit 127 で消えた**。だからリポジトリの中に置く。
#
# ── なぜラベルではないのか（レビュアーの指摘）───────────────────────────────────────────
# **`reviewed` ラベルは PO が 1 コマンドで付けられる。** 33 本のときの PO は
# 「自分で検算したから十分だ」と判断していた。**同じ PO が「自分で検算したから
# `reviewed` を付ける」と判断できる。歯止めが自己申告なら歯止めではない。**
# **レビュアーの報告は、レビュアーを走らせないと生えない。** だから報告そのものを要求する。
#
# ── なぜ `--json reviews` ではなく issue comments なのか（実測 2026-09-25、直近 60 PR）──
#   `gh pr view --json reviews` が空でない PR   **2 件 / 60**
#       どちらも著者は `github-actions`（bot）で **body は空文字**。
#       **人間のレビューは GitHub の Review として 1 件も登録されていない**（母数 60 中 0）。
#       → **`reviews` を見る検査は、この運用では何も見ていないのと同じ**になる。
#   `gh pr view --json comments` が空でない PR  **14 件 / 60**
#       **14 件とも著者は `uonoko1`**。PO も開発者もレビュアーも**同じアカウント**で書くので、
#       **著者では見分けられない**（authorAssociation も 14 件とも OWNER）。
#       → **本文の形で見分けるしかない。**
#   14 件の 1 行目を読むと、**レビュアーの報告は 1 件だけ**（PR #1000
#   「## レビュー: **マージしてよい**（3 度目の敵対的レビュー）」）。
#   残る 13 件は「PO が測り直した」「PO が確かめた」等、**PO 自身の検算**か担当者の返答だった。
#   **つまり直近 60 本のうち、レビュアーの報告が付いているのは 1 本**である。
#
#   **`gh pr view --json comments` ではなく `gh api .../issues/<n>/comments` を叩く理由**は
#   中身ではなく、この道具のテストの都合である: 既存のハンドラ 30 個が
#   `"pr view 12 --json"*` を catch-all にしているので、`pr view --json comments` を足すと
#   **30 個のテストが state の JSON を返してしまい、検査が黙って素通りする**。
#   別の呼び出し方にして衝突させない（`gh api .../check-runs` と同じ形）。
#
# ── 何を「レビュアーの報告」とみなすか ─────────────────────────────────────────────────
# `.claude/agents/reviewer.md` の報告様式:
#     「**結論を先に**: マージしてよいか／直してから／反対か」
# **同じ 1 件のコメントの中に、「レビュー」という語と、結論の語が両方あること**を要求する。
# **良し悪しは判定しない**（`pr-closes.sh` と同じ考え方——機械が判断できないことを
# 機械に判断させない。機械が見るのは「レビュアーが走って報告を書いた」ことだけで、
# **報告の中身が正しいかはレビュアー自身とPOが見る**）。
#
# **「マージしてよい」だけを探さないのは意図である。** それだけだと
# **「直してから」「反対」と書かれた PR は「レビューが無い」と同じ扱い**になり、
# **担当者が直して再レビューを受けた PR と、一度もレビューされていない PR を区別できなくなる。**
# ここで見ているのは「レビュアーが走ったか」であって「レビュアーが許したか」ではない。
# **「直してから」のまま押すかどうかは、PO が報告を読んで決めること**であり、
# この道具はその判断を肩代わりしない（下の VERDICT を必ず読み上げるのはそのため）。
#
# **なぜ結論の語だけでは足りないか（実測。ここを測らずに出していたら穴だった）**:
# **`反対` はこの専案の「データの語」である**——採決の記録そのものが賛成／反対でできている。
# 結論の語だけを本文のどこかから探す形で直近 60 PR に当てたところ、**4 件が通った**が、
# **そのうち 3 件は誤検出**だった（PO 自身の検算コメントが票数の話で `反対` を書いていた）:
#     #947 「PDF が刷っている賛成数・反対数と、読み取ったセルが 8 行すべて一致」
#     #945 「請願第38号は反対 32 人を 0 人と公表することになる」
#     #942 「`h261002giketu.pdf` の請願第38号は反対 32 人を 0 人と公表することに…」
# **どれもレビューではない。** この 3 件を通す検査は、**歯止めが黙って開く**形である。
# 「レビュー」の語も同じコメントに要る、としたところ **60 件中 1 件**（#1000、本物の
# レビュー報告）だけが通った。**直近 60 PR では誤検出 0 件。**
#
# ── #1010: **検査が読む綴りは `reviewer.md` が決める**（道具が推測しない）──────────────
# **#1009 の時点で、この検査は「レビュー」という語を必須にしていたが、
# `reviewer.md` はその語を 1 度も規定していなかった**（実測
# `grep -c 'レビュー[^ア]' .claude/agents/reviewer.md` → **0 件**。「レビュ**アー**」は
# 役割の説明で、報告の書き方ではない）。**仕様が何も決めず、道具が語を推測していた。**
# その結果、**仕様どおりに書いた報告が弾かれ、意味の無い 6 文字が通った**（実測、#1010）:
#     `## 結論: マージしてよい。変異 3 件を当て直して全部落ちた。` → **status=1 止まる**
#     `結論を先に: マージしてよい。指摘は 0 件。`                  → **status=1 止まる**
#     `レビュー反対`（6 文字）                                      → **status=0 マージ**
# **判定が「レビューしたか」ではなく「たまたまその 4 文字を打ったか」になっていた。**
#
# **#1010 で `reviewer.md` に綴りを規定した**（「報告の 1 行目は `## レビュー: <結論>`」）。
# **この検査はその 1 行目だけを読む。**
#
# ── **#1009 が書いた数字のうち 2 つは誤りだった（この PR で数え直した）** ────────────
# 母数: **PR 634 本・コメント 218 件**（2026-09-25。#1009 の 217 件との差 1 は、
# **#1009 自身に貼られたレビュー報告**である）。
#   **誤り 1**: #1009 は「**本物 6 件 / 誤検出 3 件（#224 #457 #566）**」と書いたが、
#   **#224 には本物のレビュー報告が在る**（`## レビュー: PR #224 収録範囲ページ /coverage/`
#   で始まり「敵対的にレビューした。… REQUEST_CHANGES とする。」）。
#   **正しくは 本物 8 件 / 誤検出 2 件**（#457・#566。#1009 自身を数えて本物 8 件）。
#   **誤り 2**: #1009 は「**本物の 6 件のうち #496 は見出しが無い**」と書いたが、
#   **#496 には見出しが 2 本ある**（`## レビューが確かめたこと` / `## レビューが見つけた補強材料`）。
#   `^##\s*(敵対的)?レビュー` の一致行数の実測: 223→1 224→1 226→1 259→1 429→1
#   **496→2** 1000→1 457→1 **566→0**。
#   **1 行目が見出しでないのは本当だが、本文には在る。**
#
# ── **なぜ「結論の語をどこかに含む」をやめたのか（実測。ここが #1010 の核心）** ────────
# **本物 8 件のうち 4 件（#223 #224 #226 #259）は、3 つの結論の語をどれも書いていない。**
# `REQUEST_CHANGES` / `APPROVE` と書いていた。**その 4 件が通っていたのは、
# 採決データの語「反対」がたまたま同じコメントに在ったからである**（実測の出現文脈）:
#     #223 「投票総数　215　　　賛成票　199　　　反対票　16」
#     #226 「列34「成相安信」は請願第30号で唯一の反対者（●）」
#     #259 （本文中の採決の説明）
#     #224 （**本物の報告の側には結論の語が 1 つも無く**、担当者の返答の側の
#           「賛成会派／**反対**会派」で通っていた——**別のコメントで通っていた**）
# **つまり `REVIEW_VERDICTS` から `反対` を外すと、本物 8 件のうち 4 件が落ちる。**
# **検査は採決データの語に支えられていた。** これは歯止めではなく偶然である。
#
# ── **なぜ方向 2（`結論` も許す allowlist）を採らなかったか（実測）** ──────────────────
# Issue が挙げたもう 1 つの案は `REVIEW_CONTEXT` を `レビュー|結論` にすることだった。
# **全履歴に当てて測ったところ、通る PR が 10 件 → 12 件に増え、増えた 2 件は両方とも誤検出**
# だった（**#622**「## PO: 追試しました」/ **#945**「## PO が確かめた」——どちらも PO 自身の検算）。
# **本物のレビュー 8 件は 8 件とも既に「レビュー」を含むので、得るものが 0 件で、
# 誤検出だけが 2 → 4 件に増える。** **方向 2 は測ると厳密に悪くなる。**
#
# ── **何を読むか** ────────────────────────────────────────────────────────────────────
# **コメントの 1 行目が `## レビュー: <結論>` であること**（`<結論>` は `REVIEW_VERDICTS`）。
# 全角コロン `：` も通す（日本語で書くので実際に起こる）。
# **`敵対的レビュー` も通す**（`reviewer.md` の役割名がそれなので、実際に書かれる）。
#
# **なぜ 1 行目なのか（実測）**: **担当者の返答と見分けるため。**
# `^##\s*(敵対的)?レビュー` を全履歴に当てると **36 件**当たるが、**そのうち 6 件は
# 担当者の返答**である: `## レビュー対応`（#17 #21 #32）/ `## レビュー指摘を反映しました`
# （#262）/ `## レビュー3点に対応しました`（#457）/ `## レビューへのお礼`（#466）。
# **「レビュー」の語だけでは、レビューと「レビューへの返答」が区別できない。**
# **「レビュー」の直後に結論の語が来ること**が、その区別になる——
# **返答は「レビュー対応」「レビュー指摘」と続き、結論の語では続かない。**
#
# **過去の報告に道具を合わせない。** この形は、**綴りが規定される前に書かれた報告**
# （#223 #226 #259 #429 #496 など）を落とす。**それでよい**: それらは既にマージ済みで、
# **これから書かれる報告は `reviewer.md` の規定に従う。**
# **過去 8 件に当てはまるよう緩めると、上で見たとおり「採決データの語に支えられた検査」に
# 戻る。** **母数 8 件から綴りを推定するより、綴りを規定するほうが確実である。**
#
# **良し悪しは判定しない**（`pr-closes.sh` と同じ考え方——機械が判断できないことを
# 機械に判断させない）。機械が見るのは「レビュアーが走って報告を書いた」ことだけで、
# **報告の中身が正しいかはレビュアー自身と PO が見る**。
#
# **「マージしてよい」だけを探さないのは意図である。** それだけだと
# **「直してから」「反対」と書かれた PR は「レビューが無い」と同じ扱い**になり、
# **担当者が直して再レビューを受けた PR と、一度もレビューされていない PR を区別できない。**
# ここで見ているのは「レビュアーが走ったか」であって「レビュアーが許したか」ではない
# （だから下で当たった結論を必ず読み上げる——**「直してから」のまま押していないか、PO が読む**）。
#
# **denylist ではなく allowlist**（#858 と同じ向き）: どれも無ければ止める。
# 綴りが増えたら**まず `reviewer.md` を直し、それからここに足す**——順番が逆になると、
# また「道具だけが綴りを知っている」状態に戻る。
REVIEW_VERDICTS=(マージしてよい 直してから 反対)
# 報告の 1 行目の形（`.claude/agents/reviewer.md` の「報告（日本語）」が規定）。
# **PO に見せる文字列としても使う**——止まったときに「何と書けばよいか」が分からないと、
# #1010 がそのまま再発する。
REVIEW_HEADING_FORM='## レビュー: <結論>'
# 1 行目に当てる正規表現。`<結論>` は下で埋める。
# `##` の後の空白は任意、`レビュー`/`敵対的レビュー`、コロンは半角・全角どちらも、
# その後の装飾（`**` など）と空白は読み飛ばす。
review_heading_re() {
  local verdicts; verdicts=$(IFS='|'; echo "${REVIEW_VERDICTS[*]}")
  printf '^##[[:space:]]*(敵対的)?レビュー[[:space:]]*[:：][[:space:]*_]*(%s)' "$verdicts"
}

# review_comment_first_lines — この PR のコメントの **1 行目**を 1 行 1 件で出す。
# 「1 コメント = 1 行」でないと母数が数えられなくなるので、行は必ず 1 本にする。
# **API が失敗したときは「コメント 0 件」と区別する**（#757。#1009 のレビューの指摘）。
# `|| true` で黙って空を返すと、**API が落ちたのか本当に 0 件なのかが読む人に分からない**
# ——どちらも「コメント 0 件を見ました」と出てしまう。**止まること自体は安全側**（レビューが
# 無いものとして die する）だが、**PO に「レビューを貼れ」と言う**のと
# **「API が落ちている」と言う**のでは、**次にやることが違う。**
# **失敗は返り値で伝える**（変数では伝わらない）。`x=$(review_comment_first_lines)` は
# **コマンド置換＝サブシェル**なので、**中で立てたフラグは呼び出し側に戻らない**
# （実際にそう書いて、テストが「コメント 0 件を見ました」を出して落ちた）。
#
# **#1010 から、出すのは「本文全部」ではなく「1 行目」である。**
# **見るのが 1 行目だけになったので、2 行目以降を渡す理由が無い。**
# **渡すと害がある**: 本文を平らにすると 2 行目以降が 1 行目の後ろに繋がり、
# **`## レビュー対応` の本文に「レビュー: マージしてよい」と引用が在るだけで通ってしまう。**
# `split("\n")[0]` で 1 行目を取り、`\r` を落とす（CRLF のコメントが来ても 1 行目が壊れない）。
review_comment_first_lines() {
  # shellcheck disable=SC2016  # jq の式。シェルに展開させない
  gh api "repos/$REPO/issues/$PR/comments" --paginate \
    -q '.[] | ((.body // "") | split("\n")[0] | gsub("\r"; ""))' 2>/dev/null
}

# assert_reviewed — レビュアーの報告が 1 件も無ければ die する。
# **検査を待つ前に呼ぶ**: レビューが無いと分かっているのに 20 分ポーリングさせない。
assert_reviewed() {
  local first_lines re total=0 verdict found="" hit=0 fetch_rc=0 line
  # `set -e` の下でも止まらないよう、返り値は `||` で受ける（0 件と失敗をここで分ける）
  first_lines=$(review_comment_first_lines) || fetch_rc=$?
  if [[ "${fetch_rc:-0}" != 0 ]]; then
    die "PR #$PR のコメントを読めませんでした（gh api が失敗）。マージしません。

       **これは「レビューが無い」ではありません。** レビューが在るかどうかを
       **確かめられなかった**ので止めています（#757: 母数 0 を「きれい」と報告しない）。
       gh の認証と通信を確かめてから、もう一度流してください:
         gh api repos/$REPO/issues/$PR/comments
       $URL"
  fi
  # **母数は「行数」で数える。`grep -c .` では数えない。**
  # 1 行目が空のコメント（本文が改行で始まる）は `grep -c .` だと数えられず、
  # **母数だけが黙って減る**——#757 が禁じている形そのものである。
  [[ -n "$first_lines" ]] && total=$(wc -l <<<"$first_lines")
  re=$(review_heading_re)
  # **1 行目が `## レビュー: <結論>` の形をしているコメントを探す**（1 行 1 コメント）。
  # **結論の語は、見出しの中でしか探さない。** 本文のどこかから探すと、
  # **採決データの語「反対」を拾う**（#1009 の実測: PO 自身の検算が 3 件すり抜けた）。
  while IFS= read -r line; do
    [[ "$line" =~ $re ]] || continue
    hit=1
    # **どの結論で当たったかは、当たった見出しから取り直す**（`BASH_REMATCH` に頼らない
    # ——正規表現を書き換えたときに group 番号がずれると、黙って空を読み上げる）。
    for verdict in "${REVIEW_VERDICTS[@]}"; do
      if [[ "$line" == *"$verdict"* && "$found" != *"$verdict"* ]]; then found+="$verdict "; fi
    done
  done <<<"$first_lines"
  found=${found% }
  if [[ "$hit" == 1 ]]; then
    # **母数を必ず出す**（#757）: 何件のコメントを見て、どの結論で当たったのか。
    # **どの結論で当たったかを読み上げる**のは、「直してから」「反対」のまま押している場合に
    # **PO がそれを見落とさないため**である。ここが記録として残る唯一の場所になる。
    log "レビューの報告を確認しました（コメント $total 件中、結論: $found）"
    return 0
  fi
  die "PR #$PR にレビュアーの報告がありません（コメント $total 件を見ました）。マージしません。

       **PO の検算はレビューではありません**（#1001）。2026-09-23〜24 に 33 本の PR が
       1 件もレビューされずにマージされ、そのとき PO は「自分で検算したから十分だ」と
       判断していました。**.claude/agents/README.md は「レビュー無しでマージする」を
       禁じていましたが、手順に書いてあっても止まりませんでした。**

       この道具が探しているのは、**PR のコメントの 1 行目がこの形をしていること**です
       （.claude/agents/reviewer.md の「報告（日本語）」が規定している綴り）:

         $REVIEW_HEADING_FORM

       <結論> は次のどれか 1 つ:  ${REVIEW_VERDICTS[*]}

       例:
         ## レビュー: **マージしてよい**（2 度目の敵対的レビュー）
         ## レビュー: 直してから
         ## レビュー: 反対

       **「レビュー」と書いてあるだけでは通りません**（#1010）。
       **「## レビュー対応」「## レビュー3点に対応しました」のような担当者の返答と
       見分けるため**に、1 行目で結論まで書くことを求めています。

       やること:
         1. reviewer サブエージェント（.claude/agents/reviewer.md）を立てる
         2. その報告を  gh pr comment $PR --body-file <報告>  で PR に貼る
         3. もう一度 この道具を流す

       **レビューできない事情がある場合**（例: レビュアーが立てられない障害時）は、
       **理由を PR のコメントに書いてから**通してください:
         gh pr comment $PR --body 'レビューなし（理由）'
         scripts/po/merge-when-green.sh --no-review '理由' $PR
       $URL"
}
if [[ -n "$NO_REVIEW_REASON" ]]; then
  # **逃げ道は「黙って開く」形にしない。** `pr-closes.sh` の `Closes なし（理由）` と同じ考え方:
  # **理由は省略できない**（引数が空なら下の引数解析が usage で落とす）。
  # **中身の良し悪しは判定しない**——機械には分からない。機械が見るのは
  # 「人が一度立ち止まって書いた」ことだけである。
  # **理由はログに必ず残す**: ここが「なぜレビュー無しで押したのか」が残る唯一の場所になる。
  log "**レビュー無しでマージします**（--no-review）。理由: $NO_REVIEW_REASON"
  log "  この行が、レビューを飛ばした記録です。PR のコメントにも同じ理由を残してください。"
else
  assert_reviewed
fi

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
# **実地で踏んだ**（PR #396 のマージ時）: `gh pr update-branch` が返った直後に読むと、
# GitHub 側にまだ新しい commit が見えておらず**古い oid が返る**。そのまま基準にすると、
# 次の assert_head_unchanged が「自分で作ったマージコミット」を他人の push と誤検出して中断した。
#
# 「変わったら採用」では**自分の更新と他人の push を区別できない**（レビューが指摘した窓）。
# `update-branch` が作るのは**旧 HEAD を親に持つマージコミット**なので、**親を見て確かめる**:
# 新しい HEAD の親に旧 HEAD_OID が含まれていれば、それは我々が作らせたもの。
# 含まれなければ（＝人が直接 push した）**基準を動かさず**、assert_head_unchanged に判断を委ねる。
# is_our_merge_commit <new-oid> <old-oid> → 0 なら「main を取り込んだだけ」
# `update-branch`（および GitHub の "Update branch"）が作るのは
# **旧 HEAD を親に持つマージコミット**。それだけを我々の更新とみなす。
#
# **親に旧 HEAD がある = 安全、ではない**（#414）: 誰かが旧 HEAD の上に普通のコミットを
# 積んだ場合も親には旧 HEAD が入る。その追加分は検査を通っていないのでマージしてはいけない。
# 区別のため**親が2つ以上あること**も要求する（マージコミットかどうか）。
is_our_merge_commit() {
  local oid=$1 before=$2 parents n
  parents=$(gh api "repos/$REPO/commits/$oid" -q '.parents[].sha' 2>/dev/null || true)
  n=$(grep -c . <<<"$parents" || true)
  [[ "$n" -ge 2 ]] || return 1                                   # 普通のコミットは受け入れない
  [[ $'\n'"$parents"$'\n' == *$'\n'"$before"$'\n'* ]]          # 旧 HEAD を親に持つか
}

repin_head() {
  local oid before=$HEAD_OID attempt
  for attempt in 1 2 3; do
    oid=$(gh pr view "$PR" --json headRefOid -q .headRefOid 2>/dev/null || true)
    if [[ -n "$oid" && "$oid" != "$before" ]]; then
      if is_our_merge_commit "$oid" "$before"; then
        HEAD_OID=$oid   # 旧 HEAD を親に持つマージコミット = 取り込んだだけ
        return 0
      fi
      log "note: $oid is not a merge of $before — not ours; leaving the guard to decide"
      return 0
    fi
    sleep 2   # API にまだ見えていないだけかもしれないので、数回だけ待つ
  done
  log "note: the branch head still reads $before after the update; not re-pinning"
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
  # **自分で動かしていない取り込み**（GitHub の "Update branch"、auto-update）でも HEAD は動く。
  # `update_if_behind` は BEHIND のときしか走らないので、BLOCKED（CI 待ち）の間に
  # 取り込まれると repin されず、ここで毎回止まっていた（#414。PR #409 で2回踏んだ）。
  # **旧 HEAD を親に持つマージコミット**なら取り込んだだけなので、基準を進めて続行する。
  if is_our_merge_commit "$now" "$HEAD_OID"; then
    log "branch was updated with main elsewhere ($HEAD_OID → $now); continuing"
    HEAD_OID=$now
    return 0
  fi
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

# fetch_checks — `commits/<sha>/check-runs` を読み、各チェック名を pass/pending/fail に分類する
# （`\(bucket)\t\(name)` 形式。`gh pr checks` の --json name,bucket と同じ形にして、以降の awk を
# そのまま使い回す）。
#
# **`gh pr checks` を使わない理由（#561）**: `gh pr checks` の bucket は `status` から作られる。
# GitHub 側の不整合で `status: in_progress` のまま `conclusion` が既に付くことがあり
# （実際に PR #534 の forbidden-patterns で observed: completed_at も入っていた）、
# その場合 bucket は "pending" のままになる。**`conclusion` が付いていれば、`status` に関わらず
# 結論が出ている**ので、`conclusion` を最優先で読む。
#
# 判定:
#   conclusion が null                              → pending（まだ実行中で結論なし）
#   conclusion が success / neutral / skipped        → pass
#   conclusion がそれ以外（failure/cancelled/timed_out/action_required/stale 等） → fail
#
# 出力は `<bucket>\t<name>\t<conclusion>\t<details_url>` の4列（#858 で 3・4 列目を足した）。
# **赤いときに「何で赤いのか」を、押す人がその場で読めるようにするため**:
#   - `conclusion`  `failure` と `cancelled` と `timed_out` は読む人にとって別の話で、
#                   「押してよいか」の判断がそこで変わる
#   - `details_url` **その job のログの URL**。`--net-deletions` が鳴ったときに
#                   「どのファイルの何行が減っているか」が書いてあるのは**そのログの中だけ**で、
#                   PR の画面にも `gh pr checks` の一覧にも出てこない（#858 で PO が指摘）。
#                   **数字をここで作り直さない**——検査が既に数えたものを指すだけにする。
#                   作り直すと二重の実装になり、片方が古くなったときに嘘をつく。
# pending は conclusion が null なので3列目は空になる。既存の awk は $1/$2 しか見ないので
# 列を足しても読み方は変わらない。
#
# 同名のチェックが複数回（再実行）現れることがあるので、`started_at` が最新の1件だけを見る
# （古い run の conclusion で判定しない）。
#
# 作業合意「CI の状態は commit を固定して読む」（2026-09-05）:
# branch protection が読むのも `commits/<PR の HEAD>/check-runs` なので、これに合わせる。
fetch_checks() {
  # shellcheck disable=SC2016  # $r/$bucket は jq の変数。シェルに展開させないためのシングルクォート
  gh api "repos/$REPO/commits/$HEAD_OID/check-runs" -q '
    [.check_runs[] | {name, status, conclusion, started_at, details_url}]
    | group_by(.name)
    | map(max_by(.started_at))
    | .[]
    | . as $r
    | (if $r.conclusion == null then "pending"
       elif ($r.conclusion == "success" or $r.conclusion == "neutral" or $r.conclusion == "skipped") then "pass"
       else "fail" end) as $bucket
    | "\($bucket)\t\($r.name)\t\($r.conclusion // "")\t\($r.details_url // "")"
  '
}

# classify_failures — fail の行を「必須」と「必須でない」に振り分け、シェル変数に置く。
# REQUIRED_RED / NONREQUIRED_RED は名前だけ（空白区切り）、NONREQUIRED_RED_DETAIL は
# `name (conclusion)` 形式——**黙って押さない**ための読み上げ用（#858）。
classify_failures() {
  local name concl url
  REQUIRED_RED=""; NONREQUIRED_RED=""; NONREQUIRED_RED_DETAIL=""; NONREQUIRED_RED_LOGS=""
  while IFS=$'\t' read -r _ name concl url; do
    [[ -n "$name" ]] || continue
    if is_required_check "$name"; then
      REQUIRED_RED+="$name "
    else
      NONREQUIRED_RED+="$name "
      NONREQUIRED_RED_DETAIL+="$name (${concl:-unknown}) "
      # **押す人が読むための行**。URL が無ければそう言う（黙って行を落とさない）
      NONREQUIRED_RED_LOGS+="         $name (${concl:-unknown}): ${url:-（ログの URL が取れませんでした）}"$'\n'
    fi
  done < <(awk -F'\t' '$1=="fail"' <<<"$1")
  REQUIRED_RED=${REQUIRED_RED% }; NONREQUIRED_RED=${NONREQUIRED_RED% }
  NONREQUIRED_RED_DETAIL=${NONREQUIRED_RED_DETAIL% }
  NONREQUIRED_RED_LOGS=${NONREQUIRED_RED_LOGS%$'\n'}
}

# wait_for_green — チェックが全部 pass/skipping になるまで待つ。POLL_MAX を通算で使い切る
# （マージ拒否のたびに待ち直すので、上限をリセットすると無限に粘れてしまう）。
i=0
wait_for_green() {
  while true; do
    i=$((i + 1))
    checks=$(fetch_checks || true)
    # fetch_checks は pending/pass/fail の3種類しか返さない（cancelled 等の失敗系は fail に含む）
    failed=$(awk -F'\t' '$1=="fail"{print $2}' <<<"$checks")
    pending=$(awk -F'\t' '$1=="pending"{print $2}' <<<"$checks")
    total=$(grep -c . <<<"$checks" || true)
    required_total=0; unknown_checks=""
    # **毎 poll で捨てる**。前の poll で赤かったものが今は緑かもしれない
    # （`gh run rerun` や、update-branch で走り直した場合）。持ち越すと
    # 「緑なのに赤いまま通した」と嘘のログを残す。
    PROCEEDED_OVER_RED=""
    while IFS=$'\t' read -r _ n _; do
      [[ -n "$n" ]] || continue
      if is_required_check "$n"; then required_total=$((required_total + 1)); fi
      if ! is_known_check "$n"; then unknown_checks+="$n "; fi
    done <<<"$checks"
    unknown_checks=${unknown_checks% }
    # **知らない名前が出たら必ず言う**（必須として扱ってはいるが、そう決めた人はいない）。
    # **同じ顔ぶれでは 1 回だけ**言う: wait_for_green は最大 60 回まわるので、毎回出すと
    # 「毎回鳴る警告」になって読まれなくなる。顔ぶれが変わったら（新しい job が増えたら）また言う。
    if [[ -n "$unknown_checks" && "$unknown_checks" != "${unknown_announced:-}" ]]; then
      log "note: 知らない検査があります（必須として扱います。REQUIRED_CHECKS / NONREQUIRED_CHECKS に足してください）: $unknown_checks"
      unknown_announced=$unknown_checks
    fi
    if [[ -n "$failed" ]]; then
      # #858: 赤を「必須」と「必須でない」に分ける。**母数を必ず出す**（#757）——
      # 何件の検査を見て、そのうち何件が必須で、何件が赤いのか。
      classify_failures "$checks"
      local red_total; red_total=$(grep -c . <<<"$failed" || true)
      log "検査 $total 件 / 必須 $required_total 件 / 赤 $red_total 件（必須の赤: ${REQUIRED_RED:-なし} / 必須でない赤: ${NONREQUIRED_RED_DETAIL:-なし}）"
      # **必須が 1 件でも赤ければ絶対にマージしない**（--allow-nonrequired-red があっても）。
      if [[ -n "$REQUIRED_RED" ]]; then
        die "checks failed on PR #$PR: $REQUIRED_RED${NONREQUIRED_RED:+ (必須でない赤: $NONREQUIRED_RED)}
       必須の検査が赤いので、マージしません。--allow-nonrequired-red では通せません。"
      fi
      # ここから先は「必須でないものだけが赤」。**黙って押さない**: 何がどう赤いかを必ず言い、
      # **その理由が書いてある場所（job のログ）を指す**。
      # `--net-deletions` が鳴ったとき、「どのファイルの何行が減っているか」は
      # **その job のログの中にしかない**——PR の画面にも `gh pr checks` にも出てこない。
      # 指さなければ「押す人は何も読めないまま押す」ことになる（#858 で PO が指摘）。
      if [[ "$ALLOW_NONREQUIRED_RED" != 1 ]]; then
        die "checks failed on PR #$PR: $NONREQUIRED_RED_DETAIL
       これは必須の検査ではありません（必須 $required_total 件は全部緑）。GitHub はマージを許します。
       **なぜ赤いのかを読んでから**判断してください。赤い検査のログ:
$NONREQUIRED_RED_LOGS
       手元で読むなら:
         gh pr checks $PR
         gh run view --log-failed --job <上の URL 末尾の数字>
       読んだうえで通すなら:
         scripts/po/merge-when-green.sh --allow-nonrequired-red $PR"
      fi
      # 押す直前に、押すと言う。**ログの URL も一緒に出す**——あとから
      # 「何を見て押したのか」を追えるようにするため（ここが記録として残る唯一の場所）。
      log "必須でない検査が赤いまま進みます（--allow-nonrequired-red）: $NONREQUIRED_RED_DETAIL"
      log "赤い検査のログ:
$NONREQUIRED_RED_LOGS"
      # **「全部緑」と言わせない**（下の break の直前の行）。赤いまま進んだのだから、
      # `all N checks green` は嘘である。**ログは後から「何が起きたか」を読む唯一の記録**なので、
      # そこに嘘が混ざると、次に事故を調べる人が誤った前提から出発する。
      PROCEEDED_OVER_RED=$NONREQUIRED_RED_DETAIL
    fi
    if [[ -z "$pending" && "$total" -gt 0 ]]; then
      if update_if_behind; then
        log "[$i/$POLL_MAX] checks were green on an old base; waiting for them to re-run"
      else
        if [[ -n "${PROCEEDED_OVER_RED:-}" ]]; then
          log "必須 $required_total 件は緑。$PROCEEDED_OVER_RED を赤いまま通してマージします"
        else
          log "all $total checks green"
        fi
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
# `gh pr merge` の**非ゼロを「マージされなかった」と読んではいけない**（#434）。
# 実地で1日に5回踏んだ（PR #428/#429/#430/#432/#437）: `mergeStateStatus` が UNKNOWN
# （GitHub がマージ可能性を計算中）の間に叩くと、**実際にはマージされるのに非ゼロで返る**。
# 10 秒×6 回待っても UNKNOWN のままだったので「待てば解決」ではない。**結果を読む**。
# もう1つの経路: マージ自体は成功したが `--delete-branch` の**ローカル**ブランチ削除が
# 「used by worktree at ...」で失敗した場合も非ゼロになる。これも成功である。
#
# assert_merged_by_us — マージ後の PR を読み、**我々の成功として報告してよいか**を返す。
#   0: 我々が検査した HEAD がマージされた（成功として終わってよい）
#   1: まだ OPEN（本当に拒まれた。従来どおり再試行 → die）
#   die: MERGED だが別の commit / CLOSED（どちらも再試行してはいけない）
#
# **なぜ state=MERGED だけでは足りないか**（「成功として扱う」が緩すぎないかの線引き）:
# MERGED は「誰かがマージした」しか意味しない。他人が新しいコミットを push してから
# マージしていた場合も MERGED になり、そのとき main に入ったのは**我々が緑を確認していない
# commit** である。#392/#414 で守ってきた「検査を通った HEAD だけがマージされる」という
# 不変条件を、ここで黙って崩すことになる。
# そこで **マージ後も読める headRefOid が、直前に assert_head_unchanged で確かめた
# $HEAD_OID と一致すること**まで確かめる。一致すれば、たとえ手を下したのが他人でも
# **main に入った中身は我々が検査したものと同一**なので、成功と報告してよい
# （squash マージなので main 側の SHA は変わるが、入る差分は head の内容そのもの）。
# 一致しなければ「マージはされたが我々の成功ではない」と伝えて止める——PO に
# 「何がマージされたのか」を必ず見に行かせるためで、黙って 0 で終わるより安全。
#
# **state を読めなかった場合**（#446）: `gh pr view` が API エラー等で失敗すると、`read` は
# 何も読めずに `state` が空のまま返る（この関数は `if` の中で呼ばれるので `set -e` は効かない）。
# 空を catch-all に落とすと「PR #12 はマージ中に  になりました」と**空白**が出て、
# PO に何が起きたのか伝わらなかった。止まること自体は安全（成功と誤報しない）なので、
# **動作は変えず、言葉だけを直す**。allowlist 構造（OPEN / MERGED / 空 / それ以外は die）は
# そのまま: 空を足しても、**未知の state は catch-all で die** に倒れる。
#
# **空 oid を一致とみなさない**（#446）: `[[ "$oid" == "$HEAD_OID" ]]` は両方空だと真になる。
# レビューでは実際に到達する経路を見つけられなかった（起動時に空 oid が返るなら
# assert_head_unchanged 等が先に壊れるはず）が、偽の一致は「**検査を通っていない HEAD を
# 成功と報告する**」という、このスクリプトで一番出してはいけない結果になる。
# `-n` の1つで塞げるので塞ぐ——「到達しないから直さない」ではなく「安いから塞ぐ」。
assert_merged_by_us() {
  local state oid merge_err=${1:-}
  IFS=$'\t' read -r state oid < <(
    gh pr view "$PR" --json state,headRefOid -q '[.state, .headRefOid] | @tsv'
  )
  case "$state" in
    OPEN) return 1 ;;   # 本当に拒まれた
    MERGED)
      # 空 oid 同士を一致とみなさない（$HEAD_OID も空なら "" == "" が真になってしまう）
      if [[ -n "$oid" && "$oid" == "$HEAD_OID" ]]; then
        log "gh pr merge は非ゼロで返りましたが PR #$PR は MERGED です（検査した HEAD ${HEAD_OID:0:7} のまま）。成功として扱います"
        # ローカルブランチの残存は、**削除が失敗したときだけ**言う（#446）。
        # UNKNOWN 由来の非ゼロでは削除は成功しているので、毎回出すと余計な確認をさせる。
        if [[ "$merge_err" == *"delete local branch"* ]]; then
          log "（ローカルブランチ $HEAD の削除に失敗しています: worktree が使っている可能性があります。手で消してください）"
        fi
        return 0
      fi
      die "PR #$PR は MERGED ですが、マージされたのは別の commit です（検査した ${HEAD_OID:0:7} → ${oid:0:7}）。
       我々が緑を確認していない変更が main に入っている可能性があります。$URL を確認してください。" ;;
    "")
      die "PR #$PR の state を読めませんでした（gh pr view が失敗: API エラー？）。
       マージされたかどうかを確認できないので、ここで止めます。$URL を確認してください。" ;;
    *)
      die "PR #$PR はマージ中に $state になりました（マージされていません）。$URL を確認してください。" ;;
  esac
}

log "squash-merging PR #$PR and deleting $HEAD"
for attempt in 1 2 3; do
  assert_head_unchanged     # 待っている間に push されたコミットを取り残さない（#392）
  assert_no_stacked_prs     # 待っている間に上へ積まれた PR を巻き添えにしない（#392）
  # 非ゼロだったときに「なぜ非ゼロなのか」を assert_merged_by_us に渡せるよう、
  # gh の出力を控えておく（ローカルブランチ削除の失敗かどうかの判定に使う。#446）。
  # `set -e` があるので rc は `|| merge_rc=$?` で受ける（代入と同じ行に書くと rc が消える）
  merge_rc=0
  merge_err=$(gh pr merge "$PR" --squash --delete-branch 2>&1) || merge_rc=$?
  # gh が言ったことは**成功・失敗どちらでも**そのまま見せる（stderr へ。stdout は結果の一行だけ）。
  # 控えるのは判定に使うためで、隠すためではない
  if [[ -n "$merge_err" ]]; then printf '%s\n' "$merge_err" >&2; fi
  if [[ "$merge_rc" -eq 0 ]]; then
    echo "merged PR #$PR ($HEAD) $URL"
    exit 0
  fi
  # 非ゼロ。**再試行する前に、本当にマージされていないかを確かめる**（#434）
  if assert_merged_by_us "$merge_err"; then
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
