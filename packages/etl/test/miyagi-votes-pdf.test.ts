import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseVotePdf, UNKNOWN_CELL } from "../src/sources/local/miyagi/votes-pdf.ts";

// 宮城県議会「各議員の表決状況」PDF（Issue #157）。文字層から表を復元する（pdfjs）。
//   第398回（令和7年11月定例会）: https://www.pref.miyagi.jp/documents/62682/hyouketsu071217.pdf（3 ページ、2026-08-23 取得）
//   第399回（令和8年2月定例会）:  https://www.pref.miyagi.jp/documents/63622/syuusei_hyouketsu080318.pdf（5 ページ、同日取得。「修正」版）
// 列 = 議員（縦書き氏名 1 文字ずつ）、行 = 議案。セルは凡例（○×議欠－除棄白）の 1 文字。罫線（矩形）から列・行の境界を取り、
// 文字の中心がどのセルに入るかで置く。置けないセルは UNKNOWN_CELL（推定しない）。
const bytes = (name: string) => readFileSync(new URL(`./fixtures/miyagi/${name}`, import.meta.url));
const pdf398 = await parseVotePdf(bytes("hyouketsu071217.pdf"));
const pdf399 = await parseVotePdf(bytes("syuusei_hyouketsu080318.pdf"));

test("parseVotePdf: 見出しの会期と、その PDF の凡例（賛否・表決方法・会派略称）を原文で取る", () => {
  assert.equal(pdf398.sessionLabel, "第398回宮城県議会（令和7年11月定例会）");
  assert.equal(pdf398.sessionId, "398");
  assert.deepEqual(pdf398.legend.votes, { "○": "賛成", "×": "反対", "議": "議長", "除": "除斥", "欠": "欠席", "－": "議場に不在" });
  assert.deepEqual(pdf398.legend.methods, { "簡易": "簡易表決(異議の有無を諮る)", "起立": "起立採決" });
  assert.deepEqual(pdf398.legend.groups, {
    "自民": "自由民主党・県民会議",
    "公明": "公明党県議団",
    "21世紀ク": "21世紀クラブ",
    "県民の声": "みやぎ県民の声",
    "立無ク": "立憲・無所属クラブ",
    "維新": "日本維新の会",
    "共産": "日本共産党宮城県会議員団",
  });
  // 第399回は凡例が違う（除斥が無く、棄権・白票がある）。PDF ごとに読む
  assert.deepEqual(pdf399.legend.votes, { "○": "賛成", "×": "反対", "議": "議長", "欠": "欠席", "－": "議場に不在", "棄": "棄権", "白": "白票" });
  assert.equal(pdf399.sessionLabel, "第399回宮城県議会（令和8年2月定例会）");
});

test("parseVotePdf: 議員の列（縦書きの氏名）を x 座標で復元し、会派の見出し（結合セル）から会派を付ける", () => {
  assert.equal(pdf398.members.length, 58);
  assert.deepEqual(pdf398.members[0], { nameText: "柚木 貴光", groupText: "自民", group: "自由民主党・県民会議" });
  assert.deepEqual(pdf398.members[2], { nameText: "さとう道昭", groupText: "自民", group: "自由民主党・県民会議" });
  assert.deepEqual(pdf398.members[57], { nameText: "小野寺 健", groupText: "維新", group: "日本維新の会" });
  const groups = new Map<string, number>();
  for (const m of pdf398.members) groups.set(m.group, (groups.get(m.group) ?? 0) + 1);
  assert.deepEqual([...groups.entries()], [
    ["自由民主党・県民会議", 33],
    ["みやぎ県民の声", 9],
    ["日本共産党宮城県会議員団", 5],
    ["公明党県議団", 4],
    ["立憲・無所属クラブ", 3],
    ["21世紀クラブ", 2],
    ["日本維新の会", 2],
  ]);
  assert.equal(pdf399.members.length, 57);
});

