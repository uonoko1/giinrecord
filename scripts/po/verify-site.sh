#!/usr/bin/env bash
# verify-site.sh [production|staging|all]
#   PO check after a deploy (Sprint 9 retro, #182): the PO's own network returns curl 000 intermittently, so the
#   main URLs are fetched FROM the VPS over `ssh $VPS_SSH_HOST` (default `gikaiops`) and listed as
#   "<code>  <path>  <title>" per environment. Read-only; nothing on the VPS is changed. No secrets involved.
#   - production: `curl --resolve gikailog.jp:443:127.0.0.1 https://gikailog.jp<path>` — the host nginx block with
#     the real hostname, TLS certificate verified (no -k).
#   - staging: the host nginx 443 block only admits Cloudflare (docs/ops/staging-access.md, #163); a loopback
#     request is 403 BY DESIGN. So staging is checked at the container port, `http://127.0.0.1:8083<path>` with
#     `Host: staging.gikailog.jp` (same path deploy.md uses). This verifies the deployed build, not Cloudflare Access.
#   Exit 0 only when every URL is 200; 1 when any is not (the line is marked NG); 2 on a usage error.
# Env: VPS_SSH_HOST (ssh alias; default gikaiops), STAGING_PORT (default 8083).
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TARGET=${1:-all}
case "$TARGET" in production|staging|all) ;; *) usage "verify-site.sh [production|staging|all]" ;; esac

SSH_HOST=${VPS_SSH_HOST:-gikaiops}
STAGING_PORT=${STAGING_PORT:-8083}
PATHS=(/ /about/ /terms /privacy /members/ /rollcalls/ /assemblies/ /data/meta.json /sitemap.xml)

# Runs on the VPS via `bash -s` (stdin). Args: <label> <base url> <curl opts…>. Prints one line per path and
# "all 200" / "NG: n" last. The exit status carries the result (0 = all 200).
remote_script() {
  cat <<'REMOTE'
set -euo pipefail
label=$1; base=$2; shift 2
# paths arrive NUL-free one per line in $PATHS_LIST
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
ng=0
echo "== $label"
while IFS= read -r p; do
  [[ -n "$p" ]] || continue
  code=$(curl -sS --max-time 15 "$@" -o "$tmp" -w '%{http_code}' "$base$p" 2>/dev/null || echo 000)
  # <title> may span lines: join, take the first, trim
  title=$(tr -d '\r\n' < "$tmp" | sed -n 's:.*<title>\([^<]*\)</title>.*:\1:p' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | head -1)
  [[ -n "$title" ]] || title="-"
  mark=""
  if [[ "$code" != "200" ]]; then mark="  NG"; ng=$((ng+1)); fi
  echo "$code  $p  $title$mark"
done <<<"$PATHS_LIST"
if [[ $ng -eq 0 ]]; then echo "all 200"; else echo "NG: $ng"; exit 1; fi
REMOTE
}

# check <label> <base> <curl opts…> → runs the remote script over ssh; returns its status
check() {
  local paths
  paths=$(printf '%s\n' "${PATHS[@]}")
  # The path list and args are passed as positional parameters / an env assignment on the remote command line
  # (client-side expansion, %q-quoted, intentional — SC2029), never interpolated into the script body.
  # shellcheck disable=SC2029
  ssh "$SSH_HOST" "PATHS_LIST=$(printf '%q' "$paths") bash -s -- $(printf '%q ' "$@")" < <(remote_script)
}

RC=0
if [[ "$TARGET" == production || "$TARGET" == all ]]; then
  check production "https://gikailog.jp" --resolve "gikailog.jp:443:127.0.0.1" || RC=1
fi
if [[ "$TARGET" == staging || "$TARGET" == all ]]; then
  check staging "http://127.0.0.1:$STAGING_PORT" -H "Host: staging.gikailog.jp" || RC=1
fi
exit $RC
