import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseVotePdf, UNKNOWN_CELL } from "../src/sources/local/shimane/votes-pdf.ts";

/**
 * # 島根: 票数が複数アイテムにまたがるとき、切り詰められた数が `/^\d+$/` を黙って通る（Issue #1055）
 *
 * ## 何が問題か
 *
 * ```
 * "34" のうち 1 アイテムが落ちる → "3" が残る
 * /^\d+$/ は "3" を通す         → 票数が 34 から 3 になる
 * ```
 *
 * **倒れる向きは #569 の重いほう**——**「記録が出ない」ではなく「違う記録が出る」。**
 * **利用者からは「この議案は 3 票で可決された」に見え、それが誤りだと気づけない。**
 *
 * **`/^\d+$/` は「数字である」の検査であって「切り詰められていない」の検査ではない。**
 * **形が正しいことと、値が正しいことは別である。**
 *
 * ## 到達性（**まず自分で測り直した**。2026-09-28）
 *
 * **Issue には「いまは到達不能」と書いてある。それは今も本当だが、理由は 1 本の例外に乗っている。**
 *
 * | 何を測ったか | 実測 |
 * |---|---:|
 * | フィクスチャの表決 PDF | **9 本**（うち読めるのは **8 本**） |
 * | 読めた 8 本の行 | **329 行** |
 * | **賛成／反対の欄のアイテム**（8 本 / yes・no 合わせて） | **666 個** |
 * | **うち 1 行が 2 アイテム以上だったもの** | **0 行** |
 * | **複数アイテムの票数を持つ本** | **`r0705rinji` の 1 本だけ** |
 *
 * **`r0705rinji` の実物**（`第80号` の賛成欄）: `["34","34","33","33"]`
 * ——**4 行ぶんの票数が 1 つの行にまとまっている。**
 * **その本は `page 1: two vote marks in one cell (col 0)` でこの行より早く落ちるので、
 * いま `/^\d+$/` の行に到達しない。**
 *
 * **＝到達不能なのは「そういう本が無いから」ではなく「1 本だけある本が、別の理由で先に落ちるから」。**
 * **その例外が消えた日に、この穴が開く。**
 *
 * **賛成／反対の欄の `nearest` 1 位 2 位差の最小は 16.8 pt / タイは 0 件**（666 アイテム）。
 * **だから「いま壊れている」のではない。「壊れたときに違う数が出る」のを止める。**
 *
 * ## どう直したか（**形の検査ではなく値の検査を足す**）
 *
 * **検査 (1) 落ちた事実で落とす**: 賛成／反対の欄で 1 文字でも行が決まらなかったら、その本を落とす。
 * **検査 (2) 値そのもので落とす**: 公表された票数を、**同じ行に実際に並んだ ○ ● の数**と突き合わせる。
 *
 * **(2) が「代理ではなく実体」の検査である**——**票そのものは票数の欄とは独立した別の情報なので、
 * `34 → 3` の切り詰めは必ず外れる。**
 *
 * **(2) が本物のデータで成り立つことを先に測った（前提が偽なら検査は本番を壊す）**:
 *
 * | 母数 | **公表値と ○/● の数が食い違う行** |
 * |---|---:|
 * | **読めた 8 本 / 329 行** | **0 行** |
 * | うち `不明` のセルを持つ 27 行 | **0 行**（`不明` は議⾧・除斥などの非投票セルで ○ ● に入らない） |
 *
 * **この変更で本番の出力は 1 行も変わらない**（下の「本番が痩せない」の検査）。
 *
 * ## 変異テストの結果（**素通りした変異も書く**）
 *
 * | 変異 | 結果 |
 * |---|---|
 * | **検査 (2) を丸ごと消す** | **殺せた。35 組が素通りして違う票数が出た**（＝**これが効いている検査**） |
 * | **検査 (1) を丸ごと消す** | **殺せた**（21 → 0）。**ただし素通りは 0 件**——56 組は全部 検査 (2) が捕まえる |
 * | `someMarksDropped` を常に `false`（厳密一致だけ） | **殺せた**（#1023/#1056 の検査が 2 本落ちる。`>=` の枝は #1023 の振る舞いに要る） |
 * | **`someMarksDropped` を常に `true`（`>=` だけ）** | **素通りした（等価変異）** |
 *
 * **最後の 1 つは等価変異である。理由を書く**（「たまたま緑」と区別するため）:
 * **切り詰めは票数を必ず小さくする**（`33 → 3`）ので、**`>=` でも必ず外れる。**
 * **厳密一致の枝が守っているのは逆向き（公表値 > 数えた数）で、それは切り詰めではなく
 * 「票が落ちた」側**——**そちらは `someMarksDropped` を `false` にする変異が殺している。**
 * **＝どちらの枝も検査で押さえられているが、この 1 つの変異だけは切り詰めの観点からは等価である。**
 *
 * **＝検査 (1) は「効いている唯一の検査」ではなく、原因そのものを名指しする二重化である**
 * （検査 (2) が寄りかかる「公表値と ○ ● は一致する」という前提が将来崩れたときに残る）。
 */

