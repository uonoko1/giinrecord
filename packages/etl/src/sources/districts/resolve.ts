import type { KenAllRow } from "./ken-all.ts";
import { GAIJI } from "./pdf-text.ts";
import { splitTopLevel, type DistrictUnit, type PrefectureDistricts } from "./soumu-districts.ts";
import { RENAMED_MUNICIPALITIES, SANGIIN_MERGED_DISTRICTS, TOKYO_BRANCH_OFFICES } from "./static-areas.ts";

/**
 * 郵便番号 → 選挙区の解決（Issue #111）。
 * 入力: KEN_ALL の行（郵便番号・市区町村）、総務省 PDF の区域（別表第一）、北海道の振興局所管市町村。
 * 出力: 市区町村ごとの小選挙区の候補と、郵便番号ごとの {sangiin[], shugiin[]}。
 *
 * 原則（推定しない）:
 * - 市区町村の粒度で解決する。別表で市区が分割されている（括弧で一部の区域を指定している）ときは、その市区の全郵便番号に
 *   候補の区を全部並べる。町丁目・番地で絞り込まない（KEN_ALL の町域と別表の区域の対応は一次資料に無い）。
 * - 別表の単位が KEN_ALL の市区町村に 1 つに紐づかない、KEN_ALL の市区町村に区が 1 つも付かない、別表に無い都道府県がある —— いずれも失敗。
 * - 同じ郵便番号が複数の市区町村・都道府県にまたがる行（KEN_ALL に実在）は和集合。
 */
export interface ResolvedMunicipality {
  code: string;
  pref: string;
  city: string;
  /** 小選挙区の候補（名簿表記、番号順）。分割された市区は複数。 */
  shugiin: string[];
  /** 複数の小選挙区にまたがる（候補が 2 つ以上）。 */
  split: boolean;
}
export interface ZipDistricts {
  sangiin: string[];
  shugiin: string[];
}
export interface ResolveResult {
  municipalities: ResolvedMunicipality[];
  byZip: Record<string, ZipDistricts>;
  splits: ResolvedMunicipality[];
}

export class DistrictResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DistrictResolveError";
  }
}

const prefShort = (pref: string) => (pref === "北海道" ? pref : pref.replace(/[都府県]$/, ""));
export const sangiinDistrict = (pref: string) => SANGIIN_MERGED_DISTRICTS[pref] ?? prefShort(pref);
export const shugiinDistrict = (pref: string, number: number) => `${prefShort(pref)}${number}`;

/** 表記ゆれの正規化: 互換漢字（塚 U+FA10）→ NFKC、ヶ/ヵ → ケ/カ、驒 → 騨。 */
const norm = (s: string) => s.normalize("NFKC").replace(/ヶ/g, "ケ").replace(/ヵ/g, "カ").replace(/驒/g, "騨");
/** 〓 を任意の 1 文字として等価比較。 */
function eq(pattern: string, name: string): boolean {
  const a = [...pattern];
  const b = [...name];
  return a.length === b.length && a.every((c, i) => c === GAIJI || c === b[i]);
}
const endsWith = (pattern: string, name: string) => [...name].length >= [...pattern].length && eq(pattern, [...name].slice(-[...pattern].length).join(""));
const stripGun = (name: string) => name.replace(/^.*?郡/, "");

interface Muni { code: string; pref: string; city: string; norm: string; districts: Set<number>; partial: boolean }
export type Municipality = Pick<KenAllRow, "code" | "pref" | "city">;

/** KEN_ALL の行から市区町村（全国地方公共団体コードで一意）を取り出す。同じコードに別名があれば失敗。 */
export function municipalitiesOf(rows: Municipality[]): Municipality[] {
  const byCode = new Map<string, Municipality>();
  for (const r of rows) {
    const m = byCode.get(r.code);
    if (!m) byCode.set(r.code, { code: r.code, pref: r.pref, city: r.city });
    else if (m.city !== r.city || m.pref !== r.pref) throw new DistrictResolveError(`KEN_ALL: code ${r.code} has two names: ${m.pref}${m.city} / ${r.pref}${r.city}`);
  }
  return [...byCode.values()].sort((a, b) => (a.code < b.code ? -1 : 1));
}

export function resolveDistricts(rows: KenAllRow[], prefectures: PrefectureDistricts[], hokkaidoBureaus: Map<string, string[]>, municipalities = municipalitiesOf(rows)): ResolveResult {
  const resolved = resolveMunicipalities(municipalities, prefectures, hokkaidoBureaus);
  return { municipalities: resolved, byZip: zipDistricts(rows, resolved), splits: resolved.filter((m) => m.split) };
}

