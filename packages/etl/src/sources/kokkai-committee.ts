import type { House } from "@seiji-kiroku/shared";
import { NDL_API_INTERVAL_MS, fetchText, sleep } from "../fetch.ts";

/**
 * 委員会等の「出席委員／出席者」欄に載る委員長・理事・委員（Issue #244、調査は docs/research/individual-records.md §4-A）。
 * 国会会議録検索システム 検索用API の speech を `speaker=会議録情報`（＝ speechOrder 0 の冒頭情報）で引く。
 * `parseSpeechPage`（#242）はこのレコードを捨てているので、ここで別に取る。
 *
 * ここで得られるのは **その日の会議に出席した委員の氏名と役職の原文** であって、
 * 委員名簿（在任期間）そのものではない。欠席した委員は載らないし、任期の開始日・終了日も書かれていない。
 * よって「委員だった期間」を推定せず、会議 1 回ごとの事実として記録する（期間は Web 側が
 * 「同じ役職で出席した最初の日〜最後の日」として出席日から表示する。会議録に無い日付を作らない）。
 * Verified 2026-08-25（第204回・第217回の衆参で実データ確認）。
 */
const API = "https://kokkai.ndl.go.jp/api/speech";
export const PAGE_SIZE = 100;
/** 連続リクエストの間隔。値と根拠は `fetch.ts` の `NDL_API_INTERVAL_MS`（#231）。 */
export const REQUEST_INTERVAL_MS = NDL_API_INTERVAL_MS;

const HOUSE_NAME: Record<House, string> = { sangiin: "参議院", shugiin: "衆議院" };

export function committeePageUrl(session: number, house: House, startRecord = 1): string {
  const u = new URL(API);
  u.searchParams.set("nameOfHouse", HOUSE_NAME[house]);
  u.searchParams.set("speaker", "会議録情報");
  // nameOfMeeting は付けない（付けないことが「全会議」の指定になる。#242 と同じ）。
  u.searchParams.set("sessionFrom", String(session));
  u.searchParams.set("sessionTo", String(session));
  u.searchParams.set("recordPacking", "json");
  u.searchParams.set("maximumRecords", String(PAGE_SIZE));
  u.searchParams.set("startRecord", String(startRecord));
  return u.toString();
}

/**
 * 出席委員欄の 1 名（役職と氏名の原文）。
 * `role` は会議録の原文そのまま（「委員長」「理事」「幹事」「会長」「小委員長」「委員長代理理事」…）。
 * 役職の見出しが付かない行は「委員」（衆院は役職欄が空、参院は「委　員」見出しの下）。
 * `nameText` は氏名から空白と末尾の「君」を除いたもの（`kokkai-attendance.ts` と同じ）。
 */
export interface RosterMember { role: string; nameText: string }

/** 1 回の会議の出席委員名簿（会議録の冒頭情報 1 件）。 */
export interface CommitteeRoster {
  /** 会議録情報の speechID（例 "121704889X02920250620_000"）。 */
  id: string;
  session: number;
  house: House;
  /** 会議名＋号（例「内閣委員会 第29号」）。 */
  meeting: string;
  date: string;
  members: RosterMember[];
  /** 会議録の冒頭情報の URL。 */
  sourceUrl: string;
}

export interface CommitteeRosterPage {
  numberOfRecords: number;
  nextRecordPosition: number | null;
  rosters: CommitteeRoster[];
}

export class CommitteeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommitteeParseError";
  }
}

interface SpeechRecord {
  speechID?: unknown;
  speechOrder?: unknown;
  nameOfMeeting?: unknown;
  issue?: unknown;
  date?: unknown;
  speech?: unknown;
  speechURL?: unknown;
}

/**
 * speech API の 1 ページを CommitteeRoster[] に変換する純粋関数。
 * speechOrder 0（会議録情報）だけを見る。出席委員欄が無い会議録（本会議など）は残さない。
 */
export function parseCommitteeRosterPage(json: unknown, session: number, house: House): CommitteeRosterPage {
  if (!isObject(json)) throw new CommitteeParseError("API レスポンスがオブジェクトではありません");
  const numberOfRecords = typeof json.numberOfRecords === "number" ? json.numberOfRecords : fail("numberOfRecords がありません");
  const next = json.nextRecordPosition;
  const nextRecordPosition = typeof next === "number" ? next : next == null ? null : fail(`nextRecordPosition を解釈できません: ${String(next)}`);
  // 0 件のとき API は speechRecord キー自体を返さない（kokkai-attendance.ts と同じ）。
  const records = Array.isArray(json.speechRecord) ? (json.speechRecord as SpeechRecord[]) : numberOfRecords === 0 ? [] : fail("speechRecord がありません（API レスポンスの形が想定と違います）");
  const rosters: CommitteeRoster[] = [];
  for (const rec of records) {
    if (rec.speechOrder !== 0) continue;
    const id = str(rec.speechID) ?? fail("speechID がありません");
    const need = (v: unknown, what: string) => str(v) ?? fail(`${id}: ${what} がありません`);
    const members = parseRosterHeader(need(rec.speech, "speech"), house);
    if (members.length === 0) continue;
    rosters.push({
      id, session, house,
      meeting: [need(rec.nameOfMeeting, "nameOfMeeting"), str(rec.issue)].filter(Boolean).join(" "),
      date: need(rec.date, "date"),
      members,
      sourceUrl: need(rec.speechURL, "speechURL"),
    });
  }
  return { numberOfRecords, nextRecordPosition, rosters };
}

