import { parse, type HTMLElement } from "node-html-parser";
import type {
  Bill, BillKind, BillReferralEntry, BillReferredCommittee, BillSummary, House, ShugiinGroupStance,
} from "@seiji-kiroku/shared";
import { fetchText } from "../fetch.ts";
import { isKnownReferralCommittee } from "./bill-referral-committees.ts";
import { warekiToIso } from "./sangiin-members.ts";

/**
 * 衆議院 議案情報（Issue #72）。
 *   一覧: https://www.shugiin.go.jp/internet/itdb_gian.nsf/html/gian/kaiji{回次}.htm（Shift_JIS）
 *   経過: .../gian/keika/{id}.htm（Shift_JIS）
 * 一覧は「審議回次」のページで、前回次から継続している議案（提出回次が小さい）も載る。
 * 経過ページには「議案提出者一覧」「議案提出の賛成者」（個人名＝事実）と「衆議院審議時会派態度／賛成会派／反対会派」（会派単位＝推定の材料）がある。
 * 衆議院は個人別の投票を公開していないので、会派態度を個人の賛否に読み替えるのは推定。ここではページの原文を写すだけで、読み替えはしない。
 */
const BASE = "https://www.shugiin.go.jp/internet/itdb_gian.nsf/html/gian";

/** 議案の一覧ページの URL（meta.sources 用）。 */
export const shugiinBillListUrl = (session: number) => `${BASE}/kaiji${session}.htm`;

/** 一覧ページの1行。 */
export interface ShugiinBillListItem {
  /** 経過ページ（絶対URL）。 */
  href: string;
  /** 種類の原文。表の見出し「○○の一覧」の ○○（衆法・参法・閣法・予算・条約・承認・承諾・決議）。「決算その他」の表は行の種類列（決算・国有財産・ＮＨＫ決算）。 */
  kindText: string;
  /** 提出回次。 */
  session: number;
  number?: number;
  title: string;
  /** 「審議状況」の原文（例「成立」「衆議院で閉会中審査」「本院議了」）。 */
  status: string;
}

export class ShugiinBillParseError extends Error {
  constructor(message: string, readonly sourceUrl: string) {
    super(`${message} (${sourceUrl})`);
    this.name = "ShugiinBillParseError";
  }
}

/**
 * 一覧ページ kaiji{回次}.htm。構造（2026-08-23 確認）:
 *   table.table > caption「衆法の一覧」 > tr > td（提出回次 / 番号 / 議案件名 / 審議状況 / 経過(a[href=./keika/XXXX.htm]) / 本文）
 *   承諾・決算その他の表は番号列が無い（td×4）。
 */
export function parseShugiinBillList(html: string, sourceUrl: string): ShugiinBillListItem[] {
  const out: ShugiinBillListItem[] = [];
  // ページ全体を一度に parse すると node-html-parser が末尾の <table>（決議の一覧）を落とす（caption が HTML 直下になる）ので、
  // <table ごとに切って個別に parse する。
  for (const segment of html.split(/(?=<table\b)/i)) {
    const table = parse(segment).querySelector("table");
    if (!table) continue;
    const caption = squash(table.querySelector("caption")?.text ?? "");
    if (!caption) continue;
    const headers = table.querySelectorAll("th").map((th) => squash(th.text));
    const col = (name: string) => headers.indexOf(name);
    if (col("議案件名") < 0 || col("経過情報") < 0) continue;
    for (const tr of table.querySelectorAll("tr")) {
      const cells = tr.querySelectorAll("td");
      if (cells.length <= col("経過情報")) continue;
      // 「決算その他」の表は行ごとに種類列がある。それ以外は見出し「○○の一覧」の ○○。
      const kindText = col("種類") >= 0 ? squash(cells[col("種類")]?.text ?? "") : caption.replace(/の一覧$/, "");
      const a = cells[col("経過情報")]?.querySelector("a[href]");
      const href = a?.getAttribute("href") ?? "";
      if (!/keika\/[0-9A-Za-z]+\.htm$/.test(href)) continue;
      const numberCol = col("番号");
      const number = numberCol >= 0 ? toInt(squash(cells[numberCol]?.text ?? "")) : undefined;
      const session = toInt(squash(cells[col("提出回次")]?.text ?? ""));
      if (session === undefined) throw new ShugiinBillParseError(`提出回次が読めません: ${squash(tr.text)}`, sourceUrl);
      out.push({
        href: new URL(href, sourceUrl).href, kindText, session, ...(number !== undefined ? { number } : {}),
        title: squash(cells[col("議案件名")]?.text ?? ""), status: squash(cells[col("審議状況")]?.text ?? ""),
      });
    }
  }
  if (out.length === 0) throw new ShugiinBillParseError("議案の一覧（経過ページへのリンク）が0件です", sourceUrl);
  return out;
}

