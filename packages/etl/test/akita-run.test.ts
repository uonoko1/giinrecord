import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAkita, type Fetcher } from "../src/sources/local/akita/index.ts";
import { buildLocalAssembly, validateLocalAssemblies, writeLocalAssembly, LOCAL_SOURCES } from "../src/local-assemblies.ts";
import { AKITA_ASSEMBLY, AKITA_HOST, AKITA_HUB_URL, AKITA_ROSTER_URL, AKITA_YEARS_URL } from "../src/sources/local/akita/site.ts";

const fixture = (name: string): Buffer => readFileSync(fileURLToPath(new URL(`fixtures/akita/${name}`, import.meta.url)));

/**
 * 取得部（`runAkita`）をフィクスチャで回す（Issue #759）。**ネットワークには出ない。**
 *
 * **フィクスチャに置いてある PDF は 6 本だけ**なので、年度ページが返す PDF のうち
 * その 6 本を持つものだけを「読める」ようにし、**それ以外は読めない PDF として扱う**
 * （＝`meta.unreadableSources` に落ちる枝も同時に確かめられる）。
 */
const FIXTURE_PDFS = new Set(["h291222giketu.pdf", "h231202giketu.pdf", "060220hyoketsu.pdf", "R41102hyoketsu.pdf", "041222hyoketsu.pdf", "080319.pdf"]);
/** フィクスチャに置いてある年度ページ（残りの年度は「取りに行かない」ことを確かめる） */
const FIXTURE_YEARS = new Map([
  ["2026021300064", "year-2026021300064.html"],
  ["2018051400043", "year-2018051400043.html"],
  ["2018051400098", "year-2018051400098.html"],
]);

function fetcher(): Fetcher & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async text(url: string) {
      urls.push(url);
      if (url === AKITA_ROSTER_URL) return fixture("giin.html").toString("utf-8");
      if (url === AKITA_HUB_URL) return fixture("hub.html").toString("utf-8");
      if (url === AKITA_YEARS_URL) return fixture("years.html").toString("utf-8");
      const id = url.match(/\/doc\/(\d{13})\//)?.[1];
      const f = id ? FIXTURE_YEARS.get(id) : undefined;
      if (f) return fixture(f).toString("utf-8");
      throw new Error(`no fixture for ${url}`);
    },
    async bytes(url: string) {
      urls.push(url);
      const name = url.split("/").pop()!;
      if (!FIXTURE_PDFS.has(name)) throw new Error("PDF has no text layer (image PDF)"); // 読めない本の代わり
      return fixture(name);
    },
  };
}

const FETCHED_AT = "2026-09-13T12:00:00.000Z";

test("#759 runAkita: 名簿 + 索引 2 段 + 年度ページ + PDF だけを取りに行く", async () => {
  const f = fetcher();
  await runAkita({ sessions: 6, fetchedAt: FETCHED_AT, fetcher: f });
  // **索引は 2 段**（名簿 → 概要ハブ → 年度の一覧 → 年度ページ）
  assert.deepEqual(f.urls.slice(0, 3), [AKITA_ROSTER_URL, AKITA_HUB_URL, AKITA_YEARS_URL], "最初の 3 本");
  // **議員ごとのプロフィールページを取りに行っていない**（ふりがなのために毎月 41 本増やさない）
  assert.deepEqual(f.urls.filter((u) => u.includes("/profile/")), [], "プロフィールを取りに行っていない");
  // **全部が公式ホスト**（取得先の許可リスト）
  assert.deepEqual(f.urls.filter((u) => !u.startsWith(`https://${AKITA_HOST}/`)), [], "公式ホストだけ");
  // **年度ページは必要なぶんしか取りに行かない**（`--sessions 6` なら 1 ページで足りる）。
  // **22 ページ全部は取りに行かない**
  const yearPages = f.urls.filter((u) => /\/doc\/\d{13}\/$/.test(u) && u !== AKITA_HUB_URL && u !== AKITA_YEARS_URL && u !== AKITA_ROSTER_URL);
  assert.equal(yearPages.length, 1, `年度ページの取得（${yearPages.length} 本）`);
});

test("#759 runAkita: 読めない PDF は落とさずに数える（その日の採決が黙って消えない）", async () => {
  const f = fetcher();
  // **令和8年のページには PDF が 6 本ある。フィクスチャにあるのは `080319.pdf` の 1 本だけ**
  const run = await runAkita({ sessions: 6, fetchedAt: FETCHED_AT, fetcher: f });
  assert.equal(run.sessions.length, 1, "読めた PDF の数");
  assert.equal(run.unreadableSources.length, 5, "読めなかった PDF の数（**捨てずに数える**。#741）");
  assert.ok(run.unreadableSources.every((u) => u.reason.includes("no text layer")), "理由が入っている");
  assert.ok(run.unreadableSources.every((u) => u.url.startsWith(`https://${AKITA_HOST}/`)), "URL が入っている");
});

