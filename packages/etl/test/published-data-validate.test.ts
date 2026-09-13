import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Assembly, LocalRollCall, MemberSummary } from "@seiji-kiroku/shared";
import { validateLocalAssemblies } from "../src/local-assemblies.ts";
import { validateDataset } from "../src/dataset.ts";

/**
 * **コミット済みの `data/` に、不変条件の検査をそのまま当てる**（Issue #855）。
 *
 * ## 何が問題だったか
 *
 * **`validateLocalAssemblies` / `validateDataset` は在ったが、誰も本番のデータに当てていなかった。**
 * 呼び出し元は ETL の CLI（`local-cli.ts` / `cli.ts`。**データを書き出した直後**に呼ぶ）と、
 * 県ごとの `*-run.test.ts`（**その県ぶんの一時ディレクトリ**に対して呼ぶ）だけだった。
 * **どちらも「今 ETL が書いたもの」しか見ない。** **コミットされた `data/` は、その後誰も見ていない。**
 *
 * **これは机上の穴ではない。同じ日に 2 件、「コミット済み `data/` にだけ在るずれ」が見つかっている:**
 *
 * | # | ずれ | どう見つかったか |
 * |---|---|---|
 * | #851 | `rollcalls/index.json` の行が原本と 7 件食い違っていた | **PO が本番を測って（誤った理由で）偶然気づいた** |
 * | #829 | 秋田の `counts` が 7 件欠けていた | **#819 の測定で偶然気づいた** |
 *
 * **どちらも検査は在った。当てていなかっただけである。**
 *
 * ## なぜ ETL の出力時の検査では足りないか
 *
 * **ETL が書いてから本番に出るまでに、人が `data/` を触る経路がある**——
 * **#840 は実際に原本と `meta.json` を手で直し、`index.json` を古いまま本番に出した**
 * （公表されている人数が「公表記録にありません」と表示された。利用者から検出できない虚偽）。
 * **書いた瞬間だけ見る検査は、書いた後に起きたずれを一度も見ない。**
 *
 * ## なぜ etl のテストに置くか（ci.yml の step ではなく）
 *
 * **既存の形がこれだから**——`akita-published-data.test.ts` / `saga-published-data.test.ts` /
 * `local-count-mismatches.test.ts` / `local-rollcall-index.test.ts` /
 * `local-name-broken.test.ts` は、いずれも `packages/etl/test/` から本番 `data/` を読み直している。
 * **`ci.yml` に本番データを読む step は 1 つも無い。** 新しい形を増やす理由が無い。
 *
 * **ただし「テストの中の検査は、そのテストが走らなくなったことを言えない」**（#504）ので、
 * **このファイルが走っていることの要求は別のファイルに置く**——
 * `test-file-inventory.test.ts` が `packages/etl/test/*.test.ts` の本数の下限を持ち、
 * `ci.yml` の「Test file count floor」step がその外側からもう一度数えている。
 *
 * ## 実行時間（#812 が CI の所要時間を見ているので測った）
 *
 * **実測 2026-09-14（ローカル、ページキャッシュが温まった状態、n=3）:**
 * `validateLocalAssemblies` 2,976 / 3,224 / 3,697 ms、`validateDataset` 8,433 ms。
 * **`pnpm --filter @seiji-kiroku/etl test` は 1,578 テストで 81.7 秒**だったので、
 * **合わせて 1 割強の増**。数字は下の docblock に測り直した値を書いてある。
 */
const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));

/**
 * **母数**（#757）。**「何件見たか」を出さない検査は、0 件を見て緑になっても同じ顔をする。**
 * **`data/` を丸ごと空にしても `validateLocalAssemblies` は `[]` を返す**（違反が無いのは本当だから）。
 * **実測 2026-09-14**（`data/` を直に数えた値）。
 */
const CORPUS = {
  assemblies: 13, // assemblies/index.json の全行（国会 2 ＋ 地方 11）
  localAssemblies: 11,
  memberRows: 1225, // members/index.json の全行
  localMemberRows: 453, // うち地方議員（assemblyId が diet- で始まらない行）
  rollCallFiles: 1369, // assemblies/*/rollcalls/**/*.json（index.json を除く）
  voteCells: 58057, // その採決ファイルの votes[] の合計
};

const walkRollCalls = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkRollCalls(p)));
    else if (e.name.endsWith(".json") && e.name !== "index.json") out.push(p);
  }
  return out;
};

/**
 * **母数を先に測る。** **これが落ちたら、下の 2 つの「違反 0 件」は意味を失っている**
 * （空のディレクトリを見て緑になっているのかもしれない）。
 * **上限ではなく「これ以上」で書く**——県が増えれば増えるのが正常だから。
 * **数え直したら実測に書き換えること**（`local-count-mismatches.test.ts` と同じ約束）。
 */
test("#855 母数: コミット済み data/ に 11 議会・1,369 採決・58,057 セル・1,225 名簿行がある", async () => {
  const assemblies = JSON.parse(await readFile(join(DATA, "assemblies/index.json"), "utf-8")) as Assembly[];
  const members = JSON.parse(await readFile(join(DATA, "members/index.json"), "utf-8")) as MemberSummary[];
  const local = assemblies.filter((a) => a.kind !== "national");
  assert.equal(assemblies.length, CORPUS.assemblies);
  assert.equal(local.length, CORPUS.localAssemblies);
  assert.equal(members.length, CORPUS.memberRows);
  assert.equal(members.filter((m) => m.assemblyId !== undefined && !m.assemblyId.startsWith("diet-")).length, CORPUS.localMemberRows);
  let files = 0;
  let cells = 0;
  for (const a of local) {
    for (const f of await walkRollCalls(join(DATA, "assemblies", a.id, "rollcalls"))) {
      files++;
      cells += (JSON.parse(await readFile(f, "utf-8")) as LocalRollCall).votes.length;
    }
  }
  assert.equal(files, CORPUS.rollCallFiles);
  assert.equal(cells, CORPUS.voteCells);
});

/**
 * **本丸。** `validateLocalAssemblies` を**コミット済みの `data/` そのもの**に当てる。
 *
 * **違反の一覧をそのまま出す**（件数だけだと、何が起きたのか読めない）。
 * **実測 2026-09-14: 0 件。** **「今は綺麗」であって「今後も綺麗」ではない**——
 * **#851 / #829 のずれは、この検査を当てていれば当日中に赤くなっていた。**
 */
test("#855 本番 data/: validateLocalAssemblies の違反が 0 件（地方議会の不変条件）", async () => {
  const v = await validateLocalAssemblies(DATA);
  assert.deepEqual(v, [], `コミット済み data/ が地方議会の不変条件に違反している（${v.length} 件）`);
});

/**
 * **`assemblies/index.json` と `members/index.json` の側**（#853 の担当者が「未調査」と明示した）。
 *
 * **`validateLocalAssemblies` は地方議会の行しか見ない**（国会の行は素通りする）。
 * **`validateDataset` のほうが `assemblies/index.json` の全行・`members/index.json` の全行・
 * `members/by-assembly.json` ↔ `members/index.json` の集計を見る。**
 * **こちらも誰も本番に当てていなかった**ので、同じ理由でここに置く。
 *
 * **実測 2026-09-14: 0 件。**
 */
test("#855 本番 data/: validateDataset の違反が 0 件（assemblies/index.json・members/index.json・by-assembly.json)", async () => {
  const v = await validateDataset(DATA);
  assert.deepEqual(v, [], `コミット済み data/ が国会側の不変条件に違反している（${v.length} 件）`);
});
