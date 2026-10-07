#!/usr/bin/env bash
# Issue #1227: **データ PR に auto-merge を付けてよいかを、人の記憶ではなく実測で決める。**
#
#   scripts/ci/etl-auto-merge-gate.sh <branch>
#       exit 0  … 付けてよい（呼び出し側が `gh pr merge --auto` を打つ）
#       exit 10 … **付けない**（理由を GITHUB_STEP_SUMMARY と stdout に出してある）
#       exit 1  … 検査自体が成立しなかった（比較できない。**付けない**）
#       exit 2  … 使い方の誤り
#
# ## 何が問題だったか
#
# `etl.yml` は PR を作ったあと **無条件に** `gh pr merge --squash --auto` を打っていた。
# **auto-merge は armed になった瞬間から「必須チェックが緑になったら自分でマージする」**ので、
# **止めているものは必須チェックの赤だけ**である。
#
# 2026-10-05（#1208）と 2026-10-07（#1222）は、どちらも **PO が手で auto-merge を解除して**止めた。
# **つまり「止まっている」が人の作業に乗っていた。** 1 日忘れると、次の 2 つが重なる:
#
#   1. 誰かが赤い検査を緑にする（**いちばん自然な手は #1190 の期待値の表を実測に合わせること**）
#   2. その瞬間に armed な PR が自分でマージされる
#
# **個票に復元元が無い項目が在る**（実測 5/5 で `referredCommittees` は `bills/{session}/{id}.json`
# に無い）。**だから「マージしてから直す」が効かない。消えたら戻らない。**
# これは [[expected-table-is-not-a-knob]] の型である——**期待値の表は、減った方向に
# 合わせられると喪失を通す。** 表を守るのではなく、**armed にしないほうを塞ぐ。**
#
# ## なぜ 2 つの理由を持つか（片方では足りない）
#
#   (A) **停止ファイル** `data/.refresh-hold`（中身は理由）。**人の判断を持ち越す器**である。
#       **既知の喪失が「data だけでは churn と区別が付かない」形で残っているときに要る**
#       （#1229 の 493 行がまさにそれ。下の実測）。**人が 1 回置けば、消すまで効き続ける。**
#       **「毎日外す」は記憶に乗るが、「1 回置く」はファイルに乗る。**
#   (B) **消えたファイルの実測**。`origin/main` の tip と突き合わせて、`data/` の下から
#       **消えたファイルを全件数える**。母数（差分のあるパスの総数）と一緒に出す（#757）。
#       **(A) を置き忘れても、新しい形の喪失はこちらが拾う。**
#
# **(A) だけだと「次に別の形で消え始めたとき」に誰も気づかない**（#1229 は 3 回マージされてから
# 気づかれた。下の実測）。**(B) だけだと、置き忘れではなく「判断として止める」ができない**
# ——**data からは churn と区別が付かない喪失が実在する**ので、人の判断を持ち越す器は要る。
#
# ## (B) を「消えたファイル」にした根拠（**実測。2026-10-07**）
#
# `origin/main` の `data: refresh` / `data: districts` コミット **58 本**（母数）を
# 親と突き合わせて、`data/` の下で消えたファイルを数えた:
#
# | 消えたファイル数 | 本数 | 中身 |
# |---|---|---|
# | 0 件 | **53 / 58** | — |
# | 8 件 | **3 / 58** | `data/unmatched/{202,203,205,206,207,210,212,215}.json`（**毎回まったく同じ 8 本**） |
# | 2 件 | 1 / 58 | `data/members/h_42df80d20e.json` と その `speeches.json` |
# | 1 件 | 1 / 58 | `data/members/h_9aeb820ec0/speeches.json` |
#
# **閉じた PR #1222 を同じ尺度で測ると、消えたファイルは 8 件で、
# 回次も 202/203/205/206/207/210/212/215 と完全に一致する**（#1229 が 493 行と数えたもの）。
# **つまりこの尺度は #1229 をそのまま名指しする。**
#
# **そして同じ 8 本は 2026-08-27 / 08-28 / 09-28 に、すでに 3 回 auto-merge されている。**
# **この検査が在れば、その 3 回とも armed にならなかった。**
#
# ## この検査が**言えないこと**（正直に書く）
#
# - **「消えて正しい」と「消えて間違い」を区別できない。** 実測すると
#   `data/unmatched/202.json` は main 上で **A → D → A → D → A → D → A** と振動している
#   （既定 5 回次の実行に 202 が入らない日は出力されない）。
#   **つまり上の 8 件は churn かもしれない。** #1229 が「data だけでは区別が付かない」と
#   書いているのは同じことである。**だからこの検査は「失敗」ではなく「armed にしない」**
#   ——**赤にして人を急かすのではなく、人が読むまで黙って待つ。**
# - **ファイルの中で減った行は見ない。** #1218 の `referredCommittees` **1,660 → 1,656** は
#   **ファイルが消えていないので (B) では拾えない**（実測で確認した: `bills/index.json` の
#   要素数は 1,941 のまま動かない）。**それを見るのは `#1190` の検査の仕事**であって、
#   ここの仕事は**その検査が赤いあいだに armed にしないこと**ではなく
#   **armed そのものを人の記憶から外すこと**である。**(A) がその穴を埋める器になっている。**
# - **行数では測らない。** 実測すると `data/unmatched.json` の差分は
#   **1,334,629 行削除 / 1,219 行追加**で、整形の影響が支配的だった。**行数は使えない。**
#
# 環境変数（テスト用。既定は本番の値）:
#   REMOTE          … 既定 origin
#   DEFAULT_BRANCH  … 既定 main
#   DATA_PREFIX     … 既定 data/
#   HOLD_FILE       … 既定 data/.refresh-hold
set -euo pipefail

