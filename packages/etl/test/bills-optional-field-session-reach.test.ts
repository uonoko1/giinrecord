import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { BillSummary } from "@seiji-kiroku/shared";
import { DEFAULT_SESSIONS } from "../src/dataset.ts";

/**
 * **「取り込む項目を増やしたら、古い回次に遡る」を機械が言う**（Issue #1190）。
 *
 * ## 何が起きたか
 *
 * **#1136（議案の付託先を取り込む）は正しく実装され、テストも緑で、マージされた。**
 * **それでも利用者には 4 日間ほとんど出なかった。**
 *
 * **日次 ETL が取得するのは `DEFAULT_SESSIONS`（第217〜221回）だけで、
 * 他の回次は前回出力から引き継ぐ**（`carried`。#103）。
 * **`carried` は正しい設計**（部分実行で他回次を消さない）。
 * **だからこそ、取り込む項目を増やした変更は、古い回次に自動で波及しない**——
 * **引き継がれるのは「前回書いた値」であって、「いまのパーサが読める値」ではない。**
 *
 * **実測（`origin/main` = `536d1b9c` の `data/bills/index.json` 1,941 件。2026-10-04）:**
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
 * **データソースの性質ではなく、取得範囲の境界である**（取り直したら外側も埋まった。下の実測）。
 *
 * ## なぜ「人が覚えている」ではなく機械に言わせるか
 *
 * **#1136 の PBI は正しく完了していた。** 欠けていたのは「完了の後に遡る」という**手順**で、
 * **手順は人の記憶に乗っていたので 4 日間効かなかった。**
 * **実装の正しさとデータの反映は別の事象である。**
 *
 * ## なぜ「外側が 0 件」ではなく「内外の割合の差」で見るか（**実測で選んだ**）
 *
 * **「外側が 1 件も無い」だけでは #1136 を捕まえられない。**
 * **実測 2026-10-04**（`git show 5fb62347:data/bills/index.json`＝#1136 が初めて `data/` に出た
 * 2026-10-03 の refresh。**利用者にほとんど出ていなかった、まさにその状態**）:
 *
 * | 設計 | その日の判定 |
 * |---|---|
 * | 外側が 0 件なら赤 | **緑（取り逃がす）** ——外側は 0 ではなく **60 件**あった |
 * | 内外の割合が `GAP` 倍以上開いたら赤 | **赤**（内 85.5% / 外 3.9% ＝ **22.2 倍**） |
 *
 * **60 件は継続審議の議案である**——**提出回次は 216 以前だが、第217回の一覧に載るので
 * 既定回次の実行で取得される**（実測: `216-国有財産-1DDDDF6` の付託日は **2025-01-24**＝第217回の召集日）。
 * **つまり「外側」には必ず少量の取得分が混ざるので、0 件にはならない。**
 *
 * ## 閾値を選んだ根拠と、選べていないこと（**正直に書く**）
 *
 * **`GAP = 4` は判断であって実測から導いた値ではない。** 根拠は 2 つだけ:
 *   - **捕まえたい事象は 22.2 倍だった**（上の実測）。4 倍はそれより十分小さい。
 *   - **取り直した後の実測は 1.00 倍**（内 331/387 = 85.5% ／ 外 1,329/1,554 = 85.5%）。4 倍はそれより十分大きい。
 * **「4 が正しい」ことは測っていない。** **1.5 でも 10 でもこの 2 つの実測は満たす。**
 *
 * **だから閾値だけに頼らない。** **実測値そのものを `REACH` で固定する**——
 * **項目を足した PR が、ここの数を自分で書き換えることになる。**
 * **書き換えるときに「外側も取り直したか」を自分に問うことが、この検査の本当の仕事である。**
 *
 * ## **`GAP` の assert は `REACH` の重複ではない**（**変異で測った。2026-10-04**）
 *
 * **`REACH` の `deepEqual` だけで足りるように見えるが、足りない形が在る**——
 * **「赤いから数を書き換える」**（#943 が禁じている動き）**をされたときである。**
 *
 * | 変異 | 結果 | 何が落としたか |
 * |---|---|---|
 * | `data/bills/index.json` を `536d1b9c`（#1136 当時）に戻す | **1 fail** | **`GAP`**（22.2 倍を名指し） |
 * | 同上 ＋ `gap < GAP` を `gap < Infinity` に | **1 fail** | `REACH` の `deepEqual`（`outside: 60` ↔ `1329`） |
 * | 同上 ＋ **`REACH` も当時の値に書き換える** | **1 fail** | **`GAP` だけ**（`deepEqual` は一致して通る） |
 * | 同上 ＋ **`GAP` を 1000 に緩める** | **0 fail** | **誰も落とさない** |
 *
 * **3 行目がこの assert の存在理由である**——**数を合わせても、分布は合わない。**
 * **4 行目は正直に書いておく限界である**——**`GAP` を上げれば守りは消える。**
 * **だから「閾値を緩める」のではなく `gapExempt` に理由を書く形にした**（緩めた痕跡が残る）。
 *
 * **落ちなかった変異**: `present()` の `return !(Array.isArray(v) && v.length === 0);` を
 * `return true;` にしても **0 fail**。**等価変異である**——`writeDataset` は空配列を書かないので、
 * **いまの `data/` にその分岐へ届く値が 1 件も無い**（`bills/index.json` の
 * `referredCommittees` は 0 件なら欄ごと無い）。**fixture が薄いのではなく、到達しない。**
 *
 * ## この検査が言えないこと
 *
 * - **「外側が本当に少ないのが正しい項目」と区別できない。** そういう項目が将来入ったら、
 *   **`REACH` に実測値を書いて `gapExempt: true` を付けること**——
 *   **なぜ外側が少ないのかを、その PR が言葉で残す**（黙って閾値を緩めない。#943）。
 * - **`bills/index.json` の項目しか見ない。** `members/{id}.json` の timeline の種別や
 *   `bills/{session}/{id}.json` の項目は**測っていない**（この検査の対象外）。
 * - **「取り直したか」そのものは見ていない。** 見ているのは**結果の分布**である。
 *
 * ## なぜ既存の形に寄せるか（新しい監視の入口を増やさない。#1110）
 *
 * **`packages/etl/test/` から本番 `data/` を読み直す形は既に在る**
 * （`published-data-validate.test.ts` / `akita-published-data.test.ts` /
 * `local-count-mismatches.test.ts` など）。**`ci.yml` に本番データを読む step は 1 つも無い。**
 * **新しいワークフロー・新しい cron・新しい Issue の口は足さない。**
 *
 * **このファイルが走っていることの要求は `test-file-inventory.test.ts` の本数の下限が持つ**（#504）。
 */