/** 議案種類の原文 → shared の BillKind。対応の無いもの（決算・国有財産・ＮＨＫ決算・承諾 …）は その他（原文は kindText に残す）。 */
const KINDS: ReadonlySet<string> = new Set<BillKind>(["閣法", "衆法", "参法", "予算", "条約", "承認", "決議"]);
export function toBillKind(kindText: string): BillKind {
  return KINDS.has(kindText) ? (kindText as BillKind) : "その他";
}

/**
 * 経過ページ keika/{id}.htm。構造（2026-08-23 確認）:
 *   table[1]（審議経過情報）: tr > td[headers=KOMOKU]（項目名） + td[headers=NAIYO]（内容）
 *     議案種類 / 議案提出回次 / 議案番号 / 議案件名 / 議案提出者 / 議案提出会派（議員提出のみ）
 *     衆議院議案受理年月日 / 衆議院審議終了年月日／衆議院審議結果（「日付 ／ 結果」） / 衆議院審議時会派態度 / 賛成会派 / 反対会派
 *     参議院議案受理年月日 / 参議院審議終了年月日／参議院審議結果 / 公布年月日／法律番号
 *   table[2]（議員提出のみ）: 議案提出者一覧 / 議案提出の賛成者（「氏名君; 氏名君; …」）
 * 空欄は <br> だけ、または「／」だけ。
 */
export function parseShugiinBill(html: string, sourceUrl: string, list?: { status?: string }): Bill {
  // 空欄のセルは <span class="txt03">\n／\n</TD> と span が閉じておらず、そのままだと parser が内容セルを落として次の行の項目名を内容として拾う。
  const root = parse(html.replace(/(<span[^>]*>[^<]*)<\/TD>/gi, "$1</span></TD>"));
  const cell = (label: string) => squash(valueCell(root, label) ?? "");
  const title = cell("議案件名");
  if (!title) throw new ShugiinBillParseError("議案件名が取得できません", sourceUrl);
  const kindText = cell("議案種類");
  const session = toInt(cell("議案提出回次"));
  if (session === undefined) throw new ShugiinBillParseError("議案提出回次が取得できません", sourceUrl);
  const number = toInt(cell("議案番号"));
  const keikaId = sourceUrl.match(/keika\/([0-9A-Za-z]+)\.htm$/)?.[1];
  if (number === undefined && !keikaId) throw new ShugiinBillParseError("議案番号も経過ページ id も無いので id が作れません", sourceUrl);
  const kind = toBillKind(kindText);

  const submitterText = cell("議案提出者");
  const submitterGroups = parseGroupList(cell("議案提出会派"));
  const submitterNames = valueCell(root, "議案提出者一覧");
  const supporterNames = valueCell(root, "議案提出の賛成者");
  const shugiin = splitDateResult(cell("衆議院審議終了年月日／衆議院審議結果"));
  const sangiin = splitDateResult(cell("参議院審議終了年月日／参議院審議結果"));
  const promulgation = splitDateResult(cell("公布年月日／法律番号"));
  const received = compact({ shugiin: warekiToIso(cell("衆議院議案受理年月日")), sangiin: warekiToIso(cell("参議院議案受理年月日")) });
  const result = compact({ shugiin: shugiin.text, sangiin: sangiin.text, promulgated: promulgation.date, lawNumber: promulgation.text });
  const stance = groupStance(cell("衆議院審議時会派態度"), cell("衆議院審議時賛成会派"), cell("衆議院審議時反対会派"));
  const referral = compactObject({
    shugiinPreliminary: referralEntry("shugiin", cell("衆議院予備付託年月日／衆議院予備付託委員会")),
    shugiin: referralEntry("shugiin", cell("衆議院付託年月日／衆議院付託委員会")),
    sangiinPreliminary: referralEntry("sangiin", cell("参議院予備付託年月日／参議院予備付託委員会")),
    sangiin: referralEntry("sangiin", cell("参議院付託年月日／参議院付託委員会")),
  });

  return {
    id: `${session}-${kindText}-${number ?? keikaId}`,
    session,
    kind,
    ...(kind !== kindText ? { kindText } : {}),
    ...(number !== undefined ? { number } : {}),
    title,
    house: "shugiin",
    ...(submitterText ? { submitterText } : {}),
    ...(submitterNames !== undefined ? { submitterNames: parseNameList(submitterNames) } : {}),
    ...(supporterNames !== undefined ? { supporterNames: parseNameList(supporterNames) } : {}),
    ...(submitterGroups.length ? { submitterGroups } : {}),
    ...(received ? { received } : {}),
    ...(list?.status ? { status: list.status } : {}),
    ...(result ? { result } : {}),
    ...(stance ? { shugiinGroupStance: stance } : {}),
    ...(referral ? { referral } : {}),
    sourceUrl,
  };
}

