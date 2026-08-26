import { parse, type HTMLElement } from "node-html-parser";
import type { RollCall, VoteValue } from "@seiji-kiroku/shared";
import { fetchText } from "../fetch.ts";

const BASE = "https://www.sangiin.go.jp/japanese/touhyoulist";

export interface RollCallListItem { href: string; title: string; dateJa: string }

/** List roll-call result pages for a Diet session. Verified 2026-08-22. */
export async function listRollCalls(session: number): Promise<RollCallListItem[]> {
  return parseRollCallList(await fetchText(`${BASE}/${session}/vote_ind.htm`, "utf-8", { noCache: true, session }), session);
}

/**
 * 一覧ページ vote_ind.htm を解析する純粋関数。
 * 採決が1件も無い回次（第218回・第220回のような特別国会・短い臨時国会）は見出しだけのページで、0件を正常に返す。
 * 旧レイアウト（第200〜216回、#103）は日付が `th.touhyo_date` ではなく `td[scope=row]`（rowspan で後続行に日付セルが無い）。
 * コメントアウトされたリンク（第205回に他回次のものが残っている）は node-html-parser が既定で落とすので拾わない。
 * 起立採決のページ（個人票が無い）も一覧には載る。呼び出し側が standingVoteNote で見分ける。
 */
