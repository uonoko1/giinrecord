import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assembly, LocalMember, LocalRollCall } from "@seiji-kiroku/shared";
import { buildLocalAssembly, validateLocalAssemblies, writeLocalAssembly, MIYAGI_ASSEMBLY } from "../src/local-assemblies.ts";
import { stableJson } from "../src/json.ts";
import { validateDataset, writeDataset, dietAssemblies } from "../src/dataset.ts";

// 地方議会の出力（Issue #157 / #158）: data/assemblies/{assemblyId}/{meta.json, sessions.json, rollcalls/, unmatched.json}、
// assemblies/index.json の行、そして Web が読む members/index.json・members/{id}.json（timeline は localVote）。
// 国会の日次 ETL（writeDataset）は assemblies/index.json・members/index.json を書き直すが、地方議会の行を消してはいけない。

const member = (id: string, name: string, group = "自由民主党・県民会議"): LocalMember => ({
  id, assemblyId: "pref-04", name, kana: "かな", group, district: "宮城", profileUrl: "https://www.pref.miyagi.jp/site/kengikai/x.html",
  current: true, asOf: "2026-04-23", sourceUrl: "https://www.pref.miyagi.jp/site/kengikai/18meibo-kaiha.html", counts: { rollcalls: 0 },
});
const PDF = "https://www.pref.miyagi.jp/documents/62682/hyouketsu071217.pdf";
const rollCall = (id: string, date: string, votes: LocalRollCall["votes"]): LocalRollCall => ({
  id, assemblyId: "pref-04", sessionId: "398", sessionLabel: "令和7年11月定例会（第398回）", date, kind: "発議案", number: "8",
  title: "条例", method: { raw: "起立", legend: "起立採決" }, result: "可決", counts: { present: 2, voting: 1, yes: 1, no: 0 }, votes, page: 1, sourceUrl: PDF,
});
const yes = { raw: "○", legend: "賛成", mapped: "賛成" as const };
const chair = { raw: "議", legend: "議長", mapped: "投票なし" as const };

test("buildLocalAssembly: 議員ごとの timeline（新しい順）と counts、名寄せできない氏名は unmatched に（memberId は空）", () => {
  const members = [member("p_04_a", "柚木 貴光"), member("p_04_b", "佐々木 幸士")];
  const rcs = [
    rollCall("pref-04-398-20251217-発議案-8", "2025-12-17", [
      { memberId: "p_04_a", nameText: "柚木 貴光", group: "自由民主党・県民会議", value: yes },
      { memberId: "p_04_b", nameText: "佐々木幸士", group: "自由民主党・県民会議", value: chair },
      { memberId: "", nameText: "辞職 太郎", group: "自由民主党・県民会議", value: yes },
    ]),
    rollCall("pref-04-398-20251218-発議案-9", "2025-12-18", [
      { memberId: "p_04_a", nameText: "柚木 貴光", group: "自由民主党・県民会議", value: yes },
      { memberId: "p_04_b", nameText: "佐々木幸士", group: "自由民主党・県民会議", value: chair },
      { memberId: "", nameText: "辞職 太郎", group: "自由民主党・県民会議", value: yes },
    ]),
  ];
  const built = buildLocalAssembly({ assembly: MIYAGI_ASSEMBLY, members, rollCalls: rcs, fetchedAt: "2026-08-24T00:00:00.000Z", rosterAsOf: "2026-04-23", sources: [], sessions: [] });
  assert.equal(built.index.length, 2);
  assert.equal(built.index[0].counts.rollcalls, 2);
  const a = built.details.find((d) => d.id === "p_04_a")!;
  assert.equal(a.timeline.length, 2);
  assert.equal(a.timeline[0].rollCallId, "pref-04-398-20251218-発議案-9");
  assert.deepEqual(a.timeline[1], {
    kind: "localVote", date: "2025-12-17", rollCallId: "pref-04-398-20251217-発議案-8", title: "条例",
    vote: yes, sessionLabel: "令和7年11月定例会（第398回）", method: "起立", result: "可決", sourceUrl: PDF,
  });
  assert.deepEqual(a.terms, [{ group: "自由民主党・県民会議", district: "宮城", asOf: "2026-04-23" }], "Web の議員ページは terms の group / district を出す");
  assert.ok(!("house" in a) && !("house" in built.index[0]), "地方議員は house（国会の院）を持たない");
  assert.deepEqual(built.unmatched, [{ nameText: "辞職 太郎", group: "自由民主党・県民会議", rollCallIds: ["pref-04-398-20251217-発議案-8", "pref-04-398-20251218-発議案-9"] }]);
  assert.equal(built.rollCallIndex[0].id, "pref-04-398-20251218-発議案-9", "rollcalls/index.json は新しい順");
  assert.ok(!("votes" in built.rollCallIndex[0]));
  assert.deepEqual(built.meta.counts, { members: 2, rollcalls: 2, cells: 6, unknownCells: 0, unmatchedNames: 1 });
});

