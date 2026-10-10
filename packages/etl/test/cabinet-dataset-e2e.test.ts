import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CabinetRoleEntry, Member, MemberDetail, MemberSummary } from "@seiji-kiroku/shared";
import { CABINET, MEIBO_PAGES, fetchCabinetPosts, meiboPageUrl, setFetchTextForTest } from "../src/sources/kantei-cabinet.ts";
import { matchCabinetPosts } from "../src/match-cabinet.ts";
import { buildDataset as build } from "../src/aggregate.ts";
import { dietAssemblies, validateDataset, writeDataset } from "../src/dataset.ts";
import type { MatchedCabinetRole } from "../src/match-cabinet.ts";

/**
 * **`cli.ts` の配線が `data/` に何を書くか**（Issue #1152 の受け入れ条件 1）。
 *
 * ## なぜこのテストが要るか
 *
 * **`aggregate-cabinet.test.ts` は `buildDataset` を手で組んだ行で呼んでいる。**
 * **それは「名簿を取ってきたら何行出るか」を 1 件も言わない。**
 * **`cli.ts` のブロックは「`fetchCabinetPosts` → `matchCabinetPosts` → `buildDataset`」をつなぐ配線で、
 * 配線が間違っていても上のテストは全部緑のままである。**
 *
 * **だからここは本物の入口（`fetchCabinetPosts`）から入り、`writeDataset` で書いて
 * `validateDataset` に通すところまで通す。** **取得だけは差し替える**
 * （毎回官邸を叩くテストにしない。`setFetchTextForTest`）。
 *
 * ## 固定している数（実測 2026-10-08。**`data/members` の実物 771 人**を使う）
 *
 * ```
 * tally   { total: 76, byName: 71, byKana: 5, unresolved: 0 }     71+5+0=76
 * rows 134   people 76
 * rows  by house   { shugiin: 103, sangiin: 31 }      103+31=134
 * rows by section  { 閣僚等: 63, 副大臣: 35, 大臣政務官: 36 }    63+35+36=134
 * 1 人あたり最大 7 役職 = 赤澤 亮正（h_fee329b052）
 * ```
 *
 * **フィクスチャの名簿は 2026-09-30 の写しで、上流は「いまの内閣」しか公開しない**ので、
 * **改造・総辞職で上流は書き換わる。この写しだけが 2026-09-30 の事実を保持している**
 * （#1140 と同じ扱い。**更新して件数を合わせないこと**）。
 */

/**
 * **`cli.ts` と同じ引数の並びで `buildDataset` を呼ぶ**（最後の引数が `cabinetRoles`）。
 * **ここで並びを間違えると、このテスト自身が配線を検査しなくなる**ので、
 * 他の引数は `cli.ts` と同じ「空」を渡して位置だけ合わせる。
 */
const buildDataset = (members: readonly Member[], cabinetRoles: readonly MatchedCabinetRole[]) =>
  build(members, [], new Map(), [], [], [], [], [], [], [], cabinetRoles);

const DATA = new URL("../../../data/", import.meta.url);
const fx = (file: string) =>
  readFileSync(new URL(`./fixtures/kantei-meibo-105-20260930-${file.replace(".html", "")}.html`, import.meta.url), "utf-8");

/** フィクスチャの 3 ページを URL で引く差し替え（**取得の経路そのものは本物を通す**）。 */
const byUrl = new Map(MEIBO_PAGES.map(({ file }) => [meiboPageUrl(CABINET, file), fx(file)]));
const fakeFetch = async (url: string): Promise<string> => {
  const html = byUrl.get(url);
  if (html === undefined) throw new Error(`unexpected url: ${url}`);
  return html;
};

/** `data/members/` の実物（771 人）。**フィクスチャの名簿ではなく本番の名簿で測る。** */
const realMembers = (): Member[] => {
  const index = JSON.parse(readFileSync(new URL("members/index.json", DATA), "utf-8")) as MemberSummary[];
  const out: Member[] = [];
  for (const m of index) {
    if (!m.house) continue; // 地方議員の行（#157）は閣僚等名簿の名寄せ先ではない
    out.push(JSON.parse(readFileSync(new URL(`members/${m.id}.json`, DATA), "utf-8")) as Member);
  }
  return out;
};

