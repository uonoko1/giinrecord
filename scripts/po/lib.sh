#!/usr/bin/env bash
# Shared helpers for scripts/po/*.sh. Sourced, not executed.
# Requirements: bash >= 4, gh (authenticated). No jq: JSON is read with `gh --jq`.

die()  { echo "error: $*" >&2; exit 1; }
usage() { echo "usage: $*" >&2; exit 2; }
log()  { echo "[$(date -u +%H:%M:%SZ)] $*" >&2; }

# is_int <value> → 0 if a positive integer
is_int() { [[ "$1" =~ ^[0-9]+$ ]]; }

# Repository as owner/name. PO_REPO overrides (tests, or running outside a checkout).
po_repo() {
  if [[ -n "${PO_REPO:-}" ]]; then echo "$PO_REPO"; return; fi
  gh repo view --json nameWithOwner -q .nameWithOwner
}

# Polling knobs (seconds between polls / max polls). Defaults: 20 s × 60 = 20 min.
POLL_INTERVAL=${POLL_INTERVAL:-20}
POLL_MAX=${POLL_MAX:-60}
