import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShimane, type Fetcher } from "../src/sources/local/shimane/index.ts";
import { SHIMANE_ASSEMBLY } from "../src/sources/local/shimane/site.ts";
import { DISTRICT_PAGES } from "../src/sources/local/shimane/roster.ts";
import { buildLocalAssembly, validateLocalAssemblies, writeLocalAssembly } from "../src/local-assemblies.ts";

// 島根県議会 ETL の取得部（Issue #221）: 名簿（選挙区別 index → 12 選挙区）→ 会期 index（最近＋過去）
// → 会期ページ →「議員別採決結果一覧」PDF（＋議決日を読む「議決結果一覧」PDF）。
// HTTP は境界なので、フィクスチャ（2026-08-24 取得）を返す Fetcher を差し込む。取得先 URL はすべて県の公式ホスト。
const origin = "https://www.pref.shimane.lg.jp";
const session0806 = `${origin}/gikai/ugoki/saikin/r0806/`;
// 1 つ前の会期（令和8年2月定例会＝第498回。過去の定例会の概要の側にある）。
// この会期は PDF の作りが 6月と違い（節見出しが無い・列の x が違う・欄をまたぐ結合された文字列がある）、
// 本番の ETL はここで落ちていた（Issue #221 の後、#232）。2 会期ぶん通ることを取得部でも確かめる。
const session0802 = `${origin}/gikai/ugoki/gikai_kako/r0802/`;
const files: Record<string, string> = {
  [`${origin}/gikai/gaido/meibo/tiku.html`]: "meibo-tiku.html",
  [`${origin}/gikai/ugoki/saikin/`]: "saikin.html",
  [`${origin}/gikai/ugoki/gikai_kako/`]: "gikai_kako.html",
  [session0806]: "r0806.html",
  [`${session0806}index.data/r0806_giinbetu_kekka.pdf`]: "r0806_giinbetu_kekka.pdf",
  [`${session0806}index.data/r0806_giketu_kekka.pdf`]: "r0806_giketu_kekka.pdf",
  [session0802]: "r0802.html",
  [`${session0802}index.data/r0802_giinbetu_kekka.pdf`]: "r0802_giinbetu_kekka.pdf",
  [`${session0802}index.data/r0802_giketu_kekka.pdf`]: "r0802_giketu_kekka.pdf",
};
for (const d of DISTRICT_PAGES) files[`${origin}${d.path}`] = `meibo-${d.slug}.html`;

function fakeFetcher(): Fetcher & { urls: string[] } {
  const urls: string[] = [];
  const read = (url: string) => {
    const f = files[url];
    if (!f) throw new Error(`unexpected fetch ${url}`);
    urls.push(url);
    return readFileSync(new URL(`./fixtures/shimane/${f}`, import.meta.url));
  };
  return { urls, text: async (url) => read(url).toString("utf8"), bytes: async (url) => read(url) };
}

const run = await runShimane({ sessions: 1, fetchedAt: "2026-08-24T00:00:00.000Z", fetcher: fakeFetcher() });

test("runShimane: 名簿 35 人・直近 1 会期の採決 30 件。会期は通算回次で識別する", async () => {
  assert.equal(run.roster.members.length, 35);
  assert.equal(run.roster.asOf, "2023-05-17");
  assert.deepEqual(run.sessions.map((s) => [s.sessionId, s.sessionLabel, s.rollcalls, s.unknownCells, s.sourceUrl, s.pdfUrl]), [
    ["499", "令和8年6月定例会（第499回）", 30, 0, session0806, `${session0806}index.data/r0806_giinbetu_kekka.pdf`],
  ]);
  assert.equal(run.rollCalls.length, 30);
  assert.deepEqual(run.unmatched, []);
  assert.equal(run.summary[0].members, 35);
});

