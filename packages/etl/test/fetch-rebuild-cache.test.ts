import { test, describe, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchText, cacheClosedSessionsEnabled, shouldUseCache, setCacheDirForTest, setLatestSession, latestSession } from "../src/fetch.ts";

/**
 * Issue #294: `data/` を消してからの作り直しを、繰り返す dispatch で前進させる。
 *
 * ## なぜ必要か（実装を読んで分かった事実）
 *
 * `docs/ops/etl.md` は「同じ dispatch をもう一度流せば取得済みページはキャッシュから読むので
 * 続きから進む」と書いていたが、**作業量の大半についてこれは事実ではなかった**。
 * `{ noCache: true }` は会議録 API だけでなく、前段の議案・質問主意書・名簿・採決一覧にも
 * 付いており（14 箇所 / 10 ファイル）、キャッシュから読まれるのは個票の投票結果ページだけだった。
 * つまり作り直しは毎回ゼロから取り直しになり、6 時間の上限に何度当てても前進しない。
 *
 * ## なぜ「最新回次以外」で切るのか（2026-08-26 の実測）
 *
 * `docs/research/committee-speeches.md` の 2026-08-25 実測（全 22 回次の `numberOfRecords`）を
 * 基準に、翌 2026-08-26T13:46Z に同じ API へ問い合わせて差分を見た
 * （UA は `fetch.ts` と同じ、間隔 3 秒、計 15 リクエスト）:
 *
 *   第200・202・205・208・213・214・216・217・218・219・220回（参院）… **11 回次すべて差分 0**
 *   第221回（参院）… 37,164 → **37,318（+154）**。再問い合わせでも 37,318 で安定。
 *   `sessionFrom=222` は 0 件 ＝ 第221回が現時点の最新回次。
 *
 * **日付で切ってはいけない**: 第221回の最新レコードの日付は 2026-02-18（半年前）だった。
 * 増分は「最近開かれた会議が公開された」のではなく、**古い会議録への後からの追記・訂正**である。
 * したがって安全に切れるのは**回次の単位だけ**で、「日付が古いからキャッシュしてよい」は成り立たない。
 *
 * ## 保証しないこと（実態より強く書かない）
 *
 * - 上記は 11 回次 × 24 時間の観測であって、過去回次が未来永劫増えないことの証明ではない。
 *   だからこそ既定では無効にし、**明示フラグを立てた実行だけ**キャッシュを使う。
 * - 1 回目の実行が完走できるようにはならない（キャッシュが空だから）。
 *   解けるのは「2 回目以降が確実に前進すること」だけである。
 */

const original = globalThis.fetch;
const originalEnv = process.env.ETL_CACHE_CLOSED_SESSIONS;

let dir: string;
let calls: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "etl-cache-test-"));
  setCacheDirForTest(dir);
  calls = [];
  globalThis.fetch = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(`body for ${String(url)}`, { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = original;
  setCacheDirForTest(undefined);
  setLatestSession(undefined);
  if (originalEnv === undefined) delete process.env.ETL_CACHE_CLOSED_SESSIONS;
  else process.env.ETL_CACHE_CLOSED_SESSIONS = originalEnv;
  await rm(dir, { recursive: true, force: true });
});

const URL_A = "https://example.invalid/a";

describe("フラグが無いときは現状と同じ（最重要の回帰防止）", () => {
  test("既定では cacheClosedSessionsEnabled が false", () => {
    delete process.env.ETL_CACHE_CLOSED_SESSIONS;
    assert.equal(cacheClosedSessionsEnabled(), false);
  });

  test('"1" 以外の値では発火しない（true / yes / 空 でも立たない）', () => {
    for (const v of ["", "0", "true", "yes", "YES", " 1", "1 "]) {
      process.env.ETL_CACHE_CLOSED_SESSIONS = v;
      assert.equal(cacheClosedSessionsEnabled(), false, `[${v}] で発火してはいけない`);
    }
  });

  test("フラグが無ければ session を渡しても毎回取得する（日次 ETL の鮮度を変えない）", async () => {
    delete process.env.ETL_CACHE_CLOSED_SESSIONS;
    await fetchText(URL_A, "utf-8", { noCache: true, session: 200, latestSession: 221 });
    await fetchText(URL_A, "utf-8", { noCache: true, session: 200, latestSession: 221 });
    assert.equal(calls.length, 2, "フラグ無しでキャッシュが効いてしまっている");
  });

  test("書き込みは従来どおり無条件（noCache は「読まない」であって「書かない」ではない）", async () => {
    // #294 で変えていないことの固定。ここで書き控えると、フラグ無しで走った実行の取得結果が
    // 次の作り直し（フラグ有り）から読めなくなる。
    delete process.env.ETL_CACHE_CLOSED_SESSIONS;
    await fetchText(URL_A, "utf-8", { noCache: true, session: 200, latestSession: 221 });
    assert.equal((await readdir(dir)).length, 1, "noCache の取得がキャッシュに書かれていない（従来の挙動が変わった）");
  });
});

