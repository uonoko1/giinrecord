import { parse } from "node-html-parser";
import type { LocalMember } from "@seiji-kiroku/shared";
import { AOMORI_ASSEMBLY, AOMORI_DISTRICT_URL, AOMORI_ROSTER_URL, cleanText, isoDate, resolveAomoriUrl } from "./site.ts";

/**
 * 青森県議会の議員名簿（Issue #750）。**2 ページを合わせて 1 人ぶんにする:**
 *   - 会派別 `/soshiki/gikai/giin-kaiha.html`: `<h2 class="title03">自由民主党（27人）</h2>` ＋
 *     `<ul class="cc"><li><a href="giin_tanaka-junzo.html">田中　順造</a></li>…</ul>`
 *   - 選挙区別 `/soshiki/gikai/giin-senkyoku.html`: 表の `選挙区 / 構成市町村 / 定数 / 議員名`。
 *     1 つの `td` に複数の議員が `、` で並ぶ。
 *
 * ## **突き合わせは氏名ではなくプロフィールの URL で行う**（#529 が見つけた罠）
 *
 * **同じ議員の氏名が 2 ページで違う**（実測 2026-09-13、どちらも取り直して確認）:
 *   会派別 `和田　寬司`（寬 U+5BEC）／ 選挙区別 `和田 寛司`（寛 U+5BDB）
 * **NFC でも NFKC でも一致しない別字**で、`localNameKey` も畳まない（畳んではいけない。#569）。
 * **氏名で結合すると、この議員だけ選挙区が空になる**（あるいは悪くすると別人に付く）。
 * **プロフィールの URL は 46/46 で完全に一致する**（実測）ので、URL を鍵にする。
 *
 * **href の書き方は 3 通り揺れる**（`giin_tanaka-junzo.html` / `yamaya-kiyofumi.html` /
 * `/soshiki/gikai/giin_wada-kanji.html`）ので、**絶対 URL に直してから突き合わせる。**
 *
 * ## **`kana` は空にする**（推定しない）
 * **青森はふりがなを一覧ページに持たない。** ふりがなは議員ごとの個別ページ
 * （`giin_kushibiki-yukiko.html` の `櫛󠄁引　ユキ子（くしびき　ゆきこ）`）にしか無く、
 * **46 名ぶん取るには毎月 46 リクエストが増える。** 一覧 1 本から取れる 8 県とは事情が違う。
 * **ローマ字のファイル名（`kushibiki-yukiko`）からかなを起こさない**——それは推定である（#569）。
 * **空は「比較できない」であって「壊れている」ではない**ので、
 * `kanaNameRatioExceeds` の検算（#632）はこの議会では効かない。**その代わりに
 * 「会派別と選挙区別の 2 ページに同じ 46 人が居る」という別の検算を置く**（下記 `parseRoster`）。
 *
 * ## as-of
 * **名簿ページに掲載日がある**（`<p class="lastUpdate">更新日付：2026年5月25日</p>`）ので、
 * **取得日ではなくその日付を使う**（取得日を使ってよいのはページに日付が無いときだけ。滋賀・徳島）。
 *
 * ## id
 * `p_02_{プロフィールのファイル名から .html を除いたもの}`（`p_02_giin_tanaka-junzo`）。
 * **氏名からは作らない**（字がぶれるため）。
 */
export interface Roster {
  members: LocalMember[];
  /** 名簿ページの掲載日（更新日付） */
  asOf: string;
}

/**
 * 会派の見出し「自由民主党（27人）」。人数は検算に使う（読み落としを見つけるため）。
 * **人数は半角と全角が混在する**（実測 2026-09-13: 6 会派が `27人`、
 * **`立憲民主・憲法をいかす県民の会（２人）` と `無所属（２人）` は全角**）。
 * **半角だけを見ると、この 2 会派の 4 人が丸ごと落ちる**（実装中に実際に踏んだ。
 * 落ちても例外にならず「42 人の名簿」が黙って出る——下の人数の突き合わせが止めた）。
 */
const GROUP_HEADING = /^(.+?)[（(]([\d０-９]+)人[）)]$/;
/** 掲載日「更新日付：2026年5月25日」 */
const LAST_UPDATE = /更新日付：\s*(\d{4})年(\d{1,2})月(\d{1,2})日/;
/** プロフィールページのファイル名（`giin_tanaka-junzo.html`）。id に使う */
const PROFILE_FILE = /\/([A-Za-z0-9_-]+)\.html$/;

