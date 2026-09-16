import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkTitleOffset, parseResultsPdf, parseVotePdf, splitTitleCells, UNKNOWN_CELL, UNKNOWN_LEGEND } from "../src/sources/local/shimane/votes-pdf.ts";
import type { Item } from "../src/sources/local/pdf-table.ts";
import { normalizeTitle } from "../src/sources/local/title-normalize.ts";
// **食い違った行を全部並べる**（#826 で佐賀に作り、#844 で 5 県が使う 1 か所に移した）。
// **島根の反対は `●`**（`×` ではない）——#826 の担当者は `×` で数えて 17 件の偽の不一致を出している。
import { countMismatchRows } from "./count-mismatch-rows.ts";

// 島根県議会「議員別採決結果一覧」（令和8年6月定例会＝第499回。4 ページ・文字層あり。2026-08-24 取得）と
// 同じ会期ページの「議決結果一覧」（議決日を読むためだけに使う）。
const fixture = (name: string) => readFileSync(new URL(`./fixtures/shimane/${name}`, import.meta.url));
const pdf = await parseVotePdf(fixture("r0806_giinbetu_kekka.pdf"));
const results = await parseResultsPdf(fixture("r0806_giketu_kekka.pdf"));

// 令和8年2月定例会（＝第498回。5 ページ。2026-08-24 取得）。同じ議会でも会期ごとに PDF の作りが違うので
// 2 会期ぶんのフィクスチャで確かめる（本番はこの会期で落ちていた。Issue #221 の後、#232）。6月との違いは:
//   - 節見出し「（議案）」「（請願）」「（その他表決）」が 1 つも無く、全部が「議案番号」の 1 つの表
//   - 表全体が右に寄って少し広い（列の x が 6月と違う）
//   - 議案番号と件名、件名と付託委員会が 1 つの文字列になっている行がある
const feb = await parseVotePdf(fixture("r0802_giinbetu_kekka.pdf"));
const febResults = await parseResultsPdf(fixture("r0802_giketu_kekka.pdf"));

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

/**
 * **○ の数 ＝ 賛成者数 / ● の数 ＝ 反対者数**（表の復元が正しいことの検算）。
 *
 * **島根の反対は `●` であって `×` ではない**——**#826 の担当者は本番の全票を `○`/`×` で数えて
 * 島根に 17 件の「不一致」を出し、`●` だと気づいて数え直している。**
 *
 * **食い違った行を全部並べて比べる**（#826／#844）——**`assert.equal` を行ごとに撃つと最初の 1 行で止まり、**
 * **「1 行だけ数え方が違う」のか「表の復元が壊れて 26 行ずれた」のかが読めない**
 * （**前者は記録が正しく、後者は記録が偽なのに、どちらも「テストが赤い」では同じに見える**）。
 * **検算は緩めていない——食い違いが 1 行でもあれば落ちる。**
 */
test("令和8年6月: 全 30 行で ○ ● の数が PDF の賛成者数・反対者数と一致する（食い違いは全部並べる）", () => {
  const { mismatches, checked } = countMismatchRows(pdf.rows, { yes: "○", no: "●", cells: (r) => r.cells, label: (r) => `${r.number} ${r.title}` });
  // **母数を先に固定する**（#757）——**突き合わせた行が減ったら、「食い違い 0 件」は「見た上での 0」ではない**
  assert.equal(checked, 30, "30 行とも突き合わせた（母数が減ったらこの検算は空回りする）");
  assert.deepEqual(mismatches, []);
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

/* ---------- 令和8年2月定例会（第498回）。会期ごとの PDF の作りの違いに耐えること ---------- */

test("令和8年2月: 見出し・凡例の原文を残す（6月と同じ凡例）", () => {
  assert.equal(feb.title, "第４９８回島根県議会（令和８年２月定例会）採決結果");
  assert.equal(feb.legend.get("○"), "賛成");
  assert.equal(feb.legend.get("●"), "反対");
  assert.equal(feb.legend.get("棄権"), "棄権");
  assert.equal(feb.legend.get("－"), "欠席等による不在");
  assert.equal(feb.legend.get("除斥"), "議案と一定の利害関係を有する議員");
  assert.ok(feb.notes.some((n) => n.includes("付託委員会欄の「－」は、委員会への付託を省略したことを表しています。")));
  assert.ok(feb.notes.some((n) => n.includes("議⾧の職務を行う者は採決に加わりません")));
  // 請願の賛否は付託先委員会の報告に対するもの、という注記（6月と同じ趣旨で号数だけ違う）
  assert.ok(feb.notes.some((n) => n.includes("※請願第28号の「賛成・反対」は、請願を「不採択」とした付託先委員会の報告に対する「賛成・反対」")));
});

test("令和8年2月: 議員 35 人。列の並びは 6月と同じ（表の幅・位置が違っても氏名の列を取り違えない）", () => {
  assert.equal(feb.members.length, 35);
  assert.deepEqual(feb.members, pdf.members);
  // 名指しで固定する（件数だけでは列ずれを見つけられない）
  assert.equal(feb.members[13], "大国陽介");
  assert.equal(feb.members[21], "山根成二");
  assert.equal(feb.members[23], "池田一");
  assert.equal(feb.members[27], "尾村利成");
  assert.equal(feb.members[33], "福田正明");
  assert.equal(feb.members[34], "成相安信");
});

test("令和8年2月: 節見出しが 1 つも無い PDF。kind は「議案番号」のヘッダの語と、番号自身が名乗る種別から", () => {
  assert.equal(feb.rows.length, 82);
  const kinds = feb.rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.kind]: (acc[r.kind] ?? 0) + 1 }), {});
  // 「議案番号」の表なので議案。「請願第28号」だけは番号自身が請願と名乗っている
  assert.deepEqual(kinds, { "議案": 81, "請願": 1 });
  assert.equal(feb.rows.find((r) => r.number === "請願第28号")!.kind, "請願");
  assert.equal(feb.rows.find((r) => r.number === "承認第１号")!.kind, "議案");
  assert.equal(feb.rows.find((r) => r.number === "議員提出第2号")!.kind, "議案");
});