/**
 * 付託先の位置に書かれるが、**委員会でないと分かっている**文言（#1133）。
 *
 * **これは「委員会かどうか」の判定ではない**——判定は許可リスト
 * （`bill-referral-committees.ts`）が行い、**知らない値はすべて止まる。**
 * **ここが決めるのは、止めた値を `noteText` と `unknownText` のどちらに置くかだけ**である:
 *   `noteText`    委員会でないと**数えて分かっている**値（下の 2 語）
 *   `unknownText` **まだ数えていない**値（新しい表現かもしれないし、切り出しの誤りかもしれない）
 *
 * **この 2 つを分ける理由**: 「付託を省略した」は**一次資料が書いている事実**で、
 * 「知らない値が出た」は**私たちの表が追いついていない状態**である。混ぜると、
 * **表を直すべき箇所が「省略」に埋もれて見えなくなる。**
 *
 * 2026-09-30 の全数調査（`docs/research/bill-referral.md`）で数えた値:
 *   審査省略      衆 149 件 / 参 6 件
 *   審査省略要求   衆 2 件（204-決議-2 と 201-決議-3。どちらも解任・不信任決議案）
 *
 * **「審査省略」で前方一致させない。** それでは「審査省略要求」と区別できず、
 * **要求しただけなのか省略されたのか**という別の事実を 1 つに潰してしまう。原文で照合する。
 */
const NON_COMMITTEE_REFERRAL_TEXTS: ReadonlySet<string> = new Set(["審査省略", "審査省略要求"]);

/**
 * 「令和 8年 3月 5日 ／ 財務金融」→ { date: "2026-03-05", committee: "財務金融" }。
 * 「／ 審査省略」→ { noteText: "審査省略" }（**委員会として扱わない**）。
 * 「／」だけ（空欄）→ undefined（**空文字や「不明」を作らない**）。
 *
 * 付託先の文字列は **原文のまま**。「委員会」を足さない・言い換えない・院どうしで揃えない。
 *
 * ## 知らない値は `committee` にしない（#1133。利用者の判断 2026-09-30）
 *
 * **`committee` に入るのは、その回次・その院で実際に記録されていたと数えた名前だけ**
 * （`bill-referral-committees.ts` の許可リスト）。
 * **それ以外は `unknownText` に原文のまま入れる**——**黙って捨てない**（記録が在ったことは事実なので）
 * **が、委員会名としては出さない**（`toBillSummary` が拾わず、`validateDataset` が違反にする）。
 *
 * **なぜ denylist をやめたか**: 以前は「委員会でない値」を列挙して除外していたが、
 * **列挙に無い値は委員会名として素通りする。実際に `審査省略要求` が素通りしていた。**
 */
