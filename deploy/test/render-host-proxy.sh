#!/usr/bin/env bash
# Prints the host nginx server block deploy/vps-setup.sh would write for <domain> <port>, without touching the
# system (no root, no nginx). Used by packages/etl/test/deploy-docker.test.ts.
#   bash deploy/test/render-host-proxy.sh gikailog.jp 8081
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR
# shellcheck source=../vps-setup.sh
VPS_SETUP_NO_MAIN=1 source "$HERE/../vps-setup.sh"
render_host_proxy "${1:?domain}" "${2:?port}"
