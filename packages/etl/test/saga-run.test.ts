import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runSaga, sameSession, type Fetcher } from "../src/sources/local/saga/index.ts";
import { SAGA_INDEX_URL, SAGA_ORIGIN, SAGA_ROSTER_URL } from "../src/sources/local/saga/site.ts";

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
  assert.deepEqual(run.lossyNameMatches, [], "字が落ちたまま寄った氏名は 0");
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
