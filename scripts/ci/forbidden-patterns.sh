#!/usr/bin/env bash
# Forbidden-pattern check for the public repo (Issue #133). Runs in CI (.github/workflows/security.yml) and
# locally:  bash scripts/ci/forbidden-patterns.sh   (from anywhere inside the checkout; scans tracked files only).
#
# Rules (any hit → exit 1, every hit printed as  rule<TAB>file[:line]):
#   private-key   -----BEGIN ... PRIVATE KEY-----
#   github-token  ghp_… / github_pat_…
#   aws-key       AKIA… access key ids
#   env-file      a tracked .env or .env.* (only .env.example may be committed)
#   ip-address    a public IPv4 literal anywhere (the VPS is written as a domain, not an IP; no directory is exempt —
#                 deploy/ and docs/ops/ are exactly where the IP used to live. Loopback, 0.0.0.0 and RFC1918
#                 ranges are fine — they identify nothing)
#   forbidden     regexes from $FORBIDDEN_PATTERNS (newline separated; a repo secret set by the PO — names of the
#                 other sites on the shared VPS etc.). The patterns are never printed.
#                 Unset/empty → with FORBIDDEN_PATTERNS_REQUIRED=true (push, schedule, same-repo PR) that is an
#                 error (exit 2): a missing or renamed secret must never pass as clean. Otherwise (fork PRs get no
#                 secrets by GitHub design; local runs) a ::warning:: annotation and the other rules still run.
#
# data/ (ETL output) and pnpm-lock.yaml are not scanned for IPs; everything tracked is scanned for the rest.
#   Tests: scripts/ci/test/forbidden-patterns.test.sh
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
HITS=0
report() { # report <rule> <grep-output-lines>
  [ -n "$2" ] || return 0
  HITS=$((HITS + $(printf '%s\n' "$2" | wc -l)))
  printf '%s\n' "$2" | sed "s/^/!! $1: /"
}

# Tracked (or staged) text files, NUL-separated → newline list. Binary files are skipped by grep -I.
FILES=$(git ls-files -z | tr '\0' '\n')

# run_grep <file-list> <grep args...> → prints grep's output; returns 0 for "matches or no matches", exits otherwise.
# grep exits 1 for "no match" (fine) and 2 for errors (invalid regex, unreadable file…). xargs may split the file
# list over several grep runs and reports any non-zero status as 123, so each run maps 1 → 0 first; what is left
# (2 → 123) must fail the check — a silent "clean" is the worst outcome (#137 review).
ERR_FILE=$(mktemp); PATTERN_FILE=""
trap 'rm -f "$ERR_FILE" "$PATTERN_FILE"' EXIT
grep_failed() {
  # stderr may quote the offending pattern (the secret) → only its size is logged, never its content.
  echo "forbidden-patterns: grep failed ($1; $(wc -c < "$ERR_FILE" | tr -d ' ') bytes of stderr suppressed)." \
    "Check the regexes in FORBIDDEN_PATTERNS and the tracked files." >&2
  exit 2
}
run_grep() {
  local files=$1; shift
  local out status
  set +e
  # shellcheck disable=SC2016
  out=$(printf '%s\n' "$files" | sed '/^$/d' | tr '\n' '\0' \
    | xargs -0 -r sh -c 'grep "$@"; s=$?; [ "$s" -eq 1 ] && exit 0; exit "$s"' grep "$@" -- 2>"$ERR_FILE")
  status=$?
  set -e
  case $status in
    0|1) printf '%s' "$out" ;;
    123) grep_failed "grep exited with an error" ;;
    *)   grep_failed "xargs/grep status $status" ;;
  esac
}
# grep_files <rule> <ERE> [extra grep args...]  → reports file:line hits (content is NOT printed: it may be the secret)
grep_files() {
  local rule=$1 re=$2; shift 2
  local out
  out=$(run_grep "$FILES" -I -H -n -E "$@" -e "$re" | cut -d: -f1,2) || exit 2
  report "$rule" "$out"
}

grep_files private-key '-----BEGIN( [A-Z]+)* PRIVATE KEY-----'
grep_files github-token '(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}'
grep_files aws-key '\b(AKIA|ASIA)[0-9A-Z]{16}\b'

ENV_FILES=$(printf '%s\n' "$FILES" | grep -E '(^|/)\.env(\.[^/]+)?$' | grep -v -E '(^|/)\.env\.example$' || true)
report env-file "$ENV_FILES"

# Strict octets (no leading zeros) and no neighbouring digit, letter or dot: keeps SVG path data and version strings (v1.2.3.4) out.
OCTET='(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])'
IP_RE="(?<![0-9A-Za-z.])($OCTET\\.){3}$OCTET(?![0-9A-Za-z.])"
IP_FILES=$(printf '%s\n' "$FILES" | grep -v -E '^(data/|pnpm-lock\.yaml$)' || true)
IP_OUT=$(run_grep "$IP_FILES" -I -H -n -o -P -e "$IP_RE" \
  | { grep -v -E ':(127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|255\.255\.)' || true; } | cut -d: -f1,2) || exit 2
report ip-address "$IP_OUT"

if [ -z "${FORBIDDEN_PATTERNS:-}" ]; then
  if [ "${FORBIDDEN_PATTERNS_REQUIRED:-false}" = "true" ]; then
    echo "::error::FORBIDDEN_PATTERNS is empty but required on this event (push/schedule/same-repo PR):" \
      "the repo secret is missing or renamed, so the site-name check cannot run. Not treating this as clean." >&2
    exit 2
  fi
  echo "::warning::FORBIDDEN_PATTERNS not configured (fork PR or local run): site-specific names were NOT checked." \
    "The other rules still ran."
else
  PATTERN_FILE=$(mktemp)
  # CR stripped: a secret pasted with CRLF endings would otherwise search for "name\r" and silently match nothing.
  printf '%s\n' "$FORBIDDEN_PATTERNS" | tr -d '\r' | sed '/^[[:space:]]*$/d' > "$PATTERN_FILE"
  N=$(wc -l < "$PATTERN_FILE" | tr -d ' ')
  echo "FORBIDDEN_PATTERNS: $N pattern(s)"
  if [ "$N" -gt 0 ]; then
    F_OUT=$(run_grep "$FILES" -I -H -n -i -E -f "$PATTERN_FILE" | cut -d: -f1,2) || exit 2
    report forbidden "$F_OUT"
  fi
fi

if [ "$HITS" -gt 0 ]; then
  echo "forbidden-patterns: $HITS hit(s). See docs/WORKING_AGREEMENT.md (セキュリティレビュー)." >&2
  exit 1
fi
echo "forbidden-patterns: clean"
