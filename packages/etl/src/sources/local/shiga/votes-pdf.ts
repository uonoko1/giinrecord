import { bandIndex, cluster, EDGE, EPS, joinVertical, readPages, within, type Item, type PageGeometry } from "../pdf-table.ts";
import { legendKey } from "../glyph-variants.ts";

/**
 * 滋賀県議会「議案等賛否一覧」PDF の表復元（Issue #741）。1 本会議日に 1 本、1 会期に複数本。
 *
 * レイアウト（A4 横。1 ページ目に見出し・凡例・会派帯・議席番号帯・氏名帯、その下に議案の行）:
 *   見出し: 「８月10日議決分」／「議案等賛否一覧」／凡例の文
 *   表の左: 議案等番号（件名を兼ねる。折り返しあり）｜議決日（8/10）｜出席者数｜表決者数｜賛成数｜反対数｜議決結果
 *   表の右: 議員 1 人 1 列。上から 会派帯（結合セル）→ 議席番号帯 → 氏名帯（縦書き 1 文字 1 アイテム）
 *
 * ## 記号帯の読み方（**ここが滋賀の全部**。#689 / #694 / #705 / #718 の実測に従う）
 *
 * **記号のアイテムの形が会期で 3 通りある**（147 本の実測、#718 の分類）:
 *   - **行アイテム型 86 本**: 1 行の記号が 1 アイテムに入る（`"○ ○ … ○"` が 44 文字）
 *   - **1 文字 1 アイテム型 58 本**: 記号が 1 個ずつ別アイテム
 *   - **文字層なし 3 本**: 画像 PDF。**読めないのが正しい結果**（`Kg265_250424`・`Kg274_250628`・`Kg337_sanpi-261127`）
 *
 * **この 2 つを 1 つの規則で扱う。** 記号帯は「表の行の中にある、末尾が記号の連なりで終わるアイテム」の集まりで、
 * 帯の記号の総数 n が議員の列の数と一致するときだけ置く（合わなければ全部 UNKNOWN_CELL）。
 *
 * ### 落とし穴 1: **記号 10 個以上のアイテムだけを行と見てはいけない**（#705）
 * **8 本・32 行で記号帯が 2 アイテムに割れ、割れ目に `議`（議長）が 1 文字だけ立つ:**
 *   `"○ ○ … ○"(20) + "議"(別アイテム) + "○ ○ … ○"(26)` ＝ 議員 47 名
 * **10 個以上で選ぶと `議` が落ち、その列の議員の記録が丸ごと消える**（`Kg229_240711` の `佐野高典`）。
 * **47 名の会期で 46 名しか出なくても合計は 46 で辻褄が合うので、利用者からも検出できない。**
 * だから**行の中の記号アイテムを全部足し合わせてから**列に落とす。
 *
 * ### 落とし穴 2: **型ごとに記号の x の求め方を変える**（#718）
 *   - **1 文字 1 アイテム**: **アイテム自身の `cx`。推定しない**
 *   - **複数記号のアイテム**: **そのアイテムの右端からセル幅ずつ左へ**数える
 * **1 文字型に「行を等分した推定 x」を使うと 10,908 対のうち 192 対がずれる**（#718 の変異 5 で実測）。
 * **左端 + 等分にすると、結果列が混ざる行（`"可決 ○ ○ …"`）で 170 個の記号が置けなくなる**（#705）。
 * **右端基準なら 39 行すべてで置けた**（#741 の実測。結果列が混ざるのは 39 行）。
 *
 * ### 落とし穴 3: **2 ページ目の氏名帯は「空の列だけ」1 ページ目から補う**（#718）
 * `Kg693_sanpi-040318.pdf` の 2 ページ目に、記号が 5 個あるのに氏名が 1 文字も無い列がある
 * （入るのは集計の `"0"` だけ。1 ページ目の同じ x には `角 田 航 也`）。
 * **「氏名帯が空のときだけ」では直らない**——2 ページ目には 41 人ぶんあるので「空」ではない。
 * **借りてよいことは確かめてある**（1・2 ページ目の縦罫線は本数も位置も一致。#705 / #718）。
 *
 * ## 凡例
 * **PDF ごとに読む。2 種類ある**（#694 の実測、121 本と 4 本）:
 *   `「○」は賛成を、「×」は反対を、「議」は議長（表決権なし）、「－」は表決に参加していないことを表す。`
 *   `「-」欠席を、「議」は議長（表決権なし）、「退」は退席を表す。`
 * **同じ `-` の意味が会期で違う**（「表決に参加していない」／「欠席」）ので、**決め打ちしない。**
 * **凡例の無い本もある**（`Kg889_0428sanpi2.pdf`。#670）。そのときは記号の意味を決められないので、
 * **`legend` を空にして全セルの `legend` を UNKNOWN_LEGEND にする**（推定しない。#569）。
 *
 * 方針（既存 7 県と同じ）: 文字の位置を推定で並べ替えない。罫線から列と行の境界を取り、
 * 文字の中心が入るセルにだけ置く。凡例に無い記号は例外ではなく `unknown` として残す（#569）。
 */
export const UNKNOWN_CELL = "不明";
export const UNKNOWN_LEGEND = "抽出不能";

/**
 * 表決の記号とみなす文字（#694 / #718 の実測で 147 本から拾った 10 種）。
 * **これで全部とは言えない**——会期で字形が揺れる（#671）。**ここに無い字が記号の位置に出たら、
 * 帯の記号数が議員数と合わなくなるので、その行は丸ごと UNKNOWN_CELL に落ちる**（黙って別人の票にしない）。
 */
