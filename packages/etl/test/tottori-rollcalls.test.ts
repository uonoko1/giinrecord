import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { LocalMember } from "@seiji-kiroku/shared";
import { parseRoster } from "../src/sources/local/tottori/roster.ts";
import { parseVotePdf, type VotePdf } from "../src/sources/local/tottori/votes-pdf.ts";
import { mapLegend, matchName, toLocalRollCalls } from "../src/sources/local/tottori/rollcalls.ts";

// 鳥取県議会の表決 PDF → LocalRollCall（Issue #184）。
// - 名寄せ: PDF は「○○議員」（姓だけ。同姓は「浜田一議員」のように名の 1 文字付き）。名簿の氏名（空白を除く）がその文字列で始まる議員が
//   ちょうど 1 人のときだけ寄せる。0 人・2 人以上は memberId 空で unmatched に載せ、候補を全員列挙する（選ばない）。
// - 同じ会期の複数の PDF（全体版と部分集合版、同じファイルの複製）に同じ議案が出たら、内容が一致することを確かめて 1 件にする。
const fixture = (name: string) => readFileSync(new URL(`./fixtures/tottori/${name}`, import.meta.url));
const roster = parseRoster(fixture("75928.htm").toString("utf8")).members;
const origin = "https://www.pref.tottori.lg.jp";
const juneUrls = {
  all: `${origin}/secure/1422217/R8.6giketsukekka0629.pdf`,
  giin: `${origin}/secure/1422215/R8.6.29%20giinteishutsugian_giketsukekka.pdf`,
  seigan: `${origin}/secure/1422216/R8.6.29_seiganchinjogiketsukekka.pdf`,
};
const june = [
  { pdf: await parseVotePdf(fixture("R8.6giketsukekka0629.pdf")), pdfUrl: juneUrls.all },
  { pdf: await parseVotePdf(fixture("R8.6.29_giinteishutsugian_giketsukekka.pdf")), pdfUrl: juneUrls.giin },
  { pdf: await parseVotePdf(fixture("R8.6.29_seiganchinjogiketsukekka.pdf")), pdfUrl: juneUrls.seigan },
];
const febSengi = await parseVotePdf(fixture("R0802sengikekka.pdf"));
const feb0325 = await parseVotePdf(fixture("R8.2giketsukekka0325.pdf"));
const session = { sessionId: "2026-06", sessionLabel: "令和8年6月定例会" };

test("matchName: 名簿の氏名が PDF の姓（＋名の 1 文字）で始まる議員がちょうど 1 人なら寄せる。0 人・2 人以上は候補を全員返して選ばない", () => {
  const r = (name: string, id = name): LocalMember => ({ id, assemblyId: "pref-31", name, kana: "", group: "", district: "", profileUrl: "", current: true, asOf: "2023-04-30", sourceUrl: "", counts: { rollcalls: 0 } });
  const members = [r("浜田 一哉", "a"), r("浜田 妙子", "b"), r("森 由美子", "c"), r("森山 太郎", "d"), r("入江 誠", "e")];
  assert.deepEqual(matchName("入江議員", members), { memberId: "e", candidates: [{ id: "e", name: "入江 誠" }] });
  assert.deepEqual(matchName("浜田一議員", members), { memberId: "a", candidates: [{ id: "a", name: "浜田 一哉" }] });
  assert.deepEqual(matchName("浜田議員", members), { memberId: "", candidates: [{ id: "a", name: "浜田 一哉" }, { id: "b", name: "浜田 妙子" }] });
  assert.deepEqual(matchName("森議員", members), { memberId: "", candidates: [{ id: "c", name: "森 由美子" }, { id: "d", name: "森山 太郎" }] });
  assert.deepEqual(matchName("森山議員", members), { memberId: "d", candidates: [{ id: "d", name: "森山 太郎" }] });
  assert.deepEqual(matchName("高橋議員", members), { memberId: "", candidates: [] });
  // 「議員」が無い・空は名寄せしない
  assert.deepEqual(matchName("議員", members), { memberId: "", candidates: [] });
});

