import { bandIndex, cluster, EDGE, EPS, joinVertical, within, type Item, type PageGeometry } from "../pdf-table.ts";
import { readGlyphPages } from "./glyphs.ts";
import { warekiYear } from "./site.ts";

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
const LEGEND_ITEM = /^(.)：(.+)$/;
// 賛成・反対の列見出しは 2 文字（「者数」は付かない）
const LEFT_HEADERS = ["議案等番号", "件名", "議決月日", "出席者数", "表決者数", "賛成", "反対", "議決結果"] as const;
const NUMBER_CELL = /^(.+?)(第[0-9０-９]+号)$/;

export async function parseVotePdf(bytes: Buffer): Promise<VotePdf> {
  const pages = await readGlyphPages(bytes);
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

/** 凡例に無い値が出たら例外（丸めない・推定しない）。UNKNOWN_CELL だけは通す。 */
export function checkCellsAgainstLegend(cells: readonly string[], legend: Record<string, string>, label: string): void {
  for (const c of cells) {
    if (c === UNKNOWN_CELL) continue;
    if (!(c in legend)) throw new Error(`${label}: cell value "${c}" is not in the legend (${Object.keys(legend).join("")})`);
  }
}

/* ---------- header & legend ---------- */

function parseHeader(items: Item[], pageNo: number): { title: string; sessionName: string; year: number; month: number; tableTop: number } {
  const label = items.find((i) => TITLE.test(i.str.trim()));
  if (!label) throw new Error(`page ${pageNo}: title (令和N年定例会（M月）) not found`);
  const m = label.str.trim().match(TITLE)!;
  const legendYs = items.filter((i) => LEGEND_ITEM.test(i.str)).map((i) => i.y);
  if (legendYs.length === 0) throw new Error(`page ${pageNo}: legend (○：賛成 …) not found`);
  // 表の上端 = 凡例行の下（buildGrid が罫線から取る。ここでは凡例の最下行を返す）
  return { title: m[0], sessionName: m[1], year: warekiYear(m[2], m[3]), month: Number(m[4].normalize("NFKC")), tableTop: Math.min(...legendYs) };
}

function parseLegend(items: Item[], tableTop: number, pageNo: number): Record<string, string> {
  const legend: Record<string, string> = {};
  for (const it of items) {
    if (it.y < tableTop - EPS) continue; // 表より下は凡例ではない
    const m = it.str.match(LEGEND_ITEM);
    if (!m) continue;
    if (m[1] in legend) throw new Error(`page ${pageNo}: legend key ${m[1]} appears twice`);
    legend[m[1]] = m[2].replace(/[\s　]+/g, "");
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

function readMembers(page: PageGeometry, grid: Grid, pageNo: number): VotePdfMember[] {
  const label = `page ${pageNo}`;
  // 左 8 列の見出し（bodyTop〜top の結合セル）が期待どおりか（レイアウト変化の検出）
  for (let c = 0; c < LEFT_HEADERS.length; c++) {
    const chars = page.items.filter((i) => within(i.cx, grid.leftCols[c], grid.leftCols[c + 1]) && within(i.cy, grid.bodyTop, grid.top));
    const text = chars.sort((a, b) => b.y - a.y || a.x - b.x).map((i) => i.str).join("").replace(/[\s　]+/g, "");
    if (text !== LEFT_HEADERS[c]) throw new Error(`${label}: column ${c} header "${text}" !== ${LEFT_HEADERS[c]}`);
  }
  // 会派見出し（結合セル。正式名称がそのまま載る。凡例は無い）
  const groups: { x0: number; x1: number; name: string }[] = [];
  for (let g = 0; g + 1 < grid.groupCols.length; g++) {
    const x0 = grid.groupCols[g];
    const x1 = grid.groupCols[g + 1];
    const chars = page.items.filter((i) => within(i.cx, x0, x1) && within(i.cy, grid.groupBottom, grid.top));
    const name = chars.sort((a, b) => b.y - a.y || a.x - b.x).map((c) => c.str).join("").replace(/[\s　]+/g, "");
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
      return chars.sort((a, b) => b.y - a.y || a.x - b.x).map((i) => i.str).join("").replace(/[\s　]+/g, "");
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
      number: nm[2],
      title,
      dateText,
      counts: { present: Number(nums[0]), voting: Number(nums[1]), yes: Number(nums[2]), no: Number(nums[3]) },
      result,
      cells,
    });
  }
  return rows;
}
