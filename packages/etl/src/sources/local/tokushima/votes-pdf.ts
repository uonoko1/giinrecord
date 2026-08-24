import { bandIndex, cluster, EDGE, EPS, joinVertical, readPages, within, type HLine, type Item, type PageGeometry, type VLine } from "../pdf-table.ts";
import { isoDate, warekiYear } from "./site.ts";

/**
 * 徳島県議会「各議員の表決態度」PDF の表復元（Issue #183）。
 *
 * レイアウト（A4 横）:
 *   表題「議案審査結果（令和８年７月３日）」（採決日。1 ページ目）
 *   節見出し「○ 知事提出議案」「○ 議員提出議案」「○ 請願」「○ 動議」… の下に表。表は 左 3 列（議案番号・案名・委員会審査結果）＋ 議員の列（1 人 1 列。上段に会派の結合セル、
 *   その下に縦書きの氏名 1 文字 1 テキスト）＋ 右 1 列（議決結果）。本文のセルは凡例の 1 文字（○／〇／●／議／退／欠／除）。
 *   節の表はページをまたぐ（続きのページには節見出しが無い）。節の最後の表の下に凡例（※「○」…した者、「議」議長、…／「●」〃 に起立しなかった者）。凡例は節ごとに違う。
 *   議案番号は結合セルのことがある（第１号の原案と修正案で 2 行）。番号の無い行（動議）もある。
 *
 * 方針（宮城と同じ）: 文字の位置を推定で並べ替えない。罫線から列と行の境界を取り、各テキストの中心がどのセルに入るかだけで置く。
 * 1 セルに 1 文字が入らなければ UNKNOWN_CELL。凡例に無い値が出たら例外（丸めない）。表ごとの議員の並びが違えば例外。
 */
export const UNKNOWN_CELL = "不明";
export const UNKNOWN_LEGEND = "抽出不能";

/** 凡例の記号と同じ意味の字形（見た目が同じ別コードポイント）。セルの原文は保ち、凡例を引くときだけ寄せる。 */
const GLYPH_VARIANTS: Record<string, string> = { "〇": "○" }; // U+3007 → U+25CB
export const legendKey = (raw: string): string => GLYPH_VARIANTS[raw] ?? raw;

export interface VotePdfMember {
  /** 縦書きの氏名を上から並べたもの。空きマスは半角空白 1 つ（例「嘉見 博之」。5 文字で埋まる「川真田琢巳」には入らない） */
  nameText: string;
  /** 会派の結合セルの原文（NFKC。「グローカルｐｌｕｓ」→「グローカルplus」） */
  group: string;
}

export interface VotePdfRow {
  page: number;
  /** 議案番号の原文（「第１号」）。無ければ "" */
  number: string;
  title: string;
  /** 委員会審査結果の原文（「可決」「－」「-」） */
  committeeResult: string;
  /** 議決結果の原文（「可決」「同意」「採択」「否決」…） */
  result: string;
  /** members と同じ順。置けなかったセルは UNKNOWN_CELL */
  cells: string[];
}

export interface VotePdfSection {
  /** 節見出しの原文（「知事提出議案」「議員提出議案」「請願」「動議」） */
  kind: string;
  /** セルの値 → 凡例の意味（「○」→「委員会審査結果又は議長宣告に起立（賛成）した者」） */
  legend: Record<string, string>;
  rows: VotePdfRow[];
}

export interface VotePdf {
  /** 表題の原文（「議案審査結果（令和８年７月３日）」） */
  title: string;
  /** 採決日（ISO） */
  date: string;
  members: VotePdfMember[];
  sections: VotePdfSection[];
  unknownCells: number;
}

/** NFKC 後に引く（全角括弧・全角数字は半角になる） */
const TITLE = /^議案審査結果\((令和|平成)(\d+|元)年(\d+)月(\d+)日\)$/;
const KIND_HEADING = /^○\s*(\S.*)$/;
const HEADERS = { number: /議案番号/, title: /案名/, committee: /委員会/, result: /議決結果/ };