const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));

/** `bills/index.json` に必ず在る項目（省略可能ではないので、この検査の対象にしない）。 */
const REQUIRED_FIELDS = ["house", "id", "kind", "session", "sourceUrl", "status", "title"] as const;

/**
 * **内外の割合がこの倍率以上開いたら赤**。**判断であって実測値ではない**（上の docblock）。
 * **捕まえたい事象は 22.2 倍、取り直した後は 1.00 倍。** その間に置いた。
 */
const GAP = 4;

interface Reach {
  inside: number; insideTotal: number; outside: number; outsideTotal: number;
  /** **外側が少ないことに一次資料側の理由が在る項目**。付けるときは理由をここに書くこと（黙って緩めない）。 */
  gapExempt?: true;
}

/**
 * **省略可能な項目ごとの、既定回次の内側 / 外側の実測値**（母数つき。#757）。
 *
 * **閾値ではなく「ちょうど」で固定する**——**項目を足した PR がここを書き換える。**
 *
 * **赤くなったら、まず「`data/` を取り直して値が動いた」を疑うこと。**
 * **それは正常である。** **直すのは実装ではなくこの数で、動いた内訳をコミットメッセージに書く。**
 * **「赤いから」と検査を緩めないこと**（#943）。
 */
const REACH: Record<string, Reach> = {
  // **#1190 で第200〜216回を取り直した後の実測**（取り直す前: 内 331/387・外 60/1554 ＝ 22.2 倍）。
  referredCommittees: { inside: 331, insideTotal: 387, outside: 1329, outsideTotal: 1554 },
};

