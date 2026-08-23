# ETL image (Issue #86). Build from the repo root:
#   docker build -f packages/etl/Dockerfile -t gikailog-etl .
# Run (data/ and the HTML cache are bind mounts; run as the host uid so the files stay yours):
#   docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/data:/app/data" -v "$PWD/packages/etl/.cache:/app/packages/etl/.cache" gikailog-etl 221
# or `docker compose -f deploy/docker-compose.etl.yml run --rm etl 221`.
# Only the pnpm workspace is copied (see .dockerignore): no data/, no .cache, no .env, no secrets.
FROM node:24-alpine AS deps
# pnpm version pinned by package.json#packageManager
RUN corepack enable pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/etl/package.json packages/etl/
COPY packages/shared/package.json packages/shared/
# workspace 全体の lockfile を使いつつ、インストールするのは etl とその依存（shared）だけ。
RUN pnpm install --frozen-lockfile --filter @seiji-kiroku/etl...

FROM node:24-alpine
ENV NODE_ENV=production HOME=/tmp
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/etl/node_modules ./packages/etl/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared ./packages/shared
COPY packages/etl ./packages/etl
# 出力先（cli.ts は ../../../data/ = /app/data に書く）とキャッシュ置き場。実行時に bind mount で上書きされる。
RUN mkdir -p /app/data /app/packages/etl/.cache && chown -R node:node /app
# 非 root。`docker run --user <uid>:<gid>` で任意の uid に差し替えても動く（HOME=/tmp、書き込み先はマウントのみ）。
USER node
WORKDIR /app/packages/etl
ENTRYPOINT ["node", "--import", "tsx", "src/cli.ts"]
