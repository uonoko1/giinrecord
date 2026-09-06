/**
 * 見本を走らせるための設定（#512）。**本番の `vitest.config.ts` をそのまま読み込んで、
 * `include` だけ差し替える**。設定を書き写すと、`setupFiles` が本番と違っても気づけない
 * （＝見張りを外した設定で「見張りが効いた」と言えてしまう）。
 *
 * `global-leak-guard.e2e.test.ts` が、この設定と本番の設定で
 * `setupFiles` が同一であることを実際に import して照合している。
 *
 * **等価変異として記録**（#512 の変異 G9）: ここに `setupFiles: []` を足しても
 * 見張りは死なない。`mergeConfig` は**配列を連結する**ので、
 * 本番の `setupFiles` はそのまま残る（実測で見本は落ち続けた）。
 * 見張りを外すには `mergeConfig` をやめて設定を作り直す必要があり、
 * それは G10 / G11 として**上の照合が 2 件落とす**。
 */
import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../../vitest.config";

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ["app/test-tools/leak-fixtures/*.fixture.ts"],
    },
  }),
);
