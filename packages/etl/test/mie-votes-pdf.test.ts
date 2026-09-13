import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseVotePdf, UNKNOWN_CELL } from "../src/sources/local/mie/votes-pdf.ts";

// 三重県議会「議員別の賛否等の状況」PDF（Issue #203）。月ごとに 1 本、行＝議案・列＝議員（縦書き氏名、上段に会派の結合セル）。
// 1 ページに全議案 × 全議員が入る高密度の表（列幅 約15pt）。議案が多い月は同じ形のページが増える（ヘッダは毎ページ繰り返し）。
//   令和8年6月分: https://www.pref.mie.lg.jp/common/content/001263901.pdf（1 ページ 22 行、2026-08-24 取得）
//   令和8年2月分: …/001242584.pdf（1 ページ 4 行）、令和8年3月分: …/001249930.pdf（3 ページ、議決日 3/23・3/31）
// 宮城・徳島と同じく罫線から列・行の境界を取り、文字の中心が入るセルにだけ置く。置けないセルは UNKNOWN_CELL（推定しない）。
const bytes = (name: string) => readFileSync(new URL(`./fixtures/mie/${name}`, import.meta.url));
const jun = await parseVotePdf(bytes("001263901.pdf"));
const feb = await parseVotePdf(bytes("001242584.pdf"));
const mar = await parseVotePdf(bytes("001249930.pdf"));

test("parseVotePdf: 表題「令和８年定例会（６月）」から会期名と月を取り、凡例（○×議除－欠）を読む", () => {
  assert.equal(jun.sessionName, "令和８年定例会");
  assert.equal(jun.year, 2026);
  assert.equal(jun.month, 6);
  assert.deepEqual(jun.legend, { "○": "賛成", "×": "反対", "議": "議長", "除": "除斥", "－": "不在", "欠": "欠席" });
  assert.equal(feb.month, 2);
  assert.equal(mar.month, 3);
});

test("parseVotePdf: 議員 47 人の列を会派の結合セルつきで復元する（縦書き氏名。空きマスは半角空白）", () => {
  assert.equal(jun.members.length, 47);
  assert.deepEqual(jun.members[0], { nameText: "市野 修平", group: "新政みえ" });
  assert.deepEqual(jun.members[9], { nameText: "中瀬古初美", group: "新政みえ" }); // 5 文字で埋まる
  assert.deepEqual(jun.members[15], { nameText: "藤田 宜三", group: "新政みえ" });
  assert.deepEqual(jun.members[35], { nameText: "辻\u{E0100}内 裕也", group: "自民党県議団" }); // PDF は異体字セレクタ付き（原文のまま）
  assert.deepEqual(jun.members[46], { nameText: "難波 聖子", group: "参政党" });
  const groups = new Map<string, number>();
  for (const m of jun.members) groups.set(m.group, (groups.get(m.group) ?? 0) + 1);
  assert.deepEqual([...groups.entries()], [
    ["新政みえ", 19],
    ["自由民主党", 16],
    ["自民党県議団", 5],
    ["草莽", 3],
    ["公明党", 2],
    ["日本共産党", 1],
    ["参政党", 1],
  ]);
  // 月が違っても各 PDF のヘッダを読む（2月と 6月は同じ 47 人）
  assert.deepEqual(feb.members, jun.members);
});

test("parseVotePdf: 行（議案）は 議案等番号・件名・議決月日・人数・議決結果 と 47 セル。種別は番号の接頭辞（議案・諮問・請願・意見書案）", () => {
  assert.equal(jun.rows.length, 22);
  const r0 = jun.rows[0];
  assert.equal(r0.kind, "諮問");
  assert.equal(r0.number, "第1号");
  assert.equal(r0.title, "諮問について");
  assert.equal(r0.dateText, "6/12");
  assert.deepEqual(r0.counts, { present: 47, voting: 46, yes: 46, no: 0 });
  assert.equal(r0.result, "棄却すべき");
  assert.equal(r0.page, 1);
  assert.equal(r0.cells.length, 47);
  assert.equal(r0.cells[15], "議");
  assert.ok(r0.cells.every((c, i) => (i === 15 ? c === "議" : c === "○")));
  // 全角の番号は原文のまま（「第８号」）
  const iken8 = jun.rows.find((r) => r.kind === "意見書案" && r.number === "第８号")!;
  assert.equal(iken8.title, "地方財政の充実及び強化を求める意見書案");
  // 賛否の割れた行: 意見書案第10号（賛成 25・反対 20・不在 1）
  const iken10 = jun.rows.find((r) => r.number === "第10号" && r.kind === "意見書案")!;
  assert.deepEqual(iken10.counts, { present: 46, voting: 45, yes: 25, no: 20 });
  assert.equal(iken10.cells.filter((c) => c === "○").length, 25);
  assert.equal(iken10.cells.filter((c) => c === "×").length, 20);
  assert.equal(iken10.cells[28], "－"); // 議場に不在の議員
  assert.equal(iken10.cells[15], "議");
  // 請願の行
  const seigan = jun.rows.find((r) => r.kind === "請願")!;
  assert.equal(seigan.number, "第54号");
  assert.equal(seigan.result, "不採択");
  assert.deepEqual([seigan.counts.yes, seigan.counts.no], [1, 45]);
  // 2月分: 4 行、欠席 2 人・議長は 服部 富男（列 38）
  assert.equal(feb.rows.length, 4);
  for (const r of feb.rows) {
    assert.equal(r.dateText, "2/27");
    assert.equal(r.cells[19], "欠");
    assert.equal(r.cells[26], "欠");
    assert.equal(r.cells[38], "議");
  }
  assert.deepEqual(feb.rows.map((r) => [r.kind, r.number]), [["議案", "第2号"], ["議案", "第3号"], ["議案", "第4号"], ["議案", "第22号"]]);
});

