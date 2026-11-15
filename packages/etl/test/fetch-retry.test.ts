import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchTextOr404,
  setCacheDirForTest,
  setFetchDepsForTest,
  FETCH_MAX_ATTEMPTS,
  RETRY_STATUSES,
  GATEWAY_RETRY_INTERVAL_MS,
  HTML_INTERVAL_MS,
} from "../src/fetch.ts";

/**
 * Issue #1340: 日次 ETL が衆院の質問主意書の取得で 3 晩落ちた。
 *
 * ## 実測（etl.yml の `Run ETL`）
 *
 *   2026-11-11 / 11-13  `[TypeError: fetch failed] { [cause]: SocketError: other side closed }`
 *                       （例外に URL が無く、352 件のどのページで落ちたか分からない）
 *   2026-11-12          `Error: HTTP 504 https://www.shugiin.go.jp/.../keika/1DDE08A.htm`
 *
 * どちらも相手側の**一時的な**失敗で、`fetchTextOr404` が `fetch()` を 1 回しか呼ばず
 * そのまま投げていた。11/14・11/15 は通過しているので間欠的。
 *
 * ## ここで固定すること
 *
 *  1. ネットワーク層の失敗（`TypeError`）は `HTML_INTERVAL_MS` 待って再試行する（最大 3 回試す）
 *  2. HTTP 502 / 503 / 504 も再試行する（待ちは `HTML_INTERVAL_MS × 5`）
 *  3. 404 は従来どおり 1 回で undefined、他の 4xx と 500 は従来どおり 1 回で例外（再試行しない）
 *  4. 再試行し尽くしたら、URL・試行回数・cause を含む例外を投げる
 *  5. 再試行のたびに stderr に 1 行出す（黙って通さない。後で数えられるように）
 *
 * fetch と sleep は `setFetchDepsForTest` で差し替える。実ネットワークに出ず、実時間も待たない。
 */

const URL_Q = "https://www.shugiin.go.jp/internet/itdb_shitsumon.nsf/html/shitsumon/a217001.htm";

/** fetch の台本。要素が Error なら throw、Response なら返す。 */
type Step = Response | Error;
const ok = (body: string) => new Response(body, { status: 200 });
const status = (s: number) => new Response("", { status: s });
const socketClosed = (): TypeError => {
  // Node の undici が出す形をそのまま真似る: TypeError("fetch failed") に cause として SocketError。
  const cause = Object.assign(new Error("other side closed"), { name: "SocketError", code: "UND_ERR_SOCKET" });
  return new TypeError("fetch failed", { cause });
};

let dir: string;
let calls: string[];
let sleeps: number[];
let stderrLines: string[];
let script: Step[];
const originalWrite = process.stderr.write;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "etl-fetch-retry-"));
  setCacheDirForTest(dir);
  calls = [];
  sleeps = [];
  stderrLines = [];
  script = [];
  setFetchDepsForTest({
    fetch: (async (url: string | URL | Request) => {
      calls.push(String(url));
      const step = script.shift();
      if (step === undefined) throw new Error(`台本が尽きた（${calls.length} 回目の fetch）`);
      if (step instanceof Error) throw step;
      return step;
    }) as typeof fetch,
    sleep: async (ms: number) => { sleeps.push(ms); },
  });
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrLines.push(String(chunk).replace(/\n$/, ""));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(async () => {
  process.stderr.write = originalWrite;
  setFetchDepsForTest(undefined);
  setCacheDirForTest(undefined);
  await rm(dir, { recursive: true, force: true });
});

const run = () => fetchTextOr404(URL_Q, "utf-8", { noCache: true });
const retryLines = () => stderrLines.filter((l) => l.startsWith("fetch: retry "));

describe("再試行の回数の定数（#1340）", () => {
  test("最大 3 回試す（= 再試行 2 回）", () => {
    assert.equal(FETCH_MAX_ATTEMPTS, 3);
  });
  test("再試行する HTTP ステータスは 502 / 503 / 504 だけ", () => {
    assert.deepEqual([...RETRY_STATUSES].sort(), [502, 503, 504]);
  });
  test("5xx の待ちは接続切断より長い（HTML_INTERVAL_MS × 5）", () => {
    assert.equal(GATEWAY_RETRY_INTERVAL_MS, HTML_INTERVAL_MS * 5);
  });
});