/** 値が「在る」か。空配列は「無い」（`writeDataset` は空配列を書かないが、書かれても 0 件と数える）。 */
function present(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  return !(Array.isArray(v) && v.length === 0);
}

const readIndex = async (): Promise<BillSummary[]> =>
  JSON.parse(await readFile(`${DATA}bills/index.json`, "utf-8")) as BillSummary[];

test("#1190 母数: bills/index.json の省略可能な項目は REACH の表と一致する（項目を足したら、既定回次の外も取り直してこの表に足すこと）", async () => {
  const idx = await readIndex();
  assert.ok(idx.length > 0, "bills/index.json が空（0 件を見て緑になっていないこと。#757）");
  const keys = new Set<string>();
  for (const b of idx) for (const k of Object.keys(b)) keys.add(k);
  const optional = [...keys].filter((k) => !(REQUIRED_FIELDS as readonly string[]).includes(k)).sort();
  assert.deepEqual(
    optional, Object.keys(REACH).sort(),
    "bills/index.json の省略可能な項目が REACH の表と食い違っている。項目を増やしたなら、既定回次の外（216 以前）も `gh workflow run etl.yml -f sessions=\"200 … 216\"` で取り直してから、この表に実測値を足すこと（#1190 / #1136。rebuild は使わない。#284）",
  );
});

test("#1190 省略可能な項目が「既定回次の内側だけ取り込まれている」形になっていない（#1136 はこの形で 4 日間出なかった）", async () => {
  const idx = await readIndex();
  const inside = new Set(DEFAULT_SESSIONS);
  const measured: Record<string, Reach> = {};
  for (const field of Object.keys(REACH)) {
    const m: Reach = { inside: 0, insideTotal: 0, outside: 0, outsideTotal: 0 };
    for (const b of idx) {
      const has = present((b as unknown as Record<string, unknown>)[field]);
      if (inside.has(b.session)) { m.insideTotal++; if (has) m.inside++; } else { m.outsideTotal++; if (has) m.outside++; }
    }
    if (REACH[field]?.gapExempt) m.gapExempt = true;
    measured[field] = m;
  }
  // **狭い診断を先に当てる。** `assert` は最初の 1 本で止まるので、順番が「何が画面に出るか」を決める。
  // **「内側だけ取り込まれている」は #1136 の signature そのもの**なので、
  // **実測値の固定（下）より先にこれを名指しする**——「数が動いただけの赤」と読み違えないように。
  for (const [field, m] of Object.entries(measured)) {
    if (m.gapExempt) continue;
    if (m.inside === 0 || m.insideTotal === 0 || m.outsideTotal === 0) continue;
    const ri = m.inside / m.insideTotal;
    const ro = m.outside / m.outsideTotal;
    const gap = ro === 0 ? Infinity : ri / ro;
    assert.ok(
      gap < GAP,
      `bills/index.json の ${field} が、既定回次（${DEFAULT_SESSIONS.join(" ")}）の内側 ${m.inside}/${m.insideTotal} = ${(ri * 100).toFixed(1)}% に対し、外側 ${m.outside}/${m.outsideTotal} = ${(ro * 100).toFixed(1)}% しかない（${gap === Infinity ? "外側 0 件" : gap.toFixed(1) + " 倍の差"}。閾値 ${GAP} 倍）。`
      + " 取り込む項目を足したあと、既定回次の外を取り直していない形である（#1190 / #1136）。"
      + ' 遡り方: `gh workflow run etl.yml -f sessions="200 201 … 216"`（docs/ops/etl.md「取り込む項目を増やしたときの遡り」）。'
      + " **rebuild は使わないこと**（国会側の data/ を消す。#284）。"
      + " 一次資料の側に「外側は本当に少ない」理由が在るなら、REACH に gapExempt: true と理由を書くこと（黙って閾値を緩めない。#943）",
    );
  }
  assert.deepEqual(
    measured, REACH,
    "省略可能な項目の到達範囲が実測値と食い違っている。`data/` を取り直したのなら、この表を書き換えて内訳をコミットメッセージに書くこと（#1190）",
  );
});