function referralEntry(house: House, text: string): BillReferralEntry | undefined {
  const { date, text: right } = splitDateResult(text);
  if (right === undefined) return date === undefined ? undefined : { date };
  // 許可リストは**付託日**で引く（議案の `session` は提出回次で、付託された時期とは限らない）。
  // **日付が読めない欄は照合できないので通さない**（実測では委員会名のある欄は必ず日付を持つ）。
  if (date !== undefined && isKnownReferralCommittee(date, house, right)) return compactObject({ date, committee: right });
  // 数えた名前でない = 委員会名として出せない。原文は unknownText に残す（捨てない）。
  // `審査省略` / `審査省略要求` は「委員会でないと分かっている値」なので noteText に分ける。
  const key = NON_COMMITTEE_REFERRAL_TEXTS.has(right) ? "noteText" : "unknownText";
  return compactObject({ date, [key]: right }) as BillReferralEntry;
}

/** 値が undefined のキーを落とす。全部 undefined なら undefined（欄ごと持たない）。 */
function compactObject<T extends object>(obj: T): T | undefined {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  return entries.length ? (Object.fromEntries(entries) as T) : undefined;
}

/** 「衆議院審議時会派態度」が空欄なら undefined（未審議・閉会中審査）。unanimous はページが「全会一致」と書いたときだけ。 */
function groupStance(stanceText: string, yesText: string, noText: string): ShugiinGroupStance | undefined {
  const yes = parseGroupList(yesText);
  const no = parseGroupList(noText);
  if (!stanceText && !yes.length && !no.length) return undefined;
  return { stanceText, yes, no, ...(stanceText === "全会一致" ? { unanimous: true } : {}) };
}

/** 会派名の一覧「A; B; C」→ ["A","B","C"]。区切りは半角/全角セミコロン・改行。前後の空白（全角含む）は落とす。会派名自体は変えない。 */
export function parseGroupList(text: string): string[] {
  return text
    .replace(/<br\s*\/?>/gi, "")
    .split(/[;；\n]/)
    .map((s) => s.replace(/^[\s 　]+|[\s 　]+$/g, ""))
    .filter(Boolean);
}

/** 氏名の一覧「落合貴之君; 中野洋昌君」→ ["落合貴之","中野洋昌"]。敬称「君」だけ落とし、表記はそのまま。 */
export function parseNameList(text: string): string[] {
  return parseGroupList(text).map((s) => s.replace(/君$/, "")).filter(Boolean);
}

/** `data/bills/index.json` の行。 */
export function toBillSummary(b: Bill): BillSummary {
  const referred = referredCommittees(b);
  return {
    id: b.id, session: b.session, kind: b.kind, house: b.house, title: b.title,
    ...(b.status ? { status: b.status } : {}),
    ...(referred.length ? { referredCommittees: referred } : {}),
    sourceUrl: b.sourceUrl,
  };
}

/**
 * 一覧に出す付託先（#1133）。**本付託だけ**を 衆 → 参 の順で。
 *
 * - **予備付託は入れない**（同じ委員会が 2 回並び、付託が 2 件あったように見える）。
 * - **`noteText`（審査省略）は入れない**——付託先ではないので、一覧の付託先に混ぜない。
 * - **記録が無ければ空配列**を返し、呼び出し側が欄ごと落とす（「分野なし」を値にしない）。
 */
function referredCommittees(b: Bill): BillReferredCommittee[] {
  const out: BillReferredCommittee[] = [];
  const push = (house: BillReferredCommittee["house"], e: BillReferralEntry | undefined) => {
    if (e?.committee) out.push({ house, committee: e.committee });
  };
  push("shugiin", b.referral?.shugiin);
  push("sangiin", b.referral?.sangiin);
  return out;
}

