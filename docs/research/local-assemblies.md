# 地方議会（47 都道府県議会 + 20 政令市議会）の表決公開状況 調査（Issue #128）

調査日: 2026-08-23。調査のみ（コード・データの変更なし）。各サイトは 1〜2 ページだけ取得（UA `Mozilla/5.0`、PDF は `curl -A "Mozilla/5.0 (compatible; gikailog-research)"`、間隔 ≥ 1 秒）。PDF の文字層の有無は `pdfjs-dist`（既に `packages/etl` の依存）で先頭 2 ページを抽出して確認した。

**原則（本リポジトリと同じ）**: 事実のみ。ページまたは PDF で実際に確認できたことだけを書き、確認できなかった欄は **不明**。「おそらく公開している」は書かない。分類は次の 4 値。

| 値 | 意味 |
|---|---|
| **公開** | 議員の氏名ごとに賛否（○×など）が載る一次資料を確認した |
| **会派別** | 会派（および無所属議員）ごとの賛否だけを確認した。個人票は無い |
| **総数のみ** | 議案ごとの結果（可決・同意…）や件数だけ。賛否の内訳は無い（「結果のみ」も含む） |
| **不明** | 1〜2 ページの範囲で賛否の資料に到達できなかった。無いとは言っていない |

as-of は「確認したページに載っていた最新の会期」。会議録システムは **ドメイン** を書く（運営会社名は一次資料で確認できていないので書かない）。

## 結論（要約）

- 47 都道府県: **公開 12**（青森・宮城・秋田・群馬・三重・奈良・鳥取・島根・徳島・高知・大分・沖縄）、**会派別 14**（千葉・静岡は無所属や記名投票のときだけ個人名が出るが、会派別に分類）、**総数のみ 14**、**不明 7**。
- 20 政令市: **公開 6**（さいたま・横浜・浜松・名古屋・岡山市・熊本市。岡山市は起立採決分のみ、名古屋は議案単位か要確認）、**会派別 12**、**総数のみ 2**、**不明 0**。
- 「公開」でも **ほぼ全部が PDF**。HTML 表で個人票を出しているのは 名古屋市会（市会だより）、岡山市議会、熊本市議会（議員ページの賛否一覧）、静岡県（不信任決議案のみ個人名）だけ。
- PDF は取得した 16 本すべてに文字層があった（画像 PDF は無し）。ただし氏名は縦書きで 1 文字 1 アイテムに分かれ、列の対応は x 座標で復元する必要がある（国会の HTML 表より難しい。`districts` の PDF 抽出と同じ系統の作業）。
- 機械可読な候補 Top-5 は末尾「Phase 1 候補」。

## 47 都道府県議会

