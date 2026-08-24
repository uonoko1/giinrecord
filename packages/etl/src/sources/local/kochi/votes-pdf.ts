import { bandIndex, cluster, EDGE, EPS, joinVertical, within, type Item, type PageGeometry } from "../pdf-table.ts";
import { readGlyphPages } from "./glyphs.ts";
import { warekiYear } from "./site.ts";

/**
 * 高知県議会「議員別賛否の状況」の会期 PDF（議決結果一覧表）の表復元（Issue #220）。会期ごとに 1 本。
 *
 * レイアウト（A4 横。ヘッダは各ページで繰り返される）:
 *   表題（各ページ、表の上）: 「令和８年６月定例会議決結果一覧表」
 *   表: 左から 議案種別（縦書きの結合セル「知事提出議案」「議員提出議案」）・番号（「第１号」「議発第12号」）・件名・
 *       議決年月日（「R8.7.10」。同じ日は「〃」）・議決結果（「原案可決」。同じ結果は「〃」）・
 *       議員の列（上段に会派の結合セル、その下に縦書きの氏名。1 文字 1 テキスト）・賛成者数・反対者数。
 *   凡例（最終ページの表の下）: 「・議決結果の見方」「○・・賛成、×・・反対、議・・議長、副・・副議長が議長の職務を代理、
 *   欠・・欠席、除・・除斥、－・・議場に不在であった議員」と、但し書き（表決権・裁決権）の行。
 *
 * 表の横罫線のうち、会派と氏名の境（y≈492.9）は議員の列の幅しか無い（表の右端まで届かない）。
 * そこで縦の目印は「右端まで届く横罫線」＝ 表の上端・本文の上端・各行の境 とし、
 * 会派／氏名の境は議員の列の範囲だけに架かる横罫線から取る。
 *
 * 方針（宮城・徳島・奈良・三重と同じ）: 文字の位置を推定で並べ替えない。罫線から列と行の境界を取り、
 * 各テキストの中心が入るセルにだけ置く。1 セルに 1 文字が入らなければ UNKNOWN_CELL。
 * 凡例に無い値が出たら例外（丸めない）。ページごとの議員の並びが違えば例外。
 * 「〃」（同上）は原文のまま残す（前の行の値で埋めない）。
 */
export const UNKNOWN_CELL = "不明";
export const UNKNOWN_LEGEND = "抽出不能";

export interface VotePdfLegend {
  /** セルの値 → 凡例の意味（「○」→「賛成」） */
  votes: Record<string, string>;
  /** 凡例の但し書き（「※過半数議決の場合、議長に…」など）の原文。丸めずそのまま */
  notes: string[];
}

export interface VotePdfMember {
  /** 縦書きの氏名を上から並べたもの（「浜口卓也」） */
  nameText: string;
  /** 会派見出しの原文（「自由民主党」「日本共産党」） */
  group: string;
}

export interface VotePdfRow {
  page: number;
  /** 議案種別の結合セルの原文（「知事提出議案」「議員提出議案」） */
  kind: string;
  /** 番号の原文（NFKC。「第1号」「議発第12号」） */
  number: string;
  /** 件名の原文（空白を除いて結合。折り返しの行もつながる） */
  title: string;
  /** 議決年月日の原文（「R8.7.10」。同じ日は「〃」のまま。ISO には直さない＝原文主義） */
  dateText: string;
  /** 議決結果の原文（「原案可決」「否決」「修正案否決」。同じ結果は「〃」のまま） */
  result: string;
  /** 賛成者数・反対者数の欄（読めた行だけ。空欄・非数値なら付けない） */
  counts?: { yes: number; no: number };
  /** members と同じ順。置けなかったセルは UNKNOWN_CELL */
  cells: string[];
}

