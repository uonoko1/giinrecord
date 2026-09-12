import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { multiplyMatrix, readLines, type Matrix, type PageGeometry, type Item } from "../pdf-table.ts";

/**
 * オペレータ列からの文字と罫線の読み出し（Issue #220 高知）。
 *
 * pdf-table.ts の readPages（getTextContent）は、別々の描画命令（Tm ＋ Tj）で置かれた文字を 1 つのテキストに
 * まとめることがあり、まとめられた 2 文字目以降の位置が失われる。高知の会期 PDF では、賛否の 1 行ぶん
 * （議員 36 人ぶんの「○」「×」「議」）が丸ごと 1 つのテキスト（「○ ○ ○ … 議 … ○」）になる回があり、
 * どの列がどの値かが分からなくなる（令和7年6月定例会分。令和8年6月定例会分は 1 文字ずつ別テキスト）。
 * この PDF は 1 文字ずつ setTextMatrix（位置の明示）＋ showText で置いているので、オペレータ列を歩けば
 * 1 文字ごとの正確な位置が取れる（推定・等間隔の割り付けではない）。
 *
 * 三重の glyphs.ts と同じ考え方だが、こちらの PDF は行送りに moveText（Td）も使うので、
 * Td/TD/T* は「直前の行頭からの相対移動」として仕様どおり畳み込む（三重は Tm だけを前提に例外にしている）。
 * 回転・拡縮の入った text matrix、単位行列でない CTM の下の文字が出たら例外（黙って読み間違えない）。
 * 生の `'` / `"`（次行送り＋表示）と 0 でない word spacing（Tw）も例外（Issue #707）。
 * **知らない演算子も例外**（Issue #717）——この関数には既定の枝が無く、**見たことのない演算子は
 * 何の枝にも当たらず黙って次へ進んでいた**。色や線の体裁など、文字に効かないものだけ明示的に無視する
 * （HARMLESS_OPS）。不可視の文字（`Tr 3`）と ExtGState の `Font` / 透明指定も止める。
 * 罫線は pdf-table.ts の readLines に任せる（CTM を掛ける。Issue #693 / #700）。
 */
export async function readGlyphPages(bytes: Buffer): Promise<PageGeometry[]> {
  const loadingTask = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const doc = await loadingTask.promise;
  const out: PageGeometry[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const ops = await page.getOperatorList();
      out.push(readGlyphPageOps(ops.fnArray, ops.argsArray, i));
    }
  } finally {
    await loadingTask.destroy();
  }
  return out;
}

/** 単位行列（q/Q/cm を辿るときの初期値）。 */
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** CTM が単位行列か（文字の位置を Tm / Td だけで決められるか）。 */
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
 * **潰れた線で列を割ると、賛否の記号が別の議員の列に入る**（高知は 1 人 1 列なので直撃する。
 * 利用者からは検出できない）。掛け方（4 隅を見る外接矩形、cm の合成の向き）は
 * 1 か所に置きたいので readLines を呼ぶ。
 *
 * **文字のほうは CTM を掛けていない**（この読み方は Tm / Td の値をそのままページ座標として使う）。
 * 掛けないまま `cm` の下で文字が置かれたら黙って別の位置に読むので、
 * **showText が単位行列でない CTM の下に来たら例外にする**（黙って読み間違えない、と同じ方針）。
 * 実測（2026-09-09、フィクスチャ 2 本）: 高知の PDF の showText は 5,004 回すべて CTM が単位行列。
 *
 * `getOperatorList()` ではなく配列 2 本で受けるのは、PDF を作らずに
 * `q`/`Q` の入れ子を直接テストできるようにするため（高知のフィクスチャは
 * 変換ありの constructPath が 0 本で、掛けても掛けなくても同じ値になり違いを見せられない）。
 */
