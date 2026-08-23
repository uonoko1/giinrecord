/**
 * ブランド画像のラスタライズ（#129）。brand/icon-square.svg と brand/og-image.svg を sharp で PNG にし、
 * favicon.ico は PNG を ICO コンテナに詰める（Vista 以降のブラウザはすべて PNG 入り ICO を読む）。
 * 入出力はメモリ上の Buffer だけで、同じ SVG からは同じバイト列になる（sharp は時刻などのメタデータを書かない）。
 * ファイル I/O は scripts/brand-assets.ts が担う。
 */
import sharp from "sharp";

export interface BrandSources {
  /** brand/icon-square.svg: 角丸なし・地色あり */
  icon: Buffer;
  /** brand/og-image.svg: 1200×630 */
  og: Buffer;
}

export const ICO_SIZES = [16, 32, 48] as const;

export const RASTER_OUTPUTS = [
  { name: "icon-192.png", source: "icon", width: 192, height: 192 },
  { name: "icon-512.png", source: "icon", width: 512, height: 512 },
  { name: "apple-touch-icon.png", source: "icon", width: 180, height: 180 },
  { name: "og-image.png", source: "og", width: 1200, height: 630 },
] as const satisfies readonly { name: string; source: keyof BrandSources; width: number; height: number }[];

/** SVG を指定サイズの PNG に。density を上げてから resize するので小さいサイズでも線が潰れない。 */
async function rasterize(svg: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(svg, { density: 384 })
    .resize(width, height, { fit: "fill", kernel: "lanczos3" })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
}

/** PNG 群を ICO に詰める（ICONDIR + ICONDIRENTRY×n + PNG データ）。 */
export function encodeIco(entries: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o);
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1);
    dir.writeUInt8(0, o + 2); // palette
    dir.writeUInt8(0, o + 3); // reserved
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

/** ICO のディレクトリを読む（テスト・検証用）。PNG 入り ICO のみ想定。 */
export function parseIcoDirectory(ico: Buffer): { size: number; png: Buffer }[] {
  if (ico.length < 6 || ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) throw new Error("not an ICO file");
  const n = ico.readUInt16LE(4);
  const out: { size: number; png: Buffer }[] = [];
  for (let i = 0; i < n; i++) {
    const o = 6 + i * 16;
    const w = ico.readUInt8(o);
    const len = ico.readUInt32LE(o + 8);
    const off = ico.readUInt32LE(o + 12);
    out.push({ size: w === 0 ? 256 : w, png: ico.subarray(off, off + len) });
  }
  return out;
}

/** 出力ファイル名 → バイト列。 */
export async function renderBrandAssets(sources: BrandSources): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const o of RASTER_OUTPUTS) out.set(o.name, await rasterize(sources[o.source], o.width, o.height));
  const icoEntries = [];
  for (const size of ICO_SIZES) icoEntries.push({ size, png: await rasterize(sources.icon, size, size) });
  out.set("favicon.ico", encodeIco(icoEntries));
  return out;
}
