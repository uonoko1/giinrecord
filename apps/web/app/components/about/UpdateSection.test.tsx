import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UpdateSection } from "./UpdateSection";
import { dataset } from "../../test-fixtures/dataset";

describe("UpdateSection", () => {
  it("出典ごとに名前と取得時刻を出す", () => {
    render(<UpdateSection meta={dataset.meta} />);
    expect(screen.getByRole("region", { name: "更新" })).toBeInTheDocument();
    expect(screen.getByText("参議院 本会議投票結果")).toBeInTheDocument();
    expect(screen.getAllByText("2026.08.22 06:00").length).toBeGreaterThan(0);
  });

  it("meta が無いときは「取得前です。」と書き、落ちない", () => {
    render(<UpdateSection meta={undefined} />);
    expect(screen.getByText("取得前です。")).toBeInTheDocument();
    expect(screen.getByText(/約1か月かかります/)).toBeInTheDocument();
  });
});
