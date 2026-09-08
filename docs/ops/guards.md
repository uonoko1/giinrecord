# 守りの索引（事故 → それを防いでいるもの）

**「この事故は誰が防いでいるのか」を引くための索引です。**

## なぜこれがあるか

**2026-09-08 の 1 日で、PO が「守りが無い」と考えて実際には既にあったものが 6 件ありました**（#662）。
**6 件のうち `docs/` にあったのは 1 件だけで、残り 5 件はコードとテストの中**にありました。
実害も出ています——**#634 を起票し、既にある守りを二重に作りかけて同日中に取り下げ**ました。

`docs/WORKING_AGREEMENT.md` の各節はすべて「**どう作るか**」であって、
「**何がどこで守られているか**」ではありません。だから毎回 grep で探すことになり、
探す先は「自分が最初に思いついた場所」に偏りました。

## 使い方

**新しい守りを作る前に、まずここを引いてください。**
無ければ足す。**足したら、この表に行を足す**（下の「この索引は機械で検査されています」を読むこと）。

**ここに無いからといって「守りが無い」とは限りません。**
この索引は**下限**であって全数ではありません。無いと思ったら、
`packages/etl/test/` · `apps/web/app/**/*.test.*` · `deploy/test/` · `scripts/ci/test/` を
grep してから起票してください（**今日の 5 件はそこにありました**）。

## この索引は機械で検査されています

**一覧を手で書くだけだと、次に守りが増えたとき更新されず、
「索引に無い＝守りが無い」と読まれてかえって害になります**（それがこの索引を作った理由そのものです）。

`packages/etl/test/guards-inventory.test.ts` が、**この Markdown の表を実際に読んで**、
各行の `防いでいるもの` 欄に書かれたファイルが**実在すること**と、
そこに書いた**逐語の文字列が今もそのファイルにあること**を確かめます。

- **守りを消した／改名した → この表の行が指す先が消えるので落ちます。**
- **表の行だけ消して黙らせることはできません。** 行数の下限（`MIN_ROWS`）と、
  「この守りは絶対に索引から消えてはならない」という**核の集合**をテスト側に別に固定してあります。
- **書式**: `防いでいるもの` 欄は `` `パス` ``（バッククォートで囲んだリポジトリ相対パス）を
  1 つ以上含み、その直後の `` `…` `` は**そのファイルに逐語で存在する文字列**であること。

---

## 一次資料と記録の正しさ

| 事故 | 防いでいるもの |
|---|---|
| 一次資料の URL がリンク切れになったまま気付かない | `packages/etl/src/fetch.ts` の `if (!res.ok) throw new Error` で ETL が落ち、`.github/workflows/etl.yml` の `Open failure Issue` が Issue を立てる |
| ETL が回らない月の間にリンクが死ぬ（地方は月1回） | `scripts/ci/link-check.sh`（`LINK_CHECK_UA` で名乗り、`2回とも落ちたものだけ` を報告）を `.github/workflows/link-check.yml` が週1（`Link check (weekly)`）で回す。テストは `scripts/ci/test/link-check.test.sh`（#646） |
| 別人の記録を出す（表決 PDF の氏名 → 名簿） | `packages/etl/src/sources/local/name-match.ts` は候補が 2 人以上なら `return { memberId: "", candidates: [] }` で**選ばない**（#569）。テストは `packages/etl/test/local-name-match.test.ts` |
| 氏名が PDF の文字層で 1 文字落ちる | `packages/etl/src/sources/local/name-match.ts` の `matchBySubsequence`（部分列一致）。BMP 外の `𠮷` と康熙部首 `⾧` は `ITAIJI` 表で寄せる（#617/#648） |
| 氏名が壊れているのに気付かず本番に出る | `packages/etl/src/local-assemblies.ts` の `kanaNameRatioExceeds`（かな長と氏名長の検算。#632）。`packages/etl/src/dataset.ts` が `members/index.json` にも掛ける |
| 氏名正規化の規則が県ごとに勝手に分岐する | `packages/etl/test/name-normalization-table.test.ts` が `normalizeName` と `localNameKey` の畳み方を表として固定する（#581/#636） |
| 会派の記録を本人の記録として見せる | `apps/web/app/routes/member-tabs.test.tsx` が `所属会派の記録（推定）本人の投票ではありません` を固定する（#238） |
| 議員ページの出典が「実際に使っていない source」を含む | `apps/web/app/lib/member-sources.test.ts`（`allowlist（出るべき集合と完全一致）` で固定。#339） |
| 出力の並び順が実行環境のロケールで変わる | `packages/etl/test/stable-order.test.ts`（`localeCompare` を使わせない。#244 の CI 失敗の回帰） |