test("令和8年2月: 議案番号と件名が 1 つの文字列で書かれている行を切り分ける（「議 員 提 出 第 2 号 島根県議会…」）", () => {
  const r2 = feb.rows.find((r) => r.number === "議員提出第2号")!;
  assert.equal(r2.title, "島根県議会委員会条例の一部を改正する条例");
  const r3 = feb.rows.find((r) => r.number === "議員提出第3号")!;
  assert.equal(r3.title, "放課後児童クラブの充実を求める意見書");
  // 番号だけで欄から少しはみ出す行は切らない（「請願第28号」「承認第１号」）
  assert.ok(feb.rows.some((r) => r.number === "請願第28号"));
  assert.equal(feb.rows.find((r) => r.number === "承認第１号")!.title, "専決処分事件の報告及び承認について《令和７年度島根県一般会計補正予算（第9号）》");
});

test("令和8年2月: 件名と付託委員会が 1 つの文字列で書かれている行を切り分ける（第27号）", () => {
  const r27 = feb.rows.find((r) => r.number === "第27号")!;
  assert.equal(r27.title, "非常勤の職員等の報酬及び費用弁償支給条例等の一部を改正する条例");
  assert.deepEqual(r27.referredCommittees, ["総務委員会"]);
});

test("令和8年2月: 付託委員会は捨てず全部。付託省略は原文「ー」", () => {
  assert.deepEqual(feb.rows.find((r) => r.number === "第1号")!.referredCommittees, ["総務委員会", "防災地域建設委員会", "環境厚生委員会", "農林水産商工委員会"]);
  assert.deepEqual(feb.rows.find((r) => r.number === "承認第１号")!.referredCommittees, ["総務委員会", "防災地域建設委員会", "環境厚生委員会", "農林水産商工委員会"]);
  assert.deepEqual(feb.rows.find((r) => r.number === "第8号")!.referredCommittees, ["環境厚生委員会"]);
  assert.deepEqual(feb.rows.find((r) => r.number === "第76号")!.referredCommittees, ["ー"]);
  assert.deepEqual(feb.rows.find((r) => r.number === "議員提出第3号")!.referredCommittees, ["ー"]);
  // 全 82 行に付託委員会の原文がある（空にしない）
  for (const r of feb.rows) assert.ok(r.referredCommittees.length > 0, r.number);
});

test("令和8年2月: 採決結果・賛成反対数は PDF の原文", () => {
  assert.equal(feb.rows.find((r) => r.number === "第1号")!.result, "原案可決");
  assert.deepEqual(feb.rows.find((r) => r.number === "第1号")!.counts, { yes: 33, no: 0 });
  assert.equal(feb.rows.find((r) => r.number === "第76号")!.result, "同意");
  assert.deepEqual(feb.rows.find((r) => r.number === "第76号")!.counts, { yes: 34, no: 0 });
  assert.equal(feb.rows.find((r) => r.number === "承認第１号")!.result, "承認");
  assert.equal(feb.rows.find((r) => r.number === "請願第28号")!.result, "不採択");
  assert.deepEqual(feb.rows.find((r) => r.number === "請願第28号")!.counts, { yes: 32, no: 1 });
  // 件名が複数行の議案は行を詰めて 1 つの原文に
  assert.equal(feb.rows.find((r) => r.number === "第51号")!.title, "契約の締結について《国道431号（森山西工区）防安交付金（改築）（仮称）森山トンネル工事》");
});

