import { parse, type HTMLElement } from "node-html-parser";
import type { BillKind, RollCall } from "@seiji-kiroku/shared";
import { fetchText } from "../fetch.ts";
import { warekiToIso } from "./sangiin-members.ts";

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

/** 議案詳細ページの内容のうち、採決への紐づけ（plenary）と提出者の名寄せ（proposers）に必要な部分。 */
export interface Bill {
  /** `{提出回次}-{種別}-{提出番号}`（例 "221-参法-16"）。shared の Bill.id と同じ形。 */
  id: string;
  session: number;
  kind: BillKind;
  number?: number;
  title: string;
  category: string;
  sourceUrl: string;
  /** 「提出日」（参法なら参議院への提出＝受理の日）。ISO。無ければ undefined。 */
  submittedOn?: string;
  /** 「発議者」欄の原文（例「打越さく良君 外9名」）。欄が無い（内閣提出など）なら undefined。 */
  proposerText?: string;
  /** 発議者欄に氏名として載っている人（筆頭のみ。「外N名」の氏名はページに無いので含めない）。委員会発議なら空。 */
  proposers: string[];
  /** 「提出者」欄の原文（委員会発議の参法。例「厚生労働委員長」）。個人の氏名ではないので名寄せしない。欄が無ければ undefined。 */
  submitterText?: string;
  /** 「提出者区分」欄の原文（「議員発議」「委員会発議」）。閣法など欄が無ければ undefined。 */
  submitterKind?: string;
  /** 審議状況: 最も日付の新しい経過ブロックの「段階名 ＋ 議決の原文」（例「参議院本会議 可決」「参議院 ○○委員会 未了」「公布（法律第13号）」）。経過が無ければ undefined。 */
  status?: string;
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
 *   table[summary="議案審議情報一覧"]      th 件名 / 種別 / 提出回次 / 提出番号 / 提出日 / 発議者（議員発議のみ）
 *   table[summary="参議院委員会等経過情報"] th 本付託日 / 付託委員会等 / 議決日 / 議決・継続結果
 *   table[summary="参議院本会議経過情報"]  th 議決日 / 議決 → td（可決・否決・同意・是認…／未議決は &nbsp;）
 *                                          th 採決方法 → td 押しボタン<a href="/japanese/joho1/kousei/vote/221/221-0331-v009.htm">
 *   table[summary="衆議院委員会等経過情報"] / table[summary="衆議院本会議経過情報"]  同形
 *   table[summary="その他の情報"]          th 公布年月日 / 法律番号
 * 発議者欄は「筆頭者君 外N名」の形で、外N名の氏名はこのページ（および提出法律案PDF）に載らない。載っている氏名だけを事実として取る。
 * 委員会発議の参法（提出者区分「委員会発議」）には発議者欄が無く、代わりに「提出者」欄に委員長名（例「厚生労働委員長」）が載る。
 * 委員長名は個人の氏名ではないので proposers には入れず、原文を submitterText に残す（Issue #64）。
 * plenary は参院の議決だけ（参院の採決に紐づけるため）。status は全ブロックから日付が最新のもの。
 */
export function parseBill(html: string, sourceUrl: string): Bill {
  const root = parse(html);
  const title = squash(cellAfter(root, "件名") ?? "");
  if (!title) throw new BillParseError("件名が取得できません", sourceUrl);
  const category = squash(cellAfter(root, "種別") ?? "");
  const session = Number((cellAfter(root, "提出回次") ?? "").replace(/\D/g, ""));
  if (!session) throw new BillParseError("提出回次が取得できません", sourceUrl);
  const numberText = squash(cellAfter(root, "提出番号") ?? "");
  const number = /^\d+$/.test(numberText) ? Number(numberText) : undefined;
  const kind = billKind(category);
  const submittedOn = warekiToIso(cellAfter(root, "提出日") ?? "");
  const proposerText = squash(cellAfter(root, "発議者") ?? "") || undefined;
  const submitterText = squash(cellAfter(root, "提出者") ?? "") || undefined;
  const submitterKind = squash(cellAfter(root, "提出者区分") ?? "") || undefined;
  const plenary: Bill["plenary"] = [];
  for (const table of root.querySelectorAll('table[summary="参議院本会議経過情報"]')) {
    const decision = squash(cellAfter(table, "議決") ?? "");
    if (!decision) continue;
    const href = rowOf(table, "採決方法")?.querySelector("a[href]")?.getAttribute("href") ?? "";
    const m = href.match(/\/(\d+-\d{4}-v\d+)\.htm$/i);
    plenary.push(m ? { decision, rollCallId: m[1] } : { decision });
  }
  return {
    id: `${session}-${kind}-${number ?? numberText}`, session, kind, ...(number !== undefined ? { number } : {}),
    title, category, sourceUrl, ...(submittedOn ? { submittedOn } : {}), ...(proposerText ? { proposerText } : {}),
    proposers: parseProposers(proposerText ?? ""), ...(submitterText ? { submitterText } : {}), ...(submitterKind ? { submitterKind } : {}),
    ...(statusOf(root) ? { status: statusOf(root) } : {}), plenary,
  };
}

/** 参法のうち発議者の氏名が無いもの（委員会発議。「提出者 ○○委員長」）。timeline の bill 行にならないので件数をログに出す（黙ってスキップしない）。 */
export function committeeBills(bills: readonly Bill[]): Bill[] {
  return bills.filter((b) => b.kind === "参法" && b.proposers.length === 0);
}

/** 種別（例「法律案（参法）」「人事案件」）→ BillKind。括弧内があればそれ、無ければ先頭2文字で既知のものに寄せ、残りは「その他」。 */
function billKind(category: string): BillKind {
  const inner = category.match(/（([^（）]+)）/)?.[1];
  if (inner === "内閣提出") return "閣法";
  if (inner === "衆法" || inner === "参法") return inner;
  for (const k of ["予算", "条約", "承認", "決議"] as const) if (category.includes(k)) return k;
  return "その他";
}

/**
 * 発議者欄の原文「打越さく良君 外9名」→ ["打越さく良"]。
 * 「外N名」は人数であって氏名ではないので含めない（誰かは公表されていない。推測しない）。
 */
export function parseProposers(text: string): string[] {
  return squash(text)
    .split(/\s+/)
    .filter((t) => t && !/^外\d+名$/.test(t))
    .map((t) => t.replace(/君$/, ""))
    .filter(Boolean);
}

/** 経過ブロック（段階名, 日付, 議決の原文）のうち日付が最新のものを「段階名 議決」で返す。同日は後のブロック（より後の段階）を優先。 */
function statusOf(root: HTMLElement): string | undefined {
  const stages: { label: string; date: string; text: string }[] = [];
  const add = (label: string, date: string | undefined, text: string) => { if (date && text) stages.push({ label, date, text }); };
  for (const house of ["参議院", "衆議院"]) {
    for (const table of root.querySelectorAll(`table[summary="${house}委員会等経過情報"]`)) {
      const committee = squash(cellAfter(table, "付託委員会等") ?? "");
      const date = warekiToIso(cellAfter(table, "議決日") ?? "") ?? warekiToIso(cellAfter(table, "本付託日") ?? "");
      add(`${house} ${committee}`.trim(), date, squash(cellAfter(table, "議決・継続結果") ?? ""));
    }
    for (const table of root.querySelectorAll(`table[summary="${house}本会議経過情報"]`)) {
      add(`${house}本会議`, warekiToIso(cellAfter(table, "議決日") ?? ""), squash(cellAfter(table, "議決") ?? ""));
    }
  }
  for (const table of root.querySelectorAll('table[summary="その他の情報"]')) {
    const lawNumber = squash(cellAfter(table, "法律番号") ?? "");
    add("公布", warekiToIso(cellAfter(table, "公布年月日") ?? ""), lawNumber ? `（法律第${lawNumber}号）` : "");
  }
  if (!stages.length) return undefined;
  const latest = stages.reduce((a, b) => (b.date >= a.date ? b : a));
  return latest.label === "公布" ? `公布${latest.text}` : `${latest.label} ${latest.text}`;
}

/**
 * 一覧→各詳細ページを順に取得して Bill[] にする（採決の審議結果と、参法の発議者の両方に使う。詳細ページの取得は1回）。
 * 議案ページは審議が進むと内容が変わる（未議決→可決）ので、投票結果ページと違いディスクキャッシュを使わない。
 */
export async function fetchBills(session: number): Promise<Bill[]> {
  const listUrl = billListUrl(session);
  const items = parseBillList(await fetchText(listUrl, "utf-8", { noCache: true, session }), listUrl);
  const out: Bill[] = [];
  for (const item of items) out.push(parseBill(await fetchText(item.href, "utf-8", { noCache: true, session }), item.href));
  return out;
}

/** Bill[] のうち参議院本会議で議決済みのものを BillDecision[] にする（matchBillResults の入力）。 */
export function toBillDecisions(bills: readonly Bill[]): BillDecision[] {
  return bills.flatMap((bill) => bill.plenary.map((p) => ({ title: bill.title, ...p, sourceUrl: bill.sourceUrl })));
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

/** header と一致する th の直後の td（「提出回次 / 提出番号」のように1行に th-td が2組ある行にも対応）。 */
function cellAfter(scope: HTMLElement, header: string): string | undefined {
  const th = scope.querySelectorAll("th").find((el) => squash(el.text) === header);
  let next = th?.nextElementSibling;
  while (next && next.tagName !== "TD") next = next.nextElementSibling;
  return next?.text;
}

/** NBSP（空欄の &nbsp;）・全角空白を含む空白の連続を1つにして trim。 */
function squash(s: string): string {
  return s.replace(/[\s\u00a0　]+/g, " ").trim();
}
