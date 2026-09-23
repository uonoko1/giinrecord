import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { Assembly } from "@seiji-kiroku/shared";
import type { LocalAssemblyMeta } from "../lib/data-contract";
import { defaultDataDir, readAssemblies, readLocalAssemblyMetas } from "../lib/data-files";
import { SEATS_CHANGED_FLAG, sessionRosterCoverageSummary } from "../lib/session-roster-coverage";
import { CoveragePage } from "./coverage";
import { billsBySession, dataset } from "../test-fixtures/dataset";

/**
 * **#951 の本丸**: **ETL が `meta.json` に書いた痕跡が、画面にも出ていること。**
 *
 * **`data/assemblies/pref-{2桁}/meta.json` はバンドルもされず `/data/` でも配信されない。**
 * **`git clone` した人しか読めない**——**それが #800 で実際に起きたこと**
 * （`lossyNameMatches` を 11 県すべてに書いたのに `grep -rn lossyNameMatches apps/web` が 0 件）。
 *
 * **本番の印は今 0 件である**（下で数える）。**だから「該当が 1 件以上ある」を前提にできない。**
 * **代わりに母数が画面に出ていることを見る**（#757）。
 * **印が付いた場合の画面は、本番の値のコピーに 1 行足して確かめる**（**本番のファイルは書き換えない**）。
 */

const DATA = defaultDataDir();

async function realLocalMetas(): Promise<LocalAssemblyMeta[]> {
  const metas = await readLocalAssemblyMetas(DATA);
  expect(metas, "assemblies/index.json が読めない").not.toBeNull();
  return metas ?? [];
}

const SECTION = "古い会期に今の議員名簿を当てていないか";

async function renderCoverage(metas: LocalAssemblyMeta[]) {
  const assemblies = (await readAssemblies(DATA)) as Assembly[];
  render(
    <MemoryRouter>
      <CoveragePage data={{ ...dataset, assemblies }} billsBySession={billsBySession} localMetas={metas} />
    </MemoryRouter>,
  );
}