export async function parseVotePdf(bytes: Buffer): Promise<VotePdf> {
  const pages = await readPages(bytes);
  if (pages.length === 0) throw new Error("PDF has no pages");
  const head = parseTitle(pages[0].items);
  const sections: VotePdfSection[] = [];
  const legends: (string[] | undefined)[] = [];
  let members: VotePdfMember[] | undefined;
  for (let p = 0; p < pages.length; p++) {
    const page = pages[p];
    const pageNo = p + 1;
    const tables = findTables(page, pageNo);
    const headings = page.items.filter((i) => i.h > 8 && KIND_HEADING.test(i.str));
    const legendLines = readLegendLines(page.items);
    for (let t = 0; t < tables.length; t++) {
      const tb = tables[t];
      const above = t === 0 ? Number.POSITIVE_INFINITY : tables[t - 1].bottom;
      const below = t + 1 < tables.length ? tables[t + 1].top : Number.NEGATIVE_INFINITY;
      const heading = headings.filter((h) => h.y > tb.top && h.y < above);
      if (heading.length > 1) throw new Error(`page ${pageNo} table ${t + 1}: ${heading.length} section headings above the table`);
      if (heading.length === 1) {
        sections.push({ kind: heading[0].str.match(KIND_HEADING)![1].trim(), legend: {}, rows: [] });
        legends.push(undefined);
      } else if (sections.length === 0) throw new Error(`page ${pageNo} table ${t + 1}: no section heading (○ …) above the first table`);
      const section = sections[sections.length - 1];
      if (legends[legends.length - 1]) throw new Error(`page ${pageNo} table ${t + 1}: table after the legend of section ${section.kind}`);
      const grid = buildGrid(tb, `page ${pageNo} table ${t + 1}`);
      const tableMembers = readMembers(page, grid, `page ${pageNo} table ${t + 1}`);
      if (!members) members = tableMembers;
      else if (JSON.stringify(members) !== JSON.stringify(tableMembers)) throw new Error(`page ${pageNo} table ${t + 1}: member columns differ from the first table`);
      section.rows.push(...readRows(page, grid, pageNo, members.length));
      const lines = legendLines.filter((l) => l.y < tb.bottom && l.y > below).map((l) => l.text);
      if (lines.length) legends[legends.length - 1] = lines;
    }
  }
  if (!members || members.length === 0) throw new Error("no member columns found");
  let unknownCells = 0;
  sections.forEach((s, i) => {
    const lines = legends[i];
    if (!lines) throw new Error(`section ${s.kind}: legend (※ 「○」…) not found below its table`);
    s.legend = parseLegendLines(lines);
    if (s.rows.length === 0) throw new Error(`section ${s.kind}: no rows`);
    for (const row of s.rows) {
      checkCellsAgainstLegend(row.cells, s.legend, `${s.kind} ${row.number || row.title}`);
      unknownCells += row.cells.filter((c) => c === UNKNOWN_CELL).length;
    }
  });
  return { ...head, members, sections, unknownCells };
}

/** 凡例に無い値が出たら例外（丸めない・推定しない）。UNKNOWN_CELL だけは通す。字形の揺れ（〇）は凡例の記号に寄せて引く。 */
export function checkCellsAgainstLegend(cells: readonly string[], legend: Record<string, string>, label: string): void {
  for (const c of cells) {
    if (c === UNKNOWN_CELL) continue;
    if (!(legendKey(c) in legend)) throw new Error(`${label}: cell value "${c}" is not in the legend (${Object.keys(legend).join("")})`);
  }
}

/* ---------- title & legend ---------- */

function parseTitle(items: Item[]): { title: string; date: string } {
  const hit = items.find((i) => i.h > 11 && TITLE.test(i.str.normalize("NFKC").replace(/\s+/g, "")));
  if (!hit) throw new Error("title (議案審査結果（令和N年M月D日）) not found on page 1");
  const m = hit.str.normalize("NFKC").replace(/\s+/g, "").match(TITLE)!;
  return { title: hit.str, date: isoDate(warekiYear(m[1], m[2]), Number(m[3]), Number(m[4])) };
}

