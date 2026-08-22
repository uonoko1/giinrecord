import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AnalyticsSection } from "./AnalyticsSection";

describe("AnalyticsSection（#58）", () => {
  it("id=analytics の region で、何を記録し何を記録しないかを書く", () => {
    render(<AnalyticsSection />);
    const section = screen.getByRole("region", { name: "計測について" });
    expect(section).toHaveAttribute("id", "analytics");
    expect(section).toHaveTextContent("Cookie");
    expect(section).toHaveTextContent("IP アドレス");
    expect(section).toHaveTextContent("リファラ");
    expect(section.textContent).toMatch(/ページビュー|PV/);
  });
});
