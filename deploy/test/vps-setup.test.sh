#!/usr/bin/env bash
# Tests for deploy/vps-setup.sh main() (Issue #141: idempotent, argument validation, certbot-block protection).
# No root, no nginx: every path is rooted at a temp dir through VPS_SETUP_PREFIX and install / nginx / systemctl
# are stubs on PATH that only record their arguments.
#   bash deploy/test/vps-setup.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../vps-setup.sh"
PASS=0; FAIL=0

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"; mkdir -p "$BIN"
for cmd in install nginx systemctl; do
  cat > "$BIN/$cmd" <<STUB
#!/usr/bin/env bash
echo "$cmd \$*" >> "\$STUB_LOG"
STUB
  chmod +x "$BIN/$cmd"
done
# nginx whose -t fails
BAD="$TMP/bad"; mkdir -p "$BAD"
# shellcheck disable=SC2016  # the stub expands $* / $STUB_LOG when it runs, not here
printf '#!/usr/bin/env bash\necho "nginx $*" >> "$STUB_LOG"; exit 1\n' > "$BAD/nginx"; chmod +x "$BAD/nginx"

fail() { echo "    x $1"; CURRENT_FAILED=1; }
assert_eq() { [[ "$2" == "$1" ]] || fail "$3: expected [$1] got [$2]"; }
assert_contains() { [[ "$1" == *"$2"* ]] || fail "$3: expected to contain [$2] in: $1"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] || fail "$3: expected NOT to contain [$2] in: $1"; }
test_case() {
  local name=$1; shift; CURRENT_FAILED=0
  "$@"
  if [[ $CURRENT_FAILED == 0 ]]; then PASS=$((PASS+1)); echo "ok   $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi
}

fresh() {
  P="$TMP/$1"; mkdir -p "$P/etc/nginx/sites-available" "$P/etc/nginx/sites-enabled" "$P/etc/nginx/conf.d"
  LOG="$P/stub.log"; : > "$LOG"
  export VPS_SETUP_PREFIX="$P" STUB_LOG="$LOG"
  CONF="$P/etc/nginx/sites-available/gikailog.conf"
  STG_CONF="$P/etc/nginx/sites-available/gikailog-staging.conf"
}
with_cert() { mkdir -p "$P/etc/letsencrypt/live/$1"; : > "$P/etc/letsencrypt/live/$1/fullchain.pem"; }
run_setup() { PATH="$BIN:$PATH" bash "$SCRIPT" "$@" > "$P/out" 2>&1; }

# A certbot-managed production conf as it exists on the live host (hand-edited 80 block, one 443 block for both names).
certbot_conf() {
  cat <<'C'
server {
    server_name gikailog.jp www.gikailog.jp;
    access_log /var/log/nginx/gikailog.access.log noip;

    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }

    listen [::]:443 ssl ipv6only=on; # managed by Certbot
    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/gikailog.jp/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/gikailog.jp/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot
}
server {
    if ($host = www.gikailog.jp) {
        return 301 https://gikailog.jp$request_uri;
    }
    if ($host = gikailog.jp) {
        return 301 https://$host$request_uri;
    } # managed by Certbot

    listen 80;
    listen [::]:80;
    server_name gikailog.jp www.gikailog.jp;
    access_log /var/log/nginx/gikailog.access.log noip;
    return 404; # managed by Certbot
}
C
}

t_syntax() { bash -n "$SCRIPT" || fail "bash -n"; }

t_bootstrap_without_cert() {
  fresh boot
  run_setup gikailog.jp || fail "exit $? $(cat "$P/out")"
  [[ -f "$CONF" ]] || { fail "conf written"; return; }
  local c; c=$(cat "$CONF")
  assert_contains "$c" "server_name gikailog.jp www.gikailog.jp;" "both names"
  assert_contains "$c" "proxy_pass http://127.0.0.1:8081;" "plain proxy on :80 so certbot can run"
  assert_not_contains "$c" "listen 443" "no TLS block before the certificate exists"
  assert_not_contains "$c" "return 301" "no redirect before TLS exists (site must stay reachable)"
  assert_contains "$c" "access_log /var/log/nginx/gikailog.access.log noip;" "noip log"
  [[ -L "$P/etc/nginx/sites-enabled/gikailog.conf" ]] || fail "enabled symlink"
  assert_contains "$(cat "$LOG")" "nginx -t" "config tested"
  assert_contains "$(cat "$LOG")" "systemctl reload nginx" "reloaded"
  assert_contains "$(cat "$P/out")" "certbot certonly --nginx -d gikailog.jp -d www.gikailog.jp" "operator is told the certbot command"
}

