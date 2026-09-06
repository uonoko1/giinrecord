import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect } from "vitest";
import { describeLeaks, snapshotGlobals } from "./app/test-tools/global-leak-guard";

/**
 * Issue #512: **テストファイル間でグローバルが漏れ、実行順序が変わると落ちる。**
 *
 * 見張りは**毎テストの前後**で撮る。ファイル単位（`beforeAll`/`afterAll`）にすると
 * **同じファイルの中で漏らして同じファイルの中で消す**形が素通りし、
 * かつ**どの `it` が漏らしたか**が分からない。
 *
 * `cleanup()` より**後**に撮ること——RTL が作ったコンテナは正しい後始末なので、
 * 先に撮ると全ファイルが `document.body` の差分で落ちる。
 */
let baseline: ReturnType<typeof snapshotGlobals>;

beforeEach(() => {
  baseline = snapshotGlobals();
});

afterEach(() => {
  cleanup();
  const leaks = describeLeaks(baseline, snapshotGlobals());
  expect(leaks, "テストがグローバルに状態を残した（後に走るテストファイルを落とす。#512）").toEqual([]);
});
