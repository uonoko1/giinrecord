import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cluster, readPages, within, type PageGeometry, type RotatedPageGeometry } from "../src/sources/local/pdf-table.ts";
import * as aomori from "../src/sources/local/aomori/votes-pdf.ts";
import * as saga from "../src/sources/local/saga/votes-pdf.ts";
import * as akita from "../src/sources/local/akita/votes-pdf.ts";
import { UNKNOWN_CELL } from "../src/sources/local/akita/votes-pdf.ts";
import * as shiga from "../src/sources/local/shiga/votes-pdf.ts";

/**
 * # 「票のセルは、渡されたアイテムの並び順に依らない」ことを固定する（Issue #1002）
 *
 * ## 何を測りに来たか
 *
 * **#999 / #1000 で、並べ替えの比較（`b.y - a.y || a.x - b.x`）が丸め誤差でひっくり返る揺れが
 * 三重で見つかった。** **#1000 の担当者がフィクスチャを数え、揺れは三重だけではなかった**——
 * **青森 27 対 / 佐賀 20 対 / 秋田 12 対 / 滋賀 4 対**。
 * **ただし「その揺れが各県の票に届いているか」は、そのとき測られていなかった。**
 * **届いていれば #569 の重いほう——「別人の票が出る」——であり、利用者からは検出できない。**
 *
 * ## 結論（測定。2026-09-25）
 *
 * **4 県とも、票のセルの値は入力の並び順に依らない。届いていない。**
 * **ただし「三重と同じ理由」ではなかった。4 県は同じ作りではない。**
 *
 * | 県 | 票のセルが並べ替えを**通るか** | 通るとき、**順位を使うか** | 届かない理由 |
 * |---|---|---|---|
 * | **青森** | **通らない** | — | `columnOf(band.cols, it.cx)` で **x の帯に置くだけ**（三重と同じ形） |
 * | **佐賀** | **通る** | **使う**（`placed[k]` → k 列目） | **x で並べる。y も比較関数の第 1 キーも無い** |
 * | **秋田** | **通る** | **使う**（`core[k]` → k 列目） | 同上 |
 * | **滋賀** | **通る** | **使わない** | 並べた後 `bandIndex(m.cx)` で**置き直す**（並びは捨てられる） |
 *
 * **#999 の揺れは y の丸め誤差だった。4 県の票の道には y が無い**ので、構造上そこには届かない。
 *
 * ## 実測（母数つき。#757）
 *
 * **フィクスチャ 4 県 35 本。読めた 32 本 / 728 行 / **(議員, セル) 30,692 対** / 不明 20 セル。**
 *
 * **`readPages` の中で `items` を混ぜる変異を当て、種 7 / 13 / 42 の 3 通りで通した結果、
 * 30,692 対のうち変わったのは 0 対。**
 * （差が出た本は `shiga/Kg274_250628-sanpi.pdf` の 1 本だけ。**この本は混ぜる前から
 * 氏名が空・30 セルすべて `不明`** で、混ぜると例外で落ちる。**票の値が入れ替わったのではない。**）
 *
 * **この道具が空振りでないことを先に示した**——
 * **秋田の `marks.sort((a, c) => a.cx - c.cx)` を逆順にする変異を当てると、
 * 同じ道具が 9 本 / 9,399 対の変化を検出した**（母数 30,692）。
 *
 * ### **票になる記号の x は、丸め誤差より 2 桁以上離れている**
 *
 * | 県 | 票の行 | 票になる記号の隣接 x の対 | **差が 0 の対** | **最小の正の差** |
 * |---|---:|---:|---:|---:|
 * | 青森 | 173 | 8,258 記号（帯に置く。順位を使わない） | — | **境界までの余裕 2.128 pt** |
 * | 佐賀 | 203 | **7,229** | **0** | **1.094e+1 pt** |
 * | 秋田 | 181 | **9,254**（芯 7,543） | **0** | **1.828e-3 pt** |
 * | 滋賀 | — | — | — | 並びを使わない（下の変異で実証） |
 *
 * **丸め誤差の桁は 1e-13 〜 1e-5 pt**（#1000 の実測）。**いちばん際どい秋田でも 1.828e-3 pt で、
 * 2 桁以上離れている。**
 *
 * ### 秋田に「差 0 の対」は在った——**票の行ではなかった**
 * **同じ行の記号アイテムの隣接対 7,129 のうち 4 対で x が完全に一致する**（実測）。
 * **4 対とも `h231202giketu.pdf` の見出し**
 * （`平成２３年９月定例会（１２月議会）` / `各議員の表決状況`。**`議` を含むので記号として拾われる**）
 * **で、その帯の記号アイテムは 4 個しかない。**
 * **秋田は `marks.length < 20` の帯を票の行にしない**ので、**4 対とも票の道に入らない。**
 * **票の行だけに絞ると 9,254 対のうち 差 0 は 0 対**（上の表）。
 *
 * ### 滋賀の並べ替えは、**出力に対して no-op である**（変異で実証。母数 2,467 対）
 *
 * | 変異 | 変わった対 / 滋賀の母数 2,467 |
 * |---|---:|
 * | `marks.sort` を**逆順**にする | **0** |
 * | `marks.sort` を**丸ごと消す** | **0** |
 * | 衝突の解決を**後勝ち**（`cells[c] = m.ch`）にする | **0**（＝10 本で**同じ列に 2 個落ちた列が 1 つも無い**） |
 *
 * ## **本番の範囲と、測った範囲は同じではない**（**混ぜると誤読する。#1002 の指示**）
 *
 * **私が振る舞いで測ったのは「フィクスチャ 35 本」であって、本番の全量ではない。**
 * **数えた**（2026-09-25。`data/assemblies/pref-{02,05,25,41}/rollcalls/`）:
 *
 * | 県 | 本番の採決 | **本番の票** | 本番が使う PDF | **うちフィクスチャにある** | **直接測れた票** |
 * |---|---:|---:|---:|---:|---:|
 * | 青森 | 611 | 29,015 | 14 | 4 | **6,096（21%）** |
 * | 秋田 | 785 | 32,022 | 29 | 5 | **4,551（14%）** |
 * | 滋賀 | 163 | 6,886 | 28 | 3 | **784（11%）** |
 * | 佐賀 | 366 | 13,542 | 13 | 5 | **3,626（26%）** |
 * | **合計** | **1,925** | **81,465** | **84** | **17** | **15,057（18%）** |
 *
 * **つまり「混ぜても変わらなかった 30,692 対」は、本番の票 81,465 のうち 18% しか直接は覆っていない。**
 * **「本番は全部測った」とは言えない。**
 *
 * ### **それでも本番の全量について言えること**——**理由が振る舞いではなく構造だから**
 *
 * **4 県の `readVoteCells` は y を 1 度も読まない**（下の検査がソースで固定している）。
 * **これは PDF ごとの性質ではなくコードの性質なので、84 本すべてに等しく効く。**
 * **#999 の揺れは y の丸め誤差である以上、y を読まない関数には届かない。**
 *
 * **言えるのはここまでで、「x の丸め誤差なら届きうるか」は別の問い**である——
 * **フィクスチャで測った範囲では、票になる記号の x の最小の差は 1.828e-3 pt（秋田）で、
 * 丸め誤差より 2 桁以上大きい。残り 67 本ではこれを測っていない。**
 *
 * **`data/` は 1 ファイルも変えていない。**
 *
 * ## この検査が守るもの
 *
 * **「今 0 である」ことではなく、「票の道に順序依存を持ち込んだら落ちる」ことを守る。**
 * **各県が公開している `readVoteCells`（票を決める当の関数）に、
 * 実フィクスチャから取った本物の入力を、並びを変えて渡す。**
 * **許容差つきの非推移的な比較を票の道に足せば、ここが落ちる**
 * （#1000 の N2 と同じ壊れ方を、県の側で捕まえる）。
 *
 * ## 変異テスト（**素通りしたものも、等価だったものも、そのまま書く**）
 *
 * | # | 変異 | 6 件中 fail | 出力が変わった対 / 母数 |
 * |---|---|---:|---|
 * | **M1** | 秋田 `marks.sort` を**逆順** | **1**（秋田） | 9,399 / 30,692（4 県合計） |
 * | **M4** | 青森 `columnOf(cols, it.cx)` → **`it.cy`** | **1**（y の検査） | **1,008 / 11,524**（青森） |
 * | **M4b** | 秋田 `core[k].cx` → **`core[k].cy`** | **1**（y の検査） | 未測定（検査が先に落ちる） |
 * | **M4c** | 滋賀 `bandIndex(voteCols, m.cx)` → **`m.cy`** | **1**（y の検査） | 同上 |
 * | **M4d** | 佐賀 `bandIndex(cols, placed[k].x)` → **`placed[k].y`** | **1**（y の検査） | 同上 |
 * | **M5** | 共有層 `joinVertical` に許容差（#1000 の X1） | **1**（共有層の検査） | — |
 * | M3 | 佐賀 2 つ目の sort に許容差（非推移） | 0 | **0 / 7,432（等価変異）** |
 * | M3b | 佐賀 1 つ目の sort に許容差 | 0 | **0 / 7,432（等価変異）** |
 * | M6 | 青森 衝突の解決を**後勝ち** | 0 | **0 / 11,524（等価変異）** |
 * | M7 | 滋賀 衝突の解決を**後勝ち** | 0 | **0 / 2,467（等価変異）** |
 * | M8 | 佐賀 `b !== k` の検算を**外す** | 0 | **0 / 7,432（等価変異）** |
 *
 * ### **素通りした 5 つは、全部「等価変異」だった**（**測って確かめた。言い訳ではない**）
 *
 * **M6 / M7 / M8 が外す守りは、このフィクスチャでは 1 度も発動しない**——
 * **同じ列に記号が 2 個落ちた列が 0**（青森 173 行 8,258 記号 / 滋賀 59 行）、
 * **佐賀の `b !== k` が真になった行が 0**（203 行）。
 * **秋田の docblock が自分で「154 本でこの枝は 1 度も効かない」と書いているのと同じ形である。**
 * **M3 / M3b は、入力が既に x 順で V8 の sort が安定なので、許容差をいくら大きくしても順序が動かない**
 * （tol = 12 / 25 / 40 の 3 通りで測って、いずれも 0 / 7,432）。
 *
 * **つまり「テストが弱い」のではなく「そのコードがこのデータでは到達しない」。**
 * **到達しない守りを検査で固定することはできない**ので、**ここでは数字だけ残す。**
 *
 * ## **この検査が捕まえないもの**（測っていないことは測っていないと書く）
 *
 * 1. **罫線（`vlines` / `hlines`）の並びは混ぜていない。** 列の境は罫線から作る県があるので、
 *    そちらの順序依存は見ていない。
 * 2. **混ぜて「たまたま同じ結果」になった可能性は消していない。** 種 3 通りは全数ではない。
 * 3. **`readPages` より前（pdfjs が返す順そのもの）は動かしていない。**
 *    pdfjs の版が変わってアイテムの順が変われば、ここは通ったまま出力が変わりうる。
 * 4. **本番が実際に取りに行っている PDF を全部は測っていない**（上の表。**84 本のうち 17 本**）。
 *    **残り 67 本で「票になる記号の x の最小の差」を測っていない。**
 *    **構造（y を読まない）は全量に効くが、振る舞いの測定は 18% である。**
 * 5. **y の denylist は `readVoteCells` の本体しか見ていない。**
 *    **票の道はその外にもある**（青森の `findNameBand` は y で帯を作る）。
 *    **そちらに y が居るのは正しい**（行を決めるため）ので禁じられない。
 *    **禁じられるのは「セルの値を決める関数」だけである。**
 * 6. **関数の本体は「次の行頭 `}` まで」で切っている。**
 *    **中に行頭 `}` を含む書き方（入れ子の関数など）をされると、後半を見落とす。**
 *    **見落とせば検査は恒真になる**ので、**波括弧の釣り合いを検査に入れた**
 *    （4 県とも差 1 ＝ 関数の終わりまで届いている。実測）。**それでも完全ではない。**
 */

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

