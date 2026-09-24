import { bandIndex, byRowThenColumn, cluster, EDGE, EPS, joinVertical, within, type Item, type PageGeometry } from "../pdf-table.ts";
import { readGlyphPages } from "./glyphs.ts";
import { warekiYear } from "./site.ts";
import { legendKey } from "../glyph-variants.ts";

/**
 * 三重県議会「議員別の賛否等の状況」PDF の表復元（Issue #203）。月ごとに 1 本。
 *
 * レイアウト（A4 横。1 ページに全議案 × 全議員（47 列、列幅 約15pt）の高密度の表。議案が多い月は同じ形のページが増える）:
 *   見出し行: 「令和８年定例会（２月）」「議案等の審議結果」、凡例「○：賛成 ×：反対 議：議長 除：除斥 －：不在 欠：欠席」
 *   表: 左 8 列（議案等番号・件名・議決月日・出席者数・表決者数・賛成者数・反対者数・議決結果）＋ 議員の列（1 人 1 列）。
 *       議員の列は上段に会派名（結合セル。略称の凡例は無く正式名称がそのまま載る）、その下に縦書きの氏名（1 文字 1 テキスト）。
 *       本文のセルは凡例の 1 文字。ヘッダ（見出し・凡例・会派・氏名・列見出し）は全ページで繰り返される。
 *
 * 方針（宮城・徳島と同じ）: 文字の位置を推定で並べ替えない。罫線から列と行の境界を取り、
 * 各テキストの中心がどのセルに入るかだけで置く。1 セルに 1 文字が入らなければ（空・2 つ以上・境界上）そのセルは UNKNOWN_CELL。
 * 凡例に無い値が出たら例外（丸めない）。ページごとの議員の並びが違えば例外。
 */
export const UNKNOWN_CELL = "不明";
export const UNKNOWN_LEGEND = "抽出不能";

export interface VotePdfMember {
  /** 縦書きの氏名を上から並べたもの。空きマスは半角空白 1 つ（例「市野 修平」。5 文字で埋まる「中瀬古初美」には入らない）。異体字セレクタも原文のまま */
  nameText: string;
  /** 会派見出しの原文（正式名称。「新政みえ」「日本共産党」） */
  group: string;
}

export interface VotePdfRow {
  page: number;
  /** 議案等番号の接頭辞（「議案」「諮問」「請願」「意見書案」「議提議案」…） */
  kind: string;
  /** 議案等番号の「第…号」部分の原文（「第79号」「第８号」） */
  number: string;
  title: string;
  /** 議決月日の原文（「2/27」） */
  dateText: string;
  counts: { present: number; voting: number; yes: number; no: number };
  result: string;
  /** members と同じ順。置けなかったセルは UNKNOWN_CELL */
  cells: string[];
}

export interface VotePdf {
  /** 表題の原文（「令和８年定例会（２月）」） */
  title: string;
  /** 表題の会期部分の原文（「令和８年定例会」）。会期 index の h2 と突合する */
  sessionName: string;
  year: number;
  month: number;
  /** セルの値 → 凡例の意味（「○」→「賛成」） */
  legend: Record<string, string>;
  members: VotePdfMember[];
  rows: VotePdfRow[];
  unknownCells: number;
  pages: number;
}

// 表題の showText は「議案等の審議結果」まで 1 つのテキストになることがあるので末尾は縛らない
const TITLE = /^((令和|平成)([０-９0-9]+|元)年(?:第[０-９0-9]+回)?(?:定例会|臨時会))（([０-９0-9]+)月）/;
/**
 * 凡例の 1 項目「{記号}：{意味}」。**繋がった形（1 つの showText に 6 項目）があるので `g` で全部拾う**（#841）。
 * index 151 本のうち **20 本**が `"○：賛成×：反対議：議長除：除斥－：不在欠：欠席"` の 1 テキストで出る
 * （残る 16 本は 6 テキストに分かれる。この 2 形しか無いことを読めた 36 本すべてで数えた）。
 * 意味は **次の「{1 文字}：」の直前まで**（非貪欲＋先読み）。
 * **貪欲な `(.+)` だと 1 件にまとまり、`議`/`欠`/`除` が「凡例に無い」として落ちていた**（#835 で 20 本を実測）。
 */
