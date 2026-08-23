import { bandIndex, cluster, EDGE, EPS, readPages, within, type Item, type PageGeometry, type VLine } from "../pdf-table.ts";
import { toIsoDate } from "./site.ts";

/**
 * 鳥取県議会「議決結果（令和N年M月D日議決分）」PDF の表復元（Issue #184）。
 *
 * レイアウト（A4 横）:
 *   1 ページ目の見出し: 「令和8年6月定例会」「議決結果（令和8年6月29日議決分）」（議決日は PDF 全体で 1 つ）
 *   表: 左 2 列（議案等番号＝種別（縦書き「知事提案」「議員提案」「陳情」「請願」）＋番号（「第１号」「7年－11」）、件名）、
 *       議員の列（上段に会派の結合セル「自由民主党」…、その下に縦書き「入江議員」。同姓は「浜田一議員」のように名の 1 文字付き）、
 *       右 5 列（賛成者数・反対者数・表決者数・議決結果・表決方法）。
 *       節見出しの行（「【議案】 … 議案に対する賛否」「【請願・陳情】 委員長報告 … 委員長報告に対する賛否」）が節の先頭にある。
 *       請願・陳情の節では 件名 と議員の列の間に「委員長報告」の列が入る（賛否は委員長報告に対するもの）。
 *   凡例: 表の最終ページの表の下「【凡例】 賛否欄 「○」賛成 「×」反対 「議」議長 …」。表決方法の凡例は無い。
 *   凡例より後ろに「別紙」（陳情の本文）のページが付くことがある。表ではないので読まない（trailingPages に数える）。
 *
 * 方針（宮城と同じ）: 文字の位置を推定で並べ替えない。罫線（細い矩形）から列と行の境界を取り、各テキストの中心が入るセルにだけ置く。
 * 1 セルに 1 文字が入らなければ UNKNOWN_CELL。凡例に無い値が出たら例外。ページごとの議員の並びが違えば例外。
 * 件名は「件名」列の左端に揃った行だけ（陳情の本文の引用は 1 文字分インデントされているので含めない）。
 * 長い陳情の行がページをまたぐと、次のページの先頭に本文の続きだけの行（番号・件名・賛否が無い）が入り、表の上端より上（罫線の外）に
 * 同じ番号の行が繰り返されることがある（陳情だけの PDF の 2 ページ目）。罫線の外の文字は置けないので読まず、本文だけの行は行として数えない。
 * 同じ番号の行が 2 回出た場合は、ここでは消さず呼び出し側（rollcalls.ts）が内容の一致を確かめて 1 件にする。
 */
export const UNKNOWN_CELL = "不明";
export const UNKNOWN_LEGEND = "抽出不能";

export interface VotePdfLegend {
  /** セルの値 → 凡例の意味（「○」→「賛成」） */
  votes: Record<string, string>;
}

export interface VotePdfMember {
  /** 縦書きの原文（「入江議員」「浜田一議員」） */
  nameText: string;
  /** 会派見出しの原文（「自由民主党」） */
  group: string;
}

export interface VotePdfRow {
  page: number;
  /** 種別の原文（「知事提案」「議員提案」「陳情」「請願」） */
  kind: string;
  /** 番号（NFKC。「第1号」「7年-11」） */
  number: string;
  /** 件名の原文（列の左端に揃った行を上から結合）。繰り返しの行では空 */
  title: string;
  /** 節見出しの行にある賛否の対象の原文（「議案に対する賛否」「委員長報告に対する賛否」）。節見出しの無い PDF（議員提出議案だけの版）では省略 */
  voteSubject?: string;
  /** 委員長報告の列の原文（請願・陳情の節だけ） */
  committeeReport?: string;
  counts: { yes: number; no: number; voting: number };
  methodText: string;
  result: string;
  /** members と同じ順。置けなかったセルは UNKNOWN_CELL */
  cells: string[];
}

export interface VotePdf {
  /** 「令和8年6月定例会」 */
  sessionLabel: string;
  /** 議決日（ISO） */
  date: string;
  legend: VotePdfLegend;
  members: VotePdfMember[];
  rows: VotePdfRow[];
  unknownCells: number;
  /** 凡例より後のページ（陳情の「別紙」など、表ではないページ）の数。読まない */
  trailingPages: number;
}

