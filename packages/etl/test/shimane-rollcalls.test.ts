import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkPdfSession, mapLegend, matchName, nameKey, toLocalRollCalls } from "../src/sources/local/shimane/rollcalls.ts";
import { DISTRICT_PAGES, parseRoster } from "../src/sources/local/shimane/roster.ts";
import { parseResultsPdf, parseVotePdf, UNKNOWN_CELL, UNKNOWN_LEGEND } from "../src/sources/local/shimane/votes-pdf.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/shimane/${name}`, import.meta.url));
const text = (name: string) => fixture(name).toString("utf8");
const origin = "https://www.pref.shimane.lg.jp";
const pdfUrl = `${origin}/gikai/ugoki/saikin/r0806/index.data/r0806_giinbetu_kekka.pdf`;

const roster = parseRoster(DISTRICT_PAGES.map((d) => ({ district: d.district, url: `${origin}${d.path}`, html: text(`meibo-${d.slug}.html`) })));
const pdf = await parseVotePdf(fixture("r0806_giinbetu_kekka.pdf"));
const results = await parseResultsPdf(fixture("r0806_giketu_kekka.pdf"));
const session = { sessionId: "499", sessionLabel: "令和8年6月定例会（第499回）" };
const { rollCalls, unmatched } = toLocalRollCalls([{ pdf, pdfUrl }], roster.members, session, { results, lastDate: "2026-07-02" });

test("nameKey: 空白と異体字セレクタを落とし、字形違い（德/徳・髙/高）を寄せる", () => {
  // PDF は「絲原德康」、名簿は「絲原徳康」（德/徳）
  assert.equal(nameKey("絲原德康"), nameKey("絲原徳康"));
  assert.equal(nameKey("五百川 純寿"), nameKey("五百川純寿"));
  assert.notEqual(nameKey("中村絢"), nameKey("中村芳信"));
});

test("matchName: PDF の氏名 35 人すべてが名簿の 1 人に決まる（候補が複数なら選ばない）", () => {
  for (const name of pdf.members) {
    const m = matchName(name, roster.members);
    assert.notEqual(m.memberId, "", `${name} not matched (candidates: ${m.candidates.map((c) => c.name).join("/")})`);
  }
  // 同姓が 2 人（中村絢・中村芳信）いても、フルネームなので取り違えない
  assert.equal(matchName("中村絢", roster.members).memberId, matchName("中村絢", roster.members).memberId);
  assert.notEqual(matchName("中村絢", roster.members).memberId, matchName("中村芳信", roster.members).memberId);
});

test("matchName: 名簿に無い氏名は memberId 空。候補も無ければ空の配列", () => {
  const m = matchName("架空太郎", roster.members);
  assert.equal(m.memberId, "");
  assert.deepEqual(m.candidates, []);
});

test("mapLegend: 凡例の原文から国会の値へ。棄権・不明には mapped を付けない", () => {
  assert.deepEqual(mapLegend("○", "賛成"), { raw: "○", legend: "賛成", mapped: "賛成" });
  assert.deepEqual(mapLegend("●", "反対"), { raw: "●", legend: "反対", mapped: "反対" });
  // 議長・欠席等による不在・除斥は「票を投じていない」＝投票なし
  assert.deepEqual(mapLegend("議⾧", "議長"), { raw: "議⾧", legend: "議長", mapped: "投票なし" });
  assert.deepEqual(mapLegend("－", "欠席等による不在"), { raw: "－", legend: "欠席等による不在", mapped: "投票なし" });
  assert.deepEqual(mapLegend("除斥", "議案と一定の利害関係を有する議員"), { raw: "除斥", legend: "議案と一定の利害関係を有する議員", mapped: "投票なし" });
  // 棄権は国会の 3 値に無い（欠席と区別している事実を消さない）
  assert.deepEqual(mapLegend("棄権", "棄権"), { raw: "棄権", legend: "棄権" });
  // 抽出不能は推定しない
  assert.deepEqual(mapLegend(UNKNOWN_CELL, UNKNOWN_LEGEND), { raw: UNKNOWN_CELL, legend: UNKNOWN_LEGEND });
});

test("toLocalRollCalls: 30 件。id は {assemblyId}-{sessionId}-{議決日}-{種別}-{番号}", () => {
  assert.equal(rollCalls.length, 30);
  const first = rollCalls[0];
  assert.equal(first.id, "pref-32-499-20260702-議案-第77号");
  assert.equal(first.assemblyId, "pref-32");
  assert.equal(first.sessionId, "499");
  assert.equal(first.sessionLabel, "令和8年6月定例会（第499回）");
  assert.equal(first.date, "2026-07-02");
  assert.equal(first.kind, "議案");
  assert.equal(first.number, "第77号");
  assert.equal(first.title, "令和８年度島根県一般会計補正予算（第１号）");
  assert.equal(first.result, "原案可決");
  assert.equal(first.sourceUrl, pdfUrl);
  assert.equal(first.page, 1);
  assert.equal(new Set(rollCalls.map((r) => r.id)).size, 30);
});

