import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { Assembly, MemberAssemblyCount } from "@seiji-kiroku/shared";
import type { AssemblySession, LocalAssemblyMeta } from "../lib/data-contract";
import type { Dataset } from "../lib/dataset";
import assembliesFixture from "../test-fixtures/assemblies/index.json";
import sessionsFixture from "../test-fixtures/assemblies/sessions.json";
import { billsBySession, dataset } from "../test-fixtures/dataset";
import { CoveragePage } from "./coverage";

/**
 * #826: **記号の数と公表された賛成者数・反対者数の食い違い**を `/coverage` に出す。
 *
 * **ETL 側は 5 県で `assert.equal` を撃って止めていた**（宮城・鳥取・島根・佐賀・高知）。
 * **山梨には公表の賛成者数に議長の `〇` が入っていない行が 2 つあり、佐賀には同じ事象で
 * 議長を数えている行が実在する**——**同じ事象でも議会ごとに数え方が違う。**
 * **止めれば正しい記録まで出なくなる**ので、**件数として出す**（#811 の判断）。
 *
 * **「出した」は「見えるようにした」ではない**（#800）。**`meta.json` は `/data/` で配信されない**ので、
 * ここで出さなければ `git clone` した人にしか読めない。
 *
 * **「0 件」と「1 件も突き合わせていない」を同じ出力にしない**（#757）。
 */

const assemblies = assembliesFixture as Assembly[];
const sessions = new Map<string, AssemblySession[]>([["pref-04", sessionsFixture as AssemblySession[]]]);
const withLocal: Dataset = { ...dataset, assemblies };
const byAssembly: MemberAssemblyCount[] = [
  { assemblyId: "diet-sangiin", current: 2, total: 3 },
  { assemblyId: "pref-04", current: 2, total: 3 },
];

const metaOf = (over: Partial<LocalAssemblyMeta> = {}): LocalAssemblyMeta =>
  ({
    assemblyId: "pref-04",
    fetchedAt: "2026-09-04T22:17:32.500Z",
    rosterAsOf: "2026-04-24",
    sessions: [],
    sources: [{ name: "宮城県議会 表決結果", url: "https://www.pref.miyagi.jp/soshiki/gikai/hyouketsu.html", fetchedAt: "2026-09-04T22:17:32.500Z" }],
    counts: { members: 59, rollcalls: 5, cells: 100, unknownCells: 0, unmatchedNames: 0 },
    countChecked: { rows: 5, checked: 5, noCounts: 0, unreadableCells: 0 },
    ...over,
  }) as LocalAssemblyMeta;

/** **山梨の row9 / row6 と同じ形**（公表の賛成者数に議長の `〇` が入っていない） */
const YAMANASHI_SHAPED = [
  { rollCallId: "pref-04-398-20251217-発議案-9", counted: { yes: 19, no: 17 }, published: { yes: 18, no: 17 } },
  { rollCallId: "pref-04-398-20251217-発議案-6", counted: { yes: 18, no: 18 }, published: { yes: 17, no: 18 } },
];

const SECTION = "記号の数と公表された賛成者数・反対者数の突き合わせ";

function renderPage(localMetas: LocalAssemblyMeta[] | null) {
  return render(
    <MemoryRouter>
      <CoveragePage data={withLocal} sessions={sessions} billsBySession={billsBySession} membersByAssembly={byAssembly} localMetas={localMetas} />
    </MemoryRouter>,
  );
}

describe("/coverage: 記号の数と公表値の食い違い（#826）", () => {
  it("食い違った表決は、数えた数と公表された数の両方を出す（どちらが正しいかは書かない）", () => {
    renderPage([metaOf({ countMismatches: YAMANASHI_SHAPED } as Partial<LocalAssemblyMeta>)]);
    const section = screen.getByRole("region", { name: SECTION });
    const table = within(section).getByRole("table", { name: "宮城県議会の記号の数と公表値の食い違い" });
    const row = within(table).getByRole("row", { name: /発議案-9/ });
    // **数えた 19／17 と 公表 18／17 の両方が出る**（片方だけだと、どちらを見ているか分からない）
    expect(row).toHaveTextContent("19");
    expect(row).toHaveTextContent("18");
    expect(section).toHaveTextContent("2 件");
    // **表決そのものへ行ける**（「人が見に行ける」が #811 の判断の要点）
    expect(within(row).getByRole("link")).toHaveAttribute("href", "/assemblies/pref-04/rollcalls/pref-04-398-20251217-発議案-9");
  });

  it("食い違いが 0 のときは、母数を添えて「無い」と言う（#757。0 件と未突合を混ぜない）", () => {
    renderPage([metaOf()]);
    const section = screen.getByRole("region", { name: SECTION });
    expect(within(section).getByTestId("coverage-count-mismatch-none")).toBeInTheDocument();
    expect(section).toHaveTextContent("5");
  });

  it("counts の欄が無くて突き合わせていない件数を出す（高知 104 件・徳島 105 件の形）", () => {
    renderPage([metaOf({ countChecked: { rows: 104, checked: 0, noCounts: 104, unreadableCells: 0 } } as Partial<LocalAssemblyMeta>)]);
    const section = screen.getByRole("region", { name: SECTION });
    expect(section).toHaveTextContent("104");
    expect(section).toHaveTextContent("賛成者数の欄が PDF に無い");
  });

  it("凡例の読めないセルがあって突き合わせていない件数を出す（滋賀 4 件の形）", () => {
    renderPage([metaOf({ countChecked: { rows: 14, checked: 10, noCounts: 0, unreadableCells: 4 } } as Partial<LocalAssemblyMeta>)]);
    const section = screen.getByRole("region", { name: SECTION });
    expect(section).toHaveTextContent("凡例が読み取れないセルがある");
  });

  it("否定的対照: meta を 1 件も読めていなければ節ごと出さない（0 件と混ぜない。#757）", () => {
    renderPage(null);
    expect(screen.queryByRole("region", { name: SECTION })).toBeNull();
  });

  it("評価を書かない: 「誤り」「正しい」と断じる語を出さない", () => {
    renderPage([metaOf({ countMismatches: YAMANASHI_SHAPED } as Partial<LocalAssemblyMeta>)]);
    const section = screen.getByRole("region", { name: SECTION });
    expect(section.textContent).toContain("どちらが正しいかはこのサイトでは判断しません");
  });
});