test("mapLegend: 凡例の意味から国会の値に機械的に対応づけられるものだけ mapped（○→賛成、×→反対、議長・副議長・除斥・欠席・議場に不在→投票なし。棄権・不明は付けない）", () => {
  assert.deepEqual(mapLegend("○", "賛成"), { raw: "○", legend: "賛成", mapped: "賛成" });
  assert.deepEqual(mapLegend("×", "反対"), { raw: "×", legend: "反対", mapped: "反対" });
  assert.deepEqual(mapLegend("議", "議長"), { raw: "議", legend: "議長", mapped: "投票なし" });
  assert.deepEqual(mapLegend("副", "副議長が議長の職務を代理"), { raw: "副", legend: "副議長が議長の職務を代理", mapped: "投票なし" });
  assert.deepEqual(mapLegend("除", "除斥"), { raw: "除", legend: "除斥", mapped: "投票なし" });
  assert.deepEqual(mapLegend("欠", "欠席"), { raw: "欠", legend: "欠席", mapped: "投票なし" });
  assert.deepEqual(mapLegend("－", "議場に不在であり、表決しなかった議員"), { raw: "－", legend: "議場に不在であり、表決しなかった議員", mapped: "投票なし" });
  assert.deepEqual(mapLegend("棄", "棄権"), { raw: "棄", legend: "棄権" });
  assert.deepEqual(mapLegend("不明", "抽出不能"), { raw: "不明", legend: "抽出不能" });
  // 凡例の文言が少しでも違えば対応づけない
  assert.deepEqual(mapLegend("議", "議長（表決に加わらない）"), { raw: "議", legend: "議長（表決に加わらない）" });
});

test("toLocalRollCalls: 令和8年6月定例会の 3 つの PDF → 30 件（重複は内容一致を確かめて 1 件に）。id・日付・会派・賛否の対象・委員長報告・sourceUrl", () => {
  const { rollCalls, unmatched } = toLocalRollCalls(june, roster, session);
  assert.equal(rollCalls.length, 30);
  assert.equal(unmatched.length, 0);
  const first = rollCalls[0];
  assert.equal(first.id, "pref-31-2026-06-20260629-知事提案-第1号");
  assert.equal(first.assemblyId, "pref-31");
  assert.equal(first.sessionId, "2026-06");
  assert.equal(first.sessionLabel, "令和8年6月定例会");
  assert.equal(first.date, "2026-06-29");
  assert.equal(first.kind, "知事提案");
  assert.equal(first.number, "第1号");
  assert.equal(first.title, "令和８年度鳥取県一般会計補正予算（第１号）");
  assert.deepEqual(first.method, { raw: "起立", legend: "起立" });
  assert.equal(first.result, "可決");
  assert.deepEqual(first.counts, { voting: 34, yes: 33, no: 1 });
  assert.equal(first.voteSubject, "議案に対する賛否");
  assert.equal(first.committeeReport, undefined);
  assert.equal(first.page, 1);
  assert.equal(first.sourceUrl, juneUrls.all);
  assert.equal(first.votes.length, 35);
  assert.deepEqual(first.votes[0], { memberId: "p_31_item_967688", nameText: "入江議員", group: "自由民主党", value: { raw: "○", legend: "賛成", mapped: "賛成" } });
  assert.deepEqual(first.votes[17], { memberId: "p_31_item_1165923", nameText: "浜田一議員", group: "自由民主党", value: { raw: "○", legend: "賛成", mapped: "賛成" } });
  assert.deepEqual(first.votes[18], { memberId: "p_31_item_1165930", nameText: "福田議員", group: "自由民主党", value: { raw: "議", legend: "議長", mapped: "投票なし" } });
  assert.deepEqual(first.votes[21].memberId, "p_31_item_1165924");
  assert.deepEqual(first.votes[34], { memberId: "p_31_item_1165907", nameText: "市谷議員", group: "無所属", value: { raw: "×", legend: "反対", mapped: "反対" } });
  // 議員提出議案: 全体版（sourceUrl は最初に出た PDF）。部分集合版には節見出しが無いが、全体版の「議案に対する賛否」が付く
  const giin = rollCalls.find((r) => r.id === "pref-31-2026-06-20260629-議員提案-第1号")!;
  assert.equal(giin.sourceUrl, juneUrls.all);
  assert.equal(giin.voteSubject, "議案に対する賛否");
  // 陳情: 賛否は委員長報告に対するもの
  const chinjo = rollCalls.find((r) => r.id === "pref-31-2026-06-20260629-陳情-7年-11")!;
  assert.equal(chinjo.voteSubject, "委員長報告に対する賛否");
  assert.equal(chinjo.committeeReport, "研究留保");
  assert.equal(chinjo.result, "研究留保");
  assert.equal(chinjo.title, "旧姓の通称使用の法制化を求める陳情");
  assert.equal(chinjo.votes.filter((v) => v.value.mapped === "反対").length, 11);
  // 同姓の「浜田一議員」「浜田妙議員」は名の 1 文字で 1 人に決まる
  assert.equal(rollCalls.every((r) => r.votes.every((v) => v.memberId !== "")), true);
  assert.equal(new Set(rollCalls.map((r) => r.id)).size, 30);
});

