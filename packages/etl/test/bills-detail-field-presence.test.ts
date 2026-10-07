import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Bill, BillSummary } from "@seiji-kiroku/shared";

/**
 * **個票（`data/bills/{session}/{id}.json`）の項目の存在率を、母数つきで固定する**（Issue #1266）。
 *
 * ## なぜ必要だったか（**計器が無かったので、誰も数えていなかった**）
 *
 * **2026-10-05 から 10-07 のデータ PR 3 本（#1208 / #1220 / #1222）が、
 * 1,341,426 行の差し引き減少で `stale-base-net-deletions` に止められた。**
 * **`validateDataset` は 3 回とも通った。**
 *
 * **実測（2026-10-08、PR #1222 の出力 ↔ `origin/main`、`data/bills/` 1,941 件の全数照合）:**
 *
 * ```
 * ファイル数  1,941 → 1,941     **1 件も増減していない**
 *   result   が消えた議案  18 件
 *   received が消えた議案  16 件
 *   referral が消えた議案   4 件
 * ```
 *
 * **`referral` の 4 件だけが見えていた。** `bills/index.json` の `referredCommittees` に出るので、
 * `bills-optional-field-session-reach.test.ts` が数えられたからである。
 * **そのファイルの docblock は「`bills/{session}/{id}.json` の項目は測っていない（この検査の対象外）」と
 * 自分で書いていた。** **`result` の 18 件と `received` の 16 件は、その宣言どおり測られていなかった。**
 *
 * ## `validateDataset` が通った機序（**ここが #1266 の一番の穴である**）
 *
 * **`validateDataset(dir)` は引数が `dir` だけで、前回出力を知らない。**
 * **見ているのは「いま書いた 1 つのデータセットが、それ自身で整合しているか」だけである。**
 * 個票の `result` / `received` / `referral` / `submitterNames` は **`Bill` の省略可能な項目**なので、
 * **「無い」は契約違反ではない**（閣法に提出者名が無いのと同じ形）。
 * **契約は「在るときの形」を縛るが、「前回在ったものが在り続けること」は縛らない。**
 *
 * **件数の検査では原理的に見えない**——**ファイル数は 1,941 で 1 件も動かず、
 * `bills/by-session.json` の突き合わせも `members/index.json` の `counts` も、
 * `Σ counts.rollcalls` も全部一致する。** **落ちたのは項目だけである。**
 *
 * ## この検査と `lostBillFields`（#1266 の本体）の分担
 *
 * | | 基点 | 捕まえるもの |
 * |---|---|---|
 * | `lostBillFields`（`sessions.ts`、日次 ETL の経路） | **前回出力**（`carried.bills`） | **議案 1 件でも項目が消えたら止める**。これが本体 |
 * | **このファイル** | **`PRESENCE` の実測値**（コードに刻んである） | **分布がずれたら赤**。前回出力が壊れていても効く |
 *
 * **`lostBillFields` だけでは足りない形が在る**——**前回出力そのものが既に壊れている**ときである。
 * **実際にそうなりかけた**: データ PR 3 本が止まったので `data/` は 10-04 のまま残ったが、
 * **1 本でもマージされていれば、以後の `lostBillFields` の基点は壊れた側になり、
 * 「前回も無かったので消えていない」で永久に緑になる**（[[measurement-needs-a-basepoint]]）。
 * **だから基点をコードに刻む側も要る。**
 *
 * ## 閾値を「いまの出力が通る値」に合わせないこと（#943 / [[expected-table-is-not-a-knob]]）
 *
 * **`PRESENCE` は閾値ではなく「ちょうど」の実測値である。**
 * **赤くなったら、まず「項目が本当に消えたのか」を一次資料で確かめること。**
 * **減った方向にこの表を書き換えるのは、喪失をそのまま通すことである。**
 *
 * - **増えた**（取り直し・新しい項目の取り込み）→ **表を書き換えてよい。内訳をコミットメッセージに書く。**
 * - **減った** → **まず原因を特定する。** 一次資料が本当に取り下げたと確認できたときだけ、
 *   **その確認を `docs/` か PR 本文に残して**書き換える。
 *
 * ## この検査が言えないこと（正直に書く）
 *
 * - **値が別の値に化けた分は見ていない。** 実測（`215-衆法-2`、PR #1222）:
 *   `submitterText` が `"階 猛君外六名"` → `"階 猛君外五名"`、`submitterNames` から
 *   `堤かなめ` と `馬場雄基` が落ち、`status` が `"衆議院で閉会中審査"` → `"未了"` に動いた。
 *   **項目は在るので存在率は動かない。** **「記録が出ない」より重い形**だが、
 *   **一次資料の訂正・再提出でも同じ動きをする**ので、存在率では分けられない。
 * - **どの議案で消えたかは言えない。** 分布しか見ていない（それは `lostBillFields` の仕事）。
 * - **`members/` と `rollcalls/` の項目は見ていない。** この検査は `data/bills/` だけが対象。
 *
 * ## なぜ既存の形に寄せるか（新しい監視の入口を増やさない。#1110）
 *
 * **`packages/etl/test/` から本番 `data/` を読み直す形は既に在る**
 * （`bills-optional-field-session-reach.test.ts` / `published-data-validate.test.ts` /
 * `akita-published-data.test.ts`）。**新しいワークフロー・cron・Issue の口は足さない。**
 * **このファイルが走っていることの要求は `test-file-inventory.test.ts` の本数の下限が持つ**（#504）。
 */