| 都道府県 | 個人別表決 | 形式 | 出典 URL（確認したページ） | 会議録システム | as-of / 備考 |
|---|---|---|---|---|---|
| 北海道 | 不明 | — | https://www.gikai.pref.hokkaido.lg.jp/honkaigi/index.html, https://www.gikai.pref.hokkaido.lg.jp/category/d005/ | pref-hokkaido.gijiroku.com | 議案・決議案の一覧ページはあるが賛否の資料に到達できず |
| 青森 | **公開** | PDF | https://www.pref.aomori.lg.jp/soshiki/gikai/katsudo-shinsakekka.html（例 `files/326teirei_sanpi.pdf`） | www.pref.aomori.dbsr.jp | 令和8年6月 第326回定例会（更新日付 2026年7月10日）。ページ注記「平成25年9月第275回定例会から、議決結果は議員ごとの賛否状況を掲載しています。」。文字層あり・氏名は縦書き1文字1アイテム。**2026-09-07 に再調査（下の「青森県議会（#529）」）** |
| 岩手 | 会派別 | PDF | https://iwatekengikai.gijiroku.com/g07_gian_sanpi.asp | iwatekengikai.gijiroku.com | 令和8年6月定例会「議会議員の賛否の状況」。一部の会期は議員別と注記あり（中身は未確認） |
| 宮城 | **公開** | PDF（index は HTML） | https://www.pref.miyagi.jp/site/kengikai/kakohonkaigi.html → https://www.pref.miyagi.jp/site/kengikai/hyoketu080318.html → `/documents/63622/syuusei_hyouketsu080318.pdf` | ssp.kaigiroku.net/tenant/prefmiyagi | 第399回（令和8年2月定例会、2026-03-18 議決）。「各議員の表決状況」、約 20 年分。凡例「○賛成 ×反対 議 欠 － 棄 白」「簡易／起立」。文字層あり（5 ページ） |
| 秋田 | **公開** | PDF | https://pref.akita.gsl-service.net/doc/2024022000037/ | 不明 | 令和6年12月20日版まで確認（令和7・8年は未確認）。「各議員の表決状況はこちら」 |
| 山形 | 総数のみ | PDF | https://www.pref.yamagata.jp/600006/kensei/assembly/gikaikatsudou/association/r05/teireikai/r0506teireikaigaiyo.html | 不明 | 令和5年6月定例会「議決案件一覧」（件数と可決・同意のみ）。令和8年のページは 404／一覧のみ |
| 福島 | 会派別 | PDF | https://www.pref.fukushima.lg.jp/site/gikai/202406kekka.html | 不明 | 2024年6月定例会「各会派の賛否の状況」 |
| 茨城 | 会派別 | PDF | https://www.pref.ibaraki.jp/gikai/outline/r6/teireikai1.htm | pref.ibaraki.dbsr.jp | 令和6年第1回定例会「議案等に対する各会派等の採決態度」 |
| 栃木 | 会派別 | PDF | https://pref-tochigi.gijiroku.com/g07_gian_sanpi.asp | pref-tochigi.gijiroku.com | 令和7年度 第414回通常議会まで。「各会派の採決態度」 |
| 群馬 | **公開** | 不明（PDF/HTML 未確認） | https://www.pref.gunma.jp/site/gikai/list27.html → https://www.pref.gunma.jp/site/gikai/list27-60646.html | www07.gijiroku.com/voices | 令和8年 第2回定例会まで。「提出議案・賛否の状況（議員ごとの賛否の状況は平成24年9月定例会以降）」。個票ページの形式は 2 ページ目でも辿れず |
| 埼玉 | 総数のみ | HTML | https://www.pref.saitama.lg.jp/e1601/gikai-gaiyou/r0702/2.html | ssp.kaigiroku.net/tenant/prefsaitama | 令和7年2月定例会 議案一覧（番号・件名・要旨・審査結果） |
| 千葉 | 会派別（無所属は個人名） | PDF | https://www.pref.chiba.lg.jp/gikai/giji/gaiyou/r8/r8-2-teirei/index.html → `documents/giansanpi.pdf` | pref-chiba.gijiroku.com | 令和8年2月定例県議会「議案賛否一覧表」「請願賛否一覧表」「発議案賛否一覧表」。PDF 本文は会派列＋「原案に反対する会派等」欄に無所属議員の個人名（例「松澤議員」）。会派所属議員の個人票は会派欄からの読み取りになる（会派が割れた場合の扱いは未確認）→ 個人票とは言えないので 会派別 に分類 |
| 東京 | 会派別 | HTML + PDF | https://www.gikai.metro.tokyo.lg.jp/bill/reg2025-1.html | 不明 | 令和7年第1回定例会「各会派等の議案への賛否」（テキスト版 `newsletter/362/07.html`、PDF `pdf/362.pdf`） |
| 神奈川 | 会派別 | HTML 表 | https://www.pref.kanagawa.jp/gikai/p80113.html → https://www.pref.kanagawa.jp/gikai/gian_08dai2.html | ssp.kaigiroku.net/tenant/prefkanagawa | 令和8年第2回定例会。凡例「賛成＝〇 反対＝× 欠席者等＝▲」、列は会派略称（自民・立民・未来・公明・県政・共産・維新…） |
| 新潟 | 総数のみ | HTML | https://www.pref.niigata.lg.jp/site/gikai/r0302-giketukekka.html | ssp.kaigiroku.net/tenant/prefniigata | 令和3年2月定例会 議決結果（件数と可決・否決）。最新会期は未確認 |
| 富山 | 総数のみ | HTML（Shift_JIS） | https://web.pref.toyama.dbsr.jp/giketsu/giketsu2026-r08-06t.html | web.pref.toyama.dbsr.jp | 令和8年6月定例会。列は 議案番号・件名・議決年月日・議決の結果 |
| 石川 | 不明 | — | https://www.pref.ishikawa.lg.jp/gikai/index.html | pref-ishikawa.gijiroku.com | 賛否ページに到達できず（`voices/g07_gian_sanpi.asp` は 404） |
| 福井 | 会派別 | HTML 表 + PDF | https://www.pref.fukui.lg.jp/gikai/giankekka/index.html → https://www.pref.fukui.lg.jp/doc/gikai-giji/giankekka/giankekka_r8_5.html | 不明 | 令和8年度 6月・5月「議案等に対する各会派の賛否の状況」（列: 自・民・ふ・越・公） |
| 山梨 | 不明 | — | https://www.pref.yamanashi.jp/gikaisom/ | kaigiroku.pref.yamanashi.jp | トップに議決結果・賛否の導線なし |
| 長野 | 不明 | — | https://www.pref.nagano.lg.jp/gikai/chosa/teireikai/index.html → `houkoku/r806/index.html` | nagano.gijiroku.com | 令和8年6月定例会ページは 会期日程・知事提出議案・発言通告・議員提出議案・請願陳情・委員長報告のみ。賛否資料に到達できず |
| 岐阜 | 会派別 | HTML + PDF | https://www.pref.gifu.lg.jp/site/gikai/17256.html → `/uploaded/attachment/125620.pdf` | ssp.kaigiroku.net/tenant/prefgifu | 平成30年第1回定例会（古い例しか辿れず）。「賛多（賛成多数）」の議案だけ賛否内訳 PDF。PDF は会派列（無所属は個人列 無所属Ａ〜Ｄ）＋「会派等所属議員」の氏名表 |
| 静岡 | 会派別（記名投票時のみ個人名） | HTML 表 + PDF | https://www.pref.shizuoka.jp/kensei/kengikai/gikaiugoki/1003742/index.html → https://www.pref.shizuoka.jp/kensei/kengikai/gikaiugoki/1003742/1054197/1055138.html | 不明 | 令和5年6月定例会。通常の議案は会派列（自改・ふ県・公明…）、不信任決議案は議員名ごとに白票／青票を列挙。個人票は記名投票のときだけなので 会派別 に分類 |
| 愛知 | 不明 | — | https://www.pref.aichi.jp/site/gikai/kekka-gaiyo.html, https://www.pref.aichi.jp/site/gikai/koho.html | pref.aichi.dbsr.jp | 結果概要は 議会ニュース・県議会だより（PDF/テキスト）への導線のみ。賛否の有無は未確認 |
| 三重 | **公開** | PDF（index は HTML） | https://www.pref.mie.lg.jp/KENGIKAI/07976009017.htm → `/common/content/001242584.pdf` | 不明 | 令和8年2月定例会「議員別の賛否等の状況」（月ごとの PDF）。凡例「○賛成 ×反対 議 除 － 欠」。文字層あり（1 ページ） |
| 滋賀 | 不明 | — | https://www.shigaken-gikai.jp/g07_giketsu.asp（結果のみ）、https://www.shigaken-gikai.jp/g07_gian_sanpi.asp（文字化けで判読不能） | shigaken-gikai.jp | 検索結果の要約には「賛否状況を掲載」とあるが一次資料で確認できず |
| 京都 | 会派別 | HTML 表 | https://www.pref.kyoto.jp/gikai/katsudo/tere/index.html → https://www.pref.kyoto.jp/gikai/katsudo/tere/r0402-te/2202-giketsu.html | pref.kyoto.dbsr.jp | 令和4年2月定例会「賛否の状況」（自民・共産・府民・公明・維新）。最新会期は未確認 |
| 大阪 | 総数のみ | PDF/Word | https://www.pref.osaka.lg.jp/o170010/gikai_giji/hokoku/index.html | ssp.kaigiroku.net/tenant/prefosaka | 令和8年7月臨時会まで「会議報告（議決等結果一覧）」。賛否の内訳は無し |
| 兵庫 | 会派別 | PDF | https://web.pref.hyogo.lg.jp/gikai/teireikai/r07/r7_374/documents/taidor80323.pdf | kensakusystem.jp/hyogopref | 令和8年2月 第374回定例会「議案等に対する会派態度」（PDF 本文は抽出せず。表題から分類） |
| 奈良 | **公開** | PDF | https://www.pref.nara.lg.jp/n161/18579.html → https://www.pref.nara.lg.jp/n161/p114029.html → `/documents/24098/20260702_giinbetsu_hyoketsu.pdf` | ssp.kaigiroku.net/tenant/prefnara | 令和8年6月定例会（7月2日議決分）「議員別の議案等に対する表決結果」。文字層あり（2 ページ、会派＋氏名が縦書き） |
| 和歌山 | 総数のみ | HTML | https://www.pref.wakayama.lg.jp/prefg/200100/cms/d00155103.html → https://www.pref.wakayama.lg.jp/prefg/200100/cms/d00213753.html | pref.wakayama.lg.jp/gijiroku（自前） | 令和6年6月定例会「議案・採決結果等一覧」（件数と可決）。令和8年6月は一覧に載るが個別ページ未確認 |
| 鳥取 | **公開** | PDF（index は HTML 表） | https://www.pref.tottori.lg.jp/328150.htm → `/secure/1422216/R8.6.29_seiganchinjogiketsukekka.pdf` | pref.tottori.dbsr.jp | 令和8年6月定例会（6月29日議決分）。ページ注記「議員別の賛否の状況もご覧いただけます」。文字層あり（3 ページ、氏名は縦書き「○○議員」） |
| 島根 | **公開**（ETL 済 `pref-32` #221） | PDF | https://www.pref.shimane.lg.jp/gikai/ugoki/saikin/ → https://www.pref.shimane.lg.jp/gikai/ugoki/saikin/r0806/ → `index.data/r0806_giinbetu_kekka.pdf` | pref.shimane.dbsr.jp | 第499回（令和8年6月定例会）「議員別採決結果一覧」（1.3MB、4 ページ、文字層あり。付託委員会・採決結果の列つき）。**robots.txt は 404（2026-08-24 再確認。クロールの制限なし）／利用条件は `/cl.html`「著作権・リンク等について」に著作権法の範囲での利用とリンク自由の一般的記載のみで、機械的な取得を禁じる文言は無い**。議決日はこの PDF に無く、同じ会期ページの「議決結果一覧」（`r0806_giketu_kekka.pdf`）から読む |
| 岡山 | 総数のみ | PDF | https://www.pref.okayama.jp/site/gikai/09-02.html → https://www.pref.okayama.jp/site/gikai/1036198.html → `/uploaded/attachment/416789.pdf` | ssp.kaigiroku.net/tenant/prefokayama | 令和8年6月定例会「提出議案及び議決結果」（番号・概要のみ。PDF 先頭 2 ページで賛否なし） |
| 広島 | 総数のみ | PDF | https://www.pref.hiroshima.lg.jp/site/gikai/shingikekka.html | pref.hiroshima.dbsr.jp | 「Ｒ08.6審議結果」など会期ごとの PDF（表題から。本文未抽出） |
| 山口 | 会派別 | HTML 表 + PDF | https://www.pref.yamaguchi.lg.jp/site/gikai/25491.html | ssp.kaigiroku.net/tenant/prefyamaguchi | 令和3年2月定例会 議案審議結果表＋「議案に対する各会派の賛否の状況（PDF）」。最新会期は未確認 |
| 徳島 | **公開** | PDF（index は HTML） | https://www.pref.tokushima.lg.jp/gikai/honkaigi/gaiyou/ → https://www.pref.tokushima.lg.jp/gikai/honkaigi/r08/7314697/ → `/file/attachment/1064407.pdf` | ssp.kaigiroku.net/tenant/tokushimapref | 令和8年6月定例会「各議員の表決態度（7月3日採決）」。ページ注記「平成27年12月定例会以降について公表」。文字層あり（2 ページ、行＝議案・列＝議員で ○／議 が横に並ぶ。抽出しやすい） |
| 香川 | 総数のみ | HTML | https://www.pref.kagawa.lg.jp/gikai/jyoho/giketsu/6_2b.html → https://www.pref.kagawa.lg.jp/gikai/jyoho/giketsu/0806_t01.html | pref.kagawa.dbsr.jp | 令和8年6月定例会 議決一覧（議案番号・件名・審議結果・議決年月日） |
| 愛媛 | 総数のみ | HTML | https://www.pref.ehime.jp/site/gikai/152168.html | kensakusystem.jp/ehime | 第396回（令和8年6月）定例会 議員提出議案（番号・件名・提出日・付託委員会・議決日・結果） |
| 高知 | **公開** | PDF（index は HTML） | https://gikai.pref.kochi.lg.jp/activity/decision.html → `/_files/00156424/0806.pdf` | gikai.pref.kochi.lg.jp/minutes | 令和8年6月定例会「議員別賛否の状況」（ページ名そのもの）。文字層あり（2 ページ、会派名＋縦書き氏名）。**ETL 済み（pref-39、#220）**。robots.txt（2026-08-24 確認）は `Disallow: /search.html` `/reiki/` `/*.html.r` のみで、名簿（`/member/categories/`）・index（`/activity/decision.html`）・PDF（`/_files/`）は対象外。「ご利用案内」（`/use/`）は文字サイズ・背景色・読み上げの操作案内だけで、**機械取得を禁じる文言は無い**（フッタに「掲載の記事・写真・映像等の無断転載を禁じます」の著作権表示。転載の話で取得の禁止ではない） |
| 福岡 | 総数のみ | HTML | https://www.gikai.pref.fukuoka.lg.jp/site/honkaigi/saiketsu-0802.html | pref.fukuoka.dbsr.jp | 令和8年2月定例会「採決結果」（件名と「原案のとおり可決」） |
| 佐賀 | 不明 | — | https://www.pref.saga.lg.jp/gikai/list01707.html → https://www.pref.saga.lg.jp/gikai/list06636.html | pref.saga.dbsr.jp | 令和8年の会期ページは 議案件名一覧・委員会審議・委員長報告の導線のみ。検索要約の「意見書案と採決状況」は一次資料で未確認 |
| 長崎 | 総数のみ | HTML | https://www.pref.nagasaki.lg.jp/gikai/0706teirei/gian.html | ssp.kaigiroku.net/tenant/prefnagasaki | 令和7年6月定例会「議案及び採決結果」（議案番号・件名・議決年月日・議決の結果） |
| 熊本 | 総数のみ | HTML 表 + PDF | https://www.pref.kumamoto.jp/site/gikai/list4-16.html → https://www.pref.kumamoto.jp/site/gikai/269212.html | ssp.kaigiroku.net/tenant/prefkumamoto | 令和8年6月定例会「知事提出議案の議決結果」＋「議案等の採決結果表（PDF）」（表題から。PDF 本文未抽出） |
| 大分 | **公開** | PDF | https://www.pref.oita.jp/site/gikai/list10000-10040.html → https://www.pref.oita.jp/site/gikai/teishutugiantokextuka6-3.html → `/uploaded/attachment/2223458.pdf` | 不明 | 令和6年第3回定例会「議案等賛否一覧表（9月24日分）」。PDF 本文に「会派名」「議席番号 1〜43」「議員名」＋43 名の氏名、凡例「○賛成 ×反対 除 欠 議」。令和7・8年は未確認 |
| 宮崎 | 会派別 | PDF（index は HTML） | https://www.pref.miyazaki.lg.jp/gikai/session/teirei-rinji/index.html → https://www.pref.miyazaki.lg.jp/gikai/session/r8/6gatsu/20260618165259.html | 不明 | 令和8年6月定例会「各会派の議案・請願への賛否（PDF）」 |
| 鹿児島 | 総数のみ | HTML 表 + PDF | https://www.pref.kagoshima.jp/ha01/gikai/teireikai/tyokkinn/r6_1kai/gian.html | pref.kagoshima.dbsr.jp | 令和6年第1回定例会 知事提出議案（議案番号・件名・議決結果） |
| 沖縄 | **公開** | PDF | https://www.pref.okinawa.lg.jp/kensei/gikai/1016839/1037683/1037684.html | 不明 | 令和8年第1回（2月定例会）「議決状況（議案等に対する議員の賛否状況）」知事提出議案（2月18日・3月27日議決分）。PDF 本文未抽出（表題とページの説明から） |

