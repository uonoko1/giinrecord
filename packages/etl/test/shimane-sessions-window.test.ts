import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseVotePdf } from "../src/sources/local/shimane/votes-pdf.ts";
import { defaultSessionsFor } from "../src/local-assemblies.ts";

/**
 * **島根の `--sessions` の既定を決めるための実測**（Issue #901）。
 *
 * ## 島根は先行 8 県と形が違う——**止めているのは名簿ではなく「読めるか」である**
 *
 * **先行県（青森・宮城・奈良ほか）で既定を決めたのは、氏名の集合の不連続（一般選挙の境）だった。**
 * **島根ではそれが効かない。** **一次資料の側が、境より手前で先に尽きるからである:**
 *
 * | | |
 * |---|---|
 * | 会期 index（saikin ＋ gikai_kako） | **108** |
 * | **議員別採決結果一覧 PDF を持つ会期** | **14**（**2023-06 〜 2026-06**） |
 * | **15 会期目（2023-05 臨時会）** | **議員別 PDF が無い。会期ページに `h1` も無く `parseSessionPage` が落ちる** |
 * | **一般選挙（2023-04）** | **14 本すべてより手前**。`rosterAsOf` は **2023-05-17** |
 * | **14 本の議決日と `rosterAsOf` の差** | **50 〜 1,142 日**（**#928 の 1,461 日の内側。1 度も鳴らない**） |
 *
 * **つまり島根では、名簿の境と一次資料の尽きる位置がほぼ重なっている。**
 * **`unmatchedNames` / 氏名の集合で止める位置を決める余地が無い**——**14 本より先へは行けない。**
 *
 * ## 実際に止めているもの: **3 会期目（2025-11）で `parseVotePdf` が落ちる**
 *
 * **ETL は会期を新しい順に読み、1 本でも落ちると全体が止まる。**
 * **既定 2 は「2 会期しか読めない」のではなく「3 会期目で落ちる」ことの結果である。**
 */
const fixture = (name: string): Buffer => readFileSync(new URL(`./fixtures/shimane/${name}`, import.meta.url));

/* ==================== 1. 3 会期目が読めること ==================== */

/**
 * **2025-11（`r0711`）は、直す前は `付託委員会 is 4.2pt off the row centre (max 2)` で落ちていた。**
 *
 * **機序（座標で確かめた）**: **この本だけ付託委員会が中央揃えである。**
 * **`leftAlignedBoundary` は「欄の左端が揃う」前提で、左端が一番多く並ぶ x を欄の左端にする。**
 * **中央揃えだと名前の長さで左端が散る**（実測: **左端 6 通り / 中心 2 通り**）ので、
 * **一番多い左端（336.5）より左に書き出される委員会名が 62 個中 37 個**あり、
 * **それが件名の欄に落ちる。**
 */
test("#901 2025-11 は読める（直す前は 付託委員会 が中央揃えで 4.2pt ずれていた）", async () => {
  const pdf = await parseVotePdf(fixture("r0711_giinbetu_kekka.pdf"));
  assert.ok(pdf.rows.length > 0, `行数 ${pdf.rows.length}`);
  // **付託委員会が 1 行も空でない**（母数を書く。#757）
  const withReferred = pdf.rows.filter((r) => r.referredCommittees.length > 0);
  assert.equal(withReferred.length > 0, true, `付託委員会のある行 ${withReferred.length} / ${pdf.rows.length}`);
  // **件名に委員会名が混ざっていない**——件名がそのまま委員会名になっている行が無い
  const bled = pdf.rows.filter((r) => /^[^※]{2,12}(委員会|審査会)$/.test(r.title));
  assert.deepEqual(bled.map((r) => `${r.number}:${r.title}`), [], "件名が委員会名だけになっている行");
});

/* ==================== 2. 既定の値 ==================== */

test("#901 島根の --sessions の既定", () => {
  assert.equal(defaultSessionsFor("shimane"), 5);
});
