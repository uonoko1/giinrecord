#!/usr/bin/env bash
# Issue #1185 — **「data/ が main に入ったのに deploy が始まらなかった」を見る。**
#   deploy-started.sh <iso8601 of the newest data/ commit on main>
#   deploy-started.sh ""        data/ のコミットが無い（= 鳴らす理由が無い）
# 出力は probe.sh と同じ 1 行形式（`ok deploy` / `fail deploy <reason>`）で、fail なら exit 1。
# **形を揃えているのは、report.sh / run.sh の仕組みをそのまま使うため**（#1110 の軸:
# **新しい監視の入口を増やさない**。入口が増えると入口自身の死を誰も見なくなる）。
#
# **なぜ要るか**（#1185 の根本原因。`deploy-data.yml` 自身が冒頭に書いている形）:
#   GITHUB_TOKEN のマージは push event を起こさないので、`on: push` では走らない。
#   → だから etl.yml / districts.yml / local-assemblies.yml が直後に dispatch する。
#   → **その ETL が落ちると dispatch も起きず push も起きない。両方効かない窓が在る。**
#   cron (`30 21 * * *`) が safety net だが、**それは「24 時間以内」の網であって、
#   「入ったデータが出た」ことは誰も見ていなかった。**
#
# **N = PROBE_DEPLOY_LAG_MINUTES（既定 30 分）の根拠（実測・母数つき）**:
#   `gh run list --workflow deploy-data.yml --limit 300` の **98 run**
#   （2026-08-23T15:30:43Z 〜 2026-10-04T01:40:23Z）と、同じ窓の origin/main で
#   `data/` を触った **79 コミット**を突き合わせ、各コミットから**次に始まった run** までの分を数えた
#   （**79 本すべてに後続 run が在った**ので「後続が無い」で除外した本数は 0）:
#     bot の `data:` コミット   母数 **52 本**  → **49 本が 0.03〜0.42 分**、残り 3 本が 251.9 / 335.8 / 650.6 分
#     人のマージ（`data:` 以外） 母数 **27 本**  → p50 339.3 / p90 1127.5 / max 1367.3 分
#   **bot 側は 0.42 分と 251.9 分のあいだが空っぽ**で、1 / 2 / 5 / 10 / 15 / 30 / 60 / 120 分の
#   どの境を取っても **49/52 のまま**だった。**30 分はその空白の中に在るので、
#   そこに置けばどこに置いても同じ 49/52 を分ける**（＝閾値の選び方に敏感でない）。
#   **人のマージは対象にしない**: dispatch する設計がそもそも無く、cron 待ちが正常である。
#   **27 本中 24 本が 30 分超**なので、含めれば常時鳴って読まれなくなる（#1185 の型）。
#
# **数えられなかったら `ok` にしない**（#1056）。gh が落ちた・権限が無い・レートに当たった、
# のいずれでも **「異常なし」と言ってはいけない。** 理由に `測れなかった` と書いて exit 1 で落とす。
#
# 出力にサーバー情報・ローカルパス・アカウント名を書かない（OSS。Issue 本文に載る）。
#   Tests: deploy/test/monitor-probe.test.sh (gh は stub)
set -euo pipefail

LAG_MINUTES=${PROBE_DEPLOY_LAG_MINUTES:-30}
WORKFLOW=${DEPLOY_WORKFLOW:-deploy-data.yml}
COMMIT_AT=${1-}

if [ $# -lt 1 ]; then echo "usage: deploy-started.sh <iso8601-of-newest-data-commit|''>" >&2; exit 2; fi

# **空文字 = data/ のコミットが無い**。これは「測れなかった」ではない: 見るべき事実が無い。
if [ -z "$COMMIT_AT" ]; then
  echo "ok deploy (main に data/ のコミットが無い)"
  exit 0
fi

# **壊れた時刻は「無い」と区別する。** ここを混ぜると、時刻の取得が壊れた日に黙って ok になる。
if ! commit_ep=$(date -u -d "$COMMIT_AT" +%s 2>/dev/null) || [ -z "$commit_ep" ]; then
  echo "fail deploy 測れなかった (data/ コミットの時刻を解釈できない)"
  exit 1
fi

now=$(date +%s)
age_min=$(( (now - commit_ep) / 60 ))

# **まだ窓の中なら鳴らさない。** 常態は 0.42 分以内なので、窓の手前で鳴らせば常時赤になる。
if [ "$age_min" -lt "$LAG_MINUTES" ]; then
  echo "ok deploy (${age_min}分前のコミット、窓は${LAG_MINUTES}分)"
  exit 0
fi

# **run の一覧を取る。取れなければ「測れなかった」。**
if ! runs=$(gh run list --workflow "$WORKFLOW" --limit 20 --json createdAt 2>/dev/null); then
  echo "fail deploy 測れなかった (${WORKFLOW} の run 一覧を取得できない)"
  exit 1
fi
if [ -z "$runs" ]; then
  echo "fail deploy 測れなかった (${WORKFLOW} の run 一覧が空の応答)"
  exit 1
fi

# **コミット以降に始まった run を数える。**
# **「コミットより前の run」を後続と数えないことが要点**——#1185 では deploy が
# **毎日 success していた**ので、向きを見なければ「success が在るから ok」になってしまう。
if ! started=$(printf '%s' "$runs" | python3 -c '
import json,sys,datetime
try:
    rs=json.load(sys.stdin)
except Exception:
    sys.exit(3)
cut=datetime.datetime.fromtimestamp(int(sys.argv[1]),datetime.timezone.utc)
n=0
for r in rs:
    t=r.get("createdAt")
    if not t: continue
    try:
        d=datetime.datetime.fromisoformat(t.replace("Z","+00:00"))
    except ValueError:
        continue
    if d>=cut: n+=1
print(n)
' "$commit_ep"); then
  echo "fail deploy 測れなかった (${WORKFLOW} の run 一覧を解釈できない)"
  exit 1
fi

if [ "$started" -gt 0 ]; then
  echo "ok deploy (コミットの後に ${WORKFLOW} の run が ${started} 本)"
  exit 0
fi

echo "fail deploy main の data/ が ${age_min}分前に入ったのに ${WORKFLOW} の run が 0 本 (窓 ${LAG_MINUTES}分、直近20runを確認)"
exit 1
