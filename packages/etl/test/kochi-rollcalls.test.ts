import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { LocalMember } from "@seiji-kiroku/shared";
import { parseVotePdf } from "../src/sources/local/kochi/votes-pdf.ts";
import { mapLegend, matchName, toLocalRollCalls } from "../src/sources/local/kochi/rollcalls.ts";
import { parseRoster } from "../src/sources/local/kochi/roster.ts";

// 高知県議会の表決 PDF の行 → LocalRollCall（Issue #220）。
const pdf = await parseVotePdf(readFileSync(new URL("./fixtures/kochi/0806.pdf", import.meta.url)));
const roster = parseRoster(readFileSync(new URL("./fixtures/kochi/member-categories.html", import.meta.url), "utf-8"));
const session = { sessionId: "2026-06", sessionLabel: "令和８年６月定例会" };
const pdfUrl = "https://gikai.pref.kochi.lg.jp/_files/00156424/0806.pdf";
const converted = toLocalRollCalls([{ pdf, pdfUrl }], roster.members, session);

test("mapLegend: 凡例の意味が国会の値に読めるときだけ mapped を付ける（推定しない）", () => {
  assert.deepEqual(mapLegend("○", "賛成"), { raw: "○", legend: "賛成", mapped: "賛成" });
  assert.deepEqual(mapLegend("×", "反対"), { raw: "×", legend: "反対", mapped: "反対" });
  // 「票を投じていない」と凡例が言うものは 投票なし
  assert.deepEqual(mapLegend("議", "議長"), { raw: "議", legend: "議長", mapped: "投票なし" });
  assert.deepEqual(mapLegend("欠", "欠席"), { raw: "欠", legend: "欠席", mapped: "投票なし" });
  assert.deepEqual(mapLegend("除", "除斥"), { raw: "除", legend: "除斥", mapped: "投票なし" });
  assert.deepEqual(mapLegend("－", "議場に不在であった議員"), { raw: "－", legend: "議場に不在であった議員", mapped: "投票なし" });
  assert.deepEqual(mapLegend("副", "副議長が議長の職務を代理"), { raw: "副", legend: "副議長が議長の職務を代理", mapped: "投票なし" });
  // 凡例に無い意味は mapped を付けない
  assert.deepEqual(mapLegend("？", "なにか別のもの"), { raw: "？", legend: "なにか別のもの" });
  // 抽出不能のセルは mapped を付けない
  assert.deepEqual(mapLegend("不明", "抽出不能"), { raw: "不明", legend: "抽出不能" });
});

test("matchName: 名簿と完全一致（空白・異体字を寄せる）で 1 人に決まれば寄せる", () => {
  assert.equal(matchName("浜口卓也", roster.members).memberId, "p_39_1");
  // 名簿は「浜口 卓也」（空白入り）、PDF は「浜口卓也」
  assert.equal(matchName("塚地佐智", roster.members).memberId, "p_39_37");
  // 岡﨑（異体字）は名簿も PDF も「﨑」。「岡崎」でも寄る
  assert.equal(matchName("岡崎哲也", roster.members).memberId, "p_39_29");
});

test("matchName: 名簿に無い氏名は memberId を空のままにする（候補も無ければ空）", () => {
  const m = matchName("架空 太郎", roster.members);
  assert.equal(m.memberId, "");
  assert.deepEqual(m.candidates, []);
});

test("matchName: 候補が 2 人以上なら選ばない（候補を全部返す）", () => {
  // 「西森」は 美和・雅和 の 2 人。姓だけでは決まらない
  const m = matchName("西森", roster.members);
  assert.equal(m.memberId, "");
  assert.deepEqual(m.candidates.map((c) => c.name).sort(), ["西森 美和", "西森 雅和"]);
});

test("toLocalRollCalls: id は {assemblyId}-{sessionId}-{議決日}-{種別}-{番号}", () => {
  const first = converted.rollCalls[0];
  assert.equal(first.id, "pref-39-2026-06-20260710-知事提出議案-第1号");
  assert.equal(first.assemblyId, "pref-39");
  assert.equal(first.sessionId, "2026-06");
  assert.equal(first.sessionLabel, "令和８年６月定例会");
  assert.equal(first.date, "2026-07-10");
  assert.equal(first.kind, "知事提出議案");
  assert.equal(first.number, "第1号");
  assert.equal(first.title, "令和８年度高知県一般会計予算");
  assert.equal(first.result, "原案可決");
  assert.equal(first.sourceUrl, pdfUrl);
  // id は会期の中で一意
  const ids = converted.rollCalls.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("toLocalRollCalls: 議決年月日の「〃」は上の行の日付で埋める（表の続きという原文の意味どおり）", () => {
  // R8.7.10 の次の行は「〃」。date は同じ日、result の原文は行ごとにそのまま
  const second = converted.rollCalls[1];
  assert.equal(second.date, "2026-07-10");
  assert.equal(second.result, "原案可決");
  for (const rc of converted.rollCalls) assert.equal(rc.date, "2026-07-10");
});

test("toLocalRollCalls: 票は PDF の列の順。原文（raw・legend）を必ず持つ", () => {
  const first = converted.rollCalls[0];
  assert.equal(first.votes.length, 36);
  assert.deepEqual(first.votes[0], {
    memberId: "p_39_1",
    nameText: "浜口卓也",
    group: "自由民主党",
    value: { raw: "○", legend: "賛成", mapped: "賛成" },
  });
  // 議長（19 列目）は「議」＝投票なし
  assert.deepEqual(first.votes[18].value, { raw: "議", legend: "議長", mapped: "投票なし" });
  // 日本共産党の 6 名は反対
  for (const v of first.votes.slice(30)) assert.deepEqual(v.value, { raw: "×", legend: "反対", mapped: "反対" });
});

test("toLocalRollCalls: 会派は表決時点の PDF の原文を使う（名簿の今の会派で上書きしない）", () => {
  for (const rc of converted.rollCalls) {
    for (const v of rc.votes) assert.notEqual(v.group, "");
  }
  const kyosan = converted.rollCalls[0].votes.filter((v) => v.group === "日本共産党");
  assert.equal(kyosan.length, 6);
});

test("toLocalRollCalls: 名簿に寄らなかった氏名は unmatched に出す（memberId は空のまま）", () => {
  // この会期の 36 名は全員名簿に居る
  assert.deepEqual(converted.unmatched, []);
  for (const rc of converted.rollCalls) for (const v of rc.votes) assert.notEqual(v.memberId, "");
});

test("toLocalRollCalls: 会期の原文が PDF と食い違えば例外（別の会期の PDF を黙って読まない）", () => {
  assert.throws(
    () => toLocalRollCalls([{ pdf, pdfUrl }], roster.members, { sessionId: "2026-02", sessionLabel: "令和８年２月定例会" }),
    /PDF says/,
  );
});

test("toLocalRollCalls: 名簿に無い氏名は unmatched に候補つきで出す", () => {
  const few: LocalMember[] = roster.members.slice(0, 2);
  const c = toLocalRollCalls([{ pdf, pdfUrl }], few, session);
  assert.ok(c.unmatched.length > 0);
  const one = c.unmatched.find((u) => u.nameText === "塚地佐智");
  assert.ok(one);
  assert.ok(one.rollCallIds.length > 0);
});
