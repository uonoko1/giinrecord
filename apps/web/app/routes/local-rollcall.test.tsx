import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { Assembly, LocalAssemblyMeta, LocalRollCall } from "../lib/data-contract";
import mapped from "../test-fixtures/assemblies/data/assemblies/pref-31/rollcalls/2026-06/pref-31-2026-06-20260629-知事提案-第10号.json";
import unmapped from "../test-fixtures/assemblies/data/assemblies/pref-31/rollcalls/2026-06/pref-31-2026-06-20260629-陳情-8年-11.json";
import { LocalRollCallPage, meta as routeMeta } from "./local-rollcall";

const assembly: Assembly = { id: "pref-31", kind: "prefectural", name: "鳥取県議会", prefCode: "31", sourceUrl: "https://www.pref.tottori.lg.jp/gikai/" };
const assemblyMeta: LocalAssemblyMeta = {
  assemblyId: "pref-31",
  fetchedAt: "2026-09-01T00:00:00Z",
  sources: [{ name: "鳥取県議会", url: "https://www.pref.tottori.lg.jp/gikai/", fetchedAt: "2026-09-01T00:00:00Z" }],
  rosterAsOf: "2026-08-01",
  sessions: [{ sessionId: "2026-06", sessionLabel: "令和8年6月定例会", sourceUrl: "https://www.pref.tottori.lg.jp/gikai/", pdfUrl: "https://www.pref.tottori.lg.jp/secure/1422217/R8.6giketsukekka0629.pdf", rollcalls: 3, unknownCells: 0 }],
  counts: { members: 34, rollcalls: 3, cells: 102, unknownCells: 0, unmatchedNames: 0 },
  countChecked: { rows: 10, checked: 10, noCounts: 0, unreadableCells: 0 },
};
const withCounts = mapped as unknown as LocalRollCall;
const withoutCounts = unmapped as unknown as LocalRollCall;

function renderPage(rollCall: LocalRollCall = withCounts) {
  return render(
    <MemoryRouter>
      <LocalRollCallPage rollCall={rollCall} assembly={assembly} meta={assemblyMeta} />
    </MemoryRouter>,
  );
}

describe("LocalRollCallPage 見出し（事実だけ）", () => {
  it("議案名・議決日・会期・議案番号・議決結果を原文のまま出す", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("損害賠償に係る和解及び損害賠償の額の決定について");
    expect(screen.getByText("2026.06.29")).toBeInTheDocument();
    expect(screen.getByText(/令和8年6月定例会/)).toBeInTheDocument();
    expect(screen.getByText(/第10号/)).toBeInTheDocument();
    expect(screen.getByText(/可決/)).toBeInTheDocument();
  });

  /** #791 の絶対原則。一次資料へのリンクが無い行は出せない。 */
  it("一次資料（表決結果 PDF）への外部リンクを出す", () => {
    renderPage();
    const link = screen.getByRole("link", { name: /出典：鳥取県議会 表決結果/ });
    expect(link).toHaveAttribute("href", "https://www.pref.tottori.lg.jp/secure/1422217/R8.6giketsukekka0629.pdf");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toMatch(/noopener/);
  });

  /** #757: 「公表値が 0 件」と「公表値が無い」を同じ出力にしない。 */
  it("公表された人数（counts）があるときは公表値をそのまま出す（votes から数え直さない）", () => {
    renderPage();
    const tally = screen.getByTestId("local-rollcall-counts");
    expect(tally).toHaveTextContent("賛成 34");
    expect(tally).toHaveTextContent("反対 0");
    expect(tally).toHaveTextContent("表決者数 34");
  });
  it("counts が無い議会では「公表されていません」と書き、自分で数えた値を出さない", () => {
    renderPage(withoutCounts);
    expect(screen.getByTestId("local-rollcall-counts")).toHaveTextContent("人数は公表記録にありません");
    expect(screen.queryByText(/賛成 1/)).not.toBeInTheDocument();
    expect(screen.queryByText(/賛成 2/)).not.toBeInTheDocument();
  });

  /** #204: 請願・陳情の ○ は委員長報告への賛成であって採択への賛成ではない。 */
  it("賛否の対象・委員長報告の原文があれば添える", () => {
    renderPage(withoutCounts);
    expect(screen.getByText(/委員長報告に対する賛否 ・ 委員長報告 不採択/)).toBeInTheDocument();
  });
});

