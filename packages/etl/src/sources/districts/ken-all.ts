import iconv from "iconv-lite";
import { fetchText } from "../../fetch.ts";
import { fetchBytes } from "./fetch.ts";
import { unzipEntry } from "./zip.ts";

/**
 * 日本郵便 郵便番号データ KEN_ALL（Issue #111）。
 *   ダウンロードページ: https://www.post.japanpost.jp/zipcode/dl/kogaki-zip.html（→ /service/search/zipcode/download/kogaki-zip.html に 301）
 *   全国一括: https://www.post.japanpost.jp/service/search/zipcode/download/kogaki/zip/ken_all.zip（zip の中に KEN_ALL.CSV、Shift_JIS、CRLF）
 * 月末更新。列（2026-07-31 更新分で確認）: 全国地方公共団体コード, 旧郵便番号, 郵便番号, 都道府県カナ, 市区町村カナ, 町域カナ, 都道府県, 市区町村, 町域, フラグ×6。
 * 同じ郵便番号が複数の市区町村（町域）にまたがる行はそのまま複数行になる。
 */
export const KEN_ALL_PAGE_URL = "https://www.post.japanpost.jp/service/search/zipcode/download/kogaki-zip.html";
export const KEN_ALL_ZIP_URL = "https://www.post.japanpost.jp/service/search/zipcode/download/kogaki/zip/ken_all.zip";

export interface KenAllRow {
  /** 全国地方公共団体コード（5 桁）。 */
  code: string;
  /** 郵便番号 7 桁。 */
  zip: string;
  pref: string;
  /** 市区町村（政令市は「札幌市中央区」、郡部は「虻田郡倶知安町」、島しょは「三宅島三宅村」のように原文のまま）。 */
  city: string;
  /** 町域（「以下に掲載がない場合」を含む原文）。 */
  town: string;
}

export function parseKenAll(csv: Buffer): KenAllRow[] {
  const text = iconv.decode(csv, "Shift_JIS");
  const rows: KenAllRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const cells = parseCsvLine(line);
    if (cells.length !== 15) throw new Error(`KEN_ALL: expected 15 columns, got ${cells.length}: ${line.slice(0, 60)}`);
    rows.push({ code: cells[0], zip: cells[2], pref: cells[6], city: cells[7], town: cells[8] });
  }
  return rows;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** ダウンロードページの「YYYY年M月D日更新」（最新の更新日）を ISO 日付で返す。見つからなければ失敗（推定しない）。 */
export function parseKenAllUpdated(html: string): string {
  const m = html.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日更新/);
  if (!m) throw new Error("KEN_ALL: 「YYYY年M月D日更新」 not found on the download page (layout changed?)");
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

export async function fetchKenAll(): Promise<{ rows: KenAllRow[]; updated: string }> {
  const page = await fetchText(KEN_ALL_PAGE_URL, "shift_jis", { noCache: true });
  const updated = parseKenAllUpdated(page);
  const zip = await fetchBytes(KEN_ALL_ZIP_URL, { noCache: true });
  return { rows: parseKenAll(unzipEntry(zip, "KEN_ALL.CSV")), updated };
}
