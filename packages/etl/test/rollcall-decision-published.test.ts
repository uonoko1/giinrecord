import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RollCallSummary } from "@seiji-kiroku/shared";
import { decisionOfResult, lostDecisions } from "../src/sessions.ts";

/**
 * **公開されている `data/rollcalls/index.json` から、判定の語が減っていないか**（Issue #1206）。
 *
 * ## これは何を守る検査か
 *
 * 採決の判定の語（可決・否決・同意・承認・是認・承諾・修正・除名）は**投票結果ページに無い**（#26）。
 * 参院 議案情報の審議結果を**案件名の完全一致**で突合して付けている。だから突合が外れると、
 * 票数（`賛成 244・反対 0`）だけが残り、**判定の語が黙って消える**。
 *
 * **語が残っている場所は `data/rollcalls/index.json` だけである**（実測 2026-10-05）:
 *
 * ```
 * 個票 data/rollcalls/209/209-1128-v010.json のキー
 *   date / groups / id / session / sourceUrl / title / totals / votes   ← result が無い
 * 先頭 40 件の個票で result を持つもの: 0 / 40
 * 参院 議案情報: data/ に永続化していない（data/bills/ は衆院 議案情報。別の出典）
 * ```
 *
 * **消えたら取り戻せない。** だから「減っていないこと」を検査する。
 *
 * ## なぜ遡りを流さずに捕まえられるのか（受け入れ条件 3）
 *
 * **遡り（`pnpm etl 200 … 216`）は CI で流せない**——冷えたキャッシュで 349 分、`Run ETL` 単体で 330 分（#1209）。
 * **だから「遡りを再現する」のではなく「遡りが壊す対象を直接測る」。**
 *
 * **`data/` はリポジトリにコミットされている**（CC BY 4.0、DATA_CONTRACT.md）。
 * ETL の出力は PR として上がるので、**`origin/main` の `data/rollcalls/index.json` と
 * この枝の `data/rollcalls/index.json` を突き合わせれば、語が落ちた瞬間にこの検査が落ちる。**
 * 遡りの PR も日次 refresh の PR も同じ経路を通る。
 *
 * **実測で確かめた（この壊れ方が実際にこの形で見えること）:**
 *
 * ```
 * PR #1205（遡り 200〜216 を流した PR）の基点と head で data/rollcalls/index.json を突き合わせた
 *   行数         380 → 380   （採決そのものは 1 件も消えていない）
 *   語を持つ行   348 → 347
 *   差分         209-1128-v010  「可決（賛成 244・反対 0）」 → 「賛成 244・反対 0」
 * ```
 *
 * **この検査を `origin/main` の基点（`eaff0d40^`）に対して走らせれば、`eaff0d40` は落ちた。**
 * **つまり遡りを流さずに、遡りが壊した事実を名指しできる。**
 *
 * ## 「測れなかった」と「0 件」を区別する（#1056 / #757）
 *
 * **`data/` を読めない・`origin/main` が無い（浅い checkout）ときは skip する。**
 * **緑にしない。** `checked`（突き合わせた行数）を母数として必ず数え、
 * **`checked === 0` なら「clean」ではなく失敗にする**（`scripts/ci/forbidden-patterns.sh` と同じ判断）。
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const INDEX = "data/rollcalls/index.json";

const gitOrUndefined = (...args: string[]): string | undefined => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return undefined;
  }
};

/** **読めなかった理由は列挙する。** 読めたときに空（= 差が無い）なのとは別の事象である。 */
const NO_BASE = "refs/remotes/origin/main が無い";
const NO_MERGE_BASE = "origin/main と HEAD の merge-base が取れない（浅い checkout）";
const NO_BASE_FILE = `merge-base に ${INDEX} が無い（この出力が初めて入る枝）`;

/** `origin/main` との merge-base にある `data/rollcalls/index.json`。読めなければ理由を返す。 */
const baseIndex = (): { rows?: RollCallSummary[]; reason?: string } => {
  const base = gitOrUndefined("rev-parse", "--verify", "--quiet", "refs/remotes/origin/main");
  if (base === undefined || base.trim() === "") return { reason: NO_BASE };
  const mergeBase = gitOrUndefined("merge-base", "refs/remotes/origin/main", "HEAD");
  if (mergeBase === undefined || mergeBase.trim() === "") return { reason: NO_MERGE_BASE };
  const raw = gitOrUndefined("show", `${mergeBase.trim()}:${INDEX}`);
  if (raw === undefined) return { reason: NO_BASE_FILE };
  return { rows: JSON.parse(raw) as RollCallSummary[] };
};

