import { fetchText, sleep } from "../fetch.ts";
import { REQUEST_INTERVAL_MS } from "./kokkai-speeches.ts";

/**
 * 委員会会議録の冒頭「出席者」欄に載る「発議者」（Issue #109、調査は docs/research/sangiin-cosponsors.md §5）。
 * 国会会議録検索システム 検索用API の speech を、参議院・speaker=会議録情報（speechOrder 0 の冒頭情報）・any=発議者 で引く。
 *
 * ここで得られるのは「その日の委員会に発議者として出席した」という事実だけで、参法の発議者全員の一覧ではない
 * （217 参法 7 は「外2名」＝3 人に対し出席は 2 人）。よって Bill.submitters / timeline の bill 行には絶対に入れず、
 * 別種の timeline 行（kind: "attendance"）として記録する。
 * - 「衆議院議員」見出しの下の発議者は衆法の発議者（衆議院議員）なので採らない。
 * - 「本日の会議に付した案件」に（参第N号）が無い会議録は採らない（衆法・憲法審査会など）。
 * - 同じ日の案件に参法が複数あるとき、どの参法の発議者として出席したかは出席者欄からは分からないので、その日の参法を全部 bills に残す（推定しない）。
 * Verified 2026-08-23.
 */
const API = "https://kokkai.ndl.go.jp/api/speech";
export const PAGE_SIZE = 100;

export function attendancePageUrl(session: number, startRecord = 1): string {
  const u = new URL(API);
  u.searchParams.set("nameOfHouse", "参議院");
  u.searchParams.set("speaker", "会議録情報");
  u.searchParams.set("any", "発議者");
  u.searchParams.set("sessionFrom", String(session));
  u.searchParams.set("sessionTo", String(session));
  u.searchParams.set("recordPacking", "json");
  u.searchParams.set("maximumRecords", String(PAGE_SIZE));
  u.searchParams.set("startRecord", String(startRecord));
  return u.toString();
}

/** 出席者欄の1行（役割と氏名の原文。氏名は空白と「君」を除いたもの）。 */
export interface Attendee { role: "発議者"; nameText: string }

/** 1 回の委員会（会議録の冒頭情報）。発議者として出席した参議院議員と、その日の案件にあった参法。 */
export interface CommitteeMeeting {
  /** 会議録情報の speechID（例 "122115007X01420260709_000"）。 */
  id: string;
  session: number;
  /** 会議名＋号（例「農林水産委員会 第14号」）。 */
  meeting: string;
  date: string;
  attendees: Attendee[];
  /** 「本日の会議に付した案件」の参法（billId は `{回次}-参法-{番号}`、title は案件の原文から（参第N号）を除いたもの）。 */
  bills: { billId: string; title: string }[];
  /** 会議録の冒頭情報の URL。 */
  sourceUrl: string;
}

export interface AttendancePage {
  numberOfRecords: number;
  nextRecordPosition: number | null;
  meetings: CommitteeMeeting[];
}

export class AttendanceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttendanceParseError";
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
 * speech API の1ページを CommitteeMeeting[] に変換する純粋関数。
 * speechOrder 0（会議録情報）だけを見る。参法が案件に無い、または参議院側の発議者が 0 人の会議録は残さない。
 */
export function parseAttendancePage(json: unknown, session: number): AttendancePage {
  if (!isObject(json) || !Array.isArray(json.speechRecord)) throw new AttendanceParseError("speechRecord がありません（API レスポンスの形が想定と違います）");
  const numberOfRecords = typeof json.numberOfRecords === "number" ? json.numberOfRecords : fail("numberOfRecords がありません");
  const next = json.nextRecordPosition;
  const nextRecordPosition = typeof next === "number" ? next : next == null ? null : fail(`nextRecordPosition を解釈できません: ${String(next)}`);
  const meetings: CommitteeMeeting[] = [];
  for (const rec of json.speechRecord as SpeechRecord[]) {
    if (rec.speechOrder !== 0) continue;
    const id = str(rec.speechID) ?? fail("speechID がありません");
    const need = (v: unknown, what: string) => str(v) ?? fail(`${id}: ${what} がありません`);
    const { attendees, bills } = parseMeetingHeader(need(rec.speech, "speech"), session);
    if (bills.length === 0 || attendees.length === 0) continue;
    meetings.push({
      id, session,
      meeting: [need(rec.nameOfMeeting, "nameOfMeeting"), str(rec.issue)].filter(Boolean).join(" "),
      date: need(rec.date, "date"),
      attendees, bills,
      sourceUrl: need(rec.speechURL, "speechURL"),
    });
  }
  return { numberOfRecords, nextRecordPosition, meetings };
}

