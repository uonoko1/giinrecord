# shellcheck shell=bash
# Tests for scripts/po/verify-site.sh (sourced by run.sh). `ssh` and `curl` are the fakes in fake-bin:
# the remote script runs locally, `curl_handle <url>` decides code and body per URL.

# site_handler <code for /members/> → every URL is 200 with a title except /members/ (given code)
site_handler() {
  handler <<EOF
curl_handle() {
  case "\$1" in
    *"/members/")   printf '%s\n%s' "$1" '<html><head><title>議員一覧 | 議員レコード</title></head></html>' ;;
    *"/data/meta.json") printf '200\n{"generatedAt":"2026-08-23T21:00:00Z"}' ;;
    *"/sitemap.xml")   printf '200\n<?xml version="1.0"?><urlset></urlset>' ;;
    *) printf '200\n<html><head>\n<title>\n  議員レコード\n</title></head><body>x</body></html>' ;;
  esac
}
EOF
}

ssh_calls() { grep -c $'^ssh\t' <<<"$LOG" || true; }

t_site_all_200() {
  local h; h=$(site_handler 200)
  run_script "$h" verify-site.sh
  assert_eq 0 "$STATUS" "exit status: $ERR"
  assert_contains "$OUT" "production" "production section"
  assert_contains "$OUT" "staging" "staging section"
  assert_contains "$OUT" "200  /  議員レコード" "title extracted across newlines"
  assert_contains "$OUT" "200  /members/  議員一覧 | 議員レコード" "members title"
  assert_contains "$OUT" "200  /data/meta.json  -" "no title → -"
  assert_contains "$OUT" "200  /sitemap.xml  -" "sitemap has no title"
  assert_contains "$OUT" "all 200" "summary"
  # one ssh per environment, to the default host
  assert_eq 2 "$(ssh_calls)" "ssh calls"
  assert_contains "$LOG" $'ssh\tgiinops\t' "default ssh host"
  # production: --resolve to loopback with the real hostname; staging: container port with Host header
  assert_contains "$(grep -F 'https://giinrecord.jp/about/' <<<"$LOG")" $'--resolve\tgiinrecord.jp:443:127.0.0.1\t' "production resolve"
  assert_contains "$(grep -F 'http://127.0.0.1:8083/about/' <<<"$LOG")" $'-H\tHost: staging.giinrecord.jp\t' "staging via container port"
  assert_not_contains "$LOG" $'\t-k\t' "never skips TLS verification"
  for p in / /about/ /terms /privacy /members/ /rollcalls/ /assemblies/ /data/meta.json /sitemap.xml; do
    assert_contains "$LOG" "https://giinrecord.jp$p" "production checks $p"
    assert_contains "$LOG" "http://127.0.0.1:8083$p" "staging checks $p"
  done
}
test_case "verify-site: lists code + title for every URL on production and staging, exit 0 when all 200" t_site_all_200

t_site_non_200() {
  local h; h=$(site_handler 404)
  run_script "$h" verify-site.sh
  assert_eq 1 "$STATUS" "exit status"
  assert_contains "$OUT" "404  /members/" "shows the failing code"
  assert_contains "$OUT" "NG" "marks the failing line"
  assert_not_contains "$OUT" "all 200" "no all-good summary"
}
test_case "verify-site: any non-200 → exit 1 and the line is marked" t_site_non_200

t_site_only_production() {
  local h; h=$(site_handler 200)
  run_script "$h" verify-site.sh production
  assert_eq 0 "$STATUS" "exit status: $ERR"
  assert_eq 1 "$(ssh_calls)" "one ssh call"
  assert_not_contains "$LOG" "8083" "staging not touched"
}
test_case "verify-site: 'production' argument checks production only" t_site_only_production

t_site_env_host() {
  local h; h=$(site_handler 200)
  VPS_SSH_HOST=other-alias run_script "$h" verify-site.sh staging
  assert_eq 0 "$STATUS" "exit status: $ERR"
  assert_contains "$LOG" $'ssh\tother-alias\t' "VPS_SSH_HOST respected"
  assert_not_contains "$LOG" "https://giinrecord.jp" "production not touched"
}
test_case "verify-site: VPS_SSH_HOST overrides the ssh alias; 'staging' checks staging only" t_site_env_host

t_site_bad_arg() {
  local h; h=$(site_handler 200)
  run_script "$h" verify-site.sh prod
  assert_eq 2 "$STATUS" "usage error"
  assert_eq 0 "$(ssh_calls)" "no ssh call"
}
test_case "verify-site: unknown argument → usage, exit 2, no ssh" t_site_bad_arg