describe("#951 本番データ: 会期ごとの名簿の写り方が画面に出る", () => {
  it("11 県すべての meta.json に sessionRosterCoverage がある（前提の確認。無ければ以降の検査は空回りしている）", async () => {
    const metas = await realLocalMetas();
    const local = metas.filter((m) => m.assemblyId.startsWith("pref-"));
    expect(local.length).toBe(11);
    for (const m of local) expect(sessionRosterCoverageSummary(m), `${m.assemblyId} に sessionRosterCoverage が無い`).not.toBeNull();
  });

  /**
   * **本番の母数と印の件数を固定する**（#757。**「数えていない」と区別する**）。
   *
   * **実測 2026-09-23**: **11 議会 / 82 会期（#901 の島根で 79 → 82）。`seatsChanged` の最大は 4（三重）で、
   * 印（10 以上）は 0 件。** **#901 が会期を広げると、ここが動いて数え直しを強制する。**
   */
  it("本番の母数と印の件数を固定する（82 会期・最大 4・印 0 件）", async () => {
    const metas = await realLocalMetas();
    const local = metas.filter((m) => m.assemblyId.startsWith("pref-"));
    const sums = local.map((m) => sessionRosterCoverageSummary(m)!);
    expect({
      assemblies: local.length,
      sessions: sums.reduce((n, s) => n + s.sessions, 0),
      maxSeatsChanged: sums.reduce((n, s) => Math.max(n, s.maxSeatsChanged), 0),
      flagged: sums.reduce((n, s) => n + s.flagged.length, 0),
    }).toEqual({ assemblies: 11, sessions: 82, maxSeatsChanged: 4, flagged: 0 });
    // **線は今までに起きた最大（4）の外に在る**（内側に引けば今すぐ赤くなり、誰も見なくなる。#785）
    expect(SEATS_CHANGED_FLAG).toBeGreaterThan(4);
  });

  it("/coverage に、本番の母数（82 会期）と「印の付いた会期は無い」が出る", async () => {
    await renderCoverage(await realLocalMetas());
    const section = screen.getByRole("region", { name: SECTION });
    // **母数が出ていること**（#757。「0 件」は「見た上での 0」でなければ意味が無い）
    expect(section).toHaveTextContent("82");
    // **今までに起きた最大も出す**（「入れ替わりは無い」と読ませない）
    expect(section).toHaveTextContent("4");
    expect(within(section).getByTestId("coverage-session-roster-none")).toBeInTheDocument();
    // **推定を書いていない**（#569）——**「選挙」や「同一人物」と断定しない**
    expect(section).toHaveTextContent("誰と誰が入れ替わったかは書きません");
    expect(section).toHaveTextContent("選挙があったとも書きません");
  });

  /**
   * **印が付いたときに画面に出ること**——**今 0 件なので、本番の値のコピーに 1 行足して確かめる。**
   * **足すのは #950 が奈良で測った形**（41 人中 17 人が入れ替わった 2022 年の会期）。
   */
  it("境をまたいだ会期が出たら、その議会のブロックが画面に出る（奈良の 17 人を足して確かめる）", async () => {
    const metas = await realLocalMetas();
    const nara = metas.find((m) => m.assemblyId === "pref-29");
    expect(nara, "pref-29 の meta.json が読めない").toBeDefined();
    // **本番のファイルは書き換えない。** 読み込んだ値のコピーに、#950 が測った形の行を 1 つ足す
    const withOne: LocalAssemblyMeta[] = metas.map((m) =>
      m.assemblyId === "pref-29"
        ? ({
            ...m,
            sessionRosterCoverage: [
              ...m.sessionRosterCoverage,
              { sessionId: "2022-09", date: "2022-10-12", rollcalls: 4, votes: 164, rosterSeen: 23, rosterAbsent: 17, unmatchedNames: 17, unmatchedVotes: 68, seatsChanged: 17 },
            ],
          } as LocalAssemblyMeta)
        : m,
    );
    await renderCoverage(withOne);
    const section = screen.getByRole("region", { name: SECTION });
    const block = within(section).getByTestId("coverage-session-roster-pref-29");
    expect(block).toHaveTextContent("2022-09");
    expect(block).toHaveTextContent("17");
    // **母数（この議会の会期数と名簿の人数）も一緒に出る**（#757）
    expect(block).toHaveTextContent("5 会期");
    expect(block).toHaveTextContent("40 人");
    // **またいでいない議会のブロックは出ない**（**否定的対照**。全議会に出るなら何も言っていない）
    expect(within(section).queryByTestId("coverage-session-roster-pref-24")).toBeNull();
    expect(within(section).queryByTestId("coverage-session-roster-none")).toBeNull();
  });

  /**
   * **評価・推測を書かない**（絶対原則。`coverage-lossy-name.test.tsx` と同じ語の並び）。
   *
   * **この節は真っ先にこれを踏む**——**書きかけた文が実際に踏んだ**
   * （「同じ氏名でも別の人である**可能性**があります」→
   * 「同じ氏名が同じ人かどうかは、公表されている資料からは確かめられません」に直した）。
   * **「確かめられない」は事実、「可能性がある」は評価である。**
   */
  it("評価・推測を書かない（印が付いた画面でも）", async () => {
    const metas = await realLocalMetas();
    const withOne: LocalAssemblyMeta[] = metas.map((m) =>
      m.assemblyId === "pref-29"
        ? ({ ...m, sessionRosterCoverage: [...m.sessionRosterCoverage, { sessionId: "2022-09", date: "2022-10-12", rollcalls: 4, votes: 164, rosterSeen: 23, rosterAbsent: 17, unmatchedNames: 17, unmatchedVotes: 68, seatsChanged: 17 }] } as LocalAssemblyMeta)
        : m,
    );
    await renderCoverage(withOne);
    const section = screen.getByRole("region", { name: SECTION });
    for (const w of ["おそらく", "たぶん", "可能性", "誤り", "間違", "疑わ", "ランキング", "同一人物", "再選", "別人"]) {
      expect(section.textContent, `「${w}」を書いている`).not.toContain(w);
    }
    // **「選挙があった」と断定していない**——**出るのは「とも書きません」という否定の文だけである。**
    // **「選挙」という語だけを禁じると、この説明文ごと書けなくなる**ので、語ではなく文で固定する
    const text = section.textContent ?? "";
    expect(text).toContain("選挙があったとも書きません");
    expect(text.split("選挙があった").length - 1, "「選挙があった」が説明文以外にも出ている").toBe(1);
  });

  /** **meta が 1 件も読めなければ節ごと出さない**（#757。「0 件」と「読めていない」を同じ顔にしない）。 */
  it("localMetas が null なら節ごと出さない", async () => {
    const assemblies = (await readAssemblies(DATA)) as Assembly[];
    render(
      <MemoryRouter>
        <CoveragePage data={{ ...dataset, assemblies }} billsBySession={billsBySession} localMetas={null} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("region", { name: SECTION })).toBeNull();
  });
});