/** 市区町村ごとに小選挙区の候補を付ける。 */
export function resolveMunicipalities(municipalities: Municipality[], prefectures: PrefectureDistricts[], hokkaidoBureaus: Map<string, string[]>): ResolvedMunicipality[] {
  const byCode = new Map<string, Muni>(municipalities.map((r) => [r.code, { code: r.code, pref: r.pref, city: r.city, norm: norm(r.city), districts: new Set(), partial: false }]));
  const byPref = new Map<string, Muni[]>();
  for (const m of byCode.values()) byPref.set(m.pref, [...(byPref.get(m.pref) ?? []), m]);

  const prefTable = new Map(prefectures.map((p) => [p.pref, p]));
  for (const pref of byPref.keys()) if (!prefTable.has(pref)) throw new DistrictResolveError(`no district table for ${pref}`);

  for (const { pref, districts } of prefectures) {
    const munis = byPref.get(pref) ?? [];
    const renamed = RENAMED_MUNICIPALITIES.find((r) => r.pref === pref)?.former ?? {};
    const unique = (pattern: string, cands: Muni[], context: string): Muni => {
      if (cands.length === 1) return cands[0];
      if (cands.length === 0) throw new DistrictResolveError(`${pref} ${context}: 「${pattern}」 matches no municipality in KEN_ALL`);
      throw new DistrictResolveError(`${pref} ${context}: 「${pattern}」 is ambiguous: ${cands.map((c) => c.city).join(" / ")}`);
    };
    /** 市区町村名で 1 つに絞る。完全一致 → （町村）郡を除いた名前の完全一致 → 末尾一致（三宅島三宅村）。 */
    const find = (name: string, context: string): Muni[] => {
      const n = norm(name);
      const exact = munis.filter((m) => eq(n, m.norm));
      if (exact.length) return [unique(name, exact, context)];
      if (renamed[name]) return renamed[name].map((r) => ({ ...unique(r.name, munis.filter((m) => eq(norm(r.name), m.norm)), `${context} (再編後 ${r.name})`) }));
      const town = munis.filter((m) => /[町村]$/.test(n) && eq(n, stripGun(m.norm)));
      if (town.length) return [unique(name, town, context)];
      return [unique(name, munis.filter((m) => endsWith(n, m.norm)), context)];
    };
    const assign = (m: Muni, number: number, partial: boolean) => { m.districts.add(number); if (partial) m.partial = true; };

    for (const { number, units } of districts) {
      const context = `第${number}区`;
      for (const u of units) expandUnit(u).forEach(({ name, partial }) => find(name, `${context} 「${u.raw}」`).forEach((m) => assign(m, number, partial)));
    }

    function expandUnit(u: DistrictUnit): { name: string; partial: boolean }[] {
      if (/振興局管内$/.test(u.name)) {
        const bureau = u.name.replace(/^北海道/, "").replace(/管内$/, "");
        const list = hokkaidoBureaus.get(bureau);
        if (!list) throw new DistrictResolveError(`${pref}: bureau 「${bureau}」 not in the Hokkaido bureau table (${[...hokkaidoBureaus.keys()].join(", ")})`);
        // 市は別表に直接載るので、振興局管内は町村だけ
        return list.filter((n) => /[町村]$/.test(n)).map((name) => ({ name, partial: false }));
      }
      if (/支庁管内$/.test(u.name)) {
        const list = TOKYO_BRANCH_OFFICES.areas[u.name];
        if (!list) throw new DistrictResolveError(`${pref}: 「${u.name}」 not in the Tokyo branch office table`);
        return list.map((name) => ({ name, partial: false }));
      }
      if (/郡$/.test(u.name)) {
        if (u.area === undefined) {
          const all = munis.filter((m) => m.norm.startsWith(norm(u.name)));
          if (!all.length) throw new DistrictResolveError(`${pref}: 「${u.name}」 has no municipality in KEN_ALL`);
          return all.map((m) => ({ name: m.city, partial: false }));
        }
        // 郡（町村、…）: 町村の列挙。町村の後にさらに括弧があればその町村の一部
        return splitTopLevel(u.area).map((item) => {
          const m = /^([^（(]+)(?:[（(](.*)[）)])?$/.exec(item);
          if (!m) throw new DistrictResolveError(`${pref}: cannot parse 「${item}」 in 「${u.raw}」`);
          return { name: u.name + m[1], partial: m[2] !== undefined };
        });
      }
      return [{ name: u.name, partial: u.area !== undefined }];
    }
  }

  return [...byCode.values()]
    .sort((a, b) => (a.code < b.code ? -1 : 1))
    .map((m) => {
      if (!m.districts.size) throw new DistrictResolveError(`${m.pref}${m.city} (${m.code}) has no district in the table`);
      if (m.partial && m.districts.size < 2) throw new DistrictResolveError(`${m.pref}${m.city} (${m.code}) is listed as a partial area but appears in only one district`);
      const numbers = [...m.districts].sort((a, b) => a - b);
      return { code: m.code, pref: m.pref, city: m.city, shugiin: numbers.map((n) => shugiinDistrict(m.pref, n)), split: numbers.length > 1 };
    });
}

/** 郵便番号ごとの {sangiin[], shugiin[]}。複数の市区町村・都道府県にまたがる郵便番号は和集合。 */
export function zipDistricts(rows: KenAllRow[], municipalities: ResolvedMunicipality[]): Record<string, ZipDistricts> {
  const byCode = new Map(municipalities.map((m) => [m.code, m]));
  const byZip: Record<string, ZipDistricts> = {};
  const sets = new Map<string, { sangiin: Set<string>; shugiin: Set<string> }>();
  for (const r of rows) {
    const m = byCode.get(r.code);
    if (!m) throw new DistrictResolveError(`KEN_ALL: ${r.pref}${r.city} (${r.code}) is not in the resolved municipalities`);
    let s = sets.get(r.zip);
    if (!s) { s = { sangiin: new Set(), shugiin: new Set() }; sets.set(r.zip, s); }
    s.sangiin.add(sangiinDistrict(r.pref));
    for (const d of m.shugiin) s.shugiin.add(d);
  }
  for (const [zip, s] of [...sets].sort(([a], [b]) => (a < b ? -1 : 1))) {
    byZip[zip] = { sangiin: [...s.sangiin].sort(), shugiin: [...s.shugiin].sort(byDistrictNumber) };
  }
  return byZip;
}

const byDistrictNumber = (a: string, b: string) => {
  const [pa, na] = [a.replace(/\d+$/, ""), Number(a.match(/\d+$/)?.[0])];
  const [pb, nb] = [b.replace(/\d+$/, ""), Number(b.match(/\d+$/)?.[0])];
  return pa === pb ? na - nb : pa < pb ? -1 : 1;
};
