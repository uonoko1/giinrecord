import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { nearestAnchor, parseVotePdf, UNKNOWN_CELL } from "../src/sources/local/shimane/votes-pdf.ts";

/**
 * # 島根だけ「票の行き先」を y の比較そのものが決めている（Issue #1023）
 *
 * ## 何を測りに来たか
 *
 * **#1016（Issue #1002）は 11 県のうち 4 県しか測っていない**（青森・秋田・滋賀・佐賀）。
 * **残り 7 県は「揺れが 0 件だった」のではなく「見ていなかった」。**
 *
 * **7 県を読み直すと、6 県（高知・三重・宮城・奈良・徳島・鳥取）は同じ形で、島根だけ違う。**
 *
 * | | 票のセルの行き先を決めるもの | y の使われ方 | y が揺れたときの倒れる向き |
 * |---|---|---|---|
 * | **6 県** | `bandIndex(grid.voteCols, it.cx)` ＝ **x の帯** | `within(it.cy, y0 + EDGE, y1 - EDGE)` の**在/不在だけ** | **行から外れる → `UNKNOWN_CELL`**（記録が出ない） |
 * | **島根** | **`nearest(it.y)` ＝ y の比較** | **行そのものを選ぶ** | **別の行＝別の議案へ → 別人の票**（#569 の重いほう） |
 *
 * **島根には「置き直し」が無い。** 6 県は y でふるいに掛けてから x で置き直すので、
 * y の丸め誤差は**票の行き先に触れない**。島根は `anchors` との距離比べの勝者が
 * そのまま行になるので、**同距離のタイになれば、どちらを選ぶかは `anchors` の並び順が決める**
 * ——**PDF には何の根拠も無い選び方**である。
 *
 * ## 実測（2026-09-25。**母数を全部書く**）
 *
 * ### 1. 実データにタイは無い。しかも「際どくない」
 *
 * | 何を測ったか | 母数 | **タイ（差 0）** | **1 位と 2 位の差の最小** |
 * |---|---:|---:|---:|
 * | 票（○ ●）の行き先 | **11,154 回** | **0** | **16.560 pt** |
 * | `nearest` の呼び出し全部（票・件名・付託・採決結果・賛否） | **12,489 回** | **0** | **8.160 pt** |
 *
 * **丸め誤差の桁は 1e-13 〜 1e-5 pt（#1000 の実測）。いちばん際どい 8.160 pt とは 5 桁以上離れている。**
 * **つまりこの直しは「起きている事故を止める」ものではない。**
 * **「起きたときに倒れる向き」を、実装依存から明示に変えるものである。**
 *
 * ### 2. **島根は本番の 100% を測れている**（4 県の 18% と違う）
 *
 * **本番が取りに行く表決 PDF を数えた**（`data/assemblies/pref-32/` の `sourceUrl`。2026-09-25）:
 * **5 本。5 本ともフィクスチャにある。**
 *
 * | | 本 | 採決（行） | **(議員, セル) 対** |
 * |---|---:|---:|---:|
 * | **本番** | **5** | **231** | **8,085** |
 * | この 5 本を `parseVotePdf` に通した結果 | 5 | **231** | **8,085** |
 * | フィクスチャ全部（読めた本） | **8** | **329** | **11,613** |
 *
 * **行数もセル数も本番のデータと一致する**（`data/assemblies/pref-32/rollcalls/**` を数えて 231 採決 / 8,085 票）。
 * **＝ここで測った範囲は本番の全量である。**
 *
 * ### 3. **この変更は本番の出力を 1 セルも変えない**（差分を取って確かめた）
 *
 * **フィクスチャ 9 本の `parseVotePdf` の出力（議案番号・件名・採決結果・賛否・全セル・例外文言）を
 * 変更前後で書き出して比較。330 行 / 11,613 セル / `unknownCells` 30 で、差分 0 バイト。**
 * **`tiedItems` / `tiedMarks` はどちらも 0。**（`data/` は 1 ファイルも変えていない。）
 *
 * ## 倒れる向き（**明記する**。**最初に書いた向きは偽だった**）
 *
 * **最初の版はこう書いていた**——「タイ → `undefined` → 票は置かれない → `UNKNOWN_CELL` →
 * ＝記録が出ない側。別人の記録が出る側には倒れない」。**これは偽である。**
 *
 * **票を置かないと `cells` の組み立てが「○ ● の無い行」の道に落ち、そこには
 * 「その列にラベルの塊が 1 つだけなら、行を覆っていなくてもそれを返す」枝が在った**
 * （`votes-pdf.ts` の `hit.length === 0 && blocks.length === 1`）。
 * **落とした票が「議⾧」「除斥」「棄権」になり、`rollcalls.ts` の `MAPPED` を通って
 * `mapped: "投票なし"` として公開されえた**——**賛成した実在の議員が「投票していない」と出る。**
 *
 * **実測（総当たり。ref `9dc1f065`）**:
 *
 * | 母数 | 票が落ちた組 | **不明にならずラベルになったセル** |
 * |---|---:|---:|
 * | フィクスチャ 9 本・**990 組** | 955 | **18** → **0** |
 * | **本番の 5 本**・**630 組** | 607 | **12** → **0** |
 *
 * **`tiedCols`（票を落とした列はラベルで埋めない）で塞いだ。**
 * **塞いだあとの向きは、測ったうえで「`UNKNOWN_CELL`（記録が出ない側）」である**
 * ——下の「ラベルで埋まらない」検査が 630 組を総当たりして固定する。
 * 票以外（議案番号・件名・採決結果・賛否・付託委員会）は置かれず、
 * **空になるので既存の検査が例外で落とす**（黙って隣の行に入れない）。
 *
 * ## この検査が捕まえないもの（測っていないことは測っていないと書く）
 *
 * 1. **`anchors` 自体が揺れる場合は見ていない。** `cluster(numItems.map((i) => i.y), 4)` の
 *    丸め誤差で行の基準そのものが動く道は、ここでは動かしていない。
 * 2. **摂動は `it.y` だけ**（`x` / `w` / `h` / `cx` / `cy` は動かしていない）。
 *    列（x）の割り当てはこの PBI の対象ではない。
 * 3. **`readPages` より前（pdfjs が返す座標そのもの）は動かしていない。**
 *    pdfjs の版が変われば座標が変わり、ここは通ったまま出力が変わりうる。
 * 4. **6 県の「安全」は振る舞いではなくソースの形で固定している**（下の 4 つ目のテスト）。
 *    **これは denylist ではなく allowlist（`bandIndex(grid.voteCols, it.cx)` が在ることを要求）だが、
 *    「y で行を選ぶ別の書き方を足した」ことは捕まえない。**
 */