export interface VotePdf {
  /** 表題の原文（「令和８年６月定例会議決結果一覧表」） */
  title: string;
  /** 表題の会期部分の原文（「令和８年６月定例会」）。index のリンク文言と突合する */
  sessionLabel: string;
  year: number;
  month: number;
  /** 定例会 / 臨時会 */
  sessionKind: string;
  legend: VotePdfLegend;
  members: VotePdfMember[];
  rows: VotePdfRow[];
  unknownCells: number;
  pages: number;
}

const TITLE = /^((令和|平成)([０-９0-9]+|元)年([０-９0-9]+)月(定例会|臨時会))議決結果一覧表$/;
/** 番号の欄（NFKC 後）。「第1号」「議発第12号」「報第1号」など */
const NUMBER = /^(.*?第[0-9]+号)(.*)$/;

export async function parseVotePdf(bytes: Buffer): Promise<VotePdf> {
  const pages = await readGlyphPages(bytes);
  if (pages.length === 0) throw new Error("PDF has no pages");
  const head = parseTitle(pages[0], 1);
  let members: VotePdfMember[] | undefined;
  let legend: VotePdfLegend | undefined;
  const rows: VotePdfRow[] = [];
  for (let p = 0; p < pages.length; p++) {
    const page = pages[p];
    const pageHead = parseTitle(page, p + 1);
    if (pageHead.title !== head.title) throw new Error(`page ${p + 1}: title "${pageHead.title}" differs from page 1 "${head.title}"`);
    const grid = buildGrid(page, p + 1);
    const pageMembers = readMembers(page, grid, p + 1);
    if (!members) members = pageMembers;
    else if (JSON.stringify(members) !== JSON.stringify(pageMembers)) throw new Error(`page ${p + 1}: member columns differ from page 1`);
    rows.push(...readRows(page, grid, p + 1, members.length));
    const pageLegend = parseLegend(page, grid.bottom);
    if (pageLegend) {
      if (legend) throw new Error(`page ${p + 1}: legend appears twice`);
      legend = pageLegend;
    }
  }
  if (!members || members.length === 0) throw new Error("no member columns found");
  if (rows.length === 0) throw new Error("no rows found");
  if (!legend) throw new Error("legend (・議決結果の見方) not found below the table");
  let unknownCells = 0;
  for (const row of rows) {
    checkCellsAgainstLegend(row.cells, legend.votes, `page ${row.page} ${row.kind} ${row.number}`);
    unknownCells += row.cells.filter((c) => c === UNKNOWN_CELL).length;
  }
  return { ...head, legend, members, rows, unknownCells, pages: pages.length };
}

/** 凡例に無い値が出たら例外（丸めない・推定しない）。UNKNOWN_CELL だけは通す。 */
export function checkCellsAgainstLegend(cells: readonly string[], votes: Record<string, string>, label: string): void {
  for (const c of cells) {
    if (c === UNKNOWN_CELL) continue;
    if (!(c in votes)) throw new Error(`${label}: cell value "${c}" is not in the legend (${Object.keys(votes).join("")})`);
  }
}

/* ---------- title & legend ---------- */

function parseTitle(page: PageGeometry, pageNo: number): { title: string; sessionLabel: string; year: number; month: number; sessionKind: string } {
  // 表題は 1 テキストのことも 1 文字ずつのこともあるので、同じ行（同じ y）の文字を左から繋いでから照合する
  for (const line of textLines(page.items)) {
    const text = line.replace(/[\s　]+/g, "");
    const m = text.match(TITLE);
    if (!m) continue;
    return {
      title: text,
      sessionLabel: m[1],
      year: warekiYear(m[2], m[3]),
      month: Number(m[4].normalize("NFKC")),
      sessionKind: m[5],
    };
  }
  throw new Error(`page ${pageNo}: title (令和N年M月定例会議決結果一覧表) not found`);
}

/**
 * 縦書きの見出し・氏名を読む。基本は 1 列を上から下へ。
 * セルの高さに収まりきらない字は、右にずらした短い列として置かれる
 * （会派見出し「一燈立志の会」は主列が「一燈立志の」、右に溢れた「会」が続きで最後に来る）。
 * そこで x でまとめた列のうち、いちばん字数の多い列を主列として先に読み、
 * 残りの列（溢れ）を x の小さい順に後ろへ繋ぐ。1 列だけなら joinVertical と同じ。
 */
