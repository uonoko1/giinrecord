import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRoster } from "../src/sources/local/miyagi/roster.ts";
import { parseVotePdf, type VotePdf } from "../src/sources/local/miyagi/votes-pdf.ts";
import { checkPdfSession, mapLegend, toIsoDate, toLocalRollCalls } from "../src/sources/local/miyagi/rollcalls.ts";

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

// 「名簿と PDF で字が食い違う」実データの見本（#576 の三重・奈良の実例と同型）を
// 宮城の突合経路（toLocalRollCalls）に通す。宮城の nameKey は空白しか見ないので、
// 字体そのものが食い違えば必ず unmatched に落ちる（畳まない設計を固定するテスト）。
// PDF はバイナリなので、パース結果 VotePdf を直接組み立てて toLocalRollCalls に渡す。
const fakePdf = (nameText: string): VotePdf => ({
  // #695 で PDF の見出しと会期 index の見出しを突き合わせるようになったので、見出しは実物と同じ形にする
  sessionLabel: "第398回宮城県議会（令和7年11月定例会）",
  sessionId: "398",
  sessionYear: 2025,
  sessionMonth: 11,
  legend: { votes: { "○": "賛成" }, methods: { 起立: "起立採決" }, groups: {} },
  members: [{ nameText, groupText: "", group: "" }],
  rows: [
    {
      page: 1,
      kind: "議案",
      number: "1",
      title: "t",
      dateText: "12/17",
      counts: { present: 1, voting: 1, yes: 1, no: 0 },
      methodText: "起立",
      result: "可決",
      cells: ["○"],
    },
  ],
  unknownCells: 0,
});

// #636 で 7 県の突合キーを 1 本にするまで、宮城は空白を除くだけで異体字セレクタも字体も畳まなかったので、
// この入力は unmatched に落ちていた。共通キー（name-match.ts）が IVS を除くようになったので、今は同じ人に寄る。
test("toLocalRollCalls: 名簿は「髙橋 伸二」(U+9AD9)、PDF に三重の実データと同型の IVS 付き表記（髙\\u{E0100}橋 伸二）が来ても同じ人に寄る（#636。IVS は幅 0 で目に見えない）", () => {
  const pdf = fakePdf("髙\u{E0100}橋 伸二");
  const { rollCalls, unmatched } = toLocalRollCalls(pdf, roster.members, { sessionLabel: "令和7年11月定例会（第398回）", pdfUrl: "https://example.test/x.pdf" });
  assert.equal(rollCalls[0].votes[0].memberId, "p_04_sinji");
  assert.deepEqual(unmatched, []);
});

test("toLocalRollCalls: 名簿「髙橋 伸二」に PDF の「高橋 伸二」（字体違い）が来ても同じ人に寄る（#636。本番の名簿で実際に効いている 1 名）", () => {
  const pdf = fakePdf("高橋 伸二");
  const { rollCalls, unmatched } = toLocalRollCalls(pdf, roster.members, { sessionLabel: "令和7年11月定例会（第398回）", pdfUrl: "https://example.test/x.pdf" });
  assert.equal(rollCalls[0].votes[0].memberId, "p_04_sinji");
  assert.deepEqual(unmatched, []);
});

test("toLocalRollCalls: 字体を畳んでも別人には寄らない（#569。畳んだ結果ぶつかる相手がいれば選ばない）", () => {
  // 名簿に「髙橋 伸二」と「高橋 伸二」の両方がいたら、キーが同じになるので ETL は選ばない
  const both = [...roster.members, { ...roster.members[0], id: "p_04_other", name: "高橋 伸二" }];
  const { rollCalls, unmatched } = toLocalRollCalls(fakePdf("高橋 伸二"), both, { sessionLabel: "令和7年11月定例会（第398回）", pdfUrl: "https://example.test/x.pdf" });
  assert.equal(rollCalls[0].votes[0].memberId, "");
  assert.deepEqual(unmatched.map((u) => u.nameText), ["高橋 伸二"]);
});

test("toLocalRollCalls: 名簿の表記と空白の有無以外は完全に同じ字（IVS 無し）なら、これまでどおり紐づく（回帰）", () => {
  const pdf = fakePdf("髙橋　伸二");
  const { rollCalls, unmatched } = toLocalRollCalls(pdf, roster.members, { sessionLabel: "令和7年11月定例会（第398回）", pdfUrl: "https://example.test/x.pdf" });
  assert.equal(rollCalls[0].votes[0].memberId, "p_04_sinji");
  assert.deepEqual(unmatched, []);
});

// ── #695: 表決 PDF の見出しと会期 index の見出しを突き合わせる ────────────────────────
// index.ts は通算回次（pdf.sessionId）だけを見ていた。回次は宮城県議会の通算なので一意で、これだけでも
// 別の会期の PDF はほぼ弾ける。ただし **議決日は PDF 側の年月（sessionYear / sessionMonth）から作る**
// （toIsoDate。議決月日の欄は「12/17」と月日しか無い）ので、回次が合っていても年月が食い違えば
// 日付だけが別の会期のものになる。回次と年月は同じ見出しの中の別々の語なので、両方を照合する。

test("#695 toLocalRollCalls: 別の会期の PDF を渡せば例外（第399回の PDF を第398回として読ませない）", () => {
  // 実物どうしの取り違え: 第399回（令和8年2月定例会）の PDF を、第398回（令和7年11月定例会）として渡す
  assert.throws(
    () => toLocalRollCalls(pdf399, roster.members, { sessionLabel: "令和7年11月定例会（第398回）", pdfUrl: PDF398 }),
    /PDF says 第399回, session index says 第398回/,
  );
  assert.throws(
    () => toLocalRollCalls(pdf398, roster.members, { sessionLabel: "令和8年2月定例会（第399回）", pdfUrl: PDF399 }),
    /PDF says 第398回, session index says 第399回/,
  );
});

test("#695 checkPdfSession: 回次が合っていても年月が食い違えば例外（議決日は PDF の年月から作られる）", () => {
  assert.throws(
    () => checkPdfSession("第398回宮城県議会（令和8年2月定例会）", "令和7年11月定例会（第398回）", PDF398),
    /PDF says 令和8年2月定例会, session index says 令和7年11月定例会/,
  );
});

test("#695 checkPdfSession: 否定的対照——実物の見出しと会期 index の見出しの組は通る", () => {
  assert.doesNotThrow(() => checkPdfSession(pdf398.sessionLabel, "令和7年11月定例会（第398回）", PDF398));
  assert.doesNotThrow(() => checkPdfSession(pdf399.sessionLabel, "令和8年2月定例会（第399回）", PDF399));
});

test("#695 checkPdfSession: 見出しが想定の形でなければ例外（黙って照合を飛ばさない）", () => {
  assert.throws(() => checkPdfSession("テスト会期", "令和7年11月定例会（第398回）", PDF398), /is not 第N回宮城県議会/);
  assert.throws(() => checkPdfSession(pdf398.sessionLabel, "令和7年11月のなにか", PDF398), /is not 令和N年M月定例会/);
});