const FIXTURES = fileURLToPath(new URL("./fixtures/shimane/", import.meta.url));

/** **本番が実際に取りに行っている 5 本**（`data/assemblies/pref-32/` の `sourceUrl`。#1023 で数えた） */
const PRODUCTION_PDFS = [
  "r0706_giinbetu_kekka.pdf",
  "r0709_giinbetu_kekka.pdf",
  "r0711_giinbetu_kekka.pdf",
  "r0802_giinbetu_kekka.pdf",
  "r0806_giinbetu_kekka.pdf",
] as const;

const votePdfs = (): string[] =>
  readdirSync(FIXTURES).filter((f) => f.endsWith("giinbetu_kekka.pdf")).sort();

/* ───────── 1. 母数: いま「複数アイテムの票数」を持つ本はどれか（#757） ───────── */

/**
 * **「島根で 0 件」と「数えていない」は違う**（#757）。**だから数える。**
 *
 * **読めた 8 本の票数はどの行も 1 アイテム。** **複数アイテムは `r0705rinji` だけで、
 * その本はより早く例外になる。** **＝いまは到達不能。**
 *
 * **この検査が落ちる意味は 2 つある**:
 * 1. **`r0705rinji` が読めるようになった**（＝**穴が開いた**。この Issue を読み直すこと）
 * 2. フィクスチャを足した／差し替えた（**測り直して数を更新する**）
 */
test("#1055 島根: 複数アイテムの票数を持つ本は r0705rinji だけで、その本はより早く落ちる（＝いまは到達不能）", async () => {
  const readable: string[] = [];
  const unreadable: { file: string; message: string }[] = [];
  let rows = 0;
  for (const file of votePdfs()) {
    try {
      const v = await parseVotePdf(readFileSync(`${FIXTURES}${file}`));
      readable.push(file);
      rows += v.rows.length;
    } catch (e) {
      unreadable.push({ file, message: (e as Error).message });
    }
  }
  // **母数**（実測 2026-09-28）
  assert.equal(votePdfs().length, 9, `前提: 表決 PDF のフィクスチャが ${votePdfs().length} 本（実測は 9）`);
  assert.equal(readable.length, 8, `前提: 読めた本が ${readable.length} 本（実測は 8）`);
  assert.equal(rows, 329, `前提: 読めた本の行が ${rows}（実測は 329）`);
  // **到達不能の理由そのもの**。**この文言が変わったら、穴が開いたかを確かめること。**
  assert.deepEqual(unreadable, [{
    file: "r0705rinji_giinbetu_kekka.pdf",
    message: "page 1: two vote marks in one cell (col 0)",
  }], "読めない本／落ちる理由が変わった。**r0705rinji が読めるようになったなら #1055 の穴が開いている**"
    + "（その本の賛成欄は 第80号 で ['34','34','33','33'] の 4 アイテム）");
});

/* ───────── 2. 前提: 公表された票数は、その行の ○ ● の数と一致する ───────── */

/**
 * **検査 (2) が寄りかかっている事実を、先に本物のデータで測る。**
 *
 * **これが偽なら、足した検査は本番を壊す**（＝ **0 === 0 の比較ではない**ことの証明でもある）。
 */
