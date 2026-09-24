import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { parseVotePdf, rowOrderedForTest as rowOrdered } from "../src/sources/local/mie/votes-pdf.ts";
import type { Item } from "../src/sources/local/pdf-table.ts";

/**
 * **並べ替えが丸め誤差でひっくり返る問題**（Issue #999）。**三重の中だけで直している。**
 *
 * **直す前は `(b.y - a.y || a.x - b.x)` で並べていた。**
 * **`b.y - a.y` が 0 でなければ x を見ない**ので、同じ行なのに y が最下位ビットだけ違うと、
 * **左右の順序が y の丸め誤差で決まる。**
 *
 * **ここが守らなければならないのは 4 つある**（1 つでも欠けると守りにならない）:
 *   1. **許容差が小さすぎない**——誤差（`1e-6 h` まで）で順序がひっくり返らない
 *   2. **許容差が大きすぎない**——本物の差（`1e-4 h` から）を「同じ行」と潰さない
 *   3. **推移的である**——**入力の順序で結果が変わらない**（`sort` の契約。**これが本丸**）
 *   4. **三重の中で閉じている**——**共有層に染み出していない**（他 10 県が通る道にしない）
 */

/** 文字 1 つぶんの Item。`h` は三重の実データの代表値（8.4pt）に寄せてある。 */
const at = (str: string, y: number, x: number, h = 8.4): Item =>
  ({ str, x, y, w: h, h, cx: x + h / 2, cy: y + h / 2 });

const join = (items: Item[]): string => rowOrdered(items).map((i) => i.str).join("");

/** 与えた要素の全順列を並べ替えて、出てきた結果の集合を返す（1 通りでなければ順序依存がある）。 */
function allPermutationResults(items: Item[]): Set<string> {
  const out = new Set<string>();
  const perm = (rest: Item[], acc: Item[]): void => {
    if (rest.length === 0) { out.add(join(acc)); return; }
    for (let i = 0; i < rest.length; i++) perm([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, rest[i]]);
  };
  perm(items, []);
  return out;
}

/* ---------- 1. 基本の順序 ---------- */

test("#999 y がちょうど同じなら x の小さい順（今までと同じ振る舞い）", () => {
  assert.equal(join([at("川", 600, 30), at("石", 600, 10), at("原", 600, 50)]), "石川原");
});

test("#999 y が本当に違えば大きい順（上から下）。x は見ない", () => {
  // 差 8.4pt = h。許容差（h * 1e-5 = 8.4e-5）よりはるかに大きい
  assert.equal(join([at("下", 591.6, 0), at("上", 600, 999)]), "上下");
});

/* ---------- 2. 許容差が小さすぎないこと ---------- */

/**
 * **これが #999 そのものである。**
 * **三重の実データ（`000835026.pdf`）から取った値**——
 * **`"対"`(x=336.74, y=653.5) と `"日"`(x=278.78, y=653.4999999999999)。**
 * **差は 1.137e-13 pt で、`h`(8.4) に対して 1.35e-14。**
 * **直す前は `"日"` より `"対"` が先に出ていた**（x を見ないため）。
 */
test("#999 丸め誤差（1e-13 pt）で左右が入れ替わらない——実データの値", () => {
  const items = [at("対", 653.5, 336.74), at("日", 653.4999999999999, 278.78)];
  assert.ok(items[0].y - items[1].y > 0, "前提: y は確かに違う（等価な検査になっていないこと）");
  assert.ok(items[0].x > items[1].x, "前提: x では逆順（y だけで決めると入れ替わる並び）");
  assert.equal(join(items), "日対");
});

/**
 * **単精度で座標を持つ本の誤差**（実データ `000073636.pdf`。**1e-5 pt の桁**）。
 * **これが `000073636.pdf` を読めなくしていた当のものである**——
 * **左 8 列の見出しの 1 列目 `議案等番号` が、`"件名"`(x=173.28, y=694.280029296875) と
 * `"議"`(x=43.08, y=694.2800036621094) のように、差 2.563e-5 pt（`h`=8.64 に対して 3.0e-6）で
 * x の逆順に並んでいた。**
 * **許容差を `1e-13` のような「double の誤差ぶんだけ」にすると、この本は救えない。**
 */
