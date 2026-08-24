import { bandIndex, cluster, EDGE, EPS, joinVertical, readPages, within, type Item, type PageGeometry } from "../pdf-table.ts";
import { isoDate, warekiYear } from "./site.ts";

/**
 * 奈良県議会「議員別の議案等に対する表決結果」PDF の表復元（Issue #202）。
 *
 * レイアウト（横長、議決日ごとに 1 本）:
 *   見出し（各ページ）: 「議員別の議案等に対する表決結果（令和8年6月定例会 7月2日議決分）」
 *   表: 左から 種別（縦書きの結合セル「知事提出議案」「議員提出議案」「決議」「意見書」）・議案等名（「議第56号 …」。報告の行は
 *       専決処分の内訳が字下げの小行で並ぶ）・議決結果（「原案可決」「報告受理」…）・議員の列（上段に会派の結合セル、その下に縦書きの氏名）。
 *       「＜令和8年度議案＞」の行は年度の区切り（表決の行ではない。議員の列に「年度」の飾り文字が入る）。
 *   凡例（最終ページの表の下）: 「賛否等欄：「○」賛成、「×」反対（起立採決において、起立しなかった議員）、「議」議長、
 *   「副」副議長が議長職務を代行した場合、「除」除斥、「欠」欠席、「退」表決を棄権、「―」不在（除斥、欠席及び表決を棄権した場合を除く）」
 *
 * 方針（宮城と同じ）: 文字の位置を推定で並べ替えない。罫線（細い矩形）から列と行の境界を取り、各テキストの中心が入るセルにだけ置く。
 * 1 セルに 1 文字が入らなければ UNKNOWN_CELL。凡例に無い値が出たら例外。ページごとの議員の並びが違えば例外。
 * 行の境界は議員の列まで届く横罫線、種別（結合セル）の境界は表の左端から始まる横罫線。報告の内訳の小行の罫線（議案等名の中だけ）は行の境界にしない。
 * 表決方法・人数の欄は無いので method / counts は書かない（推定しない）。
 */
export const UNKNOWN_CELL = "不明";
export const UNKNOWN_LEGEND = "抽出不能";

export interface VotePdfLegend {
  /** セルの値 → 凡例の意味（「○」→「賛成」） */
  votes: Record<string, string>;
}

export interface VotePdfMember {
  /** 縦書きの氏名を上から並べたもの（「永田恒」。外字（「芦」）が文字層に落ちて欠けることがある） */
  nameText: string;
  /** 会派見出しの原文（「自由民主党・無所属の会」「日本共産党」） */
  group: string;
}

export interface VotePdfRow {
  page: number;
  /** 種別の結合セルの原文（「知事提出議案」「議員提出議案」「決議」「意見書」） */
  kind: string;
  /** 議案等番号の原文（NFKC。「議第56号」「報第1号」「第4号」） */
  number: string;
  /** 件名の原文（空白を除いて結合。報告の行は専決処分の内訳もつながる） */
  title: string;
  /** 議決結果の原文（「原案可決」「原案同意」「報告受理」「原案承認」） */
  result: string;
  /** members と同じ順。置けなかったセルは UNKNOWN_CELL */
  cells: string[];
}

export interface VotePdf {
  /** 見出しの会期の原文（「令和8年6月定例会」） */
  sessionLabel: string;
  /** 議決日（ISO。見出しの「7月2日議決分」を会期の和暦年で読む） */
  date: string;
  legend: VotePdfLegend;
  members: VotePdfMember[];
  rows: VotePdfRow[];
  unknownCells: number;
}

// NFKC 後に照合する（全角の括弧・数字は半角になる）
const TITLE = /^議員別の議案等に対する表決結果\(((令和|平成)(\d+|元)年(\d{1,2})月(定例会|臨時会))\s*(\d{1,2})月(\d{1,2})日議決分\)$/;
const MARKER = /^＜.+＞$/;
const NUMBER = /^(議第|報第|第)([0-9０-９]+)号(.*)$/;

