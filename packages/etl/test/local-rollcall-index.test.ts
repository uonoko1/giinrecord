import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalMember, LocalRollCall, LocalRollCallSummary } from "@seiji-kiroku/shared";
import { buildLocalAssembly, rollCallIndexOf, validateLocalAssemblies, writeLocalAssembly, MIYAGI_ASSEMBLY } from "../src/local-assemblies.ts";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { stableJson } from "../src/json.ts";

/**
 * **`rollcalls/index.json` は採決の原本（`rollcalls/{sessionId}/{id}.json`）と食い違ってはいけない**（Issue #851）。
 *
 * ## 何が起きていたか（**本番で利用者に見えていた**）
 *
 * **#829 / PR #840 が秋田の `counts` 7 件を埋めた。個別ファイルと `meta.json` は直った。
 * だが `rollcalls/index.json` は更新されず、本番の採決ページは `index.json` を読むので、
 * 公表されている人数が「人数は公表記録にありません」と表示され続けた。**
 *
 * **これは #569 の「記録が出ない」側だが、それより悪い**——
 * **「公表記録にありません」は事実と違う。公表記録にはある。我々が反映していないだけで、
 * 利用者からは検出できない。**
 *
 * ## **なぜ既存の検査が捕まえなかったか**
 *
 * **#842 は `meta.json` ↔ `rollcalls/` を突き合わせている。#840 は両方を直したので、その検算は通った。**
 * **`index.json` は誰も突き合わせていなかった**——
 * **「2 つを突き合わせる検査は、3 つ目を見ていない」**（#774「独立でも互いの代わりにならない」と同じ形）。
 *
 * **加えて `validateLocalAssemblies` は `index.json` の行の形（出典・並び）しか見ておらず、
 * 同じループで原本も読んでいたのに、両者の中身を比べていなかった**（`id` / `assemblyId` だけ見ていた）。
 */

const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));
const PDF = "https://www.pref.miyagi.jp/documents/62682/hyouketsu071217.pdf";
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const walk = async (dir: string): Promise<string[]> => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(async (e) =>
  e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".json") && e.name !== "index.json" ? [join(dir, e.name)] : []))).flat();

/**
 * **本丸**: **公表した `index.json` は、公表した原本から作り直したものと一致する**。
 * **原本のほうを正とする**——票が一次資料に最も近い形だから。
 */
