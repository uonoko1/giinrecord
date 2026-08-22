import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Cover } from "./Cover";

describe("Cover", () => {
  it("氏名・ふりがな・所属・件数帯を表示する", () => {
    render(
      <Cover
        name="藤川 政人"
        kana="ふじかわ まさひと"
        house="sangiin"
        group="自由民主党"
        district="愛知"
        counts={{ rollcalls: 12, bills: 3, speeches: 7 }}
      />,
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("藤川 政人");
    expect(screen.getByText("ふじかわ まさひと")).toBeInTheDocument();
    expect(screen.getByText(/参議院/)).toBeInTheDocument();
    expect(screen.getByText(/自由民主党/)).toBeInTheDocument();
    expect(screen.getByText(/愛知/)).toBeInTheDocument();
    const counts = screen.getByRole("list", { name: "記録件数" });
    expect(counts).toHaveTextContent("採決12");
    expect(counts).toHaveTextContent("提出法案3");
    expect(counts).toHaveTextContent("発言7");
  });

  it("衆議院は「衆議院」と表示する", () => {
    render(<Cover name="x" kana="x" house="shugiin" group="g" district="d" counts={{ rollcalls: 0, bills: 0, speeches: 0 }} />);
    expect(screen.getByText(/衆議院/)).toBeInTheDocument();
  });
});