BRANCH=${1:-}
REMOTE=${REMOTE:-origin}
DEFAULT_BRANCH=${DEFAULT_BRANCH:-main}
DATA_PREFIX=${DATA_PREFIX:-data/}
HOLD_FILE=${HOLD_FILE:-data/.refresh-hold}

if [[ -z $BRANCH ]]; then
  echo "usage: $0 <branch>" >&2
  exit 2
fi

# 止めたことも、止めなかったことも、**必ず人が読める場所に出す**（#1056: 黙って止まるのは別の事故）。
say() {
  echo "$1"
  [[ -n ${GITHUB_STEP_SUMMARY:-} ]] && echo "$1" >> "$GITHUB_STEP_SUMMARY"
  return 0
}

say "## auto-merge の門（#1227）"
say ""

WITHHOLD=0
REASONS=()

# ---- (A) 停止ファイル -------------------------------------------------------
# **`data/` の中に置く。** ETL は `data/` だけを触るので、置いたファイルが
# `etl-data-only-push.sh` の「data/ の外は 0 件」に引っかからない。
if [[ -f $HOLD_FILE ]]; then
  WITHHOLD=1
  REASONS+=("停止ファイル \`$HOLD_FILE\` が在る")
  say "### 停止ファイルが在る: \`$HOLD_FILE\`"
  say ""
  say "書かれている理由:"
  say ""
  say '```'
  while IFS= read -r l || [[ -n $l ]]; do say "$l"; done < "$HOLD_FILE"
  say '```'
  say ""
  say "**解除するには、原因を直してからこのファイルを消すこと**（\`git rm $HOLD_FILE\`）。"
  say "**消すまで、毎晩の refresh は PR を作るが auto-merge は付かない。**"
  say ""
else
  say "停止ファイル \`$HOLD_FILE\` は無い。"
  say ""
fi

# ---- (B) 消えたファイルの実測 -----------------------------------------------
# **tip 同士で比べる**（三点は merge base と比べるので、土台が古いままだと見逃す。#943）。
git fetch "$REMOTE" "$DEFAULT_BRANCH" >/dev/null 2>&1 || true
BASE="$REMOTE/$DEFAULT_BRANCH"
# **土台が解決できないまま進むと `git diff` が 1 行も出さず、その 0 件が
# 「消えたファイルは 0 件。armed にする」に化ける**（#757 / #943 が実測で踏んだ形）。
if ! git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then
  say "**FAIL: 土台 \`$BASE\` を解決できない。** 比較できないものを「消えたファイル 0 件」と"
  say "読むと検査が素通りする（#757）。**auto-merge は付けない。**"
  exit 1
