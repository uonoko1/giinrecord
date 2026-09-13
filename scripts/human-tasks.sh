#!/usr/bin/env bash
# **人間にしか打てないコマンドを 1 本にまとめたもの**（PO が作った。2026-09-13）。
#
# なぜ要るか:
#   PO（Claude）が接続手段で止められている作業を、人間に 1 回のコマンドで済ませてもらう。
#   **ユーザーからの指示: 「sudo パスワード以外の情報を私に用意させないで」。**
#   だから **VPS の IP はこのスクリプトが自分で引く**（`giinrecord.jp` の A レコード）。
#   **鍵も `~/.ssh/sakura-vps/id_ed25519` にある前提で明示する**（`Host giinops` が無い端末でも通る）。
#
# 何をするか（**2 つ**）:
#   1. **`site.conf` を本番に反映する**（#610 / #654 / #746）——ssh が要る。PO の端末には接続先が無い。
#   2. **branch protection 監視用の PAT を secret に置く**（#790 / #550 / #547）——
#      **`Branch protection` ワークフローが 6 日連続で failure だった。** 設計は正しく、
#      `GITHUB_TOKEN` では保護設定を読めないので「読めなかった」と報告し続けていた（#540）。
#      **PAT の生成だけは GUI でしかできないが、secret の設置は `gh` でできる。**
#      **人間に残る操作は「画面で PAT を作って、出てきた文字列を 1 回貼る」だけ。**
#
# **やらないこと**:
#   - **`git stash` 2 件の drop（#543）**——**`scripts/ci/forbidden-patterns.sh` が
#     `git stash` を全面的に禁止している**（#542 / #557。2026-09-06 に 3 回、担当者の未コミットの
#     作業が git の「元に戻す」で消えた）。**規則を作った側がスクリプトで破るのは筋が通らない。**
#     **#543 は人間が手で 2 回打つ**（`docs/ops/pending-decisions.md` の「3.」に手順がある）。
#   - **PAT の生成そのもの**（GitHub の設定画面での操作。API では作れない）
#   - **VPS 監視用 PAT の設置**（#155）——**別の secret**（`/etc/gikailog/monitor.token`、root 600）。
#     **ここで置くのは `BRANCH_PROTECTION_TOKEN` だけ。取り違えないこと。**
#   - **Sponsors / 広告 / NDL 照会**（#53 / #48 / #250）——外部に届く。方針の判断も要る
#
# **トークンの扱い**:
#   - **コマンドライン引数では受け取らない**（`sudo` と同じ理由。**シェルの履歴と `ps` に残る**）。
#     **環境変数か標準入力だけ。**
#   - **`set -x` を使わない**（展開されてトークンがログに出る）。
#   - **値は `echo` / `printf` / `log` に渡さない。** `gh` にも**標準入力で**渡す（引数に載せない）。
#
# 使い方:
#   bash scripts/human-tasks.sh          # 何をするかだけ出す（dry-run）
#   bash scripts/human-tasks.sh --yes    # 実行する（**IP も鍵も渡さなくてよい**）
#
#   PAT を置くとき（どちらでもよい。**引数では渡せない**）:
#     BRANCH_PROTECTION_TOKEN=<貼る> bash scripts/human-tasks.sh --yes
#     pbpaste | bash scripts/human-tasks.sh --yes --set-token      # 標準入力から読む
#
#   接続先を上書きしたいときだけ `--host <IP>` か `GIINOPS_HOST=<IP>`。
#   **ふだんは要らない。**
#
#   Tests: scripts/ci/test/human-tasks.test.sh（ssh / curl / getent / gh はスタブ。実際には何もしない）
set -euo pipefail

