import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseVotePdf, UNKNOWN_CELL, checkCellsAgainstLegend } from "../src/sources/local/nara/votes-pdf.ts";

// 奈良県議会「議員別の議案等に対する表決結果」PDF（Issue #202。2026-08-24 取得）。文字層から表を復元する（pdfjs、共通部は pdf-table.ts）。
//   令和8年6月定例会 7月2日議決分: /documents/24098/20260702_giinbetsu_hyoketsu.pdf（2 ページ、37 行 × 40 名）
//   令和8年2月定例会 3月25日議決分: /documents/21459/20260325_giinbetsu_hyoketsu.pdf（3 ページ、88 行 × 40 名）
// 表: 左から 種別（縦書きの結合セル）・議案等名（議第56号 …）・議決結果・議員の列（上段に会派、下に縦書きの氏名）。
// 「＜令和8年度議案＞」の行は年度の区切りで表決の行ではない。凡例は最終ページの表の下の「賛否等欄：…」。
const bytes = (name: string) => readFileSync(new URL(`./fixtures/nara/${name}`, import.meta.url));
const june = await parseVotePdf(bytes("20260702_giinbetsu_hyoketsu.pdf"));
const feb = await parseVotePdf(bytes("20260325_giinbetsu_hyoketsu.pdf"));

test("parseVotePdf: 見出しの会期と議決日（ISO）、凡例（賛否等欄）を原文で取る", () => {
  assert.equal(june.sessionLabel, "令和8年6月定例会");
  assert.equal(june.date, "2026-07-02");
  assert.equal(feb.sessionLabel, "令和8年2月定例会");
  assert.equal(feb.date, "2026-03-25");
  assert.deepEqual(june.legend.votes, {
    "○": "賛成",
    "×": "反対（起立採決において、起立しなかった議員）",
    "議": "議長",
    "副": "副議長が議長職務を代行した場合",
    "除": "除斥",
    "欠": "欠席",
    "退": "表決を棄権",
    "―": "不在（除斥、欠席及び表決を棄権した場合を除く）",
  });
  assert.deepEqual(feb.legend.votes, june.legend.votes);
});

test("parseVotePdf: 議員の列（縦書きの氏名）と会派の結合セル。並びは PDF ごとに読む（2月と 6月で違う）", () => {
  assert.equal(june.members.length, 40);
  assert.deepEqual(june.members[0], { nameText: "永田恒", group: "自由民主党・無所属の会" });
  assert.deepEqual(june.members[39], { nameText: "森山賀文", group: "無所属" });
  const juneGroups = new Map<string, number>();
  for (const m of june.members) juneGroups.set(m.group, (juneGroups.get(m.group) ?? 0) + 1);
  assert.deepEqual([...juneGroups.entries()], [
    ["自由民主党・無所属の会", 15], ["日本維新の会", 11], ["自由民主党", 7], ["公明党", 3], ["改新なら", 2], ["日本共産党", 1], ["無所属", 1],
  ]);
  // 2月分は 改新なら が無く 立憲民主党 がある（表決時点の会派の事実。名簿と食い違っても PDF の原文を残す）。列の並びも違う
  assert.equal(feb.members.length, 40);
  const febGroups = new Map<string, number>();
  for (const m of feb.members) febGroups.set(m.group, (febGroups.get(m.group) ?? 0) + 1);
  assert.deepEqual([...febGroups.entries()], [
    ["自由民主党・無所属の会", 15], ["日本維新の会", 11], ["自由民主党", 7], ["公明党", 3], ["日本共産党", 1], ["無所属", 2], ["立憲民主党", 1],
  ]);
  assert.deepEqual(feb.members.slice(-2), [{ nameText: "藤野良次", group: "立憲民主党" }, { nameText: "阪口保", group: "無所属" }]);
  // 文字層に落ちる字はそのまま（推定で補わない）: 「芦髙清友」は 6月分では「髙清友」（外字「芦」が無い）、
  // 2月分では「芦󠄀髙清友」（異体字セレクタ付き）。「西川均」は両方で「西川」（「均」が無い）
  assert.equal(june.members[2].nameText, "髙清友");
  assert.equal(feb.members[2].nameText, "芦\u{E0100}髙清友");
  assert.equal(june.members[9].nameText, "西川");
  assert.equal(feb.members[9].nameText, "西川");
});

