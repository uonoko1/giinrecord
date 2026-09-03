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
# 確認の ssh（docker compose ps）だけ、SSH_CHECK_MODE で結果を切り替える（#426）:
#   ok     … allowlist が入っていて実行できた（ヘッダ + コンテナ2行。stderr に ssh の警告も出す）
#   empty  … 実行できたがコンテナが 0 件（ヘッダだけ）
#   down   … giinops として接続できない（ssh 自身の失敗。終了コード 255）
#   denied … 接続はできたが sudo が拒否（allowlist に無い。終了コード 1）
case "$*" in
  *"docker compose"*)
    case "${SSH_CHECK_MODE:-ok}" in
      down)   echo "ssh: connect to host x port 22: Connection refused" >&2; exit 255 ;;
      # 拒否のときも **ssh の警告が先に来る**（known_hosts に無いホスト）。実機で再現した形。
      # 1行目をそのまま出すと IP が画面に出て、issue に貼られる（#426 のレビュー）。
      # 警告は1種類ではない。`Permanently added` だけを弾く形では、鍵の警告経由でまだ IP が出るので、
      # **2行**出す。`sudo:` の行だけ拾う形にしないと落ちない fixture にしてある。
      # IP は組み立てて書く（scripts/ci/forbidden-patterns.sh は RFC 5737 の例示用アドレスも
      # 弾く。リポジトリに IPv4 リテラルを1つも置かないのがこのプロジェクトの決まり、#133）
      denied) ip1="$IP_A"; ip2="$IP_B"
              echo "Warning: Permanently added '$ip1' (ED25519) to the list of known hosts." >&2
              echo "Warning: the ECDSA host key for '$ip2' differs from the key for the IP address" >&2
              echo "sudo: a password is required" >&2; exit 1 ;;
      empty)  printf 'NAME  IMAGE  STATUS\n' ;;
      *)      echo "Warning: Permanently added 'x' (ED25519) to the list of known hosts." >&2
              printf 'NAME  IMAGE  STATUS\ngiinrecord-web-1  nginx  Up\ngiinrecord-web-staging-1  nginx  Up\n' ;;
    esac ;;
esac
STUB
cat > "$BIN/curl" <<'STUB'
#!/usr/bin/env bash
printf 'curl\t%s\n' "$*" >> "$SSH_LOG"
echo "Server: nginx"
STUB
chmod +x "$BIN/ssh" "$BIN/curl"

# denied モードのスタブが出す IP。**リテラルでは書かない**（#133: リポジトリに IPv4 を置かない。
# scripts/ci/forbidden-patterns.sh は RFC 5737 の例示用アドレスも弾く）。組み立てて渡す
IP_A=$(printf '%s.%s.%s.%s' 192 0 2 9)      # TEST-NET-1
IP_B=$(printf '%s.%s.%s.%s' 203 0 113 7)    # TEST-NET-3
export IP_A IP_B

# 終了コードは RC に残す（確認の失敗で set -e に殺されないことも見たい）
run() { : > "$TMP/log"; RC=0; PATH="$BIN:$PATH" SSH_LOG="$TMP/log" SSH_CHECK_MODE="${SSH_CHECK_MODE:-ok}" VPS_SSH_HOST="${1:-test-host}" bash "$SCRIPT" >"$TMP/out" 2>&1 || RC=$?; }

run
LOG=$(cat "$TMP/log")

# 3本とも流れているか
n=$(grep -c '^ssh' <<<"$LOG" || true)
if [ "$n" = 4 ]; then ok "ssh は4回（反映3回 + 確認1回）"; else bad "ssh の回数が違う: $n"; fi

if grep -qE "' _ giinrecord\.jp$" <<<"$LOG"; then ok "production を giinrecord.jp で流す"; else bad "production の引数が違う"; fi
if grep -qE "' _ staging\.giinrecord\.jp 8083$" <<<"$LOG"; then ok "staging を staging.giinrecord.jp 8083 で流す"; else bad "staging の引数が違う"; fi

# #141 の事故: staging の設定を production のドメインで流すと production の conf を壊す。
# **production に 8083 を渡していない / staging にポートを付け忘れていない**ことを見る
# `giinrecord.jp 8083` は `staging.giinrecord.jp 8083` にも一致してしまうので、
# **staging. が付いていない giinrecord.jp** に 8083 が続く形だけを見る（最初これで誤検出した）
if grep -qE "' _ giinrecord\.jp 8083" <<<"$LOG"; then bad "production に 8083 を渡している（#141 の事故）"; else ok "production にポートを渡さない"; fi
# 行末はタブ（STDIN: が続く）なので `$` は使えない。タブか行末で終わることを見る
if grep -qE "' _ staging\.giinrecord\.jp$" <<<"$LOG"; then bad "staging にポートが無い"; else ok "staging には 8083 を付ける"; fi