test("#999 単精度の誤差（1e-5 pt）でも左右が入れ替わらない——実データの値", () => {
  const items = [at("件名", 694.280029296875, 173.28, 8.64), at("議", 694.2800036621094, 43.08, 8.64)];
  const d = items[0].y - items[1].y;
  assert.ok(d > 2.5e-5 && d < 2.6e-5, `前提: 差は 2.563e-5 pt のはず（実際 ${d.toExponential(3)}）`);
  assert.ok(items[0].x > items[1].x, "前提: x では逆順");
  assert.equal(join(items), "議件名");
});

/* ---------- 3. 許容差が大きすぎないこと ---------- */

/**
 * **実データの「本物の差」のいちばん小さいもの**（`000073608.pdf`。**`d/h = 1.781e-4`**）。
 * **`"公明党"`(x=1096.6) が `"県政みらい"`(x=1017.5) より 1.004e-3 pt だけ上にある。**
 * **x では逆順なので、許容差がここまで届くと `県政みらい公明党` になってしまう。**
 * **その本は下の「実物」のテストでフィクスチャとして固定してある**（値だけの主張にしない）。
 */
test("#999 本物の差（d/h = 1.78e-4）は潰さない——x が逆でも y が優先される", () => {
  const h = 5.64;
  const items = [at("公明党", 507.240000, 1096.6, h), at("県政みらい", 507.238996, 1017.5, h)];
  const d = items[0].y - items[1].y;
  assert.ok(d / h > 1.7e-4 && d / h < 1.9e-4, `前提: d/h は 1.78e-4 のはず（実際 ${(d / h).toExponential(3)}）`);
  assert.ok(items[0].x > items[1].x, "前提: x では逆順");
  assert.equal(join(items), "公明党県政みらい");
});

test("#999 許容差は h に比例する（同じ差でも、文字が小さければ別の行と見る）", () => {
  const y0 = 600, d = 5e-4; // h=8.4 なら許容差 8.4e-5 < d、h=100 なら 1e-3 > d
  assert.equal(join([at("右", y0, 50, 8.4), at("左", y0 - d, 0, 8.4)]), "右左", "小さい文字では別の行");
  assert.equal(join([at("右", y0, 50, 100), at("左", y0 - d, 0, 100)]), "左右", "大きい文字では同じ行（x で並ぶ）");
});

/* ---------- 4. 推移的であること（**この PR の本丸**） ---------- */

/**
 * **許容差を比較関数の中に入れると、比較が非推移的になる**——
 * **`A~B` かつ `B~C` でも `A≁C` になりうる**（`tol` のすぐ内側を 2 回またぐと届かない）。
 * **`Array.prototype.sort` は比較関数が全順序であることを前提にしているので、
 * 非推移的な比較を渡すと結果が入力の順序で変わる。**
 *
 * **実測（2026-09-24、`h=8.4` → `tol=8.4e-5`）**:
 * **比較関数に許容差を入れた実装では、6 通りの入力順が 3 通りの結果に割れた**
 * （`CBA` / `ACB` / `BAC`）。**元の `(b.y - a.y || a.x - b.x)` は 1 通り。**
 *
 * **`rowOrdered` は先に `cluster()` で行へ丸めてから `(行番号, x)` で比べるので、
 * 比べる量が整数と x だけになり、厳密に推移的である。**
 */
test("#999 推移的: tol をまたいで鎖になる 3 要素でも、入力の順序で結果が変わらない", () => {
  const h = 8.4;
  const tol = h * 1e-5;
  // A と B は tol 以内、B と C も tol 以内、しかし A と C は 2*tol 近く離れている
  const A = at("A", 600 + tol * 0.9, 100, h);
  const B = at("B", 600, 50, h);
  const C = at("C", 600 - tol * 0.9, 10, h);
  const results = allPermutationResults([A, B, C]);
  assert.equal(results.size, 1, `入力の順序で結果が変わった: ${[...results].join(" / ")}`);
});

test("#999 推移的: 誤差の幅いっぱいに 8 個並べても、入力の順序で結果が変わらない", () => {
  const h = 8.4;
  const tol = h * 1e-5;
  // **tol の 0.6 倍ずつずらして 8 個**。隣どうしは「同じ行」、端どうしは tol の 4 倍以上離れる。
  // **比較関数に許容差を入れる実装では、ここがいちばん割れる。**
  const items = Array.from({ length: 8 }, (_, i) => at(String.fromCharCode(65 + i), 600 - i * tol * 0.6, (7 - i) * 10, h));
  const seen = new Set<string>();
  // 全順列は 40,320 通りで重いので、決まった種でシャッフルした 200 通りを見る（再現できる乱数）
  let seed = 20260924;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let k = 0; k < 200; k++) {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    seen.add(join(a));
  }
  assert.equal(seen.size, 1, `入力の順序で結果が変わった: ${[...seen].slice(0, 4).join(" / ")}`);
});