test("#1055 島根: 公表された票数は、その行に並んだ ○ ● の数と一致する（8 本 329 行で食い違い 0）", async () => {
  let rows = 0;
  let rowsWithUnknown = 0;
  const mismatch: string[] = [];
  for (const file of votePdfs()) {
    let v: Awaited<ReturnType<typeof parseVotePdf>>;
    try { v = await parseVotePdf(readFileSync(`${FIXTURES}${file}`)); } catch { continue; }
    for (const r of v.rows) {
      rows++;
      const yes = r.cells.filter((c) => c === "○").length;
      const no = r.cells.filter((c) => c === "●").length;
      if (r.cells.some((c) => c === UNKNOWN_CELL)) rowsWithUnknown++;
      if (yes !== r.counts.yes || no !== r.counts.no) {
        mismatch.push(`${file} p${r.page} ${r.number}: 公表 ${r.counts.yes}/${r.counts.no} vs ○● ${yes}/${no}`);
      }
    }
  }
  assert.equal(rows, 329, `前提: 行が ${rows}（実測は 329）`);
  assert.equal(rowsWithUnknown, 27, `前提: ${UNKNOWN_CELL} のセルを持つ行が ${rowsWithUnknown}（実測は 27）`);
  assert.deepEqual(mismatch, [], `公表値と ○ ● の数が食い違う行がある（${mismatch.length} 行）。`
    + "**この前提が崩れたなら、votes-pdf.ts の突き合わせ検査は本番を壊す**——測り直すこと");
});

/* ───────── 3. 本題: 切り詰めを起こして、必ず検出されることを測る ───────── */

/**
 * **人工的に「票数の欄が複数アイテムになり、その 1 つが落ちる」状態を、本物の座標の上で作る。**
 * **実データでは起きないので、フィクスチャを足しても検査できない**（上の 1 の母数を見よ）。
 *
 * **2 通りの落ち方を両方通す**（**1 通りだけだと、片方の検査を消しても緑のままになる**。#1056 で同じ穴を踏んだ）:
 *
 * - `tie` … **本物の同距離タイ**（隣り合う 2 行の中点へ動かす）。**検査 (1) が踏む。**
 * - `vanish` … **黙って消える**（タイ以外の理由でアイテムが欠ける形）。**検査 (2) だけが踏む。**
 *
 * ## 実測（2026-09-28）
 *
 * | | 組 |
 * |---|---:|
 * | **(ページ, 欄, 落とし方) の組** | **112** |
 * | **切り詰めが実際に起きた組** | **56** |
 * | **うち 検査 (1)（落ちた事実）が捕まえた** | **21** |
 * | **うち 検査 (2)（○ ● との突き合わせ）が捕まえた** | **35** |
 * | **切り詰めが起きなかった組**（＝捕まえるものが無い） | **56** |
 * | **切り詰めが起きたのに素通りした組** | **0** |
 *
 * **「起きなかった 56 組」の内訳も測ってある**（**これを書かないと「絞りすぎ」と区別できない**）:
 *
 * - **52 組**: その欄に 2 桁の値が 1 つも無い（`"0"` ばかりの反対欄）。**割るものが無い。**
 * - **4 組**: `tie` にしたつもりの中点が**完全な等距離にならなかった**
 *   （差 2.8e-14〜5.7e-14 pt。`nearestAnchor` は行を選ぶ）。**桁が落ちないので切り詰めも起きない。**
 *   **これは #1023 で測った「`===` の守る範囲は完全な等距離の 66%、残る 34% は 1e-14 pt の差で決まる」そのもの。**
 */
