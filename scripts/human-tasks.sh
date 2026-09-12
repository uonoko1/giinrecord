#!/usr/bin/env bash
# **人間にしか打てないコマンドを 1 本にまとめたもの**（PO が作った。2026-09-13）。
#
# なぜ要るか:
#   PO（Claude）が権限や接続手段で止められている作業が、`docs/ops/pending-decisions.md` に
#   散らばっていた。**人間に「あれとこれを打ってください」と 4 回言うより、1 回で済むほうがよい。**
#
# 何をするか（**この 2 つだけ。どちらも取り消せる**）:
#   1. **`site.conf` を本番に反映する**（#610 / #654）——ssh が要る。PO の端末には接続先が無い
#   2. **`git stash` 2 件を drop する**（#543）——PO の権限で止められている
#
# **やらないこと**（人間の判断が要るので、このスクリプトには入れない）:
#   - fine-grained PAT の設置（#550 / #155 / #547）——GitHub の設定画面での操作
#   - Sponsors / 広告 / NDL 照会（#53 / #48 / #250）——外部に届く。方針の判断も要る
#
# 使い方:
#   bash scripts/human-tasks.sh                      # 何をするかだけ出す（dry-run）
#   bash scripts/human-tasks.sh --yes                # 実行する
#   bash scripts/human-tasks.sh --yes --host 1.2.3.4 # ssh の接続先を指定する
#   bash scripts/human-tasks.sh --yes --skip-deploy  # stash の drop だけやる
#   bash scripts/human-tasks.sh --yes --skip-stash   # site.conf の反映だけやる
#
# **VPS の IP はこのリポジトリに書けない**（OSS なので）。次のどれかで渡してください:
#   - `~/.ssh/config` に `Host giinops` を書いてある（このスクリプトはそれを使う）
#   - `--host <IP>` で渡す
#   - 環境変数 `GIINOPS_HOST=<IP>`
#
#   Tests: scripts/ci/test/human-tasks.test.sh（ssh / git はスタブ。実際には何もしない）
set -euo pipefail

APPLY=0; HOST="${GIINOPS_HOST:-}"; DO_DEPLOY=1; DO_STASH=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes) APPLY=1; shift ;;
    --host) HOST="${2:-}"; shift 2 ;;
    --skip-deploy) DO_DEPLOY=0; shift ;;
    --skip-stash) DO_STASH=0; shift ;;
    *) echo "usage: human-tasks.sh [--yes] [--host <IP>] [--skip-deploy] [--skip-stash]" >&2; exit 2 ;;
  esac
done

log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

# ssh の宛先を決める。`~/.ssh/config` に Host giinops があればそれ、無ければ giinops@<HOST>。
ssh_target() {
  if grep -qi '^[[:space:]]*Host[[:space:]].*\bgiinops\b' "${HOME}/.ssh/config" 2>/dev/null; then
    echo "giinops"; return
  fi
  [[ -n "$HOST" ]] || return 1
  echo "giinops@${HOST}"
}

fail=0

# ---- 1. site.conf を本番に反映する（#610 / #654）---------------------------------------------
if [[ "$DO_DEPLOY" = 1 ]]; then
  echo
  log "== 1. site.conf を本番に反映する（#610 / #654）=="
  if ! target=$(ssh_target); then
    log "  ssh の接続先が分かりません。次のどれかで渡してください:"
    log "    ~/.ssh/config に 'Host giinops' を書く（docs/ops/deploy.md の「設定を変えるとき」3 番）"
    log "    --host <VPS の IP> を付ける"
    log "    GIINOPS_HOST=<VPS の IP> を環境変数で渡す"
    fail=1
  else
    # **`up -d` だけでは足りない**: site.conf は bind mount した単一ファイルなので、
    # git pull では inode が変わるだけでコンテナは古いものを掴んだまま（docs/ops/deploy.md）。
    cmd='sudo -n git -C /opt/giinrecord pull && sudo -n docker compose -f /opt/giinrecord/deploy/docker-compose.yml up -d --force-recreate'
    if [[ "$APPLY" = 0 ]]; then
      log "  [dry-run] ssh $target '$cmd'"
    else
      log "  ssh $target で反映します"
      if ssh "$target" "$cmd"; then log "  反映しました"; else log "  ssh が失敗しました"; fail=1; fi
    fi
  fi