export async function parseVotePdf(bytes: Buffer): Promise<VotePdf> {
  const pages = await readPages(bytes);
  if (pages.length === 0) throw new Error("PDF has no pages");
  const head = parseHeader(pages[0], 1);
  let legend: VotePdfLegend | undefined;
  let members: VotePdfMember[] | undefined;
  const rows: VotePdfRow[] = [];
  for (let p = 0; p < pages.length; p++) {
    const page = pages[p];
    const pageHead = parseHeader(page, p + 1);
    if (pageHead.sessionLabel !== head.sessionLabel || pageHead.date !== head.date) throw new Error(`page ${p + 1}: heading ${pageHead.sessionLabel} ${pageHead.date} differs from page 1`);
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
  if (!legend) throw new Error("legend (賛否等欄：…) not found below the table");
  let unknownCells = 0;
  for (const row of rows) {
    checkCellsAgainstLegend(row.cells, legend.votes, `page ${row.page} ${row.kind} ${row.number}`);
    unknownCells += row.cells.filter((c) => c === UNKNOWN_CELL).length;
  }
  return { ...head, legend, members, rows, unknownCells };
}

/** 凡例に無い値が出たら例外（丸めない・推定しない）。UNKNOWN_CELL だけは通す。 */
export function checkCellsAgainstLegend(cells: readonly string[], votes: Record<string, string>, label: string): void {
  for (const c of cells) {
    if (c === UNKNOWN_CELL) continue;
    if (!(c in votes)) throw new Error(`${label}: cell value "${c}" is not in the legend (${Object.keys(votes).join("")})`);
  }
}

/* ---------- header & legend ---------- */

function parseHeader(page: PageGeometry, pageNo: number): { sessionLabel: string; date: string } {
  for (const it of page.items) {
    const m = it.str.normalize("NFKC").trim().match(TITLE);
    if (!m) continue;
    const sessionYear = warekiYear(m[2], m[3]);
    const sessionMonth = Number(m[4]);
    const month = Number(m[6]);
    // 議決月が会期の月より 6 か月以上前なら翌年（12月定例会の 1月議決）
    const year = month < sessionMonth - 6 ? sessionYear + 1 : sessionYear;
    return { sessionLabel: m[1], date: isoDate(year, month, Number(m[7])) };
  }
  throw new Error(`page ${pageNo}: heading 議員別の議案等に対する表決結果（…M月D日議決分） not found`);
}

/** 表の下の「賛否等欄：…」の行。「「○」賛成、」の形の項目を集める。このページに無ければ undefined。 */
function parseLegend(page: PageGeometry, bottom: number): VotePdfLegend | undefined {
  const below = page.items.filter((i) => i.cy < bottom);
  const lead = below.find((i) => i.str.trim().startsWith("賛否等欄："));
  if (!lead) return undefined;
  const line = below
    .filter((i) => Math.abs(i.y - lead.y) <= 2)
    .sort((a, b) => a.x - b.x)
    .map((i) => i.str.trim())
    .join("");
  const body = line.replace(/^賛否等欄：/, "");
  const votes: Record<string, string> = {};
  for (const m of body.matchAll(/「(.)」([^「]*)/g)) {
    const meaning = m[2].replace(/、\s*$/, "").trim();
    if (meaning === "") throw new Error(`legend entry 「${m[1]}」 has no meaning: ${line}`);
    if (m[1] in votes) throw new Error(`legend key ${m[1]} appears twice`);
    votes[m[1]] = meaning;
  }
  if (Object.keys(votes).length === 0) throw new Error(`legend line has no 「X」… entries: ${line}`);
  return { votes };
}

/* ---------- grid ---------- */

interface Grid {
  top: number;
  groupBottom: number;
  bodyTop: number;
  bottom: number;
  /** 表の左端・種別の右（議案等名の左） */
  kindLeft: number;
  kindRight: number;
  /** 議案等名の右＝議決結果の左 */
  resultLeft: number;
  /** 議員の列境界（議員数＋1 本）。[0] が議決結果の右＝賛否欄の左端 */
  voteCols: number[];
  /** 会派の結合セル */
  groups: { x0: number; x1: number; name: string }[];
  /** 本文の行境界（降順。[0] は bodyTop、最後は bottom） */
  rowLines: number[];
  /** 種別（結合セル）の境界（降順。表の左端から始まる横罫線） */
  kindLines: number[];
  /** 本文の縦線（議案等番号と件名の境の検出に使う） */
  bodyVlines: { x: number; y0: number; y1: number }[];
}

function buildGrid(page: PageGeometry, pageNo: number): Grid {
  const label = `page ${pageNo}`;
  if (page.vlines.length === 0 || page.hlines.length === 0) throw new Error(`${label}: no table rules found`);
  const left = Math.min(...page.vlines.map((l) => l.x));
  const right = Math.max(...page.vlines.map((l) => l.x));
  // 同じ y の線分をまとめ、右端まで届く y を行の罫線とする（報告の内訳の小行の罫線は議案等名の中だけなので入らない）
  const ys = cluster(page.hlines.map((l) => l.y));
  const extent = ys.map((y) => {
    const segs = page.hlines.filter((l) => Math.abs(l.y - y) <= EPS);
    return { y, x0: Math.min(...segs.map((s) => s.x0)), x1: Math.max(...segs.map((s) => s.x1)) };
  });
  const wide = extent.filter((e) => e.x1 >= right - 2).map((e) => e.y).sort((a, b) => b - a);
  if (wide.length < 4) throw new Error(`${label}: too few rules reaching the right edge (${wide.length})`);
  const top = wide[0];
  const groupBottom = wide[1];
  const bodyTop = wide[2];
  const bottom = wide[wide.length - 1];
  if (!(top > groupBottom && groupBottom > bodyTop && bodyTop > bottom)) throw new Error(`${label}: header rules not found (top ${top}, groupBottom ${groupBottom}, bodyTop ${bodyTop})`);
  // 種別（結合セル）の境界: 表の左端から始まる横罫線。種別が次のページへ続くときは下端の罫線が左端まで届かないので、表の下端を境界に足す
  const kindLines = extent.filter((e) => e.x0 <= left + 2 && e.y <= bodyTop + EPS && e.y >= bottom - EPS).map((e) => e.y).sort((a, b) => b - a);
  if (kindLines.length < 1 || Math.abs(kindLines[0] - bodyTop) > EPS) {
    throw new Error(`${label}: 種別 rules do not start at the body top (${kindLines.map((y) => y.toFixed(1)).join(" ")})`);
  }
  if (Math.abs(kindLines[kindLines.length - 1] - bottom) > EPS) kindLines.push(bottom);
  // 見出しの段（bodyTop〜top）を貫く縦線: [表の左端 (| 議案等番号/件名の境) | 議決結果の左 | 賛否欄の左端 | 会派の境界 … | 右端]。
  // 議案等番号/件名の境の縦線が見出しの段まで届く PDF（2月定例会分）と届かない PDF（6月定例会分）があるので、
  // 「議決結果」の見出しセルを探して賛否欄の左端を決める
  const headerText = (x0: number, x1: number) =>
    page.items
      .filter((it) => within(it.cx, x0, x1) && within(it.cy, bodyTop, top))
      .sort((a, b) => b.y - a.y || a.x - b.x)
      .map((it) => it.str)
      .join("")
      .replace(/[\s　]+/g, "");
  const headerXs = cluster(page.vlines.filter((l) => l.y1 >= top - 2 && l.y0 <= bodyTop + 2).map((l) => l.x));
  if (headerXs.length < 4) throw new Error(`${label}: too few column rules over the header (${headerXs.length})`);
  const resultIdx = headerXs.slice(0, -1).flatMap((x0, i) => (headerText(x0, headerXs[i + 1]) === "議決結果" ? [i] : []));
  if (resultIdx.length !== 1) throw new Error(`${label}: expected exactly one 議決結果 header cell, got ${resultIdx.length}`);
  const resultLeft = headerXs[resultIdx[0]];
  const voteStart = headerXs[resultIdx[0] + 1];
  if (headerText(left, resultLeft) !== "議案等名") throw new Error(`${label}: header left of 議決結果 is "${headerText(left, resultLeft)}", not 議案等名`);
  // 会派の結合セル: 議決結果の右の見出しの縦線で区切られた帯
  const groupXs = headerXs.slice(resultIdx[0] + 1);
  const groups: Grid["groups"] = [];
  for (let g = 0; g + 1 < groupXs.length; g++) {
    const chars = page.items.filter((i) => within(i.cx, groupXs[g], groupXs[g + 1]) && within(i.cy, groupBottom, top));
    if (chars.length === 0) throw new Error(`${label}: group heading between ${groupXs[g].toFixed(1)} and ${groupXs[g + 1].toFixed(1)} is empty`);
    const name = chars.sort((a, b) => b.y - a.y || a.x - b.x).map((c) => c.str).join("").replace(/[\s　]+/g, "");
    groups.push({ x0: groupXs[g], x1: groupXs[g + 1], name });
  }
  if (groups.length === 0) throw new Error(`${label}: no group headings found`);
  if (Math.abs(groups[groups.length - 1].x1 - right) > EPS) throw new Error(`${label}: group headings do not span the vote area`);
  // 議員の列境界: 氏名の段（bodyTop〜groupBottom）を区切る縦線のうち賛否欄の左端から右
  const voteCols = cluster(page.vlines.filter((l) => l.y0 <= bodyTop + 2 && l.y1 >= groupBottom - 2).map((l) => l.x)).filter((x) => x >= voteStart - EPS);
  if (voteCols.length < 3) throw new Error(`${label}: too few member columns (${voteCols.length - 1})`);
  if (Math.abs(voteCols[0] - voteStart) > EPS || Math.abs(voteCols[voteCols.length - 1] - right) > EPS) {
    throw new Error(`${label}: member columns do not span the vote area`);
  }
  // 種別の右（議案等名の左）: 本文だけを区切る縦線のうち左端の次
  const bodyXs = cluster(page.vlines.filter((l) => l.y0 <= bodyTop - 2).map((l) => l.x));
  const kindRight = bodyXs.find((x) => x > left + EPS);
  if (kindRight === undefined || kindRight >= resultLeft) throw new Error(`${label}: 種別 column rule not found`);
  // 行境界: 議員の列まで届く横罫線（bodyTop から下）
  const rowLines = wide.filter((y) => y <= bodyTop + EPS);
  if (rowLines.length < 2) throw new Error(`${label}: row rules not found`);
  const bodyVlines = page.vlines.filter((l) => l.y0 <= bodyTop - 2);
  return { top, groupBottom, bodyTop, bottom, kindLeft: left, kindRight, resultLeft, voteCols, groups, rowLines, kindLines, bodyVlines };
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
    const nameText = joinVertical(chars).replace(/\s+/g, "");
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
  // 種別（結合セル）の文字列をセルごとに
  const kinds: { y0: number; y1: number; text: string }[] = [];
  for (let k = 0; k + 1 < grid.kindLines.length; k++) {
    const y1 = grid.kindLines[k];
    const y0 = grid.kindLines[k + 1];
    const chars = body.filter((i) => within(i.cx, grid.kindLeft, grid.kindRight) && within(i.cy, y0, y1));
    kinds.push({ y0, y1, text: joinVertical(chars).replace(/\s+/g, "") });
  }
  const rows: VotePdfRow[] = [];
  for (let r = 0; r + 1 < grid.rowLines.length; r++) {
    const y1 = grid.rowLines[r];
    const y0 = grid.rowLines[r + 1];
    const inRow = body.filter((i) => within(i.cy, y0, y1));
    if (inRow.length === 0) continue; // 空の行（余白）
    const numberTitleItems = inRow.filter((i) => within(i.cx, grid.kindRight, grid.resultLeft));
    // 「＜令和8年度議案＞」の行は年度の区切り。表決の行ではない（議員の列の「年度」の飾り文字も読まない）
    if (MARKER.test(joinText(numberTitleItems))) continue;
    // 議案等番号と件名の境の縦線（この行を横切る、議案等名の中の最初の縦線）。番号は左（「議第」「61」「号 件名…」の
    // 「号 件名…」は 1 アイテムに結合されていることがあるので、アイテムの左端 x で分ける）、件名は右
    const numberRight = grid.bodyVlines
      .filter((l) => l.x > grid.kindRight + EPS && l.x < grid.resultLeft - EPS && l.y0 <= y0 + 2 && l.y1 >= y1 - 2)
      .map((l) => l.x)
      .sort((a, b) => a - b)[0];
    if (numberRight === undefined) throw new Error(`${label} row ${r + 1}: 議案等番号/件名 rule not found`);
    const numberText = joinText(numberTitleItems.filter((i) => i.x < numberRight));
    const m = numberText.match(NUMBER);
    if (!m) throw new Error(`${label} row ${r + 1}: "${numberText}" does not start with 議第/報第/第N号`);
    const number = `${m[1]}${m[2]}号`.normalize("NFKC");
    const title = m[3] + joinText(numberTitleItems.filter((i) => i.x >= numberRight));
    const rowLabel = `${label} row ${r + 1} (${number})`;
    if (title === "") throw new Error(`${rowLabel}: title is empty`);
    const result = joinText(inRow.filter((i) => within(i.cx, grid.resultLeft, grid.voteCols[0])));
    if (result === "") throw new Error(`${rowLabel}: 議決結果 is empty`);
    const mid = (y0 + y1) / 2;
    const kind = kinds.find((k) => within(mid, k.y0, k.y1));
    if (!kind || kind.text === "") throw new Error(`${rowLabel}: 種別（結合セル） not found`);
    // 表決のセル: 各議員の列に、この行の文字がちょうど 1 つ入るときだけ採用
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
      if (hits[c].length === 1 && hits[c][0].str.trim().length === 1) cells[c] = hits[c][0].str.trim();
    }
    // 境界上の文字: 隣り合う列のどちらか分からないので両方を不明にする
    for (const it of unplaced) {
      for (let c = 0; c < memberCount; c++) {
        if (it.cx >= grid.voteCols[c] - EDGE && it.cx <= grid.voteCols[c + 1] + EDGE) cells[c] = UNKNOWN_CELL;
      }
    }
    rows.push({ page: pageNo, kind: kind.text, number, title, result, cells });
  }
  return rows;
}