test("parseVotePdf: 行（議案等）。種別（結合セル）・番号（NFKC）・件名・議決結果と各議員のセル。年度の区切り行は行にしない", () => {
  assert.equal(june.rows.length, 37);
  assert.equal(feb.rows.length, 88);
  assert.deepEqual([...new Set(june.rows.map((r) => r.page))], [1, 2]);
  assert.deepEqual([...new Set(feb.rows.map((r) => r.page))], [1, 2, 3]);
  const first = june.rows[0];
  assert.equal(first.kind, "知事提出議案");
  assert.equal(first.number, "議第56号");
  assert.equal(first.title, "令和８年度奈良県一般会計補正予算（第１号）");
  assert.equal(first.result, "原案可決");
  assert.equal(first.cells.length, 40);
  // 2 行に折り返した件名は 1 つにつながる
  assert.equal(june.rows.find((r) => r.number === "議第61号")!.title, "奈良県幼保連携型認定こども園の学級の編制、職員、設備及び運営の基準に関する条例等の一部を改正する条例");
  // 種別ごとの行数（6月: 知事提出議案 35・意見書 2 / 2月: 知事提出議案 81・議員提出議案 3・決議 1・意見書 3）
  const count = (rows: { kind: string }[]) => [...rows.reduce((m, r) => m.set(r.kind, (m.get(r.kind) ?? 0) + 1), new Map<string, number>())];
  assert.deepEqual(count(june.rows), [["知事提出議案", 35], ["意見書", 2]]);
  assert.deepEqual(count(feb.rows), [["知事提出議案", 81], ["議員提出議案", 3], ["決議", 1], ["意見書", 3]]);
  // 同じ番号でも種別が違う（2月: 議第112号 は議員提出議案、議第108号 は知事提出議案）
  assert.equal(feb.rows.find((r) => r.number === "議第112号")!.kind, "議員提出議案");
  assert.equal(feb.rows.find((r) => r.number === "議第108号")!.kind, "知事提出議案");
  assert.deepEqual(feb.rows.filter((r) => r.kind === "決議").map((r) => [r.number, r.result]), [["第1号", "原案可決"]]);
});

test("parseVotePdf: 専決処分の報告の行は内訳の小行ごと 1 行（小行の罫線は行の境界にしない）。議決結果は 2 段（報告受理・原案承認）もつながる", () => {
  const rep19 = june.rows.find((r) => r.number === "報第19号")!;
  assert.equal(rep19.result, "原案承認");
  assert.ok(rep19.title.startsWith("地方自治法第179条第１項の規定による専決処分の報告について"));
  assert.ok(rep19.title.includes("奈良県税条例の一部を改正する条例"));
  const rep37 = feb.rows.find((r) => r.number === "報第37号")!;
  assert.equal(rep37.result, "報告受理");
  assert.equal(rep37.cells.filter((c) => c === "○").length, 37);
  assert.equal(rep37.cells.filter((c) => c === "欠").length, 2);
  assert.equal(rep37.cells.filter((c) => c === "議").length, 1);
});

test("parseVotePdf: セルは凡例の 1 文字だけ。不明セル 0（このフィクスチャ）。凡例に無い値は例外", () => {
  assert.equal(june.unknownCells, 0);
  assert.equal(feb.unknownCells, 0);
  // 6月 議第69号（監査委員の選任）: 佐藤光紀・斎藤有紀 が除斥。この行の議長席は 乾浩之（議席の 議 は行ごとに読む。推定しない）
  const kansa = june.rows.find((r) => r.number === "議第69号")!;
  const cellOf = (pdf: typeof june, row: typeof kansa, name: string) => row.cells[pdf.members.findIndex((m) => m.nameText === name)];
  assert.equal(cellOf(june, kansa, "佐藤光紀"), "除");
  assert.equal(cellOf(june, kansa, "斎藤有紀"), "除");
  assert.equal(cellOf(june, kansa, "乾浩之"), "議");
  assert.equal(cellOf(june, kansa, "田中惟允"), "○");
  // 同じ PDF でも他の行では 田中惟允 が 議
  assert.equal(cellOf(june, june.rows.find((r) => r.number === "議第56号")!, "田中惟允"), "議");
  // 6月 意見書第5号: 日本維新の会の 11 名が 退（表決を棄権）
  const iken5 = june.rows.find((r) => r.kind === "意見書" && r.number === "第5号")!;
  const taiseki = iken5.cells.map((c, i) => (c === "退" ? june.members[i] : undefined)).filter((m) => m !== undefined);
  assert.equal(taiseki.length, 11);
  assert.ok(taiseki.every((m) => m.group === "日本維新の会"));
  // 2月: 山本進章・阪口保 は全行 欠（88 行 × 2 = 176 セル）
  const absent = new Set(feb.rows.flatMap((r) => r.cells.flatMap((c, i) => (c === "欠" ? [feb.members[i].nameText] : []))));
  assert.deepEqual([...absent].sort(), ["山本進章", "阪口保"].sort());
  assert.equal(feb.rows.reduce((n, r) => n + r.cells.filter((c) => c === "欠").length, 0), 176);
  assert.throws(() => checkCellsAgainstLegend(["◎"], june.legend.votes, "x"), /not in the legend/);
  assert.doesNotThrow(() => checkCellsAgainstLegend([UNKNOWN_CELL, "○"], june.legend.votes, "x"));
});
