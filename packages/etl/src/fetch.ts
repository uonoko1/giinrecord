import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import iconv from "iconv-lite";

const UA = "giinrecord-etl/0.1 (+https://github.com/uonoko1/giinrecord)";
const DEFAULT_CACHE_DIR = new URL("../.cache/", import.meta.url);
/** テストだけが差し替える。本番は常に DEFAULT_CACHE_DIR（差し替え口を本番経路に出さない）。 */
let cacheDirOverride: string | undefined;
const cacheDir = (): URL => (cacheDirOverride ? new URL(`file://${cacheDirOverride}/`) : DEFAULT_CACHE_DIR);
/** テスト用。キャッシュ先を一時ディレクトリに向ける（undefined で既定に戻す）。 */
export function setCacheDirForTest(dir: string | undefined): void { cacheDirOverride = dir; }

/**
 * 作り直し（Issue #294）のときだけ、**最新回次以外**の取得をディスクキャッシュから読む。
 *
 * ## 背景
 *
 * `data/` を消してからの作り直しは 1 回の dispatch に全 22 回次を渡す必要がある
 * （`planSessions` の `carried` は前回出力から作るので、分けると 2 回目以降で前の chunk が消える。
 * `docs/ops/etl.md`）。ところが GitHub ホステッドランナーのジョブ上限は 6 時間で、
 * 作り直しは実測 359 分で張り付き完走しない。
 *
 * 従来この「繰り返せば続きから進む」は `.cache` に頼る建て付けだったが、**実際には効いていなかった**:
 * `{ noCache: true }` が会議録 API だけでなく議案・質問主意書・名簿・採決一覧にも付いており
 * （14 箇所 / 10 ファイル）、キャッシュから読まれるのは個票の投票結果ページだけだった。
 *
 * ## 「最新回次以外」で切る根拠（2026-08-26 の実測）
 *
 * `docs/research/committee-speeches.md` の 2026-08-25 実測を基準に翌日再問い合わせした結果、
 * 第200〜220回は**サンプルした 11 回次すべてで差分 0**、第221回（最新）だけが +154 だった。
 *
 * **日付では切れない**: 第221回の最新レコードの日付は 2026-02-18（半年前）で、増分は
 * 古い会議録への後からの追記・訂正である。安全に切れるのは回次の単位だけ。
 *
 * ## 既定で無効にする理由
 *
 * 上の観測は 11 回次 × 24 時間であって、過去回次が増えないことの証明ではない。
 * 日次 ETL の鮮度を 1 バイトも変えないため、**明示的に `ETL_CACHE_CLOSED_SESSIONS=1` を
 * 立てた実行だけ**有効にする（`etl.yml` は rebuild=yes の経路にだけ立てる）。
 * 発火する値は `"1"` だけで、`"true"` / `"yes"` / 前後に空白のある `" 1"` では立たない。
 */
export function cacheClosedSessionsEnabled(): boolean {
  return process.env.ETL_CACHE_CLOSED_SESSIONS === "1";
}

/**
 * この実行が知っている最新の回次（`cli.ts` の `memberSession` ＝ `meta.sessions` の最大）。
 *
 * 各 source（`fetchBills` など）は自分が扱う `session` しか知らないので、比較対象の最新回次は
 * ここに 1 度だけ置いて共有する。**未設定なら誰もキャッシュを使わない**（回次を推定しないため、
 * 設定し忘れは「キャッシュが効かない」という安全側に倒れる）。
 */
let latest: number | undefined;
export function setLatestSession(session: number | undefined): void { latest = session; }
export function latestSession(): number | undefined { return latest; }

/**
 * この取得をディスクキャッシュから読んでよいか。判定はここ 1 か所に置く。
 *
 * 真になるのは「フラグが立っていて、取得対象の回次が分かっていて、それが最新回次より古い」ときだけ。
 * 回次の分からない取得（衆院名簿のように URL に回次が無く常に「現在」を返すもの）は、
 * 古さを判定できないので**キャッシュしない**（推定しない）。
 */
export function shouldUseCache(o: { enabled: boolean; session?: number; latestSession?: number }): boolean {
  if (!o.enabled) return false;
  if (typeof o.session !== "number" || typeof o.latestSession !== "number") return false;
  return o.session < o.latestSession;
}

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

/**
 * 取得のオプション。
 * - `noCache`: 既定のディスクキャッシュを使わない（内容が更新されうるページ）。
 * - `session` / `latestSession`: 作り直し（#294）で「この取得は最新回次より古いか」を判定するための回次。
 *   両方そろっていて `ETL_CACHE_CLOSED_SESSIONS=1` のときだけ、`noCache` の取得でもキャッシュを使う。
 *   片方でも欠ければキャッシュしない（回次を推定しない）。
 */
export interface FetchOpts { noCache?: boolean; session?: number; latestSession?: number }

/** Polite fetch with on-disk cache. Government sites are slow; never hammer them. */
export async function fetchText(url: string, encoding: "utf-8" | "shift_jis" = "utf-8", opts: FetchOpts = {}): Promise<string> {
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
export async function fetchTextOr404(url: string, encoding: "utf-8" | "shift_jis" = "utf-8", opts: FetchOpts = {}): Promise<string | undefined> {
  const dir = cacheDir();
  await mkdir(dir, { recursive: true });
  const key = createHash("sha1").update(url).digest("hex");
  const file = new URL(`${key}.html`, dir);
  // 既定の経路は従来どおり: noCache が付いていれば読まない。
  // 作り直し（#294）でフラグが立っているときだけ、最新回次より古い回次の取得を例外的に読む。
  const rebuildCache = opts.noCache === true && shouldUseCache({
    enabled: cacheClosedSessionsEnabled(),
    session: opts.session,
    // 呼び出しが明示した値を優先し、無ければ実行全体の最新回次（setLatestSession）を使う
    latestSession: opts.latestSession ?? latest,
  });
  if (!opts.noCache || rebuildCache) {
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
  // 書き込みは従来どおり無条件（#294 で変えない）。noCache は「読まない」指定であって
  // 「書かない」指定ではない。ここで書き控えると、フラグ無しで走った実行の取得結果が
  // 次の作り直し（フラグ有り）から読めなくなり、前進の足を引っ張る。
  await writeFile(file, text, "utf-8");
  await sleep(HTML_INTERVAL_MS);
  return text;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
