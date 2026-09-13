import { cluster, joinVertical, readPages, type Item, type PageGeometry, type RotatedPageGeometry } from "../pdf-table.ts";
import { legendKey } from "../glyph-variants.ts";

/**
 * 青森県議会「議決結果」PDF の表復元（Issue #750）。1 会期 1 本。
 *
 * レイアウト（A4/A3 横。上に会派帯・氏名帯、その下に議案の行）:
 *   見出し: 「令和８年６月」「第３２６回定例会」「議決結果」（ページ上端、3 アイテム）
 *   表の左: 議案等番号｜件名｜議決月日（`6/29`）｜表決方法（`起立`/`簡易`）｜議決結果（`原案可決`）
 *   表の右: 議員 1 人 1 列（縦書き 1 文字 1 アイテム）、さらに右に 賛成者数／反対者数／表決者数
 *   最下段: 凡例 1 行 ＋ 注記 2 行
 *
 * ## **#743 が 56 本 / 118 ページ / 113,911 対で測ったことを、そのまま設計にしている**
 *
 * ### 1. **`/Rotate 90` を打ち消す**（11 本 / 27 ページ）
 * `it.transform[4]/[5]` は回転前の座標なので、**打ち消さないと氏名が横に、行が縦に並ぶ**
 * （#743 の変異 7: 行 2,445 → 2,000、対 113,911 → 92,901、氏名なし 20,864）。
 * **共通層（`pdf-table.ts`）は直さない**（既存 8 県の出力が変わる）。**ここで直す。**
 *
 * ### 2. **議員の列は罫線で決めない。氏名の 1 文字アイテムの x で決める**
 * **最新 4 会期（第322〜325回）には縦罫線が 1 本も無い**（#743 の実測: 322 は縦 0 / 横 0）。
 * **罫線でセルを作る既存 8 県のやり方は、この 4 本に当たらない。**
 * だから**罫線を一切使わず**、氏名帯の 1 文字アイテムの `cx` を `cluster` でまとめて列を作る。
 * **この代替を消すと対が 113,911 → 104,908 に減る**（#743 の変異 9。
 * **`overHalf` は 0 のままなので、母数を見ていなければ「落ちない変異」に見える**）。
 *
 * ### 3. **左端の 1 文字 `議` を議員票として拾わない**（5 会期、#743 の変異 8）
 * 議員の帯（x ≈ 335〜780）の**はるか左**（x ≈ 30〜60）に単独の `議` が立つ
 * （表決方法の欄の「議案」、およびページ端の縦書き）。
 * **拾うとその行の記号が 1 つ増えて全員が 1 列ずれる**——
 * **半セル以上 109,482 / 113,408 対、差の中央 2.00 セル。**
 * **しかも「数は合う」**（`○` の個数と「賛成者数」の突き合わせは通る。#529 が実測）ので、
 * **利用者からも #529 の検算からも見えない。**
 * **だから記号は「氏名の列が張る x の範囲の中」にあるものだけを拾う。**
 *
 * ### 4. **行アイテム型を等分してはいけない**（#743 の変異 6 で 8,155 個ずれる）
 * **記号のアイテムの粒度が 2 通りある**（56 本の実測）:
 *   - **1 文字 1 アイテム型 26 本**: 記号 1 個が 1 アイテム。**`cx` をそのまま使う（推定しない）**
 *   - **行アイテム型 30 本**: `"○ ○ … ○ 45"` が 1 アイテム（**末尾に賛成者数の半角数字が付く会期がある**）
 * **記号も空白も数字も同じ幅と見て等分すると送り幅 9.155pt になるが、実際の列の間隔は 9.393pt**
 * （#743 が第290回で実測）。**46 列ぶんで 1 セル以上ずれる。**
 * **採るのは「半角（ASCII。数字・空白）は全角の半分の送り幅」というモデル**で、
 * **アイテム自身の文字列と `w` だけから決まる**（氏名の x を使っていないので循環しない）。
 * この形での余裕は 113,911 対すべてで半セル未満、**差の最大 0.2832 セル**（#743）。
 *
 * ### 5. **`議` が同じ 1 人であることをアサーションにしない**（#743 の実測で 2 本が落ちる）
 * `306teirei_sanpi.pdf` は 森内之保留（23 行）→ **三橋一三（3 行）**、
 * `322teirei_sanpi.pdf` は 丸井裕（21 行）→ **工藤慎康（最後の 2 行）**。
 * **#529 は「実装するなら必ず置け」と書いていたが、2 本しか開いていなかった。**
 *
 * ### 6. **`副` を未知の記号として落とさない**
 * **凡例（56 本で 1 字も変わらない）にはあるが、56 本のどこにも 1 個も出ない**（#743）。
 * **「56 本には無い」であって「出ない」ではない。**
 *
 * ## **`櫛引ユキ子` の 3 機序**（#749 が 118 列で測った）
 *   ① **`櫛`+U+E0101（IVS）が 2 コードポイントで「1 文字アイテム」から漏れる**（29 個 / 12 本）
 *      → **`[...it.str].length === 1` ではなく「異体字セレクタを除いてから 1 文字か」で見る**
 *        （#749 の対照で **欠落 35 → 6**。**この判定は 8 県すべてを通るので、
 *        既存の `data/` に差分が出ないことを確かめてある**）
 *   ② **`櫛` が文字層に無い**（第300・301回の 6 列）→ **①を直しても残る。直せない**
 *   ③ **`櫛` が `噰`（U+5670）に化ける**（第322〜325回の 10 列）→ `sourceConflict` で捕まる
 * **①②の結果 `引ユキ子` は `nonNameCharacters` / `conflictingRosterNames` / `unmatchedReason` の
 * 3 つすべてを素通りする**（長さが違うので「1 文字違い」に当たらない）。
 * **そこで「同じ列の氏名が、本の中のページで食い違う」ことも見ない**——
 * **氏名は 1 ページ目からしか取らない**ので食い違いようが無い。
 * **残る欠落には `shortName` の理由を付ける**（下の `brokenNames`）。
 *
 * 方針（既存 8 県と同じ）: 文字の位置を推定で並べ替えない。凡例に無い記号は例外ではなく
 * `unknown` として残す（#569）。**数が合わない行は丸ごと `不明`**（推定しない）。
 */
export const UNKNOWN_CELL = "不明";
export const UNKNOWN_LEGEND = "抽出不能";

/**
 * 表決の記号とみなす文字。**凡例の 7 記号そのもの**（`賛否欄：「○」は賛成、…「退」は退席`。
 * 56 本で 1 字も変わらない。#743）。
 * **`副` は 56 本に 1 個も出ないが、凡例にある以上ここに入れる**（未知として落とさない。#750）。
 * **ここに無い字が記号の位置に出たら、帯の記号数が議員の列の数と合わなくなり、
 * その行は丸ごと `不明` に落ちる**（黙って別人の票にはしない）。
 */