const FIXTURES = fileURLToPath(new URL("./fixtures/shimane/", import.meta.url));

/** **本番が実際に取りに行っている 5 本**（`data/assemblies/pref-32/` の `sourceUrl` を数えた。2026-09-25） */
const PRODUCTION_PDFS = [
  "r0706_giinbetu_kekka.pdf",
  "r0709_giinbetu_kekka.pdf",
  "r0711_giinbetu_kekka.pdf",
  "r0802_giinbetu_kekka.pdf",
  "r0806_giinbetu_kekka.pdf",
] as const;

const votePdfs = (): string[] =>
  readdirSync(FIXTURES).filter((f) => f.endsWith("giinbetu_kekka.pdf")).sort();

/* ───────────────── 1. タイになったら決めない（人工的に作る） ───────────────── */

/**
 * **実データにタイは 0 件なので、タイは人工的に作る**（#1023 の指示）。
 * **「実データに無いから検査できない」で終わらせない。**
 *
 * **`nearestAnchor` を直接呼ぶ**——`parseVotePdf` は PDF の座標を作り替えられないので、
 * **票の行き先を決める当の関数を、決めさせたい入力で呼ぶ。**
 */
test("#1023 島根 nearestAnchor: 同距離のタイは undefined（どちらの行にも置かない）", () => {
  const cases: { name: string; anchors: number[]; y: number; want: number | undefined }[] = [
    // タイ: 2 つの行のちょうど真ん中
    { name: "2 行の真ん中", anchors: [100, 200], y: 150, want: undefined },
    // タイ: 3 行のうち 2 つが同距離（3 つ目は遠い）
    { name: "3 行のうち 2 つが同距離", anchors: [700, 100, 200], y: 150, want: undefined },
    // タイ: **最初に見つかる最小が後から並ばれる**形（`reduce` の走査順に依る）
    { name: "先に見つかった最小に後から並ぶ", anchors: [200, 100], y: 150, want: undefined },
    // タイ: **同じ y の anchor が 2 つ**（cluster が分けそこねた場合）
    { name: "同じ y の anchor が 2 つ", anchors: [100, 100], y: 100, want: undefined },
    // **タイでないもの**は今までどおり選ぶ（恒偽の検査にしない）
    { name: "はっきり近い方（下寄り）", anchors: [100, 200], y: 149.9, want: 100 },
    { name: "はっきり近い方（上寄り）", anchors: [100, 200], y: 150.1, want: 200 },
    // **1 ulp 差はタイではない**（`===` で判定しているので、隣の表現可能な数は別扱い）
    { name: "1 ulp だけ上", anchors: [100, 200], y: ulp(150, true), want: 200 },
    { name: "1 ulp だけ下", anchors: [100, 200], y: ulp(150, false), want: 100 },
    // anchors が 1 つならタイになりようがない
    { name: "行が 1 つ", anchors: [100], y: 1e9, want: 100 },
    // anchors が空（parseVotePdf は continue するが、関数としては undefined）
    { name: "行が無い", anchors: [], y: 0, want: undefined },
  ];
  const wrong: string[] = [];
  for (const c of cases) {
    const got = nearestAnchor(c.anchors, c.y);
    if (got !== c.want) wrong.push(`${c.name}: ${String(got)} （期待 ${String(c.want)}）`);
  }
  assert.equal(cases.length, 10, "母数: 10 通り見ているはず");
  assert.deepEqual(wrong, [], `nearestAnchor がタイで行を選んでしまう（${wrong.length} / ${cases.length}）`);
});