test("toLocalRollCalls: 付託委員会を捨てずに残す（複数付託はそのまま。付託省略は原文「ー」）", () => {
  assert.deepEqual(rollCalls.find((r) => r.number === "第77号")!.referredCommittees, ["総務委員会", "防災地域建設委員会", "環境厚生委員会", "農林水産商工委員会"]);
  assert.deepEqual(rollCalls.find((r) => r.number === "第90号")!.referredCommittees, ["総務委員会", "農林水産商工委員会"]);
  assert.deepEqual(rollCalls.find((r) => r.number === "第91号")!.referredCommittees, ["ー"]);
});

test("toLocalRollCalls: counts は PDF の公表値（賛成・反対）。表決者数を公表しないので voting は付けない", () => {
  assert.deepEqual(rollCalls.find((r) => r.number === "第77号")!.counts, { yes: 34, no: 0 });
  assert.deepEqual(rollCalls.find((r) => r.number === "第80号")!.counts, { yes: 32, no: 2 });
  assert.equal("voting" in rollCalls[0].counts!, false);
  assert.equal("present" in rollCalls[0].counts!, false);
});

test("toLocalRollCalls: 議決日は「議決結果一覧」PDF から。載らない請願・その他表決は会期の最終議決日", () => {
  assert.equal(rollCalls.find((r) => r.number === "第77号")!.date, "2026-07-02");
  assert.equal(rollCalls.find((r) => r.number === "請願第17号")!.date, "2026-07-02");
  assert.equal(rollCalls.find((r) => r.kind === "その他表決")!.date, "2026-07-02");
});

test("toLocalRollCalls: 請願は「委員長報告に対する賛否」であることを voteSubject / committeeReport に残す", () => {
  const p17 = rollCalls.find((r) => r.number === "請願第17号")!;
  // ○ を「請願そのものへの賛成」と読ませない（PDF の※注記のとおり、賛否の対象は付託先委員会の報告）
  assert.equal(p17.voteSubject, "付託先委員会の報告に対する賛否");
  assert.equal(p17.committeeReport, "採択");
  const p30 = rollCalls.find((r) => r.number === "請願第30号")!;
  assert.equal(p30.voteSubject, "付託先委員会の報告に対する賛否");
  assert.equal(p30.committeeReport, "不採択");
  // 議案の行には付けない（PDF がそう言っていない）
  assert.equal(rollCalls.find((r) => r.number === "第77号")!.voteSubject, undefined);
  assert.equal(rollCalls.find((r) => r.number === "第77号")!.committeeReport, undefined);
});

test("toLocalRollCalls: votes は議員数ぶん・PDF の列順。raw と legend は原文、mapped は凡例から機械的に決まるときだけ", () => {
  const first = rollCalls[0];
  assert.equal(first.votes.length, 35);
  assert.equal(first.votes[0].nameText, "中村絢");
  assert.deepEqual(first.votes[0].value, { raw: "○", legend: "賛成", mapped: "賛成" });
  // 議長（山根成二）は「議⾧」の原文のまま、mapped は投票なし
  const gicho = first.votes[21];
  assert.equal(gicho.nameText, "山根成二");
  assert.deepEqual(gicho.value, { raw: "議⾧", legend: "議長", mapped: "投票なし" });
  // 会派は名簿の原文
  assert.equal(first.votes[0].group, "自民党ネクスト島根");
  // 全員が名簿に寄っている
  for (const v of first.votes) assert.notEqual(v.memberId, "", v.nameText);
  assert.deepEqual(unmatched, []);
});

test("toLocalRollCalls: 除斥（その他表決）も原文のまま残る", () => {
  const others = rollCalls.filter((r) => r.kind === "その他表決");
  assert.deepEqual(others[0].votes[23].value, { raw: "除斥", legend: "議案と一定の利害関係を有する議員", mapped: "投票なし" });
  assert.deepEqual(others[0].votes[18].value, { raw: "議⾧", legend: "議長", mapped: "投票なし" });
});

test("toLocalRollCalls: 凡例に無いセルが出たら例外（黙って捨てない）", () => {
  const broken = { ...pdf, rows: pdf.rows.map((r, i) => (i === 0 ? { ...r, cells: r.cells.map((c, j) => (j === 0 ? "★" : c)) } : r)) };
  assert.throws(() => toLocalRollCalls([{ pdf: broken, pdfUrl }], roster.members, session, { results, lastDate: "2026-07-02" }), /not in the legend/);
});

