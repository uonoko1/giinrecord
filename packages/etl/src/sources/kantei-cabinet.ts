import { parse } from "node-html-parser";
import type { House } from "@seiji-kiroku/shared";
import { fetchText } from "../fetch.ts";

/**
 * 首相官邸の**現職**の閣僚等名簿（Issue #1140。調査の全文は #1135）。
 *
 * ## 何が取れていなかったか
 *
 * このサイトは「この議員は何をしたか」を一次資料だけで出すが、**そのうち「大臣・副大臣・
 * 大臣政務官として省庁を率いた」という層が 1 件も取れていなかった。**
 * **国会のサイトには無い**——**大臣の任免は内閣が行うので国会の管轄外である。**
 * 会議録の `speakerPosition` には役職が入るが、**発言していない大臣は 1 件も出ない**
 * （#1135 の実測: 中田 宏 は 2 つの内閣で副大臣だが、2025-10-01〜2026-09-30 で 0 件）。
 * だから**名簿そのもの**を一次資料として取る。
 *
 * ## 官報は使わない
 *
 * 任免の一次資料は官報だが、`https://www.kanpo.go.jp/robots.txt` が
 * `Disallow: /20` で本文 URL（`/20YYMMDD/...`）を全部覆っており、許可されているのは
 * `User-agent: ndl-japan` だけである（#1135 で実測）。**提供元が機械的取得を拒んでいる。**
 *
 * ## 取得の作法
 *
 * `www.kantei.go.jp/robots.txt` は **404**（2026-09-30 に実測。衆院・参院と同じ状況）。
 * **提供元が 1 秒未満を許可している事実は無い**ので、`fetch.ts` の `POLITENESS_FLOOR_MS`
 * （＝ `HTML_INTERVAL_MS`。`fetchText` が既定で待つ）をそのまま使う。
 *
 * ## このモジュールが持たないもの
 *
 * **歴代（`rekidainaikaku/001.html`〜`105.html`、5,188 件）は扱わない**（#1141）。
 * 歴代ページには**所属院の欄が無く**、氏名だけでは 13 件が割れない（うち 5 件が
 * 唯一の「本物の別人」である 鬼木 誠）。ここで混ぜると #569 の「別人の記録が出る」になる。
 */

/** 第105代（第2次高市改造内閣）。URL に内閣の代が入るので、代を引数に取る。 */
export const CABINET = 105;

const BASE = "https://www.kantei.go.jp/jp";

/**
 * 名簿は 3 ページある（閣僚 / 副大臣 / 大臣政務官）。
 *
 * **1 ページでも落とすと、その層の全員が「役職に就いていない」と区別がつかなくなる**
 * （`shugiin-members.ts` の `ROSTER_PAGES` と同じ倒れ方。#1037）。
 * `sourihosakan.html`（内閣総理大臣補佐官）は**この PBI の対象外**——#1135 が数えた
 * 76 件（21 + 27 + 28）に含まれておらず、受け入れ条件の母数と合わなくなる。
 */
export const MEIBO_PAGES: readonly { file: string; kind: CabinetPostKind }[] = [
  { file: "index.html", kind: "閣僚等" },
  { file: "fukudaijin.html", kind: "副大臣" },
  { file: "seimukan.html", kind: "大臣政務官" },
];

/** そのページが載せている層（ページの見出しの区分そのもの。役職名の分類ではない）。 */
export type CabinetPostKind = "閣僚等" | "副大臣" | "大臣政務官";

export const meiboPageUrl = (cabinet: number, file: string): string => `${BASE}/${cabinet}/meibo/${file}`;

/**
 * 名簿 1 行（1 人）。**役職名は原文のまま、複数を配列で持つ。**
 *
 * 1 人が「財務大臣」「内閣府特命担当大臣（金融）」「租税特別措置・補助金見直し担当」…を
 * 同時に持つ（名簿では `<br>` で区切られている）。**分類・要約・代表 1 件への丸めをしない。**
 */
export interface CabinetPost {
  /** ページの区分（閣僚等 / 副大臣 / 大臣政務官）。 */
  kind: CabinetPostKind;
  /** 役職名の原文（`<br>` 区切りをそのまま配列に）。1 件以上。 */
  roles: string[];
  /**
   * 氏名の原文。**外字の議員はここが `undefined` になる**——
   * 名簿が氏名を**画像**に置き換えており、本文テキストに漢字が存在しない:
   * `<img src="…png" alt="はなし やすひろ" class="externalCharacter gaiji size-reg">`
   * **`alt` に入っているのは「かな」だけで、漢字は取れない。**
   * 2026-09-30 の実測で 4 件（葉梨 康弘 / 尾崎 正直 / 高木 啓 / 高橋 祐介）。
   */
  name?: string;
  /** ふりがなの原文から丸括弧を除いたもの（例「かたやま さつき」）。 */
  kana: string;
  /** 名簿の所属院の表記（「衆議院」→ shugiin / 「参議院」→ sangiin）。 */
  house: House;
  /**
   * 内閣の発足日（ISO）。**ページごとに違う**——閣僚は `令和８年９月１７日発足`、
   * 副大臣・大臣政務官は `令和８年９月１８日` で 1 日ずれる。**ページごとに取る。**
   */
  effectiveDate: string;
  /** 名簿ページの原文の日付表記（例「令和８年９月１７日発足」）。 */
  effectiveDateText: string;
  /** その役職の出典 URL（一次資料）。役職 1 件ごとにこの行の URL が付く。 */
  sourceUrl: string;
}