export function readGlyphPageOps(fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>, pageNo: number): PageGeometry {
  const items: Item[] = [];
  const { vlines, hlines } = readLines(fnArray, argsArray);
  let ctm: Matrix = IDENTITY;
  const ctmStack: Matrix[] = [];
  let fontSize = 0;
  let charSpacing = 0;
  let hScale = 1;
  /**
   * 行送り（T* が使う）。**初期値 0 は PDF 32000-1 の 9.3.5 が定める既定値**（Issue #703）。
   *
   * **実データでは、この初期値も leading 自体も一度も読まれない。**
   * 実測（2026-09-09、高知 2 本・三重 5 本のフィクスチャ）: **`T*` も `TD` も `TL` も 0 回**。
   * 高知は行送りに `Td`（1109 回 / 1042 回）を使い、`Td` は行頭を置き直すので leading を読まない。
   * （Issue #703 は当初「`T*` の前に必ず `TD`/`TL` を出すから初期値が読まれない」としていたが、
   * 追試の結果それは誤りで、**`T*` 自体が 1 回も出てこない**のが本当の理由だった。）
   *
   * **だから、この値を守るテストは実物の PDF では書けない。**
   * `test/local-glyphs-leading.test.ts` が readGlyphPageOps にオペレータ列を直接渡して固定している
   * （初期値を 999 に変えると、そこの 2 件が落ちる。実測: 変えても県ごとの PDF テスト 13 件は全部通る）。
   * **この段落を消すと、あちらのテストが「実データに無い形を守る不要なもの」に見えて消される。**
   */
  let leading = 0;
  // 現在のテキスト位置（tx, ty）と行頭（lx, ly）。Td/TD/T* は行頭からの相対移動
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
      tx = 0;
      ty = 0;
      lx = 0;
      ly = 0;
    } else if (fn === OPS.setTextMatrix) {
      // argsArray の形は [a,b,c,d,e,f] のことも、行列 1 つ（Array / Float32Array）を包んだ形のこともある
      const first = args[0] as unknown;
      const matrix = (args.length === 1 && typeof first === "object" && first !== null && "length" in (first as object) ? first : args) as ArrayLike<number>;
      const [a, b, c, d, e, f] = Array.from(matrix);
      if (a !== 1 || b !== 0 || c !== 0 || d !== 1) throw new Error(`page ${pageNo}: rotated/scaled text matrix [${a},${b},${c},${d}] not supported`);
      tx = e;
      ty = f;
      lx = e;
      ly = f;
    } else if (fn === OPS.moveText || fn === OPS.setLeadingMoveText) {
      // Td / TD: 行頭から (dx, dy) 動かして新しい行頭にする。TD は同時に leading を設定する
      const dx = args[0] as number;
      const dy = args[1] as number;
      if (fn === OPS.setLeadingMoveText) leading = -dy;
      lx += dx;
      ly += dy;
      tx = lx;
      ty = ly;
    } else if (fn === OPS.nextLine) {
      // T*: 行送りぶん下げて行頭へ
      ly -= leading;
      tx = lx;
      ty = ly;
    } else if (fn === OPS.nextLineShowText || fn === OPS.nextLineSetSpacingShowText) {
      // `'` / `"`（次行送り＋表示）。**pdfjs の getOperatorList はここまで届けない**——
      // `'` を nextLine + showText に、`"` を nextLine + setWordSpacing + setCharSpacing + showText に
      // 分解して出す（実測 2026-09-09、手で組んだ PDF で確認。Issue #707）。
      // だからこの枝は実データでも自作 PDF でも通らないが、**pdfjs が分解をやめたら
      // 何の枝にも当たらず黙って無視され、行送りを無視した位置で文字を読む**（別の議員の欄に記号が入る）。
      // 分解された形なら上の nextLine の枝が正しく処理するので、**生で来たら読まずに止める**（#569）。
      throw new Error(`page ${pageNo}: unsupported next-line show-text op (' / ")`);
    } else if (fn === OPS.setWordSpacing) {
      // Tw: 空白グリフ 1 つごとに送り幅へ加算される（PDF 32000-1 9.3.3）。
      // **この実装は Tw を送りに足していない**ので、0 でない Tw の下では x が左へ詰まる。
      // 実測（2026-09-09、高知 2 本・三重 5 本）: Tw は 0 回。空白グリフは高知に 62 / 61 個あるので、
      // Tw が付けば効く。**正しい足し方を実データで検証できないため、出さない側に倒す**（#700 と同じ判断）。
      if ((args[0] as number) !== 0) throw new Error(`page ${pageNo}: non-zero word spacing (Tw ${args[0]}) not supported`);
    } else if (fn === OPS.showText) {
      // 文字の位置は Tm / Td の値をそのままページ座標として使う。cm の下ではその前提が崩れる（#700）
      if (!isIdentity(ctm)) throw new Error(`page ${pageNo}: text under non-identity CTM [${ctm.join(",")}] not supported`);
      // showText 1 回 = 1 アイテム。配列の数値は字送りの調整（thousandths）
      let x = tx;
      let str = "";
      let x0: number | undefined;
      for (const g of args[0] as (number | { unicode?: string; width?: number } | null)[]) {
        if (typeof g === "number") {
          x -= (g / 1000) * fontSize * hScale;
          continue;
        }
        if (!g || typeof g !== "object") continue;
        const w = ((g.width ?? 0) / 1000) * fontSize * hScale;
        const u = (g.unicode ?? "").replace(/[\uE000-\uF8FF]/g, "〓"); // 私用領域（外字）は読めない（原文に無い文字を作らない）
        if (u.trim() !== "") {
          x0 ??= x;
          str += u;
        }
        x += w + charSpacing * hScale;
      }
      if (str !== "" && x0 !== undefined) {
        const w = x - x0;
        items.push({ str, x: x0, y: ty, w, h: fontSize, cx: x0 + w / 2, cy: ty + fontSize / 2 });
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
  return { items, vlines, hlines };
}