const LEGEND_ITEM = /(.)：(.+?)(?=.：|$)/gu;
/** テキスト全体が「{記号}：{意味}」の並びだけで出来ているか（余りがあれば凡例として読まない） */
function splitLegendText(raw: string): { key: string; desc: string }[] {
  const text = raw.trim();
  const out: { key: string; desc: string }[] = [];
  let end = 0;
  for (const m of text.matchAll(LEGEND_ITEM)) {
    if (m.index !== end) return []; // 途中に凡例でない文字がある = このテキストは凡例ではない
    out.push({ key: m[1], desc: m[2] });
    end = m.index + m[0].length;
  }
  return end === text.length ? out : [];
}
/** テスト用（凡例の区切り方だけを単体で見る。#841） */
export const splitLegendTextForTest = splitLegendText;
// 賛成・反対の列見出しは 2 文字（「者数」は付かない）
const LEFT_HEADERS = ["議案等番号", "件名", "議決月日", "出席者数", "表決者数", "賛成", "反対", "議決結果"] as const;
/**
 * **議案等番号のセル → (種別, 番号)**。**どちらも原文のまま返す**（#569。表記を揃え直さない）。
 *
 * **2026-09-20 に index の賛否 PDF 151 本すべてを取得して、このセルの原文を数えた**
 * （#901。`.measure/901/numbers.ts`。**母数 3,700 個 / 9 種**）:
 *
 * | 形 | 件数 | 枝 |
 * |---|---:|---|
 * | `議案第N号` 2,838 / `意見書案第N号` 279 / `請願第N号` 240 / `認定第N号` 233 / `議提議案第N号` 72 / `決議案第N号` 23 / `諮問第N号` 5 | **3,690** | 1 番目 |
 * | **`意見書第N案`**（`第` と `号`/`案` が入れ替わる。令和6年12月の 2 個） | **2** | 2 番目 |
 * | **`意見書案N号`**（`第` が無い。令和5年6月の 3 個と平成28年10月の 5 個） | **8** | 3 番目 |
 *
 * **外れるのは 10 個（0.27%）で、2 本の PDF に固まっている**——
 * **`001172850.pdf`（令和6年12月）と `001086178.pdf`（令和5年6月）。**
 * **`index.ts` は `parseVotePdf` の例外を握り潰さない**ので、**この 10 個が
 * 令和6年定例会と令和5年第2回定例会をまるごと塞いでいた**（#901 で実測）。
 *
 * **3 つの枝はどれも「セルに書いてある種別と番号をそのまま割る」だけで、補っていない**——
 * **`意見書案３号` を `意見書案第３号` に直さないし、`意見書第26案` を `第26号` にしない。**
 * **原文に無い文字を出力に入れると、採決 id が一次資料と食い違う**（#569）。
 *
 * **貪欲にしない**: 先頭の `(.+?)` は最短一致なので、**`議案第79号` は `(議案, 第79号)` に割れる**
 * ——**`(議案第7, 9号)` にはならない。**
 *
 * **枝の順序は結果を変えない**（**2026-09-20 に変異を当てて確かめた**。#901）。
 * **当初この docblock は「`第N号` を先に見るので 3 番目の枝に落ちない」と書いていたが、それは誤りだった。**
 * **3 つの枝を逆順（`N号` を先）にしても、`議案第79号` `意見書案３号` `意見書第26案` など
 * 実データの 9 種すべてで結果が 1 文字も変わらない**——
 * **`(.+?)` が最短から伸ばし、末尾が `$` で固定されているので、
 * 最初に全体が一致する位置は枝の順序に依らないからである。**
 * **順序を入れ替える変異はテストを落とさない。これは等価変異であって、守りの穴ではない。**
 */
const NUMBER_CELL = /^(.+?)(?:(第[0-9０-９]+号)|(第[0-9０-９]+案)|([0-9０-９]+号))$/;