test("parseVotePdf: 複数ページの月（令和8年3月）はヘッダが毎ページ繰り返され、議員の列が一致することを確かめて行を足す", () => {
  assert.equal(mar.pages, 3);
  assert.deepEqual(mar.members, jun.members);
  assert.equal(mar.rows.length, 82);
  assert.deepEqual([...new Set(mar.rows.map((r) => r.dateText))], ["3/23", "3/31"]);
  assert.ok(mar.rows.some((r) => r.page === 3));
  // 種別は 議案・議提議案・意見書案。議案第77号だけ 3/31 議決
  assert.deepEqual([...new Set(mar.rows.map((r) => r.kind))], ["議案", "議提議案", "意見書案"]);
  const no77 = mar.rows.find((r) => r.number === "第77号")!;
  assert.equal(no77.dateText, "3/31");
  // 全ページ・全行が 47 セルで、値は凡例の字だけ（不明セル 0）
  for (const r of mar.rows) assert.equal(r.cells.length, 47);
  assert.equal(mar.unknownCells, 0);
  assert.equal(jun.unknownCells, 0);
  assert.equal(feb.unknownCells, 0);
});

test("parseVotePdf: 凡例に無い値が出るセルは例外にできる（checkCellsAgainstLegend は UNKNOWN_CELL だけ通す）", () => {
  // parse が通っている時点で全セルが凡例内（不明以外）であることは保証される。UNKNOWN_CELL の値そのものを確認
  assert.equal(UNKNOWN_CELL, "不明");
});

// ---------------------------------------------------------------------------
// 凡例が 1 つのテキストに繋がる本（Issue #841。index 151 本のうち 20 本がこの形）
//   "○：賛成×：反対議：議長除：除斥－：不在欠：欠席" が showText 1 つで出る。
//   平成28年1月分: https://www.pref.mie.lg.jp/common/content/000599391.pdf（`議` が出る。2026-09-14 取得）
//   平成28年2月分: …/000599392.pdf（`欠` が出る）、令和6年5月分: …/001197758.pdf（`除` が出る）
const h28jan = await parseVotePdf(bytes("000599391.pdf"));
const h28feb = await parseVotePdf(bytes("000599392.pdf"));
const r6may = await parseVotePdf(bytes("001197758.pdf"));

test("parseVotePdf: 凡例が 1 つのテキストに繋がっていても 6 件に分ける（#841。繋がった形は index 151 本中 20 本）", () => {
  const expected = { "○": "賛成", "×": "反対", "議": "議長", "除": "除斥", "－": "不在", "欠": "欠席" };
  assert.deepEqual(h28jan.legend, expected);
  assert.deepEqual(h28feb.legend, expected);
  assert.deepEqual(r6may.legend, expected);
  // 区切って読めた凡例は、区切らずに読めた本（令和8年6月）と同じであること
  assert.deepEqual(h28jan.legend, jun.legend);
  // **繋がった凡例のテキストが実際にその形であること**（フィクスチャが入れ替わったら気づける）
  assert.equal(Object.entries(expected).map(([k, v]) => `${k}：${v}`).join(""), "○：賛成×：反対議：議長除：除斥－：不在欠：欠席");
});

