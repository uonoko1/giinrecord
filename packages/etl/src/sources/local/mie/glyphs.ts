import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { multiplyMatrix, readLines, type Matrix, type PageGeometry, type Item, type VLine, type HLine } from "../pdf-table.ts";
import { CMAP_DIR, CMAP_OPTIONS, CMAP_PACKED } from "../pdf-cmap.ts";

export { CMAP_DIR, CMAP_PACKED };

/**
 * オペレータ列からの文字と罫線の読み出し（Issue #203 三重）。
 *
 * pdf-table.ts の readPages（getTextContent）は、別々の描画命令（Tm ＋ Tj）で置かれた文字を 1 つのテキストにまとめることがあり、
 * まとめられた 2 文字目以降の位置が失われる（三重の令和8年5月分 PDF では、縦書きの氏名の列で
 * 「中川正美」の末尾の「美」と隣の列の先頭の「辻󠄀」（異体字セレクタ付き）が「美辻󠄀」の 1 テキストになり、
 * 「辻󠄀」が隣の列の位置で読めなくなる）。
 * この PDF は文字を setTextMatrix（位置の明示）または相対移動（Td/TD/T*）＋ showText で置いているので、
 * オペレータ列を歩けば 1 文字ごとの正確な位置が取れる（推定ではない）。ここでは showText 1 回を 1 アイテムにする
 * （見出しの「令和８年定例会（２月）」のような 1 行のテキストは 1 回の showText、氏名・セルの 1 文字は 1 文字ずつ）。
 * **相対移動（Td/TD/T*）も読む**（Issue #867）。**index 151 本のうち 80 本がこれを使っている。**
 * 実装は高知（kochi/glyphs.ts）と同じ。
 * **拡大だけの text matrix も読む**（Issue #867 B 群。**index 151 本のうち 15 本がこの形**——
 * `Tf` のサイズが **1** で、**`Tm` が文字の大きさを持っている**）。**回転と上下反転はまだ読まない。**
 * 位置の前提が崩れる命令（生の `'` / `"`・0 でない word spacing・**回転や上下反転や異方の入った**
 * text matrix・単位行列でない CTM）が出たら例外（黙って読み間違えない。Issue #707）。
 * **知らない演算子も例外**（Issue #717）——この関数には既定の枝が無く、**見たことのない演算子は
 * 何の枝にも当たらず黙って次へ進んでいた**。色や線の体裁など、文字に効かないものだけ明示的に無視する
 * （HARMLESS_OPS）。不可視の文字（`Tr 3`）と ExtGState の `Font` / 透明指定も止める。
 * 罫線は pdf-table.ts の readLines に任せる（CTM を掛ける。Issue #693 / #700）。
 *
 * **あらかじめ定義された CMap を pdfjs に渡す**（Issue #867 B 群。`../pdf-cmap.ts` に理由を書いた）。
 * 渡さないと、古い本のフォントで **showText が「グリフ 0 個」になり、文字が黙って消える**。
 */
export async function readGlyphPages(bytes: Buffer, options: ReadGlyphOptions = {}): Promise<PageGeometry[]> {
  const loadingTask = getDocument({ data: new Uint8Array(bytes), verbosity: 0, ...CMAP_OPTIONS });
  const doc = await loadingTask.promise;
  const out: PageGeometry[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const ops = await page.getOperatorList();
      // **ページの `/Rotate` と `view` を渡す**（Issue #867 B 群「回転 90 の 11 本」）。
      // **`/Rotate 0` のページ（151 本中 140 本）では打ち消しが単位行列になり、値は 1 ビットも変わらない。**
      const view = page.view as number[];
      // **原点が 0 でない `view` は実データに無い**（実測 2026-09-24、151 本の全ページ）。
      // **打ち消しは幅だけを使うので、原点がずれていると向きではなく位置がずれる**——
      // **黙って別の位置で読まない**（#569）。
      if (page.rotate !== 0 && (view[0] !== 0 || view[1] !== 0)) {
        throw new Error(`page ${i}: rotated page with non-zero view origin [${view.join(",")}] not supported`);
      }
      // **回転を打ち消したページから票を作らない**（Issue #867 回転 11 本。**この PR の結論**）。
      //
      // **座標は直る。表の形が直らない。** **佐賀（`saga/votes-pdf.ts:69`）の警告どおりだった。**
      // **実測（2026-09-24、回転 11 本）: 打ち消すと記号は罫線の列に正しく落ちる**が、
      // **会派見出しが「横書きの複数行」で置かれている**——
      // `votes-pdf.ts` の `readVerticalHeading` は**縦書き（右の列から）**を前提にしているので、
      // **`新政みえ` が `えみ政新`、`自民みらい` が `いらみ民自` として出る**（実測: 5 種すべて）。
      //
      // **これは「記録が出ない」ではなく「別の文字列が出る」側である**（#569 / #901 が同じ形で直した）。
      // **利用者から会派名の誤りは検出できない。**
      //
      // **縦書きか横書きかを判定する規則は作らなかった**——
      // **実測（2026-09-24、151 本）: セルの中の文字の散らばりでは回転の本と回転でない本が分かれない**
      // （同じ x の最大・同じ y の最大のどちらでも重なる）。
      // **規則を誤れば会派名が別の会派の名前になる**ので、**規則を作れないなら止める側に倒す**（#569）。
      //
      // **`allowRotated` は、回転を打ち消す計算そのものを測るテストだけが渡す。**
      // **本番の経路（`parseVotePdf` → `readGlyphPages(bytes)`）は既定のまま通るので、票は 1 票も出ない。**
      if (page.rotate !== 0 && !options.allowRotated) {
        throw new Error(`page ${i}: rotated page (/Rotate ${page.rotate}): the text matrix can be un-rotated, but the group headings are laid out horizontally on these pages and readVerticalHeading would reverse them (#867 / #569)`);
      }
      out.push(readGlyphPageOps(ops.fnArray, ops.argsArray, i, { ...options, pageRotate: page.rotate, pageWidth: view[2] - view[0] }));
    }
  } finally {
    await loadingTask.destroy();
  }
  return out;
}

/**
 * `readGlyphPages` / `readGlyphPageOps` の振る舞いの切り替え（Issue #982）。
 */
