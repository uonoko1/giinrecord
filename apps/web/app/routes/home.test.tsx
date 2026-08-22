import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Home from "./home";

describe("Home", () => {
  it("states the site's stance, not an opinion", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("言ったことではなく、やったことを。");
    expect(screen.getByText(/評価はしません/)).toBeInTheDocument();
  });
});