/** 名簿ページの掲載日（ISO）。無ければ例外（取得日で代用しない） */
export function parseLastUpdate(html: string, label: string): string {
  const m = parse(html).querySelector("p.lastUpdate")?.text.match(LAST_UPDATE);
  if (!m) throw new Error(`${label}: 更新日付が読めない`);
  return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** 選挙区別ページ → プロフィール URL → 選挙区名（「（7）青森市」の丸数字は落として「青森市」）。 */
export function parseDistricts(html: string, baseUrl: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const tr of parse(html).querySelectorAll("tr")) {
    const tds = tr.querySelectorAll("td");
    if (tds.length < 4) continue;
    // 「（1）東津軽郡」→「東津軽郡」。**番号は選挙区の名前ではない**ので落とす
    const district = cleanText(tds[0].text).replace(/^[（(]\d+[）)]\s*/, "");
    if (district === "") continue;
    for (const a of tds[3].querySelectorAll("a")) {
      const href = a.getAttribute("href");
      if (!href) continue;
      out.set(resolveAomoriUrl(href, baseUrl), district);
    }
  }
  if (out.size === 0) throw new Error("選挙区別ページに議員のリンクが 1 つも無い");
  return out;
}

export function parseRoster(kaihaHtml: string, senkyokuHtml: string): Roster {
  const asOf = parseLastUpdate(kaihaHtml, AOMORI_ROSTER_URL);
  const districts = parseDistricts(senkyokuHtml, AOMORI_DISTRICT_URL);
  const root = parse(kaihaHtml);
  const members: LocalMember[] = [];
  const ids = new Set<string>();
  /** 会派の見出しが宣言した人数（見出しの原文 → 人数）。読み落としの検算に使う */
  const declared: { group: string; count: number }[] = [];
  let group = "";
  // 会派の見出し（h2.title03）と議員の一覧（ul.cc）は文書順に交互に並ぶ
  for (const node of root.querySelectorAll("h2.title03, ul.cc")) {
    if (node.tagName === "H2") {
      const m = cleanText(node.text).match(GROUP_HEADING);
      // 「関連分野」など議員と関係ない h2 は会派ではない（人数の括弧が無い）
      if (!m) { group = ""; continue; }
      group = m[1];
      declared.push({ group, count: Number(m[2].normalize("NFKC")) });
      continue;
    }
    if (group === "") continue; // 会派の見出しの下でない ul は読まない
    for (const a of node.querySelectorAll("a")) {
      const href = a.getAttribute("href");
      if (!href) continue;
      const profileUrl = resolveAomoriUrl(href, AOMORI_ROSTER_URL);
      const file = profileUrl.match(PROFILE_FILE);
      if (!file) throw new Error(`プロフィールの URL が読めない: ${profileUrl}`);
      const id = `p_${AOMORI_ASSEMBLY.prefCode}_${file[1]}`;
      if (ids.has(id)) throw new Error(`${profileUrl} が名簿に 2 回出た`);
      ids.add(id);
      // **氏名ではなく URL で選挙区を引く**（和田寬司/寛司。docblock）
      const district = districts.get(profileUrl);
      if (district === undefined) throw new Error(`選挙区別ページに ${profileUrl} が無い（氏名 ${cleanText(a.text)}）`);
      const name = cleanText(a.text);
      if (name === "") throw new Error(`${profileUrl}: 氏名が空`);
      members.push({
        id,
        assemblyId: AOMORI_ASSEMBLY.id,
        name,
        // **青森は一覧ページにふりがなが無い**（docblock）。ローマ字から起こさない
        kana: "",
        group,
        district,
        profileUrl,
        current: true,
        asOf,
        sourceUrl: AOMORI_ROSTER_URL,
        counts: { rollcalls: 0 },
      });
    }
  }
  if (members.length === 0) throw new Error("会派別ページに議員が 1 人も居ない");
  // **見出しの人数と読めた人数が合うかを見る**（かなの検算（#632）が使えないぶん、ここで守る）。
  // **合わなければ例外**——読み落とした議員が居るまま `unmatched.json` が膨らむより、止まるほうがよい
  for (const d of declared) {
    const n = members.filter((m) => m.group === d.group).length;
    if (n !== d.count) throw new Error(`会派 ${d.group}: 見出しは ${d.count} 人だが ${n} 人しか読めない`);
  }
  // **選挙区別ページの人数とも合うかを見る**（2 つの独立した一次資料の突き合わせ）
  if (members.length !== districts.size) throw new Error(`会派別 ${members.length} 人 / 選挙区別 ${districts.size} 人 で数が合わない`);
  return { members, asOf };
}