describe("LocalRollCallPage 議員ごとの表決", () => {
  it("会派ごとに、原文の並びのまま、判と議員ページへのリンクを出す", () => {
    renderPage();
    const section = screen.getByRole("region", { name: "自由民主党" });
    const rows = within(section).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByRole("link", { name: "山田 太郎" })).toHaveAttribute("href", "/members/p_31_001");
    expect(within(rows[1]).getByRole("link", { name: "鈴木 花子" })).toHaveAttribute("href", "/members/p_31_002");
  });

  /**
   * **順序不変でない検算**（#791 の検査 3）。判の文字と議員名が 1 つずれたら落ちる。
   * 名前 → 判 の対応を、行ごとに名指しで確かめる。
   */
  it("判の文字は各議員のセルの原文で、氏名と 1 対 1 に対応する", () => {
    renderPage();
    // 判（role=img）と氏名（判の次の要素）を、**同じ行の中で**取り出して突き合わせる。
    // 行をまたいで集めた 2 本の配列を比べる形にすると、1 つずらす変異で落ちない（#791 検査 3）。
    const pairs = screen.getAllByRole("listitem").map((li) => {
      const stamp = li.querySelector("[role=img]");
      return [stamp?.getAttribute("aria-label"), stamp?.nextElementSibling?.textContent];
    });
    expect(pairs).toEqual([
      ["○（賛成）", "山田 太郎"],
      ["×（反対）", "鈴木 花子"],
      ["議（議長）", "佐藤 次郎"],
      ["棄（棄権）", "高橋 三郎"],
    ]);
  });

  it("名寄せできなかった議員（memberId が空）はリンクにしない", () => {
    renderPage();
    expect(screen.getByText("佐藤 次郎")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "佐藤 次郎" })).not.toBeInTheDocument();
  });

  /**
   * 凡例から国会の値に読める票だけ色を使う（`localVoteTone`）。
   * 変異テストで気づいた穴: mapped のある票の色を確かめていなかったので、
   * 「全部 raw」にする変異がこのファイルでは落ちなかった（assemblies.test.ts では落ちた）。
   */
  it("mapped のある票は凡例どおりの色（賛成／反対／投票なし）で、raw に潰れない", () => {
    renderPage();
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((r) => within(r).getByRole("img").getAttribute("data-tone"))).toEqual(["yes", "no", "none", "raw"]);
  });

  /** 絶対原則: 凡例から読めない票を「賛成」「反対」に丸めない。 */
  it("mapped の無い票は原文と凡例だけを出し、賛成／反対に丸めない", () => {
    renderPage(withoutCounts);
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]).getByRole("img").getAttribute("aria-label")).toBe("○（委員会審査結果又は議長宣告に起立（賛成）した者）");
    expect(within(rows[0]).getByRole("img")).toHaveAttribute("data-tone", "raw");
    expect(within(rows[1]).getByRole("img")).toHaveAttribute("data-tone", "raw");
  });

  it("会派の見出しに人数を出すが、賛成率のような集計は出さない", () => {
    renderPage();
    const section = screen.getByRole("region", { name: "自由民主党" });
    expect(within(section).getByText(/2名/)).toBeInTheDocument();
    expect(section.textContent).not.toMatch(/%|％|率/);
  });
});

describe("LocalRollCallPage 行き先", () => {
  it("その議会の採決一覧と議会ページへ戻れる", () => {
    renderPage();
    expect(screen.getByRole("link", { name: /鳥取県議会の採決/ })).toHaveAttribute("href", "/assemblies/pref-31/rollcalls");
  });
});

describe("LocalRollCallPage meta", () => {
  it("title は議案名、description は評価を含まない事実だけ", () => {
    const tags = routeMeta({ data: { rollCall: withCounts, assembly, meta: assemblyMeta }, location: { pathname: "/assemblies/pref-31/rollcalls/x" } } as never);
    const title = tags.find((t) => "title" in t) as { title: string };
    expect(title.title).toContain("損害賠償に係る和解及び損害賠償の額の決定について");
    const desc = tags.find((t) => (t as { name?: string }).name === "description") as { content: string };
    expect(desc.content).toContain("鳥取県議会");
    expect(desc.content).not.toMatch(/評価|おすすめ|ランキング|率/);
  });
});
