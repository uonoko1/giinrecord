#!/usr/bin/env bash
# Aggregate one day of the IP-less nginx access log (log_format "noip", see nginx-noip-log.conf)
# into a TSV of  date / page / referrer / pv.  Nothing else is kept.
#
#   usage: aggregate.sh YYYY-MM-DD [logfile...]     (reads stdin when no logfile is given)
#
# Log line shape (no IP, no user agent):
#   - - [22/Aug/2026:08:12:44 +0900] "GET /members/ HTTP/2.0" 200 5120 "https://www.google.com/" "-"
#
# Line 2 is a `#` summary of the whole day (Issue #1184):
#   # 2026-09-25\tpv=5631\tpages=4938\tper-page=1.14
# pv = page views, pages = DISTINCT pages, per-page = pv/pages. The point is that the reader can tell a
# crawler from a person: measured on this site, 2026-09-25 was 1.14 views per page (every page fetched once
# = a crawler) and 2026-09-16 was 3.50 (a person reading several pages). Crawlers are deliberately NOT
# excluded -- a list of suspicious spellings is a denylist, and this project has been burnt by those
# (#1133 / #1089 / #1115). The numbers are published; the judgement stays with the reader.
# Why a `#` line and not a body row: `head` shows it to the first person who looks, and it keeps the
# date/page/referrer/pv row space clean. Measured: as a body row it adds a spurious `0` line to the
# referrer one-liner in docs/ops/analytics.md; as a `#` line the pv-sum one-liner is unaffected.
set -euo pipefail

DATE="${1:?usage: aggregate.sh YYYY-MM-DD [logfile...]}"
shift
[[ "$DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "bad date: $DATE (want YYYY-MM-DD)" >&2; exit 2; }

printf 'date\tpage\treferrer\tpv\n'

# The body is built once into a temp file: the summary on line 2 is derived FROM the body, so the body
# cannot be counted twice from a pipe. Deriving it (rather than counting again in a second pass over the
# log) is what makes "the summary disagrees with the rows" impossible.
BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT

# awk: filter + normalise. Output "page\treferrer" per page view, then count.
gawk -v want="$DATE" '
BEGIN {
  split("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec", m, " ")
  for (i = 1; i <= 12; i++) mon[m[i]] = sprintf("%02d", i)
}
# 1: [dd/Mon/yyyy:..]   2: "METHOD path proto"   3: status   4: "referrer"
match($0, /^- - \[([0-9]{2})\/([A-Za-z]{3})\/([0-9]{4}):[^\]]*\] "([A-Z]+) ([^ "]+)[^"]*" ([0-9]{3}) [0-9-]+ "([^"]*)"/, f) {
  day = f[3] "-" mon[f[2]] "-" f[1]
  if (day != want) next
  if (f[4] != "GET") next
  if (f[6] != "200" && f[6] != "304") next

  path = f[5]
  sub(/[?#].*$/, "", path)                      # drop query string / fragment
  if (path ~ /^\/(assets|data)\//) next          # static bundles and datasets
  if (path ~ /\.[A-Za-z0-9]+$/) next             # favicon.ico, robots.txt, sitemap.xml, *.html ...
  if (path !~ /\/$/) path = path "/"             # /members -> /members/

  ref = f[7]
  if (ref == "" || ref == "-") ref = "-"
  else {
    scheme = ""
    if (match(ref, /^[A-Za-z][A-Za-z0-9+.-]*:\/\//)) { scheme = substr(ref, 1, RLENGTH); ref = substr(ref, RLENGTH + 1) }
    sub(/[\/?#].*$/, "", ref)                    # host only (no path, no query)
    if (ref == "" || ref == self) ref = "-"      # own site = internal navigation
    else if (scheme != "" && scheme !~ /^https?:/) ref = scheme ref  # keep app schemes (android-app://...)
  }
  print path "\t" ref
}
' self="${ANALYTICS_HOST:-giinrecord.jp}" "$@" \
  | sort | uniq -c \
  | awk -v d="$DATE" 'BEGIN { OFS = "\t" } { n = $1; sub(/^ *[0-9]+ /, ""); print d, $0, n }' \
  | sort -t $'\t' -k4,4nr -k2,2 -k3,3 > "$BODY"

# Summary line, derived from $BODY. pages counts DISTINCT values of column 2, not rows: one page reached
# through two referrers is two rows but one page (otherwise per-page would understate a crawler).
# 0 is printed as 0 -- "no page views" and "could not measure" are different facts, and daily.sh is the
# one that turns the second into a non-zero exit (Issue #1184).
awk -F '\t' -v d="$DATE" '
  { pv += $4; seen[$2] = 1 }
  END {
    pages = length(seen)
    printf "# %s\tpv=%d\tpages=%d\tper-page=%.2f\n", d, pv, pages, (pages ? pv / pages : 0)
  }
' "$BODY"
cat "$BODY"