export interface ReadGlyphOptions {
  /**
   * **1 回の showText を、グリフ 1 つずつの別アイテムにするか**（既定 `false`）。
   *
   * ## なぜ要るか（**#982 の壁**）
   *
   * 既定（`false`）は **showText 1 回 = 1 アイテム**である。
   * **三重の 17 本は 1 回の showText に複数のセルぶんの文字を入れている**ので、
   * **1 アイテムが丸ごと 1 つの列に落ち、残りの列が空になる**。
   *
   * **実測（2026-09-24、`001088734.pdf` の 1 ページ目）**——1 行ぶんがこの 5 アイテムで出る:
   *
   * | アイテム | 何列ぶんか |
   * |---|---|
   * | `"議案第1号"` | 1 列（議案等番号） |
   * | `"令和2年度三重県一般会計補正予算（第１０号）"` | 1 列（件名） |
   * | **`"1/155049490"`** | **5 列**（議決月日・出席者数・表決者数・賛成者数・反対者数） |
   * | `"可決"` | 1 列（議決結果） |
   * | **`"○○○…議○○…"`（50 文字、w=493.4）** | **47 人ぶんの列** |
   *
   * **見出しも `"議案等番号件名"` の 1 アイテム**（2 列ぶん）で出る——
   * **これが `column 0 header "" !== 議案等番号` の正体である。**
   *
   * ## **位置は推測ではない**（#569）
   *
   * **グリフ 1 つずつの x は、この関数が既にグリフ幅から積算している**——
   * 既定の枝も同じループで `x` を進めており、**1 アイテムの `x`（左端）と `w` はその積算の結果である。**
   * **割るのは「その途中の値も一緒に出す」だけで、新しい推定を 1 つも足していない。**
   *
   * ## **既定を `false` に保つ理由**（**`true` にすると読めている本が壊れる**）
   *
   * **表題と凡例は 1 アイテムの `str` を正規表現に掛けて見つけている**
   * （`votes-pdf.ts` の `TITLE` / `LEGEND_ITEM`）。**全部を割ると 1 文字ずつになり当たらない。**
   * **`votes-pdf.ts` には #867 A-2 で入った「同じ行の文字を x 順に繋ぐ」経路があるが、
   * それは「1 アイテムで当たるものが 1 つも無いとき」しか使われない**——
   * **つまり割ると経路が入れ替わり、今読めている本の `tableTop` が変わりうる。**
   *
   * **だから `votes-pdf.ts` は「既定で読んでみて、例外になった本だけ」割り直す**
   * （`parseVotePdf` の 2 段構え）。**読めている本はこの枝に入らない。**
   */
  splitGlyphs?: boolean;

  /**
   * **このページの `/Rotate`（度）**（Issue #867 B 群「回転 90 の 11 本」。既定 `0` ＝ 打ち消さない）。
   *
   * ## なぜ要るか（**#969 と同じ形の「合成」だった**）
   *
   * **実測（2026-09-24、index 151 本のうち回転で止まっていた 11 本の `Tm` 774 回すべて）**:
   *
   * | | 値 | 種類 |
   * |---|---|---:|
   * | `Tm` | **`[0, +s, -s, 0, e, f]`** | **1 種類**（774 / 774） |
   * | そのときの CTM | **`[1,0,0,1,0,0]`（単位行列）** | **1 種類** |
   * | ページの `/Rotate` | **90** | **1 種類**（11 本の全 19 ページ） |
   * | ページの `view` | **`[0,0,842,1191]`**（A3 縦） | **1 種類** |
   *
   * **`/Rotate 90` は「時計回りに 90 度回して表示する」意味**なので、
   * **PDF 座標 `(px, py)` は表示座標 `(py, W − px)`（W はページの幅）に写る。**
   * これは行列 **`D = [0, −1, 1, 0, 0, W]`** である。
   *
   * **`Tm × CTM` に `D` を掛けると回転はちょうど打ち消し合って消える**:
   *
   * ```
   * [0, s, −s, 0, e, f] × [0, −1, 1, 0, 0, W] = [s, 0, 0, s, f, W − e]
   * ```
   *
   * **正の等方 s 倍＋平行移動。** **つまりこの 11 本は「回転した本」ではなく、
   * 「`/Rotate 90` のページに、そのページの向きに合わせて置かれた本」である。**
   *
   * **#969 が上下反転 9 本で見つけたのと同じ形**——
   * **見るべき量は `Tm` でも CTM でもなく、`Tm × CTM × D` のほうだった。**
   * **`Tm` の `b`/`c` が 0 でないことだけで止めるのは、見るべき量を見ていない。**
   *
   * ## **既定は `0`（打ち消さない）**
   *
   * **`readGlyphPages` はページの `/Rotate` をそのまま渡す**ので、
   * **`/Rotate 0` の本（151 本中 140 本）では `D` が単位行列になり、値は 1 ビットも変わらない。**
   * **オペレータ列を直接渡すテストでは、渡さなければ今までどおりの判定になる。**
   *
   * ## **180 / 270 は例外にする**
   *
   * **実データに 1 ページも無い**（11 本の全 19 ページが 90。残り 140 本は 0）。
   * **正しい向きを実データで検証できないものは、黙って読まずに止める**（#707 / #700 と同じ判断）。
   */
  pageRotate?: number;

  /**
   * **このページの `view` の幅**（`view[2] − view[0]`。`pageRotate` が 0 でないときだけ読む）。
   * **`/Rotate 90` の打ち消しは `y_disp = W − x_pdf` なので、幅が要る。**
   * **`pageRotate` が 0 なら使われない**（`D` が単位行列になる）。
   */
  pageWidth?: number;

