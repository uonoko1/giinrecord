#!/usr/bin/env bash
# Forbidden-pattern check for the public repo (Issue #133). Runs in CI (.github/workflows/security.yml) and
# locally:  bash scripts/ci/forbidden-patterns.sh   (from anywhere inside the checkout; scans tracked files only).
#
# Rules (any hit → exit 1, every hit printed as  rule<TAB>file[:line]):
#   private-key   -----BEGIN ... PRIVATE KEY-----
#   github-token  ghp_… / github_pat_…
#   aws-key       AKIA… access key ids
#   env-file      a tracked .env or .env.* (only .env.example may be committed)
#   ip-address    a public IPv4 literal outside deploy/ and docs/ops/ (the VPS is written as a domain, not an IP;
#                 loopback, 0.0.0.0 and RFC1918 ranges are fine — they identify nothing)
#   forbidden     regexes from $FORBIDDEN_PATTERNS (newline separated; a repo secret set by the PO — names of the
#                 other sites on the shared VPS etc.). The patterns are never printed. Unset → "not configured".
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
# grep_files <rule> <ERE> [extra grep args...]  → reports file:line hits (content is NOT printed: it may be the secret)
grep_files() {
  local rule=$1 re=$2; shift 2
  local out
  out=$(printf '%s\n' "$FILES" | tr '\n' '\0' | xargs -0 -r grep -I -H -n -E "$@" -e "$re" -- 2>/dev/null | cut -d: -f1,2 || true)
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
IP_OUT=$(printf '%s\n' "$FILES" | grep -v -E '^(deploy/|docs/ops/|data/|pnpm-lock\.yaml$)' | tr '\n' '\0' \
  | xargs -0 -r grep -I -H -n -o -P -e "$IP_RE" -- 2>/dev/null \
  | grep -v -E ':(127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|255\.255\.)' | cut -d: -f1,2 || true)
report ip-address "$IP_OUT"

if [ -z "${FORBIDDEN_PATTERNS:-}" ]; then
  echo "FORBIDDEN_PATTERNS: not configured (set the repo secret to check for site-specific names)"
else
  PATTERN_FILE=$(mktemp); trap 'rm -f "$PATTERN_FILE"' EXIT
  printf '%s\n' "$FORBIDDEN_PATTERNS" | sed '/^[[:space:]]*$/d' > "$PATTERN_FILE"
  N=$(wc -l < "$PATTERN_FILE" | tr -d ' ')
  echo "FORBIDDEN_PATTERNS: $N pattern(s)"
  if [ "$N" -gt 0 ]; then
    F_OUT=$(printf '%s\n' "$FILES" | tr '\n' '\0' | xargs -0 -r grep -I -H -n -i -E -f "$PATTERN_FILE" -- 2>/dev/null | cut -d: -f1,2 || true)
    report forbidden "$F_OUT"
  fi
fi

if [ "$HITS" -gt 0 ]; then
  echo "forbidden-patterns: $HITS hit(s). See docs/WORKING_AGREEMENT.md (セキュリティレビュー)." >&2
  exit 1
fi
echo "forbidden-patterns: clean"