const VOTE_SYMBOLS = new Set([..."○×議副除欠退-"]);
/**
 * **凡例に無いが、賛否欄のセルに実在する記号**（実測 2026-09-13）。
 * **`-`（U+002D）が `276_25.11_giketsukekka.pdf` の賛否欄に 40 個ある**（他の 55 本には 1 個も無い）。
 * **7 人目の議員（長 尾 忠 行）の列に立つ。**
 * **凡例に無いので意味を決められない**——`legendOf` が `抽出不能` を返し、`mapped` は付かない（#569）。
 * **落とさずに数える**のは、**落とすと記号の個数が議員の列の数と合わなくなり、
 * その本の 46 行 2,162 セルが丸ごと `不明` になるため**（実際にそうなった）。
 * **「欠席だろう」「表決に参加していないのだろう」と埋めない**——凡例にそう書いていない。
 */
export const UNLISTED_MARKS = new Set([..."-"]);
export const isVoteSymbol = (c: string): boolean => VOTE_SYMBOLS.has(c);

/** 異体字セレクタ（SVS U+FE00–FE0F / IVS U+E0100–E01EF）。`name-match.ts` の `localNameKey` と同じ範囲 */
const VARIATION_SELECTORS = /[︀-️\u{E0100}-\u{E01EF}]/gu;

/**
 * **異体字セレクタを除いて 1 文字か**（#749 の機序 ①）。
 * `櫛`+U+E0101 は `[...str].length === 2` なので、素朴に数えると氏名の 1 文字目が丸ごと落ちる
 * （**56 本中 12 本・29 列**。氏名が `引ユキ子` になり、**3 つの守りをすべて素通りする**）。
 * **幅 0 の異体字セレクタは目に見えない**ので、利用者からは検出できない壊れ方である（#617 と同じ形）。
 */
export const isSingleGlyph = (str: string): boolean => [...str.replace(VARIATION_SELECTORS, "")].length === 1;

export interface VotePdfLegend {
  /** セルの記号 → 凡例の意味（「○」→「賛成」）。凡例の無い PDF では空 */
  votes: Record<string, string>;
  /** 凡例・注記の原文 */
  notes: string[];
}

export interface VotePdfMember {
  /** 縦書きの氏名を上から並べたもの（「田 中 順 造」。空きは半角空白 1 つ） */
  nameText: string;
  /** 会派帯の原文（「自由民主党」。読めなければ空） */
  group: string;
}

export interface VotePdfRow {
  page: number;
  /** 議案等番号の欄の原文（「第 1 号」「№４」。空の行もある） */
  number: string;
  /** 件名の欄の原文（折り返しを繋いだもの） */
  title: string;
  /** 議決月日の欄の原文（「6/29」「継続審査」）。ISO には直さない（原文主義。年は見出しから補う） */
  dateText: string;
  /** 表決方法の欄の原文（「起立」「簡易」「－」） */
  method: string;
  /** 議決結果の欄の原文（「原案可決」「否決」「－」） */
  result: string;
  /** 賛成者数・反対者数・表決者数（数として読めたときだけ） */
  counts?: { yes: number; no: number; voting: number };
  /** members と同じ順。置けなかったセルは UNKNOWN_CELL */
  cells: string[];
}

export interface VotePdf {
  /** 見出しの原文（「令和８年６月 第３２６回定例会 議決結果」） */
  headingText: string;
  /** 見出しから読めた年・月・回次（**無い本がある**ので undefined でありうる。#743） */
  year?: number;
  month?: number;
  round?: number;
  legend: VotePdfLegend;
  members: VotePdfMember[];
  rows: VotePdfRow[];
  unknownCells: number;
  pages: number;
  /** `/Rotate 90` を打ち消したページ数（測定と突き合わせるため） */
  rotatedPages: number;
  /** 縦罫線が 1 本も無かったページ数（第322〜325回。同上） */
  ruleless: number;
}

/** 凡例の行（`賛否欄：「○」は賛成、…「退」は退席`） */
const LEGEND_LINE = /^賛否欄[：:]/;
/** 凡例の項目「「○」は賛成、」「「副」は副議長が議長の職務を代理、」 */
const LEGEND_ITEM = /「(.)」は([^、。]+)/g;
/**
 * 注記の行（**原文を捨てないため `notes` に入れる**）。**2 行ある**（#743 が 56 本で確認）:
 *   `注 ： 欠席とは、採決時に届出により本会議を欠席、早退等していたこと。`
 *   `退席とは、採決時に議場内に不在であったこと。`
 * **2 行目は `注` で始まらない**（1 行目の続き）ので、`^注` だけを見ると落ちる（実装中に落とした）。
 * **`302` と `306` の 2 本だけ、注記 2 行の順序が逆**（#743）。
 */
const NOTE_LINE = /^(注\s*[：:]|(欠席|退席)とは)/;
/** 見出しの年（和暦）。**ページ上端にあるものだけを見る**（議案名「平成29年度青森県証紙…」を拾わないため。#743） */
const HEADING_YEAR = /^(令和|平成|昭和)\s*([０-９0-9]+|元)年\s*([０-９0-9]+)月$/;
/** 見出しの回次「第３２６回定例会」 */
const HEADING_ROUND = /^第\s*([０-９0-9]+)\s*回/;
/** 議決月日「6/29」 */
const DATE_CELL = /^(\d{1,2})\/(\d{1,2})$/;

/* ---------- 回転の打ち消し ---------- */

/**
 * `/Rotate 90` のページの座標を、表示どおりの向き（横長）に直す。
 * PDF の `/Rotate 90` は「時計回りに 90 度回して表示する」意味なので、
 * **表示上の x は PDF の y、表示上の y は（ページ幅 − PDF の x）**になる。
 * 幅と高さは入れ替えない——**文字の `width`/`height` はテキスト行に沿った量**で、
 * 回転してもその文字の送り方向（表示上の x）に沿ったままである（実測: 回転ページでも
 * 縦書きの氏名が 1 文字ずつ別アイテムで `w === h` のまま出る）。
 *
 * **`rotate` が 0 のページは 1 バイトも触らない**（既存 8 県と同じ経路）。
 * **180 / 270 は 56 本に 1 ページも無い**ので、出たら例外にする（黙って間違えた向きで読まない）。
 *
 * **`width` を `page.view[3] - page.view[1]`（高さ）と取り違えても、結果は 1 セルも変わらない**
 * （変異を当てて確かめた。56 本 118 ページ 114,233 セルが 1 つも動かない）。
 * **`flip` は全部の y に同じ定数を足す／引くだけ**で、**この先の計算はすべて相対（帯・列・格子）**
 * だからである。**等価な変異であって、検算が緩いのではない**——
 * **`rotate === 90` を打ち消さない変異は 10 件以上落ちる。**
 */
