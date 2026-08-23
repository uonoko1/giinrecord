#!/usr/bin/env bash
# Issue #86 受け入れ基準: `docker compose run --rm etl <session>` と `pnpm etl <session>` の出力が byte-identical であることを示す。
#
#   scripts/etl-docker-diff.sh [session...]     （既定 221）
#
# 1. pnpm etl を走らせ data/ をスナップショット A に保存
# 2. コンテナ（deploy/docker-compose.etl.yml、ホストの uid）で同じ回次を走らせ data/ をスナップショット B に保存
# 3. A と B を diff。meta.json の fetchedAt（実行時刻）だけは同一になりえないので、比較前に固定値へ置換する
# 終了コード 0 = 同一。差分があれば diff を出して 1。
# 両方とも .cache を共有し、回次一覧・名簿・議案・会議録 API は毎回取得する（docs/ops/etl.md）ので、実行の合間に上流が更新されると
# 差分が出うる。その場合はもう一度流す。
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
SESSIONS=("${@:-221}")
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

snapshot() { # $1 = name
  rm -rf "$WORK/${1:?}"; cp -r data "$WORK/$1"
  # fetchedAt は ISO 時刻。実行ごとに変わる唯一の値なので固定して比較する。
  find "$WORK/$1" -name meta.json -exec sed -i -E 's/"fetchedAt": ?"[^"]*"/"fetchedAt":"FIXED"/g' {} +
}

echo "== pnpm etl ${SESSIONS[*]}"
pnpm etl "${SESSIONS[@]}" >"$WORK/pnpm.log" 2>&1 || { cat "$WORK/pnpm.log"; exit 1; }
snapshot pnpm

echo "== docker compose run --rm etl ${SESSIONS[*]}"
mkdir -p packages/etl/.cache
ETL_UID=$(id -u) ETL_GID=$(id -g) docker compose -f deploy/docker-compose.etl.yml run --rm --build etl "${SESSIONS[@]}" >"$WORK/docker.log" 2>&1 \
  || { cat "$WORK/docker.log"; exit 1; }
snapshot docker

# 所有者も確認（root で書かれていたら git add / 次の pnpm etl が困る）
if find data -not -user "$(id -u)" | grep -q .; then
  echo "NG: data/ にホストの uid 以外が所有するファイルがある"; find data -not -user "$(id -u)" | head; exit 1
fi

if diff -r "$WORK/pnpm" "$WORK/docker" >"$WORK/diff.txt"; then
  N=$(find "$WORK/pnpm" -type f | wc -l | tr -d ' ')
  echo "OK: byte-identical ($N files, fetchedAt を除く)"
else
  echo "NG: 差分あり"; head -50 "$WORK/diff.txt"; exit 1
fi
