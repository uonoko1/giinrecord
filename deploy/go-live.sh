#!/usr/bin/env bash
# 議会ログ 本番切替（root で実行。再実行可）。共用 VPS の他サイトには触れない。
#   ssh -t sakura-vps 'sudo bash -s gikailog.jp' < deploy/go-live.sh     ← TTY が要る（certbot が対話）
# 順序が重要：旧名の移行 → Docker → コンテナ起動（8081）→ ホスト nginx を proxy に切替 → certbot → 計測。
#
# 移行（Issue #119、リポジトリ改名 seiji-kiroku → gikailog）: 旧パス・旧 nginx conf・旧 compose project が
# 残っていれば新名へ mv／削除してから進む。無ければ何もしない（冪等）。
#   テスト: deploy/test/go-live.test.sh（GO_LIVE_PREFIX で全パスを一時ディレクトリ配下に、docker 等はスタブ）
set -euo pipefail

# 全パスの接頭辞（テスト専用。本番では空）
PREFIX="${GO_LIVE_PREFIX:-}"
OLD=seiji-kiroku
NEW=gikailog
REPO_DIR="$PREFIX/opt/$NEW"
SITE="$PREFIX/var/www/$NEW/site"

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# move_if_legacy <old> <new>: 旧が在って新が無ければ mv。両方在れば触らずに知らせる（人が見る）。
move_if_legacy() {
  local old=$1 new=$2
  if [ -e "$old" ] && [ ! -e "$new" ]; then
    echo "migrate: $old -> $new"
    mv "$old" "$new"
  elif [ -e "$old" ] && [ -e "$new" ]; then
    echo "!! both $old and $new exist; leaving $old alone — merge or delete it by hand" >&2
  fi
}

# remove_if_legacy <path>: 旧ファイル（シンボリックリンク含む）があれば削除
remove_if_legacy() {
  if [ -e "$1" ] || [ -L "$1" ]; then
    echo "migrate: rm $1"
    rm -f "$1"
  fi
}

migrate_legacy() {
  move_if_legacy "$PREFIX/opt/$OLD" "$PREFIX/opt/$NEW"
  move_if_legacy "$PREFIX/var/www/$OLD" "$PREFIX/var/www/$NEW"
  move_if_legacy "$PREFIX/usr/local/lib/$OLD-analytics" "$PREFIX/usr/local/lib/$NEW-analytics"

  # 旧ホスト nginx（Sprint 1 の直配信 block と log_format）。vps-setup.sh が直後に新 conf を書いて nginx -t →
  # reload するので、ここでは reload しない。conf.d の log_format は新旧が並ぶと "duplicate log_format" で落ちる。
  remove_if_legacy "$PREFIX/etc/nginx/sites-enabled/$OLD.conf"
  remove_if_legacy "$PREFIX/etc/nginx/sites-available/$OLD.conf"
  remove_if_legacy "$PREFIX/etc/nginx/conf.d/$OLD-noip-log.conf"
  # 旧 cron（vps-analytics-setup.sh が新名で書き直す）
  remove_if_legacy "$PREFIX/etc/cron.d/$OLD-analytics"

  # 旧 compose project（project name = コンテナ名・ネットワーク名の接頭辞）
  if command -v docker >/dev/null 2>&1 && docker network ls --format '{{.Name}}' 2>/dev/null | grep -qx "${OLD}_default"; then
    echo "migrate: docker compose project $OLD -> down"
    docker compose -p "$OLD" down --remove-orphans || echo "!! could not remove compose project $OLD; continuing" >&2
  fi
}

main() {
  local domain="${1:?usage: go-live.sh <domain>}"

  step "0/6 旧名（$OLD）からの移行（残っていれば）"
  migrate_legacy

  step "1/6 Docker Engine + compose plugin（未導入なら公式手順で導入）"
  if ! command -v docker >/dev/null; then
    apt-get update -qq && apt-get install -y -qq ca-certificates curl
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
    apt-get update -qq && apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  fi
  docker --version; docker compose version
  # deploy ユーザーには docker 権限を与えない（docker グループ = root 相当）
  if id -nG ubuntu | grep -qw docker; then gpasswd -d ubuntu docker; fi

  step "2/6 リポジトリ（compose ファイル用）を $REPO_DIR に取得"
  if [ -d "$REPO_DIR/.git" ]; then
    git -C "$REPO_DIR" remote set-url origin "https://github.com/uonoko1/$NEW.git"
    git -C "$REPO_DIR" pull -q --ff-only
  else
    git clone -q "https://github.com/uonoko1/$NEW.git" "$REPO_DIR"
  fi

  step "3/6 web コンテナ起動（127.0.0.1:8081、$SITE を読み取り専用で配信）"
  install -d -o ubuntu -g deploygroup -m 2775 "$SITE"
  docker compose -f "$REPO_DIR/deploy/docker-compose.yml" up -d --wait
  curl -sI http://127.0.0.1:8081/ | head -1

  step "4/6 ホスト nginx を proxy_pass に切替（$domain）"
  bash "$REPO_DIR/deploy/vps-setup.sh" "$domain"

  step "5/6 TLS（DNS が $domain -> このホストを指している必要あり）"
  if getent hosts "$domain" >/dev/null; then
    certbot --nginx -d "$domain" -d "www.$domain" --redirect
  else
    echo "!! $domain の DNS がまだ引けません。反映後に:  sudo certbot --nginx -d $domain -d www.$domain --redirect"
  fi

  step "6/6 計測（IP を記録しない nginx ログ + 日次集計 cron）"
  bash "$REPO_DIR/deploy/analytics/vps-analytics-setup.sh" || echo "!! 計測セットアップに失敗（後で単独実行可）"

  step "確認"
  curl -sI "https://$domain/" 2>/dev/null | head -1 || true
  echo "done. 次は PO 側: GitHub Actions の Deploy を実行 → https://$domain/ で title に『議会ログ』、sitemap の <loc> が https://$domain/ で始まることを確認"
}

# テストからは GO_LIVE_NO_MAIN=1 で source して関数だけ使う
if [ -z "${GO_LIVE_NO_MAIN:-}" ]; then main "$@"; fi