# 順序: production → staging → allowlist
order=$(grep '^ssh' <<<"$LOG" | grep -oE 'staging\.giinrecord\.jp 8083|giinrecord\.jp$|docker compose' | tr '\n' '|')
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
if [ "$(grep -cE "' _$" <<<"$LOG")" = 1 ]; then ok "allowlist は鍵を渡さずに流す（#403: auth.log に公開鍵を残さない）"; else bad "allowlist の引数が違う"; fi

# 反映のあとに確認する（「流した」で終わりにしない）
last=$(grep -oE '^(ssh|curl)' <<<"$LOG" | tail -2 | tr '\n' ' ')
if [ "$last" = "curl ssh " ]; then ok "最後に curl と ssh で確認する"; else bad "確認していない: $last"; fi

# #426: 確認の ssh は **giinops として**入る。`ssh "$HOST"` は alias の設定（ubuntu）で入るので、
# ubuntu の sudoers を見て「0」と誤表示していた。alias の HostName・鍵・ポートはそのまま使い、
# ユーザーだけ -l で差し替える（ホスト名を取り出して表示すると IP が画面に出るので、しない）
check=$(grep '^ssh' <<<"$LOG" | grep 'docker compose' || true)
if [ "$(wc -l <<<"$check")" = 1 ] && grep -qE '^ssh\s+-l giinops test-host ' <<<"$check"; then ok "確認は giinops として入る（-l giinops <alias>）"; else bad "確認が giinops として入っていない: $check"; fi
if grep -qE '^ssh\s+test-host .*sudo -n -l' <<<"$LOG"; then bad "ubuntu として sudo -n -l を見ている（#426 の誤表示）"; else ok "ubuntu の sudoers を見ない"; fi
# 行数を数えるのではなく **allowlist の行そのもの**（ops-user-setup.sh が書く docker compose ps）を実行する。
# ops-user-setup.sh の CHECKOUT を変えたらここも変わるべきなので、期待値はそこから組み立てる
checkout=$(grep -oE '^CHECKOUT=[^ ]+' "$HERE/../ops-user-setup.sh" | cut -d= -f2)
want="sudo -n docker compose -f $checkout/deploy/docker-compose.yml ps"
# **部分一致では足りない**（#426 のレビュー）。`grep -qF "$want"` だと `… ps --format json` を
# 足す変異が素通りする（実機では `sudo: a password is required` で拒否される形）。
# 逆に `/usr/bin/docker`（絶対パス）に変えると落ちるが、実機では secure_path のおかげで**通る**。
# 検査が逆向きだったので、**行末アンカー付きの完全一致**にする。
# ログの1行は `ssh<TAB>-l giinops <alias> <cmd>`。前置きを落とし、<cmd> が $want と
# **過不足なく**一致することを見る（末尾に何か足されていたら落ちる）
sent=${check#*$'\t'-l giinops test-host }
if [ -n "$checkout" ] && [ "$sent" = "$want" ]; then ok "allowlist の行そのもの（$want）を実行して確かめる"; else bad "確認コマンドが allowlist の行と一致しない: 送った=[$sent] 期待=[$want]"; fi
if grep -q 'docker compose ps: 実行できた（コンテナ 2 件）' "$TMP/out"; then ok "実行できたら「実行できた（コンテナ N 件）」と出す"; else bad "実行できた表示が無い: $(grep -A2 'giinops の allowlist' "$TMP/out")"; fi
# ヘッダの1行を数えない: ok モードの出力はヘッダ + 2 行。stderr の警告（IP を含むことがある）も数えない
if grep -q 'コンテナ 3 件' "$TMP/out"; then bad "ヘッダ行か stderr の警告をコンテナとして数えている"; else ok "ヘッダ行と stderr を数えない"; fi
if grep -q 'Permanently added' "$TMP/out"; then bad "ssh の stderr をそのまま表示している"; else ok "実行できたときは ssh の stderr を表示しない"; fi
# ps の出力（bind した IP を含む）をそのまま画面に出さない。#426 のように出力が issue に貼られる。
# **empty モードの前に見る**（最初 empty の後ろに置いて、変異 M8 が通ってしまった＝fixture の順序ミス）
if grep -q 'giinrecord-web-1' "$TMP/out"; then bad "docker compose ps の出力をそのまま表示している（IP が貼られる）"; else ok "ps の出力をそのまま表示しない"; fi
# コンテナ 0 件でも「実行できた（0 件）」。接続失敗と区別する（#426 の受け入れ条件）
SSH_CHECK_MODE=empty run
if grep -q 'docker compose ps: 実行できた（コンテナ 0 件）' "$TMP/out"; then ok "0 件でも「実行できた（コンテナ 0 件）」と出す（接続失敗と区別）"; else bad "0 件の表示が違う: $(grep -A1 'giinops の allowlist' "$TMP/out" | tail -1)"; fi
if [ "$RC" = 0 ]; then ok "0 件でもスクリプトは 0 で終わる（grep -c の 1 を set -e に拾わせない）"; else bad "0 件でスクリプトが exit=$RC で死ぬ"; fi

# 接続できない（255）と、接続できたが実行できない（allowlist に無い）を**区別**する
SSH_CHECK_MODE=down run
down=$(grep -A1 'giinops の allowlist' "$TMP/out" | tail -1)
if grep -q '接続できませんでした' <<<"$down"; then ok "giinops として接続できないときはそう言う"; else bad "接続失敗の表示が違う: $down"; fi
if grep -q '実行できた' <<<"$down"; then bad "接続できないのに実行できたと出る"; else ok "接続失敗を実行できたと言わない"; fi
SSH_CHECK_MODE=denied run
denied=$(grep -A1 'giinops の allowlist' "$TMP/out" | tail -1)
if grep -q '実行できませんでした' <<<"$denied"; then ok "sudo に拒否されたときは「実行できませんでした」"; else bad "拒否の表示が違う: $denied"; fi
if grep -q '接続できませんでした' <<<"$denied"; then bad "拒否を接続失敗と言っている（区別できていない）"; else ok "拒否を接続失敗と混同しない"; fi
if grep -q 'a password is required' "$TMP/out"; then ok "拒否の理由（sudo の1行）を添える"; else bad "拒否の理由が出ない"; fi
# **何が出るか**を見る（#426 のレビュー）。stderr の1行目は sudo のエラーとは限らず、known_hosts に
# 無いホストだと `Warning: Permanently added '<IP>' …` が先に来る。`head -n1 "$err"` をそのまま
# 出すと **IP が画面に出て、その出力が issue に貼られる**。denied のスタブはその形を再現している。
# 落ちたときのメッセージにも IP を載せない（テストのログも公開されうる）ので、伏せて出す
if grep -qE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' "$TMP/out"; then bad "拒否の表示に IP 形式が含まれている: $(sed -E 's/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/<IP>/g' <<<"$denied")"; else ok "拒否の表示に IP を出さない"; fi
if grep -q 'Permanently added' "$TMP/out"; then bad "ssh の警告をそのまま表示している（IP が漏れる）"; else ok "拒否のときも ssh の警告を表示しない"; fi
if [ "$down" = "$denied" ]; then bad "接続失敗と拒否の表示が同じ"; else ok "接続失敗と拒否の表示が違う"; fi
# どちらの失敗でもスクリプト自体は最後（期待する結果）まで進む（確認は情報で、反映は済んでいる）
if grep -q '期待する結果' "$TMP/out"; then ok "確認が失敗しても最後まで表示する"; else bad "確認の失敗で止まる"; fi
if [ "$RC" = 0 ]; then ok "確認が失敗してもスクリプトは 0 で終わる"; else bad "確認の失敗で exit=$RC"; fi
if grep -q 'docker compose ps: 実行できた' "$TMP/out"; then ok "期待する結果に「実行できた」を書く"; else bad "期待する結果が古い（行数: 1）"; fi

# ホストは VPS_SSH_HOST で差し替えられる
run other-host
if grep -q 'other-host' "$TMP/log"; then ok "VPS_SSH_HOST でホストを差し替えられる"; else bad "ホストが固定されている"; fi

# 何をするかを先に見せる
if grep -q '3つを順に実行します' "$TMP/out"; then ok "実行内容を先に表示する"; else bad "実行内容を表示していない"; fi

echo
echo "pass=$PASS fail=$FAIL"
[ "$FAIL" = 0 ]