/**
 * **タイを検出する規則が、実装依存の「たまたま」ではないことを見る。**
 *
 * **`anchors` の並び順を変えるとタイの勝者が変わる**——それが `reduce` の走査順に依るということである。
 * **タイを `undefined` にしていれば、並べ替えても答えは変わらない**（＝どちらも `undefined`）。
 * **タイで片方を選んでいれば、並べ替えで答えが変わる**（＝別の議案の票になる）。
 */
test("#1023 島根 nearestAnchor: タイのとき anchors の並び順で答えが変わらない", () => {
  const base = [400, 300, 200, 100];
  let checked = 0;
  const wrong: string[] = [];
  // タイになる y（隣り合う anchor の中点）を全部作る
  for (let i = 0; i + 1 < base.length; i++) {
    const y = (base[i] + base[i + 1]) / 2;
    const forward = nearestAnchor(base, y);
    const reversed = nearestAnchor([...base].reverse(), y);
    checked++;
    if (forward !== undefined) wrong.push(`y=${y}: 並び順どおりだと ${forward} を選んだ`);
    if (reversed !== undefined) wrong.push(`y=${y}: 逆順だと ${reversed} を選んだ`);
    if (forward !== reversed) wrong.push(`y=${y}: 並び順で答えが変わる（${String(forward)} / ${String(reversed)}）`);
  }
  assert.equal(checked, 3, "母数: 隣り合う 3 対の中点を見ているはず");
  assert.deepEqual(wrong, [], `タイの答えが anchors の並び順に依っている（${wrong.length} 件）`);
});

/* ───────────────── 2. 本物の座標に摂動を入れる ───────────────── */

/**
 * **1 ulp（浮動小数で隣の表現可能な数）**。`Math.nextUp` / `Math.nextDown` はこの Node には無いので、
 * **64 bit の並びを 1 だけ進める／戻す**（正の有限値だけを扱う。この PDF の y はすべて正）。
 * **「1 ulp」は「これ以上小さい摂動は無い」という意味**なので、
 * **ここが変わらなければ、丸め誤差のどんな揺れでも変わらない。**
 */
const ULP_BUF = new ArrayBuffer(8);
const ULP_F64 = new Float64Array(ULP_BUF);
const ULP_U64 = new BigUint64Array(ULP_BUF);
function ulp(v: number, up: boolean): number {
  if (!Number.isFinite(v) || v <= 0) return v;
  ULP_F64[0] = v;
  ULP_U64[0] += up ? 1n : -1n;
  return ULP_F64[0];
}

/**
 * **摂動**: 1 ulp（浮動小数で隣の表現可能な数）と 1e-5 pt。
 * **#1000 が測った丸め誤差の桁（1e-13 〜 1e-5 pt）の両端**を取っている。
 * **符号は種から決める**（`Math.random` は使わない——落ちたときに再現できない検査は直せない）。
 */
const PERTURBATIONS = [
  { name: "1 ulp", apply: (y: number, up: boolean): number => ulp(y, up) },
  { name: "1e-5 pt", apply: (y: number, up: boolean): number => y + (up ? 1e-5 : -1e-5) },
] as const;

const SEEDS = [7, 13, 42] as const;

/** 決まった種の擬似乱数（線形合同法）。**再現できない検査は落ちても直せない。** */
function rng(seed: number): () => number {
  let s = seed || 1;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
}

/**
 * **本物の座標に摂動を入れて、票の行き先が 1 つも変わらないことを見る**（#1023 の指示）。
 *
 * **合成した座標では測らない**——`parseVotePdf` が実際に `nearest` へ渡した
 * **`anchors`（行の基準）と票の y** を `rowAssignments` から取り、そのまま摂動させる。
 *
 * **摂動は 1 ulp（浮動小数で隣の表現可能な数）と 1e-5 pt。**
 * **#1000 が実測した丸め誤差の桁（1e-13 〜 1e-5 pt）の両端**である。
 * **票の y と行の基準の両方**を、種から決めた向きに動かす。
 *
 * **実測（2026-09-25）**:
 * **8 本 / 28 ページ / 行の基準 329 / 票 11,119 / 種 3 × 摂動 2 = 66,714 回**のうち、
 * **行き先が変わったのは 0 回**（別の行へ 0 / タイで不明へ 0）。
 *
 * **この検査が空振りでないことは変異で確かめてある**（PR 本文の表）。
 */