/**
 * **「既定で読む → 落ちたらグリフに割って読み直す」の 2 段構え**（Issue #982）。
 *
 * ## なぜ 2 段にするか（**#969 が割らなかった理由への答え**）
 *
 * **三重の 17 本は 1 回の showText に複数のセルぶんの文字を入れている**ので、
 * **1 アイテムが丸ごと 1 つの列に落ち、残りの列が空になる**（`glyphs.ts` の `splitGlyphs` に実測表）。
 * **割れば読めるが、全部を割ると `TITLE` / `LEGEND_ITEM` が 1 文字ずつのアイテムに当たらなくなり、
 * 今読めている 99 本が表題も凡例も失う**（#969 が測ったとおり）。
 *
 * **#969 は「どのアイテムが記号帯かを決める規則」を考えて、
 * 規則を誤れば別人の列に票が落ちる（#569）として見送った。**
 *
 * **この実装は規則を作らない。** **「どれを割るか」を一切選ばず、
 * **本ごとに「割らないで読む」を先に試し、それが例外で止まった本だけ「全部割って」読み直す。**
 *
 * **だから読めている本はこの枝に入らない**——**入口の `readGlyphPages(bytes)` が成功した時点で返る。**
 * **実測（2026-09-24、index の賛否 PDF 151 本すべて）: 読めていた 99 本の
 * セル・議員・凡例・表題のハッシュは 1 本も変わらない**（1 段目で返るため、構造上そうなる）。
 *
 * ## **2 段目が「黙って間違える」ことはあるか**（#569 の重さ）
 *
 * **ある。だから 2 段目にも 1 段目と同じ検査がすべて掛かる**——
 * 左 8 列の見出しが `LEFT_HEADERS` と一致すること、凡例に無い記号が出たら例外、
 * ページごとの議員の並びが同じこと、行の日付・人数が形どおりであること。
 * **2 段目だけが緩い、ということが無いようにしてある**（同じ `parseFrom` を呼ぶ）。
 *
 * **そのうえで、割った位置が正しいことを別に実測した**（2026-09-24、**17 本すべて・全 30 ページ**）:
 * **記号帯のグリフ 21,197 個の中心が、罫線で決まる議員の列に対して
 * `内側 21,197 / 境界上 0 / 列の外 0`、かつ「同じ列に 2 つ落ちた」が 0。**
 * **1 グリフがちょうど 1 列に、1 列にちょうど 1 グリフ入る。**
 */
export async function parseVotePdf(bytes: Buffer): Promise<VotePdf> {
  try {
    return await parseFrom(await readGlyphPages(bytes));
  } catch (first) {
    // **2 段目に進むのは 1 段目が止まった本だけ**（読めた本はここに来ない）。
    let pages;
    try {
      pages = await readGlyphPages(bytes, { splitGlyphs: true });
    } catch {
      throw first; // 割っても読み出せない（例: 回転）。**1 段目の理由をそのまま返す**（理由を差し替えない）
    }
    try {
      return await parseFrom(pages);
    } catch (second) {
      // **どちらの理由も残す**（#569。「割れば読める」と誤解させない）
      throw new Error(`${(first as Error).message} / after splitting glyphs: ${(second as Error).message}`);
    }
  }
}

async function parseFrom(pages: PageGeometry[]): Promise<VotePdf> {
  if (pages.length === 0) throw new Error("PDF has no pages");
  const head = parseHeader(pages[0].items, 1);
  const legend = parseLegend(pages[0].items, head.tableTop, 1);
  let members: VotePdfMember[] | undefined;
  const rows: VotePdfRow[] = [];
  let unknownCells = 0;
  for (let p = 0; p < pages.length; p++) {
    const page = pages[p];
    const pageHead = parseHeader(page.items, p + 1);
    if (pageHead.title !== head.title) throw new Error(`page ${p + 1}: title ${pageHead.title} !== ${head.title}`);
    const grid = buildGrid(page, pageHead.tableTop, p + 1);
    const pageMembers = readMembers(page, grid, p + 1);
    if (!members) members = pageMembers;
    else if (JSON.stringify(members) !== JSON.stringify(pageMembers)) throw new Error(`page ${p + 1}: member columns differ from page 1`);
    const pageRows = readRows(page, grid, p + 1, members.length);
    for (const row of pageRows) {
      checkCellsAgainstLegend(row.cells, legend, `page ${row.page} ${row.kind}${row.number}`);
      unknownCells += row.cells.filter((c) => c === UNKNOWN_CELL).length;
    }
    rows.push(...pageRows);
  }
  if (!members || members.length === 0) throw new Error("no member columns found");
  if (rows.length === 0) throw new Error("no rows found");
  return { title: head.title, sessionName: head.sessionName, year: head.year, month: head.month, legend, members, rows, unknownCells, pages: pages.length };
}

