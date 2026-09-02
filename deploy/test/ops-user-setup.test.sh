#!/usr/bin/env bash
# Tests for deploy/ops-user-setup.sh (Issue #333)。
#
# 守りたい性質は「giinops から root に昇格できる許可を作らない」こと。
# 「危ないものを含まない」という denylist は綴りの変種と未知の危険コマンドに原理的に弱いので
# （NOPASSWD:<TAB>ALL、ワイルドカード無しの `bash /tmp/x.sh`、別ファイル追加、Cmnd_Alias が全て素通りした）
# **許可される行の集合を完全一致で照合する allowlist 方式**を主にする。行が1つでも増減したら落ちる＝
# 許可を足すときは必ずこのテストを直すことになり、レビューが強制される。
#
# root 不要・実ホストに触れない: adduser / usermod / chown / id はスタブ、全パスは OPS_SETUP_PREFIX 配下。
# visudo は**本物**を使う（root 不要で構文検証できるため。無いホストではその検査だけ skip）。
#   bash deploy/test/ops-user-setup.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../ops-user-setup.sh"
PASS=0; FAIL=0; SKIP=0
PUBKEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITESTKEYFIXTUREONLYNOTAREALKEY ops@test"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"; mkdir -p "$BIN"
for cmd in adduser usermod chown; do printf '#!/usr/bin/env bash\nexit 0\n' > "$BIN/$cmd"; chmod +x "$BIN/$cmd"; done
# id: 既定は「居ない」(exit 1)。H_LEGACY_EXISTS=1 のとき gikaiops だけ「居る」ことにする
cat > "$BIN/id" <<'IDSTUB'
#!/usr/bin/env bash
if [ -n "${H_LEGACY_EXISTS:-}" ] && [ "${*: -1}" = gikaiops ]; then exit 0; fi
exit 1
IDSTUB
chmod +x "$BIN/id"
# sudo: -l -U <user> の問い合わせにだけ答える。H_LEGACY_SUDO の中身をそのまま返す
cat > "$BIN/sudo" <<'SUDOSTUB'
#!/usr/bin/env bash
printf '%s\n' "${H_LEGACY_SUDO:-}"
SUDOSTUB
chmod +x "$BIN/sudo"

ok()  { PASS=$((PASS+1)); echo "  ok   - $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL - $1"; }
skip(){ SKIP=$((SKIP+1)); echo "  skip - $1"; }

run_setup() {
  local p=$1
  mkdir -p "$p/home/ubuntu/.ssh"; : > "$p/home/ubuntu/.ssh/authorized_keys"
  PATH="$BIN:$PATH" OPS_SETUP_PREFIX="$p" bash "$SCRIPT" "$PUBKEY" >/dev/null 2>&1
}

P="$TMP/run1"; run_setup "$P"
SUDOERS_DIR="$P/etc/sudoers.d"

# ---------------------------------------------------------------------------
# 1. 許可されるコマンドの集合が、期待と**完全に一致**する（allowlist 方式）
# ---------------------------------------------------------------------------
echo "== 許可コマンドの集合が期待と完全一致する =="

