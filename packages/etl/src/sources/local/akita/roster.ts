import { parse } from "node-html-parser";
import type { LocalMember } from "@seiji-kiroku/shared";
import { AKITA_ASSEMBLY, AKITA_ROSTER_URL, cleanText, isoDate, resolveAkitaUrl } from "./site.ts";

/**
 * 秋田県議会の議員名簿（Issue #759）。**1 ページに 4 つの一覧がある:**
 *   `/doc/2018042300017/`（議員紹介、公開日つき）
 *     - `<h2><span id="gojuon">五十音別一覧…` ＋ 表（**41 人。これを名簿の実体とする**）
 *     - `<h2><span id="senkyoku">選挙区別一覧…` ＋ `<h4>秋田市 （１２人）</h4>` ＋ 表（**選挙区**）
 *     - `<h2><span id="iinkai">委員会別一覧…`（**読まない**。委員会は採決の記録ではない）
 *     - `<h2><span id="kaiha">会派別一覧…` ＋ `<h4>自由民主党（27人）</h4>` ＋ 表（**会派**）
 *
 * ## **突き合わせは氏名ではなくプロフィールの URL で行う**（青森 #529 と同じ判断）
 * **議員はみな `/profile/{13桁}/` のリンクを持つ**（実測 41 / 41）。
 * **`id` はそのファイル名から作る**（氏名からは作らない。字がぶれるため）。
 *
 * ## **`川邉隼之介` は 3 つの `<a>` に割れている**（秋田固有の罠。実測 2026-09-13）
 * **会派別一覧の 1 つの `<td>` の中が次のようになっている**（原文）:
 * ```html
 * <td …><a href="http://…/profile/2025040700015/">川邉</a>
 *       <a href="https://…/profile/2025040700015/">隼</a>
 *       <a href="http://…/profile/2025040700015/">之介</a></td>
 * ```
 * **`<a>` ごとに議員を作ると、この 1 人が 3 人になる**（`川邉` `隼` `之介`）。
 * **しかも 3 つのうち 2 つが `http://`、1 つが `https://`** なので、
 * **URL をそのまま鍵にすると同じ議員が 2 つの鍵に見える**（`resolveAkitaUrl` が `https:` に寄せる）。
 * **だから「`<td>` 1 つ ＝ 議員 1 人」として読み、`<td>` の中の `<a>` のテキストを全部繋ぐ。**
 * **五十音別一覧では 1 つの `<a>` なので、どちらの一覧でも同じ氏名 `川邉隼之介` になる**（実測）。
 *
 * ## **定数 43 に対して 41 人**（欠員 2）
 * **選挙区別一覧の `（１２人）` は選挙区の定数**（ページの注記: `※カッコ内は各選挙区定数`）で、
 * **合計は 43 になるが、載っている議員は 41 人である**（実測）。
 * **定数を議員数として使わない**（大分 #617 が同じ罠を名指ししている）。
 * **だから「選挙区の定数と人数が合う」という検算は置けない。**
 * **代わりに「五十音別・選挙区別・会派別の 3 つの一覧に同じ 41 人が居る」を検算にする**
 * （**3 つの独立した一覧の突き合わせ**。1 つの読み落としで必ず落ちる）。
 * **会派別の見出しの人数（`自由民主党（27人）`）とも合わせる**（青森 #750 と同じ）。
 *
 * ## **`kana` は空にする**（推定しない）
 * **議員紹介ページにふりがなが無い**（実測: 氏名のリンクだけで、ふりがなの `<rt>` も併記も無い）。
 * **ふりがなは議員ごとのプロフィールページにある可能性があるが、41 名ぶん取ると
 * 毎月 41 リクエストが増える**——青森（#750）と同じ判断で取りに行かない。
 * **ローマ字も無い**（URL は `/profile/{13桁}/` の連番で、氏名の情報が無い）。
 * **空は「比較できない」であって「壊れている」ではない**ので、
 * `kanaNameRatioExceeds` の検算（#632）はこの議会では効かない。
 *
 * ## as-of
 * **`<p class="publishedAt">公開日 2026年7月24日</p>` がある**ので、**取得日ではなくその日付を使う**
 * （取得日を使ってよいのはページに日付が無いときだけ。滋賀・徳島）。
 */
