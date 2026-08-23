import { inflateRawSync } from "node:zlib";

/**
 * 最小限の ZIP 読み出し（Issue #111）。日本郵便の ken_all.zip（KEN_ALL.CSV 1 本、deflate）を展開するためだけのもの。
 * Node には unzip が無く、依存を増やさないために central directory を末尾から読む。
 * 対応: 圧縮方式 0（無圧縮）と 8（deflate）。それ以外・壊れたファイルは失敗する。
 */
export function unzipEntry(zip: Buffer, entryName: string): Buffer {
  const eocd = findEocd(zip);
  const entries = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let i = 0; i < entries; i++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error(`zip: bad central directory entry at ${offset}`);
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLen = zip.readUInt16LE(offset + 28);
    const extraLen = zip.readUInt16LE(offset + 30);
    const commentLen = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString("utf8", offset + 46, offset + 46 + nameLen);
    names.push(name);
    if (name === entryName) {
      if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`zip: bad local header for ${name}`);
      const localNameLen = zip.readUInt16LE(localOffset + 26);
      const localExtraLen = zip.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLen + localExtraLen;
      const data = zip.subarray(start, start + compressedSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`zip: unsupported compression method ${method} for ${name}`);
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`zip: entry ${entryName} not found (entries: ${names.join(", ")})`);
}

function findEocd(zip: Buffer): number {
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error("zip: end of central directory not found (not a zip file?)");
}
