import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readGlyphPageOps, readGlyphPages, pageRotationMatrix } from "../src/sources/local/mie/glyphs.ts";
import { parseVotePdf, readVerticalHeading } from "../src/sources/local/mie/votes-pdf.ts";
import { cluster, type Item } from "../src/sources/local/pdf-table.ts";

/**
 * # 三重: **回転 90 の 11 本**（Issue #867 B 群の残り。#969 / #994 の続き）
 *
 * ## 結論を先に: **機序は解けた。それでも票は 1 票も出さない。**
 *
 * **11 本すべてが `rotated text matrix` の壁を越えた。**
 * **そのうち 2 本は最後まで読めるところまで行くが、会派名が全部ひっくり返る**ので、
 * **`readGlyphPages` が回転したページを既定で止める**（下の「3.」）。
 * **読める本数は 111 → 111 のまま。退行 0、既存の本の値の変化 0。**
 *
 * ## 1. 母数（**2026-09-24 に index を取り直して数え直した。#757**）
 *
 * index（`/KENGIKAI/07976009017.htm`、53,535 バイト）の `<a>` のうち `.pdf` は **151 本**
 * （`sort -u` した行数と素の行数がどちらも 151。重複なし。
 * **キャッシュしてある 151 本のファイル名は、今日の index と `diff` して完全一致**）。
 *
 * **151 本すべてを `parseVotePdf` に通したベースライン（`ccc53287`）: ok 111 / fail 40。**
 * **そのうち `rotated text matrix … not supported` で止まるのは 11 本**
 * （`000073593` `000073596` `000073607` `000073610` `000073611` `000073612`
 * `000073613` `000073614` `000073615` `000073616` `000073637`）。
 * **PO の「回転 11 本」は実測と一致した。**
 *
 * ## 2. 機序（**#969 と同じ形の「合成」だった**）
 *
 * **実測（2026-09-24、11 本の `Tm` 774 回すべて）**:
 *
 * | | 値 | 種類 |
 * |---|---|---:|
 * | `Tm` | **`[0, +s, -s, 0, e, f]`** | **1 種類**（774 / 774） |
 * | そのときの CTM | **`[1,0,0,1,0,0]`（単位行列）** | **1 種類** |
 * | ページの `/Rotate` | **90** | **1 種類**（11 本の全 19 ページ） |
 * | ページの `view` | **`[0,0,842,1191]`**（A3 縦） | **1 種類** |
 *
 * **`/Rotate 90` は「時計回りに 90 度回して表示する」意味なので、
 * PDF 座標 `(px, py)` は表示座標 `(py, W − px)`（W = 842）に写る。**
 * **これは行列 `D = [0, −1, 1, 0, 0, W]` である。**
 *
 * **`Tm × CTM` に `D` を掛けると、回転はちょうど打ち消し合って消える**:
 *
 * ```
 * [0, s, −s, 0, e, f] × [0, −1, 1, 0, 0, W] = [s, 0, 0, s, f, W − e]
 * ```
 *
 * **正の等方 s 倍＋平行移動。** **つまりこの 11 本は「回転した本」ではなく、
 * 「`/Rotate 90` のページに、そのページの向きに合わせて置かれた本」である**——
 * **#969 が上下反転 9 本で見つけたのと同じ形**（見るべき量は `Tm` でも CTM でもなく、
 * **`Tm × CTM × D`** のほうだった）。
 *
 * **打ち消すと、表示座標で表がきれいに立つ**（実測、`000073610.pdf` の 1 ページ目）:
 *
 * | | 実測 |
 * |---|---|
 * | 表題 | `平成２２年第２回定例会（１０月）議案等の審議結果` |
 * | 凡例 | `○：賛成×：反対議：議長除：除斥－：不在欠：欠席` |
 * | 議員の列（罫線。幅 15.8pt） | **49 列** |
 * | **1 行ぶんの記号** | **49 個 → 49 列。列の外 0、同じ列への重複 0** |
 *
 * ## 3. **それでも票を出さない**（#569。**この PR の結論**）
 *
 * **座標は直る。表の形が直らない。** **佐賀（`saga/votes-pdf.ts:69`）の警告どおりだった。**
 *
 * **11 本のうち 2 本（`000073614` `000073616`）は最後まで読める。**
 * **票そのものは正しい**:
 *
 * | 検算 | 結果 |
 * |---|---|
 * | **検算A**: 公表の賛成者数・反対者数 ↔ `○` / `×` の数 | **4 / 4 行で一致** |
 * | **検算B**: `議` の列 ↔ 一次資料「歴代正副議長」 | **4 / 4 行で「三谷 哲央」** |
 *
 * **検算B の一次資料**: 三重県議会「歴代正副議長」
 * https://www.pref.mie.lg.jp/KENGIKAI/07681011814.htm ——
 * **102代 三谷哲央、平成21.05 就任、平成23.05 に 103代 山本教和へ交代。**
 * **2 本は平成22年5月・平成22年9月なので、両方ともその任期の内側にある。**
 *
 * ### **それでも出さない理由: 会派名が全部ひっくり返る**
 *
 * **実測（2026-09-24、2 本の会派見出し 5 種すべて）**:
 *
 * | 出る文字列 | 一次資料 |
 * |---|---|
 * | `えみ政新` | **`新政みえ`** |
 * | `いらみ民自` | **`自民みらい`** |
 * | `党明公` | **`公明党`** |
 * | `共三議本党県団日産重` | **`日本共産党三重県議団`** |
 *
 * **`votes-pdf.ts` の `readVerticalHeading` は縦書き（右の列から左へ）を前提にしている**（#901）。
 * **この 11 本では会派見出しが「横書きの複数行」（上→下、左→右）で置かれている**——
 * **実測（`000073614.pdf`）: `日本共 / 産党三 / 重県議 / 団` が
 * y = 747.4 / 739.6 / 731.8 / 724.0 に、x = 1056.3, 1063.3, 1070.2 で並ぶ。**
 * **上→下・左→右に繋ぐと `日本共産党三重県議団` になる。**
 *
 * **これは「記録が出ない」ではなく「別の文字列が出る」側である**（#569）。
 * **#901 が同じ形（`運草動のい根が` → `草の根運動いが`）を直したばかりである。**
 * **利用者から会派名の誤りは検出できない。**
 *
 * ### **縦書きか横書きかを見分ける規則は作らなかった**
 *
 * **実測（2026-09-24、151 本）: セルの中の文字の散らばりでは、回転の本と回転でない本が分かれない。**
 * 1 ページ目の 1 文字アイテムについて「同じ x に並ぶ文字数の最大」「同じ y に並ぶ文字数の最大」を
 * 数えると、**回転の 11 本は `同じx最大 5〜21 / 同じy最大 11〜50`、
 * 回転でない本は `同じx最大 5〜46 / 同じy最大 13〜69` で、範囲が重なる。**
 *
 * **規則を誤れば会派名が別の会派の名前になる。規則を作れないなら止める側に倒す**（#569）。
 * **だから `readGlyphPages` は回転したページを既定で例外にする**（`allowRotated`）。
 *
 * ## 4. **見つけたが直さなかったもの**（**別 PBI**。この PR の射程外）
 *
 * ### 4-1. **会派名の反転は、今本番に出ている 111 本にも既にある**
 *
 * **ベースライン `ccc53287` で 151 本を読み、会派見出しの原文を数え直した（実測 2026-09-24）**:
 *
 * | 出ている原文 | 本数 | 正しい原文 |
 * |---|---:|---|
 * | `鷹山` | **51** | `山鷹`？（**どちらが正しいか確かめていない**） |
 * | `莽草` | **19** | **`草莽`**（`草莽` も 36 本ある） |
 * | `産党日本共` | **26** | **`日本共産党`**（`日本共産党` も 58 本ある） |
 * | `えみ政新` | **24** | **`新政みえ`**（`新政みえ` も 87 本ある） |
 * | `党明公` | **24** | **`公明党`**（`公明党` も 87 本ある） |
 * | `党主民由自` | **10** | **`自由民主党`** |
 * | `団議県党主民由自` | **9** | **`自由民主党県議団`** |
 * | `党民自` | **9** | **`自民党`** |
 * | `いらみ民自` | **4** | **`自民みらい`** |
 *
 * **同じ会派が本によって 2 通りの文字列で出ている。**
 * **これは #901 が直した形と同じだが、母数が違う**——
 * **#901 は「2 列に折り返す縦書き」を直した。ここに残っているのは別の形である。**
 * **この PR は既に本番に出ている 111 本の出力を変えないので、直していない。**
 *
 * ### 4-2. **並べ替えが 1e-11 pt の誤差でひっくり返る**
 *
 * **`readRows` の `cellText` は `(b.y - a.y || a.x - b.x)` で並べる。**
 * **`b.y - a.y` が 0 でなければ x を見ない**ので、
 * **同じ行のはずの 2 つのアイテムの y が浮動小数の誤差だけ違うと、左右が入れ替わる。**
 *
 * **実物（`000073614.pdf`、回転を打ち消したあと）**:
 * - `"三重県過疎地域における"` y = **617.4787994060464**
 * - `"県税の特例措置に関する条例の"` y = **617.4787994060516**
 *
 * **差は 5.2e-12 pt。** **これで `県税の…` が先に来て、件名が
 * `県税の特例措置に関する条例の三重県過疎地域における一部を改正する条例案` になる**
 * （正しくは `三重県過疎地域における県税の特例措置に関する条例の一部を改正する条例案`）。
 *
 * **実測（2026-09-24、151 本）**:
 *
 * | | 本数 / 対 |
 * |---|---|
 * | 「0 < y の差 < 1e-6」の隣接対を持つ本 | **66 / 151 本、2,803 対** |
 * | 「y の差 < 1e-6 なのに x が逆順」の対を持つ本 | **65 / 151 本、1,238 対** |
 * | **うち回転の本** | **6 本** |
 *
 * **つまり 60 本近くは回転と関係なく、今の `main` にこの揺れがある。**
 * **ただし、既に読めている 111 本の 2,805 行の件名には、末尾が壊れた形は 1 件も無い**
 * （実測。**「出ていない」のであって「起きない」わけではない**）。
 * **この PR は既存の出力を変えないので直していない。別 PBI にすべきである。**
 *
 * ## 5. 共有層に触っていない
 *
 * **`pdf-table.ts` は 1 文字も変えていない**（秋田 #759 / 青森 #750 と同じ判断）。
 * **罫線の向き直しは三重の `glyphs.ts` の中の `rotateLines` でやっている**——
 * **青森の `unrotate`（`aomori/votes-pdf.ts:224`）の考え方を借りて、
 * 掛ける相手を「`readPages` の Item」から「`readLines` の線」に替えただけである。**
 */