/** 凡例に無い値が出たら例外（丸めない・推定しない）。UNKNOWN_CELL だけは通す。字形の揺れ（〇 U+3007・✕ U+2715）は凡例の記号に寄せて引く（#674）。 */
export function checkCellsAgainstLegend(cells: readonly string[], legend: Record<string, string>, label: string): void {
  for (const c of cells) {
    if (c === UNKNOWN_CELL) continue;
    if (!(legendKey(c) in legend)) throw new Error(`${label}: cell value "${c}" is not in the legend (${Object.keys(legend).join("")})`);
  }
}

/* ---------- header & legend ---------- */

/**
 * **同じ行に並ぶ文字を x の順に繋ぐ**（Issue #867 A-2）。行ごとに `{ y, text }` を上から順に返す。
 *
 * ## 何が問題か
 *
 * **表題と凡例を 1 文字ずつ別の `showText` で置いている本がある**（index 151 本のうち **19 本**。実測 2026-09-21）。
 * `readGlyphPages` は **showText 1 回を 1 アイテム**にするので、そういう本では
 * **どのアイテムも 1 文字しか持たず、`TITLE` にも `LEGEND_ITEM` にも当たらない。**
 *
 * 実測（`000995095.pdf` 令和4年1月分、1 ページ目）: **`令` `和` `4` `年` `定` `例` `会` `（` `１` `月` `）` … が
 * すべて同じ y=766.8 に x=104.6 から 11.9pt 刻みで 19 個**並ぶ。
 * **凡例も同じ形**——**19 本すべてで「単体で凡例として読めるアイテム」は 0 個、
 * 繋ぐと 1 個**（実測。母数 19 / 19）。**表題だけ直しても読めるようにならない。**
 *
 * **#841 が凡例で直したのと同じ形**（あちらは「繋がりすぎ」で 1 つのテキストに 6 項目、
 * こちらは「割れすぎ」。**どちらも showText の切れ目が意味の切れ目と一致しない**）。
 *
 * ## 推定ではない（#569）
 *
 * **やっているのは並べ替えだけである**——**文字を足しも引きもせず、同じ行の文字を x の順に繋ぐ。**
 * **繋いだ結果が `TITLE` / 凡例の形に当たらなければ、今までどおり例外になる。**
 * **`000073600.pdf`（`平成２０年第１回臨時会`。`（M月）` が無い）は、繋いでも当たらないので読めないまま**
 * （A-3。**この変更で読めるようになる本と、ならない本の境目がここにある**）。
 *
 * ## 行の切り方
 *
 * **「y の差が、その行の先頭の文字の高さの半分以上」で行を切る。**
 * 表題の文字は同じ y に置かれるので実測では差 0 だが、丸めの揺れを見込んで半分だけ許す。
 * **隣の行はそれより離れている**——実測: 表題 y=766.8 の次の行（凡例）は y=758.3 で、
 * **差 8.5pt に対し表題の文字の高さは 11.8pt**。**半分（5.9pt）なら切れる。**
 */
