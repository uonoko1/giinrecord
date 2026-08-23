import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NotRecordedSection } from "./NotRecordedSection";

describe("NotRecordedSection", () => {
  it("記録にないことを5項目列挙する", () => {
    render(<NotRecordedSection />);
    const section = screen.getByRole("region", { name: "記録にないこと" });
    expect(section.querySelectorAll("li")).toHaveLength(5);
    expect(screen.getByText("「投票なし」が欠席か棄権か")).toBeInTheDocument();
    expect(screen.getByText("選挙公約との一致・不一致の判定")).toBeInTheDocument();
  });

  it("参法の共同発議者・賛成者名が一次資料に無いことを、その文言で書く（#63）", () => {
    render(<NotRecordedSection />);
    expect(screen.getByText("参議院の議員立法の共同発議者・賛成者名（一次資料に掲載なし）")).toBeInTheDocument();
  });
});
