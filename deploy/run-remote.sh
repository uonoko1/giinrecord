#!/usr/bin/env bash
# ローカルのスクリプトを VPS 上で root として実行する。**tty を潰さない**唯一の正しい形（Issue 419）。
#
#     bash deploy/run-remote.sh <script> [引数...]
#     例: bash deploy/run-remote.sh deploy/go-live.sh giinrecord.jp
#
# `ssh -t <host> 'sudo bash -s' < script` は**動かない**: `< script` で標準入力がファイルになり、
# `-t` が tty を割り当てられず、`sudo` がパスワードを読めずに落ちる。
# この形がリポジトリに5箇所書かれていたが、元から動かない組み合わせだった（#398 で実測）。
#
# ここでは base64 にして**コマンド行で渡し、プロセス置換で実行する**:
#   - 標準入力を使わないので tty が生きる（sudo がパスワードを聞ける。certbot も対話できる）
#   - base64 にするのは、スクリプト内のシングルクォートで引用が壊れるのを避けるため
#   - プロセス置換なので**サーバー上にファイルを残さない**
#     （/tmp に置いて実行する形は、誰でも書ける場所なので root 昇格に使える。#333 で塞いだ経路）
#   テスト: deploy/test/run-remote.test.sh
set -euo pipefail

SCRIPT="${1:?usage: run-remote.sh <script> [args...]}"; shift
[ -r "$SCRIPT" ] || { echo "run-remote.sh: $SCRIPT が読めません" >&2; exit 2; }
HOST="${VPS_SSH_HOST:-sakura-vps}"

b64=$(base64 -w0 < "$SCRIPT")
# 引数はリモートのシェルで再解釈されるので、**引用して**渡す（空白や記号を含んでも壊れない）
args=""
for a in "$@"; do args+=" $(printf '%q' "$a")"; done
# shellcheck disable=SC2029  # 展開はローカルで行う。b64 はファイル由来、args は %q で引用済み
ssh -t "$HOST" "sudo bash <(echo $b64 | base64 -d)$args"
