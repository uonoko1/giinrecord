#!/usr/bin/env bash
# 議員レコード 本番切替（root で実行。再実行可）。共用 VPS の他サイトには触れない。
#   ssh -t "${VPS_SSH_HOST:-sakura-vps}" 'sudo bash -s giinrecord.jp' < deploy/go-live.sh     ← TTY が要る（certbot が対話）
# 順序が重要：旧名の移行 → Docker → ポート空き検査（ss -tln）→ コンテナ起動（8081、常に --force-recreate）→
#             ホスト nginx を proxy に切替 → certbot certonly（証明書が既にあればスキップ）→ ホスト nginx を TLS + redirect に → 計測。
# staging.* のドメインは拒否（staging は deploy/staging-setup.sh、#141）。
#
# 移行（改名 gikailog → giinrecord）: 旧名で作られた VPS 上の成果物（パス・nginx conf・cron・compose project）が
# 残っていれば新名へ mv／削除してから進む。無ければ何もしない（冪等）。
# 前回の seiji-kiroku → gikailog（Issue #119）と同じ手口。seiji-kiroku 世代は gikailog 世代への移行が済んでいるので
# 1 段だけ（gikailog → giinrecord）を扱う。
#   migrate_legacy() が扱えないもの（手作業。docs/ops/deploy.md「改名の移行」に手順）:
#     - ~ubuntu/.ssh/authorized_keys の rrsync パスと鍵コメント（deploy/ops-user-setup.sh の grep が新文字列にしか当たらない）
#     - certbot 管理の本番 nginx conf（vps-setup.sh は書き換えない設計）
#     - Cloudflare ダッシュボードの Access Application 名 / Service Token 名
#     - OS ユーザー gikaiops → giinops
#   /etc/gikailog/ は monitor.token（fine-grained PAT）ごと mv する。移行後に権限と存在を人が確認する。
#   sites-{available,enabled}/gikailog{,-staging}.conf は**消さない**（旧ドメインの 301。migrate_legacy() 内に理由）。
#   テスト: deploy/test/go-live.test.sh（GO_LIVE_PREFIX で全パスを一時ディレクトリ配下に、docker 等はスタブ）
set -euo pipefail