test("#1023 島根: 本物の座標（行の基準と票の y）を摂動させても、票の行き先は 1 つも変わらない", async () => {
  let books = 0, pages = 0, anchorCount = 0, markCount = 0, trials = 0;
  let movedToOtherRow = 0, movedToTie = 0;
  const wrong: string[] = [];
  for (const file of votePdfs()) {
    let pdf: Awaited<ReturnType<typeof parseVotePdf>>;
    try { pdf = await parseVotePdf(readFileSync(`${FIXTURES}${file}`)); } catch { continue; }
    books++;
    for (const ra of pdf.rowAssignments) {
      pages++;
      anchorCount += ra.anchors.length;
      markCount += ra.markYs.length;
      for (const seed of SEEDS) {
        const r = rng(seed);
        for (const pert of PERTURBATIONS) {
          // 行の基準をまとめて摂動させる（向きは種から。**`Math.random` は使わない**）
          const jittered = ra.anchors.map((a) => pert.apply(a, r() > 0.5));
          for (const y of ra.markYs) {
            const base = nearestAnchor(ra.anchors, y);
            const got = nearestAnchor(jittered, pert.apply(y, r() > 0.5));
            trials++;
            if (base === undefined) { wrong.push(`${file} p${ra.page} y=${y}: 摂動前からタイ`); continue; }
            // 摂動後の行は、摂動前に選ばれた行の「同じ番地」でなければならない
            const wantIdx = ra.anchors.indexOf(base);
            const gotIdx = got === undefined ? -1 : jittered.indexOf(got);
            if (gotIdx === wantIdx) continue;
            if (gotIdx === -1) { movedToTie++; continue; } // 安全な向き（不明に落ちる）だが実測は 0
            movedToOtherRow++;
            wrong.push(`${file} p${ra.page} ${pert.name} seed ${seed} y=${y}: 行 ${wantIdx} → ${gotIdx}`);
          }
        }
      }
    }
  }
  // **母数**（#757。0 回なら何も主張していない）
  assert.equal(books, 8, `前提: 読めた本が ${books} 本（実測は 8 本）`);
  assert.equal(pages, 28, `前提: 票の行があるページが ${pages}（実測は 28）`);
  assert.equal(anchorCount, 329, `前提: 行の基準が ${anchorCount}（実測は 329。parseVotePdf の行数と同じ）`);
  // **読めた 8 本ぶんで 11,119**。全 9 本を数えると 11,154 になるが、
  // **r0705rinji は「1 つのセルに票が 2 つ」で例外になる**ので rowAssignments が返らない（既知）。
  assert.equal(markCount, 11119, `前提: 票が ${markCount} 個（実測は 11,119）`);
  assert.equal(trials, 11119 * SEEDS.length * PERTURBATIONS.length,
    `前提: 試行が ${trials}（11,119 × 種 3 × 摂動 2 = 66,714）`);
  // **本題**
  assert.deepEqual(wrong.slice(0, 5), [], `摂動で票が別の行へ移った（${movedToOtherRow} 件 / ${trials} 回。**#569 の重いほう**）`);
  assert.equal(movedToTie, 0, `摂動でタイになり ${UNKNOWN_CELL} に落ちた（${movedToTie} 件 / ${trials} 回。安全な向きだが実測は 0）`);
});

/* ───────────────── 3. 本番の出力が 1 セルも変わらない ───────────────── */

/**
 * **本番が取りに行く 5 本が、タイを 1 つも起こさないことを固定する。**
 *
 * **これが 0 でなくなったら、票が `不明` に落ちている**（＝利用者に見える形で記録が減る）。
 * **0 のうちは、この直しは本番の出力を 1 セルも変えていない。**
 *
 * **母数は実測で固定する**（#757。一律のしきい値は守りにならない）:
 * **本番 5 本 = 231 行 / 8,085 セル / 7,730 記号。`data/assemblies/pref-32/` の数と一致する。**
 */
test("#1023 島根: 本番が使う 5 本でタイは 0 件（＝この直しは本番の票を 1 つも変えない）", async () => {
  let rows = 0, cells = 0, marks = 0, unknownInCells = 0, tiedItems = 0, tiedMarks = 0;
  for (const file of PRODUCTION_PDFS) {
    const pdf = await parseVotePdf(readFileSync(`${FIXTURES}${file}`));
    rows += pdf.rows.length;
    tiedItems += pdf.tiedItems;
    tiedMarks += pdf.tiedMarks;
    for (const r of pdf.rows) {
      cells += r.cells.length;
      for (const c of r.cells) {
        if (c === "○" || c === "●") marks++;
        if (c === UNKNOWN_CELL) unknownInCells++;
      }
    }
  }
  // **母数**（`data/assemblies/pref-32/rollcalls/**` を数えた値と同じ。2026-09-25）
  assert.equal(rows, 231, `前提: 本番の採決は 231 行（実測 ${rows}）`);
  assert.equal(cells, 8085, `前提: 本番の (議員, セル) 対は 8,085（実測 ${cells}）`);
  assert.equal(marks, 7730, `前提: 本番の ○/● は 7,730（実測 ${marks}）`);
  assert.equal(unknownInCells, 0, `本番の 5 本に ${UNKNOWN_CELL} のセルが ${unknownInCells} 個ある（実測は 0）`);
  // **本題**
  assert.equal(tiedMarks, 0, `本番の票が ${tiedMarks} 個、行が決まらず ${UNKNOWN_CELL} に落ちた（実測は 0）`);
  assert.equal(tiedItems, 0, `本番で行が決まらなかった文字が ${tiedItems} 個（実測は 0）`);
});

