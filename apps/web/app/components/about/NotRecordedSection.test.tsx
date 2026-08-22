import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NotRecordedSection } from "./NotRecordedSection";

describe("NotRecordedSection", () => {
  it("記録にないことを4項目列挙する", () => {
    render(<NotRecordedSection />);
    const section = screen.getByRole("region", { name: "記録にないこと" });
    expect(section.querySelectorAll("li")).toHaveLength(4);
    expect(screen.getByText("「投票なし」が欠席か棄権か")).toBeInTheDocument();
    expect(screen.getByText("選挙公約との一致・不一致の判定")).toBeInTheDocument();
  });
});
