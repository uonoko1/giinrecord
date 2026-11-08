#!/usr/bin/env bash
# Issue #1286 — **日次 ETL が N 晩連続で失敗していることを見る。**
#   etl-streak.sh            （引数なし。`gh run list --workflow etl.yml` を 1 回叩く）
# 出力は probe.sh / deploy-started.sh と同じ 1 行形式（`ok etl` / `fail etl <reason>`）で、fail なら exit 1。
# **形を揃えているのは、report.sh / run.sh の仕組みをそのまま使うため**（#1110 の軸:
# **新しい監視の入口を増やさない**。入口が増えると入口自身の死を誰も見なくなる）。
#
# **なぜ要るか（#1286。計器が症状だけで、機構に 1 つも無かった）**:
#   `probe.sh` の `data` が見ているのは **`meta.fetchedAt` の古さ**（`PROBE_MAX_AGE_HOURS` = 48）だけである。
#   **実測（2026-10-11T11:18Z）**: ETL は **7 晩連続で失敗**していたのに、
#   `main` も `production` も `fetchedAt = 2026-10-10T00:22:40Z`（約 35 時間）で、
#   **35 < 48 なので監視は正しく黙っていた。嘘はついていない。**
#   **さらに悪いのは、人が手で PR を運ぶほど `fetchedAt` が若返り、48 時間の窓がリセットされること。**
#   **症状は消え、機構は残る。** だから **`fetchedAt` とは独立に、run の結末そのものを数える。**
#
# **N = PROBE_ETL_FAIL_STREAK（既定 3）の根拠（実測・母数つき）**:
#   `gh run list --workflow etl.yml --limit 300` で取れた **103 run**
#   （2026-08-22T10:31:31Z 〜 2026-10-10T23:56:02Z）のうち、**`event = schedule` の 50 run**
#   （2026-08-22T21:10:23Z 〜 2026-10-10T23:56:02Z）で連続失敗の長さを数えた:
#     長さ 1 … 2 回 / 長さ 2 … 1 回 / 長さ 3 … 1 回 / 長さ 7 … 1 回（＝いま続いている分）
#   しきい値ごとに「鳴る回数」は **50 晩で**:
#     N=1 → 5 回   N=2 → 3 回   **N=3 → 2 回**   N=4..7 → 1 回
#   **N=3 を採った理由は 2 つで、どちらも「鳴っても読まれる」側に効く**:
#     1. **N=1 / N=2 では単発のこけが鳴る。** 上の 50 晩で長さ 1 の streak が 2 回、長さ 2 が 1 回在り、
#        **どれも次の晩に自力で success に戻っている**（下の「ended by」を見た）。
#        **自力で直るものを鳴らすと、読まれなくなる**（#1185 の型）。
#     2. **N=4 以上にすると、3 晩の本物の故障を取り逃がす。** 長さ 3 の streak
#        （2026-09-24 / 09-25 / 09-26、いずれも step `Run ETL` の失敗）は**本物の取得失敗**で、
#        **09-27 の success まで 3 晩データが出ていなかった。** N=4 ならこれは鳴らない。
#   **つまり N=3 は「自力で直った最長（2）」より上で、「本物の故障の最短（3）」以下の、ただ 1 つの整数である。**
#   この関係式は `deploy/test/monitor-probe.test.sh` が実測の表から導出して検査している
#   （**数字を 2 か所に書かない**: N の既定値はこのファイルの下の 1 行だけが持ち、
#   テストはそれを**このファイルから読んで**突き合わせる。#1264 の型を繰り返さない）。
#
# **`event = schedule` だけを数える理由**:
#   `workflow_dispatch`（実測 30 run）と `push`（23 run）が混ざっていると、
#   **「N 晩連続」ではなく「N 回連続」になる。** 手で 3 回試して 3 回失敗したら鳴るのは、
#   「毎晩のデータが出ていない」とは別の事実である。**cron の宣言時刻は実行時刻ではない**ので
#   （実測で 145〜275 分の遅れ）、**時刻では判定せず `event` で選ぶ。**
#
# **`cancelled` は失敗に数えない。** 実測で 8 run 在り、**concurrency や手での中止で起きる**。
#   「ETL が結果を出せなかった」ではあるが「失敗した」ではないので、**streak を切る**
#   （数えれば N=3 で鳴る回数が 2 → 3 に増える。上の表の `failure+cancelled` 側で確かめた）。
#
# **失敗した step を名指しする（#1286 受け入れ条件 3）。**
#   **原因が 2 つに分かれるので、名指しできなければ見た人は毎回両方を調べ直すことになる**
#   （この repo の教訓「赤は『待ち合わせの時間切れ』かもしれない」）。**実測で実際に分かれた**:
#     6 晩（10-04〜10-10）… step `Wait for data PR merge, then deploy` → **ETL 自体は成功**。
#                            正体は**待ち合わせの時間切れ**（PR が赤くて merge されなかった）
#     1 晩（10-10 夜）  … step `Run ETL` → **本物の取得失敗**（`SocketError: other side closed`）
#     3 晩（09-24〜26） … step `Run ETL` → 本物の取得失敗
#   **step 番号ではなく step 名を出す。** 番号は workflow を編集すると動く（実測: 同じ
#   `Run ETL` が run によって 8 番。間に step が 1 本入れば 9 番になる）が、**名前は動かない。**
#
# **数えられなかったら `ok` にしない**（#1056）。gh が落ちた・権限が無い・レートに当たった、
# のいずれでも **「異常なし」と言ってはいけない。** 理由に `測れなかった` と書いて exit 1 で落とす。
#
# 出力にサーバー情報・ローカルパス・アカウント名・URL を書かない（OSS。Issue 本文に載る）。
# 出すのは run の番号・時刻・結末・step 名だけ。
#   Tests: deploy/test/monitor-probe.test.sh (gh は stub)
set -euo pipefail

