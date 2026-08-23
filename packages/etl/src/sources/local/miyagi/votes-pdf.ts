import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * 宮城県議会「各議員の表決状況」PDF の表復元（Issue #157）。
 *
 * レイアウト（A4 横、1 ページに議案 20〜25 行）:
 *   見出し行: 「各議員の表決状況」「第398回宮城県議会（令和7年11月定例会）」、凡例（＜会派名＞ 略称：正式名称 / ＜表決方法＞ 簡易・起立 / ＜賛否欄＞ ○×議欠－除棄白）
 *   表: 左 10 列（議案等番号＝種別＋番号・件名・議決月日・出席者数・表決者数・賛成者数・反対者数・表決方法・議決結果）＋ 議員の列（1 人 1 列）。
 *       議員の列は上段に会派（結合セル）、その下に縦書きの氏名（1 文字 1 テキスト）。本文のセルは凡例の 1 文字。
 *
 * 方針: 文字の位置を推定で並べ替えない。罫線（PDF に細い矩形として描かれている）から列と行の境界を取り、
 * 各テキストの中心がどのセルに入るかだけで置く。1 セルに 1 文字が入らなければ（空・2 つ以上・境界上）そのセルは UNKNOWN_CELL。
 * 凡例に無い値が出たら例外（丸めない）。ページごとの議員の並びが違えば例外。
 */
export const UNKNOWN_CELL = "不明";
export const UNKNOWN_LEGEND = "抽出不能";

export interface VotePdfLegend {
  /** セルの値 → 凡例の意味（「○」→「賛成」） */
  votes: Record<string, string>;
  /** 表決方法 → 凡例の意味（「簡易」→「簡易表決(異議の有無を諮る)」） */
  methods: Record<string, string>;
  /** 会派略称 → 正式名称（「自民」→「自由民主党・県民会議」） */
  groups: Record<string, string>;
}

export interface VotePdfMember {
  /** 縦書きの氏名を上から並べたもの。空きマスは半角空白 1 つ（例「柚木 貴光」。5 文字で埋まる「さとう道昭」には入らない） */
  nameText: string;
  /** 会派見出しの原文（略称。「21世紀ｸ」は NFKC で「21世紀ク」） */
  groupText: string;
  /** 凡例で引いた正式名称 */
  group: string;
}

export interface VotePdfRow {
  page: number;
  kind: string;
  number: string;
  title: string;
  /** 議決月日の原文（「12/17」） */
  dateText: string;
  counts: { present: number; voting: number; yes: number; no: number };
  methodText: string;
  result: string;
  /** members と同じ順。置けなかったセルは UNKNOWN_CELL */
  cells: string[];
}

export interface VotePdf {
  sessionLabel: string;
  sessionId: string;
  /** 見出しの和暦（令和N年）を西暦にしたもの */
  sessionYear: number;
  /** 見出しの「M月定例会」の月 */
  sessionMonth: number;
  legend: VotePdfLegend;
  members: VotePdfMember[];
  rows: VotePdfRow[];
  unknownCells: number;
}

interface Item { str: string; x: number; y: number; w: number; h: number; cx: number; cy: number }
interface VLine { x: number; y0: number; y1: number }
interface HLine { y: number; x0: number; x1: number }
interface PageGeometry { items: Item[]; vlines: VLine[]; hlines: HLine[] }

const LEFT_HEADERS = [/議案等番/, /号/, /件名/, /議決月日/, /出席者数/, /表決者数/, /賛成者数/, /反対者数/, /表決方法/, /議決結果/];
const SESSION_LABEL = /^第(\d+)回宮城県議会（(令和|平成)(\d+)年(\d+)月(定例会|臨時会)）$/;
/** 境界からこの距離以内にある文字は「どちらのセルか分からない」として置かない。 */
const EDGE = 1.0;
const EPS = 1.5;

