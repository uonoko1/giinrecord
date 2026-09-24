import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { multiplyMatrix, readLines, type Matrix, type PageGeometry, type Item } from "../pdf-table.ts";
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
      out.push(readGlyphPageOps(ops.fnArray, ops.argsArray, i, options));
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
}

/** 単位行列（q/Q/cm を辿るときの初期値）。 */
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** CTM が単位行列か（文字の位置を Tm だけで決められるか）。 */
const isIdentity = (m: Matrix): boolean => m.every((v, i) => v === IDENTITY[i]);

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
 *   - `setFillRGBColor` / `setStrokeRGBColor` / `setLineWidth` / `setLineCap` / `setLineJoin`:
 *     **色と線の体裁だけ**。文字の座標にも、文字が見えるかどうかにも効かない
 *     （見えなくする方法は「透明にする」で、それは `setGState` の `ca`/`CA` 側にあり、下で止めている）。
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
  const { splitGlyphs = false } = options;
  const items: Item[] = [];
  /** このページで「文字を描け」と言われた回数（0 グリフのまま終わったら例外にする。Issue #867）。 */
  let showTextCalls = 0;
  // **`splitBatchedPaths` は三重だけで `true` にする**（Issue #867 B 群「上下反転 9 本」）。
  // この 9 本は 13,207 本の罫線が 92 回の `constructPath` に畳まれており、
  // 割らないと **縦罫線 0 本・横罫線 0 本**になる（例外は出ない。黙って空の表になる）。
  // **佐賀では `true` にすると字の輪郭を罫線と読み違えて票が別の列に落ちる**ので、
  // 共通層の既定は `false` のままにしてある（`pdf-table.ts` の `ReadLinesOptions` に実測表がある）。
  const { vlines, hlines } = readLines(fnArray, argsArray, { splitBatchedPaths: true });
  let ctm: Matrix = IDENTITY;
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
      ctm = ctmStack.pop() ?? IDENTITY;
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
      if (!tmSeenInBlock && !isIdentity(ctm)) throw new Error(`page ${pageNo}: text under non-identity CTM [${ctm.join(",")}] without a text matrix not supported`);
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