test("令和8年2月: 各行のセルは議員数ぶん。議長は池田一（列 23。6月の山根成二とは別の人）", () => {
  for (const r of feb.rows) assert.equal(r.cells.length, feb.members.length, `${r.number} ${r.title}`);
  // 「どの議員がどの値か」を名指しで固定する。列が 1 つでもずれればここが落ちる
  const r1 = feb.rows.find((r) => r.number === "第1号")!;
  assert.equal(r1.cells[23], "議⾧");
  assert.equal(feb.members[23], "池田一");
  assert.equal(r1.cells[33], "－");
  assert.equal(feb.members[33], "福田正明");
  assert.equal(r1.cells[0], "○");
  assert.equal(r1.cells[34], "○");
  // 議長は全 82 行で池田一（会期を通じて交代していない。6月は途中で交代していた）
  for (const r of feb.rows) assert.equal(r.cells[23], "議⾧", r.number);
});

test("令和8年2月: 反対した議員を名指しで固定する（第3号は 大国陽介・尾村利成・成相安信）", () => {
  const r3 = feb.rows.find((r) => r.number === "第3号")!;
  assert.deepEqual(r3.counts, { yes: 30, no: 3 });
  assert.equal(r3.cells[13], "●");
  assert.equal(r3.cells[27], "●");
  assert.equal(r3.cells[34], "●");
  assert.deepEqual(r3.cells.flatMap((c, i) => (c === "●" ? [feb.members[i]] : [])), ["大国陽介", "尾村利成", "成相安信"]);
  // 賛成に回った隣の列（列ずれなら ○ と ● が入れ替わる）
  assert.equal(r3.cells[12], "○");
  assert.equal(r3.cells[14], "○");
  assert.equal(r3.cells[26], "○");
  assert.equal(r3.cells[28], "○");
  // 請願第28号に反対したのは成相安信ひとり
  const p = feb.rows.find((r) => r.number === "請願第28号")!;
  assert.deepEqual(p.cells.flatMap((c, i) => (c === "●" ? [feb.members[i]] : [])), ["成相安信"]);
  // 大国陽介が反対した議案（列の取り違えがあれば人が変わる）
  assert.deepEqual(
    feb.rows.filter((r) => r.cells[13] === "●").map((r) => r.number),
    ["第3号", "第9号", "第17号", "第20号", "第21号", "第34号", "第38号"],
  );
});

/** **上の 6月定と同じ検算を 2月定にも**（食い違った行を全部並べる。#844）。 */
test("令和8年2月: 全 82 行で ○ ● の数が PDF の賛成者数・反対者数と一致する（食い違いは全部並べる）", () => {
  const { mismatches, checked } = countMismatchRows(feb.rows, { yes: "○", no: "●", cells: (r) => r.cells, label: (r) => `${r.number} ${r.title}` });
  assert.equal(checked, 82, "82 行とも突き合わせた（母数が減ったらこの検算は空回りする）");
  assert.deepEqual(mismatches, []);
});

test("令和8年2月: 凡例に無い値は 1 つも無い。不明セルも無い", () => {
  const known = new Set([...feb.legend.keys(), "議⾧"]);
  const unknown = new Set<string>();
  for (const r of feb.rows) for (const c of r.cells) if (!known.has(c)) unknown.add(c);
  assert.deepEqual([...unknown], []);
  assert.equal(feb.unknownCells, 0);
});

test("令和8年2月 parseResultsPdf: 議決日は 3月12日。議案の行は全部 議決結果一覧に載っていて結果も一致する", () => {
  assert.equal(febResults.size, 81);
  assert.equal(febResults.get("第1号")?.date, "2026-03-12");
  assert.equal(febResults.get("第1号")?.result, "原案可決");
  assert.equal(febResults.get("承認第1号")?.result, "承認");
  assert.equal(febResults.get("第76号")?.result, "同意");
  // 議員別 PDF は「承認第１号」（全角）、議決結果一覧は「承認第1号」（半角）。突き合わせは NFKC で寄せる
  const byNumber = new Map([...febResults].map(([n, r]) => [n.normalize("NFKC"), r] as const));
  for (const r of feb.rows.filter((r) => r.kind === "議案")) {
    const hit = byNumber.get(r.number.normalize("NFKC"));
    assert.ok(hit, `${r.number} not in 議決結果一覧`);
    assert.equal(hit!.result, r.result, r.number);
  }
});