test("#1055 島根: 票数を 1 桁ずつに割って 1 つ落とすと、必ず例外になる（112 組。素通り 0）", async () => {
  let sites = 0;
  let caughtByDropFact = 0;
  let caughtByMarkTally = 0;
  let noChange = 0;
  const leaked: string[] = [];
  const otherError: string[] = [];
  for (const file of votePdfs()) {
    const bytes = readFileSync(`${FIXTURES}${file}`);
    let base: Awaited<ReturnType<typeof parseVotePdf>>;
    // `r0705rinji` は「1 つのセルに票が 2 つ」で落ちる既知の本（上の 1 で固定してある）
    try { base = await parseVotePdf(bytes); } catch { continue; }
    const baseCounts = JSON.stringify(base.rows.map((r) => [r.counts.yes, r.counts.no]));
    const pages = [...new Set(base.rows.map((r) => r.page))].sort((a, b) => a - b);
    for (const page of pages) {
      for (const which of ["yes", "no"] as const) {
        for (const mode of ["tie", "vanish"] as const) {
          sites++;
          const where = `${file} ${page}:${which} ${mode}`;
          try {
            const v = await parseVotePdf(bytes, { splitCountForTest: `${page}:${which}`, splitCountModeForTest: mode });
            // 例外にならなかった ⇒ **票数が 1 つも変わっていないこと**を確かめる。
            // **変わって素通りしたなら、それが #1055 そのもの（違う数が公開される）。**
            if (JSON.stringify(v.rows.map((r) => [r.counts.yes, r.counts.no])) === baseCounts) noChange++;
            else leaked.push(where);
          } catch (e) {
            const m = (e as Error).message;
            if (m.includes("行が決まらなかった文字がある")) caughtByDropFact++;
            else if (m.includes("と合わない（票数が切り詰められた疑い")) caughtByMarkTally++;
            else otherError.push(`${where}: ${m.slice(0, 80)}`);
          }
        }
      }
    }
  }
  // **母数**（#757）
  assert.equal(sites, 112, `前提: (ページ, 欄, 落とし方) の組が ${sites}（実測は 112）`);
  assert.deepEqual(otherError, [], `切り詰めと関係のない例外で落ちた（${otherError.length} 組）`);
  // **検出能力**（**これが 0 なら、下の `leaked` は何も守っていない**——#1056 の教訓）
  assert.equal(caughtByDropFact, 21, `検査 (1)（落ちた事実）が捕まえた組が ${caughtByDropFact}（実測は 21）。`
    + "**0 に近づいたなら、合成が効いていないか検査が消えている**");
  assert.equal(caughtByMarkTally, 35, `検査 (2)（○ ● との突き合わせ）が捕まえた組が ${caughtByMarkTally}（実測は 35）。`
    + "**0 に近づいたなら、合成が効いていないか検査が消えている**");
  assert.equal(noChange, 56, `切り詰めが起きなかった組が ${noChange}（実測は 56 ＝ 2 桁が無い 52 + 中点がタイにならない 4）`);
  // **本題**: **切り詰めが起きたのに素通りした組は 1 つも無い**
  assert.deepEqual(leaked, [], `票数が切り詰められたのに例外にならなかった（${leaked.length} 組）。`
    + "**#569 の重いほう——利用者から検出できない誤った票数が公開される**");
});

/* ───────── 3b. 票も落ちているとき（`>=` が緩くなる道）でも素通りしない ───────── */

/**
 * **検査 (2) は、票（○ ●）がタイで落ちたページでは `公表値 >= 数えた数` に緩む**
 * （落ちた票は `不明` になるので「数えた数」が本物より小さい。#1023 の振る舞いを壊さないため）。
 *
 * **その緩んだ道でも、票数の切り詰めが素通りしないことを測る。**
 * **票の落下（#1056 が絞った 13 組）と票数の切り詰めを同時に起こす。**
 *
 * ## 実測（2026-09-28）
 *
 * | | 組 |
 * |---|---:|
 * | **(票を落とす列, 票数の欄, 落とし方) の組** | **52** |
 * | **例外になった組** | **24** |
 * | **票数が変わらなかった組**（2 桁が無い／中点がタイにならない） | **28** |
 * | **票数が変わったのに素通りした組** | **0** |
 */
