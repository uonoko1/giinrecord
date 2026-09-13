import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { articleTitle, mainLinks, parseCategoryPage, parseGianPage, parseIndex, parseSessionPage, parseYearPage } from "../src/sources/local/saga/sessions.ts";
import { resolveSagaUrl, SAGA_HOST, SAGA_INDEX_URL, SAGA_ORIGIN } from "../src/sources/local/saga/site.ts";

/**
 * 佐賀県議会の会期の索引（Issue #768）。フィクスチャは本物の HTML の**本文だけ**
 * （`div.RightArea` / `div#mainShosai`。**左サイドバーは落としてある**——落としてあること自体が
 * この実装の前提で、`saga-sessions-sidebar.test.ts` ではなくここに書く理由は下記のテストにある）。
 */
const html = (name: string): string => readFileSync(new URL(`./fixtures/saga/${name}`, import.meta.url), "utf-8");
const url = (p: string): string => `${SAGA_ORIGIN}/gikai/${p}`;

test("#768 年の一覧 → 年ページ（令和8年〜平成27年の 12 本）", () => {
  const years = parseIndex(html("index.html"));
  assert.equal(years.length, 12, "令和8年・令和7年…平成27年（実測 2026-09-13）");
  assert.equal(years[0], url("list06635.html"), "先頭は令和8年");
  assert.ok(years.every((u) => new URL(u).host === SAGA_HOST));
});

test("#768 年ページ → 種別ページ（定例会・臨時会）", () => {
  const cats = parseYearPage(html("year-r8.html"), url("list06635.html"));
  assert.deepEqual(cats, [url("list06636.html"), url("list06670.html")], "令和8年は 定例会 と 臨時会");
});

test("#768 種別ページ → 会期（名前・年・月・種別・sessionId）", () => {
  const teirei = parseCategoryPage(html("category-r8-teirei.html"), url("list06636.html"));
  assert.deepEqual(teirei.map((s) => s.sessionLabel), ["令和8年2月定例会", "令和8年6月定例会", "令和8年9月定例会"]);
  assert.deepEqual(teirei[1], {
    sessionLabel: "令和8年6月定例会",
    sessionId: "2026-06-teirei-list06680",
    sessionUrl: url("list06680.html"),
    year: 2026, month: 6, kind: "定例会",
  });
  const rinji = parseCategoryPage(html("category-r8-rinji.html"), url("list06670.html"));
  assert.deepEqual(rinji.map((s) => s.sessionId), ["2026-04-rinji-list06671"]);
});

/**
 * **左サイドバーを読んではいけない**（この実装の前提）。
 *
 * **どのページにも、その年のすべての会期とその下の記事が展開された `LeftArea` がある。**
 * **ページ全体の `<a>` を読むと、令和8年9月定例会のページから
 * 令和8年2月・6月の議案件名一覧表（`kiji003117512` / `kiji003119791`）が拾える**
 * （#689 の罠 7 と同じ形の事故になる）。
 * **フィクスチャからはサイドバーを落としてあるので、この対照は
 * 「本文の中に別会期のリンクが無い」ことしか言えない**——
 * **だから `mainLinks` が `div.RightArea` の外を読まないこと**そのものを、
 * **サイドバーを模した HTML を足して確かめる。**
 */
test("#768 本文の外（左サイドバー）のリンクを読まない（別会期の議案件名一覧表を拾わない）", () => {
  const base = url("list06701.html");
  const body = html("session-r8-09.html");
  // **本物のサイドバーと同じ形**（別会期の議案件名一覧表へのリンク）を足す
  const withSidebar = body.replace("</body>", `
    <div class="LeftArea"><ul id="classMenuArea">
      <li><a href="kiji003117512/index.html">議案件名一覧表</a></li>
      <li><a href="kiji003119791/index.html">議案件名一覧表</a></li>
    </ul></div></body>`);
  assert.notEqual(withSidebar, body, "サイドバーを足せていること");
  assert.deepEqual(parseSessionPage(withSidebar, base), parseSessionPage(body, base), "サイドバーを足しても結果が変わらない");
  assert.ok(!mainLinks(withSidebar, base).some((l) => l.url.includes("kiji003117512")), "別会期の記事を拾っていない");
});