const VOTE_SYMBOLS = new Set([..."○×議〇✕－―ー欠退-"]);
const isVoteSymbol = (c: string): boolean => VOTE_SYMBOLS.has(c);

/**
 * アイテムの末尾に連なる記号（空白は読み飛ばす）。記号で終わらないアイテムは空配列。
 * **`"可決 ○ ○ … ○"` は 44 個を返し、`"「○」は賛成を、…表す。"`（凡例）は 0 個**——
 * 凡例は `。` で終わるので末尾が記号ではない。**本文・討論・会派名も同じ理由で 0 個になる。**
 */
export function trailingVoteSymbols(str: string): string[] {
  const out: string[] = [];
  for (const c of [...str].reverse()) {
    if (isVoteSymbol(c)) out.unshift(c);
    else if (/\s/.test(c)) continue;
    else break;
  }
  return out;
}

export interface VotePdfLegend {
  /** セルの記号 → 凡例の意味（「○」→「賛成」）。凡例の無い PDF では空 */
  votes: Record<string, string>;
  /** 凡例の原文（1 本に複数行あることは無いが、原文を捨てないため配列） */
  notes: string[];
}

export interface VotePdfMember {
  /** 縦書きの氏名を上から並べたもの（「辻 正隆」。空きは半角空白 1 つ） */
  nameText: string;
  /** 会派帯の原文（「自由民主党滋賀県議会議員団」。読めなければ空） */
  group: string;
  /** 議席番号帯の原文（「15」。読めなければ空） */
  seat: string;
}

export interface VotePdfRow {
  page: number;
  /** 議案等番号・件名の欄の原文（折り返しを繋いだもの。滋賀は番号と件名が 1 つの欄） */
  title: string;
  /** 議決日の原文（「8/10」）。ISO には直さない（原文主義。年は見出しから補う） */
  dateText: string;
  /** 出席者数・表決者数・賛成数・反対数（数として読めたときだけ） */
  counts?: { present: number; voting: number; yes: number; no: number };
  /** 議決結果の原文（「可決」「否決」「不採択」「同意」） */
  result: string;
  /** members と同じ順。置けなかったセルは UNKNOWN_CELL */
  cells: string[];
}

export interface VotePdf {
  /** 見出しの「８月10日議決分」の原文 */
  headingText: string;
  /** 見出しの議決日（月・日。年は PDF に無いので会期から補う） */
  month: number;
  day: number;
  legend: VotePdfLegend;
  members: VotePdfMember[];
  rows: VotePdfRow[];
  unknownCells: number;
  pages: number;
}

/** 見出し「８月10日議決分」（全角・半角どちらの数字も来る） */
const HEADING = /([０-９0-9]+)月([０-９0-9]+)日議決分/;
/** 凡例の行（「…を表す。」で終わる。句点が無い本もある） */
const LEGEND_LINE = /^「.+」.*表す。?$/;
/** 凡例の項目「「○」は賛成を、」「「-」欠席を、」（「は」が無い形もある） */
const LEGEND_ITEM = /「(.)」(?:は)?([^、。]+?)(?:を)?(?=[、。]|$)/g;
/**
 * 列見出しの原文（1 アイテムで出るもの）。**本文の行に混じることがある**ので、行を読むときに落とす。
 * 縦書き 1 文字ずつの見出し（`議決日` `議決結果` など）は氏名帯より上にあるので行には入らない。
 */
const COLUMN_HEADERS = new Set(["議案等番号", "件名", "議席番号", "会派名"]);

/** アイテムの末尾に連なる記号（と空白）。`trailingVoteSymbols` と同じ範囲を文字列として切る。 */
const TRAILING_SYMBOL_RUN = /[○×議〇✕－―ー欠退\-\s　]+$/u;

/** 凡例の最後の項目に付く述語（「…を表す。」）。意味には含めない */
const LEGEND_TAIL = /(こと)?を表す$/;

export async function parseVotePdf(bytes: Buffer): Promise<VotePdf> {
  const pages = await readPages(bytes);
  if (pages.length === 0) throw new Error("PDF has no pages");
  if (pages.every((p) => p.items.length === 0)) throw new Error("PDF has no text layer (image PDF)");
  const head = parseHeading(pages);
  const legend = parseLegend(pages);
  let members: VotePdfMember[] | undefined;
  /** 1 ページ目の氏名列（列番号 → 氏名）。後続ページの空の列だけをここから補う（#718） */
  let page1Names: Map<number, VotePdfMember> | undefined;
  const rows: VotePdfRow[] = [];
  for (let p = 0; p < pages.length; p++) {
    // 継続ページには見出しが無いので、1 ページ目の議員の列の数を引き継ぐ。
    // **借りてよいことは確かめてある**（147 本の全ページで縦罫線の本数・位置が一致。#705 / #718）
    const grid = buildGrid(pages[p], p + 1, members?.length);
    if (!grid) continue; // 表の無いページ（討論の一覧だけのページ）
    const pageMembers = readMembers(pages[p], grid, page1Names);
    if (pageMembers.length === 0) continue;
    if (!members) { members = pageMembers; page1Names = new Map(pageMembers.map((m, i) => [i, m])); }
    else if (members.length !== pageMembers.length) throw new Error(`page ${p + 1}: member columns ${pageMembers.length} !== page 1 ${members.length}`);
    rows.push(...readRows(pages[p], grid, p + 1, pageMembers.length));
  }
  if (!members || members.length === 0) throw new Error("no member columns found");
  if (rows.length === 0) throw new Error("no rows found");
  let unknownCells = 0;
  for (const row of rows) unknownCells += row.cells.filter((c) => c === UNKNOWN_CELL).length;
  return { ...head, legend, members, rows, unknownCells, pages: pages.length };
}