function joinedLines(items: Item[]): { y: number; text: string }[] {
  if (items.length === 0) return [];
  // **ここの許容差は、今の 151 本では等価変異である**（Issue #999。**測ったので、そう書き残す**）。
  //
  // **`byRowThenColumn` を元の `(b.y - a.y || a.x - b.x)` に戻す変異を当てても、
  // 151 本の出力は 1 ビットも変わらない**（読めた 112 本のうち値が変わった本 0、読めなくなった本 0）。
  //
  // **理由は「差が小さいから」ではない。誤差でひっくり返る対は、ここがいちばん多い**——
  // **151 本で 2,627 対（`cellText` と `joinVertical` は 0 対）。**
  // **それでも出力が変わらないのは、この関数の結果が
  // 「`TITLE` に当たる行」と「凡例として読める行」を探すためだけに使われるから**である。
  // **崩れるのは本文の行で、そこは `TITLE` にも `LEGEND_ITEM` にも当たらない。**
  // **実測（151 本）: 表題として当たった行 479 / 凡例として当たった行 444 のうち、
  // 許容差の有無で文字列が変わったものは 0 行。**
  // **当たり外れが変わった行も 0 行**（新しく当たるようになった行 0 / 当たらなくなった行 0）。
  //
  // **それでも許容差つきを使う**——**「今のデータでは同じ」は「正しい」ではない。**
  // **本文の行が崩れたまま表題や凡例の形に当たってしまえば、別の文字列が黙って通る**（#569）。
  const sorted = [...items].sort(byRowThenColumn);
  const out: { y: number; text: string }[] = [];
  let line: Item[] = [];
  const flush = () => { if (line.length > 0) out.push({ y: line[0].y, text: line.map((i) => i.str).join("") }); };
  for (const it of sorted) {
    if (line.length > 0 && Math.abs(it.y - line[0].y) >= Math.max(line[0].h, 1) / 2) {
      flush();
      line = [];
    }
    line.push(it);
  }
  flush();
  return out;
}

function parseHeader(items: Item[], pageNo: number): { title: string; sessionName: string; year: number; month: number; tableTop: number } {
  // **まず 1 アイテムで当たるものを探す**（今までどおり。読めていた本はこの経路のまま値が変わらない）。
  // **無ければ、同じ行の文字を繋いで探す**（Issue #867 A-2。**繋いでも当たらなければ例外**）。
  const lines = joinedLines(items);
  const single = items.find((i) => TITLE.test(i.str.trim()));
  const raw = single ? single.str.trim() : lines.map((l) => l.text.trim()).find((l) => TITLE.test(l));
  if (raw === undefined) throw new Error(`page ${pageNo}: title (令和N年定例会（M月）) not found`);
  const m = raw.match(TITLE)!;
  // **凡例も 1 文字ずつ割れていることがある**（A-2。19 本すべてがその形）。
  // **単体で読めるものがあればそれだけを使う**（既存の本の `tableTop` を 1 ビットも変えないため）。
  const singleYs = items.filter((i) => splitLegendText(i.str).length > 0).map((i) => i.y);
  const legendYs = singleYs.length > 0 ? singleYs : lines.filter((l) => splitLegendText(l.text).length > 0).map((l) => l.y);
  if (legendYs.length === 0) throw new Error(`page ${pageNo}: legend (○：賛成 …) not found`);
  // 表の上端 = 凡例行の下（buildGrid が罫線から取る。ここでは凡例の最下行を返す）
  return { title: m[0], sessionName: m[1], year: warekiYear(m[2], m[3]), month: Number(m[4].normalize("NFKC")), tableTop: Math.min(...legendYs) };
}

function parseLegend(items: Item[], tableTop: number, pageNo: number): Record<string, string> {
  const legend: Record<string, string> = {};
  // **単体で凡例として読めるアイテムがあればそれだけを使う**（今までどおり）。
  // **1 つも無ければ、同じ行の文字を繋いだものを読む**（Issue #867 A-2。**19 本がこの形**）。
  // **「単体が 1 つでもあれば繋いだ側は見ない」**ので、**読めていた本の凡例は 1 ビットも変わらない。**
  const singles = items.filter((i) => splitLegendText(i.str).length > 0).map((i) => ({ y: i.y, text: i.str }));
  const sources = singles.length > 0 ? singles : joinedLines(items);
  for (const src of sources) {
    if (src.y < tableTop - EPS) continue; // 表より下は凡例ではない
    for (const { key, desc } of splitLegendText(src.text)) {
      if (key in legend) throw new Error(`page ${pageNo}: legend key ${key} appears twice`);
      legend[key] = desc.replace(/[\s　]+/g, "");
    }
  }
  if (Object.keys(legend).length === 0) throw new Error(`page ${pageNo}: legend empty`);
  return legend;
}