/**
 * **比較が対称であること**（`cmp(A,B)` と `cmp(B,A)` が逆符号になる）。
 * **`tol` を「対ごとの `Math.max(a.h, b.h, 1)`」で決めると、ここが壊れる**——
 * **高さの違う 2 文字では、A から見た `tol` と B から見た `tol` が食い違いうる。**
 * **`rowOrdered` は一群でひとつの `tol` を決めるので、この形にならない。**
 */
test("#999 対称: 高さの違う文字が混ざっても、2 要素の順序は入れ替えて同じ", () => {
  // 小さい文字（h=1）と大きい文字（h=1000）。対ごとに tol を決めると 1e-5 と 1e-2 で 3 桁違う
  const P = at("大", 600, 100, 1000);
  const Q = at("小", 600 - 5e-3, 10, 1);
  assert.equal(join([P, Q]), join([Q, P]), "入れ替えると結果が変わった（比較が非対称）");
});

test("#999 対称: 2 要素の全対で、入れ替えても結果が同じ（高さも y もばらばら）", () => {
  const hs = [1, 5.64, 8.4, 8.64, 100];
  const ds = [0, 1e-13, 1e-6, 1e-5, 1e-4, 1e-2, 1];
  let checked = 0;
  for (const h1 of hs) for (const h2 of hs) for (const d of ds) {
    const P = at("P", 600, 100, h1);
    const Q = at("Q", 600 - d, 10, h2);
    assert.equal(join([P, Q]), join([Q, P]), `h1=${h1} h2=${h2} d=${d} で非対称`);
    checked++;
  }
  // **母数を出す**（#757）。「0 件」と「1 つも比べていない」を同じ出力にしない
  assert.equal(checked, hs.length * hs.length * ds.length, `比べた対 ${checked}`);
  assert.equal(checked, 175);
});

/**
 * **高さが 0 の文字しか無いとき**（`h` が取れない PDF）。
 * **`Math.max(..., 1)` の床が無いと `tol = 0` になり、誤差でひっくり返る側に戻る。**
 * **実データにこの形は無い**が、**床を外す変異を捕まえるために置いてある**
 * （**この検査が無いと「床を外す」が素通りする**）。
 */
test("#999 高さが取れない（h=0）ときも床 1 が効いて、微小な揺れでひっくり返らない", () => {
  // h=0 → 床が効けば tol = 1e-5。差 1e-13 はその内側なので x の順に並ぶ
  const items = [at("対", 653.5, 336.74, 0), at("日", 653.4999999999999, 278.78, 0)];
  assert.ok(items[0].x > items[1].x, "前提: x では逆順");
  assert.equal(join(items), "日対");
});

/* ---------- 5. 三重の中で閉じていること ---------- */

/**
 * **共有層（`pdf-table.ts`）に染み出していないこと**（#953。**「追記だけだから安全」は射程の議論ではない**）。
 *
 * **`tol = 1e-5 h` は三重の 151 本で測った値で、他県では余裕が 1.04 倍しかない**（佐賀）。
 * **共有層に置くと 11 県が通る道になり、測っていない県で効き始める。**
 *
 * **この検査はソースを読んで固定する**——**実装を移しただけでは落ちないので、
 * 「他県が通る関数に入れる」変異をここで捕まえる。**
 */
test("#999 射程: 許容差つきの並べ替えは共有層 pdf-table.ts に無い", () => {
  const src = readFileSync(new URL("../src/sources/local/pdf-table.ts", import.meta.url), "utf8");
  assert.ok(!/1e-5/.test(src), "pdf-table.ts に 1e-5（#999 の許容差）が入っている");
  assert.ok(!/rowOrdered|byRowThenColumn/.test(src), "pdf-table.ts に #999 の並べ替えが入っている");
  // **`joinVertical`（7 県が通る）は元の比較のままであること**——ここが染み出しの入口になる
  const jv = src.slice(src.indexOf("export function joinVertical"));
  assert.match(jv.slice(0, 200), /sort\(\(a, b\) => b\.y - a\.y \|\| a\.x - b\.x\)/,
    "joinVertical の比較が #999 の許容差つきに差し替えられている（7 県に染み出す）");
});