  /**
   * **回転したページから票を作ってよいか**（Issue #867 回転 11 本。既定 `false` ＝ 作らない）。
   *
   * **既定で止める理由は「座標が直らないから」ではない。座標は直る。**
   * **`votes-pdf.ts` の表の組み立てが、この 11 本の表の形に合っていないからである**（#819）:
   *
   * | | 回転でない 140 本 | **回転の 11 本** |
   * |---|---|---|
   * | 議員の氏名 | 列ごとに**縦書き** | **縦書き**（`joinVertical` で正しく読める） |
   * | **会派見出し** | **縦書き**（長いと右→左に折り返す。#901） | **横書きの複数行**（上→下、左→右） |
   *
   * **実測（2026-09-24、`000073614.pdf` / `000073616.pdf`）**——
   * **打ち消して最後まで読むと、票は正しいが会派名が全部ひっくり返る**:
   *
   * | 出る文字列 | 一次資料 |
   * |---|---|
   * | `えみ政新` | **`新政みえ`** |
   * | `いらみ民自` | **`自民みらい`** |
   * | `党明公` | **`公明党`** |
   * | `共三議本党県団日産重` | **`日本共産党三重県議団`** |
   *
   * **票そのものは正しい**（検算A: 公表の賛成者数・反対者数 ↔ `○`/`×` の数が **4/4 行で一致**。
   * 検算B: `議` の列が **4/4 行で「三谷 哲央」**で、一次資料「歴代正副議長」の
   * **102代 三谷哲央（平成21.05 就任、平成23.05 に山本教和へ交代）**と、
   * **平成22年5月・平成22年9月という本の月が両方ともその任期の内側にある**）。
   *
   * **それでも出さない**——**会派名が別の文字列になるのは #569 の「別の記録が出る」側で、
   * 利用者からは検出できない。** **#901 が同じ形（`運草動のい根が`）を直したばかりである。**
   *
   * **縦書きと横書きを見分ける規則は作らなかった**——**実測で分かれなかった**（上の docblock）。
   * **規則を誤れば会派名が別の会派になる。規則を作れないなら止める。**
   *
   * **渡すのはテストだけ**（回転を打ち消す計算そのものを測るため）。
   * **本番の経路は既定のまま通るので、11 本から票は 1 票も出ない。**
   */
  allowRotated?: boolean;
}

/** 単位行列（q/Q/cm を辿るときの初期値）。 */
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/**
 * **ページの `/Rotate` を打ち消す行列**（Issue #867 B 群「回転 90 の 11 本」）。
 *
 * **`/Rotate 90` は「時計回りに 90 度回して表示する」**ので、
 * **PDF 座標 `(px, py)` は表示座標 `(py, W − px)` に写る**（W はページの幅）。
 * 行列にすると `[0, −1, 1, 0, 0, W]`——`(px, py)` に掛けると `(py, −px + W)` になる。
 *
 * **`0` なら単位行列を返す**ので、**回転の無いページでは何も変わらない**
 * （151 本中 140 本がここを通る。**値は 1 ビットも変わらない**）。
 *
 * **180 / 270 は例外**——**実データに 1 ページも無く**（実測 2026-09-24、151 本の全ページ）、
 * **正しい向きを検証できないので黙って読まない**（#707 の `Tw` と同じ判断）。
 *
 * **`view[0]` / `view[1]` が 0 でないページは実データに無い**（回転の 11 本はすべて `[0,0,842,1191]`）。
 * **出たら向きではなく位置がずれる**ので、`readGlyphPages` が別に例外にして受け止める。
 */
export function pageRotationMatrix(rotate: number, width: number): Matrix {
  if (rotate === 0) return IDENTITY;
  if (rotate !== 90) throw new Error(`unsupported page rotation ${rotate}`);
  return [0, -1, 1, 0, 0, width];
}

/** 2 つの行列が同じか（6 つの成分すべて）。 */
const sameMatrix = (a: Matrix, b: Matrix): boolean => a.every((v, i) => v === b[i]);

/**
 * **罫線に `/Rotate` の打ち消しを掛ける**（Issue #867 B 群「回転 90 の 11 本」）。
 *
 * **`readLines` は共有層（`pdf-table.ts`）にあり、単位行列から CTM を組み立てる**ので、
 * **`D` をそこに渡すと 11 県の既定が変わる**（秋田 #759 の docblock が禁じている）。
 * **だから読んだあとでここで掛ける。**
 *
 * **`/Rotate 90` の打ち消しは 90 度回転なので、PDF の縦線は表示の横線になり、逆も同じ**
 * （**青森の `unrotate`（`aomori/votes-pdf.ts:224`）が同じ入れ替えをしている**。
 * **考え方を借りて、掛ける相手を「`readPages` の Item」から「`readLines` の線」に替えただけ**）。
 *
 * **`display` が単位行列なら、配列をそのまま返す**——
 * **回転の無い 140 本では `vlines` / `hlines` が 1 ビットも変わらない**（新しいオブジェクトすら作らない）。
 */
function rotateLines(lines: { vlines: VLine[]; hlines: HLine[] }, display: Matrix): { vlines: VLine[]; hlines: HLine[] } {
  if (sameMatrix(display, IDENTITY)) return lines;
  const [a, b, c, d, e, f] = display;
  const map = (x: number, y: number): [number, number] => [a * x + c * y + e, b * x + d * y + f];
  const vlines: VLine[] = [];
  const hlines: HLine[] = [];
  // **PDF の縦線（x 一定）は、90 度回すと表示の横線（y 一定）になる。**
  for (const l of lines.vlines) {
    const [x0, y0] = map(l.x, l.y0);
    const [x1, y1] = map(l.x, l.y1);
    hlines.push({ y: (y0 + y1) / 2, x0: Math.min(x0, x1), x1: Math.max(x0, x1) });
  }
  // **PDF の横線（y 一定）は、90 度回すと表示の縦線（x 一定）になる。**
  for (const l of lines.hlines) {
    const [x0, y0] = map(l.x0, l.y);
    const [x1, y1] = map(l.x1, l.y);
    vlines.push({ x: (x0 + x1) / 2, y0: Math.min(y0, y1), y1: Math.max(y0, y1) });
  }
  return { vlines, hlines };
}

