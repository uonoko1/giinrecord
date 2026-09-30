#!/usr/bin/env bash
# Issue #1110: スクラムの停滞を見張る。**リポジトリの中に在ること**がこの道具の存在理由である。
#
# **何が壊れていたか（PO が 2 回実測した。#1110 と #1099 のコメント）:**
#   PO はこれと同じ監視を `scratchpad` に立てていた。**scratchpad はセッション固有なので、
#   セッションが終わると消える。** **2026-09-29〜30 の 1 日で 2 回消えた。**
#     1 回目  セッション再開で監視が止まった  →  **PO が気づかず、監視なしで進めた**
#     2 回目  スクリプト自体が消えた          →  `MONITOR-BROKEN` が出て気づいた
#   **その日 23 本マージしており、そのあいだ監視が 2 回死んでいた。**
#   **死んでいる間は「止まった worktree」も「PR の赤」も誰も見ていない。**
#   `find scripts -iname '*monitor*'` → **`deploy/monitor/` はサイトを見るもので、
#   スクラムを見るものは 0 件**だった。
#
# 何を見るか（節ごとに、母数つきで出す）:
#   1. PR        開いている PR の赤い検査（`--paginate` + `total_count` の検算）
#   2. board     `In Progress` のまま書き込みが $STALE_MINUTES 分無いもの
#   3. worktree  止まっている疑い／幽霊（**判定は worktree-audit.sh に委ねる**）
#
# **「何も言わない」と「正常」を区別できること**が要件である（#1094）。
#   - **節ごとに「見た件数／測れなかった件数」を必ず出す**（#757 の母数。
#     **「赤 0 件」と「1 件も数えていない」を同じ顔にしない**）。
#   - **測れなかった節が在れば exit 4**（`MONITOR-BROKEN`）。**黙って 0 を出さない。**
#   - 末尾に必ず 1 行 `scrum-monitor: 終了（節 N/M を測れました）` を出す。
#     **この行が無ければ、この道具は途中で死んでいる**（`set -e` で落ちた）。
#
# **出力に書かないもの**（OSS で公開され、この出力は Issue にコピーされる。
# `deploy/test/environment-protection.test.sh:47` に同じ理由が在る）:
#   IP・ホスト名・**worktree の絶対パス**・鍵・アカウント名。
#   **件数と Issue/PR の番号は書いてよい**（番号は GitHub 上で既に公開されている）。
#   **worktree はパスではなく本数だけ出す**——**枝名も出さない**（枝名は担当者を指す）。
#   詳細が要るときは `worktree-audit.sh` を人が手で走らせる（あちらはローカル専用）。
#
# 終了コード:
#   0 = 全部測れて、行動が要るものが無い
#   2 = 使い方が違う
#   3 = 行動が要る事実が在る（赤い検査／停滞／幽霊）。**測定自体は成功している**
#   4 = **測れなかった節が在る（MONITOR-BROKEN）**。**この道具を信じてはいけない**
#   3 と 4 が重なったら **4 を返す**——**「測れなかった」のほうが重い**
#   （行動が要るものを見落としている可能性が在るため）。
#
# Env:
#   PO_REPO           owner/name（既定は `gh repo view`）
#   STALE_MINUTES     停滞と呼ぶ閾値（分。既定 90。**根拠は下の実測**）
#   MONITOR_NOW       現在時刻の epoch 秒（テスト用。既定は本物の時計）
#   MONITOR_SKIP_LOCAL  1 なら worktree の節を飛ばす（CI では worktree が 1 本しか無く、
#                       PO の手元の話は測れない。**飛ばしたことを出力に書く**）
#
# Tests: scripts/po/test/scrum-monitor.test.sh（fake `gh` / fake `git`。実在のツリーを触らない）
#
# Usage:
#   scripts/po/scrum-monitor.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/po/lib.sh
source "$HERE/lib.sh"

case "${1:-}" in
  "") ;;
  *) usage "scrum-monitor.sh" ;;
esac

