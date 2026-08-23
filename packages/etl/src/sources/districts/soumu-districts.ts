import { parse } from "node-html-parser";
import { fetchText } from "../../fetch.ts";
import { fetchBytes } from "./fetch.ts";
import { extractPdfText } from "./pdf-text.ts";

/**
 * 総務省「衆議院小選挙区の区割りの改定等について」（令和4年改定＝10増10減、Issue #111）。
 *   ページ: https://www.soumu.go.jp/senkyo/senkyo_s/news/senkyo/shu_kuwari/shu_kuwari_4.html（Shift_JIS）
 *   区域は「衆議院小選挙区選出議員の選挙区（都道府県別）」の表から都道府県ごとの PDF（公職選挙法 別表第一の写し）。
 * PDF の構造（2026-08-23 確認）:
 *   「東 京 都」 / 「第１区 千代田区、新宿区」 / 「第４区 大田区（大田区大森東特別出張所管内、…）」 / 「第２区 札幌市北区（第１区に属しない区域）、札幌市東区」
 *   単位は市・区（政令市は「札幌市中央区」）・郡（「紫波郡」＝郡全体、「東伯郡（三朝町）」＝郡のうちの町村）・
 *   「北海道後志総合振興局管内」「東京都大島支庁管内」。市区の後の括弧はその市区の一部の区域＝分割。
 * ここでは PDF の文をそのまま単位に分けるだけで、市区町村への解決は resolve.ts が行う。
 */
export const SOUMU_PAGE_URL = "https://www.soumu.go.jp/senkyo/senkyo_s/news/senkyo/shu_kuwari/shu_kuwari_4.html";

export interface DistrictUnit {
  /** 括弧の前の名前（市区・郡・振興局管内など）。外字は 〓。 */
  name: string;
  /** 括弧の中身の原文（「第１区に属しない区域」「三朝町」「大田区大森東特別出張所管内、…」）。括弧が無ければ無い。 */
  area?: string;
  /** 単位の原文（空白除去後）。 */
  raw: string;
}
export interface PrefectureDistricts {
  pref: string;
  districts: { number: number; units: DistrictUnit[] }[];
}

export class DistrictParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DistrictParseError";
  }
}

export function parsePrefecturePdfLinks(html: string, pageUrl: string): { pref: string; url: string }[] {
  const table = parse(html).querySelectorAll("table").find((t) => (t.getAttribute("summary") ?? "").includes("都道府県別"));
  if (!table) throw new DistrictParseError("soumu: table 「衆議院小選挙区選出議員の選挙区（都道府県別）」 not found (page layout changed?)");
  const links = table.querySelectorAll("a").flatMap((a) => {
    const href = a.getAttribute("href") ?? "";
    if (!href.endsWith(".pdf")) return [];
    return [{ pref: a.text.replace(/\s/g, ""), url: new URL(href, pageUrl).toString() }];
  });
  if (links.length !== 47) throw new DistrictParseError(`soumu: expected 47 prefecture PDFs in 都道府県別 table, got ${links.length}`);
  return links;
}

/** 本文「令和4年11月28日に公布され、同年12月28日から施行」の施行日（区域の基準日）。 */
export function parseEffectiveDate(html: string): string {
  const m = html.replace(/\s/g, "").match(/令和(\d+)年(\d+)月(\d+)日に公布され、同年(\d+)月(\d+)日から施行/);
  if (!m) throw new DistrictParseError("soumu: 「令和N年M月D日に公布され、同年M月D日から施行」 not found (page text changed?)");
  const year = 2018 + Number(m[1]);
  return `${year}-${m[4].padStart(2, "0")}-${m[5].padStart(2, "0")}`;
}

const OPEN = "（(";
const CLOSE = "）)";
const toAscii = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

export function parseDistrictText(text: string, pref: string): PrefectureDistricts {
  const s = text.replace(/\s/g, "");
  const headingRaw = text.trim().split("\n")[0]?.trim() ?? "";
  // 括弧の外にある「第N区」だけが見出し（「（第１区に属しない区域）」の中は見出しではない）。
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const m = depth === 0 ? /^第([0-9０-９]+)区/.exec(s.slice(i)) : null;
    if (m) { parts.push(cur, toAscii(m[1])); cur = ""; i += m[0].length - 1; continue; }
    const ch = s[i];
    if (OPEN.includes(ch)) depth++;
    if (CLOSE.includes(ch)) depth--;
    cur += ch;
  }
  parts.push(cur);
  if (depth !== 0) throw new DistrictParseError(`soumu ${pref}: unbalanced parentheses in PDF text`);
  if (parts[0] !== pref) throw new DistrictParseError(`soumu: expected PDF for ${pref} but it is headed 「${headingRaw}」`);
  const districts: PrefectureDistricts["districts"] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const number = Number(parts[i]);
    if (number !== districts.length + 1) throw new DistrictParseError(`soumu ${pref}: district numbers not consecutive — expected 第${districts.length + 1}区, found 第${number}区`);
    const units = splitTopLevel(parts[i + 1]).map((raw) => {
      const m = /^([^（(]+)(?:[（(](.*)[）)])?$/.exec(raw);
      if (!m) throw new DistrictParseError(`soumu ${pref} 第${number}区: cannot parse unit 「${raw}」`);
      return m[2] === undefined ? { name: m[1], raw } : { name: m[1], area: m[2], raw };
    });
    if (!units.length) throw new DistrictParseError(`soumu ${pref}: 第${number}区 has no area`);
    districts.push({ number, units });
  }
  if (!districts.length) throw new DistrictParseError(`soumu ${pref}: no 「第N区」 headings found`);
  return { pref, districts };
}

/** 括弧の外の 、 で区切る。 */
export function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (OPEN.includes(ch)) depth++;
    if (CLOSE.includes(ch)) depth--;
    if (ch === "、" && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out.filter(Boolean);
}

export async function fetchSoumuDistricts(): Promise<{ effectiveDate: string; prefectures: (PrefectureDistricts & { url: string })[] }> {
  const html = await fetchText(SOUMU_PAGE_URL, "shift_jis", { noCache: true });
  const effectiveDate = parseEffectiveDate(html);
  const prefectures = [];
  for (const { pref, url } of parsePrefecturePdfLinks(html, SOUMU_PAGE_URL)) {
    const text = await extractPdfText(await fetchBytes(url));
    prefectures.push({ ...parseDistrictText(text, pref), url });
  }
  return { effectiveDate, prefectures };
}