test("writeLocalAssembly + validateLocalAssemblies: 契約どおりのパスに stableJson で書き、違反 0", async () => {
  const dir = await mkdtemp(join(tmpdir(), "giinrecord-local-"));
  const members = [member("p_04_a", "柚木 貴光")];
  const rcs = [rollCall("pref-04-398-20251217-発議案-8", "2025-12-17", [{ memberId: "p_04_a", nameText: "柚木 貴光", group: "自由民主党・県民会議", value: yes }])];
  rcs[0].counts = { present: 1, voting: 1, yes: 1, no: 0 };
  const built = buildLocalAssembly({ assembly: MIYAGI_ASSEMBLY, members, rollCalls: rcs, fetchedAt: "2026-08-24T00:00:00.000Z", rosterAsOf: "2026-04-23", sources: [], sessions: [{ sessionId: "398", sessionLabel: "令和7年11月定例会（第398回）", sourceUrl: "https://www.pref.miyagi.jp/site/kengikai/hyoketu071217.html", pdfUrl: PDF, rollcalls: 1, unknownCells: 0 }] });
  await writeLocalAssembly(dir, built, { national: dietAssemblies(221) });
  const index = JSON.parse(await readFile(join(dir, "assemblies", "index.json"), "utf8")) as Assembly[];
  assert.deepEqual(index, [...dietAssemblies(221), MIYAGI_ASSEMBLY], "国会の 2 行が無ければ補い、その後に地方議会の行");
  // 2 回目は既存の行（国会の 2 行）を残して自分の行だけ入れ替える
  await writeLocalAssembly(dir, built);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "assemblies", "index.json"), "utf8")), [...dietAssemblies(221), MIYAGI_ASSEMBLY]);
  const text = await readFile(join(dir, "assemblies", "pref-04", "rollcalls", "398", "pref-04-398-20251217-発議案-8.json"), "utf8");
  assert.equal(text, stableJson(rcs[0]));
  // Web が読む形（#158）: members/index.json と members/{id}.json、assemblies/{id}/sessions.json
  const memberIndex = JSON.parse(await readFile(join(dir, "members", "index.json"), "utf8")) as LocalMember[];
  assert.deepEqual(memberIndex.map((m) => m.id), ["p_04_a"]);
  const detail = JSON.parse(await readFile(join(dir, "members", "p_04_a.json"), "utf8")) as { timeline: { kind: string }[] };
  assert.equal(detail.timeline[0].kind, "localVote");
  assert.deepEqual(JSON.parse(await readFile(join(dir, "assemblies", "pref-04", "sessions.json"), "utf8")), [
    { id: "398", label: "令和7年11月定例会（第398回）", date: "2025-12-17", rollcalls: 1, sourceUrl: "https://www.pref.miyagi.jp/site/kengikai/hyoketu071217.html", fetchedAt: "2026-08-24T00:00:00.000Z" },
  ]);
  assert.ok(await readFile(join(dir, "assemblies", "pref-04", "rollcalls", "index.json"), "utf8"));
  assert.ok(await readFile(join(dir, "assemblies", "pref-04", "meta.json"), "utf8"));
  assert.ok(await readFile(join(dir, "assemblies", "pref-04", "unmatched.json"), "utf8"));
  assert.deepEqual(await validateLocalAssemblies(dir), []);
});