/**
 * **文字の位置にも可読性にも影響しない演算子**（Issue #717）。ここに載っているものだけ黙って読み飛ばす。
 *
 * **なぜ allowlist（既定は例外）にするか**: この関数には既定の枝が無く、
 * **知らない演算子は何の枝にも当たらず黙って次へ進んでいた**。#707 が `'` / `"` / `Tw` を
 * 名指しで塞いだが、**同じ形の穴が演算子の数だけ残っていた**（実測: フィクスチャ 7 本に
 * どちらの実装も見ていない演算子が 13 種類）。1 つずつ足しても次の未知の演算子で同じことが起きる。
 *
 * **なぜ全部を例外にしないか**: 13 種類のうち 11 種類は色・線の体裁・クリップ・マーク付きコンテンツで、
 * **実データに 32,036 回出る**（内訳は test/local-glyphs-unknown-ops.test.ts の実測表）。
 * 全部止めると**色を変えただけの PDF で ETL が丸ごと止まる**。
 *
 * **なぜこれらが無害と言えるか**:
 *   - `setFillRGBColor` / `setStrokeRGBColor` / `setLineWidth` / `setLineCap` / `setLineJoin`
 *     **／ `setMiterLimit`**:
 *     **色と線の体裁だけ**。文字の座標にも、文字が見えるかどうかにも効かない
 *     （見えなくする方法は「透明にする」で、それは `setGState` の `ca`/`CA` 側にあり、下で止めている）。
 *
 *     **`setMiterLimit`（`M`。PDF 32000-1 の 8.4.3 「Line miter limit」）は #867 の回転 11 本で足した。**
 *     （**節番号を 4 段で書くと `forbidden-patterns` の `ip-address` に当たる**ので 3 段で書く。
 *     検査を緩めるほうではなく、書き方を変えるほうに倒す）
 *     **「線の角がどこまで尖ってよいか」の上限**で、**`setLineJoin` が既に allowlist に入っているのと
 *     同じ種類の値である**（`setLineJoin` が「角の形」、`setMiterLimit` が「その角の長さの上限」）。
 *     **実測（2026-09-24、index 151 本すべて）: `setMiterLimit` が出るのは 9 本で、
 *     9 本とも回転の本、1 本あたり 1 回、値はすべて `1`**（＝尖らせない。既定の 10 より弱い指定）。
 *     **残り 142 本には 1 回も出ない**ので、**足しても既存の本の経路は 1 つも変わらない**
 *     （実測: 151 本の出力は前後で 1 ビットも変わらなかった）。
 *     **`setLineWidth` と違って、罫線の「細さ」の判定（`readLines`）にも効かない**——
 *     **`readLines` が見るのは `constructPath` の座標であって、線の太さでも角の形でもない。**
 *   - `clip` / `eoClip`: クリップ領域を狭める。**この読み方は描画結果ではなく命令の座標を読む**ので
 *     関係しない（クリップで文字が隠れることは原理上ありうるが、それは
 *     この 2 つではなく `constructPath` の形の問題で、罫線の読み方（readLines）と同じ土俵になる）。
 *   - `beginMarkedContent` / `beginMarkedContentProps` / `endMarkedContent`:
 *     タグ付き PDF の構造マーク。描画には一切効かない。
 *   - `dependency`: pdfjs 内部の「このフォント資源を待て」という印。PDF の演算子ですらない。
 *   - `endText`: `BT` と対の `ET`。`beginText` が状態を初期化するので、閉じ側で見るものが無い。
 */
const HARMLESS_OPS: ReadonlySet<number> = new Set([
  OPS.setFillRGBColor, OPS.setStrokeRGBColor, OPS.setLineWidth, OPS.setLineCap, OPS.setLineJoin,
  OPS.setMiterLimit, // **#867 の回転 11 本で出た**（9 本 / 各 1 回 / 値はすべて 1。残り 142 本には 0 回）
  OPS.clip, OPS.eoClip,
  OPS.beginMarkedContent, OPS.beginMarkedContentProps, OPS.endMarkedContent,
  OPS.dependency, OPS.endText,
  // **`constructPath` はここで無視してよいのではなく、readLines が別に読んでいる**（罫線）。
  // このループでは何もしないのが正しいが、理由が「無害だから」ではないので明記しておく。
  // 実測（2026-09-09、フィクスチャ 7 本）: 24,299 回。ここを外すと 7 本すべてが例外で止まる。
  OPS.constructPath,
]);

/** 演算子の番号から `OPS` の名前を引く（未知なら "unknown"）。例外の本文に出して追えるようにする。 */
const opName = (fn: number): string => Object.keys(OPS).find((k) => (OPS as Record<string, number>)[k] === fn) ?? "unknown";

/**
 * **文字を読んでよい text rendering mode か**（PDF 32000-1 9.3.6。Issue #717）。
 *
 * `0`=fill（既定） `1`=stroke `2`=fill+stroke **`3`=invisible（不可視）** `4`-`7`=clip 付き。
 *
 * **`3` の文字は PDF ビューアに表示されない。**それを読んで記録にすると、
 * **利用者が一次資料を開いても、その文字は見えない**——「出典を確かめられない記録」になる（#569 と同じ重さ）。
 * OCR 済みスキャン PDF の透明テキスト層はまさに `Tr 3` で置かれる。
 *
 * 実測（2026-09-09、フィクスチャ 7 本）: 出た値は **`2` だけ**（三重 5 本に 1〜3 回ずつ。高知は 0 回）。
 * **`1` と `4`-`7` は実データに無いので「正しく読める」ことを検証できない**ので、
 * `0`（既定）と `2` だけ通し、残りは出さない側に倒す（#707 の `Tw` と同じ判断）。
 */
const READABLE_TEXT_RENDERING_MODES: ReadonlySet<number> = new Set([0, 2]);

/**
 * 1 ページぶんのオペレータ列を読む（Issue #700 でここに切り出した）。
 *
 * **罫線は pdf-table.ts の readLines に任せる**（Issue #693 / #700）。
 * `OPS.constructPath` の `minMax` は **その時点の CTM を掛ける前** のローカル座標なので、
 * `q`（save）/ `Q`（restore）/ `cm`（transform）を辿って掛けないと、
 * 罫線を `q … cm … 矩形 … Q` で置いている PDF で線が全部同じ位置に潰れる。
 * **潰れた線で列を割ると、採決記号が別の議員の列に入る**（利用者からは検出できない）。
 * 掛け方（4 隅を見る外接矩形、cm の合成の向き）は 1 か所に置きたいので readLines を呼ぶ。
 *
 * **文字のほうは CTM を掛けていない**（この読み方は Tm / Td の値をそのままページ座標として使う）。
 * 掛けないまま `cm` の下で文字が置かれたら黙って別の位置に読むので、
 * **showText が単位行列でない CTM の下に来たら例外にする**（黙って読み間違えない、と同じ方針）。
 * 実測（2026-09-09、フィクスチャ 5 本）: 三重の PDF の showText は 8,066 回すべて CTM が単位行列。
 *
 * `getOperatorList()` ではなく配列 2 本で受けるのは、PDF を作らずに
 * `q`/`Q` の入れ子を直接テストできるようにするため（三重のフィクスチャは
 * 変換ありの constructPath が 0 本で、掛けても掛けなくても同じ値になり違いを見せられない）。
 */
