#!/usr/bin/env bash
# VPS への反映を1コマンドにまとめる（Issue 398）。リポジトリのルートで:
#
#     bash deploy/apply-all.sh
#
# 3つのスクリプトを順に流すだけで、**新しいことは何もしない**:
#   1. ホスト nginx（production）  … #386 server_tokens off + #387 HSTS
#   2. ホスト nginx（staging）     … 同上
#   3. giinops の sudo allowlist   … #375 docker compose ps
#
# なぜ `&&` で繋げないか: 3本とも**ローカルのファイルを標準入力で渡す**形（`ssh ... < file`）
# なので、1つの ssh セッションに3つ流し込めない。**ssh を3回**に分けて、ここで順番を保証する。
#
# 途中で失敗したら止まる（set -e）。**流し直しても安全**（3本とも冪等）。
#   テスト: deploy/test/apply-all.test.sh
set -euo pipefail

HOST="${VPS_SSH_HOST:-sakura-vps}"
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# 実行する内容を**先に全部見せる**（何が起きるか分からないまま sudo を打たせない）
cat <<EOS
これから ${HOST} に対して次の3つを順に実行します。

  1. ホスト nginx（production）  giinrecord.jp
       Server ヘッダからバージョンと OS を消す（#386）
       Strict-Transport-Security: max-age=86400 を出す（#387・preload なし）
  2. ホスト nginx（staging）     staging.giinrecord.jp:8083
  3. giinops の sudo allowlist   docker compose ps を足す（#375）

いずれも冪等で、certbot 管理の conf は書き換えません。
sudo のパスワードを3回聞かれます。

EOS

# run <説明> <スクリプト> [引数...]
#
# **`ssh -t ... < script` は使えない**（実測で判明）。`< script` で標準入力がファイルになるので
# `-t` が tty を割り当てられず、`sudo` がパスワードを読めずに落ちる:
#
#     Pseudo-terminal will not be allocated because stdin is not a terminal.
#     sudo: a terminal is required to read the password
#
# docs/ops/deploy.md にもこの形が書かれていたが、**元から動かない組み合わせ**だった。
#
# 代わりに **base64 にしてコマンド行で渡し、プロセス置換で実行する**。
# 標準入力を一切使わないので tty が生きる。base64 にするのは、スクリプト内の
# シングルクォート（vps-setup.sh に 39 個ある）で引用が壊れるのを避けるため。
#
# **サーバー上にファイルを残さない**（`/tmp` にスクリプトを置いて実行する形は、
# 誰でも書ける場所なので root 昇格に使える。#333 で塞いだ経路）。
run() {
  local label=$1 script=$2; shift 2
  echo "── $label"
  local b64; b64=$(base64 -w0 < "$script")
  # shellcheck disable=SC2029  # 展開はローカルで行う（b64 と引数はこのファイル由来）
  ssh -t "$HOST" "sudo bash <(echo $b64 | base64 -d) $*"
  echo
}

run "1/3 ホスト nginx（production）" "$HERE/vps-setup.sh"      giinrecord.jp
run "2/3 ホスト nginx（staging）"    "$HERE/vps-setup.sh"      staging.giinrecord.jp 8083
run "3/3 giinops の sudo allowlist"  "$HERE/ops-user-setup.sh"

# 反映されたかを**その場で確かめる**（「流した」で終わりにしない）
echo "── 確認"
echo "Server ヘッダと HSTS:"
curl -sI https://giinrecord.jp/ | grep -iE '^server:|strict-transport' || echo "  （取得できませんでした）"
echo "giinops の allowlist（docker compose ... ps があるか）:"
ssh "$HOST" 'sudo -n -l' 2>/dev/null | grep -c 'docker compose .* ps' \
  | sed 's/^/  docker compose ps の行数: /' || echo "  （確認できませんでした）"

echo
echo "期待する結果:"
echo "  Server: nginx                                  ← バージョンと OS が消えている"
echo "  Strict-Transport-Security: max-age=86400"
echo "  docker compose ps の行数: 1"
