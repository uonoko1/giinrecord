#!/usr/bin/env bash
# External probe of one site origin (Issue #135), run from GitHub Actions (.github/workflows/monitor.yml via run.sh)
# — or by hand: bash deploy/monitor/probe.sh https://giinrecord.jp
#
# Checks → one line per check on stdout, "ok <check>" or "fail <check> <reason>"; exit 1 if anything failed:
#   http   GET /, /members/, /assemblies/ and /data/meta.json answer 200, and every HTML page carries 議員レコード
#          in <title> (a 200 from a default nginx page or a wrong site would otherwise pass)
#          Issue #248: the assembly pages (/assemblies/<id>) are part of this same check, so a 500 or a missing
#          prerender on a local assembly is noticed — and a failure there opens the one "http" Issue, not one per
#          assembly. The list is NOT hard-coded: /data/assemblies/index.json — the very file the site serves to its
#          own front-end — is fetched and its "id" values are the paths to probe, so a new assembly is monitored the
#          moment it ships. At most PROBE_ASSEMBLY_SAMPLE (3) of them are fetched per run, rotating through the list
#          in file order (one step per 10-minute slot), which keeps a round at a fixed, small number of requests
#          however many assemblies exist while still covering every assembly within a few rounds. Each page must
#          answer 200 AND carry the site name AND the assembly's own name: nginx answers 200 with the SPA fallback
#          (try_files … /__spa-fallback.html) for ANY unknown path, so the site name alone cannot tell a live page
#          from a vanished prerender — only the assembly's own name in the <title> can.
#   data   meta.fetchedAt (top-level, the ETL's run time) is at most PROBE_MAX_AGE_HOURS (48) old — the daily ETL +
#          deploy-data.yml is alive
#   tls    the certificate presented for the origin's host is valid for at least PROBE_TLS_MIN_DAYS (14) more days
# Reasons contain only the path, the HTTP status, ages and day counts — never headers, bodies or addresses.
# Issue #163: staging sits behind Cloudflare Access. With CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET set (a
# Cloudflare service token) every request carries CF-Access-Client-Id / CF-Access-Client-Secret. The headers are
# written to a curl config file (mode 600, deleted on exit) and passed with -K: they never appear in argv (ps, logs)
# and are never printed. The tls check then sees Cloudflare's edge certificate, which is what browsers see too.
#   Tests: deploy/test/monitor-probe.test.sh (curl and openssl are stubs)
set -euo pipefail
export LC_ALL=C   # openssl prints English month names; date must parse them whatever the runner locale is

ORIGIN=${1:-}
MAX_AGE_HOURS=${PROBE_MAX_AGE_HOURS:-48}
TLS_MIN_DAYS=${PROBE_TLS_MIN_DAYS:-14}
TIMEOUT=${PROBE_TIMEOUT:-20}
TITLE_MUST_CONTAIN=${PROBE_TITLE:-議員レコード}
ASSEMBLY_SAMPLE=${PROBE_ASSEMBLY_SAMPLE:-3}   # assembly pages fetched per run (#248); 0 = none

