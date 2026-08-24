import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseVotePdf } from "../src/sources/local/mie/votes-pdf.ts";
import { mapLegend, nameKey, toLocalRollCalls } from "../src/sources/local/mie/rollcalls.ts";
import { DISTRICT_INDEX_URL, parseDistrictIndex, parseDistrictPage, parseGojuon, buildRoster } from "../src/sources/local/mie/roster.ts";

// 表決 PDF の行 → LocalRollCall（Issue #203）。名寄せは空白と異体字セレクタを除いた完全一致だけ（推定しない）。
const read = (name: string) => readFileSync(new URL(`./fixtures/mie/${name}`, import.meta.url), "utf8");
const bytes = (name: string) => readFileSync(new URL(`./fixtures/mie/${name}`, import.meta.url));
const origin = "https://www.pref.mie.lg.jp";

const gojuon = parseGojuon(read("meibo-50on.htm"));
const links = parseDistrictIndex(read("meibo-senkyoku.htm"), DISTRICT_INDEX_URL);
const pages = links.map((l) => parseDistrictPage(read(`senkyoku-${l.url.match(/(\d+)\.htm$/)![1]}.htm`), l.url));
const roster = buildRoster(gojuon, links, pages);
const jun = await parseVotePdf(bytes("001263901.pdf"));
const session = { sessionId: "r08", sessionLabel: "令和８年定例会", pdfUrl: `${origin}/common/content/001263901.pdf` };

test("mapLegend: ○→賛成・×→反対、議長・除斥・欠席・不在→投票なし。不明には mapped を付けない", () => {
  assert.deepEqual(mapLegend("○", "賛成"), { raw: "○", legend: "賛成", mapped: "賛成" });
  assert.deepEqual(mapLegend("×", "反対"), { raw: "×", legend: "反対", mapped: "反対" });
  assert.deepEqual(mapLegend("議", "議長"), { raw: "議", legend: "議長", mapped: "投票なし" });
  assert.deepEqual(mapLegend("欠", "欠席"), { raw: "欠", legend: "欠席", mapped: "投票なし" });
  assert.deepEqual(mapLegend("除", "除斥"), { raw: "除", legend: "除斥", mapped: "投票なし" });
  assert.deepEqual(mapLegend("－", "不在"), { raw: "－", legend: "不在", mapped: "投票なし" });
  assert.deepEqual(mapLegend("不明", "抽出不能"), { raw: "不明", legend: "抽出不能" });
  // 凡例が知らない意味なら mapped を付けない（推定しない）
  assert.deepEqual(mapLegend("棄", "棄権"), { raw: "棄", legend: "棄権" });
});

test("nameKey: 空白（全角・半角）と異体字セレクタ（辻󠄀 の IVS）を除いて比べる。字そのものは寄せない", () => {
  assert.equal(nameKey("辻\u{E0100}内 裕也"), nameKey("辻内　裕也"));
  assert.equal(nameKey("東　　 豊"), "東豊");
  assert.notEqual(nameKey("高橋"), nameKey("髙橋")); // 異体字は寄せない
});

test("toLocalRollCalls: 令和8年6月分 → 22 件。id は pref-24-r08-{議決日}-{種別}-{番号(NFKC)}、日付は表題の年と議決月日から", () => {
  const { rollCalls, unmatched } = toLocalRollCalls(jun, roster.members, session);
  assert.equal(rollCalls.length, 22);
  assert.equal(unmatched.length, 0);
  const shimon = rollCalls[0];
  assert.equal(shimon.id, "pref-24-r08-20260612-諮問-第1号");
  assert.equal(shimon.date, "2026-06-12");
  assert.equal(shimon.sessionId, "r08");
  assert.equal(shimon.sessionLabel, "令和８年定例会");
  assert.equal(shimon.kind, "諮問");
  assert.equal(shimon.number, "第1号");
  assert.equal(shimon.result, "棄却すべき");
  assert.deepEqual(shimon.counts, { present: 47, voting: 46, yes: 46, no: 0 });
  assert.equal(shimon.method, undefined, "表決方法の欄が無いので method は書かない（推定しない）");
  assert.equal(shimon.sourceUrl, session.pdfUrl);
  assert.equal(shimon.page, 1);
  assert.equal(shimon.votes.length, 47);
  assert.deepEqual(shimon.votes[0], { memberId: "p_24_ichino_shuuhei15", nameText: "市野 修平", group: "新政みえ", value: { raw: "○", legend: "賛成", mapped: "賛成" } });
  assert.deepEqual(shimon.votes[15].value, { raw: "議", legend: "議長", mapped: "投票なし" });
  // 全角番号は id では NFKC（第８号 → 第8号）、number は原文のまま
  const iken8 = rollCalls.find((r) => r.number === "第８号")!;
  assert.equal(iken8.id, "pref-24-r08-20260630-意見書案-第8号");
  // 異体字セレクタ付きの氏名（辻󠄀内）も名簿（辻内）に寄る
  const tsuji = shimon.votes[35];
  assert.equal(tsuji.nameText, "辻\u{E0100}内 裕也");
  assert.equal(tsuji.memberId, "p_24_tujiuchi_yuuya15");
  // 不在（－）は投票なし
  const iken10 = rollCalls.find((r) => r.id === "pref-24-r08-20260630-意見書案-第10号")!;
  assert.deepEqual(iken10.votes[28].value, { raw: "－", legend: "不在", mapped: "投票なし" });
});

test("toLocalRollCalls: 議決月日の月が PDF の月と違えば例外、名簿に無い氏名は memberId 空で unmatched に載る", () => {
  const wrongMonth = { ...jun, rows: [{ ...jun.rows[0], dateText: "7/1" }] };
  assert.throws(() => toLocalRollCalls(wrongMonth, roster.members, session), /7\/1/);
  // 名簿から 1 人消すと、その人の票は memberId 空で unmatched に列挙される
  const without = roster.members.filter((m) => m.id !== "p_24_ichino_shuuhei15");
  const { rollCalls, unmatched } = toLocalRollCalls(jun, without, session);
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].nameText, "市野 修平");
  assert.equal(unmatched[0].group, "新政みえ");
  assert.equal(unmatched[0].rollCallIds.length, 22);
  assert.ok(rollCalls.every((rc) => rc.votes[0].memberId === ""));
  // 同姓同名が 2 人いれば寄せない
  const dup = [...roster.members, { ...roster.members.find((m) => m.id === "p_24_ichino_shuuhei15")!, id: "p_24_dup" }];
  assert.equal(toLocalRollCalls(jun, dup, session).unmatched.length, 1);
});