## 20 政令指定都市議会

| 市 | 個人別表決 | 形式 | 出典 URL（確認したページ） | 会議録システム | as-of / 備考 |
|---|---|---|---|---|---|
| 札幌市 | 会派別 | PDF | https://www.city.sapporo.jp/gikai/html/shingikekka.html → `/gikai/html/documents/08_kekka2t.pdf` | sapporo.gijiroku.com | 令和8年第2回定例会「議決事件等一覧表」（11 ページ）。委員会結果欄に「（共反対）」のように反対会派だけ略記。個人票なし |
| 仙台市 | 会派別 | HTML 表 | https://www.gikai.city.sendai.jp/result/result/confe_2024/gian_r6_4.html | city.sendai.miyagi.dbsr.jp | 令和6年第4回定例会。列＝会派名（11 会派）＋採決結果 |
| さいたま市 | **公開** | PDF | https://www.city.saitama.lg.jp/gikai/003/002/hyouketutaido/index.html → https://www.city.saitama.lg.jp/gikai/003/002/hyouketutaido/p129237.html → `p129237_d/fil/0806hyouketutaido.pdf` | 不明（資料検索システム） | 令和8年6月定例会「議案表決態度一覧」。PDF 本文は会派見出しの下に議員氏名が個別に並ぶ（「議長：伊藤仕議員は除く」）、凡例「○賛成 ×反対 欠 退 除」。平成25年6月定例会以降 |
| 千葉市 | 会派別 | HTML 表 | https://www.city.chiba.jp/shigikai/sichoteisyutu2403.html | city.chiba.chiba.dbsr.jp | 令和6年第3回定例会。「賛否の状況」列は会派名、無所属は「無所属　黒澤議員」のように個人名 |
| 横浜市 | **公開** | PDF | https://www.city.yokohama.lg.jp/shikai/kiroku/kekka/kaihabetsu.html → `kaihabetsu.files/r8_2t_0605sanpi.pdf` | 不明 | 令和8年第2回定例会（6月5日議決）。ページ注記「令和２年第２回定例会からは議員別の賛否一覧を掲載」（それ以前は会派別）。文字層あり（2 ページ、縦書き氏名） |
| 川崎市 | 会派別 | PDF | https://www.city.kawasaki.jp/980/page/0000179675.html | 不明 | 令和7年第3回定例会「各会派及び無所属議員の賛否状況」 |
| 相模原市 | 会派別 | PDF（審議結果）＋議会だより | https://www.sagamihara-shigikai.jp/doc/2013120900035/ | ssp.kaigiroku.net/tenant/sagamihara | 「審議結果」PDF は結果のみ、「各議案における会派ごとの賛否状況」は さがみはら市議会だより へ誘導 |
| 新潟市 | 会派別 | 不明 | https://www.city.niigata.lg.jp/shigikai/index_honkaigi/honkaigi_kekka/index.html | www06.gijiroku.com/niigata | ページ注記「平成21年5月臨時会より、会派別の賛否の状況を公表」 |
| 静岡市 | 総数のみ | PDF | https://www.city.shizuoka.lg.jp/gikai/s006689.html → `/documents/6558/202606gatu_gigetukekka2.pdf` | city.shizuoka.shizuoka.dbsr.jp | 令和8年6月定例会 審議結果（表題から。PDF 本文未抽出） |
| 浜松市 | **公開** | PDF | https://www.city.hamamatsu.shizuoka.jp/gikai/r0802tei/teireikai.html → `/documents/171369/giinnsannpiitiran.pdf` | 不明 | 令和8年2月定例会「議員賛否一覧」。文字層あり（3 ページ、会派略称＋縦書き氏名 40 名超） |
| 名古屋市 | **公開** | HTML 表 | https://www.city.nagoya.jp/shikai/shingi/1030858/index.html、https://www.city.nagoya.jp/shikai/page/0000133190.html | 不明 | 市会だより第172号（6月定例会）「提出案件の賛否」: 会派名・議員名・選出区 × 議員提出議案／市長提出案件、値は 賛成／反対／欠席／議長のため議決に参加できない（88 名）。議案ごとではなく「案件群」単位に見える → 議案単位の個人票かは要確認 |
| 京都市 | 会派別 | HTML 表 | https://www2.city.kyoto.lg.jp/shikai/honkaigi/R05/gian11.html | 不明 | 令和5年11月市会「議案・審議結果」列＝自民・維京国・共産・公明… ○× |
| 大阪市 | 会派別 | HTML 表 | https://www.city.osaka.lg.jp/shikai/page/0000001592.html → https://www.city.osaka.lg.jp/contents/wdu260/result/202605.html | 不明 | 令和8年5月市会。列＝維新・公明・自民市民・自国くらし・共産・無所属… |
| 堺市 | 会派別 | HTML → 個票 | https://www.city.sakai.lg.jp/shigikai/kekka/giketsukekka/index.html | www12.gijiroku.com/sakai | 「主な議案に対する会派等の賛否一覧」（主な議案のみ） |
| 神戸市 | 会派別 | PDF | https://www.city.kobe.lg.jp/z/shikaijimukyoku/giann_etc/r8/2gatsukekka.html → `/documents/83465/20260326_sanpiichiran2.pdf` | city.kobe.hyogo.dbsr.jp | 令和8年第1回定例市会（2月）「議案等に対する各会派の賛否一覧」 |
| 岡山市 | **公開**（起立採決のみ） | HTML 表 | https://www.city.okayama.jp/gikai/0000078068.html | 不明 | 令和8年（7月28日・6月23日・3月17日議決分）。「本会議において、起立により採決を行った議案に対する議員ごとの賛否を掲載」。簡易表決（全会一致）の議案は載らない |
| 広島市 | 会派別 | PDF | https://www.city.hiroshima.lg.jp/gikai/nittei/1027907/1043766.html | 不明 | 令和7年第3回定例会「各会派の賛否態度」PDF（`sanpi09.pdf`） |
| 北九州市 | 総数のみ | PDF | https://www.city.kitakyushu.lg.jp/sigikai/menu11_00089.html → https://www.city.kitakyushu.lg.jp/sigikai/g0100425.html | 不明（議会中継は smart.discussvision.net） | 令和8年6月定例会「会議結果一覧（PDF）」（表題から。本文未抽出） |
| 福岡市 | 会派別 | HTML 表 | https://gikai.city.fukuoka.lg.jp/result/r7_gikai4 | 不明 | 令和7年第4回定例会。列＝自民・公明・市民ク・維新・共産・自民新・新風＋無所属 5 列（無所属は個人） |
| 熊本市 | **公開** | HTML 表（議員ページ） | https://kumamoto-shigikai.jp/namelist/pub/detail.aspx?c_id=3&mem_id=148&lsttype=1、https://kumamoto-shigikai.jp/agenda/pub/ailist.aspx?c_id=4&coy_id=15&co_id=198 | kumamoto.gijiroku.com | 議員ごとのページに「賛否一覧 ○賛成 ×反対 －議長・欠席・除斥・退席」（会議名・議案・備考・賛否）。議案一覧側は結果のみ。賛否は画像アイコンで表現（alt の有無は未確認） |

