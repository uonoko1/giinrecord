import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "~": fileURLToPath(new URL("./app", import.meta.url)) } },
  test: { environment: "jsdom", include: ["app/**/*.test.{ts,tsx}"], setupFiles: ["./vitest.setup.ts"] },
});