describe("ネットワーク層の失敗（TypeError: fetch failed）", () => {
  test("1 回目 TypeError → 2 回目 200: 本文が返り、stderr に retry 行が 1 本", async () => {
    script = [socketClosed(), ok("<html>q1</html>")];
    assert.equal(await run(), "<html>q1</html>");
    assert.equal(calls.length, 2, "fetch は 2 回呼ばれる");
    const lines = retryLines();
    assert.equal(lines.length, 1, `retry 行は 1 本:\n${stderrLines.join("\n")}`);
    assert.match(lines[0]!, /^fetch: retry 1\/2 /, "何回目か/最大何回かが分かる形");
    assert.ok(lines[0]!.includes(URL_Q), `URL が入る: ${lines[0]}`);
    assert.ok(lines[0]!.includes("other side closed"), `理由（cause）が入る: ${lines[0]}`);
  });

  test("再試行の前に HTML_INTERVAL_MS 待つ", async () => {
    script = [socketClosed(), ok("x")];
    await run();
    // 1 回目: 再試行前の待ち、2 回目: 成功後の礼儀の待ち（従来どおり）
    assert.deepEqual(sleeps, [HTML_INTERVAL_MS, HTML_INTERVAL_MS]);
  });

  test("3 回とも TypeError: 例外。URL・試行回数・cause が入り、retry 行は 2 本", async () => {
    script = [socketClosed(), socketClosed(), socketClosed()];
    await assert.rejects(run, (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.ok(!(e instanceof TypeError), "素の TypeError のまま投げない（URL を付ける）");
      assert.ok(e.message.includes(URL_Q), `URL が入る: ${e.message}`);
      assert.ok(/\b3\b/.test(e.message), `試行回数 3 が入る: ${e.message}`);
      assert.ok(e.message.includes("other side closed"), `cause の内容が入る: ${e.message}`);
      assert.ok(e.cause instanceof TypeError, "cause に元の TypeError を残す");
      return true;
    });
    assert.equal(calls.length, 3, "fetch は 3 回で諦める");
    assert.equal(retryLines().length, 2);
    assert.match(retryLines()[1]!, /^fetch: retry 2\/2 /);
  });

  test("TypeError 以外の例外（AbortError など）は再試行しない（1 回で URL 付きの例外）", async () => {
    script = [Object.assign(new Error("This operation was aborted"), { name: "AbortError" })];
    await assert.rejects(run, (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.ok(e.message.includes(URL_Q), `URL が入る: ${e.message}`);
      assert.ok(e.message.includes("This operation was aborted"), `元の内容が入る: ${e.message}`);
      return true;
    });
    assert.equal(calls.length, 1);
    assert.equal(retryLines().length, 0);
  });
});

describe("HTTP 5xx のうち一時的なもの（502 / 503 / 504）", () => {
  test("1 回目 504 → 2 回目 200: 本文が返る。待ちは GATEWAY_RETRY_INTERVAL_MS", async () => {
    script = [status(504), ok("<html>keika</html>")];
    assert.equal(await run(), "<html>keika</html>");
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [GATEWAY_RETRY_INTERVAL_MS, HTML_INTERVAL_MS]);
    const lines = retryLines();
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.includes("504"), `理由にステータスが入る: ${lines[0]}`);
    assert.ok(lines[0]!.includes(URL_Q));
  });

  test("3 回とも 504: 従来どおり `HTTP 504 <url>` を含む例外。fetch は 3 回", async () => {
    script = [status(504), status(504), status(504)];
    await assert.rejects(run, new RegExp(`HTTP 504 ${URL_Q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.equal(calls.length, 3);
    assert.equal(retryLines().length, 2);
  });

  for (const s of [502, 503]) {
    test(`${s} も再試行する（1 回目 ${s} → 2 回目 200）`, async () => {
      script = [status(s), ok("b")];
      assert.equal(await run(), "b");
      assert.equal(calls.length, 2);
    });
  }
});

describe("再試行しないもの（従来どおり）", () => {
  test("500 は 1 回で例外（相手のバグは繰り返しても変わらない）", async () => {
    script = [status(500)];
    await assert.rejects(run, /HTTP 500/);
    assert.equal(calls.length, 1, "fetch は 1 回だけ");
    assert.equal(retryLines().length, 0, "retry 行を出さない");
    assert.deepEqual(sleeps, [], "待たない");
  });

  test("404 は 1 回で undefined", async () => {
    script = [status(404)];
    assert.equal(await run(), undefined);
    assert.equal(calls.length, 1);
    assert.equal(retryLines().length, 0);
  });

  test("403 は 1 回で例外", async () => {
    script = [status(403)];
    await assert.rejects(run, /HTTP 403/);
    assert.equal(calls.length, 1);
  });

  test("1 回目で 200 なら retry 行は出ない", async () => {
    script = [ok("fine")];
    assert.equal(await run(), "fine");
    assert.equal(calls.length, 1);
    assert.equal(retryLines().length, 0);
  });
});

describe("差し替え口", () => {
  test("fetch を渡さなければ globalThis.fetch を使う（既存テストの差し替え方を壊さない）", async () => {
    // sleep だけ差し替え、fetch は未指定 → globalThis.fetch に戻る（実時間は待たない）
    setFetchDepsForTest({ sleep: async (ms: number) => { sleeps.push(ms); } });
    const originalFetch = globalThis.fetch;
    let seen = 0;
    globalThis.fetch = (async () => { seen++; return ok("g"); }) as typeof fetch;
    try {
      assert.equal(await run(), "g");
      assert.equal(seen, 1);
      assert.equal(calls.length, 0, "台本の fetch は呼ばれない");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