test("validateLocalAssemblies: sourceUrl のホストが議会の公式ホストでない・凡例の無い値・議員数×議案数≠セル数・index に無い memberId を違反にする", async () => {
  const dir = await mkdtemp(join(tmpdir(), "giinrecord-local-"));
  const members = [member("p_04_a", "柚木 貴光")];
  const rcs = [rollCall("pref-04-398-20251217-発議案-8", "2025-12-17", [{ memberId: "p_04_a", nameText: "柚木 貴光", group: "自由民主党・県民会議", value: yes }])];
  rcs[0].counts = { present: 1, voting: 1, yes: 1, no: 0 };
  const built = buildLocalAssembly({ assembly: MIYAGI_ASSEMBLY, members, rollCalls: rcs, fetchedAt: "2026-08-24T00:00:00.000Z", rosterAsOf: "2026-04-23", sources: [], sessions: [] });
  await writeLocalAssembly(dir, built);
  const rel = join(dir, "assemblies", "pref-04", "rollcalls", "398", "pref-04-398-20251217-発議案-8.json");
  const bad: LocalRollCall = {
    ...rcs[0],
    sourceUrl: "https://example.com/x.pdf",
    votes: [
      { memberId: "p_04_zzz", nameText: "誰か", group: "g", value: { raw: "○", legend: "" } },
      { memberId: "p_04_a", nameText: "柚木 貴光", group: "g", value: { raw: "不明", legend: "抽出不能", mapped: "賛成" } },
    ],
  };
  await writeFile(rel, stableJson(bad));
  const v = await validateLocalAssemblies(dir);
  assert.ok(v.some((l) => /sourceUrl host/.test(l)), v.join("\n"));
  assert.ok(v.some((l) => /legend/.test(l)), v.join("\n"));
  assert.ok(v.some((l) => /p_04_zzz/.test(l)), v.join("\n"));
  assert.ok(v.some((l) => /cells/.test(l)), v.join("\n"));
  assert.ok(v.some((l) => /mapped/.test(l)), v.join("\n"));
});

test("writeLocalAssembly: members/index.json は国会の行を残し、自分の議会の行だけ入れ替える（名簿から消えた人の detail も消す）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "giinrecord-local-"));
  await mkdir(join(dir, "members"), { recursive: true });
  const diet = { id: "m_x", name: "国会 太郎", kana: "こっかい たろう", house: "sangiin", assemblyId: "diet-sangiin", group: "g", district: "d", current: true, counts: { rollcalls: 0, bills: 0, speeches: 0, questions: 0 } };
  await writeFile(join(dir, "members", "index.json"), stableJson([diet]));
  await writeFile(join(dir, "members", "m_x.json"), stableJson({ ...diet, terms: [], timeline: [] }));
  const rcs = [rollCall("pref-04-398-20251217-発議案-8", "2025-12-17", [{ memberId: "p_04_a", nameText: "柚木 貴光", group: "自由民主党・県民会議", value: yes }])];
  rcs[0].counts = { present: 1, voting: 1, yes: 1, no: 0 };
  const input = { assembly: MIYAGI_ASSEMBLY, rollCalls: rcs, fetchedAt: "2026-08-24T00:00:00.000Z", rosterAsOf: "2026-04-23", sources: [], sessions: [{ sessionId: "398", sessionLabel: "令和7年11月定例会（第398回）", sourceUrl: "https://www.pref.miyagi.jp/site/kengikai/hyoketu071217.html", pdfUrl: PDF, rollcalls: 1, unknownCells: 0 }] };
  await writeLocalAssembly(dir, buildLocalAssembly({ ...input, members: [member("p_04_b", "引退 花子"), member("p_04_a", "柚木 貴光")] }), { national: dietAssemblies(221) });
  let ids = (JSON.parse(await readFile(join(dir, "members", "index.json"), "utf8")) as { id: string }[]).map((m) => m.id);
  assert.deepEqual(ids, ["m_x", "p_04_a", "p_04_b"], "国会の行 → 地方の行（id 順）");
  await writeLocalAssembly(dir, buildLocalAssembly({ ...input, members: [member("p_04_a", "柚木 貴光")] }));
  ids = (JSON.parse(await readFile(join(dir, "members", "index.json"), "utf8")) as { id: string }[]).map((m) => m.id);
  assert.deepEqual(ids, ["m_x", "p_04_a"]);
  await assert.rejects(readFile(join(dir, "members", "p_04_b.json")), "名簿から消えた人の detail は消す");
  assert.ok(await readFile(join(dir, "members", "m_x.json"), "utf8"), "国会の detail は触らない");
  assert.deepEqual(await validateLocalAssemblies(dir), []);
});