/**
 * **令和8年9月定例会の下は空**（2026-09-13 実測）。
 * **#689（2026-09-09）は「ここに令和8年2月の議案件名一覧表が出る」と記録した**が、
 * **いまは `list06732.html` という空の一覧ページに変わっている。**
 * **どちらの形でも、賛否 PDF は 1 本も出ない。**
 */
test("#768 令和8年9月定例会: 議案件名一覧表は空の一覧ページで、PDF が 1 本も出ない（#689 の罠 7）", () => {
  const session = parseSessionPage(html("session-r8-09.html"), url("list06701.html"));
  assert.deepEqual(session, [url("list06732.html")], "記事ではなく一覧ページ");
  const { pdfs, next } = parseGianPage(html("gian-r8-09.html"), url("list06732.html"));
  assert.deepEqual(pdfs, [], "PDF は 1 本も無い");
  assert.deepEqual(next, [], "さらに下る先も無い");
});

test("#768 会期ページ → 議案件名一覧表 → 賛否 PDF", () => {
  const gian = parseSessionPage(html("session-r8-06.html"), url("list06680.html"));
  assert.deepEqual(gian, [url("kiji003119791/index.html")]);
  const { pdfs } = parseGianPage(html("gian-r8-06.html"), gian[0]);
  assert.deepEqual(pdfs, [url("kiji003119791/3_119791_394982_up_cda325jj.pdf")], "同じ PDF への 2 本のリンクは 1 本に畳む");
  assert.equal(articleTitle(html("gian-r8-06.html")), "令和8年6月定例会 議案件名一覧表");
});

/**
 * **賛否 PDF のリンクの文言は 6 通りある**（`議員ごとの採決結果` / `採決結果` / `こちら` /
 * `議員ごとの採決結果はこちら` / `個人ごとの採決結果` / `採決結果一覧`、**さらに空**）。
 * **文言で選ぶと落ちる。** `.pdf` を全部候補にする。
 */
test("#768 賛否 PDF は文言で選ばない（アイコンだけの <a> は文言が空）", () => {
  const base = url("kiji003119791/index.html");
  const { pdfs } = parseGianPage(html("gian-r8-06.html"), base);
  assert.equal(pdfs.length, 1);
  // **文言が空の `<a>` が本文にあること**（この対照が空回りしていないこと）
  const links = mainLinks(html("gian-r8-06.html"), base).filter((l) => l.url.endsWith(".pdf"));
  assert.equal(links.length, 2, "同じ PDF への <a> が 2 本（アイコンと文言）");
  assert.deepEqual(links.map((l) => l.text), ["", "議員ごとの採決結果"], "1 本は文言が空");
});

/** **`議案件名一覧`（`表` が無い）でも拾う**（令和4年11月定・令和4年1月臨。前方一致） */
test("#768 議案件名一覧（表 が無い形）も拾う", () => {
  const base = url("list05671.html");
  const page = `<div class="RightArea"><ul>
    <li><a href="kiji00388755/index.html">議案件名一覧</a></li>
    <li><a href="kiji00388759/index.html">意見書案件名一覧表</a></li>
  </ul></div>`;
  assert.deepEqual(parseSessionPage(page, base), [url("kiji00388755/index.html")], "意見書案側は拾わない");
});

/** **機械翻訳のミラー（`*.transer.com`）は別ホスト**——全ページのヘッダに 4 本ある。 */
test("#768 別ホスト（機械翻訳のミラー）は落とす", () => {
  assert.throws(() => resolveSagaUrl("https://www.pref.saga.lg.jp.e.zg.hp.transer.com/gikai/list01707.html", SAGA_INDEX_URL), /not on www\.pref\.saga\.lg\.jp/);
  assert.throws(() => resolveSagaUrl("http://www.pref.saga.lg.jp/gikai/x.html", SAGA_INDEX_URL), /not https/);
  assert.equal(resolveSagaUrl("kiji003119791/index.html#top", url("list06680.html")), url("kiji003119791/index.html"), "フラグメントは落とす");
});