# 全パスの接頭辞（テスト専用。本番では空）
PREFIX="${GO_LIVE_PREFIX:-}"
OLD=gikailog
NEW=giinrecord
# GitHub リポジトリ名。VPS のパス名（$NEW）とは別の概念なので変数を分ける（両者はたまたま同じ値）。
REPO_SLUG="uonoko1/giinrecord"
REPO_DIR="$PREFIX/opt/$NEW"
SITE="$PREFIX/var/www/$NEW/site"
COMPOSE="$REPO_DIR/deploy/docker-compose.yml"
PORT=8081
SERVICE=web

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# ensure_port_free <port> <service>: 127.0.0.1:<port> が LISTEN 中なら、それが自分の compose service でない限り止まる
# （共用 VPS：他サイトのポートを奪わない。Sprint 7 で 8080/8082 が使用中で 2 回やり直した）。staging-setup.sh と同じ。
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
  # 1. 中身を持ち越すもの（mv）。新名が既にあれば触らず知らせる（move_if_legacy）。
  move_if_legacy "$PREFIX/opt/$OLD" "$PREFIX/opt/$NEW"                                    # git checkout（deploy/ のみ使用）
  move_if_legacy "$PREFIX/var/www/$OLD" "$PREFIX/var/www/$NEW"                            # site / staging の配信ルート
  move_if_legacy "$PREFIX/usr/local/lib/$OLD-analytics" "$PREFIX/usr/local/lib/$NEW-analytics"
  move_if_legacy "$PREFIX/usr/local/lib/$OLD-monitor" "$PREFIX/usr/local/lib/$NEW-monitor"
  move_if_legacy "$PREFIX/usr/local/lib/$OLD-cloudflare-allowlist.sh" "$PREFIX/usr/local/lib/$NEW-cloudflare-allowlist.sh"
  # /etc/<name>/ には monitor.token（fine-grained PAT）が入っている。中身ごと持ち越す（消すとトークンを失い、
  # health.sh がフェイルソフトして「無言で監視が効かない」状態になる）。
  move_if_legacy "$PREFIX/etc/$OLD" "$PREFIX/etc/$NEW"
  # 監視の open-issue 状態（issue.<check>）。移さないと復旧時に既存 Issue を close できず重複する。
  move_if_legacy "$PREFIX/var/lib/$OLD-monitor" "$PREFIX/var/lib/$NEW-monitor"
  # 実行ログ（監視・集計）。追記の連続性のために持ち越す。
  move_if_legacy "$PREFIX/var/log/$OLD-monitor.log" "$PREFIX/var/log/$NEW-monitor.log"
  move_if_legacy "$PREFIX/var/log/$OLD-analytics.log" "$PREFIX/var/log/$NEW-analytics.log"
  # nginx のアクセス／エラーログ。現行ファイルだけ mv する（logrotate の過去世代 .1 / .2.gz … は旧名のまま
  # 14 日で自然に消える。daily.sh は前日分を新名のログから読むので、改名日をまたぐ 1 日分は欠測しうる）。
  move_if_legacy "$PREFIX/var/log/nginx/$OLD.access.log" "$PREFIX/var/log/nginx/$NEW.access.log"
  move_if_legacy "$PREFIX/var/log/nginx/$OLD.error.log" "$PREFIX/var/log/nginx/$NEW.error.log"
  move_if_legacy "$PREFIX/var/log/nginx/$OLD-staging.access.log" "$PREFIX/var/log/nginx/$NEW-staging.access.log"
  move_if_legacy "$PREFIX/var/log/nginx/$OLD-staging.error.log" "$PREFIX/var/log/nginx/$NEW-staging.error.log"

  # 2. 新名で作り直されるもの（rm）。残すと新旧が並んで壊れる。
  # sites-{available,enabled}/gikailog{,-staging}.conf は消さない。ファイル名が旧称なだけで、中身は
  # 旧ドメイン gikailog.jp / staging.gikailog.jp を新ドメインへ 301 する現役の設定
  # （2026-08-26 に VPS 実測: 4 つとも sites-enabled にあり、`curl -sSI https://gikailog.jp/members/` は
  # giinrecord.jp へ 301 を返す）。新名の giinrecord{,-staging}.conf とは server_name が違うので重複しない。
  # #192 で「旧ドメインは 1 年維持」と決めた（docs/sprints/sprint-11.md、2027-08 まで）。消すと旧 URL が死ぬ。
  # vps-setup.sh は新名の conf だけを書き、直後に nginx -t → reload するので、ここでは reload しない。
  #
  # 以下はドメインと無関係な名前の重複なので削除してよい。
  # conf.d の log_format は新旧が並ぶと nginx -t が "duplicate log_format" で落ちる。
  remove_if_legacy "$PREFIX/etc/nginx/conf.d/$OLD-noip-log.conf"
  # Cloudflare allowlist snippet。旧名は誰も include しない死んだファイルになる。新名は
  # deploy/cloudflare-allowlist.sh が生成する（staging を建てる前に走らせる。docs/ops/staging-access.md）。
  remove_if_legacy "$PREFIX/etc/nginx/snippets/$OLD-cloudflare-allow.conf"
  # 旧 cron（新名は各 setup スクリプトが書き直す）。残すと新旧が同時に走り、
  # 監視 Issue の二重オープン・集計の二重実行になる。
  remove_if_legacy "$PREFIX/etc/cron.d/$OLD-analytics"
  remove_if_legacy "$PREFIX/etc/cron.d/$OLD-monitor"
  remove_if_legacy "$PREFIX/etc/cron.d/$OLD-cloudflare-allowlist"

  # 3. 旧 compose project（project name = コンテナ名・ネットワーク名の接頭辞）。
  # 落とさないと旧コンテナが 127.0.0.1:8081 / 8083 を掴んだままで、ensure_port_free が exit 1 する。
  if command -v docker >/dev/null 2>&1 && docker network ls --format '{{.Name}}' 2>/dev/null | grep -qx "${OLD}_default"; then
    echo "migrate: docker compose project $OLD -> down"
    docker compose -p "$OLD" down --remove-orphans || echo "!! could not remove compose project $OLD; continuing" >&2
  fi

  # 4. このスクリプトでは扱えないもの（人が行う）。毎回出す（冪等な確認用チェックリスト）。
  if [ -e "$PREFIX/opt/$NEW" ] || [ -e "$PREFIX/var/www/$NEW" ]; then
    cat >&2 <<MANUAL
