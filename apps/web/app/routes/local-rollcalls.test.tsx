import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { Assembly, LocalRollCallSummary } from "../lib/data-contract";
import index from "../test-fixtures/assemblies/data/assemblies/pref-31/rollcalls/index.json";
import shigaIndex from "../test-fixtures/assemblies/data/assemblies/pref-25/rollcalls/index.json";
import { LocalRollCallsPage, meta as routeMeta } from "./local-rollcalls";

const assembly: Assembly = { id: "pref-31", kind: "prefectural", name: "鳥取県議会", prefCode: "31", sourceUrl: "https://www.pref.tottori.lg.jp/gikai/" };
const rollCalls = index as unknown as LocalRollCallSummary[];

function renderPage(list: LocalRollCallSummary[] = rollCalls) {
  return render(
    <MemoryRouter>
      <LocalRollCallsPage assembly={assembly} rollCalls={list} />
    </MemoryRouter>,
  );
}

describe("LocalRollCallsPage", () => {
  it("議会名と件数を出す", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("鳥取県議会");
    expect(screen.getByTestId("local-rollcalls-total")).toHaveTextContent("3 件");
  });

  /**
   * #757: **「0 件」と「1 件も読めていない」を同じ出力にしない。**
   * 母数（件数）を消すと落ちる。
   */
  it("1 件も無いときは 0 件とは書かず、取得していない事実を書く", () => {
    renderPage([]);
    expect(screen.getByTestId("local-rollcalls-total")).toHaveTextContent("表決の記録は取得していません");
    expect(screen.getByTestId("local-rollcalls-total").textContent).not.toMatch(/0 件/);
  });

  it("1 行ごとに議決日・議案名・議案番号・議決結果と、採決 1 件のページへのリンクを出す", () => {
    renderPage();
    const rows = screen.getAllByRole("row").slice(1); // thead を除く
    expect(rows).toHaveLength(3);
    const first = rows[0];
    expect(within(first).getByRole("link", { name: /損害賠償に係る和解/ })).toHaveAttribute("href", "/assemblies/pref-31/rollcalls/pref-31-2026-06-20260629-知事提案-第10号");
    expect(first).toHaveTextContent("2026.06.29");
    expect(first).toHaveTextContent("第10号");
    expect(first).toHaveTextContent("可決");
  });

  /**
   * **絶対原則**（#791 の検査 1）。一次資料へのリンクが無い行は出せない。
   * 全行が外部の表決結果へのリンクを持つことを、行ごとに確かめる。
   */
  it("全行が一次資料（表決結果）への外部リンクを持つ", () => {
    renderPage();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const link = within(row).getByRole("link", { name: "表決結果（公式）" });
      expect(link.getAttribute("href")).toMatch(/^https:\/\/www\.pref\.tottori\.lg\.jp\//);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link.getAttribute("rel")).toMatch(/noopener/);
    }
  });

  /** 一次資料の無い行は**落とさずに**「出典がありません」と書く、ではなく——出さない（絶対原則）。 */
  it("sourceUrl の無い行は表に出さず、出さなかった件数を書く", () => {
    const broken = [{ ...rollCalls[0], id: "broken", sourceUrl: "" }, ...rollCalls];
    renderPage(broken as LocalRollCallSummary[]);
    expect(screen.getAllByRole("row").slice(1)).toHaveLength(3);
    expect(screen.getByTestId("local-rollcalls-omitted")).toHaveTextContent("1 件");
  });

  it("評価・順位・賛成率を出さない", () => {
    renderPage();
    expect(document.body.textContent).not.toMatch(/％|%|賛成率|ランキング|順位|おすすめ/);
  });

  it("議会ページへ戻れる", () => {
    renderPage();
    expect(screen.getByRole("link", { name: /鳥取県議会のページ/ })).toHaveAttribute("href", "/assemblies/pref-31");
  });
});