/**
 * **件名の欄が縦に高い行（請願の本文が丸ごと件名として書かれている行）を、上下の行に漏らさない**（Issue #866）。
 *
 * **一次資料に何が書いてあるか**（`r0802_giinbetu_kekka.pdf` 5 ページ目 / `r0806_giinbetu_kekka.pdf` 3 ページ目。
 * 実測は下の `#866` のテストが数字で押さえる）:
 *   - この PDF には**罫線が 1 本も無い**（`readPages` の `hlines`/`vlines` がどのページも 0 本）。
 *     行の区切りは「議案番号の欄の y」だけで、**行の上下の端はどこにも描かれていない。**
 *   - 件名のセルは**行の中心に揃えて**書かれている（付託委員会の欄と同じ）。
 *     請願の本文が件名になっている行は 20 行を超える高さになり、**上下の行の議案番号より外まで伸びる。**
 * 直す前は件名を**1 行ずつ**「y が一番近い議案番号」に入れていたので、
 * 高いセルの上端の数行が上の議案へ、下端の数行が下の議案へこぼれていた。
 */
test("#866 一次資料: 件名の高いセルが上下の議案に漏れない（承認第２号・請願第28号・議員提出第1号）", () => {
  // 令和8年2月 5 ページ目。承認第２号の件名は《…》で閉じて終わる（後ろに請願の本文が続かない）
  assert.equal(
    feb.rows.find((r) => r.number === "承認第２号")!.title,
    "専決処分事件の報告及び承認について《令和７年度島根県中小企業制度融資等特別会計補正予算（第１号）》",
  );
  // 請願第28号の件名は請願の本文そのもの。PDF の 21 行ぶんが 1 つのセル。
  // **先頭は「島根県議会が平成25年…」で、途中（「して最も多かったのが、…」）から始まらない**
  const p28 = feb.rows.find((r) => r.number === "請願第28号")!;
  assert.ok(p28.title.startsWith("島根県議会が平成25年6月26日付で可決採択された"), p28.title.slice(0, 40));
  assert.ok(p28.title.endsWith("とする決議を求めます。"), p28.title.slice(-20));
  // 議員提出第1号の件名は条例名 1 つだけ（請願の本文が前に付かない）
  assert.equal(
    feb.rows.find((r) => r.number === "議員提出第1号")!.title,
    "議会の議員の議員報酬、費用弁償及び期末手当支給条例の一部を改正する条例",
  );
});

test("#866 一次資料: 令和8年6月 3 ページ目も同じ（請願第29号・請願第30号）", () => {
  // 請願第29号の件名は「「地方財政の充実・強化を求める」請願」の 1 行だけ
  assert.equal(pdf.rows.find((r) => r.number === "請願第29号")!.title, "「地方財政の充実・強化を求める」請願");
  // 請願第30号の件名が本文 20 行ぶん。**先頭は「平成25年6月議会で…」**（途中から始まらない）
  const p30 = pdf.rows.find((r) => r.number === "請願第30号")!;
  assert.ok(p30.title.startsWith("平成25年6月議会で島根県議会が採択された請願は"), p30.title.slice(0, 40));
  assert.ok(p30.title.endsWith("とする決議を求めます。"), p30.title.slice(-20));
});

/**
 * **件名のセルが行の中心に揃っていることを、全行ぶん数字で押さえる**（Issue #866）。
 * **母数（何行見たか）をこのテストの中で確かめる**ので、「違反 0 件」と「1 行も見ていない」が区別できる（#757）。
 * **字数の上限では見ない**——68 字 1 セル（第39号）も 480 字 1 セル（請願第30号）も一次資料のとおりで、
 * **字数は壊れの機序ではない。**
 */
test("#866 件名のセルの中心は行の中心にある（112 行ぜんぶ測る。母数も固定する）", () => {
  const rows = [...feb.rows, ...pdf.rows];
  // **母数**: 令和8年2月 82 行 ＋ 令和8年6月 30 行 = 112 行。行が減ったらここで落ちる
  assert.equal(feb.rows.length, 82);
  assert.equal(pdf.rows.length, 30);
  assert.equal(rows.length, 112);
  // 全行に titleOffset がある（undefined を「ずれ 0」と読まない）
  assert.equal(rows.filter((r) => typeof r.titleOffset === "number").length, 112);
  const offsets = rows.map((r) => Math.abs(r.titleOffset)).sort((a, b) => b - a);
  // **実測（2026-09-14）**: 一番大きいのが請願第30号の 5.16pt（件名が 21 行の請願本文そのもの）。
  // 残り 111 行は 0.30pt 以下。壊れていたときの値は ±27pt だった（MAX_TITLE_OFFSET の注記を見よ）
  assert.ok(offsets[0] < 5.2 && offsets[0] > 5.1, `max offset ${offsets[0]}`);
  assert.equal(rows.filter((r) => Math.abs(r.titleOffset) > 1).length, 1);
  assert.ok(offsets[1] <= 0.3, `second largest ${offsets[1]}`);
  // 件名が 1 文字も落ちていない: 件名の字数の合計を固定する（行の取り合いで増減すれば落ちる）
  assert.equal(feb.rows.reduce((n, r) => n + [...r.title].length, 0), 2612);
  assert.equal(pdf.rows.reduce((n, r) => n + [...r.title].length, 0), 1205);
});

