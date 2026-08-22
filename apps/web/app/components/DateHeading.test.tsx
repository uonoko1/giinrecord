import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DateHeading } from "./DateHeading";

describe("DateHeading", () => {
  it("日付を time 要素で、ラベルを添えて表示する", () => {
    render(<DateHeading date="2025-07-24" label="本会議" />);
    const time = screen.getByText("2025-07-24");
    expect(time.tagName).toBe("TIME");
    expect(time).toHaveAttribute("datetime", "2025-07-24");
    expect(time.style.color).toBe("var(--brass)");
    expect(screen.getByText("本会議")).toBeInTheDocument();
  });

  it("ラベルなしでも日付だけ出る", () => {
    render(<DateHeading date="2025-07-24" />);
    expect(screen.getByText("2025-07-24")).toBeInTheDocument();
  });
});