t_full_template_with_cert() {
  fresh tls; with_cert gikailog.jp
  run_setup gikailog.jp || fail "exit $? $(cat "$P/out")"
  local c; c=$(cat "$CONF")
  assert_contains "$c" "listen 443 ssl;" "TLS block"
  assert_contains "$c" "ssl_certificate /etc/letsencrypt/live/gikailog.jp/fullchain.pem;" "cert path of the apex"
  assert_contains "$c" "return 301 https://gikailog.jp\$request_uri;" "80: www and apex -> https apex"
  assert_contains "$c" "proxy_pass http://127.0.0.1:8081;" "443 proxies to the container"
  assert_not_contains "$c" "SERVER_NAMES" "placeholder"; assert_not_contains "$c" "DOMAIN" "placeholder"
  assert_not_contains "$c" "PORT" "placeholder"; assert_not_contains "$c" "LOG_NAME" "placeholder"
  # the redirect is a location, not a server-level return: certbot's injected ACME location must win
  assert_contains "$c" "location / {
        return 301" "redirect inside location /"
}

t_rerun_is_noop() {
  fresh twice; with_cert gikailog.jp
  run_setup gikailog.jp || fail "first: $(cat "$P/out")"
  local before; before=$(cat "$CONF")
  run_setup gikailog.jp || fail "second: $(cat "$P/out")"
  assert_eq "$before" "$(cat "$CONF")" "second run writes the same conf"
}

t_protects_certbot_conf() {
  fresh certbot; with_cert gikailog.jp
  certbot_conf > "$CONF"
  local before; before=$(cat "$CONF")
  run_setup gikailog.jp || fail "exit $? $(cat "$P/out")"
  assert_eq "$before" "$(cat "$CONF")" "certbot-managed conf untouched (live host re-run is a no-op)"
  assert_contains "$(cat "$P/out")" "managed by Certbot" "operator is told why"
  assert_contains "$(cat "$LOG")" "nginx -t" "still tested"
}

t_certbot_conf_only_port_rewritten() {
  fresh port; with_cert gikailog.jp
  certbot_conf | sed 's/8081/8085/' > "$CONF"
  run_setup gikailog.jp || fail "exit $? $(cat "$P/out")"
  local c; c=$(cat "$CONF")
  assert_contains "$c" "proxy_pass http://127.0.0.1:8081;" "proxy port rewritten"
  assert_not_contains "$c" "8085" "old port gone"
  assert_eq "$(certbot_conf)" "$c" "nothing else changed (server_name, certificate, redirects)"
}

t_staging_port_requires_staging_domain() {
  fresh stgarg
  if run_setup gikailog.jp 8083; then fail "8083 with the production domain must be rejected"; fi
  assert_contains "$(cat "$P/out")" "staging." "message names the rule"
  [[ ! -e "$CONF" && ! -e "$STG_CONF" ]] || fail "nothing written"
  assert_eq "" "$(cat "$LOG")" "nothing run"
}

t_production_port_rejects_staging_domain() {
  fresh prodarg
  if run_setup staging.gikailog.jp; then fail "staging domain on the production port must be rejected"; fi
  [[ ! -e "$CONF" ]] || fail "nothing written"
}

t_staging_conf() {
  fresh stg; with_cert staging.gikailog.jp
  run_setup staging.gikailog.jp 8083 || fail "exit $? $(cat "$P/out")"
  local c; c=$(cat "$STG_CONF")
  assert_contains "$c" "server_name staging.gikailog.jp;" "no www for staging"
  assert_contains "$c" "proxy_pass http://127.0.0.1:8083;" "staging port"
  assert_contains "$c" "gikailog-staging.access.log noip" "staging log"
  assert_contains "$c" "/etc/letsencrypt/live/staging.gikailog.jp/" "staging cert"
  [[ ! -e "$CONF" ]] || fail "production conf untouched"
}

t_unknown_port() {
  fresh badport
  if run_setup gikailog.jp 9000; then fail "unknown port must be rejected"; fi
}

t_broken_config_not_reloaded() {
  fresh broken; with_cert gikailog.jp
  if PATH="$BAD:$BIN:$PATH" bash "$SCRIPT" gikailog.jp > "$P/out" 2>&1; then fail "must exit 1"; fi
  assert_not_contains "$(cat "$LOG")" "systemctl" "no reload"
}

test_case "vps-setup.sh: bash -n" t_syntax
test_case "証明書が無ければ :80 の proxy だけ（redirect も 443 も無し）を書き certbot のコマンドを案内" t_bootstrap_without_cert
test_case "証明書があれば :80 は www/apex とも https://apex へ 301、:443 が proxy（テンプレート全体）" t_full_template_with_cert
test_case "2 回目は同じ conf（冪等）" t_rerun_is_noop
test_case "certbot 管理の conf は書き換えない（本番の再実行は no-op）" t_protects_certbot_conf
test_case "certbot 管理の conf でも proxy_pass のポートだけは直す" t_certbot_conf_only_port_rewritten
test_case "8083 は staging.* のドメインだけ受け付ける" t_staging_port_requires_staging_domain
test_case "8081 は staging.* のドメインを拒否する" t_production_port_rejects_staging_domain
test_case "staging: www 無し・8083・gikailog-staging.conf、production の conf には触れない" t_staging_conf
test_case "8081/8083 以外のポートは拒否" t_unknown_port
test_case "nginx -t が落ちれば reload せず exit 1" t_broken_config_not_reloaded

echo; echo "passed: $PASS  failed: $FAIL"
[[ $FAIL == 0 ]]
