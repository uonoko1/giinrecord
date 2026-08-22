import { parse, type HTMLElement } from "node-html-parser";
import type { RollCall, VoteValue } from "@seiji-kiroku/shared";
import { fetchText } from "../fetch.ts";

const BASE = "https://www.sangiin.go.jp/japanese/touhyoulist";

export interface RollCallListItem { href: string; title: string; dateJa: string }

/** List roll-call result pages for a Diet session. Verified 2026-08-22. */
export async function listRollCalls(session: number): Promise<RollCallListItem[]> {
  return parseRollCallList(await fetchText(`${BASE}/${session}/vote_ind.htm`, "utf-8", { noCache: true }), session);
}

/**
 * 一覧ページ vote_ind.htm を解析する純粋関数。
 * 採決が1件も無い回次（第218回・第220回のような特別国会・短い臨時国会）は見出しだけのページで、0件を正常に返す。
 */
export function parseRollCallList(html: string, session: number): RollCallListItem[] {
  const out: RollCallListItem[] = [];
  let dateJa = "";
  for (const tr of parse(html).querySelectorAll("tr")) {
    const th = tr.querySelector("th.touhyo_date");
    if (th) dateJa = th.text.trim();
    const a = tr.querySelector("a[href]");
    if (a && /-v\d+\.htm$/i.test(a.getAttribute("href") ?? "")) {
      out.push({ href: `${BASE}/${session}/${a.getAttribute("href")}`, title: a.text.trim(), dateJa });
    }
  }
  return out;
}

export class RollCallParseError extends Error {
  constructor(message: string, readonly sourceUrl: string) {
    super(`${message} (${sourceUrl})`);
    this.name = "RollCallParseError";
  }
}

/**
 * Parse one result page (e.g. 221-0605-v001.htm) into per-member votes.
 * Page structure (verified 2026-08-22):
 *   h2.kaiji_nichiji   第221回国会<br>2026年 6月 5日<br>投票結果
 *   dl.ankenmei dd     案件名
 *   h3.tohyosousu      投票総数 N <span>賛成票 N 反対票 N</span>
 *   h4.party           会派名(N名)            ← followed by
 *   dl.sanpilist       dt.party 賛成票 N 反対票 N / li.giin × N
 *   li.giin            span.pros|span.cons|span.novote + span.names
 * Throws RollCallParseError instead of returning partial data.
 */
export function parseRollCall(html: string, sourceUrl: string, session: number): RollCall {
  const root = parse(html);
  const box = root.querySelector("#ContentsBox") ?? root;
  const fail = (msg: string): never => { throw new RollCallParseError(msg, sourceUrl); };

  const date = parseDate(box.querySelector("h2.kaiji_nichiji")?.text ?? "") ?? fail("日付が取得できません");
  const title = squash(box.querySelector("dl.ankenmei dd")?.text ?? "", "　");
  if (!title) fail("案件名が取得できません");
  const totals = parseTotals(box.querySelector("h3.tohyosousu")?.text ?? "") ?? fail("投票総数が取得できません");

  const groups: RollCall["groups"] = [];
  const votes: RollCall["votes"] = [];
  for (const h4 of box.querySelectorAll("h4.party")) {
    const head = squash(h4.text).match(/^(.+?)\s*[(（]\s*(\d+)\s*名\s*[)）]$/) ?? fail(`会派見出しを解釈できません: ${squash(h4.text)}`);
    const group = head[1].trim();
    const size = +head[2];
    const list = h4.nextElementSibling?.classList.contains("sanpilist") ? h4.nextElementSibling : fail(`会派「${group}」の投票一覧が見つかりません`);
    const tally = parseTally(list.querySelector("dt")?.text ?? "") ?? fail(`会派「${group}」の賛否集計を解釈できません`);
    groups.push({ group, size, ...tally });

    const items = list.querySelectorAll("li.giin");
    if (items.length !== size) fail(`会派「${group}」の人数 ${size} と個人票数 ${items.length} が一致しません`);
    for (const li of items) {
      votes.push({ memberId: "", nameText: squash(li.querySelector(".names")?.text ?? ""), group, value: parseVoteValue(li) ?? fail(`票の値を判別できません: ${squash(li.text)}`) });
    }
  }
  if (groups.length === 0) fail("会派ブロックが0件です");
  const expected = groups.reduce((a, g) => a + g.size, 0);
  if (votes.length !== expected) fail(`会派人数の合計 ${expected} と個人票数 ${votes.length} が一致しません`);

  const id = sourceUrl.split("/").pop()!.replace(/\.htm$/i, "");
  return { id, session, date, title, totals, groups, votes, sourceUrl };
}

/**
 * Whitespace runs of any width (incl. U+3000) → one `sep`, trimmed.
 * Names: 「青木　　一彦」→「青木 一彦」, 「阿達 　 雅志」→「阿達 雅志」, 「いんどう周作」はそのまま。
 */
function squash(s: string, sep = " "): string {
  return s.replace(/[\s　]+/g, sep).trim();
}

function parseDate(text: string): string | undefined {
  const m = squash(text).match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : undefined;
}

function parseTotals(text: string): RollCall["totals"] | undefined {
  const t = squash(text);
  const total = t.match(/投票総数\s*(\d+)/);
  const tally = parseTally(t);
  return total && tally ? { total: +total[1], ...tally } : undefined;
}

function parseTally(text: string): { yes: number; no: number } | undefined {
  const t = squash(text);
  const yes = t.match(/賛成票\s*(\d+)/);
  const no = t.match(/反対票\s*(\d+)/);
  return yes && no ? { yes: +yes[1], no: +no[1] } : undefined;
}

/** Absorbs 「投票 なし」 / 「投票\nなし」 (rendered as two spans) and empty pros/cons spans. */
function parseVoteValue(li: HTMLElement): VoteValue | undefined {
  const pros = squash(li.querySelector(".pros")?.text ?? "");
  const cons = squash(li.querySelector(".cons")?.text ?? "");
  const novote = squash(li.querySelector(".novote")?.text ?? "", "");
  const marks: VoteValue[] = [];
  if (pros === "賛成") marks.push("賛成");
  if (cons === "反対") marks.push("反対");
  if (novote === "投票なし") marks.push("投票なし");
  return marks.length === 1 ? marks[0] : undefined;
}
