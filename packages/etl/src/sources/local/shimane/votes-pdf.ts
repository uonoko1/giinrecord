import { cluster, joinVertical, readPages, type Item } from "../pdf-table.ts";

/**
 * 島根県議会「議員別採決結果一覧」PDF の表復元（Issue #221）。
 *
 * この PDF には罫線がベクタで入っているが、引かれているのは「用紙全体の格子」だけで
 * 1 議案 1 行の高さとは一致しない（件名が 2 行の議案・付託委員会が 4 つの議案は行が高い）。
 * そこで罫線ではなく文字の位置で表を復元する。手がかりは次のとおりで、どれも推定ではなく PDF に書かれている:
 *   - 列: 議員の欄は等間隔（約 11.9pt）の縦書き 1 文字幅。1 ページ目の氏名の x をまとめたものが議員の列。
 *         左側は 議案番号 / 件名 / 付託委員会 / 採決結果 / 賛成 / 反対 の 6 列で、x の範囲が決まっている。
 *   - 行: 議案番号の欄（1 議案に 1 つ、行の中心）を行の基準にする。件名・票のセルもその中心に揃っている。
 *         付託委員会は 1 議案に複数（最大 4）あり、等間隔に積まれたブロックの中心が行の中心に揃う
 *         （＝ブロックごとにまとめてから、中心が最も近い議案番号の行に入れる）。
 * 「議⾧」「除斥」は 1 セルの中の縦書き 2 文字なので、同じ列の近い y をまとめて 1 つのセルにする。
 * どの行にも置けない文字が出たら、そのセルは UNKNOWN_CELL（「不明」）にして数える（推定しない）。
 *
 * 議決日はこの PDF に書かれていないので、同じ会期ページの「議決結果一覧」PDF（parseResultsPdf）から
 * 議案番号ごとに読む。請願・その他表決は議決結果一覧に載らないので、呼ぶ側（rollcalls.ts）が会期の最終議決日を使う。
 */

/** 置けなかったセルの原文（推定しない）。 */
export const UNKNOWN_CELL = "不明";
/** 置けなかったセルの凡例。 */
export const UNKNOWN_LEGEND = "抽出不能";

export interface VoteRow {
  /** 節見出しの原文から「（）」を外したもの（「議案」「請願」「その他表決」） */
  kind: string;
  /** 議案等番号の原文（「第77号」「承認第3号」「議員提出第4号」「請願第17号」。番号の無い行は原文の「ー」） */
  number: string;
  /** 件名の原文（複数行は詰めて 1 つに） */
  title: string;
  /** 付託委員会の原文（複数付託はページの並び順。付託を省略した議案は原文の「ー」だけ） */
  referredCommittees: string[];
  /** 採決結果の原文（「原案可決」「同意」「承認」「採択」「不採択」「決定」「許可」） */
  result: string;
  /** PDF の賛成者数・反対者数（cells から数え直さない） */
  counts: { yes: number; no: number };
  /** 各議員の表決の原文（members と同じ並び。置けなければ UNKNOWN_CELL） */
  cells: string[];
  page: number;
}

export interface VotePdf {
  /** 1 ページ目の見出しの原文（「第４９９回島根県議会（令和８年６月定例会）採決結果」） */
  title: string;
  /** 議員の氏名（PDF の列順。縦書きを上から結合したもの） */
  members: string[];
  /** 凡例の原文（記号 → 意味）。PDF ごとに読む */
  legend: Map<string, string>;
  /** 凡例以外の注記の原文（付託委員会欄の「－」・議長は採決に加わらない・請願の賛否の対象 …）。落とさない */
  notes: string[];
  rows: VoteRow[];
  /** 置けなかったセルの数 */
  unknownCells: number;
}

