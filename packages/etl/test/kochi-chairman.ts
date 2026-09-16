import { parse, type HTMLElement } from "node-html-parser";

export interface Chair { dai: number; name: string; group: string; since: string }

/**
 * 高知県議会「議長・副議長」ページ（/chairman/）の **歴代議長** の表だけを読む。
 * **同じページに歴代副議長の表が並んでおり、代の番号も氏名も違う**——取り違えると錨が嘘になる。
 * だから「表の直前の見出しが 歴代議長 であるもの」だけを選ぶ（位置で決め打ちにしない）。
 */
export function parseChairs(html: string, heading: string): Chair[] {
  const root = parse(html);
  const tables = root.querySelectorAll("table");
  // 表は div に包まれていることがあるので、自分と親をさかのぼりながら直前の兄弟を見る。
  // **最初に見つかった「歴代議長」か「歴代副議長」の見出しだけを採る**（遠くの見出しに当たらない）。
  const headingOf = (t: HTMLElement): string | undefined => {
    let node: HTMLElement | null = t;
    for (let up = 0; up < 4 && node; up++) {
      let n: HTMLElement | null = node.previousElementSibling;
      for (let i = 0; i < 6 && n; i++) {
        const s = n.text.replace(/[\s　]+/g, "");
        if (s.includes("歴代副議長")) return "歴代副議長";
        if (s.includes("歴代議長")) return "歴代議長";
        n = n.previousElementSibling;
      }
      node = node.parentNode as HTMLElement | null;
    }
    return undefined;
  };
  const hit = tables.filter((t) => headingOf(t) === heading);
  if (hit.length !== 1) throw new Error(`expected exactly one ${heading} table, got ${hit.length}`);
  const rows: Chair[] = [];
  for (const tr of hit[0].querySelectorAll("tr")) {
    const cells = tr.querySelectorAll("td,th").map((c) => c.text.replace(/&nbsp;| /g, " ").replace(/[\s　]+/g, " ").trim());
    if (cells.length < 4) continue;
    const dai = Number(cells[0].normalize("NFKC"));
    if (!Number.isInteger(dai)) continue;
    // 氏名は 2 セル（姓・名）のことも 1 セルのこともある
    const since = cells[cells.length - 1];
    const group = cells[cells.length - 2];
    const name = cells.slice(1, cells.length - 2).join(" ").replace(/[\s　]+/g, " ").trim();
    if (name === "") continue;
    rows.push({ dai, name, group, since });
  }
  if (rows.length === 0) throw new Error(`${heading}: no rows`);
  return rows;
}

/** 就任年月日の原文（`R08.03.24` / `H27.05.12` / `S59.03.21` / `M13.07.`）→ ISO。日が無いものは undefined（月までしか分からない）。 */
export function parseSince(s: string): string | undefined {
  const m = s.normalize("NFKC").replace(/[\s　]/g, "").match(/^([MTSHR])(\d{1,2})\.(\d{1,2})\.(\d{1,2})$/);
  if (!m) return undefined;
  const base: Record<string, number> = { M: 1867, T: 1911, S: 1925, H: 1988, R: 2018 };
  return `${base[m[1]] + Number(m[2])}-${String(Number(m[3])).padStart(2, "0")}-${String(Number(m[4])).padStart(2, "0")}`;
}

/** その日に議長だった人（就任日 <= date のうち最も新しい）。 */
export function chairOn(chairs: readonly Chair[], date: string): Chair | undefined {
  const dated = chairs.flatMap((c) => { const d = parseSince(c.since); return d ? [{ c, d }] : []; }).sort((a, b) => a.d.localeCompare(b.d));
  let cur: Chair | undefined;
  for (const { c, d } of dated) { if (d <= date) cur = c; }
  return cur;
}
