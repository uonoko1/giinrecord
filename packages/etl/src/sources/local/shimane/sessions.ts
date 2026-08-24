import { parse } from "node-html-parser";
import { cleanText, resolveShimaneUrl, SHIMANE_ORIGIN, warekiYear } from "./site.ts";

/**
 * 島根県議会の会期の発見（Issue #221）。会期の index は 2 つに分かれている:
 *   /gikai/ugoki/saikin/      「最近の定例会の概要」。会期中〜直近の会期（ふつう 1 つ）だけが載る。
 *                             リンク文言に通算回次がある（「令和８年６月定例会（第４９９回）の概要」）。
 *   /gikai/ugoki/gikai_kako/  「過去の定例会の概要」。年見出し（h3「令和８年」）ごとに会期のリンクが並ぶ。
 *                             こちらのリンク文言に回次は無い（「令和８年２月定例会」）。
 * どちらも会期ページ（/…/r0806/）へのリンクで、会期ページの「議決結果」の節に「議員別採決結果一覧」PDF がある。
 * saikin にある会期は会期が終わると gikai_kako へ移る（同じ会期が両方に出ることもあるので、呼ぶ側が url で重複を除く）。
 *
 * sessionId: 回次が原文にあれば回次（「499」。宮城と同じ）、無ければ「{西暦}-{月2桁}」（臨時会は「-rinji」。鳥取・奈良と同じ）。
 * 平成31年と令和元年はどちらも 2019 年だが、月が違うので西暦＋月で一意になる。
 */
export const SESSION_INDEX_URL = `${SHIMANE_ORIGIN}/gikai/ugoki/saikin/`;
export const SESSION_ARCHIVE_URL = `${SHIMANE_ORIGIN}/gikai/ugoki/gikai_kako/`;

export interface SessionLink {
  /** 議会内で一意: 通算回次（「499」）、回次の無い会期は「{西暦}-{月2桁}」（臨時会は「-rinji」付き） */
  sessionId: string;
  /** リンク文言から「の概要」を除いた原文（「令和8年6月定例会（第499回）」）。sessionLabel になる */
  sessionLabel: string;
  year: number;
  month: number;
  url: string;
}

/** 「令和８年６月定例会（第４９９回）の概要」「令和元年５月臨時会」。NFKC で寄せた後の形（括弧は半角になる）。 */
const LINK_TEXT = /^(令和|平成)(\d+|元)年(\d{1,2})月(定例会|臨時会)(?:[（(]第(\d+)回[）)])?(?:の概要)?$/;

/**
 * 会期 index（saikin / gikai_kako のどちらでも）→ 会期のリンク。新しい順に並べ替えて返す
 * （gikai_kako の年内の並びは年によって昇順・降順が混ざっているので、ここで揃える）。
 */
export function parseSessionIndex(html: string, baseUrl: string): SessionLink[] {
  const root = parse(html);
  const contents = root.querySelector("#page-content");
  if (!contents) throw new Error(`${baseUrl}: #page-content not found`);
  const sessions: SessionLink[] = [];
  for (const a of contents.querySelectorAll("a")) {
    const text = cleanText(a.text).normalize("NFKC");
    const m = text.match(LINK_TEXT);
    if (!m) continue;
    const year = warekiYear(m[1], m[2]);
    const month = Number(m[3]);
    if (month < 1 || month > 12) throw new Error(`${baseUrl} ${text}: bad month`);
    const sessionId = m[5] ?? `${year}-${String(month).padStart(2, "0")}${m[4] === "臨時会" ? "-rinji" : ""}`;
    if (sessions.some((s) => s.sessionId === sessionId)) throw new Error(`${baseUrl}: duplicate session ${sessionId}`);
    // 回次の括弧は全角に戻す（DATA_CONTRACT の会期の原文の例「令和7年11月定例会（第398回）」に合わせる。NFKC で半角になっている）
    const sessionLabel = text.replace(/の概要$/, "").replace(/\(第(\d+)回\)$/, "（第$1回）");
    sessions.push({
      sessionId,
      sessionLabel,
      year,
      month,
      url: resolveShimaneUrl(a.getAttribute("href") ?? "", baseUrl),
    });
  }
  if (sessions.length === 0) throw new Error(`${baseUrl}: no sessions found`);
  sessions.sort((a, b) => b.year * 100 + b.month - (a.year * 100 + a.month));
  return sessions;
}

export interface SessionPage {
  /** h1 の原文から「の概要」を除いたもの（「令和8年6月定例会」。会期ページの h1 に通算回次は無い） */
  sessionLabel: string;
  /** 「議員別採決結果一覧」PDF（ページの並び順）。無ければ []（会期中＝まだ議決していない） */
  pdfUrls: string[];
}

const VOTE_PDF_TEXT = /^議員別採決結果一覧/;
/** index のリンク文言の通算回次「（第499回）」。会期ページの h1 には無いので、突き合わせる前に落とす（NFKC 後は半角括弧）。 */
const KAIJI = /[（(]第\d+回[）)]$/;

/**
 * 会期ページ → 会期の原文と「議員別採決結果一覧」PDF の一覧。
 * h1 が index のリンク文言（回次を除いたもの）と食い違えば例外（別の会期のページを黙って読まない）。
 * 「議決結果一覧」（議案ごとの総数だけの PDF）は議員別ではないので拾わない。
 */
export function parseSessionPage(html: string, baseUrl: string, expected: { sessionLabel: string }): SessionPage {
  const root = parse(html);
  const contents = root.querySelector("#page-content");
  if (!contents) throw new Error(`${baseUrl}: #page-content not found`);
  const h1 = cleanText(contents.querySelector("h1")?.text ?? "").normalize("NFKC");
  const want = `${expected.sessionLabel.normalize("NFKC").replace(KAIJI, "")}の概要`;
  if (h1 !== want) throw new Error(`${baseUrl}: h1 "${h1}" does not match the index link "${want}"`);
  const pdfUrls: string[] = [];
  for (const a of contents.querySelectorAll("a")) {
    const text = cleanText(a.text).normalize("NFKC");
    if (!VOTE_PDF_TEXT.test(text)) continue;
    const href = (a.getAttribute("href") ?? "").trim();
    if (!/\.pdf$/i.test(href)) throw new Error(`${baseUrl}: 議員別採決結果一覧 link is not a PDF: ${href}`);
    const url = resolveShimaneUrl(href, baseUrl);
    if (!pdfUrls.includes(url)) pdfUrls.push(url);
  }
  return { sessionLabel: h1.replace(/の概要$/, ""), pdfUrls };
}