/** 左側の列（x の範囲）。PDF のヘッダ（議案番号 / 件 名 / 付託委員会 / 採決結果 / 賛成 / 反対）の位置から。 */
const NUMBER_X = [30, 85] as const;
const TITLE_X = [85, 262] as const;
const REFERRED_X = [262, 335] as const;
const RESULT_X = [335, 371] as const;
const YES_X = [371, 390] as const;
const NO_X = [390, 402] as const;

/** 凡例の行（「○」･･･賛成、…）。 */
const LEGEND_LINE = /「(.+?)」\s*[･・.]{2,}\s*([^、。]+)/g;
/** 節見出し（議案）（請願）（その他表決）。 */
const SECTION = /^[（(](.+?)[）)]$/;
/** 見出し（第499回…採決結果）。 */
const TITLE_LINE = /^第.+回島根県議会（.+）採決結果$/;
/** 表の下の注記（「※請願17、29号の「賛成・反対」は…」）。セルではないので notes に移す。 */
const FOOTNOTE = /^※/;
/** 議長の欄（「議⾧」。長は U+2FE7 の異体字で書かれている）。 */
const GICHO_CELL = /^議[長⾧]$/;
/** 議長は採決に加わらない、という注記（凡例の記号一覧には「議⾧」が無いので、これを凡例の根拠にする）。 */
const GICHO_NOTE = /議[長⾧]の職務を行う者は採決に加わりません/;

/** 縦書きのセル（議⾧・除斥）をまとめる距離。1 文字ぶん（約 11.4pt）より少し大きく。 */
const CELL_GAP = 13;
/** 付託委員会のブロックをまとめる距離（1 行ぶんの行送り）。 */
const BLOCK_GAP = 13;

const inX = (it: Item, [lo, hi]: readonly [number, number]): boolean => it.x >= lo && it.x < hi;

/** テキストを詰める（PDF の行内の空白は落とす。原文の文字は変えない）。 */
const joinText = (items: Item[]): string => [...items].sort((a, b) => b.y - a.y || a.x - b.x).map((i) => i.str).join("").replace(/\s+/g, "");

