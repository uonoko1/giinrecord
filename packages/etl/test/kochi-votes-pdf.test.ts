import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseVotePdf, UNKNOWN_CELL, checkCellsAgainstLegend } from "../src/sources/local/kochi/votes-pdf.ts";

// 高知県議会「議員別賛否の状況」の会期 PDF（Issue #220。2026-08-24 取得）。文字層から表を復元する（pdfjs、共通部は pdf-table.ts）。
//   令和8年6月定例会: /_files/00156424/0806.pdf（2 ページ、36 名）
//   令和7年6月定例会: /_files/00141109/0706.pdf（2 ページ、36 名）
// 表: 左から 議案種別（縦書きの結合セル）・番号・件名・議決年月日・議決結果・議員の列（上段に会派の結合セル、下に縦書きの氏名）・賛成者数・反対者数。
// 凡例は最終ページの表の下の「・議決結果の見方」の行。
const bytes = (name: string) => readFileSync(new URL(`./fixtures/kochi/${name}`, import.meta.url));
const june8 = await parseVotePdf(bytes("0806.pdf"));
const june7 = await parseVotePdf(bytes("0706.pdf"));

test("parseVotePdf: 表題の会期を原文で取る", () => {
  assert.equal(june8.title, "令和８年６月定例会議決結果一覧表");
  assert.equal(june8.sessionLabel, "令和８年６月定例会");
  assert.equal(june8.year, 2026);
  assert.equal(june8.month, 6);
  assert.equal(june7.sessionLabel, "令和７年６月定例会");
  assert.equal(june7.year, 2025);
});

test("parseVotePdf: 凡例（議決結果の見方）を原文どおりに取る", () => {
  // 「○・・賛成、×・・反対、議・・議長、副・・副議長が議長の職務を代理、欠・・欠席、除・・除斥、－・・議場に不在であった議員」
  assert.deepEqual(june8.legend.votes, {
    "○": "賛成",
    "×": "反対",
    "議": "議長",
    "副": "副議長が議長の職務を代理",
    "欠": "欠席",
    "除": "除斥",
    "－": "議場に不在であった議員",
  });
  assert.deepEqual(june7.legend.votes, june8.legend.votes);
  // 凡例の但し書き（表決権・裁決権）も原文のまま残す（丸めない）
  assert.ok(june8.legend.notes.some((n) => n.includes("可否同数の場合に決定する権利（裁決権）があります")));
});

test("parseVotePdf: 議員の列（縦書きの氏名）と会派の結合セル", () => {
  assert.equal(june8.members.length, 36);
  assert.deepEqual(june8.members[0], { nameText: "浜口卓也", group: "自由民主党" });
  assert.deepEqual(june8.members[35], { nameText: "塚地佐智", group: "日本共産党" });
  // 会派ごとの人数（PDF の会派見出しの結合セルから）
  const groups = new Map<string, number>();
  for (const m of june8.members) groups.set(m.group, (groups.get(m.group) ?? 0) + 1);
  assert.deepEqual([...groups.entries()], [
    ["自由民主党", 20], ["一燈立志の会", 2], ["公明党", 3], ["自由の風", 1], ["県民の会", 4], ["日本共産党", 6],
  ]);
});

test("parseVotePdf: 行（議案）。種別（結合セル）・番号・件名・議決年月日・結果と各議員のセル", () => {
  const first = june8.rows[0];
  assert.equal(first.kind, "知事提出議案");
  assert.equal(first.number, "第1号");
  assert.equal(first.title, "令和８年度高知県一般会計予算");
  assert.equal(first.dateText, "R8.7.10");
  assert.equal(first.result, "原案可決");
  assert.equal(first.cells.length, 36);
  // 先頭行: 自民〜県民の会が○、議長（19 列目）は「議」、共産 6 名が×
  assert.equal(first.cells[0], "○");
  assert.equal(first.cells[18], "議");
  assert.deepEqual(first.cells.slice(30), ["×", "×", "×", "×", "×", "×"]);
  assert.equal(first.counts?.yes, 29);
  assert.equal(first.counts?.no, 6);
});

test("parseVotePdf: 「〃」（同上）は原文のまま残す（前の行の値で埋めない）", () => {
  const dittos = june8.rows.filter((r) => r.dateText === "〃");
  assert.ok(dittos.length > 0, "「〃」の行があること");
});

test("parseVotePdf: 議員提出議案の行も種別（結合セル）から取る", () => {
  const giin = june8.rows.filter((r) => r.kind === "議員提出議案");
  assert.ok(giin.length > 0);
  const last = june8.rows[june8.rows.length - 1];
  assert.equal(last.kind, "議員提出議案");
  assert.equal(last.number, "議発第12号");
  assert.equal(last.result, "否決");
  assert.equal(last.counts?.yes, 10);
  assert.equal(last.counts?.no, 25);
});

test("parseVotePdf: 凡例に無い値が出たら例外（丸めない）", () => {
  assert.throws(() => checkCellsAgainstLegend(["○", "△"], june8.legend.votes, "test"), /not in the legend/);
  // UNKNOWN_CELL は通す
  assert.doesNotThrow(() => checkCellsAgainstLegend(["○", UNKNOWN_CELL], june8.legend.votes, "test"));
});

test("parseVotePdf: すべてのセルが凡例の値か不明のどちらか。ページごとの議員の並びは同じ", () => {
  for (const pdf of [june8, june7]) {
    assert.ok(pdf.rows.length > 0);
    for (const row of pdf.rows) {
      assert.equal(row.cells.length, pdf.members.length);
      for (const c of row.cells) assert.ok(c === UNKNOWN_CELL || c in pdf.legend.votes, `cell ${c}`);
    }
    // 2 ページにまたがる（ヘッダは各ページで繰り返される）
    assert.deepEqual([...new Set(pdf.rows.map((r) => r.page))], [1, 2]);
  }
});
