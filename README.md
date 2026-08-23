# 議会ログ (gikailog)

言ったことではなく、やったことを。 https://gikailog.jp

国会議員が本会議でどう投票し、どの法案を出し、何を発言したか —— 衆参両院と国立国会図書館の**公式記録だけ**を、出典リンク付きでそのまま並べるサイトです。評価・採点・推薦はしません。

## 原則

- **事実のみ。** すべての行に一次資料へのリンクと取得日時。
- **事実と推定を区別。** 参議院の個人別投票は事実。衆議院は個人別記録が公開されていないため「会派の態度」として別に扱う。
- **評価しない。** スコア・ランク・一致率・色による善悪表現を作らない。
- **検証可能。** コード（MIT）とデータ（CC BY 4.0）を公開。

## 構成

```
apps/web         React + TypeScript + Vite + React Router。ビルド時にプリレンダリングした静的サイト。サーバー実行コードは含まない
packages/etl     TypeScript のバッチ。GitHub Actions で日次実行し、衆参・会議録から data/ を生成
packages/shared  型定義
data/            正規化済み JSON（CC BY 4.0）
deploy/          VPS の配信設定（nginx コンテナ + docker compose。共用ホストの nginx は TLS と proxy のみ）
```

## 開発

```sh
pnpm install
pnpm test && pnpm typecheck && pnpm lint
pnpm dev            # apps/web
pnpm etl 221        # 第221回国会の参院投票結果を data/ に取得
```

## 進め方

スクラム。PBI は GitHub Issues、ボードは GitHub Projects。TDD。

## デプロイ（staging → production）

| 環境 | URL | いつ | ワークフロー |
|---|---|---|---|
| staging | https://staging.gikailog.jp（noindex） | `main` への push で自動 | `deploy-staging.yml` |
| production | https://gikailog.jp | 手動リリース：Actions → **Release** → Run workflow（ref、既定 `main`）→ Environment `production` の承認 | `release.yml` |
| 両方（データのみ） | — | 日次 ETL の data PR がマージされたら自動 | `deploy-data.yml`（`etl.yml` / `districts.yml` が起動） |

staging の初回構築で人間がやることは 2 つだけ：**DNS の A レコード `staging.gikailog.jp → VPS のアドレス`（`gikailog.jp` と同じ。IP はリポジトリに書かない、#133）** と、VPS で 1 回 `ssh -t "$VPS_SSH_HOST" 'sudo bash -s' < deploy/staging-setup.sh`（`VPS_SSH_HOST` は ssh エイリアス、既定 `sakura-vps`）。
GitHub 側は Environment `staging` / `production-data` に `DEPLOY_*` secrets（`production` と同じ）、`production` に required reviewers。詳細は `deploy/README.md` と `docs/ops/deploy.md`。

## ライセンス

コード: MIT / データ: CC BY 4.0（出典: 参議院・衆議院・国立国会図書館）