/** 会議録の冒頭情報から出席委員欄を取り出す。院で書式が違うので分ける。 */
export function parseRosterHeader(speech: string, house: House): RosterMember[] {
  return house === "shugiin" ? parseShugiinRoster(speech) : parseSangiinRoster(speech);
}

/* ---------------- 衆議院 ---------------- */

/**
 * 衆議院の出席委員欄。「　出席委員」（全角空白 1 つ）から始まり、氏名行（末尾が「君」）が続く。
 * 氏名行でない行（「…………」の区切り・「委員の異動」など）で終わる。
 * 1 行に 2 名（2 段組）で、役職は氏名の前に付く（「理事　黄川田仁志君　理事　國場幸之助君」）。
 */
function parseShugiinRoster(speech: string): RosterMember[] {
  const out: RosterMember[] = [];
  let inBlock = false;
  for (const raw of speech.split(/\r?\n/)) {
    const line = raw.replace(/[\s　]+$/, "");
    if (!inBlock) {
      if (SHUGIIN_BLOCK_START.test(line)) inBlock = true;
      continue;
    }
    // 出席委員欄は氏名行が連続するだけ。氏名行でない行が来たら欄の終わり
    // （「　　　　…………………」の区切り行、「委員の異動」、「本日の会議に付した案件」）。
    if (!line.endsWith("君")) break;
    out.push(...parseShugiinLine(line));
  }
  return out;
}

/** 「　出席委員」「　出席小委員」（分科会・小委員会）。 */
const SHUGIIN_BLOCK_START = /^　出席(小)?委員$/;

/**
 * 衆院の出席委員欄の 1 行を 1 名ずつに割る純粋関数（export はテスト用ではなく院別パーサの単位）。
 *
 * 全角空白は「姓と名の区切り」（`安住　　淳`）にも「段組の区切り」（`…君　　　　石原`）にも使われるので、
 * **空白の連続数で段組を判定しない**（実データでは段組の区切りが 1・2・3・4 個、姓名の区切りが 1・2・3 個あった）。
 * 代わりに「1 名は必ず `君` で終わり、その `君` の次は行末か全角空白」という規則で切る。
 * こうすると氏名に「君」を含む議員（`畑野　君枝君`）を 2 名に割らない（`君枝` の `君` の次は `枝`）。
 * 役職（`理事`）は氏名の前に付き、空白を挟まないこともある（`理事おおつき紅葉君`）。
 */
export function parseShugiinLine(line: string): RosterMember[] {
  const out: RosterMember[] = [];
  const s = line.replace(/[\s　]+$/, "");
  let i = 0;
  while (i < s.length) {
    while (isSpace(s[i])) i++;
    if (i >= s.length) break;
    let role = "委員";
    for (const r of INLINE_ROLES) if (s.startsWith(r, i)) { role = r; i += r.length; break; }
    while (isSpace(s[i])) i++;
    // この 1 名を終わらせる「君」＝ 次が行末か全角空白であるもの
    let j = i, end = -1;
    while ((j = s.indexOf("君", j)) >= 0) {
      if (j + 1 >= s.length || isSpace(s[j + 1])) { end = j; break; }
      j++;
    }
    if (end < 0) throw new CommitteeParseError(`出席委員欄の行を解釈できません（「君」で終わらない）: ${JSON.stringify(line)}`);
    const nameText = s.slice(i, end).replace(/[\s　]/g, "");
    if (nameText === "") throw new CommitteeParseError(`出席委員欄の行に氏名がありません: ${JSON.stringify(line)}`);
    out.push({ role, nameText });
    i = end + 1;
  }
  return out;
}

/**
 * 氏名の前に付きうる役職の原文（実データで確認したもの。長いものから先に試す）。
 * 第204回・第217回の衆参で出現したのは 委員長・理事・幹事・会長・小委員長・委員長代理理事 の 6 種。
 * ここに無い役職が付いた行は、役職ごと氏名として読んでしまうので、`matchCommitteeRoles` の
 * 名寄せで落ちて unmatched に出る（推測で役職を切らない）。
 */
const INLINE_ROLES = ["委員長代理理事", "小委員長", "委員長", "理事", "幹事", "会長"] as const;

/* ---------------- 参議院 ---------------- */