export async function parseVotePdf(bytes: Buffer): Promise<VotePdf> {
  const pages = await readPages(bytes);
  if (pages.length === 0) throw new Error("PDF has no pages");
  const head = parseHeader(pages[0].items);
  const legend = parseLegend(pages[0].items, head.tableTop);
  let members: VotePdfMember[] | undefined;
  const rows: VotePdfRow[] = [];
  let unknownCells = 0;
  for (let p = 0; p < pages.length; p++) {
    const page = pages[p];
    const pageHead = parseHeader(page.items);
    if (pageHead.sessionLabel !== head.sessionLabel) throw new Error(`page ${p + 1}: session label ${pageHead.sessionLabel} !== ${head.sessionLabel}`);
    const grid = buildGrid(page, pageHead.tableTop, p + 1);
    const pageMembers = readMembers(page, grid, legend, p + 1);
    if (!members) members = pageMembers;
    else if (JSON.stringify(members) !== JSON.stringify(pageMembers)) throw new Error(`page ${p + 1}: member columns differ from page 1`);
    const pageRows = readRows(page, grid, p + 1, members.length);
    for (const row of pageRows) {
      checkCellsAgainstLegend(row.cells, legend.votes, `page ${row.page} ${row.kind} ${row.number}`);
      unknownCells += row.cells.filter((c) => c === UNKNOWN_CELL).length;
    }
    rows.push(...pageRows);
  }
  if (!members || members.length === 0) throw new Error("no member columns found");
  if (rows.length === 0) throw new Error("no rows found");
  return { ...head, legend, members, rows, unknownCells };
}

/** 凡例に無い値が出たら例外（丸めない・推定しない）。UNKNOWN_CELL だけは通す。 */
export function checkCellsAgainstLegend(cells: readonly string[], votes: Record<string, string>, label: string): void {
  for (const c of cells) {
    if (c === UNKNOWN_CELL) continue;
    if (!(c in votes)) throw new Error(`${label}: cell value "${c}" is not in the legend (${Object.keys(votes).join("")})`);
  }
}

/* ---------- pdfjs ---------- */

async function readPages(bytes: Buffer): Promise<PageGeometry[]> {
  const loadingTask = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const doc = await loadingTask.promise;
  const out: PageGeometry[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const items: Item[] = [];
      for (const it of content.items) {
        if (!("str" in it)) continue;
        const str = it.str.replace(/[-]/g, "〓");
        if (str.trim() === "") continue;
        const x = it.transform[4];
        const y = it.transform[5];
        items.push({ str, x, y, w: it.width, h: it.height, cx: x + it.width / 2, cy: y + it.height / 2 });
      }
      const ops = await page.getOperatorList();
      const vlines: VLine[] = [];
      const hlines: HLine[] = [];
      for (let k = 0; k < ops.fnArray.length; k++) {
        if (ops.fnArray[k] !== OPS.constructPath) continue;
        const args = ops.argsArray[k] as unknown[];
        const minMax = args[2] as ArrayLike<number> | undefined;
        if (!minMax || minMax.length < 4) continue;
        const [x0, y0, x1, y1] = [minMax[0], minMax[1], minMax[2], minMax[3]];
        const w = x1 - x0;
        const h = y1 - y0;
        if (w < 2 && h > 5) vlines.push({ x: (x0 + x1) / 2, y0, y1 });
        else if (h < 2 && w > 5) hlines.push({ y: (y0 + y1) / 2, x0, x1 });
      }
      out.push({ items, vlines, hlines });
    }
  } finally {
    await loadingTask.destroy();
  }
  return out;
}

/* ---------- header & legend ---------- */

function parseHeader(items: Item[]): { sessionLabel: string; sessionId: string; sessionYear: number; sessionMonth: number; tableTop: number } {
  const label = items.find((i) => SESSION_LABEL.test(i.str));
  if (!label) throw new Error("session label (第N回宮城県議会（…）) not found in page header");
  const m = label.str.match(SESSION_LABEL)!;
  const year = m[2] === "令和" ? 2018 + Number(m[3]) : 1988 + Number(m[3]);
  // 表の上端 = 凡例の下（最初の凡例行より下で最も高い位置にある行見出し）。会派見出し・氏名・列見出しはこの下。
  const legendBottom = Math.min(...items.filter((i) => /^＜.+＞$/.test(i.str)).map((i) => i.y));
  if (!Number.isFinite(legendBottom)) throw new Error("legend headings (＜会派名＞ …) not found");
  return { sessionLabel: label.str, sessionId: m[1], sessionYear: year, sessionMonth: Number(m[4]), tableTop: legendBottom };
}