const SESSION_LABEL = /^(令和|平成)(\d+|元)年\d{1,2}月(定例会|臨時会)$/;
const DATE_HEADING = /^議決結果（(.+)議決分）$/;
/** 件名の見出しセルには、前ページから続く陳情の本文がはみ出して入ることがある（陳情だけの PDF の 2 ページ目）ので前方一致 */
const LEFT_HEADERS = [/^議案等番号$/, /^件名/];
const RIGHT_HEADERS = [/^賛成者数$/, /^反対者数$/, /^表決者数$/, /^議決結果$/, /^表決方法$/];
/** 種別（縦書き）は列の左端に寄っている。件名はセルの左端（罫線から 4pt 以内）に揃う。 */
const KIND_INDENT = 8;
const TITLE_INDENT = 4;

export async function parseVotePdf(bytes: Buffer): Promise<VotePdf> {
  const pages = await readPages(bytes);
  if (pages.length === 0) throw new Error("PDF has no pages");
  const head = parseHeader(pages[0]);
  let legend: VotePdfLegend | undefined;
  let members: VotePdfMember[] | undefined;
  const rows: VotePdfRow[] = [];
  let subject: string | undefined;
  let trailingPages = 0;
  for (let p = 0; p < pages.length; p++) {
    const page = pages[p];
    if (legend) { trailingPages++; continue; } // 凡例の後ろは表ではない（「別紙」の陳情文など）
    const grid = buildGrid(page, p + 1);
    const pageMembers = readMembers(page, grid, p + 1);
    if (!members) members = pageMembers;
    else if (JSON.stringify(members) !== JSON.stringify(pageMembers)) throw new Error(`page ${p + 1}: member columns differ from page 1`);
    const read = readRows(page, grid, p + 1, members.length, subject);
    subject = read.subject;
    rows.push(...read.rows);
    const pageLegend = parseLegend(page, grid.bottom);
    if (pageLegend) {
      if (legend) throw new Error(`page ${p + 1}: legend appears twice`);
      legend = pageLegend;
    }
  }
  if (!members || members.length === 0) throw new Error("no member columns found");
  if (rows.length === 0) throw new Error("no rows found");
  if (!legend) throw new Error("legend (【凡例】 賛否欄) not found");
  let unknownCells = 0;
  for (const row of rows) {
    checkCellsAgainstLegend(row.cells, legend.votes, `page ${row.page} ${row.kind} ${row.number}`);
    unknownCells += row.cells.filter((c) => c === UNKNOWN_CELL).length;
  }
  return { ...head, legend, members, rows, unknownCells, trailingPages };
}

/** 凡例に無い値が出たら例外（丸めない・推定しない）。UNKNOWN_CELL だけは通す。 */
export function checkCellsAgainstLegend(cells: readonly string[], votes: Record<string, string>, label: string): void {
  for (const c of cells) {
    if (c === UNKNOWN_CELL) continue;
    if (!(c in votes)) throw new Error(`${label}: cell value "${c}" is not in the legend (${Object.keys(votes).join("")})`);
  }
}

/* ---------- header & legend ---------- */

function parseHeader(page: PageGeometry): { sessionLabel: string; date: string } {
  const label = page.items.find((i) => SESSION_LABEL.test(i.str.normalize("NFKC").replace(/\s+/g, "")));
  if (!label) throw new Error("session label (令和N年M月定例会) not found in page 1 header");
  const dated = page.items.find((i) => DATE_HEADING.test(i.str.replace(/\s+/g, "")));
  if (!dated) throw new Error("議決結果（…議決分） not found in page 1 header");
  const date = toIsoDate(dated.str.replace(/\s+/g, "").match(DATE_HEADING)![1]);
  if (!date) throw new Error(`cannot read 議決日 from ${dated.str}`);
  return { sessionLabel: label.str.normalize("NFKC").replace(/\s+/g, ""), date };
}

/** 表の下の「【凡例】」ブロック。「「○」賛成」の形の項目を集める。このページに無ければ undefined。 */
function parseLegend(page: PageGeometry, bottom: number): VotePdfLegend | undefined {
  const below = page.items.filter((i) => i.cy < bottom);
  if (!below.some((i) => i.str.replace(/\s+/g, "") === "【凡例】")) return undefined;
  const votes: Record<string, string> = {};
  for (const it of below) {
    const m = it.str.trim().match(/^「(.)」(.+)$/);
    if (!m) continue;
    if (m[1] in votes) throw new Error(`legend key ${m[1]} appears twice`);
    votes[m[1]] = m[2].trim();
  }
  if (Object.keys(votes).length === 0) throw new Error("legend block has no 「X」… entries");
  return { votes };
}