/** 凡例の行（※ で始まる行と、その続きの「●」行）。同じ y の大きめの字（h ≈ 9.7）を x 順に結合する。 */
function readLegendLines(items: Item[]): { y: number; text: string }[] {
  const big = items.filter((i) => i.h > 8 && i.h < 11 && !KIND_HEADING.test(i.str));
  const ys = cluster(big.map((i) => i.y));
  const out: { y: number; text: string }[] = [];
  for (const y of ys) {
    const line = big.filter((i) => Math.abs(i.y - y) <= EPS).sort((a, b) => a.x - b.x).map((i) => i.str).join("");
    const text = line.replace(/^※\s*/, "").replace(/[\s　]+/g, "");
    if (text.startsWith("「")) out.push({ y, text });
  }
  return out.sort((a, b) => b.y - a.y); // 上から下へ
}

/**
 * 「〃」（同上）は直前の凡例の同じ位置の語。「●」〃 に起立しなかった者 → 「○」の説明「委員会審査結果又は議長宣告に起立（賛成）した者」のうち、
 * 〃 の後ろの語（に起立…）が現れる直前までを 〃 に入れる。対応する語が無ければ例外（推定しない）。
 */
export function expandDitto(text: string, previous: string): string {
  if (!text.startsWith("〃")) return text;
  const rest = text.slice(1);
  for (let n = Math.min(rest.length, previous.length); n >= 2; n--) {
    const idx = previous.indexOf(rest.slice(0, n));
    if (idx > 0) return previous.slice(0, idx) + rest;
  }
  throw new Error(`ditto "${text}" has no matching phrase in "${previous}"`);
}

/** 凡例の行 → 記号と意味の原文。行は「記号」意味、「記号」意味、… の形。2 行目以降の 〃 は 1 行目の最初の意味を指す。 */
export function parseLegendLines(lines: readonly string[]): Record<string, string> {
  const legend: Record<string, string> = {};
  let first: string | undefined;
  for (const line of lines) {
    const entries = [...line.matchAll(/「([^」]+)」([^「]*)/g)];
    if (entries.length === 0 || entries.map((e) => e[0]).join("") !== line) throw new Error(`legend line not in 「記号」意味 form: ${line}`);
    for (const e of entries) {
      const key = e[1];
      let value = e[2].replace(/、$/, "");
      if (value === "") throw new Error(`legend key ${key} has no meaning: ${line}`);
      if (value.startsWith("〃")) {
        if (!first) throw new Error(`ditto before any legend: ${line}`);
        value = expandDitto(value, first);
      }
      if (key in legend) throw new Error(`legend key ${key} appears twice`);
      legend[key] = value;
      first ??= value;
    }
  }
  return legend;
}

/* ---------- tables & grid ---------- */

interface Table { top: number; bottom: number; left: number; right: number; vlines: PageGeometry["vlines"]; hlines: HLine[] }

/** 同じ x で上下に接する縦線を 1 本にする（続きのページでは見出し部と本文部が別々に描かれている）。 */
function mergeVLines(vlines: readonly VLine[]): VLine[] {
  const out: VLine[] = [];
  for (const l of [...vlines].sort((a, b) => a.x - b.x || a.y0 - b.y0)) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - l.x) <= EPS / 2 && l.y0 <= last.y1 + EPS) last.y1 = Math.max(last.y1, l.y1);
    else out.push({ ...l });
  }
  return out;
}

