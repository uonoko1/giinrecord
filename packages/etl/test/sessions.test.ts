import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bill, Member, MemberDetail, RollCall, RollCallSummary, TimelineEntry } from "@seiji-kiroku/shared";
import { planSessions, readCarried, decisionOfResult, lostVoteMatches, lostTimelineEntries, lostSessionEntries, readSessionCounts, sessionCounts, sessionOfEntry, dropCarriedSpeeches, carriedTenureVerified } from "../src/sessions.ts";
import type { CarriedEntry } from "../src/aggregate.ts";
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

  // #219: 第142〜199回のバックフィルは 1 回の dispatch（timeout 360m）に収まらないことがあるので、
  // 回次を分けて複数回 dispatch する。前の chunk で入れた回次が次の chunk で消えないことを固定する。
  test("回次を分けて複数回 dispatch しても、前の chunk の回次は carried として残る", () => {
    let onDisk = [217, 218, 219, 220, 221];
    const chunks = [[142, 143, 144], [145, 146, 147], [148, 149, 150]];
    for (const chunk of chunks) {
      const plan = planSessions(chunk, onDisk);
      assert.deepEqual(plan.targets, chunk, "指定した chunk だけを取得する");
      for (const s of onDisk) assert.ok(plan.carried.includes(s), `回次 ${s} が引き継がれていない`);
      onDisk = plan.all;
    }
    assert.deepEqual(onDisk, [142, 143, 144, 145, 146, 147, 148, 149, 150, 217, 218, 219, 220, 221]);
  });

  test("バックフィルの chunk でも最新回次（衆院名簿が覆う回次）は plan.all に残る", () => {
    const plan = planSessions([142, 143], [217, 218, 219, 220, 221]);
    assert.equal(Math.max(...plan.all), 221);
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
      // 委員会の役職（#244）。counts を持たない種別なので、引き継ぎから漏れると lostTimelineEntries / lostSessionEntries の
      // どちらにも引っかからず、黙って消える（#235 と同型）。引き継ぐことをここで固定する
      { kind: "committeeRole", estimated: false, session: 200, date: "2019-11-05", committee: "内閣委員会", role: "委員長", meetings: 3, firstDate: "2019-11-05", lastDate: "2019-12-03", meetingId: "120014889X00120191105_000", sourceUrl: "https://kokkai.ndl.go.jp/txt/120014889X00120191105/0" },
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
      // 再突合の後退検出用に、前回出力で memberId が付いていた票の数を採決ごとに残す（#103 レビュー）
      assert.deepEqual([...carried.matchedVotes], [["200-1204-v001", 1]]);
      assert.deepEqual([...carried.decisions], [["200-1204-v001", "可決"]]);
      assert.deepEqual(carried.bills.map((b) => b.id), ["200-衆法-1"]);
      assert.deepEqual(carried.entries.map((c) => [c.memberId, c.entry.kind, c.entry.session, (c.entry as { sourceUrl: string }).sourceUrl.includes("kousei/gian")]), [
        ["m_1", "speech", 200, false],
        ["m_1", "bill", 200, true],
        ["m_1", "question", 200, false],
        ["m_1", "attendance", 200, false],
        ["m_1", "committeeRole", 200, false],
      ]);
      assert.equal(carried.withoutSession, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("data/ が空なら全部空", async () => {
    const dir = await mkdtemp(join(tmpdir(), "carried-"));
    try {
      assert.deepEqual(await readCarried(dir, [200]), { rollCalls: [], decisions: new Map(), matchedVotes: new Map(), bills: [], entries: [], withoutSession: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /*
   * Issue #242: 発言は timeline から members/{id}/speeches.json に移った。readCarried は読む先が変わる。
   *
   * ここは #235（質問主意書 524 件が黙って消えた）と #236（衆院発言が引き継ぎ頼みで 0 のまま戻らなくなった）が
   * どちらも起きた場所なので、**両方の形式**を実際のファイルで固定する:
   *   - 新形式（#242 以降の出力）: members/{id}/speeches.json から読む
   *   - 旧形式（#242 以前の出力）: members/{id}.json の timeline に speech 行がある。**初回実行は必ずこの状態**なので、
   *     ここで落とすと全議員の発言が 1 回で消える。
   * 両方あるときは新形式だけを読む（同じ speechId が 2 行になるのを防ぐ）。
   */
  const speechFile = (id: string, rows: TimelineEntry[]) => ({ id, speeches: rows });
  const s200: TimelineEntry = { kind: "speech", session: 200, date: "2019-12-04", speechId: "120015254X00120191204_001", meeting: "本会議 第1号", excerpt: "抜粋", chars: 3, sourceUrl: "https://kokkai.ndl.go.jp/txt/120015254X00120191204/1" };
  const s221: TimelineEntry = { kind: "speech", session: 221, date: "2026-06-05", speechId: "122115254X00120260605_001", meeting: "本会議 第1号", excerpt: "抜粋", chars: 3, sourceUrl: "https://kokkai.ndl.go.jp/txt/122115254X00120260605/1" };
  /** 委員会の発言（#242）。会議名が原文で長いこと以外は本会議と同じ形。 */
  const c200: TimelineEntry = { kind: "speech", session: 200, date: "2019-12-03", speechId: "120014911X00120191203_005", meeting: "内閣委員会 第1号", excerpt: "抜粋", chars: 300, position: "内閣府大臣官房審議官", sourceUrl: "https://kokkai.ndl.go.jp/txt/120014911X00120191203/5" };

  /** 引き継ぎだけを見るための最小の data/（採決・議案なし）。timeline は detailTimeline、発言は speeches で置く。 */
  async function withData(detailTimeline: TimelineEntry[], speeches: TimelineEntry[] | null, run: (dir: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "carried-"));
    try {
      await mkdir(join(dir, "members"), { recursive: true });
      await writeFile(join(dir, "members", "index.json"), stableJson([{ id: "m_1", name: "一 郎", kana: "", house: "sangiin", assemblyId: "diet-sangiin", group: "G", district: "東京", current: true, counts: { rollcalls: 0, bills: 0, speeches: speeches?.length ?? detailTimeline.filter((e) => e.kind === "speech").length, questions: 0 } }]));
      await writeFile(join(dir, "members", "m_1.json"), stableJson({ ...detail, timeline: detailTimeline }));
      if (speeches) {
        await mkdir(join(dir, "members", "m_1"), { recursive: true });
        await writeFile(join(dir, "members", "m_1", "speeches.json"), stableJson(speechFile("m_1", speeches)));
      }
      await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("新形式（#242）: carried の回次の発言を members/{id}/speeches.json から引き継ぐ", async () => {
    await withData([], [s221, c200, s200], async (dir) => {
      const carried = await readCarried(dir, [200]);
      assert.deepEqual(carried.entries.map((c) => [c.memberId, c.entry.kind, c.entry.session, (c.entry as { speechId: string }).speechId]), [
        ["m_1", "speech", 200, "120014911X00120191203_005"],
        ["m_1", "speech", 200, "120015254X00120191204_001"],
      ]);
      assert.equal(carried.withoutSession, 0);
    });
  });

  test("委員会の発言（position 付き・会議名が原文）もそのまま引き継ぐ（再解釈しない。#242）", async () => {
    await withData([], [c200], async (dir) => {
      const carried = await readCarried(dir, [200]);
      assert.deepEqual(carried.entries[0].entry, c200);
    });
  });

  test("旧形式（#242 以前の出力）: timeline の speech 行も引き継ぐ（初回実行で全議員の発言が消えない）", async () => {
    await withData([s221, s200], null, async (dir) => {
      const carried = await readCarried(dir, [200]);
      assert.deepEqual(carried.entries.map((c) => (c.entry as { speechId: string }).speechId), ["120015254X00120191204_001"]);
    });
  });

  test("新旧が両方あれば新形式だけを読む（同じ speechId が2行にならない）", async () => {
    await withData([s200], [s200], async (dir) => {
      const carried = await readCarried(dir, [200]);
      assert.deepEqual(carried.entries.map((c) => (c.entry as { speechId: string }).speechId), ["120015254X00120191204_001"]);
    });
  });

  test("speeches.json に session を持たない古い行があれば引き継がず件数だけ報告する（推定しない。#235 と同じ規則）", async () => {
    const noSession = { kind: "speech", date: "2019-12-05", speechId: "120015254X00220191205_001", meeting: "本会議 第2号", excerpt: "抜粋", chars: 3, sourceUrl: "https://kokkai.ndl.go.jp/txt/120015254X00220191205/1" } as never as TimelineEntry;
    await withData([], [s200, noSession], async (dir) => {
      const carried = await readCarried(dir, [200]);
      assert.equal(carried.entries.length, 1);
      assert.equal(carried.withoutSession, 1);
    });
  });

  test("carried でない回次の発言は引き継がない（取得し直す回次の分は取得側が入れる）", async () => {
    await withData([], [s221, s200], async (dir) => {
      assert.deepEqual((await readCarried(dir, [221])).entries.map((c) => (c.entry as { speechId: string }).speechId), ["122115254X00120260605_001"]);
    });
  });
});

/*
 * #235: 第217〜221回の質問主意書 524 件が「静かに消えた」回帰の再発防止。
 * 原因は「#103 以前の出力（session を持たない timeline 行）」を readCarried が数えるだけで捨てていたこと。
 * question / bill 行は id の先頭が回次（DATA_CONTRACT「未突合の置き場所」と同じ規約）なので、捨てずに回次を引いて引き継ぐ。
 * speech / attendance の NDL 会議録 id は回次を含まないので引けない（推定しない）。
 */
describe("sessionOfEntry: session を持たない古い行から id の先頭の回次を引く（#235）", () => {
  test("question 行は questionId `{回次}-{house}-{番号}` の先頭から回次を引く", () => {
    assert.equal(sessionOfEntry({ kind: "question", date: "2026-02-19", questionId: "221-shugiin-1", title: "質問", sourceUrl: "https://www.shugiin.go.jp/internet/itdb_shitsumon.nsf/html/shitsumon/221001.htm" } as never), 221);
    assert.equal(sessionOfEntry({ kind: "question", date: "2024-12-20", questionId: "216-sangiin-47", title: "質問", sourceUrl: "https://www.sangiin.go.jp/japanese/joho1/kousei/syuisyo/216/meisai/m216047.htm" } as never), 216);
  });

  test("参法の bill 行は billId `{提出回次}-{種別}-{番号}` の先頭から引く", () => {
    assert.equal(sessionOfEntry({ kind: "bill", date: "2019-11-01", billId: "200-参法-1", title: "参法", role: "提出者", sourceUrl: "https://www.sangiin.go.jp/japanese/joho1/kousei/gian/200/meisai/m200050200001.htm" } as never), 200);
  });

  test("speech / attendance の NDL 会議録 id は回次を含まないので引けない（推定しない）", () => {
    assert.equal(sessionOfEntry({ kind: "speech", date: "2019-12-05", speechId: "120015254X00220191205_001", meeting: "本会議 第2号", excerpt: "抜粋", chars: 3, sourceUrl: "https://kokkai.ndl.go.jp/txt/120015254X00220191205/1" } as never), undefined);
    assert.equal(sessionOfEntry({ kind: "attendance", estimated: false, date: "2019-11-01", meetingId: "120015007X00120191101_000", meeting: "委員会 第1号", role: "発議者", bills: [], sourceUrl: "https://kokkai.ndl.go.jp/txt/120015007X00120191101/0" } as never), undefined);
  });

  test("session を既に持つ行はその値をそのまま返す（id からは引き直さない）", () => {
    assert.equal(sessionOfEntry({ kind: "question", session: 221, date: "2026-02-19", questionId: "221-shugiin-1", title: "質問", sourceUrl: "https://www.shugiin.go.jp/internet/itdb_shitsumon.nsf/html/shitsumon/221001.htm" }), 221);
  });
});

describe("readCarried: #103 以前の出力（session 無し）の question / 参法 bill 行も回次を引いて引き継ぐ（#235）", () => {
  // 2026-08-24 の実データで起きた事故の再現: 第217〜221回が carried になったとき、
  // session を持たない question 行 524 件が引き継がれず、writeDataset が members/ を消して書き直したので黙って消えた。
  const legacyDetail: MemberDetail = {
    id: "h_93effd86cb", name: "緒方 林太郎", kana: "おがた りんたろう", house: "shugiin",
    terms: [{ house: "shugiin", group: "無所属", district: "福岡9", from: "", sessionFrom: 221 }],
    sourceUrl: "https://www.shugiin.go.jp/internet/itdb_annai.nsf/html/statics/syu/1giin.htm",
    timeline: [
      // 実データ（commit bc586bd の data/members/h_93effd86cb.json）と同じ形: session が無い
      { kind: "question", date: "2026-02-19", questionId: "221-shugiin-1", title: "行き過ぎた緊縮志向に関する質問主意書", submitterText: "緒方 林太郎君", status: "答弁受理", answerDate: "2026-03-03", answerUrl: "https://www.shugiin.go.jp/internet/itdb_shitsumon.nsf/html/shitsumon/b221001.htm", sourceUrl: "https://www.shugiin.go.jp/internet/itdb_shitsumon.nsf/html/shitsumon/221001.htm" } as never,
      { kind: "question", date: "2026-02-24", questionId: "221-shugiin-3", title: "施政方針演説等における幾つかの点に関する質問主意書", submitterText: "緒方 林太郎君", status: "答弁受理", sourceUrl: "https://www.shugiin.go.jp/internet/itdb_shitsumon.nsf/html/shitsumon/221003.htm" } as never,
      // 回次が引けない古い行（NDL の会議録 id）は今までどおり引き継げず、件数だけ報告する
      { kind: "speech", date: "2026-02-19", speechId: "122105254X00120260219_001", meeting: "本会議 第1号", excerpt: "抜粋", chars: 3, sourceUrl: "https://kokkai.ndl.go.jp/txt/122105254X00120260219/1" } as never,
    ],
  };

  test("第221回が carried のとき、session 無しの question 行が questionId から回次を引いて引き継がれる（消えない）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "carried-legacy-"));
    try {
      await mkdir(join(dir, "members"), { recursive: true });
      await writeFile(join(dir, "members", "index.json"), stableJson([{ id: "h_93effd86cb", name: "緒方 林太郎", kana: "おがた りんたろう", house: "shugiin", assemblyId: "diet-shugiin", group: "無所属", district: "福岡9", current: true, counts: { rollcalls: 0, bills: 0, speeches: 1, questions: 2 } }]));
      await writeFile(join(dir, "members", "h_93effd86cb.json"), stableJson(legacyDetail));

      const carried = await readCarried(dir, [221]);
      // どの議員のどの質問かを名指しで固定する（件数だけのテストにしない。WORKING_AGREEMENT のテスト方針）
      assert.deepEqual(carried.entries.map((c) => [c.memberId, c.entry.kind, c.entry.session, (c.entry as { questionId?: string }).questionId]), [
        ["h_93effd86cb", "question", 221, "221-shugiin-1"],
        ["h_93effd86cb", "question", 221, "221-shugiin-3"],
      ]);
      // 引き継いだ行には回次が入っているので、次の出力は #103 以後の形になる（同じ事故を繰り返さない）
      assert.equal(carried.entries[0]?.entry.session, 221);
      // 回次の引けない speech 行だけが「引き継げない」件数に残る
      assert.equal(carried.withoutSession, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("回次が引けても carried の回次でなければ引き継がない（対象外の回次の行を混ぜない）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "carried-legacy-"));
    try {
      await mkdir(join(dir, "members"), { recursive: true });
      await writeFile(join(dir, "members", "index.json"), stableJson([{ id: "h_93effd86cb", name: "緒方 林太郎", kana: "おがた りんたろう", house: "shugiin", assemblyId: "diet-shugiin", group: "無所属", district: "福岡9", current: true, counts: { rollcalls: 0, bills: 0, speeches: 1, questions: 2 } }]));
      await writeFile(join(dir, "members", "h_93effd86cb.json"), stableJson(legacyDetail));
      const carried = await readCarried(dir, [200]);
      assert.deepEqual(carried.entries, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/*
 * #235: 「前回あった行が今回無い」ことを検知する（lostVoteMatches と同じ発想）。
 * writeDataset は members/ を毎回消して書き直すので、引き継ぎが壊れると出力から黙って消える。
 * 件数の後退を検出して ETL を落とし、二度と静かに消えないようにする。
 */
describe("lostTimelineEntries: 前回出力にあった timeline 行が今回の出力で減っていないか（#235）", () => {
  const row = (id: string, house: "sangiin" | "shugiin", counts: { rollcalls: number; bills: number; speeches: number; questions: number }) =>
    ({ id, name: id, kana: "", house, assemblyId: `diet-${house}`, group: "G", district: "東京", current: true, counts });

  test("質問主意書が前回 42 件・今回 0 件なら、その議会と種別と前後の件数を返す", () => {
    const lost = lostTimelineEntries([row("h_1", "shugiin", { rollcalls: 0, bills: 2, speeches: 5, questions: 42 })], [row("h_1", "shugiin", { rollcalls: 0, bills: 2, speeches: 5, questions: 0 })]);
    assert.deepEqual(lost, [{ assemblyId: "diet-shugiin", kind: "questions", before: 42, after: 0 }]);
  });

  // 2026-08-24 の事故そのもの: 衆院の質問 42 件が消えた一方、同じ実行で参院が 482 → 1374 に増えた。
  // 両院の合計（524 → 1374）は増えているので、合計だけを見る検出では捕まらない。院ごとに見て初めて捕まる。
  test("片方の院の増加が反対側の消失を覆い隠さない（合計は 524 → 1374 で増えているが衆院は消えている）", () => {
    const before = [row("h_1", "shugiin", { rollcalls: 0, bills: 0, speeches: 0, questions: 42 }), row("m_1", "sangiin", { rollcalls: 0, bills: 0, speeches: 0, questions: 482 })];
    const after = [row("h_1", "shugiin", { rollcalls: 0, bills: 0, speeches: 0, questions: 0 }), row("m_1", "sangiin", { rollcalls: 0, bills: 0, speeches: 0, questions: 1374 })];
    const beforeTotal = before.reduce((s, m) => s + m.counts.questions, 0);
    const afterTotal = after.reduce((s, m) => s + m.counts.questions, 0);
    assert.equal(beforeTotal, 524);
    assert.ok(afterTotal > beforeTotal, "合計では増えている（だから合計だけの検出では捕まらない）");
    assert.deepEqual(lostTimelineEntries(before, after), [{ assemblyId: "diet-shugiin", kind: "questions", before: 42, after: 0 }]);
  });

  test("増えるのは正常（回次を足した・名寄せが良くなった）。同じでも正常", () => {
    assert.deepEqual(lostTimelineEntries([row("m_1", "sangiin", { rollcalls: 10, bills: 2, speeches: 5, questions: 482 })], [row("m_1", "sangiin", { rollcalls: 10, bills: 2, speeches: 5, questions: 1374 })]), []);
    assert.deepEqual(lostTimelineEntries([row("m_1", "sangiin", { rollcalls: 10, bills: 2, speeches: 5, questions: 1 })], [row("m_1", "sangiin", { rollcalls: 10, bills: 2, speeches: 5, questions: 1 })]), []);
  });

  test("種別ごとに数える（採決・議案・発言・質問主意書）。複数減れば全部返す", () => {
    const lost = lostTimelineEntries([row("m_1", "sangiin", { rollcalls: 10, bills: 2, speeches: 5, questions: 3 })], [row("m_1", "sangiin", { rollcalls: 9, bills: 2, speeches: 1, questions: 3 })]);
    assert.deepEqual(lost, [{ assemblyId: "diet-sangiin", kind: "rollcalls", before: 10, after: 9 }, { assemblyId: "diet-sangiin", kind: "speeches", before: 5, after: 1 }]);
  });

  test("議員が入れ替わっても議会ごとの合計で見る（初回実行＝前回が空なら常に空）", () => {
    assert.deepEqual(lostTimelineEntries([], [row("m_1", "sangiin", { rollcalls: 1, bills: 0, speeches: 0, questions: 0 })]), []);
    // 同じ院の中で議員が入れ替わっても、合計が保たれていれば消失ではない
    assert.deepEqual(lostTimelineEntries([row("m_1", "sangiin", { rollcalls: 0, bills: 0, speeches: 0, questions: 2 })], [row("m_2", "sangiin", { rollcalls: 0, bills: 0, speeches: 0, questions: 2 })]), []);
  });

  test("assemblyId の無い古い行は house から議会を決める（diet-{house}）", () => {
    const legacy = { id: "m_1", name: "一 郎", kana: "", house: "sangiin", group: "G", district: "東京", current: true, counts: { rollcalls: 0, bills: 0, speeches: 0, questions: 3 } };
    assert.deepEqual(lostTimelineEntries([legacy as never], [row("m_1", "sangiin", { rollcalls: 0, bills: 0, speeches: 0, questions: 1 })]), [
      { assemblyId: "diet-sangiin", kind: "questions", before: 3, after: 1 },
    ]);
  });

  test("地方議員の行（assemblyId が diet- 以外）は国会の counts を持たないので数えない", () => {
    const local = { id: "p_04_x", name: "地方 議員", kana: "", assemblyId: "pref-04", group: "G", district: "仙台", current: true, counts: { rollcalls: 5 } };
    assert.deepEqual(lostTimelineEntries([local as never, row("m_1", "sangiin", { rollcalls: 1, bills: 0, speeches: 0, questions: 2 })], [row("m_1", "sangiin", { rollcalls: 1, bills: 0, speeches: 0, questions: 2 })]), []);
  });
});

describe("lostVoteMatches: 引き継いだ採決の再突合で memberId の付いた票が前回より減っていないか（#103 レビュー）", () => {
  const rc = (id: string, memberIds: string[]): RollCall => ({
    id, session: 217, date: "2025-01-24", title: "案件", totals: { total: memberIds.length, yes: memberIds.length, no: 0 },
    groups: [{ group: "G", size: memberIds.length, yes: memberIds.length, no: 0 }],
    votes: memberIds.map((m, i) => ({ memberId: m, nameText: `議員 ${i}`, group: "G", value: "賛成" as const })),
    sourceUrl: `https://www.sangiin.go.jp/japanese/touhyoulist/217/${id}.htm`,
  });

  test("名簿の取り漏れ（第216回の名簿を取らずに第217回を再突合した等）で票の memberId が減ったら、その採決と前後の件数を返す", () => {
    const previous = new Map([["217-0124-v001", 2], ["217-0124-v002", 1]]);
    assert.deepEqual(lostVoteMatches(previous, [rc("217-0124-v001", ["m_1", ""]), rc("217-0124-v002", ["m_2"])]), [
      { id: "217-0124-v001", before: 2, after: 1 },
    ]);
  });

  test("減っていなければ空。今回取得した採決（previous に無い）は対象外。増えるのは正常（名簿が良くなった）", () => {
    const previous = new Map([["217-0124-v001", 1]]);
    assert.deepEqual(lostVoteMatches(previous, [rc("217-0124-v001", ["m_1", "m_2"]), rc("221-0605-v001", [""])]), []);
  });
});

describe("dropCarriedSpeeches: 取得した発言と同じ speechId の引き継ぎ行を落とす（#236）", () => {
  // 衆院名簿は「現在」の1回次分しか無い（#71）ので、衆院本会議の発言は memberSession = max(all) の分だけ取得できる。
  // その回次が carried（過去回次だけの手動実行）でも取得はする（#236: 取得しないと衆院発言が永久に 0 のままになりうる）。
  // 二重行（同じ speechId が 2 行）は「取得した speechId の引き継ぎ行を落とす」ことで防ぐ。取得しないことで防いではいけない。
  const speechEntry = (speechId: string, session: number): TimelineEntry =>
    ({ kind: "speech", session, date: "2026-06-05", speechId, meeting: "本会議 第1号", excerpt: "抜粋", chars: 3, sourceUrl: `https://kokkai.ndl.go.jp/txt/${speechId.split("_")[0]}/1` });
  const voteEntry: TimelineEntry = { kind: "vote", session: 221, date: "2026-06-05", rollCallId: "221-0605-v001", title: "案件", value: "賛成", result: "可決（賛成 1・反対 0）", sourceUrl: "https://www.sangiin.go.jp/japanese/touhyoulist/221/221-0605-v001.htm" };

  test("取得した speechId の引き継ぎ行だけ落ち、他の回次・他の kind の行は残る", () => {
    const carried: CarriedEntry[] = [
      { memberId: "h_1", entry: speechEntry("122115254X00120260605_001", 221) },  // 取得し直した分（落ちる）
      { memberId: "h_1", entry: speechEntry("120015254X00120191204_001", 200) },  // 別回次の発言（残る）
      { memberId: "m_1", entry: voteEntry },                                       // 発言でない行（残る）
    ];
    const fetched = [{ id: "122115254X00120260605_001" }];
    assert.deepEqual(dropCarriedSpeeches(carried, fetched).map((c) => [c.memberId, c.entry.kind, c.entry.session]), [["h_1", "speech", 200], ["m_1", "vote", 221]]);
  });

  test("取得が空なら引き継ぎ行はそのまま（取り漏れで既存の発言を消さない）", () => {
    const carried: CarriedEntry[] = [{ memberId: "h_1", entry: speechEntry("122115254X00120260605_001", 221) }];
    assert.deepEqual(dropCarriedSpeeches(carried, []), carried);
  });
});

// #236 の回帰テスト（この分岐が再び「永久にスキップ」に戻らないように固定する）。
// もとの条件「最新回次が targets に入っているときだけ取得する」は、最新回次が carried になる実行
//（過去回次だけの手動実行・#219 のバックフィルの chunk）では成立しない。取得しないと衆院の発言は前回出力の
// 引き継ぎ頼みになり、引き継ぎが1度でも欠ければ（#103 以前の session の無い行、名簿から消えた memberId）
// 0 に落ちたまま自力では戻らない。実際に #236 ではバックフィルの実行で衆院議員 465 名の発言が全員 0 になった。
describe("#236 回帰: 最新回次が carried の実行でも衆院の発言は残り、二重行にならない", () => {
  const detail = (id: string, speechIds: readonly string[]): MemberDetail => ({
    id, name: "衆 一郎", kana: "", house: "shugiin", terms: [{ house: "shugiin", group: "G", district: "東京", from: "", sessionFrom: 221 }],
    sourceUrl: "https://www.shugiin.go.jp/internet/itdb_annai.nsf/html/statics/syu/1giin.htm",
    timeline: speechIds.map((speechId) => ({
      kind: "speech", session: 221, date: "2026-06-05", speechId, meeting: "本会議 第1号", excerpt: "抜粋", chars: 3,
      sourceUrl: `https://kokkai.ndl.go.jp/txt/${speechId.split("_")[0]}/1`,
    })),
  });
  const write = async (dir: string, d: MemberDetail) => {
    await mkdir(join(dir, "members"), { recursive: true });
    await writeFile(join(dir, "members", "index.json"), stableJson([{ id: d.id, name: d.name, kana: "", house: "shugiin", assemblyId: "diet-shugiin", group: "G", district: "東京", current: true, counts: { rollcalls: 0, bills: 0, speeches: d.timeline.length, questions: 0 } }]));
    await writeFile(join(dir, "members", `${d.id}.json`), stableJson(d));
  };
  // 「前回の日次実行が入れた第221回の衆院発言 2 件」が data/ にある状態で、過去回次だけを指定して流す。
  const IDS = ["122105254X00120260605_001", "122105254X00120260605_002"];

  test("バックフィルの chunk（pnpm etl 200）でも、最新回次の衆院発言は 1 件ずつ残る", async () => {
    const dir = await mkdtemp(join(tmpdir(), "regress236-"));
    try {
      await write(dir, detail("h_1", IDS));
      const plan = planSessions([200], [200, 221]);
      assert.deepEqual(plan.carried, [221], "最新回次が carried になる実行を再現している");

      const carried = await readCarried(dir, plan.carried);
      assert.equal(carried.entries.length, 2, "前回出力の衆院発言 2 件を引き継いでいる");

      // 修正後: 取得は必ず走る（memberSession = 221）。取得した分と引き継ぎ分を合わせても speechId は重複しない。
      const fetched = IDS.map((id) => ({ id }));
      const kept = dropCarriedSpeeches(carried.entries, fetched);
      const speechIds = [...kept.filter((c) => c.entry.kind === "speech").map((c) => (c.entry as { speechId: string }).speechId), ...fetched.map((f) => f.id)];
      assert.deepEqual(speechIds.sort(), [...IDS].sort(), "取得分だけが残り、同じ speechId が 2 行にならない");
      assert.equal(speechIds.length, 2, "衆院の発言が 0 に落ちない（#236 の実害）");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("引き継ぎが空でも（#103 以前の session の無い行で引き継げなくても）取得分で発言は復元される", async () => {
    const dir = await mkdtemp(join(tmpdir(), "regress236-empty-"));
    try {
      // #103 以前の出力を模して session を落とす。readCarried は引き継げず withoutSession に数える。
      const d = detail("h_1", IDS);
      d.timeline = d.timeline.map((e) => { const { session: _s, ...rest } = e as Record<string, unknown>; return rest as never; });
      await write(dir, d);

      const carried = await readCarried(dir, [221]);
      assert.equal(carried.entries.length, 0);
      assert.equal(carried.withoutSession, 2, "session の無い行は引き継げない（#236 で発言が 0 になった経路）");

      // 取得をやめていたらここで 0 のまま（修正前の挙動）。取得するので 2 件戻る。
      const fetched = IDS.map((id) => ({ id }));
      assert.equal(dropCarriedSpeeches(carried.entries, fetched).length + fetched.length, 2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("cli.ts は衆院発言の取得を条件分岐で囲まない（取得を丸ごとスキップする述語を復活させない）", async () => {
    const src = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
    // #242 で第4引数（会議の範囲 SPEECH_SCOPE）が付いた。守るのは「条件分岐で囲まないこと」であって引数の数ではない
    assert.ok(/^const shugiinSpeeches = matchSpeeches\(await fetchSpeeches\(memberSession, "shugiin"[^)]*\)/m.test(src), "衆院の発言を memberSession で無条件に取得している");
    assert.ok(!/shouldFetchShugiinSpeeches/.test(src), "取得を丸ごとスキップする条件が cli.ts に残っている（#236）");
    assert.ok(/dropCarriedSpeeches\(/.test(src), "二重行は dropCarriedSpeeches で防ぐ");
  });
});

/*
 * #256: lostTimelineEntries の残る穴。
 * lostTimelineEntries は議会（院）×種別の合計しか見ないので、同じ院・同じ種別の中で
 * 「第221回が消え、第200回のバックフィルが同数入った」入れ替わりは合計が保たれて素通りする。
 * 回次まで含めた粒度（議会 × 回次 × 種別）で突き合わせて塞ぐ。
 */
describe("lostSessionEntries: 議会 × 回次 × 種別で前回出力より減っていないか（#256）", () => {
  const entry = (kind: "speech" | "question", session: number, n: number): TimelineEntry =>
    kind === "speech"
      ? { kind: "speech", session, date: "2025-01-24", speechId: `s${session}-${n}`, meeting: "本会議", excerpt: "…", chars: 3, sourceUrl: "https://kokkai.ndl.go.jp/txt/122105254X00120250124/1" }
      : { kind: "question", session, date: "2025-01-24", title: "質問主意書", questionId: `${session}-shugiin-${n}`, sourceUrl: `https://www.shugiin.go.jp/internet/itdb_shitsumon.nsf/html/shitsumon/${session}${n}.htm` };

  const detail = (id: string, house: "sangiin" | "shugiin", timeline: TimelineEntry[]): MemberDetail =>
    ({ id, name: id, kana: "", house, assemblyId: `diet-${house}`, group: "G", district: "東京", current: true, terms: [], timeline, sourceUrl: "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/221/giin.htm" }) as unknown as MemberDetail;

  const countsOf = (details: readonly MemberDetail[]) => sessionCounts(details);

  test("#256 の穴そのもの: 同じ院・同じ種別で第221回が消え第200回が同数入った入れ替わりを検出する", () => {
    const before = [detail("h_1", "shugiin", [entry("question", 221, 1), entry("question", 221, 2)])];
    const after = [detail("h_1", "shugiin", [entry("question", 200, 1), entry("question", 200, 2)])];
    // 院×種別の合計は 2 → 2 で変わらないので、lostTimelineEntries は素通りする（これが #256）
    assert.deepEqual(lostTimelineEntries(
      [{ id: "h_1", house: "shugiin", assemblyId: "diet-shugiin", counts: { rollcalls: 0, bills: 0, speeches: 0, questions: 2 } } as never],
      [{ id: "h_1", house: "shugiin", assemblyId: "diet-shugiin", counts: { rollcalls: 0, bills: 0, speeches: 0, questions: 2 } } as never],
    ), []);
    assert.deepEqual(lostSessionEntries(countsOf(before), after), [
      { assemblyId: "diet-shugiin", session: 221, kind: "questions", before: 2, after: 0 },
    ]);
  });

  test("委員会の役職（#244）も消失検出に載る: counts を持たない種別なので、ここが唯一の検出経路", () => {
    // committeeRole は counts に無い（設計どおり）ので lostTimelineEntries は構造的に見られない。
    // sessionCounts は timeline を直接数えるので、counts を増やさずに検出できる。
    const role = (session: number, committee: string): TimelineEntry =>
      ({ kind: "committeeRole", estimated: false, session, date: "2026-02-10", committee, role: "委員長", meetings: 3,
         firstDate: "2026-02-10", lastDate: "2026-06-18", meetingId: `${session}-${committee}`,
         sourceUrl: "https://kokkai.ndl.go.jp/txt/121714889X02520250620/0" }) as unknown as TimelineEntry;
    const before = [detail("h_1", "shugiin", [role(221, "内閣委員会"), role(221, "予算委員会")])];
    const after = [detail("h_1", "shugiin", [role(221, "内閣委員会")])];
    // counts は committeeRole を数えないので、合計側（#235）は素通りする
    assert.deepEqual(lostTimelineEntries(
      [{ id: "h_1", house: "shugiin", assemblyId: "diet-shugiin", counts: { rollcalls: 0, bills: 0, speeches: 0, questions: 0 } } as never],
      [{ id: "h_1", house: "shugiin", assemblyId: "diet-shugiin", counts: { rollcalls: 0, bills: 0, speeches: 0, questions: 0 } } as never],
    ), []);
    // 回次側（#256）が拾う
    assert.deepEqual(lostSessionEntries(countsOf(before), after), [
      { assemblyId: "diet-shugiin", session: 221, kind: "committeeRoles", before: 2, after: 1 },
    ]);
  });

  test("同じ回次で議員が入れ替わっても、その回次の合計が保たれていれば消失ではない（改選・名寄せの移動）", () => {
    const before = [detail("m_1", "sangiin", [entry("speech", 221, 1), entry("speech", 221, 2)])];
    const after = [detail("m_1", "sangiin", [entry("speech", 221, 1)]), detail("m_2", "sangiin", [entry("speech", 221, 2)])];
    assert.deepEqual(lostSessionEntries(countsOf(before), after), []);
  });

  test("増える・同じは正常（回次を足した・名寄せが良くなった）。初回実行（前回が空）は常に空", () => {
    const before = [detail("m_1", "sangiin", [entry("question", 221, 1)])];
    const after = [detail("m_1", "sangiin", [entry("question", 221, 1), entry("question", 221, 2), entry("question", 200, 1)])];
    assert.deepEqual(lostSessionEntries(countsOf(before), after), []);
    assert.deepEqual(lostSessionEntries(new Map(), after), []);
  });

  test("回次を指定した部分実行でも、対象外の回次は引き継がれるので止まらない（偽陽性を増やさない）", () => {
    // `pnpm etl 221` = targets 221 / carried 200。第200回の行は readCarried が戻すので減らない
    const before = [detail("m_1", "sangiin", [entry("speech", 221, 1), entry("speech", 200, 1)])];
    const after = [detail("m_1", "sangiin", [entry("speech", 221, 1), entry("speech", 221, 2), entry("speech", 200, 1)])];
    assert.deepEqual(lostSessionEntries(countsOf(before), after), []);
  });

  test("複数の回次・種別が減れば全部返す（議会・回次・種別の順に並ぶ）", () => {
    const before = [detail("h_1", "shugiin", [entry("speech", 221, 1), entry("question", 220, 1), entry("question", 220, 2)]), detail("m_1", "sangiin", [entry("speech", 221, 1)])];
    const after = [detail("h_1", "shugiin", [entry("question", 220, 1)]), detail("m_1", "sangiin", [entry("speech", 221, 1)])];
    assert.deepEqual(lostSessionEntries(countsOf(before), after), [
      { assemblyId: "diet-shugiin", session: 220, kind: "questions", before: 2, after: 1 },
      { assemblyId: "diet-shugiin", session: 221, kind: "speeches", before: 1, after: 0 },
    ]);
  });

  test("回次の無い行（#103 以前の出力）は回次を推定せず数えない。合計側の lostTimelineEntries が引き続き見る", () => {
    const legacy = { kind: "speech", date: "2025-01-24", speechId: "sX", meeting: "本会議", excerpt: "…", chars: 3, sourceUrl: "https://kokkai.ndl.go.jp/txt/122105254X00120250124/1" } as unknown as TimelineEntry;
    const before = [detail("m_1", "sangiin", [legacy])];
    assert.deepEqual(lostSessionEntries(countsOf(before), [detail("m_1", "sangiin", [])]), []);
  });

  test("sessionCounts: 前回出力の members/{id}.json から議会 × 回次 × 種別の件数を読む", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-counts-"));
    try {
      await mkdir(join(dir, "members"), { recursive: true });
      const rows = [{ id: "h_1", name: "衆 議員", kana: "", house: "shugiin", assemblyId: "diet-shugiin", group: "G", district: "東京", current: true, counts: { rollcalls: 0, bills: 0, speeches: 0, questions: 2 } }];
      await writeFile(join(dir, "members", "index.json"), stableJson(rows));
      await writeFile(join(dir, "members", "h_1.json"), stableJson(detail("h_1", "shugiin", [entry("question", 221, 1), entry("question", 200, 1)])));
      const counts = await readSessionCounts(dir);
      assert.equal(counts.get("diet-shugiin\t221\tquestions"), 1);
      assert.equal(counts.get("diet-shugiin\t200\tquestions"), 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /*
   * Issue #242 の移行で最も危ないところ。発言が timeline から members/{id}/speeches.json に移るので、
   * 数え方が片方しか見ていないと「発言が全部消えた」という**偽陽性**で ETL が毎回止まるか、
   * 逆に二重計上で本物の消失を見逃す。旧形式・新形式・両方あるとき、の 3 通りで同じ値が出ることを固定する。
   */
  test("sessionCounts: 発言は members/{id}/speeches.json から数える（新形式。#242）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-counts-"));
    try {
      await mkdir(join(dir, "members", "m_1"), { recursive: true });
      await writeFile(join(dir, "members", "index.json"), stableJson([{ id: "m_1", name: "一 郎", kana: "", house: "sangiin", assemblyId: "diet-sangiin", group: "G", district: "東京", current: true, counts: { rollcalls: 0, bills: 0, speeches: 2, questions: 0 } }]));
      await writeFile(join(dir, "members", "m_1.json"), stableJson(detail("m_1", "sangiin", [])));
      await writeFile(join(dir, "members", "m_1", "speeches.json"), stableJson({ id: "m_1", speeches: [entry("speech", 221, 1), entry("speech", 200, 1)] }));
      const counts = await readSessionCounts(dir);
      assert.equal(counts.get("diet-sangiin\t221\tspeeches"), 1);
      assert.equal(counts.get("diet-sangiin\t200\tspeeches"), 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("sessionCounts: 旧形式（timeline の speech 行）と新形式で同じ値になる（移行で偽陽性を出さない。#242）", async () => {
    const rows = [entry("speech", 221, 1), entry("speech", 200, 1)];
    const legacy = sessionCounts([detail("m_1", "sangiin", rows)]);
    const split = sessionCounts([{ ...detail("m_1", "sangiin", []), speeches: rows }]);
    assert.deepEqual([...split].sort(), [...legacy].sort());
    // 旧形式の前回出力 → 新形式の今回出力で、消失として検出されない
    assert.deepEqual(lostSessionEntries(legacy, [{ ...detail("m_1", "sangiin", []), speeches: rows }]), []);
  });

  test("sessionCounts: 新旧が両方あれば speeches.json 側だけを数える（二重計上しない。#242）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-counts-"));
    try {
      await mkdir(join(dir, "members", "m_1"), { recursive: true });
      await writeFile(join(dir, "members", "index.json"), stableJson([{ id: "m_1", name: "一 郎", kana: "", house: "sangiin", assemblyId: "diet-sangiin", group: "G", district: "東京", current: true, counts: { rollcalls: 0, bills: 0, speeches: 1, questions: 0 } }]));
      await writeFile(join(dir, "members", "m_1.json"), stableJson(detail("m_1", "sangiin", [entry("speech", 221, 1)])));
      await writeFile(join(dir, "members", "m_1", "speeches.json"), stableJson({ id: "m_1", speeches: [entry("speech", 221, 1)] }));
      assert.equal((await readSessionCounts(dir)).get("diet-sangiin\t221\tspeeches"), 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("発言が本当に減れば新形式でも検出する（偽陰性にしない。#242）", () => {
    const before = sessionCounts([{ ...detail("m_1", "sangiin", []), speeches: [entry("speech", 221, 1), entry("speech", 221, 2)] }]);
    assert.deepEqual(lostSessionEntries(before, [{ ...detail("m_1", "sangiin", []), speeches: [entry("speech", 221, 1)] }]), [
      { assemblyId: "diet-sangiin", session: 221, kind: "speeches", before: 2, after: 1 },
    ]);
  });
});

describe("carriedTenureVerified: 引き継ぎ行も今の名簿で在職を確認し直す（#230）", () => {
  const member = (id: string, sessionFrom: number, sessionTo: number, to?: string): Member => ({
    id, name: "山田 太郎", kana: "", house: "sangiin",
    terms: [{ house: "sangiin", group: "自由民主党・無所属の会", district: "", from: "", sessionFrom, sessionTo, ...(to ? { to } : {}) }],
    sourceUrl: "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/221/giin.htm",
  });
  const entry = (session: number, date: string): CarriedEntry => ({
    memberId: "m_1",
    entry: { kind: "question", session, date, questionId: `${session}-sangiin-1`, title: "件名", role: "提出者", sourceUrl: "https://www.sangiin.go.jp/x" } as TimelineEntry,
  });

  test("名簿がその回次を覆っていれば残る", () => {
    assert.deepEqual(carriedTenureVerified([entry(217, "2025-03-01")], [member("m_1", 216, 221)]), [entry(217, "2025-03-01")]);
  });

  test("名簿が後の回次にしか無い行は落ちる（#230 より前の出力に入っている在職未確認の紐づけ）", () => {
    assert.deepEqual(carriedTenureVerified([entry(200, "2019-11-15")], [member("m_1", 216, 221, "2028-07-25")]), []);
  });

  test("前の回次の名簿に載り任期満了日が行の日付以後なら残る（会期中に名簿から消えた議員）", () => {
    assert.deepEqual(
      carriedTenureVerified([entry(217, "2025-03-01")], [member("m_1", 216, 216, "2025-07-28")]),
      [entry(217, "2025-03-01")],
    );
  });

  test("名簿から消えた memberId の行は落ちる（従来どおり。付け先が無い）", () => {
    assert.deepEqual(carriedTenureVerified([entry(217, "2025-03-01")], [member("m_2", 216, 221)]), []);
  });
});
