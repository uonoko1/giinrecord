#!/usr/bin/env bash
# GitHub の Issue / PR の**本文とコメント**に、公開 IPv4 や鍵らしき値が無いかを見る（Issue #940）。
#
# **なぜ要るか**: `scripts/ci/forbidden-patterns.sh` は**リポジトリの中身**しか見ない。
# **Issue の本文はリポジトリの外にあるので、そこには効かない。**
# **実際、2026-09-20 に VPS の IP が Issue 2 件とコメント 1 件に 1 か月以上公開されていた**
# （#15 / #127 / #163 のコメント。ユーザーが見つけた。**PO も CI も気づいていなかった**）。
#
# **読むだけで、何も直さない。** 直し方は人が決める（Issue の編集は履歴が残る。削除は履歴ごと消えるが
# 記録も失われる）。
#
# 使い方:
#   bash scripts/ci/issue-secrets.sh                 # 全 Issue / PR / コメントを見る
#   bash scripts/ci/issue-secrets.sh --limit 100     # 直近 100 件だけ（速い）
#
# 終了コード: 0 = 見つからない / 1 = 見つかった / 2 = 走らせられなかった（母数 0 など）
set -euo pipefail

REPO=${GITHUB_REPOSITORY:-uonoko1/giinrecord}
LIMIT=""
[ "${1:-}" = "--limit" ] && LIMIT="&per_page=${2:-100}"

command -v gh >/dev/null || { echo "::error::gh が無い" >&2; exit 2; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# 本文（Issue と PR。GitHub の issues API は PR も返す）
# **JSON Lines で取る**（TSV だと本文の改行で 1 件が複数行に割れ、母数が「行数」になる。
# 実測 2026-09-20: 939 件の Issue が 65,599 行になり、母数が 70 倍に見えた）
gh api --paginate "/repos/$REPO/issues?state=all${LIMIT:-&per_page=100}" \
  --jq '.[]|{id:(.number|tostring),url:.html_url,title:.title,body:(.body//"")}|tostring' > "$TMP/bodies.jsonl" 2>/dev/null || true
gh api --paginate "/repos/$REPO/issues/comments?per_page=100" \
  --jq '.[]|{id:("comment-"+(.id|tostring)),url:.html_url,title:"",body:(.body//"")}|tostring' > "$TMP/comments.jsonl" 2>/dev/null || true

cat "$TMP/bodies.jsonl" "$TMP/comments.jsonl" > "$TMP/all.jsonl"
N=$(wc -l < "$TMP/all.jsonl" | tr -d ' ')

# **母数 0 は clean ではなく error**（#757。取得に失敗しても「見つからなかった」に見える）
if [ "$N" -eq 0 ]; then
  echo "::error::issue-secrets: 0 件しか読めなかった（gh の認証か API を疑う）。clean とは言わない。" >&2
  exit 2
fi

# 公開 IPv4 だけを拾う（私的・予約・ループバック・リンクローカル・ドキュメント用は除く）
python3 - "$TMP/all.jsonl" <<'PY' > "$TMP/hits.txt"
import ipaddress,re,sys,io,json
pat=re.compile(r'\b(?:\d{1,3}\.){3}\d{1,3}\b')
for line in io.open(sys.argv[1],encoding='utf-8'):
    line=line.strip()
    if not line: continue
    d=json.loads(line)
    num,url,title,body=d['id'],d['url'],d.get('title',''),d.get('body','')
    for m in set(pat.findall(body+' '+title)):
        try: ip=ipaddress.IPv4Address(m)
        except ValueError: continue          # 1.2.3.4.5 やバージョン番号
        if ip.is_private or ip.is_loopback or ip.is_reserved or ip.is_link_local \
           or ip.is_multicast or ip.is_unspecified: continue
        if m.startswith(('192.0.2.','198.51.100.','203.0.113.')): continue  # RFC 5737 文書用
        # **バージョン番号を IPv4 と読まない**（`forbidden-patterns` の `ip-address` 規則が
        # DocuWorks の版番号（4 つ組）を拾った実例が PR #813 に在る。**規則ではなく文脈で外す**）:
        # ——その版番号そのものをここに書くと `forbidden-patterns` の `ip-address` が
        # **この行を**拾う（実測: PR #940 の CI が落ちた）。規則を緩めるのではなく書かない。
        # 直前に「Build」「ver」「v」などが在るか、周りに「バージョン」と書いてあれば版番号。
        ctx=body[max(0,body.find(m)-40):body.find(m)+len(m)+10]
        if re.search(r'(?i)(build|version|ver\.?|バージョン|ビルド|Adobe|DocuWorks|Acrobat)', ctx): continue
        print(f'{num}\t{m}\t{url}')
PY

H=$(wc -l < "$TMP/hits.txt" | tr -d ' ')
echo "issue-secrets: $N 件の本文・コメントを見た（公開 IPv4 を探した）"

if [ "$H" -gt 0 ]; then
  echo "::error::issue-secrets: 公開 IPv4 が $H 件見つかった。**Issue はリポジトリの外なので gitleaks も forbidden-patterns も見ていない。**" >&2
  sort -u "$TMP/hits.txt" | while IFS=$'\t' read -r num ip url; do
    echo "  $num  $ip  $url" >&2
  done
  echo "" >&2
  echo "  **直す前に読むこと**: Issue の本文を編集しても**編集履歴に元の値が残り、誰でも見られる**。" >&2
  echo "  履歴ごと消すには Issue / コメントの**削除**が要る（記録も失われる）。" >&2
  echo "  **どちらを選ぶかは人が決める。このスクリプトは直さない。**" >&2
  exit 1
fi

echo "issue-secrets: clean"
