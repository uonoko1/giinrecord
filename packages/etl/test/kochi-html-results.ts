import { parse } from "node-html-parser";

export interface HtmlRow { number: string; title: string; result: string; dateText: string }

const clean = (s: string) => s.replace(/&nbsp;| /g, " ").replace(/[\s　]+/g, "").trim();

/**
 * 会期の詳細ページ（`/docs/…/`）の「議決結果一覧」の表。
 * **賛否 PDF とは別の一次資料である**（同じ県が別の場所に置いている）。
 * 列は 事件の番号 / 件名 / 議決結果 / 議決年月日。見出しの文言で表を選ぶ（位置で決め打ちにしない）。
 */
export function parseHtmlResults(html: string): HtmlRow[] {
  const root = parse(html);
  const tables = root.querySelectorAll("table").filter((t) => {
    const head = clean(t.querySelectorAll("tr")[0]?.text ?? "");
    return head.includes("件名") && head.includes("議決結果");
  });
  if (tables.length !== 1) throw new Error(`expected exactly one 議決結果一覧 table, got ${tables.length}`);
  const out: HtmlRow[] = [];
  for (const tr of tables[0].querySelectorAll("tr")) {
    const cells = tr.querySelectorAll("td,th").map((c) => clean(c.text));
    if (cells.length < 4) continue;
    // 番号の欄が 2 セルに割れていることがある（「第 １」「号」）ので、後ろの 3 つを固定して前を繋ぐ
    const dateText = cells[cells.length - 1];
    const result = cells[cells.length - 2];
    const title = cells[cells.length - 3];
    const number = cells.slice(0, cells.length - 3).join("");
    if (number.includes("番号") || title === "件名") continue;
    if (number === "" && title === "") continue;
    out.push({ number: number.normalize("NFKC"), title, result, dateText });
  }
  return out;
}