test("#1055 島根: 票も落ちているページ（`>=` に緩む道）でも、票数の切り詰めは素通りしない（52 組）", async () => {
  // **#1056 が絞った 13 組**（`labelCols ∩ markCols`。あちらの検査が同じ並びを固定している）
  const MARK_DROP_SITES: readonly (readonly [string, string])[] = [
    ["r0506_giinbetu_kekka.pdf", "2:13"],
    ["r0606_giinbetu_kekka.pdf", "4:25"],
    ["r0606_giinbetu_kekka.pdf", "4:29"],
    ["r0609_giinbetu_kekka.pdf", "2:33"],
    ["r0609_giinbetu_kekka.pdf", "3:7"],
    ["r0706_giinbetu_kekka.pdf", "4:8"],
    ["r0706_giinbetu_kekka.pdf", "4:18"],
    ["r0706_giinbetu_kekka.pdf", "4:20"],
    ["r0706_giinbetu_kekka.pdf", "4:23"],
    ["r0706_giinbetu_kekka.pdf", "4:24"],
    ["r0802_giinbetu_kekka.pdf", "4:33"],
    ["r0806_giinbetu_kekka.pdf", "4:21"],
    ["r0806_giinbetu_kekka.pdf", "4:23"],
  ] as const;
  let sites = 0;
  let caught = 0;
  let noChange = 0;
  const leaked: string[] = [];
  for (const [file, pageCol] of MARK_DROP_SITES) {
    const bytes = readFileSync(`${FIXTURES}${file}`);
    const base = await parseVotePdf(bytes);
    const baseCounts = JSON.stringify(base.rows.map((r) => [r.counts.yes, r.counts.no]));
    const page = pageCol.split(":")[0];
    for (const which of ["yes", "no"] as const) {
      for (const mode of ["tie", "vanish"] as const) {
        sites++;
        try {
          const v = await parseVotePdf(bytes, { pageCol, splitCountForTest: `${page}:${which}`, splitCountModeForTest: mode });
          if (JSON.stringify(v.rows.map((r) => [r.counts.yes, r.counts.no])) === baseCounts) noChange++;
          else leaked.push(`${file} 票=${pageCol} 票数=${page}:${which} ${mode}`);
        } catch { caught++; }
      }
    }
  }
  assert.equal(sites, 52, `前提: 組が ${sites}（実測は 52 ＝ 13 組 × yes/no × tie/vanish）`);
  assert.equal(caught, 24, `例外になった組が ${caught}（実測は 24）。**0 に近づいたなら合成が効いていない**`);
  assert.equal(noChange, 28, `票数が変わらなかった組が ${noChange}（実測は 28）`);
  assert.deepEqual(leaked, [], `票も落ちているページで、票数の切り詰めが素通りした（${leaked.length} 組）`);
});

/* ───────── 4. 本番が痩せない（足した検査が「出るはずの記録」を消していない） ───────── */

/**
 * **「出さない側に倒す」は正しいが、倒しすぎれば記録が消える。**
 * **本番 5 本の行数・票数・セルが 1 つも変わらないことを測る。**
 */
test("#1055 島根: 足した検査で本番 5 本の出力は 1 行も変わらない（231 行 / 8,085 セル）", async () => {
  let rows = 0;
  let cells = 0;
  let marks = 0;
  const countsSum = { yes: 0, no: 0 };
  for (const file of PRODUCTION_PDFS) {
    const v = await parseVotePdf(readFileSync(`${FIXTURES}${file}`));
    rows += v.rows.length;
    for (const r of v.rows) {
      cells += r.cells.length;
      marks += r.cells.filter((c) => c === "○" || c === "●").length;
      countsSum.yes += r.counts.yes;
      countsSum.no += r.counts.no;
    }
  }
  // **#1023 が測った数と同じ**（`ref` も同じ。ここが動いたら本番が変わっている）
  assert.equal(rows, 231, `本番の採決が ${rows} 行（実測は 231）`);
  assert.equal(cells, 8085, `本番の (議員, セル) 対が ${cells}（実測は 8,085）`);
  assert.equal(marks, 7730, `本番の ○/● が ${marks}（実測は 7,730）`);
  // **票数そのもの**（#1055 が守るもの。**切り詰められればここが減る**）
  assert.equal(countsSum.yes, 7633, `本番の賛成の合計が ${countsSum.yes}（実測は 7,633）`);
  assert.equal(countsSum.no, 97, `本番の反対の合計が ${countsSum.no}（実測は 97）`);
  assert.equal(countsSum.yes + countsSum.no, marks, "票数の合計と ○ ● の数が合わない");
});