/**
 * ## **本番 `data/assemblies/pref-32/` の件名が、一次資料の PDF と 1 字も違わない**（Issue #866）
 *
 * **上の 3 本は PDF を読む側を見ている。ここは「書いたもの」を PDF と突き合わせる。**
 * **#866 で直したのは `data/` に出ている件名なので、`data/` を読み直さなければ直ったことにならない。**
 *
 * **突き合わせの鍵は `sessionId` + `number` ではなく、会期ごとの「PDF の行の並び」である**——
 * **島根の「その他表決」4 件は番号が原文の `ー` で、番号では 1 つに潰れる**（実測: 番号で引くと
 * 112 行が 109 通りにしかならない）。**PDF の行順と `data/` の並びを、そのまま 1 対 1 で突き合わせる。**
 *
 * **`title` の中身は一次資料が決める。** 請願第28号・請願第30号の件名は**請願の本文そのもの**で、
 * **それは一次資料の件名の欄にそう書いてある**（下の `#866 一次資料:` の 2 本が PDF 側で押さえている）。
 * **短い議案名は一次資料のどこにも書かれていないので、推測で作らない**（#569）。
 */
test("#866 本番 data/pref-32: 112 件の件名が一次資料の PDF と完全一致（多重集合で突き合わせる）", () => {
  const dir = new URL("../../../data/assemblies/pref-32/rollcalls/", import.meta.url);
  const index = JSON.parse(readFileSync(new URL("index.json", dir), "utf-8")) as { id: string; sessionId: string }[];
  const read = (session: string): { title: string; number: string; page: number }[] =>
    index
      .filter((e) => e.sessionId === session)
      .map((e) => JSON.parse(readFileSync(new URL(`${session}/${e.id}.json`, dir), "utf-8")) as { title: string; number: string; page: number });
  // **`index.json` の並びは表示のための並びで、PDF の行順ではない**（#851）。
  // **番号でも引けない**——**「その他表決」4 件は番号が原文の `ー` で、番号では 1 つに潰れる**
  // （実測: 112 行を番号で引くと 109 通りにしかならない）。
  // **そこで「番号・件名・ページ」の組の多重集合として突き合わせる。**
  // **並べ替えには強く、1 字の違いには落ちる**（件名が 1 か所でも変われば組が合わなくなる）。
  const key = (r: { title: string; number: string; page: number }): string => `p${r.page}\u0001${r.number}\u0001${r.title}`;
  let compared = 0;
  let normalized = 0;
  for (const [session, rows, label] of [["2026-02", feb.rows, "令和8年2月"], ["499", pdf.rows, "令和8年6月"]] as const) {
    const got = read(session);
    // **母数**: 会期ごとに PDF の行数と `data/` の件数が合っていること。
    // **合っていなければ、以下の突き合わせは意味を持たない**（#757）
    assert.equal(got.length, rows.length, `${label}: data/ の件数と PDF の行数`);
    // **`data/` に出る件名は、PDF の件名に `normalizeTitle` を掛けたものである**（#648 / #674）。
    // **島根の PDF の文字層は「長」を康熙部首 `⾧` U+2FA7 で持っており、件名だけ `長` U+9577 に寄せている**
    // （氏名と `vote.raw` には掛けない）。**ここでその 1 段だけを明示して掛ける**——
    // **掛けずに比べると「教育⾧」と「教育長」で落ちるが、それは #866 の壊れではない。**
    const want = rows.map((r) => ({ ...r, title: normalizeTitle(r.title) }));
    normalized += rows.filter((r) => normalizeTitle(r.title) !== r.title).length;
    assert.deepEqual(got.map(key).sort(), want.map(key).sort(), `${label}: 件名（PDF と data/）`);
    compared += got.length;
  }
  // **`normalizeTitle` が実際に効いた行の数**（実測 2026-09-16: 令和8年2月の「教育⾧任命の同意について」1 行 ＋
  // 令和8年6月の「議⾧辞職…」「副議⾧辞職…」4 行 = 5 行）。
  // **0 になったら、上の突き合わせは正規化を通していないのと同じで、この 1 段の主張が空回りする。**
  assert.equal(normalized, 5, "normalizeTitle が件名を書き換えた行の数");
  // **何件突き合わせたか**——**0 件を見て緑にならないように**（#757）
  assert.equal(compared, 112, "突き合わせた件名の数");
});