describe("LocalRollCallsPage meta", () => {
  it("title に議会名、description は事実だけ", () => {
    const tags = routeMeta({ data: { assembly, rollCalls }, location: { pathname: "/assemblies/pref-31/rollcalls" } } as never);
    const title = tags.find((t) => "title" in t) as { title: string };
    expect(title.title).toContain("鳥取県議会");
    const desc = tags.find((t) => (t as { name?: string }).name === "description") as { content: string };
    expect(desc.content).not.toMatch(/評価|おすすめ|ランキング|率/);
  });
});

/**
 * #1003: **一覧の「結果」列が空セルだった。**
 * `resultAbsent: true`（一次資料に書かれていない）と、読み取りが壊れて空になった場合を、
 * **画面で見分けられるようにする。** fixture は本番の実データ（滋賀 `2025-04-rinji` の 4 行。3 行が `resultAbsent`）。
 */
describe("LocalRollCallsPage 議決結果が一次資料に無い行（#1003）", () => {
  const shiga: Assembly = { id: "pref-25", kind: "prefectural", name: "滋賀県議会", prefCode: "25", sourceUrl: "https://www.shigaken-gikai.jp/" };
  const shigaRows = shigaIndex as unknown as LocalRollCallSummary[];

  function renderShiga(list: LocalRollCallSummary[] = shigaRows) {
    return render(
      <MemoryRouter>
        <LocalRollCallsPage assembly={shiga} rollCalls={list} />
      </MemoryRouter>,
    );
  }

  /** **母数つきで数える**（#757）。4 行のうち 3 行が空、1 行は原文どおり「承認」。 */
  it("resultAbsent の行にだけ「一次資料に記載なし」を出し、結果のある行は原文のまま出す", () => {
    renderShiga();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    const notes = screen.getAllByTestId("local-rollcalls-result-absent");
    expect(notes).toHaveLength(3);
    for (const n of notes) {
      expect(n).toHaveTextContent(/記載.*ありません|記載なし/);
      // **可否を多数決から推論しない**（#901 / DATA_CONTRACT）
      expect(n.textContent).not.toMatch(/可決|否決|承認|不承認|採択/);
    }
    const approved = rows.find((r) => r.textContent?.includes("議第97号を承認すべきものとする"));
    expect(approved).toBeDefined();
    expect(approved).toHaveTextContent("承認");
    expect(within(approved as HTMLElement).queryByTestId("local-rollcalls-result-absent")).not.toBeInTheDocument();
  });

  /**
   * **ここがこの PBI の要**（#569）。**`resultAbsent` の無い空の `result`** は読み取り事故の形で、
   * ETL が今までどおり違反として弾く。**画面で「一次資料に記載がありません」と書けば、
   * こちらの事故を県のせいにする虚偽になる。** 空のまま出す（利用者が「出ていない」と気づける）。
   */
  it("resultAbsent が無い空の result（読み取り事故）には「一次資料に記載がありません」と書かない", () => {
    const broken = { ...shigaRows[0] } as Record<string, unknown>;
    delete broken.resultAbsent;
    renderShiga([broken as unknown as LocalRollCallSummary]);
    expect(screen.queryAllByTestId("local-rollcalls-result-absent")).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/一次資料に記載がありません/);
  });

  /** `number` が空でも議案名の下の補足が「議案等 ・」で終わらない（滋賀は 163 件すべて number が空）。 */
  it("number が空でも `・` が余らない", () => {
    renderShiga();
    for (const note of document.querySelectorAll(".assemblies-status-note")) {
      expect(note.textContent).not.toMatch(/・\s*$|^\s*・|・\s*・/);
    }
  });

  /** 鳥取（結果が全行読めている）には注記が 1 つも出ない。 */
  it("結果が全行読めている議会には注記を出さない", () => {
    renderPage();
    expect(screen.queryAllByTestId("local-rollcalls-result-absent")).toHaveLength(0);
  });
});