/* ---------- heading & legend ---------- */

function parseHeading(pages: readonly PageGeometry[]): { headingText: string; month: number; day: number } {
  for (const page of pages) {
    for (const it of page.items) {
      const m = it.str.match(HEADING);
      if (!m) continue;
      const month = Number(m[1].normalize("NFKC"));
      const day = Number(m[2].normalize("NFKC"));
      if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error(`heading "${it.str}" has a date out of range`);
      return { headingText: it.str.trim(), month, day };
    }
  }
  throw new Error("heading (N月M日議決分) not found");
}

/**
 * 凡例。**PDF に凡例の文が無ければ空**（`votes` が空）。
 * **推定で埋めない**——凡例が無い本では記号の意味が決められないので、全セルが `UNKNOWN_LEGEND` になる（#569）。
 */
export function parseLegend(pages: readonly PageGeometry[]): VotePdfLegend {
  const votes: Record<string, string> = {};
  const notes: string[] = [];
  for (const page of pages) {
    for (const it of page.items) {
      const text = it.str.trim();
      if (!LEGEND_LINE.test(text)) continue;
      notes.push(text);
      for (const m of text.matchAll(LEGEND_ITEM)) {
        const key = m[1];
        const meaning = m[2].replace(LEGEND_TAIL, "").trim();
        if (meaning === "") continue;
        if (key in votes && votes[key] !== meaning) throw new Error(`legend key ${key} appears twice with different meanings (${votes[key]} / ${meaning})`);
        votes[key] = meaning;
      }
    }
  }
  return { votes, notes };
}

/* ---------- grid ---------- */

export interface Grid {
  /** 表の上端（いちばん高い全幅の横罫線） */
  top: number;
  /** 本文の上端（＝氏名帯の下端。表の上端の次に高い全幅の横罫線） */
  bodyTop: number;
  /** 表の下端 */
  bottom: number;
  /** 本文の行境界（降順。[0] が bodyTop、最後が bottom） */
  rowLines: number[];
  /** 表の左端 */
  left: number;
  /** 議員の列の境界（議員数＋1 本）。[0] が議決結果の右＝賛否欄の左端 */
  voteCols: number[];
  /** 左の列の境界（表の左端から賛否欄の左端まで）。数は会期で違う */
  leftCols: number[];
  /** 会派帯・議席番号帯・氏名帯を区切る横罫線（降順。無いページもある） */
  headerLines: number[];
  /** 氏名帯の下端（氏名の文字の中心のいちばん低い y）。氏名帯が無いページは bodyTop */
  nameBottom: number;
}

/**
 * 表の骨格。**全幅（表の左端から右端まで届く）の横罫線**を行の境界とする。
 * 会派帯・議席番号帯の境は議員の列のぶんしか無いので、全幅では拾われない（分けて取る）。
 * 表が無いページ（討論の一覧だけ）は undefined。
 */
