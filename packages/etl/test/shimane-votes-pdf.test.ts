import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseResultsPdf, parseVotePdf, UNKNOWN_CELL, UNKNOWN_LEGEND } from "../src/sources/local/shimane/votes-pdf.ts";

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

test("令和8年2月: 全 82 行で ○ ● の数が PDF の賛成者数・反対者数と一致する（表の復元の検算）", () => {
  for (const r of feb.rows) {
    assert.equal(r.cells.filter((c) => c === "○").length, r.counts.yes, `${r.number} ${r.title}: 賛成`);
    assert.equal(r.cells.filter((c) => c === "●").length, r.counts.no, `${r.number} ${r.title}: 反対`);
  }
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