migrate: 手作業が残っています（docs/ops/deploy.md「改名の移行（gikailog → giinrecord）」）:
  - ~ubuntu/.ssh/authorized_keys: command="/usr/bin/rrsync /var/www/$OLD" と鍵コメント "$OLD github-actions deploy"
    を新名に直す（直さないと deploy の rsync が rrsync に拒否される）
  - 本番の nginx conf は certbot 管理のため vps-setup.sh が書き換えない。sites-available/$NEW.conf への
    改名と certbot の管理対象名の整合は手作業
  - Cloudflare ダッシュボード: Access Application "$OLD staging" / Service Token "$OLD-monitor" の名前
  - OS ユーザー gikaiops → giinops（作成 → 鍵移行 → 確認 → 旧ユーザー削除の 4 段）
MANUAL
  fi
}

main() {
  local domain="${1:?usage: go-live.sh <domain>   (production apex, e.g. giinrecord.jp; staging → deploy/staging-setup.sh)}"
  case "$domain" in
    staging.*) echo "!! '$domain' は staging です。production の go-live ではなく deploy/staging-setup.sh を使う（本番 conf を書き換えないため拒否）" >&2; exit 1 ;;
  esac

  step "0/8 旧名（$OLD）からの移行（残っていれば）"
  migrate_legacy

  step "1/8 Docker Engine + compose plugin（未導入なら公式手順で導入）"
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

  step "2/8 リポジトリ（compose ファイル用）を $REPO_DIR に取得"
  if [ -d "$REPO_DIR/.git" ]; then
    git -C "$REPO_DIR" remote set-url origin "https://github.com/$REPO_SLUG.git"
    git -C "$REPO_DIR" pull -q --ff-only
  else
    git clone -q "https://github.com/$REPO_SLUG.git" "$REPO_DIR"
  fi

  step "3/8 ポート空き検査（127.0.0.1:$PORT）"
  install -d -o ubuntu -g deploygroup -m 2775 "$SITE"
  ensure_port_free "$PORT" "$SERVICE"

  step "4/8 web コンテナ起動（127.0.0.1:$PORT、$SITE を読み取り専用で配信。常に --force-recreate: bind mount の site.conf は pull で inode が変わる）"
  docker compose -f "$COMPOSE" up -d --wait --force-recreate
  curl -sI "http://127.0.0.1:$PORT/" | head -1 || true

  step "5/8 ホスト nginx を proxy_pass に切替（$domain）"
  bash "$REPO_DIR/deploy/vps-setup.sh" "$domain"

  step "6/8 TLS（DNS が $domain -> このホストを指している必要あり。証明書が既にあればスキップ）"
  if [ -f "$PREFIX/etc/letsencrypt/live/$domain/fullchain.pem" ]; then
    echo "certificate for $domain already exists; certbot skipped (no -0001 duplicate)"
  elif getent hosts "$domain" >/dev/null; then
    certbot certonly --nginx -d "$domain" -d "www.$domain" --deploy-hook 'systemctl reload nginx'
  else
    echo "!! $domain の DNS がまだ引けません。反映後に:  sudo certbot certonly --nginx -d $domain -d www.$domain --deploy-hook 'systemctl reload nginx'  → このスクリプトを再実行"
  fi

  step "7/8 ホスト nginx を TLS + redirect block に（証明書があるときだけ書き換わる。certbot 管理の conf はそのまま。冪等）"
  bash "$REPO_DIR/deploy/vps-setup.sh" "$domain"

  step "8/8 計測（IP を記録しない nginx ログ + 日次集計 cron）"
  bash "$REPO_DIR/deploy/analytics/vps-analytics-setup.sh" || echo "!! 計測セットアップに失敗（後で単独実行可）"

  step "確認"
  curl -sI "https://$domain/" 2>/dev/null | head -1 || true
  echo "done. 次は PO 側: GitHub Actions の Deploy を実行 → https://$domain/ で title に『議員レコード』、sitemap の <loc> が https://$domain/ で始まることを確認"
}

# テストからは GO_LIVE_NO_MAIN=1 で source して関数だけ使う
if [ -z "${GO_LIVE_NO_MAIN:-}" ]; then main "$@"; fi
