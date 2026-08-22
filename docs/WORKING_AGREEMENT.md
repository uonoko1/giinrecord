# 作業合意（Working Agreement）

## 役割
- **PO**: Claude（セッションの本体）。バックログ・受け入れ基準・スプリントゴール・レビュー統括・マージ判断。コードは書かない。
- **開発者**: 実装サブエージェント（最大5並列）。1人1PBI。自分のブランチで作業し PR を出す。
- **レビュアー**: 実装者とは別のサブエージェント。敵対的検証・セキュリティ・SOLID・テスト品質。

## 原則（プロダクト）
- 事実のみ。評価しない。すべての記録に `sourceUrl`。
- 事実（参院個人投票・提出者・発言）と推定（衆院会派態度）を型とUIで区別する。

## 開発の流れ
1. Ready な Issue を1つ取る。Issue の受け入れ基準を読む。
2. `git switch -c <type>/<issue#>-<slug>`（例 `feat/12-sangiin-vote-parser`）
3. **TDD**：失敗するテストを書く → 最小実装で通す → リファクタ。テストを後付けしない。
4. `pnpm lint && pnpm typecheck && pnpm test && pnpm build` が通ること。
5. PR を出す（テンプレに従う）。Issue を `Closes #N` で紐づける。
6. レビュアーの指摘に対応。Approve 後、PO が squash merge。

## Definition of Done
- [ ] 受け入れ基準をすべて満たす
- [ ] テストがあり、テストが先に書かれた痕跡がある（コミット履歴 or PR説明）
- [ ] lint / typecheck / test / build が CI で green
- [ ] 新しい外部データは `sourceUrl` と取得日時を持つ
- [ ] UI は design tokens（`apps/web/app/styles/tokens.css`）のみ使用。生の色コードを書かない
- [ ] 秘密情報・個人のメールアドレス等をコミットしない
- [ ] 他の PBI と衝突するファイルを最小化（共有ファイルの変更は Issue に明記）

## 並列作業の衝突回避
- ETL と Web は `data/` のファイル契約（`docs/DATA_CONTRACT.md`）だけで結合する。
- 共有ファイル（`routes.ts`, `tokens.css`, `shared/src/index.ts`）の変更は担当 PBI を1つに限定し、他は読み取りのみ。
- フィクスチャは `packages/etl/test/fixtures/` と `apps/web/app/test-fixtures/` に置き、他人のフィクスチャを書き換えない。

## テスト方針（t-wada に怒られないために）
- テストは仕様である。テスト名は「何が・どうなる」を日本語で書いてよい。
- 1テスト1アサーション群。モックは境界（HTTP）だけ。
- 実データの HTML はフィクスチャとして保存し、パーサーのテストは必ず実 HTML で行う。
- カバレッジ数値は目標にしない。境界値・異常系（欠損・表記ゆれ・空）を必ず書く。
