import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import type { Assembly, Bill, BillSummary, MemberSummary, RollCall, RollCallSummary } from "@seiji-kiroku/shared";
import { buildDataset } from "../src/aggregate.ts";
import { DIET_ASSEMBLY_IDS, dietAssemblies, readSessionsOnDisk, resolveSessions, writeDataset, validateDataset, type Dataset } from "../src/dataset.ts";
import { stableJson } from "../src/json.ts";
import { matchVotes } from "../src/match-votes.ts";
import { parseRollCall } from "../src/sources/sangiin-votes.ts";
import { parseMemberList } from "../src/sources/sangiin-members.ts";
import { parseShugiinBill } from "../src/sources/shugiin-bills.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.htm`, import.meta.url), "utf-8");
const BASE = "https://www.sangiin.go.jp/japanese/touhyoulist/221";
const KEIKA = "https://www.shugiin.go.jp/internet/itdb_gian.nsf/html/gian/keika";
/** 実HTML（Shift_JIS）の衆院 経過ページから作る Bill。 */
const realBill = (id: string, status?: string): Bill =>
  parseShugiinBill(iconv.decode(readFileSync(new URL(`./fixtures/shugiin-keika-${id}.htm`, import.meta.url)), "Shift_JIS"), `${KEIKA}/${id}.htm`, { status });
const ROSTER = "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/221/giin.htm";

/** 実在する議員（m_007006）と採決で作る group-mismatch の1行（Issue #24）。 */
const MISMATCH = { memberId: "m_007006", nameText: "テスト 太郎", voteGroup: "れいわ新選組", rosterGroup: "いのちの党", rollCallId: "221-0605-v001" };

function realDataset(): Dataset {
  const members = parseMemberList(fixture("sangiin-giin-221"), ROSTER, 221);
  const rollCalls = ["221-0605-v001", "221-0724-v001"].map((id) => matchVotes(parseRollCall(fixture(id), `${BASE}/${id}.htm`, 221), members).rollCall);
  return {
    ...buildDataset(members, rollCalls),
    assemblies: dietAssemblies(221),
    rollCallDetails: rollCalls,
    bills: [realBill("1DE153E", "衆議院で閉会中審査"), realBill("1DE14D6", "成立"), realBill("1DE115E", "衆議院で閉会中審査")],
    unmatched: [],
    unmatchedBills: [{ rollCallId: "221-0724-v001", title: rollCalls[1].title, sourceUrl: rollCalls[1].sourceUrl }],
    unmatchedGroups: [{ group: "新党", memberIds: ["m_000001"], sourceUrl: ROSTER }],
    groupMismatch: [MISMATCH],
    meta: { fetchedAt: "2026-08-22T00:00:00.000Z", sessions: [221], sources: [{ name: "参議院 議員一覧", url: ROSTER, fetchedAt: "2026-08-22T00:00:00.000Z" }] },
  };
}

const readJson = <T,>(dir: string, rel: string): T => JSON.parse(readFileSync(join(dir, rel), "utf-8")) as T;
const patch = <T,>(dir: string, rel: string, f: (v: T) => unknown) => writeFileSync(join(dir, rel), stableJson(f(readJson<T>(dir, rel))));