/** 1 ページ分の名簿。 */
export interface MeiboPage {
  kind: CabinetPostKind;
  /** ページ見出しの内閣名（例「第２次高市改造内閣 閣僚名簿」）。 */
  heading: string;
  effectiveDate: string;
  effectiveDateText: string;
  sourceUrl: string;
  posts: CabinetPost[];
  /**
   * 所属院の欄が無かった行の数。**国会議員でない人**（事務方の内閣官房副長官・内閣法制局長官）で、
   * 名簿に所属院の表記が無い。**0 件と数えていないを区別する**ため、落とした数を持って返す。
   * 2026-09-30 の実測: `index.html` で 2 件（露木 康浩 / 岩尾 信行）、他 2 ページは 0 件。
   */
  withoutHouse: number;
}

export class CabinetParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CabinetParseError";
  }
}

const HOUSE_OF: Readonly<Record<string, House>> = { 衆議院: "shugiin", 参議院: "sangiin" };

const ERA: Readonly<Record<string, number>> = { 令和: 2018, 平成: 1988 };

/**
 * 見出しの下の日付（`令和８年９月１７日発足` / `令和８年９月１８日`）を ISO に。
 *
 * **全角数字で書かれている**（`令和８年９月１７日`）ので NFKC で半角に寄せてから読む。
 * 「発足」が付かないページもあるので、**「発足」は必須にしない**（副大臣・政務官のページは
 * 日付だけ。必須にすると 55 件が丸ごと落ちる）。
 *
 * `text` は**正規化前の原文**を返す（`令和８年９月１７日発足` のまま）。
 * 全角数字の NFKC は 1 文字 → 1 文字なので、正規化後の一致位置で原文を切り出せる。
 */
export function parseEffectiveDate(text: string): { date: string; text: string } | undefined {
  const normalized = text.normalize("NFKC");
  const m = /(令和|平成)\s*(元|[0-9]+)年\s*([0-9]{1,2})月\s*([0-9]{1,2})日(発足)?/.exec(normalized);
  if (!m) return undefined;
  const base = ERA[m[1]];
  if (base === undefined) return undefined;
  const y = base + (m[2] === "元" ? 1 : Number(m[2]));
  // 長さが変わる正規化（合字など）が混ざっていたら原文を切り出せないので、正規化後の文字列を返す。
  const raw = normalized.length === text.length ? text.slice(m.index, m.index + m[0].length) : m[0];
  return { date: `${y}-${m[3].padStart(2, "0")}-${m[4].padStart(2, "0")}`, text: raw };
}

/** 空白（全角含む）を 1 個の半角空白に寄せて前後を落とす。氏名・かな・所属院に使う。 */
const tidy = (s: string): string => s.replace(/[\s　]+/g, " ").trim();

/**
 * 役職名の整形。**前後の空白を落とすだけで、中の空白は原文のまま残す。**
 *
 * **全角空白を半角に寄せてはいけない**——役職名の中で全角空白が**区切り**として使われている:
 * `内閣府特命担当大臣（知的財産戦略　科学技術政策　宇宙政策　人工知能戦略　海洋政策　サイバー安全保障）`。
 * ここを半角 1 個に寄せると、**役職名が原文と違うものになる**（この PBI は「原文のまま持つ」）。
 * HTML の改行・タブだけは 1 個の半角空白に寄せる（マークアップの都合であって原文の一部ではない）。
 */
const tidyRole = (s: string): string => s.replace(/[\r\n\t]+/g, " ").replace(/^[\s　]+|[\s　]+$/g, "");

/**
 * 名簿 1 ページを `MeiboPage` に変換する純粋関数。
 *
 * - 1 人 = `li.list-profile__item`。役職は `.list-profile__title` を `<br>` で割る。
 * - 氏名は `.list-profile__name` からふりがなの `span` を除いたテキスト。
 *   **外字の議員はここが空になる**（画像しか無い）ので `name` は `undefined` にする。
 *   **`alt` の「かな」を氏名として使わない**——かなは氏名ではないし、`alt` には
 *   `（おざき まさなお）` のように括弧付きで入っている行もある（実測）。
 * - 所属院は `.label`。**この欄が無い行は国会議員ではない**ので落とし、`withoutHouse` に数える。
 * - 1 人も取れなければ例外（黙って空の名簿を返さない。`shugiin-members.ts` と同じ）。
 */
