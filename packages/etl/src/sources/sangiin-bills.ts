import { parse, type HTMLElement } from "node-html-parser";
import type { RollCall } from "@seiji-kiroku/shared";
import { fetchText } from "../fetch.ts";

const BASE = "https://www.sangiin.go.jp/japanese/joho1/kousei/gian";

/** 議案情報 一覧ページの URL（meta.sources 用）。 */
export const billListUrl = (session: number) => `${BASE}/${session}/gian.htm`;

/** 一覧ページの1行。 */
export interface BillListItem {
  /** 議案詳細ページ（絶対URL）。 */
  href: string;
  title: string;
  /** 表の summary 属性から「○○一覧」を除いたもの（例「法律案（内閣提出）」「人事案件」）。 */
  category: string;
}

/** 議案詳細ページの内容のうち、採決に紐づけるのに必要な部分。 */
export interface Bill {
  title: string;
  category: string;
  sourceUrl: string;
  /** 「参議院本会議経過」ブロックごとの議決（原文）と、採決方法欄がリンクする投票結果ページの id。未議決（空欄）は含めない。 */
  plenary: { decision: string; rollCallId?: string }[];
}

/** 議案1件の参議院本会議での議決1つ（突合の入力）。 */
export interface BillDecision {
  title: string;
  /** 議決の原文（可決・否決・修正議決・同意・是認 など）。言い換えない。 */
  decision: string;
  /** 議案ページが投票結果ページにリンクしていればその id（例 221-0331-v009）。 */
  rollCallId?: string;
  /** 議案詳細ページ。 */
  sourceUrl: string;
}

/** 審議結果と突合できなかった採決（`data/unmatched-bills.json`）。人事・決議など議案情報に載らないものは正常にここへ来る。 */
export interface UnmatchedBill {
  rollCallId: string;
  title: string;
  sourceUrl: string;
}

export class BillParseError extends Error {
  constructor(message: string, readonly sourceUrl: string) {
    super(`${message} (${sourceUrl})`);
    this.name = "BillParseError";
  }
}

/**
 * 一覧ページ gian.htm（UTF-8）。構造（2026-08-22 確認）:
 *   table.list_c[summary="法律案（内閣提出）一覧"] > tr > td×5（提出回次 / 提出番号 / 件名(a[href=./meisai/mNNN.htm]) / 議案要旨 / 提出法律案）
 * カテゴリごとに同形の table が並ぶ。人事案件等は末尾2列が空。
 */
export function parseBillList(html: string, sourceUrl: string): BillListItem[] {
  const out: BillListItem[] = [];
  for (const table of parse(html).querySelectorAll("table.list_c")) {
    const category = (table.getAttribute("summary") ?? "").replace(/一覧$/, "").trim();
    for (const a of table.querySelectorAll("td a[href]")) {
      const href = a.getAttribute("href") ?? "";
      if (!/meisai\/m\d+\.htm$/i.test(href)) continue;
      out.push({ href: new URL(href, sourceUrl).href, title: squash(a.text), category });
    }
  }
  if (out.length === 0) throw new BillParseError("議案の一覧（table.list_c 内の meisai/ へのリンク）が0件です", sourceUrl);
  return out;
}

/**
 * 議案詳細ページ meisai/mNNN.htm。構造（2026-08-22 確認）:
 *   table[summary="議案審議情報一覧"]      th 件名 / 種別
 *   table[summary="参議院本会議経過情報"]  th 議決 → td（可決・否決・同意・是認…／未議決は &nbsp;）
 *                                          th 採決方法 → td 押しボタン<a href="/japanese/joho1/kousei/vote/221/221-0331-v009.htm">
 * 衆議院側のブロック（"衆議院本会議経過情報"）は使わない（参院の採決に紐づけるのは参院の議決だけ）。
 */
export function parseBill(html: string, sourceUrl: string): Bill {
  const root = parse(html);
  const title = squash(cellAfter(root, "件名") ?? "");
  if (!title) throw new BillParseError("件名が取得できません", sourceUrl);
  const category = squash(cellAfter(root, "種別") ?? "");
  const plenary: Bill["plenary"] = [];
  for (const table of root.querySelectorAll('table[summary="参議院本会議経過情報"]')) {
    const decision = squash(cellAfter(table, "議決") ?? "");
    if (!decision) continue;
    const href = rowOf(table, "採決方法")?.querySelector("a[href]")?.getAttribute("href") ?? "";
    const m = href.match(/\/(\d+-\d{4}-v\d+)\.htm$/i);
    plenary.push(m ? { decision, rollCallId: m[1] } : { decision });
  }
  return { title, category, sourceUrl, plenary };
}