test("公開されている採決一覧から、判定の語が減っていない（遡りを流さずに #1206 の壊れ方を捕まえる）", async (t) => {
  const base = baseIndex();
  if (base.rows === undefined) {
    t.skip(`基点が読めないので突き合わせていない: ${base.reason}`);
    return;
  }
  const head = JSON.parse(await readFile(resolve(root, INDEX), "utf8")) as RollCallSummary[];

  // 母数（#757）: 「語が落ちた行は 0 件」と「1 行も見ていない」を区別する
  const checked = base.rows.filter((s) => decisionOfResult(s.result) !== undefined).length;
  assert.ok(checked > 0, `基点の ${INDEX} に判定の語を持つ行が 1 つも無い。これは「clean」ではなく、検査が何も見ていない状態である`);

  const lost = lostDecisions(base.rows, head);
  assert.deepEqual(lost, [], [
    `公開していた判定の語が ${lost.length} 件消えた（基点の語を持つ行 ${checked} 件 / 全 ${base.rows.length} 件を突き合わせた）:`,
    ...lost.map((l) => `  ${l.id} (第${l.session}回): 「${l.before}」が消え、票数だけが残った`),
    "",
    "判定の語は投票結果ページに無く（#26）、残っているのは data/rollcalls/index.json だけである。",
    "個票（data/rollcalls/{session}/{id}.json）は result を持たないので、消えたら取り戻せない。",
    "遡り（既定回次の外を取り直す実行）で参院 議案情報の案件名突合が外れると、この形で落ちる（#1206）。",
    "復元は cli.ts の restoreDecisions が前回出力から行う。効いていなければそこを見る。",
  ].join("\n"));
});

/**
 * **語を持たない採決と `unmatched-bills.json` が逐語で一致すること。**
 *
 * **上の検査（基点との比較）だけでは足りない**: 復元が壊れて語が落ちると、その採決は
 * `unmatched-bills.json` にも載るので、**両者の整合は保たれたまま**になる。
 * ここで固定するのは**「語が無い」と「突合できなかったと申告している」がずれていないこと**で、
 * **索引にだけ語を差し込む／申告だけ消す**という別の壊れ方を塞ぐ（#1133 が `referredCommittees` で
 * 原本と索引を突き合わせているのと同じ考え方）。
 *
 * **実測 2026-10-05**（`data/` の全数）:
 *
 * ```
 * rollcalls/index.json           380 行
 *   判定の語を持つ               347
 *   語を持たない                  33
 * unmatched-bills.json            33 行
 * 語が無いのに unmatched-bills に居ない:  0
 * 語が在るのに unmatched-bills に居る:    0
 * ```
 */
test("判定の語を持たない採決の集合が、unmatched-bills.json と逐語で一致する", async () => {
  const rows = JSON.parse(await readFile(resolve(root, INDEX), "utf8")) as RollCallSummary[];
  const unmatched = JSON.parse(await readFile(resolve(root, "data/unmatched-bills.json"), "utf8")) as { rollCallId: string }[];
  assert.ok(rows.length > 0, `${INDEX} が空。検査が何も見ていない`);

  const withoutWord = new Set(rows.filter((s) => decisionOfResult(s.result) === undefined).map((s) => s.id));
  const declared = new Set(unmatched.map((r) => r.rollCallId));
  const silentlyMissing = [...withoutWord].filter((id) => !declared.has(id)).sort();
  const falselyDeclared = [...declared].filter((id) => !withoutWord.has(id)).sort();

  assert.deepEqual(silentlyMissing, [], `判定の語が無いのに unmatched-bills.json に申告が無い採決（語が黙って消えた兆候）: ${silentlyMissing.join(" ")}`);
  assert.deepEqual(falselyDeclared, [], `unmatched-bills.json に「突合できなかった」と書いてあるのに索引には語が在る採決（索引にだけ差し込まれた兆候）: ${falselyDeclared.join(" ")}`);
});
