/**
 * Bulk download of `data/` as one reproducible ZIP (Issue #49, free tier only).
 *
 * Written with node:zlib alone so the build has no extra dependency. The output is
 * byte-for-byte deterministic for the same input: entries are sorted by path (byte
 * order), every mtime is the fixed DOS epoch 1980-01-01 00:00, and deflate runs at a
 * fixed level. Build-time only (scripts/build-archive.ts); never shipped to the browser.
 *
 * Limits: plain ZIP (no ZIP64) — fine for < 4 GiB and < 65535 entries. Exceeding either throws.
 */
import { crc32, deflateRawSync } from "node:zlib";
import type { DatasetMeta } from "./data-contract";
import { REPO_URL } from "./dataset";

export const ARCHIVE_NAME = "data-archive.zip";
/** URL path on the site. nginx serves /data/ with a 1h cache (deploy/nginx-seiji-kiroku.conf). */
export const ARCHIVE_PATH = `/data/${ARCHIVE_NAME}`;
export const ARCHIVE_README = "README.txt";

export interface ZipEntry {
  /** posix relative path inside the archive, e.g. `members/index.json` */
  path: string;
  data: Buffer;
}

/** DOS date for 1980-01-01: (year-1980)<<9 | month<<5 | day */
const FIXED_DOS_DATE = (0 << 9) | (1 << 5) | 1;
const FIXED_DOS_TIME = 0;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const VERSION_NEEDED = 20;
/** general purpose flag bit 11: file names are UTF-8 */
const FLAG_UTF8 = 0x0800;
const MAX_ENTRIES = 0xffff;
const MAX_SIZE = 0xffffffff;

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

function assertSafePath(p: string): void {
  if (p === "" || p.startsWith("/") || p.split("/").some((seg) => seg === "" || seg === "." || seg === "..") || p.includes("\\")) {
    throw new Error(`archive: unsafe entry path ${JSON.stringify(p)}`);
  }
}

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Build a ZIP file in memory. Pure: same entries (in any order) → same bytes. */
export function buildZip(entries: ZipEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => compareBytes(a.path, b.path));
  const seen = new Set<string>();
  for (const e of sorted) {
    assertSafePath(e.path);
    if (seen.has(e.path)) throw new Error(`archive: duplicate entry path ${JSON.stringify(e.path)}`);
    seen.add(e.path);
  }
  if (sorted.length > MAX_ENTRIES) throw new Error(`archive: too many entries (${sorted.length} > ${MAX_ENTRIES}); ZIP64 not supported`);

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of sorted) {
    const name = Buffer.from(e.path, "utf8");
    const deflated = deflateRawSync(e.data, { level: 9 });
    const useDeflate = deflated.length < e.data.length;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    const body = useDeflate ? deflated : e.data;
    if (e.data.length > MAX_SIZE || body.length > MAX_SIZE) throw new Error(`archive: entry too large for ZIP: ${e.path}`);
    const crc = crc32(e.data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(FIXED_DOS_TIME, 10);
    local.writeUInt16LE(FIXED_DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(VERSION_NEEDED, 4); // version made by (MS-DOS, 2.0)
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(FIXED_DOS_TIME, 12);
    central.writeUInt16LE(FIXED_DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  if (offset + centralSize > MAX_SIZE) throw new Error("archive: total size exceeds ZIP limit; ZIP64 not supported");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(sorted.length, 8);
  eocd.writeUInt16LE(sorted.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

export interface ZipDirectoryEntry {
  path: string;
  method: number;
  dosTime: number;
  dosDate: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  /** absolute offset of the compressed bytes within the ZIP */
  dataOffset: number;
}

/** Read the central directory of a (non-ZIP64, comment-less) ZIP. Used by tests and the smoke check. */
export function readZipDirectory(zip: Buffer): ZipDirectoryEntry[] {
  const eocdAt = zip.length - 22;
  if (eocdAt < 0 || zip.readUInt32LE(eocdAt) !== EOCD_SIG) throw new Error("archive: end of central directory not found");
  const count = zip.readUInt16LE(eocdAt + 10);
  let pos = zip.readUInt32LE(eocdAt + 16);
  const out: ZipDirectoryEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(pos) !== CENTRAL_SIG) throw new Error(`archive: bad central directory entry at ${pos}`);
    const nameLen = zip.readUInt16LE(pos + 28);
    const extraLen = zip.readUInt16LE(pos + 30);
    const commentLen = zip.readUInt16LE(pos + 32);
    const localOffset = zip.readUInt32LE(pos + 42);
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const localExtraLen = zip.readUInt16LE(localOffset + 28);
    out.push({
      path: zip.toString("utf8", pos + 46, pos + 46 + nameLen),
      method: zip.readUInt16LE(pos + 10),
      dosTime: zip.readUInt16LE(pos + 12),
      dosDate: zip.readUInt16LE(pos + 14),
      crc32: zip.readUInt32LE(pos + 16),
      compressedSize: zip.readUInt32LE(pos + 20),
      uncompressedSize: zip.readUInt32LE(pos + 24),
      dataOffset: localOffset + 30 + localNameLen + localExtraLen,
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** README.txt placed at the archive root: licence, attribution, sources, fetch time. Facts only. */
export function archiveReadme(meta: DatasetMeta | undefined): string {
  const lines = [
    "政治記録 (seiji-kiroku) データ一括アーカイブ",
    "==========================================",
    "",
    "このアーカイブは、参議院・衆議院・国立国会図書館が公開する公式記録を整形した JSON です。",
    "評価・採点・推薦は含みません。各記録は sourceUrl で一次資料を指します。",
    "ファイル構成は docs/DATA_CONTRACT.md を参照してください。",
    `${REPO_URL}/blob/main/docs/DATA_CONTRACT.md`,
    "",
    "ライセンス / License",
    "--------------------",
    "Creative Commons Attribution 4.0 International (CC BY 4.0)",
    "https://creativecommons.org/licenses/by/4.0/",
    "詳細は同梱の LICENSE を参照。",
    "",
    "帰属表示 / Attribution",
    "----------------------",
    `「政治記録 (seiji-kiroku)」 ${REPO_URL}`,
    "一次資料：参議院・衆議院・国立国会図書館。引用する際は各記録の sourceUrl も併記してください。",
    "",
  ];
  if (meta) {
    lines.push("取得時刻 / Fetched at", "----------------------", meta.fetchedAt, "");
    lines.push(`収録回次 / Sessions: ${meta.sessions.join(", ")}`, "");
    lines.push("出典 / Sources", "---------------");
    for (const s of meta.sources) lines.push(`- ${s.name}`, `  ${s.url}`, `  fetchedAt: ${s.fetchedAt}`);
    lines.push("");
  }
  return lines.join("\n");
}
