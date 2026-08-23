#!/usr/bin/env bash
# www.DOMAIN の扱いを「ホストは proxy するだけ、リダイレクトはコンテナ」に揃える。root で1回：
#   sudo bash fix-www.sh gikailog.jp
# 1. sites-enabled/ に残った .bak を退避（nginx が読み込んでしまう）
# 2. certbot が sites-enabled/default に作った www.DOMAIN の server block を除去
# 3. gikailog.conf の server_name に www.DOMAIN を追加（80/443 とも）
# 4. /opt/gikailog を pull してコンテナを再作成（コンテナ側 site.conf に www→apex の 301 が入る）
set -euo pipefail
DOMAIN="${1:?usage: fix-www.sh <domain>}"
CONF=/etc/nginx/sites-enabled/gikailog.conf
DEF=/etc/nginx/sites-enabled/default
BAK_DIR=/var/backups/gikailog; mkdir -p "$BAK_DIR"
mv -f /etc/nginx/sites-enabled/default.bak.* "$BAK_DIR"/ 2>/dev/null || true
BAK="$BAK_DIR/default.bak.$(date +%s)"; cp -a "$DEF" "$BAK"; cp -a "$CONF" "$BAK_DIR/gikailog.conf.$(date +%s)"
python3 - "$DEF" "www.$DOMAIN" <<'PY'
import re,sys
p,name=sys.argv[1],sys.argv[2]; s=open(p).read(); res='';pos=0
while True:
    m=re.search(r'server\s*\{', s[pos:])
    if not m: res+=s[pos:]; break
    start=pos+m.start(); j=pos+m.end(); depth=1
    while depth and j<len(s):
        depth += 1 if s[j]=='{' else -1 if s[j]=='}' else 0; j+=1
    block=s[start:j]
    res += s[pos:start] if re.search(r'server_name\s+'+re.escape(name)+r'\s*;', block) else s[pos:j]
    pos=j
open(p,'w').write(res)
PY
sed -i -E "s/^(\s*server_name\s+)$DOMAIN;/\1$DOMAIN www.$DOMAIN;/" "$CONF"
grep -n "server_name" "$CONF"
if nginx -t; then systemctl reload nginx; else echo "nginx -t failed; restoring"; cp -a "$BAK" "$DEF"; cp -a "$BAK_DIR"/gikailog.conf.* "$CONF"; exit 1; fi
git -C /opt/gikailog pull -q --ff-only
docker compose -f /opt/gikailog/deploy/docker-compose.yml up -d --wait
curl -sI -H "Host: www.$DOMAIN" http://127.0.0.1:8081/ | head -2
echo "done: https://www.$DOMAIN -> https://$DOMAIN (301 from the container)"