const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));

/**
 * **個票の項目を持っている議案の件数**（母数は `bills/index.json` の全件。#757）。
 *
 * **実測 2026-10-08、`origin/main`（`data/meta.json` の `fetchedAt` は 2026-10-04T15:45:19.099Z）。
 * 母数 1,941 件。** 数え方は `present()`（**空文字・空配列・空オブジェクトは「無い」**）。
 *
 * **`supporterNames` が 2 通りの数になることに注意**:
 * **鍵が在る議案は 540 件だが、そのうち 120 件は `[]`**（「欄はあるが賛成者が居ない」という事実。
 * `shugiin-bills.ts` の `EMPTY_IS_RECORDED`）。**ここは `present()` で数えるので 420 件である。**
 * **どちらの数を書くかを間違えると、120 件の喪失が通る。**
 */
const PRESENCE: Record<string, number> = {
  house: 1941,
  id: 1941,
  kind: 1941,
  session: 1941,
  sourceUrl: 1941,
  status: 1941,
  title: 1941,
  submitterText: 1939,
  referral: 1702,
  number: 1435,
  result: 1299,
  received: 1266,
  shugiinGroupStance: 928,
  submitterNames: 540,
  kindText: 521,
  submitterGroups: 420,
  supporterNames: 420,   // 鍵が在るのは 540 件。うち 120 件は [] なので present() では数えない
  submitters: 39,
  supporters: 29,
};

/** 母数（`bills/index.json` の件数）。**0 件を見て緑になる形を作らない**（#757）。 */
const TOTAL = 1941;

/**
 * **「この項目が全部消えても気づかない」ことが在ってはならない項目**。
 *
 * **法案ページが表示する中身そのもの**で、**#1266 で実際に落ちたもの**を名指しする。
 * **`PRESENCE` の表を書き換えて黙らせても、ここは縮まない**
 * （`guards-inventory.test.ts` の `CORE_GUARDS` と同じ形。#507 の学び）。
 *
 * **数は書かない**（#1189: 散文が現在値を語るとずれても機械が黙る）。
 * **「1 件も無い状態になっていないこと」だけを要求する。**
 */
const MUST_NOT_VANISH = ["result", "status", "sourceUrl", "submitterText", "supporterNames", "received", "referral", "submitterNames"] as const;

/** 値が「在る」か。**空文字・空配列・空オブジェクトは「無い」**（`PRESENCE` の数え方と同じ）。 */
function present(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

async function readBills(): Promise<Bill[]> {
  const idx = JSON.parse(await readFile(`${DATA}bills/index.json`, "utf-8")) as BillSummary[];
  const out: Bill[] = [];
  for (const s of idx) out.push(JSON.parse(await readFile(`${DATA}bills/${s.session}/${s.id}.json`, "utf-8")) as Bill);
  return out;
}

function count(bills: readonly Bill[]): Record<string, number> {
  const f: Record<string, number> = {};
  for (const b of bills) {
    for (const [k, v] of Object.entries(b)) {
      if (!present(v)) continue;
      f[k] = (f[k] ?? 0) + 1;
    }
  }
  return f;
}

test("#1266 母数: data/bills/ の個票が PRESENCE の件数ちょうどで項目を持っている（減った方向に表を合わせないこと）", async () => {
  const bills = await readBills();
  assert.equal(bills.length, TOTAL, `bills/index.json が ${bills.length} 件（PRESENCE は母数 ${TOTAL} 件で測っている）。母数が動いたなら PRESENCE も測り直すこと（0 件を見て緑にならないこと。#757）`);
  assert.deepEqual(
    count(bills), PRESENCE,
    "data/bills/ の個票の項目の存在率が実測値と食い違っている（#1266）。"
    + " **増えた**（取り直し・新しい項目の取り込み）なら表を書き換えて内訳をコミットメッセージに書くこと。"
    + " **減った**なら、まず一次資料で「本当に取り下げられたか」を確かめること——"
    + " #1266 では result 18 件 / received 16 件 / referral 4 件が、"
    + " 継続審議の議案の最新回次のページ（3 欄とも空）の後勝ちで消えた（#1218 / #1232）。"
    + " **ファイル数は 1,941 → 1,941 で 1 件も動かず、validateDataset も通った。**"
    + " 減った方向にこの表を合わせるのは、喪失をそのまま通すことである（#943）",
  );
});

test("#1266 核: 法案ページが表示する項目が、1 件も無い状態になっていない（PRESENCE を書き換えても縮まない）", async () => {
  const f = count(await readBills());
  for (const field of MUST_NOT_VANISH) {
    assert.ok(
      (f[field] ?? 0) > 0,
      `data/bills/ の個票で ${field} を持つ議案が 1 件も無い（#1266）。`
      + " これは法案ページが表示する中身そのもので、全部消えても件数の検査には出ない"
      + "（ファイル数も by-session.json も counts も動かない）。"
      + " PRESENCE の表を書き換えてもこの検査は縮まない（#507 / guards-inventory の CORE_GUARDS と同じ形）",
    );
  }
});
