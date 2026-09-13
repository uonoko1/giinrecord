import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { LocalMember } from "@seiji-kiroku/shared";
import { countsOf, mapLegend, numberOf, resolveDate, toLocalRollCalls } from "../src/sources/local/saga/rollcalls.ts";
import { parseVotePdf } from "../src/sources/local/saga/votes-pdf.ts";
import { parseRoster } from "../src/sources/local/saga/roster.ts";
import { conflictingRosterNames, unmatchedReason } from "../src/sources/local/name-match.ts";
import { buildLocalAssembly, SAGA_ASSEMBLY } from "../src/local-assemblies.ts";

const bytes = (name: string): Buffer => readFileSync(new URL(`./fixtures/saga/${name}`, import.meta.url));
const roster = (): LocalMember[] => parseRoster(readFileSync(new URL("./fixtures/saga/roster.html", import.meta.url), "utf-8")).members;
const session = { sessionId: "2026-06-teirei-list06680", sessionLabel: "令和8年6月定例会", year: 2026, month: 6 };

test("#768 id は {assemblyId}-{sessionId}-{議決日}-{議案番号}。件名・結果・集計は原文", async () => {
  const pdf = await parseVotePdf(bytes("3_119791_394982_up_cda325jj.pdf"));
  const { rollCalls } = toLocalRollCalls([{ pdf, pdfUrl: "https://www.pref.saga.lg.jp/gikai/kiji003119791/x.pdf" }], roster(), session);
  assert.equal(rollCalls.length, 21);
  const first = rollCalls[0];
  assert.deepEqual(
    { id: first.id, date: first.date, kind: first.kind, number: first.number, result: first.result, counts: first.counts, page: first.page },
    {
      id: "pref-41-2026-06-teirei-list06680-20260701-甲第36号議案",
      date: "2026-07-01", kind: "議案", number: "甲第36号議案", result: "可決",
      counts: { yes: 36, no: 0, present: 37, voting: 36 }, page: 1,
    },
  );
  assert.equal(first.title, "令和８年度佐賀県一般会計補正予算（第１号）");
  assert.equal(first.votes.length, 37);
  // **表決方法の欄はこの議会に無い**（宮城・秋田にはある）。無いものを作らない
  assert.equal(first.method, undefined);
});

/**
 * **氏名の食い違い 2 件が、どちらにも寄らずに `sourceConflict` で落ちる**（#711。**この議会の要点**）。
 *
 * **`猪村理恵子`（理 U+7406）は名簿の `猪村利恵子`（利 U+5229）と 1 文字違い。**
 * **`localNameKey` は畳まない**（別の漢字であって字形違いではない）、
 * **`matchBySubsequence` も寄せない**（長さが同じで 1 文字違うので部分列にならない）。
 * **だから `memberId` は空のまま、`unmatched.json` に `sourceConflict` で落ちる。**
 */
test("#768 猪村理恵子（理）は名簿の 猪村利恵子（利）に寄せない——sourceConflict で落とす", async () => {
  const pdf = await parseVotePdf(bytes("3_119791_394982_up_cda325jj.pdf"));
  const r = roster();
  const { rollCalls, unmatched } = toLocalRollCalls([{ pdf, pdfUrl: "https://www.pref.saga.lg.jp/gikai/x.pdf" }], r, session);
  assert.deepEqual(unmatched.map((u) => u.nameText), ["猪村理恵子"]);
  // **全 21 採決でこの列の memberId が空**（1 つでも寄っていたら別人の記録になる）
  for (const rc of rollCalls) {
    const v = rc.votes.find((x) => x.nameText === "猪村理恵子")!;
    assert.equal(v.memberId, "", `${rc.id}: 寄せていない`);
  }
  // **名簿側の `猪村利恵子` には 1 票も付かない**
  const imura = r.find((m) => m.name === "猪村 利恵子")!;
  assert.equal(rollCalls.flatMap((rc) => rc.votes).filter((v) => v.memberId === imura.id).length, 0);
  // **理由は `sourceConflict`**（`brokenGlyph` でも「名簿に無い議員」でもない）
  assert.equal(unmatchedReason("猪村理恵子", r), "sourceConflict");
  assert.deepEqual(conflictingRosterNames("猪村理恵子", r).map((c) => c.name), ["猪村 利恵子"]);
});