function buildGrid(page: PageGeometry, pageNo: number, inherit?: number): Grid | undefined {
  if (page.vlines.length === 0 || page.hlines.length === 0) return undefined;
  const left = Math.min(...page.vlines.map((l) => l.x));
  const vxs = cluster(page.vlines.map((l) => l.x));
  if (vxs.length < 4) return undefined;
  const ys = cluster(page.hlines.map((l) => l.y));
  const extent = ys.map((y) => {
    const segs = page.hlines.filter((l) => Math.abs(l.y - y) <= EPS);
    return { y, x0: Math.min(...segs.map((s) => s.x0)), x1: Math.max(...segs.map((s) => s.x1)) };
  });

  // ---- 議員の列を先に決める（表の右端は議員の列の右端であって、縦線の最大値ではない）----
  // **議員の列の左端 ＝「議決結果」の縦書き見出しの列の右。**
  // **間隔で切ってはいけない**——議決結果の欄の幅（実測 19.0〜20.2pt）は議員の列（10.1〜13.3pt）の
  // 1.5 倍に届かないので、「隣との間隔が中央値の 1.5 倍を超えるまで左へ」だと議決結果の欄まで
  // 議員の列に数えてしまう（実測 28 本でページ間の列数が食い違った）。**見出しの文言で決める。**
  // 継続ページには見出しが無いので、1 ページ目の列の数を引き継ぐ（`inherit`）。
  // 見出しを探す範囲は、まだ bodyTop が決まっていないのでページ全体にする。
  // **「縦線の最大値まで届く横罫線」で窓を作ってはいけない**——表の外側に長い縦線がある本では
  // その窓が表の下の方だけになり、見出しが 1 つも見つからない（実測 4 本）。
  // 「議決結果」という縦書きが列に入るのは見出しの段だけなので、窓は要らない。
  const headerIdx = findHeaderColumn(page, vxs, -Infinity, Infinity, "議決結果");
  const startIdx = headerIdx !== undefined ? headerIdx + 1 : inherit !== undefined ? undefined : undefined;
  let voteCols: number[];
  if (startIdx !== undefined) {
    if (startIdx < 1 || vxs.length - startIdx < 3) return undefined;
    voteCols = vxs.slice(startIdx);
    // **表の右に、議員の列より広い枠線が 1 本ある本がある**（実測。`Kg361_sanpi-270716` は
    // 727.1 の次が 773.1 で幅 46pt ＝ 議員の列 11.3pt の 4 倍）。**この 1 本を議員の列に数えると
    // 記号の個数（44）が列の数（45）と合わなくなり、その本の全セルが不明に落ちる。**
    // 議員の列の幅は 1 本の中では一定なので、**中央値の 1.5 倍を超える幅の列は末尾から落とす**
    // （左は「議決結果」の見出しで決まっているので触らない）。
    voteCols = trimOuterColumns(voteCols);
  } else if (inherit !== undefined) {
    // 継続ページ: 1 ページ目と同じ本数の列を右から取る（**縦罫線の本数・位置が
    // 1 ページ目と一致することは 147 本の全ページで確かめてある**。#705 / #718）
    if (vxs.length < inherit + 2) return undefined;
    const trimmed = trimOuterColumns(vxs);
    if (trimmed.length < inherit + 1) return undefined;
    voteCols = trimmed.slice(trimmed.length - inherit - 1);
  } else return undefined;
  if (voteCols.length < 3) return undefined;
  const right = voteCols[voteCols.length - 1];
  const startAt = vxs.indexOf(voteCols[0]);
  const leftCols = vxs.slice(0, startAt + 1);

  // ---- 行の境界 ----
  // **「議員の列の右端まで届く横罫線」**を行の境とする（左端まで届くとは限らない——議案等番号の欄が
  // 結合セルになっている会期では行の境が左端に届かない。実測 `Kg243_241129-sanpi-new` は
  // 左端まで届く線が 2 本しかなく、その 2 本だけで行を切ると本文の行が 1 本も取れない）。
  // **行の境は「議員の列の右端まで届く横罫線」**（右端は縦線の最大値ではない——表の外側に
  // もう 1 本ある本があるため）。**左端まで届くことは求めない**——議案等番号の欄が結合セルの
  // 会期では行の境が左端に届かない（実測 `Kg243_241129-sanpi-new`）。
  // 会派帯・議席番号帯・氏名帯の境もここに混じるが、**氏名帯は罫線ではなく文字の密度で決める**ので
  // （下の `nameBand`）、混じっていても氏名は取り違えない。
  const wide = extent.filter((e) => e.x1 >= right - 2 && e.x0 <= voteCols[0] + 2).map((e) => e.y).sort((a, b) => b - a);
  if (wide.length < 2) return undefined;
  const top = wide[0];
  const bottom = wide[wide.length - 1];
  // 会派帯・議席番号帯・氏名帯の境は、**議員の列のぶんしか無い**（表の左端まで届かない）。
  // **氏名帯の無いページ（継続ページ）では headerLines が空になる。**
  const headerLines = extent.filter((e) => e.y < top - EPS && e.y > bottom + EPS && e.x0 > left + 2 && e.x1 >= right - 2).map((e) => e.y).sort((a, b) => b - a);
  // **本文の上端 ＝ 氏名帯の下端。** 罫線だけでは決まらない（会期で引き方が違う）ので、
  // **記号のアイテムがいちばん高い位置（＝表の最初の票の行）より上で、最も低い横罫線**を採る。
  // 罫線で決め打つと 2 通りとも外れる:
  //   - 「headerLines の下の全幅の線」→ 氏名帯の下に線が無い本（`Kg243_241129-sanpi-new`）で
  //     表の下端まで飛び、本文の行が 1 本も取れない
  //   - 「headerLines のいちばん下」→ 議席番号帯と氏名帯の境を本文の上端にしてしまい、
  //     氏名の代わりに議席番号を読む（実測 83 本で氏名が `"1"` `"2"` になった）
  // **1 個ずつ数えてはいけない**——列見出しの `議決日` / `議決結果` は 1 文字 1 アイテムの縦書きで、
  // その `議` が「記号で終わるアイテム」に見える。会派帯が割れた `"賀県議"` も同じ（実測 28 本で
  // 氏名の代わりに議席番号を読んだ）。**同じ y にある記号を足して 10 個以上になる帯**だけを票の行と見る。
  const bodyTop = wide.filter((y) => y > topVoteRowY(page, voteCols[0], right) + EPS).sort((a, b) => a - b)[0] ?? top;
  const rowLines = wide.filter((y) => y <= bodyTop + EPS);
  if (rowLines.length < 2) return undefined;
  const nameLow = Math.min(...page.items.filter((i) => [...i.str].length === 1 && within(i.cx, voteCols[0], right) && i.cy > topVoteRowY(page, voteCols[0], right) + EDGE && i.cy < top).map((i) => i.cy), Infinity);
  return { top, bodyTop, bottom, rowLines, left, voteCols, leftCols, headerLines, nameBottom: Number.isFinite(nameLow) ? nameLow : bodyTop };
}

/**
 * 表の外側の枠線を落とす。**議員の列の幅は 1 本の PDF の中では一定**（実測 10.1〜13.3pt）なので、
 * **中央値から大きく外れた幅の列を末尾から落とす。**
 *
 * **外れる方向は両方ある**（実測）:
 *   - **広すぎる**: `Kg361_sanpi-270716` は 727.1 の次が 773.1（幅 46pt ＝ 議員の列 11.3pt の 4 倍）
 *   - **狭すぎる**: `Kg815_1128sanpi-go` は 736.5 の次が 740.9（幅 4.4pt）
 * **どちらも議員の列に数えると、記号の個数が列の数と合わなくなり、その本の全セルが不明に落ちる。**
 */
