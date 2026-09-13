import { parse, type HTMLElement } from "node-html-parser";
import type { LocalMember } from "@seiji-kiroku/shared";
import { cleanText, isoDate, SAGA_ASSEMBLY, SAGA_ROSTER_URL } from "./site.ts";

/**
 * 佐賀県議会の議員一覧（Issue #768）。**1 ページに 37 人**（実測 2026-09-13、45,179 B）。
 *
 * ## 構造（実測）
 * ```html
 * <div class="danraku" id="danraku1">
 *   <h3 class="title"><strong>（任期）令和5年4月30日～令和9年4月29日　（　）は所属会派名　…　令和7年4月1日現在</strong></h3>
 *   <h2 class="title">佐賀市　定数11人</h2>
 *   <table class="__wys_table">…
 *     <tr><td><img alt="留守茂幸議員"></td>…</tr>          ← 写真の行
 *     <tr><td><p>るす しげゆき</p>
 *             <p><big>留守 茂幸<br></big>(自由民主党)<br> (9期)</p></td>…</tr>  ← 氏名の行
 * ```
 *
 * ## **氏名は `<big>` から採る。`<img alt>` からは採らない**（#765 との違い）
 * **#765 は `alt="猪村利恵子議員"` を読んだ**。それでも氏名は取れるが、
 * **`alt` にはふりがな・会派・選挙区・期数が無い。** `<big>` の側には姓名のあいだに空白があり、
 * **同じ `<td>` の中にふりがな・会派・期数が揃っている**ので、こちらを名簿の実体とする。
 * **`<img alt>` は独立した 2 つ目の綴りとして突き合わせに使う**（下記の検算）。
 *
 * ## **空の `<big>` が 6 つある**（実測）
 * **`<big><big><big></big></big></big>` という入れ子の空タグが 6 か所にある**（編集の残骸）。
 * **`<big>` を数えると 43 になるが、中身のあるものは 37 である。**
 * **空を捨てずに数えると「議員 43 人」になる**——**定数（37）とも合わないので気づけるが、
 * 中身で判定するほうが確実。**
 *
 * ## **会派名が 2 つの `<p>` にまたがる**（実測。8 人）
 * ```html
 * <p><big>一ノ瀬 裕子<br></big>(自由民主党</p><p>ネクストさが)</p><p>(2期)</p>
 * ```
 * **`(自由民主党` で閉じ括弧が来ない。**`<td>` のテキスト全体を繋いでから括弧の対応を見る。
 * **`(自由民主党` だけを会派名にすると 8 人が別の会派に分かれる**（`自由民主党ネクストさが` は
 * `自由民主党` とは別の会派である）。
 *
 * ## **選挙区の見出しは `佐賀市　定数11人`**（**定数であって人数ではない**）
 * **定数の合計は 38 だが、載っている議員は 37 人**（実測: 佐賀市 11 / 唐津市・玄海町 6 / 鳥栖市 3 /
 * 多久市 1 / 伊万里市 2 / 武雄市 2 / 鹿島市・太良町 2 / 小城市 2 / 嬉野市 1 / 神埼市・吉野ヶ里町 2 /
 * 三養基郡 2 / 西松浦郡 1 / 杵島郡 2 = 37。**合計は 37 で合う**）。
 * **それでも「定数 = 議員数」とは書かない**（大分 #617・秋田 #759 が踏んだ罠）。
 * **選挙区ごとに「定数と読めた人数」を比べ、合わなければ例外**——読み落としで黙って人が減らない。
 *
 * ## **`id` は写真のファイル名の番号から作る**（氏名からは作らない）
 * **佐賀の議員一覧に議員ごとのページへのリンクは 1 本も無い**（実測: `<a>` は 0 本）ので、
 * **青森 #529 / 秋田 #759 のようにプロフィール URL を鍵にできない。**
 * **代わりに写真の添付ファイル番号を使う**——**`3_66725_280907_up_m6js0i6b.png` の `280907`。**
 * **37 人すべてが写真を持ち、番号は 37 通りすべて違う**（実測 2026-09-13）。
 * **氏名からは作らない**——**`LOCAL_MEMBER_ID` が ASCII しか許さない**（`^p_\d\d_[A-Za-z0-9_-]+$`）
 * のに加えて、**この議会は氏名が一次資料どうしで食い違う**（`猪村利恵子`/`猪村理恵子`）。
 * **氏名を id にすると、綴りが変わった日に別人の id ができる。**
 * **同じ番号が 2 人出たら例外**（黙って 1 人に畳まない）。
 * **`profileUrl` は名簿ページ自身**（高知 #220 と同じ。議員ごとのページが無い議会の書き方）。
 *
 * ## as-of
 * **`<h3>` の中に `令和7年4月1日現在` がある**ので、**取得日ではなくその日付を使う。**
 * **`最終更新日：2025年4月1日`（`<time datetime>`）とも一致する**（独立した 2 つ目の日付。実測）。
 * **食い違ったら例外**——どちらが正しいかを決めない（#569）。
 */
