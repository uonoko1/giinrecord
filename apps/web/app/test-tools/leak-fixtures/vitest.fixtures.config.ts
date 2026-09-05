/**
 * 見本を走らせるための設定（#512）。**本番の `vitest.config.ts` をそのまま読み込んで、
 * `include` だけ差し替える**。設定を書き写すと、`setupFiles` が本番と違っても気づけない
 * （＝見張りを外した設定で「見張りが効いた」と言えてしまう）。
 *
 * `global-leak-guard.e2e.test.ts` が、この設定と本番の設定で
 * `setupFiles` が同一であることを実際に import して照合している。
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