function trimOuterColumns(cols: readonly number[]): number[] {
  let out = [...cols];
  for (let guard = 0; guard < out.length && out.length > 3; guard++) {
    const widths: number[] = [];
    for (let i = 1; i < out.length; i++) widths.push(out[i] - out[i - 1]);
    const medW = [...widths].sort((a, b) => a - b)[Math.floor(widths.length / 2)];
    const last = out[out.length - 1] - out[out.length - 2];
    if (last > medW * 1.5 || last < medW * 0.5) out = out.slice(0, -1);
    else break;
  }
  return out;
}

/**
 * 票の行のうち、いちばん高い位置にある行の y（同じ y の記号を足して 10 個以上になる帯）。
 * 無ければ -Infinity。**ここで 1 個ずつ数えると列見出しの `議` を拾う**（上の buildGrid の注）。
 */
function topVoteRowY(page: PageGeometry, voteLeft: number, voteRight: number): number {
  const items = page.items.filter((i) => trailingVoteSymbols(i.str).length > 0 && i.cx > voteLeft && i.cx < voteRight + EDGE);
  const byY: { cy: number; h: number; n: number }[] = [];
  for (const it of [...items].sort((a, b) => b.cy - a.cy)) {
    const last = byY[byY.length - 1];
    const n = trailingVoteSymbols(it.str).length;
    if (last && Math.abs(last.cy - it.cy) <= Math.max(it.h, last.h) * 0.5) last.n += n;
    else byY.push({ cy: it.cy, h: it.h, n });
  }
  const hit = byY.find((b) => b.n >= 10);
  return hit ? hit.cy : -Infinity;
}

/**
 * 見出しの段（本文の上端〜表の上端）で、縦書きの見出しが `name` になる列の番号。無ければ undefined。
 * **滋賀の見出しは 1 文字 1 アイテムの縦書き**（「議」「決」「結」「果」が別アイテム）なので、
 * 列ごとに上から繋いでから照合する。**会派帯の文字が同じ列に混じる**ことがある（「会」「派」「名」）ので
 * 「含む」で見る（実測: `議決日※`・`会出席者数`・`名議決結果` のように前後に混じる本がある）。
 */
function findHeaderColumn(page: PageGeometry, vxs: readonly number[], bodyTop: number, top: number, name: string): number | undefined {
  for (let c = 0; c + 1 < vxs.length; c++) {
    const chars = page.items.filter((i) => [...i.str].length === 1 && within(i.cx, vxs[c], vxs[c + 1]) && i.cy > bodyTop && i.cy < top);
    const text = chars.sort((a, b) => b.y - a.y).map((i) => i.str).join("");
    if (text.includes(name)) return c;
  }
  return undefined;
}

/* ---------- members ---------- */

/**
 * 氏名帯（と、そのすぐ上の議席番号帯の上端）。議員の列に入る **1 文字アイテム**を y でまとめ、
 * **いちばん多くの列に文字が入る帯の連なり**を氏名とする。氏名は縦書き 2〜5 文字なので、
 * 同じ列で続く帯をまとめて 1 つの氏名帯にする。見つからなければ undefined（継続ページ）。
 */
function nameBand(page: PageGeometry, grid: Grid): { top: number; bottom: number; seatTop: number } | undefined {
  const left = grid.voteCols[0];
  const right = grid.voteCols[grid.voteCols.length - 1];
  // **`bodyTop` に依らない**——`bodyTop` は罫線から決まるが、罫線の引き方が会期で違う（上の注）。
  // 氏名は「いちばん上の票の行より上」にある 1 文字アイテムの中から、密度で決める。
  const firstRow = topVoteRowY(page, left, right);
  const chars = page.items.filter((i) => [...i.str].length === 1 && within(i.cx, left, right) && i.cy > firstRow + EDGE && i.cy < grid.top);
  if (chars.length === 0) return undefined;
  const bands: { cy: number; h: number; items: Item[] }[] = [];
  for (const it of [...chars].sort((a, b) => b.cy - a.cy)) {
    const last = bands[bands.length - 1];
    if (last && Math.abs(last.cy - it.cy) <= Math.max(it.h, last.h) * 0.6) last.items.push(it);
    else bands.push({ cy: it.cy, h: it.h, items: [it] });
  }
  // 列の数がいちばん多い帯を氏名の 1 文字目の帯とする。
  // **そこから下は、文字が 1 つでもある帯を全部繋ぐ**——氏名は 2〜5 文字で、長さが列ごとに違うので、
  // 下の帯ほど埋まっている列が減る（実測 `Kg229_240711` は 47 → 39 → 11 → 36 → 4 → 47 と上下する）。
  // **「同じくらい埋まっている帯まで」で切ると、氏名の途中で切れて別の氏名になる。**
  const width = (b: { items: Item[] }) => new Set(b.items.map((i) => bandIndex(grid.voteCols, i.cx))).size;
  // **議席番号の帯を先に外す**——議席番号も全列が埋まるので、密度だけで選ぶと
  // 議席番号を氏名として読む（実測 `Kg898_sanpi2-080630` は議席番号も氏名 1 文字目も 41 列で、
  // 密度が同点になる）。**議席番号は全部が数字**で、氏名にはならない
  // （本番の 1,057 名の氏名に数字は 1 文字も無い。`name-match.ts` の実測）。
  const nameBands = bands.filter((b) => b.items.some((i) => !/^[0-9０-９]$/.test(i.str)));
  if (nameBands.length === 0) return undefined;
  const widest = Math.max(...nameBands.map(width));
  if (widest < 2) return undefined;
  // **いちばん広い帯を採ってはいけない**——氏名は縦書きで長さがまちまちなので、
  // 最後の文字の帯（全員ぶんそろう）が 1 文字目の帯より広くなることがある
  // （実測 `Kg898_sanpi2-080630`: 1 文字目 40 列・最後の文字 41 列。`辻󠄀` の幅が 0 で列に入らないため）。
  // **氏名の 1 文字目は「いちばん広い帯とほぼ同じだけ埋まっている帯のうち、いちばん上」**。
  const best = nameBands.findIndex((b) => width(b) >= widest * 0.9);
  const full = width(nameBands[best]);
  const end = nameBands.length - 1;
  const top = Math.max(...nameBands[best].items.map((i) => i.cy));
  const bottom = Math.min(...nameBands[end].items.map((i) => i.cy));
  // 議席番号帯: 氏名帯のすぐ上の帯（数字の帯を外す前の並びで見る。無ければ氏名帯の上端）
  const bestIdx = bands.indexOf(nameBands[best]);
  const seatTop = bestIdx > 0 ? Math.max(...bands[bestIdx - 1].items.map((i) => i.cy)) : top;
  return { top, bottom, seatTop };
}

