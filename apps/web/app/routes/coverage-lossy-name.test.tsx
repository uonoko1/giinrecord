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
 * #800: **字が落ちたまま名簿に寄った氏名**を `/coverage` にも出す。
 *
 * `unmatched.json`（突き合わなかった発言）は既にこの画面が件数を出している（#370）のに、
 * **`lossyNameMatches`（字が落ちたまま突き合わせた）はどこにも出ていなかった。**
 * **後者の方が利用者から見えにくい**——票は本人に付いているので、画面上は何も変わって見えない。
 *
 * **「0 件」と「1 件も読めていない」を同じ出力にしない**（#757）。
 * 母数（その議会の表決の総数）を必ず添え、`meta.json` を読めていない議会は**行を出さない**。
 */

const assemblies = assembliesFixture as Assembly[];
const sessions = new Map<string, AssemblySession[]>([["pref-04", sessionsFixture as AssemblySession[]]]);
const withLocal: Dataset = { ...dataset, assemblies };
const byAssembly: MemberAssemblyCount[] = [
  { assemblyId: "diet-sangiin", current: 2, total: 3 },
  { assemblyId: "pref-04", current: 2, total: 3 },
];

const metaOf = (lossy?: LocalAssemblyMeta["lossyNameMatches"], rollcalls = 5): LocalAssemblyMeta =>
  ({
    assemblyId: "pref-04",
    fetchedAt: "2026-09-04T22:17:32.500Z",
    rosterAsOf: "2026-04-24",
    sessions: [],
    sources: [{ name: "宮城県議会 表決結果", url: "https://www.pref.miyagi.jp/soshiki/gikai/hyouketsu.html", fetchedAt: "2026-09-04T22:17:32.500Z" }],
    counts: { members: 59, rollcalls, cells: 100, unknownCells: 0, unmatchedNames: 0 },
    ...(lossy ? { lossyNameMatches: lossy } : {}),
  }) as LocalAssemblyMeta;

const LOSSY = [
  { memberId: "p_04_000001", nameText: "西川", rosterName: "西川 均", rollCalls: 4 },
  { memberId: "p_04_000002", nameText: "髙清友", rosterName: "芦高 清友", rollCalls: 1 },
];

function renderPage(localMetas: LocalAssemblyMeta[] | null) {
  return render(
    <MemoryRouter>
      <CoveragePage data={withLocal} sessions={sessions} billsBySession={billsBySession} membersByAssembly={byAssembly} localMetas={localMetas} />
    </MemoryRouter>,
  );
}

describe("/coverage: 字が落ちたまま名簿に寄った氏名（#800）", () => {
  it("該当のある議会は、人数・表決の件数・母数と、印字されていた氏名と名簿の氏名を原文で出す", () => {
    renderPage([metaOf(LOSSY)]);
    const section = screen.getByRole("region", { name: "字が落ちたまま名簿に突き合わせた氏名" });
    expect(within(section).getByRole("heading", { level: 3 })).toHaveTextContent("宮城県議会");
    expect(section).toHaveTextContent("西川");
    expect(section).toHaveTextContent("西川 均");
    expect(section).toHaveTextContent("髙清友");
    expect(section).toHaveTextContent("芦高 清友");
  });

  it("母数を出す（#757）。件数 5 件／母数 5 件", () => {
    renderPage([metaOf(LOSSY)]);
    const row = screen.getByTestId("coverage-lossy-pref-04");
    expect(row).toHaveTextContent("2"); // 人数
    expect(row).toHaveTextContent("5"); // 表決の件数（4+1）と母数（counts.rollcalls）
  });

  it("一次資料へのリンクを出す（絶対原則）", () => {
    renderPage([metaOf(LOSSY)]);
    const section = screen.getByRole("region", { name: "字が落ちたまま名簿に突き合わせた氏名" });
    const hrefs = within(section).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("https://www.pref.miyagi.jp/soshiki/gikai/hyouketsu.html");
  });

  it("否定的対照: 0 件の議会（11 県中 10 県）には該当の行を出さない。ただし「0 件」であることは母数つきで書く", () => {
    renderPage([metaOf(undefined, 5)]);
    const section = screen.getByRole("region", { name: "字が落ちたまま名簿に突き合わせた氏名" });
    expect(screen.queryByTestId("coverage-lossy-pref-04")).toBeNull();
    expect(section).toHaveTextContent("0");
    expect(section).toHaveTextContent("5"); // 母数は出す（0 件だと言える根拠）
    expect(section.textContent).not.toContain("西川");
  });

  it("否定的対照: meta を 1 つも読めていないときは「0 件」と言わない（#757）", () => {
    renderPage(null);
    expect(screen.queryByRole("region", { name: "字が落ちたまま名簿に突き合わせた氏名" })).toBeNull();
  });

  /**
   * **`if (!metas) return null` は、`rows.length === 0` の早期 return があるので
   * 今の 2 ケース（null と空配列）では同じ結果になる＝等価変異である**（#800 の変異テストで確認した）。
   * **区別が観測できるのは読み側**——`readLocalAssemblyMetas` が「index.json が無い」ときに
   * **`[]` ではなく `null`** を返すこと（`data-files.test.ts`）。ここでは
   * **「読んだが該当 0 件」は節を出して 0 と母数を書く**という、null との違いを固定する。
   */
  it("「読んだが 0 件」と「1 件も読めていない」は違う画面になる（#757）", () => {
    renderPage([metaOf(undefined, 5)]);
    expect(screen.getByRole("region", { name: "字が落ちたまま名簿に突き合わせた氏名" })).toHaveTextContent("該当する議会はありません");
    screen.getByRole("region", { name: "字が落ちたまま名簿に突き合わせた氏名" }).remove();
    renderPage(null);
    expect(screen.queryByText("該当する議会はありません")).toBeNull();
  });

  it("評価・推測を書かない", () => {
    const { container } = renderPage([metaOf(LOSSY)]);
    for (const w of ["おそらく", "たぶん", "可能性", "誤り", "間違", "疑わ", "ランキング"]) expect(container.textContent).not.toContain(w);
  });
});
