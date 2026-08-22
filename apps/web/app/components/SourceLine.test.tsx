import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SourceLine } from "./SourceLine";

const url = "https://www.sangiin.go.jp/japanese/joho1/kousei/vote/221/221-0724-v001.htm";

describe("SourceLine", () => {
  it("出典リンクと取得日時を出す", () => {
    render(<SourceLine sourceUrl={url} fetchedAt="2026-08-21T03:00:00Z" />);
    const link = screen.getByRole("link", { name: /出典/ });
    expect(link).toHaveAttribute("href", url);
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(screen.getByText(/取得/)).toHaveTextContent("2026-08-21T03:00:00Z");
  });

  it("出典名を指定できる", () => {
    render(<SourceLine sourceUrl="https://www.sangiin.go.jp/" sourceName="参議院" fetchedAt="2026-08-21T03:00:00Z" />);
    expect(screen.getByRole("link", { name: /参議院/ })).toBeInTheDocument();
  });
});