export function unrotate(page: RotatedPageGeometry): PageGeometry {
  if (page.rotate === 0) return page;
  if (page.rotate !== 90) throw new Error(`unsupported page rotation ${page.rotate}`);
  const width = page.view[2] - page.view[0];
  const flip = (x: number): number => width - x;
  return {
    ...page,
    items: page.items.map((it) => {
      const x = it.y;
      const y = flip(it.x + it.h);
      return { ...it, x, y, cx: x + it.w / 2, cy: y + it.h / 2 };
    }),
    // 縦線（PDF 座標で縦）は表示では横線になり、逆も同じ
    vlines: page.hlines.map((l) => ({ x: l.y, y0: flip(l.x1), y1: flip(l.x0) })),
    hlines: page.vlines.map((l) => ({ y: flip(l.x), x0: l.y0, x1: l.y1 })),
  };
}

/* ---------- 本体 ---------- */

export async function parseVotePdf(bytes: Buffer): Promise<VotePdf> {
  const raw = await readPages(bytes);
  if (raw.length === 0) throw new Error("PDF has no pages");
  if (raw.every((p) => p.items.length === 0)) throw new Error("PDF has no text layer (image PDF)");
  const pages = raw.map(unrotate);
  const head = parseHeading(pages);
  const legend = parseLegend(pages);
  let members: VotePdfMember[] | undefined;
  let band: NameBand | undefined;
  const rows: VotePdfRow[] = [];
  for (let p = 0; p < pages.length; p++) {
    const b = findNameBand(pages[p]);
    if (b) {
      // **議員の並びは 1 ページ目からしか取らない**（後のページの氏名帯で上書きしない）。
      // 後続ページにも氏名帯はあるが、**列の数が食い違ったら例外**（黙って別の並びで読まない）
      const pageMembers = readMembers(pages[p], b);
      if (!members) { members = pageMembers; band = b; }
      else if (members.length !== pageMembers.length) throw new Error(`page ${p + 1}: member columns ${pageMembers.length} !== page 1 ${members.length}`);
    }
    if (!band) continue; // 氏名帯がまだ見つかっていないページ
    // **列の境界はページごとに取り直す**（ページで x が少しずれる本があるため）。
    // 取れなければ 1 ページ目のものを使う
    rows.push(...readRows(pages[p], b ?? band, p + 1));
  }
  if (!members || members.length === 0) throw new Error("no member columns found");
  if (rows.length === 0) throw new Error("no rows found");
  let unknownCells = 0;
  for (const row of rows) unknownCells += row.cells.filter((c) => c === UNKNOWN_CELL).length;
  return {
    ...head,
    legend,
    members,
    rows,
    unknownCells,
    pages: pages.length,
    rotatedPages: raw.filter((p) => p.rotate !== 0).length,
    ruleless: pages.filter((p) => p.vlines.length === 0).length,
  };
}

/* ---------- heading & legend ---------- */

/**
 * ページ上端の見出し（「令和８年６月」「第３２６回定例会」「議決結果」の 3 アイテム）。
 * **年が無い本が 4 本、回次が無い本が 1 本ある**（#743）ので、**無いことは例外にしない**
 * （index の会期見出しから補う。`rollcalls.ts`）。
 * **「議案名に和暦が出る」罠**（`289_sannpi.pdf` の「平成29年度青森県証紙特別会計予算案」）は、
 * **`^(令和|平成|昭和)…年…月$` という完結した形だけを見る**ことで避ける
 * （議案名は `年度` と続くのでこの形にならない）。
 */
function parseHeading(pages: readonly PageGeometry[]): { headingText: string; year?: number; month?: number; round?: number } {
  const page = pages[0];
  // ページのいちばん上の帯（同じ y の並び）を見出しとする
  const top = Math.max(...page.items.map((i) => i.cy), -Infinity);
  if (!Number.isFinite(top)) throw new Error("page 1 has no items");
  const line = page.items.filter((i) => Math.abs(i.cy - top) <= Math.max(i.h, 1)).sort((a, b) => a.x - b.x);
  let year: number | undefined;
  let month: number | undefined;
  let round: number | undefined;
  for (const it of line) {
    const y = it.str.trim().match(HEADING_YEAR);
    if (y) {
      const n = y[2] === "元" ? 1 : Number(y[2].normalize("NFKC"));
      year = y[1] === "令和" ? 2018 + n : y[1] === "平成" ? 1988 + n : 1925 + n;
      month = Number(y[3].normalize("NFKC"));
      if (month < 1 || month > 12) throw new Error(`heading "${it.str}" has a month out of range`);
      continue;
    }
    const r = it.str.trim().match(HEADING_ROUND);
    if (r) round = Number(r[1].normalize("NFKC"));
  }
  return { headingText: line.map((i) => i.str.trim()).join(" ").trim(), ...(year !== undefined ? { year, month } : {}), ...(round !== undefined ? { round } : {}) };
}

/**
 * 凡例。**56 本すべてで 1 字も変わらない**（13 年離れていても同じ。#743）が、
 * **それでも PDF ごとに読む**（決め打ちにすると、文言が変わった会期を黙って古い意味で読む）。
 * **凡例が無い本では `votes` が空になり、全セルの `legend` が `抽出不能` になる**（推定しない。#569）。
 */
export function parseLegend(pages: readonly PageGeometry[]): VotePdfLegend {
  const votes: Record<string, string> = {};
  const notes: string[] = [];
  for (const page of pages) {
    for (const it of page.items) {
      const text = it.str.trim();
      if (NOTE_LINE.test(text)) { if (!notes.includes(text)) notes.push(text); continue; }
      if (!LEGEND_LINE.test(text)) continue;
      if (!notes.includes(text)) notes.push(text);
      for (const m of text.matchAll(LEGEND_ITEM)) {
        const key = m[1];
        const meaning = m[2].trim();
        if (meaning === "") continue;
        if (key in votes && votes[key] !== meaning) throw new Error(`legend key ${key} appears twice with different meanings (${votes[key]} / ${meaning})`);
        votes[key] = meaning;
      }
    }
  }
  return { votes, notes };
}

/* ---------- 氏名帯と議員の列 ---------- */

export interface NameBand {
  /** 氏名帯の上端・下端（文字の中心の y） */
  top: number;
  bottom: number;
  /** 議員の列の境界（議員数 + 1 本）。氏名の 1 文字目の x から作る */
  cols: number[];
  /** 会派帯の下端（＝氏名帯の上）。会派名はここより上 */
  groupBottom: number;
  /** 票の行が張る x の範囲（議員の帯）。左端の stray な `議` はこの外にある */
  left: number;
  right: number;
}

/** 議員の列の x を復元するのに使える 1 文字（記号ではない）か。 */
const isNameChar = (it: Item): boolean => isSingleGlyph(it.str) && !isVoteSymbol(it.str.replace(VARIATION_SELECTORS, "")) && !/^[\s　0-9０-９]$/.test(it.str.replace(VARIATION_SELECTORS, ""));