test("#768 桃崎裕介（裕 U+88D5）も寄せない——sourceConflict で落とす", async () => {
  const pdf = await parseVotePdf(bytes("3_112934_353517_up_h8tpjpnt.pdf"));
  const r = roster();
  const { rollCalls, unmatched } = toLocalRollCalls(
    [{ pdf, pdfUrl: "https://www.pref.saga.lg.jp/gikai/y.pdf" }], r,
    { sessionId: "2025-04-rinji-list06476", sessionLabel: "令和7年4月臨時会", year: 2025, month: 4 },
  );
  assert.deepEqual(unmatched.map((u) => u.nameText), ["桃崎裕介"]);
  assert.equal(unmatchedReason("桃崎裕介", r), "sourceConflict");
  assert.deepEqual(conflictingRosterNames("桃崎裕介", r).map((c) => c.name), ["桃崎 祐介"]);
  const momo = r.find((m) => m.name === "桃崎 祐介")!;
  assert.equal(rollCalls.flatMap((rc) => rc.votes).filter((v) => v.memberId === momo.id).length, 0, "名簿の 桃崎祐介 には 1 票も付かない");
});

/**
 * **否定的対照: 名簿の綴りと同じ本では、その議員に票が付く。**
 * **これが無いと「全員を落とす実装」でも上の 2 つが緑になる**（#705／#718 の空回り）。
 */
test("#768 否定的対照: 猪村利恵子（利）と書く本では、その議員に票が付く", async () => {
  const pdf = await parseVotePdf(bytes("3_111805_349057_up_7elgmado.pdf"));
  const r = roster();
  const { rollCalls, unmatched } = toLocalRollCalls(
    [{ pdf, pdfUrl: "https://www.pref.saga.lg.jp/gikai/z.pdf" }], r,
    { sessionId: "2025-02-teirei-list06440", sessionLabel: "令和7年2月定例会", year: 2025, month: 2 },
  );
  assert.deepEqual(unmatched.map((u) => u.nameText), [], "この本では 1 人も落ちない");
  const imura = r.find((m) => m.name === "猪村 利恵子")!;
  assert.equal(rollCalls.flatMap((rc) => rc.votes).filter((v) => v.memberId === imura.id).length, 72, "72 採決すべてに票が付く");
  // **37 人全員に memberId がある**
  assert.equal(rollCalls.flatMap((rc) => rc.votes).filter((v) => v.memberId === "").length, 0);
});

/**
 * **改選前の議員は「名簿に無い議員」で落ちる**（`sourceConflict` ではない）。
 * **理由が違えば、運用者が次にすることも違う**（#680／#711）。
 */
test("#768 改選前の 5 人は「名簿に無い議員」で落ちる（sourceConflict ではない）", async () => {
  const pdf = await parseVotePdf(bytes("3_87962_253631_up_ita1q1dw.pdf"));
  const r = roster();
  const { unmatched } = toLocalRollCalls(
    [{ pdf, pdfUrl: "https://www.pref.saga.lg.jp/gikai/w.pdf" }], r,
    { sessionId: "2022-09-teirei-list05651", sessionLabel: "令和4年9月定例会", year: 2022, month: 9 },
  );
  assert.deepEqual(
    unmatched.map((u) => u.nameText).sort(),
    ["中倉政義", "井上祐輔", "川﨑常博", "稲富正敏", "向門慶人"].sort(),
    "令和5年4月の改選で入れ替わった 5 人",
  );
  for (const u of unmatched) assert.equal(unmatchedReason(u.nameText, r), undefined, `${u.nameText}: 理由なし（名簿に無い）`);
  // **`川﨑常博` の `﨑` は U+FA11**（異体字。丸めない）
  assert.equal(unmatched.find((u) => u.nameText.startsWith("川"))!.nameText.codePointAt(1), 0xfa11);
});

/** **`buildLocalAssembly` が `unmatched.json` に理由を付ける**（県ごとに書かない。#680） */
test("#768 buildLocalAssembly: 食い違った氏名に reason: sourceConflict が付く", async () => {
  const pdf = await parseVotePdf(bytes("3_119791_394982_up_cda325jj.pdf"));
  const r = roster();
  const { rollCalls, unmatched } = toLocalRollCalls([{ pdf, pdfUrl: "https://www.pref.saga.lg.jp/gikai/x.pdf" }], r, session);
  const built = buildLocalAssembly({
    assembly: SAGA_ASSEMBLY, members: r, rollCalls, fetchedAt: "2026-09-13T00:00:00.000Z", rosterAsOf: "2025-04-01",
    sources: [{ name: "議員一覧", url: "https://www.pref.saga.lg.jp/gikai/kiji00366725/index.html", fetchedAt: "2026-09-13T00:00:00.000Z" }],
    sessions: [{ sessionId: session.sessionId, sessionLabel: session.sessionLabel, sourceUrl: "https://www.pref.saga.lg.jp/gikai/list06680.html", pdfUrl: "https://www.pref.saga.lg.jp/gikai/x.pdf", rollcalls: rollCalls.length, unknownCells: 0 }],
    unmatched,
  });
  assert.deepEqual(built.unmatched.map((u) => ({ name: u.nameText, reason: u.reason })), [{ name: "猪村理恵子", reason: "sourceConflict" }]);
  assert.equal(built.meta.counts.unknownCells, 0);
  assert.equal(built.meta.counts.cells, 21 * 37);
});