/** フィクスチャ全部（本番の 5 本 + 過去の 3 本）でも同じ。**母数は実測で固定する。** */
test("#1023 島根: フィクスチャ 8 本 329 行 11,613 セルでタイは 0 件", async () => {
  let books = 0, rows = 0, cells = 0, tiedItems = 0, tiedMarks = 0;
  for (const file of votePdfs()) {
    let pdf: Awaited<ReturnType<typeof parseVotePdf>>;
    // `r0705rinji` は「1 つのセルに票が 2 つ」で落ちる既知の本（この検査の対象ではない）
    try { pdf = await parseVotePdf(readFileSync(`${FIXTURES}${file}`)); } catch { continue; }
    books++;
    rows += pdf.rows.length;
    tiedItems += pdf.tiedItems;
    tiedMarks += pdf.tiedMarks;
    for (const r of pdf.rows) cells += r.cells.length;
  }
  assert.equal(books, 8, `前提: 読めた本が ${books} 本（実測は 8 本 / 置いてあるのは 9 本）`);
  assert.equal(rows, 329, `前提: 行が ${rows}（実測は 329）`);
  assert.equal(cells, 11613, `前提: セルが ${cells} 個（実測は 11,613 個）`);
  assert.equal(tiedMarks, 0, `票が ${tiedMarks} 個、行が決まらなかった（実測は 0）`);
  assert.equal(tiedItems, 0, `行が決まらなかった文字が ${tiedItems} 個（実測は 0）`);
});

/* ───────── 3b. 落とした票がラベルで埋まらない（#1023 のレビューで見つかった穴） ───────── */

/**
 * **タイで落とした票が「議⾧」「除斥」「棄権」にならないことを、総当たりで固定する。**
 *
 * **これはこの PBI でいちばん重い検査である。** **元の PR には 1 件も無かった。**
 *
 * **なぜ総当たりが要るか。** **実データに同距離のタイは 1 件も無い**（`nearest` 12,489 回で 0）。
 * **だから「タイになったとき何が出るか」は本物の PDF では 1 度も観測できない。**
 * **観測できないものを「安全だ」と書いたのが元の PR の誤りだった。**
 * **`dropForTest` で「この (ページ, 列) の票は行が決まらなかったことにする」を外から起こし、
 * 全ページ × 全列を総当たりして、落ちた先が必ず `UNKNOWN_CELL` であることを見る。**
 *
 * **実測（ref `9dc1f065`）**:
 *
 * | 母数 | 票が落ちた組 | **不明にならずラベルになったセル** |
 * |---|---:|---:|
 * | フィクスチャ 9 本・**990 組** | **955** | **18** → **0**（`tiedCols` で塞いだ後） |
 * | **本番の 5 本**・**630 組** | **607** | **12** → **0** |
 *
 * **塞ぐ前に出た 12 件は実在の議員だった**（`○ → 議長` 高橋雅彦 / `○ → 除斥` 中島謙二 /
 * `○ → 議⾧` 山根成二 / `○ → 除斥` 池田一）。
 *
 * **「落ちた組の数」も固定する**（955 / 607）——**0 組なら何も主張していない。**
 * **`dropForTest` が効かなくなれば、この検査は「不一致 0 件」で静かに緑になる**（分類 4 の穴）。
 *
 * ## **この検査は重い**（測った。**隠さずに書く**）
 *
 * **990 組それぞれで `parseVotePdf` を呼ぶので PDF を 990 回読み直す。実測 140 秒。**
 * **`readPages`（pdfjs）が費用のほぼ全部である**（1 本あたり `readPages` 211ms /
 * `parseVotePdf` 154ms の実測——`readPages` は `parseVotePdf` の中でも呼ばれる）。
 *
 * **etl の全体は 196 秒 → 275 秒**（`node --test` はファイルを並行に流すので、
 * 足した 140 秒のうち壁時計に出たのは約 79 秒）。
 * **`ci.yml` の `check` job は実測 153〜225 秒に対して `timeout-minutes: 30` なので収まる。**
 *
 * **「ラベルの塊がある列」だけに絞れば 990 → 48 組に落ちる**（実測）**が、そうしなかった。**
 * **絞る条件は「どの列が危ないか」という私の読みであり、読みが外れたら検査も外れる。**
 * **総当たりなら読みが要らない。** **費用を払って読みを捨てた**、という判断である。
 */