/** 1 ページの中の表（左端の縦線 1 本につき 1 つ）。上から順。 */
function findTables(page: PageGeometry, pageNo: number): Table[] {
  if (page.vlines.length === 0) return [];
  const merged = mergeVLines(page.vlines);
  const left = Math.min(...merged.map((l) => l.x));
  const borders = merged.filter((l) => Math.abs(l.x - left) <= EPS && l.y1 - l.y0 > 20).sort((a, b) => b.y1 - a.y1);
  const out: Table[] = [];
  for (const b of borders) {
    if (out.some((t) => within((b.y0 + b.y1) / 2, t.bottom, t.top))) continue;
    const vlines = merged.filter((l) => l.y0 >= b.y0 - 2 && l.y1 <= b.y1 + 2 && l.y1 - l.y0 > 5);
    const hlines = page.hlines.filter((l) => l.y >= b.y0 - 2 && l.y <= b.y1 + 2);
    const right = Math.max(...vlines.map((l) => l.x));
    if (hlines.length === 0 || right - left < 100) throw new Error(`page ${pageNo}: table at y ${b.y0.toFixed(1)}-${b.y1.toFixed(1)} has no rules`);
    out.push({ top: b.y1, bottom: b.y0, left, right, vlines, hlines });
  }
  return out;
}

interface Grid {
  top: number;
  bodyTop: number;
  bottom: number;
  groupBottom: number;
  /** 左 3 列の境界（4 本） */
  leftCols: number[];
  /** 議員の列の境界（議員数＋1 本） */
  voteCols: number[];
  /** 議決結果の列 */
  resultCol: [number, number];
  groupCols: number[];
  /** 本文の行境界（降順） */
  rowLines: number[];
  /** 議案番号（結合セル）の境界（降順） */
  numberLines: number[];
}

function buildGrid(tb: Table, label: string): Grid {
  const colXs = cluster(tb.vlines.filter((l) => l.y0 <= tb.bottom + 2).map((l) => l.x));
  if (colXs.length < 6) throw new Error(`${label}: too few column rules (${colXs.length})`);
  const leftCols = colXs.slice(0, 4);
  const voteCols = colXs.slice(3, -1);
  const resultCol: [number, number] = [colXs[colXs.length - 2], colXs[colXs.length - 1]];
  const titleX = (leftCols[1] + leftCols[2]) / 2;
  const numberX = (leftCols[0] + leftCols[1]) / 2;
  const voteX = (voteCols[0] + voteCols[1]) / 2;
  const covers = (y: number, x: number) => tb.hlines.some((l) => Math.abs(l.y - y) <= EPS && l.x0 <= x + 1 && l.x1 >= x - 1);
  const ys = cluster(tb.hlines.map((l) => l.y)).sort((a, b) => b - a);
  const top = ys[0];
  const bottom = ys[ys.length - 1];
  if (Math.abs(top - tb.top) > EPS || Math.abs(bottom - tb.bottom) > EPS) throw new Error(`${label}: outer rules do not match the border`);
  const bodyTop = ys.find((y) => y < top - EPS && covers(y, titleX));
  const groupBottom = ys.find((y) => y < top - EPS && !covers(y, titleX) && covers(y, voteX));
  if (bodyTop === undefined || groupBottom === undefined || groupBottom <= bodyTop) throw new Error(`${label}: header rules not found (top ${top.toFixed(1)}, groupBottom ${groupBottom?.toFixed(1)}, bodyTop ${bodyTop?.toFixed(1)})`);
  const groupXs = cluster(tb.vlines.filter((l) => l.y1 >= top - 2 && l.x >= voteCols[0] - EPS && l.x <= voteCols[voteCols.length - 1] + EPS).map((l) => l.x));
  if (groupXs.length < 2) throw new Error(`${label}: group rules not found`);
  const rowLines = ys.filter((y) => y <= bodyTop + EPS && covers(y, titleX));
  const numberLines = ys.filter((y) => y <= bodyTop + EPS && covers(y, numberX));
  if (rowLines.length < 2 || numberLines.length < 2) throw new Error(`${label}: row rules not found`);
  return { top, bodyTop, bottom, groupBottom, leftCols, voteCols, resultCol, groupCols: groupXs, rowLines, numberLines };
}

