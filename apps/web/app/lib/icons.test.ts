/**
 * ビルド時ラスタライズ（#129）: brand/icon-square.svg と brand/og-image.svg から
 * favicon.ico（16/32/48）・icon-192/512.png・apple-touch-icon.png（180）・og-image.png（1200×630）を決定的に作る。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ICO_SIZES, parseIcoDirectory, renderBrandAssets, RASTER_OUTPUTS } from "./icons";

const WEB = join(__dirname, "..", "..");
const sources = {
  icon: readFileSync(join(WEB, "brand/icon-square.svg")),
  og: readFileSync(join(WEB, "brand/og-image.svg")),
};

describe("renderBrandAssets", () => {
  it("出力は favicon.ico / icon-192.png / icon-512.png / apple-touch-icon.png / og-image.png", async () => {
    const out = await renderBrandAssets(sources);
    expect([...out.keys()].sort()).toEqual(["apple-touch-icon.png", "favicon.ico", "icon-192.png", "icon-512.png", "og-image.png"]);
  });

  it.each(RASTER_OUTPUTS)("$name は $width×$height の PNG", async ({ name, width, height }) => {
    const out = await renderBrandAssets(sources);
    const meta = await sharp(out.get(name)).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", width, height]);
  });

  it("favicon.ico は 16/32/48 の3エントリで、各エントリは同じ大きさの PNG", async () => {
    const out = await renderBrandAssets(sources);
    const entries = parseIcoDirectory(out.get("favicon.ico")!);
    expect(entries.map((e) => e.size)).toEqual([...ICO_SIZES]);
    for (const e of entries) {
      const meta = await sharp(e.png).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(["png", e.size, e.size]);
    }
  });

  it("同じ入力からは同じバイト列（決定的）", async () => {
    const a = await renderBrandAssets(sources);
    const b = await renderBrandAssets(sources);
    for (const [name, buf] of a) expect(buf.equals(b.get(name)!), name).toBe(true);
  });

  it("apple-touch-icon の四隅は不透明（角丸なし・地色あり）", async () => {
    const out = await renderBrandAssets(sources);
    const { data, info } = await sharp(out.get("apple-touch-icon.png")).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3];
    expect(alphaAt(0, 0)).toBe(255);
    expect(alphaAt(info.width - 1, info.height - 1)).toBe(255);
  });
});

describe("parseIcoDirectory", () => {
  it("ICO でないバイト列は拒否する", () => {
    expect(() => parseIcoDirectory(Buffer.from("not an ico"))).toThrow();
  });
});