test("#1023 島根: タイで落とした票は必ず 不明 になる（ラベルで埋めない。全ページ × 全列の総当たり）", async () => {
  let combosAll = 0, droppedAll = 0, labelledAll = 0;
  let combosProd = 0, droppedProd = 0, labelledProd = 0;
  const labelled: string[] = [];
  for (const file of votePdfs()) {
    const bytes = readFileSync(`${FIXTURES}${file}`);
    let base: Awaited<ReturnType<typeof parseVotePdf>>;
    try { base = await parseVotePdf(bytes); } catch { continue; }
    const isProd = (PRODUCTION_PDFS as readonly string[]).includes(file);
    const pageNos = [...new Set(base.rows.map((r) => r.page))];
    const nCols = base.members.length;
    for (const page of pageNos) {
      for (let col = 0; col < nCols; col++) {
        combosAll++; if (isProd) combosProd++;
        let got: Awaited<ReturnType<typeof parseVotePdf>>;
        try { got = await parseVotePdf(bytes, { pageCol: `${page}:${col}` }); } catch { continue; }
        let anyDrop = false;
        for (let i = 0; i < base.rows.length; i++) {
          const b = base.rows[i].cells[col];
          const a = got.rows[i].cells[col];
          if (b === a) continue;
          anyDrop = true;
          // **落ちたなら必ず 不明**。ラベル（議⾧・除斥・棄権…）になってはいけない
          if (a === UNKNOWN_CELL) continue;
          labelledAll++; if (isProd) labelledProd++;
          if (labelled.length < 8) {
            labelled.push(`${file} p${base.rows[i].page} ${base.rows[i].number} / ${base.members[col]}: ${b} → ${a}`);
          }
        }
        if (anyDrop) { droppedAll++; if (isProd) droppedProd++; }
      }
    }
  }
  // **母数**（#757。**0 組を見ても何も主張しない**）
  assert.equal(combosAll, 990, `前提: (ページ, 列) の組が ${combosAll}（実測は 990）`);
  assert.equal(combosProd, 630, `前提: 本番 5 本の組が ${combosProd}（実測は 630）`);
  assert.equal(droppedAll, 955, `前提: 票が落ちた組が ${droppedAll}（実測は 955）。dropForTest が効いていない疑い`);
  assert.equal(droppedProd, 607, `前提: 本番で票が落ちた組が ${droppedProd}（実測は 607）`);
  // **本題**（塞ぐ前は 18 / 12 だった）
  assert.deepEqual(labelled, [],
    `落とした票がラベルになった（全 ${labelledAll} 件 / 本番 ${labelledProd} 件。**#569 の重いほう——`
    + `rollcalls.ts の MAPPED を通って mapped: "投票なし" になる**）`);
  assert.equal(labelledProd, 0, `本番の 5 本で ${labelledProd} 件（塞ぐ前は 12 件）`);
});

/* ───────── 3c. `===` が拾う範囲を、測った数のまま固定する ───────── */

/**
 * **「`===` で足りる」は実測より強い書きぶりだった**（#1023 のレビューの指摘）。**その範囲を測って固定する。**
 *
 * **本物の `anchors` から隣り合う 2 つの幾何学的な中点 `(A[i]+A[i+1])/2` を全部作って通すと、
 * 幾何学的には等距離なのに 3 分の 1 はタイと判定されない**（`(A[i]+A[i+1])/2` を double で
 * 計算した時点で 1 位と 2 位の差が 0 にならない）。
 *
 * **実測（ref `9dc1f065`。フィクスチャ 8 本）**:
 *
 * | 母数 | **`undefined`（タイ）** | **行を選んだ** | 差の最小 / 中央 / 最大 |
 * |---:|---:|---:|---|
 * | **301 対** | **200（66.4%）** | **101（33.6%）** | **1.42e-14 / 5.68e-14 / 1.14e-13 pt** |
 *
 * **ただし 101 対とも `anchors` を逆順にしても答えは変わらない**（実測 0 対）——
 * **差は `reduce` の走査順の産物ではなく、計算された double の実差なので決定的である。**
 * **＝#1023 の元の問題（並び順が票の行き先を決める）は確かに消えている。**
 *
 * **そして実データの 1 位 2 位差の最小は 8.15996 pt で、1e-14 の領域とは 14 桁離れている。**
 * **だからこれは「いま壊れる」ではなく「守る範囲は 66% である」という事実の記録である。**
 */
