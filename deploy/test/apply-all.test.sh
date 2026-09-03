#!/usr/bin/env bash
# Tests for deploy/apply-all.sh (Issue 398)。
#
# 守りたい性質は「**3本を正しい引数で、正しい順に流す**」こと。
# 1本でも落ちると、本番と staging とで設定がずれる（#141: staging の設定を production の
# ドメインで流して production の conf を壊した事故が実際にある）。
#
# ssh / curl はスタブ。実ホストには一切触れない。
#   bash deploy/test/apply-all.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../apply-all.sh"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ok   - $1"; }
bad(){ FAIL=$((FAIL+1)); echo "  FAIL - $1"; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"; mkdir -p "$BIN"
# ssh: 呼び出しを記録し、標準入力の1行目（どのスクリプトが渡されたか）も残す
cat > "$BIN/ssh" <<'STUB'
#!/usr/bin/env bash
# 標準入力がリダイレクトされているときだけ読む（確認用の `ssh ... 'sudo -n -l'` は
# 標準入力を渡さないので、無条件に読むとそこで固まる。実際に固まった）
first=""
if [ ! -t 0 ]; then first=$(head -n 1 2>/dev/null || true); fi
printf 'ssh\t%s\tSTDIN:%s\n' "$*" "${first:0:40}" >> "$SSH_LOG"
STUB
cat > "$BIN/curl" <<'STUB'
#!/usr/bin/env bash
printf 'curl\t%s\n' "$*" >> "$SSH_LOG"
echo "Server: nginx"
STUB
chmod +x "$BIN/ssh" "$BIN/curl"

run() { : > "$TMP/log"; PATH="$BIN:$PATH" SSH_LOG="$TMP/log" VPS_SSH_HOST="${1:-test-host}" bash "$SCRIPT" >"$TMP/out" 2>&1; }

run
LOG=$(cat "$TMP/log")

# 3本とも流れているか
n=$(grep -c '^ssh' <<<"$LOG" || true)
[ "$n" = 4 ] && ok "ssh は4回（反映3回 + 確認1回）" || bad "ssh の回数が違う: $n"

grep -q 'sudo bash -s giinrecord.jp' <<<"$LOG" && ok "production を giinrecord.jp で流す" || bad "production の引数が違う"
grep -q 'sudo bash -s staging.giinrecord.jp 8083' <<<"$LOG" && ok "staging を staging.giinrecord.jp 8083 で流す" || bad "staging の引数が違う"

# #141 の事故: staging の設定を production のドメインで流すと production の conf を壊す。
# **production に 8083 を渡していない / staging にポートを付け忘れていない**ことを見る
# `giinrecord.jp 8083` は `staging.giinrecord.jp 8083` にも一致してしまうので、
# **staging. が付いていない giinrecord.jp** に 8083 が続く形だけを見る（最初これで誤検出した）
grep -qE 'bash -s giinrecord\.jp 8083' <<<"$LOG" && bad "production に 8083 を渡している（#141 の事故）" || ok "production にポートを渡さない"
# 行末はタブ（STDIN: が続く）なので `$` は使えない。タブか行末で終わることを見る
grep -qE 'bash -s staging\.giinrecord\.jp(\t|$)' <<<"$LOG" && bad "staging にポートが無い" || ok "staging には 8083 を付ける"

# 順序: production → staging → allowlist
order=$(grep '^ssh' <<<"$LOG" | grep -oE 'giinrecord\.jp|staging\.giinrecord\.jp 8083|sudo bash -s$|sudo -n -l' | tr '\n' '|')
case "$order" in
  giinrecord.jp\|staging.giinrecord.jp\ 8083\|*) ok "production → staging の順" ;;
  *) bad "順序が違う: $order" ;;
esac

# 渡しているファイルが合っているか（標準入力の中身で見る）
grep -q 'STDIN:#!/usr/bin/env bash' <<<"$LOG" && ok "スクリプトを標準入力で渡している" || bad "標準入力にスクリプトが渡っていない"
# 引数無しの `sudo bash -s`（鍵を渡さない）がちょうど1回。行末はタブなので `$` ではなくタブで見る
[ "$(grep -cF $'sudo bash -s\tSTDIN' <<<"$LOG")" = 1 ] && ok "allowlist は鍵を渡さずに流す（#403: auth.log に公開鍵を残さない）" || bad "allowlist の引数が違う"

# 反映のあとに確認する（「流した」で終わりにしない）
last=$(grep -oE '^(ssh|curl)' <<<"$LOG" | tail -2 | tr '\n' ' ')
[ "$last" = "curl ssh " ] && ok "最後に curl と ssh で確認する" || bad "確認していない: $last"

# ホストは VPS_SSH_HOST で差し替えられる
run other-host
grep -q 'other-host' "$TMP/log" && ok "VPS_SSH_HOST でホストを差し替えられる" || bad "ホストが固定されている"

# 何をするかを先に見せる
grep -q '3つを順に実行します' "$TMP/out" && ok "実行内容を先に表示する" || bad "実行内容を表示していない"

echo
echo "pass=$PASS fail=$FAIL"
[ "$FAIL" = 0 ]