function joinVerticalColumns(chars: readonly Item[]): string {
  if (chars.length === 0) return "";
  const xs = cluster(chars.map((c) => c.cx), 3);
  const cols = xs.map((x) => chars.filter((c) => Math.abs(c.cx - x) <= 3));
  if (cols.length === 1) return joinVertical(cols[0]).replace(/[\s　]+/g, "");
  const mainIdx = cols.reduce((best, col, i) => (col.length > cols[best].length ? i : best), 0);
  const rest = cols.flatMap((col, i) => (i === mainIdx ? [] : [{ x: xs[i], col }])).sort((a, b) => a.x - b.x);
  return [joinVertical(cols[mainIdx]), ...rest.map((r) => joinVertical(r.col))].join("").replace(/[\s　]+/g, "");
}

/** 同じ y にある文字を左から繋いで 1 行にする（上の行から順）。 */
function textLines(items: readonly Item[]): string[] {
  const lines: string[] = [];
  for (const y of [...cluster(items.map((i) => i.y), 2)].sort((a, b) => b - a)) {
    const line = items
      .filter((i) => Math.abs(i.y - y) <= 2)
      .sort((a, b) => a.x - b.x)
      .map((i) => i.str)
      .join("")
      .trim();
    if (line !== "") lines.push(line);
  }
  return lines;
}

const LEGEND_LEAD = /^・?議決結果の見方/;
/** 「○・・賛成、」の形。区切りは「・・」（中黒 2 つ） */
const LEGEND_ITEM = /(.)・・([^、]+)/g;

/**
 * 表の下の凡例。「・議決結果の見方」の行の下にある「○・・賛成、×・・反対、…」から値と意味を取る。
 * 「※…」で始まる行は但し書きとして原文のまま notes に残す。このページに無ければ undefined。
 */
function parseLegend(page: PageGeometry, bottom: number): VotePdfLegend | undefined {
  const below = page.items.filter((i) => i.cy < bottom - EPS);
  const lines = textLines(below);
  // 文字が 1 つずつ別テキストのこともあるので、行に繋いでから見出しを探す
  if (!lines.some((l) => LEGEND_LEAD.test(l.replace(/[\s　]+/g, "")))) return undefined;
  const votes: Record<string, string> = {};
  const notes: string[] = [];
  for (const line of lines) {
    // 「・議決結果の見方」の見出しと凡例本体が同じ行に来ることがあるので、見出しだけ落として続きを読む
    const flat = line.replace(/[\s　]+/g, "").replace(LEGEND_LEAD, "");
    if (flat === "") continue;
    if (flat.startsWith("※") || flat.startsWith("特別多数議決")) { notes.push(line.trim()); continue; }
    if (!flat.includes("・・")) continue;
    for (const m of flat.matchAll(LEGEND_ITEM)) {
      const key = m[1];
      const meaning = m[2].replace(/、$/, "").trim();
      if (meaning === "") throw new Error(`legend entry ${key} has no meaning: ${line}`);
      if (key in votes && votes[key] !== meaning) throw new Error(`legend key ${key} appears twice with different meanings`);
      votes[key] = meaning;
    }
  }
  if (Object.keys(votes).length === 0) throw new Error(`legend has no X・・… entries: ${lines.join(" / ")}`);
  return { votes, notes };
}

/* ---------- grid ---------- */