const fixture = (name: string): Buffer => readFileSync(fileURLToPath(new URL(`./fixtures/mie/${name}`, import.meta.url)));

/** 1 グリフの showText を組むだけのオペレータ列（`local-glyphs-flip.test.ts` と同じ形）。 */
function ops(tm: number[], cm?: number[]): [number[], unknown[]] {
  const fn: number[] = [];
  const args: unknown[] = [];
  if (cm) { fn.push(OPS.transform); args.push(cm); }
  fn.push(OPS.beginText); args.push([]);
  fn.push(OPS.setFont); args.push(["F1", 1]);
  fn.push(OPS.setTextMatrix); args.push(tm);
  fn.push(OPS.showText); args.push([[{ unicode: "あ", width: 1000 }]]);
  return [fn, args];
}

/* ---------- 1. 打ち消しの行列そのもの ---------- */

test("#867 mie: /Rotate 0 の打ち消しは単位行列（回転の無い 140 本は 1 ビットも変わらない）", () => {
  assert.deepEqual(pageRotationMatrix(0, 842), [1, 0, 0, 1, 0, 0]);
  // **幅を何にしても単位行列**（回転が 0 なら幅は読まれない）
  assert.deepEqual(pageRotationMatrix(0, 0), [1, 0, 0, 1, 0, 0]);
});

