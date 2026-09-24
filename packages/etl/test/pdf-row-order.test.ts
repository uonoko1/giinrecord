import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { parseVotePdf, rowOrderedForTest as rowOrdered } from "../src/sources/local/mie/votes-pdf.ts";
import type { Item } from "../src/sources/local/pdf-table.ts";
import { comparatorsIn } from "./comparator-shape.ts";

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
 * **`pdf-table.ts` の `joinVertical` が、許容差つきの並べ替えになっていないこと**（#999）。
 *
 * ## なぜ文字列の grep をやめたか（**レビューで実証された**）
 *
 * **直す前のこの検査は `pdf-table.ts` のソースを `/1e-5/` と `/rowOrdered/` で見ていた。**
 * **レビュアーが 2 通りの回避を実証し、どちらも全件緑で通った**:
 *   - **`0.00001` と書き、`rowOrdered` という名前を使わずに `joinVertical` へ注入する**
 *   - **元の `sort` 行を残したまま、その直後で `sorted.sort(...)` し直す**
 * **私も両方を当て直して、17 件中 0 件 fail（＝素通り）を確認した。**
 * **denylist の文字列一致は、綴りを変えられた時点で何も守らない。**
 *
 * ## なぜ重いか（#569）
 *
 * **`joinVertical` は議員の氏名（`nameText`）を組み立てる**。
 * **徳島・島根・宮城・奈良・秋田・高知・滋賀・青森の 8 県が通る。**
 * **ここが非推移的な比較で並ぶと、V8 の `sort` は要素数でアルゴリズムを変えるので、
 * 氏名が黙って別の順に組まれる**——**「別人の記録が出る」そのものである。**
 *
 * ## どう固定するか: **振る舞いで見る**
 *
 * **`joinVertical` を、許容差つきなら必ず結果が変わる形で呼ぶ。**
 * **`y` が `tol` の半分だけ違い、`x` では逆順**の 2 文字を渡す:
 *   - **元の比較**（`b.y - a.y || a.x - b.x`）なら **y が優先**されて `上下` の順
 *   - **許容差つき**（同じ行とみなす）なら **x が優先**されて `下上` の順
 * **実装を何と名付けようと、どこに書こうと、振る舞いが変われば落ちる。**
 */
test("#999 射程: 共有層の joinVertical は許容差を持たない（8 県の議員氏名が通る道）", async () => {
  const { joinVertical } = await import("../src/sources/local/pdf-table.ts");
  // **#999 の tol（h の 1e-5）の半分**。許容差があれば「同じ行」に入る大きさ
  const h = 8.4;
  const d = h * 1e-5 / 2;
  // **上の文字のほうが x が大きい**——**y で並べば `上下`、x で並べば `下上`**
  const up = { str: "上", x: 900, y: 600, w: h, h, cx: 900 + h / 2, cy: 600 + h / 2 };
  const down = { str: "下", x: 100, y: 600 - d, w: h, h, cx: 100 + h / 2, cy: 600 - d + h / 2 };
  assert.ok(up.y > down.y, "前提: 上のほうが y が大きい");
  assert.ok(up.x > down.x, "前提: x では逆順（許容差があれば下が先に来る並び）");
  assert.equal(joinVertical([up, down]), "上下",
    "joinVertical が許容差つきになっている（#999 の tol の半分で順序が変わった）。8 県の議員氏名がこの関数を通る");
  // **入れ替えて渡しても同じ**（比較が壊れていれば、ここで入力順に引きずられる）
  assert.equal(joinVertical([down, up]), "上下", "joinVertical の結果が入力の順序で変わった");
});

/**
 * **共有層の `sort` を全部数え上げて、比較式を allowlist で固定する**（#757。**母数つき**）。
 *
 * **denylist（「これが入っていなければよい」）ではなく allowlist（「これしか無い」）にする。**
 * **数え上げた総数も固定する**ので、**新しい `sort` を足せば、それだけで落ちる。**
 * **上の振る舞いの検査と二重にしてある**——
 * **振る舞いは `joinVertical` 1 か所しか見ないが、こちらは共有層の全部を見る。**
 */
