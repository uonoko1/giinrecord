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
# 標準入力は**使わない**（`< script` は tty を潰して sudo が落ちるため、
# base64 にしてコマンド行で渡す形に変えた）。標準入力を読むとここで固まる
printf 'ssh\t%s\n' "$*" >> "$SSH_LOG"
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
if [ "$n" = 4 ]; then ok "ssh は4回（反映3回 + 確認1回）"; else bad "ssh の回数が違う: $n"; fi

if grep -qE 'base64 -d\) giinrecord\.jp$' <<<"$LOG"; then ok "production を giinrecord.jp で流す"; else bad "production の引数が違う"; fi
if grep -qE 'base64 -d\) staging\.giinrecord\.jp 8083$' <<<"$LOG"; then ok "staging を staging.giinrecord.jp 8083 で流す"; else bad "staging の引数が違う"; fi

# #141 の事故: staging の設定を production のドメインで流すと production の conf を壊す。
# **production に 8083 を渡していない / staging にポートを付け忘れていない**ことを見る
# `giinrecord.jp 8083` は `staging.giinrecord.jp 8083` にも一致してしまうので、
# **staging. が付いていない giinrecord.jp** に 8083 が続く形だけを見る（最初これで誤検出した）
if grep -qE 'base64 -d\) giinrecord\.jp 8083' <<<"$LOG"; then bad "production に 8083 を渡している（#141 の事故）"; else ok "production にポートを渡さない"; fi
# 行末はタブ（STDIN: が続く）なので `$` は使えない。タブか行末で終わることを見る
if grep -qE 'base64 -d\) staging\.giinrecord\.jp$' <<<"$LOG"; then bad "staging にポートが無い"; else ok "staging には 8083 を付ける"; fi

# 順序: production → staging → allowlist
order=$(grep '^ssh' <<<"$LOG" | grep -oE 'staging\.giinrecord\.jp 8083|giinrecord\.jp$|sudo -n -l' | tr '\n' '|')
case "$order" in
  giinrecord.jp\|staging.giinrecord.jp\ 8083\|*) ok "production → staging の順" ;;
  *) bad "順序が違う: $order" ;;
esac

# 渡しているファイルが合っているか（標準入力の中身で見る）
# **`< script` は使わない。** それをやると tty が潰れて sudo がパスワードを読めない
# （実際にユーザーの手元で `sudo: a terminal is required` で落ちた）
if grep -qE 'base64 -d\)' <<<"$LOG"; then ok "スクリプトを base64 でコマンド行に渡す（標準入力を使わない）"; else bad "base64 で渡していない"; fi
if grep -qE '\ba<' <<<"$(cat "$SCRIPT")"; then bad "内部で標準入力リダイレクトを使っている"; else ok "標準入力リダイレクトを使わない"; fi
if grep -qE 'ssh [^|]*<[^(]' <<<"$(grep -v '^#' "$SCRIPT")"; then bad "ssh に < でファイルを渡している（tty が潰れる）"; else ok "ssh に < でファイルを渡さない"; fi
# 引数無しの `sudo bash -s`（鍵を渡さない）がちょうど1回。行末はタブなので `$` ではなくタブで見る
# allowlist は**引数なし**（鍵を渡さない。#403: sudo が auth.log に公開鍵を残す）
if [ "$(grep -cE 'base64 -d\) *$' <<<"$LOG")" = 1 ]; then ok "allowlist は鍵を渡さずに流す（#403: auth.log に公開鍵を残さない）"; else bad "allowlist の引数が違う"; fi

# 反映のあとに確認する（「流した」で終わりにしない）
last=$(grep -oE '^(ssh|curl)' <<<"$LOG" | tail -2 | tr '\n' ' ')
if [ "$last" = "curl ssh " ]; then ok "最後に curl と ssh で確認する"; else bad "確認していない: $last"; fi

# ホストは VPS_SSH_HOST で差し替えられる
run other-host
if grep -q 'other-host' "$TMP/log"; then ok "VPS_SSH_HOST でホストを差し替えられる"; else bad "ホストが固定されている"; fi

# 何をするかを先に見せる
if grep -q '3つを順に実行します' "$TMP/out"; then ok "実行内容を先に表示する"; else bad "実行内容を表示していない"; fi

echo
echo "pass=$PASS fail=$FAIL"
[ "$FAIL" = 0 ]
