import { parse, type HTMLElement } from "node-html-parser";
import type { Question } from "@seiji-kiroku/shared";
import { fetchText } from "../fetch.ts";
import { warekiToIso } from "./sangiin-members.ts";

/**
 * 衆議院 質問答弁情報（Issue #106）。
 *   一覧: https://www.shugiin.go.jp/internet/itdb_shitsumon.nsf/html/shitsumon/kaiji{回次}_l.htm（Shift_JIS）
 *   経過: .../shitsumon/{回次}{番号3桁}.htm（Shift_JIS）。提出年月日・会派名・答弁書受領年月日はここにしか無い。
 * 一覧は提出者氏名（空白なし「緒方林太郎君」）、経過ページは「緒方　林太郎君」。名寄せは空白を除くので同じ人に落ちる。
 * 提出者は1人（「外N名」の形は第217〜221回に無い）。複数人の形が出たら submitterNames が複数になるよう分割だけする。
 */
const BASE = "https://www.shugiin.go.jp/internet/itdb_shitsumon.nsf/html/shitsumon";

/** 質問の一覧ページの URL（meta.sources 用）。 */
export const shugiinQuestionListUrl = (session: number) => `${BASE}/kaiji${session}_l.htm`;

/** 一覧ページの1行。 */
export interface ShugiinQuestionListItem {
  number: number;
  title: string;
  /** 提出者氏名の原文（「緒方林太郎君」）。 */
  submitterText: string;
  /** 経過状況の原文（「答弁受理」）。 */
  status: string;
  /** 経過ページ（絶対URL）。 */
  href: string;
  questionUrl?: string;
  answerUrl?: string;
}

export class ShugiinQuestionParseError extends Error {
  constructor(message: string, readonly sourceUrl: string) {
    super(`${message} (${sourceUrl})`);
    this.name = "ShugiinQuestionParseError";
  }
}

/**
 * 一覧ページ kaiji{回次}_l.htm。構造（2026-08-23 確認）:
 *   table#shitsumontable > tr > td[headers=SHITSUMON.NUMBER / KENMEI / TEISHUTSUSHA / STATUS / KLINK(a 経過) / SLINK(a 質問HTML) / SLINKPDF / TLINK(a 答弁HTML) / TLINKPDF]
 */
export function parseShugiinQuestionList(html: string, sourceUrl: string): ShugiinQuestionListItem[] {
  const out: ShugiinQuestionListItem[] = [];
  const table = parse(html).querySelector("#shitsumontable") ?? undefined;
  for (const tr of table?.querySelectorAll("tr") ?? []) {
    const cell = (header: string) => tr.querySelector(`td[headers="SHITSUMON.${header}"]`) ?? undefined;
    const number = toInt(squash(cell("NUMBER")?.text ?? ""));
    const href = cell("KLINK")?.querySelector("a[href]")?.getAttribute("href");
    if (number === undefined || !href) continue;
    const link = (header: string) => {
      const h = cell(header)?.querySelector("a[href]")?.getAttribute("href");
      return h ? new URL(h, sourceUrl).href : undefined;
    };
    const questionUrl = link("SLINK");
    const answerUrl = link("TLINK");
    out.push({
      number, title: squash(cell("KENMEI")?.text ?? ""), submitterText: squash(cell("TEISHUTSUSHA")?.text ?? ""),
      status: squash(cell("STATUS")?.text ?? ""), href: new URL(href, sourceUrl).href,
      ...(questionUrl ? { questionUrl } : {}), ...(answerUrl ? { answerUrl } : {}),
    });
  }
  if (out.length === 0) throw new ShugiinQuestionParseError("質問の一覧（#shitsumontable の経過ページへのリンク）が0件です", sourceUrl);
  return out;
}

/**
 * 経過ページ {回次}{番号}.htm。構造（2026-08-23 確認）:
 *   table.table > tr > td[headers=KOMOKU]（項目）/ td[headers=NAIYO]（内容）
 *   項目: 国会回次 / 国会区別 / 質問番号 / 質問件名 / 提出者名 / 会派名 / 質問主意書提出年月日 / 内閣転送年月日 / 答弁延期通知受領年月日 /
 *         答弁延期期限年月日 / 答弁書受領年月日 / 撤回年月日 / 撤回通知年月日 / 経過状況
 * 空欄（<br>）は「未定または無し」なので省略する（推定しない）。答弁書受領年月日が空なら answerUrl も付けない（一覧のリンクは先に張られうる）。
 */
export function parseShugiinQuestion(html: string, sourceUrl: string, links: { questionUrl?: string; answerUrl?: string }): Question {
  const root = parse(html);
  const value = (label: string) => squash(valueCell(root, label) ?? "");
  const session = toInt(value("国会回次"));
  const number = toInt(value("質問番号"));
  if (session === undefined || number === undefined) throw new ShugiinQuestionParseError("国会回次・質問番号が読めません", sourceUrl);
  const title = value("質問件名");
  if (!title) throw new ShugiinQuestionParseError("質問件名が取得できません", sourceUrl);
  const date = warekiToIso(value("質問主意書提出年月日"));
  if (!date) throw new ShugiinQuestionParseError("質問主意書提出年月日が読めません", sourceUrl);
  const submitterText = value("提出者名");
  const group = value("会派名");
  const status = value("経過状況");
  const answerDate = warekiToIso(value("答弁書受領年月日"));
  return {
    id: `${session}-shugiin-${number}`, session, number, house: "shugiin", title, date,
    submitterText, submitterNames: parseSubmitterNames(submitterText),
    ...(group ? { group } : {}), ...(status ? { status } : {}),
    ...(answerDate ? { answerDate } : {}),
    ...(links.questionUrl ? { questionUrl: links.questionUrl } : {}),
    ...(answerDate && links.answerUrl ? { answerUrl: links.answerUrl } : {}),
    sourceUrl,
  };
}

/** 提出者欄の原文「緒方 林太郎君」→ ["緒方 林太郎"]。「外N名」は人数であって氏名ではないので含めない。 */
export function parseSubmitterNames(text: string): string[] {
  return squash(text)
    .split(/君(?:\s*[、，,]\s*|\s+|$)/)
    .map((t) => t.trim())
    .filter((t) => t && !/^外\d+名$/.test(t));
}

/** 一覧→各経過ページを順に取得して Question[] にする。経過ページは答弁の受領で内容が変わるのでキャッシュしない。 */
export async function fetchShugiinQuestions(session: number): Promise<Question[]> {
  const listUrl = shugiinQuestionListUrl(session);
  const items = parseShugiinQuestionList(await fetchText(listUrl, "shift_jis", { noCache: true, session }), listUrl);
  const out: Question[] = [];
  for (const item of items) {
    out.push(parseShugiinQuestion(await fetchText(item.href, "shift_jis", { noCache: true, session }), item.href, item));
  }
  return out;
}

/** 項目名セル（td[headers=KOMOKU]）の右隣の内容セルのテキスト。無ければ undefined。 */
function valueCell(root: HTMLElement, label: string): string | undefined {
  for (const td of root.querySelectorAll("td")) {
    if (squash(td.text) !== label) continue;
    let next = td.nextElementSibling;
    while (next && next.tagName !== "TD") next = next.nextElementSibling;
    if (next) return next.text;
  }
  return undefined;
}

function toInt(s: string): number | undefined {
  return /^\d+$/.test(s) ? Number(s) : undefined;
}

/** NBSP・全角空白を含む空白の連続を1つにして trim。 */
export function squash(s: string): string {
  return s.replace(/[\s 　]+/g, " ").trim();
}
