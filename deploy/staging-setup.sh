#!/usr/bin/env bash
# 議員レコード staging（staging.giinrecord.jp）の初回セットアップ（Issue #127、冪等化と安全装置 #141）。root で 1 回、再実行可。
#   ssh -t "${VPS_SSH_HOST:-sakura-vps}" 'sudo bash -s' < deploy/staging-setup.sh            ← TTY が要る（certbot が対話）
#   ssh -t "${VPS_SSH_HOST:-sakura-vps}" 'sudo bash -s staging.example.test' < deploy/staging-setup.sh   （ドメインを変える場合）
# 引数のドメインは staging. で始まるものだけ受け付ける（本番ドメインを渡すと本番 conf を書き換えてしまった事故の再発防止、#141）。
# 前提：production が go-live.sh で構築済み（docker・/opt/gikailog・ホスト nginx の noip log_format）。
# 人間の作業はこれと「DNS A: staging.giinrecord.jp → VPS（giinrecord.jp と同じアドレス。リポジトリには書かない、#133）」だけ（README.md）。
# 順序：引数検証 → repo pull → staging web root → ポート空き検査（ss -tln）→ コンテナ（web-staging 8083、常に --force-recreate：
#       bind mount の site.conf は git pull で inode が変わり、再作成しないと反映されない）→ Cloudflare allow-list（#163、
#       snippet ＋週次 cron）→ ホスト nginx の proxy block → certbot certonly（証明書が既にあればスキップ）→
#       もう一度 vps-setup.sh（TLS + redirect block、staging だけ Cloudflare gate）。production には触れない。
# Cloudflare 側（DNS プロキシ ON、Access アプリ）は人間の作業：docs/ops/staging-access.md。
#   テスト: deploy/test/staging-setup.test.sh（STAGING_SETUP_PREFIX で全パスを一時ディレクトリ配下に、docker 等はスタブ）
set -euo pipefail

usage() { echo "usage: staging-setup.sh [staging.<domain>]   (default staging.giinrecord.jp; the domain must start with 'staging.')" >&2; }

PREFIX="${STAGING_SETUP_PREFIX:-}"
DOMAIN="${1:-staging.giinrecord.jp}"
PORT=8083
SERVICE=web-staging
REPO_DIR="$PREFIX/opt/gikailog"
SITE="$PREFIX/var/www/gikailog/staging"
COMPOSE="$REPO_DIR/deploy/docker-compose.yml"

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# ensure_port_free <port> <service>: 127.0.0.1:<port> が LISTEN 中なら、それが自分の compose service でない限り止まる
# （共用 VPS：他サイトのポートを奪わない。Sprint 7 で 8080/8082 が使用中で 2 回やり直した）。
ensure_port_free() {
  local port=$1 service=$2
  if ss -tln | grep -qE "[]:]$port\s"; then
    if [ -n "$(docker compose -f "$COMPOSE" ps -q "$service" 2>/dev/null)" ]; then
      echo "127.0.0.1:$port は自分のコンテナ（$service）が使用中。再作成します"
    else
      echo "!! port $port は別のプロセスが LISTEN 中です。共用ホストの他サイトかもしれません。ss -tlnp で確認してから再実行" >&2
      exit 1
    fi
  fi
}

main() {
  case "$DOMAIN" in
    staging.*) ;;
    *) echo "!! '$DOMAIN' は staging. で始まりません。production の conf を書き換えないため拒否します" >&2; usage; exit 1 ;;
  esac

  step "0/8 前提確認（production が go-live.sh で構築済みであること）"
  if ! command -v docker >/dev/null 2>&1 || [ ! -d "$REPO_DIR/.git" ]; then
    echo "!! docker または $REPO_DIR が無い。先に production を構築する:  ssh -t \"\${VPS_SSH_HOST:-sakura-vps}\" 'sudo bash -s giinrecord.jp' < deploy/go-live.sh" >&2
    exit 1
  fi

  step "1/8 リポジトリ更新（compose と site.conf の staging 対応を取り込む）"
  git -C "$REPO_DIR" pull -q --ff-only

  step "2/8 staging の web root（deploy-staging.yml の rsync 先、所有者 ubuntu）"
  install -d -o ubuntu -g deploygroup -m 2775 "$SITE"

  step "3/8 ポート空き検査（127.0.0.1:$PORT）"
  ensure_port_free "$PORT" "$SERVICE"

  step "4/8 コンテナ起動（$SERVICE: 127.0.0.1:$PORT、$SITE を読み取り専用で配信。常に --force-recreate）"
  docker compose -f "$COMPOSE" up -d --wait --force-recreate
  curl -sI "http://127.0.0.1:$PORT/" | head -1 || true

  step "5/8 Cloudflare の IP allow-list（#163：staging は Cloudflare 経由のみ。snippet 生成＋週次 cron）"
  bash "$REPO_DIR/deploy/cloudflare-allowlist.sh" --install-cron

  step "6/8 ホスト nginx に $DOMAIN の proxy block（port $PORT）"
  bash "$REPO_DIR/deploy/vps-setup.sh" "$DOMAIN" "$PORT"

  step "7/8 TLS（DNS が $DOMAIN -> このホストを指している必要あり。証明書が既にあればスキップ）"
  if [ -f "$PREFIX/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    echo "certificate for $DOMAIN already exists; certbot skipped (no -0001 duplicate)"
  elif getent hosts "$DOMAIN" >/dev/null 2>&1; then
    certbot certonly --nginx -d "$DOMAIN" --deploy-hook 'systemctl reload nginx'
  else
    echo "!! $DOMAIN の DNS がまだ引けません。反映後に:  sudo certbot certonly --nginx -d $DOMAIN --deploy-hook 'systemctl reload nginx'  → このスクリプトを再実行"
  fi

  step "8/8 ホスト nginx を TLS + redirect block に（証明書があるときだけ書き換わる。冪等。#163 の Cloudflare gate 込み）"
  bash "$REPO_DIR/deploy/vps-setup.sh" "$DOMAIN" "$PORT"

  echo "done. 次は PO 側: GitHub Environment 'staging' に DEPLOY_* secrets → Actions の Deploy (staging) を実行 → https://$DOMAIN/ で <meta name=robots content=noindex> と robots.txt の Disallow: / を確認（Cloudflare Access のログイン後。docs/ops/staging-access.md）"
}

main "$@"