test("runShimane: 出典は名簿・会期 index（最近／過去）・会期ページ・PDF 2 本。すべて公式ホストで fetchedAt つき", () => {
  assert.equal(run.sources[0].name, "島根県議会 議員名簿（選挙区別）");
  assert.equal(run.sources[0].url, `${origin}/gikai/gaido/meibo/tiku.html`);
  assert.ok(run.sources.some((s) => s.url === `${origin}/gikai/ugoki/saikin/`));
  assert.ok(run.sources.some((s) => s.url === `${origin}/gikai/ugoki/gikai_kako/`));
  assert.ok(run.sources.some((s) => s.url === `${session0806}index.data/r0806_giinbetu_kekka.pdf` && s.name.includes("議員別採決結果一覧")));
  // 議決日の出どころ（議決結果一覧）も出典に残す
  assert.ok(run.sources.some((s) => s.url === `${session0806}index.data/r0806_giketu_kekka.pdf` && s.name.includes("議決結果一覧")));
  assert.ok(run.sources.every((s) => s.url.startsWith(`${origin}/`) && s.fetchedAt === "2026-08-24T00:00:00.000Z"));
});

test("runShimane: 取得は名簿 index → 12 選挙区 → 会期 index 2 つ → 会期ページ → PDF の順。同じ URL は 1 回だけ", async () => {
  const f = fakeFetcher();
  await runShimane({ sessions: 1, fetchedAt: "2026-08-24T00:00:00.000Z", fetcher: f });
  assert.equal(f.urls[0], `${origin}/gikai/gaido/meibo/tiku.html`);
  assert.deepEqual(f.urls.slice(1, 13), DISTRICT_PAGES.map((d) => `${origin}${d.path}`));
  assert.equal(f.urls[13], `${origin}/gikai/ugoki/saikin/`);
  assert.equal(f.urls[14], `${origin}/gikai/ugoki/gikai_kako/`);
  assert.equal(f.urls[15], session0806);
  assert.deepEqual(f.urls.slice(16), [`${session0806}index.data/r0806_giinbetu_kekka.pdf`, `${session0806}index.data/r0806_giketu_kekka.pdf`]);
  assert.equal(new Set(f.urls).size, f.urls.length);
});

test("writeLocalAssembly + validateLocalAssemblies（島根）: 契約違反なし。rollcalls に referredCommittees があり method は無い", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shimane-"));
  const built = buildLocalAssembly({
    assembly: SHIMANE_ASSEMBLY,
    members: run.roster.members,
    rollCalls: run.rollCalls,
    fetchedAt: "2026-08-24T00:00:00.000Z",
    rosterAsOf: run.roster.asOf,
    sources: run.sources,
    sessions: run.sessions,
    unmatched: run.unmatched,
  });
  await writeLocalAssembly(dir, built);
  assert.deepEqual(await validateLocalAssemblies(dir), []);

  // 議員数 × 議案数 のセル（不明を含む）と、不明セル 0
  assert.deepEqual(built.meta.counts, { members: 35, rollcalls: 30, cells: 35 * 30, unknownCells: 0, unmatchedNames: 0 });

  const rc = JSON.parse(await readFile(join(dir, "assemblies/pref-32/rollcalls/499/pref-32-499-20260702-議案-第77号.json"), "utf8"));
  assert.deepEqual(rc.referredCommittees, ["総務委員会", "防災地域建設委員会", "環境厚生委員会", "農林水産商工委員会"]);
  assert.deepEqual(rc.counts, { yes: 34, no: 0 });
  assert.equal(rc.method, undefined);
  assert.equal(rc.sourceUrl, `${session0806}index.data/r0806_giinbetu_kekka.pdf`);
  // 原文主義: raw / legend を必ず持ち、mapped は凡例から機械的に決まるときだけ
  assert.deepEqual(rc.votes[0].value, { raw: "○", legend: "賛成", mapped: "賛成" });
  assert.deepEqual(rc.votes[21].value, { raw: "議⾧", legend: "議長", mapped: "投票なし" });

  // 議員ページ（Web が読む形）に採決が入っている
  const detail = JSON.parse(await readFile(join(dir, `members/${run.roster.members[0].id}.json`), "utf8"));
  assert.equal(detail.counts.rollcalls, 30);
  assert.equal(detail.timeline[0].kind, "localVote");
  assert.equal(detail.timeline[0].sessionLabel, "令和8年6月定例会（第499回）");
  assert.ok(detail.timeline[0].sourceUrl.endsWith("r0806_giinbetu_kekka.pdf"), "一次資料（PDF）へのリンクが全行にある");
  for (const e of detail.timeline) assert.ok(e.sourceUrl.startsWith(`${origin}/`), e.sourceUrl);

  // 会期一覧の date は最終議決日
  const sessions = JSON.parse(await readFile(join(dir, "assemblies/pref-32/sessions.json"), "utf8"));
  assert.deepEqual(sessions, [{ id: "499", label: "令和8年6月定例会（第499回）", date: "2026-07-02", rollcalls: 30, sourceUrl: session0806, fetchedAt: "2026-08-24T00:00:00.000Z" }]);
});