test("writeDataset（国会の日次 ETL）は assemblies/index.json の地方議会の行を残す。地方の行が無ければ国会の 2 行だけ（byte-identical）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "giinrecord-local-"));
  await mkdir(join(dir, "assemblies"), { recursive: true });
  await writeFile(join(dir, "assemblies", "index.json"), stableJson([...dietAssemblies(221), MIYAGI_ASSEMBLY]));
  await mkdir(join(dir, "members"), { recursive: true });
  const local = member("p_04_a", "柚木 貴光");
  await writeFile(join(dir, "members", "index.json"), stableJson([local]));
  await writeFile(join(dir, "members", "p_04_a.json"), stableJson({ ...local, terms: [{ group: local.group, district: local.district, asOf: local.asOf }], timeline: [] }));
  await mkdir(join(dir, "assemblies", "pref-04"), { recursive: true });
  for (const [rel, value] of [["meta.json", { assemblyId: "pref-04", fetchedAt: "x", sources: [], rosterAsOf: "2026-04-23", sessions: [], counts: { members: 1, rollcalls: 0, cells: 0, unknownCells: 0, unmatchedNames: 0 } }], ["sessions.json", []], ["unmatched.json", []], ["rollcalls/index.json", []]] as const) {
    await mkdir(join(dir, "assemblies", "pref-04", rel, ".."), { recursive: true });
    await writeFile(join(dir, "assemblies", "pref-04", rel), stableJson(value));
  }
  const ds = {
    assemblies: dietAssemblies(221), index: [], details: [], speeches: [], rollCalls: [], rollCallDetails: [], bills: [],
    unmatched: [], unmatchedBills: [], unmatchedGroups: [], groupMismatch: [],
    meta: { fetchedAt: "2026-08-24T00:00:00.000Z", sources: [], sessions: [221] },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await writeDataset(dir, ds as any);
  const index = JSON.parse(await readFile(join(dir, "assemblies", "index.json"), "utf8")) as Assembly[];
  assert.deepEqual(index.map((a) => a.id), ["diet-sangiin", "diet-shugiin", "pref-04"]);
  assert.deepEqual((JSON.parse(await readFile(join(dir, "members", "index.json"), "utf8")) as { id: string }[]).map((m) => m.id), ["p_04_a"], "members/index.json の地方議員の行を残す");
  const dir2 = await mkdtemp(join(tmpdir(), "giinrecord-local-"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await writeDataset(dir2, ds as any);
  assert.equal(await readFile(join(dir2, "assemblies", "index.json"), "utf8"), stableJson(dietAssemblies(221)));
  assert.equal(await readFile(join(dir2, "members", "index.json"), "utf8"), stableJson([]));
  // validateDataset は地方議会のディレクトリも検査する（無ければ違反にしない）
  const v = await validateDataset(dir);
  assert.ok(!v.some((l) => /pref-04/.test(l)), v.filter((l) => /pref-04/.test(l)).join("\n"));
});
