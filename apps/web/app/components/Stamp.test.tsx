import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Stamp } from "./Stamp";

describe("Stamp", () => {
  it.each(["賛成", "反対", "投票なし", "発言", "提出"] as const)("「%s」を aria-label と文字で示す", (value) => {
    render(<Stamp value={value} />);
    const el = screen.getByLabelText(value);
    expect(el).toHaveTextContent(value);
    expect(el).toHaveAttribute("data-value", value);
  });

  it("見た目は value から決まり、tokens の変数だけを使う", () => {
    render(<Stamp value="賛成" />);
    const el = screen.getByLabelText("賛成");
    expect(el.style.background).toBe("var(--yes-bg)");
    expect(el.style.color).toBe("var(--yes-fg)");
  });
});
