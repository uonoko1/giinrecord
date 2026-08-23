import { render as rtlRender, screen } from "@testing-library/react";
import type React from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { VerifySection } from "./VerifySection";

const repo = "https://github.com/uonoko1/gikailog";

/** 費目・金額・未確定の表現は書かない（#160）。 */
const BANNED_WORDS = ["VPS", "ドメイン", "未算出", "取得予定", "月額", "円"];
/** 運動的・煽り的な言葉。事実と依頼だけを書く（#47）。 */
const CAMPAIGN_WORDS = ["応援", "守る", "守ろう", "ぜひ", "お願いします", "あなたの力", "みんなで", "寄付をお願い"];

function render(ui: React.ReactElement) {
  return rtlRender(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("VerifySection", () => {
  it("ソースコード・誤りを報告・GitHub のデータはリポジトリ URL を指す", () => {
    render(<VerifySection />);
    expect(screen.getByRole("link", { name: "ソースコード" })).toHaveAttribute("href", repo);
    expect(screen.getByRole("link", { name: "誤りを報告" })).toHaveAttribute("href", `${repo}/issues/new`);
    expect(screen.getByRole("link", { name: "GitHub のデータ" })).toHaveAttribute("href", `${repo}/tree/main/data`);
  });

  it("データ一括取得は自サイトの zip を指し、ライセンス CC BY 4.0 を添える（#49）", () => {
    render(<VerifySection />);
    const link = screen.getByRole("link", { name: "データ一括取得" });
    expect(link).toHaveAttribute("href", "/data/data-archive.zip");
    expect(link).toHaveAttribute("download");
    expect(screen.getByRole("region", { name: "検証する" })).toHaveTextContent("CC BY 4.0");
  });
});

describe("VerifySection（#166）", () => {
  it("一括取得の説明は短く、ビルドの話を書かない", () => {
    render(<VerifySection />);
    const section = screen.getByRole("region", { name: "検証する" });
    expect(section).toHaveTextContent("毎日更新。CC BY 4.0。出典として「議会ログ」と一次資料（参議院・衆議院・国立国会図書館）を明記してください。個人・非営利・商用いずれも同じ条件です。");
    for (const word of ["ビルド", "作り直され", "zip", "LICENSE", "README"]) {
      expect(section.textContent).not.toContain(word);
    }
  });
});

describe("VerifySection（#174 運営費の1文）", () => {
  it("末尾に運営費の1文を書き、利用規約（/terms）へリンクする", () => {
    render(<VerifySection />);
    const section = screen.getByRole("region", { name: "検証する" });
    expect(section).toHaveTextContent("運営者の自費で運営し、政党・候補者・業界団体からは受け取っていません。運営の方針は利用規約に書いています。");
    expect(screen.getByRole("link", { name: "利用規約" })).toHaveAttribute("href", "/terms");
    const paragraphs = section.querySelectorAll("p");
    expect(paragraphs[paragraphs.length - 1]).toHaveTextContent("運営の方針は利用規約に書いています。");
  });

  it("支援リンクは置かない（/terms 側へ移動）", () => {
    render(<VerifySection />);
    expect(screen.queryByRole("link", { name: "支援する" })).toBeNull();
  });

  it("費目・金額・未確定の表現、運動的な言葉を含まない", () => {
    const { container } = render(<VerifySection />);
    for (const word of [...BANNED_WORDS, ...CAMPAIGN_WORDS]) {
      expect(container.textContent).not.toContain(word);
    }
  });
});