describe("writeDataset / validateDataset: docs/DATA_CONTRACT.md の不変条件", () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "seiji-dataset-"));
    await writeDataset(dir, realDataset());
  });
  const cleanup = () => rmSync(dir, { recursive: true, force: true });

  test("書き出した直後のデータセットは違反なし", async () => {
    assert.deepEqual(await validateDataset(dir), []);
    cleanup();
  });

  test("契約どおりのファイル一式を書く（キーソート・末尾改行）", () => {
    for (const rel of ["meta.json", "assemblies/index.json", "members/index.json", "members/m_007006.json", "rollcalls/index.json", "rollcalls/221/221-0605-v001.json", "bills/index.json", "bills/221/221-衆法-1.json", "bills/219/219-決算-1DE115E.json", "unmatched.json", "unmatched-bills.json", "unmatched-groups.json", "group-mismatch.json"]) {
      const text = readFileSync(join(dir, rel), "utf-8");
      assert.equal(text, stableJson(JSON.parse(text)), rel);
    }
    cleanup();
  });

  test("assemblies/index.json: 国会の2議会（diet-sangiin / diet-shugiin）を kind: national・出典付きで書く（#156）", () => {
    const list = readJson<Assembly[]>(dir, "assemblies/index.json");
    assert.deepEqual(list.map((a) => a.id), ["diet-sangiin", "diet-shugiin"]);
    assert.deepEqual(DIET_ASSEMBLY_IDS, { sangiin: "diet-sangiin", shugiin: "diet-shugiin" });
    for (const a of list) {
      assert.equal(a.kind, "national");
      assert.match(a.sourceUrl, /^https:\/\/www\.(sangiin|shugiin)\.go\.jp\//);
      assert.equal(a.prefCode, undefined);
    }
    assert.equal(list[0].name, "参議院");
    assert.equal(list[1].name, "衆議院");
    cleanup();
  });

  test("members/index.json と members/{id}.json の全員に assemblyId が付く（国会は diet-sangiin。既存項目はそのまま）", () => {
    const idx = readJson<MemberSummary[]>(dir, "members/index.json");
    assert.ok(idx.length > 0);
    for (const m of idx) assert.equal(m.assemblyId, "diet-sangiin", m.id);
    assert.equal(readJson<{ assemblyId: string }>(dir, "members/m_007006.json").assemblyId, "diet-sangiin");
    cleanup();
  });

  test("assemblies/index.json が無ければ違反", async () => {
    rmSync(join(dir, "assemblies/index.json"));
    assert.match((await validateDataset(dir)).join("\n"), /assemblies\/index\.json: missing/);
    cleanup();
  });

  test("assemblies/index.json の id が重複・kind が national|prefectural|municipal 以外・sourceUrl が不正なら違反", async () => {
    patch<Assembly[]>(dir, "assemblies/index.json", (list) => [...list, { ...list[0], kind: "regional" as never, sourceUrl: "http://example.com/" }]);
    const out = (await validateDataset(dir)).join("\n");
    assert.match(out, /assemblies\/index\.json.*duplicate id diet-sangiin/);
    assert.match(out, /assemblies\/index\.json.*kind.*regional/);
    assert.match(out, /assemblies\/index\.json.*sourceUrl.*example\.com/);
    cleanup();
  });

  test("prefectural / municipal の議会は prefCode が 2 桁の団体コードでなければ違反。国会は prefCode を持たない", async () => {
    patch<Assembly[]>(dir, "assemblies/index.json", (list) => [
      ...list.map((a) => (a.id === "diet-shugiin" ? { ...a, prefCode: "13" } : a)),
      { id: "pref-04", kind: "prefectural", name: "宮城県議会", sourceUrl: "https://www.pref.miyagi.jp/" },
      { id: "city-33100", kind: "municipal", name: "岡山市議会", prefCode: "033", sourceUrl: "https://www.city.okayama.jp/" },
    ]);
    const out = (await validateDataset(dir)).join("\n");
    assert.match(out, /diet-shugiin.*prefCode/);
    assert.match(out, /pref-04.*prefCode/);
    assert.match(out, /city-33100.*prefCode/);
    cleanup();
  });

  test("member の assemblyId が assemblies/index.json に無ければ違反", async () => {
    patch<MemberSummary[]>(dir, "members/index.json", (idx) => idx.map((m) => (m.id === "m_007006" ? { ...m, assemblyId: "pref-99" } : m)));
    patch<{ assemblyId: string }>(dir, "members/m_007006.json", (d) => ({ ...d, assemblyId: "pref-99" }));
    assert.match((await validateDataset(dir)).join("\n"), /m_007006.*assemblyId pref-99 not in assemblies\/index\.json/);
    cleanup();
  });

  test("国会議員の assemblyId は house と一致（sangiin → diet-sangiin）しなければ違反", async () => {
    patch<MemberSummary[]>(dir, "members/index.json", (idx) => idx.map((m) => (m.id === "m_007006" ? { ...m, assemblyId: "diet-shugiin" } : m)));
    patch<{ assemblyId: string }>(dir, "members/m_007006.json", (d) => ({ ...d, assemblyId: "diet-shugiin" }));
    assert.match((await validateDataset(dir)).join("\n"), /m_007006.*assemblyId diet-shugiin.*house sangiin/);
    cleanup();
  });

  test("index と detail の assemblyId が食い違えば違反。assemblyId を欠けば違反", async () => {
    patch<{ assemblyId?: string }>(dir, "members/m_007006.json", ({ assemblyId: _, ...d }) => d);
    assert.match((await validateDataset(dir)).join("\n"), /members\/m_007006\.json: assemblyId/);
    cleanup();
  });

  test("meta.json は stableJson（キーソート・インデント1・末尾改行）で書かれる（Issue #24）", () => {
    const text = readFileSync(join(dir, "meta.json"), "utf-8");
    assert.equal(text, stableJson(realDataset().meta));
    assert.match(text, /^\{\n "fetchedAt"/);
    cleanup();
  });

  test("group-mismatch.json: 氏名だけで紐づき会派が食い違った票を永続化する（Issue #24）", () => {
    assert.deepEqual(readJson(dir, "group-mismatch.json"), [MISMATCH]);
    cleanup();
  });

  test("group-mismatch.json が無ければ違反", async () => {
    rmSync(join(dir, "group-mismatch.json"));
    assert.match((await validateDataset(dir)).join("\n"), /group-mismatch\.json: missing/);
    cleanup();
  });

  test("group-mismatch.json が配列でなければ違反", async () => {
    patch<unknown>(dir, "group-mismatch.json", () => ({}));
    assert.match((await validateDataset(dir)).join("\n"), /group-mismatch\.json: must be an array/);
    cleanup();
  });

  test("group-mismatch.json の行に memberId/nameText/voteGroup/rosterGroup/rollCallId が揃っていなければ違反", async () => {
    const { voteGroup: _, ...rest } = MISMATCH;
    patch<unknown[]>(dir, "group-mismatch.json", () => [rest]);
    assert.match((await validateDataset(dir)).join("\n"), /group-mismatch\.json\[0\]: voteGroup/);
    cleanup();
  });

  test("group-mismatch.json の memberId が members/index.json に無ければ違反", async () => {
    patch<unknown[]>(dir, "group-mismatch.json", () => [{ ...MISMATCH, memberId: "m_999999" }]);
    assert.match((await validateDataset(dir)).join("\n"), /group-mismatch\.json\[0\].*m_999999/);
    cleanup();
  });

  test("group-mismatch.json の rollCallId が rollcalls/index.json に無ければ違反", async () => {
    patch<unknown[]>(dir, "group-mismatch.json", () => [{ ...MISMATCH, rollCallId: "999-0101-v999" }]);
    assert.match((await validateDataset(dir)).join("\n"), /group-mismatch\.json\[0\].*999-0101-v999/);
    cleanup();
  });

  test("unmatched-groups.json: 対応表に無い会派略称を原文のまま列挙する（Issue #36）", () => {
    assert.deepEqual(readJson(dir, "unmatched-groups.json"), [{ group: "新党", memberIds: ["m_000001"], sourceUrl: ROSTER }]);
    cleanup();
  });

  test("キーが未ソート or 末尾改行なしの JSON は違反", async () => {
    writeFileSync(join(dir, "meta.json"), JSON.stringify(readJson(dir, "meta.json")));
    assert.match((await validateDataset(dir)).join("\n"), /meta\.json.*stableJson/);
    cleanup();
  });

  test("result に得票（賛成 N・反対 N）が含まれていなければ違反（可否だけにしない）", async () => {
    patch<RollCallSummary[]>(dir, "rollcalls/index.json", (list) => list.map((s, i) => (i === 0 ? { ...s, result: "可決" } : s)));
    assert.match((await validateDataset(dir)).join("\n"), /rollcalls\/index\.json\[0\]: result/);
    cleanup();
  });

  test("result が「可決（賛成 N・反対 N）」「賛成 N・反対 N」の形なら違反ではない", async () => {
    patch<RollCallSummary[]>(dir, "rollcalls/index.json", (list) => list.map((s, i) => (i === 0 ? { ...s, result: `可決（${s.result}）` } : s)));
    assert.deepEqual(await validateDataset(dir), []);
    cleanup();
  });

  test("votes[].memberId が members/index.json にない id なら違反", async () => {
    patch<RollCall>(dir, "rollcalls/221/221-0605-v001.json", (rc) => ({ ...rc, votes: [{ ...rc.votes[0], memberId: "m_999999" }, ...rc.votes.slice(1)] }));
    assert.match((await validateDataset(dir)).join("\n"), /m_999999/);
    cleanup();
  });

  test("memberId が空なのに unmatched.json に載っていなければ違反", async () => {
    patch<RollCall>(dir, "rollcalls/221/221-0605-v001.json", (rc) => ({ ...rc, votes: [{ ...rc.votes[0], memberId: "" }, ...rc.votes.slice(1)] }));
    assert.match((await validateDataset(dir)).join("\n"), /unmatched/);
    cleanup();
  });

  test("memberId が空でも unmatched.json に載っていれば違反ではない", async () => {
    const rc = readJson<RollCall>(dir, "rollcalls/221/221-0605-v001.json");
    patch<RollCall>(dir, "rollcalls/221/221-0605-v001.json", (r) => ({ ...r, votes: [{ ...r.votes[0], memberId: "" }, ...r.votes.slice(1)] }));
    patch<unknown[]>(dir, "unmatched.json", () => [{ nameText: rc.votes[0].nameText, group: rc.votes[0].group, rollCallId: rc.id }]);
    // その票は timeline から消えるので、counts と timeline も合わせて更新してから検証する
    patch<{ id: string; counts: { rollcalls: number } }[]>(dir, "members/index.json", (idx) => idx.map((m) => (m.id === rc.votes[0].memberId ? { ...m, counts: { ...m.counts, rollcalls: m.counts.rollcalls - 1 } } : m)));
    patch<{ timeline: { rollCallId?: string }[] }>(dir, `members/${rc.votes[0].memberId}.json`, (d) => ({ ...d, timeline: d.timeline.filter((e) => e.rollCallId !== rc.id) }));
    assert.deepEqual(await validateDataset(dir), []);
    cleanup();
  });

  test("Σ groups[].size !== votes.length なら違反", async () => {
    patch<RollCall>(dir, "rollcalls/221/221-0605-v001.json", (rc) => ({ ...rc, groups: [{ ...rc.groups[0], size: rc.groups[0].size + 1 }, ...rc.groups.slice(1)] }));
    assert.match((await validateDataset(dir)).join("\n"), /groups.*size/);
    cleanup();
  });

  test("timeline が日付降順でなければ違反", async () => {
    patch<{ timeline: unknown[] }>(dir, "members/m_007006.json", (d) => ({ ...d, timeline: [...d.timeline].reverse() }));
    assert.match((await validateDataset(dir)).join("\n"), /m_007006.*timeline/);
    cleanup();
  });

  test("sourceUrl が衆参・NDL 以外のドメインなら違反", async () => {
    patch<{ sourceUrl: string }>(dir, "members/m_007006.json", (d) => ({ ...d, sourceUrl: "https://example.com/x" }));
    assert.match((await validateDataset(dir)).join("\n"), /example\.com/);
    cleanup();
  });

  test("sourceUrl を欠くレコードは違反", async () => {
    patch<{ sourceUrl?: string }[]>(dir, "rollcalls/index.json", (rows) => rows.map(({ sourceUrl: _, ...r }) => r));
    assert.match((await validateDataset(dir)).join("\n"), /rollcalls\/index\.json.*sourceUrl/);
    cleanup();
  });

  test("票の値が 賛成/反対/投票なし 以外（欠席・棄権の区別）なら違反", async () => {
    patch<RollCall>(dir, "rollcalls/221/221-0605-v001.json", (rc) => ({ ...rc, votes: [{ ...rc.votes[0], value: "欠席" as never }, ...rc.votes.slice(1)] }));
    assert.match((await validateDataset(dir)).join("\n"), /欠席/);
    cleanup();
  });

  test("members/index.json の id に対応する members/{id}.json が無ければ違反", async () => {
    rmSync(join(dir, "members/m_007006.json"));
    assert.match((await validateDataset(dir)).join("\n"), /m_007006\.json/);
    cleanup();
  });

  test("counts.speeches が timeline の speech 数と食い違えば違反", async () => {
    patch<{ id: string; counts: { speeches: number } }[]>(dir, "members/index.json", (idx) => idx.map((m) => (m.id === "m_007006" ? { ...m, counts: { ...m.counts, speeches: 99 } } : m)));
    assert.match((await validateDataset(dir)).join("\n"), /m_007006.*counts\.speeches/);
    cleanup();
  });

  test("counts.rollcalls が timeline の vote 数と食い違えば違反", async () => {
    patch<{ id: string; counts: { rollcalls: number } }[]>(dir, "members/index.json", (idx) => idx.map((m) => (m.id === "m_007006" ? { ...m, counts: { ...m.counts, rollcalls: 99 } } : m)));
    assert.match((await validateDataset(dir)).join("\n"), /m_007006.*counts/);
    cleanup();
  });

  test("counts.bills が timeline の bill 数と食い違えば違反", async () => {
    patch<{ id: string; counts: { bills: number } }[]>(dir, "members/index.json", (idx) => idx.map((m) => (m.id === "m_007006" ? { ...m, counts: { ...m.counts, bills: 99 } } : m)));
    assert.match((await validateDataset(dir)).join("\n"), /m_007006.*counts\.bills/);
    cleanup();
  });

  test("bill 行の sourceUrl が参院 議案ページ（kousei/gian/{回次}/meisai/）でなければ違反", async () => {
    const bill = (sourceUrl: string) => ({ kind: "bill", date: "2026-07-30", billId: "221-参法-16", title: "法案", role: "提出者", sourceUrl });
    patch<{ timeline: unknown[] }>(dir, "members/m_007006.json", (d) => ({ ...d, timeline: [bill(`${BASE}/221-0605-v001.htm`), ...d.timeline] }));
    patch<{ id: string; counts: { bills: number } }[]>(dir, "members/index.json", (idx) => idx.map((m) => (m.id === "m_007006" ? { ...m, counts: { ...m.counts, bills: 1 } } : m)));
    assert.match((await validateDataset(dir)).join("\n"), /m_007006.*timeline\[0\].*議案/);
    patch<{ timeline: unknown[] }>(dir, "members/m_007006.json", (d) => ({ ...d, timeline: [bill("https://www.sangiin.go.jp/japanese/joho1/kousei/gian/221/meisai/m221100221016.htm"), ...d.timeline.slice(1)] }));
    assert.deepEqual(await validateDataset(dir), []);
    cleanup();
  });

  test("bill 行の sourceUrl は衆院 経過ページ（gian/keika/）でもよい（#73。衆院議員の提出・賛同）", async () => {
    const bill = { kind: "bill", date: "2026-07-30", billId: "221-衆法-1", title: "法案", role: "賛成者", sourceUrl: `${KEIKA}/1DE153E.htm` };
    patch<{ timeline: unknown[] }>(dir, "members/m_007006.json", (d) => ({ ...d, timeline: [bill, ...d.timeline] }));
    patch<{ id: string; counts: { bills: number } }[]>(dir, "members/index.json", (idx) => idx.map((m) => (m.id === "m_007006" ? { ...m, counts: { ...m.counts, bills: 1 } } : m)));
    assert.deepEqual(await validateDataset(dir), []);
    cleanup();
  });

  test("stance 行（会派態度の推定）は estimated: true・stance は 賛成/反対・sourceUrl は衆院 経過ページ。counts には数えない", async () => {
    const stance = (extra: Record<string, unknown> = {}) => ({ kind: "stance", estimated: true, date: "2026-07-30", billId: "221-閣法-3", title: "法案", group: "日本共産党", stance: "反対", stanceText: "多数", sourceUrl: `${KEIKA}/1DE14D6.htm`, ...extra });
    // stance 行は衆院議員（house=shugiin）にだけ付く。フィクスチャは参院名簿なので house を衆院に差し替えて検証する
    patch<{ house: string; timeline: unknown[] }>(dir, "members/m_007006.json", (d) => ({ ...d, house: "shugiin", timeline: [stance(), ...d.timeline] }));
    assert.deepEqual(await validateDataset(dir), []);
    patch<{ timeline: unknown[] }>(dir, "members/m_007006.json", (d) => ({ ...d, timeline: [stance({ estimated: false }), ...d.timeline.slice(1)] }));
    assert.match((await validateDataset(dir)).join("\n"), /m_007006.*timeline\[0\].*estimated/);
    patch<{ timeline: unknown[] }>(dir, "members/m_007006.json", (d) => ({ ...d, timeline: [stance({ stance: "投票なし" }), ...d.timeline.slice(1)] }));
    assert.match((await validateDataset(dir)).join("\n"), /m_007006.*timeline\[0\].*stance/);
    patch<{ timeline: unknown[] }>(dir, "members/m_007006.json", (d) => ({ ...d, timeline: [stance({ sourceUrl: `${BASE}/221-0605-v001.htm` }), ...d.timeline.slice(1)] }));
    assert.match((await validateDataset(dir)).join("\n"), /m_007006.*timeline\[0\].*経過/);
    cleanup();
  });

  test("stance 行は house=shugiin の議員にだけ許される（参院議員に会派態度の推定は付けない、#88）", async () => {
    const stance = { kind: "stance", estimated: true, date: "2026-07-30", billId: "221-閣法-3", title: "法案", group: "日本共産党", stance: "反対", stanceText: "多数", sourceUrl: `${KEIKA}/1DE14D6.htm` };
    patch<{ timeline: unknown[] }>(dir, "members/m_007006.json", (d) => ({ ...d, timeline: [stance, ...d.timeline] }));
    assert.match((await validateDataset(dir)).join("\n"), /m_007006.*timeline\[0\].*house=shugiin/);
    cleanup();
  });

  test("question 行（質問主意書、#106）: sourceUrl は衆院 経過ページか参院 詳細ページ。counts.questions は timeline の question 数", async () => {
    const SYUISYO = "https://www.sangiin.go.jp/japanese/joho1/kousei/syuisyo/221";
    const question = (extra: Record<string, unknown> = {}) => ({ kind: "question", date: "2026-07-30", questionId: "221-sangiin-1", title: "質問主意書", submitterText: "テスト 太郎君", answerDate: "2026-08-05", answerUrl: `${SYUISYO}/touh/t221001.htm`, sourceUrl: `${SYUISYO}/meisai/m221001.htm`, ...extra });
    const setCounts = (questions: number) => patch<{ id: string; counts: Record<string, number> }[]>(dir, "members/index.json", (idx) => idx.map((m) => (m.id === "m_007006" ? { ...m, counts: { ...m.counts, questions } } : m)));
    patch<{ timeline: unknown[] }>(dir, "members/m_007006.json", (d) => ({ ...d, timeline: [question(), ...d.timeline] }));
    assert.match((await validateDataset(dir)).join("\n"), /m_007006.*counts\.questions/);
    setCounts(1);
    assert.deepEqual(await validateDataset(dir), []);
    patch<{ timeline: unknown[] }>(dir, "members/m_007006.json", (d) => ({ ...d, timeline: [question({ sourceUrl: "https://www.shugiin.go.jp/internet/itdb_shitsumon.nsf/html/shitsumon/221001.htm" }), ...d.timeline.slice(1)] }));
    assert.deepEqual(await validateDataset(dir), []);
    patch<{ timeline: unknown[] }>(dir, "members/m_007006.json", (d) => ({ ...d, timeline: [question({ sourceUrl: `${BASE}/221-0605-v001.htm` }), ...d.timeline.slice(1)] }));
    assert.match((await validateDataset(dir)).join("\n"), /m_007006.*timeline\[0\].*question sourceUrl/);
    patch<{ timeline: unknown[] }>(dir, "members/m_007006.json", (d) => ({ ...d, timeline: [question({ answerUrl: "https://example.com/x" }), ...d.timeline.slice(1)] }));
    assert.match((await validateDataset(dir)).join("\n"), /m_007006.*timeline\[0\].*answerUrl/);
    cleanup();
  });

  test("attendance 行（委員会出席の発議者、#109）: estimated は false・role は 発議者・sourceUrl は会議録（kokkai.ndl.go.jp/txt/）・参院議員だけ。counts には数えない", async () => {
    const attendance = (extra: Record<string, unknown> = {}) => ({ kind: "attendance", estimated: false, date: "2026-07-30", meetingId: "122115007X01420260709_000", meeting: "農林水産委員会 第14号", role: "発議者", bills: [{ billId: "221-参法-11", title: "法律案" }], sourceUrl: "https://kokkai.ndl.go.jp/txt/122115007X01420260709/0", ...extra });
    patch<{ timeline: unknown[] }>(dir, "members/m_007006.json", (d) => ({ ...d, timeline: [attendance(), ...d.timeline] }));
    assert.deepEqual(await validateDataset(dir), []);
    patch<{ timeline: unknown[] }>(dir, "members/m_007006.json", (d) => ({ ...d, timeline: [attendance({ estimated: true }), ...d.timeline.slice(1)] }));
    assert.match((await validateDataset(dir)).join("\n"), /m_007006.*timeline\[0\].*estimated: false/);
    patch<{ timeline: unknown[] }>(dir, "members/m_007006.json", (d) => ({ ...d, timeline: [attendance({ role: "提出者" }), ...d.timeline.slice(1)] }));
    assert.match((await validateDataset(dir)).join("\n"), /m_007006.*timeline\[0\].*role/);
    patch<{ timeline: unknown[] }>(dir, "members/m_007006.json", (d) => ({ ...d, timeline: [attendance({ sourceUrl: `${BASE}/221-0605-v001.htm` }), ...d.timeline.slice(1)] }));
    assert.match((await validateDataset(dir)).join("\n"), /m_007006.*timeline\[0\].*attendance sourceUrl/);
    patch<{ house: string; timeline: unknown[] }>(dir, "members/m_007006.json", (d) => ({ ...d, house: "shugiin", timeline: [attendance(), ...d.timeline.slice(1)] }));
    assert.match((await validateDataset(dir)).join("\n"), /m_007006.*timeline\[0\].*house=sangiin/);
    cleanup();
  });

  test("rollcalls/index.json の行に対応する採決ファイルが無ければ違反", async () => {
    rmSync(join(dir, "rollcalls/221/221-0724-v001.json"));
    assert.match((await validateDataset(dir)).join("\n"), /221-0724-v001\.json/);
    cleanup();
  });

  test("members/index.json に載っていない members/{id}.json（前回実行の残骸）は違反", async () => {
    const d = readJson<{ id: string; sourceUrl: string }>(dir, "members/m_007006.json");
    writeFileSync(join(dir, "members/m_999999.json"), stableJson({ ...d, id: "m_999999", sourceUrl: "https://example.com/x" }));
    assert.match((await validateDataset(dir)).join("\n"), /members\/m_999999\.json.*not in members\/index\.json/);
    cleanup();
  });

  test("rollcalls/index.json に載っていない rollcalls/{session}/{id}.json（前回実行の残骸）は違反", async () => {
    const rc = readJson<RollCall>(dir, "rollcalls/221/221-0605-v001.json");
    writeFileSync(join(dir, "rollcalls/221/221-0101-v999.json"), stableJson({ ...rc, id: "221-0101-v999", votes: [{ ...rc.votes[0], memberId: "m_999999" }] }));
    assert.match((await validateDataset(dir)).join("\n"), /rollcalls\/221\/221-0101-v999\.json.*not in rollcalls\/index\.json/);
    cleanup();
  });

  test("writeDataset は前回の members/ と、今回対象の回次の rollcalls/{session}/ を消してから書く", async () => {
    writeFileSync(join(dir, "members/m_999999.json"), "{}\n");
    writeFileSync(join(dir, "rollcalls/221/221-0101-v999.json"), "{}\n");
    await writeDataset(dir, realDataset());
    assert.equal(existsSync(join(dir, "members/m_999999.json")), false);
    assert.equal(existsSync(join(dir, "rollcalls/221/221-0101-v999.json")), false);
    assert.deepEqual(await validateDataset(dir), []);
    cleanup();
  });

  test("writeDataset は対象外の回次の rollcalls/{session}/ を消さない（#4 レビュー指摘）", async () => {
    const ds = realDataset();
    const rc217 = { ...ds.rollCallDetails[0], id: "217-0620-v001", session: 217 };
    await writeDataset(dir, { ...ds, rollCallDetails: [rc217], rollCalls: [], meta: { ...ds.meta, sessions: [217] } });
    await writeDataset(dir, realDataset());
    assert.equal(existsSync(join(dir, "rollcalls/217/217-0620-v001.json")), true);
    assert.equal(existsSync(join(dir, "rollcalls/221/221-0605-v001.json")), true);
    cleanup();
  });

  test("採決 0 件の回次（第218回）は rollcalls/{session}/ を作らず、違反にもならない", async () => {
    const ds = realDataset();
    await writeDataset(dir, { ...ds, meta: { ...ds.meta, sessions: [218, 221] } });
    assert.equal(existsSync(join(dir, "rollcalls/218")), false);
    assert.deepEqual(await validateDataset(dir), []);
    cleanup();
  });

  test("bills/index.json は軽量な行（id・回次・種別・院・件名・状況・出典）で、回次降順・id 昇順", () => {
    const index = readJson<BillSummary[]>(dir, "bills/index.json");
    assert.deepEqual(index.map((b) => b.id), ["221-衆法-1", "221-閣法-3", "219-決算-1DE115E"]);
    assert.deepEqual(index[0], { id: "221-衆法-1", session: 221, kind: "衆法", house: "shugiin", title: "政治資金規正法の一部を改正する法律案", status: "衆議院で閉会中審査", sourceUrl: `${KEIKA}/1DE153E.htm` });
    cleanup();
  });

  test("bills/{提出回次}/{id}.json は Bill そのもの（会派態度は shugiinGroupStance にだけあり、rollcalls/ には無い）", () => {
    const bill = readJson<Bill>(dir, "bills/221/221-閣法-3.json");
    assert.equal(bill.shugiinGroupStance?.stanceText, "多数");
    const rc = readFileSync(join(dir, "rollcalls/221/221-0605-v001.json"), "utf-8");
    assert.doesNotMatch(rc, /shugiinGroupStance|会派態度/);
    cleanup();
  });

  test("bills/index.json の行に対応する bills/{session}/{id}.json が無ければ違反", async () => {
    rmSync(join(dir, "bills/221/221-閣法-3.json"));
    assert.match((await validateDataset(dir)).join("\n"), /bills\/221\/221-閣法-3\.json: missing/);
    cleanup();
  });

  test("bills/index.json に載っていない bills/{session}/{id}.json（前回実行の残骸）は違反", async () => {
    const b = readJson<Bill>(dir, "bills/221/221-閣法-3.json");
    writeFileSync(join(dir, "bills/221/221-閣法-99.json"), stableJson({ ...b, id: "221-閣法-99" }));
    assert.match((await validateDataset(dir)).join("\n"), /bills\/221\/221-閣法-99\.json.*not in bills\/index\.json/);
    cleanup();
  });

  test("bills の id が重複していれば違反", async () => {
    patch<BillSummary[]>(dir, "bills/index.json", (idx) => [...idx, idx[0]]);
    assert.match((await validateDataset(dir)).join("\n"), /bills\/index\.json: duplicate id 221-衆法-1/);
    cleanup();
  });

  test("bills の sourceUrl が衆参の議案ページでなければ違反、id・回次が index と食い違えば違反", async () => {
    patch<Bill>(dir, "bills/221/221-閣法-3.json", (b) => ({ ...b, sourceUrl: "https://example.com/x", session: 220 }));
    const v = (await validateDataset(dir)).join("\n");
    assert.match(v, /bills\/221\/221-閣法-3\.json: sourceUrl host not allowed/);
    assert.match(v, /bills\/221\/221-閣法-3\.json: session 220 !== 221/);
    cleanup();
  });

  test("shugiinGroupStance の unanimous は stanceText が「全会一致」のときだけ true（反対会派が空でも推論しない）", async () => {
    patch<Bill>(dir, "bills/221/221-閣法-3.json", (b) => ({ ...b, shugiinGroupStance: { stanceText: "多数", yes: ["A"], no: [], unanimous: true } }));
    assert.match((await validateDataset(dir)).join("\n"), /bills\/221\/221-閣法-3\.json: unanimous/);
    cleanup();
  });

  test("writeDataset は前回の bills/ を消してから書く", async () => {
    writeFileSync(join(dir, "bills/221/221-閣法-99.json"), "{}\n");
    await writeDataset(dir, realDataset());
    assert.equal(existsSync(join(dir, "bills/221/221-閣法-99.json")), false);
    assert.deepEqual(await validateDataset(dir), []);
    cleanup();
  });

  test("議案 0 件なら bills/index.json は [] で、bills/{session}/ は作らず、違反にもならない", async () => {
    await writeDataset(dir, { ...realDataset(), bills: [] });
    assert.equal(readFileSync(join(dir, "bills/index.json"), "utf-8"), "[]\n");
    assert.equal(existsSync(join(dir, "bills/221")), false);
    assert.deepEqual(await validateDataset(dir), []);
    cleanup();
  });

  test("readSessionsOnDisk は meta.json の sessions を返し、無ければ空", async () => {
    assert.deepEqual(await readSessionsOnDisk(dir), [221]);
    rmSync(join(dir, "meta.json"));
    assert.deepEqual(await readSessionsOnDisk(dir), []);
    cleanup();
  });

  test("meta.json が無ければ違反", async () => {
    rmSync(join(dir, "meta.json"));
    assert.match((await validateDataset(dir)).join("\n"), /meta\.json/);
    cleanup();
  });
});

describe("resolveSessions: 今回処理する回次 = 指定回次 ∪ data/ に既にある回次（他回次の出力を消さないため）", () => {
  test("指定と既存の和集合を昇順・重複なしで返す", () => {
    assert.deepEqual(resolveSessions([221], [217, 218, 219, 220, 221]), [217, 218, 219, 220, 221]);
    assert.deepEqual(resolveSessions([220, 217], [221]), [217, 220, 221]);
  });
  test("指定が空なら既定の回次 ∪ 既存", () => {
    assert.deepEqual(resolveSessions([], [216]), [216, 217, 218, 219, 220, 221]);
    assert.deepEqual(resolveSessions([], []), [217, 218, 219, 220, 221]);
  });
});
