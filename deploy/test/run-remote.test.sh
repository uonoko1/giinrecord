#!/usr/bin/env bash
# Tests for deploy/run-remote.sh (Issue 419)。ssh はスタブ。実ホストには触れない。
#   bash deploy/test/run-remote.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../run-remote.sh"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ok   - $1"; }
bad(){ FAIL=$((FAIL+1)); echo "  FAIL - $1"; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"; mkdir -p "$BIN"
# ssh: 引数を記録し、**標準入力が tty かどうか**も記録する（これが守りたい性質そのもの）
cat > "$BIN/ssh" <<'STUB'
#!/usr/bin/env bash
tty=no; [ -t 0 ] && tty=yes
printf 'ssh\t%s\tSTDIN_TTY=%s\n' "$*" "$tty" >> "$SSH_LOG"
STUB
chmod +x "$BIN/ssh"

# 引用符と空白を含むスクリプト（base64 にしないと壊れる）
printf '#!/usr/bin/env bash\necho "it'"'"'s a test" with spaces\n' > "$TMP/s.sh"


# script を渡すと ssh -t で sudo bash <(...) の形で実行する
: > "$TMP/log"; PATH="$BIN:$PATH" SSH_LOG="$TMP/log" VPS_SSH_HOST=h bash "$SCRIPT" "$TMP/s.sh" giinrecord.jp 8083 >/dev/null 2>&1
LOG=$(cat "$TMP/log")
# **プロセス置換は sudo の内側**。外側（`sudo bash <(…)`）だと sudo が fd を閉じて
# `bash: /dev/fd/63: No such file or directory` になる（ユーザーの手元で実際に落ちた）
if grep -q "^ssh	-t h sudo bash -c 'bash <(echo " <<<"$LOG"; then ok "プロセス置換を sudo の内側で作る（sudo bash -c 'bash <(…)'）"; else bad "形が違う: $LOG"; fi
if grep -qE "^ssh	-t h sudo bash <\(" <<<"$LOG"; then bad "プロセス置換が sudo の外側にある（fd が閉じる）"; else ok "sudo の外側でプロセス置換していない"; fi
if grep -q '_ giinrecord.jp 8083' <<<"$LOG"; then ok "引数を \$@ 経由で末尾に渡す"; else bad "引数が渡っていない"; fi
# **標準入力を使っていない**（< script が無い）
if grep -qE '<[^(]' <<<"$LOG"; then bad "標準入力リダイレクトを使っている"; else ok "標準入力リダイレクトを使わない（tty を潰さない）"; fi
# base64 を戻すと元のスクリプトになる（引用符も空白も壊れない）
b64=$(grep -oE 'echo [A-Za-z0-9+/=]+' <<<"$LOG" | head -1 | cut -d' ' -f2)
if [ "$(base64 -d <<<"$b64")" = "$(cat "$TMP/s.sh")" ]; then ok "base64 を戻すと元のスクリプト（引用符・空白が壊れない）"; else bad "base64 の中身が違う"; fi

# 引数に空白や記号が入っても壊れない（%q で引用）
: > "$TMP/log"; PATH="$BIN:$PATH" SSH_LOG="$TMP/log" VPS_SSH_HOST=h bash "$SCRIPT" "$TMP/s.sh" "a b" 'c$d' >/dev/null 2>&1
# shellcheck disable=SC2016  # 展開させない: %q が c$d を c\$d に引用した**その文字列**を探している
if grep -qF "a\\ b" "$TMP/log" && grep -qF 'c\$d' "$TMP/log"; then ok "空白や記号を含む引数を引用して渡す"; else bad "引数の引用が壊れる: $(cat "$TMP/log")"; fi

# ホストは VPS_SSH_HOST で差し替えられる
: > "$TMP/log"; PATH="$BIN:$PATH" SSH_LOG="$TMP/log" VPS_SSH_HOST=other bash "$SCRIPT" "$TMP/s.sh" >/dev/null 2>&1
if grep -q '^ssh	-t other ' "$TMP/log"; then ok "VPS_SSH_HOST でホストを差し替えられる"; else bad "ホストが固定されている"; fi

# 引数なし・読めないファイルは usage で止まる（ssh を呼ばない）
: > "$TMP/log"
if PATH="$BIN:$PATH" SSH_LOG="$TMP/log" bash "$SCRIPT" >/dev/null 2>"$TMP/err"; then bad "引数なしで成功してしまった"; else
  if grep -q usage "$TMP/err" && [ ! -s "$TMP/log" ]; then ok "引数なしは usage で止まり、ssh を呼ばない"; else bad "usage が出ない / ssh を呼んだ"; fi; fi
: > "$TMP/log"
if PATH="$BIN:$PATH" SSH_LOG="$TMP/log" bash "$SCRIPT" "$TMP/nope.sh" >/dev/null 2>"$TMP/err"; then bad "無いファイルで成功してしまった"; else
  # base64 自身も無いファイルで落ちるので「ssh を呼ばない」だけでは検査を外しても通る（等価変異）。
  # **自分の言葉で理由を言う**ことまで見る
  if [ ! -s "$TMP/log" ] && grep -q '読めません' "$TMP/err"; then ok "読めないファイルは理由を言って ssh を呼ばずに止まる"; else bad "無いファイルの扱いが違う: $(cat "$TMP/err")"; fi; fi

# ---- 再発防止: `ssh ... 'sudo bash -s ...' < script` の形がリポジトリに戻ってこないこと ----
# 最初「5箇所」と数えたが、grep で全部拾うと**14箇所**あった（#413 と同じ数え漏れ）。
# 手で数えずに、検査で全部見る。「動かない」と説明している行は除く。
echo
echo "再発防止（#419）"
REPO=$(cd "$HERE/../.." && pwd)
found=$(grep -rn "sudo bash -s[^<]*< " "$REPO/deploy" "$REPO/docs" "$REPO/README.md" 2>/dev/null \
  | grep -v "$REPO/deploy/test/" \
  | grep -v "は標準入力が tty\|は動きません\|は使えない\|パスワードを読めず\|動かない\|元から .* で root として実行しており" || true)
if [ -z "$found" ]; then ok "実行手順としての 'sudo bash -s ... < script' がリポジトリに無い"
else bad "動かない形が残っている:"; printf '%s\n' "$found" | sed 's/^/        /'; fi

echo
echo "pass=$PASS fail=$FAIL"
[ "$FAIL" = 0 ]
