#!/usr/bin/env bash
# One monitoring round for one environment (Issue #135), called by .github/workflows/monitor.yml:
#   run.sh <environment> <origin>        e.g. run.sh production https://giinrecord.jp
# probe.sh once; if anything failed, wait MONITOR_RETRY_SLEEP (60) seconds and probe again. A check counts as failed
# only when it failed in BOTH rounds ("2 consecutive failures" within a single run — the schedule fires every
# 10 minutes, so the previous run's outcome is not needed and a blip never opens an Issue). Then every check is
# reported through report.sh: failed → Issue "[monitor] <environment>: <check>" (deduplicated), passed → close it if
# one is open. Exit 1 when something was reported as failed (the workflow run shows red too).
# Issue bodies: environment, check, the probe's reason, and the link to this run. Nothing about the server.
# Issue #1185: production だけ **`deploy` という 4 つめの check** を足す。
#   **何を見るか**: 「main に `data/` が入ったのに `deploy-data.yml` の run が始まっていない」
#   **なぜ要るか**: `deploy-data.yml` は GITHUB_TOKEN のマージで push event が出ないため
#     ETL からの dispatch に頼っていて、**ETL が落ちると dispatch も push も起きない窓**が在る。
#   **既存の形に寄せる**（#1110 の軸: **新しい監視の入口を増やさない**）:
#     `deploy-started.sh` は probe.sh と同じ `ok <check>` / `fail <check> <reason>` を 1 行出すだけで、
#     **2 回連続の判定・Issue の開閉・エスカレーションは、すでに在るこの run.sh と report.sh がそのまま扱う。**
#     **入口が増えると入口自身の死を誰も見なくなる**——それが #1185 の原因そのものである。
#   **main の `data/` の最新コミット時刻は MONITOR_DATA_COMMIT_AT で渡す**（workflow が git から採る）。
#   **渡されなければ `deploy` check は走らせない**（手元の run.sh の振る舞いを変えない）。
#
# Issue #163: with MONITOR_REQUIRE_CF_ACCESS=1 (staging, behind Cloudflare Access) the run is skipped with a
# ::warning:: and exit 0 when CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET are not set — probing without the
# service token would only see Cloudflare's login page and open a false "http" Issue. Nothing is reported either
# way in that case (an open Issue is neither created nor closed blindly).
#   Tests: deploy/test/monitor-probe.test.sh (curl/openssl/gh/sleep are stubs)
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ENV_NAME=${1:-}; ORIGIN=${2:-}
if [ -z "$ENV_NAME" ] || [ -z "$ORIGIN" ]; then echo "usage: run.sh <environment> <origin>" >&2; exit 2; fi
RETRY_SLEEP=${MONITOR_RETRY_SLEEP:-60}
CHECKS=(http data tls)
# #1185: production だけ `deploy` を足す。**時刻が渡っていなければ足さない**
# （staging にも、手元で叩いたときにも足さない——測れないものを check にしない）。
DATA_COMMIT_AT=${MONITOR_DATA_COMMIT_AT:-}
if [ -n "$DATA_COMMIT_AT" ]; then CHECKS+=(deploy); fi

if [ "${MONITOR_REQUIRE_CF_ACCESS:-0}" = 1 ] && { [ -z "${CF_ACCESS_CLIENT_ID:-}" ] || [ -z "${CF_ACCESS_CLIENT_SECRET:-}" ]; }; then
  echo "::warning::$ENV_NAME is behind Cloudflare Access but CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET are not set; probe skipped (docs/ops/staging-access.md)"
  exit 0
fi

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# Both rounds must probe the SAME pages, or "failed twice in a row" is not about the same thing twice. probe.sh
# picks its rotating sample of assembly pages (#248) from the 10-minute slot, and the retry is only 60 s later —
# which would cross into the next slot ~10% of the time. Pinning PROBE_NOW here keeps round 2 on round 1's sample.
export PROBE_NOW=${PROBE_NOW:-$(date +%s)}

# one round = probe.sh's lines, plus deploy-started.sh's line when the commit time was handed in (#1185).
# **`|| true` でまとめて飲まないこと**: それぞれの終了コードは「何かが fail した」の重複情報で、
# 判定は下の `grep '^fail <check> '` が行の内容で行う。**行が 1 本も出なかった形は
# `CHECKS` のループで `r1`/`r2` のどちらも空になり、fail として扱われない**ので、
# **出力が空という形を別に検出する**（下の missing_lines）。
one_round() {
  local out=$1
  bash "$HERE/probe.sh" "$ORIGIN" > "$out" || true
  if [ -n "$DATA_COMMIT_AT" ]; then
    bash "$HERE/deploy-started.sh" "$DATA_COMMIT_AT" >> "$out" || true
  fi
}

one_round "$TMP/r1"
echo "round 1:"; sed 's/^/  /' "$TMP/r1"
if grep -q '^fail ' "$TMP/r1"; then
  sleep "$RETRY_SLEEP"
  one_round "$TMP/r2"
  echo "round 2:"; sed 's/^/  /' "$TMP/r2"
else
  cp "$TMP/r1" "$TMP/r2"
fi

run_url=""
if [ -n "${GITHUB_SERVER_URL:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ] && [ -n "${GITHUB_RUN_ID:-}" ]; then
  run_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
fi

EXIT=0
for check in "${CHECKS[@]}"; do
  title="[monitor] $ENV_NAME: $check"
  r1=$(grep "^fail $check " "$TMP/r1" || true)
  r2=$(grep "^fail $check " "$TMP/r2" || true)
  # **どちらのラウンドでも 1 行も出なかった check は「測れていない」。**
  # **ここを `ok` に倒すと、probe.sh が途中で死んだ日に黙って緑になる**（#1185 の型）。
  if ! grep -q "^\(ok\|fail\) $check\b" "$TMP/r1" && ! grep -q "^\(ok\|fail\) $check\b" "$TMP/r2"; then
    EXIT=1
    cat > "$TMP/body.$check" <<BODY
External check **${check}** of **${ENV_NAME}** (${ORIGIN}) **produced no verdict at all** in either round.

- reason: \`judgement line missing (the check did not report ok or fail)\`
- first seen: $(date -u +%Y-%m-%dT%H:%M:%SZ)
${run_url:+- run: $run_url}

**これは「異常なし」ではありません。** 判定に届く前に死んだ形です（#1185）。
What the check means and what to do: \`docs/ops/monitoring.md\`.
BODY
    bash "$HERE/report.sh" "$title" fail "$TMP/body.$check"
    continue
  fi
  if [ -n "$r1" ] && [ -n "$r2" ]; then
    EXIT=1
    reason=${r2#fail "$check" }
    cat > "$TMP/body.$check" <<BODY
External check **${check}** of **${ENV_NAME}** (${ORIGIN}) failed twice in a row, ${RETRY_SLEEP}s apart.

- reason: \`${reason}\`
- first seen: $(date -u +%Y-%m-%dT%H:%M:%SZ)
${run_url:+- run: $run_url}

What the check means and what to do: \`docs/ops/monitoring.md\`. This Issue is closed automatically once the check passes again.
BODY
    bash "$HERE/report.sh" "$title" fail "$TMP/body.$check"
  else
    bash "$HERE/report.sh" "$title" ok
  fi
done
exit $EXIT