/**
 * 参議院の出席者欄。「出席者は左のとおり。」から「本日の会議に付した案件」まで。1 行 1 名。
 * - 全角空白 4 つのインデントが委員の役職見出し（`委　員` `理　事` `幹　事` `小委員`）と
 *   行内役職（`委員長　　…　和田　政宗君` `会　長　…`）。
 * - 全角空白 3 つのインデントが委員以外の見出し（`国務大臣` `事務局側` `政府参考人` `衆議院議員` …）で、
 *   その下の氏名行はインデント 7。**インデント 15 以上の氏名行は委員の役職見出しの下にしか現れない**
 *   （第204・217回の実データ 4 ファイル 11,000 行で確認。officials は 7、委員は 15 か 16）。
 * この 2 つを使って、委員以外（大臣・政府参考人・専門員・衆議院議員）を確実に外す。
 */
function parseSangiinRoster(speech: string): RosterMember[] {
  const out: RosterMember[] = [];
  let inBlock = false;
  let section: string | undefined;
  for (const raw of speech.split(/\r?\n/)) {
    const line = raw.replace(/[\s　]+$/, "");
    if (!inBlock) {
      if (line.includes("出席者は左のとおり")) inBlock = true;
      continue;
    }
    if (line.includes("本日の会議に付した案件")) break;
    const body = line.replace(/^　*/, "");
    if (body === "") continue;
    const indent = line.length - body.length;
    if (!line.endsWith("君")) {
      // 見出し行。インデント 4 は委員の役職見出し、それ以外（3 など）は委員以外の見出し。
      // 「─────」の区切り行は見出しではないので、そこでは section を変えない。
      if (!/^[─―—-]+$/.test(body)) section = indent === 4 ? normalizeRole(body) : undefined;
      continue;
    }
    if (indent === 4) {
      // 行内に役職がある（「委員長　　　　　　　　　和田　政宗君」「会　長　…」）。
      const m = /^(.+?)　{2,}(.+)君$/.exec(body);
      if (!m) continue;
      out.push({ role: normalizeRole(m[1]), nameText: m[2].replace(/[\s　]/g, "") });
      section = undefined;
      continue;
    }
    // 見出しの下の氏名行。委員の役職見出しの下で、かつ委員のインデント（15 以上）の行だけを採る。
    // 「委　員」の並びの後に「─────」の区切りを挟んで議長・副議長が続く会議録（議院運営委員会）が
    // あり、区切り行では見出しが変わらないので、インデントでも切る（議長・副議長・政府参考人はインデント 7）。
    if (indent >= MEMBER_NAME_INDENT && section !== undefined && MEMBER_ROLES.has(section)) {
      out.push({ role: section, nameText: body.replace(/君$/, "").replace(/[\s　]/g, "") });
    }
  }
  return out;
}

/** 参院の見出し・行内役職は字間に全角空白が入る（`理　事` `委　員` `会　長`）ので詰める。 */
const normalizeRole = (s: string): string => s.replace(/[\s　]/g, "");

/**
 * 委員として名簿に載せる役職（参院の見出し）。これ以外の見出し（国務大臣・事務局側・政府参考人・
 * 衆議院議員・参考人・説明員 …）の下の氏名は委員ではないので採らない。
 * `委員長` `会長` `小委員長` は見出しではなく行内に付くので、ここには要らない。
 */
const MEMBER_ROLES = new Set(["委員", "理事", "幹事", "小委員"]);

/**
 * 見出しの下の委員の氏名行の最小インデント（全角空白の数）。
 * 第204・217回の実データ（会議録情報 4 ファイル・出席者欄の氏名行 13,525 行）では
 * 委員は 15 か 16、委員以外（大臣・政府参考人・事務局側・議長／副議長）は 7 だった。
 */
const MEMBER_NAME_INDENT = 15;

/* ---------------- 取得 ---------------- */

/**
 * 回次・院の会議録情報を全ページ取得して出席委員名簿にする。間隔 ≥ REQUEST_INTERVAL_MS。
 * 会議録は追加公開されるのでキャッシュしない。
 * 1 回次あたり 3〜4 ページ（第217回は衆院 439 件・参院 4xx 件＝開会日数×会議体。2026-08-25 実測）。
 */
export async function fetchCommitteeRosters(session: number, house: House): Promise<CommitteeRoster[]> {
  const out: CommitteeRoster[] = [];
  let start: number | null = 1;
  while (start !== null) {
    const page = parseCommitteeRosterPage(JSON.parse(await fetchText(committeePageUrl(session, house, start), "utf-8", { noCache: true })), session, house);
    out.push(...page.rosters);
    start = page.nextRecordPosition;
    if (start !== null) await sleep(REQUEST_INTERVAL_MS);
  }
  return out;
}

const isSpace = (c: string | undefined): boolean => c === "　" || c === " ";
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const fail = (msg: string): never => { throw new CommitteeParseError(msg); };
