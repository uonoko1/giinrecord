#!/usr/bin/env bash
# External probe of one site origin (Issue #135), run from GitHub Actions (.github/workflows/monitor.yml via run.sh)
# — or by hand: bash deploy/monitor/probe.sh https://gikailog.jp
#
# Checks → one line per check on stdout, "ok <check>" or "fail <check> <reason>"; exit 1 if anything failed:
#   http   GET /, /members/ and /data/meta.json answer 200, and both HTML pages carry 議会ログ in <title>
#          (a 200 from a default nginx page or a wrong site would otherwise pass)
#   data   meta.fetchedAt (top-level, the ETL's run time) is at most PROBE_MAX_AGE_HOURS (48) old — the daily ETL +
#          deploy-data.yml is alive
#   tls    the certificate presented for the origin's host is valid for at least PROBE_TLS_MIN_DAYS (14) more days
# Reasons contain only the path, the HTTP status, ages and day counts — never headers, bodies or addresses.
#   Tests: deploy/test/monitor-probe.test.sh (curl and openssl are stubs)
set -euo pipefail
export LC_ALL=C   # openssl prints English month names; date must parse them whatever the runner locale is

ORIGIN=${1:-}
MAX_AGE_HOURS=${PROBE_MAX_AGE_HOURS:-48}
TLS_MIN_DAYS=${PROBE_TLS_MIN_DAYS:-14}
TIMEOUT=${PROBE_TIMEOUT:-20}
TITLE_MUST_CONTAIN=${PROBE_TITLE:-議会ログ}

# origin = https://<host> only (no path, no http): the paths are appended here and the host is reused for TLS
if [[ ! "$ORIGIN" =~ ^https://[A-Za-z0-9.-]+$ ]]; then
  echo "usage: probe.sh https://<host>   (got: '${ORIGIN}')" >&2; exit 2
fi
HOST=${ORIGIN#https://}

FAILED=0
ok()   { echo "ok $1"; }
fail() { echo "fail $1 $2"; FAILED=1; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# fetch <path> <outfile> → prints the HTTP status (000 when the connection failed)
fetch() {
  local code
  code=$(curl -sS --max-time "$TIMEOUT" -o "$2" -w '%{http_code}' "$ORIGIN$1" 2>/dev/null) || code=000
  printf '%s' "$code"
}
# has_title <file> → the first <title> contains the site name
has_title() { tr -d '\n' < "$1" | grep -o '<title>[^<]*</title>' | head -1 | grep -q -F -- "$TITLE_MUST_CONTAIN"; }

# ---- http ----
http_reasons=()
for path in / /members/; do
  f="$TMP/page"; code=$(fetch "$path" "$f")
  if [ "$code" != 200 ]; then http_reasons+=("$path $code")
  elif ! has_title "$f"; then http_reasons+=("$path title lacks ${TITLE_MUST_CONTAIN}")
  fi
done
META="$TMP/meta.json"; meta_code=$(fetch /data/meta.json "$META")
[ "$meta_code" = 200 ] || http_reasons+=("/data/meta.json $meta_code")
if [ ${#http_reasons[@]} -eq 0 ]; then ok http; else fail http "$(IFS=';'; echo "${http_reasons[*]}")"; fi

# ---- data ----
if [ "$meta_code" != 200 ]; then
  fail data "meta.json not fetched ($meta_code)"
else
  # top-level "fetchedAt" comes first in DatasetMeta (docs/DATA_CONTRACT.md); the sources' own fetchedAt follow
  fetched=$(grep -o '"fetchedAt": *"[^"]*"' "$META" | head -1 | sed 's/.*: *"//; s/"$//')
  fetched_epoch=$(date -u -d "$fetched" +%s 2>/dev/null || true)
  if [ -z "$fetched" ] || [ -z "$fetched_epoch" ]; then
    fail data "fetchedAt missing or unparseable"
  else
    age_h=$(( ($(date +%s) - fetched_epoch) / 3600 ))
    if [ "$age_h" -le "$MAX_AGE_HOURS" ]; then ok data; else fail data "fetchedAt ${age_h}h old (limit ${MAX_AGE_HOURS}h)"; fi
  fi
fi

# ---- tls ----
not_after=$(openssl s_client -servername "$HOST" -connect "$HOST:443" </dev/null 2>/dev/null \
  | openssl x509 -noout -enddate 2>/dev/null | sed -n 's/^notAfter=//p' || true)
na_epoch=$(date -u -d "$not_after" +%s 2>/dev/null || true)
if [ -z "$not_after" ] || [ -z "$na_epoch" ]; then
  fail tls "certificate expiry not readable"
else
  days=$(( (na_epoch - $(date +%s)) / 86400 ))
  if [ "$days" -ge "$TLS_MIN_DAYS" ]; then ok tls; else fail tls "certificate expires in ${days} days (limit ${TLS_MIN_DAYS})"; fi
fi

exit $FAILED