集計（上表を数えたもの）:
- 都道府県 47 = 公開 12（青森・宮城・秋田・群馬・三重・奈良・鳥取・島根・徳島・高知・大分・沖縄）＋ 会派別 14（岩手・福島・茨城・栃木・千葉※・東京・神奈川・福井・岐阜・静岡※・京都・兵庫・山口・宮崎）＋ 総数のみ 14（山形・埼玉・新潟・富山・大阪・和歌山・岡山・広島・香川・愛媛・福岡・長崎・熊本・鹿児島）＋ 不明 7（北海道・石川・山梨・長野・愛知・滋賀・佐賀）。※千葉は無所属議員だけ個人名、静岡は記名投票（不信任決議案）のときだけ個人名。
- 政令市 20 = 公開 6（さいたま・横浜・浜松・名古屋・岡山市・熊本市）＋ 会派別 12（札幌・仙台・千葉市・川崎・相模原・新潟市・京都市・大阪市・堺・神戸・広島市・福岡市）＋ 総数のみ 2（静岡市・北九州市）。

## 会議録システムと利用条件

- 見つかったドメインは 4 系統: `*.gijiroku.com`（北海道・岩手・栃木・群馬・千葉・石川・長野・札幌・新潟市・堺・熊本市）、`*.dbsr.jp`（青森・茨城・富山・愛知・京都・鳥取・島根・広島・香川・福岡・佐賀・鹿児島・仙台・千葉市・静岡市・神戸）、`ssp.kaigiroku.net/tenant/*`（宮城・埼玉・神奈川・新潟・岐阜・大阪・奈良・岡山・山口・徳島・長崎・熊本・相模原）、`kensakusystem.jp/*`（兵庫・愛媛）。自前は 和歌山（`/gijiroku/`）・高知（`/minutes/`）・山梨（`kaigiroku.pref.yamanashi.jp`）。
- 利用規約: 取得した 4 サイト（pref-hokkaido.gijiroku.com、pref.ibaraki.dbsr.jp、ssp.kaigiroku.net/tenant/prefsaitama、kensakusystem.jp/hyogopref）のトップには **機械取得や複製を禁じる文言は見当たらなかった**（著作権表示は各県、「冊子と表記が異なる場合がある」「正式な記録ではない」注記のみ）。運営会社名はページに出ていないので書かない。**これは「禁止されていない」であって「許可されている」ではない**。ETL 化する議会には事前に事務局へ問い合わせる（国会と違い地方議会はサイトごとに判断が要る）。
- robots.txt（候補ホスト 18 件を取得）: 賛否ページを Disallow しているものは無かった。`pref.akita.gsl-service.net` は `User-agent: GPTBot Disallow: /` のみ、`kumamoto-shigikai.jp` はカレンダー系 aspx のみ、鳥取は `/secure/221685/` のみ（賛否 PDF は `/secure/1422216/`）。宮城・島根・沖縄・岡山市・横浜・千葉県は robots.txt が 404（HTML が返る）。
- 参考（未取得）: 奈良県議会が全 47 都道府県に行った「議案の賛否の公表状況」調査 PDF `http://www.pref.nara.jp/secure/58014/03si02.pdf`（403 で取得できず）。二次資料だが、本表の 不明 を埋めるときの当たりになる。