APPLY=0; HOST="${GIINOPS_HOST:-}"; READ_TOKEN_STDIN=0
usage() {
  cat >&2 <<'USAGE'
usage: human-tasks.sh [--yes] [--host <IP>] [--set-token]
  --yes         実際に実行する（既定は dry-run。何をするか出すだけ）
  --host <IP>   ssh の接続先を上書きする（ふだんは要らない。自分で名前解決する）
  --set-token   BRANCH_PROTECTION_TOKEN を**標準入力から**読む

  **トークンは引数では渡せません**（シェルの履歴と ps に残るため）。
  環境変数 BRANCH_PROTECTION_TOKEN か、--set-token + 標準入力で渡してください。
USAGE
  exit 2
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes) APPLY=1; shift ;;
    --host) HOST="${2:-}"; shift 2 ;;
    --set-token) READ_TOKEN_STDIN=1; shift ;;
    *) usage ;;
  esac
done

log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }

# ssh の宛先を決める。**人間に IP を用意させない**（ユーザーの指示）:
#   1. `~/.ssh/config` に `Host giinops` があればそれを使う
#   2. `--host` / `GIINOPS_HOST` が渡されていればそれ
#   3. **どちらも無ければ `giinrecord.jp` の A レコードを自分で引く**
#      （本番のサイトが載っているホストなので、これが VPS の IP である）
ssh_target() {
  if grep -qi '^[[:space:]]*Host[[:space:]].*\bgiinops\b' "${HOME}/.ssh/config" 2>/dev/null; then
    echo "giinops"; return
  fi
  if [[ -z "$HOST" ]]; then
    HOST=$(getent ahostsv4 giinrecord.jp 2>/dev/null | awk '{print $1; exit}')
  fi
  [[ -n "$HOST" ]] || return 1
  echo "giinops@${HOST}"
}

# `Host giinops` が無い端末では、**どの鍵を出すかが決まらず Permission denied になる**
# （`docs/ops/deploy.md`）。**鍵は ubuntu と同じもので、ユーザー名だけが違う。**
# **配列で持つ**——文字列にして `$(...)` で展開すると単語分割の扱いが曖昧になる（SC2046）。
ssh_opts=()
set_ssh_opts() {
  local key="${HOME}/.ssh/sakura-vps/id_ed25519"
  ssh_opts=()
  if [[ "$1" == giinops@* && -r "$key" ]]; then ssh_opts=(-i "$key" -o IdentitiesOnly=yes); fi
}

fail=0

# ---- 1. site.conf を本番に反映する（#610 / #654 / #746）---------------------------------------------
echo
log "== site.conf を本番に反映する（#610 / #654 / #746）=="
if true; then
  if ! target=$(ssh_target); then
    log "  ssh の接続先が分かりません（giinrecord.jp の名前解決にも失敗しました）。"
    log "    ネットワークを確かめるか、--host <IP> か GIINOPS_HOST=<IP> で渡してください"
    fail=1
  else
    # **`up -d` だけでは足りない**: site.conf は bind mount した単一ファイルなので、
    # git pull では inode が変わるだけでコンテナは古いものを掴んだまま（docs/ops/deploy.md）。
    cmd='sudo -n git -C /opt/giinrecord pull && sudo -n docker compose -f /opt/giinrecord/deploy/docker-compose.yml up -d --force-recreate'
    if [[ "$APPLY" = 0 ]]; then
      # **IP は出さない**（このスクリプトのログが貼られても漏れないように。
      # `scripts/ci/forbidden-patterns.sh` の ip-address 規則と同じ趣旨）。
      log "  [dry-run] ssh <giinops@VPS> '$cmd'"
    else
      log "  ssh で反映します（接続先は伏せます）"
      set_ssh_opts "$target"
      # shellcheck disable=SC2029  # $cmd はローカルで組み立てた固定文字列。クライアント側展開が意図どおり
      if ssh "${ssh_opts[@]}" "$target" "$cmd"; then log "  反映しました"; else log "  ssh が失敗しました"; fail=1; fi
    fi
  fi
fi

