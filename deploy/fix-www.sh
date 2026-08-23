#!/usr/bin/env bash
# www.DOMAIN を DOMAIN へ 301 する。certbot が sites-enabled/default に作った www ブロックを取り除き、
# gikailog.conf の 443 に www 用のリダイレクトブロックを追加する。root で1回：  sudo bash fix-www.sh gikailog.jp
set -euo pipefail
DOMAIN="${1:?usage: fix-www.sh <domain>}"
CONF=/etc/nginx/sites-enabled/gikailog.conf
DEF=/etc/nginx/sites-enabled/default
BAK_DIR=/var/backups/gikailog; mkdir -p "$BAK_DIR"
# 以前の版が sites-enabled/ に置いた bak（nginx が読み込んでしまう）を退避
mv -f /etc/nginx/sites-enabled/default.bak.* "$BAK_DIR"/ 2>/dev/null || true
BAK="$BAK_DIR/default.bak.$(date +%s)"; cp -a "$DEF" "$BAK"
# default から「server_name www.DOMAIN」を含む server ブロックだけを除去
python3 - "$DEF" "www.$DOMAIN" <<'PY'
import re,sys
p,name=sys.argv[1],sys.argv[2]
s=open(p).read()
out=[];i=0
for m in re.finditer(r'server\s*\{', s):
    pass
# 波括弧で server ブロックを走査
res='';pos=0
while True:
    m=re.search(r'server\s*\{', s[pos:])
    if not m: res+=s[pos:]; break
    start=pos+m.start(); j=pos+m.end(); depth=1
    while depth and j<len(s):
        depth += 1 if s[j]=='{' else -1 if s[j]=='}' else 0; j+=1
    block=s[start:j]
    if re.search(r'server_name\s+'+re.escape(name)+r'\s*;', block):
        res+=s[pos:start]  # drop block
    else:
        res+=s[pos:j]
    pos=j
open(p,'w').write(res)
PY
grep -q "server_name www.$DOMAIN" "$CONF" || cat >> "$CONF" <<EOF2

# www -> apex (added by deploy/fix-www.sh)
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name www.$DOMAIN;
    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    return 301 https://$DOMAIN\$request_uri;
}
server {
    listen 80;
    listen [::]:80;
    server_name www.$DOMAIN;
    return 301 https://$DOMAIN\$request_uri;
}
EOF2
if nginx -t; then systemctl reload nginx; echo "www.$DOMAIN -> https://$DOMAIN (301)"; else echo "nginx -t failed; restoring default"; cp -a "$BAK" "$DEF"; exit 1; fi