export async function parseVotePdf(bytes: Buffer): Promise<VotePdf> {
  const pages = await readPages(bytes);
  if (pages.length === 0) throw new Error("empty PDF");

  // 議員の列: 票の欄の x にある縦書きの氏名。氏名は 1 ページ目のヘッダ（付託委員会の行）をまたいで
  // 下にも伸びる（姓が上、名が下）ので、境目はヘッダではなく「一番上の票の行」より上とする。
  // 見出し・凡例・注記も同じ x にあるが、そちらは 1 アイテムに長い文字列が入っているので 1 文字かどうかで分ける。
  const head0 = pages[0].items.find((i) => i.str === "付託委員会");
  if (!head0) throw new Error("page 1: 付託委員会 header not found");
  const topVoteY = Math.max(...pages[0].items.filter((i) => i.x >= NO_X[1] && (i.str === "○" || i.str === "●")).map((i) => i.y));
  if (!Number.isFinite(topVoteY)) throw new Error("page 1: no ○/● vote cell found");
  const isNameChar = (i: Item): boolean => i.x >= NO_X[1] && i.y > topVoteY + 6 && [...i.str].length === 1;
  const nameItems = pages[0].items.filter(isNameChar);
  if (nameItems.length === 0) throw new Error("page 1: no member name column found");
  const colX = cluster(nameItems.map((i) => i.x), 2);
  const members = colX.map((x) => joinVertical(nameItems.filter((i) => Math.abs(i.x - x) < 3)).replace(/\s+/g, ""));
  if (members.some((m) => m === "")) throw new Error("page 1: a member column has no name");

  // 見出し・凡例・注記（1 ページ目のヘッダより上のうち、縦書きの氏名 1 文字ではないもの）
  const above = pages[0].items.filter((i) => i.y > head0.y && [...i.str].length > 1).sort((a, b) => b.y - a.y);
  const title = above.map((i) => i.str).find((s) => TITLE_LINE.test(s.replace(/\s+/g, "")))?.replace(/\s+/g, "");
  if (!title) throw new Error("page 1: 採決結果 title not found");
  const legend = new Map<string, string>();
  const notes: string[] = [];
  for (const it of above) {
    const s = it.str;
    if (TITLE_LINE.test(s.replace(/\s+/g, "")) || SECTION.test(s.trim()) || /^令和.+年度$/.test(s.trim())) continue;
    const hits = [...s.matchAll(LEGEND_LINE)];
    if (hits.length > 0) for (const h of hits) legend.set(h[1], h[2].trim());
    else notes.push(s.trim());
  }
  if (legend.size === 0) throw new Error("page 1: legend（「○」･･･賛成 …）not found");

  const rows: VoteRow[] = [];
  let unknownCells = 0;
  let section: string | undefined;
  for (const [pi, page] of pages.entries()) {
    const head = page.items.find((i) => i.str === "付託委員会");
    if (!head) throw new Error(`page ${pi + 1}: 付託委員会 header not found`);
    // 節見出し（（議案）（請願）（その他表決））はヘッダより上にある。無いページは前のページの続き
    for (const it of page.items.filter((i) => i.y > head.y && [...i.str].length > 1).sort((a, b) => b.y - a.y)) {
      const m = it.str.trim().match(SECTION);
      if (m && !/^[０-９0-9]/.test(m[1])) section = m[1];
    }
    if (!section) throw new Error(`page ${pi + 1}: 節見出し（議案）… not found`);
    // ヘッダ行より下がデータ。ヘッダ（付託委員会）の y をそのまま境目にする。
    // 表の下の注記（「※請願17、29号の…」）は表のセルではないので、notes に移してデータから外す。
    const top = head.y - 6;
    const body: Item[] = [];
    for (const i of page.items) {
      if (i.y >= top) continue;
      if (FOOTNOTE.test(i.str)) { if (!notes.includes(i.str.trim())) notes.push(i.str.trim()); continue; }
      body.push(i);
    }
    // 行の基準: 議案番号の欄（1 議案に 1 つ）
    const numItems = body.filter((i) => inX(i, NUMBER_X) && i.str.trim() !== "");
    const anchors = cluster(numItems.map((i) => i.y), 4).sort((a, b) => b - a);
    if (anchors.length === 0) continue;
    const nearest = (y: number): number => anchors.reduce((best, a) => (Math.abs(a - y) < Math.abs(best - y) ? a : best), anchors[0]);
    // 行の中心（議案番号の y）が最も近い行へ入れる。件名・採決結果・人数はどれも行の中心に揃っている
    const own = (items: Item[]): Map<number, Item[]> => {
      const map = new Map<number, Item[]>(anchors.map((a) => [a, [] as Item[]]));
      for (const it of items) map.get(nearest(it.y))!.push(it);
      return map;
    };
    const numByRow = own(numItems);
    const titleByRow = own(body.filter((i) => inX(i, TITLE_X)));
    const resultByRow = own(body.filter((i) => inX(i, RESULT_X)));
    const yesByRow = own(body.filter((i) => inX(i, YES_X)));
    const noByRow = own(body.filter((i) => inX(i, NO_X)));

    // 付託委員会: 等間隔に積まれたブロックごとにまとめ、ブロックの中心が最も近い行に入れる
    const refItems = body.filter((i) => inX(i, REFERRED_X)).sort((a, b) => b.y - a.y);
    const refByRow = new Map<number, string[]>(anchors.map((a) => [a, [] as string[]]));
    const blocks: Item[][] = [];
    for (const it of refItems) {
      const last = blocks.at(-1);
      if (last && Math.abs(last.at(-1)!.y - it.y) < BLOCK_GAP) last.push(it);
      else blocks.push([it]);
    }
    for (const b of blocks) {
      const center = (b[0].y + b.at(-1)!.y) / 2;
      refByRow.get(nearest(center))!.push(...b.map((i) => i.str.trim()));
    }

    // 票のセル。縦書きの氏名はヘッダ行より下まで伸びるので、票の欄は「一番上の票の行」より下だけを見る。
    const pageTopVoteY = Math.max(...body.filter((i) => i.x >= NO_X[1] && (i.str === "○" || i.str === "●")).map((i) => i.y));
    if (!Number.isFinite(pageTopVoteY)) throw new Error(`page ${pi + 1}: no ○/● vote cell found`);
    const voteItems = body.filter((i) => i.x >= NO_X[1] && i.y < pageTopVoteY + 6);
    // 1 議案 1 票の欄（○ ●）は行の中心にある
    const markByRow = new Map<number, Map<number, Item>>(anchors.map((a) => [a, new Map<number, Item>()]));
    // 「議⾧」「除斥」は縦書き 2 文字の結合セルで、○ ● の無い行をまとめて覆う（議長は複数の議案にわたって議長のまま）。
    // 列ごとに文字を集めておき、その列で ○ ● の無い行すべてにこのラベルを入れる。
    const labelByCol = new Map<number, Item[]>();
    for (const it of voteItems) {
      const col = colX.findIndex((x) => Math.abs(it.x - x) < 4);
      if (col < 0) { unknownCells++; continue; }
      if (it.str === "○" || it.str === "●") {
        const row = markByRow.get(nearest(it.y))!;
        if (row.has(col)) throw new Error(`page ${pi + 1}: two vote marks in one cell (col ${col})`);
        row.set(col, it);
      } else {
        if (!labelByCol.has(col)) labelByCol.set(col, []);
        labelByCol.get(col)!.push(it);
      }
    }
    // 列ごとのラベルを、ラベルの縦の並び（結合セルのブロック）ごとにまとめる
    const labelBlocks = new Map<number, { text: string; y0: number; y1: number }[]>();
    for (const [col, items] of labelByCol) {
      const sorted = [...items].sort((a, b) => b.y - a.y);
      const blocks: Item[][] = [];
      for (const it of sorted) {
        const last = blocks.at(-1);
        if (last && last.at(-1)!.y - it.y <= CELL_GAP) last.push(it);
        else blocks.push([it]);
      }
      labelBlocks.set(col, blocks.map((b) => ({ text: b.map((i) => i.str).join("").replace(/\s+/g, ""), y0: b.at(-1)!.y, y1: b[0].y })));
    }

    for (const a of anchors) {
      const number = joinText(numByRow.get(a)!);
      const title = joinText(titleByRow.get(a)!);
      const result = joinText(resultByRow.get(a)!);
      const yesText = joinText(yesByRow.get(a)!).normalize("NFKC");
      const noText = joinText(noByRow.get(a)!).normalize("NFKC");
      const referredCommittees = refByRow.get(a)!;
      if (number === "") throw new Error(`page ${pi + 1} y=${a.toFixed(0)}: 議案番号 is empty`);
      if (title === "") throw new Error(`page ${pi + 1} ${number}: 件名 is empty`);
      if (result === "") throw new Error(`page ${pi + 1} ${number}: 採決結果 is empty`);
      if (referredCommittees.length === 0) throw new Error(`page ${pi + 1} ${number}: 付託委員会 is empty`);
      if (!/^\d+$/.test(yesText) || !/^\d+$/.test(noText)) throw new Error(`page ${pi + 1} ${number}: 賛成/反対 "${yesText}"/"${noText}" is not a number`);
      const marks = markByRow.get(a)!;
      const cells = colX.map((_, col) => {
        const mark = marks.get(col);
        if (mark) return mark.str;
        // ○ ● が無い行は、その列の結合セル（議⾧・除斥）が覆っている。行を挟むブロックを選ぶ
        const blocks = labelBlocks.get(col) ?? [];
        const hit = blocks.filter((b) => b.y0 - CELL_GAP <= a && a <= b.y1 + CELL_GAP);
        if (hit.length === 1) return hit[0].text;
        if (hit.length === 0 && blocks.length === 1) return blocks[0].text;
        // どのラベルが覆うのか決まらなければ置かない（推定しない）
        unknownCells++;
        return UNKNOWN_CELL;
      });
      rows.push({ kind: section, number, title, referredCommittees, result, counts: { yes: Number(yesText), no: Number(noText) }, cells, page: pi + 1 });
    }
  }
  if (rows.length === 0) throw new Error("no rows found in the PDF");
  // 「議⾧」のセルは凡例の記号一覧（○ ● 棄権 － 除斥）には無く、注記に
  // 「議⾧の職務を行う者は採決に加わりません」と書かれている。凡例に無いセルは扱えない（rollcalls.ts が例外にする）ので、
  // その注記が言っている意味を凡例として登録する（推定ではなく PDF に書かれていること）。
  const gicho = [...new Set(rows.flatMap((r) => r.cells))].filter((c) => GICHO_CELL.test(c));
  if (gicho.length > 0) {
    if (!notes.some((n) => GICHO_NOTE.test(n))) throw new Error(`cell "${gicho[0]}" appears but the 議⾧ note is missing`);
    for (const c of gicho) legend.set(c, "議長");
  }
  return { title, members, legend, notes, rows, unknownCells };
}