/**
 * 会派帯（議席番号帯の上〜表の上端）。**結合セル**なので、その段まで届く縦線で区切る。
 * 会派名は**複数アイテムに割れる**（`日本共` / `産党滋` / `賀県議` / `会議員` / `団`。#670）ので、
 * セルの中の文字を上の行から順に繋ぐ。
 */
function readGroups(page: PageGeometry, grid: Grid, seatTop: number): { x0: number; x1: number; name: string }[] {
  const left = grid.voteCols[0];
  const right = grid.voteCols[grid.voteCols.length - 1];
  // **会派帯の下端は罫線で取る**——`seatTop`（議席番号の文字の中心）は罫線より下なので、
  // それを境にすると議員の列の境（議席番号帯の上まで届く）まで会派の境に数えてしまう（実測）。
  const ruleAbove = cluster(page.hlines.map((l) => l.y)).filter((y) => y > seatTop + EDGE && y < grid.top - EPS).sort((a, b) => a - b)[0] ?? seatTop;
  // 会派帯まで届く縦線（議員の列の境は議席番号帯までしか届かない）
  const xs = cluster(page.vlines.filter((l) => l.y1 > ruleAbove + EDGE && l.y0 < grid.top - EDGE).map((l) => l.x))
    .filter((x) => x >= left - EPS && x <= right + EPS);
  const bounds = xs.length >= 2 ? xs : [left, right];
  const out: { x0: number; x1: number; name: string }[] = [];
  for (let g = 0; g + 1 < bounds.length; g++) {
    const name = page.items
      .filter((i) => within(i.cx, bounds[g], bounds[g + 1]) && i.cy > ruleAbove + EDGE && i.cy < grid.top)
      .sort((a, b) => b.y - a.y || a.x - b.x)
      .map((i) => i.str)
      .join("")
      .replace(/[\s　]+/g, "");
    out.push({ x0: bounds[g], x1: bounds[g + 1], name });
  }
  return out;
}

/** 縦書きの列を上から結合（空白は 1 つに寄せる）。 */
const columnText = (chars: readonly Item[]): string => joinVertical([...chars]).replace(/[\s　]+/g, " ").trim();

/**
 * 議員の列。氏名帯（本文の上端〜その上の横罫線）から列ごとに読む。
 * **空の列だけ `page1` から補う**（#718。「氏名帯が空のときだけ」では直らない）。
 * 氏名帯そのものが無いページ（継続ページ。3 本 14 行）も `page1` から全部借りる（#705）。
 */
function readMembers(page: PageGeometry, grid: Grid, page1: Map<number, VotePdfMember> | undefined): VotePdfMember[] {
  const n = grid.voteCols.length - 1;
  // **氏名帯は罫線では決まらない**（会期で引き方が違い、議席番号帯との境が無い本もある）。
  // **議員の列に 1 文字アイテムがいちばん多く入る帯**を氏名帯とする（#718 と同じ決め方）。
  // 議席番号帯はそのすぐ上の帯（数字だけ）。**「最初の帯」にすると氏名の無い列に記号が落ちる**
  // （#718 の変異 7 で 5 → 715 に増えた）。
  const band = nameBand(page, grid);
  const nameTop = band?.top;
  const seatTop = band?.seatTop;
  const nameBottom = band?.bottom ?? grid.bodyTop;
  const groups = seatTop === undefined ? [] : readGroups(page, grid, seatTop);
  const out: VotePdfMember[] = [];
  for (let c = 0; c < n; c++) {
    const x0 = grid.voteCols[c];
    const x1 = grid.voteCols[c + 1];
    const inCol = (i: Item) => within(i.cx, x0, x1);
    const nameText = nameTop === undefined ? "" : columnText(page.items.filter((i) => inCol(i) && i.cy >= nameBottom - EDGE && i.cy <= nameTop + EDGE));
    const seat = seatTop === undefined ? "" : columnText(page.items.filter((i) => inCol(i) && i.cy > nameTop! + EDGE && i.cy <= seatTop + EDGE)).replace(/[\s　]+/g, "");
    const group = groups.find((g) => within((x0 + x1) / 2, g.x0, g.x1))?.name ?? "";
    const borrowed = page1?.get(c);
    // **空の列だけ**借りる（#718。「氏名帯が空のときだけ」では直らない——
    // `Kg693_sanpi-040318` の 2 ページ目には 41 人ぶんあるので「空」ではなく、欠けるのは 1 列だけ）。
    //
    // **ただし、いまの設計ではこの枝は 1 度も走らない**（実測 147 本。この行を消しても
    // 144 本の出力が 1 バイトも変わらない）。**議員の並びは 1 ページ目から取ってそれ以降は使わない**
    // （`parseVotePdf` の `if (!members) members = pageMembers`）ので、
    // 2 ページ目の欠けた氏名帯はそもそも出力に届かない。**#718 の欠落はそちらで防げている。**
    //
    // **それでも残す**——`parseVotePdf` の側が「ページごとに氏名を取り直す」形に変わった瞬間に
    // #718 の欠落が復活するし、そのときこの枝が無ければ**議員 1 人の記録が静かに消える**
    // （合計の辻褄は合うので気づけない）。**守りは、効いていないときも外さない。**
    if (nameText === "" && borrowed) out.push({ ...borrowed });
    else out.push({ nameText, group, seat });
  }
  return out;
}