/**
 * 一覧→各詳細ページを順に取得し、参議院本会議で議決済みのものを BillDecision[] にする。
 * 議案ページは審議が進むと内容が変わる（未議決→可決）ので、投票結果ページと違いディスクキャッシュを使わない。
 */
export async function fetchBillDecisions(session: number): Promise<BillDecision[]> {
  const listUrl = billListUrl(session);
  const items = parseBillList(await fetchText(listUrl, "utf-8", { noCache: true }), listUrl);
  const out: BillDecision[] = [];
  for (const item of items) {
    const bill = parseBill(await fetchText(item.href, "utf-8", { noCache: true }), item.href);
    for (const p of bill.plenary) out.push({ title: bill.title, ...p, sourceUrl: item.href });
  }
  return out;
}

/**
 * 投票結果ページの案件名から、議案名の比較に不要な装飾を除く。
 *   「日程第９　」（先頭の議事日程番号）
 *   「（内閣提出、衆議院送付）」「（衆議院提出）」「（○○君外３名発議）」（末尾の提出者・送付の注記）
 * 件名の一部である括弧（「（第１号）」「第五十条（ａ）」）は末尾であっても提出・送付・発議の語を含まないので残る。
 */
export function normalizeTitle(title: string): string {
  return squash(title)
    .replace(/^日程第[0-9０-９]+\s*/, "")
    .replace(/（[^（）]*(提出|送付|発議)[^（）]*）$/, "")
    .trim();
}

/**
 * 採決 ↔ 議決の突合。
 *   1. 議案ページが投票結果ページの id を指していればそれ（案件名の表記に依らない、最も確かな紐づけ）
 *   2. 無ければ正規化した案件名の完全一致。同名の議決が複数あり結果が割れるなら紐づけない（推測しない）
 * 紐づかなかった採決は unmatched に列挙する（人事・決議など議案情報に無いものは正常）。
 */
export function matchBillResults(
  rollCalls: readonly RollCall[],
  decisions: readonly BillDecision[],
): { results: Map<string, { decision: string; sourceUrl: string }>; unmatched: UnmatchedBill[] } {
  const byId = new Map<string, BillDecision[]>();
  const byTitle = new Map<string, BillDecision[]>();
  for (const d of decisions) {
    if (d.rollCallId) push(byId, d.rollCallId, d);
    push(byTitle, normalizeTitle(d.title), d);
  }
  const results = new Map<string, { decision: string; sourceUrl: string }>();
  const unmatched: UnmatchedBill[] = [];
  for (const rc of rollCalls) {
    const found = unanimous(byId.get(rc.id)) ?? unanimous(byTitle.get(normalizeTitle(rc.title)));
    if (found) results.set(rc.id, { decision: found.decision, sourceUrl: found.sourceUrl });
    else unmatched.push({ rollCallId: rc.id, title: rc.title, sourceUrl: rc.sourceUrl });
  }
  return { results, unmatched };
}

/** 候補が1件、または全候補の議決が同じならそれ。割れていれば undefined（どれかを選ぶ＝推測になる）。 */
function unanimous(cands: BillDecision[] | undefined): BillDecision | undefined {
  if (!cands?.length) return undefined;
  return cands.every((c) => c.decision === cands[0].decision) ? cands[0] : undefined;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function rowOf(scope: HTMLElement, header: string): HTMLElement | undefined {
  return scope.querySelectorAll("tr").find((tr) => squash(tr.querySelector("th")?.text ?? "") === header);
}

function cellAfter(scope: HTMLElement, header: string): string | undefined {
  return rowOf(scope, header)?.querySelector("td")?.text;
}

/** NBSP（空欄の &nbsp;）・全角空白を含む空白の連続を1つにして trim。 */
function squash(s: string): string {
  return s.replace(/[\s\u00a0　]+/g, " ").trim();
}