/** 票の行（同じ y の記号を足して 10 個以上になる帯）。上から順に返す。 */
export function voteRowBands(page: PageGeometry): { cy: number; h: number; items: Item[] }[] {
  const symItems = page.items.filter((i) => trailingVoteSymbols(i.str).length > 0);
  const bands: { cy: number; h: number; items: Item[] }[] = [];
  for (const it of [...symItems].sort((a, b) => b.cy - a.cy)) {
    const last = bands[bands.length - 1];
    if (last && Math.abs(last.cy - it.cy) <= Math.max(it.h, last.h, 1) * 0.5) { last.items.push(it); continue; }
    bands.push({ cy: it.cy, h: it.h, items: [it] });
  }
  return bands.filter((b) => b.items.reduce((s, i) => s + trailingVoteSymbols(i.str).length, 0) >= 10);
}

/**
 * **1 列ぶんきれいに空いている場所に、列を戻す**（**中身は戻さない**）。
 *
 * **なぜ要るか**——**`櫛` が文字層に丸ごと無い本がある**（第300・301回。#749 の機序 ②。
 * **`w=0` のアイテムすら無く、PUA も 0 個なので `〓` にもならない**）。
 * **その列だけ氏名の 1 文字目が無い**ので、列の中心を氏名から作ると **46 列**になるが、
 * **記号は 47 個ある**。**数が合わないので全セルが `不明` に落ちる**（1 本まるごと読めない）。
 * **さらに悪いことに、列が 1 つ詰まるので、その右の議員の氏名が隣とまざる**
 * （実測 300: `山 谷 清ユキ文` `夏 引堀 浩 子一` という、**どちらの議員でもない氏名**ができる）。
 *
 * **戻すのは「列がそこにある」という幾何だけで、氏名は戻さない。**
 * その列の `nameText` は空のまま → **名簿に寄らず `unmatched.json` に落ちる**（#569 のとおり）。
 * **「この列は櫛引ユキ子だろう」と埋めない**——それは推定であり、別人の記録を作る側である。
 *
 * **間隔が中央値の 1.75〜2.25 倍**のときだけ 1 つ戻す（実測の欠けは **ちょうど 2.00 倍**）。
 * **`櫛`+IVS（幅 0）のずれ（0.62 / 1.38 倍の対）は戻さない**——
 * **あれは列が欠けているのではなく中心がずれているだけ**で、戻すと列が 1 つ増えて数が合わなくなる。
 */
export function fillLatticeGaps(centers: readonly number[]): number[] {
  if (centers.length < 4) return [...centers];
  const gaps: number[] = [];
  for (let i = 1; i < centers.length; i++) gaps.push(centers[i] - centers[i - 1]);
  const step = median(gaps);
  const out: number[] = [centers[0]];
  for (let i = 0; i < gaps.length; i++) {
    const k = gaps[i] / step;
    if (k > 1.75 && k < 2.25) out.push(centers[i] + gaps[i] / 2);
    out.push(centers[i + 1]);
  }
  return out;
}

/**
 * **両端から、間隔が外れている列を落とす**（議員の列は 1 本の中で等間隔。実測）。
 *
 * **なぜ要るか**——**氏名帯と同じ高さに、右端の縦書きの列見出し
 * （`賛成者数` `反対者数` `表決者数` の 1 文字目）が並ぶ本がある**
 * （実測 `290_sanpi.pdf`: 氏名は y=505.2・間隔 9.38pt、見出しは y=501.2・間隔 13.9pt。
 * **帯をまとめる許容 0.6×h = 4.32pt に対して差が 4.0pt なので、同じ帯に入ってしまう**）。
 * **そのまま列にすると議員が 47 人になり、記号 46 個と数が合わず、その本の全セルが `不明` に落ちる**
 * （実際にそうなった。落ちるほうに倒れるので別人の票にはならないが、**1 本まるごと読めなくなる**）。
 *
 * **落とすのは両端だけで、途中では切らない**——
 * **`櫛`（U+6ADB + IVS）は幅 0 なので `cx` が半セルぶん左にずれる**（実測 326:
 * 前後の間隔が 14.59 のところ **9.03 / 20.14** になる）。
 * **途中で切ると、この 1 本だけ 46 人が 37 人になる**（実際にそうなった）。
 * **中は信じる**——記号の個数と合わなければ、そのときは行ごと `不明` に落ちる（別人の票にはならない）。
 */
export function trimUnevenEnds(centers: readonly number[]): number[] {
  if (centers.length < 4) return [...centers];
  let out = [...centers];
  for (let guard = 0; guard < centers.length && out.length >= 4; guard++) {
    const gaps: number[] = [];
    for (let i = 1; i < out.length; i++) gaps.push(out[i] - out[i - 1]);
    const step = median(gaps);
    const first = gaps[0];
    const last = gaps[gaps.length - 1];
    // **外れが大きいほうの端**を 1 つ落とす（0.25 は `櫛` のずれ 9.03/14.59 = 0.38 より小さいが、
    // **端のずれだけを見るのでそちらは残る**）
    const dFirst = Math.abs(first - step) / step;
    const dLast = Math.abs(last - step) / step;
    if (dFirst <= 0.25 && dLast <= 0.25) break;
    if (dFirst > dLast) out = out.slice(1);
    else out = out.slice(0, -1);
  }
  return out;
}

