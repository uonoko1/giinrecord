import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FundingSection, SUPPORT_URL } from "./FundingSection";

/** 運動的・煽り的な言葉。事実と依頼だけを書く（#47）。 */
const CAMPAIGN_WORDS = ["応援", "守る", "守ろう", "ぜひ", "お願いします", "あなたの力", "みんなで", "寄付をお願い"];

describe("FundingSection", () => {
  it("id=funding の region で、費用・収入源・受け取らないもの・公開の約束を書く", () => {
    render(<FundingSection />);
    const section = screen.getByRole("region", { name: "運営費について" });
    expect(section).toHaveAttribute("id", "funding");
    for (const t of ["VPS", "未算出", "ドメイン", "取得予定", "運営者の自費", "政党・候補者・業界団体からは一切受け取りません", "資金源と支出を公開します"]) {
      expect(section).toHaveTextContent(t);
    }
  });

  it("広告は将来の可能性として予告だけし、広告要素は置かない", () => {
    render(<FundingSection />);
    const section = screen.getByRole("region", { name: "運営費について" });
    expect(section).toHaveTextContent("政治カテゴリを除外した広告");
    expect(section.querySelector("ins, iframe, script")).toBeNull();
  });

  it("支援リンクは SUPPORT_URL（GitHub Sponsors 有効化までリポジトリ URL）を指す", () => {
    render(<FundingSection />);
    expect(SUPPORT_URL).toBe("https://github.com/uonoko1/seiji-kiroku");
    expect(screen.getByRole("link", { name: "支援する" })).toHaveAttribute("href", SUPPORT_URL);
  });

  it("運動的な言葉を含まない", () => {
    const { container } = render(<FundingSection />);
    for (const word of CAMPAIGN_WORDS) {
      expect(container.textContent).not.toContain(word);
    }
  });
});
