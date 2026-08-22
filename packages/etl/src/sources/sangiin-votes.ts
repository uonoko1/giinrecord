import { parse } from "node-html-parser";
import type { RollCall, VoteValue } from "@seiji-kiroku/shared";
import { fetchText } from "../fetch.ts";

const BASE = "https://www.sangiin.go.jp/japanese/touhyoulist";

/** List roll-call result pages for a Diet session. Verified 2026-08-22. */
export async function listRollCalls(session: number): Promise<{ href: string; title: string; dateJa: string }[]> {
  const html = await fetchText(`${BASE}/${session}/vote_ind.htm`, "utf-8", { noCache: true });
  const out: { href: string; title: string; dateJa: string }[] = [];
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

/** Parse one result page into per-member votes. */
export function parseRollCall(html: string, sourceUrl: string, session: number): RollCall {
  const text = parse(html).querySelector("#ContentsBox")?.text ?? parse(html).text;
  const flat = text.replace(/\s+/g, " ");
  const date = flat.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  const title = flat.match(/案件名：\s*(.+?)\s*投票総数/)?.[1] ?? "";
  const totals = {
    total: num(flat.match(/投票総数\s*(\d+)/)?.[1]),
    yes: num(flat.match(/賛成票\s*(\d+)/)?.[1]),
    no: num(flat.match(/反対票\s*(\d+)/)?.[1]),
  };
  const groups: RollCall["groups"] = [];
  const votes: RollCall["votes"] = [];
  // Group blocks: "会派名(101名) 賛成票 97 反対票 0 賛成 氏 名 賛成 氏 名 投票 なし 氏 名 ..."
  const re = /([^\s()]+)\(\s*(\d+)名\)\s*賛成票\s*(\d+)\s*反対票\s*(\d+)\s*((?:(?:賛成|反対|投票 なし)\s+[^\s]+(?: [^\s]+)?\s*)*)/g;
  for (const m of flat.matchAll(re)) {
    const group = m[1];
    groups.push({ group, size: +m[2], yes: +m[3], no: +m[4] });
    const body = m[5];
    for (const v of body.matchAll(/(賛成|反対|投票 なし)\s+((?:(?!賛成|反対|投票 なし)\S)+(?: (?:(?!賛成|反対|投票 なし)\S)+)?)/g)) {
      const value: VoteValue = v[1] === "投票 なし" ? "投票なし" : (v[1] as VoteValue);
      votes.push({ memberId: "", nameText: v[2].replace(/\s+/g, " ").trim(), group, value });
    }
  }
  const id = sourceUrl.split("/").pop()!.replace(/\.htm$/i, "");
  return {
    id, session,
    date: date ? `${date[1]}-${date[2].padStart(2, "0")}-${date[3].padStart(2, "0")}` : "",
    title, totals, groups, votes, sourceUrl,
  };
}

const num = (s?: string) => (s ? +s : 0);