/**
 * ## **#866 で直した 5 件の、直った後の値をそのまま固定する**
 *
 * **一次資料に何と書いてあるかは上のテストが PDF 側で押さえている。ここは `data/` の実物を名指しで固定する。**
 * **PDF のフィクスチャを取り替えても、`data/` を作り直し忘れればここが落ちる。**
 *
 * | 議案 | 直す前 | 直した後 | 一次資料に書いてあること |
 * |---|---|---|---|
 * | 承認第２号 | 175 字 | **49 字** | 議案名だけ。後ろに付いていた別議案（請願第28号）の本文が消えた |
 * | 議員提出第1号 | 171 字 | **35 字** | 条例名だけ。前に付いていた請願第28号の本文の末尾が消えた |
 * | 請願第29号 | 144 字 | **18 字** | 件名 1 行だけ。後ろに付いていた請願第30号の本文の先頭が消えた |
 * | 請願第28号 | 304 字 | **566 字** | **件名の欄が請願の本文そのもの。** 断片ではなく全体になった |
 * | 請願第30号 | 354 字 | **480 字** | **同上。** 文の途中から始まらなくなった |
 *
 * **請願第28号・第30号が長いままなのは、一次資料の件名の欄がそうなっているからである。**
 * **短い議案名は `議員別採決結果一覧` にも `議決結果一覧`（請願を載せない）にも会期ページにも無い。**
 * **委員会の委員長報告には請願の趣旨が地の文で述べられているが、それは件名の欄ではなく報告の文章であり、
 * そこから件名を組み立てれば本サイトが議案名を創作したことになる**（#569: 推測で書かない）。
 */
test("#866 本番 data/pref-32: 直した 5 件の件名（字数と先頭・末尾を名指しで固定）", () => {
  const dir = new URL("../../../data/assemblies/pref-32/rollcalls/", import.meta.url);
  const title = (session: string, id: string): string =>
    (JSON.parse(readFileSync(new URL(`${session}/${id}.json`, dir), "utf-8")) as { title: string }).title;
  const len = (s: string): number => [...s].length;

  // **文の途中から始まらない**（「議案名が文の途中から始まることは無い」——#866 の起票時は 2 件がそうだった）
  const shouryou2 = title("2026-02", "pref-32-2026-02-20260312-議案-承認第２号");
  assert.equal(shouryou2, "専決処分事件の報告及び承認について《令和７年度島根県中小企業制度融資等特別会計補正予算（第１号）》");
  assert.equal(len(shouryou2), 49);

  const teishutsu1 = title("2026-02", "pref-32-2026-02-20260312-議案-議員提出第1号");
  assert.equal(teishutsu1, "議会の議員の議員報酬、費用弁償及び期末手当支給条例の一部を改正する条例");
  assert.equal(len(teishutsu1), 35);

  const seigan29 = title("499", "pref-32-499-20260702-請願-請願第29号");
  assert.equal(seigan29, "「地方財政の充実・強化を求める」請願");
  assert.equal(len(seigan29), 18);

  // **この 2 件は一次資料の件名の欄が請願の本文そのもの**（短い議案名は一次資料のどこにも無い）。
  // **断片ではなく全体が入っていること**——**先頭が文の頭で、末尾が文の終わり**であることで見る。
  const seigan28 = title("2026-02", "pref-32-2026-02-20260312-請願-請願第28号");
  assert.equal(len(seigan28), 566);
  assert.ok(seigan28.startsWith("島根県議会が平成25年6月26日付で可決採択された"), seigan28.slice(0, 30));
  assert.ok(seigan28.endsWith("とする決議を求めます。"), seigan28.slice(-15));

  const seigan30 = title("499", "pref-32-499-20260702-請願-請願第30号");
  assert.equal(len(seigan30), 480);
  assert.ok(seigan30.startsWith("平成25年6月議会で島根県議会が採択された請願は"), seigan30.slice(0, 30));
  assert.ok(seigan30.endsWith("とする決議を求めます。"), seigan30.slice(-15));

  // **起票時に混ざっていた「別の議案の中身」が、もう入っていない**——
  // **承認第２号（議案）の欄に請願第28号の本文が続いていたのが #866 の核心だった。**
  assert.ok(!shouryou2.includes("島根県議会が平成25年"), "承認第２号に請願第28号の本文が連結している");
  assert.ok(!teishutsu1.includes("請願書"), "議員提出第1号に請願第28号の本文の末尾が付いている");
  assert.ok(!seigan29.includes("平成25年6月議会で島根県議会が採択された請願は"), "請願第29号に請願第30号の本文の先頭が付いている");
});

/**
 * ## **`splitTitleCells` の契約を、PDF を通さずに直接見る**（Issue #866）
 *
 * **上の 3 本は 2 本のフィクスチャを通してしか `splitTitleCells` を呼んでいない。**
 * **その 2 本ではたまたま「一番素直な分け方」が正解なので、分け方の規則そのものは見えていない。**
 * **ここでは一次資料と同じ形（高いセルが上下の議案番号を跨ぐ）を最小の入力で作って、規則を名指しで見る。**
 *
 * **数字は令和8年6月 3 ページ目の実測**（`請願第17号` y=445.80 / `請願第29号` y=422.88 / `請願第30号` y=286.32、
 * 本文 21 行は y=405.48 から 11.4pt 刻みで y=177.48 まで）。
 */
