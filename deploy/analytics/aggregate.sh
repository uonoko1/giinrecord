#!/usr/bin/env bash
# Aggregate one day of the IP-less nginx access log (log_format "noip", see nginx-noip-log.conf)
# into a TSV of  date / page / referrer / pv.  Nothing else is kept.
#
#   usage: aggregate.sh YYYY-MM-DD [logfile...]     (reads stdin when no logfile is given)
#
# Log line shape (no IP, no user agent):
#   - - [22/Aug/2026:08:12:44 +0900] "GET /members/ HTTP/2.0" 200 5120 "https://www.google.com/" "-"
set -euo pipefail

DATE="${1:?usage: aggregate.sh YYYY-MM-DD [logfile...]}"
shift
[[ "$DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "bad date: $DATE (want YYYY-MM-DD)" >&2; exit 2; }

printf 'date\tpage\treferrer\tpv\n'

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
' self="${ANALYTICS_HOST:-gikailog.jp}" "$@" \
  | sort | uniq -c \
  | awk -v d="$DATE" 'BEGIN { OFS = "\t" } { n = $1; sub(/^ *[0-9]+ /, ""); print d, $0, n }' \
  | sort -t $'\t' -k4,4nr -k2,2 -k3,3