# ---- 反映の確認（#610 / #654 / #746 を実際に見る）----------------------------------------------------
if [[ "$APPLY" = 1 && "$fail" = 0 ]]; then
  echo
  log "== 反映の確認 =="
  # **#746: 2026-09-13 に、このスクリプトは「4 つとも期待どおり」と報告したのに 200 が残っていた。**
  # **見ていたのが `/__not-found/index.html` だけで、`/__not-found` と `/__not-found/` を見ていなかった。**
  # `try_files $uri $uri/index.html` が末尾なしを index.html に内部解決し、`internal` は
  # **外部からの要求しか拒まない**ので、綴りによって 404 と 200 が分かれていた。
  # **だから「not-found の綴りを 1 つだけ見る」のをやめ、3 つとも見る。**
  # **/compare を見るのも同じくらい大事**——SPA fallback を使う**正常な**ページなので、
  # そこが壊れていないことまで見て、はじめて成功と言える（docs/ops/pending-decisions.md）。
  code() { curl -sSL -o /dev/null -w '%{http_code}' -A giinrecord-human-tasks "https://giinrecord.jp$1"; }
  body=$(curl -sSL -A giinrecord-human-tasks https://giinrecord.jp/no-such-page-12345 | grep -c ページが見つかりません || true)
  code404=$(code /no-such-page-12345)
  compare=$(code /compare)
  log "  1) 404 の本文に「ページが見つかりません」: $body 件   （0 → 1 以上になれば #610 が解消）"
  log "  2) 存在しない URL の status:               $code404   （404 のまま。変わってはいけない）"
  log "  3) /compare の status:                     $compare   （200 のまま。**ここが壊れたら失敗**）"
  # **綴り違いを 1 つずつ。** どれか 1 つでも 404 でなければ失敗にする（#746）。
  not_found_bad=0
  for path in /__not-found /__not-found/ /__not-found/index.html; do
    got=$(code "$path")
    log "  4) $path の status: $got   （404 でなければ #654 / #746 が未解消）"
    [[ "$got" = "404" ]] || not_found_bad=1
  done
  # **`A && B || C` は if-then-else ではない**（SC2015。B が失敗すると C も走る）。
  # ここは「全部期待どおりか」で分岐したいので、素直に if で書く。
  if [[ "$body" != "0" && "$code404" = "404" && "$compare" = "200" && "$not_found_bad" = 0 ]]; then
    log "  6 つとも期待どおりです（#610 / #654 / #746 が解消しました）"
  else
    log "  期待と違う項目があります。docs/ops/pending-decisions.md の「1.」を見てください"
    fail=1
  fi
  echo
  log "  さらに強い確認（headless Chromium で JS を切って開く）:"
  log "    pnpm --filter web browser-check -- --url https://giinrecord.jp"
  log "    **2 回走らせて、両方に出るものだけを見ること**（1 回目は一時的なネットワーク変動が出ることがある）"
fi

# ---- 2. branch protection 監視用の PAT を secret に置く（#790 / #550 / #547）------------------
# **`Branch protection` ワークフローは 2026-09-08 以降、毎日 failure で終わっていた。**
# **設計は正しい**——`GITHUB_TOKEN` では保護設定を読めないので exit 2（読めない）を報告し続けていた
# （#540）。**問題は、正しい設計が赤いまま何日も置かれること**（毎日赤いものは、赤いこと自体が
# 見えなくなる。同じ形で secret scanning の検出を 21 日見落とした——#785 / #786）。
#
# **ワークフロー側の変更は要らない。** `.github/workflows/branch-protection.yml` は既に
# `${{ secrets.BRANCH_PROTECTION_TOKEN || secrets.GITHUB_TOKEN }}` を使っており、
# **secret を置いた次の実行から自動でそちらを使う。**
BP_SECRET=BRANCH_PROTECTION_TOKEN
BP_WORKFLOW=branch-protection.yml
BP_REPO=uonoko1/giinrecord

echo
log "== $BP_SECRET を置く（#790 / #550 / #547）=="
# **`deploy.md` を開かせない。** 必要な設定をここで読み上げる（原典は docs/ops/deploy.md
# 「main の保護設定」。**消さずに参照する**）。
log "  PAT は GitHub の画面でしか作れません。次の設定で作ってください:"
log "    1) Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token"
log "    2) Repository access : $BP_REPO **のみ**（All repositories にしない）"
log "    3) Repository permissions : Administration = Read-only / Issues = Read and write **だけ**"
log "       （それ以外は No access。**書き込み権限を与えない**）"
log "    4) 有効期限を決める（**期限は docs/ops/board.md に控えてください**。切れるとまた赤くなります）"
log "  作った文字列の渡し方（**引数では渡せません**。履歴と ps に残るため）:"
log "    BRANCH_PROTECTION_TOKEN=<貼る> bash scripts/human-tasks.sh --yes"
log "    または: bash scripts/human-tasks.sh --yes --set-token   ← 標準入力に貼る"
log "  **#155（VPS 監視用の PAT）は別物です**（置き場も用途も違う。docs/ops/monitoring.md）"

# **トークンの受け取り口は 2 つだけ: 環境変数と標準入力。**
# **引数は受け取らない**（`--token` は上の usage で弾かれる）。
BP_TOKEN="${BRANCH_PROTECTION_TOKEN:-}"
if [[ "$READ_TOKEN_STDIN" = 1 && -z "$BP_TOKEN" ]]; then
  # `read -r` は改行を落とす。**貼り付けの末尾改行がそのまま secret に入らないように。**
  IFS= read -r BP_TOKEN || true
fi

if [[ -z "$BP_TOKEN" ]]; then
  log "  トークンが渡されていないので、置きません（**site.conf の反映は上で済んでいます**）"
elif [[ "$APPLY" = 0 ]]; then
  # **既定は読むだけ。** `--yes` が無ければ `gh` を一度も呼ばない。
  log "  [dry-run] gh secret set $BP_SECRET --repo $BP_REPO  （値は標準入力で渡します）"
  log "  [dry-run] gh workflow run $BP_WORKFLOW --repo $BP_REPO"
else
  # **値は引数ではなく標準入力で渡す**（`ps` に出さない）。`--body-file -` が標準入力を読む。
  # **`log` にも `echo` にも $BP_TOKEN を渡さない。**
  if printf '%s' "$BP_TOKEN" | gh secret set "$BP_SECRET" --repo "$BP_REPO" --body-file - ; then
    log "  置きました（${#BP_TOKEN} 文字。**値は出しません**）"
    log "  期限を docs/ops/board.md に控えてください"
    log "  $BP_WORKFLOW を起動して、赤い期間が終わったかを見ます"
    if ! gh workflow run "$BP_WORKFLOW" --repo "$BP_REPO"; then
      log "  ワークフローを起動できませんでした"
      fail=1
    else
      # **起動しただけで終わらない。結果まで見る**（#790: 「置いた」と「緑になった」は別）。
      run_id=$(gh run list --repo "$BP_REPO" --workflow "$BP_WORKFLOW" --limit 1 --json databaseId -q '.[0].databaseId' || true)
      if [[ -z "$run_id" ]]; then
        log "  起動した run を見つけられませんでした。Actions → Branch protection を見てください"
        fail=1
      elif gh run watch "$run_id" --repo "$BP_REPO" --exit-status >/dev/null 2>&1; then
        log "  緑になりました: ok branch-protection: main は保護されている"
        log "  Issue 「[monitor] repo: main の保護設定を読めない」は自動で閉じます（#547 / #550）"
      else
        log "  まだ赤いです。Actions → Branch protection の run を見てください"
        log "    権限が足りない可能性: Administration = Read-only が入っているか確かめてください"
        fail=1
      fi
    fi
  else
    # **gh のエラー文は転記しない**（認証情報が混ざりうる。deploy.md と同じ扱い）。
    log "  secret を置けませんでした（**ワークフローは起動しません**）"
    log "    gh auth status で、このリポジトリに権限のあるアカウントか確かめてください"
    fail=1
  fi
fi

echo
if [[ "$APPLY" = 0 ]]; then
  log "dry-run でした。実行するには --yes を付けてください"
elif [[ "$fail" = 0 ]]; then
  log "できました。**Claude に「human-tasks を実行した」と伝えてください**（#610 / #654 / #746 を閉じます）"
  log "  **#543（退避された作業 2 件の破棄）は別です**——docs/ops/pending-decisions.md の「3.」を見てください"
else
  log "できなかったものがあります。上のログを Claude に伝えてください"
  exit 1
fi