/**
 * **同じ議案の、審議回次ごとの経過ページを重ねる**（#1218）。
 *
 * ## なぜ要るか（実測で分かった原因）
 *
 * **衆院は「議案 1 件につき 1 ページ」ではなく「(提出回次, 番号, 審議回次) につき 1 ページ」を出す。**
 * 継続審議の議案は、審議回次ごとに **別 URL の経過ページ**が増える。
 * **`id` は `{提出回次}-{種類}-{番号}` なので、それら全部が同じ id に衝突する。**
 *
 * 実測（2026-10-07、一次資料を直接取得。`216-衆法-9`）:
 * ```
 *   kaiji216  keika/1DDDBA6  付託 2024-12-10 政治改革に関する特別  結果 閉会中審査  受理 2024-12-09
 *   kaiji217  keika/1DDDD82  付託 2025-01-24 政治改革に関する特別  結果 閉会中審査  受理 (空)
 *   kaiji218  keika/1DDF436  付託 2025-08-01 政治改革に関する特別  結果 閉会中審査  受理 (空)
 *   kaiji219  keika/1DE0196  付託 2025-10-24 政治改革に関する特別  結果 閉会中審査  受理 (空)
 *   kaiji220  keika/1DE0AEE  **付託 (空)**                         結果 (空)       受理 (空)
 * ```
 *
 * **各ページは「その審議回次に何が起きたか」の部分的な記録**であって、議案の全体像ではない。
 * **欄が空なのは「付託されていない」ではなく「その回次ではまだ付託されていない」である。**
 *
 * 衝突を `Map.set` の後勝ちで解いていたため、**審議の途中で欄がまだ空の最新回次のページが勝ち、
 * 前の回次が記録していた事実が丸ごと消えた。** 実測（`origin/main` → PR #1222 の `data/`。
 * `data/bills/` の **1,941 件を全数**）:
 * ```
 *   キーが消えた議案     18 件 / 1,941   （18/18 すべて sourceUrl が別ページに変わっている）
 *     result   が消えた  18 件
 *     received が消えた  16 件
 *     referral が消えた   4 件  ← bills/index.json の referredCommittees 1,660 → 1,656（#1218）
 * ```
 * **kaiji220 の一覧に載った 216-衆法 は 11 件で、そのうち付託欄が空だったのがちょうど 4 件。
 * 落ちた 4 件と完全に一致する**（`216-衆法-9 / 12 / 13 / 22`）。
 * 残りの 7 件は第220回の付託が記録されていたので件数が変わらず、**「特別委員会だから」でも
 * 「閉会中審査だから」でもない**——**最新ページの欄が空かどうか**だけで決まっていた。
 *
 * ## 規則
 *
 * **後のページが書いていない欄は、前のページが書いた値を消さない。**
 * **後のページが書いている欄は、後のページを採る**（「新しい状態を採る」は変えない。
 * 付託日が回次ごとに更新されるのは一次資料がそう書いているからで、潰してはいけない）。
 *
 * - **`undefined`（欄が無い）では上書きしない。**
 * - **空文字・空配列・空オブジェクトでも上書きしない**——ただし `supporterNames` は例外で、
 *   パーサが「欄が無い」= `undefined` と「欄はあるが空」= `[]` を分けている（`parseShugiinBill`）。
 *   **`[]` は「賛成者の欄が在って空」という事実の記録**なので、そちらは採る。
 * - **`id` が違うものは混ぜない**（取り違えを黙って通さない）。
 *
 * **欄ごとの浅いマージである**（`referral` の中を欄単位で混ぜない）。
 * **理由**: `referral` は 1 ページが 4 欄を一度に書く。欄単位で混ぜると
 * **第216回の衆院付託と第220回の参院付託を 1 件の `referral` に並べる**ことになり、
 * **一次資料のどのページにも無い組み合わせを作ってしまう。** ページ単位で採る。
 */
export function mergeShugiinBill(previous: Bill, next: Bill): Bill {
  if (previous.id !== next.id) throw new Error(`mergeShugiinBill: 違う議案を混ぜようとした（${previous.id} と ${next.id}）`);
  // **「後のページが書いた欄だけ」を集めてから重ねる。** `Bill` に index signature を足さずに
  // 欄ごとの判定を書くため、`Partial<Bill>` を組み立てて最後に 1 回展開する。
  const written: Partial<Bill> = {};
  for (const key of Object.keys(next) as (keyof Bill)[]) {
    const value = next[key];
    if (keepsPrevious(key, value)) continue;
    Object.assign(written, { [key]: value });
  }
  return { ...previous, ...written };
}

