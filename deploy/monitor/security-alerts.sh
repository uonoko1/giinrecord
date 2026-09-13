#!/usr/bin/env bash
# Read GitHub's own security alerts for this repository (Issue #786; run by security-alerts.yml).
#   security-alerts.sh <owner/repo>
#     exit 0  every feed was READ and every one of them is empty
#     exit 1  at least one feed was read and has open alerts — the kinds and counts go to stdout
#     exit 2  at least one feed could NOT BE READ (no permission / disabled / API down). Reason to stderr.
#             Distinct from 0 on purpose: "we could not look" must never render as "0 alerts" (#757, #540).
#
# Why this exists: secret scanning alert #1 was opened 2026-08-23T16:51:24Z and NOBODY LOOKED FOR 21 DAYS.
# It was a real leak (#785). CI was green the whole time, and gitleaks does not detect that shape (measured:
# `no leaks found`). The only detector that found it was one whose output we never read.
# **A detector nobody reads is the same as no detector at all.**
#
# #785 removes that one leak. THIS removes the 21 days. The next alert — a new Dependabot advisory, another
# shape of secret — would otherwise go unseen just as long.
#
# ---------------------------------------------------------------------------------------------
# WHAT MAY LEAVE THIS SCRIPT ON STDOUT, AND WHY THE LIST IS SO SHORT
# ---------------------------------------------------------------------------------------------
# stdout is copied VERBATIM into a PUBLIC GitHub Issue by security-alerts-report.sh. The alert payloads
# themselves are the most sensitive JSON this repository ever touches. Measured against the live API
# (2026-09-13), one secret-scanning alert carries:
#     .secret                      THE LEAKED CREDENTIAL ITSELF, in cleartext
#     .first_location_detected     path, start_line, end_line, blob_sha, commit_sha, a permalink to the blob
# So `gh api … | jq .` into an Issue body would PUBLISH the very credential the alert is warning about,
# and hand every reader a direct link to the blob — turning the alarm into the exploit.
#
# Therefore this script NEVER echoes the response. It builds its output field by field with an ALLOWLIST:
#   secret scanning   .secret_type_display_name  (the KIND, e.g. "Google API Key") and .number
#   dependabot        .security_advisory.severity (the SEVERITY) and .number
# plus the count and the GitHub Security tab URL. A denylist ("strip .secret") is the wrong shape here:
# it is one field name behind forever, and the API adds fields (`.validity`, `.publicly_leaked` and
# `.closure_request_comment` are all newer than this repository). An allowlist cannot leak a field that
# did not exist when it was written.
#
# The alert NUMBER is included deliberately: it is how a human reaches the alert on github.com, and it
# discloses nothing on its own (the Security tab requires push access to view).
#   Tests: deploy/test/security-alerts.test.sh (gh is a stub)
set -euo pipefail

REPO=${1:-}
[ -n "$REPO" ] || { echo "usage: security-alerts.sh <owner/repo>" >&2; exit 2; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

problems=()    # lines describing feeds WITH open alerts
unreadable=()  # names of feeds that could not be read
summary=()     # one line per feed, always printed — this is the 母数 (#757)

# read_feed <name> <api-path> <jq-kind-filter>
#   Fetches one alert feed and appends to the arrays above. The jq filter is applied to ONE alert object and
# must print the kind; it is the allowlist, and it is passed in per feed rather than shared, so that adding a
# feed forces whoever adds it to decide what is safe to print for it.
read_feed() {
  local name=$1 path=$2 kind_filter=$3
  local out="$TMP/$name.json" err rc=0

  # `2>&1 >file`: stderr into the substitution, stdout into the file. gh echoes the request's Authorization
  # header in some failures, so the error text goes to STDERR ONLY (the run log), never to stdout (#540).
  # --paginate: a repository with more than 100 open alerts must not silently report only the first 100.
  err=$(gh api --paginate "repos/$REPO/$path?state=open&per_page=100" 2>&1 >"$out") || rc=$?
  if [ "$rc" != 0 ]; then
    unreadable+=("$name")
    summary+=("unreadable $name: 読めなかった（件数は不明）")
    printf 'security-alerts: gh api failed for %s: %s\n' "$name" "$err" >&2
    return
  fi

  # --paginate concatenates one JSON array per page, so parse the stream and gather it back into one array.
  local n
  # A response that is not an array of alerts (an error object, HTML from a proxy, an empty body) must count
  # as UNREADABLE, not as zero. This is the #757 母数 in its sharpest form: `jq length` on `{"message":…}`
  # would print 1, and on `null` it errors — neither is "no alerts".
  if ! n=$(jq -s -e 'map(select(type == "array")) | if length == 0 then error("not an array") else add | length end' "$out" 2>/dev/null); then
    unreadable+=("$name")
    summary+=("unreadable $name: 応答が想定の形ではない（件数は不明）")
    printf 'security-alerts: unexpected response shape for %s\n' "$name" >&2
    return
  fi

  summary+=("read $name: open $n 件")
  # `|| return` would return the FAILED TEST's status (1) and, under `set -e`, kill the whole script at the
  # first empty feed — measured: the all-clear path printed nothing at all and exited 1. Return 0 explicitly.
  if [ "$n" -eq 0 ]; then return 0; fi

  # ALLOWLIST. Only the kind and the number leave jq. Nothing else from the alert object is referenced.
  local kinds
  kinds=$(jq -s -r "add | map($kind_filter) | group_by(.) | map(\"\(.[0]) x\(length)\") | join(\", \")" "$out")
  problems+=("$name: open $n 件（$kinds）")
}

read_feed secret-scanning "secret-scanning/alerts" '.secret_type_display_name // "unknown"'
read_feed dependabot      "dependabot/alerts"      '.security_advisory.severity // "unknown"'

# The counts are printed on EVERY path, including the all-clear one. "0 alerts" that is never shown is
# indistinguishable from "the check did not run" — which is the 21 days this Issue is about.
for s in "${summary[@]}"; do echo "  - $s"; done

if [ ${#unreadable[@]} -gt 0 ]; then
  echo "fail security-alerts: ${#unreadable[@]} 件のフィードを読めなかった（${unreadable[*]}）。open なアラートが有るか無いかは判定できていない"
  echo "  理由はこの run のログ（stderr）に出ている。Issue 本文には出さない: 認証情報が混ざりうる"
  echo "  権限が足りない場合の直し方: docs/ops/monitoring.md「GitHub の security アラート」"
  exit 2
fi

if [ ${#problems[@]} -gt 0 ]; then
  echo "fail security-alerts: $REPO に open な security アラートがある"
  for p in "${problems[@]}"; do echo "  - $p"; done
  echo "  https://github.com/$REPO/security"
  exit 1
fi

echo "ok security-alerts: open なアラートは無い（secret scanning / dependabot の 2 フィードを読んだ）"