test("#1023 島根 nearestAnchor: 幾何学的な中点 301 対のうち 200 対がタイ、101 対は 1e-14 pt の差で行が選ばれる", async () => {
  let pairs = 0, tie = 0, picked = 0, orderDependent = 0;
  const gaps: number[] = [];
  for (const file of votePdfs()) {
    let pdf: Awaited<ReturnType<typeof parseVotePdf>>;
    try { pdf = await parseVotePdf(readFileSync(`${FIXTURES}${file}`)); } catch { continue; }
    for (const ra of pdf.rowAssignments) {
      const A = ra.anchors;
      for (let i = 0; i + 1 < A.length; i++) {
        const y = (A[i] + A[i + 1]) / 2;
        pairs++;
        const got = nearestAnchor(A, y);
        if (got === undefined) { tie++; continue; }
        picked++;
        const d = A.map((a) => Math.abs(a - y)).sort((p, q) => p - q);
        gaps.push(d[1] - d[0]);
        // **並び順に依っていないこと**（#1023 の元の問題が消えていることの確認）
        if (nearestAnchor([...A].reverse(), y) !== got) orderDependent++;
      }
    }
  }
  gaps.sort((a, b) => a - b);
  // **母数**（実測で固定する。#757）
  assert.equal(pairs, 301, `前提: 隣り合う中点が ${pairs} 対（実測は 301）`);
  assert.equal(tie, 200, `前提: タイと判定されたのが ${tie} 対（実測は 200 = 66.4%）`);
  assert.equal(picked, 101, `前提: 行が選ばれたのが ${picked} 対（実測は 101 = 33.6%）`);
  // **選ばれた 101 対の差は、どれも丸め誤差の下端の桁である**（1e-13 pt 未満）
  assert.ok(gaps.at(-1)! < 1e-12, `選ばれた対の差の最大が ${gaps.at(-1)} pt（実測は 1.14e-13 pt 未満）`);
  // **本題: 並び順に依らない**（#1023 の元の問題が消えていること）
  assert.equal(orderDependent, 0,
    `中点で anchors の並び順によって答えが変わった（${orderDependent} 対 / ${picked} 対）。**#1023 の元の問題が戻っている**`);
});

/* ───────────────── 4. 残る 6 県を、ソースの形で固定する ───────────────── */

/**
 * **6 県（高知・三重・宮城・奈良・徳島・鳥取）が「y で行を選んでいない」ことをソースで固定する**（#1023）。
 *
 * **「読み直して安全だと思った」は測定ではない。** そこで **6 県のソースを読んで数える。**
 *
 * **6 県はどれも同じ 3 行である**（実測。2026-09-25）:
 *     if (!within(it.cy, y0 + EDGE, y1 - EDGE)) { unplaced.push(it); continue; }
 *     const c = bandIndex(grid.voteCols, it.cx);
 *     if (c === undefined) unplaced.push(it);
 * **y は「この行の中に在るか」の真偽にしか使われない**（`within` は `>` と `<` だけ。
 * **行と行を比べない**）。**在らなければ `unplaced` ＝ `UNKNOWN_CELL` に落ちる**（記録が出ない側）。
 * **セルの値を決めるのは `bandIndex(..., it.cx)` ＝ x だけ**である。
 *
 * **だから y が 1 ulp 揺れても、票が別の行へ移る道が無い**——
 * **移れるのは「行の中」から「行の外（＝不明）」へだけ。**
 * **島根にはこの `within` によるふるいが無く、`nearest` が行を選ぶ。そこが違いの全部である。**
 *
 * **これは allowlist（「この 3 行が在ること」を要求）と denylist（`Math.abs(...y...)` を禁じる）の併用である。**
 * **ただし、この 3 行を消す／`it.cx` を `it.cy` に変えるといった壊し方は捕まえる**（変異 M6 / M7 で確かめた）。
 *
 * ## **すり抜ける形を、測って名指しで書く**（#1023 のレビューが実際に当てた）
 *
 * **「denylist なので穴がある」は元の PR が自分で開示していたが、レビュアーが実測した。**
 * **次の 2 つは、この検査を素通りする**（どちらも **9 件中 fail 0**。ref `9dc1f065`）:
 *
 * | 変異 | すり抜ける理由 |
 * |---|---|
 * | **奈良**の `readRows` に `(ry - it.cy) ** 2` で行を選ぶ形を足す | **`Math.abs` を使わない**（2 乗で距離を作る）ので denylist の正規表現に当たらない |
 * | **徳島**の `readRows` に `pickRowByY(it.cy)` を足す（allowlist の 3 行は残す） | **距離の計算を別の関数に出す**と `readRows` の本体に現れない |
 *
 * **＝この検査は「6 県が y で行を選んでいない」ことの保証ではない。**
 * **「いまの 6 県が、いまの 3 行の形をしている」ことの固定である。**
 * **本当に保証するには 6 県それぞれに振る舞いの検査（本物の PDF に摂動を当てる）が要るが、
 * この PBI ではやっていない**（島根だけ `rowAssignments` を持っている）。**別の PBI が要る。**
 *
 * **denylist の部分は、自分を消す変異でも落ちない**（実測。この行の `if (nearestLike.length > 0)` を
 * `if (false)` にしても **9 件中 fail 0**）——**いまの 6 県が 1 つも引っかかっていないので、
 * 消しても違いが出ない。** **＝denylist は「将来の壊し方」にしか効かず、いま何も守っていない。**
 * **allowlist の 3 行（`bandIndex(..., it.cx)` / `within(it.cy, ...)` / `unplaced`）は
 * 消す変異で落ちる**（M6 / M7）**ので、守っているのはそちらである。**
 */