test("#759 runAkita: sessionId は議決日（HTML の文言に依らない）", async () => {
  const f = fetcher();
  const run = await runAkita({ sessions: 6, fetchedAt: FETCHED_AT, fetcher: f });
  // **`080319.pdf` の議決日は 3月19日、見出しの年は令和8年 = 2026**
  assert.equal(run.sessions[0].sessionId, "2026-03-19", "議決日から作る");
  assert.equal(run.sessions[0].sessionLabel, "令和８年第１回定例会（２月議会）", "会期の名前は PDF の見出しの原文");
  assert.equal(run.sessions[0].rollcalls, 91, "採決の数");
  assert.equal(run.sessions[0].unknownCells, 0, "不明セル");
  assert.ok(run.sessions[0].sourceUrl.includes("/doc/2026021300064/"), "会期の出典は年度ページ");
});

test("#759 runAkita: 41 人全員が名簿に寄る（unmatched 0）", async () => {
  const f = fetcher();
  const run = await runAkita({ sessions: 6, fetchedAt: FETCHED_AT, fetcher: f });
  assert.equal(run.roster.members.length, 41, "名簿");
  assert.deepEqual(run.unmatched, [], "寄らなかった氏名");
  assert.deepEqual(run.lossyNameMatches, [], "字が落ちたまま寄った氏名");
  assert.equal(run.rollCalls.length, 91, "採決");
  // **全部の票に memberId が入っている**（`unmatched` 0 と同じことを、票の側からも見る）
  const empty = run.rollCalls.flatMap((r) => r.votes).filter((v) => v.memberId === "");
  assert.deepEqual(empty, [], "memberId が空の票");
});

test("#759 runAkita → buildLocalAssembly → writeLocalAssembly → validateLocalAssemblies", async () => {
  const f = fetcher();
  const run = await runAkita({ sessions: 6, fetchedAt: FETCHED_AT, fetcher: f });
  const built = buildLocalAssembly({
    assembly: AKITA_ASSEMBLY,
    members: run.roster.members,
    rollCalls: run.rollCalls,
    fetchedAt: FETCHED_AT,
    rosterAsOf: run.roster.asOf,
    sources: run.sources,
    sessions: run.sessions,
    unmatched: run.unmatched,
    unreadableSources: run.unreadableSources,
  });
  assert.equal(built.meta.counts.members, 41);
  assert.equal(built.meta.counts.rollcalls, 91);
  assert.equal(built.meta.counts.cells, 91 * 41, "セル = 採決 × 議員");
  assert.equal(built.meta.counts.unknownCells, 0, "**抽出不能が 0**（推定していないのに全部置けている）");
  assert.equal(built.meta.counts.unmatchedNames, 0);

  const dir = await mkdtemp(join(tmpdir(), "akita-run-"));
  await writeLocalAssembly(dir, built, { national: [] });
  const violations = await validateLocalAssemblies(dir);
  assert.deepEqual(violations, [], "契約違反");
  // **出力が読める形で置かれている**
  const meta = JSON.parse(await readFile(join(dir, "assemblies/pref-05/meta.json"), "utf-8"));
  assert.equal(meta.assemblyId, "pref-05");
  assert.equal(meta.unreadableSources.length, 5, "読めなかった PDF が meta に残る");
  const index = JSON.parse(await readFile(join(dir, "assemblies/pref-05/rollcalls/index.json"), "utf-8"));
  assert.equal(index.length, 91);
  // **一次資料の URL は全部公式ホスト**（`validateLocalAssemblies` も見るが、ここでも固定する）
  const urls = [...meta.sources.map((s: { url: string }) => s.url), ...meta.sessions.map((s: { sourceUrl: string }) => s.sourceUrl)];
  assert.deepEqual(urls.filter((u: string) => !u.startsWith(`https://${AKITA_HOST}/`)), [], "公式ホストだけ");
});

/** **共通層に登録されている**（登録し忘れると、コードが全部あっても 1 度も走らない。#720 の形） */
test("#759 LOCAL_SOURCES に `akita` が入っている", () => {
  assert.ok(Object.hasOwn(LOCAL_SOURCES, "akita"), "`pnpm etl:local akita` が引ける");
  assert.equal(LOCAL_SOURCES.akita.assembly.id, "pref-05");
  assert.equal(LOCAL_SOURCES.akita.assembly.name, "秋田県議会");
  // **10 議会目**（既存 9 県を消していない）
  assert.equal(Object.keys(LOCAL_SOURCES).length, 10, `議会の数（${Object.keys(LOCAL_SOURCES).join(" ")}）`);
  assert.equal(new Set(Object.values(LOCAL_SOURCES).map((s) => s.assembly.id)).size, 10, "assemblyId が重複していない");
});

/** **ワークフローと CLI にも足してある**（コードだけあっても月次で走らない。#720 の運用） */
test("#759 ワークフローと CLI の Usage に `akita=pref-05` が入っている", async () => {
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const wf = await readFile(join(repo, ".github/workflows/local-assemblies.yml"), "utf-8");
  assert.match(wf, /akita=pref-05/, "ASSEMBLIES に入っている");
  const cli = await readFile(join(repo, "packages/etl/src/local-cli.ts"), "utf-8");
  assert.match(cli, /\|akita>/, "Usage に入っている");
  // **link-check の公式ドメインの許可にも入っている**（秋田は `pref.*.lg.jp` ではない）
  const lc = await readFile(join(repo, "scripts/ci/test/link-check.test.sh"), "utf-8");
  assert.match(lc, /pref\\\.akita\\\.gsl-service\\\.net/, "許可リストに入っている");
  assert.match(lc, /秋田の URL が入っている/, "「入っていること」も固定してある");
});