test("#867 mie: /Rotate 90 の打ち消しは [0,-1,1,0,0,W]（(px,py) → (py, W-px)）", () => {
  assert.deepEqual(pageRotationMatrix(90, 842), [0, -1, 1, 0, 0, 842]);
});

test("#867 mie: 知らない /Rotate（180 / 270）は例外（黙って間違えた向きで読まない）", () => {
  assert.throws(() => pageRotationMatrix(180, 842), /unsupported page rotation 180/);
  assert.throws(() => pageRotationMatrix(270, 842), /unsupported page rotation 270/);
});

/* ---------- 2. 合成の判定 ---------- */

test("#867 mie: /Rotate 90 のページでは Tm の回転が打ち消されて読める", () => {
  // 実データと同じ形: Tm = [0, s, -s, 0, e, f]、CTM は単位行列、ページは /Rotate 90 の A3 縦
  const [fn, args] = ops([0, 8.04, -8.04, 0, 149.2, 406.3]);
  const { items } = readGlyphPageOps(fn, args, 1, { pageRotate: 90, pageWidth: 842 });
  assert.equal(items.length, 1);
  // 表示座標: x = f = 406.3、y = W - e = 842 - 149.2 = 692.8
  assert.equal(Math.round(items[0].x * 10) / 10, 406.3);
  assert.equal(Math.round(items[0].y * 10) / 10, 692.8);
  // 幅も高さも 合成の a(8.04) が掛かる
  assert.equal(Math.round(items[0].w * 100) / 100, 8.04);
  assert.equal(Math.round(items[0].h * 100) / 100, 8.04);
});