# sudoers.d 配下**全ファイル**から許可行を集める（和集合になるので1ファイルだけ見てはいけない）
ACTUAL=$(cat "$SUDOERS_DIR"/* 2>/dev/null \
  | sed -e 's/[[:space:]]*#.*$//' -e '/^[[:space:]]*$/d' \
  | grep 'NOPASSWD' | sed 's/^.*NOPASSWD:[[:space:]]*//' | sort)

EXPECTED=$(sort <<'EXP'
/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx
/usr/bin/systemctl status nginx
/usr/bin/rm -f /var/log/nginx/giinrecord-staging.access.log
/usr/bin/rm -f /var/log/nginx/giinrecord-staging.error.log
/usr/bin/git -C /opt/giinrecord pull
/usr/bin/docker compose -f /opt/giinrecord/deploy/docker-compose.yml up -d --force-recreate
/usr/bin/docker compose -f /opt/giinrecord/deploy/docker-compose.yml ps
EXP
)

if [ "$ACTUAL" = "$EXPECTED" ]; then
  ok "許可コマンドは期待した 8 行ちょうど"
else
  bad "許可コマンドの集合が期待と違う"
  echo "--- 期待にあって実際に無い ---"; comm -23 <(echo "$EXPECTED") <(echo "$ACTUAL") | sed 's/^/      /'
  echo "--- 実際にあって期待に無い（新しい許可を足したなら、まずここを疑う）---"
  comm -13 <(echo "$EXPECTED") <(echo "$ACTUAL") | sed 's/^/      /'
fi

# ---------------------------------------------------------------------------
# 2. 許可の「形」そのものへの検査（allowlist をすり抜ける書き方を個別に禁じる）
# ---------------------------------------------------------------------------
echo "== 危険な構文を持ち込まない =="
ALL_FILES=$(cat "$SUDOERS_DIR"/* 2>/dev/null | sed -e 's/[[:space:]]*#.*$//' -e '/^[[:space:]]*$/d')

# NOPASSWD の後が ALL（空白・タブ・綴りを問わない）
if echo "$ALL_FILES" | grep -Eq 'NOPASSWD:[[:space:]]*ALL'; then
  bad "NOPASSWD に ALL を与えている"
else ok "NOPASSWD に ALL を与えない（空白・タブの変種も含む）"; fi

# 引数を取らない裸のコマンド = 引数自由 = 実質何でもできる
if echo "$ALL_FILES" | grep -E 'NOPASSWD:' | sed 's/^.*NOPASSWD:[[:space:]]*//' | grep -Eq '^[^ ]+$'; then
  bad "引数の無い（＝引数自由な）コマンド許可がある"
else ok "全ての許可コマンドが引数まで固定されている"; fi

# ワイルドカード = 任意コード実行になりうる
if echo "$ALL_FILES" | grep -E 'NOPASSWD:' | grep -q '[*?]'; then
  bad "コマンドにワイルドカードがある"
else ok "コマンドにワイルドカードが無い"; fi

# シェル・インタプリタ・GTFOBins 系は、パスやワイルドカードの有無に関わらず禁止
DANGEROUS='bash|/sh|dash|zsh|env|find|awk|perl|python|ruby|vi|vim|nano|less|man|dd|chmod|chown|cp|mv|ln|tar|nsenter|unshare|systemd-run'
if echo "$ALL_FILES" | grep -E 'NOPASSWD:' | sed 's/^.*NOPASSWD:[[:space:]]*//' | grep -Eq "^[^ ]*/($DANGEROUS)( |$)"; then
  bad "シェル/インタプリタ系のコマンドを許可している（任意コード実行）"
else ok "シェル/インタプリタ系を許可していない"; fi

# docker run / exec は任意のコンテナを root で起動できる = root 相当
if echo "$ALL_FILES" | grep -E 'NOPASSWD:.*docker' | grep -Eq ' (run|exec|cp) '; then
  bad "docker run/exec/cp を許可している"
else ok "docker は compose の固定操作のみ"; fi

# #335: nginx conf を書ける = 実質 root 相当（nginx master は root。`location /x { root /; }` で
# 任意ファイルを HTTP 公開でき、他サイトの TLS 秘密鍵も読める。`nginx -t` は検査しない）
if echo "$ALL_FILES" | grep -E 'NOPASSWD:' | grep -q '/tee '; then
  bad "nginx conf を書く許可（tee）がある（#335: 実質 root 相当）"
else ok "nginx conf を書く許可（tee）を与えない"; fi

# Issue 375: docker compose logs は足さない（コンテナの nginx ログは IP を含む）
if echo "$ALL_FILES" | grep -E 'NOPASSWD:.*docker' | grep -q ' logs'; then
  bad "docker compose logs を許可している（IP を含むログが読める）"
else ok "docker compose logs は許可しない"; fi

# Alias による間接化（Cmnd_Alias OPS = /usr/bin/env のような迂回）
if echo "$ALL_FILES" | grep -Eq '^[[:space:]]*(Cmnd_Alias|User_Alias|Runas_Alias|Host_Alias)'; then
  bad "Alias 定義がある（許可の実体が隠れる）"
else ok "Alias 定義を使っていない"; fi

# ---------------------------------------------------------------------------
# 3. sudoers.d は和集合。世代違いが残ると allowlist の意味が消える（#333 の実機バグ）
# ---------------------------------------------------------------------------
echo "== 旧世代の sudoers を残さない =="
FILES=$(find "$SUDOERS_DIR" -maxdepth 1 -type f -printf '%f ' 2>/dev/null)
NFILES=$(find "$SUDOERS_DIR" -maxdepth 1 -type f 2>/dev/null | wc -l)
if [ "$NFILES" = 1 ]; then ok "sudoers.d に自分のファイルは1つだけ ($FILES)"
else bad "sudoers.d に複数ある: $FILES"; fi

# 実機で起きた形（91-giinops に bash /tmp/*.sh が残る）を再現し、掃除されることを見る
P2="$TMP/run2"; mkdir -p "$P2/etc/sudoers.d"
printf 'giinops ALL=(ALL) NOPASSWD: /bin/bash /tmp/giinrecord-x.sh\n' > "$P2/etc/sudoers.d/91-giinops"
printf 'gikaiops ALL=(ALL) NOPASSWD:ALL\n' > "$P2/etc/sudoers.d/90-gikaiops"
printf 'othersite ALL=(ALL) NOPASSWD: /usr/bin/true\n' > "$P2/etc/sudoers.d/other-site"
run_setup "$P2"
if [ -e "$P2/etc/sudoers.d/91-giinops" ]; then bad "旧世代 91-giinops が残っている（実機のバグが再発）"
else ok "旧世代 91-giinops を掃除する"; fi
# 共用ホスト：自分以外の sudoers には触れない
if [ -e "$P2/etc/sudoers.d/other-site" ]; then ok "他サイトの sudoers には触れない"
else bad "他サイトの sudoers を消した"; fi
if [ -e "$P2/etc/sudoers.d/90-gikaiops" ]; then ok "別ユーザー名のファイルは自動で消さない（人が確認して消す）"
else bad "別ユーザーの sudoers を勝手に消した"; fi

# ---------------------------------------------------------------------------
# 4. 主体は giinops だけ。ubuntu を巻き込まない
# ---------------------------------------------------------------------------
echo "== 権限を持つ主体は giinops だけ =="
SUBJECTS=$(echo "$ALL_FILES" | grep -E 'NOPASSWD' | awk '{print $1}' | sort -u | tr '\n' ' ')
if [ "$SUBJECTS" = "giinops " ]; then ok "許可を持つ主体は giinops のみ"; else bad "giinops 以外が居る: $SUBJECTS"; fi

# ---------------------------------------------------------------------------
# 5. 環境変数が渡らないこと（docker の SITE_DIR=/ 対策）
# ---------------------------------------------------------------------------
echo "== 環境をリセットする指定がある =="
if echo "$ALL_FILES" | grep -q 'env_reset'; then ok "env_reset を明示している"; else bad "env_reset の明示が無い"; fi
if echo "$ALL_FILES" | grep -q '!setenv'; then ok "!setenv（sudo VAR=x を禁止）を明示している"; else bad "!setenv が無い"; fi

# ---------------------------------------------------------------------------
# 6. 構文が本当に妥当か（スタブではなく本物の visudo で）
# ---------------------------------------------------------------------------
echo "== visudo による構文検証 =="
if command -v visudo >/dev/null 2>&1; then
  if visudo -cf "$SUDOERS_DIR/90-giinops" >/dev/null 2>&1; then ok "visudo -cf が通る"
  else bad "visudo -cf が構文エラーを報告した"; fi
else skip "visudo がこのホストに無い"; fi

# ---------------------------------------------------------------------------
# 7. 鍵は1本・冪等
# ---------------------------------------------------------------------------
echo "== 鍵は1本だけ・冪等 =="
run_setup "$P"   # 2回目
AK="$P/home/giinops/.ssh/authorized_keys"
if grep -qF "$PUBKEY" "$AK"; then ok "運用鍵が置かれる"; else bad "運用鍵が無い"; fi
LINES=$(grep -c . "$AK" || true)
if [ "$LINES" = 1 ]; then ok "2回流しても鍵は1本のまま"; else bad "鍵が $LINES 本に増えた"; fi
# 2回目でも allowlist は同じ（0440 のまま書き直せない、を踏まない）
AFTER=$(cat "$SUDOERS_DIR"/* | sed -e 's/[[:space:]]*#.*$//' -e '/^[[:space:]]*$/d' \
  | grep 'NOPASSWD' | sed 's/^.*NOPASSWD:[[:space:]]*//' | sort)
if [ "$AFTER" = "$EXPECTED" ]; then ok "2回流しても allowlist は同じ"; else bad "2回目で allowlist が変わった"; fi
# 権限
MODE=$(stat -c '%a' "$SUDOERS_DIR/90-giinops")
if [ "$MODE" = 440 ]; then ok "sudoers は 0440"; else bad "sudoers の権限が $MODE（sudo は 0440 以外を無視する）"; fi


# #336: 旧運用ユーザーが NOPASSWD:ALL を持ったまま残ると、新ユーザーをどれだけ絞っても迂回できる。
# 「残っています」という穏当な警告は実際に読み流されたので、危険な場合は言い切ることを検査する。
echo "== 旧運用ユーザーの警告 =="
warn_output() {  # warn_output <H_LEGACY_EXISTS> <H_LEGACY_SUDO> → stderr
  local p="$TMP/warn$RANDOM"
  mkdir -p "$p/home/ubuntu/.ssh"; : > "$p/home/ubuntu/.ssh/authorized_keys"
  PATH="$BIN:$PATH" OPS_SETUP_PREFIX="$p" H_LEGACY_EXISTS="$1" H_LEGACY_SUDO="$2" \
    bash "$SCRIPT" "$PUBKEY" 2>"$p/stderr" >/dev/null || true
  cat "$p/stderr"
}

OUT=$(warn_output 1 "(ALL) NOPASSWD: ALL")
if printf '%s' "$OUT" | grep -q '危険'; then ok "旧ユーザーが NOPASSWD:ALL なら「危険」と言い切る"
else bad "NOPASSWD:ALL を持つ旧ユーザーを危険と伝えていない: $OUT"; fi
if printf '%s' "$OUT" | grep -q 'deluser'; then ok "消し方（deluser）を示す"
else bad "消し方を示していない"; fi

OUT=$(warn_output 1 "(ALL) NOPASSWD: /usr/bin/true")
if printf '%s' "$OUT" | grep -q '残っています'; then ok "無制限でない旧ユーザーは通常の警告"
else bad "旧ユーザーが居るのに警告が出ない: $OUT"; fi

OUT=$(warn_output "" "")
if printf '%s' "$OUT" | grep -q '旧運用ユーザー'; then bad "旧ユーザーが居ないのに警告が出る: $OUT"
else ok "旧ユーザーが居なければ何も言わない"; fi

# Issue 375: allowlist を更新するだけの再実行では、鍵を渡し直さなくてよい。
# 鍵をコマンドラインに置くと sudo が /var/log/auth.log にコマンド全体を記録するので、
# **公開鍵が平文でログに残る**（秘密ではないが、残す理由も無い。ps とシェル履歴にも出る）。
echo
echo "鍵を省略した再実行（#375）"

P="$TMP/rerun"
mkdir -p "$P/home/ubuntu/.ssh"; : > "$P/home/ubuntu/.ssh/authorized_keys"
# 1回目: 鍵を渡して作る
PATH="$BIN:$PATH" OPS_SETUP_PREFIX="$P" bash "$SCRIPT" "$PUBKEY" >/dev/null 2>&1
# 2回目: 鍵を渡さずに流し直す
if PATH="$BIN:$PATH" OPS_SETUP_PREFIX="$P" bash "$SCRIPT" >"$P/out" 2>"$P/err"; then
  ok "鍵を省略しても成功する（allowlist の更新だけを流し直せる）"
else
  bad "鍵を省略した再実行が失敗した: $(cat "$P/err")"
fi
if [ "$(cat "$P/home/giinops/.ssh/authorized_keys")" = "$PUBKEY" ]; then
  ok "既にある鍵をそのまま使う（消したり変えたりしない）"
else
  bad "鍵が変わってしまった: $(cat "$P/home/giinops/.ssh/authorized_keys")"
fi
if [ "$(grep -c . "$P/home/giinops/.ssh/authorized_keys")" = 1 ]; then
  ok "鍵は1行のまま（重複して増えない）"
else
  bad "鍵が増えた: $(cat "$P/home/giinops/.ssh/authorized_keys")"
fi
if grep -q '既にある鍵' "$P/err"; then ok "鍵を引き継いだことを伝える"
else bad "鍵を引き継いだことを言わない: $(cat "$P/err")"; fi

# authorized_keys に**複数行ある状態**で省略されたら、1行目だけを使う。
# `cat` で全部読むと、`>` の上書きでファイルが壊れるうえ、鍵の検査も通らなくなる
# （テストの前提が1行だけだと、head -n1 を cat に変える変異が素通りする）
P4="$TMP/rerun-multi"
mkdir -p "$P4/home/ubuntu/.ssh" "$P4/home/giinops/.ssh"
: > "$P4/home/ubuntu/.ssh/authorized_keys"
printf '%s\n%s\n' "$PUBKEY" "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAASECONDKEYSHOULDNOTBEUSED other@host" > "$P4/home/giinops/.ssh/authorized_keys"
if PATH="$BIN:$PATH" OPS_SETUP_PREFIX="$P4" bash "$SCRIPT" >/dev/null 2>"$P4/err"; then
  if [ "$(cat "$P4/home/giinops/.ssh/authorized_keys")" = "$PUBKEY" ]; then
    ok "既存が複数行でも1行目だけを使う（残りは落とす）"
  else
    bad "複数行を読んでしまった: $(cat "$P4/home/giinops/.ssh/authorized_keys")"
  fi
else
  bad "既存が複数行の再実行が失敗した: $(cat "$P4/err")"
fi

# 鍵がまだ無いのに省略したら、**作らずに**使い方を出して終わる
P2="$TMP/firstrun"
mkdir -p "$P2/home/ubuntu/.ssh"; : > "$P2/home/ubuntu/.ssh/authorized_keys"
if PATH="$BIN:$PATH" OPS_SETUP_PREFIX="$P2" bash "$SCRIPT" >/dev/null 2>"$P2/err"; then
  bad "鍵が無いのに省略して成功してしまった"
else
  if grep -q 'usage' "$P2/err"; then ok "初回に鍵を省略したら使い方を出して終わる"
  else bad "初回の鍵省略で usage が出ない: $(cat "$P2/err")"; fi
fi
if [ ! -e "$P2/etc/sudoers.d/90-giinops" ]; then ok "初回の鍵省略では sudoers を書かない"
else bad "鍵が無いのに sudoers を書いた"; fi

# **複数行の鍵は受け付けない**。`>` で上書きするので、渡されたら authorized_keys が壊れる
P3="$TMP/multiline"
mkdir -p "$P3/home/ubuntu/.ssh"; : > "$P3/home/ubuntu/.ssh/authorized_keys"
if PATH="$BIN:$PATH" OPS_SETUP_PREFIX="$P3" bash "$SCRIPT" "$PUBKEY
$PUBKEY" >/dev/null 2>"$P3/err"; then
  bad "複数行の鍵を受け入れてしまった"
else
  if grep -q '1行' "$P3/err"; then ok "複数行の鍵は1行で渡すよう言って断る"
  else bad "複数行を断る理由を言わない: $(cat "$P3/err")"; fi
fi

echo
echo "pass=$PASS fail=$FAIL skip=$SKIP"
[ "$FAIL" = 0 ]