/* ---------- grid ---------- */

interface Grid {
  /** 表の上端（会派見出しの上の罫線）・本文の上端（氏名の下の罫線）・下端 */
  top: number;
  bodyTop: number;
  bottom: number;
  /** 会派見出しの下（氏名の上）の罫線 */
  groupBottom: number;
  /** 左 8 列の境界（9 本）。[8] が表決エリアの左端 */
  leftCols: number[];
  /** 議員の列の境界（議員数＋1 本）。[0] が左 8 列の右端 */
  voteCols: number[];
  /** 会派の結合セルの境界 */
  groupCols: number[];
  /** 本文の行境界（全幅の罫線。上から下へ降順） */
  rowLines: number[];
}

function buildGrid(page: PageGeometry, legendBottom: number, pageNo: number): Grid {
  const label = `page ${pageNo}`;
  const vl = page.vlines.filter((l) => l.y0 < legendBottom);
  const hl = page.hlines.filter((l) => l.y < legendBottom);
  if (vl.length === 0 || hl.length === 0) throw new Error(`${label}: no table rules found`);
  const colXs = cluster(vl.map((l) => l.x));
  const left = colXs[0];
  const right = colXs[colXs.length - 1];
  // 全幅の罫線 = 表の上端＋本文の行境界（見出し行・会派・氏名の区切りは全幅ではない）
  const full = cluster(hl.filter((l) => l.x0 <= left + 2 && l.x1 >= right - 2).map((l) => l.y)).sort((a, b) => b - a);
  if (full.length < 3) throw new Error(`${label}: too few full-width rules (${full.length})`);
  const top = full[0];
  const bodyTop = full[1];
  const rowLines = full.slice(1);
  const bottom = full[full.length - 1];
  // 会派見出しの下の罫線: 表決エリアだけに引かれた線（全幅ではない）で、top と bodyTop の間にあるもの
  const seg = cluster(hl.filter((l) => l.y < top - EPS && l.y > bodyTop + EPS).map((l) => l.y));
  if (seg.length !== 1) throw new Error(`${label}: expected one group-bottom rule between top and body, got ${seg.length}`);
  const groupBottom = seg[0];
  if (colXs.length < LEFT_HEADERS.length + 2) throw new Error(`${label}: too few column rules (${colXs.length})`);
  const leftCols = colXs.slice(0, LEFT_HEADERS.length + 1);
  const voteCols = colXs.slice(LEFT_HEADERS.length);
  // 表決エリアの左端は会派の結合セルの境界（表の上端まで届く縦線）でもある
  const groupXs = cluster(vl.filter((l) => l.y1 >= top - EPS).map((l) => l.x));
  const voteStart = voteCols[0];
  if (!groupXs.some((x) => Math.abs(x - voteStart) <= EPS)) throw new Error(`${label}: vote area does not start at a group boundary (${voteStart.toFixed(1)})`);
  const groupCols = groupXs.filter((x) => x >= voteStart - EPS);
  if (groupCols.length < 2) throw new Error(`${label}: no group boundaries found`);
  return { top, bodyTop, bottom, groupBottom, leftCols, voteCols, groupCols, rowLines };
}

/* ---------- members ---------- */