export function parseMeiboPage(html: string, sourceUrl: string, kind: CabinetPostKind): MeiboPage {
  const root = parse(html);
  const h2 = root.querySelector("h2.heading-lv2");
  const heading = tidy(h2?.text ?? "");
  if (h2 === null || heading === "") throw new CabinetParseError(`${sourceUrl}: 名簿の見出し（h2.heading-lv2）がありません`);
  // **日付は見出しの兄弟の `<p>` から取る。ページ全体から探してはいけない。**
  // ページ上部の説明文が `令和8年9月17日に発足した第２次高市改造内閣の…` と**「に発足」**を含み、
  // ページ末尾のリンク文にも同じ文が入っている。全体から拾うと、副大臣・政務官のページでも
  // その説明文（閣僚の日付）に当たってしまい、**09-18 が 09-17 に化ける**（実測で踏んだ）。
  const dateEl = (h2.parentNode?.querySelectorAll("p") ?? []).map((p) => parseEffectiveDate(p.text)).find((d) => d !== undefined);
  if (dateEl === undefined) throw new CabinetParseError(`${sourceUrl}: 内閣の発足日（令和N年M月D日）がありません`);

  const posts: CabinetPost[] = [];
  let withoutHouse = 0;
  for (const li of root.querySelectorAll("li.list-profile__item")) {
    const title = li.querySelector(".list-profile__title");
    if (title === null) throw new CabinetParseError(`${sourceUrl}: 役職名（.list-profile__title）が無い行があります`);
    // `<br>` で役職が並ぶ。innerHTML を割ってからタグを落とす（textContent では改行が消える）。
    const roles = title.innerHTML.split(/<br\s*\/?>/i).map((s) => tidyRole(parse(s).text)).filter((s) => s !== "");
    if (roles.length === 0) throw new CabinetParseError(`${sourceUrl}: 役職名が空の行があります`);

    const nameEl = li.querySelector(".list-profile__name");
    if (nameEl === null) throw new CabinetParseError(`${sourceUrl}: 氏名欄（.list-profile__name）が無い行があります（${roles[0]}）`);
    const rubyEl = nameEl.querySelector(".list-profile__name--ruby");
    if (rubyEl === null) throw new CabinetParseError(`${sourceUrl}: ふりがな（.list-profile__name--ruby）が無い行があります（${roles[0]}）`);
    const kana = tidy(rubyEl.text).replace(/^[（(]|[）)]$/g, "");
    if (kana === "") throw new CabinetParseError(`${sourceUrl}: ふりがなが空の行があります（${roles[0]}）`);
    // ふりがなの span を外してから氏名を取る。外字の行は img しか残らないので空になる。
    const nameText = tidy(nameEl.childNodes.filter((n) => n !== rubyEl).map((n) => n.text).join(""));

    const houseText = tidy(li.querySelector(".label")?.text ?? "").replace(/\s/g, "");
    const house = HOUSE_OF[houseText];
    if (house === undefined) { withoutHouse++; continue; }

    posts.push({
      kind, roles,
      ...(nameText === "" ? {} : { name: nameText }),
      kana, house,
      effectiveDate: dateEl.date, effectiveDateText: dateEl.text,
      sourceUrl,
    });
  }
  if (posts.length === 0) throw new CabinetParseError(`${sourceUrl}: 所属院のある行が 1 件もありません（名簿の構成が変わった可能性）`);
  return { kind, heading, effectiveDate: dateEl.date, effectiveDateText: dateEl.text, sourceUrl, posts, withoutHouse };
}

/**
 * **取得の差し替え口**（`shugiin-members.ts` の `setFetchTextForTest` と同じ向き。検査だけが使う）。
 *
 * **これが無いと「3 ページ取れている」ことを誰も検査できない。**
 * `MEIBO_PAGES` の中身を `deepEqual` で固定しても、**取得ループに `break` を入れれば
 * 列挙は無傷のまま 1 ページしか取らない**（#1037 の実測と同じ形）。
 */
let fetchTextForTest: typeof fetchText | undefined;
export function setFetchTextForTest(f: typeof fetchText | undefined): void { fetchTextForTest = f; }

/**
 * 3 ページすべてを取得して結合する。
 *
 * **`noCache` は付けない**——名簿の URL に内閣の代が入っており（`/jp/105/meibo/`）、
 * 代が変われば URL も変わるので、同じ URL は同じ内閣の名簿を指す。
 * 取得間隔は `fetchText` が `HTML_INTERVAL_MS`（= `POLITENESS_FLOOR_MS`）で待つ。
 */
export async function fetchCabinetPosts(cabinet: number = CABINET): Promise<{ pages: MeiboPage[]; posts: CabinetPost[] }> {
  const get = fetchTextForTest ?? fetchText;
  const pages: MeiboPage[] = [];
  for (const { file, kind } of MEIBO_PAGES) {
    const url = meiboPageUrl(cabinet, file);
    pages.push(parseMeiboPage(await get(url), url, kind));
  }
  return { pages, posts: pages.flatMap((p) => p.posts) };
}