/**
 * 決まった種の混ぜ方（線形合同法）。**`Math.random` を使わない**——
 * **落ちたときに再現できない検査は、落ちても直せない。**
 */
function shuffled<T>(a: readonly T[], seed: number): T[] {
  const out = [...a];
  let s = seed || 1;
  const rnd = (): number => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const SEEDS = [7, 13, 42] as const;

const pdfsIn = (pref: string): string[] => {
  try { return readdirSync(`${FIXTURES}${pref}`).filter((f) => f.endsWith(".pdf")).sort(); }
  catch { return []; }
};

const pages = async (pref: string, file: string): Promise<RotatedPageGeometry[]> =>
  readPages(readFileSync(`${FIXTURES}${pref}/${file}`));

/**
 * **青森・秋田は `/Rotate 90` を打ち消してから読む**（`parseVotePdf` が `raw.map(unrotate)` する）。
 * **打ち消さずに渡すと、秋田は `findMemberColumns` が 1 ページも返さず、検査が 0 回になる**
 * （実装中に踏んだ。**母数の検査が捕まえた**——`assert.ok(calls >= 100)` が
 * 「呼び出しが 0 回しかない」で落ちた。**これが無ければ「0 件不一致」で緑になっていた**）。
 */
const unrotate = aomori.unrotate;

/**
 * 1 件ぶんの検査。**`readVoteCells` に渡る本物の入力を集め、並びを変えて同じ結果が出るかを見る。**
 *
 * **`total` は「集めた入力の数」**（＝この本で `readVoteCells` を何回呼んだか）。
 * **0 回なら何も主張していない**ので、呼び手が母数を検査する（分類 4）。
 */
interface Probe { calls: number; cells: number; mismatches: string[] }

/* ---------- 青森 ---------- */

/**
 * 青森の票: `readVoteCells(symItems, band)` → `columnOf(band.cols, cx)` で x の帯に置く。
 * **`symItems` の並びは `page.items` の並びのまま渡る**ので、そこを混ぜる。
 */
function probeAomori(raw: RotatedPageGeometry): Probe {
  const out: Probe = { calls: 0, cells: 0, mismatches: [] };
  const page = unrotate(raw);
  const band = aomori.findNameBand(page);
  if (!band) return out;
  const inBand = { ...page, items: page.items.filter((i) => i.x + i.w > band.left && i.cx < band.right) };
  for (const b of aomori.voteRowBands(inBand)) {
    const base = aomori.readVoteCells(b.items, band);
    out.calls++;
    out.cells += base.length;
    for (const seed of SEEDS) {
      const got = aomori.readVoteCells(shuffled(b.items, seed), band);
      if (got.join("\t") !== base.join("\t")) out.mismatches.push(`seed ${seed} cy=${b.cy.toFixed(2)}`);
    }
  }
  return out;
}

/* ---------- 佐賀 ---------- */

/**
 * 佐賀の票: `readVoteCells(items, cols, n)` → **x で並べた `placed[k]` を k 列目に置く**。
 * **並びの順位をそのまま使う**ので、ここが順序に依れば票が入れ替わる。
 */
function probeSaga(page: PageGeometry): Probe {
  const out: Probe = { calls: 0, cells: 0, mismatches: [] };
  const cols = saga.memberColumns(page.vlines);
  if (cols.length === 0) return out;
  const n = cols.length - 1;
  for (const band of saga.readRowBands(page, cols)) {
    const base = saga.readVoteCells(band.items, cols, n);
    out.calls++;
    out.cells += base.length;
    for (const seed of SEEDS) {
      const got = saga.readVoteCells(shuffled(band.items, seed), cols, n);
      if (got.join("\t") !== base.join("\t")) out.mismatches.push(`seed ${seed} y=${band.y.toFixed(2)}`);
    }
  }
  return out;
}

/* ---------- 秋田 ---------- */

/**
 * 秋田の票: `voteRows(page)` が記号を cx で並べ、`readVoteCells(row, mc)` が
 * `voteRowCore(row.marks)` の `core[k]` を k 列目に置く。
 *
 * ## **混ぜるのは `page.items` であって `row.marks` ではない**（実装中に踏んだ。重要）
 *
 * **`voteRowCore` は「渡された `marks` が既に x 順に並んでいる」ことを前提にしている**
 * （隣り合う要素の差を「列の間隔」として見る）。
 * **`row.marks` を直に混ぜるとその前提を壊すので、`readVoteCells` の順序依存ではなく
 * 「前提を破ったときの振る舞い」を測ってしまう。**
 *
 * **測ってしまった結果も残しておく**（**壊れ方の向きが分かるので**）——
 * **`row.marks` を 3 通りの種で混ぜると、223 回の呼び出し / 27,807 セルのうち
 * 同じ 0 / **`不明` に落ちた 27,807** / **別の記号になった 0**。**
 * **前提を破っても「別人の票」にはならず、丸ごと落ちる**（#569 の軽いほうに倒れている）。
 * **`voteRowCore` の芯の長さが 43 → 4 になり、`core.length !== mc.n` で全セルが `不明` になる。**
 *
 * **正しい測り方は `page.items` を混ぜること**——**そこは誰も順序を約束していない**
 * （pdfjs が返した順がそのまま来るだけ）。**`voteRows()` の中の並べ替えごと通す。**
 *
 * ## **前提が破れたとき「別人の票」になる経路を探した**（PO の指摘を受けて測った）
 *
 * **「全部 `不明` に落ちる」は結果であって、保証ではない。**
 * **`voteRowCore` には `if (!(step > 0)) return [...marks];` という抜け道がある**——
 * **並んでいない入力では中央値の間隔が 0 以下になりうるので、そこを通ると
 * 「並べ替えられていない marks がそのまま芯として返る」。**
 * **そのとき長さが `mc.n` と一致すれば、`core[k].ch` が k 列目に入る＝別人の票になる。**
 *
 * **223 行 × 200 通りの混ぜ方 = 44,600 試行で、この経路をどこまで進むかを数えた**（実測）:
 *
 * | 段階 | 試行 |
 * |---|---:|
 * | 混ぜた試行（母数） | **44,600** |
 * | **`step <= 0` になった**（抜け道に入った） | **20,444** |
 * | **芯の長さが `mc.n` と一致した**（長さの検査を抜けた） | **1,192** |
 * | **`columnOf(...) === k` の検算まで通った** | **0** |
 * | **別人の票になった** | **0** |
 *
 * **つまり「長さが合う」ところまでは 1,192 回到達する。止めているのは `columnOf` の検算だけである。**
 * **秋田の docblock は「154 本でこの枝は 1 度も効かない」と書いているが、
 * それは正しい入力での話で、前提が破れた入力では 1,192 回効いている。**
 *
 * **余裕も測った**——**落ちた 1,192 回のうち 1,188 回（99.7%）は `k = 0`、
 * 残り 4 回が `k = 1` で、それより後ろまで通ったものは 0。**
 * **検算は「いちばん最初の記号」で捕まえており、薄氷ではない。**
 *
 * **`columnOf` の検算が本当に効いているかは、外して測った**（同じ 44,600 試行）:
 *
 * | | 素のコード | **検算を外す** |
 * |---|---:|---:|
 * | 全部 `不明` | 44,600 | 43,408 |
 * | **別人の票になった行** | **0** | **1,181** |
 * | **誤ったセル** | **0** | **6,742** |
 *
 * **だからここは「明文化すれば足りる」と判断した**（PBI を分けない）——
 * **守りは既にあり、外すと 1,181 行が別人の票になることまで測れている。**
 * **欠けていたのは前提の記述だけである。**
 * **`voteRowCore` と `readVoteCells` の docblock に、この表を添えて前提を書いた。**
 */
function probeAkita(raw: RotatedPageGeometry): Probe {
  const out: Probe = { calls: 0, cells: 0, mismatches: [] };
  const page = unrotate(raw);
  const mc = akita.findMemberColumns(page);
  if (!mc) return out;
  const base = akita.voteRows(page).map((r) => akita.readVoteCells(r, mc));
  out.calls += base.length;
  for (const c of base) out.cells += c.length;
  for (const seed of SEEDS) {
    const mixedPage = { ...page, items: shuffled(page.items, seed) };
    const mixedMc = akita.findMemberColumns(mixedPage);
    if (!mixedMc) { out.mismatches.push(`seed ${seed}: 混ぜると議員の列が作れない`); continue; }
    const got = akita.voteRows(mixedPage).map((r) => akita.readVoteCells(r, mixedMc));
    if (got.length !== base.length) { out.mismatches.push(`seed ${seed}: 行の数が ${base.length} → ${got.length}`); continue; }
    for (let i = 0; i < base.length; i++) {
      if (got[i].join("\t") !== base[i].join("\t")) out.mismatches.push(`seed ${seed} row ${i}`);
    }
  }
  return out;
}

/* ---------- 滋賀 ---------- */

/**
 * 滋賀の票: `readVoteCells(inRow, grid, vxs, memberCount)` → `marks.sort` した後
 * **`bandIndex(m.cx)` で置き直す**（並びは使われない）。**`inRow` の並びを混ぜる。**
 *
 * **`Grid` は合成しない**——`buildGridForTest` で実ページから作る。
 * **合成した骨格で測っても「実データでどうか」は何も言えない。**
 */
function probeShiga(page: PageGeometry, pageNo: number): Probe {
  const out: Probe = { calls: 0, cells: 0, mismatches: [] };
  const grid = shiga.buildGridForTest(page, pageNo);
  if (!grid) return out;
  const vxs = cluster(page.vlines.map((l) => l.x));
  const n = grid.voteCols.length - 1;
  // **`readRows` と同じ絞り方でなければならない**——列見出しと氏名帯の 1 文字を落とさずに
  // 渡すと、`readVoteCells` が「記号帯の無い行」と見て undefined を返し、
  // **検査の母数が静かに減る**（実装中に踏んだ: 59 回しか呼ばれず、母数の検査が落ちた）。
  const headers = new Set(["議案等番号", "件名", "議席番号", "会派名"]);
  for (let r = 0; r + 1 < grid.rowLines.length; r++) {
    const inRow = page.items.filter((i) => within(i.cy, grid.rowLines[r + 1], grid.rowLines[r])
      && !headers.has(i.str.replace(/[\s　]+/g, ""))
      && !([...i.str].length === 1 && i.cy >= grid.nameBottom - 1.0));
    if (inRow.length === 0) continue;
    const base = shiga.readVoteCells(inRow, grid, vxs, n);
    if (!base) continue;
    out.calls++;
    out.cells += base.length;
    for (const seed of SEEDS) {
      const got = shiga.readVoteCells(shuffled(inRow, seed), grid, vxs, n);
      if ((got ?? []).join("\t") !== base.join("\t")) out.mismatches.push(`seed ${seed} row ${r}`);
    }
  }
  return out;
}

/**
 * **母数は県ごとの実測値で固定する**（#757。**一律のしきい値では守りにならない**）。
 *
 * **`calls` / `cells` は `parseVotePdf` の行数・セル数と一致することを確かめてある**（2026-09-25 実測）:
 *
 * | 県 | 読めた本 | **行** | **(議員, セル) 対** |
 * |---|---:|---:|---:|
 * | 青森 | 7 | **243** | **11,524** |
 * | 佐賀 | 7 | **203** | **7,432** |
 * | 秋田 | 9 | **223** | **9,269** |
 * | 滋賀 | 9 | **59** | **2,467** |
 * | **合計** | **32** | **728** | **30,692** |
 *
 * **滋賀が 59 行しか無いのは、この 10 本にそれだけしか票の行が無いから**である
 * （行の枠 92 のうち 32 は記号帯が無く、1 は空。**実測**）。
 * **一律 100 行のしきい値にしていたとき、滋賀がここで落ちた**——
 * **しきい値のほうが間違っていた。** **数えてから書くこと。**
 *
 * **この数が減ったら落とす**——**「フィクスチャが読めなくなった」ことを、
 * 順序の検査が静かに素通りするのを防ぐ**（0 件不一致は、0 件しか見ていなければ何も主張しない）。
 */
const PROBES: { pref: string; run: (p: RotatedPageGeometry, n: number) => Probe; rows: number; cells: number }[] = [
  { pref: "aomori", run: (p) => probeAomori(p), rows: 243, cells: 11524 },
  { pref: "saga", run: (p) => probeSaga(p), rows: 203, cells: 7432 },
  { pref: "akita", run: (p) => probeAkita(p), rows: 223, cells: 9269 },
  { pref: "shiga", run: (p, n) => probeShiga(p, n), rows: 59, cells: 2467 },
];

/**
 * **県ごとに 1 件。本ごとに分けない**——
 * **「この本では `readVoteCells` が 1 回も呼ばれなかった」を県の合計で検査したいから。**
 * **本ごとに分けると、0 回の本が「通った」ことになり、母数を見ていない検査になる**（分類 4）。
 */
for (const { pref, run, rows: wantRows, cells: wantCells } of PROBES) {
  test(`#1002 ${pref}: readVoteCells に渡す並びを混ぜても票のセルは変わらない`, async () => {
    let calls = 0, cells = 0, books = 0;
    const mismatches: string[] = [];
    for (const file of pdfsIn(pref)) {
      let ps: RotatedPageGeometry[];
      try { ps = await pages(pref, file); } catch { continue; } // 文字層なし等。読めないことはこの検査の対象ではない
      books++;
      for (let i = 0; i < ps.length; i++) {
        let probe: Probe;
        try { probe = run(ps[i], i + 1); } catch { continue; } // 表の無いページ
        calls += probe.calls;
        cells += probe.cells;
        for (const m of probe.mismatches) mismatches.push(`${file} p${i + 1} ${m}`);
      }
    }
    // **母数の検査**（#757。**0 件を 0 件と比べても何も主張しない**）
    assert.ok(books > 0, `前提: ${pref} のフィクスチャの PDF が 1 本も読めていない`);
    assert.equal(calls, wantRows, `前提: ${pref} の票の行が ${calls}（実測は ${wantRows}）。フィクスチャか読み方が変わった`);
    assert.equal(cells, wantCells, `前提: ${pref} のセルが ${cells} 個（実測は ${wantCells} 個）`);
    assert.deepEqual(mismatches, [], `${pref}: 並びを変えると票が変わる（${mismatches.length} 件 / 呼び出し ${calls} 回 / セル ${cells} 個）`);
  });
}

/**
 * **「票を決める関数が y を 1 度も読まない」ことを、ソースを読んで固定する**（#1000 の 3 番目と同じ形）。
 *
 * **#999 の揺れは y の丸め誤差である。** 4 県の票の道に y が入った時点で、
 * **上の「混ぜる」検査を通ってしまう壊れ方が生まれる**——
 * **y は混ぜても値が変わらないので、混ぜる検査は y の誤りを原理的に見ない。**
 *
 * ## **最初は「y の差を取っていないか」しか見ておらず、素通りした**（変異で分かった）
 *
 * **変異 M4「青森の `columnOf(band.cols, it.cx)` を `it.cy` にする」を当てたとき、
 * 出力は 11,524 対のうち 1,008 対が変わったのに、検査は 6 件とも緑だった。**
 * **`it.cy` は「差」ではないので、`\w+\.c?y - \w+\.c?y` の形を探す検査には当たらない。**
 * **直して、`.y` / `.cy` を読むこと自体を禁じた**（票は x だけで決まるべきなので、
 * **この関数の中に y が現れる正当な理由が無い**）。
 *
 * **直した最初の形もまだ甘かった**——**`\w+\.c?y` と書いたので `core[k].cy` に当たらなかった**
 * （`]` は `\w` ではない）。**変異 M4b（秋田の `core[k].cx` → `core[k].cy`）が素通りした。**
 * **`\.c?y\b` に直して、ドットの前が何であっても当たるようにした。**
 * **「denylist を書いたら、自分の書いた denylist にも変異を当てる」**——
 * **1 回目も 2 回目も、当てるまで穴に気づかなかった。**
 *
 * **これは denylist なので「これで全部」ではない**——
 * **y を別名の変数に入れてから渡す / 比較を別ファイルに出す、といった形はすり抜ける。**
 * **上の振る舞いの検査が一次で、ここは二次である。**
 */
test("#1002 4 県の readVoteCells の本体が y / cy を 1 度も読まない", () => {
  const targets = [
    { pref: "aomori", file: "aomori/votes-pdf.ts" },
    { pref: "saga", file: "saga/votes-pdf.ts" },
    { pref: "akita", file: "akita/votes-pdf.ts" },
    { pref: "shiga", file: "shiga/votes-pdf.ts" },
  ];
  const offenders: string[] = [];
  let checked = 0;
  for (const t of targets) {
    const src = readFileSync(fileURLToPath(new URL(`../src/sources/local/${t.file}`, import.meta.url)), "utf8");
    const start = src.indexOf("export function readVoteCells");
    assert.ok(start >= 0, `${t.pref}: readVoteCells が見つからない（名前が変わったら、この検査を直すこと）`);
    // 関数の終わり = 次の行頭 `}` まで
    const end = src.indexOf("\n}", start);
    assert.ok(end > start, `${t.pref}: readVoteCells の終わりが見つからない`);
    const body = src.slice(start, end);
    // **切り出しが関数の終わりまで届いているか**を、波括弧の釣り合いで確かめる
    // （`\n}` で切るので、中に行頭 `}` があると後半を見落とす。**見落とせば検査は恒真になる**）
    assert.equal(body.split("{").length - body.split("}").length, 1,
      `${t.pref}: readVoteCells の切り出しが関数の終わりまで届いていない（後半を見落とす）`);
    checked++;
    // **`.y` / `.cy` を読むこと自体を禁じる**（差を取る形だけを見ると M4 が素通りする。上記）
    const hit = body.match(/\.c?y\b/g);
    if (hit) offenders.push(`${t.pref}: y を読んでいる（${hit.length} か所）`);
  }
  assert.equal(checked, 4, "4 県ぶん見ているはず（母数）");
  assert.deepEqual(offenders, [], "票を決める関数の中で y を読んでいる（#999 の揺れが票に届く道ができる）");
});

/**
 * **秋田の `columnOf` の検算が、前提の破れを本当に止めていることを固定する**（#1002）。
 *
 * **`voteRowCore` は「`marks` が cx の昇順」を前提にしている。**
 * **前提が破れた入力を作り、`readVoteCells` が「別人の票」を 1 つも出さないことを見る。**
 *
 * **これは上の「混ぜても変わらない」検査では守れない**——
 * **あちらは `page.items` を混ぜるので、`voteRows()` が並べ直してしまい、前提は破れない。**
 * **ここでは `row.marks` を直に混ぜて、前提そのものを破る。**
 *
 * **実測（2026-09-25。6 本 223 行 × 200 通り = 44,600 試行）**:
 * **素のコードでは 44,600 試行すべてが全セル `不明`。別人の票は 0。**
 * **`columnOf` の検算を外すと 1,181 行が別人の票になる（誤ったセル 6,742）。**
 * **＝この検査は空振りではない。**
 *
 * **検査では 200 通りではなく 20 通りにしてある**（CI の時間のため）。
 * **20 通りでも、検算を外す変異では落ちることを確かめてある。**
 */
test("#1002 秋田: marks の並び順の前提が破れても、別人の票は 1 つも出ない", async () => {
  let trials = 0, notAllUnknown = 0;
  const wrong: string[] = [];
  for (const file of pdfsIn("akita")) {
    let ps: RotatedPageGeometry[];
    try { ps = await pages("akita", file); } catch { continue; }
    for (const rp of ps) {
      const page = unrotate(rp);
      const mc = akita.findMemberColumns(page);
      if (!mc) continue;
      for (const r of akita.voteRows(page)) {
        const base = akita.readVoteCells(r, mc);
        for (let seed = 1; seed <= 20; seed++) {
          trials++;
          const got = akita.readVoteCells({ ...r, marks: shuffled(r.marks, seed) }, mc);
          if (got.every((c) => c === UNKNOWN_CELL)) continue; // 丸ごと落ちた＝安全な向き
          notAllUnknown++;
          // 落ちていないなら、元と 1 セルも違ってはいけない
          for (let k = 0; k < got.length; k++) {
            if (got[k] !== base[k] && got[k] !== UNKNOWN_CELL) {
              wrong.push(`${file} seed ${seed} 列 ${k}: ${base[k]} → ${got[k]}`);
            }
          }
        }
      }
    }
  }
  // **母数**（#757。0 試行なら何も主張しない）
  assert.equal(trials, 223 * 20, `前提: 秋田の票の行は 223 のはず（試行 ${trials} / 20 通り）`);
  assert.deepEqual(wrong.slice(0, 5), [], `別人の票が出た（${wrong.length} 件 / 試行 ${trials}）`);
  assert.equal(notAllUnknown, 0, `全セル 不明 にならなかった試行が ${notAllUnknown} 件（実測は 0 件）`);
});

/**
 * **共有層に染み出していないこと**（#1000 の【7】と同じ）。
 * **`pdf-table.ts` は 11 県の共通層である。** この PBI は 1 バイトも触っていない。
 */
test("#1002 共有層（pdf-table.ts）に許容差つきの並べ替えが無い", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/sources/local/pdf-table.ts", import.meta.url)), "utf8");
  assert.ok(!src.includes("1e-5"), "pdf-table.ts に許容差 1e-5 が入っている（三重の rowOrdered が染み出した）");
  assert.ok(!src.includes("rowOrdered"), "pdf-table.ts に rowOrdered が入っている");
  // **`joinVertical` の比較が元のまま**（8 県が議員氏名を組み立てる道。#1000 の X1）
  assert.ok(src.includes("const sorted = [...chars].sort((a, b) => b.y - a.y || a.x - b.x);"),
    "joinVertical の比較が変わっている（許容差が入ると #569 の「別人の記録」になる）");
});