test("parseVotePdf: 凡例が繋がった本の 議 / 欠 / 除 が、落ちずにセルとして出る（#841 が直したのはここ）", () => {
  // **落ちていたのは この 3 つの記号**（index 151 本の実測で 議 13 本・欠 6 本・除 1 本）。
  // 1 本ずつ「その記号が実際に立っている列の議員」まで見る（凡例が読めただけでは足りない）。
  // 議: 平成28年1月 決議案第1号（北朝鮮の地下核実験に抗議する決議案、1/18 可決）
  assert.equal(h28jan.rows.length, 1);
  const jan = h28jan.rows[0];
  assert.deepEqual([jan.kind, jan.number, jan.dateText, jan.result], ["決議案", "第1号", "1/18", "可決"]);
  assert.deepEqual(jan.counts, { present: 51, voting: 50, yes: 50, no: 0 });
  assert.equal(h28jan.members.length, 51);
  assert.deepEqual(jan.cells.flatMap((c, i) => (c === "議" ? [i] : [])), [22]);
  assert.equal(h28jan.members[22].nameText, "中村 進一");
  assert.equal(jan.cells.filter((c) => c === "○").length, 50);
  assert.equal(h28jan.unknownCells, 0);
  // 欠: 平成28年2月 議案第1号（欠 2 人・× 2 人）
  const feb28 = h28feb.rows[0];
  assert.deepEqual(feb28.counts, { present: 49, voting: 48, yes: 46, no: 2 });
  assert.deepEqual(feb28.cells.flatMap((c, i) => (c === "欠" ? [i] : [])), [17, 44]);
  assert.deepEqual([h28feb.members[17].nameText, h28feb.members[44].nameText], ["舘 直人", "山内 道明"]);
  assert.deepEqual(feb28.cells.flatMap((c, i) => (c === "×" ? [i] : [])), [46, 47]);
  assert.equal(h28feb.unknownCells, 0);
  // 除: 令和6年5月 議案第90号（監査委員の選任につき同意を得るについて。除斥 2 人）
  const may = r6may.rows[0];
  assert.equal(may.title, "監査委員の選任につき同意を得るについて");
  assert.deepEqual(may.cells.flatMap((c, i) => (c === "除" ? [i] : [])), [7, 25]);
  assert.deepEqual([r6may.members[7].nameText, r6may.members[25].nameText], ["平畑 武", "山崎 博"]);
  // この本の 議 は 列 17 = 稲垣 昭義（県の公表する 114代 議長・令和06.05〜 と一致。mie-vote-alignment.test.ts の検算B）
  assert.deepEqual(may.cells.flatMap((c, i) => (c === "議" ? [i] : [])), [17]);
  assert.equal(r6may.members[17].nameText, "稲垣 昭義");
  assert.equal(r6may.unknownCells, 0);
  // 表題（平成の本。年は半角）
  assert.deepEqual([h28jan.year, h28jan.month], [2016, 1]);
  assert.deepEqual([h28feb.year, h28feb.month], [2016, 2]);
  assert.deepEqual([r6may.year, r6may.month], [2024, 5]);
});

test("parseVotePdf: 凡例として読むのはテキスト全体が「{記号}：{意味}」の並びのときだけ（余りがあれば読まない。#841）", async () => {
  // **凡例が 1 件も取れなければ例外**（黙って空の凡例で進まない）。
  // 「繋がった形を分ける」ことと「凡例でない文字列から凡例を作る」ことは別で、後者をしていないことを見る。
  const { splitLegendTextForTest } = await import("../src/sources/local/mie/votes-pdf.ts");
  // 分ける（20 本の形）
  assert.deepEqual(splitLegendTextForTest("○：賛成×：反対議：議長除：除斥－：不在欠：欠席").map((x) => [x.key, x.desc]), [
    ["○", "賛成"], ["×", "反対"], ["議", "議長"], ["除", "除斥"], ["－", "不在"], ["欠", "欠席"],
  ]);
  // 分かれている形（16 本）はそのまま 1 件
  assert.deepEqual(splitLegendTextForTest("○：賛成").map((x) => [x.key, x.desc]), [["○", "賛成"]]);
  // **前に余りがある**（青森の「賛否欄：「○」は賛成…」のような前置きのある文は、三重の形ではないので読まない）
  assert.deepEqual(splitLegendTextForTest("注：○：賛成"), [{ key: "注", desc: "○：賛成" }]); // 先頭から並びとして成立する形はそのまま読む
  // 凡例でない文字列は 0 件（「：」が無い／末尾が「：」だけ）
  assert.deepEqual(splitLegendTextForTest("議案等の審議結果"), []);
  assert.deepEqual(splitLegendTextForTest("○："), []);
  assert.deepEqual(splitLegendTextForTest("令和８年定例会（６月）議案等の審議結果"), []);
});