const median = (a: readonly number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

/**
 * 氏名帯と議員の列。**罫線を一切使わない**（罫線が無い本が 4 本ある。docblock の 2）。
 * **票の行も使わない**（**行が 2 アイテムに割れる本があり、そちらから帯を決めると帯が右にずれる**。下記）。
 *
 * 手順:
 *   1. **ページの 1 文字アイテム**（記号・数字・空白を除く）を y でまとめて帯にする
 *   2. **両端の外れた列を落とし**（`trimUnevenEnds`）、**1 列ぶん空いた所を戻す**（`fillLatticeGaps`）
 *   3. **いちばん列数の多い帯**を氏名の 1 文字目とし、その x を列の中心にする
 *
 * ## **議員の帯を「票の行の x 範囲」から決めてはいけない**（実装中に踏んだ）
 * **`276_25.11_giketsukekka.pdf` は 46 行中 39 行で記号帯が 2 アイテムに割れる**
 * （`"○ ○ ○ 議 ○ ○ -"` ＋ `"○ ○ … ○ 42"`。**割れ目は 7 人目と 8 人目の間**）。
 * **行の左端の中央値を採ると 404.3**（割れた右側の左端）**になり、先頭 7 人が帯の外に落ちる。**
 * **その結果 40 列の表になり、8 人目以降の票が 1 人目以降に付く**——**これが「別人の記録」である。**
 * **#705 が滋賀で踏んだのと同じ形**（あちらは `議` 1 文字が割れ目に立って議員 1 人が消えた）。
 *
 * **氏名帯から決めれば、割れ方に依らない**（実測: 56 本 118 ページすべてで、
 * 氏名から決めた列の数が、その本の記号の個数と一致する）。
 *
 * ## それでも **左端の 1 文字 `議` は落とさなければならない**（#743 の問題 1）
 * 議員の帯（x ≈ 335〜780）の**はるか左**（x ≈ 30〜60）に単独の `議` が立つ本が 5 つある。
 * **拾うとその行の記号が 1 つ増えて全員が 1 列ずれる**——
 * **半セル以上 109,482 / 113,408 対、差の中央 2.00 セル**（#743 の変異 8）。
 * **しかも「数は合う」**（`○` の個数と「賛成者数」の突き合わせは通る）ので、
 * **利用者からも #529 の検算からも見えない。**
 * **氏名の列が張る x の範囲の外にある記号は拾わない**ことで落とす（`readRows`）。
 */
export function findNameBand(page: PageGeometry): NameBand | undefined {
  const chars = page.items.filter(isNameChar);
  if (chars.length === 0) return undefined;
  const bands: { cy: number; items: Item[] }[] = [];
  for (const it of [...chars].sort((a, b) => b.cy - a.cy)) {
    const last = bands[bands.length - 1];
    // **許容は 0.45×h**。**0.6 では右端の縦書きの列見出し（`賛成者数` の `賛`）が
    // 氏名の帯に入る**（実測 `290_sanpi.pdf`: 氏名 y=505.2 / 見出し y=501.2、差 4.0pt に対して
    // 0.6×7.2 = 4.32pt）。**入ると議員が 47 人になり、記号 46 個と数が合わず、
    // その本の全セルが `不明` に落ちる**（実際にそうなった。0.45×7.2 = 3.24pt で分かれる）
    if (last && Math.abs(last.cy - it.cy) <= Math.max(it.h, 1) * 0.45) last.items.push(it);
    else bands.push({ cy: it.cy, items: [it] });
  }
  const lattices = bands.map((b) => fillLatticeGaps(trimUnevenEnds(cluster(b.items.map((t) => t.cx), 3))));
  let best = -1;
  for (let i = 0; i < lattices.length; i++) if (best < 0 || lattices[i].length > lattices[best].length) best = i;
  if (best < 0 || lattices[best].length < 10) return undefined; // 氏名帯の無いページ
  const centers = lattices[best];
  // **列の境界は中心の中点**（外側は半セルぶん外に伸ばす）
  const step = (centers[centers.length - 1] - centers[0]) / (centers.length - 1);
  const cols: number[] = [centers[0] - step / 2];
  for (let i = 1; i < centers.length; i++) cols.push((centers[i - 1] + centers[i]) / 2);
  cols.push(centers[centers.length - 1] + step / 2);
  const top = Math.max(...bands[best].items.map((t) => t.cy));
  // **氏名帯の下端 ＝ いちばん高い票の行のすぐ上**。
  // **氏名は 2〜5 文字で長さがまちまち**なので、下の帯ほど埋まる列が減り、
  // **途中に列の外の帯（`賛` `反` `表` の 2 文字目など）が挟まる**（実測 275）。
  // **「文字が無くなったら切る」では 1 文字目だけになる**（実際にそうなり、氏名が全部空になった）。
  // **票の行で切る**——票の行より下は議案の行で、氏名ではない。
  const firstVoteRow = topVoteRowY(page, cols[0], cols[cols.length - 1]);
  const below = bands.slice(best + 1).flatMap((b) => b.items).filter((t) => t.cx > cols[0] && t.cx < cols[cols.length - 1] && t.cy > firstVoteRow);
  const bottom = below.length > 0 ? Math.min(...below.map((t) => t.cy)) : top;
  const groupBottom = top + Math.max(...bands[best].items.map((t) => t.h), 1) * 0.6;
  return { top, bottom, cols, groupBottom, left: cols[0], right: cols[cols.length - 1] };
}


/**
 * いちばん高い票の行の y（**議員の列の x 範囲の中**で、同じ y の記号を足して 10 個以上になる帯）。
 * 無ければ -Infinity。**1 個ずつ数えてはいけない**——列見出しの `議決結果` の `議` や
 * 左端の stray な `議` を票の行と見てしまう。
 */
function topVoteRowY(page: PageGeometry, left: number, right: number): number {
  const items = page.items.filter((i) => trailingVoteSymbols(i.str).length > 0 && i.x + i.w > left && i.cx < right);
  const byY: { cy: number; h: number; n: number }[] = [];
  for (const it of [...items].sort((a, b) => b.cy - a.cy)) {
    const last = byY[byY.length - 1];
    const n = trailingVoteSymbols(it.str).length;
    if (last && Math.abs(last.cy - it.cy) <= Math.max(it.h, last.h, 1) * 0.5) last.n += n;
    else byY.push({ cy: it.cy, h: it.h, n });
  }
  const hit = byY.find((b) => b.n >= 10);
  return hit ? hit.cy : -Infinity;
}

/**
 * アイテムの末尾に連なる記号（空白は読み飛ばし、**末尾の半角数字も読み飛ばす**）。
 * **行アイテム型には賛成者数が付く**（`"○ ○ … ○ 45"`）ので、数字で止めると 0 個になる。
 * 凡例（`…「退」は退席`）は `席` で終わるので 0 個。件名の `…動議` は記号で終わるが、
 * **議員の列の x 範囲の外にある**ので拾われない（`readVoteCells`）。
 */
export function trailingVoteSymbols(str: string): string[] {
  const out: string[] = [];
  let sawSymbol = false;
  for (const c of [...str].reverse()) {
    if (isVoteSymbol(c)) { out.unshift(c); sawSymbol = true; continue; }
    if (/[\s　]/.test(c)) continue;
    // **記号より後ろの半角数字（賛成者数）だけ読み飛ばす**。記号を 1 つも見ていない状態でなら飛ばす
    if (!sawSymbol && /[0-9]/.test(c)) continue;
    break;
  }
  return out;
}

/** 縦書きの列を上から結合（空白は 1 つに寄せる）。 */
const columnText = (chars: readonly Item[]): string => joinVertical([...chars]).replace(/[\s　]+/g, " ").trim();

/** 値が区間 [lo, hi) のどこに入るか（`bandIndex` と違い境界を落とさない）。外なら undefined。 */
export function columnOf(cols: readonly number[], v: number): number | undefined {
  if (v < cols[0] || v >= cols[cols.length - 1]) return undefined;
  for (let i = 0; i + 1 < cols.length; i++) if (v >= cols[i] && v < cols[i + 1]) return i;
  return undefined;
}

/**
 * 議員の列（氏名と会派）。
 *
 * ## **会派名は「幅」では取れない**（実測で分かったこと）
 * **会派のラベルは、その会派が覆う列の上に「中央揃え」で 1 アイテム置かれているだけ**で、
 * **アイテムの幅は覆う列の幅ではない**（実測 326: `自由民主党` は 27 人ぶん 400pt の上に
 * **幅 55.41pt** のアイテムが 1 つ置かれている）。
 * **幅から span を作ると、ラベルの真下の 5 人だけが会派を持ち、残り 22 人が空になる。**
 *
 * ## **だから罫線が要る。罫線が無ければ会派は空にする**
 * **会派の境は、氏名帯より上まで伸びる縦罫線**として引かれている（実測 326: 8 会派ぶんの境が
 * 524.4 / 917.5 / 990.4 / 1048.8 / 1092.5 / 1121.7 / 1150.9 / 1165.5 / 1194.6 に立ち、
 * 名簿の会派の内訳 27/5/4/3/2/2/1/2 と一致する）。
 * **罫線が 1 本も無い本が 4 本ある**（第322〜325回。#743）ので、**その 4 本では会派を空にする。**
 * **中央のラベルから「いちばん近い会派」を当てない**——それは推定であり、
 * **会派の境を 1 列間違えれば、その議員の会派が嘘になる**（#569）。
 *
 * **会派名は突き合わせに使っていない**（議員は氏名で名簿と突き合わせる）ので、
 * 空でも別人の記録にはならない。
 *
 * **会派名が複数アイテムに割れる**（`"立憲民主・"` ＋ `"無所属の会"`）ので、
 * **同じ会派のセルに入るアイテムを上の行から順に繋ぐ。**
 */
export function readMembers(page: PageGeometry, band: NameBand): VotePdfMember[] {
  const n = band.cols.length - 1;
  const groups = readGroupCells(page, band);
  const out: VotePdfMember[] = [];
  for (let c = 0; c < n; c++) {
    const x0 = band.cols[c];
    const x1 = band.cols[c + 1];
    const nameText = columnText(page.items.filter((i) => isNameChar(i) && i.cx >= x0 && i.cx < x1 && i.cy >= band.bottom - 0.5 && i.cy <= band.top + 0.5));
    const mid = (x0 + x1) / 2;
    const group = groups.find((g) => mid > g.x0 && mid < g.x1)?.name ?? "";
    out.push({ nameText, group });
  }
  return out;
}

/**
 * 会派のセル（x の範囲と原文）。**氏名帯より上まで伸びる縦罫線**で区切る。
 * **罫線が無ければ空配列**（会派を推定しない。docblock）。
 */
export function readGroupCells(page: PageGeometry, band: NameBand): { x0: number; x1: number; name: string }[] {
  const left = band.cols[0];
  const right = band.cols[band.cols.length - 1];
  // 会派のラベル（氏名帯より上、議員の帯の中にあるアイテム）
  const labels = page.items.filter((i) => i.cy > band.groupBottom && i.x + i.w > left && i.cx < right);
  if (labels.length === 0) return [];
  const labelTop = Math.max(...labels.map((i) => i.cy));
  // **会派の境は「ラベルの上まで届く縦罫線」**。
  // **`groupBottom` を跨ぐだけでは足りない**——**議員の列の境も氏名帯の上まで伸びる本がある**
  // （実測 279・276: 議員 46 本ぶんの境が全部立ち、**会派のセルが 1 人ずつに割れて、
  // ラベルの真下の 1 人だけが会派を持ち、残り 39〜40 人が空になった**）。
  // **ラベルより上まで届くのは会派の境だけ**（実測: 314 で 8 本、279・276 で 7 本、300 で 8 本＝会派の数 + 1）。
  const xs = cluster(page.vlines.filter((l) => l.y1 > labelTop && l.y0 < band.groupBottom).map((l) => l.x))
    .filter((x) => x >= left - 2 && x <= right + 2);
  if (xs.length < 2) return [];
  const out: { x0: number; x1: number; name: string }[] = [];
  for (let g = 0; g + 1 < xs.length; g++) {
    const name = page.items
      .filter((i) => i.cx > xs[g] && i.cx < xs[g + 1] && i.cy > band.groupBottom)
      .sort((a, b) => b.y - a.y || a.x - b.x)
      .map((i) => i.str)
      .join("")
      .replace(/[\s　]+/g, "");
    out.push({ x0: xs[g], x1: xs[g + 1], name });
  }
  return out;
}

/* ---------- 議案の行 ---------- */

/** 文字を上の行から順に、行の中は左から結合（空白は除く）。 */
const joinText = (chars: readonly Item[]): string =>
  [...chars].sort((a, b) => b.y - a.y || a.x - b.x).map((c) => c.str).join("").replace(/[\s　]+/g, "");

/**
 * 議案の行。**行は罫線ではなく「記号の帯」で決める**（罫線が無い本があり、
 * 罫線があっても件名が 2 行の議案で行の高さと一致しない）。
 *   1. 議員の列の x 範囲に掛かる「記号で終わるアイテム」を y でまとめる
 *   2. **記号の総数が議員の列の数と一致するときだけ置く**（合わなければその行は丸ごと `不明`）
 *   3. 左の欄は、その帯の y から次の帯の y までに入るアイテムから読む
 */
function readRows(page: PageGeometry, band: NameBand, pageNo: number): VotePdfRow[] {
  // **記号の帯は「議員の帯の中」にあるものだけで作る**（左端の stray な `議` はここで落ちる）
  const inBand = { ...page, items: page.items.filter((i) => i.x + i.w > band.left && i.cx < band.right) };
  const voteRows = voteRowBands(inBand);
  // **欄の境を先に決める**（罫線が無い本では、行のアイテムの左端を全行ぶん重ねて決めるので、
  // まず票の行の中点で粗く切ったものを渡す）
  const coarse = voteRows.map((b, r) => {
    const yTop = r === 0 ? band.bottom : (voteRows[r - 1].cy + b.cy) / 2;
    const yBottom = r + 1 < voteRows.length ? (b.cy + voteRows[r + 1].cy) / 2 : -Infinity;
    return page.items.filter((i) => i.cy < yTop && i.cy > yBottom && i.x + i.w <= band.left + 1);
  });
  const bounds = leftColumnBounds(page, band, coarse);

  // 行ごとの左の欄のアイテム。
  //
  // **「次の票の行までの全部」を取ってはいけない**——**票の無い議案の行が挟まる**
  // （`継続審査` の行。**表決していないので記号が 1 つも無い**。#529 が第275回で 5 行と数え、
  // 56 本では `275` `279` `giketsukekka_27.09_283` の 3 本にある）。
  // **取ると 2 議案の件名・番号・議決日が 1 行に繋がる**
  // （実測 275: `第11号第12号` / `10/8継続審査` という、**どちらの議案でもない行**ができた）。
  //
  // **行の境を y の帯で切ることもできない**——**件名が番号より上に出る議案がある**
  // （実測 275 第12号: 番号 y=433.0 に対して件名 y=439.0。**1 つ上の票の行は y=454.2**）。
  // **帯で切ると、この件名が 1 つ上の議案の件名に付く。**
  //
  // **議決月日の欄の y を「錨」にする**——**議決月日は 1 議案に 1 つだけ立つ 1 アイテム**で
  // （`11/22` / `継続審査`）、**件名が何行に折り返しても増えない。**
  // **議案等番号では錨にならない**——**番号と件名が 1 アイテムに繋がる本がある**
  // （実測 276: `"第13号 青森県病院事業未処分利益剰余金の処分の件"` が x=47.9 から 1 アイテム。
  // **アイテムの中心が件名の欄に入るので、番号の欄には何も無い**。276 は 46 行中 11 行、287 は 9 行）。
  // **錨が無い行は、その票の行の y を錨にする。**
  const anchors = bounds.length >= 4
    ? [...new Set(page.items.filter((i) => i.cx >= bounds[bounds.length - 4] && i.cx < bounds[bounds.length - 3] && i.cy < band.bottom).map((i) => i.cy))].sort((a, b) => b - a)
    : [];
  // 票の行 → その行の錨（いちばん近い番号の y）。
  // **1 つの番号を 2 つの票の行に付けない**——付けると、番号の無い行が空になり、
  // 隣の行が 2 議案ぶんの件名・議決日を持つ（実測 276: `11/2211/22` という行ができた）。
  // **上から順に、まだ使っていない番号のうちいちばん近いものを取る。**
  // 番号がそもそも無い行は、その票の行の y を錨にする（`276` は 12 行、`287` は 9 行が番号なし）。
  const used = new Set<number>();
  const rowAnchor = voteRows.map((b) => {
    let best: number | undefined;
    for (const y of anchors) {
      if (used.has(y)) continue;
      if (best === undefined || Math.abs(y - b.cy) < Math.abs(best - b.cy)) best = y;
    }
    if (best === undefined || Math.abs(best - b.cy) > Math.max(b.h, 1) * 3) return b.cy;
    used.add(best);
    return best;
  });
  // 左の欄の文字を、**いちばん近い錨**に配る（錨は番号と、番号の無い票の行の y の和）
  const allAnchors = [...new Set([...rowAnchor, ...anchors])];
  const rowItems: Item[][] = voteRows.map(() => []);
  for (const it of page.items) {
    if (it.x + it.w > band.left + 1) continue;
    if (it.cy >= band.bottom) continue; // 氏名帯より上（見出し・列見出し）
    const nearest = allAnchors.reduce((best, y) => (Math.abs(y - it.cy) < Math.abs(best - it.cy) ? y : best), allAnchors[0] ?? Infinity);
    const r = rowAnchor.indexOf(nearest);
    if (r >= 0) rowItems[r].push(it);
  }
  const rows: VotePdfRow[] = [];
  for (let r = 0; r < voteRows.length; r++) {
    const b = voteRows[r];
    rows.push({ page: pageNo, ...readLeftCells(rowItems[r], bounds), ...readCounts(page, b, band.right), cells: readVoteCells(b.items, band) });
  }
  return rows;
}

/**
 * **左の欄の境界**（議案等番号｜件名｜議決月日｜表決方法｜議決結果 の 6 本）。
 *
 * **罫線があればそれを使う**（52 / 56 本。実測で 6 本ちょうど立つ）。
 * **罫線が 1 本も無い 4 本**（第322〜325回。#743）では、**議案の行のアイテムの左端を
 * 全行ぶん集めてまとめる**——**欄は全行で同じ x に揃っている**（実測 322:
 * 番号 41.3 / 件名 69.1 / 議決月日 240.8 / 表決方法 271.7 / 議決結果 300.1 が全 23 行で同じ）。
 *
 * **1 行だけを見て間隔で切ってはいけない**——番号の右端 66.5 と件名の左端 69.1 の隙間は **2.6pt** で、
 * **件名の中の折り返しの隙間より狭い**（実測 322）。**全行を重ねて初めて欄が見える。**
 */
export function leftColumnBounds(page: PageGeometry, band: NameBand, rowItems: readonly (readonly Item[])[]): number[] {
  const top = Math.max(...rowItems.flatMap((r) => r.map((i) => i.cy)), -Infinity);
  const bottom = Math.min(...rowItems.flatMap((r) => r.map((i) => i.cy)), Infinity);
  // 議案の行の全体を貫く縦罫線（＝欄の境）。**議員の帯の左端まで**。
  // **`cluster` の既定 eps=1.5 では足りない**——件名の欄の右に **1.8pt 離れた二重線**が立つ本がある
  // （実測 313: 360.7 と 362.5）。**二重線を 2 本と数えると欄が 1 つずれ、件名が番号の欄に入る**
  // （実際にそうなり、313 の 78 行中 75 行で `title` が空になった）。**eps=3 でまとめる。**
  const ruled = cluster(page.vlines.filter((l) => l.y0 < top && l.y1 > bottom).map((l) => l.x), 3).filter((x) => x <= band.left + 1);
  // 立つ線は左から **[外枠, 議案等番号の左, 件名の左, (件名の中の分割線), 議決月日の左,
  // 表決方法の左, 議決結果の左, 議員の帯の左]**（実測 52 / 56 本で 7 本、うち 12 ページは 8 本）。
  // **右から 4 本**（議決月日・表決方法・議決結果・議員の帯）と**左から 2・3 本目**を採る。
  // **左端の外枠を欄に数えない**——数えると番号の欄が空になり、件名が番号に入る。
  // 件名の中の分割線は `bounds[1]` と `bounds[n-3]` の間に挟まるので、件名として繋がる。
  if (ruled.length >= 7) return [ruled[1], ruled[2], ...ruled.slice(ruled.length - 4)];
  // **罫線が無い本**: 全行のアイテムの左端をまとめる（欄は全行で揃っている。docblock）。
  // **eps=4 でまとめる**——**議決結果の欄は文言の長さで左端が動く**
  // （実測 323: `原案可決` は 300.1、`不採択` は 303.6。中央揃えのため）。
  // **2 本と数えるとどちらも「半分以上の行」に届かず、議決結果の欄が丸ごと落ちる。**
  const starts = cluster(rowItems.flat().map((i) => i.x), 4);
  // 何行にその左端が出るかを数え、**3 分の 2 以上の行に出る左端だけ**を欄の左端とする。
  // **半分では緩い**——**左端の縦書きのラベル（`議` `案` `発` `請願・陳情` `受理番号`）が
  // 半分の行に出るページがある**（実測 323 p2）。**拾うと欄が 1 つ増え、
  // 右から数える議決月日・表決方法・議決結果が 1 つずつずれる。**
  const common = starts.filter((x) => rowItems.filter((r) => r.some((i) => Math.abs(i.x - x) <= 4)).length * 3 >= rowItems.length * 2);
  if (common.length < 2) return [];
  return [...common, band.left];
}

/**
 * 左の欄（議案等番号／件名／議決月日／表決方法／議決結果）を境界で切る。
 * **欄が 6 つ取れなければ、右から 3 つ（議決月日・表決方法・議決結果）だけを当てる**
 * （番号と件名は左に残る全部）。**足りない欄は空**（推定しない）。
 */
function readLeftCells(items: readonly Item[], bounds: readonly number[]): { number: string; title: string; dateText: string; method: string; result: string } {
  const empty = { number: "", title: "", dateText: "", method: "", result: "" };
  if (bounds.length < 4) return empty;
  const text = (a: number, b: number) => joinText(items.filter((i) => i.cx >= a && i.cx < b));
  const n = bounds.length - 1;
  // 右から: [.., 議決月日, 表決方法, 議決結果]
  const result = text(bounds[n - 1], bounds[n]);
  const method = text(bounds[n - 2], bounds[n - 1]);
  const dateText = text(bounds[n - 3], bounds[n - 2]);
  // 左から: 議案等番号, 件名（件名の欄が 2 本に分かれる本は繋ぐ）
  const number = text(bounds[0], bounds[1]);
  const title = text(bounds[1], bounds[n - 3]);
  return { number, title, dateText, method, result };
}

/**
 * 右端の 賛成者数／反対者数／表決者数。**読めなければ counts 無し**（推定しない）。
 *
 * **賛成者数が記号のアイテムの末尾に入っている会期がある**（行アイテム型。`"○ ○ … ○ 41"`）。
 * **その場合、議員の帯の右には 2 つ（反対者数・表決者数）しか無い**ので、
 * **3 つ揃わなければ諦める、では 749 / 2,445 行で数が取れない**（実測）。
 * **記号アイテムの末尾の数字を先頭に足す**——**推定ではない。原文がそこにある。**
 *
 * **3 つ揃わない行は counts 無しのまま**（`継続審査` の行など、そもそも数が印字されていない行がある）。
 */
function readCounts(page: PageGeometry, b: { cy: number; h: number; items: readonly Item[] }, voteRight: number): { counts?: { yes: number; no: number; voting: number } } {
  // 記号アイテムの末尾に付く賛成者数（行アイテム型）
  const inItem = b.items.map((i) => i.str.trim().match(/(\d+)$/)?.[1]).filter((v): v is string => v !== undefined);
  const right = page.items
    .filter((i) => i.cx >= voteRight && Math.abs(i.cy - b.cy) <= Math.max(i.h, b.h, 1) * 0.5)
    .sort((a, b2) => a.x - b2.x)
    .map((i) => i.str.trim());
  const nums = [...inItem, ...right];
  if (nums.length !== 3 || !nums.every((t) => /^\d+$/.test(t))) return {};
  return { counts: { yes: Number(nums[0]), no: Number(nums[1]), voting: Number(nums[2]) } };
}

/**
 * この行の記号帯 → 議員ごとのセル。
 *
 * **記号の総数が議員の列の数と一致しなければ、全セルを `不明` にする**——
 * **数が合わない行を押し込むと、ずれた 1 列ぶん全員が別人の票になる**（#689 が滋賀で踏んだ形）。
 *
 * **記号 k の x**（#743 の問題 4）:
 *   - **記号が 1 個だけのアイテム**（1 文字 1 アイテム型）は **実 `cx`。推定しない**
 *   - **複数記号のアイテム**（行アイテム型）は
 *     **「半角（ASCII）は全角の半分の送り幅」というモデルでアイテムを割る**
 *     （**等分に落とすと 8,155 個ずれる**。#743 の変異 6）
 */
export function readVoteCells(symItems: readonly Item[], band: NameBand): string[] {
  const n = band.cols.length - 1;
  const cells: string[] = new Array(n).fill(UNKNOWN_CELL);
  const total = symItems.reduce((s, i) => s + trailingVoteSymbols(i.str).length, 0);
  if (total !== n) return cells; // 数が合わない＝置かない（推定しない）
  for (const it of symItems) {
    const cs = trailingVoteSymbols(it.str);
    if (cs.length === 1 && isSingleGlyph(it.str)) {
      const c = columnOf(band.cols, it.cx);
      if (c !== undefined) cells[c] = cells[c] === UNKNOWN_CELL ? cs[0] : UNKNOWN_CELL;
      continue;
    }
    for (const m of splitRowItem(it)) {
      const c = columnOf(band.cols, m.cx);
      if (c !== undefined) cells[c] = cells[c] === UNKNOWN_CELL ? m.ch : UNKNOWN_CELL;
    }
  }
  return cells;
}

/**
 * 行アイテム（`"○ ○ … ○ 45"`）を記号ごとの x に割る（#743 が 56 本で確かめたモデル）。
 *
 * **アイテム自身の文字列と `w` だけから決まる**（氏名の x を使っていないので循環しない）。
 * **半角（ASCII。空白・数字）は全角の半分の送り幅**として単位数を数え、
 * `w ÷ 単位数` を 1 単位の幅とする。
 *
 * ## **ただし、この実装では等分でも列は変わらない**（2026-09-13 に測り直した）
 *
 * **#743 は「等分にすると 8,155 個が半セル以上ずれる」と書いている**が、
 * **あちらは罫線から作ったセルの境で測っている。** この実装は**氏名の 1 文字目の x を中心にした格子**で
 * 列を作るので、**セルの中心が実際の列の中心に一致し、両側に半セルぶんの余裕がある。**
 *
 * **実測**（56 本・行アイテムの記号 **64,424 個**。セル中心からの距離、1.0 = 1 セル）:
 *
 * | モデル | 平均 | 中央 | 99% | 最大 |
 * |---|---|---|---|---|
 * | **半角 0.5 幅（これ）** | **0.0771** | **0.0361** | 0.2643 | 0.2835 |
 * | 等分（全部同じ幅） | 0.1030 | 0.1155 | **0.1575** | **0.1612** |
 *
 * **どちらも 0.5 に届かないので、落ちる列は 64,424 個すべてで同じ**（**差 0 個**。実測）。
 * **つまり「等分にする」という変異は、この実装では等価である**——
 * **`splitRowItem` の単体テストは落ちるが、5 本のフィクスチャも 56 本も 1 セルも変わらない。**
 *
 * **それでも半角モデルを残す**理由:
 *   - **典型的な誤差はこちらのほうが小さい**（平均 0.077 対 0.103、中央 0.036 対 0.116）。
 *     **列の作り方が変わったとき**（罫線から作るように戻す、など）に効き始める。
 *   - **末尾の賛成者数（`45`）を全角 2 文字ぶんと数えると、その行の記号が右に寄る**——
 *     いまは余裕に収まっているだけで、**列が増えれば（議員が増えれば）先に破綻するのはこちらではない。**
 * **「効いていない守りだ」という事実を、ここに測った数字ごと残す。**
 */
export function splitRowItem(it: Item): { cx: number; ch: string }[] {
  const cs = [...it.str];
  const isHalf = (c: string): boolean => c.codePointAt(0)! < 0x80;
  let units = 0;
  for (const c of cs) units += isHalf(c) ? 0.5 : 1;
  if (units === 0) return [];
  const u = it.w / units;
  const out: { cx: number; ch: string }[] = [];
  let pos = 0;
  for (const c of cs) {
    const adv = isHalf(c) ? 0.5 : 1;
    if (isVoteSymbol(c)) out.push({ cx: it.x + (pos + adv / 2) * u, ch: c });
    pos += adv;
  }
  return out;
}

/** セルの原文 → 凡例の意味。凡例に無ければ `抽出不能`（例外にしない＝読めた票は残す。#569） */
export function legendOf(raw: string, votes: Record<string, string>): string {
  if (raw === UNKNOWN_CELL) return UNKNOWN_LEGEND;
  return votes[legendKey(raw)] ?? UNKNOWN_LEGEND;
}