fi

# ---- 2. git stash 2 件を drop する（#543）-----------------------------------------------------
if [[ "$DO_STASH" = 1 ]]; then
  echo
  log "== 2. git stash 2 件を drop する（#543）=="
  # **PO は「消してよい」と確認済み**（どちらも apply できず、中身は main により良い形で入っている）。
  # **念のため sha を控えてから消す**——直後なら `git stash apply <sha>` で戻せる。
  n=$(git -C "$ROOT" stash list 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$n" = "0" ]]; then
    log "  stash はありません（既に消えています）"
  else
    log "  今ある stash: $n 件"
    git -C "$ROOT" stash list | sed 's/^/    /'
    if [[ "$APPLY" = 0 ]]; then
      log "  [dry-run] git stash drop 'stash@{1}' && git stash drop 'stash@{0}'"
    else
      # **消す前に sha を控える**（戻せるようにする）
      log "  消す前の sha を控えます:"
      git -C "$ROOT" stash list --format='    %gd %H %gs' | sed 's/^/  /'
      # **後ろから消す**（前から消すと番号がずれる）
      ok=1
      for i in 1 0; do
        if git -C "$ROOT" rev-parse --verify --quiet "stash@{$i}" >/dev/null 2>&1; then
          if git -C "$ROOT" stash drop "stash@{$i}"; then log "  stash@{$i} を消しました"; else log "  stash@{$i} を消せませんでした"; ok=0; fi
        fi
      done
      [[ "$ok" = 1 ]] || fail=1
    fi
  fi
fi

# ---- 反映の確認（#610 / #654 を実際に見る）----------------------------------------------------
if [[ "$APPLY" = 1 && "$DO_DEPLOY" = 1 && "$fail" = 0 ]]; then
  echo
  log "== 反映の確認 =="
  # **4 つとも見る。** 3 つ目が大事——/compare は SPA fallback を使う**正常な**ページなので、
  # そこが壊れていないことまで見て、はじめて成功と言える（docs/ops/pending-decisions.md）。
  body=$(curl -sSL -A giinrecord-human-tasks https://giinrecord.jp/no-such-page-12345 | grep -c ページが見つかりません || true)
  code404=$(curl -sSL -o /dev/null -w '%{http_code}' -A giinrecord-human-tasks https://giinrecord.jp/no-such-page-12345)
  compare=$(curl -sSL -o /dev/null -w '%{http_code}' -A giinrecord-human-tasks https://giinrecord.jp/compare)
  leaked=$(curl -sSL -o /dev/null -w '%{http_code}' -A giinrecord-human-tasks https://giinrecord.jp/__not-found/index.html)
  log "  1) 404 の本文に「ページが見つかりません」: $body 件   （0 → 1 以上になれば #610 が解消）"
  log "  2) 存在しない URL の status:               $code404   （404 のまま。変わってはいけない）"
  log "  3) /compare の status:                     $compare   （200 のまま。**ここが壊れたら失敗**）"
  log "  4) /__not-found/index.html の status:      $leaked   （200 → 404 になれば #654 が解消）"
  [[ "$body" != "0" && "$code404" = "404" && "$compare" = "200" && "$leaked" = "404" ]] \
    && log "  4 つとも期待どおりです（#610 / #654 が解消しました）" \
    || { log "  期待と違う項目があります。docs/ops/pending-decisions.md の「1.」を見てください"; fail=1; }
  echo
  log "  さらに強い確認（headless Chromium で JS を切って開く）:"
  log "    pnpm --filter web browser-check -- --url https://giinrecord.jp"
  log "    **2 回走らせて、両方に出るものだけを見ること**（1 回目は一時的なネットワーク変動が出ることがある）"
fi

echo
if [[ "$APPLY" = 0 ]]; then
  log "dry-run でした。実行するには --yes を付けてください"
elif [[ "$fail" = 0 ]]; then
  log "全部できました。**Claude に「human-tasks を実行した」と伝えてください**（Issue を閉じます）"
else
  log "できなかったものがあります。上のログを Claude に伝えてください"
  exit 1
fi