test("#999 射程: 許容差つきの並べ替えを使っているのは三重だけ", () => {
  const dir = new URL("../src/sources/local/", import.meta.url);
  const users: string[] = [];
  for (const pref of readdirSync(dir)) {
    const sub = new URL(`${pref}/`, dir);
    let isDir = false;
    try { isDir = statSync(sub).isDirectory(); } catch { isDir = false; }
    if (!isDir) continue;
    for (const f of readdirSync(sub)) {
      if (!f.endsWith(".ts")) continue;
      if (/rowOrdered/.test(readFileSync(new URL(f, sub), "utf8"))) users.push(`${pref}/${f}`);
    }
  }
  assert.deepEqual(users, ["mie/votes-pdf.ts"], `使っているファイル: ${users.join(" ")}`);
});

/* ---------- 6. 実物（端から端まで） ---------- */

/**
 * **`000073636.pdf`（平成25年定例会（6月））は、直す前は読めなかった**——
 * **左 8 列の見出しの照合で `column 0 header "案等番号議" !== 議案等番号` で止まっていた。**
 * **`議案等番号` の 5 文字が、単精度の丸め誤差（2.5e-5 pt）で `案等番号議` に入れ替わっていたためである。**
 *
 * **この検査は「読めること」だけでなく、読めた中身が一次資料と合うことまで見る**
 * （**「読めた」だけなら、中身が壊れていても通ってしまう**）。
 */
test("#999 実物: 000073636.pdf は丸め誤差で見出しがひっくり返り、読めなくなっていた", async () => {
  const pdf = await parseVotePdf(readFileSync(new URL("./fixtures/mie/000073636.pdf", import.meta.url)));
  assert.equal(pdf.title, "平成２５年定例会（６月）");
  assert.equal(pdf.sessionName, "平成２５年定例会");
  assert.equal(pdf.year, 2013);
  assert.equal(pdf.month, 6);
  assert.equal(pdf.pages, 2);
  assert.equal(pdf.members.length, 50);
  assert.equal(pdf.rows.length, 26);
  assert.equal(pdf.unknownCells, 0);
  // **1 行目は一次資料どおり**（議案第105号 平成25年度三重県一般会計補正予算（第１号））。
  // **直す前は `105号議案第` / `決可` のように崩れていた**（実測。この本だけで 45 対）
  const r0 = pdf.rows[0];
  assert.equal(r0.kind, "議案");
  assert.equal(r0.number, "第105号");
  assert.equal(r0.title, "平成25年度三重県一般会計補正予算（第１号）");
  assert.equal(r0.dateText, "6/28");
  assert.equal(r0.result, "可決");
  // **賛成者数と `○` の数が合う**（検算。票そのものが壊れていないこと）
  assert.deepEqual(r0.counts, { present: 50, voting: 49, yes: 49, no: 0 });
  assert.equal(r0.cells.length, pdf.members.length);
  // **全 26 行で賛成者数 ↔ `○` の数が合う**（1 行だけ見て済ませない）
  for (const r of pdf.rows) {
    assert.equal(r.cells.filter((c) => c === "○").length, r.counts.yes, `${r.kind}${r.number} の ○ の数`);
    assert.equal(r.cells.filter((c) => c === "×").length, r.counts.no, `${r.kind}${r.number} の × の数`);
    assert.equal(r.cells.filter((c) => c === "議").length, 1, `${r.kind}${r.number} の 議 は 1 人`);
  }
  // **件名も議決結果も崩れていない**（26 行すべて。**「行が読めた」だけでは足りない**）
  for (const r of pdf.rows) {
    assert.match(r.number, /^第[0-9]+号$/, `議案等番号が崩れている: ${r.kind}${r.number}`);
    assert.ok(["可決", "否決", "同意", "認定", "採択", "不採択", "承認"].includes(r.result), `議決結果が崩れている: ${r.result}`);
    assert.ok(!/^[0-9]/.test(r.title), `件名が数字で始まっている（崩れの兆候）: ${r.title}`);
  }
});

/**
 * **上界の根拠を実物で検算する**（`000073608.pdf`。**`1e-5 h` より上でいちばん小さい差に近いもの**）。
 *
 * **この本は別の理由で `parseVotePdf` が通らない**（`incomplete row`。#999 の射程外）ので、
 * **座標のところまでで検算する**——**値だけの主張にしないために、本そのものを置いてある。**
 *
 * **実測: `公明党`(x=1096.56, y=755.9585124287606) と `県政みらい`(x=1017.48, y=755.9573199973106)。**
 * **`d = 1.192431e-3 pt`、`h = 5.64`、`d/h = 2.114e-4`、`tol`(= 5.64e-5) の 21.14 倍。**
 * **x では逆順なので、`tol` がここまで届くと `県政みらい公明党` になる。**
 */
