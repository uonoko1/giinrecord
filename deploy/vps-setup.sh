#!/usr/bin/env bash
# One-time VPS setup. Run as: ssh sakura-vps 'sudo bash -s seiji-kiroku.daichisakai.net' < deploy/vps-setup.sh
set -euo pipefail
DOMAIN="${1:?usage: vps-setup.sh <domain>}"
DEPLOY_USER=ubuntu

install -d -o "$DEPLOY_USER" -g deploygroup -m 2775 /var/www/seiji-kiroku /var/www/seiji-kiroku/site
sed "s/DOMAIN/$DOMAIN/" > /etc/nginx/sites-available/seiji-kiroku.conf <<'CONF'
# /etc/nginx/sites-available/seiji-kiroku.conf  (symlink into sites-enabled)
# Static files only. certbot adds the 443 block: sudo certbot --nginx -d DOMAIN
server {
    listen 80;
    listen [::]:80;
    server_name DOMAIN;
    root /var/www/seiji-kiroku/site;
    index index.html;

    # Pre-rendered routes: /members/xxx -> /members/xxx/index.html ; unknown -> SPA fallback
    location / {
        try_files $uri $uri/index.html /__spa-fallback.html;
    }
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
    location /data/ {
        add_header Cache-Control "public, max-age=3600";
    }

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    add_header Content-Security-Policy "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; connect-src 'self'" always;
}
CONF
ln -sfn /etc/nginx/sites-available/seiji-kiroku.conf /etc/nginx/sites-enabled/seiji-kiroku.conf
nginx -t && systemctl reload nginx
echo "nginx ready for $DOMAIN. Next (after DNS A record -> this host): sudo certbot --nginx -d $DOMAIN --redirect"