# origin = https://<host> only (no path, no http): the paths are appended here and the host is reused for TLS
if [[ ! "$ORIGIN" =~ ^https://[A-Za-z0-9.-]+$ ]]; then
  echo "usage: probe.sh https://<host>   (got: '${ORIGIN}')" >&2; exit 2
fi
HOST=${ORIGIN#https://}

FAILED=0
ok()   { echo "ok $1"; }
fail() { echo "fail $1 $2"; FAILED=1; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# Cloudflare Access service token (#163) → curl config file; CURL_OPTS holds only "-K <file>", never a value.
CURL_OPTS=()
CF_ID=${CF_ACCESS_CLIENT_ID:-}; CF_SECRET=${CF_ACCESS_CLIENT_SECRET:-}
if [ -n "$CF_ID" ] || [ -n "$CF_SECRET" ]; then
  if [ -z "$CF_ID" ] || [ -z "$CF_SECRET" ]; then
    echo "probe.sh: CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be set together" >&2; exit 2
  fi
  # printable, no quotes / backslashes / newlines: the values go inside a quoted curl config string
  for v in "$CF_ID" "$CF_SECRET"; do
    if [[ ! "$v" =~ ^[A-Za-z0-9._-]+$ ]]; then
      echo "probe.sh: CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET contain unexpected characters (value not shown)" >&2; exit 2
    fi
  done
  CURLRC="$TMP/curlrc"
  ( umask 077; printf 'header = "CF-Access-Client-Id: %s"\nheader = "CF-Access-Client-Secret: %s"\n' "$CF_ID" "$CF_SECRET" > "$CURLRC" )
  CURL_OPTS=(-K "$CURLRC")
fi
unset CF_ID CF_SECRET

# fetch <path> <outfile> → prints the HTTP status (000 when the connection failed)
fetch() {
  local code
  code=$(curl -sS --max-time "$TIMEOUT" "${CURL_OPTS[@]}" -o "$2" -w '%{http_code}' "$ORIGIN$1" 2>/dev/null) || code=000
  printf '%s' "$code"
}
# has_title <file> [needle] → the first <title> contains <needle> (default: the site name)
has_title() { tr -d '\n' < "$1" | grep -o '<title>[^<]*</title>' | head -1 | grep -q -F -- "${2:-$TITLE_MUST_CONTAIN}"; }

# check_page <path> [extra] → appends to http_reasons unless the page answers 200 and its <title> carries the site
# name — plus <extra> when given (the assembly's own name; see the SPA-fallback note in the header)
check_page() {
  local path=$1 extra=${2:-} f="$TMP/page" code
  code=$(fetch "$path" "$f")
  if [ "$code" != 200 ]; then http_reasons+=("$path $code"); return; fi
  if ! has_title "$f"; then http_reasons+=("$path title lacks ${TITLE_MUST_CONTAIN}"); return; fi
  if [ -n "$extra" ] && ! has_title "$f" "$extra"; then http_reasons+=("$path title is not this page"); fi
}

# ---- http ----
http_reasons=()
for path in / /members/ /assemblies/; do check_page "$path"; done
META="$TMP/meta.json"; meta_code=$(fetch /data/meta.json "$META")
[ "$meta_code" = 200 ] || http_reasons+=("/data/meta.json $meta_code")

# ---- assembly pages (#248) ----
# The list comes from the site's own /data/assemblies/index.json, so a new assembly is probed the moment it ships —
# nothing here to keep in sync by hand. Failures land in the same "http" check: one Issue per environment, not per
# assembly, so the existing dedup/auto-close in report.sh keeps working unchanged.
if [ "$ASSEMBLY_SAMPLE" -gt 0 ]; then
  AIDX="$TMP/assemblies.json"; aidx_code=$(fetch /data/assemblies/index.json "$AIDX")
  if [ "$aidx_code" != 200 ]; then
    http_reasons+=("/data/assemblies/index.json $aidx_code")
  else
    # "<id> <name>" per entry, in file order — no jq or python3 needed on the runner
    mapfile -t assemblies < <(tr -d '\n' < "$AIDX" \
      | grep -o '"id" *: *"[^"]*"[^{]*"name" *: *"[^"]*"' \
      | sed 's/^"id" *: *"\([^"]*\)".*"name" *: *"\([^"]*\)"$/\1 \2/' || true)
    n=${#assemblies[@]}
    if [ "$n" -eq 0 ]; then
      http_reasons+=("/data/assemblies/index.json lists no assembly")
    else
      # Rotate through the list (one step per 10-minute slot = one step per run): a run stays at a fixed small
      # number of requests however many assemblies exist, and every assembly is still covered within a few runs.
      # PROBE_NOW pins the slot for the tests; the schedule provides it in production.
      offset=$(( (${PROBE_NOW:-$(date +%s)} / 600) % n ))
      take=$(( ASSEMBLY_SAMPLE < n ? ASSEMBLY_SAMPLE : n ))
      for ((i = 0; i < take; i++)); do
        entry=${assemblies[$(( (offset + i) % n ))]}
        check_page "/assemblies/${entry%% *}" "${entry#* }"
      done
    fi
  fi
fi
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
