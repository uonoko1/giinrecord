#!/usr/bin/env bash
# 議会ログ staging（staging.gikailog.jp）の初回セットアップ（Issue #127）。root で 1 回、再実行可。
#   ssh -t "${VPS_SSH_HOST:-sakura-vps}" 'sudo bash -s' < deploy/staging-setup.sh            ← TTY が要る（certbot が対話）
#   ssh -t "${VPS_SSH_HOST:-sakura-vps}" 'sudo bash -s stg.example.test' < deploy/staging-setup.sh   （ドメインを変える場合）
# 前提：production が go-live.sh で構築済み（docker・/opt/gikailog・ホスト nginx の noip log_format）。
# 人間の作業はこれと「DNS A: staging.gikailog.jp → VPS（gikailog.jp と同じアドレス。リポジトリには書かない、#133）」だけ（README.md）。
# 順序：repo pull → staging web root → コンテナ（web-staging 8083。site.conf が変わっていれば web も再作成）→
#       ホスト nginx に staging の proxy block → certbot。production のパス・ポート・権限には触れない。
#   テスト: deploy/test/staging-setup.test.sh（STAGING_SETUP_PREFIX で全パスを一時ディレクトリ配下に、docker 等はスタブ）
set -euo pipefail

PREFIX="${STAGING_SETUP_PREFIX:-}"
DOMAIN="${1:-staging.gikailog.jp}"
PORT=8083
REPO_DIR="$PREFIX/opt/gikailog"
SITE="$PREFIX/var/www/gikailog/staging"

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

main() {
  step "0/5 前提確認（production が go-live.sh で構築済みであること）"
  if ! command -v docker >/dev/null 2>&1 || [ ! -d "$REPO_DIR/.git" ]; then
    echo "!! docker または $REPO_DIR が無い。先に production を構築する:  ssh -t \"\${VPS_SSH_HOST:-sakura-vps}\" 'sudo bash -s gikailog.jp' < deploy/go-live.sh" >&2
    exit 1
  fi

  step "1/5 リポジトリ更新（compose と site.conf の staging 対応を取り込む）"
  git -C "$REPO_DIR" pull -q --ff-only

  step "2/5 staging の web root（deploy-staging.yml の rsync 先、所有者 ubuntu）"
  install -d -o ubuntu -g deploygroup -m 2775 "$SITE"

  step "3/5 コンテナ起動（web-staging: 127.0.0.1:$PORT、$SITE を読み取り専用で配信）"
  docker compose -f "$REPO_DIR/deploy/docker-compose.yml" up -d --wait
  curl -sI "http://127.0.0.1:$PORT/" | head -1 || true

  step "4/5 ホスト nginx に $DOMAIN の proxy block（port $PORT）"
  bash "$REPO_DIR/deploy/vps-setup.sh" "$DOMAIN" "$PORT"

  step "5/5 TLS（DNS が $DOMAIN -> このホストを指している必要あり）"
  if getent hosts "$DOMAIN" >/dev/null 2>&1; then
    certbot --nginx -d "$DOMAIN" --redirect
  else
    echo "!! $DOMAIN の DNS がまだ引けません。反映後に:  sudo certbot --nginx -d $DOMAIN --redirect"
  fi

  echo "done. 次は PO 側: GitHub Environment 'staging' に DEPLOY_* secrets → Actions の Deploy (staging) を実行 → https://$DOMAIN/ で <meta name=robots content=noindex> と robots.txt の Disallow: / を確認"
}

main "$@"
