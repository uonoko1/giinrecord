import type { House, Speech } from "@seiji-kiroku/shared";
import { fetchText, sleep } from "../fetch.ts";

/**
 * 国会会議録検索システム 検索用API（https://kokkai.ndl.go.jp/api.html）。
 * S2 は参議院・本会議のみ。Issue #73 で衆議院・本会議も対象にした（house 引数）。
 * 会議録の公開には約1ヶ月のラグがある（meta.sources[].fetchedAt で明示する）。
 * Verified 2026-08-22.
 */
const API = "https://kokkai.ndl.go.jp/api/speech";
export const PAGE_SIZE = 100;
/** 連続リクエストの間隔（API の利用規約: 短時間の大量アクセスを避ける）。 */
export const REQUEST_INTERVAL_MS = 1000;
/** 冒頭抜粋の長さ（コードポイント）。要約はしない。 */
export const EXCERPT_CHARS = 200;

/** API の nameOfHouse（会議録の院名の原文）。 */
const HOUSE_NAME: Record<House, string> = { sangiin: "参議院", shugiin: "衆議院" };

export function speechPageUrl(session: number, startRecord = 1, house: House = "sangiin"): string {
  const u = new URL(API);
  u.searchParams.set("nameOfHouse", HOUSE_NAME[house]);
  u.searchParams.set("nameOfMeeting", "本会議");
  u.searchParams.set("sessionFrom", String(session));
  u.searchParams.set("sessionTo", String(session));
  u.searchParams.set("recordPacking", "json");
  u.searchParams.set("maximumRecords", String(PAGE_SIZE));
  u.searchParams.set("startRecord", String(startRecord));
  return u.toString();
}

export interface SpeechPage {
  numberOfRecords: number;
  nextRecordPosition: number | null;
  speeches: Speech[];
}

export class SpeechParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeechParseError";
  }
}

/** API の JSON レコード（使う項目だけ）。null は「値なし」。 */
interface SpeechRecord {
  speechID?: unknown;
  speechOrder?: unknown;
  speaker?: unknown;
  speakerGroup?: unknown;
  speakerPosition?: unknown;
  nameOfMeeting?: unknown;
  issue?: unknown;
  date?: unknown;
  speech?: unknown;
  speechURL?: unknown;
}

/**
 * speech API の1ページ（JSON）を Speech[] に変換する純粋関数。
 * - speechOrder 0（speaker「会議録情報」＝議事日程・付した案件）は発言ではないので除く。
 * - speakerGroup は会派（名寄せに使う）、speakerPosition は議長・大臣等の役職（あればそのまま保持）。
 * - 形が違う／必須項目が無いレスポンスは例外にする（黙って空を返さない）。
 */
export function parseSpeechPage(json: unknown, house: House = "sangiin"): SpeechPage {
  if (!isObject(json) || !Array.isArray(json.speechRecord)) throw new SpeechParseError("speechRecord がありません（API レスポンスの形が想定と違います）");
  const numberOfRecords = typeof json.numberOfRecords === "number" ? json.numberOfRecords : fail("numberOfRecords がありません");
  const next = json.nextRecordPosition;
  const nextRecordPosition = typeof next === "number" ? next : next == null ? null : fail(`nextRecordPosition を解釈できません: ${String(next)}`);
  const speeches: Speech[] = [];
  for (const rec of json.speechRecord as SpeechRecord[]) {
    if (rec.speechOrder === 0) continue;
    speeches.push(toSpeech(rec, house));
  }
  return { numberOfRecords, nextRecordPosition, speeches };
}

function toSpeech(rec: SpeechRecord, house: House): Speech {
  const id = str(rec.speechID) ?? fail("speechID がありません");
  const need = (v: unknown, what: string) => str(v) ?? fail(`${id}: ${what} がありません`);
  const { excerpt, chars } = toExcerpt(need(rec.speech, "speech"));
  const group = str(rec.speakerGroup);
  const position = str(rec.speakerPosition);
  return {
    id,
    speakerText: need(rec.speaker, "speaker"),
    ...(group ? { group } : {}),
    ...(position ? { position } : {}),
    house,
    meeting: [need(rec.nameOfMeeting, "nameOfMeeting"), str(rec.issue)].filter(Boolean).join(" "),
    date: need(rec.date, "date"),
    excerpt, chars,
    sourceUrl: need(rec.speechURL, "speechURL"),
  };
}

/**
 * 冒頭抜粋。会議録本文は「○藤川政人君　本文…」「○議長（関口昌一君）　本文…」で始まるので、
 * 話者表示（speakerText と重複）だけを除き、空白・改行の連続を1つの半角空白にまとめ、先頭 EXCERPT_CHARS 字を返す。
 * chars は同じ正規化をした本文全体の文字数（コードポイント）。言い換え・要約は一切しない。
 */
export function toExcerpt(speech: string): { excerpt: string; chars: number } {
  const body = speech.replace(/^○[^\s　]+[\s　]+/, "").replace(/[\s　]+/g, " ").trim();
  const cps = [...body];
  return { excerpt: cps.slice(0, EXCERPT_CHARS).join(""), chars: cps.length };
}

/** 回次の本会議発言（house の院）を全ページ取得する。リクエスト間隔 ≥ REQUEST_INTERVAL_MS。会議録は追加公開されるのでキャッシュしない。 */
export async function fetchSpeeches(session: number, house: House = "sangiin"): Promise<Speech[]> {
  const out: Speech[] = [];
  let start: number | null = 1;
  while (start !== null) {
    const page = parseSpeechPage(JSON.parse(await fetchText(speechPageUrl(session, start, house), "utf-8", { noCache: true })), house);
    out.push(...page.speeches);
    start = page.nextRecordPosition;
    if (start !== null) await sleep(REQUEST_INTERVAL_MS);
  }
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const fail = (msg: string): never => { throw new SpeechParseError(msg); };
