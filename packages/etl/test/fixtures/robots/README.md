# 11 県の `robots.txt`（`isAllowedByRobots` の検算用フィクスチャ）

**ネットワークを叩かずに `isAllowedByRobots` を測るために置いた**（#894）。

**本文は `docs/research/local-assemblies.md` に記録済みの取得結果から起こしたもので、
`Disallow` 行の集合が原本と同じになるようにしてある**（原本のコメント・`Sitemap`・
`Crawl-delay`・他 UA のブロックは、`giinrecord-etl` の判定に影響しないので落としたものがある）。
**バイト数は原本と一致しない。** 突き合わせるのは **`Disallow` の集合**である。

| ファイル | 県 | ホスト | 記録元（`docs/research/local-assemblies.md`） |
|---|---|---|---|
| `aomori.txt` | 青森 | `www.pref.aomori.lg.jp` | 「`robots.txt` は 200 で、全文が次の 4 行」（97 B、md5 `d453536d…`） |
| `miyagi.txt` | 宮城 | `www.pref.miyagi.jp` | **HTTP 404**（HTML が返る）。`Disallow` は 1 行も無い |
| `akita.txt` | 秋田 | `pref.akita.gsl-service.net` | 「全文が次の 2 行」（33 B、md5 `c4a20a26…`） |
| `mie.txt` | 三重 | `www.pref.mie.lg.jp` | 「`User-agent: *` の `Disallow` は `/TOPICS/200809027610.pdf` の 1 本だけ」（169 B） |
| `shiga.txt` | 滋賀 | `www.shigaken-gikai.jp` | 「`/voices/cgi/`・`/voices2/cgi/`・`/gikai/cgi/`、`g07_Video*_View*.asp` / `g08_Video*_View*.asp`、`/voices/gikaidoc/index.html` と `index2.html`（と `/gikai/` 配下の同名）だけ」（1,621 B） |
| `nara.txt` | 奈良 | `www.pref.nara.lg.jp` | 「全文は `User-agent: *` / `Disallow: /documents/22137/*` の 2 行だけ」（43 B） |
| `tottori.txt` | 鳥取 | `www.pref.tottori.lg.jp` | 「`User-Agent: *` のブロックが 2 つ…末尾にもう 1 つ `User-agent: *` があり `/koujisoutatu*.pdf` と `*/koujisoutatu*.pdf`」（406 B） |
| `shimane.txt` | 島根 | `www.pref.shimane.lg.jp` | **HTTP 404**。`Disallow` は無い |
| `tokushima.txt` | 徳島 | `www.pref.tokushima.lg.jp` | **実物を取り直した**（#875、2026-09-16。**HTTP 200・167 B・md5 `e47a08ed…`・全文 5 行で、このファイルは原本と 1 バイトも違わない**）。**`Disallow` は 4 行**（`/system`・`/kenseijoho/kenpou/koujisoutatsu`・その `/tb/` と `/sp/` 版）。**`*` は 0 件。** **`docs/ops/etl.md` の「`/system` などを Disallow」から起こした版は `Disallow` が 1 行しか無く、3 行足りなかった** |
| `kochi.txt` | 高知 | `gikai.pref.kochi.lg.jp` | 「`Disallow: /search.html` `/reiki/` `/*.html.r` のみ」 |
| `saga.txt` | 佐賀 | `www.pref.saga.lg.jp` | 「`*/Calendar.aspx` `*/Daily.aspx` `*/Weekly.aspx` `*/Yearly.aspx`（大小両方）のみ」＝8 行（219 B、md5 `844393c4…`） |

**ホスト名はいずれも既にリポジトリの `src/sources/local/*/site.ts` に在る公開ホストである。**