interface Grid {
  /** 表の上端 */
  top: number;
  /** 会派と氏名の境（議員の列の幅しか無い横罫線） */
  groupBottom: number;
  /** 本文の上端（列見出しの下） */
  bodyTop: number;
  /** 表の下端 */
  bottom: number;
  /** 表の左端＝議案種別の左 */
  kindLeft: number;
  /** 議案種別の右＝番号の左 */
  kindRight: number;
  /** 番号の右＝件名の左 */
  titleLeft: number;
  /** 件名の右＝議決年月日の左 */
  dateLeft: number;
  /** 議決年月日の右＝議決結果の左 */
  resultLeft: number;
  /** 議員の列境界（議員数＋1 本）。[0] が議決結果の右＝賛否欄の左端 */
  voteCols: number[];
  /** 賛成者数の左（＝議員の列の右端）と反対者数の左、表の右端 */
  countCols: number[];
  /** 会派の結合セル */
  groups: { x0: number; x1: number; name: string }[];
  /** 本文の行境界（降順。[0] は bodyTop、最後は bottom） */
  rowLines: number[];
  /** 議案種別（結合セル）の境界（降順。表の左端から始まる横罫線） */
  kindLines: number[];
}

function buildGrid(page: PageGeometry, pageNo: number): Grid {
  const label = `page ${pageNo}`;
  if (page.vlines.length === 0 || page.hlines.length === 0) throw new Error(`${label}: no table rules found`);
  const left = Math.min(...page.vlines.map((l) => l.x));
  const right = Math.max(...page.vlines.map((l) => l.x));
  const ys = cluster(page.hlines.map((l) => l.y));
  const extent = ys.map((y) => {
    const segs = page.hlines.filter((l) => Math.abs(l.y - y) <= EPS);
    return { y, x0: Math.min(...segs.map((s) => s.x0)), x1: Math.max(...segs.map((s) => s.x1)) };
  });
  // 右端まで届く横罫線＝表の上端・本文の上端・行の境
  const wide = extent.filter((e) => e.x1 >= right - 2).map((e) => e.y).sort((a, b) => b - a);
  if (wide.length < 3) throw new Error(`${label}: too few rules reaching the right edge (${wide.length})`);
  const top = wide[0];
  const bodyTop = wide[1];
  const bottom = wide[wide.length - 1];
  if (!(top > bodyTop && bodyTop > bottom)) throw new Error(`${label}: header rules not found (top ${top}, bodyTop ${bodyTop}, bottom ${bottom})`);
  // 縦線は横罫線で区切られた帯ごとに分けて描かれている（1 本の長い線ではない）ので、x でまとめてから
  // 「その x の線分が [y0, y1] を（横罫線のぶんの隙間を跨いで）覆っているか」を見る。
  // 隙間は横罫線の太さぶん（実測 3〜4pt）空くので GAP まで繋がっているとみなす。
  const GAP = 5;
  const vxs = cluster(page.vlines.map((l) => l.x));
  const covers = (x: number, y0: number, y1: number): boolean => {
    const segs = page.vlines.filter((l) => Math.abs(l.x - x) <= EPS && l.y1 > y0 + EDGE).sort((a, b) => a.y0 - b.y0);
    let reach = y0;
    for (const s of segs) {
      if (s.y0 > reach + GAP) break; // 途切れている
      reach = Math.max(reach, s.y1);
      if (reach >= y1 - EDGE) return true;
    }
    return false;
  };
  // 見出しの段を貫く縦線（表の上端から本文の上端まで）
  const headerXs = vxs.filter((x) => covers(x, bodyTop, top));
  if (headerXs.length < 6) throw new Error(`${label}: too few column rules over the header (${headerXs.length})`);
  const headerText = (x0: number, x1: number, y0: number, y1: number) =>
    page.items
      .filter((it) => within(it.cx, x0, x1) && within(it.cy, y0, y1))
      .sort((a, b) => b.y - a.y || a.x - b.x)
      .map((it) => it.str)
      .join("")
      .replace(/[\s　]+/g, "");
  // 左の 5 列: 議案種別（見出し無し。縦書きの結合セル）・番号・件名・議決年月日・議決結果。
  // 議案種別と番号の境の縦線は見出しの段まで届かないので、列は見出しの文言から決める（位置決め打ちにしない）。
  const headerCell = (i: number) => headerText(headerXs[i], headerXs[i + 1], bodyTop, top);
  const findHeader = (name: string) => {
    const hit = headerXs.slice(0, -1).flatMap((_, i) => (headerCell(i).includes(name) ? [i] : []));
    if (hit.length !== 1) throw new Error(`${label}: expected exactly one ${name} header cell, got ${hit.length}`);
    return hit[0];
  };
  const numberIdx = findHeader("番号");
  const titleIdx = findHeader("件名");
  const dateIdx = findHeader("年月日");
  const resultIdx = findHeader("結果");
  if (!(numberIdx < titleIdx && titleIdx < dateIdx && dateIdx < resultIdx)) {
    throw new Error(`${label}: header cells are not in the order 番号→件名→議決年月日→議決結果`);
  }
  // 議案種別の右＝番号の左。「番号」の見出しセルは議案種別の列も含む幅（見出しの段には議案種別を仕切る縦線が無い）ので、
  // 本文だけを区切る縦線（表の左端の次）を議案種別の右とする
  const numberCellLeft = headerXs[numberIdx];
  const numberCellRight = headerXs[numberIdx + 1];
  const kindRight = vxs.find((x) => x > numberCellLeft + EPS && x < numberCellRight - EPS) ?? numberCellLeft;
  const titleLeft = headerXs[titleIdx];
  const dateLeft = headerXs[dateIdx];
  const resultLeft = headerXs[resultIdx];
  const voteStart = headerXs[resultIdx + 1];
  // 会派と氏名の境: 議員の列の範囲だけに架かる横罫線（右端まで届かないので wide には入らない）
  const nameRule = extent
    .filter((e) => e.y < top - EPS && e.y > bodyTop + EPS && e.x0 >= voteStart - 2)
    .sort((a, b) => b.y - a.y)[0];
  if (!nameRule) throw new Error(`${label}: 会派/氏名 rule not found between the table top and the body top`);
  const groupBottom = nameRule.y;
  // 議員の列: 氏名の段（本文の上端〜会派/氏名の境）を区切る縦線のうち賛否欄の左端から右。
  // 縦線は罫線の内側（bodyTop と groupBottom の少し内）までしか描かれていないので、少し縮めた範囲で見る
  // 会派/氏名の境の横罫線は議員の列のぶんしか無いので、その右端が賛否欄の右端（＝賛成者数の左）になる
  const nameBand: [number, number] = [bodyTop + GAP, groupBottom - GAP];
  // （罫線の端は縦線より僅かに内側で終わるので、いちばん近い縦線に寄せる）
  const voteRight = vxs.reduce((best, x) => (Math.abs(x - nameRule.x1) < Math.abs(best - nameRule.x1) ? x : best), vxs[0]);
  if (voteRight <= voteStart) throw new Error(`${label}: 賛否欄の右端 not found`);
  const nameXs = vxs.filter((x) => x >= voteStart - EPS && x <= voteRight + EPS && covers(x, nameBand[0], nameBand[1]));
  if (nameXs.length < 3) throw new Error(`${label}: too few member columns (${nameXs.length - 1})`);
  const voteCols = nameXs;
  const countCols = headerXs.filter((x) => x >= voteRight - EPS);
  if (countCols.length !== 3) throw new Error(`${label}: expected 賛成者数/反対者数 columns, got ${countCols.length - 1}`);
  // 会派の結合セル: 会派/氏名の境〜表の上端。この段を貫く縦線で区切られた帯。
  // 縦書きは 1 つのテキストが数文字ぶんの高さを持ち、中心（cy）が表の上端を越えることがあるので、
  // 「文字の下端（y）が会派/氏名の境より上」で選ぶ（氏名の段の長い名前を拾わない）。
  const groupXs = vxs.filter((x) => x >= voteStart - EPS && x <= voteRight + EPS && covers(x, groupBottom, top));
  const groups: Grid["groups"] = [];
  for (let g = 0; g + 1 < groupXs.length; g++) {
    const chars = page.items.filter((i) => within(i.cx, groupXs[g], groupXs[g + 1]) && i.y >= groupBottom - EDGE);
    const name = joinVerticalColumns(chars);
    if (name === "") throw new Error(`${label}: group heading between ${groupXs[g].toFixed(1)} and ${groupXs[g + 1].toFixed(1)} is empty`);
    groups.push({ x0: groupXs[g], x1: groupXs[g + 1], name });
  }
  if (groups.length === 0) throw new Error(`${label}: no group headings found`);
  // 議案種別（結合セル）の境界: 表の左端から始まる横罫線
  const kindLines = extent.filter((e) => e.x0 <= left + 2 && e.y <= bodyTop + EPS && e.y >= bottom - EPS).map((e) => e.y).sort((a, b) => b - a);
  if (kindLines.length < 1 || Math.abs(kindLines[0] - bodyTop) > EPS) {
    throw new Error(`${label}: 議案種別 rules do not start at the body top (${kindLines.map((y) => y.toFixed(1)).join(" ")})`);
  }
  if (Math.abs(kindLines[kindLines.length - 1] - bottom) > EPS) kindLines.push(bottom);
  const rowLines = wide.filter((y) => y <= bodyTop + EPS);
  if (rowLines.length < 2) throw new Error(`${label}: row rules not found`);
  return { top, groupBottom, bodyTop, bottom, kindLeft: left, kindRight, titleLeft, dateLeft, resultLeft, voteCols, countCols, groups, rowLines, kindLines };
}