describe("フラグを立てたとき：過去回次だけキャッシュする", () => {
  beforeEach(() => { process.env.ETL_CACHE_CLOSED_SESSIONS = "1"; });

  test("過去回次（session < latestSession）は 2 回目がキャッシュから返る", async () => {
    const first = await fetchText(URL_A, "utf-8", { noCache: true, session: 200, latestSession: 221 });
    const second = await fetchText(URL_A, "utf-8", { noCache: true, session: 200, latestSession: 221 });
    assert.equal(calls.length, 1, "過去回次がキャッシュされていない");
    assert.equal(second, first, "キャッシュの中身が元と違う");
  });

  test("最新回次（session === latestSession）は毎回取得する（+154 の追記を取り逃さない）", async () => {
    await fetchText(URL_A, "utf-8", { noCache: true, session: 221, latestSession: 221 });
    await fetchText(URL_A, "utf-8", { noCache: true, session: 221, latestSession: 221 });
    assert.equal(calls.length, 2, "最新回次をキャッシュしてはいけない");
  });

  test("session を持たない取得（衆院名簿など「現在」の情報）は毎回取得する", async () => {
    // 衆院名簿は回次が URL に無く常に「現在」を返す。回次で古さを判定できないのでキャッシュしない。
    await fetchText(URL_A, "utf-8", { noCache: true, latestSession: 221 });
    await fetchText(URL_A, "utf-8", { noCache: true, latestSession: 221 });
    assert.equal(calls.length, 2, "回次不明の取得をキャッシュしてはいけない");
  });

  test("latestSession が不明なら（回次を比較できない）毎回取得する", async () => {
    await fetchText(URL_A, "utf-8", { noCache: true, session: 200 });
    await fetchText(URL_A, "utf-8", { noCache: true, session: 200 });
    assert.equal(calls.length, 2, "最新回次が不明なのにキャッシュしてはいけない");
  });
});

describe("shouldUseCache（判定を 1 か所に置く）", () => {
  test("真理値表", () => {
    const on = { enabled: true };
    // 過去回次だけが true
    assert.equal(shouldUseCache({ ...on, session: 200, latestSession: 221 }), true);
    assert.equal(shouldUseCache({ ...on, session: 220, latestSession: 221 }), true);
    // 最新回次・未来の回次は false
    assert.equal(shouldUseCache({ ...on, session: 221, latestSession: 221 }), false);
    assert.equal(shouldUseCache({ ...on, session: 222, latestSession: 221 }), false);
    // 回次が分からなければ false
    assert.equal(shouldUseCache({ ...on, latestSession: 221 }), false);
    assert.equal(shouldUseCache({ ...on, session: 200 }), false);
    // フラグが無ければ何があっても false
    assert.equal(shouldUseCache({ enabled: false, session: 200, latestSession: 221 }), false);
  });
});

describe("latestSession（最新回次を 1 か所に持つ）", () => {
  test("既定では未設定（回次を推定しない）", () => {
    setLatestSession(undefined);
    assert.equal(latestSession(), undefined);
  });

  test("設定すると、呼び出し側が latestSession を渡さなくても判定に使われる", async () => {
    process.env.ETL_CACHE_CLOSED_SESSIONS = "1";
    setLatestSession(221);
    // 各 source は session だけを渡す（latestSession は cli が 1 回設定する）
    await fetchText(URL_A, "utf-8", { noCache: true, session: 200 });
    await fetchText(URL_A, "utf-8", { noCache: true, session: 200 });
    assert.equal(calls.length, 1, "設定した最新回次が使われていない");
  });

  test("設定しても最新回次そのものはキャッシュしない", async () => {
    process.env.ETL_CACHE_CLOSED_SESSIONS = "1";
    setLatestSession(221);
    await fetchText(URL_A, "utf-8", { noCache: true, session: 221 });
    await fetchText(URL_A, "utf-8", { noCache: true, session: 221 });
    assert.equal(calls.length, 2);
  });

  test("明示的に渡された latestSession が、設定値より優先される", async () => {
    process.env.ETL_CACHE_CLOSED_SESSIONS = "1";
    setLatestSession(221);
    await fetchText(URL_A, "utf-8", { noCache: true, session: 200, latestSession: 200 });
    await fetchText(URL_A, "utf-8", { noCache: true, session: 200, latestSession: 200 });
    assert.equal(calls.length, 2, "明示の latestSession=200 なら session 200 は最新なのでキャッシュしない");
  });
});

describe("回次を渡し忘れない（#294 の回帰防止）", () => {
  /**
   * 作り直しのキャッシュは `session` が渡って初めて効く。渡し忘れると「毎回取り直す」に
   * 静かに戻り、6 時間の run が前進しなくなる（症状が出るのは本番の作り直しのときだけで、
   * テストでは気づけない）。**回次を引数に持つ source は必ず session を渡す**ことを固定する。
   *
   * 例外は衆院名簿（`shugiin-members.ts`）だけ。URL に回次が無く常に「現在」を返すので、
   * 回次で古さを判定できない（下の allowlist）。
   */
  test("session を引数に持つ source の noCache 取得は session を渡している", async () => {
    const dirUrl = new URL("../src/sources/", import.meta.url);
    const offenders: string[] = [];
    // 回次で古さを判定できないファイル（理由はコード中のコメント）
    const allowlist = new Set(["shugiin-members.ts"]);
    for (const name of await readdir(dirUrl)) {
      if (!name.endsWith(".ts") || allowlist.has(name)) continue;
      const src = await readFile(new URL(name, dirUrl), "utf-8");
      // その関数が session を引数に持たないファイルは対象外（地方議会など）
      if (!/\bsession: number\b/.test(src)) continue;
      for (const [i, line] of src.split("\n").entries()) {
        if (!/noCache:\s*true/.test(line)) continue;
        // `${session}` のような URL 中の埋め込みを「渡した」と誤認しないよう、
        // noCache が入っているオプションオブジェクト `{ ... }` の中だけを見る。
        const optsObj = line.match(/\{[^{}]*noCache:\s*true[^{}]*\}/)?.[0] ?? "";
        if (/\bsession\b/.test(optsObj)) continue; // session を渡している
        offenders.push(`${name}:${i + 1}: ${line.trim()}`);
      }
    }
    assert.deepEqual(offenders, [], `noCache の取得に session を渡すこと（#294）:\n${offenders.join("\n")}`);
  });
});
