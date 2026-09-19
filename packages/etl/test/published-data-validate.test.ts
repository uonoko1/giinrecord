import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Assembly, LocalRollCall, MemberSummary } from "@seiji-kiroku/shared";
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
 * **単体で測った時間（ローカル、ページキャッシュが温まった状態、n=3）:**
 * `validateLocalAssemblies` 2,708 / 2,696 / 2,610 ms、`validateDataset` 7,206 / 7,015 / 7,328 ms。
 * **合わせて約 10 秒の直列時間**である。
 *
 * **だが `pnpm --filter @seiji-kiroku/etl test` の所要時間は動かない。**
 * `node --test` は 134 本のファイルを並列に走らせるので、**10 秒の 1 本は他の仕事に隠れる。**
 * **交互に測った実測（WITH / WITHOUT を続けて 3 組）:**
 * 79.1 / 80.4（−1.3 秒）、80.5 / 80.4（＋0.1 秒）、159.0 / 154.3（＋4.7 秒。両方遅く、機械が混んでいた）。
 * **中央値の差は ＋0.1 秒——測定の揺れの中である。**
 *
 * **#812 が CI の所要時間を見ているので書いておく: これは CI を目に見えて遅くしない。**
 * **最初に 1 回だけ測ったときは ＋34 秒に見えたが、それは自分が並列に走らせていた別の測定との
 * 取り合いだった**（交互に測り直して消えた）。**1 回の測定を数字として出さないこと。**
 */
const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));

/**
 * **母数**（#757）。**「何件見たか」を出さない検査は、0 件を見て緑になっても同じ顔をする。**
 *
 * ## **これは理屈ではない。実際に `validateDataset` が素通りする形がある。**
 *
 * **実測 2026-09-14**: **青森（pref-02）を「整合したまま」丸ごと消した**——
 * `assemblies/index.json` の行、`members/index.json` の 46 行、その detail、
 * `members/by-assembly.json` の行、`assemblies/pref-02/` を**まとめて**落とした。
 * **残ったデータは内部的に完全に整合しているので、`validateDataset` の違反は 0 件のまま緑だった。**
 * **落ちたのはこのテストだけである**（議会が 13 → 12）。
 *
 * **「1 県ぶんの記録が丸ごと消えても誰も言わない」は、まさに「記録が出ない」側の事故である。**
 * **`data/` を丸ごと空にしたときも `validateLocalAssemblies` は `[]` を返す**（違反が無いのは本当だから）。
 *
 * **上限ではなく「ちょうど」で固定する**——**県が増えたらここが落ちて、数え直しを強制する。**
 * **増えたときに数字を書き換えるのは、増やした PR の仕事である**
 * （`local-count-mismatches.test.ts` の「母数が変わったら数え直すこと」と同じ約束）。
 *
 * **実測 2026-09-20**（`data/` を直に数えた値。**#901 で三重だけ会期を 2 → 4 にした**:
 * **採決 1,369 → 1,737（+368）/ セル 58,057 → 75,615（+17,558）。**
 * **動いたのは `pref-24` だけで、他の 10 議会は 1 バイトも変わっていない**）。
 */