/** 出席者欄の見出し行（全角空白 3 つ＋見出し。例「衆議院議員」「国務大臣」「委員以外の議員」）。委員長・理事・委員は 4 つなので見出しではない。 */
const SECTION = /^　{3}([^　\s].*?)\s*$/;
/** 「　　　　　　　発議者　　　　　　舟山　康江君」 */
const PROPOSER = /^　+発議者　+(.+?)君\s*$/;
/** 「○主要農作物の…法律案（参第一一号）」。末尾の（衆議院送付）などは参法には付かないが、念のため後続を許す */
const SANPOU = /^○(.+?)（参第([〇一二三四五六七八九十百]+)号）/;

/**
 * 会議録の冒頭情報から「出席者」欄の参議院側の発議者と「本日の会議に付した案件」の参法を取り出す純粋関数。
 * - 出席者欄は「出席者は左のとおり。」から「本日の会議に付した案件」まで。その外の「発議者」は拾わない。
 * - 「衆議院議員」見出しの下（次の見出しまで）の発議者は衆議院議員なので採らない。見出しより前・「委員以外の議員」の下は採る。
 *   衆議院議員以外の見出し（国務大臣・事務局側・政府参考人 …）の下にも発議者は載らないが、載っていても採らない（出席者欄の構造を信用しない）。
 */
export function parseMeetingHeader(speech: string, session: number): { attendees: Attendee[]; bills: CommitteeMeeting["bills"] } {
  const attendees: Attendee[] = [];
  const bills: CommitteeMeeting["bills"] = [];
  let where: "before" | "attendees" | "agenda" = "before";
  let section: string | undefined;
  for (const raw of speech.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (where === "before") {
      if (line.includes("出席者は左のとおり")) where = "attendees";
      continue;
    }
    if (line.includes("本日の会議に付した案件")) { where = "agenda"; continue; }
    if (where === "attendees") {
      const head = SECTION.exec(line);
      if (head) { section = head[1]; continue; }
      const m = PROPOSER.exec(line);
      if (!m) continue;
      if (section === undefined || section === "委員以外の議員") attendees.push({ role: "発議者", nameText: m[1].replace(/[\s　]+/g, "") });
      continue;
    }
    const b = SANPOU.exec(line);
    if (b) bills.push({ billId: `${session}-参法-${kanjiNumber(b[2])}`, title: b[1].trim() });
  }
  return { attendees, bills };
}

const DIGITS = "〇一二三四五六七八九";

/** 案件の議案番号（参第一一号 → 11）。位取りなしの漢数字を桁ごとに読む。十・百が現れたら解釈せず例外（推測しない）。 */
export function kanjiNumber(s: string): number {
  let n = 0;
  for (const c of s) {
    const d = DIGITS.indexOf(c);
    if (d < 0) throw new AttendanceParseError(`議案番号の漢数字を解釈できません: ${s}（${c}）`);
    n = n * 10 + d;
  }
  return n;
}

/** 回次の参議院の会議録情報（出席者欄に発議者を含むもの）を全ページ取得する。間隔 ≥ REQUEST_INTERVAL_MS。会議録は追加公開されるのでキャッシュしない。 */
export async function fetchCommitteeAttendance(session: number): Promise<CommitteeMeeting[]> {
  const out: CommitteeMeeting[] = [];
  let start: number | null = 1;
  while (start !== null) {
    const page = parseAttendancePage(JSON.parse(await fetchText(attendancePageUrl(session, start), "utf-8", { noCache: true })), session);
    out.push(...page.meetings);
    start = page.nextRecordPosition;
    if (start !== null) await sleep(REQUEST_INTERVAL_MS);
  }
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const fail = (msg: string): never => { throw new AttendanceParseError(msg); };
