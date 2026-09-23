import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runSaga, sameSession, type Fetcher } from "../src/sources/local/saga/index.ts";
import { SAGA_INDEX_URL, SAGA_ORIGIN, SAGA_ROSTER_URL } from "../src/sources/local/saga/site.ts";
import { lossyNameMatchesOf } from "../src/local-assemblies.ts";

/**
 * 佐賀県議会 ETL の取得部（Issue #768）。本物の HTML / PDF をフィクスチャから返す stub で回す。
 * **ネットワークには 1 本も出ない。**
 */
const fx = (name: string): Buffer => readFileSync(new URL(`./fixtures/saga/${name}`, import.meta.url));
const u = (p: string): string => `${SAGA_ORIGIN}/gikai/${p}`;

const HTML: Record<string, string> = {
  [SAGA_ROSTER_URL]: "roster.html",
  [SAGA_INDEX_URL]: "index.html",
  [u("list06635.html")]: "year-r8.html",
  [u("list06636.html")]: "category-r8-teirei.html",
  [u("list06670.html")]: "category-r8-rinji.html",
  [u("list06680.html")]: "session-r8-06.html",
  [u("list06701.html")]: "session-r8-09.html",
  [u("list06732.html")]: "gian-r8-09.html",
  [u("kiji003119791/index.html")]: "gian-r8-06.html",
  [u("list06671.html")]: "session-r8-04rinji.html",
  [u("kiji003119136/index.html")]: "gian-r8-04rinji.html",
};
const PDF: Record<string, string> = {
  [u("kiji003119791/3_119791_394982_up_cda325jj.pdf")]: "3_119791_394982_up_cda325jj.pdf",
  [u("kiji003119136/3_119136_389175_up_bkhi5h10.pdf")]: "3_119136_389175_up_bkhi5h10.pdf",
  [u("kiji003111805/3_111805_349057_up_7elgmado.pdf")]: "3_111805_349057_up_7elgmado.pdf",
};

/**
 * **令和7年の索引**（#901。「令和8年に読める会期が尽きたら令和7年へ下りる」ことを見るため）。
 * **本物の HTML を削ったフィクスチャ**（`year-r7.html` / `category-r7-teirei.html` /
 * `session-r7-02.html` / `gian-r7-02.html`。2026-09-21 取得）。
 *
 * **読める会期は 令和7年2月定例会 の 1 本だけにしてある。**
 * **令和7年の 6月定・9月定・11月定・4月臨・決算特別委員会は、本文が空のページを返す**
 * （`EMPTY`）——**本物では 9月定と 4月臨も読めるが、この試験が見たいのは
 * 「索引をもう 1 年ぶん下りたか」であって「令和7年が全部読めるか」ではない。**
 * **フィクスチャの PDF を増やすほど試験は遅くなるので、1 本だけ置いて境を作る。**
 */