const CORPUS = {
  assemblies: 13, // assemblies/index.json の全行（国会 2 ＋ 地方 11）
  localAssemblies: 11,
  memberRows: 1225, // members/index.json の全行
  localMemberRows: 453, // うち地方議員（assemblyId が diet- で始まらない行）
  rollCallFiles: 1737, // assemblies/*/rollcalls/**/*.json（index.json を除く）。**#901 で三重が 365 → 733**
  voteCells: 75615, // その採決ファイルの votes[] の合計。**#901 で三重が 17,032 → 34,590**
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
 * **母数を先に測る。** **これが落ちたら、下の「違反 0 件」は意味を失っている**
 * （痩せたディレクトリを見て緑になっているのかもしれない。上の docblock の青森の実測）。
 */
test("#855 母数: コミット済み data/ に 11 議会・1,737 採決・75,615 セル・1,225 名簿行がある", async () => {
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
 * **本丸。** **コミット済みの `data/` そのもの**に不変条件を当てる。
 *
 * ## **なぜ `validateDataset` 1 つで、`validateLocalAssemblies` を別に呼ばないか**
 *
 * **`validateDataset` は `validateLocalAssemblies` を内側で呼んでいる**
 * （`packages/etl/src/dataset.ts` の末尾: `v.push(...(await validateLocalAssemblies(dir)))`）。
 * **書いている途中は 2 つ別々に呼んでいたが、変異を当てて初めて気づいた**——
 * `rollcalls/index.json` の `counts` を 1 つ壊したら、**2 つのテストが同じ 1 件の違反で落ちた。**
 * **同じ仕事を 2 回している**（地方のぶんだけ実測 2.6–2.7 秒の二重払い）。
 *
 * **だから 1 回だけ呼ぶ。** **`validateDataset` は厳密な上位集合**である——
 * 地方議会の不変条件（`validateLocalAssemblies`）に加えて、
 * `assemblies/index.json` の全行・`members/index.json` の全行・
 * `members/by-assembly.json` ↔ `members/index.json` の集計・国会議員の detail まで見る。
 * **#853 の担当者が「`assemblies/index.json` と `members/index.json` は未調査」と書いた部分は、
 * これで当たっている。**
 *
 * **違反の一覧をそのまま出す**（件数だけだと、何が起きたのか読めない）。
 *
 * **実測 2026-09-14: 0 件。** **「今は綺麗」であって「今後も綺麗」ではない**——
 * **#851 / #829 のずれは、この検査を当てていれば当日中に赤くなっていた**
 * （変異で確かめた: #851 と同じ形——`rollcalls/index.json` の `counts.yes` を 38 → 37 にする——を
 * 当てると、`assemblies/pref-05/rollcalls/index.json[0] (…提出意見書案第6号):
 * rollcalls/ の原本と食い違っている（原本が正）` と名指しして落ちる）。
 */
test("#855 本番 data/: 不変条件の違反が 0 件（validateDataset ＝ 国会側 ＋ validateLocalAssemblies）", async () => {
  const v = await validateDataset(DATA);
  assert.deepEqual(v, [], `コミット済み data/ が不変条件に違反している（${v.length} 件）`);
});

/**
 * **上のテストが本当に地方議会ぶんも見ていることを、別の根拠で固定する**（#774「独立でも互いの代わりにならない」）。
 *
 * **`validateDataset` の中の 1 行（`v.push(...(await validateLocalAssemblies(dir)))`）が消えると、
 * 上のテストは地方議会を 1 件も見なくなるのに緑のままになる**
 * **実測 2026-09-14**（その行を `/* removed *\/` に置き換えて測った）:
 * **上のテストは 0 件のまま緑で通り、落ちたのはこのテストだけだった。**
 * **地方議会の検査が丸ごと走らなくなったのに、「違反 0 件」は何も言わない**——
 * **違反が 0 なのは本当だから**（見ていないものからは違反が出ない）。
 * **ここはソースを読んで、その 1 行が在ることを固定する**——**呼ばれていることの根拠を、
 * 「違反が 0 だった」以外の場所から取る。**
 */
test("#855 validateDataset は validateLocalAssemblies を今も呼んでいる（呼ばなくなっても上のテストは緑のままなので）", async () => {
  const src = await readFile(fileURLToPath(new URL("../src/dataset.ts", import.meta.url)), "utf-8");
  assert.ok(
    src.includes("v.push(...(await validateLocalAssemblies(dir)))"),
    "dataset.ts が validateLocalAssemblies を呼んでいない。呼ばなくなると、上のテストは地方議会を 1 件も見ずに緑になる（#855）",
  );
});
