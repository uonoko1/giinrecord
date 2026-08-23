# Sprint 7（2026-08-23）

## ゴール
有権者が自分の選挙区の議員を見つけて、同じ採決で比べられる。

## レビュー（成果）
- ✅ 達成（staging で確認、production へは Sprint 8 冒頭でリリース）。/compare（最大4名、事実と推定を分離、一致率なし）、選挙区データ（KEN_ALL＋総務省、郵便番号 120,682 件、分割区 33 は複数候補）、Home の郵便番号入口、衆院本会議の発言、質問主意書（衆参）。
- 完了：#104 #111 #112 #107 #106（21pt）。7 スプリント累計 141pt。
- 同時進行した基盤：改名「議会ログ」、staging/production 分離（main→staging 自動、Release 手動）、Docker 化、ロゴ D、セキュリティ CI（gitleaks/forbidden/audit 必須）、運用ユーザー gikaiops、CI 鍵の rrsync 限定。本番 https://gikailog.jp 公開。

## レトロスペクティブ（検査と適応）

| 起きたこと | 原因 | 適応 |
|---|---|---|
| staging-setup を誤った引数で実行し、本番 conf の証明書参照と余計な証明書が発生（復旧済、停止なし） | PO がスクリプトの usage を確認せずに実行 | #141：引数検証と本番 conf 保護。PO は setup 系スクリプトの実行前に `--help`／usage を読む |
| bind mount の nginx 設定が `git pull` 後も反映されない | Docker が inode を掴む | 済：setup 系は `--force-recreate`。docs 化は #141 |
| 共用 VPS のポート 8080/8082 が既に使用中で2回やり直し | 事前にポート空きを確認しなかった | setup 系スクリプトの冒頭で `ss -tln` によるポート空き検査 |
| 新セキュリティ基準で sharp/pdfjs の high を検出し即修正 | 基準が効いた | 継続。Dependabot PR は audit が通れば PO がマージ |
| 横断 PBI（改名・staging・ロゴ）が同時に走り PO の衝突解消が4件 | 横断 PBI を並列にした | 横断 PBI は1スプリントに1本、単独 wave で先に |
| 差し戻し 1/5（セキュリティ由来） | — | — |

## 計測
- ベロシティ：21pt（機能）＋ 基盤 ≈ 25pt
- PO の手作業：VPS 復旧と設定1時間、衝突解消4件
