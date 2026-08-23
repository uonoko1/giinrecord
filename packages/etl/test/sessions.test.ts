import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bill, MemberDetail, RollCall, RollCallSummary } from "@seiji-kiroku/shared";
import { planSessions, readCarried, decisionOfResult } from "../src/sessions.ts";
import { stableJson } from "../src/json.ts";

// Issue #103: 日次 ETL は直近 5 回次（DEFAULT_SESSIONS）だけ取得し、data/ に既にある他の回次（第200〜216回など）は
// 取得し直さず前回出力から引き継ぐ（carried）。手動実行（pnpm etl 200 … 216）も同じ仕組みで、そのとき直近回次が carried になる。

describe("planSessions: 今回取得する回次（targets）と引き継ぐ回次（carried）", () => {
  test("指定なし: 既定の 5 回次を取得し、data/ にある他の回次は引き継ぐ", () => {
    assert.deepEqual(planSessions([], [200, 201, 217, 218, 219, 220, 221]), { targets: [217, 218, 219, 220, 221], carried: [200, 201], all: [200, 201, 217, 218, 219, 220, 221] });
  });
  test("指定あり: 指定回次だけ取得し、data/ にある指定外の回次（直近回次を含む）は引き継ぐ", () => {
    assert.deepEqual(planSessions([210, 200], [217, 218, 219, 220, 221]), { targets: [200, 210], carried: [217, 218, 219, 220, 221], all: [200, 210, 217, 218, 219, 220, 221] });
  });
  test("初回（data/ が空）は引き継ぎなし。重複指定は 1 つに", () => {
    assert.deepEqual(planSessions([221, 221], []), { targets: [221], carried: [], all: [221] });
    assert.deepEqual(planSessions([], []).carried, []);
  });
});

describe("decisionOfResult: rollcalls/index.json の result から議案情報の審議結果（原文）を戻す", () => {
  test("「可決（賛成 1・反対 1）」→ 可決、「賛成 1・反対 1」→ undefined（推定しない）", () => {
    assert.equal(decisionOfResult("可決（賛成 148・反対 94）"), "可決");
    assert.equal(decisionOfResult("修正議決（賛成 1・反対 0）"), "修正議決");
    assert.equal(decisionOfResult("賛成 148・反対 94"), undefined);
    assert.equal(decisionOfResult(""), undefined);
  });
});

