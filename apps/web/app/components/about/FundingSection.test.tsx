import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FundingSection, SUPPORT_URL } from "./FundingSection";

/** 運動的・煽り的な言葉。事実と依頼だけを書く（#47）。 */
const CAMPAIGN_WORDS = ["応援", "守る", "守ろう", "ぜひ", "お願いします", "あなたの力", "みんなで", "寄付をお願い"];

/** 費目・金額・未確定の表現は書かない（#160）。 */
const BANNED_WORDS = ["VPS", "ドメイン", "未算出", "取得予定", "月額", "円"];

describe("FundingSection", () => {
  it("id=funding の region で、方針3点を箇条書きにする", () => {
    render(<FundingSection />);
    const section = screen.getByRole("region", { name: "運営費について" });
    expect(section).toHaveAttribute("id", "funding");
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toHaveLength(3);
    expect(items[0]).toContain("運営者の自費で運営");
    expect(items[1]).toContain("政党・候補者・業界団体からは受け取らない");
    expect(items[2]).toContain("政治カテゴリを除外した広告");
    expect(items[2]).toContain("このページに明記");
  });

  it("費目・金額・未確定の表現を含まない（禁止語）", () => {
    const { container } = render(<FundingSection />);
    for (const word of BANNED_WORDS) {
      expect(container.textContent).not.toContain(word);
    }
    expect(container.querySelector(".rows, .row")).toBeNull();
  });

  it("広告要素は置かない", () => {
    render(<FundingSection />);
    const section = screen.getByRole("region", { name: "運営費について" });
    expect(section.querySelector("ins, iframe, script")).toBeNull();
  });

  it("支援リンクは SUPPORT_URL（GitHub Sponsors 有効化までリポジトリ URL）を指す", () => {
    render(<FundingSection />);
    expect(SUPPORT_URL).toBe("https://github.com/uonoko1/gikailog");
    expect(screen.getByRole("link", { name: "支援する" })).toHaveAttribute("href", SUPPORT_URL);
  });

  it("運動的な言葉を含まない", () => {
    const { container } = render(<FundingSection />);
    for (const word of CAMPAIGN_WORDS) {
      expect(container.textContent).not.toContain(word);
    }
  });
});

describe("FundingSection（#166）", () => {
  it("予告調の表現を含まない", () => {
    const { container } = render(<FundingSection />);
    for (const word of ["将来", "可能性", "事前に", "予定"]) {
      expect(container.textContent).not.toContain(word);
    }
  });
});