## テスト・検査そのものが死ぬ

| 事故 | 防いでいるもの |
|---|---|
| `deploy/test/*.test.sh` が消えて無言で緑になる | `packages/etl/test/deploy-test-inventory.test.ts` の `INVENTORY` と `EXPECTED_COUNT`（別パッケージ・別ランナーから数える。#513/#526） |
| 残り 3 つの glob（web/etl/scripts-ci）でテストが消えて無言で緑になる | `packages/etl/test/test-file-inventory.test.ts` の `WEB_TEST_FILES_MIN` / `ETL_TEST_FILES_MIN` / `CI_TEST_FILES_MIN`（#533） |
| テストが `exit 0` に差し替えられて素通りする | `packages/etl/test/deploy-test-inventory.test.ts` の `GATES` と `minAssertions`（コメント化して黙らせる道を塞ぐ。#526） |
| 検査器そのものが壊れて緑のまま（検査器自身のテストが無い） | `apps/web/app/test-tools/value-imports.test.ts`（`検査そのものを検査する。`。#451）／`deploy/test/nginx-headers-probe-safety.test.sh`（門に悪い location を食わせる。#642） |
| テスト間でグローバルが漏れて隣のテストを壊す | `apps/web/app/test-tools/global-leak-guard.ts` の `installGlobalLeakGuard`。配線されているかは `apps/web/app/test-tools/global-leak-guard.e2e.test.ts` が別プロセスから見る（#512） |
| `set -o pipefail` + 早期終了する読み手で検査が確率的に偽になる | `deploy/test/pipefail-sigpipe.test.sh`（`set -o pipefail` と早期終了する読み手の組。#527） |

## CI とリポジトリの運用

| 事故 | 防いでいるもの |
|---|---|
| `main` のブランチ保護が弱められる（差分に出ない） | `deploy/monitor/branch-protection.sh`（`required_status_checks` を API から読む）を `.github/workflows/branch-protection.yml` が回す。Issue の開閉は `deploy/monitor/branch-protection-report.sh`（#521/#540） |
| deploy の Environment の保護設定が黙って変わる（差分に出ない） | `deploy/monitor/environment-protection.sh` の `EXPECTED_RULES` を `.github/workflows/environment-protection.yml` が回す。Issue の開閉は `deploy/monitor/environment-protection-report.sh`（#659/#661） |
| 必須チェックと実在する job の対応が崩れる | `packages/etl/test/branch-protection-jobs.test.ts` の `REQUIRED_CHECKS`（#541/#601） |
| ワークフローが無限ループで既定の 6 時間走る | `packages/etl/test/workflow-timeout.test.ts` が `timeout-minutes` を全 job に要求する（#556/#574） |
| 古い `main` から切った枝が、main が得た行を黙って消す | `scripts/ci/stale-base.sh`（`merge-base` より後に main が得た行が枝に無いかを見る）。テストは `scripts/ci/test/stale-base.test.sh`（#536） |
| 秘密・サーバー情報がリポジトリに入る | `scripts/ci/forbidden-patterns.sh`（`private-key` / `github-token` / `aws-key` / `env-file` / `ip-address` / `forbidden`。#133） |
| 破壊的な git（`reset --hard` 等）を scripts に書いて未コミットの作業を消す | `scripts/ci/forbidden-patterns.sh` の `destructive-git` 規則（#542/#557）。退避は `scripts/dev/mutate.sh` を使う |
| 高深刻度の脆弱性を無期限に放置する | `scripts/ci/audit.sh`（`audit-ignore.txt` の例外は必ず期限付き）と `scripts/ci/audit-ignore.txt`（#133） |
| shellcheck の対象・版が CI と手元でずれる | `scripts/ci/shellcheck.sh`（`--list` の対象と `--pinned-version` の固定版が 1 か所。#154/#552） |
| ビルド成果物がリポジトリに入る | `apps/web/app/lib/repo-hygiene.test.ts`（`check-ignore` で判定。文字列一致ではなく git の判定） |
| 本番のコードが「最後のリリース」から外れる | `scripts/ci/released-ref.sh`（`resolve` / `overlay`。#134） |