/* ---------- members ---------- */

function readMembers(page: PageGeometry, grid: Grid, pageNo: number): VotePdfMember[] {
  const label = `page ${pageNo}`;
  const members: VotePdfMember[] = [];
  for (let c = 0; c + 1 < grid.voteCols.length; c++) {
    const x0 = grid.voteCols[c];
    const x1 = grid.voteCols[c + 1];
    // 氏名の段: 文字の下端（y）が本文の上端より上、かつ会派/氏名の境より下（縦書きは cy が段をはみ出す）
    const chars = page.items.filter((i) => within(i.cx, x0, x1) && i.y >= grid.bodyTop - EDGE && i.y < grid.groupBottom - EDGE);
    if (chars.length === 0) throw new Error(`${label}: member column ${c} has no name`);
    const nameText = joinVerticalColumns(chars);
    if (nameText === "") throw new Error(`${label}: member column ${c} name is empty`);
    const mid = (x0 + x1) / 2;
    const group = grid.groups.find((g) => within(mid, g.x0, g.x1));
    if (!group) throw new Error(`${label}: member column "${nameText}" is not under any group heading`);
    members.push({ nameText, group: group.name });
  }
  return members;
}

/* ---------- rows ---------- */

/** 文字を上の行から順に、行の中は左から結合（空白は除く）。 */
function joinText(chars: Item[]): string {
  return [...chars].sort((a, b) => b.y - a.y || a.x - b.x).map((c) => c.str).join("").replace(/[\s　]+/g, "");
}

