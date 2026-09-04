// @vitest-environment node
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assemblyPaths, memberPaths, readAssemblies, readLocalAssemblyMeta, readAssemblySessions, readLocalRollCallIndex, readLinkedRecordCounts, readMemberDetail, readMeta, readRollCall, readSangiinVoteLinkStats, readShugiinBillNameStats, readUnmatchedSpeechStats, rollCallPaths } from "./data-files";

const fixtures = fileURLToPath(new URL("../test-fixtures/data", import.meta.url));
const missing = fileURLToPath(new URL("../test-fixtures/does-not-exist", import.meta.url));
const assemblyFixtures = fileURLToPath(new URL("../test-fixtures/assemblies/data", import.meta.url));

/** data/ に壊れた JSON を置いた一時ディレクトリ（ETL 不具合の再現） */
async function brokenDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "seiji-broken-"));
  await writeFile(path.join(dir, "meta.json"), "{ not json");
  await mkdir(path.join(dir, "members"));
  await writeFile(path.join(dir, "members", "index.json"), "{ not json");
  await writeFile(path.join(dir, "members", "m_000123.json"), "{ not json");
  return dir;
}

describe("memberPaths", () => {
  it("一覧 /members と、members/index.json の全議員 /members/{id} を返す", async () => {
    expect(await memberPaths(fixtures)).toEqual(["/members", "/members/m_000123", "/members/m_000456"]);
  });
  it("data/ が無ければ一覧 /members だけを返して落ちない", async () => {
    expect(await memberPaths(missing)).toEqual(["/members"]);
  });
  it("index.json が壊れていれば黙らずに throw する", async () => {
    await expect(memberPaths(await brokenDataDir())).rejects.toThrow(SyntaxError);
  });
});

describe("readMemberDetail", () => {
  it("members/{id}.json を読む", async () => {
    const detail = await readMemberDetail(fixtures, "m_000123");
    expect(detail?.name).toBe("藤川 政人");
    expect(detail?.timeline).toHaveLength(4);
  });
  it("無い id は null", async () => {
    expect(await readMemberDetail(fixtures, "m_999999")).toBeNull();
  });
  it("パス区切りを含む id は読まない", async () => {
    expect(await readMemberDetail(fixtures, "../meta")).toBeNull();
  });
  it("壊れた JSON は throw する", async () => {
    await expect(readMemberDetail(await brokenDataDir(), "m_000123")).rejects.toThrow(SyntaxError);
  });
});

describe("rollCallPaths", () => {
  it("一覧・回次別一覧・全採決ページを列挙する", async () => {
    expect(await rollCallPaths(fixtures)).toEqual([
      "/rollcalls",
      "/rollcalls/220",
      "/rollcalls/221",
      "/rollcalls/220/220-0124-v001",
      "/rollcalls/221/221-0323-v001",
      "/rollcalls/221/221-0724-v006",
      "/rollcalls/221/221-0724-v007",
    ]);
  });
  it("data/ が無ければ空配列を返して落ちない", async () => {
    expect(await rollCallPaths(missing)).toEqual([]);
  });
  it("index.json が壊れていれば黙らずに throw する", async () => {
    const dir = await brokenDataDir();
    await mkdir(path.join(dir, "rollcalls"));
    await writeFile(path.join(dir, "rollcalls", "index.json"), "{ not json");
    await expect(rollCallPaths(dir)).rejects.toThrow(SyntaxError);
  });
});

describe("readRollCall", () => {
  it("rollcalls/{session}/{id}.json を読む", async () => {
    const rc = await readRollCall(fixtures, "221", "221-0724-v007");
    expect(rc?.title).toMatch(/特別区の設置/);
    expect(rc?.votes).toHaveLength(10);
  });
  it("無い id は null", async () => {
    expect(await readRollCall(fixtures, "221", "221-9999-v999")).toBeNull();
  });
  it("パス区切りを含む session / id は読まない", async () => {
    expect(await readRollCall(fixtures, "../members", "index")).toBeNull();
    expect(await readRollCall(fixtures, "221", "../index")).toBeNull();
  });
});

describe("readMeta", () => {
  it("meta.json を読む", async () => {
    expect((await readMeta(fixtures))?.fetchedAt).toBe("2025-04-01T03:00:00+09:00");
  });
  it("無ければ null", async () => {
    expect(await readMeta(missing)).toBeNull();
  });
  it("壊れた JSON は throw する", async () => {
    await expect(readMeta(await brokenDataDir())).rejects.toThrow(SyntaxError);
  });
});