## 配信（nginx / VPS）

| 事故 | 防いでいるもの |
|---|---|
| プローブ生成が docroot の外に出る | 入口 `deploy/test/nginx-headers.test.sh` の `location_shape_ok`、出口 `assert_confined`、実体 `assert_no_symlink_ancestor`。門が働くことは `deploy/test/nginx-headers-gate-behavior.test.sh`（#505/#580/#642/#652） |
| セキュリティヘッダが `add_header` の非継承で消える | `deploy/test/nginx-headers.test.sh`（`Permissions-Policy` を含め、本物の nginx を起動して実レスポンスを見る。#482） |
| 存在しない URL が 200 と SPA fallback を返す | `deploy/test/nginx-404.test.sh`（実 nginx で `try_files` の実ステータスを見る）＋ `packages/etl/test/deploy-docker.test.ts`（設定文字列側。#325） |
| 設定が壊れたまま `nginx -t && reload` が黙って成功扱いになる | `deploy/test/nginx-reload.test.sh` が全スクリプトに `reload_nginx()` を要求する（#133） |
| 運用ユーザー `giinops` から root に昇格できてしまう | `deploy/test/ops-user-setup.test.sh`（`NOPASSWD` の中身を allowlist で判定。#333） |
| 監視ログが無制限に肥る（共用 VPS） | `deploy/test/logrotate.test.sh`（`logrotate` 設定がこのプロジェクトのログだけを名指しする。#288） |
| 本番と staging で設定がずれる | `deploy/test/apply-all.test.sh`（`apply-all.sh` が 3 本を正しい引数・順で流す。#398/#141） |
| deploy 鍵が docroot の外に書ける | `packages/etl/test/workflow-deploy-concurrency.test.ts`（`rrsync` で固定。#308） |

## 画面（フォント・色・押しやすさ）

| 事故 | 防いでいるもの |
|---|---|
| 本番のフォントサブセットに議員名の字が無い | `apps/web/app/lib/font-subset-coverage.test.ts`（`woff2Chars` で woff2 の cmap を実際に読む。`.txt` の主張を信じない。#477/#520） |
| サブセットを作る側と検査する側が同じ源を読み、源が痩せると両方黙る | `apps/web/app/lib/head-font-data-source.test.ts`（`readHeadFontDataSource` が痩せたら鳴る。自己参照の下限。#520） |
| CSS が無いウェイトを要求して合成 face が描かれる | `apps/web/app/styles/font-weight-match.test.ts`（`FONT_FAMILIES` が持つウェイトだけを CSS が要求する。#452/#454） |
| 生の色コードでダークテーマが壊れる | `apps/web/app/components/no-raw-colors.test.ts`（`tokens.css` の変数だけを使う） |
| 表紙の上の文字が WCAG AA（4.5:1）を割る | `apps/web/app/styles/contrast.test.ts` の `contrast` と `luminance`（#394） |
| 押せる範囲が 24×24 CSS px を割る | `apps/web/app/styles/target-size.test.ts`（`sizeOnlyHeight` と Spacing 例外。WCAG 2.2 の 2.5.8。#413） |
| データセット全体が全ページのチャンクに引きずり込まれる | `apps/web/app/lib/site.test.ts`（`import.meta.glob` を持つモジュールから定数を import しない。#406） |
| `~/` エイリアスがどの実行環境でも解決できない形で入る | `apps/web/app/test-tools/no-path-alias.test.ts`（tsconfig の `paths` に頼らせない。#500） |
| tsx で直に走るスクリプトが `import.meta.glob` に触って落ちる | `apps/web/app/test-tools/tsx-build-scripts.test.ts`（tsx から辿れる先が `import.meta.glob` に触らない） |
| 未知のパスがどのルートにも一致せず `<title>Loading...</title>` で止まる | `apps/web/app/routes.test.ts`（`catch-all` ルートが在ること。#325） |