function parseLegend(items: Item[], tableTop: number): VotePdfLegend {
  const heads = items.filter((i) => /^＜.+＞$/.test(i.str)).sort((a, b) => a.x - b.x);
  const col = (name: string) => heads.find((h) => h.str === name);
  const groupsHead = col("＜会派名＞");
  const methodsHead = col("＜表決方法＞");
  const votesHead = col("＜賛否欄＞");
  if (!groupsHead || !methodsHead || !votesHead) throw new Error(`legend headings missing: ${heads.map((h) => h.str).join(" ")}`);
  const legend: VotePdfLegend = { votes: {}, methods: {}, groups: {} };
  // 凡例は見出し行より下、表（会派見出し）より上。表の上端は凡例の最下行の下にある最初の罫線より上なので、
  // ここでは「＜…＞ の y より下で、表の会派見出し（y が小さい）より上」を、凡例アイテムの形（「X：Y」）で拾う。
  const legendRows = items.filter((i) => i.y < tableTop && /^[^：]+：.+$/.test(i.str) && i.y > tableTop - 60);
  for (const it of legendRows) {
    const [key, ...rest] = it.str.split("：");
    const value = rest.join("：").replace(/[\s　]+/g, "");
    const target = it.x >= votesHead.x - 20 ? legend.votes : it.x >= methodsHead.x - 20 ? legend.methods : legend.groups;
    // 賛否の記号（－ など）は原文のまま。会派略称だけ NFKC（見出しの「21世紀ｸ」と合わせる）
    const k = (target === legend.groups ? key.normalize("NFKC") : key).replace(/[\s　]+/g, "");
    if (k in target) throw new Error(`legend key ${k} appears twice`);
    target[k] = value;
  }
  if (Object.keys(legend.votes).length === 0 || Object.keys(legend.methods).length === 0 || Object.keys(legend.groups).length === 0) {
    throw new Error(`legend incomplete: ${JSON.stringify(legend)}`);
  }
  return legend;
}

/* ---------- grid ---------- */

interface Grid {
  /** 表の上端・本文の上端（列見出し・氏名の下の罫線）・下端 */
  top: number;
  bodyTop: number;
  bottom: number;
  /** 左 10 列の境界（11 本）。[0] が表の左端 */
  leftCols: number[];
  /** 議員の列の境界（議員数＋1 本）。[0] が左 10 列の右端 */
  voteCols: number[];
  /** 会派の結合セルの境界（会派数＋1 本） */
  groupCols: number[];
  /** 会派見出しの下（氏名の上）の罫線 */
  groupBottom: number;
  /** 本文の行境界（上から下へ降順） */
  rowLines: number[];
  /** 種別（議案等番号の左側）の結合セルの境界（降順） */
  kindLines: number[];
}

function cluster(values: number[], eps = EPS): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (out.length && Math.abs(out[out.length - 1] - v) <= eps) out[out.length - 1] = (out[out.length - 1] + v) / 2;
    else out.push(v);
  }
  return out;
}