describe("readLocalAssemblyMeta（#346）: 地方議員の出典はその議会自身のもの", () => {
  it("assemblies/{id}/meta.json の出典を読む", async () => {
    const m = await readLocalAssemblyMeta(assemblyFixtures, "pref-04");
    expect(m?.sources.map((s) => s.name)).toEqual(["宮城県議会 議員名簿（会派別）", "宮城県議会 会議録"]);
  });
  it("その議会の meta.json が無ければ null（無い出典を作らない）", async () => {
    expect(await readLocalAssemblyMeta(assemblyFixtures, "pref-99")).toBeNull();
  });
  it("assemblyId が空なら null", async () => {
    expect(await readLocalAssemblyMeta(assemblyFixtures, "")).toBeNull();
  });
});

describe("readAssemblies / assemblyPaths（#158）", () => {
  it("assemblies/index.json を読む", async () => {
    const list = await readAssemblies(assemblyFixtures);
    expect(list?.map((a) => a.id)).toEqual(["diet-sangiin", "diet-shugiin", "pref-04"]);
  });
  it("assemblies/index.json が無ければ null", async () => {
    expect(await readAssemblies(missing)).toBeNull();
  });
  it("一覧 /assemblies と index.json の全議会 /assemblies/{id} を返す", async () => {
    expect(await assemblyPaths(assemblyFixtures)).toEqual(["/assemblies", "/assemblies/diet-sangiin", "/assemblies/diet-shugiin", "/assemblies/pref-04"]);
  });
  it("index.json が無い（#156 より前の）データでは国会の2議会を返す（ページ側の fallback と同じ）", async () => {
    expect(await assemblyPaths(missing)).toEqual(["/assemblies", "/assemblies/diet-sangiin", "/assemblies/diet-shugiin"]);
  });
  it("index.json が壊れていれば黙らずに throw する", async () => {
    const dir = await brokenDataDir();
    await mkdir(path.join(dir, "assemblies"));
    await writeFile(path.join(dir, "assemblies", "index.json"), "{ not json");
    await expect(assemblyPaths(dir)).rejects.toThrow(SyntaxError);
  });
});

describe("readAssemblySessions（#158）", () => {
  it("assemblies/{id}/sessions.json を読む", async () => {
    const sessions = await readAssemblySessions(assemblyFixtures, "pref-04");
    expect(sessions?.map((s) => s.id)).toEqual(["399", "398"]);
  });
  it("無い議会・パス区切りを含む id は null", async () => {
    expect(await readAssemblySessions(assemblyFixtures, "pref-99")).toBeNull();
    expect(await readAssemblySessions(assemblyFixtures, "../index")).toBeNull();
  });
});

describe("readLocalRollCallIndex（#204）", () => {
  it("assemblies/{id}/rollcalls/index.json を読み、voteSubject / committeeReport の原文をそのまま返す", async () => {
    const index = await readLocalRollCallIndex(assemblyFixtures, "pref-31");
    expect(index).toHaveLength(3);
    const chinjo = index?.find((r) => r.id === "pref-31-2026-06-20260629-陳情-8年-11");
    expect(chinjo?.voteSubject).toBe("委員長報告に対する賛否");
    expect(chinjo?.committeeReport).toBe("不採択");
    const giin = index?.find((r) => r.id === "pref-31-2026-06-20260629-知事提案-第10号");
    expect(giin?.voteSubject).toBe("議案に対する賛否");
    expect(giin?.committeeReport).toBeUndefined();
  });
  it("無い議会（宮城には rollcalls/index.json が無い）・パス区切りを含む id は null", async () => {
    expect(await readLocalRollCallIndex(assemblyFixtures, "pref-04")).toBeNull();
    expect(await readLocalRollCallIndex(assemblyFixtures, "pref-99")).toBeNull();
    expect(await readLocalRollCallIndex(assemblyFixtures, "../pref-31")).toBeNull();
  });
});