export interface Roster {
  members: LocalMember[];
  /** 名簿ページの公開日 */
  asOf: string;
}

/** 公開日「公開日 2026年7月24日」 */
const PUBLISHED_AT = /(\d{4})年(\d{1,2})月(\d{1,2})日/;
/** プロフィールページの URL（`/profile/2018052300021/`）。id に使う */
const PROFILE_ID = /\/profile\/(\d+)\/?$/;
/** 会派の見出し「自由民主党（27人）」。**人数は全角**（実測: `（２７人）` ではなく `（27人）` の本もある） */
const GROUP_HEADING = /^(.+?)[（(]([\d０-９]+)人[）)]$/;
/** 選挙区の見出し「秋田市 （１２人）」。**人数は選挙区の定数**（議員数ではない。docblock） */
const DISTRICT_HEADING = /^(.+?)\s*[（(]([\d０-９]+)人[）)]$/;

/** 名簿ページの公開日（ISO）。無ければ例外（取得日で代用しない）。 */
export function parsePublishedAt(html: string): string {
  const m = parse(html).querySelector("p.publishedAt")?.text.match(PUBLISHED_AT);
  if (!m) throw new Error(`${AKITA_ROSTER_URL}: 公開日が読めない`);
  return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** 記事本文（`<article class="contentGpArticleDoc">` の中）。ヘッダ・サイドバー・フッタを読まないため。 */
function articleBody(html: string): string {
  const root = parse(html);
  const art = root.querySelector("article.contentGpArticleDoc");
  if (!art) throw new Error(`${AKITA_ROSTER_URL}: 記事本文が見つからない`);
  return art.innerHTML;
}

/**
 * 一覧の 1 つ（`id="gojuon"` などのアンカーから、次のアンカーまで）を切り出す。
 * **アンカーの `id` はページの中で 1 回だけ出る**（実測）。
 */
function section(body: string, id: string, nextIds: readonly string[]): string {
  const start = body.indexOf(`id="${id}"`);
  if (start < 0) throw new Error(`${AKITA_ROSTER_URL}: 一覧 ${id} が無い`);
  let end = body.length;
  for (const n of nextIds) {
    const i = body.indexOf(`id="${n}"`, start);
    if (i > start && i < end) end = i;
  }
  return body.slice(start, end);
}

/**
 * 一覧の中の「見出し → その下の表の議員」を読む。
 * **`<td>` 1 つ ＝ 議員 1 人**（`<a>` ごとに数えない。docblock の `川邉隼之介`）。
 * 返すのは `[プロフィール URL, 氏名, 見出し]` の並び（**見出しの無い一覧では見出しが空**）。
 */
export function parseSection(html: string, headingTag: "h4" | "none"): { profileUrl: string; name: string; heading: string }[] {
  const out: { profileUrl: string; name: string; heading: string }[] = [];
  const root = parse(`<div>${html}</div>`);
  let heading = "";
  for (const node of root.querySelectorAll(headingTag === "h4" ? "h4, td" : "td")) {
    if (node.tagName === "H4") { heading = cleanText(node.text); continue; }
    // **`<td>` の中の `<a>` を全部繋いで 1 人ぶんの氏名にする**（`川邉` ＋ `隼` ＋ `之介`）
    const links = node.querySelectorAll("a").filter((a) => PROFILE_ID.test(a.getAttribute("href") ?? ""));
    if (links.length === 0) continue;
    const urls = new Set(links.map((a) => resolveAkitaUrl(a.getAttribute("href")!, AKITA_ROSTER_URL)));
    // **同じ `<td>` に 2 人の議員が入っていたら例外**（そういう本は無いが、出たら黙って 1 人にしない）
    if (urls.size !== 1) throw new Error(`${AKITA_ROSTER_URL}: 1 つの td に ${urls.size} 人ぶんのリンクがある（${[...urls].join(" ")}）`);
    const name = cleanText(links.map((a) => a.text).join(""));
    if (name === "") continue;
    out.push({ profileUrl: [...urls][0], name, heading });
  }
  return out;
}

export function parseRoster(html: string): Roster {
  const asOf = parsePublishedAt(html);
  const body = articleBody(html);
  // **五十音別一覧を名簿の実体とする**（見出しは `あ` `か` … なので読まない）
  const gojuon = parseSection(section(body, "gojuon", ["senkyoku", "iinkai", "kaiha", "giin"]), "none");
  const districts = parseSection(section(body, "senkyoku", ["iinkai", "kaiha", "giin"]), "h4");
  const groups = parseSection(section(body, "kaiha", ["giin"]), "h4");
  if (gojuon.length === 0) throw new Error(`${AKITA_ROSTER_URL}: 五十音別一覧に議員が 1 人も居ない`);

  // **URL で引ける表にする**（氏名では引かない。青森 #529 の教訓）
  const districtOf = new Map<string, string>();
  for (const d of districts) {
    // 「秋田市 （１２人）」→「秋田市」。**人数は選挙区の定数なので捨てる**（docblock）
    const m = d.heading.match(DISTRICT_HEADING);
    districtOf.set(d.profileUrl, m ? m[1].trim() : d.heading);
  }
  const groupOf = new Map<string, string>();
  /** 会派の見出しが宣言した人数（読み落としの検算に使う） */
  const declared = new Map<string, number>();
  for (const g of groups) {
    const m = g.heading.match(GROUP_HEADING);
    const name = m ? m[1].trim() : g.heading;
    groupOf.set(g.profileUrl, name);
    if (m) declared.set(name, Number(m[2].normalize("NFKC")));
  }

  const members: LocalMember[] = [];
  const ids = new Set<string>();
  for (const p of gojuon) {
    const file = p.profileUrl.match(PROFILE_ID);
    if (!file) throw new Error(`プロフィールの URL が読めない: ${p.profileUrl}`);
    const id = `p_${AKITA_ASSEMBLY.prefCode}_${file[1]}`;
    if (ids.has(id)) throw new Error(`${p.profileUrl} が名簿に 2 回出た`);
    ids.add(id);
    // **3 つの一覧に同じ議員が居ることを確かめる**（独立した一覧の突き合わせ。docblock）。
    // **合わなければ例外**——読み落としたまま `unmatched.json` が膨らむより、止まるほうがよい
    const district = districtOf.get(p.profileUrl);
    if (district === undefined) throw new Error(`選挙区別一覧に ${p.profileUrl}（${p.name}）が無い`);
    const group = groupOf.get(p.profileUrl);
    if (group === undefined) throw new Error(`会派別一覧に ${p.profileUrl}（${p.name}）が無い`);
    members.push({
      id,
      assemblyId: AKITA_ASSEMBLY.id,
      name: p.name,
      // **秋田はふりがなを一覧ページに持たない**（docblock）。ローマ字からも起こさない（#569）
      kana: "",
      group,
      district,
      profileUrl: p.profileUrl,
      current: true,
      asOf,
      sourceUrl: AKITA_ROSTER_URL,
      counts: { rollcalls: 0 },
    });
  }
  // **選挙区別・会派別に、五十音別に無い議員が居ないことも見る**（片側だけの検算にしない）
  if (districtOf.size !== members.length) throw new Error(`五十音別 ${members.length} 人 / 選挙区別 ${districtOf.size} 人 で数が合わない`);
  if (groupOf.size !== members.length) throw new Error(`五十音別 ${members.length} 人 / 会派別 ${groupOf.size} 人 で数が合わない`);
  // **会派の見出しの人数と読めた人数が合うか**（かなの検算（#632）が使えないぶん、ここで守る）
  for (const [group, count] of declared) {
    const n = members.filter((m) => m.group === group).length;
    if (n !== count) throw new Error(`会派 ${group}: 見出しは ${count} 人だが ${n} 人しか読めない`);
  }
  return { members, asOf };
}