test("#866 splitTitleCells: 高いセルは行を跨いでも 1 つの議案に入る（一次資料と同じ y で確かめる）", () => {
  const line = (y: number, str: string): Item[] => [{ str, x: 91.68, y, w: 170, h: 11.4, cx: 91.68 + 85, cy: y }];
  // 令和8年6月 3 ページ目の件名の行（実測の y）
  const body: number[] = [];
  for (let y = 405.48; y > 177; y -= 11.4) body.push(Number(y.toFixed(2)));
  assert.equal(body.length, 21, "請願の本文の行数（母数）");
  const lines = [line(445.56, "「再審法改正を求める意見書」採択について"), line(422.64, "「地方財政の充実・強化を求める」請願"), ...body.map((y, i) => line(y, `本文${i}`))];
  const anchors = [445.80, 422.88, 286.32]; // 請願第17号 / 第29号 / 第30号
  const out = splitTitleCells(lines, anchors)!;
  assert.ok(out, "分けられた");
  assert.equal(out.size, 3, "議案の数ぶんの塊");
  // **第17号・第29号は 1 行ずつ、第30号が本文 21 行ぜんぶ**——
  // **本文の上端 y=405.48 は第29号の y=422.88 より第30号の y=286.32 から遠いが、
  // 塊として見れば第30号に入る。1 行ずつ近い議案に入れると、ここで上の 2 行が第29号へ漏れる。**
  assert.deepEqual(out.get(445.80)!.map((i) => i.str), ["「再審法改正を求める意見書」採択について"]);
  assert.deepEqual(out.get(422.88)!.map((i) => i.str), ["「地方財政の充実・強化を求める」請願"]);
  assert.equal(out.get(286.32)!.length, 21, "第30号に入った行数");
  assert.equal(out.get(286.32)![0].str, "本文0", "第30号の先頭は本文の 1 行目（途中から始まらない）");
  assert.equal(out.get(286.32)!.at(-1)!.str, "本文20", "第30号の末尾は本文の最終行");
  // **行を並べ替えない**（上から順の塊に切るだけ。推定で入れ替えない）。
  // **`Map` に入れる順は下の議案からなので、y の大きい議案から並べ直して比べる**
  // （`Map` の入れ方は実装の都合で、契約は「行が入れ替わらないこと」）
  assert.deepEqual(
    [...anchors].sort((a, b) => b - a).flatMap((a) => out.get(a)!).map((i) => i.str),
    lines.flat().map((i) => i.str),
    "行の順序",
  );
  // **件名の行が議案の数より少なければ分けない**（黙って推定で埋めず undefined を返す）
  assert.equal(splitTitleCells(lines.slice(0, 2), anchors), undefined, "3 議案に 2 行");
  assert.equal(splitTitleCells(lines, []), undefined, "議案が 0");
});

/**
 * ## **`MAX_TITLE_OFFSET` の見張りが、実際に落ちることを見る**（Issue #866）
 *
 * **これが無いと、見張りを `if (false)` にしても 30 本すべて緑のままだった**
 * （変異テストで実測。**見張りは「今のフィクスチャでは鳴らない」ので、鳴る条件を別に作らないと誰も見ていない**）。
 *
 * **`parseVotePdf` は PDF を丸ごと受け取るので、件名だけをずらした PDF は作れない。**
 * **そこで `splitTitleCells` を通さなかったとき（= 1 行ずつ近い議案に入れる昔のやり方）に
 * 何 pt ずれるかを、同じ入力で計算して確かめる。** 直す前の実装が出していた値そのものである。
 */