describe("#1152 cli.ts の配線: 官邸の名簿 3 ページ → data/ の cabinetRole 行", () => {
  test("76 人 / 134 行が出て、母数の内訳が合う（71 + 5 + 0 = 76）", async () => {
    setFetchTextForTest(fakeFetch as never);
    try {
      const { pages, posts } = await fetchCabinetPosts(CABINET);
      assert.equal(pages.length, 3, "名簿は 3 ページ（1 ページ落とすとその層の全員が消える。#1037）");
      const members = realMembers();
      assert.ok(members.length > 700, `data/members が ${members.length} 人。名簿が空では名寄せを測れない`);

      const matched = matchCabinetPosts(posts, members, { session: 221, cabinet: CABINET });
      const t = matched.tally;
      assert.deepEqual(t, { total: 76, byName: 71, byKana: 5, unresolved: 0 }, "母数の内訳（#1149 の実測と同じ）");
      assert.equal(t.byName + t.byKana + t.unresolved, t.total, "分類が漏れていない");
      assert.equal(matched.entries.length, 134, "役職の行");
      assert.equal(new Set(matched.entries.map((e) => e.memberId)).size, 76, "名寄せできた人数（重複 0）");
      // **落とした行も数える**（#757）。事務方 2 人は国会議員ではないので出さないが、黙って消さない
      assert.equal(pages.reduce((n, p) => n + p.withoutHouse, 0), 2, "所属院の欄が無い行（露木 康浩 / 岩尾 信行＝事務方）");
    } finally { setFetchTextForTest(undefined); }
  });

  test("院ごと・区分ごとの内訳が合う（合計だけ見ると片側の消失を反対側が覆い隠す。#235）", async () => {
    setFetchTextForTest(fakeFetch as never);
    try {
      const { posts } = await fetchCabinetPosts(CABINET);
      const matched = matchCabinetPosts(posts, realMembers(), { session: 221, cabinet: CABINET });
      const byHouse: Record<string, number> = {};
      const bySection: Record<string, number> = {};
      for (const e of matched.entries) {
        byHouse[e.house] = (byHouse[e.house] ?? 0) + 1;
        bySection[e.kind] = (bySection[e.kind] ?? 0) + 1;
      }
      assert.deepEqual(byHouse, { shugiin: 103, sangiin: 31 }, "院ごとの行（103 + 31 = 134）");
      assert.deepEqual(bySection, { 閣僚等: 63, 副大臣: 35, 大臣政務官: 36 }, "区分ごとの行（63 + 35 + 36 = 134）");
      assert.equal(Object.values(byHouse).reduce((a, b) => a + b, 0), 134);
      assert.equal(Object.values(bySection).reduce((a, b) => a + b, 0), 134);
      // **兼務は丸めない**: 1 人あたり最大 7 役職（赤澤 亮正）
      const perPerson = new Map<string, number>();
      for (const e of matched.entries) perPerson.set(e.memberId, (perPerson.get(e.memberId) ?? 0) + 1);
      const max = [...perPerson].sort((a, b) => b[1] - a[1])[0];
      assert.deepEqual(max, ["h_fee329b052", 7], "1 人あたり最大の役職数（赤澤 亮正）");
    } finally { setFetchTextForTest(undefined); }
  });

  test("writeDataset で書いて validateDataset が違反 0 件（全行に官邸の名簿 URL が付く）", async () => {
    setFetchTextForTest(fakeFetch as never);
    const dir = await mkdtemp(join(tmpdir(), "cabinet-e2e-"));
    try {
      const { posts } = await fetchCabinetPosts(CABINET);
      const members = realMembers();
      const matched = matchCabinetPosts(posts, members, { session: 221, cabinet: CABINET });
      // **`cli.ts` と同じ引数の並びで呼ぶ**（最後の引数が cabinetRoles）
      const built = buildDataset(members, matched.entries);
      await writeDataset(dir, {
        ...built,
        assemblies: dietAssemblies(221),
        rollCallDetails: [], bills: [], unmatched: [], unmatchedBills: [], unmatchedGroups: [], groupMismatch: [],
        meta: {
          fetchedAt: "2026-10-08T00:00:00.000Z", sessions: [221],
          sources: [
            // **house は both**（大臣は衆参どちらからも出る）。`cli.ts` が書く行と同じ形
            { name: `首相官邸 閣僚等名簿（第${CABINET}代内閣）`, url: meiboPageUrl(CABINET, "index.html"), fetchedAt: "2026-10-08T00:00:00.000Z", house: "both", kind: "cabinet" },
          ],
        },
      } as never);

      assert.deepEqual(await validateDataset(dir), [], "書き出した data/ に違反が無い");

      // **実際に書かれた行を読み直して数える**（組み立てた値ではなく、ファイルの中身を見る）
      const index = JSON.parse(readFileSync(join(dir, "members/index.json"), "utf-8")) as MemberSummary[];
      let rows = 0;
      const people = new Set<string>();
      const urls = new Set<string>();
      const cabinets = new Set<number>();
      for (const m of index) {
        const d = JSON.parse(readFileSync(join(dir, `members/${m.id}.json`), "utf-8")) as MemberDetail;
        for (const e of d.timeline) {
          if (e.kind !== "cabinetRole") continue;
          const c = e as CabinetRoleEntry;
          rows++;
          people.add(m.id);
          urls.add(c.sourceUrl);
          cabinets.add(c.cabinet);
          // **全行に一次資料リンク**（受け入れ条件 4）
          assert.match(c.sourceUrl, /^https:\/\/www\.kantei\.go\.jp\/jp\/105\/meibo\/(?:index|fukudaijin|seimukan)\.html$/, `${m.id} の sourceUrl`);
          // **回次を持たない**（受け入れ条件: 一次資料に無い値を作っていない）
          assert.equal("session" in c, false, `${m.id} の cabinetRole に session が付いている`);
          // **終了日を持たない**
          for (const k of ["endDate", "untilDate", "lastDate", "toDate"]) assert.equal(k in c, false, `${m.id} に ${k} が付いている`);
        }
      }
      assert.equal(rows, 134, "data/ に書かれた cabinetRole の行");
      assert.equal(people.size, 76, "data/ に cabinetRole が付いた議員");
      assert.equal(urls.size, 3, "出典の URL は 3 ページ分");
      assert.deepEqual([...cabinets], [105], "内閣の代は 1 つだけ（前の内閣の行が残っていない）");
    } finally {
      setFetchTextForTest(undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("counts には数えない（counts は採決・議案・発言・質問主意書の 4 つのまま）", async () => {
    setFetchTextForTest(fakeFetch as never);
    try {
      const { posts } = await fetchCabinetPosts(CABINET);
      const members = realMembers();
      const matched = matchCabinetPosts(posts, members, { session: 221, cabinet: CABINET });
      const built = buildDataset(members, matched.entries);
      const withRole = new Set(matched.entries.map((e) => e.memberId));
      for (const row of built.index) {
        if (!withRole.has(row.id)) continue;
        assert.deepEqual(Object.keys(row.counts).sort(), ["bills", "questions", "rollcalls", "speeches"], `${row.id} の counts の欄`);
      }
    } finally { setFetchTextForTest(undefined); }
  });

  /**
   * **`cli.ts` が本当に配線しているか**（**変異テストで見つけた穴**）。
   *
   * **上の 4 本は `buildDataset` を自分で呼んでいるので、`cli.ts` の配線を 1 文字も検査していない。**
   * **実測 2026-10-08**: `cli.ts` の `buildDataset(…, carriedEntries, cabinetRoles)` から
   * **`cabinetRoles` を落としても、このファイルは 5 件すべて緑だった**
   * ——**その 1 行が「`data/` に届くかどうか」を決める唯一の場所である。**
   *
   * **`cli.ts` は `await` を含むトップレベルのスクリプトで、import すると実際に取得が走る**ので、
   * **呼び出して確かめられない。** **だからソースを読む**
   * （`sessions.test.ts` の「cli.ts は衆院発言の取得を条件分岐で囲まない」と同じ形）。
   *
   * **行数や引数の数は固定しない**——守るのは「3 つがつながっていること」である。
   */
  test("#1152 cli.ts が 取得 → 名寄せ → buildDataset をつないでいる（配線が切れたら落ちる）", async () => {
    const src = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
    // 1. 取得している（**回次で絞らず、無条件に 1 回取る**。名簿は「いまの内閣」しか無い）
    assert.match(src, /await fetchCabinetPosts\(CABINET\)/, "官邸の名簿を取得していない");
    // 2. 名寄せしている（**衆参の名簿を両方渡す**。大臣は両院から出る）
    assert.match(src, /matchCabinetPosts\(posts, \[\.\.\.members, \.\.\.shugiin\.members\], \{[^}]*cabinet: CABINET[^}]*\}\)/,
      "名寄せに衆参の名簿と内閣の代を渡していない");
    // 3. **buildDataset に渡している**（**ここが切れると data/ に 1 行も出ない**）
    assert.match(src, /buildDataset\([^;]*carriedEntries, cabinetRoles\)/,
      "buildDataset に cabinetRoles を渡していない（data/ に 1 行も出ない。#1152）");
    // 4. 一次資料を meta.sources に出している（議員ページの出典の絞り込みが読む。#339）
    assert.match(src, /kind: "cabinet" as const/, "meta.sources に閣僚等名簿の出典が無い");
    // 5. **取得を条件分岐で囲んでいない**（#236 と同じ形の事故を作らない）
    assert.ok(!/if\s*\([^)]*\)\s*\{?\s*(?:const\s*\{\s*pages|await fetchCabinetPosts)/.test(src),
      "閣僚等名簿の取得が条件分岐で囲まれている（丸ごとスキップできる形）");
    // 6. **引き継がない**（名簿を毎回取り直すので。`dropCarried…` に相当するものは要らない）
    assert.ok(!/dropCarriedCabinet/.test(src), "引き継ぎを落とす仕掛けが在る＝引き継いでいる（#1152 は引き継がない）");
  });

  test("assemblies の形は国会の 2 行のまま（閣僚等名簿は議会を増やさない）", () => {
    assert.deepEqual(dietAssemblies(221).map((a) => a.id), ["diet-sangiin", "diet-shugiin"]);
  });
});
