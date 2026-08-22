import { parse } from "node-html-parser";
import type { Member, MemberSummary } from "@seiji-kiroku/shared";
import { fetchText } from "../fetch.ts";
import { stableJson } from "../json.ts";
import { isKnownGroup, resolveGroup } from "./sangiin-groups.ts";

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
 * 議員が 1 人も取れなければ例外（assertUniqueIds と同じ「黙って通さない」方針）。
 */
export function parseMemberList(html: string, sourceUrl: string, session: number): Member[] {
  const out: Member[] = [];
  for (const tr of parse(html).querySelectorAll("tr")) {
    const a = tr.querySelector("td a[href]");
    const profileId = a?.getAttribute("href")?.match(/profile\/(\d+)\.htm/)?.[1];
    if (!a || !profileId) continue;
    const cells = tr.querySelectorAll("td").map((td) => normalize(td.text));
    if (cells.length < 5) continue;
    const { name, legalName } = parseNameCell(a.innerHTML);
    out.push({
      id: memberIdFromProfileId(profileId),
      name,
      ...(legalName ? { legalName } : {}),
      kana: cells[1],
      house: "sangiin",
      terms: [{ house: "sangiin", group: resolveGroup(cells[2]), district: cells[3], from: "", to: warekiToIso(cells[4]), sessionFrom: session }],
      sourceUrl,
    });
  }
  // 0名は「表が無い」「リンク形式が変わった」のどちらかで、正常な結果ではありえない。
  // 黙って [] を返すと cli.ts がコミット済みの index.json を空で上書きしてしまうので例外にする。
  if (out.length === 0) throw new Error(`no members parsed from ${sourceUrl} (session ${session}): page layout may have changed`);
  assertUniqueIds(out);
  return out;
}

/**
 * 氏名セル: 通称使用者は「通称<BR>[本名]」の2行表記（第221回で 43/247 名）。
 * 投票ページの氏名は通称なので、name は <BR> より前だけを取り、本名は legalName に分けて保持する。
 */
export function parseNameCell(innerHtml: string): { name: string; legalName?: string } {
  const [first, ...rest] = innerHtml.split(/<br\s*\/?>/i);
  const name = normalize(parse(first).text);
  const legal = normalize(parse(rest.join(" ")).text).match(/^[\[［]\s*(.+?)\s*[\]］]$/)?.[1];
  return legal ? { name, legalName: normalize(legal) } : { name };
}

/** 永続IDの衝突（下6桁が同じプロフィールID）を黙って通さない。 */
function assertUniqueIds(members: Member[]): void {
  const seen = new Set<string>();
  for (const { id } of members) {
    if (seen.has(id)) throw new Error(`duplicate member id: ${id}`);
    seen.add(id);
  }
}

/** 対応表に無い会派略称（正式名称に解決できなかったもの）。data/unmatched-groups.json に出す。 */
export interface UnmatchedGroup {
  /** 名簿セルの原文（略称のまま公開データにも入っている）。 */
  group: string;
  memberIds: string[];
  sourceUrl: string;
}

/**
 * 正式名称に解決できなかった会派を、略称ごとにまとめて返す。
 * 新会派・改称のたびに略称が増えるので、ETL は止めずに運用者へ見せる（sangiin-groups.ts に追記すれば消える）。
 */
export function unmatchedGroups(members: Member[]): UnmatchedGroup[] {
  const byGroup = new Map<string, UnmatchedGroup>();
  for (const m of members) {
    for (const t of m.terms) {
      if (t.house !== "sangiin" || isKnownGroup(t.group)) continue;
      const entry = byGroup.get(t.group) ?? { group: t.group, memberIds: [], sourceUrl: m.sourceUrl };
      if (!entry.memberIds.includes(m.id)) entry.memberIds.push(m.id);
      byGroup.set(t.group, entry);
    }
  }
  return [...byGroup.values()];
}

export function toSummary(m: Member): MemberSummary {
  const t = m.terms[0];
  return {
    id: m.id, name: m.name, kana: m.kana, house: m.house,
    group: t?.group ?? "", district: t?.district ?? "", termEnd: t?.to,
    // 回次をまたいで統合する前（名簿1つだけ）の Member は全員が現職。
    current: m.current ?? true,
    counts: { rollcalls: 0, bills: 0, speeches: 0 },
  };
}

/** `data/members/index.json` の本文。キーは再帰的にソート、末尾改行（差分を小さくするため）。 */
export function serializeMembersIndex(members: Member[]): string {
  return stableJson(members.map(toSummary));
}

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
