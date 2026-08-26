# セキュリティポリシー / Security Policy

## 脆弱性の報告

議員レコード（giinrecord.jp）のセキュリティ上の問題を見つけた方は、**GitHub Security Advisories** から非公開で報告してください。

- 報告窓口: https://github.com/uonoko1/giinrecord/security/advisories/new （「Report a vulnerability」）
- 公開の Issue・PR・SNS には**書かないでください**。修正前に公開されると利用者と共用サーバーの他サイトに影響します。
- 報告には、再現手順・影響範囲・（あれば）修正案を含めてください。PoC は最小限で構いません。

### 対象範囲

| 対象 | 内容 |
|---|---|
| Web サイト | `https://giinrecord.jp` で配信している静的サイト（`apps/web/`）。XSS、CSP/ヘッダの不備、外部への意図しない通信、URL 組み立ての不備など |
| ETL | `packages/etl/`。取得先ドメインの許可リスト外へのアクセス、`data/` 以外への書き込み、パストラバーサルなど |
| デプロイ・運用 | `deploy/`、`.github/workflows/`、`scripts/`。権限昇格、共用 VPS の他サイトへの影響、秘密情報の露出 |
| リポジトリ | コミット履歴・フィクスチャ・ログに含まれる鍵・トークン・サーバー情報 |

対象外: 国会の公開データそのものの内容（誤りの指摘は通常の Issue へ）、第三者サービス（GitHub、さくらの VPS、Let's Encrypt）の脆弱性。

### 対応の目安

| 段階 | 目安 |
|---|---|
| 受領の返信 | 3 営業日以内 |
| 影響の判断と初回報告 | 7 日以内 |
| 修正（高・緊急） | 14 日以内を目標。共用サーバーに影響するものは最優先 |
| 修正（中・低） | 次のスプリントで対応 |
| 公開 | 修正のデプロイ後、報告者と合意した時点で Advisory を公開し、クレジットを記載（希望があれば匿名） |

個人開発プロジェクトのため、目安を超えることがあります。その場合も Advisory 上で状況を伝えます。

### 予防策（このリポジトリで行っていること）

- `SECURITY.md`（このファイル）と `docs/WORKING_AGREEMENT.md` の「セキュリティレビュー」節を毎 PR で適用
- CI（`.github/workflows/security.yml`）: gitleaks（PR の差分と週次の全履歴）、禁止パターン検査（`scripts/ci/forbidden-patterns.sh`）、`pnpm audit`（high 以上で失敗）。Dependabot 有効
- サーバーの IP アドレス・他サイトの名前はリポジトリに書かない（ドメイン名または変数で表す）

---

## Reporting a vulnerability (English)

Please report security issues in 議員レコード (giinrecord.jp) **privately** through GitHub Security Advisories:
https://github.com/uonoko1/giinrecord/security/advisories/new. Do not open a public Issue.

**Scope**: the static site at `https://giinrecord.jp` (`apps/web/`), the ETL (`packages/etl/`), the deploy and CI
tooling (`deploy/`, `.github/workflows/`, `scripts/`), and anything in the repository history (keys, tokens,
server details). Out of scope: the content of the public Diet records themselves, and third-party services.

**Response targets**: acknowledgement within 3 business days, triage within 7 days, fix for high/critical
issues targeted within 14 days (issues affecting the shared host come first). We publish the advisory after the
fix is deployed and credit the reporter unless they prefer to stay anonymous. This is a one-person project, so
targets may slip; we will keep you informed in the advisory thread.