describe("readShugiinBillNameStats（#251）", () => {
  /** bills/{回次}/{id}.json と members/index.json を置いた一時ディレクトリ */
  async function billsDataDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "seiji-bills-"));
    await mkdir(path.join(dir, "members"));
    await writeFile(
      path.join(dir, "members", "index.json"),
      JSON.stringify([
        { id: "h_1", name: "中島 克仁", kana: "なかじま かつひと", house: "shugiin", group: "立憲", district: "山梨1", counts: { rollcalls: 0, bills: 1, speeches: 0 } },
        { id: "h_2", name: "阿部 知子", kana: "あべ ともこ", house: "shugiin", group: "立憲", district: "神奈川12", counts: { rollcalls: 0, bills: 1, speeches: 0 } },
        // 参院議員は衆院の名簿に数えない
        { id: "m_1", name: "東 徹", kana: "あずま とおる", house: "sangiin", group: "維新", district: "大阪", counts: { rollcalls: 0, bills: 0, speeches: 0 } },
      ]),
    );
    await mkdir(path.join(dir, "bills", "221"), { recursive: true });
    await mkdir(path.join(dir, "bills", "217"), { recursive: true });
    await writeFile(
      path.join(dir, "bills", "221", "221-衆法-1.json"),
      JSON.stringify({ id: "221-衆法-1", house: "shugiin", session: 221, title: "法案", submitterNames: ["中島克仁"], submitters: ["h_1"], supporterNames: ["阿部知子", "東徹君"], supporters: ["h_2"] }),
    );
    // 名簿の回次より前: 氏名だけあって紐づかない
    await writeFile(
      path.join(dir, "bills", "217", "217-衆法-1.json"),
      JSON.stringify({ id: "217-衆法-1", house: "shugiin", session: 217, title: "古い法案", submitterNames: ["中島克仁", "退任 太郎"], supporterNames: ["別人 花子"] }),
    );
    // 参院の議案は数えない
    await writeFile(path.join(dir, "bills", "217", "217-参法-1.json"), JSON.stringify({ id: "217-参法-1", house: "sangiin", session: 217, title: "参法", submitterNames: ["東徹"] }));
    return dir;
  }

  it("衆院の議案の氏名の延べ数と、紐づいた memberId の延べ数を数える（参院の議案は数えない）", async () => {
    const stats = await readShugiinBillNameStats(await billsDataDir());
    expect(stats?.names).toBe(6); // 221: 3、217: 3
    expect(stats?.linked).toBe(2); // 221 の submitters 1 + supporters 1
  });

  it("回次ごとに、異なり氏名の数と現在の名簿にある数を数える（氏名は空白を除いて突合）", async () => {
    const stats = await readShugiinBillNameStats(await billsDataDir());
    expect(stats?.sessions).toEqual([
      // 「退任 太郎」「別人 花子」は名簿に無い
      { session: 217, names: 3, inRoster: 1 },
      // 「東徹君」は「君」が残っているので名簿の氏名と一致しない（docs/research/shugiin-roster.md の注）
      { session: 221, names: 3, inRoster: 2 },
    ]);
  });

  it("衆院の名簿の人数と、名簿のなかで氏名が重複する人数を数える", async () => {
    const stats = await readShugiinBillNameStats(await billsDataDir());
    expect(stats?.rosterMembers).toBe(2); // 参院議員は数えない
    expect(stats?.rosterDuplicateNames).toBe(0);
  });

  it("bills/ が無ければ null（無い事実を作らない）", async () => {
    expect(await readShugiinBillNameStats(missing)).toBeNull();
  });

  // #259 レビュー: ETL の normalizeName は異体字も畳み込む。ここだけ畳み込まないと画面の数値が ETL の紐づけとずれる
  it("異体字（髙﨑德濵邊邉）は ETL の normalizeName と同じように畳み込んで突合する", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "seiji-variants-"));
    await mkdir(path.join(dir, "members"));
    await writeFile(
      path.join(dir, "members", "index.json"),
      JSON.stringify([{ id: "h_1", name: "高橋 辺子", kana: "たかはし へんこ", house: "shugiin", group: "自民", district: "東京1", counts: { rollcalls: 0, bills: 1, speeches: 0 } }]),
    );
    await mkdir(path.join(dir, "bills", "221"), { recursive: true });
    // 議案側は異体字（髙・邊）。畳み込めば名簿の「高橋 辺子」と一致する
    await writeFile(path.join(dir, "bills", "221", "221-衆法-1.json"), JSON.stringify({ id: "221-衆法-1", house: "shugiin", session: 221, title: "法案", submitterNames: ["髙橋邊子"] }));
    const stats = await readShugiinBillNameStats(dir);
    expect(stats?.sessions).toEqual([{ session: 221, names: 1, inRoster: 1 }]);
  });
});