test("#867 mie: /Rotate を渡さなければ同じ Tm は今までどおり例外（既定は 1 バイトも変えない）", () => {
  const [fn, args] = ops([0, 8.04, -8.04, 0, 149.2, 406.3]);
  assert.throws(() => readGlyphPageOps(fn, args, 1), /rotated text matrix/);
});

test("#867 mie: /Rotate 90 でも、打ち消して残る回転は例外（向きが合っていない本を黙って読まない）", () => {
  // Tm が逆向き（-s, +s）の回転だと、D を掛けると 180 度になり a<0 / d<0 が残る
  const [fn, args] = ops([0, -8.04, 8.04, 0, 149.2, 406.3]);
  assert.throws(() => readGlyphPageOps(fn, args, 1, { pageRotate: 90, pageWidth: 842 }), /flipped text matrix/);
});

test("#867 mie: /Rotate 90 のページで回転していない Tm が来たら例外（打ち消しが回転を生む）", () => {
  // 回転していない Tm に D を掛けると回転が生まれるので、b/c が 0 でなくなる
  const [fn, args] = ops([8.04, 0, 0, 8.04, 149.2, 406.3]);
  assert.throws(() => readGlyphPageOps(fn, args, 1, { pageRotate: 90, pageWidth: 842 }), /rotated text matrix/);
});

test("#867 mie: 罫線も同じ打ち消しで向きが直る（PDF の縦線は表示の横線になる）", () => {
  // `readLines` は共有層（`pdf-table.ts`）なので `D` を渡せない。読んだあとで `rotateLines` が掛ける。
  // **縦線 x=100（y 10..200）は、/Rotate 90（W=842）で 横線 y=842−100=742（x 10..200）になる。**
  // pdfjs の path バッファ: moveTo(100,10) → lineTo(100,200)
  const fnArray = [OPS.constructPath];
  const argsArray = [[0, [[0, 100, 10, 1, 100, 200]], [100, 10, 101, 200]]];
  const plain = readGlyphPageOps(fnArray, argsArray, 1);
  assert.equal(plain.vlines.length, 1, "回転なしでは縦線のまま");
  assert.equal(plain.hlines.length, 0);
  assert.equal(Math.round(plain.vlines[0].x), 100);
  const rotated = readGlyphPageOps(fnArray, argsArray, 1, { pageRotate: 90, pageWidth: 842 });
  assert.equal(rotated.vlines.length, 0, "回転すると縦線ではなくなる");
  assert.equal(rotated.hlines.length, 1, "回転すると横線になる");
  assert.equal(Math.round(rotated.hlines[0].y), 742);
  assert.equal(Math.round(rotated.hlines[0].x0), 10);
  assert.equal(Math.round(rotated.hlines[0].x1), 200);
});

/* ---------- 3. 実物の PDF: 壁は越えた ---------- */

test("#867 mie: 回転 11 本は回転の例外を抜ける（表題・凡例・罫線が表示座標で立つ）", async () => {
  // **`allowRotated` を渡すのはこのテストだけ**（本番の経路は既定で止まる。下の 4. を見よ）
  const pages = await readGlyphPages(fixture("000073610.pdf"), { allowRotated: true });
  assert.equal(pages.length, 2);
  const p1 = pages[0];
  assert.ok(p1.items.length > 300, `items ${p1.items.length}`);
  // 表題（1 文字ずつ別の showText。x の順に繋ぐと読める）
  const top = Math.max(...p1.items.map((i) => i.y));
  const titleLine = p1.items.filter((i) => Math.abs(i.y - top) < 1).sort((a, b) => a.x - b.x).map((i) => i.str).join("");
  assert.equal(titleLine, "平成２２年第２回定例会（１０月）議案等の審議結果");
  // 罫線も同じ向きに直っている
  assert.ok(p1.vlines.length > 50, `vlines ${p1.vlines.length}`);
  assert.ok(p1.hlines.length > 100, `hlines ${p1.hlines.length}`);
});