test("#1023 6 県（高知・三重・宮城・奈良・徳島・鳥取）の票のセルは x だけで決まる", () => {
  const prefs = ["kochi", "mie", "miyagi", "nara", "tokushima", "tottori"] as const;
  const offenders: string[] = [];
  let checked = 0;
  for (const pref of prefs) {
    const src = readFileSync(fileURLToPath(new URL(`../src/sources/local/${pref}/votes-pdf.ts`, import.meta.url)), "utf8");
    // **票の道は `readRows` の中だけ**を見る。ファイル全体を見ると票と関係ない道に当たる
    // （実装中に踏んだ: **鳥取の `headerLines` が見出しを y でまとめている**——
    //  あれは見出しの文字列を組み立てるだけで、票のセルには触れない。**当ててしまうと検査が嘘になる**）。
    const fnStart = src.indexOf("\nfunction readRows(");
    assert.ok(fnStart >= 0, `${pref}: readRows が見つからない（名前が変わったら、この検査を直すこと）`);
    const fnEnd = src.indexOf("\n}", fnStart);
    assert.ok(fnEnd > fnStart, `${pref}: readRows の終わりが見つからない`);
    const body = src.slice(fnStart, fnEnd);
    // **切り出しが関数の終わりまで届いているか**（行頭 `}` で切るので、届いていなければ後半を見落とす。
    //  **見落とせば検査は恒真になる**）
    assert.equal(body.split("{").length - body.split("}").length, 1,
      `${pref}: readRows の切り出しが関数の終わりまで届いていない（後半を見落とす）`);
    // 1. **票のセルは x の帯で決まる**（この 1 行が無ければ、置き直しが消えている）
    const place = body.match(/const c = bandIndex\(grid\.voteCols, it\.cx\);/g) ?? [];
    if (place.length !== 1) { offenders.push(`${pref}: 票の置き直し（bandIndex(grid.voteCols, it.cx)）が ${place.length} か所（1 のはず）`); continue; }
    // 2. **y は「行の中に在るか」のふるいにだけ使われ、行と行を比べない**
    const sift = body.match(/if \(!within\(it\.cy, y0 \+ EDGE, y1 - EDGE\)\) \{ unplaced\.push\(it\); continue; \}/g) ?? [];
    if (sift.length !== 1) { offenders.push(`${pref}: y のふるい（within(it.cy, ...) → unplaced）が ${sift.length} か所（1 のはず）`); continue; }
    // 3. **置けなかった文字は UNKNOWN_CELL に落ちる**（＝記録が出ない側に倒れる）
    if (!/for \(const it of unplaced\)/.test(body)) { offenders.push(`${pref}: unplaced を ${UNKNOWN_CELL} にする処理が無い`); continue; }
    // 4. **「最も近い行」を選ぶ書き方が、票の道に無い**（島根と同じ形が入ったら落とす）
    const nearestLike = body.match(/Math\.abs\([^)]*\bc?y\b[^)]*\)/g) ?? [];
    if (nearestLike.length > 0) offenders.push(`${pref}: readRows の中で y の距離を比べている（${nearestLike.join(" / ")}）`);
    checked++;
  }
  assert.equal(checked, 6, `母数: 6 県ぶん見ているはず（実際に通ったのは ${checked} 県）`);
  assert.deepEqual(offenders, [], `6 県のどれかで票のセルの決まり方が変わった（${offenders.length} 件）`);
});

/**
 * **島根が「唯一の例外」であることを、11 県を数えて固定する**（#1023）。
 *
 * **`votes-pdf.ts` を持つのは 11 県**（実測: `ls packages/etl/src/sources/local/<県>/votes-pdf.ts`）。
 * **そのうち票の行き先を y の比較で決めているのは島根 1 県だけ**——
 * **その事実が変わったら（12 県目が増えた／別の県が y で選ぶようになった）、ここが落ちる。**
 */
test("#1023 votes-pdf.ts を持つのは 11 県で、島根の nearestAnchor はタイを undefined にする", () => {
  const dir = fileURLToPath(new URL("../src/sources/local/", import.meta.url));
  const prefs = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => existsSync(`${dir}${e.name}/votes-pdf.ts`))
    .map((e) => e.name).sort();
  assert.equal(prefs.length, 11, `votes-pdf.ts を持つ県が ${prefs.length}（実測は 11。増えたら票の道を測ること）: ${prefs.join(", ")}`);
  assert.ok(prefs.includes("shimane"), "島根が居ない");

  // **島根の `nearest` は `nearestAnchor` を通っている**（`reduce` の直書きに戻ったら落とす）
  const src = readFileSync(fileURLToPath(new URL("../src/sources/local/shimane/votes-pdf.ts", import.meta.url)), "utf8");
  assert.ok(src.includes("nearestAnchor(anchors, y)"),
    "島根の nearest が nearestAnchor を通っていない（タイの検出が外れている）");
  assert.ok(!/anchors\.reduce\(\(best, a\) =>/.test(src),
    "島根に `anchors.reduce((best, a) => ...)` の直書きが戻っている（タイで黙って片方を選ぶ）");
  // **票の行き先はタイなら置かない**（`markByRow.get(nearest(it.y))!` に戻ったら落とす）
  assert.ok(!/markByRow\.get\(nearest\(/.test(src),
    "島根の票が nearest(it.y) の結果を直に使っている（タイを検査していない）");
});
