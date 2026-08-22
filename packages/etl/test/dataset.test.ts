import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RollCall } from "@seiji-kiroku/shared";
import { buildDataset } from "../src/aggregate.ts";
import { writeDataset, validateDataset, type Dataset } from "../src/dataset.ts";
import { stableJson } from "../src/json.ts";
import { matchVotes } from "../src/match-votes.ts";
import { parseRollCall } from "../src/sources/sangiin-votes.ts";
import { parseMemberList } from "../src/sources/sangiin-members.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.htm`, import.meta.url), "utf-8");
const BASE = "https://www.sangiin.go.jp/japanese/touhyoulist/221";
const ROSTER = "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/221/giin.htm";

function realDataset(): Dataset {
  const members = parseMemberList(fixture("sangiin-giin-221"), ROSTER, 221);
  const rollCalls = ["221-0605-v001", "221-0724-v001"].map((id) => matchVotes(parseRollCall(fixture(id), `${BASE}/${id}.htm`, 221), members).rollCall);
  return {
    ...buildDataset(members, rollCalls),
    rollCallDetails: rollCalls,
    unmatched: [],
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
    for (const rel of ["meta.json", "members/index.json", "members/m_007006.json", "rollcalls/index.json", "rollcalls/221/221-0605-v001.json", "unmatched.json"]) {
      const text = readFileSync(join(dir, rel), "utf-8");
      assert.equal(text, stableJson(JSON.parse(text)), rel);
    }
    cleanup();
  });

  test("キーが未ソート or 末尾改行なしの JSON は違反", async () => {
    writeFileSync(join(dir, "meta.json"), JSON.stringify(readJson(dir, "meta.json")));
    assert.match((await validateDataset(dir)).join("\n"), /meta\.json.*stableJson/);
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

  test("counts.rollcalls が timeline の vote 数と食い違えば違反", async () => {
    patch<{ id: string; counts: { rollcalls: number } }[]>(dir, "members/index.json", (idx) => idx.map((m) => (m.id === "m_007006" ? { ...m, counts: { ...m.counts, rollcalls: 99 } } : m)));
    assert.match((await validateDataset(dir)).join("\n"), /m_007006.*counts/);
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

  test("writeDataset は前回の members/・rollcalls/ を消してから書く", async () => {
    writeFileSync(join(dir, "members/m_999999.json"), "{}\n");
    writeFileSync(join(dir, "rollcalls/221/221-0101-v999.json"), "{}\n");
    await writeDataset(dir, realDataset());
    assert.equal(existsSync(join(dir, "members/m_999999.json")), false);
    assert.equal(existsSync(join(dir, "rollcalls/221/221-0101-v999.json")), false);
    assert.deepEqual(await validateDataset(dir), []);
    cleanup();
  });

  test("meta.json が無ければ違反", async () => {
    rmSync(join(dir, "meta.json"));
    assert.match((await validateDataset(dir)).join("\n"), /meta\.json/);
    cleanup();
  });
});