function readRows(page: PageGeometry, grid: Grid, pageNo: number, memberCount: number): VotePdfRow[] {
  const label = `page ${pageNo}`;
  const body = page.items.filter((i) => within(i.cy, grid.bottom, grid.bodyTop));
  // 議案種別（結合セル）の文字列をセルごとに。縦書きの「知事提出議案」は 1 つのテキストが数文字ぶんの高さを持ち、
  // その中心（cy）がセルの外に出ることがあるので、文字の占める範囲［y, y+h］とセルの重なりで選ぶ。
  // 表の中（本文の上端より下・表の下端より上）の、議案種別の列にある文字だけ。
  // 表の下の凡例（「※特別多数議決…」）は表の外なので入れない
  const kindItems = page.items.filter((i) => within(i.cx, grid.kindLeft, grid.kindRight) && i.y < grid.bodyTop && i.y >= grid.bottom - EDGE);
  const kinds: { y0: number; y1: number; text: string }[] = [];
  for (let k = 0; k + 1 < grid.kindLines.length; k++) {
    kinds.push({ y0: grid.kindLines[k + 1], y1: grid.kindLines[k], text: "" });
  }
  // 結合セルの縦書きは、セルの高さより文字列が長いとセルの外へはみ出して描かれる（この PDF では
  // 「議員提出議案」がセルの上へはみ出す）。なので重なりではなく、テキストの中心にいちばん近いセルに入れる。
  // セルは上から順に埋まるので、1 セルに 2 つ以上入ったら例外（黙って混ぜない）。
  const assigned: Item[][] = kinds.map(() => []);
  for (const i of kindItems) {
    const mid = i.y + i.h / 2;
    let best = 0;
    let bestDist = Infinity;
    kinds.forEach((k, ki) => {
      const center = (k.y0 + k.y1) / 2;
      const dist = Math.abs(mid - center);
      if (dist < bestDist) { bestDist = dist; best = ki; }
    });
    assigned[best].push(i);
  }
  kinds.forEach((k, ki) => { k.text = joinVerticalColumns(assigned[ki]); });
  const rows: VotePdfRow[] = [];
  for (let r = 0; r + 1 < grid.rowLines.length; r++) {
    const y1 = grid.rowLines[r];
    const y0 = grid.rowLines[r + 1];
    const inRow = body.filter((i) => within(i.cy, y0, y1));
    if (inRow.length === 0) continue; // 空の行（余白）
    const numberText = joinText(inRow.filter((i) => within(i.cx, grid.kindRight, grid.titleLeft))).normalize("NFKC");
    if (numberText === "") continue; // 件名の折り返しだけの行（番号は最初の行にしか無い）ではなく、番号の無い行は飛ばす
    const m = numberText.match(NUMBER);
    if (!m) throw new Error(`${label} row ${r + 1}: "${numberText}" does not look like 第N号`);
    const number = m[1];
    const rowLabel = `${label} row ${r + 1} (${number})`;
    const title = joinText(inRow.filter((i) => within(i.cx, grid.titleLeft, grid.dateLeft)));
    if (title === "") throw new Error(`${rowLabel}: title is empty`);
    const dateText = joinText(inRow.filter((i) => within(i.cx, grid.dateLeft, grid.resultLeft)));
    if (dateText === "") throw new Error(`${rowLabel}: 議決年月日 is empty`);
    const result = joinText(inRow.filter((i) => within(i.cx, grid.resultLeft, grid.voteCols[0])));
    if (result === "") throw new Error(`${rowLabel}: 議決結果 is empty`);
    const mid = (y0 + y1) / 2;
    const kind = kinds.find((k) => within(mid, k.y0, k.y1));
    if (!kind || kind.text === "") throw new Error(`${rowLabel}: 議案種別（結合セル） not found`);
    // 表決のセル: 各議員の列に、この行の文字がちょうど 1 つ入るときだけ採用
    const cells: string[] = new Array(memberCount).fill(UNKNOWN_CELL);
    const hits: Item[][] = Array.from({ length: memberCount }, () => []);
    const unplaced: Item[] = [];
    for (const it of inRow) {
      if (it.cx <= grid.voteCols[0] || it.cx >= grid.voteCols[grid.voteCols.length - 1]) continue;
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
    // 賛成者数・反対者数（数字として読めたときだけ。空欄・「〃」などは付けない）
    const yesText = joinText(inRow.filter((i) => within(i.cx, grid.countCols[0], grid.countCols[1]))).normalize("NFKC");
    const noText = joinText(inRow.filter((i) => within(i.cx, grid.countCols[1], grid.countCols[2]))).normalize("NFKC");
    const counts = /^\d+$/.test(yesText) && /^\d+$/.test(noText) ? { yes: Number(yesText), no: Number(noText) } : undefined;
    rows.push({ page: pageNo, kind: kind.text, number, title, dateText, result, ...(counts ? { counts } : {}), cells });
  }
  return rows;
}
