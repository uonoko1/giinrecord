import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../../..");

describe("ビルド成果物はリポジトリに含めない", () => {
  it("apps/web/build/ は git に無視される", () => {
    // 文字列ではなく git の判定で検証する（`build/` でも `apps/web/build/` でもよい）
    const out = execFileSync("git", ["check-ignore", "-q", "apps/web/build/client/index.html"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    expect(out).toBe("");
  });

  it("apps/web/build 配下に追跡中のファイルが無い", () => {
    const tracked = execFileSync("git", ["ls-files", "apps/web/build"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    expect(tracked).toBe("");
  });
});