export function readGlyphPageOps(fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>, pageNo: number, options: ReadGlyphOptions = {}): PageGeometry {
  const { splitGlyphs = false, pageRotate = 0, pageWidth = 0 } = options;
  const items: Item[] = [];
  /** このページで「文字を描け」と言われた回数（0 グリフのまま終わったら例外にする。Issue #867）。 */
  let showTextCalls = 0;
  /**
   * **ページの `/Rotate` を打ち消す行列**（Issue #867 B 群「回転 90 の 11 本」）。
   * **`pageRotate` が 0 なら単位行列**なので、既存の 140 本は 1 ビットも変わらない。
   *
   * **これを CTM の初期値にする。** `multiplyMatrix(ctm, m)` は「`m` を先に、`ctm` を後に」掛けるので、
   * **`cm` も `Tm` も、最後に必ず `D` が掛かる**——**文字も罫線も同じ 1 か所で向きが直る。**
   * **判定（回転・反転・異方）は `D` を掛けたあとの値に対して行う**ので、
   * **「`/Rotate 90` のページで `Tm` が 90 度回っている」＝「表示上は回っていない」を正しく読む。**
   */
  const display = pageRotationMatrix(pageRotate, pageWidth);
  // **`splitBatchedPaths` は三重だけで `true` にする**（Issue #867 B 群「上下反転 9 本」）。
  // この 9 本は 13,207 本の罫線が 92 回の `constructPath` に畳まれており、
  // 割らないと **縦罫線 0 本・横罫線 0 本**になる（例外は出ない。黙って空の表になる）。
  // **佐賀では `true` にすると字の輪郭を罫線と読み違えて票が別の列に落ちる**ので、
  // 共通層の既定は `false` のままにしてある（`pdf-table.ts` の `ReadLinesOptions` に実測表がある）。
  //
  // **罫線は `readLines` が単位行列から CTM を組み立てる**（共有層なので `D` を渡せない）。
  // **だから読んだあとでここで `D` を掛ける**（`rotateLines`）。
  // **共有層（`pdf-table.ts`）には 1 文字も触らない**（秋田 #759 / 青森 #750 と同じ判断。
  // 既存 11 県の出力を変えないため）。
  const { vlines, hlines } = rotateLines(readLines(fnArray, argsArray, { splitBatchedPaths: true }), display);
  let ctm: Matrix = display;
  const ctmStack: Matrix[] = [];
  let fontSize = 0;
  let charSpacing = 0;
  let hScale = 1;
  /**
   * 行送り（T* が使う）。**初期値 0 は PDF 32000-1 の 9.3.5 が定める既定値**（Issue #703 / #867）。
   *
   * **実データでは、この初期値は一度も読まれない。**
   * 実測（2026-09-14、三重の index **151 本**すべて）: **A 群 80 本の `T*` 1,651 回すべてに、
   * 同じ `BT` ブロックの中で先に `TD` が出ている**（`TL` は 80 本で **0 回**）。
   * **`T*` が 1 回でも出る 63 本すべてで `TD` > 0** なので、初期値が効く経路が実データに無い。
   * **だからこの値を守るテストは実物の PDF では書けない**——
   * `test/local-glyphs-leading.test.ts` の「#867 mie: TL も TD も無しの T*」が
   * オペレータ列を直接渡して固定している。**母数を書かずに「実データに無い」と書かないこと**（#757）。
   */
  let leading = 0;
  /**
   * **text matrix の拡大**（Issue #867 B 群「拡大のみ 15 本」）。
   *
   * **`tx`/`ty`/`lx`/`ly` はページ座標で持ち、`Td`/`T*` の移動量と文字の送りにこの倍率を掛ける。**
   * 拡大のみの 15 本は `Tf` のサイズが **1** で、**Tm が大きさを持っている**ので、
   * 掛けないと **文字が 1/8 に縮んだ位置**に並び、罫線で割った列と全く合わない。
   *
   * **初期値 1 は PDF 32000-1 の 9.4.2 が定める `Tm` の既定値（単位行列）である。**
   *
   * **この宣言の初期値は、構造上けっして読まれない**（`BT` が下で 1 に戻すため。
   * `BT` より前に `showText` が来る PDF は規格違反で、実データにも無い）。
   * **実測（2026-09-19、`mutate.sh`）: ここを `8` にしてもテストは 1 件も落ちず、
   * 151 本の読める本数も 84 のまま変わらない**——**分類②「等価変異」である。**
   * **`BT` 側の `sx = 1` を `8` にすると落ちる**ので、生きているのはそちらだと確かめてある。
   *
   * **なお「`BT` の後、最初の showText より前に `Tm` が来ない」本は 151 本中 80 本ある**
   * （A 群の相対移動の本。`Td` で置く）。**だから `BT` での戻しは実データに効いている。**
   */
  let sx = 1;
  let sy = 1;
  /**
   * この `BT` ブロックで `Tm` を見たか（Issue #867）。
   * **`Tm` が来れば CTM は合成済み**なので showText で CTM を見る必要が無い。
   * **来ていなければ CTM が反映されていない**ので、単位行列でない CTM の下では止める。
   */
  let tmSeenInBlock = false;
  // 現在のテキスト位置（tx, ty）と行頭（lx, ly）。Td/TD/T* は行頭からの相対移動（text space なので倍率を掛ける）
  let tx = 0;
  let ty = 0;
  let lx = 0;
  let ly = 0;
  for (let k = 0; k < fnArray.length; k++) {
    const fn = fnArray[k];
    const args = argsArray[k] as unknown[];
    if (fn === OPS.save) {
      ctmStack.push(ctm);
    } else if (fn === OPS.restore) {
      // **戻す先は `display`**（Issue #867。回転の無いページでは単位行列なので今までどおり）
      ctm = ctmStack.pop() ?? display;
    } else if (fn === OPS.transform) {
      ctm = multiplyMatrix(ctm, args as ArrayLike<number>);
    } else if (fn === OPS.setFont) {
      fontSize = args[1] as number;
    } else if (fn === OPS.setCharSpacing) {
      charSpacing = args[0] as number;
    } else if (fn === OPS.setLeading) {
      leading = args[0] as number;
    } else if (fn === OPS.setHScale) {
      hScale = (args[0] as number) / 100;
    } else if (fn === OPS.beginText) {
      // BT: text matrix と text line matrix を単位行列に戻す（PDF 32000-1 9.4.1）。**倍率も 1 に戻す。**
      tx = 0;
      ty = 0;
      lx = 0;
      ly = 0;
      sx = 1;
      sy = 1;
      tmSeenInBlock = false;
    } else if (fn === OPS.setTextMatrix) {
      // argsArray の形は [a,b,c,d,e,f] のことも、行列 1 つ（Array / Float32Array）を包んだ形のこともある
      const first = args[0] as unknown;
      const matrix = (args.length === 1 && typeof first === "object" && first !== null && "length" in (first as object) ? first : args) as ArrayLike<number>;
      // **`Tm` だけを見ない。CTM と合成してから判定する**（Issue #867 B 群「上下反転 9 本」）。
      //
      // **実測（2026-09-21、9 本すべて）**: `Tm` は全 showText で `[1,0,0,-1,e,f]` の 1 種類、
      // そのときの CTM も `[0.75,0,0,-0.75,0,H]` の 1 種類（H はページの高さ）。
      // **合成すると `[0.75,0,0,0.75,0.75e,H−0.75f]`——正の等方 0.75 倍＋平行移動で、
      // 反転は打ち消し合って消える。**
      // **つまりこの 9 本は「上下反転した本」ではなく「0.75 倍で置かれた本」である。**
      //
      // **合成前の `Tm` の `d < 0` で止めるのは、見るべき量を見ていない。**
      // 同じ理由で、**合成前の CTM が単位行列かどうかで止めるのも見るべき量ではない**
      // （この関数は 2026-09-21 まで showText のところで CTM を弾いていた。#700）。
      // **文字がページのどこに置かれるかを決めるのは `Tm × CTM` であって、その片方ではない。**
      const [ta, tb, tc, td] = Array.from(matrix);
      const m = multiplyMatrix(ctm, matrix);
      const [a, b, c, d, e, f] = m;
      const shown = `[${ta},${tb},${tc},${td}] under CTM [${ctm.join(",")}]`;
      // **回転・斜行は読まない**（Issue #867 B 群のうち「回転 90/270 の 11 本」。別 PR）。
      // 回転が入ると文字の送りが x でなく y に進み、行の向きも変わる。
      // この実装は「文字は x に進み、行は y に並ぶ」を前提に表を組み立てているので、
      // b / c が 0 でないまま読むと **列と行を取り違える**（#819: 行がずれれば賛成と反対が入れ替わる）。
      if (b !== 0 || c !== 0) throw new Error(`page ${pageNo}: rotated text matrix ${shown} not supported`);
      // **打ち消されずに残った反転は読まない。** 読めば行が上下逆に並び、賛成と反対が入れ替わる。
      if (a <= 0 || d <= 0) throw new Error(`page ${pageNo}: flipped text matrix ${shown} not supported`);
      // **a と d が違ってよいのは「同じ向きの拡大」の範囲だけにする。**
      // 実測（2026-09-19、拡大のみ 15 本の Tm 全部）: a と d の差は最大でも a の **0.1%**
      // （例: 8.039859771728516 と 8.032349586486816）。実質は等方の拡大で、丸め誤差しか違わない。
      if (Math.abs(a - d) > Math.abs(a) * 0.01) throw new Error(`page ${pageNo}: anisotropic text matrix ${shown} not supported`);
      // **x と y は別々に持つ**（a と d は丸めのぶんだけ違う。片方で代用しない）。
      // **実測（2026-09-19）**: `sy = d` を `sy = a` にしても、テストは 1 件も落ちず、
      // 151 本の読める本数も変わらない。**差が小さすぎるためである**——
      // 実データでいちばん離れた本（`000073609.pdf`: a=5.159900… / d=5.152400…）でも
      // **差は a の 0.145%、`h` で 0.0075pt、`cy` で 0.00375pt** にしかならず、
      // **行を割る罫線の間隔（十数 pt）に対して 3 桁小さい。**
      // **分類②「等価変異」に近い**（出力が変わる本はあるが、行の割り当てには届かない）。
      // **それでも `d` を使う**——**「小さいから代用してよい」は根拠になっておらず、
      // PDF が書いてある値をそのまま使うほうが、次に大きい差が来たときに壊れない。**
      sx = a;
      sy = d;
      tx = e;
      ty = f;
      lx = e;
      ly = f;
      tmSeenInBlock = true;
    } else if (fn === OPS.moveText || fn === OPS.setLeadingMoveText) {
      // Td / TD: 行頭から (dx, dy) 動かして新しい行頭にする。TD は同時に leading を設定する。
      // **高知（kochi/glyphs.ts）と同じ実装である**（#703 で書かれ、実データで動いているもの）。
      //
      // **ここには 2026-09-09 まで「この枝は実データでは一度も通らない」と書いてあった**（#703 / #707）。
      // **その記述は「フィクスチャ 5 本」という母数の上では正しく、今も正しい**——
      // **その 5 本の Td / TD / T* は当時 0 回で、2026-09-14 に数え直しても 0 回である。**
      // **間違っていたのは「実データ」という言葉のほうで、母数が 5 本だと書いていなかった**（#757）。
      //
      // **index 151 本に母数を広げた実測（2026-09-14、#867）: 80 本がこの枝で落ちていた。**
      //   A 群 80 本の内訳: `Td` 122,059 回 / `TD` 59,351 回 / `T*` 1,651 回 / `TL` **0 回**。
      //   **年で見ると A 群は 2011〜2023 年に収まり、2024 年以降の本は 1 本も無い**
      //   （フィクスチャ 5 本はすべて令和8年 = 2026 年の本なので、A 群を 1 本も含んでいなかった）。
      //   **ただし「古い本＝A 群」ではない**——**元から読めていた 33 本にも 2015・2016・2019 年の本がある。**
      //   **年で切り分かるのではなく、本ごとに作り方が違う。**
      //
      // **`T*` の行送りがどこから来るか**（`leading` の初期値が実データで効かない根拠）:
      //   **A 群 80 本の `T*` 1,651 回すべてに、同じ `BT` ブロックの中で先に `TD` が出ている**（0 例外）。
      //   **`T*` が 1 回以上出る 63 本すべてで `TD` > 0**、かつ **`TL` は 80 本で 0 回。**
      //
      // **移動量は text space なので `sx`/`sy` を掛ける**（Issue #867。拡大のみの 15 本で効く）。
      // `Tm` が単位行列の本では `sx = sy = 1` なので、既存の 84 本の値は 1 ビットも変わらない。
      const dx = args[0] as number;
      const dy = args[1] as number;
      if (fn === OPS.setLeadingMoveText) leading = -dy;
      lx += dx * sx;
      ly += dy * sy;
      tx = lx;
      ty = ly;
    } else if (fn === OPS.nextLine) {
      // T*: 行送りぶん下げて行頭へ。**`leading` も text space なので `sy` を掛ける**（Issue #867）。
      // `leading` は `TD` の `-dy` か `TL` の値で、どちらも text space の量である。
      ly -= leading * sy;
      tx = lx;
      ty = ly;
    } else if (fn === OPS.nextLineShowText || fn === OPS.nextLineSetSpacingShowText) {
      // `'` / `"`（次行送り＋表示）。**pdfjs の getOperatorList はここまで届けない**——
      // `'` を nextLine + showText に、`"` を nextLine + setWordSpacing + setCharSpacing + showText に
      // 分解して出す（実測 2026-09-09、手で組んだ PDF で確認。Issue #707）。
      // 分解された形なら上の nextLine の枝が正しく処理するが、**pdfjs が分解をやめたら
      // 何の枝にも当たらず黙って無視され、行送りを無視した位置で文字を読む**ので、生で来たら止める。
      throw new Error(`page ${pageNo}: unsupported next-line show-text op (' / ")`);
    } else if (fn === OPS.setWordSpacing) {
      // Tw: 空白グリフ 1 つごとに送り幅へ加算される（PDF 32000-1 9.3.3）。
      // **この実装は Tw を送りに足していない**ので、0 でない Tw の下では x が左へ詰まる。
      // 実測（2026-09-09、三重 5 本）: Tw は 0 回。空白グリフは 2 / 2 / 6 / 2 / 2 個あるので、
      // Tw が付けば効く。**正しい足し方を実データで検証できないため、出さない側に倒す**（#700 と同じ判断）。
      if ((args[0] as number) !== 0) throw new Error(`page ${pageNo}: non-zero word spacing (Tw ${args[0]}) not supported`);
    } else if (fn === OPS.showText) {
      // **CTM は `Tm` と合成して `sx`/`sy`/`tx`/`ty` に入っている**ので、ここで弾くものは無い
      // （Issue #867。2026-09-21 まではここで `!isIdentity(ctm)` を例外にしていた——
      // **上下反転 9 本はその検査に当たって落ちていたが、合成すれば反転は消える**）。
      // **ただし `Tm` が一度も来ないまま `cm` の下で文字が置かれる形は、まだ前提の外である**
      // （`BT` が `sx`/`sy` を 1 に、`tx`/`ty` を 0 に戻すだけで CTM を見ないため）。
      // **実測（2026-09-21、三重 151 本）: `BT` の後、最初の showText より前に `Tm` が来ない本は
      // 80 本あるが、そのすべてで CTM は単位行列である**（A 群の相対移動の本）。
      // **単位行列でない CTM の下で `Tm` 無しの showText が来たら止める**（推測で置かない）。
      //
      // **比べる相手は `display`（ページの `/Rotate` を打ち消す行列）である**（Issue #867 回転 11 本）。
      // **回転の無いページでは `display` は単位行列なので、今までと全く同じ判定になる。**
      // **回転のあるページで「CTM に何も足されていない」は「CTM が `display` のまま」を意味する**
      // ——**`IDENTITY` と比べると、打ち消しそのものを「余計な CTM」と読んで 11 本を全部止めてしまう。**
      if (!tmSeenInBlock && !sameMatrix(ctm, display)) throw new Error(`page ${pageNo}: text under non-identity CTM [${ctm.join(",")}] without a text matrix not supported`);
      showTextCalls++;
      // showText 1 回 = 1 アイテム。配列の数値は字送りの調整（thousandths）
      //
      // **送りは text space の量なので `sx` を掛ける**（Issue #867。拡大のみの 15 本で効く）。
      // この 15 本は `Tf` のサイズが 1 で `Tm` が大きさを持つので、掛けないと
      // **1 文字の幅が 1/8 になり、氏名の列の中で全部の文字が 1 点に潰れる**（#693 と同じ実害）。
      let x = tx;
      let str = "";
      let x0: number | undefined;
      // 高さも text space の量なので `sy` を掛ける（Tf 1 / Tm 8.04 の本で h が 1 になるのを防ぐ）
      const h = fontSize * sy;
      for (const g of args[0] as (number | { unicode?: string; width?: number } | null)[]) {
        if (typeof g === "number") {
          x -= (g / 1000) * fontSize * hScale * sx;
          continue;
        }
        if (!g || typeof g !== "object") continue;
        const w = ((g.width ?? 0) / 1000) * fontSize * hScale * sx;
        const u = (g.unicode ?? "").replace(/[\uE000-\uF8FF]/g, "〓"); // 私用領域（外字）は読めない（原文に無い文字を作らない）
        if (u.trim() !== "") {
          // **`splitGlyphs` のときはグリフ 1 つを 1 アイテムにする**（Issue #982）。
          // **幅は `w`（このグリフの送り幅）、左端は `x`**——**どちらも既定の枝が
          // 1 アイテムの `x0` / `w` を作るのに使っているのと同じ値である**（推定を足していない）。
          // **`charSpacing` を幅に入れないのは、字間は字の一部ではないから**
          // （既定の枝でも最後のグリフの後ろの字間は `w` に入らない。`x0 + w` は最後のグリフの右端になる）。
          //
          // **ただし、この選択は実データでは検証できない**（**分類②「等価変異」。2026-09-24 に測った**）:
          // **`w` に `charSpacing * hScale * sx` を足す変異を当てても、テストは 25 件中 1 件も落ちない。**
          // **理由は「差が小さいから」ではなく「`charSpacing` が 0 だから」である**——
          // **#982 で読めるようになった 12 本すべてで `setCharSpacing` が 1 回も出ない**（母数 12 / 12）。
          // **0 でない `charSpacing` を持つ本は 151 本中 103 本あるが、
          // そのどれもこの枝に入らない**（1 段目で読めるか、別の理由で止まる）。
          // **だから「どちらが正しいか」はこのデータでは決められない。**
          // **規格（PDF 32000-1 9.4.4）が「字送り = 幅 + 字間」と書いているので、
          // 「字の幅」は `w` のほうを採る**——**測れないときは規格に寄せる。**
          if (splitGlyphs) items.push({ str: u, x, y: ty, w, h, cx: x + w / 2, cy: ty + h / 2 });
          x0 ??= x;
          str += u;
        }
        x += w + charSpacing * hScale * sx;
      }
      if (!splitGlyphs && str !== "" && x0 !== undefined) {
        const w = x - x0;
        items.push({ str, x: x0, y: ty, w, h, cx: x0 + w / 2, cy: ty + h / 2 });
      }
      tx = x;
    } else if (fn === OPS.setTextRenderingMode) {
      // Tr: 塗り／線／不可視／クリップの別（PDF 32000-1 9.3.6）。**`3` は不可視**。
      // **見た瞬間に止める**（#707 の Tw と同じ理由——状態にして showText のときに判定すると、
      // たまたまその区間に文字が無かった回だけ通り、同じ PDF の別の回で不可視の文字を読む）。
      if (!READABLE_TEXT_RENDERING_MODES.has(args[0] as number)) throw new Error(`page ${pageNo}: unsupported text rendering mode (Tr ${args[0]})`);
    } else if (fn === OPS.setTextRise) {
      // Ts: ベースラインを上下にずらす（PDF 32000-1 9.4.3）。**この実装は y に足していない**ので、
      // 0 でない Ts の下では文字の y がずれる（#707 の担当者が別 Issue 候補として残した宿題）。
      // 実測（2026-09-09、フィクスチャ 7 本）: Ts は 0 回。正しい足し方を実データで検証できないので止める。
      if ((args[0] as number) !== 0) throw new Error(`page ${pageNo}: non-zero text rise (Ts ${args[0]}) not supported`);
    } else if (fn === OPS.setGState) {
      // gs: ExtGState をまとめて適用する。**pdfjs は [鍵, 値] の並びを 1 つ包んで渡す**
      // （pdf.worker.mjs の setGState が組み立てる gStateObj）。**中身を見ないと危ない鍵が 2 つある**:
      //   - `Font`: フォントと**サイズ**を設定するが、**このとき pdfjs は setFont を出さない**
      //     （実測。test/local-glyphs-unknown-ops.test.ts の 1. が実物の PDF で固定している）。
      //     この実装は fontSize を setFont からしか取らないので **0 のまま**になり、
      //     グリフ幅が全部 0 → **文字の x が 1 点に潰れる**。潰れた座標で列を割ると
      //     記号が別の議員の列に入る（#693 と同じ実害。高知も三重も 1 人 1 列）。
      //   - `ca` / `CA` が 1 でない: 塗り／線が透ける。**0 なら完全に見えない**（Tr 3 と同じ帰結）。
      // 実測（2026-09-09、フィクスチャ 7 本の setGState 14 回すべて）: 出たのは
      // `[["BM","source-over"],["ca",1]]` と `[["BM","source-over"],["CA",1]]` の 2 種類だけ。
      // **allowlist にする**ので、知らない鍵（SMask など）は止まる側に落ちる。
      for (const [key, value] of (args[0] as [string, unknown][]) ?? []) {
        if (key === "BM") continue; // 合成モード。文字の位置にも可読性にも効かない
        if ((key === "ca" || key === "CA") && value === 1) continue; // 完全に不透明（実データはこれ）
        throw new Error(`page ${pageNo}: unsupported graphics state (${key === "ca" || key === "CA" ? `${key} ${value}` : key})`);
      }
    } else if (!HARMLESS_OPS.has(fn)) {
      // **既定の枝**（Issue #717）。ここに来る演算子は、この実装が一度も考えたことのないものである。
      // **黙って無視すると、それが位置や可読性を変える演算子だったときに気づけない。**
      // 番号と名前を出して止める（`OPS` に名前が無い番号なら "unknown"）。
      throw new Error(`page ${pageNo}: unsupported operator ${fn} (${opName(fn)})`);
    }
  }
  // **文字を描けと言われたのに 1 文字も取れなかったページは、読めたことにしない**（Issue #867）。
  //
  // **pdfjs は、フォントを組み立てられなかったとき例外を投げず、showText に空の配列を渡す。**
  // いちばん多い原因は「あらかじめ定義された CMap」を渡していないこと（`../pdf-cmap.ts`）だが、
  // **壊れた埋め込みフォントでも同じ形になる**。どちらも **文字が黙って消える**。
  // ここで止めないと「罫線だけの空の表」を正しく読めたものとして返し、
  // **途中まで読んだ表（#569）** になる——後段が表題で落ちるかどうかは本の作り次第で、
  // **偶然に頼ってはいけない。**
  //
  // 実測（2026-09-19、三重 151 本）: この検査で新たに落ちる本は **0 本**
  // （CMap を渡した後は、showText がある 151 本すべてで 1 つ以上のアイテムが取れる）。
  // **つまりこれは「今の本を落とすための検査」ではなく「黙って空を返さないための受け皿」である。**
  if (items.length === 0 && showTextCalls > 0) {
    throw new Error(`page ${pageNo}: no glyphs from ${showTextCalls} show-text ops (font/CMap not loaded?)`);
  }
  return { items, vlines, hlines };
}