# **N の既定値を持つのはこの 1 行だけ。** docs も test も workflow も、この値を複製しない
# （#1264: 2 つの数が同じ制約を分担すると矛盾する。この repo で 2 度踏んでいる）。
STREAK_N=${PROBE_ETL_FAIL_STREAK:-3}
WORKFLOW=${ETL_WORKFLOW:-etl.yml}
# 何 run 分さかのぼるか。**N より十分大きいこと**（下で検査する）。
LIMIT=${PROBE_ETL_RUN_LIMIT:-30}

if ! [ "$STREAK_N" -ge 1 ] 2>/dev/null; then
  echo "fail etl 測れなかった (PROBE_ETL_FAIL_STREAK が 1 以上の整数でない)"
  exit 1
fi
# **窓が N より狭ければ、N 晩連続は原理的に観測できない。** 黙って ok に倒すと
# **「鳴らない監視」が設定の間違いで作れてしまう**ので、測れていないと書いて落とす。
if ! [ "$LIMIT" -ge "$STREAK_N" ] 2>/dev/null; then
  echo "fail etl 測れなかった (run の取得数 ${LIMIT} が N=${STREAK_N} より少ない)"
  exit 1
fi

# **run の一覧を取る。取れなければ「測れなかった」。**
if ! runs=$(gh run list --workflow "$WORKFLOW" --limit "$LIMIT" \
    --json databaseId,createdAt,conclusion,status,event 2>/dev/null); then
  echo "fail etl 測れなかった (${WORKFLOW} の run 一覧を取得できない)"
  exit 1
fi
# **空文字は `[]` と別。** 本物の gh はレートに当たった・応答が途切れたなどで
# **stdout が空のまま exit 0 になり得る**（#1198 R10b）。**そこを「0 件」と同じ扱いにしない。**
if [ -z "$runs" ]; then
  echo "fail etl 測れなかった (${WORKFLOW} の run 一覧が空の応答)"
  exit 1
fi