# ---- 閾値の根拠（#1110 の受け入れ条件 3）------------------------------------------------------
#
# **PO の 90 分は勘だった**（#1099 のコメントに「根拠が在りません」と自分で書いている）。
# **測った**（2026-09-29、手元の agent worktree 6 本・直近 24 時間の書き込み。
# **メインの作業ツリーは除いた**——あれは PO のもので、エージェントの挙動ではない）。
#
# **測った量は「連続する書き込みの間隔」**である。**閾値はこの分布の上に乗っていなければ
# ならない**——**考えているだけのエージェントを「止まった」と呼ばないため**（#1110 の
# 「長く考えているだけのエージェントを誤報しないこと」）。
#
#   間隔 n=36（6 本の worktree、24 時間）
#     p50 = 0.0 分 / p75 = 0.3 分 / p90 = 3.3 分 / p95 = 10.6 分 / **max = 17.0 分**
#   閾値ごとの誤報（その閾値を超えた間隔の本数）:
#     > 5 分 2/36 (5.6%) / >10 分 2/36 (5.6%) / >15 分 1/36 (2.8%)
#     **>20 分 0/36 / >30 分 0 / >45 分 0 / >60 分 0 / >90 分 0 / >120 分 0**
#
# **20 分以上の間隔は 1 本も無かった。** つまり**働いているエージェントは 17 分以上
# 黙らない**（この標本では）。**90 分は観測された最大の約 5 倍**である。
#
# **なぜ 20 分や 30 分に下げないか**——**倒れる向きが非対称だから**である:
#     誤って鳴らす   → PO が 1 本目で見る。**失うものは無いが、鳴り続けると見なくなる**
#     誤って黙る     → **止まった作業が放置される。これが #1110 が起きた理由そのもの**
#   一見すると「黙るほうが重いので短くせよ」に見える。**逆である**——
#   **この道具は 10 分ごとに回る**ので、**閾値を下げても「見つかるのが早くなる」だけで、
#   見つからなくなるわけではない。** 一方**誤報は毎回出て、出力全体の信用を落とす**
#   （`worktree-audit.sh` の「毎回鳴ると鳴っていること自体を見なくなる」と同じ罠）。
#   **標本が 36 件しか無い**ことも効く: **p99 を 36 件から決めるのは無理**なので、
#   **観測された最大（17 分）から大きく離す**しかない。
#
# **標本の限界（正直に）:**
#   - **36 件・6 本・1 日**である。**夜間に人が止めた時間は「間隔」に入っていない**
#     （24 時間で切ったので、それより古い書き込みは数えていない）。
#   - **「ファイルが書かれている」は「進んでいる」の代理である**
#     （`docs/WORKING_AGREEMENT.md` の「代理と実体」）。
#     **同じファイルを無限に書き直しているのは、この道具では検出できない。**
#     **これは #1110 に「測っていないこと」として書かれており、ここでも解決していない。**
STALE_MINUTES=${STALE_MINUTES:-90}
is_int "$STALE_MINUTES" || die "STALE_MINUTES は正の整数で指定してください（受け取った値: $STALE_MINUTES）"
NOW=${MONITOR_NOW:-$(date +%s)}
is_int "$NOW" || die "MONITOR_NOW は epoch 秒で指定してください（受け取った値: $NOW）"

REPO=$(po_repo)

# 節ごとに「測れたか」を数える。**母数は 3**（PR / board / worktree）。
SECTIONS_TOTAL=3
SECTIONS_OK=0
FINDINGS=0        # 行動が要る事実の件数
UNMEASURED=()     # 測れなかった節の名前と理由

unmeasured() { UNMEASURED+=("$1"); log "MONITOR-BROKEN $1"; }