test("validateLocalAssemblies: referredCommittees が空の配列なら契約違反", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shimane-bad-"));
  const built = buildLocalAssembly({
    assembly: SHIMANE_ASSEMBLY,
    members: run.roster.members,
    rollCalls: run.rollCalls,
    fetchedAt: "2026-08-24T00:00:00.000Z",
    rosterAsOf: run.roster.asOf,
    sources: run.sources,
    sessions: run.sessions,
    unmatched: run.unmatched,
  });
  await writeLocalAssembly(dir, built);
  const path = join(dir, "assemblies/pref-32/rollcalls/499/pref-32-499-20260702-議案-第77号.json");
  const rc = JSON.parse(await readFile(path, "utf8"));
  const { writeFile } = await import("node:fs/promises");
  const { stableJson } = await import("../src/json.ts");
  await writeFile(path, stableJson({ ...rc, referredCommittees: [] }));
  assert.ok((await validateLocalAssemblies(dir)).some((x) => /referredCommittees/.test(x)));
});

/* ---------- 2 会期ぶん（令和8年6月・令和8年2月）。会期ごとの PDF の作りの違いに耐えること ---------- */

const run2 = await runShimane({ sessions: 2, fetchedAt: "2026-08-24T00:00:00.000Z", fetcher: fakeFetcher() });

test("runShimane: 2 会期（第499回・第498回）を新しい順に読む。回次の無い会期は西暦＋月の sessionId", () => {
  assert.deepEqual(run2.sessions.map((s) => [s.sessionId, s.sessionLabel, s.rollcalls, s.unknownCells]), [
    ["499", "令和8年6月定例会（第499回）", 30, 0],
    // 過去の定例会の概要のリンク文言には回次が無いので {西暦}-{月2桁}
    ["2026-02", "令和8年2月定例会", 82, 0],
  ]);
  assert.equal(run2.rollCalls.length, 30 + 82);
  // どちらの会期でも名簿に寄せられなかった氏名は無い
  assert.deepEqual(run2.unmatched, []);
  assert.deepEqual(run2.summary.map((s) => [s.sessionId, s.members, s.rows, s.unknownCells]), [["499", 35, 30, 0], ["2026-02", 35, 82, 0]]);
});

test("runShimane: 令和8年2月の議決日は議決結果一覧から（3月12日）。全角の「承認第１号」も突き合わせる", () => {
  const feb = run2.rollCalls.filter((rc) => rc.sessionId === "2026-02");
  assert.equal(feb.length, 82);
  // 議決日は取得日で代用しない（議決結果一覧 PDF の「３月12日」）
  assert.deepEqual([...new Set(feb.map((rc) => rc.date))], ["2026-03-12"]);
  const shonin = feb.find((rc) => rc.number === "承認第１号")!;
  assert.equal(shonin.result, "承認");
  assert.equal(shonin.date, "2026-03-12");
  // id は種別と議案等番号の原文から
  assert.equal(feb.find((rc) => rc.number === "第1号")!.id, "pref-32-2026-02-20260312-議案-第1号");
  assert.equal(feb.find((rc) => rc.number === "請願第28号")!.id, "pref-32-2026-02-20260312-請願-請願第28号");
});

