import { parse } from "node-html-parser";
import type { Member, MemberSummary } from "@seiji-kiroku/shared";
import { fetchText } from "../fetch.ts";

const BASE = "https://www.sangiin.go.jp/japanese/joho1/kousei/giin";

export const memberListUrl = (session: number) => `${BASE}/${session}/giin.htm`;

/** Fetch and parse the member roster for a Diet session. */
export async function fetchMembers(session: number): Promise<Member[]> {
  const url = memberListUrl(session);
  return parseMemberList(await fetchText(url, "utf-8", { noCache: true }), url, session);
}

/**
 * 永続ID: 参院プロフィールID（7桁。先頭桁は 7 が大半だが 5 もある）の下6桁を "m_" に付ける。
 * 下6桁は第221回時点で一意（parseMemberList が重複を検出して例外にする）。
 * 衆院議員は将来、衝突しない別の導出規則で同じ "m_" 空間に入れる想定。氏名からは導出しない。
 */
export function memberIdFromProfileId(profileId: string): string {
  if (!/^\d{7}$/.test(profileId)) throw new Error(`unexpected sangiin profile id: ${profileId}`);
  return `m_${profileId.slice(-6)}`;
}

/**
 * 議員一覧（50音順）を Member[] に変換する。
 * 行構成: 索引行（あ行…）・見出し行・各議員行。プロフィールリンクを持つ行だけを議員とみなす。
 * 第221回: 250 tr のうち 247 名（定数 248、欠員 1）。
 */
export function parseMemberList(html: string, sourceUrl: string, session: number): Member[] {
  const out: Member[] = [];
  for (const tr of parse(html).querySelectorAll("tr")) {
    const a = tr.querySelector("td a[href]");
    const profileId = a?.getAttribute("href")?.match(/profile\/(\d+)\.htm/)?.[1];
    if (!a || !profileId) continue;
    const cells = tr.querySelectorAll("td").map((td) => normalize(td.text));
    if (cells.length < 5) continue;
    out.push({
      id: memberIdFromProfileId(profileId),
      name: normalize(a.text),
      kana: cells[1],
      house: "sangiin",
      terms: [{ house: "sangiin", group: cells[2], district: cells[3], from: "", to: warekiToIso(cells[4]), sessionFrom: session }],
      sourceUrl,
    });
  }
  assertUniqueIds(out);
  return out;
}

/** 永続IDの衝突（下6桁が同じプロフィールID）を黙って通さない。 */
function assertUniqueIds(members: Member[]): void {
  const seen = new Set<string>();
  for (const { id } of members) {
    if (seen.has(id)) throw new Error(`duplicate member id: ${id}`);
    seen.add(id);
  }
}

export function toSummary(m: Member): MemberSummary {
  const t = m.terms[0];
  return {
    id: m.id, name: m.name, kana: m.kana, house: m.house,
    group: t?.group ?? "", district: t?.district ?? "", termEnd: t?.to,
    counts: { rollcalls: 0, bills: 0, speeches: 0 },
  };
}

/** `data/members/index.json` の本文。キーは再帰的にソート、末尾改行（差分を小さくするため）。 */
export function serializeMembersIndex(members: Member[]): string {
  return JSON.stringify(members.map(toSummary), sortKeys, 1) + "\n";
}

const sortKeys = (_: string, v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : v;

const ERA: Record<string, number> = { 令和: 2018, 平成: 1988, 昭和: 1925 };

/** 「令和10年7月25日」→ "2028-07-25"。解釈できなければ undefined。 */
export function warekiToIso(s: string): string | undefined {
  const m = s.match(/(令和|平成|昭和)\s*(元|\d+)年\s*(\d{1,2})月\s*(\d{1,2})日/);
  if (!m) return undefined;
  const y = ERA[m[1]] + (m[2] === "元" ? 1 : +m[2]);
  return `${y}-${m[3].padStart(2, "0")}-${m[4].padStart(2, "0")}`;
}

/** 全角空白・改行・&nbsp; を半角空白1つに正規化。 */
const normalize = (s: string) => s.replace(/[\s　 ]+/g, " ").trim();
