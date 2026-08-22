import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VerifySection } from "./VerifySection";

const repo = "https://github.com/uonoko1/seiji-kiroku";

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