## 名簿・議案情報（Phase 1 候補について確認した範囲）

| 議会 | 名簿 | 会派・選挙区 | 議案（提出者） |
|---|---|---|---|
| 宮城県 | https://www.pref.miyagi.jp/site/kengikai/meibo/index.html（HTML） | 表決 PDF に会派略称あり | 提出議案ページ `gian{回次}.html`（知事提出のみ確認。議員提出議案の発議者は未確認） |
| 徳島県 | 会派別・選挙区別の議員紹介（HTML） | 表決 PDF に会派 | 未確認 |
| 鳥取県 | 未確認 | 表決 PDF は氏名のみ（会派は別資料） | 提出議案ページ https://www.pref.tottori.lg.jp/63834.htm |
| 奈良県 | 会派別・選挙区別・五十音順の名簿（HTML） | 表決 PDF に会派 | 未確認 |
| 三重県 | 未確認 | 表決 PDF に会派 | 提出予定議案概要ページあり |
| 岡山市 | 未確認 | HTML 表に会派 | 同ページに議案名 |

名簿と議案の提出者は今回の 1〜2 フェッチ制約では深掘りしていない。Phase 1 の着手時に候補 5 議会だけ個別に調べる。

## Phase 1 候補（機械可読な個人別表決、上位 5）

判断軸: (1) 個人票が一次資料で確認できた、(2) 一覧ページが機械で辿れる（会期 → PDF/HTML の URL が規則的）、(3) PDF の文字層があり表構造が単純、(4) 遡れる期間、(5) 更新が継続している。

| 順位 | 議会 | 理由 | 懸念 |
|---|---|---|---|
| 1 | **宮城県** | 個人票 PDF を約 20 年分（2012 以前は PDF、以後 HTML index→PDF）。index が HTML で会期ごとに規則的（`hyoketu{yymmdd}.html`）。凡例が明文（○×議欠－棄白、簡易／起立）。文字層あり | 氏名が縦書き 1 文字ずつ → x 座標で列復元。議長・簡易表決の扱いを型に入れる |
| 2 | **徳島県** | PDF が「行＝議案、列＝議員」で ○／議 が横並びに抽出でき、最も構造が素直。平成27年12月以降と明記 | 列見出し（議員名）の抽出と順序の対応は要確認。会期 index は `honkaigi/r08/{id}/` で id が規則的でない。→ #183 で実装（`pref-36`。氏名は縦書き 1 文字ずつで宮城と同じ罫線方式、採決日ごとに PDF が分かれる、節ごとに凡例が違う、表決方法・人数の欄なし） |
| 3 | **鳥取県** | 会期ごとの HTML index に結果表＋「議員別の賛否の状況」PDF。文字層あり。robots.txt も妨げず | PDF は「○○議員」表記（姓のみ）→ 同姓は名簿と突合が要る |
| 4 | **奈良県** | 「議員別の議案等に対する表決結果」PDF（2 ページ、会派＋氏名）。会期 index が HTML で規則的（`/n161/p{id}.html`） | 議決日ごとに PDF が分かれる（7月2日分 など） |
| 5 | **三重県** | 月ごとの「議員別の賛否等の状況」PDF（1 ページ、凡例 ○×議除－欠）。index が 1 ページに全会期 | PDF 1 ページに全議案・全議員を詰めているので列復元の精度が要る。URL は `/common/content/{番号}.pdf` で規則性なし（index から拾う） |

次点: 高知県（ページ名が「議員別賛否の状況」、PDF は会派＋氏名。index は 1 ページ）、島根県（PDF 1.3MB、4 ページ、付託委員会列つき）、さいたま市・横浜市・浜松市（PDF に氏名、横浜は 2020 年 6 月以降）。HTML で個人票を出す 岡山市（起立採決のみ）・熊本市（議員ページ、○×が画像）・名古屋市（案件群単位）は「議案単位の全議員票」としては条件付き。

**Phase 1 に入れない方がよいもの**: 会派別しか無い議会を「個人票」に読み替えること（国会の衆院会派態度と同じく **推定** にしかならない。やるなら `stance` 行と同じ型で、個人の賛否は記録しない）。

## 青森県議会（#529）の再調査（2026-09-07）

#128 の青森の行は **2026-08-23 時点**で、robots.txt・利用条件・PDF の中身を確認していなかった。
**#529 の着手前調査として現地を見直した**（**調査のみ。ETL の実装はしていない。`data/` は書いていない**）。

取得のしかた: UA `Mozilla/5.0 (compatible; giinrecord-research)`、**間隔 ≥ 1 秒**、
**取得したのは HTML 5 本・PDF 3 本だけ**（賛否 PDF は **41 本**——ファイル名に `sanpi`/`sannpi` を含む
リンクを数えた実測値——あるが、**3 本しか取っていない**）。
PDF の中身は `packages/etl/src/sources/local/pdf-table.ts` の `readPages`（`pdfjs-dist`）で読んだ。

### 取得したもの（すべて 2026-09-07、HTTP 200）

| URL | 取得時刻 | 大きさ |
|---|---|---|
| `https://www.pref.aomori.lg.jp/robots.txt` | 00:36:33+09:00 | 97 B |
| `https://www.pref.aomori.lg.jp/soshiki/gikai/katsudo-shinsakekka.html` | 00:36:41+09:00 | 42,288 B |
| `https://www.pref.aomori.lg.jp/soshiki/gikai/files/326teirei_sanpi.pdf` | 00:37:47+09:00 | 507,968 B（1 ページ） |
| `https://www.pref.aomori.lg.jp/soshiki/gikai/files/275_25.09giketsukekka.pdf` | 00:37:49+09:00 | 240,445 B（1 ページ） |
| `https://www.pref.aomori.lg.jp/contents/copyright.html` | 00:46:00+09:00 | 12,411 B |
| `https://www.pref.aomori.lg.jp/soshiki/gikai/home.html` | 00:46:38+09:00 | 19,980 B |
| `https://www.pref.aomori.lg.jp/soshiki/gikai/giin-kaiha.html` | 00:46:52+09:00 | 14,162 B |
| `https://www.pref.aomori.lg.jp/soshiki/gikai/giin-senkyoku.html` | 00:47:14+09:00 | 15,685 B |
| `https://www.pref.aomori.lg.jp/soshiki/gikai/files/25.06_274_tijiteisyutugiankekka2.pdf` | 00:50:18+09:00 | 79,360 B（3 ページ） |

### robots.txt と利用条件

`robots.txt` は 200 で、**全文が次の 4 行**（賛否 PDF も議会ページも対象外）:

```
User-Agent: *
Disallow: /kensei/kojisotatsu/

User-agent: ndl-japan
Allow: /kensei/kojisotatsu/
```

利用条件（`/contents/copyright.html`、更新日付 2021年4月1日）の該当部分は原文で:

> これらの情報については、青森県または第三者が著作権を有しており、「私的利用のための複製」や「引用」など著作権法上認められた場合を除き、無断で複製・転用することはできません。

**機械的な取得（クローリング・スクレイピング）を名指しで禁じる文言は無い。**
リンクは「営利、非営利を問わず原則自由」。
**これは島根（#221）と同じ「禁止されていない」であって「許可されている」ではない状態**で、
**#537（事務局への事前照会をしていない）がそのまま当てはまる。**
**#537 が決まるまで実装に入らない**というのが #529 の前提である。

