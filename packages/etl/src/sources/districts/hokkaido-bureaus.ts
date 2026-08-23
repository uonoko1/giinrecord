import { parse } from "node-html-parser";
import { fetchText } from "../../fetch.ts";

/**
 * 北海道「14総合振興局・振興局」（Issue #111）: https://www.pref.hokkaido.lg.jp/gyosei/shicho/index.html
 * 公職選挙法 別表第一の北海道は市を名指しし、町村を「北海道後志総合振興局管内」のように振興局でまとめる。
 * 振興局の所管市町村はこのページ（35 市 129 町 15 村）から取る。構造（2026-08-23 確認）:
 *   <h2 id="sorachi"><a href="…">空知総合振興局</a></h2> … <p>夕張市 ／岩見沢市 ／… ／沼田町</p>
 */
export const HOKKAIDO_BUREAUS_URL = "https://www.pref.hokkaido.lg.jp/gyosei/shicho/index.html";

export function parseHokkaidoBureaus(html: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  // h2 から次の h2 までを 1 局の塊にする（所管市町村の <p> は <div> の内外どちらにもある）
  const blocks = html.split(/(?=<h2\b)/i).filter((b) => /^<h2 id=/i.test(b));
  for (const block of blocks) {
    const root = parse(block);
    const name = root.querySelector("h2")?.text.replace(/\s/g, "") ?? "";
    if (!/振興局$/.test(name)) continue;
    const p = root.querySelectorAll("p").find((el) => el.text.includes("／"));
    if (!p) throw new Error(`hokkaido: municipality list (「市 ／町 ／…」) not found after ${name}`);
    const names = p.text.split("／").map((s) => s.replace(/[\s　]/g, "")).filter(Boolean);
    out.set(name, names);
  }
  if (out.size !== 14) throw new Error(`hokkaido: expected 14 bureaus, got ${out.size} (${[...out.keys()].join(", ")}) — page layout changed?`);
  return out;
}

export async function fetchHokkaidoBureaus(): Promise<Map<string, string[]>> {
  return parseHokkaidoBureaus(await fetchText(HOKKAIDO_BUREAUS_URL, "utf-8", { noCache: true }));
}