/* ---------- 凡例の写像 ---------- */

test("#768 mapLegend: 賛成/反対 だけが賛否。退席・除席・除斥・議長・欠席は 投票なし", () => {
  assert.deepEqual(mapLegend("○", "賛成"), { raw: "○", legend: "賛成", mapped: "賛成" });
  assert.deepEqual(mapLegend("×", "反対"), { raw: "×", legend: "反対", mapped: "反対" });
  assert.deepEqual(mapLegend("△", "退席"), { raw: "△", legend: "退席", mapped: "投票なし" });
  assert.deepEqual(mapLegend("議", "議長"), { raw: "議", legend: "議長", mapped: "投票なし" });
  assert.deepEqual(mapLegend("欠", "欠席"), { raw: "欠", legend: "欠席", mapped: "投票なし" });
  // **`除席` と `除斥` は別の語**。どちらも原文のまま `legend` に残る
  assert.deepEqual(mapLegend("除", "除席"), { raw: "除", legend: "除席", mapped: "投票なし" });
  assert.deepEqual(mapLegend("除", "地方自治法第117条による除斥"), { raw: "除", legend: "地方自治法第117条による除斥", mapped: "投票なし" });
  // **凡例に無い語は `mapped` を付けない**（推定しない）
  assert.deepEqual(mapLegend("▲", "抽出不能"), { raw: "▲", legend: "抽出不能" });
  assert.deepEqual(mapLegend("不明", "抽出不能"), { raw: "不明", legend: "抽出不能" });
});

/* ---------- 日付と集計 ---------- */

test("#768 resolveDate: 会期の月より 6 か月以上前なら翌年（11月定例会の 1月議決）", () => {
  assert.equal(resolveDate({ year: 2026, month: 6 }, 7, 1), "2026-07-01");
  assert.equal(resolveDate({ year: 2023, month: 11 }, 12, 21), "2023-12-21", "11月定例会の12月議決は同じ年");
  assert.equal(resolveDate({ year: 2023, month: 11 }, 1, 20), "2024-01-20", "11月定例会の1月議決は翌年");
  assert.equal(resolveDate({ year: 2025, month: 2 }, 3, 17), "2025-03-17");
});

test("#768 numberOf / countsOf: 読めない欄は書かない（-1 のような値を作らない）", () => {
  assert.equal(numberOf("37"), 37);
  assert.equal(numberOf("３７"), 37, "全角も読む");
  assert.equal(numberOf(""), undefined);
  assert.equal(numberOf("－"), undefined);
  assert.deepEqual(countsOf({ present: "37", voting: "36", yes: "36", no: "0" }), { counts: { yes: 36, no: 0, present: 37, voting: 36 } });
  assert.equal(countsOf({ present: "37", voting: "36", yes: "", no: "0" }), undefined, "賛成が読めなければ counts を書かない");
  assert.deepEqual(countsOf({ present: "", voting: "", yes: "36", no: "0" }), { counts: { yes: 36, no: 0 } }, "読めたぶんだけ");
});

/**
 * **記号の数が、同じ PDF の集計欄（別の場所に印刷された数）と合う。**
 * **これは「氏名の列が正しい」証明ではない**（数だけ）が、
 * **記号を落としたり増やしたりしていないことを、PDF 自身の数で確かめられる。**
 * **`退席` の欄には `△` と `除` の両方が数えられている**（実測。凡例では別の記号）。
 */
test("#768 検算: ○=賛成 / ×=反対 / △+除=退席 / 欠=欠席 が、フィクスチャ 5 本の全 122 行で合う", async () => {
  const files = ["3_119791_394982_up_cda325jj.pdf", "3_111805_349057_up_7elgmado.pdf", "3_112934_353517_up_h8tpjpnt.pdf", "3_96145_279859_up_jsqwevkw.pdf", "3_87962_253631_up_ita1q1dw.pdf"];
  let rows = 0;
  for (const f of files) {
    const pdf = await parseVotePdf(bytes(f));
    for (const r of pdf.rows) {
      rows++;
      const c = (s: string) => r.cells.filter((x) => x === s).length;
      assert.equal(c("○"), Number(r.counts.yes), `${f} ${r.number}: ○`);
      assert.equal(c("×"), Number(r.counts.no), `${f} ${r.number}: ×`);
      assert.equal(c("△") + c("除"), Number(r.counts.withdrew), `${f} ${r.number}: △+除 = 退席`);
      assert.equal(c("欠"), Number(r.counts.absent), `${f} ${r.number}: 欠`);
    }
  }
  assert.equal(rows, 122, "フィクスチャ 5 本の行数（実測 2026-09-13）");
});