describe("readCarried: 前回出力（data/）から引き継ぐ回次の採決・議案・timeline 行を読む", () => {
  const rc = (id: string, session: number): RollCall => ({
    id, session, date: "2019-12-04", title: "案件", totals: { total: 1, yes: 1, no: 0 }, groups: [{ group: "G", size: 1, yes: 1, no: 0 }],
    votes: [{ memberId: "m_1", nameText: "一 郎", group: "G", value: "賛成" }], sourceUrl: `https://www.sangiin.go.jp/japanese/touhyoulist/${session}/${id}.htm`,
  });
  const summary = (r: RollCall, result: string): RollCallSummary => ({ id: r.id, session: r.session, date: r.date, title: r.title, totals: r.totals, result, sourceUrl: r.sourceUrl });
  const bill = (id: string, session: number): Bill => ({ id, session, kind: "衆法", house: "shugiin", title: "議案", sourceUrl: "https://www.shugiin.go.jp/internet/itdb_gian.nsf/html/gian/keika/1DE1E6A.htm" });
  const detail: MemberDetail = {
    id: "m_1", name: "一 郎", kana: "", house: "sangiin", terms: [{ house: "sangiin", group: "G", district: "東京", from: "", sessionFrom: 221 }], sourceUrl: "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/221/giin.htm",
    timeline: [
      { kind: "vote", session: 200, date: "2019-12-04", rollCallId: "200-1204-v001", title: "案件", value: "賛成", result: "可決（賛成 1・反対 0）", sourceUrl: "https://www.sangiin.go.jp/japanese/touhyoulist/200/200-1204-v001.htm" },
      { kind: "speech", session: 200, date: "2019-12-04", speechId: "120015254X00120191204_001", meeting: "本会議 第1号", excerpt: "抜粋", chars: 3, sourceUrl: "https://kokkai.ndl.go.jp/txt/120015254X00120191204/1" },
      { kind: "speech", session: 221, date: "2026-06-05", speechId: "122115254X00120260605_001", meeting: "本会議 第1号", excerpt: "抜粋", chars: 3, sourceUrl: "https://kokkai.ndl.go.jp/txt/122115254X00120260605/1" },
      { kind: "bill", session: 200, date: "2019-11-01", billId: "200-参法-1", title: "参法", role: "提出者", sourceUrl: "https://www.sangiin.go.jp/japanese/joho1/kousei/gian/200/meisai/m200050200001.htm" },
      { kind: "bill", session: 200, date: "2019-11-01", billId: "200-衆法-1", title: "衆法", role: "賛成者", sourceUrl: "https://www.shugiin.go.jp/internet/itdb_gian.nsf/html/gian/keika/1DE1E6B.htm" },
      { kind: "question", session: 200, date: "2019-11-01", questionId: "200-sangiin-1", title: "質問", sourceUrl: "https://www.sangiin.go.jp/japanese/joho1/kousei/syuisyo/200/meisai/m200001.htm" },
      { kind: "attendance", estimated: false, session: 200, date: "2019-11-01", meetingId: "120015007X00120191101_000", meeting: "委員会 第1号", role: "発議者", bills: [], sourceUrl: "https://kokkai.ndl.go.jp/txt/120015007X00120191101/0" },
      // 古いデータ（#103 以前）の行: session が無い。引き継げないので件数だけ報告する
      { kind: "speech", date: "2019-12-05", speechId: "120015254X00220191205_001", meeting: "本会議 第2号", excerpt: "抜粋", chars: 3, sourceUrl: "https://kokkai.ndl.go.jp/txt/120015254X00220191205/1" } as never,
    ],
  };

  test("採決は memberId を空に戻して返し（現行名簿で再突合する）、審議結果は index の result から戻す。議案は data/ の全部。timeline は carried の回次の speech / question / attendance / 参法 bill 行だけ", async () => {
    const dir = await mkdtemp(join(tmpdir(), "carried-"));
    try {
      const r1 = rc("200-1204-v001", 200);
      const r2 = rc("221-0605-v001", 221);
      await mkdir(join(dir, "rollcalls", "200"), { recursive: true });
      await mkdir(join(dir, "rollcalls", "221"), { recursive: true });
      await mkdir(join(dir, "bills", "200"), { recursive: true });
      await mkdir(join(dir, "members"), { recursive: true });
      await writeFile(join(dir, "rollcalls", "index.json"), stableJson([summary(r2, "賛成 1・反対 0"), summary(r1, "可決（賛成 1・反対 0）")]));
      await writeFile(join(dir, "rollcalls", "200", "200-1204-v001.json"), stableJson(r1));
      await writeFile(join(dir, "rollcalls", "221", "221-0605-v001.json"), stableJson(r2));
      await writeFile(join(dir, "bills", "index.json"), stableJson([{ id: "200-衆法-1", session: 200, kind: "衆法", house: "shugiin", title: "議案", sourceUrl: bill("200-衆法-1", 200).sourceUrl }]));
      await writeFile(join(dir, "bills", "200", "200-衆法-1.json"), stableJson(bill("200-衆法-1", 200)));
      await writeFile(join(dir, "members", "index.json"), stableJson([{ id: "m_1", name: "一 郎", kana: "", house: "sangiin", assemblyId: "diet-sangiin", group: "G", district: "東京", current: true, counts: { rollcalls: 1, bills: 2, speeches: 3, questions: 1 } }]));
      await writeFile(join(dir, "members", "m_1.json"), stableJson(detail));

      const carried = await readCarried(dir, [200]);
      assert.deepEqual(carried.rollCalls.map((r) => [r.id, r.votes[0].memberId]), [["200-1204-v001", ""]]);
      assert.deepEqual([...carried.decisions], [["200-1204-v001", "可決"]]);
      assert.deepEqual(carried.bills.map((b) => b.id), ["200-衆法-1"]);
      assert.deepEqual(carried.entries.map((c) => [c.memberId, c.entry.kind, c.entry.session, (c.entry as { sourceUrl: string }).sourceUrl.includes("kousei/gian")]), [
        ["m_1", "speech", 200, false],
        ["m_1", "bill", 200, true],
        ["m_1", "question", 200, false],
        ["m_1", "attendance", 200, false],
      ]);
      assert.equal(carried.withoutSession, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("data/ が空なら全部空", async () => {
    const dir = await mkdtemp(join(tmpdir(), "carried-"));
    try {
      assert.deepEqual(await readCarried(dir, [200]), { rollCalls: [], decisions: new Map(), bills: [], entries: [], withoutSession: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
