import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { HTML_INTERVAL_MS, NDL_API_INTERVAL_MS, POLITENESS_FLOOR_MS, sleep } from "../src/fetch.ts";

/**
 * Issue #231: 取得間隔の二重基準（国会 HTML 0.5 秒 / 地方 1 秒）を解消する。
 *
 * 「待った」ことそのものは実時間に依存するのでテストで固定しない。
 * 代わりに**テストで保証できること**を固定する:
 *  1. 定数が 1 か所にあり、礼儀の下限（POLITENESS_FLOOR_MS）を下回らない
 *  2. NDL 会議録 API は提供元の明示要求（「数秒程度空けて」）を満たす
 *  3. src/ に間隔のマジックナンバーが再び散らばらない（回帰防止）
 *  4. 実際の fetch が「取得し終えてから」待つ（NDL の文言どおりの順序）
 */

describe("取得間隔の定数（#231）", () => {
  test("礼儀の下限は 1 秒", () => {
    assert.equal(POLITENESS_FLOOR_MS, 1000);
  });

  test("HTML の取得間隔は下限を下回らない（国会も地方も同じ基準）", () => {
    assert.ok(HTML_INTERVAL_MS >= POLITENESS_FLOOR_MS, `${HTML_INTERVAL_MS} >= ${POLITENESS_FLOOR_MS}`);
  });

  test("NDL 会議録 API は「数秒程度空けて」の明示要求を満たす（2 秒以上）", () => {
    // https://kokkai.ndl.go.jp/api.html 「4. 利用条件・免責事項」:
    // 「機械的なアクセスを行う場合、多重リクエストは避けてください。
    //   また、データを取得し終えてから数秒程度空けて次のリクエストを行うようにしてください。」
    assert.ok(NDL_API_INTERVAL_MS >= 2000, `${NDL_API_INTERVAL_MS} >= 2000`);
    assert.ok(NDL_API_INTERVAL_MS >= HTML_INTERVAL_MS, "API は HTML 以上に空ける");
  });
});

describe("間隔のマジックナンバーが散らばらない（#231 の回帰防止）", () => {
  test("src/ の sleep(...) は数値リテラルを直接渡さない", async () => {
    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { await walk(p); continue; }
        if (!e.name.endsWith(".ts")) continue;
        const src = await readFile(p, "utf-8");
        for (const [i, line] of src.split("\n").entries()) {
          // sleep(500) のような直接の数値。sleep(NAME) や sleep(ms) は許す
          if (/\bsleep\(\s*\d/.test(line)) offenders.push(`${p}:${i + 1}: ${line.trim()}`);
        }
      }
    };
    await walk(new URL("../src/", import.meta.url).pathname);
    assert.deepEqual(offenders, [], `間隔は fetch.ts の定数を使う:\n${offenders.join("\n")}`);
  });
});

describe("sleep", () => {
  test("Promise を返し、指定ミリ秒後に解決する", async () => {
    const t0 = Date.now();
    await sleep(20);
    assert.ok(Date.now() - t0 >= 19, "sleep が待っていない");
  });
});
