import { parse, type HTMLElement } from "node-html-parser";
import type { Question } from "@seiji-kiroku/shared";
import { fetchText } from "../fetch.ts";
import { warekiToIso } from "./sangiin-members.ts";
import { parseSubmitterNames, squash } from "./shugiin-questions.ts";

/**
 * 参議院 質問主意書（Issue #106）。
 *   一覧: https://www.sangiin.go.jp/japanese/joho1/kousei/syuisyo/{回次}/syuisyo.htm（UTF-8）
 *   詳細: .../syuisyo/{回次}/meisai/m{回次}{番号3桁}.htm。提出日・転送日・答弁書受領日はここにしか無い。
 * 詳細ページに会派は無い（参院名簿は回次ごとにあるので、同姓同名は名簿の側でしか分けられない＝分けられなければ unmatched）。
 */
const BASE = "https://www.sangiin.go.jp/japanese/joho1/kousei/syuisyo";

/** 質問主意書の一覧ページの URL（meta.sources 用）。 */
export const sangiinQuestionListUrl = (session: number) => `${BASE}/${session}/syuisyo.htm`;

/** 一覧ページの1件。 */
export interface SangiinQuestionListItem {
  number: number;
  title: string;
  /** 提出者の原文（「石垣 のりこ君」。全角空白は半角1つ）。 */
  submitterText: string;
  /** 詳細ページ（絶対URL）。 */
  href: string;
  questionUrl?: string;
  answerUrl?: string;
}

export class SangiinQuestionParseError extends Error {
  constructor(message: string, readonly sourceUrl: string) {
    super(`${message} (${sourceUrl})`);
    this.name = "SangiinQuestionParseError";
  }
}

/**
 * 一覧ページ syuisyo.htm。構造（2026-08-23 確認）: table.list_c の中で1件が3つの tr:
 *   tr: th#tN「提出番号」/ th「件名」/ td > a[href=meisai/mNNN.htm]（件名）
 *   tr: td[headers=tN]（番号）/ th「提出者」/ td.ta_l（提出者）/ td > a[href=syuh/…]（質問本文 html）/ td > a[href=touh/…]（答弁本文 html）
 *   tr: PDF のリンク（使わない）
 */
export function parseSangiinQuestionList(html: string, sourceUrl: string): SangiinQuestionListItem[] {
  const out: SangiinQuestionListItem[] = [];
  const rows = parse(html).querySelectorAll("table.list_c tr");
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i].querySelector('a[href*="meisai/m"]');
    if (!a) continue;
    const next = rows[i + 1];
    const numberCell = next?.querySelector("td[headers]");
    const number = toInt(squash(numberCell?.text ?? ""));
    if (number === undefined) throw new SangiinQuestionParseError(`提出番号が読めません: ${squash(a.text)}`, sourceUrl);
    const submitterText = squash(next?.querySelector("td.ta_l")?.text ?? "");
    const link = (dir: string) => {
      const h = next?.querySelector(`a[href*="${dir}/"]`)?.getAttribute("href");
      return h ? new URL(h, sourceUrl).href : undefined;
    };
    const questionUrl = link("syuh");
    const answerUrl = link("touh");
    out.push({
      number, title: squash(a.text), submitterText, href: new URL(a.getAttribute("href") ?? "", sourceUrl).href,
      ...(questionUrl ? { questionUrl } : {}), ...(answerUrl ? { answerUrl } : {}),
    });
  }
  if (out.length === 0) throw new SangiinQuestionParseError("質問主意書の一覧（table.list_c 内の meisai/ へのリンク）が0件です", sourceUrl);
  return out;
}

/**
 * 詳細ページ meisai/mNNN.htm。構造（2026-08-23 確認）: table.list_c[summary="質問主意書情報"] が複数:
 *   th 件名 / 提出回次 / 提出番号、th 提出日 / 提出者、th 備考、th 転送日 / 答弁書受領日、質問主意書・答弁書へのリンク
 */
export function parseSangiinQuestion(html: string, sourceUrl: string, links: { questionUrl?: string; answerUrl?: string }): Question {
  const root = parse(html);
  const value = (header: string) => squash(cellAfter(root, header) ?? "");
  const title = value("件名");
  if (!title) throw new SangiinQuestionParseError("件名が取得できません", sourceUrl);
  const session = toInt(value("提出回次").replace(/\D/g, ""));
  const number = toInt(value("提出番号"));
  if (session === undefined || number === undefined) throw new SangiinQuestionParseError("提出回次・提出番号が読めません", sourceUrl);
  const date = warekiToIso(value("提出日"));
  if (!date) throw new SangiinQuestionParseError("提出日が読めません", sourceUrl);
  const submitterText = value("提出者");
  const answerDate = warekiToIso(value("答弁書受領日"));
  return {
    id: `${session}-sangiin-${number}`, session, number, house: "sangiin", title, date,
    submitterText, submitterNames: parseSubmitterNames(submitterText),
    ...(answerDate ? { answerDate } : {}),
    ...(links.questionUrl ? { questionUrl: links.questionUrl } : {}),
    ...(answerDate && links.answerUrl ? { answerUrl: links.answerUrl } : {}),
    sourceUrl,
  };
}

/** 一覧→各詳細ページを順に取得して Question[] にする。詳細ページは答弁の受領で内容が変わるのでキャッシュしない。 */
export async function fetchSangiinQuestions(session: number): Promise<Question[]> {
  const listUrl = sangiinQuestionListUrl(session);
  const items = parseSangiinQuestionList(await fetchText(listUrl, "utf-8", { noCache: true, session }), listUrl);
  const out: Question[] = [];
  for (const item of items) out.push(parseSangiinQuestion(await fetchText(item.href, "utf-8", { noCache: true, session }), item.href, item));
  return out;
}

/** header と一致する th の直後の td（「提出回次 / 提出番号」のように1行に th-td が2組ある行にも対応）。 */
function cellAfter(scope: HTMLElement, header: string): string | undefined {
  const th = scope.querySelectorAll("th").find((el) => squash(el.text) === header);
  let next = th?.nextElementSibling;
  while (next && next.tagName !== "TD") next = next.nextElementSibling;
  return next?.text;
}

function toInt(s: string): number | undefined {
  return /^\d+$/.test(s) ? Number(s) : undefined;
}
