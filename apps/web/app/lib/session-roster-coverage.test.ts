import { describe, expect, it } from "vitest";
import type { LocalAssemblyMeta } from "./data-contract";
import { SEATS_CHANGED_FLAG, sessionRosterCoverageSummary } from "./session-roster-coverage";

/**
 * **#951: `meta.sessionRosterCoverage` の読み側**。
 *
 * **判定（何を数えるか）は ETL にある**（`packages/etl/src/local-assemblies.ts` の
 * `sessionRosterCoverageOf`）。**ここは `meta.json` が既に書いた行を引くだけ。**
 *
 * **見るのは 3 つ**: **母数を返すこと（#757）／印の線が ETL と同じ値であること／
 * 読めていない議会を「0 件」と同じ形にしないこと。**
 */

const row = (sessionId: string, date: string, seatsChanged: number, rosterAbsent = seatsChanged, unmatchedNames = seatsChanged): LocalAssemblyMeta["sessionRosterCoverage"][number] =>
  ({ sessionId, date, rollcalls: 10, votes: 400, rosterSeen: 40 - rosterAbsent, rosterAbsent, unmatchedNames, unmatchedVotes: unmatchedNames * 10, seatsChanged });

const meta = (rows: LocalAssemblyMeta["sessionRosterCoverage"]): LocalAssemblyMeta =>
  ({
    assemblyId: "pref-29", fetchedAt: "2026-09-21T00:00:00.000Z", sources: [], rosterAsOf: "2026-04-24", sessions: [],
    counts: { members: 40, rollcalls: rows.reduce((n, r) => n + r.rollcalls, 0), cells: 0, unknownCells: 0, unmatchedNames: 0 },
    countChecked: { rows: 0, checked: 0, noCounts: 0, unreadableCells: 0 },
    sessionRosterCoverage: rows,
  }) as LocalAssemblyMeta;

describe("sessionRosterCoverageSummary", () => {
  it("母数（会期の数・名簿の人数）を必ず返す——印が 0 件でも", () => {
    const s = sessionRosterCoverageSummary(meta([row("2026-06", "2026-07-02", 0), row("2026-02", "2026-03-25", 0)]));
    expect(s).toEqual({ sessions: 2, flagged: [], maxSeatsChanged: 0, rosterSize: 40 });
  });

  it("印が付くのは seatsChanged が線以上の会期だけ（境界の内と外の両方を見る）", () => {
    const s = sessionRosterCoverageSummary(
      meta([
        row("a", "2026-07-02", SEATS_CHANGED_FLAG - 1),
        row("b", "2025-07-02", SEATS_CHANGED_FLAG),
        row("c", "2022-10-12", 17),
      ]),
    );
    expect(s!.sessions).toBe(3);
    expect(s!.flagged.map((r) => r.sessionId)).toEqual(["b", "c"]);
    expect(s!.maxSeatsChanged).toBe(17);
  });

  it("meta が無ければ null——「0 件」ではなく「まだ読んでいない」（#757）", () => {
    expect(sessionRosterCoverageSummary(null)).toBeNull();
  });

  it("古い meta（欄が無い）も null——0 件と同じ形にしない", () => {
    const old = { ...meta([]) } as Partial<LocalAssemblyMeta>;
    delete old.sessionRosterCoverage;
    expect(sessionRosterCoverageSummary(old as LocalAssemblyMeta)).toBeNull();
  });

  it("会期が 0 なら maxSeatsChanged は 0（空配列で NaN や -Infinity にしない）", () => {
    expect(sessionRosterCoverageSummary(meta([]))).toEqual({ sessions: 0, flagged: [], maxSeatsChanged: 0, rosterSize: 40 });
  });

  /**
   * **線は ETL 側（`SEATS_CHANGED_FLAG`）と同じ値でなければならない。**
   * **`packages/shared` は型だけで定数を持たない**ので 2 か所にある（`DIET_ASSEMBLY_IDS` と同じ形）。
   * **ETL の原文を読んで突き合わせる**——**片方だけ動かすとここが落ちる。**
   */
  it("線が ETL の SEATS_CHANGED_FLAG と同じ値である（2 か所に同じ値がある）", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    // **`process.cwd()` は `apps/web`**（`defaultDataDir` と同じ前提）。
    // **`import.meta.url` は vitest では file: スキームとは限らない**ので使わない
    const src = await readFile(resolve(process.cwd(), "../../packages/etl/src/local-assemblies.ts"), "utf-8");
    const m = src.match(/export const SEATS_CHANGED_FLAG = (\d+);/);
    expect(m, "ETL 側の SEATS_CHANGED_FLAG が見つからない（名前が変わった？）").not.toBeNull();
    expect(Number(m![1])).toBe(SEATS_CHANGED_FLAG);
  });
});
