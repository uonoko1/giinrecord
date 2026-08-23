# Sprint 6（2026-08-23）

## ゴール
「議会ログ」として独自ドメインで公開できる状態——改名、Docker 化（web/nginx・ETL）、衆院の仕上げ。

## レビュー（成果）
- ✅ 達成（VPS 切替は人間作業待ち）。改名「議会ログ」（title・OGP・About・README・LICENSE・アーカイブ、ブランドテスト付き）。web は nginx コンテナ（127.0.0.1:8080、compose、CI で compose up→URL スモーク）、ホスト nginx は proxy のみに縮小。ETL はコンテナ（非 root、Actions とローカルで byte-identical）。衆院：/about の推定カード更新、stance 折りたたみ、不変条件追加。PO スクリプト修正。go-live.sh（1回で Docker→コンテナ→proxy→certbot→計測）。
- #63 調査：参法の共同発議者・賛成者名は**一次資料に存在しない**（議案情報・PDF・法制局・公報104日分・会議録API・衆院経過）。/about「記録にないこと」に明記。会議録の委員会出席発議者は別種の事実として #109 へ。
- 完了：#84 #85 #86 #88 #89 #63（17pt）。6スプリント累計 120pt。
- 運用：ETL の push 失敗（stale ブランチ force-push が workflows 権限で拒否）→ ブランチ再作成方式に（#98）。衆院465名・議案451件が本番に。

## レトロスペクティブ（検査と適応）

| 起きたこと | 原因 | 適応 |
|---|---|---|
| PO 手編集の etl.yml が YAML として壊れ、dispatch 不能に | 手編集＋CI に actionlint が無かった | 済：全ワークフローに actionlint（#91）。PO はワークフローを直接触らず PBI 化を原則に |
| GITHUB_TOKEN の制約に4回目の遭遇（workflows 権限） | bot 周りの仕様を都度踏んでいる | docs/ops/etl.md に「GITHUB_TOKEN で出来ないこと一覧」を集約（#109 と一緒に起票） |
| #95/#96/#99 が改名（#84）と衝突 | 改名は全ファイルに触る横断 PBI | 横断 PBI は単独 wave で先に流す（今回は PO が3件手で解消、各10分） |
| 5並列で差し戻し 0/5（レビューは全件 non-blocking のみ） | 受け入れ基準に不変条件を列挙する運用が定着 | 継続 |

## 計測
- ベロシティ：17pt
- PO の手作業：衝突解消3件、ワークフロー修正2件、go-live スクリプト作成