### 賛否 PDF の中身（**文字層はある。画像 PDF ではない**）

**第326回（令和8年6月）`326teirei_sanpi.pdf`**: 1 ページ、**文字アイテム 1,701 個**
（うち **1 文字のもの 1,493 個**）、縦罫線 416・横罫線 623。
**既存 7 県と同じく氏名は縦書き 1 文字 1 アイテム**で、列の対応は x 座標で復元する。

- **議員の列は 46**（`○ × 議 欠 退 除 副` の x を `cluster(…, 3)` でまとめた数）。
  縦に結合すると氏名になる（`joinVertical`）。
- **議案の行は 26。**
- **凡例は PDF の中に 1 行で書かれている**（原文）:
  > 賛否欄：「○」は賛成、「×」は反対、「議」は議長、「副」は副議長が議長の職務を代理、「除」は除斥、「欠」は欠席、「退」は退席
  さらに注記が 2 行:
  > 注 ： 欠席とは、採決時に届出により本会議を欠席、早退等していたこと。
  > 退席とは、採決時に議場内に不在であったこと。
  **凡例は 7 記号**で、#128 が宮城で見た「○×議欠－棄白」とは違う（**棄権・白票は無く、副・退がある**）。
  **PDF ごとに凡例を読むこと**（島根 `votes-pdf.ts` と同じ方針）。
- **記号の実測の内訳**（第326回 1 ページぶん）: `○` 918、`×` 218、`欠` 32、`議` 29、`退` 2。
  **`除` と `副` はこの PDF には 1 つも出ていない**（凡例にはある）。
- **議決月日は同じ PDF の中にある**（列「議決月日」。値は `6/29` `6/24` の形）。
  **島根のように別 PDF（議決結果一覧）を読む必要は無い**（#221 との違い）。
  ただし**年は列に無い**ので、会期の見出し（「令和８年６月」「第３２６回定例会」）から補う必要がある。
- 左側の列は **議案等番号／件名／議決月日／表決方法／議決結果**、右端に
  **賛成者数／反対者数／表決者数**（縦書きのヘッダ）。

### 「賛成者数」との突き合わせは**列ずれを検出しない**（実測）

第326回で、復元した `○` の数と PDF が印字する「賛成者数」を突き合わせると **26 行中 26 行一致**した。
**しかしこれは検算にならない**（作業合意「検算は『順序不変』でないか確かめる」・高知 PR #225 と同じ形）。
**実際に全行のセルを 1 列ずらして測った**:

```
ORIGINAL     : count-check 26/26 rows OK | named-check(工藤慎康 always 議) = true
SHIFTED by 1 : count-check 26/26 rows OK | named-check(工藤慎康 always 議) = false
```

**1 列ずらしても件数の検算は 26/26 のまま緑**である。捕まえたのは**氏名を名指しする検査**だけだった。
青森には**その名指しの錨がある**: 第326回では **`議`（議長）が 26 行すべてで同じ列（index 10「工藤慎康」）**に出る。
**実装するなら、島根 `members[21] === "山根成二"` と同じ形の順序敏感なアサーションを必ず置くこと。**

### 氏名の突き合わせで**実際に踏んだ 2 つの罠**（どちらも「別人の記録」を作りうる）

1. **`櫛引ユキ子` の「櫛」は `w=0.0` で、列がずれる。**
   PDF のアイテムは `U+6ADB U+E0101`（**異体字セレクタ付き**）で、**幅が 0**。
   そのため `cx = x = 642.920` になる（**幅が 0 なので `x` がそのまま中心になる**）。
   **`cluster(…, 3)` の `eps=3` では別の列に落ち、氏名が `引 ユキ子` になった。**
   **氏名が静かに 1 文字欠ける**という、利用者から検出できない壊れ方である。

   **この機序は一度、数字を 3 か所間違えて書いた**（#243「現象は本物でも、原因の説明は別に検証が要る」の形）。
   **PDF を取り直して測り直した値**（507,968 バイト / 1,701 アイテム）:

   | 誤って書いていたこと | 実測 |
   |---|---|
   | 「中心からの許容差 **±6**」 | **`±6` はコードのどこにも無い。** 実際は **`cluster(…, 3)`** |
   | 「**列の中心 648.5** から」 | 決め手は `引`（`cx=648.470`）**ではなく `ユ`/`キ`**（`cx=648.44355`、カタカナで `w=10.6671` と細い） |
   | 「**5.6pt** ずれる」 | **5.523550**（`櫛` と `ユ`/`キ` の差）。`引` との差なら 5.550 |

   **`cluster` は「中心からの距離」を見ていない。** ソート順で**直前のクラスタの逐次平均**との差を **`<=`** で比べる。
   **境界は `eps ≈ 5.523550`** で、実測すると:

   ```
   eps=3     → "引 ユキ子 ○"        ★櫛が別列＝欠落（現行の設定）
   eps=5.5   → "引 ユキ子 ○"        ★櫛が別列＝欠落
   eps=5.6   → "櫛󠄁 引 ユキ子 ○"     同じ列
   eps=6     → "櫛󠄁 引 ユキ子 ○"     同じ列
   ```

   **つまり「±6 だったから落ちた」は誤りで、`±6` なら落ちない**（`5.52355 <= 6`）。
   **落ちる原因は `eps=3` である。**
2. **名簿（HTML）と PDF で字が違う。**
   `和田寛司` は **HTML が `寬`（U+5BEC）、PDF が `寛`（U+5BDB）**。
   **NFC でも NFKC でも一致しない**（実測）。
   **氏名の一致だけで紐づけると、この議員は名簿と結びつかない。**

**どちらも #529 の「氏名の一致だけで紐づけない」「迷ったら出さない側に倒す」に直接効く。**
**実装するときは、突き合わせに失敗した氏名を `unmatched.json` に落として黙って捨てないこと。**

### 遡れる範囲（**第275回より前は個人別ではない。実測**）

index ページ（`katsudo-shinsakekka.html`）には**年度の見出しごとに会期が並び、PDF リンクは 160 本**ある。
**1 ページに全会期が載っており、会期ごとの中間ページは無い**（三重・高知と同じ）。
最古は **平成21年6月 第258回定例会**、最新は **令和8年6月 第326回定例会**。

ページ末尾の注記は原文で:

> ※平成25年9月第275回定例会から、議決結果は議員ごとの賛否状況を掲載しています。

**この注記は正しかった**（両側を実際に取得して確かめた）:

- **第275回**（`275_25.09giketsukekka.pdf`）は**個人別**。**議員 47 列**・議案 21 行、
  文字アイテム 1,421 個（1 文字のもの 1,229 個）。
  **凡例の文言は第326回と 1 字も違わない**（13 年離れているのに同じ）。
  賛成者数／反対者数との突き合わせは **21 行中 21 行一致**。
- **第274回**（`25.06_274_tijiteisyutugiankekka2.pdf`）は**会派別**。3 ページ、**罫線 0 本・表ではない**。
  本文は `〔 賛 成 ： 自 民 、 民 主 、 青 和 、 公 健 、 無 （ 相 馬 ）／反 対 ： 共 産 、 無 （ 古 村 ）〕` の形で、
  **個人名が出るのは無所属議員だけ**（千葉県と同じ形）。
  **個人票としては使えない**（本リポジトリの分類では 会派別）。

したがって**個人別で遡れるのは 第275回（平成25年9月）〜第326回（令和8年6月）**。
**index 上でこの範囲に入る会期は 56**（**定例会 52 + 臨時会 4**。見出し「第N回定例会／臨時会」を機械で数えたもの。
臨時会は 第93・94・95・96回）。
**このうち賛否 PDF を実際に開いたのは 2 本だけ**なので、**残りの作りは確かめていない。**

