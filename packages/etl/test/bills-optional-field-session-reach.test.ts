import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { BillSummary } from "@seiji-kiroku/shared";
import { DEFAULT_SESSIONS } from "../src/dataset.ts";

/**
 * **「取り込む項目を増やしたら、古い回次に遡る」を機械が言う**（Issue #1190）。
 *
 * ## 何が起きたか（#1136 の実測）
 *
 * **#1136（議案の付託先を取り込む）は正しく実装され、テストも緑で、マージされた。**
 * **それでも利用者には 4 日間ほとんど出なかった。**
 *
 * **日次 ETL が取得するのは `DEFAULT_SESSIONS`（第217〜221回）だけで、
 * 他の回次は前回出力から引き継ぐ**（`carried`。#103）。
 * **`carried` は正しい設計**（部分実行で他回次を消さない）。
 * **だからこそ、取り込む項目を増やした変更は、古い回次に自動で波及しない**——
 * 引き継がれるのは「前回書いた値」であって、「今のパーサが読める値」ではない。
 *
 * **実測（`origin/main` = `536d1b9c`、2026-10-04T08:30Z。`data/bills/index.json` の 1,941 件）:**
 *
 * ```
 *                  内側（217-221）     外側（216 以前）
 * 閣法          133 / 133  100.0%       0 /  374   0.0%
 * 条約           25 /  25  100.0%       0 /   61   0.0%
 * 衆法          111 / 124   89.5%      14 /  369   3.8%
 * 参法            7 /  41   17.1%       0 /  196   0.0%
 * 合計          331 / 387   85.5%      60 / 1,554  3.9%
 * ```
 *
 * **閣法は内側 100%・外側 0%。境界が回次と完全に一致している**——
 * **データソースの性質ではなく、取得範囲の境界である。**
 *
 * ## なぜ「人が覚えている」ではなく機械に言わせるか
 *
 * **#1136 の PBI は正しく完了していた。** 欠けていたのは「完了の後に遡る」という**手順**で、
 * **手順は人の記憶に乗っていたので、4 日間効かなかった。**
 * **実装の正しさとデータの反映は別の事象である。**
 *
 * ## なぜ既存の形に寄せるか（新しい監視の入口を増やさない。#1110）
 *
 * **`packages/etl/test/` から本番 `data/` を読み直す形は既に在る**
 * （`published-data-validate.test.ts` / `akita-published-data.test.ts` /
 * `local-count-mismatches.test.ts` など）。**`ci.yml` に本番データを読む step は 1 つも無い。**
 * **新しいワークフロー・新しい cron・新しい Issue の口は足さない。**
 *
 * **このファイルが走っていることの要求は `test-file-inventory.test.ts` の本数の下限が持つ**（#504）。
 *
 * ## この検査が言えること・言えないこと
 *
 * **言えること**: **`bills/index.json` の省略可能な項目が、既定回次の内側には在るのに
 * 外側には不釣り合いに少ない**という形を名指しする。**次の #1136 がこれで赤くなる。**
 *
 * **言えないこと**:
 * - **「外側が本当に 0 であるべき項目」と区別できない。** だから**閾値ではなく実測値で固定する**——
 *   **項目を足した PR が、ここの数を自分で書き換えることになる**（`CORPUS` と同じ約束）。
 *   **書き換えるときに「外側も取り直したか」を自分に問うことが、この検査の仕事である。**
 * - **`bills/index.json` の項目しか見ない。** `members/` や `bills/{session}/{id}.json` の
 *   項目は見ていない（**測っていない**）。
 */
const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));

/** `bills/index.json` で必ず在る項目（省略可能ではないので、この検査の対象にしない）。 */
const REQUIRED_FIELDS = ["house", "id", "kind", "session", "sourceUrl", "status", "title"] as const;

/**
 * **省略可能な項目ごとの、既定回次の内側 / 外側の実測値**（母数つき。#757）。
 *
 * **閾値ではなく「ちょうど」で固定する**——**項目を足した PR がここを書き換える。**
 * **書き換えるときに「既定回次の外も取り直したか」を問われるのが、この表の目的である。**
 *
 * **赤くなったら、まず「`data/` を取り直して値が動いた」を疑うこと。**
 * **それは正常である**（取り直せば増える）。**直すのは実装ではなくこの数で、
 * 動いた内訳をコミットメッセージに書く。** **「赤いから」と検査を緩めないこと**（#943）。
 */
const REACH = {
  referredCommittees: { inside: 331, insideTotal: 387, outside: 60, outsideTotal: 1554 },
} as Record<string, { inside: number; insideTotal: number; outside: number; outsideTotal: number }>;

/** 値が「在る」か。空配列は「無い」（`writeDataset` は空配列を書かないが、書かれても 0 件と数える）。 */
function present(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  return !(Array.isArray(v) && v.length === 0);
}

test("#1190 母数: bills/index.json の省略可能な項目は referredCommittees だけ（増えたらこの表に足して、既定回次の外も取り直すこと）", async () => {
  const idx = JSON.parse(await readFile(`${DATA}bills/index.json`, "utf-8")) as BillSummary[];
  const keys = new Set<string>();
  for (const b of idx) for (const k of Object.keys(b)) keys.add(k);
  const optional = [...keys].filter((k) => !(REQUIRED_FIELDS as readonly string[]).includes(k)).sort();
  assert.deepEqual(optional, Object.keys(REACH).sort(), "bills/index.json の省略可能な項目が REACH の表と食い違っている（項目を足したら、既定回次の外も取り直してこの表に足すこと。#1190）");
});

test("#1190 bills/index.json の省略可能な項目が、既定回次の内側だけに在る形になっていない（#1136 は 4 日間この形だった）", async () => {
  const idx = JSON.parse(await readFile(`${DATA}bills/index.json`, "utf-8")) as BillSummary[];
  const inside = new Set(DEFAULT_SESSIONS);
  const measured: Record<string, { inside: number; insideTotal: number; outside: number; outsideTotal: number }> = {};
  for (const field of Object.keys(REACH)) {
    const m = { inside: 0, insideTotal: 0, outside: 0, outsideTotal: 0 };
    for (const b of idx) {
      const has = present((b as unknown as Record<string, unknown>)[field]);
      if (inside.has(b.session)) { m.insideTotal++; if (has) m.inside++; } else { m.outsideTotal++; if (has) m.outside++; }
    }
    measured[field] = m;
  }
  // **狭い診断を先に当てる**（`assert` は最初の 1 本で止まる）。
  // **「内側に在るのに外側が 1 件も無い」は #1136 の signature そのもの**で、
  // **実測値の固定より先にこれを名指しする**——数が動いただけの赤と区別がつくように。
  for (const [field, m] of Object.entries(measured)) {
    if (m.inside === 0) continue;
    assert.notEqual(
      m.outside, 0,
      `bills/index.json の ${field} が既定回次（${[...inside].join(" ")}）の内側に ${m.inside}/${m.insideTotal} 件在るのに、外側 ${m.outsideTotal} 件には 1 件も無い。取り込む項目を足したあと、既定回次の外を取り直していない形である（#1190 / #1136。gh workflow run etl.yml -f sessions="…" で遡る。rebuild は使わない）`,
    );
  }
  assert.deepEqual(measured, REACH, "省略可能な項目の到達範囲が実測値と食い違っている（data/ を取り直したなら、この表を書き換えて内訳をコミットメッセージに書くこと。#1190）");
});