/**
 * **縦書きの見出しを読む。列を右から左へ、各列を上から下へ**（Issue #901）。
 *
 * ## 何が問題だったか
 *
 * **会派見出しは結合セルで、名前が長いと縦書きが 2 列に折り返す。**
 * **日本語の縦書きは右の列から読む**が、直す前は
 * **`(b.y - a.y || a.x - b.x)`（上から下 → 同じ高さなら左から右）** で並べていた。
 * **1 列に収まる見出しでは同じ結果になる**ので、**`--sessions 2` の 13 本では 1 件も出ない。**
 * **2 列に折り返すと、左右の列が 1 文字ずつ交互に混ざる。**
 *
 * **実測（2026-09-20、index の賛否 PDF 151 本すべて。母数＝読めた 87 本 / 見出しの原文 21 種）:**
 *
 * | 出ていた原文 | 本数 | 正しい原文 |
 * |---|---:|---|
 * | `運草動のい根が` | 36 | **`草の根運動いが`** |
 * | `運草動のみ根え` | 12 | **`草の根運動みえ`** |
 * | `運※動草いのが根` | 1 | 同じ会派（`※` 付き） |
 * | `※み1ん新なしのい党翼` | 1 | `新しい翼`（`※` 付き） |
 *
 * **同じ会派が、本によって 2 通りの文字列で出ていた**——
 * **`草の根運動いが` は 2 本では正しく（1 列に収まった本）、36 本では崩れて出ていた。**
 *
 * **これは「記録が出ない」ではなく「別の文字列が出る」側である**（#569）。
 * **利用者から会派名の誤りは検出できない。**
 *
 * ## どう読むか
 *
 * **x でクラスタに分け、クラスタを降順（右 → 左）に、各クラスタを y の降順（上 → 下）に読む。**
 * **クラスタ幅は文字の高さ `h` の半分**——**同じ列の文字は x がほぼ揃い、隣の列とは 1 文字ぶん離れる**
 * （実測: `001086178.pdf` の `草の根運動いが` は x = 1116.7 と 1123.7 で、差 7.0pt ＝ 文字 1 つぶん）。
 *
 * **1 列の見出しではクラスタが 1 つなので、今までと 1 バイトも変わらない**
 * （**読めた 87 本の見出しのうち、クラスタが 2 つ以上なのは上の 4 種だけ**）。
 *
 * **推定はしない**——**文字を足しも引きもせず、並べ替えるだけである。**
 * **`joinVertical` は使えない**（あれも y を先に見るので、2 列だと同じように混ざる）。
 */
export function readVerticalHeading(chars: readonly Item[]): string {
  if (chars.length === 0) return "";
  // **列の幅は文字の高さの半分**（同じ列の x の揺れより広く、隣の列との間隔より狭い）
  const w = Math.max(...chars.map((c) => c.h), 1) / 2;
  const xs = cluster(chars.map((c) => c.x), w).sort((a, b) => b - a); // **右から左へ**
  let out = "";
  for (const cx of xs) {
    const col = chars.filter((c) => Math.abs(c.x - cx) <= w).sort((a, b) => b.y - a.y); // **上から下へ**
    out += col.map((c) => c.str).join("");
  }
  return out.replace(/[\s　]+/g, "");
}

function readMembers(page: PageGeometry, grid: Grid, pageNo: number): VotePdfMember[] {
  const label = `page ${pageNo}`;
  // 左 8 列の見出し（bodyTop〜top の結合セル）が期待どおりか（レイアウト変化の検出）
  for (let c = 0; c < LEFT_HEADERS.length; c++) {
    const chars = page.items.filter((i) => within(i.cx, grid.leftCols[c], grid.leftCols[c + 1]) && within(i.cy, grid.bodyTop, grid.top));
    const text = chars.sort(byRowThenColumn).map((i) => i.str).join("").replace(/[\s　]+/g, "");
    if (text !== LEFT_HEADERS[c]) throw new Error(`${label}: column ${c} header "${text}" !== ${LEFT_HEADERS[c]}`);
  }
  // 会派見出し（結合セル。正式名称がそのまま載る。凡例は無い）
  const groups: { x0: number; x1: number; name: string }[] = [];
  for (let g = 0; g + 1 < grid.groupCols.length; g++) {
    const x0 = grid.groupCols[g];
    const x1 = grid.groupCols[g + 1];
    const chars = page.items.filter((i) => within(i.cx, x0, x1) && within(i.cy, grid.groupBottom, grid.top));
    const name = readVerticalHeading(chars);
    if (name === "") throw new Error(`${label}: group heading between ${x0.toFixed(1)} and ${x1.toFixed(1)} is empty`);
    groups.push({ x0, x1, name });
  }
  const members: VotePdfMember[] = [];
  for (let c = 0; c + 1 < grid.voteCols.length; c++) {
    const x0 = grid.voteCols[c];
    const x1 = grid.voteCols[c + 1];
    const chars = page.items.filter((i) => within(i.cx, x0, x1) && within(i.cy, grid.bodyTop, grid.groupBottom));
    if (chars.length === 0) throw new Error(`${label}: member column ${c} has no name`);
    const nameText = joinVertical(chars);
    const mid = (x0 + x1) / 2;
    const group = groups.find((g) => within(mid, g.x0, g.x1));
    if (!group) throw new Error(`${label}: member column "${nameText}" is not under any group heading`);
    members.push({ nameText, group: group.name });
  }
  return members;
}