const cellText = (items: Item[], x0: number, x1: number, y0: number, y1: number): string =>
  items.filter((i) => within(i.cx, x0, x1) && within(i.cy, y0, y1)).sort((a, b) => b.y - a.y || a.x - b.x).map((i) => i.str).join("").replace(/[\s　]+/g, "");

/* ---------- members ---------- */

function readMembers(page: PageGeometry, grid: Grid, label: string): VotePdfMember[] {
  const groups: { x0: number; x1: number; name: string }[] = [];
  for (let g = 0; g + 1 < grid.groupCols.length; g++) {
    const x0 = grid.groupCols[g];
    const x1 = grid.groupCols[g + 1];
    const name = cellText(page.items, x0, x1, grid.groupBottom, grid.top).normalize("NFKC");
    if (name === "") throw new Error(`${label}: group heading ${g} is empty`);
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
  // 左 3 列と右 1 列の見出しが期待どおりか（レイアウト変化の検出）
  const header = (x0: number, x1: number) => cellText(page.items, x0, x1, grid.bodyTop, grid.top);
  const check = (re: RegExp, text: string, name: string) => { if (!re.test(text)) throw new Error(`${label}: ${name} header "${text}" does not match ${re}`); };
  check(HEADERS.number, header(grid.leftCols[0], grid.leftCols[1]), "議案番号");
  check(HEADERS.title, header(grid.leftCols[1], grid.leftCols[2]), "案名");
  check(HEADERS.committee, header(grid.leftCols[2], grid.leftCols[3]), "委員会審査結果");
  check(HEADERS.result, header(grid.resultCol[0], grid.resultCol[1]), "議決結果");
  return members;
}

/* ---------- rows ---------- */

function readRows(page: PageGeometry, grid: Grid, pageNo: number, memberCount: number): VotePdfRow[] {
  const label = `page ${pageNo}`;
  const body = page.items.filter((i) => within(i.cy, grid.bottom, grid.bodyTop));
  const numbers: { y0: number; y1: number; text: string }[] = [];
  for (let k = 0; k + 1 < grid.numberLines.length; k++) {
    const y1 = grid.numberLines[k];
    const y0 = grid.numberLines[k + 1];
    numbers.push({ y0, y1, text: cellText(body, grid.leftCols[0], grid.leftCols[1], y0, y1) });
  }
  const rows: VotePdfRow[] = [];
  const voteLeft = grid.voteCols[0];
  const voteRight = grid.voteCols[grid.voteCols.length - 1];
  for (let r = 0; r + 1 < grid.rowLines.length; r++) {
    const y1 = grid.rowLines[r];
    const y0 = grid.rowLines[r + 1];
    const inRow = body.filter((i) => within(i.cy, y0, y1));
    if (inRow.length === 0) continue; // 空の行（余白）
    const title = cellText(inRow, grid.leftCols[1], grid.leftCols[2], y0, y1);
    const committeeResult = cellText(inRow, grid.leftCols[2], grid.leftCols[3], y0, y1);
    const result = cellText(inRow, grid.resultCol[0], grid.resultCol[1], y0, y1);
    const mid = (y0 + y1) / 2;
    const number = numbers.find((n) => within(mid, n.y0, n.y1));
    const rowLabel = `${label} row ${r + 1} (${number?.text ?? ""} ${title})`;
    if (!number) throw new Error(`${rowLabel}: 議案番号 cell not found`);
    if (title === "" || result === "") throw new Error(`${rowLabel}: incomplete row (title/result)`);
    // 表決のセル: 各議員の列に、この行の文字がちょうど 1 つ入るときだけ採用
    const cells: string[] = new Array(memberCount).fill(UNKNOWN_CELL);
    const hits: Item[][] = Array.from({ length: memberCount }, () => []);
    const unplaced: Item[] = [];
    for (const it of inRow) {
      if (it.cx <= voteLeft - EDGE || it.cx >= voteRight + EDGE) continue;
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
    rows.push({ page: pageNo, number: number.text, title, committeeResult, result, cells });
  }
  return rows;
}