/* ---------- rows ---------- */

/** 文字を上の行から順に、行の中は左から結合（空白は除く）。 */
const joinText = (chars: readonly Item[]): string =>
  [...chars].sort((a, b) => b.y - a.y || a.x - b.x).map((c) => c.str).join("").replace(/[\s　]+/g, "");

function readRows(page: PageGeometry, grid: Grid, pageNo: number, memberCount: number): VotePdfRow[] {
  const rows: VotePdfRow[] = [];
  const voteLeft = grid.voteCols[0];
  const voteRight = grid.voteCols[grid.voteCols.length - 1];
  const vxs = cluster(page.vlines.map((l) => l.x));
  for (let r = 0; r + 1 < grid.rowLines.length; r++) {
    const y1 = grid.rowLines[r];
    const y0 = grid.rowLines[r + 1];
    // **いちばん上の行には列見出しが混ざる会期がある**（実測 15 本。氏名帯の下に罫線が無いので
    // 見出しが最初の行と同じ帯に入る。`議案等番号` は氏名帯より**下**に置かれている本もあるので、
    // 位置では切れない）。**見出しの文言そのもので落とす**——`議案等番号` は議案の件名ではなく、
    // この PDF が必ず使う列見出しの原文である。落とさないと件名が `議案等番号議第109号…` になる。
    // 列見出しは 2 通りの形で最初の行に混ざる（実測 15 本。氏名帯の下に罫線が無い会期）:
    //   - 1 アイテムの横書き（`議案等番号`）→ 文言で落とす
    //   - 1 文字ずつの縦書き（`議決結果` の `議` `決` `結` `果`）→ **氏名帯と同じ高さにある**ので、
    //     氏名帯の下端より上にある 1 文字アイテムを落とす（議案の値は氏名帯より下にある）
    const inRow = page.items.filter((i) => within(i.cy, y0, y1)
      && !COLUMN_HEADERS.has(i.str.replace(/[\s　]+/g, ""))
      && !([...i.str].length === 1 && i.cy >= grid.nameBottom - EDGE));
    if (inRow.length === 0) continue;
    const cells = readVoteCells(inRow, grid, vxs, memberCount);
    if (!cells) continue; // 記号帯の無い行（表題・注記の行）
    // 左の欄。列の数は会期で違うので、右から数える:
    //   [..., 議決日, 出席者数, 表決者数, 賛成数, 反対数, 議決結果] の 6 欄が賛否欄の左に並ぶ
    const lc = grid.leftCols;
    // **賛否欄まで伸びているアイテムは左の欄から除く**——記号帯が議決結果の欄から始まる本では
    // アイテムの中心 `cx` が議決結果の欄に入り、`可決○○○…` のような値になる。
    // **「記号で終わるアイテム」で除いてはいけない**——件名の `特別委員会設置動議` が
    // `議` で終わるので件名が丸ごと消える（実測 12 行）。**位置で除く。**
    const leftItems = inRow.filter((i) => trailingVoteSymbols(i.str).length === 0 || i.x + i.w <= voteLeft + EDGE);
    const leftText = (a: number, b: number) => joinText(leftItems.filter((i) => within(i.cx, a, b)));
    const nLeft = lc.length - 1;
    // 議案等番号・件名は左端から「議決日」の左まで
    const dateIdx = nLeft - 6;
    const title = dateIdx >= 1 ? leftText(lc[0], lc[dateIdx]) : leftText(lc[0], lc[Math.max(0, nLeft - 1)]);
    const dateText = dateIdx >= 0 ? leftText(lc[dateIdx], lc[dateIdx + 1]) : "";
    // **議決結果が記号のアイテムに入っている会期がある**（実測 `"可決 ○ ○ … ○"`。#694 の
    // 「結果列が記号と同じアイテムに入る型」）。**その場合、議決結果の欄には何も無い**ので、
    // 記号アイテムの先頭（記号でない部分）から取る。**推定ではない**——原文がそこにある。
    const resultCell = leftText(lc[nLeft - 1], lc[nLeft]);
    const result = resultCell !== "" ? resultCell : resultFromSymbolItems(inRow, grid);
    // 出席者数・表決者数・賛成数・反対数は **1 アイテムにまとまることがある**（`"44 43 43"` ＋ `"0"`）。
    // **空白を潰してから数字を取り出してはいけない**——`"44 43 43"` ＋ `"0"` が `"4443430"` になる。
    // 区切りを残したまま並べて、数字の列として読む。
    const numsText = dateIdx >= 0
      ? [...inRow.filter((i) => within(i.cx, lc[dateIdx + 1], lc[nLeft - 1]))].sort((a, b) => b.y - a.y || a.x - b.x).map((i) => i.str).join(" ").replace(/[^\d]/g, " ").trim()
      : "";
    const nums = numsText === "" ? [] : numsText.split(/\s+/).map(Number);
    const counts = nums.length === 4 && nums.every((v) => Number.isInteger(v)) ? { present: nums[0], voting: nums[1], yes: nums[2], no: nums[3] } : undefined;
    rows.push({ page: pageNo, title, dateText, ...(counts ? { counts } : {}), result, cells });
  }
  return rows;
}