test("#866 見張りの閾値: 昔のやり方（1 行ずつ近い議案へ）のずれは閾値を超える", () => {
  const body: number[] = [];
  for (let y = 405.48; y > 177; y -= 11.4) body.push(Number(y.toFixed(2)));
  const titleYs = [445.56, 422.64, ...body];
  const anchors = [445.80, 422.88, 286.32];
  // 昔のやり方: 1 行ずつ「y が一番近い議案番号」に入れる
  const near = new Map<number, number[]>(anchors.map((a) => [a, [] as number[]]));
  for (const y of titleYs) {
    let best = anchors[0];
    for (const a of anchors) if (Math.abs(a - y) < Math.abs(best - y)) best = a;
    near.get(best)!.push(y);
  }
  const offsetOf = (ys: number[], a: number): number => (Math.max(...ys) + Math.min(...ys)) / 2 - a;
  const oldOffsets = anchors.map((a) => offsetOf(near.get(a)!, a));
  // **請願第29号が −31.6pt ずれる**（本文の上の数行を巻き込むので、塊の中心が上へ動く）。
  // **この値は変異テストでも出た**（`splitTitleCells` を使わなくすると
  // `page 3 請願第29号: 件名 is -31.6pt off the row centre (max 15)` で落ちる）
  assert.ok(Math.abs(oldOffsets[1]) > 15, `昔のやり方のずれ ${oldOffsets[1].toFixed(1)}pt が閾値 15 を超えていない`);
  assert.equal(oldOffsets[1].toFixed(1), "-31.6", "請願第29号のずれ");
  // **今のやり方なら閾値の内側**（請願第30号だけ 5.16pt で、それは一次資料がそう置いている）
  const now = splitTitleCells(titleYs.map((y) => [{ str: "x", x: 91.68, y, w: 170, h: 11.4, cx: 176, cy: y }]), anchors)!;
  const newOffsets = anchors.map((a) => offsetOf(now.get(a)!.map((i) => i.y), a));
  assert.deepEqual(newOffsets.map((o) => Math.abs(o) <= 15), [true, true, true], newOffsets.map((o) => o.toFixed(2)).join(" / "));
  assert.equal(newOffsets[2].toFixed(2), "5.16", "請願第30号のずれ（一次資料がそう置いている）");
});

/**
 * ## **見張りそのものを呼んで、鳴ることと鳴らないことを両方見る**（Issue #866）
 *
 * **この見張りは今の 2 本のフィクスチャでは 1 度も鳴らない**（112 行すべて閾値の内側）。
 * **だから `if (false)` に変えても 32 本すべてが緑のままだった**（変異テストで実測）——
 * **見張りを足しただけでは、誰もそれを見ていない。** ここで直接呼ぶ。
 */
test("#866 checkTitleOffset: 閾値を超えたら落ち、内側なら通る（境界の両側を見る）", () => {
  // **鳴らない側**: 請願第30号の 5.16pt は一次資料がそう置いているので通る
  assert.doesNotThrow(() => { checkTitleOffset(3, "請願第30号", "平成25年6月議会で…", 5.16); });
  assert.doesNotThrow(() => { checkTitleOffset(5, "承認第２号", "専決処分事件の…", -0.24); });
  // **2024-09 請願第14号の −12.33pt も通る**（#896。**8 のときはここで ETL が止まっていた**——
  // **`splitTitleCells` の割り当ては正しく、一次資料が塊の中心を行の中心ぴったりには置いていないだけである**）
  assert.doesNotThrow(() => { checkTitleOffset(3, "請願第14号", "本年7月10日、永田町の星陵会館で…", -12.36); });
  // **境界そのもの**: 閾値 15 ちょうどは通り、超えたら落ちる（`>` であって `>=` ではない）
  assert.doesNotThrow(() => { checkTitleOffset(1, "第1号", "x", 15); });
  assert.doesNotThrow(() => { checkTitleOffset(1, "第1号", "x", -15); });
  assert.throws(() => { checkTitleOffset(1, "第1号", "x", 15.1); }, /off the row centre/);
  assert.throws(() => { checkTitleOffset(1, "第1号", "x", -15.1); }, /off the row centre/);
  // **緩めた側で誤りが通らないこと**（#896 の「必ず守ること」）:
  // **壊れている側の最小は 17.88pt**（2024-09 請願第14号を昔のやり方で割り当てたときの値。14 本の実測）。
  // **15 はその内側にあるので、壊れている 10 行はいまも全部落ちる。**
  assert.throws(() => { checkTitleOffset(3, "請願第14号", "x", 17.88); }, /off the row centre/);
  assert.throws(() => { checkTitleOffset(3, "請願第14号", "x", -17.88); }, /off the row centre/);
  // **鳴る側**: 昔のやり方が出していた値（上のテストが計算した −31.6pt / 起票時の ±27pt）
  assert.throws(
    () => { checkTitleOffset(3, "請願第29号", "「地方財政の充実・強化を求める」請願平成25年6月議会で島根", -31.6); },
    // **どの議案がどれだけずれたかを、落ちたときのメッセージが名指しする**（#569: 黙って通さない）
    /page 3 請願第29号: 件名 is -31\.6pt off the row centre \(max 15\) — 隣の行の件名が混ざっている疑い: 「地方財政の充実・強化を求める」請願平成25年6月議会で島根/,
  );
  assert.throws(() => { checkTitleOffset(5, "承認第２号", "専決処分事件の…", -27.4); }, /off the row centre/);
  assert.throws(() => { checkTitleOffset(5, "議員提出第1号", "もの請願書に…", 27.35); }, /off the row centre/);
});