### **ファイル名に規則性が無い**（実装の一番の障害）

**「`{回次}teirei_sanpi.pdf` で組み立てられる」と思ってはいけない。**
index の PDF リンク 160 本のファイル名を、数字を `N` に置き換えて数えると **37 通り**あった
（`grep -oP 'href="[^"]*\.pdf"' index.html | sed 's|.*/||; s/[0-9]\+/N/g' | sort -u | wc -l`）。
個人別の範囲（第275回以降）だけでも、議決結果 PDF の名前はこう散らばっている:

```
326teirei_sanpi.pdf   325teirei_sanpi.pdf   …  298teirei_sanpi.pdf   （第298回以降。teirei_sanpi 型）
307teirei_sanpi_2.pdf                                                （第307回だけ _2 が付く）
96rinji_sanpi.pdf  95rinji_sanpi.pdf  94rinji_sanpi.pdf              （臨時会は rinji_sanpi 型）
297_sanpi.pdf  …  290_sanpi.pdf                                      （第290〜297回。_sanpi 型）
289_sannpi.pdf                                                       （第289回だけ sannpi と綴りが違う）
giketukekka_288.pdf                                                  （第288回だけ giketukekka（s 抜け））
giketsukekka_2809_287.pdf  giketsukekka_28.02_285.pdf                （第285〜287回。年月が入る）
275_25.09giketsukekka.pdf  276_25.11_giketsukekka.pdf                （第275〜281回。区切りが揺れる）
```

**`_` の有無・`sanpi`/`sannpi`/`giketsukekka`/`giketukekka` の綴り・年月の入り方がすべて揺れている。**
**URL を組み立てず、必ず index ページのリンクから拾うこと**（#128 が三重について書いたのと同じ）。
なお**リンク先が `./hatsugi_270.pdf` のように `files/` を通らないものが 2 本ある**ので、
相対 URL の解決は `new URL(href, base)` で行うこと。

**リンクの文言も一定ではない。** 個人別の範囲では
`知事提出議案・議員提出議案議決結果` が多いが、
`知事提出議案議決結果`（議員提出議案が無い会期）、
`知事提出議案・議員提出議案・請願議決結果`、
`知事提出議案・請願・陳情議決結果` などがあり、
**さらに末尾に `[496KB]` `[PDF.94KB]` `（PDF:100KB）` のいずれかが付く会期と付かない会期がある。**
**「議決結果」で終わる、という決め打ちはできない。**

### 会期に賛否が「無い」行の扱い

第275回の PDF には、**表決方法・議決結果が `－`、議決月日が `継続審査` の行が 5 行**あり、
**その行には議員の記号が 1 つも無い**（議案第12・13・16・17・18号）。
**黙って落とさず、「継続審査で表決していない」という事実として扱うこと。**

**簡易表決の扱いは島根と違う。** 第326回には **表決方法が `簡易` の行が 5 行**（議員派遣）あるが、
**簡易でも 46 人ぶんの記号がすべて入っている**（`○` 45・`議` 1）。
島根では簡易表決に個人票が無いので `simple` として個人票を作らない設計にしたが、
**青森は簡易でも個人票がある**。**「簡易だから個人票が無い」と決め打ちしないこと。**

### 会派・選挙区の名簿（**HTML で別ページにある**）

- **会派別**: `https://www.pref.aomori.lg.jp/soshiki/gikai/giin-kaiha.html`（更新日付 2026年5月25日）
  **46 人**が会派の見出しごとに並ぶ。実測の内訳は
  自由民主党 27／オール青森 5／立憲民主・無所属の会 4／日本共産党 3／公明党 2／
  立憲民主・憲法をいかす県民の会 2／参政党 1／無所属 2。
  **議員ごとの個別ページへのリンクがある**（`giin_tanaka-junzo.html` のようにローマ字。
  ただし `yamaya-kiyofumi.html` `abe-yuuki_01.html` のように `giin_` が無いものや、
  `/soshiki/gikai/` から始まる絶対パスのものが混ざる）。
- **選挙区別**: `https://www.pref.aomori.lg.jp/soshiki/gikai/giin-senkyoku.html`（更新日付 2026年5月25日）
  **選挙区 16・定数 48** と明記。表の列は 選挙区／構成市町村／定数／議員名。
- **注意**: ページに **「議員の定数は48人」**とあるが、
  **会派別名簿に載るのは 46 人**で、**第326回 PDF の列も 46**。
  **定数と現員が違う**（欠員がある）。**定数を議員数として使わないこと。**
- **会派は賛否 PDF の中にも書かれている**（氏名の上に `自由民主党` `オール青森` `立憲民主・無所属の会`
  `日本共産党` `公明党` `立憲民主・憲法をいかす県民の会` `参政党` `無所属` が横に伸びる形で入る）。
  **つまり会期当時の会派が PDF から取れる**（名簿は「今」しか無いので、
  過去の会期に今の会派を当てないこと）。**ただし会派名がどの列からどの列までを覆うかは、
  文字の x の範囲から復元する必要があり、今回そこまでは確かめていない。**

### 会議録システム

議会トップ（`home.html`）からリンクされている会議録検索は **`http://www.pref.aomori.dbsr.jp/index.php/`**
（**`http://`。`https` では確かめていない**）。#128 が書いた `pref.aomori.dbsr.jp` と同じ系統で、
鳥取・島根と同じ `dbsr` 系。**今回は会議録そのものは取得していない**（#529 の範囲外）。

### **既存 7 県のどれに一番近いか**

**宮城（`pref-04`、#128）が最も近い。** 理由は次のとおり:

1. **1 会期 1 PDF に、議案 × 議員の表が丸ごと入っている**（三重の「月ごと」でも、
   奈良の「議決日ごとに PDF が分かれる」でもない）。**島根もこの点は同じ。**
2. **氏名が縦書き 1 文字 1 アイテムで、列を x 座標で復元する**——
   `pdf-table.ts` の `cluster` / `joinVertical` がそのまま効く（**今回それで 46 列全部復元できた**）。
   **島根も宮城も同じ方式なので、この点は両者を区別しない。**
3. **左側の列立てが宮城とほぼ一致する。** 宮城 `votes-pdf.ts` の `LEFT_HEADERS` は
   議案等番号／件名／**議決月日**／出席者数／表決者数／**賛成者数**／**反対者数**／**表決方法**／議決結果 で、
   青森で実測した欄とそろっている。**島根の左側は 議案番号／件名／付託委員会／採決結果／賛成／反対 の 6 列**で
   （`votes-pdf.ts` の `Columns`）、**議決月日も表決方法も無い。**
4. **議決日が同じ PDF の中にある。** 宮城は `LEFT_HEADERS` の `議決月日` を `cellText(3)` で読み、
   `M/D` を検証している（`votes-pdf.ts`）。青森も同じく同一 PDF の「議決月日」列にある。
   **島根は別 PDF（議決結果一覧）を読む必要があり、ここが最も大きな差。**
5. **罫線はあるが、行の高さと一致しない**（件名が 2 行の議案がある）。
   **「罫線ではなく文字の位置で行を決める」必要がある**（島根・宮城とも同じ）。

**凡例については島根の方針が近い。** 凡例が PDF の中に文章で書かれており **PDF ごとに読む**必要がある点は、
明文の凡例を持つ宮城より島根 `votes-pdf.ts` の考え方に沿う。

**島根と違うところ（実装するなら、ここが差分になる）:**

