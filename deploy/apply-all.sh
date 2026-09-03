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

# run <説明> <スクリプト> [引数...] — 実際の呼び出しは deploy/run-remote.sh（#419）。
# `ssh -t ... < script` が動かない理由と正しい形はそちらに1箇所だけ書く。
run() {
  local label=$1; shift
  echo "── $label"
  bash "$HERE/run-remote.sh" "$@"
  echo
}

run "1/3 ホスト nginx（production）" "$HERE/vps-setup.sh"      giinrecord.jp
run "2/3 ホスト nginx（staging）"    "$HERE/vps-setup.sh"      staging.giinrecord.jp 8083
run "3/3 giinops の sudo allowlist"  "$HERE/ops-user-setup.sh"

# 反映されたかを**その場で確かめる**（「流した」で終わりにしない）
echo "── 確認"
echo "Server ヘッダと HSTS:"
curl -sI https://giinrecord.jp/ | grep -iE '^server:|strict-transport' || echo "  （取得できませんでした）"
echo "giinops の allowlist（sudo -n で docker compose ps を実行できるか）:"
# **giinops として**入って、allowlist の行そのものを実行する（#426）。
#   - `ssh "$HOST" 'sudo -n -l'` は alias の設定（ubuntu）で入るので、ubuntu の sudoers を見て
#     「0」と誤表示していた。見たいのは giinops の allowlist。
#   - alias の HostName・鍵・ポートはそのまま使い、ユーザーだけ `-l giinops` で差し替える。
#     ホスト名を alias から取り出す形（ssh -G）にしないのは、取り出した値が画面に出ると IP が
#     残る（この確認の出力は issue に貼られる）から。
#   - 行数を数えるより「実行できたか」の方が確実で、0 件（拒否）と接続失敗を分けられる:
#     ssh 自身の失敗は終了コード 255、sudo の拒否はそれ以外。
#   - ps の出力は bind した IP を含むので、そのまま表示せずコンテナの数だけ出す。
# コマンドは deploy/ops-user-setup.sh が書く allowlist の行と**一字一句同じ**でないと sudo が通らない。
COMPOSE_PS='sudo -n docker compose -f /opt/giinrecord/deploy/docker-compose.yml ps'
err=$(mktemp); trap 'rm -f "$err"' EXIT   # stderr は混ぜない（ssh の警告を行数に数えない。IP を含むこともある）
if out=$(ssh -l giinops "$HOST" "$COMPOSE_PS" 2>"$err"); then
  n=$(printf '%s\n' "$out" | tail -n +2 | grep -c . || true)   # 1行目はヘッダ
  echo "  docker compose ps: 実行できた（コンテナ ${n} 件）"
else
  rc=$?
  if [ "$rc" = 255 ]; then
    echo "  （giinops として接続できませんでした。鍵か VPS_SSH_HOST を確認: ssh -l giinops $HOST）"
  else
    echo "  （実行できませんでした: allowlist に無いか、docker が落ちています。exit=$rc: $(head -n1 "$err")）"
  fi
fi

echo
echo "期待する結果:"
echo "  Server: nginx                                  ← バージョンと OS が消えている"
echo "  Strict-Transport-Security: max-age=86400"
echo "  docker compose ps: 実行できた（コンテナ 2 件）    ← web と web-staging"
