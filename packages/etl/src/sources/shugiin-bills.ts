import { parse, type HTMLElement } from "node-html-parser";
import type { Bill, BillKind, BillSummary, ShugiinGroupStance } from "@seiji-kiroku/shared";
import { fetchText } from "../fetch.ts";
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
    sourceUrl,
  };
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
  return { id: b.id, session: b.session, kind: b.kind, house: b.house, title: b.title, ...(b.status ? { status: b.status } : {}), sourceUrl: b.sourceUrl };
}

/**
 * 一覧→各経過ページを順に取得して Bill[] にする。経過ページは審議が進むと内容が変わるので、ディスクキャッシュを使わない。
 * どちらも Shift_JIS。
 */
export async function fetchShugiinBills(session: number): Promise<Bill[]> {
  const listUrl = shugiinBillListUrl(session);
  const items = parseShugiinBillList(await fetchText(listUrl, "shift_jis", { noCache: true }), listUrl);
  const out: Bill[] = [];
  for (const item of items) out.push(parseShugiinBill(await fetchText(item.href, "shift_jis", { noCache: true }), item.href, item));
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