function buildGrid(page: PageGeometry, tableTop: number, pageNo: number): Grid {
  const label = `page ${pageNo}`;
  const vl = page.vlines.filter((l) => l.y1 <= tableTop + 2 && l.y1 - l.y0 > 20);
  const hl = page.hlines.filter((l) => l.y <= tableTop + 2);
  if (vl.length === 0 || hl.length === 0) throw new Error(`${label}: no table rules found`);
  const top = Math.max(...hl.map((l) => l.y));
  const bottom = Math.min(...hl.map((l) => l.y));
  const left = Math.min(...vl.map((l) => l.x));
  const right = Math.max(...vl.map((l) => l.x));
  // 会派見出しの下の罫線: 表の右側だけに引かれている（左 10 列の見出しは 1 段）。表の上端の次に高い、右端まで届く線。
  const wide = hl.filter((l) => l.x1 >= right - 2).map((l) => l.y);
  const groupBottom = cluster(wide).filter((y) => y < top - 2).sort((a, b) => b - a)[0];
  // 本文の上端: 表の全幅（左端から）に引かれた線のうち、表の上端の次に高いもの。
  const full = cluster(hl.filter((l) => l.x0 <= left + 2 && l.x1 >= right - 2).map((l) => l.y)).sort((a, b) => b - a);
  const bodyTop = full.find((y) => y < top - 2);
  if (groupBottom === undefined || bodyTop === undefined || groupBottom <= bodyTop) throw new Error(`${label}: header rules not found (top ${top}, groupBottom ${groupBottom}, bodyTop ${bodyTop})`);
  // 列境界: 本文まで届く縦線（氏名欄の下まで）。会派見出しまで届く縦線が会派の境界。
  const colXs = cluster(vl.filter((l) => l.y0 <= bodyTop + 2).map((l) => l.x));
  const groupXs = cluster(vl.filter((l) => l.y1 >= top - 2 && l.y0 <= bodyTop + 2).map((l) => l.x));
  // 左 10 列は「会派見出しの結合セルが始まる線」より左。会派の境界のうち、左から数えて 10 本目の列境界以降に最初に現れる線。
  if (colXs.length < 12) throw new Error(`${label}: too few column rules (${colXs.length})`);
  const voteStart = colXs[10];
  if (!groupXs.some((x) => Math.abs(x - voteStart) <= EPS)) throw new Error(`${label}: vote area does not start at a group boundary (col 10 at ${voteStart.toFixed(1)}, group rules ${groupXs.map((x) => x.toFixed(1)).join(" ")})`);
  const leftCols = colXs.slice(0, 11);
  const voteCols = colXs.slice(10);
  const groupCols = groupXs.filter((x) => x >= voteStart - EPS);
  // 行境界: 件名列（leftCols[2]..[3]）を横切る線。本文の上端と下端を含む。
  const titleX = (leftCols[2] + leftCols[3]) / 2;
  const rowLines = cluster(hl.filter((l) => l.x0 <= titleX && l.x1 >= titleX && l.y <= bodyTop + 2).map((l) => l.y)).sort((a, b) => b - a);
  const kindX = (leftCols[0] + leftCols[1]) / 2;
  const kindLines = cluster(hl.filter((l) => l.x0 <= kindX && l.x1 >= kindX && l.y <= bodyTop + 2).map((l) => l.y)).sort((a, b) => b - a);
  if (rowLines.length < 2 || kindLines.length < 2) throw new Error(`${label}: row rules not found`);
  if (Math.abs(rowLines[0] - bodyTop) > EPS || Math.abs(rowLines[rowLines.length - 1] - bottom) > EPS) throw new Error(`${label}: body rows do not span the table`);
  return { top, bodyTop, bottom, leftCols, voteCols, groupCols, groupBottom, rowLines, kindLines };
}

/** 区間 [lo, hi] のどこに値があるか。境界の EDGE 以内なら undefined（置かない）。 */
function bandIndex(bounds: number[], v: number): number | undefined {
  for (let i = 0; i + 1 < bounds.length; i++) {
    const lo = Math.min(bounds[i], bounds[i + 1]);
    const hi = Math.max(bounds[i], bounds[i + 1]);
    if (v > lo + EDGE && v < hi - EDGE) return i;
  }
  return undefined;
}

const within = (v: number, lo: number, hi: number) => v > Math.min(lo, hi) && v < Math.max(lo, hi);

/** 縦書きの文字列を上から順に結合。1 文字ぶん以上空いていれば半角空白 1 つ（連続する空きは 1 つに）。 */
function joinVertical(chars: Item[]): string {
  const sorted = [...chars].sort((a, b) => b.y - a.y || a.x - b.x);
  let out = "";
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0) {
      const gap = sorted[i - 1].y - sorted[i].y;
      const step = Math.max(sorted[i].h, sorted[i - 1].h, 1);
      if (gap > step * 1.5) out += " ";
    }
    out += sorted[i].str;
  }
  return out.trim();
}

/* ---------- members ---------- */

function readMembers(page: PageGeometry, grid: Grid, legend: VotePdfLegend, pageNo: number): VotePdfMember[] {
  const label = `page ${pageNo}`;
  // 会派見出し（結合セル）: 会派境界ごとに、会派行（groupBottom〜top）の文字を集める。
  const groups: { x0: number; x1: number; text: string; name: string }[] = [];
  for (let g = 0; g + 1 < grid.groupCols.length; g++) {
    const x0 = grid.groupCols[g];
    const x1 = grid.groupCols[g + 1];
    const chars = page.items.filter((i) => within(i.cx, x0, x1) && within(i.cy, grid.groupBottom, grid.top));
    const text = chars.sort((a, b) => b.y - a.y || a.x - b.x).map((c) => c.str).join("").replace(/[\s　]+/g, "").normalize("NFKC");
    const name = legend.groups[text];
    if (!name) throw new Error(`${label}: group heading "${text}" is not in the legend (${Object.keys(legend.groups).join(" / ")})`);
    groups.push({ x0, x1, text, name });
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
    members.push({ nameText, groupText: group.text, group: group.name });
  }
  // 左 10 列の見出しが期待どおりか（レイアウト変化の検出）
  for (let c = 0; c < 10; c++) {
    const chars = page.items.filter((i) => within(i.cx, grid.leftCols[c], grid.leftCols[c + 1]) && within(i.cy, grid.bodyTop, grid.top));
    const text = chars.sort((a, b) => b.y - a.y || a.x - b.x).map((i) => i.str).join("");
    if (!LEFT_HEADERS[c].test(text)) throw new Error(`${label}: column ${c} header "${text}" does not match ${LEFT_HEADERS[c]}`);
  }
  return members;
}