/* ---------- 4. それでも票は出さない ---------- */

test("#867 mie: parseVotePdf は回転したページを止める（既定。票は 1 票も出さない。#569）", async () => {
  // **11 本すべてがここで止まる。** 理由は「座標が直らない」ではなく
  // **「会派見出しが横書きで、readVerticalHeading がひっくり返す」**である。
  for (const f of ["000073610.pdf", "000073614.pdf"]) {
    await assert.rejects(() => parseVotePdf(fixture(f)), (e: Error) => {
      assert.match(e.message, /rotated page \(\/Rotate 90\)/, `${f}: ${e.message}`);
      // **回転の text matrix ではもう止まっていない**（壁を 1 つ越えたことの確認）
      assert.doesNotMatch(e.message, /rotated text matrix/, `${f}: まだ text matrix で止まっている`);
      return true;
    });
  }
});

test("#867 mie: 止める理由の実物——会派見出しは横書きで、縦書きとして読むとひっくり返る", async () => {
  // **これがこの PR の中心の測定である。** 止める判断の根拠を、実物で固定しておく。
  const pages = await readGlyphPages(fixture("000073614.pdf"), { allowRotated: true, splitGlyphs: true });
  const p1 = pages[0];
  // 「日本共産党三重県議団」のセル（実測: x 1056〜1070、y 724〜748）
  const cell = p1.items.filter((i) => i.cx > 1000 && i.cx < 1085 && i.cy > 718 && i.cy < 758);
  assert.equal(cell.length, 10, "セルの中の文字数");
  // **縦書きとして読むと（今の readVerticalHeading）ひっくり返る**
  assert.equal(readVerticalHeading(cell), "共三議本党県団日産重");
  // **横書き（上→下、左→右）として読むと一次資料どおりになる**
  const h = Math.max(...cell.map((c) => c.h), 1) / 2;
  const ys = cluster(cell.map((c) => c.y), h).sort((a, b) => b - a);
  const horizontal = ys.map((cy) => cell.filter((c: Item) => Math.abs(c.y - cy) <= h).sort((a, b) => a.x - b.x).map((c) => c.str).join("")).join("");
  assert.equal(horizontal, "日本共産党三重県議団");
  // **どちらで読むかを決める規則は作らない**（151 本で測っても分かれなかった。docblock の 3.）——
  // **誤れば会派名が別の会派になる**ので、**止める側に倒す**（#569）。
});

test("#867 mie: 1e-11 pt の差で件名の左右が入れ替わる（見つけたが直さない。別 PBI）", async () => {
  // **`cellText` は `(b.y - a.y || a.x - b.x)` で並べるので、y が誤差だけ違うと x を見ない。**
  const pages = await readGlyphPages(fixture("000073614.pdf"), { allowRotated: true });
  const items = pages[0].items.filter((i) => /三重県過疎地域における|県税の特例措置に関する条例の/.test(i.str));
  assert.equal(items.length, 2);
  const [a, b] = items.sort((x, y) => x.x - y.x);
  assert.equal(a.str, "三重県過疎地域における");
  assert.equal(b.str, "県税の特例措置に関する条例の");
  // **同じ行に見えるのに y は厳密には違う**
  assert.notEqual(a.y, b.y);
  assert.ok(Math.abs(a.y - b.y) < 1e-9, `y の差 ${Math.abs(a.y - b.y)}`);
  // **その差で `b.y - a.y` が 0 にならず、x の順が使われない**
  assert.notEqual(b.y - a.y, 0);
  // **実測: 151 本中 65 本に「y の差 < 1e-6 なのに x が逆順」の対が 1,238 対ある**
  // （回転の本は 6 本だけ。**残りは今の `main` に既にある**）。
  // **この PR は既存の出力を変えないので直していない。**
});
