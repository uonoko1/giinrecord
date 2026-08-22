import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../../..");

describe("ビルド成果物はリポジトリに含めない", () => {
  it("ルート .gitignore が apps/web/build/ を無視する", () => {
    const lines = readFileSync(resolve(repoRoot, ".gitignore"), "utf8")
      .split("\n")
      .map((l) => l.trim());
    expect(lines).toContain("apps/web/build/");
  });

  it("apps/web/build 配下に追跡中のファイルが無い", () => {
    const tracked = execFileSync("git", ["ls-files", "apps/web/build"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    expect(tracked).toBe("");
  });
});
