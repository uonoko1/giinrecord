/**
 * コミット済みの woff2 から**実際に収録されているコードポイント**を読む（#477 / PR #520 の再レビュー）。
 *
 * **なぜ必要か。** `shippori-mincho-700.subset.txt`（収録したと*主張する*字の一覧）と
 * **実物の woff2 が食い違っても、誰も気づかなかった**。レビュアーの実測:
 *
 *     woff2 から「準」(U+6E96) だけ抜き、.txt はそのまま
 *     → 472 件すべて緑。ブラウザでは「石井 準一」の中で書体が混ざる
 *       Shippori Mincho:3 / Liberation Serif(SYSTEM):1 / WenQuanYi Zen Hei(SYSTEM):1
 *
 * サイズ検査（`> 100_000`）は**痩せた woff2 は捕まえるが、サイズを保ったまま中身が欠ける**のは通す。
 * **`.txt` は主張であって証拠ではない。** だから実物の cmap を読む。
 *
 * **依存は足していない。** woff2 の圧縮は brotli で、Node 標準の `node:zlib` が持っている。
 * ここが読むのは**テーブル一覧と `cmap` だけ**（`glyf` の woff2 独自変換には触れない。
 * cmap は無変換で格納される）。
 *
 * 仕様: https://www.w3.org/TR/WOFF2/ §4（table directory）, OpenType `cmap` format 4 / 12。
 */
import { brotliDecompressSync } from "node:zlib";

/** woff2 の table directory が使う既知タグ表（§5.2 Table 6）。index 63 は「任意タグが後続」 */
const KNOWN_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT",
  "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH",
  "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar",
  "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill",
];

/** woff2 の可変長整数（UIntBase128、§4.1） */
function readBase128(buf: Buffer, pos: number): [number, number] {
  let v = 0;
  for (let i = 0; i < 5; i++) {
    const b = buf[pos++]!;
    if (i === 0 && b === 0x80) throw new Error("woff2: UIntBase128 に先頭 0 がある");
    v = v * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) return [v, pos];
  }
  throw new Error("woff2: UIntBase128 が長すぎる");
}

/** woff2 のバイト列から `cmap` テーブルの中身だけを取り出す。 */
function extractCmap(woff2: Buffer): Buffer {
  if (woff2.toString("ascii", 0, 4) !== "wOF2") throw new Error("woff2: signature が wOF2 ではない");
  const numTables = woff2.readUInt16BE(12);
  let pos = 48; // woff2 header は 48 バイト固定
  let offsetInDecompressed = 0;
  let cmapOffset = -1;
  let cmapLength = 0;
  for (let i = 0; i < numTables; i++) {
    const flags = woff2[pos++]!;
    const idx = flags & 0x3f;
    let tag: string;
    if (idx === 0x3f) {
      tag = woff2.toString("ascii", pos, pos + 4);
      pos += 4;
    } else {
      tag = KNOWN_TAGS[idx] ?? `?${idx}`;
    }
    let origLength: number;
    [origLength, pos] = readBase128(woff2, pos);
    // transform されたテーブルは transformLength が続く（glyf / loca は既定で変換される）
    const transform = (flags >> 6) & 0x03;
    let length = origLength;
    if ((tag === "glyf" || tag === "loca") ? transform === 0 : transform !== 0) {
      [length, pos] = readBase128(woff2, pos);
    }
    if (tag === "cmap") {
      cmapOffset = offsetInDecompressed;
      cmapLength = length;
    }
    offsetInDecompressed += length;
  }
  if (cmapOffset < 0) throw new Error("woff2: cmap テーブルが無い");
  const compressed = woff2.subarray(pos, pos + woff2.readUInt32BE(20));
  const font = brotliDecompressSync(compressed);
  return font.subarray(cmapOffset, cmapOffset + cmapLength);
}

/** cmap subtable format 4（BMP）を読む */
function readFormat4(t: Buffer, out: Set<number>): void {
  const segX2 = t.readUInt16BE(6);
  const seg = segX2 / 2;
  const endBase = 14;
  const startBase = endBase + segX2 + 2;
  const deltaBase = startBase + segX2;
  const rangeBase = deltaBase + segX2;
  for (let i = 0; i < seg; i++) {
    const end = t.readUInt16BE(endBase + i * 2);
    const start = t.readUInt16BE(startBase + i * 2);
    const delta = t.readInt16BE(deltaBase + i * 2);
    const rangeOffset = t.readUInt16BE(rangeBase + i * 2);
    if (start === 0xffff) continue;
    for (let c = start; c <= end && c !== 0x10000; c++) {
      let g: number;
      if (rangeOffset === 0) g = (c + delta) & 0xffff;
      else {
        const gi = rangeBase + i * 2 + rangeOffset + (c - start) * 2;
        if (gi + 1 >= t.length) continue;
        g = t.readUInt16BE(gi);
        if (g !== 0) g = (g + delta) & 0xffff;
      }
      if (g !== 0) out.add(c);
    }
  }
}

/** cmap subtable format 12（BMP 外を含む）を読む */
function readFormat12(t: Buffer, out: Set<number>): void {
  const nGroups = t.readUInt32BE(12);
  for (let i = 0; i < nGroups; i++) {
    const o = 16 + i * 12;
    const start = t.readUInt32BE(o);
    const end = t.readUInt32BE(o + 4);
    const startGlyph = t.readUInt32BE(o + 8);
    if (startGlyph === 0 && start === 0) continue;
    for (let c = start; c <= end; c++) out.add(c);
  }
}

/** woff2 が実際に収録しているコードポイントの集合。 */
export function woff2CodePoints(woff2: Buffer): Set<number> {
  const cmap = extractCmap(woff2);
  const numTables = cmap.readUInt16BE(2);
  const out = new Set<number>();
  for (let i = 0; i < numTables; i++) {
    const offset = cmap.readUInt32BE(4 + i * 8 + 4);
    if (offset >= cmap.length) continue;
    const sub = cmap.subarray(offset);
    const format = sub.readUInt16BE(0);
    if (format === 4) readFormat4(sub, out);
    else if (format === 12) readFormat12(sub, out);
  }
  if (out.size === 0) throw new Error("woff2: cmap から 1 文字も読めなかった（読み方が壊れている）");
  return out;
}

/** 収録している「字」の集合（`parseSubsetChars` と突き合わせられる形）。 */
export function woff2Chars(woff2: Buffer): Set<string> {
  return new Set([...woff2CodePoints(woff2)].map((cp) => String.fromCodePoint(cp)));
}