test("#999 実物: 000073608.pdf の 公明党 / 県政みらい は、tol の 21 倍離れた別の行である", async () => {
  const { readGlyphPages } = await import("../src/sources/local/mie/glyphs.ts");
  const pages = await readGlyphPages(readFileSync(new URL("./fixtures/mie/000073608.pdf", import.meta.url)));
  const a = pages[0].items.find((i) => i.str === "公明党");
  const b = pages[0].items.find((i) => i.str === "県政みらい");
  assert.ok(a && b, "公明党 / 県政みらい が 1 ページ目に無い");
  const d = a.y - b.y;
  const h = Math.max(a.h, b.h, 1);
  assert.ok(a.x > b.x, "前提: x では逆順（tol が届けば繋がってしまう並び）");
  assert.ok(d / h > 2.0e-4 && d / h < 2.2e-4, `前提: d/h は 2.114e-4 のはず（実際 ${(d / h).toExponential(3)}）`);
  // **この 2 つは別の行のままであること**（同じ行に潰れると順序が x で決まり、逆順になる）
  assert.equal(rowOrdered([a, b]).map((i) => i.str).join("|"), "公明党|県政みらい");
  // **tol の何倍あるかを数で残す**（#757。次に tol を動かす人が、余裕がどれだけ減るか見られるように）
  assert.ok(d / (h * 1e-5) > 21 && d / (h * 1e-5) < 22, `tol に対する余裕 ×${(d / (h * 1e-5)).toFixed(2)}（実測 21.14）`);
});

/**
 * **下界の根拠を実物で検算する**（`000835026.pdf`。**double の積算の丸め誤差**）。
 * **実測: `"対"`(x=336.74, y=653.5) と `"日"`(x=278.78, y=653.4999999999999)。差 1.137e-13 pt。**
 * **直す前はここで `"対日"` の順に出ていた。**
 */
test("#999 実物: 000835026.pdf の 1.1e-13 pt の揺れは同じ行として扱われる", async () => {
  const { readGlyphPages } = await import("../src/sources/local/mie/glyphs.ts");
  const pages = await readGlyphPages(readFileSync(new URL("./fixtures/mie/000835026.pdf", import.meta.url)));
  // **同じ行なのに y が違い、x では逆順**になっている対を探す（母数も出す）
  let found = 0;
  let sample = "";
  for (const p of pages) {
    const arr = [...p.items].sort((x, y) => y.y - x.y || x.x - y.x);
    for (let i = 0; i + 1 < arr.length; i++) {
      const d = arr[i].y - arr[i + 1].y;
      const h = Math.max(arr[i].h, arr[i + 1].h, 1);
      if (d > 0 && d / h < 1e-5 && arr[i].x > arr[i + 1].x) {
        found++;
        if (!sample) sample = `${arr[i].str}/${arr[i + 1].str} d=${d.toExponential(3)}`;
        // **直したあとは、この 2 つが x の順（左 → 右）に出ること**
        assert.deepEqual(rowOrdered([arr[i], arr[i + 1]]).map((it) => it.x), [arr[i + 1].x, arr[i].x],
          `${arr[i].str}/${arr[i + 1].str} が x の順になっていない`);
      }
    }
  }
  // **母数を出す**（#757）。0 件なら「揺れが無い本」を掴んでいて、この検査は何も主張していない
  assert.ok(found > 0, "この本に誤差でひっくり返る対が 1 つも無い（フィクスチャを取り違えている）");
  assert.equal(found, 3, `誤差で x が逆順の対 ${found}（実測 3。${sample}）`);
});

/**
 * **この本の会派名は壊れたまま出る**（**#998 §4-1 の別問題。この PR では直さない**）。
 * **「直っていない」ことを検査で固定しておく**——
 * **そうしないと、次にこの本を見た人が「読めているから大丈夫」と読んでしまう**（#569）。
 */
test("#999 ただし会派名は逆順のまま出る（#998 §4-1。この PR の射程外であることを固定する）", async () => {
  const pdf = await parseVotePdf(readFileSync(new URL("./fixtures/mie/000073636.pdf", import.meta.url)));
  const groups = [...new Set(pdf.members.map((m) => m.group))];
  assert.deepEqual(groups, ["えみ政新", "いらみ民自", "山鷹", "党明公", "みんなの党"]);
});