# **新しい順に並べ直してから数える**（gh の順序に依存しない）。`status != completed` の run は
# **まだ結末が無いので飛ばす**（走っている最中の run を失敗に数えない。数えると毎晩 1 回鳴る）。
#
# **`status == "completed"` の条件は、測った限り等価変異である**（正直に書く。#1286 の変異テスト）:
#   この条件を外す変異を当てて **123/123 全緑のまま生き残った。** 理由を実測で確かめた——
#   **走っている run は `conclusion` が `failure` にならない**ので、下の `== "failure"` が先に弾く。
#   実測（2026-10-11T12:0xZ、`gh run list --limit 200 --json status,conclusion` を
#   `group_by(.status)` で畳んだ。**母数 200 run**）:
#     status=completed   → conclusion は cancelled / failure / success
#     status=in_progress → conclusion は **"" だけ**（REST API では `null`。
#                          `gh api .../actions/runs?status=in_progress` を同時刻に叩いて確かめた）
#   **つまり `failure` は `completed` のときしか出ない。** だからこの条件は**多重の守り**であって、
#   **いま観測できる挙動を変えていない。** **残す理由**: `conclusion` の綴りは GitHub 側の都合で
#   増えうるし（`startup_failure` など）、**「結末が出ている run だけを数える」という意図が
#   コードから読めることに価値が在る。** **「変異が死なないから消す」はしない**——
#   消すと、`conclusion` の集合が変わった日に静かに壊れる。
if ! verdict=$(printf '%s' "$runs" | python3 -c '
import json,sys
try:
    rs = json.load(sys.stdin)
except Exception:
    sys.exit(3)
if not isinstance(rs, list):
    sys.exit(3)
n = int(sys.argv[1])
# **毎晩の run だけを見る**: workflow_dispatch / push が混ざると「N 晩連続」ではなく「N 回連続」になる。
rs = [r for r in rs if r.get("event") == "schedule" and r.get("status") == "completed"]
rs = [r for r in rs if r.get("createdAt")]
rs.sort(key=lambda r: r["createdAt"], reverse=True)
if not rs:
    # **「毎晩の run が 1 本も無い」は 0 件であって、測れなかったのとは別。**
    # それ自体おかしいので ok にはしない（cron が止まっている形がここに来る）。
    print("NONE"); sys.exit(0)
streak = []
for r in rs:
    if r.get("conclusion") == "failure":
        streak.append(r)
    else:
        break
# 母数（schedule かつ completed で、実際に見た本数）も返す: 「0 件」と「数えていない」を区別するため。
print("STREAK %d %d" % (len(streak), len(rs)))
for r in streak[:n]:
    print("%s %s" % (r.get("databaseId"), r["createdAt"]))
' "$STREAK_N"); then
  echo "fail etl 測れなかった (${WORKFLOW} の run 一覧を解釈できない)"
  exit 1
fi

if [ "$verdict" = NONE ]; then
  echo "fail etl 測れなかった (${WORKFLOW} に毎晩の run が 1 本も無い、直近${LIMIT}run を確認)"
  exit 1
fi

# **パイプの末尾に `head` を置かない**（#527。`pipefail` のもとで書き手が SIGPIPE で死に、
# **一致が入力の先頭寄りだと確率的に偽になる**）。`deploy/test/pipefail-sigpipe.test.sh` が
# **実測でここを捕まえた**——最初はパイプで書いていて、検出器が 25/0 → 24/1 にして落ちた。
head_line=$(head -1 <<<"$verdict")
read -r _tag streak total <<<"$head_line"
if [ "$_tag" != STREAK ] || ! [ "$streak" -ge 0 ] 2>/dev/null; then
  echo "fail etl 測れなかった (${WORKFLOW} の run 一覧を解釈できない)"
  exit 1
fi

if [ "$streak" -lt "$STREAK_N" ]; then
  echo "ok etl (連続失敗 ${streak}、しきい値 ${STREAK_N}、毎晩の run ${total}本を確認)"
  exit 0
fi

# ---- N 晩以上連続で失敗している。**どの step で落ちたかを名指しする。** ----
# **受け入れ条件 3**: step 12（待ち合わせの時間切れ）と step 8（本物の取得失敗）は**対処が別**。
# **名指しできなければ、見た人は毎回両方を調べ直すことになる。**
# **step 名が取れなくても鳴ることは変えない**（名指しは理由を厚くするだけで、判定の条件ではない
# ——ここを「名前が取れたときだけ鳴る」にすると、gh の 1 本の失敗で監視が黙る）。
steps=''
while IFS= read -r line; do
  [ -n "$line" ] || continue
  rid=${line%% *}
  # **1 run ずつ叩く。** N は小さい（既定 3）ので要求は N 回に収まる。
  if detail=$(gh run view "$rid" --json jobs 2>/dev/null) && [ -n "$detail" ]; then
    names=$(printf '%s' "$detail" | python3 -c '
import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
out = []
for j in d.get("jobs") or []:
    for s in j.get("steps") or []:
        if s.get("conclusion") == "failure":
            nm = (s.get("name") or "").strip()
            if nm and nm not in out:
                out.append(nm)
print("/".join(out))
' 2>/dev/null) || names=''
  else
    names=''
  fi
  # **取れなかったことを黙って落とさない**（#1056。「step が無い」と「読めなかった」は別）。
  [ -n "$names" ] || names='step を読めなかった'
  steps="${steps}${steps:+, }${names}"
done < <(printf '%s\n' "$verdict" | tail -n +2)

echo "fail etl 日次 ETL が ${streak}晩連続で失敗 (しきい値 ${STREAK_N}晩、毎晩の run ${total}本を確認); 直近${STREAK_N}晩の失敗した step: ${steps:-step を読めなかった}"
exit 1