test("toLocalRollCalls: 姓だけで名簿に同姓が 2 人いれば寄せない。unmatched に候補を全員列挙する（選ばない）", () => {
  // PDF の「浜田一議員」を「浜田議員」に変えた場合（名簿には 浜田一哉・浜田妙子 の 2 人）
  const pdf = june[0].pdf;
  const altered: VotePdf = { ...pdf, members: pdf.members.map((m) => (m.nameText === "浜田一議員" ? { ...m, nameText: "浜田議員" } : m)) };
  const { rollCalls, unmatched } = toLocalRollCalls([{ pdf: altered, pdfUrl: juneUrls.all }], roster, session);
  assert.equal(rollCalls[0].votes[17].memberId, "");
  assert.equal(rollCalls[0].votes[17].nameText, "浜田議員");
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].nameText, "浜田議員");
  assert.equal(unmatched[0].group, "自由民主党");
  assert.equal(unmatched[0].rollCallIds.length, 30);
  assert.deepEqual(unmatched[0].candidates, [{ id: "p_31_item_1165923", name: "浜田 一哉" }, { id: "p_31_item_1165924", name: "浜田 妙子" }]);
  // 名簿に無い姓は候補なし（candidates は省略）
  const gone: VotePdf = { ...pdf, members: pdf.members.map((m) => (m.nameText === "入江議員" ? { ...m, nameText: "高橋議員" } : m)) };
  const r2 = toLocalRollCalls([{ pdf: gone, pdfUrl: juneUrls.all }], roster, session);
  assert.deepEqual(r2.unmatched.map((u) => [u.nameText, u.candidates]), [["高橋議員", undefined]]);
  assert.equal("candidates" in r2.unmatched[0], false);
});

test("toLocalRollCalls: 同じ議案が複数の PDF に出て内容が食い違えば失敗する（どちらが正しいか推定しない）", () => {
  const pdf = june[0].pdf;
  const flipped: VotePdf = { ...pdf, rows: pdf.rows.map((r, i) => (i === 0 ? { ...r, cells: r.cells.map((c) => (c === "×" ? "○" : c)) } : r)) };
  assert.throws(() => toLocalRollCalls([june[0], { pdf: flipped, pdfUrl: juneUrls.giin }], roster, session), /differs/);
  const otherResult: VotePdf = { ...pdf, rows: pdf.rows.map((r, i) => (i === 0 ? { ...r, result: "否決" } : r)) };
  assert.throws(() => toLocalRollCalls([june[0], { pdf: otherResult, pdfUrl: juneUrls.giin }], roster, session), /differs/);
  // 同じファイルの複製（URL だけ違う）は 1 件。会期のラベルが PDF の見出しと違えば失敗
  assert.equal(toLocalRollCalls([june[0], { pdf, pdfUrl: `${origin}/secure/1/x.pdf` }], roster, session).rollCalls.length, 30);
  assert.throws(() => toLocalRollCalls(june, roster, { sessionId: "2026-02", sessionLabel: "令和8年2月定例会" }), /令和8年6月定例会/);
});

test("toLocalRollCalls: 令和8年2月定例会は議決日が 2 つ（3/9 先議 14 件・3/25 74 件）。id に議決日が入るので一意。附帯意見の行もそのまま", () => {
  const feb = { sessionId: "2026-02", sessionLabel: "令和8年2月定例会" };
  const { rollCalls } = toLocalRollCalls([
    { pdf: febSengi, pdfUrl: `${origin}/secure/1412313/R0802sengikekka.pdf` },
    { pdf: feb0325, pdfUrl: `${origin}/secure/1412311/R8.2giketsukekka0325.pdf` },
    { pdf: feb0325, pdfUrl: `${origin}/secure/1412309/R8.2giketsukekka0325.pdf` },
  ], roster, feb);
  assert.equal(rollCalls.length, 88);
  assert.ok(rollCalls.some((r) => r.id === "pref-31-2026-02-20260309-知事提案-第22号"));
  assert.ok(rollCalls.some((r) => r.id === "pref-31-2026-02-20260325-知事提案-附帯意見"));
  assert.ok(rollCalls.some((r) => r.id === "pref-31-2026-02-20260325-請願-8年-2"));
  assert.equal(rollCalls.find((r) => r.id === "pref-31-2026-02-20260325-陳情-8年-3")?.committeeReport, "趣旨採択（措置済）");
  assert.equal(new Set(rollCalls.map((r) => r.id)).size, 88);
  assert.equal(rollCalls.every((r) => r.votes.every((v) => v.memberId !== "")), true);
});
