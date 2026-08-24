import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseResultsPdf, parseVotePdf, UNKNOWN_CELL, UNKNOWN_LEGEND } from "../src/sources/local/shimane/votes-pdf.ts";

// 島根県議会「議員別採決結果一覧」（令和8年6月定例会＝第499回。4 ページ・文字層あり。2026-08-24 取得）と
// 同じ会期ページの「議決結果一覧」（議決日を読むためだけに使う）。
const fixture = (name: string) => readFileSync(new URL(`./fixtures/shimane/${name}`, import.meta.url));
const pdf = await parseVotePdf(fixture("r0806_giinbetu_kekka.pdf"));
const results = await parseResultsPdf(fixture("r0806_giketu_kekka.pdf"));

test("parseVotePdf: 見出し・凡例の原文を残す", () => {
  assert.equal(pdf.title, "第４９９回島根県議会（令和８年６月定例会）採決結果");
  // 凡例は PDF の原文そのまま（○ ● 棄権 － 除斥）
  assert.equal(pdf.legend.get("○"), "賛成");
  assert.equal(pdf.legend.get("●"), "反対");
  assert.equal(pdf.legend.get("棄権"), "棄権");
  assert.equal(pdf.legend.get("－"), "欠席等による不在");
  assert.equal(pdf.legend.get("除斥"), "議案と一定の利害関係を有する議員");
  // 付託委員会欄の「－」の意味と、議長が採決に加わらない旨の注記も原文で残す
  assert.ok(pdf.notes.some((n) => n.includes("付託委員会欄の「－」は、委員会への付託を省略したことを表しています。")));
  assert.ok(pdf.notes.some((n) => n.includes("議⾧の職務を行う者は採決に加わりません")));
});

test("parseVotePdf: 議員 35 人を PDF の列順（縦書きの氏名を上から結合）で読む", () => {
  assert.equal(pdf.members.length, 35);
  assert.deepEqual(pdf.members.slice(0, 3), ["中村絢", "森山裕介", "河内大輔"]);
  assert.equal(pdf.members[21], "山根成二");
  assert.equal(pdf.members[25], "角智子");
  assert.deepEqual(pdf.members.slice(-2), ["福田正明", "成相安信"]);
});

test("parseVotePdf: 30 行（議案 23・請願 3・その他表決 4）。節見出しの原文が kind になる", () => {
  assert.equal(pdf.rows.length, 30);
  const kinds = pdf.rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.kind]: (acc[r.kind] ?? 0) + 1 }), {});
  assert.deepEqual(kinds, { "議案": 23, "請願": 3, "その他表決": 4 });
});

test("parseVotePdf: 付託委員会は捨てず全部（複数付託はそのまま並べる）。付託省略は原文「ー」", () => {
  const r77 = pdf.rows.find((r) => r.number === "第77号")!;
  // 一般会計補正予算は 4 常任委員会すべてに付託されている（1 つに丸めない）
  assert.deepEqual(r77.referredCommittees, ["総務委員会", "防災地域建設委員会", "環境厚生委員会", "農林水産商工委員会"]);
  assert.deepEqual(pdf.rows.find((r) => r.number === "第90号")!.referredCommittees, ["総務委員会", "農林水産商工委員会"]);
  assert.deepEqual(pdf.rows.find((r) => r.number === "承認第3号")!.referredCommittees, ["総務委員会", "防災地域建設委員会", "環境厚生委員会", "農林水産商工委員会"]);
  assert.deepEqual(pdf.rows.find((r) => r.number === "第79号")!.referredCommittees, ["環境厚生委員会"]);
  // 委員会付託を省略した議案（人事同意・議員提出議案）は原文の「ー」だけ（空にしない）
  assert.deepEqual(pdf.rows.find((r) => r.number === "第91号")!.referredCommittees, ["ー"]);
  assert.deepEqual(pdf.rows.find((r) => r.number === "議員提出第5号")!.referredCommittees, ["ー"]);
});

test("parseVotePdf: 採決結果・賛成反対数は PDF の原文（votes から数え直さない）", () => {
  const r77 = pdf.rows.find((r) => r.number === "第77号")!;
  assert.equal(r77.title, "令和８年度島根県一般会計補正予算（第１号）");
  assert.equal(r77.result, "原案可決");
  assert.deepEqual(r77.counts, { yes: 34, no: 0 });
  const r80 = pdf.rows.find((r) => r.number === "第80号")!;
  assert.deepEqual(r80.counts, { yes: 32, no: 2 });
  assert.equal(pdf.rows.find((r) => r.number === "第91号")!.result, "同意");
  assert.equal(pdf.rows.find((r) => r.number === "承認第3号")!.result, "承認");
  // 件名が複数行の議案は行を詰めて 1 つの原文に
  assert.equal(pdf.rows.find((r) => r.number === "第89号")!.title, "契約の締結について《浜田養護学校整備（高等部棟建築）工事》");
});

