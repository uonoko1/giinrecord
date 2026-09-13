import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runAomori, type Fetcher } from "../src/sources/local/aomori/index.ts";
import { buildLocalAssembly, validateLocalAssemblies, writeLocalAssembly } from "../src/local-assemblies.ts";
import { AOMORI_ASSEMBLY, AOMORI_DISTRICT_URL, AOMORI_INDEX_URL, AOMORI_ROSTER_URL } from "../src/sources/local/aomori/site.ts";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = (name: string): Buffer => readFileSync(fileURLToPath(new URL(`fixtures/aomori/${name}`, import.meta.url)));

/**
 * 取得部（`runAomori`）をフィクスチャで回す（Issue #750）。**ネットワークには出ない。**
 *
 * **フィクスチャに置いてある PDF は 5 本だけ**なので、index が返す 56 会期のうち
 * その 5 本を持つ会期だけを「読める」ようにし、**それ以外は読めない PDF として扱う**
 * （＝`meta.unreadableSources` に落ちる枝も同時に確かめられる）。
 */
const FIXTURE_PDFS = new Set(["314teirei_sanpi.pdf", "279_26.9_giketsukekka.pdf", "322teirei_sanpi.pdf", "276_25.11_giketsukekka.pdf", "300teirei_sanpi.pdf"]);