export function parseRollCallList(html: string, session: number): RollCallListItem[] {
  const out: RollCallListItem[] = [];
  let dateJa = "";
  for (const tr of parse(html).querySelectorAll("tr")) {
    const th = tr.querySelector("th.touhyo_date") ?? tr.querySelector("td[scope=row]");
    if (th) dateJa = squash(th.text);
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
 * 起立採決のページ（個人票が無い）なら結果行の原文（例「起立採決により可決されました」）を返す。押しボタン投票のページなら undefined。
 * 新レイアウトは `p.kiritsu`、旧レイアウト（第200〜216回）は `<B>` の太字行。第210回・第216回は一覧の全件がこれ（#103）。
 * 個人票が無いので RollCall にはできない。呼び出し側（cli.ts）は件数をログに出して飛ばす（推定して票を作らない）。
 */
export function standingVoteNote(html: string): string | undefined {
  const box = parse(lowercaseRawTextClosers(html)).querySelector("#ContentsBox");
  if (!box) return undefined;
  for (const el of [box.querySelector("p.kiritsu"), ...box.querySelectorAll("b")]) {
    const text = squash(el?.text ?? "");
    if (text.includes("起立採決")) return text;
  }
  return undefined;
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
 * 旧レイアウト（第200〜216回、#103。verified 2026-08-24）は table 構成で、parseLegacyGroups が読む:
 *   <TT>第200回国会<BR>2019年 12月 6日<BR>投票結果</TT>、<TH>案件名：</TH><TD>案件名</TD>、<B>投票総数 N 賛成票 N 反対票 N</B>
 *   table > caption.party  会派名( N名)<br>賛成票 N 反対票 N
 *   tr > td.pro / td.con / td.nam  3人分を1行に横並び。pro は img sansei.jpg、con は img hantai.jpg、どちらも空なら 投票なし。
 *   行末の余りセルは氏名が空（票に数えない）。
 * Throws RollCallParseError instead of returning partial data.
 */
export function parseRollCall(html: string, sourceUrl: string, session: number): RollCall {
  const root = parse(lowercaseRawTextClosers(html));
  const box = root.querySelector("#ContentsBox") ?? root;
  const fail = (msg: string): never => { throw new RollCallParseError(msg, sourceUrl); };
  const legacy = !box.querySelector("h2.kaiji_nichiji") && !!box.querySelector("caption.party");

  const date = parseDate(box.querySelector("h2.kaiji_nichiji")?.text ?? (legacy ? box.text : "")) ?? fail("日付が取得できません");
  const title = squash(box.querySelector("dl.ankenmei dd")?.text ?? (legacy ? legacyTitle(box) : ""), "　");
  if (!title) fail("案件名が取得できません");
  const totalsText = box.querySelector("h3.tohyosousu")?.text ?? (legacy ? box.querySelectorAll("b").map((b) => b.text).find((t) => t.includes("投票総数")) : undefined);
  const totals = parseTotals(totalsText ?? "") ?? fail("投票総数が取得できません");

  const groups: RollCall["groups"] = [];
  const votes: RollCall["votes"] = [];
  if (legacy) parseLegacyGroups(box, groups, votes, fail);
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
 * 旧レイアウトのページは `<style >…</STYLE>` のように閉じタグだけ大文字で、node-html-parser は raw text 要素（style / script）の閉じタグを
 * 大文字小文字を区別して探すため、本文全体を style の中身として飲み込んで #ContentsBox が見つからなくなる。閉じタグだけ小文字に揃える（中身は触らない）。
 */
function lowercaseRawTextClosers(html: string): string {
  return html.replace(/<\/(style|script)(\s*)>/gi, (_, tag: string, ws: string) => `</${tag.toLowerCase()}${ws}>`);
}

/** 旧レイアウトの案件名: `<TH>案件名：</TH><TD>…</TD>` の TD。 */
function legacyTitle(box: HTMLElement): string {
  const th = box.querySelectorAll("th").find((t) => squash(t.text, "").startsWith("案件名"));
  return th?.nextElementSibling?.text ?? "";
}

/**
 * 旧レイアウトの会派ブロック: `table > caption.party` ごとに、その table の td.pro / td.con / td.nam の3つ組を票にする。
 * 会派見出しの人数と票数の不一致は fail（新レイアウトと同じ「黙って通さない」）。
 */
function parseLegacyGroups(box: HTMLElement, groups: RollCall["groups"], votes: RollCall["votes"], fail: (msg: string) => never): void {
  for (const caption of box.querySelectorAll("caption.party")) {
    const [headText, ...rest] = caption.innerHTML.split(/<br\s*\/?>/i);
    const head = squash(parse(headText).text).match(/^(.+?)\s*[(（]\s*(\d+)\s*名\s*[)）]$/) ?? fail(`会派見出しを解釈できません: ${squash(caption.text)}`);
    const group = head[1].trim();
    const size = +head[2];
    const tally = parseTally(parse(rest.join(" ")).text) ?? fail(`会派「${group}」の賛否集計を解釈できません`);
    groups.push({ group, size, ...tally });

    let count = 0;
    for (const tr of caption.parentNode.querySelectorAll("tr")) {
      const cells = tr.querySelectorAll("td");
      // 見出し行（th のみ）と table 末尾の余白行（class の無い空セル）は票ではない
      if (!cells.some((td) => td.classList.contains("nam"))) continue;
      for (let i = 0; i + 2 < cells.length; i += 3) {
        const [pro, con, nam] = [cells[i], cells[i + 1], cells[i + 2]];
        if (!pro.classList.contains("pro") || !con.classList.contains("con") || !nam.classList.contains("nam")) fail(`会派「${group}」の票セルの並びが pro/con/nam ではありません`);
        const nameText = squash(nam.text);
        if (!nameText) continue;
        count++;
        votes.push({ memberId: "", nameText, group, value: parseLegacyVoteValue(pro, con) ?? fail(`票の値を判別できません: ${nameText}`) });
      }
    }
    if (count !== size) fail(`会派「${group}」の人数 ${size} と個人票数 ${count} が一致しません`);
  }
}

/** 旧レイアウトの票: 賛成列の img（sansei.jpg）→ 賛成、反対列の img（hantai.jpg）→ 反対、両方とも空 → 投票なし。それ以外は不明（fail）。 */
function parseLegacyVoteValue(pro: HTMLElement, con: HTMLElement): VoteValue | undefined {
  const yes = /sansei/i.test(pro.querySelector("img")?.getAttribute("src") ?? "");
  const no = /hantai/i.test(con.querySelector("img")?.getAttribute("src") ?? "");
  if (yes && no) return undefined;
  if (yes) return "賛成";
  if (no) return "反対";
  const blank = (td: HTMLElement) => !td.querySelector("img") && squash(td.text, "") === "";
  return blank(pro) && blank(con) ? "投票なし" : undefined;
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