test("runShimane: 令和8年2月の票も「どの議員がどの値か」で固定する（議長は池田一、福田正明は欠席）", () => {
  const feb = run2.rollCalls.filter((rc) => rc.sessionId === "2026-02");
  const r1 = feb.find((rc) => rc.number === "第1号")!;
  assert.equal(r1.votes.length, 35);
  assert.equal(r1.votes[23].nameText, "池田一");
  assert.deepEqual(r1.votes[23].value, { raw: "議⾧", legend: "議長", mapped: "投票なし" });
  assert.equal(r1.votes[33].nameText, "福田正明");
  assert.deepEqual(r1.votes[33].value, { raw: "－", legend: "欠席等による不在", mapped: "投票なし" });
  assert.deepEqual(r1.votes[0].value, { raw: "○", legend: "賛成", mapped: "賛成" });
  // 反対した議員を名前で固定する（列がずれれば人が変わる）
  const r3 = feb.find((rc) => rc.number === "第3号")!;
  assert.deepEqual(r3.votes.filter((v) => v.value.raw === "●").map((v) => v.nameText), ["大国陽介", "尾村利成", "成相安信"]);
  // 名寄せできているので memberId が付く
  assert.ok(r3.votes.every((v) => v.memberId !== ""));
  // 請願は「付託先委員会の報告に対する賛否」であることを残す
  const p = feb.find((rc) => rc.number === "請願第28号")!;
  assert.equal(p.voteSubject, "付託先委員会の報告に対する賛否");
  assert.equal(p.committeeReport, "不採択");
});

test("writeLocalAssembly + validateLocalAssemblies（島根・2 会期）: 契約違反なし", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shimane2-"));
  const built = buildLocalAssembly({
    assembly: SHIMANE_ASSEMBLY,
    members: run2.roster.members,
    rollCalls: run2.rollCalls,
    fetchedAt: "2026-08-24T00:00:00.000Z",
    rosterAsOf: run2.roster.asOf,
    sources: run2.sources,
    sessions: run2.sessions,
    unmatched: run2.unmatched,
  });
  await writeLocalAssembly(dir, built);
  assert.deepEqual(await validateLocalAssemblies(dir), []);
  assert.deepEqual(built.meta.counts, { members: 35, rollcalls: 112, cells: 35 * 112, unknownCells: 0, unmatchedNames: 0 });

  // 令和8年2月の議案（件名と付託委員会が 1 つの文字列で書かれていた行）
  const rc = JSON.parse(await readFile(join(dir, "assemblies/pref-32/rollcalls/2026-02/pref-32-2026-02-20260312-議案-第27号.json"), "utf8"));
  assert.equal(rc.title, "非常勤の職員等の報酬及び費用弁償支給条例等の一部を改正する条例");
  assert.deepEqual(rc.referredCommittees, ["総務委員会"]);
  assert.equal(rc.sourceUrl, `${session0802}index.data/r0802_giinbetu_kekka.pdf`);

  // 会期一覧は新しい順で、date は会期ごとの最終議決日
  const sessions = JSON.parse(await readFile(join(dir, "assemblies/pref-32/sessions.json"), "utf8"));
  assert.deepEqual(sessions.map((s: { id: string; date: string; rollcalls: number }) => [s.id, s.date, s.rollcalls]), [
    ["499", "2026-07-02", 30],
    ["2026-02", "2026-03-12", 82],
  ]);

  // 議員ページ: 2 会期ぶんの票が入る
  const detail = JSON.parse(await readFile(join(dir, `members/${run2.roster.members[0].id}.json`), "utf8"));
  assert.equal(detail.counts.rollcalls, 112);
  assert.ok(detail.timeline.some((e: { sessionLabel: string }) => e.sessionLabel === "令和8年2月定例会"));
});
