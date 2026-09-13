import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeAll, describe, expect, it } from "vitest";
import type { Assembly } from "@seiji-kiroku/shared";
import type { LocalAssemblyMeta, MemberDetail } from "../lib/data-contract";
import { defaultDataDir, readAssemblies, readLocalAssemblyMetas, readMemberDetail } from "../lib/data-files";
import { lossyNameMatchFor } from "../lib/lossy-name";
import { CoveragePage, loader as coverageLoader } from "./coverage";
import { MemberPage, loader as memberLoader } from "./member";
import { billsBySession, dataset } from "../test-fixtures/dataset";

/**
 * #800 の本丸: **本番の `data/` に `lossyNameMatches` があるのに、画面に出ない**状態を落とす。
 *
 * **#778（PR #794）では、11 県すべての `meta.json` に書いたところで止まっていた。**
 * `data/assemblies/pref-29/meta.json` は **`/data/` で配信されず、バンドルもされず**、
 * `grep -rn "lossyNameMatches" apps/web` は **0 件**だった——**`git clone` した人しか読めなかった。**
 *
 * **だから、fixture ではなく本番のデータで見る。** fixture だけだと、
 * ETL が書いた欄と画面のつなぎが切れても緑のままになる（それが #800 そのもの）。
 */

const DATA = defaultDataDir();

/** その議会の議員のうち、lossy に載っていない 1 人の id（実データの名簿から取る。id を組み立てない） */
function otherMemberIdOf(m: LocalAssemblyMeta, lossyIds: ReadonlySet<string>): string {
  const index: { id: string; assemblyId?: string }[] = JSON.parse(readFileSync(join(DATA, "members", "index.json"), "utf8"));
  const found = index.find((x) => x.assemblyId === m.assemblyId && !lossyIds.has(x.id));
  expect(found, `${m.assemblyId} に lossy でない議員が 1 人も居ない`).toBeDefined();
  return (found as { id: string }).id;
}

async function realLocalMetas(): Promise<LocalAssemblyMeta[]> {
  const metas = await readLocalAssemblyMetas(DATA);
  expect(metas, `${join(DATA, "assemblies", "index.json")} が読めない`).not.toBeNull();
  return metas ?? [];
}