test("toLocalRollCalls: 議決結果一覧の議決結果が議員別 PDF と食い違えば例外（別の会期の PDF を組み合わせない）", () => {
  const wrong = new Map(results);
  wrong.set("第77号", { date: "2026-07-02", result: "否決" });
  assert.throws(() => toLocalRollCalls([{ pdf, pdfUrl }], roster.members, session, { results: wrong, lastDate: "2026-07-02" }), /議決結果/);
});

// ── #695: 議員別採決結果一覧 PDF の表題と会期 index のリンク文言を突き合わせる ────────────────
// 島根の PDF には表題があり、そこに **通算回次と 年月の会期名の両方** が書かれている
// （「第４９９回島根県議会（令和８年６月定例会）採決結果」）。にもかかわらず突き合わせていなかった。
// 会期ページに別の会期の PDF が置かれていても素通りし、会期名は令和8年6月・中身は令和8年2月の
// rollCall が出る（会期名が合っているので利用者からは検出できない。#569）。
// PDF の URL（r0806_giinbetu_kekka.pdf）に会期らしき文字列はあるが、URL は県が付けたファイル名であって
// 中身が何であるかの証拠にはならないので、中身の表題で照合する。
const feb = await parseVotePdf(fixture("r0802_giinbetu_kekka.pdf"));
const febResults = await parseResultsPdf(fixture("r0802_giketu_kekka.pdf"));

test("#695 toLocalRollCalls: 別の会期の PDF を渡せば例外（令和8年2月の PDF を令和8年6月定例会として読ませない）", () => {
  // 実物どうしの取り違え: 第498回（令和8年2月定例会）の PDF を、第499回（令和8年6月定例会）として渡す
  assert.throws(
    () => toLocalRollCalls([{ pdf: feb, pdfUrl }], roster.members, session, { results: febResults, lastDate: "2026-03-12" }),
    /PDF says 令和8年2月定例会, session index says 令和8年6月定例会/,
  );
  // 逆向き（第499回の PDF を第498回として）も弾く
  const febSession = { sessionId: "498", sessionLabel: "令和8年2月定例会（第498回）" };
  assert.throws(
    () => toLocalRollCalls([{ pdf, pdfUrl }], roster.members, febSession, { results, lastDate: "2026-07-02" }),
    /PDF says 令和8年6月定例会, session index says 令和8年2月定例会/,
  );
});

test("#695 checkPdfSession: 年月の会期名が合っていても回次が違えば例外（回次と年月の両方を見る）", () => {
  assert.throws(
    () => checkPdfSession("第４９８回島根県議会（令和８年６月定例会）採決結果", "令和8年6月定例会（第499回）", pdfUrl),
    /PDF says 第498回, session index says 第499回/,
  );
  // 回次が合っていても年月が違えば例外
  assert.throws(
    () => checkPdfSession("第４９９回島根県議会（令和８年２月定例会）採決結果", "令和8年6月定例会（第499回）", pdfUrl),
    /PDF says 令和8年2月定例会, session index says 令和8年6月定例会/,
  );
});

test("#695 checkPdfSession: リンク文言に回次が無い会期（過去の定例会の概要）は年月だけを照合する（無いものは照合しない）", () => {
  // gikai_kako のリンク文言には回次が無い（sessions.ts の LINK_TEXT 参照）
  assert.doesNotThrow(() => checkPdfSession("第４９８回島根県議会（令和８年２月定例会）採決結果", "令和8年2月定例会", pdfUrl));
  // 回次を照合しないだけで、年月が違えば弾く
  assert.throws(() => checkPdfSession("第４９８回島根県議会（令和８年２月定例会）採決結果", "令和8年6月定例会", pdfUrl), /PDF says 令和8年2月定例会/);
});

test("#695 checkPdfSession: 否定的対照——実物の表題とリンク文言の組（全角/半角の揺れを含む）は通る", () => {
  // PDF は全角（「第４９９回」「令和８年」）、リンク文言は半角（「第499回」「令和8年」）。NFKC で寄せて通す
  assert.doesNotThrow(() => checkPdfSession(pdf.title, session.sessionLabel, pdfUrl));
  assert.doesNotThrow(() => checkPdfSession(feb.title, "令和8年2月定例会（第498回）", pdfUrl));
});

test("#695 checkPdfSession: 表題・リンク文言が想定の形でなければ例外（黙って照合を飛ばさない）", () => {
  assert.throws(() => checkPdfSession("議案等の審査付託先委員会における審査結果に対する賛否状況の一覧です。", session.sessionLabel, pdfUrl), /is not 第N回島根県議会/);
  assert.throws(() => checkPdfSession(pdf.title, "令和8年6月のなにか", pdfUrl), /is not 令和N年M月定例会/);
});