test("#851 公表した rollcalls/index.json は、公表した採決の原本から作り直したものと一致する（11 県）", async () => {
  const prefs = (await readdir(join(DATA, "assemblies"), { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name.startsWith("pref-")).map((e) => e.name).sort();
  assert.equal(prefs.length, 11, "11 県ぶんを見ていること");
  let rows = 0;
  for (const p of prefs) {
    const rollCalls: LocalRollCall[] = [];
    for (const f of (await walk(join(DATA, "assemblies", p, "rollcalls"))).sort(cmp)) rollCalls.push(JSON.parse(await readFile(f, "utf8")));
    const index = JSON.parse(await readFile(join(DATA, "assemblies", p, "rollcalls", "index.json"), "utf8")) as LocalRollCallSummary[];
    // **行ごとに比べる**（1 行ずれたときに、どの採決かを名指しできるように）
    assert.equal(index.length, rollCalls.length, `${p}: index の件数と原本のファイル数`);
    const expected = rollCallIndexOf(rollCalls);
    for (let i = 0; i < expected.length; i++) {
      assert.deepEqual(index[i], expected[i], `${p}/rollcalls/index.json[${i}] (${expected[i].id}) が原本と食い違っている`);
      rows++;
    }
  }
  // **母数はいつも出す**（「0 件」は「見た上での 0」でなければ意味が無い。#757）
  // **#901 で三重を 365 → 733 本にしたので 1,369 → 1,737**（動いたのは pref-24 だけ）
  assert.equal(rows, 1_737, "**11 県で 1,737 行を突き合わせた**（2026-09-20 実測）");
});

/**
 * **`counts` は index にも原本にも同じだけ出ている**（#851 の直接の症状を数字で固定する）。
 *
 * **秋田は 157 / 157 本に `counts` がある**（#840 が 7 件を埋めた後の値）。
 * **`index.json` だけが 150 / 157 だった。**
 */
test("#851 counts を持つ採決の数は index と原本で一致する（11 県。秋田は 157/157）", async () => {
  const prefs = (await readdir(join(DATA, "assemblies"), { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name.startsWith("pref-")).map((e) => e.name).sort();
  const got: Record<string, number> = {};
  for (const p of prefs) {
    const rollCalls: LocalRollCall[] = [];
    for (const f of await walk(join(DATA, "assemblies", p, "rollcalls"))) rollCalls.push(JSON.parse(await readFile(f, "utf8")));
    const index = JSON.parse(await readFile(join(DATA, "assemblies", p, "rollcalls", "index.json"), "utf8")) as LocalRollCallSummary[];
    const inIndex = index.filter((s) => s.counts !== undefined).length;
    const inFiles = rollCalls.filter((rc) => rc.counts !== undefined).length;
    assert.equal(inIndex, inFiles, `${p}: counts を持つ採決が index に ${inIndex} 本、原本に ${inFiles} 本`);
    got[p] = inIndex;
  }
  // **2026-09-20 実測**（`counts` の欄が無い県は 0。奈良・高知・徳島は PDF に人数欄が無い）。
  // **#901 で三重が 365 → 733**（三重は全行に `counts` があるので採決の本数と同じ）
  assert.deepEqual(got, {
    "pref-02": 113, "pref-04": 133, "pref-05": 157, "pref-24": 733, "pref-25": 14,
    "pref-29": 0, "pref-31": 118, "pref-32": 112, "pref-36": 0, "pref-39": 0, "pref-41": 23,
  });
});

const member = (id: string, name: string): LocalMember => ({
  id, assemblyId: "pref-04", name, kana: "かな", group: "会派", district: "宮城",
  profileUrl: "https://www.pref.miyagi.jp/site/kengikai/x.html", current: true, asOf: "2026-04-23",
  sourceUrl: "https://www.pref.miyagi.jp/site/kengikai/18meibo-kaiha.html", counts: { rollcalls: 0 },
});
const rollCall = (id: string, date: string, counts?: LocalRollCall["counts"]): LocalRollCall => ({
  id, assemblyId: "pref-04" as LocalRollCall["assemblyId"], sessionId: "398",
  sessionLabel: "令和7年11月定例会（第398回）", date, kind: "発議案", number: id.slice(-1),
  title: "条例", result: "可決", page: 1,
  sourceUrl: PDF,
  ...(counts ? { counts } : {}),
  votes: [{ memberId: "p_04_a", nameText: "山田太郎", group: "会派", value: { raw: "○", legend: "賛成", mapped: "賛成" } }],
});

const setup = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "gikailog-851-"));
  const built = buildLocalAssembly({
    assembly: MIYAGI_ASSEMBLY, fetchedAt: "2026-04-23T00:00:00.000Z", rosterAsOf: "2026-04-23",
    sources: [],
    sessions: [{ sessionId: "398", sessionLabel: "令和7年11月定例会（第398回）", sourceUrl: "https://www.pref.miyagi.jp/site/kengikai/hyoketu071217.html", pdfUrl: PDF, rollcalls: 2, unknownCells: 0 }],
    members: [member("p_04_a", "山田太郎")],
    rollCalls: [rollCall("pref-04-a", "2025-12-17", { yes: 1, no: 0 }), rollCall("pref-04-b", "2025-12-16", { yes: 1, no: 0 })],
  });
  await writeLocalAssembly(dir, built);
  return dir;
};

const indexPath = (dir: string) => join(dir, "assemblies", "pref-04", "rollcalls", "index.json");

test("#851 無改造: 書いたばかりの data/ は違反 0（否定的対照）", async () => {
  const dir = await setup();
  assert.deepEqual(await validateLocalAssemblies(dir), []);
});

test("#851 index.json の counts を 1 件消すと validateLocalAssemblies が違反にする（本丸）", async () => {
  const dir = await setup();
  const index = JSON.parse(await readFile(indexPath(dir), "utf8")) as LocalRollCallSummary[];
  delete index[0].counts;
  await writeFile(indexPath(dir), stableJson(index));
  const v = await validateLocalAssemblies(dir);
  assert.ok(v.some((x) => /rollcalls\/index\.json\[0\].*原本と食い違っている/.test(x)), v.join("\n"));
});

test("#851 index.json に原本と違う counts を入れると違反にする", async () => {
  const dir = await setup();
  const index = JSON.parse(await readFile(indexPath(dir), "utf8")) as LocalRollCallSummary[];
  index[0].counts = { yes: 99, no: 0 };
  await writeFile(indexPath(dir), stableJson(index));
  const v = await validateLocalAssemblies(dir);
  assert.ok(v.some((x) => /rollcalls\/index\.json\[0\].*原本と食い違っている/.test(x)), v.join("\n"));
});

test("#851 index.json の title を原本と変えると違反にする（counts 以外の欄も見ている）", async () => {
  const dir = await setup();
  const index = JSON.parse(await readFile(indexPath(dir), "utf8")) as LocalRollCallSummary[];
  index[0].title = "別の件名";
  await writeFile(indexPath(dir), stableJson(index));
  const v = await validateLocalAssemblies(dir);
  assert.ok(v.some((x) => /rollcalls\/index\.json\[0\].*原本と食い違っている/.test(x)), v.join("\n"));
});

/** **原本にあるのに index に無い**＝「記録が出ない」側。**index を辿るだけでは見つからない。** */
test("#851 原本にある採決が index.json から落ちていると違反にする", async () => {
  const dir = await setup();
  const index = JSON.parse(await readFile(indexPath(dir), "utf8")) as LocalRollCallSummary[];
  const dropped = index[1].id;
  await writeFile(indexPath(dir), stableJson(index.slice(0, 1)));
  const v = await validateLocalAssemblies(dir);
  assert.ok(v.some((x) => x.includes(`${dropped} が原本にあるのに index に無い`)), v.join("\n"));
});

/** **`rollCallIndexOf` は単体でも使える**（作る側と検算する側が同じ関数を共有している根拠）。 */
test("#851 rollCallIndexOf は votes を落とし、日付の降順に並べる", () => {
  const out = rollCallIndexOf([rollCall("pref-04-b", "2025-12-16"), rollCall("pref-04-a", "2025-12-17", { yes: 1, no: 0 })]);
  assert.deepEqual(out.map((s) => s.id), ["pref-04-a", "pref-04-b"]);
  assert.equal("votes" in out[0], false);
  assert.deepEqual(out[0].counts, { yes: 1, no: 0 });
  assert.equal(out[1].counts, undefined, "原本に counts が無ければ index にも無い（推定で埋めない。#569）");
});

/** **`buildLocalAssembly` の `rollCallIndex` は `rollCallIndexOf` そのもの**（写しではない）。 */
test("#851 buildLocalAssembly の rollCallIndex は rollCallIndexOf(rollCalls) と一致する", () => {
  const built = buildLocalAssembly({
    assembly: MIYAGI_ASSEMBLY, fetchedAt: "2026-04-23T00:00:00.000Z", rosterAsOf: "2026-04-23",
    sources: [],
    sessions: [{ sessionId: "398", sessionLabel: "令和7年11月定例会（第398回）", sourceUrl: "https://www.pref.miyagi.jp/site/kengikai/hyoketu071217.html", pdfUrl: PDF, rollcalls: 2, unknownCells: 0 }],
    members: [member("p_04_a", "山田太郎")],
    rollCalls: [rollCall("pref-04-b", "2025-12-16"), rollCall("pref-04-a", "2025-12-17", { yes: 1, no: 0 })],
  });
  assert.deepEqual(built.rollCallIndex, rollCallIndexOf(built.rollCalls));
});