| | 島根（#221） | 青森（実測） |
|---|---|---|
| 議決日 | **別 PDF**（議決結果一覧）から引く | **同じ PDF の「議決月日」列**にある（年は見出しから） |
| 会期の入口 | 会期 index → **会期ページ** → PDF | **1 ページに全会期の PDF リンク**（中間ページ無し） |
| PDF の URL | 会期ページから拾う | **index から拾う**（**名前に規則性が無いので組み立て不可**） |
| 簡易表決 | 個人票が**無い** | **簡易でも個人票がある**（第326回で 5 行） |
| 会派 | PDF に**無い**（名簿から） | **PDF の中にある**（会期当時の会派） |
| ページ数 | 4 ページ | **確かめた 2 本はどちらも 1 ページ** |

**なお「島根が近い」と言えるのは、開いた 2 本の PDF についてだけである。**
**残り 50 本は開いていない。** 島根は **#232 で「同じ議会でも会期ごとに PDF の作りが違う」**を踏んでいる
（節見出しが無い会期、欄が 1 つの文字列になる行）。**青森でも同じことが起きると考えたほうがよい。**
**実装するなら、作りの違う 2 つ以上の会期をフィクスチャにすること**（作業合意）。

### 確かめていないこと（**不明と書く**）

- **賛否 PDF の中身のほとんど**（ファイル名に `sanpi`/`sannpi` を含むリンクは 41 本、
  個人別の範囲の会期は 56 ある。**開いたのは第326回と第275回の 2 本だけ**）。
  **`除`（除斥）と `副`（副議長）の実物を 1 つも見ていない**——凡例にはあるが、この 2 本には出てこない。
- **会派名の帯が、どの列からどの列までを覆うか**（x の範囲の復元）。
- **議員の個別ページに何が載っているか**（在職期間・当選回数の有無）。**1 本も開いていない。**
- **欠員 2 名がいつからか**（定数 48・現員 46 の差の理由）。
- **第275回より前に、個人別の資料が別の場所にあるかどうか。**
  **index の範囲では会派別しか無い**が、**無いとは言っていない。**
- **会議録（`www.pref.aomori.dbsr.jp`）の中身と利用条件。**
- **議案の提出者**（議員提出議案の発議者は「議員提出議案の内容」PDF にありそうだが、**開いていない**）。

## DATA_CONTRACT 拡張の素案（実装しない。議論用）

### 1. `house` の拡張

現行 `type House = "sangiin" | "shugiin"` は **国会の院** の意味で全レコードに入っている。地方を足すとき、`House` を増やすのではなく **階層（level）と議会（assembly）を分ける**:

```ts
type Level = "national" | "prefectural" | "municipal";
type House = "sangiin" | "shugiin";          // national のときだけ意味を持つ（今のまま）
type AssemblyId =
  | "sangiin" | "shugiin"                    // 既存 id と後方互換
  | `pref-${string}`                         // 都道府県: pref-{団体コード2桁} 例 pref-04（宮城）、pref-36（徳島）
  | `city-${string}`;                        // 市区町村: city-{団体コード5桁} 例 city-33100（岡山市）、city-14100（横浜市）

interface Assembly { id: AssemblyId; level: Level; name: string; shortName: string; code?: string; sourceUrl: string; voteDisclosure: "individual" | "group" | "totals" | "unknown"; since?: string }
```

- 団体コード（総務省 全国地方公共団体コード）を id にする。`districts/municipalities.json` の `code` と同じ体系なので、郵便番号 → 市区町村 → 議会 の結合がそのまま効く（#111）。都道府県は上 2 桁。
- `voteDisclosure` はこの調査表の 4 値をそのまま型にし、Web は「この議会は個人別の表決を公開していません」を **事実として** 出す（評価しない）。
- 既存の `house: House` はフィールド名を変えない（国会データの後方互換）。地方のレコードは `house` を持たず `assembly: AssemblyId` を持つ、または `house` を `AssemblyId` に広げる（`"sangiin" | "shugiin"` が部分型なので既存 JSON はそのまま妥当）。後者の方が `Member.house` / `RollCall.house` / `Bill.house` の 3 か所を一度に広げられて差分が小さい。

### 2. id と `session`

- 国会は `session`（回次）が整数で全ファイルのキーになっている。地方は「令和8年6月定例会」「第399回」のように **番号付けが議会ごとに違う**（宮城は通算回次、徳島は年＋月、岡山市は議決日）。`session` を整数のまま使わず、`sessionId: string`（議会内で一意。例 `2026-06`、`399`）と `sessionLabel: string`（原文「令和8年6月定例会」）を持つ。
- `memberId`: `{assemblyId}-{…}`（例 `pref-04-{かな/連番}`）。国会の memberId の作り方（`packages/etl` の name-resolver）を assembly ごとの名簿に対して再利用。
- `rollCallId`: `{assemblyId}-{sessionId}-{議決日}-{議案番号}`（同じ会期で議決日が複数ある 奈良・沖縄 のため議決日を含める）。
- `billId`: `{assemblyId}-{sessionId}-{種別原文}-{番号}`。
- `sourceUrl` の不変条件「衆参・NDL のドメイン」は assembly ごとの許可ドメイン表（`Assembly.sourceUrl` のホスト）に置き換える。ETL の取得先許可リストも同じ表から作る。

### 3. ファイル配置と URL

```
data/
  assemblies.json                       Assembly[]（67 件。voteDisclosure を含む。調査表が初版）
  national/ …（現行の members/ rollcalls/ bills/ をそのまま。移動は別 Issue）
  local/{assemblyId}/
    meta.json                           DatasetMeta（取得日時・出典・対象 sessionId）
    members/index.json, members/{memberId}.json
    rollcalls/index.json, rollcalls/{sessionId}/{rollCallId}.json
```

Web の URL: `/assemblies`（一覧。公開／会派別／総数のみ／不明を事実として表示）、`/assemblies/{assemblyId}`、`/assemblies/{assemblyId}/members/{memberId}`、`/assemblies/{assemblyId}/rollcalls/{rollCallId}`。国会の既存 URL は変えない。郵便番号検索（Home）は `districts/municipalities.json` の `code` から `city-{code}` と `pref-{code 上2桁}` を引いて「あなたの自治体の議会」にリンクできる。

### 4. 表決の値

国会の `VoteValue` に、地方の凡例で出てきた値を足す必要がある: 賛成・反対 のほか **議長**（採決に加わらない）、**欠席**、**議場に不在**（－）、**棄権**、**白票／青票**（記名投票）、**除斥**、**退席**。「投票なし」に畳まず原文の区分を保持する（国会では欠席と棄権を区別しないが、地方の PDF は区別して書いているので、区別している事実を消さない）。`simple`（簡易表決＝異議なしで可決、個人票が無い）を RollCall の属性に持ち、個人票が無いことを「全員賛成」と推定しない。

### 5. 会派別しか無い議会

`Bill.shugiinGroupStance` と同じく **推定** として `groupStances` を持ち、`stance` 行（`estimated: true`）だけを作る。個人の `vote` 行は作らない。Web の判は `est-*` のまま。

## 制約と次の一手

- 1〜2 フェッチの制約で **不明 7 県**（北海道・石川・山梨・長野・愛知・滋賀・佐賀）と、「表題から分類した」PDF（兵庫・広島・熊本県・沖縄・静岡市・北九州市）が残る。次は上記の奈良県調査 PDF か各事務局への照会で埋める。
- 個人票 PDF の列復元（縦書き氏名）は `districts` の pdfjs 抽出と同じ手法で足りる見込みだが、宮城・三重の 1 ページ詰め込み表は検証が要る。Phase 1 の最初の Issue は「宮城県の表決 PDF を 1 会期ぶんパースして `RollCall` にする spike」が妥当。
- ETL 化の前に各事務局へ利用可否を問い合わせる（規約に禁止文言は無いが、明示の許可も無い）。