/* ---------- grid ---------- */

interface Grid {
  top: number;
  groupBottom: number;
  bodyTop: number;
  bottom: number;
  /** 左端から賛否欄の左端までの列境界（[議案等番号 | 件名 |]） */
  leftCols: number[];
  /** 議員の列境界（議員数＋1 本） */
  voteCols: number[];
  /** 会派の結合セル */
  groups: { x0: number; x1: number; name: string }[];
  /** 賛否欄の右端からの列境界（賛成者数・反対者数・表決者数・議決結果・表決方法） */
  rightCols: number[];
  /** 本文の行境界（降順。[0] は bodyTop、最後は bottom。ページの下端で切れる行があれば最後は縦線の下端） */
  rowLines: number[];
  /** 本文の縦線（件名と議員の間の「委員長報告」列の検出に使う） */
  bodyVlines: VLine[];
}

function buildGrid(page: PageGeometry, pageNo: number): Grid {
  const label = `page ${pageNo}`;
  if (page.vlines.length === 0 || page.hlines.length === 0) throw new Error(`${label}: no table rules found`);
  const left = Math.min(...page.vlines.map((l) => l.x));
  const right = Math.max(...page.vlines.map((l) => l.x));
  // 同じ y の線分をまとめ、表の全幅（左端〜右端）を覆う y を「横罫線」とする。凡例の枠線は全幅でないので入らない
  const ys = cluster(page.hlines.map((l) => l.y));
  const extent = ys.map((y) => {
    const segs = page.hlines.filter((l) => Math.abs(l.y - y) <= EPS);
    return { y, x0: Math.min(...segs.map((s) => s.x0)), x1: Math.max(...segs.map((s) => s.x1)) };
  });
  const wide = extent.filter((e) => e.x0 <= left + 2 && e.x1 >= right - 2).map((e) => e.y).sort((a, b) => b - a);
  if (wide.length < 3) throw new Error(`${label}: too few full-width rules (${wide.length})`);
  const top = wide[0];
  const bodyTop = wide[1];
  const bottom = wide[wide.length - 1];
  const between = ys.filter((y) => y < top - 2 && y > bodyTop + 2).sort((a, b) => b - a);
  if (between.length === 0) throw new Error(`${label}: group heading rule (between table top ${top} and body top ${bodyTop}) not found`);
  const groupBottom = between[0];
  // 会派の結合セル: 表の上端から会派行の下まで届く縦線で区切られ、会派行に文字がある帯
  const groupXs = cluster(page.vlines.filter((l) => l.y1 >= top - 2 && l.y0 <= groupBottom + 2).map((l) => l.x));
  const groups: Grid["groups"] = [];
  for (let g = 0; g + 1 < groupXs.length; g++) {
    const chars = page.items.filter((i) => within(i.cx, groupXs[g], groupXs[g + 1]) && within(i.cy, groupBottom, top));
    if (chars.length === 0) continue;
    const name = chars.sort((a, b) => b.y - a.y || a.x - b.x).map((c) => c.str).join("").replace(/[\s　]+/g, "");
    groups.push({ x0: groupXs[g], x1: groupXs[g + 1], name });
  }
  if (groups.length === 0) throw new Error(`${label}: no group headings found`);
  for (let g = 1; g < groups.length; g++) {
    if (Math.abs(groups[g].x0 - groups[g - 1].x1) > EPS) throw new Error(`${label}: group headings are not contiguous (${groups[g - 1].name} → ${groups[g].name})`);
  }
  const voteStart = groups[0].x0;
  const voteEnd = groups[groups.length - 1].x1;
  // 氏名の段（bodyTop〜groupBottom）を区切る縦線 = 列境界
  const colXs = cluster(page.vlines.filter((l) => l.y0 <= bodyTop + 2 && l.y1 >= groupBottom - 2).map((l) => l.x));
  const leftCols = colXs.filter((x) => x <= voteStart + EPS);
  const voteCols = colXs.filter((x) => x >= voteStart - EPS && x <= voteEnd + EPS);
  const rightCols = colXs.filter((x) => x >= voteEnd - EPS);
  if (leftCols.length !== LEFT_HEADERS.length + 1) throw new Error(`${label}: expected ${LEFT_HEADERS.length} columns left of the vote area, got ${leftCols.length - 1}`);
  if (rightCols.length !== RIGHT_HEADERS.length + 1) throw new Error(`${label}: expected ${RIGHT_HEADERS.length} columns right of the vote area, got ${rightCols.length - 1}`);
  if (voteCols.length < 3) throw new Error(`${label}: too few member columns (${voteCols.length - 1})`);
  // 行境界: 本文の全幅の横罫線（節見出しの行も含む）
  const rowLines = wide.filter((y) => y <= bodyTop + EPS);
  if (rowLines.length < 2) throw new Error(`${label}: row rules not found`);
  const bodyVlines = page.vlines.filter((l) => l.y1 <= bodyTop + 2);
  // ページの下端で切れる行（次のページに続く長い陳情）: 最後の横罫線より下に列の縦線が伸びていれば、その下端までを 1 行とする（罫線の外は置かない）
  const columnVlines = bodyVlines.filter((l) => l.y1 >= bottom - 2 && colXs.some((x) => Math.abs(x - l.x) <= EPS));
  const vBottom = Math.min(...columnVlines.map((l) => l.y0));
  let effectiveBottom = bottom;
  if (Number.isFinite(vBottom) && vBottom < bottom - 5) {
    rowLines.push(vBottom);
    effectiveBottom = vBottom;
  }
  return { top, groupBottom, bodyTop, bottom: effectiveBottom, leftCols, voteCols, groups, rightCols, rowLines, bodyVlines };
}