test("parseVotePdf: 行（議案）は種別・番号・件名・議決月日・人数・表決方法・議決結果を原文で持ち、ページをまたいで続く", () => {
  assert.equal(pdf398.rows.length, 50);
  const first = pdf398.rows[0];
  assert.equal(first.page, 1);
  assert.equal(first.kind, "発議案");
  assert.equal(first.number, "8");
  assert.equal(first.title, "県議会議員の議員報酬等に関する条例の一部を改正する条例");
  assert.equal(first.dateText, "12/17");
  assert.deepEqual(first.counts, { present: 57, voting: 54, yes: 49, no: 5 });
  assert.equal(first.methodText, "起立");
  assert.equal(first.result, "可決");
  assert.equal(pdf398.rows[1].kind, "意見書案");
  assert.equal(pdf398.rows[1].number, "11");
  assert.equal(pdf398.rows[3].title, "幼児教育の充実及び私立幼稚園・認定こども園への支援拡充を求める意見書");
  assert.equal(pdf398.rows[4].kind, "知事提出議案");
  assert.equal(pdf398.rows[4].number, "132");
  assert.equal(pdf398.rows[23].page, 2);
  assert.equal(pdf398.rows[23].number, "151");
  assert.equal(pdf398.rows[23].kind, "知事提出議案");
  const last = pdf398.rows[49];
  assert.equal(last.page, 3);
  assert.equal(last.kind, "請願");
  assert.equal(last.number, "398の2");
});

test("parseVotePdf: セルは議員数ぶん（議員数×議案数）。第398回 発議案8 は ○49 ×5 議1 欠1 －2", () => {
  const row = pdf398.rows[0];
  assert.equal(row.cells.length, pdf398.members.length);
  const count = (v: string) => row.cells.filter((c) => c === v).length;
  assert.equal(count("○"), 49);
  assert.equal(count("×"), 5);
  assert.equal(count("議"), 1);
  assert.equal(count("欠"), 1);
  assert.equal(count("－"), 2);
  // 議長の列は 1 人に固定（列の復元がずれていない）
  const chair = pdf398.members[row.cells.indexOf("議")];
  assert.equal(chair.nameText, "佐々木幸士");
  assert.equal(pdf398.members[row.cells.indexOf("欠")].nameText, "坂下 賢");
});

test("parseVotePdf: 不変条件 — 全行でセル数＝議員数、○の数＝賛成者数、×の数＝反対者数、不明セル 0（2 会期）", () => {
  for (const pdf of [pdf398, pdf399]) {
    assert.equal(pdf.unknownCells, 0);
    for (const row of pdf.rows) {
      assert.equal(row.cells.length, pdf.members.length, `${row.kind} ${row.number}`);
      assert.equal(row.cells.filter((c) => c === "○").length, row.counts.yes, `${row.kind} ${row.number} yes`);
      assert.equal(row.cells.filter((c) => c === "×").length, row.counts.no, `${row.kind} ${row.number} no`);
      for (const c of row.cells) assert.ok(c === UNKNOWN_CELL || c in pdf.legend.votes, `${row.kind} ${row.number}: ${c}`);
    }
  }
  assert.equal(pdf398.rows.length * pdf398.members.length, pdf398.rows.reduce((n, r) => n + r.cells.length, 0));
});

test("parseVotePdf: 凡例に無い値のセルは例外（丸めない・推定しない）", async () => {
  // フィクスチャには無いので、凡例を差し替えた状態を作るのではなく、parser の検査関数を直接叩く
  const { checkCellsAgainstLegend } = await import("../src/sources/local/miyagi/votes-pdf.ts");
  assert.throws(() => checkCellsAgainstLegend(["○", "△"], { "○": "賛成" }, "発議案 8"), /△/);
  assert.doesNotThrow(() => checkCellsAgainstLegend(["○", UNKNOWN_CELL], { "○": "賛成" }, "発議案 8"));
});
