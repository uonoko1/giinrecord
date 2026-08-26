import { createHash } from "node:crypto";
import { parse } from "node-html-parser";
import iconv from "iconv-lite";
import type { Member, MemberTerm } from "@seiji-kiroku/shared";
import { fetchText } from "../fetch.ts";
import type { UnmatchedGroup } from "./sangiin-members.ts";
import { isKnownShugiinGroup, resolveShugiinGroup } from "./shugiin-groups.ts";

/**
 * 衆議院 議員一覧（50音順、あ行〜わ行の 10 ページ、Shift_JIS）。
 * 列: 氏名（プロフィールへのリンク）・ふりがな・会派（略称）・選挙区（小選挙区「岡山1」／比例「（比）北関東」）・当選回数。
 * 参院と違い回次ごとのアーカイブは無く、常に「現在」の名簿1つ（ページ上部に「令和8年2月18日現在」）。
 *
 * プロフィールURL（itdb_giinprof.nsf/html/profile/NNN.html）の NNN は掲載順の連番で、総選挙ごとに振り直される
 * （逢沢一郎: 2024-05 時点 011 → 2026-02 時点 001。Wayback Machine で確認）ので ID には使えない。
 * 初当選回はプロフィールページの自由記述（「当選八回（44 45 …）」）にしか無く、465 ページを毎回取る必要があるので使わない。
 * ID は氏名＋ふりがなのハッシュ（memberIdFromName）。
 */
const BASE = "https://www.shugiin.go.jp/internet/itdb_annai.nsf/html/statics/syu";

/** あ行〜わ行。 */
export const ROSTER_PAGES: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export const memberListUrl = (page: number) => `${BASE}/${page}giin.htm`;

/** 名簿ページの生バイト（Shift_JIS）を文字列に。フィクスチャは生バイトのまま保存する。 */
export function decodeRosterPage(bytes: Buffer): string {
  return iconv.decode(bytes, "Shift_JIS");
}

/** 10 ページすべてを取得して結合する。asOf はページ上部の「令和N年M月D日現在」。 */
export async function fetchShugiinMembers(session: number): Promise<{ members: Member[]; asOf?: string }> {
  const members: Member[] = [];
  let asOf: string | undefined;
  for (const page of ROSTER_PAGES) {
    const url = memberListUrl(page);
    // **session を渡さない**（#294）。衆院名簿の URL には回次が無く、常に「現在」の名簿を返すので、
    // 回次で古さを判定できない。作り直しのキャッシュ（ETL_CACHE_CLOSED_SESSIONS）でも毎回取得する。
    const html = await fetchText(url, "shift_jis", { noCache: true });
    asOf ??= parseAsOf(html);
    members.push(...parseShugiinMemberList(html, url, session));
  }
  assertUniqueIds(members);
  return { members, asOf };
}

const ERA: Record<string, number> = { 令和: 2018, 平成: 1988 };

/** 「令和8年2月18日現在」→ "2026-02-18"。無ければ undefined。 */
export function parseAsOf(html: string): string | undefined {
  const m = html.match(/(令和|平成)\s*(元|\d+)年\s*(\d{1,2})月\s*(\d{1,2})日現在/);
  if (!m) return undefined;
  const y = ERA[m[1]] + (m[2] === "元" ? 1 : +m[2]);
  return `${y}-${m[3].padStart(2, "0")}-${m[4].padStart(2, "0")}`;
}

/**
 * 永続ID: "h_" + sha1(氏名 + "\t" + ふりがな)（空白は除く）の先頭 10 桁。参院の "m_" 空間とは接頭辞で衝突しない。
 * 名簿の掲載順・プロフィールURLの連番（総選挙ごとに振り直される）には依存しないので、落選→返り咲きでも同じ ID になる。
 * 改姓・表記変更では ID が変わる（名簿に他の安定キーが無い）。同姓同名かつ同かなは assertUniqueIds が例外にする。
 */
export function memberIdFromName(name: string, kana: string): string {
  const key = `${stripSpaces(name)}\t${stripSpaces(kana)}`;
  return `h_${createHash("sha1").update(key).digest("hex").slice(0, 10)}`;
}

/**
 * 1 ページ分（あ行など）を Member[] に。プロフィールリンクを持つ行だけを議員とみなす（見出し行を除く）。
 * 議員が 1 人も取れなければ例外（黙って空の index.json を書かない）。
 */
export function parseShugiinMemberList(html: string, sourceUrl: string, session: number): Member[] {
  const out: Member[] = [];
  for (const tr of parse(html).querySelectorAll("tr")) {
    // 名簿の表は外側の表に入れ子になっている。外側の tr も内側の a にマッチするので、直下の td だけを見る。
    const tds = tr.querySelectorAll("td").filter((td) => td.parentNode === tr);
    const a = tds[0]?.querySelector("a[href]");
    if (!a || !/itdb_giinprof\.nsf\/html\/profile\//.test(a.getAttribute("href") ?? "")) continue;
    const cells = tds.map((td) => normalize(td.text));
    if (cells.length < 5) continue;
    const name = normalize(a.text).replace(/君$/, "");
    const kana = cells[1];
    const elected = parseTimesElected(cells[4]);
    const term: MemberTerm = {
      house: "shugiin", group: resolveShugiinGroup(cells[2]), district: cells[3], from: "", sessionFrom: session,
      ...(elected.timesElected !== undefined ? { timesElected: elected.timesElected } : {}),
      ...(elected.timesElectedText ? { timesElectedText: elected.timesElectedText } : {}),
    };
    out.push({ id: memberIdFromName(name, kana), name, kana, house: "shugiin", terms: [term], sourceUrl });
  }
  if (out.length === 0) throw new Error(`no members parsed from ${sourceUrl} (session ${session}): page layout may have changed`);
  assertUniqueIds(out);
  return out;
}

/** 「14」→ 14。「1（参2）」→ 1 と原文。数値で始まらなければ原文だけ（推定しない）。 */
export function parseTimesElected(cell: string): { timesElected?: number; timesElectedText?: string } {
  const m = cell.match(/^(\d+)(.*)$/);
  if (!m) return cell ? { timesElectedText: cell } : {};
  return m[2] ? { timesElected: +m[1], timesElectedText: cell } : { timesElected: +m[1] };
}

/** 対応表（shugiin-groups.ts）に無い会派略称を略称ごとにまとめる。data/unmatched-groups.json に参院分と並べて出す。 */
export function unmatchedShugiinGroups(members: readonly Member[]): UnmatchedGroup[] {
  const byGroup = new Map<string, UnmatchedGroup>();
  for (const m of members) {
    for (const t of m.terms) {
      if (t.house !== "shugiin" || isKnownShugiinGroup(t.group)) continue;
      const entry = byGroup.get(t.group) ?? { group: t.group, memberIds: [], sourceUrl: m.sourceUrl };
      if (!entry.memberIds.includes(m.id)) entry.memberIds.push(m.id);
      byGroup.set(t.group, entry);
    }
  }
  return [...byGroup.values()];
}

function assertUniqueIds(members: readonly Member[]): void {
  const seen = new Set<string>();
  for (const { id, name } of members) {
    if (seen.has(id)) throw new Error(`duplicate member id: ${id} (${name})`);
    seen.add(id);
  }
}

/** 全角空白・改行・&nbsp; を半角空白1つに正規化。 */
const normalize = (s: string) => s.replace(/[\s　 ]+/g, " ").trim();
const stripSpaces = (s: string) => s.replace(/[\s　 ]+/g, "");