fi

DIFF_OUT=$(mktemp); trap 'rm -f "$DIFF_OUT"' EXIT
# **`-z` で NUL 区切りにする。** 既定の `core.quotePath=true` では非 ASCII のパスが
# ダブルクォートで囲まれて 8 進エスケープされ、`data/` の中のファイルが「外」に数えられる
# （#943 が実測で踏んだ。日本語の議案名を持つファイルが通れなかった）。
if ! git diff -z --name-status "$BASE" HEAD -- "$DATA_PREFIX" > "$DIFF_OUT"; then
  say "**FAIL: \`git diff --name-status $BASE HEAD\` が失敗した。** 比較できていないので"
  say "**auto-merge は付けない。**"
  exit 1
fi

# `--name-status -z` の出力は `<status>\0<path>\0`（R/C だけ `<status>\0<from>\0<to>\0`）。
# ETL は rename を作らないが、来ても「消えた」とは数えない形にしておく。
mapfile -t -d "" FIELDS < "$DIFF_OUT"
DELETED=()
TOTAL=0
i=0
while ((i < ${#FIELDS[@]})); do
  st=${FIELDS[i]}
  if [[ $st == R* || $st == C* ]]; then
    ((i += 3)); TOTAL=$((TOTAL + 1)); continue
  fi
  p=${FIELDS[i + 1]:-}
  ((i += 2)); TOTAL=$((TOTAL + 1))
  # **停止ファイル自身を「消えた記録」に数えない。**
  # 数えると**解除が永久に自分を止める**——(A) を消した次の refresh が (B) で止まり、
  # その refresh が止まっている理由は「停止ファイルが消えたこと」になる。
  # **解除できない止め方は、止め方として壊れている。**
  # （この分岐は後から足したものではなく、テストが先に捕まえた:
  #  `t_removing_hold_file_arms_again` が expected [0] got [10] で落ちた。）
  # **停止ファイルは記録ではない**ので、消えても喪失ではない。
  [[ $st == D* && $p != "$HOLD_FILE" ]] && DELETED+=("$p")
done

say "### \`$DATA_PREFIX\` から消えたファイル（\`$BASE\` の tip と突き合わせた）"
say ""
say "| 区分 | 件数 |"
say "|---|---|"
say "| 差分のあるパス（母数） | $TOTAL |"
say "| うち消えた（D） | ${#DELETED[@]} |"
say ""
if ((TOTAL == 0)); then
  say "$BASE の tip との差分は 1 件も無い（**母数 0**。数えていないのではない）。"
  say ""
fi

if ((${#DELETED[@]} > 0)); then
  WITHHOLD=1
  REASONS+=("\`$DATA_PREFIX\` からファイルが ${#DELETED[@]} 件消えている（母数 $TOTAL 件）")
  for p in "${DELETED[@]}"; do say "- \`$p\`（消えた）"; done
  say ""
  say "**消えたファイルは、個票に復元元が無いことが在る**（実測 5/5 で"
  say "\`referredCommittees\` は \`bills/{session}/{id}.json\` に無い）。**マージすると戻らない。**"
  say ""
  say "**churn かもしれない**——\`data/unmatched/202.json\` は main 上で A→D→A→D→A→D→A と"
  say "振動している（既定回次に 202 が入らない日は出力されない）。**だから「失敗」にはしない。**"
  say "**人が中身を見て決めること**（#1229）。"
  say ""
fi

# ---- 判定 -------------------------------------------------------------------
if ((WITHHOLD == 1)); then
  say "### 判定: **auto-merge を付けない**"
  say ""
  for r in "${REASONS[@]}"; do say "- $r"; done
  say ""
  say "**PR は作ってある。** マージしないだけである——**人が中身を見て、"
  say "正しいと判断したら手でマージすること**（\`gh pr merge <番号> --squash\`）。"
  say "**黙って止まっているのではない。この表がその説明である**（#1056）。"
  exit 10
fi

say "### 判定: **auto-merge を付ける**"
say ""
say "停止ファイルは無く、\`$DATA_PREFIX\` から消えたファイルも 0 件（母数 $TOTAL 件を全部見た）。"
exit 0