/**
 * **取り込みの 1 歩**: 取得したページ `page` を `bills` に重ねる（#1218 のレビュー指摘 1）。
 * **既にその id が在れば重ねた**ことを示す `true` を返す（cli がログで数を言うため）。
 *
 * ## なぜ cli のループではなく関数にするか
 *
 * **引数順は「`mergeShugiinBill` という語が在るか」では守れない。**
 * `mergeShugiinBill(previous, page)` を `mergeShugiinBill(page, previous)` に取り違えると
 * **「古いページが新しいページを上書きする」**——#1218 が直したバグがそのまま戻るのに、
 * **語は在るのでソースを見る検査は落ちない。**
 *
 * **実測（レビューが一次資料 79 件で測った）**: 引数を逆にすると
 * **21/79 件の付託日が古い値に化けるのに、`referredCommittees` の件数は 1 件しか動かない。**
 * **件数でも語でも鳴らない＝「黙って別の値が出る」**形で、
 * **「記録が出ない」より重い**（利用者が自分では気づけない）。
 *
 * **だから順序を 1 か所に閉じ込めて、振る舞いで固定する。**
 * **呼び出し側は `previous` を触らない**ので、取り違えようがない。
 */
export function addShugiinBillPage(bills: Map<string, Bill>, page: Bill): boolean {
  const previous = bills.get(page.id);
  // **`previous` が先・`page`（新しいページ）が後**。この順序がこの関数の全部である。
  bills.set(page.id, previous ? mergeShugiinBill(previous, page) : page);
  return previous !== undefined;
}

/** パーサが「欄が無い」と「欄はあるが空」を分けている欄（空配列も事実として採る）。 */
const EMPTY_IS_RECORDED: ReadonlySet<string> = new Set(["supporterNames"]);

/** 後のページのこの値では上書きしない（= 前のページの値を残す）か。 */
function keepsPrevious(key: keyof Bill, value: unknown): boolean {
  if (value === undefined) return true;
  if (EMPTY_IS_RECORDED.has(key)) return false;
  if (value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (value !== null && typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/**
 * 一覧→各経過ページを順に取得して Bill[] にする。経過ページは審議が進むと内容が変わるので、ディスクキャッシュを使わない。
 * どちらも Shift_JIS。
 */
export async function fetchShugiinBills(session: number): Promise<Bill[]> {
  const listUrl = shugiinBillListUrl(session);
  const items = parseShugiinBillList(await fetchText(listUrl, "shift_jis", { noCache: true, session }), listUrl);
  const out: Bill[] = [];
  for (const item of items) out.push(parseShugiinBill(await fetchText(item.href, "shift_jis", { noCache: true, session }), item.href, item));
  return out;
}

/** 「令和 8年 3月13日 ／ 可決」→ { date: "2026-03-13", text: "可決" }。空欄（「／」だけ）は両方 undefined。 */
function splitDateResult(s: string): { date?: string; text?: string } {
  const [left, ...rest] = s.split("／");
  const text = squash(rest.join("／"));
  return { date: warekiToIso(left ?? ""), ...(text ? { text } : {}) };
}

/** 項目名セル（td[headers=KOMOKU] または表2の左列）の右隣の内容セルのテキスト。無ければ undefined。 */
function valueCell(root: HTMLElement, label: string): string | undefined {
  for (const td of root.querySelectorAll("td")) {
    if (squash(td.text) !== label) continue;
    let next = td.nextElementSibling;
    while (next && next.tagName !== "TD") next = next.nextElementSibling;
    if (next) return next.text;
  }
  return undefined;
}

function compact<T extends Record<string, string | undefined>>(obj: T): { [K in keyof T]?: string } | undefined {
  const entries = Object.entries(obj).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== "");
  return entries.length ? (Object.fromEntries(entries) as { [K in keyof T]?: string }) : undefined;
}

function toInt(s: string): number | undefined {
  return /^\d+$/.test(s) ? Number(s) : undefined;
}

/** NBSP（空欄の &nbsp;）・全角空白を含む空白の連続を1つにして trim。 */
function squash(s: string): string {
  return s.replace(/[\s 　]+/g, " ").trim();
}