# ---- 1. 開いている PR の赤い検査 --------------------------------------------------------------
#
# **`--paginate` が必要である**（#1093 で実測。**#1116 で必須 5 件が丸ごと消えた**）:
#   gh api ".../check-runs"            → returned 30 / total_count 53
#   gh api ".../check-runs" --paginate → returned 53 / total_count 53
# **30 件で消えていたのは branch protection の必須 4 件 + `pr-closes` の全部**だった。
# **消えた検査は「無い」ものとして扱われる**ので、**赤がそこに居れば黙って「赤 0 件」になる。**
#
# **`--paginate` だけでは足りない**（#1093、gh 2.89.0）:
#   **`--paginate` はオブジェクト応答を 1 個の JSON に畳まない**——**ページごとに 1 個の
#   JSON ドキュメントを並べて吐く。** `-q` を付けると **jq がドキュメントごとに走る**ので
#   `group_by` の畳み込みがページ境界をまたげない。**だから生 JSON を受けて `jq -s` で束ねる。**
#
# **母数の検算**（#757）: **`total_count` より少ない run しか手元に無いなら取りこぼしている。**
# **そのときは「赤 0 件」と言わず、`MONITOR-BROKEN` にする**——
# **これは監視なので、`merge-when-green.sh` のように die して止まる必要は無い**
# （止めると残りの節が測れなくなる）。**節として「測れなかった」に落とす。**
# `total_count` が**無い**応答では検算しない（「母数を知らない」と「取りこぼした」は別。
# 無いだけで壊れたと言うと、この道具が別の理由で鳴り続ける）。
#
# **同名の check-run をどう畳むか**——**`merge-when-green.sh` に合わせて `max_by(severity)`
# （最も悪いものを採る）にする。** **これは意図的な設計であって、真似られる欠陥ではない**:
#   `scripts/po/merge-when-green.sh` の `fetch_checks()` に逐語で在る:
#       「悪い順の重み。**同名グループからこれが最大の 1 件を採る**（fail が緑に塗り替えられない）」
#   **なぜ monitor も合わせるのか**: **この監視の役目は「マージが止まっている PR を PO に
#   見せること」である。** **ゲートが赤と見るものを monitor が緑と見たら、
#   PO には「詰まっていない」ように見えて、実際には詰まる。**
#   **食い違うほうが害が大きい**ので、**ゲートと同じ目で見る。**
#
#   **#1128 の限界をそのまま引き継ぐ**（あちらが未解決なのでここでも未解決である）:
#     同名が「古い失敗 → 新しい成功」で並ぶと、**直して緑にした PR も赤に見える。**
#     **実測（2026-09-29、直近 40 件のマージ済み PR の head、check-run 324 件）:**
#       同名が 2 件以上在った head          **4 / 40**
#       そのうち結論が食い違った head        **1 / 40**（PR #1131 の `pr-closes`:
#                                            failure@02:47 → success@03:08）
#     **つまり 40 件に 1 件は「直したのに赤と出る」。** **これは誤報だが、
#     ゲートが実際にその PR を止めるので、事実としては正しい**——
#     **「PO が行動する必要が在る」ことは合っている**（#1128 を進めるか、本文を直し直す）。
#     **#1128 が決着したら、両方を同時に直すこと**（片方だけ変えると食い違いが戻る）。
#
# **`skipped` の扱い**: **`merge-when-green.sh` は `SKIPPABLE_CHECKS` に列挙された名前だけを
# 緑と数える**（#1069。**必須 5 件が全部 `skipped` の PR が「全部緑」でマージされた**）。
# **monitor はその一覧を複製しない**——**複製すると 2 か所が食い違う**。
# **代わりに `skipped` を「赤」にも「緑」にも数えず、別の列として出す。**
# **monitor はマージを決めないので、判断を持つ必要が無い**（持つと二重管理になる）。
pr_section() {
  local list prs=0 red_prs=0 pending_prs=0 broken=0 runs_seen=0 runs_want=0

  if ! list=$(gh pr list --repo "$REPO" --state open --limit 200 \
      --json number,headRefOid,isDraft --jq '.[] | [(.number|tostring), .headRefOid, (.isDraft|tostring)] | @tsv' 2>/dev/null); then
    unmeasured "PR: 開いている PR の一覧が取れませんでした（gh の認証切れ／rate limit かもしれません）"
    return
  fi

  local num sha draft raw got want collapsed red pending skipped
  while IFS=$'\t' read -r num sha draft; do
    [[ -n "$num" && -n "$sha" ]] || continue
    prs=$((prs+1))

    # **終了コードで応答を捨てない**（#1116 のレビューで見つかった形。**PO も再現した**）。
    # **gh は「赤いチェックを含む応答を出しきってから非ゼロで終わる」ことがある**ので、
    # 捨てると**赤を読まずに「読めなかった」に倒れる。**
    raw=$(gh api "repos/$REPO/commits/$sha/check-runs" --paginate 2>/dev/null) || true

    if ! got=$(jq -s '[.[].check_runs[]] | length' <<<"$raw" 2>/dev/null); then
      log "MONITOR-BROKEN PR #$num: check-runs の応答が読めませんでした（空か壊れた JSON）"
      broken=$((broken+1)); continue
    fi
    want=$(jq -rs 'map(.total_count) | map(select(. != null)) | if length == 0 then "null" else .[0] end' <<<"$raw" 2>/dev/null || echo null)
    runs_seen=$((runs_seen+got))
    if [[ "$want" != "null" ]]; then
      is_int "$want" && runs_want=$((runs_want+want))
      if [[ "$got" -lt "$want" ]]; then
        # **取りこぼしたら「赤 0 件」と言わない**（#757 / #1093）。
        log "MONITOR-BROKEN PR #$num: check-runs を取りこぼしました（手元 $got 件 / total_count $want 件）。**赤を見落としている可能性が在ります**"
        broken=$((broken+1)); continue
      fi
    fi

    # **`max_by(severity)` で同名を畳む**（`merge-when-green.sh` と同じ目。上の docblock）。
    # **`// 2` は fail-closed**: `{...}[key]` は知らないキーで null を返し、
    # **`max_by` は null を最小として扱う**ので、表が痩せたらその bucket が消える。
    # **分からないものは fail の重みに倒す。**
    # **これは単独では変異で殺せない防御である**（`merge-when-green.sh` が同じことを実測して
    # 書いている: `// 2` → `// 0` でも 0 件落ちた）。**保険であって、測って裏づけた防御ではない。**
    # shellcheck disable=SC2016  # jq の変数。シェルに展開させない
    collapsed=$(jq -rs '
      def bucket_of:
        if .conclusion == null then "pending"
        elif (.conclusion == "success" or .conclusion == "neutral") then "pass"
        elif .conclusion == "skipped" then "skipped"
        else "fail" end;
      def severity: ({"pass": 0, "skipped": 1, "pending": 2, "fail": 3}[bucket_of]) // 3;
      # **`started_at` を落とさずに持つ。** **使っていないのに残す理由が在る**（実測）:
      # **これを落とすと、変異テストが `max_by(severity)` の正しさを測れなくなる。**
      #   投影が `{name, conclusion}` だったとき:
      #     max_by(severity)     → fail   ← 正しい
      #     max_by(.started_at)  → fail   ← **偶然一致する**（`.started_at` が全要素 null になり、
      #                                     `max_by` は同値のとき**最後の要素**を返す。
      #                                     fixture の最後が failure だったので偶然 fail）
      #   投影が `{name, conclusion, started_at}` なら:
      #     max_by(severity)     → fail
      #     max_by(.started_at)  → **pass** ← 2 つの設計が実際に分かれる
      # **つまり `started_at` が無いと「畳み方を取り替える変異」が生き残る**
      # ——**テストが常に緑になり、設計を守っていないのに守っているように見える。**
      [.[].check_runs[] | {name, conclusion, started_at}]
      | group_by(.name) | map(max_by(severity)) | .[] | bucket_of
    ' <<<"$raw" 2>/dev/null) || collapsed=""

    red=$(printf '%s\n' "$collapsed" | grep -c '^fail$' || true)
    pending=$(printf '%s\n' "$collapsed" | grep -c '^pending$' || true)
    skipped=$(printf '%s\n' "$collapsed" | grep -c '^skipped$' || true)

    if [[ "$red" != 0 ]]; then
      red_prs=$((red_prs+1)); FINDINGS=$((FINDINGS+1))
      log "赤 PR #$num: 赤 $red 件・実行中 $pending 件・skipped $skipped 件（検査 $got/$want 件${draft:+ , draft=$draft}）"
    elif [[ "$pending" != 0 ]]; then
      pending_prs=$((pending_prs+1))
    fi
  done <<< "$list"

  # **母数を必ず出す**（#757）。**「赤 0 本」と「PR を 1 本も見ていない」を同じ顔にしない。**
  log "PR $prs 本を見ました: 赤 $red_prs 本 / 実行中 $pending_prs 本 / 測れなかったもの $broken 本（check-run 計 $runs_seen 件 / total_count 計 $runs_want 件）"
  if [[ "$broken" != 0 ]]; then
    unmeasured "PR: $prs 本のうち $broken 本の検査を測れていません（**赤 $red_prs 本は下限です**）"
  else
    SECTIONS_OK=$((SECTIONS_OK+1))
  fi
}

# ---- 2. In Progress のまま動いていない PBI ----------------------------------------------------
#
# **`board-audit.sh` の規則 5 とは別のものを見る**（**二重管理ではない**）:
#   board-audit 規則 5  `In Progress` **なのに枝も PR も無い**（$STALE_HOURS 既定 24 時間）
#                       = **着手されていない**（#781: 担当者を立て忘れた形）
#   ここ                `In Progress` で**動いている痕跡は在るが、最近動いていない**
#                       （既定 90 分）= **途中で止まった**
# **前者は「始まっていない」、後者は「止まった」である。** **#1110 が起きたのは後者だ。**
#
# **何を「最近動いた」の代理にするか**: **Issue と、その番号を持つ PR の `updatedAt`。**
# **`gh` から見えるものだけを使う**——**worktree は PO の手元にしか無いので、
# CI からは測れない**（この節が CI でも動くことが #1110 の受け入れ条件「自動の入口」に要る）。
#
# **代理の限界（正直に）**: **`updatedAt` はコメントやラベルでも動く。**
# **「PR に 1 行コメントしただけ」は「進んだ」と数えられてしまう。**
# **逆側（進んでいるのに黙る）は起きにくい**ので、**見落とすより誤って黙る側に寄っている。**
# **これは代理であって実体ではない**（`docs/WORKING_AGREEMENT.md` の「代理と実体」）。
PROJECT_ID="PVT_kwHOBy0CLs4BhHqj"   # 議員レコード スクラムボード (project 2)。board-set.sh / board-audit.sh と同じ値

board_section() {
  local page cursor="" has_next next_cursor first_line
  local -a NUMS=()
  local items=0

  # shellcheck disable=SC2016  # $cursor / $project は GraphQL の変数
  local Q='query($project:ID!,$cursor:String){ node(id:$project){ ... on ProjectV2 {
    items(first:100, after:$cursor){ pageInfo{ hasNextPage endCursor }
      nodes{ content{ ... on Issue { number state updatedAt } }
        fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }'

  # **空のフィールドを `-` で埋める**（`// "-"`）。**これは飾りではない。**
  #
  # **`read` は tab を IFS の空白として扱うので、連続した tab を 1 個に畳む**（実測）:
  #   $ printf 'a\t\tb\n' | while IFS=$'\t' read -r x y z; do echo "[$x][$y][$z]"; done
  #     → **[a][b][]**   ← `y` に `b` が入り、**以降のフィールドが 1 つずつ前にずれる**
  # **つまり `updatedAt` が null の項目では、Status が `updated` に入って読まれる。**
  # **その項目は Status の照合に落ちるので、`In Progress` から黙って消える**
  # ——**「測っていないのに In Progress 0 件」**という、この道具が存在する理由そのものの形になる。
  # **実測でこの穴に落ちた**（`t_mon_board_bad_timestamp` が最初に落ちたのはこれである）。
  # **`-` は ISO 8601 でも Status の名前でもない**ので、どちらの列でも「値が無い」を意味できる。
  local num state updated status
  while :; do
    # **ページングを打ち切らない**（打ち切ると「載っていない」の誤検出になる。board-audit.sh と同じ）
    if ! page=$(gh api graphql -f query="$Q" -F project="$PROJECT_ID" -F cursor="$cursor" \
        --jq '[(.data.node.items.pageInfo.hasNextPage|tostring), (.data.node.items.pageInfo.endCursor // "-")],
              (.data.node.items.nodes[] | select(.content.number != null)
                | ["item", (.content.number|tostring), (.content.state // "-"), (.content.updatedAt // "-"),
                   (.fieldValueByName.name // "-")])
              | @tsv' 2>/dev/null); then
      unmeasured "board: スクラムボードが読めませんでした（GraphQL が返りませんでした）"
      return
    fi
    first_line=1; has_next="false"; next_cursor=""
    while IFS=$'\t' read -r a b c d e; do
      if [[ "$first_line" == 1 ]]; then has_next="$a"; next_cursor="$b"; first_line=0; continue; fi
      [[ "$a" == "item" ]] || continue
      items=$((items+1))
      num="$b"; state="$c"; updated="$d"; status="$e"
      [[ "$state" == "OPEN" && "$status" == "In Progress" ]] || continue
      NUMS+=("$num"$'\t'"$updated")
    done <<< "$page"
    [[ "$has_next" == "true" && -n "$next_cursor" ]] || break
    [[ "$next_cursor" == "-" ]] && break
    cursor="$next_cursor"
  done

  local inprogress=0 stale=0 unknown=0 ts age
  for row in "${NUMS[@]+"${NUMS[@]}"}"; do
    inprogress=$((inprogress+1))
    num="${row%%$'\t'*}"; updated="${row#*$'\t'}"
    # **時刻が取れなければ鳴らさず、数えて出す**（#757。取れないことを鳴らすと全件鳴る）。
    # **`-` は上の jq が埋めた「値が無い」の印**（tab の畳み込み対策。上の docblock）。
    if [[ -z "$updated" || "$updated" == "-" ]] || ! ts=$(date -u -d "$updated" +%s 2>/dev/null) || ! is_int "$ts"; then
      unknown=$((unknown+1)); continue
    fi
    age=$(( (NOW - ts) / 60 ))
    # **未来の時刻は 0 に丸める**（負の「N 分前」を出さない。worktree-audit.sh と同じ扱い）
    [[ "$age" -lt 0 ]] && age=0
    if [[ "$age" -ge "$STALE_MINUTES" ]]; then
      stale=$((stale+1)); FINDINGS=$((FINDINGS+1))
      log "停滞 #$num: In Progress のまま $age 分動いていません（閾値 $STALE_MINUTES 分）"
    fi
  done

  log "ボードの項目 $items 件を見ました: In Progress $inprogress 件（停滞 $stale 件 / 時刻が取れなかったもの $unknown 件）"
  if [[ "$items" == 0 ]]; then
    # **0 件は「ボードが空」ではなく「読めていない」ことのほうが多い**（#757）。
    unmeasured "board: 項目が 0 件でした。**ボードが空なのか読めていないのか区別できません**"
  elif [[ "$unknown" != 0 ]]; then
    unmeasured "board: In Progress $inprogress 件のうち $unknown 件の更新時刻が取れていません（**停滞 $stale 件は下限です**）"
  else
    SECTIONS_OK=$((SECTIONS_OK+1))
  fi
}

# ---- 3. worktree（停滞と幽霊）-----------------------------------------------------------------
#
# **幽霊と残留の判定は `worktree-audit.sh` に委ねる**（#1110 の「同じ判定を 2 か所に書かない」）。
# **あちらは「読めない worktree」を数えて出す**ので、**幽霊はその数で分かる。**
# **あちらを書き換えない**——**この monitor はあちらの出力を読む側である。**
#
# **この節が足すのは「停滞」の軸だけである**（`worktree-audit.sh` が持っているのは
# 「作業中かもしれない」＝ 6 時間の印で、**意味が逆**: あちらは「触るな」を多めに付ける道具、
# こちらは「止まっている」を挙げる道具）。
#
# **パスも枝名も出さない**（OSS。上の docblock）。**本数だけ出す。**
worktree_section() {
  if [[ "${MONITOR_SKIP_LOCAL:-}" == 1 ]]; then
    # **飛ばしたことを必ず言う**（#1094。**黙って飛ばすと「正常」に見える**）。
    # **これは「測れなかった」ではなく「測らないと決めた」**なので `MONITOR-BROKEN` にしない
    # ——ただし**母数からも外す**ので、末尾の N/M が 2/2 になって区別がつく。
    log "worktree: MONITOR_SKIP_LOCAL=1 のため飛ばしました（**この環境では PO の手元の worktree は見えません**）"
    SECTIONS_TOTAL=$((SECTIONS_TOTAL-1))
    return
  fi

  local total=0 ghosts=0 stale=0 unknown=0
  local -a PATHS=()
  local wt="" line
  if ! out=$(git worktree list --porcelain 2>/dev/null); then
    unmeasured "worktree: git worktree list が失敗しました（作業ツリーの中で走っていますか）"
    return
  fi
  while IFS= read -r line; do
    case "$line" in
      "worktree "*) wt="${line#worktree }"; PATHS+=("$wt") ;;
    esac
  done <<< "$out"
  total=${#PATHS[@]}

  local p last age idx_path idx_mtime
  for p in "${PATHS[@]+"${PATHS[@]}"}"; do
    if [[ ! -d "$p" ]]; then
      # **幽霊**: 登録は在るがディレクトリが無い（#1099 の変異 2 が出したもの）。
      ghosts=$((ghosts+1)); FINDINGS=$((FINDINGS+1)); continue
    fi
    # **最終更新は「HEAD のコミット時刻」と「index の mtime」の遅いほう**
    # （`worktree-audit.sh` と同じ理由: commit せずに編集し続けているツリーは HEAD が古い）。
    last=$(git -C "$p" log -1 --format=%ct 2>/dev/null || echo 0)
    is_int "$last" || last=0
    # **`rev-parse --git-path index` はメインの作業ツリーで相対パスを返す**（#1070 で実測）。
    # **相対は `$p` 基準であって cwd 基準ではない。** **cwd 基準で解くと、
    # 監視を走らせた場所で答えが変わる**（無関係な repo の index を読んだ実測が在る）。
    idx_path=$(git -C "$p" rev-parse --git-path index 2>/dev/null || true)
    [[ -n "$idx_path" && "$idx_path" != /* ]] && idx_path="$p/$idx_path"
    if [[ -n "$idx_path" && -f "$idx_path" ]]; then
      idx_mtime=$(stat -c %Y "$idx_path" 2>/dev/null || echo 0)
      is_int "$idx_mtime" && [[ "$idx_mtime" -gt "$last" ]] && last=$idx_mtime
    fi
    if [[ "$last" == 0 ]]; then
      unknown=$((unknown+1)); continue
    fi
    age=$(( (NOW - last) / 60 ))
    [[ "$age" -lt 0 ]] && age=0
    if [[ "$age" -ge "$STALE_MINUTES" ]]; then
      stale=$((stale+1)); FINDINGS=$((FINDINGS+1))
      # **パスも枝名も出さない**（OSS）。**どれかを知りたければ人が worktree-audit.sh を走らせる。**
      log "停滞 worktree: $age 分書き込みがありません（閾値 $STALE_MINUTES 分）"
    fi
  done

  log "worktree $total 本を見ました: 停滞 $stale 本 / 幽霊 $ghosts 本 / 最終更新が取れなかったもの $unknown 本"
  [[ "$ghosts" != 0 ]] && log "幽霊が $ghosts 本あります（登録は在るがディレクトリが無い）。**未 push の成果物が在りうる**ので、消す前に 'git worktree list' を人が見てください（#1087）"
  # **残留の分類は `worktree-audit.sh` の仕事**なので、**呼んで、その終了コードを伝える。**
  # **同じ判定をここに書き直さない**（#1110）。**あれは読むだけの道具である。**
  if [[ -x "$HERE/worktree-audit.sh" ]]; then
    local wa_status=0
    "$HERE/worktree-audit.sh" >/dev/null 2>&1 || wa_status=$?
    if [[ "$wa_status" == 3 ]]; then
      FINDINGS=$((FINDINGS+1))
      log "worktree-audit.sh が exit 3 を返しました: **staged に削除が在るツリーが在ります。commit すると他人の成果物が消えます**。'scripts/po/worktree-audit.sh' を人が読んでください"
    elif [[ "$wa_status" != 0 ]]; then
      unmeasured "worktree: worktree-audit.sh が exit $wa_status を返しました（残留の分類は測れていません）"
      return
    fi
  else
    unmeasured "worktree: worktree-audit.sh が見つかりません（残留の分類は測れていません）"
    return
  fi
  if [[ "$unknown" != 0 ]]; then
    unmeasured "worktree: $total 本のうち $unknown 本の最終更新が取れていません（**停滞 $stale 本は下限です**）"
  else
    SECTIONS_OK=$((SECTIONS_OK+1))
  fi
}

pr_section
board_section
worktree_section

# ---- 締め -------------------------------------------------------------------------------------
#
# **この行が無ければ、この道具は途中で死んでいる**（#1094 / #1110 の
# 「『何も言わない』と『正常』を区別できること」）。
# **`set -e` で落ちたらこの行は出ない**ので、**入口（cron / Actions）はこの行の有無を見れば
# 『監視自身が死んだ』を検出できる。** **「出力が空」＝「異常なし」と読んではいけない。**
log "scrum-monitor: 終了（節 $SECTIONS_OK/$SECTIONS_TOTAL を測れました・行動が要る事実 $FINDINGS 件）"

if [[ ${#UNMEASURED[@]} -gt 0 ]]; then
  log "MONITOR-BROKEN: 測れなかった節が ${#UNMEASURED[@]} 件あります。**この出力を『異常なし』として読まないでください**"
  printf '  - %s\n' "${UNMEASURED[@]}" >&2
  exit 4
fi
[[ "$FINDINGS" != 0 ]] && exit 3
exit 0
