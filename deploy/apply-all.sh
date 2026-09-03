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

run() { # run <説明> <リモートで実行するコマンド> <標準入力に渡すファイル>
  echo "── $1"
  # shellcheck disable=SC2029  # $2 はこのファイル内のリテラルで、外から来ない
  ssh -t "$HOST" "$2" < "$3"
  echo
}

run "1/3 ホスト nginx（production）" 'sudo bash -s giinrecord.jp'            "$HERE/vps-setup.sh"
run "2/3 ホスト nginx（staging）"    'sudo bash -s staging.giinrecord.jp 8083' "$HERE/vps-setup.sh"
run "3/3 giinops の sudo allowlist"  'sudo bash -s'                           "$HERE/ops-user-setup.sh"

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