/** 文字を上から下・左から右に並べて結合（空白は除く）。 */
function joinText(chars: Item[]): string {
  return [...chars].sort((a, b) => b.y - a.y || a.x - b.x).map((c) => c.str).join("").replace(/[\s　]+/g, "");
}

/* ---------- members ---------- */

function readMembers(page: PageGeometry, grid: Grid, pageNo: number): VotePdfMember[] {
  const label = `page ${pageNo}`;
  const members: VotePdfMember[] = [];
  for (let c = 0; c + 1 < grid.voteCols.length; c++) {
    const x0 = grid.voteCols[c];
    const x1 = grid.voteCols[c + 1];
    const chars = page.items.filter((i) => within(i.cx, x0, x1) && within(i.cy, grid.bodyTop, grid.groupBottom));
    if (chars.length === 0) throw new Error(`${label}: member column ${c} has no name`);
    const nameText = joinText(chars);
    if (!/議員$/.test(nameText)) throw new Error(`${label}: member column "${nameText}" does not end with 議員`);
    const mid = (x0 + x1) / 2;
    const group = grid.groups.find((g) => within(mid, g.x0, g.x1));
    if (!group) throw new Error(`${label}: member column "${nameText}" is not under any group heading`);
    members.push({ nameText, group: group.name });
  }
  // 左右の列見出しが期待どおりか（レイアウト変化の検出）
  const check = (cols: number[], expected: RegExp[], side: string) => {
    for (let c = 0; c + 1 < cols.length; c++) {
      const chars = page.items.filter((i) => within(i.cx, cols[c], cols[c + 1]) && within(i.cy, grid.bodyTop, grid.top));
      const text = joinText(chars);
      if (!expected[c].test(text)) throw new Error(`${label}: ${side} column ${c} header "${text}" does not match ${expected[c]}`);
    }
  };
  check(grid.leftCols, LEFT_HEADERS, "left");
  check(grid.rightCols, RIGHT_HEADERS, "right");
  return members;
}

/* ---------- rows ---------- */