export interface Roster {
  members: LocalMember[];
  /** 名簿の基準日（`令和7年4月1日現在`） */
  asOf: string;
  /** 任期の原文（`（任期）令和5年4月30日～令和9年4月29日`。meta に残す） */
  termText: string;
}

/** 名簿の基準日「令和7年4月1日現在」（和暦。**全角数字もありうる**） */
const AS_OF = /(令和|平成)([元０-９0-9]+)年([０-９0-9]{1,2})月([０-９0-9]{1,2})日現在/;
/** `<time datetime="2025-04-01T17:00:00+09:00">` の日付（独立した 2 つ目の綴り） */
const UPDATED = /<time datetime="(\d{4}-\d{2}-\d{2})/;
/** 選挙区の見出し「佐賀市　定数11人」 */
const DISTRICT = /^(.+?)\s*定数([０-９0-9]+)人$/;
/** 会派と期数「(自由民主党ネクストさが)(2期)」 */
const GROUP_TERM = /[（(]([^（()）]+)[）)]\s*[（(]([０-９0-9]+)期[）)]/;
/** ふりがな（ひらがなと空白だけの行） */
const KANA = /^[ぁ-ゖー\s　]+$/;
/** 写真の添付ファイル名（`3_66725_280907_up_m6js0i6b.png`）。**`280907` が議員ごとに違う** */
const PHOTO_ID = /^3_\d+_(\d+)_up_[a-z0-9]+\.(png|jpg|jpeg|gif)$/i;

const nfkc = (s: string): number => Number(s.normalize("NFKC"));

/** 名簿の記事本文（`<div class="danraku" id="danraku1">`）。ヘッダ・サイドバー・フッタを読まない。 */
function rosterBody(html: string): HTMLElement {
  const body = parse(html).querySelector("div#danraku1");
  if (!body) throw new Error(`${SAGA_ROSTER_URL}: 記事本文（#danraku1）が見つからない`);
  return body;
}

/** 名簿の基準日（ISO）。`<h3>` の `令和7年4月1日現在` と `<time datetime>` の両方を見て、食い違えば例外。 */
export function parseAsOf(html: string): { asOf: string; termText: string } {
  const body = rosterBody(html);
  const text = cleanText(body.text);
  const m = AS_OF.exec(text);
  if (!m) throw new Error(`${SAGA_ROSTER_URL}: 名簿の基準日（「令和N年M月D日現在」）が読めない`);
  const era = m[1];
  const y = m[2] === "元" ? 1 : nfkc(m[2]);
  const year = era === "令和" ? 2018 + y : 1988 + y;
  const asOf = isoDate(year, nfkc(m[3]), nfkc(m[4]));
  // **`<time datetime>` は独立した 2 つ目の日付**。合わなければ例外（どちらが正しいかを決めない）
  const u = UPDATED.exec(html);
  if (!u) throw new Error(`${SAGA_ROSTER_URL}: 最終更新日（<time datetime>）が読めない`);
  if (u[1] !== asOf) throw new Error(`${SAGA_ROSTER_URL}: 基準日 ${asOf} と最終更新日 ${u[1]} が食い違う`);
  const term = /（任期）[^　\s]+/.exec(text);
  return { asOf, termText: term ? term[0] : "" };
}

/** 議員 1 人ぶんの `<td>`（ふりがな・氏名・会派・期数）。氏名が無い `<td>`（写真だけ）は undefined。 */
export function parseCell(td: HTMLElement): { name: string; kana: string; group: string; terms: number } | undefined {
  // **中身のある `<big>` だけ**（空の入れ子 `<big><big><big></big></big></big>` が 6 か所ある）
  const name = td.querySelectorAll("big").map((b) => cleanText(b.text)).find((t) => t !== "");
  if (name === undefined) return undefined;
  // **`<td>` のテキスト全体から会派と期数を採る**（会派名が 2 つの `<p>` にまたがる。docblock）
  const whole = cleanText(td.text);
  const gt = GROUP_TERM.exec(whole.replace(/[\s　]+/g, ""));
  if (!gt) throw new Error(`${SAGA_ROSTER_URL}: ${name} の会派と期数が読めない（${JSON.stringify(whole)}）`);
  // **ふりがな: `<td>` の中の「ひらがなと空白だけ」の要素**。
  // **`<p>` だけを見てはいけない**——**`下田 寛` 1 人だけ `<div>` に入っている**（実測 2026-09-13）。
  // **`<p>` に限ると 37 人中 1 人の `kana` が空になり、#632 の検算（かな長 / 氏名長）が
  // その 1 人について効かなくなる**（空は「比較できない」なので検算が素通りする）。
  const kana = td.querySelectorAll("*").map((n) => cleanText(n.text)).find((t) => t !== "" && KANA.test(t)) ?? "";
  return { name, kana, group: gt[1], terms: nfkc(gt[2]) };
}

