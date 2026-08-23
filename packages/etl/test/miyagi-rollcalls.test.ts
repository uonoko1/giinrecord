import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRoster } from "../src/sources/local/miyagi/roster.ts";
import { parseVotePdf } from "../src/sources/local/miyagi/votes-pdf.ts";
import { mapLegend, toIsoDate, toLocalRollCalls } from "../src/sources/local/miyagi/rollcalls.ts";

// 表決 PDF の行 → LocalRollCall（Issue #157）。名簿との名寄せは氏名の空白を除いた完全一致だけ（推定しない）。
const fixture = (name: string) => new URL(`./fixtures/miyagi/${name}`, import.meta.url);
const roster = parseRoster({
  kaiha: readFileSync(fixture("18meibo-kaiha.html"), "utf8"),
  kubetu: readFileSync(fixture("18meibo-kubetu.html"), "utf8"),
  gojuuon: readFileSync(fixture("18meibo-gojuuon.html"), "utf8"),
});
const pdf398 = await parseVotePdf(readFileSync(fixture("hyouketsu071217.pdf")));
const pdf399 = await parseVotePdf(readFileSync(fixture("syuusei_hyouketsu080318.pdf")));
const PDF398 = "https://www.pref.miyagi.jp/documents/62682/hyouketsu071217.pdf";
const PDF399 = "https://www.pref.miyagi.jp/documents/63622/syuusei_hyouketsu080318.pdf";

test("toIsoDate: 議決月日（M/D）は見出しの和暦年で西暦にする。11月定例会の 12/17 は同じ年、年をまたぐ 1月は翌年", () => {
  assert.equal(toIsoDate("12/17", 2025, 11), "2025-12-17");
  assert.equal(toIsoDate("3/18", 2026, 2), "2026-03-18");
  assert.equal(toIsoDate("2/17", 2026, 2), "2026-02-17");
  assert.equal(toIsoDate("1/10", 2025, 11), "2026-01-10");
  assert.throws(() => toIsoDate("13/1", 2025, 11), /date/);
});

test("mapLegend: 凡例の意味から国会の値に機械的に対応づけられるものだけ mapped（○→賛成、×→反対、議長・欠席・議場に不在・除斥→投票なし。棄権・白票・不明は付けない）", () => {
  assert.deepEqual(mapLegend("○", "賛成"), { raw: "○", legend: "賛成", mapped: "賛成" });
  assert.deepEqual(mapLegend("×", "反対"), { raw: "×", legend: "反対", mapped: "反対" });
  assert.deepEqual(mapLegend("議", "議長"), { raw: "議", legend: "議長", mapped: "投票なし" });
  assert.deepEqual(mapLegend("欠", "欠席"), { raw: "欠", legend: "欠席", mapped: "投票なし" });
  assert.deepEqual(mapLegend("－", "議場に不在"), { raw: "－", legend: "議場に不在", mapped: "投票なし" });
  assert.deepEqual(mapLegend("除", "除斥"), { raw: "除", legend: "除斥", mapped: "投票なし" });
  assert.deepEqual(mapLegend("棄", "棄権"), { raw: "棄", legend: "棄権" });
  assert.deepEqual(mapLegend("白", "白票"), { raw: "白", legend: "白票" });
  assert.deepEqual(mapLegend("不明", "抽出不能"), { raw: "不明", legend: "抽出不能" });
});

test("toLocalRollCalls: 第398回の 50 件。id は {assemblyId}-{sessionId}-{議決日}-{種別}-{番号}、sourceUrl は PDF、会派は PDF の凡例の正式名称", () => {
  const { rollCalls, unmatched } = toLocalRollCalls(pdf398, roster.members, { sessionLabel: "令和7年11月定例会（第398回）", pdfUrl: PDF398 });
  assert.equal(rollCalls.length, 50);
  const first = rollCalls[0];
  assert.equal(first.id, "pref-04-398-20251217-発議案-8");
  assert.equal(first.assemblyId, "pref-04");
  assert.equal(first.sessionId, "398");
  assert.equal(first.sessionLabel, "令和7年11月定例会（第398回）");
  assert.equal(first.date, "2025-12-17");
  assert.deepEqual(first.method, { raw: "起立", legend: "起立採決" });
  assert.equal(first.result, "可決");
  assert.deepEqual(first.counts, { present: 57, voting: 54, yes: 49, no: 5 });
  assert.equal(first.page, 1);
  assert.equal(first.sourceUrl, PDF398);
  assert.equal(first.votes.length, 58);
  assert.deepEqual(first.votes[0], { memberId: "p_04_meibo_yuzuki", nameText: "柚木 貴光", group: "自由民主党・県民会議", value: { raw: "○", legend: "賛成", mapped: "賛成" } });
  // 氏名の空白の有無は無視して一致させる（PDF「佐々木幸士」= 名簿「佐々木 幸士」）
  const chair = first.votes.find((v) => v.value.raw === "議")!;
  assert.equal(chair.memberId, "p_04_kosi");
  assert.deepEqual(chair.value, { raw: "議", legend: "議長", mapped: "投票なし" });
  assert.equal(rollCalls[49].id, "pref-04-398-20251217-請願-398の2");
  // 第398回の PDF には名簿に無い人（その後に辞職・失職）が 2 人いる。推定せず unmatched に
  const strip = (s: string) => s.replace(/[\s　]/g, "");
  const rosterKeys = new Set(roster.members.map((m) => strip(m.name)));
  const expected = pdf398.members.filter((m) => !rosterKeys.has(strip(m.nameText))).map((m) => m.nameText).sort();
  assert.ok(expected.length >= 1 && expected.includes("中島 源陽"));
  assert.deepEqual(unmatched.map((u) => u.nameText).sort(), expected);
  assert.equal(first.votes.filter((v) => v.memberId === "").length, expected.length);
  for (const u of unmatched) assert.equal(u.rollCallIds.length, 50);
});

test("toLocalRollCalls: 番号の無い行（決議案）は 無番号N、同じ会期に複数の議決日（2/17 と 3/18）があっても id は一意", () => {
  const { rollCalls } = toLocalRollCalls(pdf399, roster.members, { sessionLabel: "令和8年2月定例会（第399回）", pdfUrl: PDF399 });
  assert.equal(rollCalls.length, 110);
  assert.equal(rollCalls[0].id, "pref-04-399-20260318-決議案-無番号1");
  assert.equal(rollCalls[0].number, "");
  assert.equal(rollCalls[1].id, "pref-04-399-20260217-発議案-1");
  assert.equal(new Set(rollCalls.map((r) => r.id)).size, 110);
  for (const rc of rollCalls) assert.equal(rc.votes.length, 56);
});

test("toLocalRollCalls: 名簿に同じ氏名が 2 人いれば名寄せしない（unmatched）", () => {
  const dup = [...roster.members, { ...roster.members.find((m) => m.name === "柚木 貴光")!, id: "p_04_dup" }];
  const { rollCalls, unmatched } = toLocalRollCalls(pdf398, dup, { sessionLabel: "令和7年11月定例会（第398回）", pdfUrl: PDF398 });
  assert.equal(rollCalls[0].votes[0].memberId, "");
  assert.ok(unmatched.some((u) => u.nameText === "柚木 貴光"));
});
