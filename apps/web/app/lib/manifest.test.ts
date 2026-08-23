import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** #191: ホーム画面からの起動体験のため display は standalone のまま。ストアアプリを優先しない。 */
describe("site.webmanifest（#191）", () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, "../../public/site.webmanifest"), "utf8")) as Record<string, unknown>;
  it("display は standalone、prefer_related_applications は false", () => {
    expect(manifest.display).toBe("standalone");
    expect(manifest.prefer_related_applications).toBe(false);
  });
});