const EMPTY = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8" /><title>フィクスチャ（本文が空）| 佐賀県議会</title></head><body>
<!-- #901 の試験用。**本物のページではない**——索引の歩きを止めるための空の本文。 -->
<div class="RightArea"></div></body></html>`;
const R7: Record<string, string> = {
  // **令和8年2月定例会**（`category-r8-teirei.html` に出るが、議案件名一覧表のフィクスチャが無い）。
  // **本物では 78 採決が読める**が、ここでは空にして「令和8年に読めるのは 2 本」の境を作る。
  [u("list06637.html")]: EMPTY,
  [u("list06438.html")]: fx("year-r7.html").toString("utf-8"),
  [u("list06439.html")]: fx("category-r7-teirei.html").toString("utf-8"),
  [u("list06440.html")]: fx("session-r7-02.html").toString("utf-8"),
  [u("kiji003111805/index.html")]: fx("gian-r7-02.html").toString("utf-8"),
  [u("list06470.html")]: EMPTY, // 令和7年 臨時会（種別ページ）
  [u("list06545.html")]: EMPTY, // 令和7年 決算特別委員会（種別ページ）
  [u("list06485.html")]: EMPTY, // 令和7年6月定例会
  [u("list06515.html")]: EMPTY, // 令和7年9月定例会
  [u("list06546.html")]: EMPTY, // 令和7年11月定例会
};

function stub(extra: { html?: Record<string, string>; pdf?: Record<string, Buffer> } = {}): Fetcher & { fetched: string[] } {
  const fetched: string[] = [];
  return {
    fetched,
    async text(url) {
      fetched.push(url);
      if (extra.html?.[url] !== undefined) return extra.html[url];
      const f = HTML[url];
      if (!f) throw new Error(`HTTP 404 ${url}`);
      return fx(f).toString("utf-8");
    },
    async bytes(url) {
      fetched.push(url);
      if (extra.pdf?.[url]) return extra.pdf[url];
      const f = PDF[url];
      if (!f) throw new Error(`HTTP 404 ${url}`);
      return fx(f);
    },
  };
}

test("#768 runSaga: 名簿 37 人 × 令和8年6月定例会 21 採決、不明 0・未突合は 猪村理恵子 だけ", async () => {
  const f = stub();
  const run = await runSaga({ sessions: 1, fetchedAt: "2026-09-13T00:00:00.000Z", fetcher: f });
  assert.equal(run.roster.members.length, 37);
  assert.equal(run.roster.asOf, "2025-04-01");
  assert.equal(run.rollCalls.length, 21);
  assert.equal(run.rollCalls.reduce((s, rc) => s + rc.votes.length, 0), 777);
  assert.equal(run.rollCalls.reduce((s, rc) => s + rc.votes.filter((v) => v.value.raw === "不明").length, 0), 0);
  assert.deepEqual(run.unmatched.map((x) => x.nameText), ["猪村理恵子"]);
  assert.deepEqual(run.sessions.map((s) => s.sessionId), ["2026-06-teirei-list06680"]);
  assert.deepEqual(run.sessions[0], {
    sessionId: "2026-06-teirei-list06680",
    sessionLabel: "令和8年6月定例会",
    sourceUrl: u("list06680.html"),
    pdfUrl: u("kiji003119791/3_119791_394982_up_cda325jj.pdf"),
    pdfUrls: [u("kiji003119791/3_119791_394982_up_cda325jj.pdf")],
    rollcalls: 21,
    unknownCells: 0,
  });
  // **#778 で共通層が数えるようになった**（`run` は渡さない）。佐賀は 0 のまま（否定的対照）
  assert.deepEqual(lossyNameMatchesOf(run.rollCalls, run.roster.members), [], "字が落ちたまま寄った氏名は 0");
  // **`sources` は名簿・索引・議案件名一覧表・PDF の 4 本**（出典を全部残す）
  assert.deepEqual(run.sources.map((s) => s.url), [
    SAGA_ROSTER_URL, SAGA_INDEX_URL, u("kiji003119791/index.html"), u("kiji003119791/3_119791_394982_up_cda325jj.pdf"),
  ]);
  // **ネットワークには出ていない**（stub しか叩いていない）
  assert.ok(f.fetched.every((x) => x.startsWith(SAGA_ORIGIN)));
});

/**
 * **令和8年9月定例会は「読める PDF が 1 本も無い会期」**（2026-09-13 実測）。
 * **`--sessions 1` のときに 9月定例会で枠を使い切って 6月定例会に届かない、ということが無いこと。**
 * **上のテストが `sessions: 1` で 6月定例会を返しているのがその証拠**だが、
 * **ここで「9月定例会も見に行った」ことを明示する**（黙って飛ばしているのではない）。
 */
test("#768 runSaga: 読める PDF の無い会期（令和8年9月定例会）で枠を使わない", async () => {
  const f = stub();
  await runSaga({ sessions: 1, fetchedAt: "2026-09-13T00:00:00.000Z", fetcher: f });
  assert.ok(f.fetched.includes(u("list06701.html")), "9月定例会の会期ページは開いている");
  assert.ok(f.fetched.includes(u("list06732.html")), "その下の議案件名一覧表も開いている");
  assert.ok(!f.fetched.some((x) => x.endsWith(".pdf") && !x.includes("119791")), "9月定例会から PDF は取っていない");
});

/**
 * **読めない PDF で会期ごと落とさない**（`unreadableSources` に理由を残して先へ進む）。
 * **6月定例会の PDF を、文字層の無い本に差し替える。**
 * **6月は 0 行になるが、次の会期（4月臨時会）は読める**——**run は成功し、理由が残る。**
 */
test("#768 runSaga: 読めない PDF は unreadableSources に理由を残し、次の会期へ進む", async () => {
  const bad = u("kiji003119791/3_119791_394982_up_cda325jj.pdf");
  const f = stub({ pdf: { [bad]: fx("3_114143_360206_up_8onm36yv.pdf") } });
  const run = await runSaga({ sessions: 1, fetchedAt: "2026-09-13T00:00:00.000Z", fetcher: f });
  assert.deepEqual(run.unreadableSources.map((x) => ({ url: x.url, reason: x.reason })), [
    { url: bad, reason: "PDF に文字層が無い（ToUnicode 無し。#689）" },
  ]);
  // **6月定例会は出ていない。代わりに 4月臨時会が出ている**（枠を使い切っていない）
  assert.deepEqual(run.sessions.map((s) => s.sessionLabel), ["令和8年4月臨時会"]);
  assert.equal(run.rollCalls.length, 2);
});

/**
 * **#689 の罠 7: 会期ページが別会期の一覧表を指していたら、その PDF を出さない。**
 * **令和8年6月定例会のページに、令和7年2月定例会の PDF を返させる。**
 * **例外にはしない**（サイトの作りの問題であって、この ETL が止まる理由ではない）——
 * **`unreadableSources` に理由を残して、その会期を出さない。**
 */
test("#768 runSaga: PDF の表題が会期名と食い違えば出さない（#689 の罠 7）", async () => {
  const url = u("kiji003119791/3_119791_394982_up_cda325jj.pdf");
  const f = stub({ pdf: { [url]: fx("3_111805_349057_up_7elgmado.pdf") } });
  const run = await runSaga({ sessions: 1, fetchedAt: "2026-09-13T00:00:00.000Z", fetcher: f });
  assert.deepEqual(run.unreadableSources.map((x) => x.reason), [
    "PDF の表題「令和７年２月定例会 議案採決結果一覧表」が会期「令和8年6月定例会」と食い違う（#689 の罠 7）",
  ]);
  assert.deepEqual(run.sessions.map((s) => s.sessionLabel), ["令和8年4月臨時会"], "6月定例会は出ていない");
  // **72 行の票が 1 行も混ざっていない**（食い違った本の中身が出ていないこと）
  assert.equal(run.rollCalls.length, 2);
  assert.ok(run.rollCalls.every((rc) => rc.sessionLabel === "令和8年4月臨時会"));
  // 否定的対照: 表題が合っていれば通る判定であること
  assert.equal(sameSession({ year: 2026, month: 6, kind: "定例会" }, { year: 2026, month: 6, kind: "定例会" }), true);
  assert.equal(sameSession({ year: 2025, month: 2, kind: "定例会" }, { year: 2026, month: 6, kind: "定例会" }), false, "年も月も違う");
  assert.equal(sameSession({ year: 2026, month: 6, kind: "臨時会" }, { year: 2026, month: 6, kind: "定例会" }), false, "種別だけ違っても出さない");
});

/**
 * **臨時会の本には `除` が出て、`桃崎裕介`（裕）が出る。**
 * **`--sessions 2` で定例会と臨時会の両方が出ることを見る**（会期の順序と `sessionId` も固定）。
 */
test("#768 runSaga --sessions 2: 令和8年6月定例会と令和8年4月臨時会が新しい順に出る", async () => {
  const run = await runSaga({ sessions: 2, fetchedAt: "2026-09-13T00:00:00.000Z", fetcher: stub() });
  assert.deepEqual(run.sessions.map((s) => `${s.sessionId}/${s.sessionLabel}/${s.rollcalls}`), [
    "2026-06-teirei-list06680/令和8年6月定例会/21",
    "2026-04-rinji-list06671/令和8年4月臨時会/2",
  ]);
  // **両方の食い違いが出る**（6月＝猪村理恵子、4月臨＝猪村理恵子も桃崎裕介も無い…ではなく実測どおり）
  assert.deepEqual(run.unmatched.map((x) => x.nameText).sort(), ["桃崎裕介", "猪村理恵子"].sort());
  assert.equal(run.rollCalls.reduce((s, rc) => s + rc.votes.filter((v) => v.value.raw === "不明").length, 0), 0);
  assert.equal(run.unreadableSources.length, 0);
});

/**
 * ## **`--sessions N` が「読める会期 N 本」を返さない**（#901 佐賀。**この PR が直す欠陥**）
 *
 * **`index.ts` の docblock と内側のループは「読める会期が `opts.sessions` 本そろったら止める」と
 * 書いてあるが、外側の索引の歩きは `targets.length >= opts.sessions` で止まる。**
 * **`targets` は「索引の候補」であって「読める会期」ではない。**
 * **佐賀は読めない会期が多い**（文字層なし 5 本・賛否 PDF が無い 2 本が現任期の 20 会期に混ざる）
 * **ので、候補の本数で止めると読める会期が足りないまま返る。**
 *
 * **本番で実測した（2026-09-21、`--sessions N` で `runSaga` を走らせた）:**
 * | 頼んだ N | 返った会期 | 採決 | 最古 |
 * |---:|---:|---:|---|
 * | 2 | 2 | 23 | 2026-04-21 |
 * | 4 | **3** | 101 | 2026-03-06 |
 * | 8 | **6** | 201 | 2025-03-07 |
 * | 13 | **8** | 277 | 2024-03-14 |
 * | 20 | **14** | 445 | 2023-03-10（**一般選挙の前に届いてしまう**） |
 *
 * **「N 本頼んだら N 本返る」ではないので、既定を決める根拠に使えない。**
 * **`N` を大きくすれば読める会期は増えるが、増え方が読めないまま
 * 一般選挙の境（令和5年2月定例会）を踏み越える**——**#569 の「別人の記録が出る」側。**
 *
 * **このテストは索引の歩きが「読める会期の本数」で止まることを見る。**
 * **フィクスチャの令和8年には読める会期が 2 本しか無い**（6月定・4月臨。
 * 9月定は賛否 PDF が無く、2月定は議案件名一覧表のフィクスチャを置いていない）。
 * **3 本目を頼んだら、令和7年まで索引を下りて 令和7年2月定例会 に届くこと。**
 */
test("#901 runSaga --sessions 3: 令和8年に読める会期が 2 本しか無くても、令和7年まで下りて 3 本そろえる", async () => {
  const f = stub({ html: R7 });
  const run = await runSaga({ sessions: 3, fetchedAt: "2026-09-13T00:00:00.000Z", fetcher: f });
  assert.deepEqual(run.sessions.map((s) => `${s.sessionLabel}/${s.rollcalls}`), [
    "令和8年6月定例会/21",
    "令和8年4月臨時会/2",
    "令和7年2月定例会/72",
  ], "読める会期が 3 本（索引の候補の本数ではなく）");
  assert.equal(run.rollCalls.length, 95);
  assert.equal(run.rollCalls.reduce((s, rc) => s + rc.votes.filter((v) => v.value.raw === "不明").length, 0), 0, "不明セルは 0");
  // **令和7年の索引を実際に下りている**（黙って空で返していない）
  assert.ok(f.fetched.includes(u("list06438.html")), "令和7年の年ページを開いた");
  assert.ok(f.fetched.includes(u("list06439.html")), "令和7年の定例会ページを開いた");
});

/**
 * ## **索引の年が新しい順に並んでいなくても、会期を飛ばさない**（#901）
 *
 * **`nextYear` は 1 年ぶん足すたびに `targets` をまるごと並べ直す。**
 * **その `targets` を「添字」で歩くと、後から足した年に
 * 「もう見た会期より新しい会期」が 1 本でもあった瞬間に列がずれる**——
 * **見たはずの会期をもう 1 度見るか、まだ見ていない会期を飛ばすかのどちらかになる。**
 *
 * **`parseIndex` は索引ページの本文の出現順をそのまま返す**（`sessions.ts`）。
 * **本物のページは新しい順に並んでいるが、それはページの作り側の都合であって、
 * この実装が頼ってよい保証ではない。**
 *
 * **このテストは索引の年の並びだけを入れ替える**（**令和7年 → 令和8年 の順**）。
 * **一次資料そのものは 1 バイトも変えていない**——**会期ページも PDF も上のテストと同じ。**
 * **`--sessions 3` で返る 3 本は、並びを入れ替える前と同じ 3 本・同じ順**であること。
 */
test("#901 runSaga: 索引の年が新しい順でなくても、読める会期 3 本を新しい順に返す（添字で歩かない）", async () => {
  // **令和7年を先に、令和8年を後に**書いた索引（**リンク先は本物のまま**）
  const SWAPPED = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8" /><title>議案等の審議結果 | 佐賀県議会</title></head><body>
<!-- #901 の試験用。**本物のページではない**——索引の年の並びだけを入れ替えてある。 -->
<div class="RightArea"><div class="newArea"><ul class="classArea2">
<li class="class2"><div class="midashi"><a href="list06438.html">令和7年</a></div>
<ul class="child"><li><a href="list06439.html">定例会</a></li><li><a href="list06470.html">臨時会</a></li><li><a href="list06545.html">決算特別委員会</a></li></ul></li>
<li class="class2"><div class="midashi"><a href="list06635.html">令和8年</a></div>
<ul class="child"><li><a href="list06636.html">定例会</a></li><li><a href="list06670.html">臨時会</a></li></ul></li>
</ul></div></div></body></html>`;
  const f = stub({ html: { ...R7, [SAGA_INDEX_URL]: SWAPPED } });
  const run = await runSaga({ sessions: 3, fetchedAt: "2026-09-13T00:00:00.000Z", fetcher: f });
  // **並びを入れ替えない上のテストと 1 文字も違わない**（同じ 3 本・同じ順・同じ採決数）
  assert.deepEqual(run.sessions.map((s) => `${s.sessionLabel}/${s.rollcalls}`), [
    "令和8年6月定例会/21",
    "令和8年4月臨時会/2",
    "令和7年2月定例会/72",
  ], "索引の年の並びは結果を変えない");
  assert.equal(run.rollCalls.length, 95);
  // **同じ会期を 2 回出していない**（添字で歩くと重複が出うる）
  const ids = run.sessions.map((s) => s.sessionId);
  assert.equal(new Set(ids).size, ids.length, "会期の重複 0");
  // **同じ会期ページを 2 回開いていない**（母数。#757）
  const pages = f.fetched.filter((x) => x === u("list06680.html"));
  assert.equal(pages.length, 1, "令和8年6月定例会の会期ページを開いた回数");
});