/* ---------- 議決結果一覧 PDF（議決日を読むためだけに使う） ---------- */

export interface ResultRow {
  /** 議決日（ISO） */
  date: string;
  /** 議決結果の原文（「原案可決」「承認」「同意」） */
  result: string;
}

/** 「第77号議案 … （７月２日 原案可決）」の行。議員提出議案は「議員提出 第４号議案」。 */
const RESULT_LINE = /^(承認第|議員提出第|第)([0-9]+)号議案.*[（(]([0-9]{1,2})月([0-9]{1,2})日\s*([^）)]+)[）)]/;
/** 「知事提出議案（令和８年６月９日提出）」の年。議決日の年に使う。 */
const YEAR_LINE = /(令和|平成)([0-9]+|元)年[0-9]+月[0-9]+日提出/;

/**
 * 「議決結果一覧」PDF → 議案番号ごとの議決日・議決結果。
 * 議員別採決結果一覧に議決日が書かれていないので、同じ会期ページのこの PDF から読む（取得日で代用しない）。
 * 請願・その他表決はこの PDF に載らない（呼ぶ側が会期の最終議決日を使う）。
 */
export async function parseResultsPdf(bytes: Buffer): Promise<Map<string, ResultRow>> {
  const pages = await readPages(bytes);
  const out = new Map<string, ResultRow>();
  let year: number | undefined;
  for (const page of pages) {
    const byY = new Map<number, Item[]>();
    for (const it of page.items) {
      const k = [...byY.keys()].find((v) => Math.abs(v - it.y) < 3) ?? it.y;
      if (!byY.has(k)) byY.set(k, []);
      byY.get(k)!.push(it);
    }
    for (const [, items] of [...byY.entries()].sort((a, b) => b[0] - a[0])) {
      const line = [...items].sort((a, b) => a.x - b.x).map((i) => i.str).join("").normalize("NFKC").replace(/\s+/g, "");
      const y = line.match(YEAR_LINE);
      if (y) year = y[1] === "令和" ? 2018 + (y[2] === "元" ? 1 : Number(y[2])) : 1988 + (y[2] === "元" ? 1 : Number(y[2]));
      const m = line.match(RESULT_LINE);
      if (!m) continue;
      if (year === undefined) throw new Error(`議決結果一覧: 提出年 not found before ${line.slice(0, 30)}`);
      const number = `${m[1]}${m[2]}号`;
      const month = Number(m[3]);
      const day = Number(m[4]);
      if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error(`議決結果一覧 ${number}: 議決日 ${month}/${day} out of range`);
      out.set(number, { date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, result: m[5].trim() });
    }
  }
  if (out.size === 0) throw new Error("議決結果一覧: no rows found");
  return out;
}
