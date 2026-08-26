import type { House, Speech } from "@seiji-kiroku/shared";
import { NDL_API_INTERVAL_MS, fetchText, sleep } from "../fetch.ts";

/**
 * 国会会議録検索システム 検索用API（https://kokkai.ndl.go.jp/api.html）。
 * S2 は参議院・本会議のみ。Issue #73 で衆議院・本会議も対象にした（house 引数）。
 * Issue #242 で委員会も対象にできるようにした（scope 引数）。
 * 会議録の公開には約1ヶ月のラグがある（meta.sources[].fetchedAt で明示する）。
 * Verified 2026-08-22（本会議）/ 2026-08-25（委員会・分科会）。
 */
const API = "https://kokkai.ndl.go.jp/api/speech";
export const PAGE_SIZE = 100;
/**
 * 連続リクエストの間隔。値と根拠は `fetch.ts` の `NDL_API_INTERVAL_MS`
 * （API の利用条件が「データを取得し終えてから数秒程度空けて」と明示している。#231）。
 */
export const REQUEST_INTERVAL_MS = NDL_API_INTERVAL_MS;
/** 冒頭抜粋の長さ（コードポイント）。要約はしない。 */
export const EXCERPT_CHARS = 200;

/** API の nameOfHouse（会議録の院名の原文）。 */
const HOUSE_NAME: Record<House, string> = { sangiin: "参議院", shugiin: "衆議院" };

/**
 * 取得する会議の範囲（Issue #242）。
 * - `"plenary"`: `nameOfMeeting=本会議`。#73 以来の既定で、既存の出力と同じ URL になる。
 * - `"all"`: `nameOfMeeting` を付けない。委員会・分科会・審査会・連合審査会・公聴会・調査会が同じ形で返る。
 *
 * `"all"` が本会議と同じ形で返ることは実データで確認済み:
 * - #263 が第221回（衆参 70,544 件・全量）でキーセットが 1 種類（21キー固定・欠損は null）であることを確認。
 * - #242 が第201・204回の分科会（第221回は特別会で分科会が 1 件も無く #263 が未確認と flag した箇所）を確認。
 *   キーセットは第221回と同一、`speechOrder: 0` の会議録情報が先頭に付き、本文は `○話者　` で始まる。
 *   フィクスチャは `test/fixtures/kokkai-speech-shugiin-204-bunkakai-p1.json`。
 * 確認していないこと: 両院協議会は衆参の第204・208・213回で `numberOfRecords: 0` だった（2026-08-25 実測）。
 * 全回次で 0 かは確認していないので「この API に載っていない」とは断定しない。
 */
export type SpeechScope = "plenary" | "all";

export function speechPageUrl(session: number, startRecord = 1, house: House = "sangiin", scope: SpeechScope = "plenary"): string {
  const u = new URL(API);
  u.searchParams.set("nameOfHouse", HOUSE_NAME[house]);
  // scope が "all" のときは nameOfMeeting を付けない（付けないことが「全会議」の指定になる）。
  if (scope === "plenary") u.searchParams.set("nameOfMeeting", "本会議");
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
  session?: unknown;
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
    session: typeof rec.session === "number" ? rec.session : fail(`${id}: session がありません`),
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

/**
 * 回次の発言（house の院、scope の会議）を全ページ取得する。リクエスト間隔 ≥ REQUEST_INTERVAL_MS。
 * 会議録は追加公開されるのでキャッシュしない。
 * scope が "all"（#242）だと 1 回次で数百ページになる（第221回は衆院 334・参院 372 ページ＝#263 の実測）ので、
 * 全回次を 1 回の実行で流さず #219 と同じ分割 dispatch にする（docs/ops/etl.md）。
 */
export async function fetchSpeeches(session: number, house: House = "sangiin", scope: SpeechScope = "plenary"): Promise<Speech[]> {
  const out: Speech[] = [];
  let start: number | null = 1;
  while (start !== null) {
    const page = parseSpeechPage(JSON.parse(await fetchText(speechPageUrl(session, start, house, scope), "utf-8", { noCache: true, session })), house);
    out.push(...page.speeches);
    start = page.nextRecordPosition;
    if (start !== null) await sleep(REQUEST_INTERVAL_MS);
  }
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const fail = (msg: string): never => { throw new SpeechParseError(msg); };