test("parseVotePdf: 請願の行は採択・不採択の原文。委員長報告に対する賛否である注記も残す", () => {
  const petitions = pdf.rows.filter((r) => r.kind === "請願");
  assert.deepEqual(petitions.map((r) => [r.number, r.result, r.counts]), [
    ["請願第17号", "採択", { yes: 34, no: 0 }],
    ["請願第29号", "採択", { yes: 34, no: 0 }],
    ["請願第30号", "不採択", { yes: 33, no: 1 }],
  ]);
  // ※ の注記（賛否は「付託先委員会の報告」に対するもの）を落とさない
  assert.ok(pdf.notes.some((n) => n.includes("請願を「採択」とした付託先委員会の報告に対する「賛成・反対」")));
  assert.ok(pdf.notes.some((n) => n.includes("請願を「不採択」とした付託先委員会の報告に対する「賛成・反対」")));
});

test("parseVotePdf: その他表決（議長辞職など）は議案番号が原文の「ー」", () => {
  const others = pdf.rows.filter((r) => r.kind === "その他表決");
  assert.deepEqual(others.map((r) => [r.number, r.title, r.result]), [
    ["ー", "議⾧辞職の件（日程追加）", "決定"],
    ["ー", "議⾧辞職の許可", "許可"],
    ["ー", "副議⾧辞職の件（日程追加）", "決定"],
    ["ー", "副議⾧辞職の許可", "許可"],
  ]);
});

test("parseVotePdf: 各行のセルは議員数ぶん。議長の列は「議⾧」の原文（縦書き 2 文字）", () => {
  for (const r of pdf.rows) assert.equal(r.cells.length, pdf.members.length, `${r.number} ${r.title}`);
  const r77 = pdf.rows.find((r) => r.number === "第77号")!;
  // 山根成二（col 21）が議長。空欄ではなく「議⾧」と書かれている
  assert.equal(r77.cells[21], "議⾧");
  assert.equal(r77.cells[0], "○");
  // 反対のある議案（賛成32・反対2 と PDF の数が一致する）
  const r80 = pdf.rows.find((r) => r.number === "第80号")!;
  assert.equal(r80.cells[13], "●");
  assert.equal(r80.cells[27], "●");
  assert.equal(r80.cells.filter((c) => c === "●").length, r80.counts.no);
  assert.equal(r80.cells.filter((c) => c === "○").length, r80.counts.yes);
});

test("parseVotePdf: その他表決は議長が交代している（列 18 と列 21）。除斥の原文も残す", () => {
  const others = pdf.rows.filter((r) => r.kind === "その他表決");
  // 議⾧辞職の件: 山根成二（21）はまだ議長ではなく、岩田浩岳（18）が議長
  assert.equal(others[0].cells[18], "議⾧");
  assert.equal(others[0].cells[23], "除斥");
  // 副議⾧辞職の件では 21 が議長に
  assert.equal(others[2].cells[21], "議⾧");
  assert.equal(others[2].cells[18], "除斥");
});

test("parseVotePdf: 全 30 行で ○ ● の数が PDF の賛成者数・反対者数と一致する（表の復元が正しいことの検算）", () => {
  for (const r of pdf.rows) {
    assert.equal(r.cells.filter((c) => c === "○").length, r.counts.yes, `${r.number} ${r.title}: 賛成`);
    assert.equal(r.cells.filter((c) => c === "●").length, r.counts.no, `${r.number} ${r.title}: 反対`);
  }
});

test("parseVotePdf: 凡例に無い値は 1 つも無い（あれば不明セルとして数える）", () => {
  const known = new Set([...pdf.legend.keys(), "議⾧"]);
  const unknown = new Set<string>();
  for (const r of pdf.rows) for (const c of r.cells) if (!known.has(c)) unknown.add(c);
  assert.deepEqual([...unknown], []);
  assert.equal(pdf.unknownCells, 0);
});

test("parseVotePdf: 置けないセルは「不明」（抽出不能）として残し、推定しない", () => {
  // 不明セルの表現が凡例つきで決まっている（rollcalls.ts が mapped を付けない目印にする）
  assert.equal(UNKNOWN_CELL, "不明");
  assert.equal(UNKNOWN_LEGEND, "抽出不能");
});

test("parseResultsPdf（議決結果一覧）: 議案番号ごとの議決日を読む。採決結果は議員別 PDF と一致する", () => {
  assert.equal(results.get("第77号")?.date, "2026-07-02");
  assert.equal(results.get("第77号")?.result, "原案可決");
  assert.equal(results.get("承認第3号")?.date, "2026-07-02");
  assert.equal(results.get("承認第3号")?.result, "承認");
  assert.equal(results.get("議員提出第5号")?.date, "2026-07-02");
  assert.equal(results.get("第92号")?.result, "同意");
  // 議案（知事提出・承認・議員提出）23 件ぶん
  assert.equal(results.size, 23);
  // 議員別 PDF の議案の行は、すべて議決結果一覧に載っている（結果も一致）
  for (const r of pdf.rows.filter((r) => r.kind === "議案")) {
    const hit = results.get(r.number);
    assert.ok(hit, `${r.number} not in 議決結果一覧`);
    assert.equal(hit!.result, r.result, r.number);
  }
});