/**
 * 記号のアイテムに混ざった議決結果の原文（`"可決 ○ ○ … ○"` の `可決`）。無ければ空。
 * **記号のアイテムの、末尾の記号の連なりより前**を取るだけ（推定はしない）。
 * `"44 43 19 24 不採択 × × …"` のように集計数も混ざる形があるので、**数字は落とす**
 * （数字は別に `counts` として読んでいる）。
 */
function resultFromSymbolItems(inRow: readonly Item[], grid: Grid): string {
  const voteLeft = grid.voteCols[0];
  for (const it of [...inRow].sort((a, b) => a.cx - b.cx)) {
    const cs = trailingVoteSymbols(it.str);
    if (cs.length === 0) continue;
    if (it.x > voteLeft + EDGE) continue; // 記号帯が賛否欄から始まる＝結果は混ざっていない
    if (it.x + it.w <= voteLeft + EDGE) continue; // 賛否欄に届かない＝件名の `…動議` などで記号ではない
    // **末尾の記号の連なりには空白が挟まる**（`"可決 ○ ○ … ○"`）ので、
    // **記号の個数だけ後ろから切り落としてはいけない**（空白のぶん足りず、記号が結果に残る）。
    // 末尾から「記号と空白だけ」の部分を正規表現で落とす。
    const head = it.str.replace(TRAILING_SYMBOL_RUN, "");
    const text = head.replace(/[0-9０-９]/g, " ").replace(/[\s　]+/g, "");
    if (text !== "") return text;
  }
  return "";
}

/**
 * この行の記号帯 → 議員ごとのセル。記号帯が無ければ undefined（表の行ではない）。
 *
 * **行の中の「末尾が記号で終わるアイテム」を全部足し合わせる**（割れた帯も、1 文字の `議` も拾う。#705）。
 * **記号の総数が議員の列の数と一致しなければ、全セルを UNKNOWN_CELL にする**——
 * **数が合わない行を押し込むと、ずれた 1 列ぶん全員が別人の票になる**（#689）。
 */
export function readVoteCells(inRow: readonly Item[], grid: Grid, vxs: readonly number[], memberCount: number): string[] | undefined {
  const voteLeft = grid.voteCols[0];
  const voteRight = grid.voteCols[grid.voteCols.length - 1];
  const symItems = inRow.filter((i) => trailingVoteSymbols(i.str).length > 0 && i.x + i.w > voteLeft && i.cx < voteRight + EDGE);
  if (symItems.length === 0) return undefined;
  const total = symItems.reduce((s, i) => s + trailingVoteSymbols(i.str).length, 0);
  if (total < 10) return undefined; // 表の行ではない（注記など）
  const cells: string[] = new Array(memberCount).fill(UNKNOWN_CELL);
  if (total !== memberCount) return cells; // 数が合わない＝置かない（推定しない）
  const cellW = (voteRight - voteLeft) / memberCount;
  // 記号の x: 1 文字だけのアイテムは実 cx（推定しない。#718）、
  // 複数記号のアイテムは**その右端からセル幅ずつ左へ**（左端 + 等分だと結果列混在の行で破綻する。#705）
  const marks: { cx: number; ch: string }[] = [];
  for (const it of symItems) {
    const cs = trailingVoteSymbols(it.str);
    if (cs.length === 1 && [...it.str].every((c) => isVoteSymbol(c) || /\s/.test(c))) { marks.push({ cx: it.cx, ch: cs[0] }); continue; }
    const r = it.x + it.w;
    for (let k = 0; k < cs.length; k++) marks.push({ cx: r - cellW * (cs.length - k - 0.5), ch: cs[k] });
  }
  marks.sort((a, b) => a.cx - b.cx);
  for (const m of marks) {
    const c = bandIndex(grid.voteCols, m.cx);
    if (c === undefined) continue; // 境界上＝どちらの列か分からない（UNKNOWN_CELL のまま）
    // 1 つの列に 2 個入ったら、その列は決められない
    cells[c] = cells[c] === UNKNOWN_CELL ? m.ch : UNKNOWN_CELL;
  }
  return cells;
}

/** セルの原文 → 凡例の意味。凡例に無ければ UNKNOWN_LEGEND（例外にしない＝読めた票は残す。#569） */
export function legendOf(raw: string, votes: Record<string, string>): string {
  if (raw === UNKNOWN_CELL) return UNKNOWN_LEGEND;
  return votes[legendKey(raw)] ?? UNKNOWN_LEGEND;
}