/* ---------- rows ---------- */

function readRows(page: PageGeometry, grid: Grid, pageNo: number, memberCount: number): VotePdfRow[] {
  const label = `page ${pageNo}`;
  const body = page.items.filter((i) => within(i.cy, grid.bottom, grid.bodyTop));
  // 種別（結合セル）の文字列をセルごとに
  const kinds: { y0: number; y1: number; text: string }[] = [];
  for (let k = 0; k + 1 < grid.kindLines.length; k++) {
    const y1 = grid.kindLines[k];
    const y0 = grid.kindLines[k + 1];
    // 種別は縦書き 1 文字ずつのことも、横書き 1 アイテム（「決議案」。番号列にはみ出す）のこともあるので、左端の x で列を決める
    const chars = body.filter((i) => within(i.x + 1, grid.leftCols[0], grid.leftCols[1]) && within(i.cy, y0, y1));
    kinds.push({ y0, y1, text: joinVertical(chars).replace(/\s+/g, "") });
  }
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
    const number = cellText(1);
    const title = cellText(2);
    const dateText = cellText(3);
    const nums = [4, 5, 6, 7].map(cellText);
    const methodText = cellText(8);
    const result = cellText(9);
    const rowLabel = `${label} row ${r + 1} (${number} ${title})`;
    // 番号は空のことがある（決議案）。他は必須
    if (title === "" || dateText === "" || methodText === "" || result === "") throw new Error(`${rowLabel}: incomplete row (title/date/method/result)`);
    if (!/^\d{1,2}\/\d{1,2}$/.test(dateText)) throw new Error(`${rowLabel}: date "${dateText}" is not M/D`);
    if (nums.some((n) => !/^\d+$/.test(n))) throw new Error(`${rowLabel}: counts "${nums.join(",")}" are not numbers`);
    const mid = (y0 + y1) / 2;
    const kind = kinds.find((k) => within(mid, k.y0, k.y1));
    if (!kind || kind.text === "") throw new Error(`${rowLabel}: 議案種別 not found`);
    // 表決のセル: 各議員の列に、この行の文字がちょうど 1 つ入るときだけ採用
    const cells: string[] = new Array(memberCount).fill(UNKNOWN_CELL);
    const hits: Item[][] = Array.from({ length: memberCount }, () => []);
    const unplaced: Item[] = [];
    for (const it of inRow) {
      if (it.cx <= grid.voteCols[0]) continue;
      // 行境界に近い文字も置かない
      if (!within(it.cy, y0 + EDGE, y1 - EDGE)) { unplaced.push(it); continue; }
      const c = bandIndex(grid.voteCols, it.cx);
      if (c === undefined) unplaced.push(it);
      else hits[c].push(it);
    }
    for (let c = 0; c < memberCount; c++) {
      if (hits[c].length === 1 && hits[c][0].str.length === 1) cells[c] = hits[c][0].str;
    }
    // 境界上の文字: 隣り合う列のどちらか分からないので両方を不明にする
    for (const it of unplaced) {
      for (let c = 0; c < memberCount; c++) {
        if (it.cx >= grid.voteCols[c] - EDGE && it.cx <= grid.voteCols[c + 1] + EDGE) cells[c] = UNKNOWN_CELL;
      }
    }
    rows.push({
      page: pageNo,
      kind: kind.text,
      number,
      title,
      dateText,
      counts: { present: Number(nums[0]), voting: Number(nums[1]), yes: Number(nums[2]), no: Number(nums[3]) },
      methodText,
      result,
      cells,
    });
  }
  return rows;
}