describe("#800 本番データ: 字が落ちたまま寄った氏名が画面に出る", () => {
  it("本番の meta.json に lossyNameMatches がある議会が 1 つ以上ある（前提の確認。無ければこの検査は空回りしている）", async () => {
    const metas = await realLocalMetas();
    const withLossy = metas.filter((m) => (m.lossyNameMatches ?? []).length > 0);
    expect(metas.length).toBeGreaterThan(0);
    expect(withLossy.length, "本番データに lossy が 1 件も無い。この検査は何も見ていない").toBeGreaterThan(0);
  });

  it("/coverage に、本番データの該当議会・該当氏名・件数がすべて出る", async () => {
    const metas = await realLocalMetas();
    const assemblies = (await readAssemblies(DATA)) as Assembly[];
    render(
      <MemoryRouter>
        <CoveragePage data={{ ...dataset, assemblies }} billsBySession={billsBySession} localMetas={metas} />
      </MemoryRouter>,
    );
    const section = screen.getByRole("region", { name: "字が落ちたまま名簿に突き合わせた氏名" });
    for (const m of metas) {
      for (const row of m.lossyNameMatches ?? []) {
        const block = within(section).getByTestId(`coverage-lossy-${m.assemblyId}`);
        expect(block, `${m.assemblyId} の ${row.nameText} が出ていない`).toHaveTextContent(row.nameText);
        expect(block).toHaveTextContent(row.rosterName);
        // 一次資料（絶対原則）
        expect(within(block).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(expect.arrayContaining([m.sources[0].url]));
      }
    }
  });

  it("該当する議員のページに注記が出て、印字されていた氏名・名簿の氏名・件数がその議員の実データと一致する", async () => {
    const metas = await realLocalMetas();
    let checked = 0;
    for (const m of metas) {
      for (const row of m.lossyNameMatches ?? []) {
        const detail = (await readMemberDetail(DATA, row.memberId)) as MemberDetail | null;
        expect(detail, `${row.memberId} の members/{id}.json が無い`).not.toBeNull();
        expect(lossyNameMatchFor(m, row.memberId)).toEqual(row);
        render(
          <MemoryRouter>
            <MemberPage detail={detail as MemberDetail} meta={null} localSources={m.sources} lossyNameMatch={row} />
          </MemoryRouter>,
        );
        const notice = screen.getByTestId("member-lossy-name");
        expect(notice).toHaveTextContent(row.nameText);
        expect(notice).toHaveTextContent(row.rosterName);
        expect(notice).toHaveTextContent(String(row.rollCalls));
        expect(within(notice).getAllByRole("link").length).toBeGreaterThan(0);
        // 票は動かしていない（#800 の「やらないこと」）。表決の行はそのまま残る
        expect((detail as MemberDetail).timeline.filter((e) => e.kind === "localVote").length).toBeGreaterThanOrEqual(row.rollCalls);
        screen.getByTestId("member-lossy-name").remove();
        checked += 1;
      }
    }
    expect(checked, "1 人も見ていない").toBeGreaterThan(0);
  });

  /**
   * **ここが #800 の本丸である。**
   *
   * **画面の部品を作っただけでは同じことが起きる**——#778 は `meta.json` に書いて止まった。
   * **本番と同じ経路（`loader`）を通したときに、data の事実が画面まで届くか**を見る。
   * **loader の 1 行を `null` に差し替える変異は、この検査が無い間、全テストが緑のまま素通りした**
   * （実測。#800 の変異テスト 10 番）。それは **#800 で起きていたことそのもの**である。
   */
  describe("本番の loader を通して、data の事実が画面まで届く", () => {
    let coverageData: Awaited<ReturnType<typeof coverageLoader>>;
    beforeAll(async () => {
      coverageData = await coverageLoader();
    });

    it("/coverage の loader が地方の meta.json を読み、lossyNameMatches を持って返る", () => {
      expect(coverageData.localMetas, "loader が地方の meta.json を読んでいない（#800 で起きていたのはこれ）").not.toBeNull();
      const rows = (coverageData.localMetas ?? []).flatMap((m) => m.lossyNameMatches ?? []);
      expect(rows.length, "loader の結果に lossy が 1 件も無い").toBeGreaterThan(0);
    });

    it("その loader の結果で描くと、画面の可視テキストに氏名と件数が出る", async () => {
      const assemblies = (await readAssemblies(DATA)) as Assembly[];
      render(
        <MemoryRouter>
          <CoveragePage data={{ ...dataset, assemblies }} billsBySession={billsBySession} localMetas={coverageData.localMetas} />
        </MemoryRouter>,
      );
      const section = screen.getByRole("region", { name: "字が落ちたまま名簿に突き合わせた氏名" });
      for (const m of coverageData.localMetas ?? []) {
        for (const row of m.lossyNameMatches ?? []) {
          expect(section, `${row.nameText} が /coverage に出ていない`).toHaveTextContent(row.nameText);
          expect(section).toHaveTextContent(row.rosterName);
          expect(section).toHaveTextContent(String(row.rollCalls));
        }
      }
    });

    it("議員ページの loader が、その議員の lossyNameMatch を持って返り、画面に出る", async () => {
      const metas = await realLocalMetas();
      let checked = 0;
      for (const m of metas) {
        for (const row of m.lossyNameMatches ?? []) {
          const data = await memberLoader({ params: { id: row.memberId } } as never);
          expect(data.lossyNameMatch, `${row.memberId} の loader が lossyNameMatch を返していない`).toEqual(row);
          render(
            <MemoryRouter>
              <MemberPage detail={data.detail} meta={data.meta} localSources={data.localSources} lossyNameMatch={data.lossyNameMatch} />
            </MemoryRouter>,
          );
          const notice = screen.getByTestId("member-lossy-name");
          expect(notice).toHaveTextContent(row.nameText);
          expect(notice).toHaveTextContent(row.rosterName);
          expect(within(notice).getAllByRole("link").length, "一次資料のリンクが無い").toBeGreaterThan(0);
          notice.remove();
          checked += 1;
        }
      }
      expect(checked, "1 人も見ていない").toBeGreaterThan(0);
    });

    it("否定的対照: lossy でない地方議員の loader は null を返す（誰にでも出したりしない）", async () => {
      const metas = await realLocalMetas();
      const m = metas.find((x) => (x.lossyNameMatches ?? []).length > 0)!;
      const lossyIds = new Set((m.lossyNameMatches ?? []).map((r) => r.memberId));
      const assemblies = (await readAssemblies(DATA)) as Assembly[];
      expect(assemblies.some((a) => a.id === m.assemblyId)).toBe(true);
      // 同じ議会の、lossy でない議員を実データから 1 人取る
      const other = (await readMemberDetail(DATA, otherMemberIdOf(m, lossyIds))) as MemberDetail;
      const data = await memberLoader({ params: { id: other.id } } as never);
      expect(data.lossyNameMatch).toBeNull();
      render(
        <MemoryRouter>
          <MemberPage detail={data.detail} meta={data.meta} localSources={data.localSources} lossyNameMatch={data.lossyNameMatch} />
        </MemoryRouter>,
      );
      expect(screen.queryByTestId("member-lossy-name")).toBeNull();
    });
  });

  it("否定的対照: lossy に載っていない議員のページには注記が出ない", async () => {
    const metas = await realLocalMetas();
    const m = metas.find((x) => (x.lossyNameMatches ?? []).length > 0)!;
    const lossyIds = new Set((m.lossyNameMatches ?? []).map((r) => r.memberId));
    // 同じ議会の、lossy でない議員を 1 人選ぶ（id の連番ではなく、実データの票から辿る）
    const other = (m.lossyNameMatches ?? [])[0];
    const detail = (await readMemberDetail(DATA, other.memberId)) as MemberDetail;
    expect(lossyIds.has(detail.id)).toBe(true);
    render(
      <MemoryRouter>
        <MemberPage detail={detail} meta={null} localSources={m.sources} lossyNameMatch={lossyNameMatchFor(m, "p_00_no_such_member")} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("member-lossy-name")).toBeNull();
  });
});
