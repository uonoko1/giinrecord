import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import iconv from "iconv-lite";

const UA = "gikailog-etl/0.1 (+https://github.com/uonoko1/gikailog)";
const CACHE_DIR = new URL("../.cache/", import.meta.url);

/**
 * 取得間隔（Issue #231）。ETL の待ち時間はここだけで決める。
 *
 * 相手は公的機関の公開情報であり、過負荷をかけないことは中立性・信頼性の一部。
 * #231 以前は国会 HTML が 0.5 秒・地方議会が 1 秒という二重基準だった（経緯で別々に実装された）。
 * 根拠を確認した上で、下限を 1 秒に揃え、明示要求のある提供元だけ長くする。
 */

/**
 * 礼儀の下限。どの取得もこれを下回らない。
 * 衆院・参院・総務省・日本郵便の robots.txt には Crawl-delay の記述が無い（2026-08-25 に確認。
 * 衆院・参院は robots.txt 自体が 404、総務省は `User-agent: ia_archiver / Disallow: /` のみ）。
 * つまり**提供元が 1 秒未満を許可している事実は無い**ので、自ら課す下限として 1 秒を採る。
 * 地方議会（sources/local/polite-fetch.ts）が既にこの値で運用できている。
 */
export const POLITENESS_FLOOR_MS = 1000;

/** 官公庁サイトの HTML・PDF・zip の取得間隔。 */
export const HTML_INTERVAL_MS = POLITENESS_FLOOR_MS;

/**
 * 国会会議録検索システム 検索用API（https://kokkai.ndl.go.jp/api.html）の取得間隔。
 * 「4. 利用条件・免責事項」に提供元自身の明示要求がある（2026-08-25 に確認）:
 *   「機械的なアクセスを行う場合、多重リクエストは避けてください。
 *     また、データを取得し終えてから数秒程度空けて次のリクエストを行うようにしてください。」
 * 「数秒程度」の下限を 2 秒と読み、HTML より長くする。#231 以前の 1 秒はこの要求を満たしていなかった。
 */
export const NDL_API_INTERVAL_MS = 2000;

/** Polite fetch with on-disk cache. Government sites are slow; never hammer them. */
export async function fetchText(url: string, encoding: "utf-8" | "shift_jis" = "utf-8", opts: { noCache?: boolean } = {}): Promise<string> {
  const text = await fetchTextOr404(url, encoding, opts);
  if (text === undefined) throw new Error(`HTTP 404 ${url}`);
  return text;
}

/**
 * fetchText と同じだが、404 だけは例外にせず undefined を返す（#103）。
 * 参院の回次ごとの議員名簿 giin/{N}/giin.htm は第216回以降しか公開されておらず（第215回以前は 404）、
 * 古い回次を処理するときに「名簿が無い」のは正常。他のステータス（5xx・timeout）は障害なので例外のまま。
 * 404 はキャッシュしない（公開されたら次回から取れる）。
 */
export async function fetchTextOr404(url: string, encoding: "utf-8" | "shift_jis" = "utf-8", opts: { noCache?: boolean } = {}): Promise<string | undefined> {
  await mkdir(CACHE_DIR, { recursive: true });
  const key = createHash("sha1").update(url).digest("hex");
  const file = new URL(`${key}.html`, CACHE_DIR);
  if (!opts.noCache) {
    try { return await readFile(file, "utf-8"); } catch { /* miss */ }
  }
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (res.status === 404) {
    await sleep(HTML_INTERVAL_MS);
    return undefined;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = encoding === "shift_jis" ? iconv.decode(buf, "Shift_JIS") : buf.toString("utf-8");
  await writeFile(file, text, "utf-8");
  await sleep(HTML_INTERVAL_MS);
  return text;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