describe("readSangiinVoteLinkStats（#274）", () => {
  /** rollcalls/{回次}/{id}.json を置いた一時ディレクトリ */
  async function votesDataDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "seiji-votes-"));
    await mkdir(path.join(dir, "rollcalls", "200"), { recursive: true });
    await mkdir(path.join(dir, "rollcalls", "221"), { recursive: true });
    await writeFile(
      path.join(dir, "rollcalls", "200", "200-1115-v001.json"),
      JSON.stringify({
        id: "200-1115-v001",
        session: 200,
        date: "2019-11-15",
        votes: [
          { nameText: "足立 敏之", group: "自民", value: "賛成", memberId: "" },
          { nameText: "阿達 雅志", group: "自民", value: "賛成", memberId: "m_014002" },
          { nameText: "岡田 広", group: "自民", value: "賛成", memberId: "" },
        ],
      }),
    );
    await writeFile(
      path.join(dir, "rollcalls", "200", "200-1115-v002.json"),
      JSON.stringify({ id: "200-1115-v002", session: 200, date: "2019-11-15", votes: [{ nameText: "宇都 隆史", group: "自民", value: "反対", memberId: "" }] }),
    );
    await writeFile(
      path.join(dir, "rollcalls", "221", "221-0605-v001.json"),
      JSON.stringify({ id: "221-0605-v001", session: 221, date: "2026-06-05", votes: [{ nameText: "阿達 雅志", group: "自民", value: "賛成", memberId: "m_014002" }] }),
    );
    return dir;
  }

  it("回次ごとに、票の延べ数と議員に紐づいた数を数える", async () => {
    const stats = await readSangiinVoteLinkStats(await votesDataDir());
    expect(stats?.sessions).toEqual([
      { session: 200, votes: 4, linked: 1 },
      { session: 221, votes: 1, linked: 1 },
    ]);
  });

  it("全体の延べ数と紐づいた数も返す", async () => {
    const stats = await readSangiinVoteLinkStats(await votesDataDir());
    expect(stats?.votes).toBe(5);
    expect(stats?.linked).toBe(2);
  });

  it("rollcalls/ が無ければ null（無い事実を作らない）", async () => {
    expect(await readSangiinVoteLinkStats(missing)).toBeNull();
  });
});

describe("readUnmatchedSpeechStats（#370）: 紐づけられなかった発言を数える", () => {
  it("発言の行だけを数える（票・議案の行は数えない）", async () => {
    const r = await readUnmatchedSpeechStats(fixtures);
    // fixture は発言3件（世耕2・重徳1）＋票1件＋議案1件。発言だけ数えて 3 / 2 名
    expect(r).toEqual({
      speeches: 3,
      speakers: 2,
      sessions: [{ session: 217, speeches: 2 }, { session: 219, speeches: 1 }],
    });
  });

  it("回次は件数の多い順（同数なら新しい回次）", async () => {
    const r = await readUnmatchedSpeechStats(fixtures);
    expect(r?.sessions.map((x) => x.session)).toEqual([217, 219]);
  });

  it("unmatched.json が無ければ null（無い事実を作らない）", async () => {
    expect(await readUnmatchedSpeechStats(missing)).toBeNull();
  });
});

/**
 * #451: `/coverage` の「議員ページに出ている件数」は #441 でこの関数に移ったが、**テストが 1 件も無かった**。
 * `questions` を 0 に固定しても web の 925 件が全部緑のまま通り、ビルドすると画面の「42」が「0」に変わり、
 * さらに「そのうち提出者を名簿に照合できたものはありません」という**事実に反する文が増えた**。
 *
 * fixture は**両院を混ぜ、4 項目とも院ごとに違う数**にしてある。同じ数だとどの項目・どちらの院を
 * 読んでいるか見分けられず、`house` フィルタを外す変異も項目を取り違える変異も素通りする。
 */