export function parseRoster(html: string): Roster {
  const { asOf, termText } = parseAsOf(html);
  const body = rosterBody(html);
  // **写真の `alt` → 添付ファイル番号**（`id` の素。docblock）。**写真の行と氏名の行は別の `<tr>`** なので、
  // **`<td>` の中では突き合わせられない**——**ページ全体の `<img>` から先に表を作る**
  const photoIdOf = new Map<string, string>();
  for (const img of body.querySelectorAll("img")) {
    const alt = cleanText(img.getAttribute("alt") ?? "").replace(/議員$/, "").replace(/[\s　]/g, "");
    const m = PHOTO_ID.exec((img.getAttribute("src") ?? "").split("/").pop() ?? "");
    if (alt === "" || !m) continue;
    const prev = photoIdOf.get(alt);
    if (prev !== undefined && prev !== m[1]) throw new Error(`${SAGA_ROSTER_URL}: ${alt} の写真が 2 枚ある（${prev} / ${m[1]}）`);
    photoIdOf.set(alt, m[1]);
  }
  // **選挙区の見出し（`<h2 class="title">`）で区切る**。見出しの前には議員が居ない
  const nodes = body.querySelectorAll("h2.title, td");
  const members: LocalMember[] = [];
  const ids = new Set<string>();
  /** 選挙区ごとに「見出しが宣言した定数」と「読めた人数」（読み落としの検算） */
  const declared = new Map<string, number>();
  const counted = new Map<string, number>();
  let district = "";
  for (const node of nodes) {
    if (node.tagName === "H2") {
      const m = DISTRICT.exec(cleanText(node.text).replace(/[\s　]+/g, ""));
      if (!m) throw new Error(`${SAGA_ROSTER_URL}: 選挙区の見出しが読めない（${JSON.stringify(cleanText(node.text))}）`);
      district = m[1];
      if (declared.has(district)) throw new Error(`${SAGA_ROSTER_URL}: 選挙区 ${district} の見出しが 2 回出た`);
      declared.set(district, nfkc(m[2]));
      counted.set(district, 0);
      continue;
    }
    const cell = parseCell(node);
    if (!cell) continue;
    if (district === "") throw new Error(`${SAGA_ROSTER_URL}: 選挙区の見出しより前に議員 ${cell.name} が居る`);
    // **`id` は写真の添付ファイル番号から作る**（氏名からは作らない。docblock）
    const key = cell.name.replace(/[\s　]/g, "");
    const photoId = photoIdOf.get(key);
    // **写真が無ければ例外**——**氏名から id を作って代用しない**（綴りが変わった日に別人の id ができる）
    if (photoId === undefined) throw new Error(`${SAGA_ROSTER_URL}: ${cell.name} の写真が見つからない（id を作れない）`);
    const id = `p_${SAGA_ASSEMBLY.prefCode}_${photoId}`;
    if (ids.has(id)) throw new Error(`${SAGA_ROSTER_URL}: 同じ写真番号の議員が 2 人居る（${id} / ${cell.name}）`);
    ids.add(id);
    counted.set(district, (counted.get(district) ?? 0) + 1);
    members.push({
      id,
      assemblyId: SAGA_ASSEMBLY.id,
      name: cell.name,
      kana: cell.kana,
      group: cell.group,
      district,
      // **議員ごとのページが無い**ので名簿ページ自身を指す（高知 #220 と同じ。docblock）
      profileUrl: SAGA_ROSTER_URL,
      current: true,
      asOf,
      sourceUrl: SAGA_ROSTER_URL,
      counts: { rollcalls: 0 },
    });
  }
  if (members.length === 0) throw new Error(`${SAGA_ROSTER_URL}: 議員が 1 人も読めない`);
  // **選挙区の定数と読めた人数を突き合わせる**（読み落としで黙って人が減らない）。
  // **「定数 = 人数」と決め打ちしているのではない**——**合わなければ例外にして人が見る**
  // （欠員が出たらここで落ちる。そのときは欠員として書き直すこと。#617 / #759 の罠）
  for (const [d, n] of declared) {
    const got = counted.get(d) ?? 0;
    if (got !== n) throw new Error(`${SAGA_ROSTER_URL}: 選挙区 ${d} は定数 ${n} 人だが ${got} 人しか読めない（欠員なら実装を直すこと）`);
  }
  // **`<img alt>` は独立した 2 つ目の綴り**（#765 が読んだ側）。
  // **氏名が alt に無ければ上の `photoIdOf.get` が undefined になって既に落ちている**ので、
  // ここで見るのは**逆向き**——**alt にしか居ない議員が残っていないか**（氏名の側の読み落とし）
  if (photoIdOf.size !== members.length) throw new Error(`${SAGA_ROSTER_URL}: 氏名 ${members.length} 人 / 写真の alt ${photoIdOf.size} 人 で数が合わない`);
  return { members, asOf, termText };
}