function readRows(page: PageGeometry, grid: Grid, pageNo: number, memberCount: number, subjectIn: string | undefined): { rows: VotePdfRow[]; subject: string | undefined } {
  const label = `page ${pageNo}`;
  const body = page.items.filter((i) => within(i.cy, grid.bottom, grid.bodyTop));
  const kindLeft = grid.leftCols[0];
  const kindRight = grid.leftCols[1];
  const titleLeft = grid.leftCols[1];
  const voteStart = grid.voteCols[0];
  const voteEnd = grid.voteCols[grid.voteCols.length - 1];
  let subject = subjectIn;
  const rows: VotePdfRow[] = [];
  for (let r = 0; r + 1 < grid.rowLines.length; r++) {
    const y1 = grid.rowLines[r];
    const y0 = grid.rowLines[r + 1];
    const inRow = body.filter((i) => within(i.cy, y0, y1));
    if (inRow.length === 0) continue; // 空の行（余白）
    const firstCol = inRow.filter((i) => within(i.cx, kindLeft, kindRight));
    // 件名の列にしか文字が無い行: 前ページから続く陳情の本文だけ（番号・賛否・結果が無い）。行として数えない
    if (inRow.every((i) => within(i.cx, titleLeft, voteStart) && i.x >= titleLeft + TITLE_INDENT)) continue;
    // 節見出しの行（「【議案】」）: 賛否の対象を読み、以後の行に付ける
    if (firstCol.some((i) => i.str.trim().startsWith("【"))) {
      const heading = joinText(firstCol);
      const subjectText = joinText(inRow.filter((i) => within(i.cx, voteStart, voteEnd)));
      if (subjectText === "") throw new Error(`${label}: section heading ${heading} has no 賛否の対象 text over the vote area`);
      subject = subjectText;
      continue;
    }
    const kind = joinText(firstCol.filter((i) => i.x < kindLeft + KIND_INDENT));
    const number = joinText(firstCol.filter((i) => i.x >= kindLeft + KIND_INDENT)).normalize("NFKC");
    const rowLabel = `${label} row ${r + 1} (${kind} ${number})`;
    // 件名と議員の間の縦線（委員長報告の列）
    const splits = cluster(grid.bodyVlines.filter((l) => l.x > titleLeft + 5 && l.x < voteStart - 5 && l.y0 <= y0 + 2 && l.y1 >= y1 - 2).map((l) => l.x));
    if (splits.length > 1) throw new Error(`${rowLabel}: unexpected columns between 件名 and the vote area (${splits.map((x) => x.toFixed(1)).join(" ")})`);
    const titleRight = splits[0] ?? voteStart;
    const titleItems = inRow.filter((i) => within(i.cx, titleLeft, titleRight));
    const title = [...titleItems.filter((i) => i.x < titleLeft + TITLE_INDENT)].sort((a, b) => b.y - a.y || a.x - b.x).map((i) => i.str.trim()).join("");
    const committeeReport = splits.length === 1 ? joinText(inRow.filter((i) => within(i.cx, titleRight, voteStart))) : undefined;
    const rightText = (c: number) => joinText(inRow.filter((i) => within(i.cx, grid.rightCols[c], grid.rightCols[c + 1])));
    const nums = [0, 1, 2].map(rightText);
    const result = rightText(3);
    const methodText = rightText(4);
    if (kind === "" || number === "" || methodText === "" || result === "") throw new Error(`${rowLabel}: incomplete row (kind/number/method/result)`);
    if (nums.some((n) => !/^\d+$/.test(n))) throw new Error(`${rowLabel}: counts "${nums.join(",")}" are not numbers`);
    if (splits.length === 1 && committeeReport === "") throw new Error(`${rowLabel}: 委員長報告 column is empty`);
    // 表決のセル: 各議員の列に、この行の文字がちょうど 1 つ入るときだけ採用
    const cells: string[] = new Array(memberCount).fill(UNKNOWN_CELL);
    const hits: Item[][] = Array.from({ length: memberCount }, () => []);
    const unplaced: Item[] = [];
    for (const it of inRow) {
      if (it.cx <= voteStart - EDGE || it.cx >= voteEnd + EDGE) continue;
      if (!within(it.cy, y0 + EDGE, y1 - EDGE)) { unplaced.push(it); continue; }
      const c = bandIndex(grid.voteCols, it.cx);
      if (c === undefined) unplaced.push(it);
      else hits[c].push(it);
    }
    for (let c = 0; c < memberCount; c++) {
      if (hits[c].length === 1 && hits[c][0].str.trim().length === 1) cells[c] = hits[c][0].str.trim();
    }
    // 境界上の文字: 隣り合う列のどちらか分からないので両方を不明にする
    for (const it of unplaced) {
      for (let c = 0; c < memberCount; c++) {
        if (it.cx >= grid.voteCols[c] - EDGE && it.cx <= grid.voteCols[c + 1] + EDGE) cells[c] = UNKNOWN_CELL;
      }
    }
    rows.push({
      page: pageNo,
      kind,
      number,
      title,
      ...(subject !== undefined ? { voteSubject: subject } : {}),
      ...(committeeReport !== undefined ? { committeeReport } : {}),
      counts: { yes: Number(nums[0]), no: Number(nums[1]), voting: Number(nums[2]) },
      methodText,
      result,
      cells,
    });
  }
  return { rows, subject };
}