test("#999 射程: 共有層 pdf-table.ts の sort は 2 か所で、どちらも許容差を持たない", () => {
  const src = readFileSync(new URL("../src/sources/local/pdf-table.ts", import.meta.url), "utf8");
  // **コメントを除いてから数える**（docblock の中の `.sort(` を拾わない）
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const comparators = [...code.matchAll(/\.sort\(([^;]*?)\)(?:;|\.)/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
  // **母数**（#757）。「許容差 0 件」と「sort を 1 つも見ていない」を同じ出力にしない
  assert.equal(comparators.length, 2, `共有層の sort ${comparators.length} か所: ${comparators.join(" / ")}`);
  // **allowlist: この 2 つだけ**。どちらも「厳密な比較」で、許容差を持たない
  assert.deepEqual(comparators.sort(), [
    "(a, b) => a - b",                        // cluster: 値の昇順
    "(a, b) => b.y - a.y || a.x - b.x",       // joinVertical: 上から下、同じ y なら左から右
  ], "共有層の sort の比較式が allowlist から外れた（#999 の許容差が染み出していないか確かめること）");
});

/**
 * **どの県のファイルにも「許容差つきの比較関数」が無いこと**（**構文木で見る。文字列ではなく**）。
 *
 * ## ここは #1000 まで denylist だった（#1008 が実測で穴を出した）
 *
 * **#1000 が置いた検査は `/\.sort\(\s*\([^)]*\)\s*=>[^;]*?\?\s*0\s*:/` で、
 * 「三項で、リテラル `0` を返す」という 1 つの綴りだけを禁じていた。**
 * **#1008 で 10 通りの綴りを実際に当てて測った**（宮城の氏名の組み立てを差し替え、
 * **`pdf-row-order.test.ts` の 19 件が赤くなるか**を見た。詳しい表は `comparator-shape.ts` の docblock）:
 * **10 通りのうち 8 通りが 19 件中 0 件 fail（＝完全素通り）だった。**
 * **いちばん普通の `if (Math.abs(a.y - b.y) <= t) return a.x - b.x;` も素通りした。**
 *
 * ## だから allowlist にした（#858 と同じ向き: 黙って通る側に落ちない）
 *
 * **`test/comparator-shape.ts` が、`sort` / `toSorted` の比較関数を構文木で拾い、
 * 「差（`-`）と `||` の連鎖、および 0 にならない三項」だけを許す。**
 * **それ以外は綴りを問わず落ちる**——**知らない書き方は「通す」ではなく「落とす」に倒れる。**
 *
 * ## 母数（#757。「0 件」と「1 つも見ていない」を区別する）
 *
 * **下限で押さえる**（**#1008: 68 という固定値は、許容差と無関係なファイルを足すだけで落ち、
 * 次の人が「68 → 69」と機械的に書き換える運用になる。母数が「数えた証拠」でなく「写した数字」になる**）。
 * **代わりに「県のディレクトリを全部読んだ」ほうを直接確かめる。**
 * **実測（2026-09-25）: 県 11 / ファイル 68 / 比較関数 103 / allowlist から外れたもの 0。**
 */
test("#999 #1008 射程: 県ごとのファイルの比較関数が allowlist の形（差と || の連鎖）から外れていない", () => {
  const dir = new URL("../src/sources/local/", import.meta.url);
  const bad: string[] = [];
  const prefs: string[] = [];
  let scanned = 0;
  let comparators = 0;
  for (const pref of readdirSync(dir)) {
    const sub = new URL(`${pref}/`, dir);
    try { if (!statSync(sub).isDirectory()) continue; } catch { continue; }
    prefs.push(pref);
    for (const f of readdirSync(sub)) {
      if (!f.endsWith(".ts")) continue;
      scanned++;
      for (const c of comparatorsIn(f, readFileSync(new URL(f, sub), "utf8"))) {
        comparators++;
        if (c.reason) bad.push(`${pref}/${f}:${c.line} [${c.reason}] ${c.text}`);
      }
    }
  }
  // **県のディレクトリを全部読んだこと**（**ファイル数の固定値ではなく、県の名前そのもので押さえる**。
  // **県を足したらここが落ちる＝新しい県を検査に載せ忘れない**）
  assert.deepEqual(prefs.sort(), ["akita", "aomori", "kochi", "mie", "miyagi", "nara", "saga", "shiga", "shimane", "tokushima", "tottori"],
    `県のディレクトリ: ${prefs.join(" ")}`);
  // **下限**（#1008）。**「1 ファイルも読んでいない」「1 つも比較関数を見ていない」を 0 件と区別する**
  assert.ok(scanned > 60, `読んだファイル ${scanned}（実測 68。下限 60 で押さえる）`);
  assert.ok(comparators > 90, `見た比較関数 ${comparators}（実測 103。下限 90 で押さえる）`);
  assert.deepEqual(bad, [], `allowlist から外れた比較関数:\n${bad.join("\n")}`);
});

/**
 * **`comparator-shape.ts` そのものを、合成したソースで固定する**（**リポジトリの今の中身に依存しない**）。
 *
 * **上の検査は「今のリポジトリに違反が無い」ことしか言わない**——
 * **`comparatorsIn` が常に空を返すように壊れても、上は緑のままである。**
 * **だからここで「違反を渡したら必ず落ちる」ほうを固定する。**
 * **#1008 で旧 denylist を素通りした 8 通りを含む、16 通りをそのまま並べてある**
 * （**残り 8 通りは、この allowlist のどの規則が効いているかを 1 つずつ殺して確かめるために足した**——
 * **#1008 の変異の表で K1〜K9 のどれを殺しても必ず 1 件落ちる**ようにするため）。
 */
test("#999 #1008 射程: 旧 denylist を素通りした綴り 16 通りを、構文木の allowlist は全部落とす", () => {
  // **#1008 の実測で「旧 denylist が 19 件中 0 件 fail」だったもの（8 通り）＋ 捕まえていた 2 通り ＋ 規則ごとの 6 通り**
  const mutants: [string, string][] = [
    ["if で早期 return", `xs.sort((a, b) => { if (Math.abs(a.y - b.y) <= t) return a.x - b.x; return b.y - a.y; });`],
    ["三項だが 0 を書かない", `xs.sort((a, b) => Math.abs(a.y - b.y) <= t ? a.x - b.x : b.y - a.y);`],
    ["Math.round で行に丸める", `xs.sort((a, b) => Math.round(b.y / t) - Math.round(a.y / t) || a.x - b.x);`],
    ["toSorted", `xs.toSorted((a, b) => Math.abs(a.y - b.y) <= t ? 0 : b.y - a.y);`],
    ["比較関数を定数に切り出す", `const CMP = (a, b) => Math.abs(a.y - b.y) <= t ? 0 : b.y - a.y; xs.sort(CMP);`],
    ["分割代入", `xs.sort(({ y: ay, x: ax }, { y: by, x: bx }) => Math.abs(ay - by) <= t ? ax - bx : by - ay);`],
    ["添字でプロパティを取る", `xs.sort((a, b) => Math.abs(a["y"] - b["y"]) <= t ? 0 : b["y"] - a["y"]);`],
    ["?? で繋ぐ", `xs.sort((a, b) => (Math.abs(a.y - b.y) <= t ? undefined : b.y - a.y) ?? (a.x - b.x));`],
    ["三項で 0 を返す（旧 denylist も捕まえていた）", `xs.sort((a, b) => Math.abs(a.y - b.y) <= t ? 0 : b.y - a.y);`],
    ["function 式で書く", `xs.sort(function (a, b) { if (Math.abs(a.y - b.y) <= t) return 0; return b.y - a.y; });`],
    // **`if` の枝の中身が allowlist に合う `-` でも落ちること**（**枝の式ではなく「本体の形」で落とす**）
    ["if で早期 return（枝はどちらも素の差）", `xs.sort((a, b) => { if (near(a, b)) return a.x - b.x; return b.y - a.y; });`],
    // **比較を関数呼び出しに丸ごと隠す**（**中が見えない＝許容差かどうか分からない。分からないものは落とす**）
    ["比較を関数呼び出しに隠す", `xs.sort((a, b) => cmpWithTol(a, b));`],
    // **同じファイルの中に定義が無い識別子**（**import してきた比較関数。追えないので落とす**）
    ["追えない識別子を渡す", `import { CMP } from "./elsewhere.ts"; xs.sort(CMP);`],
    // **本体の文が `return <式>;` 1 つでない**（**最初の文が return なので、
    // 「唯一の文が return か」の規則では捕まらない。「文が 1 つ」の規則だけが捕まえている**）
    ["本体の文が 2 つで、最初が return", `xs.sort((a, b) => { return rowOf(a, t) - rowOf(b, t) || a.x - b.x; log(a); });`],
    // **本体の唯一の文が return ではない**（**文は 1 つなので「文が 1 つ」の規則では捕まらない。
    // 「唯一の文が return か」の規則だけが捕まえている**）
    ["本体の唯一の文が return ではない", `xs.sort((a, b) => { if (near(a, b)) return 0; });`],
    ["本体の手前に許容差の丸めを置く", `xs.sort((a, b) => { const ay = Math.round(a.y / t); const by = Math.round(b.y / t); return by - ay || a.x - b.x; });`],
  ];
  for (const [name, code] of mutants) {
    const found = comparatorsIn("m.ts", code);
    assert.equal(found.length, 1, `${name}: 比較関数が 1 つ見つかるはず（${found.length}）`);
    assert.ok(found[0].reason, `${name}: allowlist を素通りした（${found[0].text}）`);
  }
  // **今のリポジトリに実在する形は、1 つも落としてはいけない**（**偽陽性の検査**。
  // **全部落とすだけの検査は「強い」のではなく使えない**）
  const good = [
    `xs.sort((a, b) => b.y - a.y || a.x - b.x);`,
    `xs.sort((a, b) => a - b);`,
    `xs.sort((a, b) => rowOf.get(b)! - rowOf.get(a)! || a.x - b.x);`,
    `xs.sort((a, b) => b.year * 100 + b.month - (a.year * 100 + a.month) || (a.sessionId < b.sessionId ? 1 : -1));`,
    `xs.sort((a, b) => b[1] - a[1] || b[0] - a[0]);`,
    `xs.sort((a, b) => { return b.y - a.y || a.x - b.x; });`,
  ];
  for (const code of good) {
    const found = comparatorsIn("g.ts", code);
    assert.equal(found.length, 1, `比較関数が 1 つ見つかるはず: ${code}`);
    assert.equal(found[0].reason, null, `正しい比較を落とした（偽陽性）: ${code} → ${found[0].reason}`);
  }
  // **比較関数を渡さない `sort()` は対象にしない**（文字列の既定順。許容差を書けない）
  assert.deepEqual(comparatorsIn("n.ts", `xs.sort();`), []);
});

/**
 * **この検査が捕まえられない形**（**塞げないと分かっていて残す。気づかずに残すのとは違う**）。
 *
 * **`sort` / `toSorted` を経由しない自前の並べ替え**は、構文木では「並べ替え」と分からない。
 * **#1008 で手書きの挿入ソートを宮城に当てたところ、この検査でも素通りする**（下で固定する）。
 *
 * **共有層（`pdf-table.ts`）についてはこれで困らない**——
 * **上の `joinVertical` の振る舞いの検査が、実装の書き方を一切見ずに落とすからである**
 * （**#1000 のレビュアーが手書きの挿入ソートを当てても落ちた**）。
 * **県ごとの写しには、対応する振る舞いの検査がまだ無い。そこが残っている穴である。**
 *
 * **倒れる向き（#569）**: **破られたとき起きるのは「別人の記録が出る」**——
 * **議員の氏名が黙って別の順に組まれる**ので、**利用者からは検出できない。**
 * **ただし #1008 の実測では、今のフィクスチャでこの穴が実害に届くかは確かめられていない**
 * （**11 県 127 本・`joinVertical` 呼び出し 11,592 回で、「y が 3pt 以内で x が逆順」の対は 0 組**だった。
 * **つまり今のデータでは許容差 3pt までは等価変異になる。守られているのではなく、データが揃っているだけである**）。
 */
test("#999 #1008 射程: sort を経由しない自前の並べ替えは、この検査では捕まえられない（既知の穴）", () => {
  const manual = `const s = []; for (const c of cs) { let k = 0; while (k < s.length && !(Math.abs(s[k].y - c.y) <= t ? s[k].x > c.x : s[k].y < c.y)) k++; s.splice(k, 0, c); }`;
  assert.deepEqual(comparatorsIn("manual.ts", manual), [],
    "自前の並べ替えを捕まえられるようになったら、この検査（既知の穴の記録）を消して上の allowlist に寄せること");
});

test("#999 射程: rowOrdered を使っているのは三重だけ", () => {
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