function fetcher(): Fetcher & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async text(url: string) {
      urls.push(url);
      if (url === AOMORI_ROSTER_URL) return fixture("giin-kaiha.html").toString("utf-8");
      if (url === AOMORI_DISTRICT_URL) return fixture("giin-senkyoku.html").toString("utf-8");
      if (url === AOMORI_INDEX_URL) return fixture("katsudo-shinsakekka.html").toString("utf-8");
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

test("#750 runAomori: 名簿 2 ページ + index + 会期ごとの PDF だけを取りに行く", async () => {
  const f = fetcher();
  await runAomori({ sessions: 5, fetchedAt: FETCHED_AT, fetcher: f });
  // **議員ごとのプロフィールページを取りに行っていない**（ふりがなのために毎月 46 本増やさない）
  assert.deepEqual(f.urls.filter((u) => /\/giin_[a-z]/.test(u)), []);
  assert.deepEqual(f.urls.slice(0, 3), [AOMORI_ROSTER_URL, AOMORI_DISTRICT_URL, AOMORI_INDEX_URL]);
  // **1 会期 1 本**（5 会期で 5 本）
  assert.equal(f.urls.filter((u) => u.endsWith(".pdf")).length, 5);
  // **HTML は 3 本だけ**（会期ごとの中間ページが無い）
  assert.equal(f.urls.filter((u) => u.endsWith(".html")).length, 3);
});

/**
 * **読めない PDF で会期ごと落とさない**（滋賀 #741 と同じ判断）。
 * **`meta.unreadableSources` に URL と理由を残す**——書かないと「その日の採決は無かった」と読めてしまう。
 */
test("#750 runAomori: 読めない PDF は unreadableSources に落ちて、会期ごと消えない", async () => {
  const f = fetcher();
  // 第326回〜第314回（14 会期）のうち、フィクスチャにあるのは 322（6 番目）と 314（14 番目）の 2 本
  const run = await runAomori({ sessions: 14, fetchedAt: FETCHED_AT, fetcher: f });
  assert.deepEqual(run.sessions.map((s) => s.sessionId), ["2025-06", "2023-07"], "読めた会期は 2 つ");
  assert.equal(run.unreadableSources.length, 12, "読めなかった 12 本が記録される");
  assert.equal(run.unreadableSources.every((u) => u.url.startsWith("https://www.pref.aomori.lg.jp/")), true);
  assert.equal(run.unreadableSources.every((u) => u.reason.includes("text layer")), true, "理由は例外のメッセージのまま（推定しない）");
  assert.equal(run.rollCalls.length, 23 + 21);
});

test("#750 runAomori: 出典に名簿 2 ページ・index・PDF が全部入る", async () => {
  // 第322回（2025-06）は index の新しい順で 6 番目（先頭 5 本はフィクスチャに無い）
  const run = await runAomori({ sessions: 6, fetchedAt: FETCHED_AT, fetcher: fetcher() });
  assert.deepEqual(run.sources.map((s) => s.url), [
    AOMORI_ROSTER_URL, AOMORI_DISTRICT_URL, AOMORI_INDEX_URL,
    "https://www.pref.aomori.lg.jp/soshiki/gikai/files/322teirei_sanpi.pdf",
  ], "**読めた本だけが出典に入る**（読めなかった 5 本は unreadableSources へ）");
  assert.equal(run.sources.every((s) => s.fetchedAt === FETCHED_AT), true);
  // **会期の出典は index そのもの**（会期ごとの中間ページが無い）
  assert.equal(run.sessions[0].sourceUrl, AOMORI_INDEX_URL);
  assert.equal(run.unreadableSources.length, 5);
});

/**
 * **`data/` に書ける形になっているか**（`validateLocalAssemblies` が違反 0 で通ること）。
 * **本番の `data/` は触らない**（一時ディレクトリに書く）。
 */
test("#750 buildLocalAssembly → validateLocalAssemblies が違反 0 で通る", async () => {
  const run = await runAomori({ sessions: 14, fetchedAt: FETCHED_AT, fetcher: fetcher() });
  const built = buildLocalAssembly({
    assembly: AOMORI_ASSEMBLY, members: run.roster.members, rollCalls: run.rollCalls, fetchedAt: FETCHED_AT,
    rosterAsOf: run.roster.asOf, sources: run.sources, sessions: run.sessions, unmatched: run.unmatched,
    unreadableSources: run.unreadableSources,
  });
  assert.equal(built.meta.counts.members, 46);
  assert.equal(built.meta.counts.rollcalls, 44);
  assert.equal(built.meta.counts.cells, 23 * 48 + 21 * 48);
  assert.equal(built.meta.counts.unknownCells, 0, "**推定せず残した不明セルは 0**");
  assert.equal(built.meta.rosterAsOf, "2026-05-25");
  assert.equal(built.meta.unreadableSources?.length, 12);
  // **この 2 会期には字の落ちた氏名が無い**（`lossyNameMatches` は省略される）
  assert.equal(built.meta.lossyNameMatches, undefined);
  // **`unmatched.json` の理由**: 名簿に無い議員（理由なし）と `sourceConflict`（和田寛司・噰引ユキ子）。
  // **同じ氏名が 2 行あるのは会派が違うから**——**第322回は罫線が無いので会派が空**で、
  // **第314回は会派が読める。** `unmatched.json` は (氏名, 会派) で数える
  assert.deepEqual([...new Set(built.unmatched.map((u) => `${u.nameText}/${u.reason ?? "-"}`))].sort(), [
    "和 田 寛 司/sourceConflict", "噰 引 ユキ子/sourceConflict", "工 藤 貴 弘/-", "谷 川 政 人/-", "阿 部 広 悦/-",
  ].sort());
  assert.equal(built.unmatched.length, 9, "(氏名, 会派) の組では 9 行");

  const dir = await mkdtemp(join(tmpdir(), "gl750-"));
  await writeLocalAssembly(dir, built, { national: [] });
  assert.deepEqual(await validateLocalAssemblies(dir), [], "契約違反が 0 件");
  // **書いたものが読み返せる**（meta.json に出典が全部ある）
  const meta = JSON.parse(await readFile(join(dir, "assemblies", "pref-02", "meta.json"), "utf-8"));
  assert.equal(meta.assemblyId, "pref-02");
  assert.equal(meta.sources.length, run.sources.length);
});

/**
 * **`lossyNameMatches` が `meta.json` に出る**（#749 の機序 ②。第300回）。
 * **この会期を含めて回すと、`引 ユキ子` の 1 行が残る。**
 */
test("#750 meta.lossyNameMatches: 字が落ちたまま寄った氏名が残る（第300回）", async () => {
  // 第300回（2019-11）は index の新しい順で 29 番目
  const run = await runAomori({ sessions: 29, fetchedAt: FETCHED_AT, fetcher: fetcher() });
  assert.deepEqual(run.sessions.map((s) => s.sessionId), ["2025-06", "2023-07", "2019-11"], "フィクスチャにある 3 本ぶん読めた");
  const built = buildLocalAssembly({
    assembly: AOMORI_ASSEMBLY, members: run.roster.members, rollCalls: run.rollCalls, fetchedAt: FETCHED_AT,
    rosterAsOf: run.roster.asOf, sources: run.sources, sessions: run.sessions, unmatched: run.unmatched,
    unreadableSources: run.unreadableSources,
  });
  // **#778 でここは共通層（`lossyNameMatchesOf`）が数えるようになった。**
  // **青森の `run` は渡していない**——**渡さなくても出ることがこの検査の要点である。**
  assert.deepEqual(built.meta.lossyNameMatches, [{
    nameText: "引 ユキ子", memberId: "p_02_giin_kushibiki-yukiko", rosterName: "櫛󠄁引 ユキ子", rollCalls: 46,
  }]);
  assert.equal(built.meta.counts.rollcalls, 23 + 21 + 46);
  const dir = await mkdtemp(join(tmpdir(), "gl750b-"));
  await writeLocalAssembly(dir, built, { national: [] });
  assert.deepEqual(await validateLocalAssemblies(dir), []);
});

test("#750 runAomori: 会期が 1 つも読めなければ例外（空の data/ を書かない）", async () => {
  const f: Fetcher = {
    async text(url: string) {
      if (url === AOMORI_ROSTER_URL) return fixture("giin-kaiha.html").toString("utf-8");
      if (url === AOMORI_DISTRICT_URL) return fixture("giin-senkyoku.html").toString("utf-8");
      return fixture("katsudo-shinsakekka.html").toString("utf-8");
    },
    async bytes() { throw new Error("PDF has no text layer (image PDF)"); },
  };
  await assert.rejects(() => runAomori({ sessions: 2, fetchedAt: FETCHED_AT, fetcher: f }), /no roll calls read from any session/);
});
