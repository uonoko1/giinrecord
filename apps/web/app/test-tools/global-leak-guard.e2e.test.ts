// @vitest-environment node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * **見張りが本当に配線されているか**を、外側から確かめる（Issue #512）。
 *
 * ## なぜ別ファイルで、別プロセスなのか
 *
 * `global-leak-guard.test.ts` は `describeDrift` を**直に呼んで**検査している。
 * それだけでは、`installGlobalLeakGuard` の `afterEach` の中の
 *
 *     expect(drift, HINT).toEqual([]);
 *
 * を **`void drift;` に変えるだけで見張りが完全に死ぬ**のに気づけない。
 * 実測（#512 の変異 G3'）: その 1 行を変えたうえで `PoliciesSection.test.tsx` の
 * 後始末を `origin/main` の形に戻すと、**3 ファイル 30 テストが全部緑**になった。
 * **差分 2 行で、本物の漏れが素通りする。**
 *
 * 同じファイルの中に仕掛けを置くと、そのファイルごと消せば黙る（作業合意の
 * 「検査コードそのものを削除する」型）。だから**レイヤを 1 つ上げて**、
 * **本番と同じ `vitest.config.ts` で vitest を別プロセスに起動し、
 * わざと漏らす見本が「落ちる」ことを結果で見る。**
 *
 * ## 対照を両方置く
 *
 * 落ちる見本（`leaky.fixture.ts`）だけだと、「何をやっても落ちる見張り」でも通ってしまう。
 * 落ちない見本（`clean.fixture.ts`）を並べて、**通すべきものが通る**ことも見る（#484）。
 */
const webRoot = path.resolve(fileURLToPath(import.meta.url), "../../.."); // app/test-tools/x.test.ts → apps/web
const fixtureDir = "app/test-tools/leak-fixtures";
const fixtureConfig = `${fixtureDir}/vitest.fixtures.config.ts`;

/**
 * 本番の `vitest.config.ts` を継いだ設定（`include` だけ差し替え）で、見本 1 ファイルだけを走らせる。
 * 見本は `*.fixture.ts` なので、本体の `include`（`app/**\/*.test.{ts,tsx}`）には入らない。
 */
function runFixture(name: string): { status: number; output: string } {
  const r = spawnSync(
    "npx",
    ["vitest", "run", "-c", fixtureConfig, "--reporter=basic", "--pool=forks", "--poolOptions.forks.singleFork", `${fixtureDir}/${name}`],
    { cwd: webRoot, encoding: "utf8", env: { ...process.env, CI: "1" }, timeout: 180_000 },
  );
  return { status: r.status ?? -1, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "") };
}

describe("見張りの配線（#512）", () => {
  it(
    "わざと漏らす見本は落ちる（見張りが afterEach で本当に判定している証明）",
    () => {
      const { status, output } = runFixture("leaky.fixture.ts");
      // 見本のテスト本体（`expect(1).toBe(1)`）は通る。落とすのは見張りだけ
      expect(output, "見本が vitest に拾われていない（include / パスを確認）").toContain(`${fixtureDir}/leaky.fixture.ts`);
      expect(output, "見本が 1 件も走っていない").toMatch(/Tests\s+1 failed \(1\)/);
      expect(output, "落ちた理由が見張りではない。見張りのメッセージが出ていない").toContain("後始末していないグローバル状態");
      expect(output).toContain("window に増えた: __giinrecordInstallPrompt");
      expect(status, `終了コードが 0（＝見張りが黙っている）。出力:\n${output.slice(-2000)}`).not.toBe(0);
    },
    240_000,
  );

  /*
   * **見本を走らせる設定が、本番と同じ `setupFiles` を使っていること。**
   * ここを確かめないと、上の 2 件は「見張りの入っていない設定」でも成立しうる
   * （落ちる側は別の理由で落ち、通る側はそもそも見張りが無いから通る）。
   * 設定を書き写さず `mergeConfig` で継いでいるので、**値そのものを突き合わせる**。
   */
  it("見本の設定は、本番と同じ setupFiles を使っている", async () => {
    const [base, fixture] = await Promise.all([import("../../vitest.config"), import("./leak-fixtures/vitest.fixtures.config")]);
    const setupOf = (c: unknown) => (c as { test?: { setupFiles?: unknown } }).test?.setupFiles;
    expect(setupOf(base.default), "本番の vitest.config.ts に setupFiles が無い").toBeDefined();
    expect(setupOf(fixture.default)).toEqual(setupOf(base.default));
    // その setupFiles が見張りを設置していること（別経路で入れ替えられたら落ちる）
    const { readFileSync } = await import("node:fs");
    const files = setupOf(base.default) as string[];
    const joined = files.map((f) => readFileSync(path.resolve(webRoot, f), "utf8")).join("\n");
    expect(joined, "setupFiles のどれも installGlobalLeakGuard を呼んでいない").toContain("installGlobalLeakGuard(cleanup)");
  });

  it(
    "漏らさない見本は通る（見張りが厳しすぎて正しいテストを落としていない）",
    () => {
      const { status, output } = runFixture("clean.fixture.ts");
      expect(output, "見本が vitest に拾われていない").toContain(`${fixtureDir}/clean.fixture.ts`);
      expect(output, "見本が 1 件も走っていない").toMatch(/Tests\s+1 passed \(1\)/);
      expect(status, `後始末しているのに落ちた。出力:\n${output.slice(-2000)}`).toBe(0);
    },
    240_000,
  );
});
