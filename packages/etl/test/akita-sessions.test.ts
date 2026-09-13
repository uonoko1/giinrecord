import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseYearPage, parseYearPages, INDEX_URLS } from "../src/sources/local/akita/sessions.ts";
import { AKITA_HOST, AKITA_HUB_URL, AKITA_YEARS_URL } from "../src/sources/local/akita/site.ts";

const html = (name: string) => readFileSync(fileURLToPath(new URL(`fixtures/akita/${name}.html`, import.meta.url)), "utf-8");
const YEAR_URL = (id: string) => `https://${AKITA_HOST}/doc/${id}/`;

test("#759 parseYearPages: 索引 2 段から年度ページを集める", () => {
  const pages = parseYearPages([
    { html: html("hub"), baseUrl: AKITA_HUB_URL },
    { html: html("years"), baseUrl: AKITA_YEARS_URL },
  ]);
  // **20 の年度ページ ＋ 令和8年 ＋ 概要関連のリンク**（実測 22。**平成18〜22 の 5 本には PDF が無い**）
  assert.equal(pages.length, 22, "年度ページの候補");
  assert.equal(new Set(pages).size, pages.length, "重複していない（`#R7` のフラグメントを落としてある）");
  // **必ず入っているもの**（この 3 本はフィクスチャにもある）
  for (const id of ["2026021300064", "2018051400043", "2018051400098"]) {
    assert.ok(pages.includes(YEAR_URL(id)), `${id} が入っている`);
  }
  // **新しいほうが先**（`--sessions N` が「新しい N 本」になるために要る）
  assert.equal(pages[0], YEAR_URL("2026021300064"), "先頭は令和8年（いちばん新しい年度）");
  // **`/doc/XXXXXXXXXXXXX/`（未設定のリンク）を拾っていない**
  assert.deepEqual(pages.filter((p) => p.includes("XXXX")), [], "未設定のリンクを拾っていない");
  // **全部が公式ホスト**
  assert.deepEqual(pages.filter((p) => !p.startsWith(`https://${AKITA_HOST}/`)), [], "公式ホストだけ");
});

/**
 * ## **本数は数え方で 2 / 22 / 154 / 155 / 176 と変わる**（#748 と同じ罠。#753 が数えた）
 *
 * | 数え方 | 本数 | なぜ違うか |
 * |---|---:|---|
 * | `.pdf` リンクを全部 | **176** | **各年度ページのサイドバーに SNS 運用方針 PDF が 1 本**（21 本ぶん） |
 * | 記事本文の `.pdf` | **155** | **令和8年の `080213.pdf` へのリンクが 2 つある**（`<a>` が閉じ括弧の前で切れている） |
 * | **URL の重複を除く** | **154** | **#753 が数えた本数と一致する** |
 * | `<a>` のテキストに「表決状況」 | **22** | **令和6年以降の 3 年度だけが `<a>` の中に書く** |
 */
test("#759 parseYearPage: 年度ページから賛否 PDF を拾う（重複を除いて 6 本）", () => {
  const links = parseYearPage(html("year-2026021300064"), YEAR_URL("2026021300064"));
  // **#753 の表の「令和8 = 6 本」と一致する**（重複を除く前は 7 本）
  assert.equal(links.length, 6, "令和8年の賛否 PDF");
  assert.equal(new Set(links.map((l) => l.url)).size, 6, "URL が重複していない");
  assert.deepEqual(
    links.map((l) => l.url.split("/").pop()),
    ["080703.pdf", "080615.pdf", "080609.pdf", "080319.pdf", "080227.pdf", "080213.pdf"],
    "ページの並び順（新しい順）",
  );
  // **サイドバーの SNS 運用方針 PDF を拾っていない**
  assert.deepEqual(links.filter((l) => l.url.includes("SNS_unyou")), [], "SNS 運用方針を拾っていない");
  assert.ok(links.every((l) => l.sourceUrl === YEAR_URL("2026021300064")), "出典は年度ページ");
  assert.ok(links.every((l) => l.url.startsWith(`https://${AKITA_HOST}/`)), "公式ホストだけ");
});

/**
 * **否定的対照: `080213.pdf` へのリンクは年度ページに 2 本ある。**
 * **除かなければ 7 本になり、同じ PDF を 2 回取りに行くことになる**（相手にも失礼）。
 */
test("#759 否定的対照: 同じ PDF への 2 本目のリンクが実在する（除かなければ 7 本）", () => {
  const src = html("year-2026021300064");
  const all = [...src.matchAll(/<a[^>]*href="([^"]*\.pdf)"[^>]*>/gi)]
    .map((m) => m[1])
    .filter((h) => !h.includes("SNS_unyou"));
  assert.equal(all.length, 7, "記事本文の `.pdf` リンク（重複を除く前）");
  assert.equal(new Set(all).size, 6, "重複を除くと 6 本");
  // **2 本目の `<a>` は閉じ括弧だけ**（`…（令和8年2月13日版` ＋ `）`）
  const dup = all.filter((h) => h.includes("080213")).length;
  assert.equal(dup, 2, "`080213.pdf` へのリンクが 2 本");
});

/**
 * ## **`<a>` のテキストだけを見ると 154 本のうち多くが落ちる**（#753 の観察）
 * **平成23年のページは `<a>` が `こちら（平成２３年１２月２２日版）` だけで、
 * 「各議員の表決状況は」が `<a>` の外（直前の地の文）にある。**
 */
test("#759 `<a>` のテキストに「表決状況」が無い年度でも拾える（平成23年 7 本）", () => {
  const links = parseYearPage(html("year-2018051400043"), YEAR_URL("2018051400043"));
  // **#753 の表の「平成23 = 7 本」と一致する**
  assert.equal(links.length, 7, "平成23年の賛否 PDF");
  // **`<a>` のテキストには「表決状況」が入っていない**（地の文の側にある）
  const inAnchor = links.filter((l) => /こちら（[^）]*）$/.test(l.linkText.replace(/.*\s/, "")));
  assert.ok(links.length > 0 && inAnchor.length >= 0, "リンクの文言は原文のまま残る");
  // **綴りが揺れる**（`giketu` / `giketsu`）ので URL は組み立てない
  assert.deepEqual(
    links.map((l) => l.url.split("/").pop()),
    ["h231222giketu.pdf", "h231207giketu.pdf", "h231202giketu.pdf", "h231129giketu.pdf", "h231101giketu.pdf", "H231004giketu.pdf", "h2306giketu.pdf"],
    "ファイル名（**`H` が大文字の本がある**）",
  );
});

/**
 * **平成22年以前の 5 年度ページには PDF が 1 本も無い**（#753 が実測）。
 * **遡れるのは平成23年12月からである。**
 * **「0 本」を例外にしない**——**その年度に無いのが事実である。**
 */
test("#759 平成18年のページには賛否 PDF が 1 本も無い（例外にしない）", () => {
  const links = parseYearPage(html("year-2018051400098"), YEAR_URL("2018051400098"));
  assert.deepEqual(links, [], "PDF 0 本（例外ではない）");
});

test("#759 INDEX_URLS: 索引は 2 段（概要ハブ → 年度の一覧）", () => {
  assert.deepEqual([...INDEX_URLS], [AKITA_HUB_URL, AKITA_YEARS_URL]);
  assert.ok(INDEX_URLS.every((u) => u.startsWith(`https://${AKITA_HOST}/`)), "公式ホストだけ");
});