/* ---------- rows ---------- */

function readRows(page: PageGeometry, grid: Grid, pageNo: number, memberCount: number): VotePdfRow[] {
  const label = `page ${pageNo}`;
  const body = page.items.filter((i) => within(i.cy, grid.bottom, grid.bodyTop));
  const rows: VotePdfRow[] = [];
  for (let r = 0; r + 1 < grid.rowLines.length; r++) {
    const y1 = grid.rowLines[r];
    const y0 = grid.rowLines[r + 1];
    const inRow = body.filter((i) => within(i.cy, y0, y1));
    if (inRow.length === 0) continue; // 空の行（余白）
    const cellText = (c: number) => {
      const chars = inRow.filter((i) => within(i.cx, grid.leftCols[c], grid.leftCols[c + 1]));
      return chars.sort(byRowThenColumn).map((i) => i.str).join("").replace(/[\s　]+/g, "");
    };
    const numberCell = cellText(0);
    const title = cellText(1);
    const dateText = cellText(2).normalize("NFKC");
    const nums = [3, 4, 5, 6].map(cellText).map((n) => n.normalize("NFKC"));
    const result = cellText(7);
    const rowLabel = `${label} row ${r + 1} (${numberCell} ${title})`;
    if (title === "" || dateText === "" || result === "") throw new Error(`${rowLabel}: incomplete row (title/date/result)`);
    const nm = numberCell.match(NUMBER_CELL);
    if (!nm) throw new Error(`${rowLabel}: 議案等番号 "${numberCell}" is not {種別}第N号`);
    if (!/^\d{1,2}\/\d{1,2}$/.test(dateText)) throw new Error(`${rowLabel}: date "${dateText}" is not M/D`);
    if (nums.some((n) => !/^\d+$/.test(n))) throw new Error(`${rowLabel}: counts "${nums.join(",")}" are not numbers`);
    // 表決のセル: 各議員の列に、この行の文字がちょうど 1 つ入るときだけ採用（境界上・空・複数は UNKNOWN_CELL）
    const cells: string[] = new Array(memberCount).fill(UNKNOWN_CELL);
    const hits: Item[][] = Array.from({ length: memberCount }, () => []);
    const unplaced: Item[] = [];
    for (const it of inRow) {
      if (it.cx <= grid.voteCols[0]) continue;
      if (!within(it.cy, y0 + EDGE, y1 - EDGE)) { unplaced.push(it); continue; }
      const c = bandIndex(grid.voteCols, it.cx);
      if (c === undefined) unplaced.push(it);
      else hits[c].push(it);
    }
    for (let c = 0; c < memberCount; c++) {
      if (hits[c].length === 1 && [...hits[c][0].str].length === 1) cells[c] = hits[c][0].str;
    }
    // 境界上の文字: 隣り合う列のどちらか分からないので両方を不明にする
    for (const it of unplaced) {
      for (let c = 0; c < memberCount; c++) {
        if (it.cx >= grid.voteCols[c] - EDGE && it.cx <= grid.voteCols[c + 1] + EDGE) cells[c] = UNKNOWN_CELL;
      }
    }
    rows.push({
      page: pageNo,
      kind: nm[1],
      // **3 つの枝のうち当たった 1 つ**（`第N号` / `第N案` / `N号`）。**原文のまま**（#901）
      number: nm[2] ?? nm[3] ?? nm[4],
      title,
      dateText,
      counts: { present: Number(nums[0]), voting: Number(nums[1]), yes: Number(nums[2]), no: Number(nums[3]) },
      result,
      cells,
    });
  }
  return rows;
}