describe("readLinkedRecordCounts（#251 / #441 / #451）: 議員ページに出ている件数", () => {
  /**
   * 院ごとの合計（この数を手で足したもの。実装を呼んで作らない）:
   *   sangiin  rollcalls 10+5=15 / bills 1+2=3   / speeches 2+0=2  / questions 7+0=7
   *   shugiin  rollcalls 0+0=0   / bills 3+40=43 / speeches 5+8=13 / questions 42+0=42
   * `questions` は #106 以降のデータにしか無いので、**持たない行**（衆院の 2 人目）も混ぜてある。
   */
  async function membersDataDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "seiji-linked-"));
    await mkdir(path.join(dir, "members"));
    await writeFile(
      path.join(dir, "members", "index.json"),
      JSON.stringify([
        { id: "m_1", name: "参議 一郎", house: "sangiin", counts: { rollcalls: 10, bills: 1, speeches: 2, questions: 7 } },
        { id: "m_2", name: "参議 二郎", house: "sangiin", counts: { rollcalls: 5, bills: 2, speeches: 0, questions: 0 } },
        { id: "m_3", name: "衆議 三郎", house: "shugiin", counts: { rollcalls: 0, bills: 3, speeches: 5, questions: 42 } },
        { id: "m_4", name: "衆議 四郎", house: "shugiin", counts: { rollcalls: 0, bills: 40, speeches: 8 } },
      ]),
    );
    return dir;
  }

  it("院ごとに counts の 4 項目を合計する（両院が混ざらない）", async () => {
    const linked = await readLinkedRecordCounts(await membersDataDir());
    // `toEqual` で **4 項目まとめて**見る。1 項目だけ見ると他の 3 項目の変異が素通りする
    expect(linked.sangiin).toEqual({ rollcalls: 15, bills: 3, speeches: 2, questions: 7 });
    expect(linked.shugiin).toEqual({ rollcalls: 0, bills: 43, speeches: 13, questions: 42 });
  });

  it("questions を持たない（#106 より前の）行は 0 として数える（欠測にしない）", async () => {
    // 衆院の 2 人目は counts.questions が無い。それでも合計は 1 人目の 42 のままで、NaN や undefined にならない
    const linked = await readLinkedRecordCounts(await membersDataDir());
    expect(linked.shugiin?.questions).toBe(42);
  });

  it("その院の議員が 0 人なら null（無い事実を作らない）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "seiji-linked-empty-"));
    await mkdir(path.join(dir, "members"));
    await writeFile(path.join(dir, "members", "index.json"), JSON.stringify([{ id: "m_1", name: "参議 一郎", house: "sangiin", counts: { rollcalls: 1, bills: 0, speeches: 0, questions: 0 } }]));
    const linked = await readLinkedRecordCounts(dir);
    expect(linked.shugiin).toBeNull(); // 0 件ではなく null。「衆院の記録は 0 件」という無い事実を作らない
    expect(linked.sangiin).not.toBeNull();
  });

  it("members/index.json が無ければ両院とも null（無い事実を作らない）", async () => {
    expect(await readLinkedRecordCounts(missing)).toEqual({ sangiin: null, shugiin: null });
  });

  it("index.json が壊れていれば黙らずに throw する（0 件にしない）", async () => {
    await expect(readLinkedRecordCounts(await brokenDataDir())).rejects.toThrow(SyntaxError);
  });
});

/**
 * #451: `linkedRecordCounts` は `members-count.ts` に 1 つだけ置き、この画面（Vite）と
 * `data-files.ts`（tsx で直に走るビルドスクリプトから読まれる）の**両方が同じ関数を呼ぶ**。
 *
 * これが成り立つのは `members-count.ts` が**型以外を import しない**からで、値の import を
 * 1 つ足しただけで `import.meta.glob` に触る経路が繋がりうる（`coverage.ts` は `assemblies.ts`
 * 経由で実際に触る）。そうなると `pnpm --filter web build` の tsx スクリプトが
 * `import.meta.glob is not a function` で落ちる——**#441 の担当者が実際に踏んだ罠**。
 *
 * ビルドを流さないと出ない失敗なので、ソースの形でここに固定する。
 */
describe("members-count.ts は型以外を import しない（#451 / #441 の罠）", () => {
  const src = readFileSync(fileURLToPath(new URL("./members-count.ts", import.meta.url)), "utf8");

  it("import 行はすべて `import type`（値を持ち込むと tsx のビルドスクリプトが glob で落ちる）", () => {
    const imports = src.split("\n").filter((l) => /^\s*import\s/.test(l));
    expect(imports.length, "import 行が 1 つも無い（このテストが何も見ていない）").toBeGreaterThan(0);
    expect(imports.filter((l) => !/^\s*import\s+type\s/.test(l))).toEqual([]);
  });

  it("import.meta.glob を直に使わない（コメントで名前を出すのは可）", () => {
    // コメントは落とす。このファイルの doc コメント自身が「glob に触るな」と書いていて、
    // 素の文字列検索だと**注意書きを書いたこと自体で落ちる**（実際に落ちた）
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("import.meta.glob");
    // コメントを落としても中身は残っている（正規表現がファイルを空にしていない）
    expect(code).toContain("export function linkedRecordCounts");
  });
});
