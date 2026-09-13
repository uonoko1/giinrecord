import { cluster, joinVertical, readPages, type Item, type PageGeometry, type RotatedPageGeometry } from "../pdf-table.ts";
import { legendKey } from "../glyph-variants.ts";

/**
 * 秋田県議会「各議員の表決状況」PDF の表復元（Issue #759）。**1 本会議日に 1 本。**
 *
 * レイアウト（A3 横。`/Rotate 90` の本が 70 / 154。上に凡例・会派帯・氏名帯、その下に議案の行）:
 *   見出し: 「各議員の表決状況」「平成２９年第２回定例会（１２月２２日）」（ページ上端）
 *   凡例:   「自民：自由民主党」…／「簡易：簡易表決（異議の有無を諮る）」…／「「○」：賛成」…
 *   表の左: 議案等番号｜件名｜議決月日（`12月22日`）｜表決方法（`起立`/`簡易`/`投票`）｜
 *           議決結果（`原案可決`）｜表決者数｜賛成者数｜反対者数
 *   表の右: 議員 1 人 1 列（縦書き 1 文字 1 アイテム）
 *
 * ## **#753 が 154 本 / 196 ページ / 167,653 対で測った 6 つを、そのまま設計にしている**
 *
 * ### 1. **`/Rotate 90` を打ち消す**（70 本 / 96 ページ。青森の 11 本 / 27 ページより多い）
 * **共通層（`pdf-table.ts`）は直さない**（既存 9 県の出力が変わる）。**ここで直す**（青森 #750 と同じ判断）。
 * **青森の `unrotate` をそのまま使わずに書き写してあるのは、県ごとに独立させるため**ではない——
 * **同じものなので `aomori/votes-pdf.ts` から import する**（下記）。
 * **打ち消さないと 行 3,985 → 2,183、対 167,653 → 85,528、氏名なし 35,605**（#753 の変異 17）。
 *
 * ### 2. **左端の stray な `議` が 5,298 個、154 本すべてにある**（青森 #748 の 1 番目と同じ形だが規模が違う）
 * 議員の帯の**はるか左**にある「議案等番号」「議決月日」「議決結果」の列見出しの `議`、
 * および議案名の中の `議` である。**青森は 5 会期だったが、秋田は 154 本すべてにある。**
 * **除かずに測ると 半セル以上 35,097 / 170,686 対、落ちた行 3,863 / 3,930**（#753 の変異 11）。
 * **しかも「数は合う」**ので、利用者からも素朴な検算からも見えない。
 * **だから記号は「氏名の列が張る x の範囲の中」にあるものだけを拾う**（`readRows`）。
 *
 * ### 3. **`ー`(U+30FC) を記号として拾ってはいけない**（**秋田で新しく出た形**）
 * **凡例 B（10 本）は「議場に不在」を `ー`(U+30FC ＝ 長音記号) と書く。**
 * **凡例の記号を文字列としてそのまま本文の走査に使うと、議案名の長音が票に化ける**——
 * `エネルギー` `センター` `アショア` の `ー` が **268 個 / 73 本**（#753 実測）。
 * **実害は「記号が読めない」ではなく「記号でないものを記号と読む」側に出る**（#569 の別人の記録と同じ）。
 * **だから `VOTE_SYMBOLS` に `ー` を入れない**（凡例から動的に足すこともしない。下の docblock）。
 * **`ー` は 154 本のどの本文セルにも票として 1 個も出ていない**（凡例で `ー` を使う 10 本を含む。#753）。
 * **`－`(U+FF0D) は本文セルに 7 個 / 4 本だけ出る**ので、そちらは入れる。
 *
 * ### 4. **凡例は 4 通り。うち凡例 D は「1 つの記号に 2 つの意味」**（5 本）
 * | 凡例 | 本数 | 「議場に不在」の記号 |
 * |---|---:|---|
 * | A | **130** | `－`(U+FF0D) |
 * | B | **10** | **`ー`(U+30FC)**（3 の罠と直結） |
 * | C | **9** | **無い**（5 記号だけ。`除` も無い） |
 * | D | **5** | **`－`＝「棄権又は議場に不在」**（1 記号に 2 つの意味） |
 * **凡例は PDF ごとに読む**（既存 9 県と同じ）。**決め打ちにしない。**
 * **D の `－` は `mapped` を付けない**（`rollcalls.ts` の `MAPPED` に「棄権又は議場に不在」が無いため）——
 * **`raw` と `legend`（原文「棄権又は議場に不在」）は残る。**
 * **「棄権」と「議場に不在」は別の事実なので、片方に決めない**（#569）。
 * **`抽出不能` にはしない**（滋賀は凡例そのものが無い PDF をそうしたが、**秋田の D は凡例が有り、
 * 原文がそう書いてある**。原文を捨てるほうが情報が減る）。**詳しくは `rollcalls.ts` の `MAPPED`。**
 *
 * ### 5. **本文セルに出る記号は 7 種。凡例に無い記号は 1 つも出ない**（#753）
 * `○` 158,989 / `議` 3,984 / `×` 3,745 / `欠` 888 / `除` 35 / `－` 7 / `棄` 5。
 * **`退` `副` `白` は 1 つも出ない**（22 / 7 / 3 箇所あるがすべて議案名の中の語）。
 *
 * ### 6. **1 行の中で分割単位が揃わない**（#615 の罠 1。**110 本 / 2,780 アイテム**）
 * **記号のアイテムの粒度が 1 本の中でも揃わない**:
 *   - `"○ ○ … ○ 議 ○ … ○"`（36 記号）が 1 アイテム **＋** その右に 1 文字 1 アイテムが 5 個
 *     （実測 `h291222giketu.pdf`: 結合アイテムは x=658.53 w=396.478、右の 5 個は cx 1064.55〜1121.79）
 *   - **結合アイテムの y は、同じ行の単独アイテムと 0〜7.68pt ずれる**（#753 が 154 本で 13 通り数えた）
 *   - **一方で行の間隔は最小 4.92pt**（中央 18.24pt）なので、**「y の差が N pt 以内なら同じ行」では解けない**
 * **#615 自身が「アイテムを 1 文字ずつに割ってから x で再配置する」なら読めると書いている。その形にした。**
 * **モデルは「半角（ASCII）は全角の半分の送り幅」**（`splitRowItem`）。
 * **アイテム自身の文字列と `w` だけから決まる**（氏名の x を使っていないので循環しない）。
 * **実測**（`h291222giketu.pdf` の 36 記号）: **列の中心からのずれは最大 0.153 セル。**
 * **等分に差し替えると 半セル以上 7,123、置けず 3,173、氏名なし 2,401、落ちた行 246**（#753 の変異 10）。
 *
 * ## **列は罫線で割らない**（#753 の実測）
 * **縦罫線が 20 本以上あるページは 195 / 196 だが、罫線でそのまま列を割れるのは 24 ページだけ。**
 * 残りは**議員の列の間に罫線が間引かれている**（`h281222giketu.pdf` は単位幅 14.72pt に対して
 * 会派の境が 29.44pt ＝ちょうど 2 倍。**45 本の罫線から 24 列しか出ず、実際の 44 人に足りない**）。
 * **だから列は氏名の 1 文字アイテムの x から作る**（青森と同じ）。
 *
 * ## **列は等間隔ではない**（#753 の測り方 #2 と同じ罠。青森には無かった）
 * **右端の小会派のところで列が広がる**（実測 `h291222giketu.pdf`:
 * 左の 34 対は 11.04pt、右の 6 対は 12.36 / 13.68 / 14.16 / 14.52 / 14.64 / 13.92pt）。
 * **「列数で等分した格子」にすると、#753 は回転版 1 本で `ROT=-1` のほうが当てはまりが良くなった。**
 * **だから境界は「隣り合う中心の中点」**（等間隔を仮定しない）。
 *
 * ## 見出し（**同じ文字列が 4 回描かれる本がある。しかも断片に割れる**。実測 2026-09-13）
 * `h251008giketu.pdf` のページ上端は **44 アイテム**で、
 * `各議員|各議員|各議員|各議員の|の|の|の表決状況|表決状況|…|平成|平成|平成|平成２５|…` と
 * **同じ見出しが 4 回、しかも 1 文字〜数文字の断片に割れて重なっている**（おそらく影付きの装飾）。
 * **アイテムを x で並べて繋ぐと `各議員各議員各議員各議員のののの表決状況…` になる。**
 * **だから見出しは「繋いだ文字列」からではなく、`(元号)N年第M回(定例会|臨時会)（M月D日）` という
 * 完結した形に当たるアイテムを探す**（`parseHeading`）。**断片は当たらないので黙って落ちる。**
 *
 * 方針（既存 9 県と同じ）: 文字の位置を推定で並べ替えない。凡例に無い記号は例外ではなく
 * `抽出不能` として残す（#569）。**数が合わない行は丸ごと `不明`**（推定しない）。
 */
export const UNKNOWN_CELL = "不明";
export const UNKNOWN_LEGEND = "抽出不能";

/**
 * 表決の記号とみなす文字。
 *
 * **#753 が 154 本の本文セルで数えた 7 種そのもの**（`○` 158,989 / `議` 3,984 / `×` 3,745 /
 * `欠` 888 / `除` 35 / `－` 7 / `棄` 5）。**凡例に無い記号は 1 つも出ない。**
 *
 * ## **`ー`(U+30FC) は入れない**（**この判断が秋田の要である**）
 * **凡例 B（10 本）は「議場に不在」を `ー`(U+30FC) と書く**が、
 * **`ー` を記号として拾うと議案名の長音が 268 個 / 73 本、票に化ける**（#753。docblock の 3）。
 * **`ー` は 154 本のどの本文セルにも票として 1 個も出ていない。**
 * **もし将来 `ー` が本文セルに票として出たら、その行の記号の個数が議員の列の数と合わなくなり、
 * その行は丸ごと `不明` に落ちる**（黙って別人の票にはならない。落ちる側に倒してある）。
 * **「1 本の議案名の長音を票にする」と「1 行の票を落とす」は同じ重さではない**（作業合意）。
 *
 * ## **`退` `副` `白` も入れない**
 * **秋田の凡例 4 通りのどれにも無く、本文セルにも 1 つも出ない**（#753 が 154 本で確認。
 * 議案名の中に `退職手当` `副知事` `白紙撤回` として出るだけ）。
 * **青森の `副`（凡例にあるが 0 個）とは違って、秋田では凡例にすら無い。**
 */
const VOTE_SYMBOLS = new Set([..."○×議欠棄除－"]);
export const isVoteSymbol = (c: string): boolean => VOTE_SYMBOLS.has(c);

/** 異体字セレクタ（SVS U+FE00–FE0F / IVS U+E0100–E01EF）。`name-match.ts` の `localNameKey` と同じ範囲 */
const VARIATION_SELECTORS = /[︀-️\u{E0100}-\u{E01EF}]/gu;

/**
 * **異体字セレクタを除いて 1 文字か**（青森 #749 の機序 ①）。
 * `櫛`+U+E0101 のような形は `[...str].length === 2` なので、素朴に数えると氏名の 1 文字目が落ちる。
 * **秋田の 154 本には異体字セレクタ付きの氏名は見つかっていない**（#615 が 2 本で 0 件と数えた）が、
 * **「2 本には無い」であって「無い」ではない。** 9 県を通る判定なのでそのまま使う。
 */
export const isSingleGlyph = (str: string): boolean => [...str.replace(VARIATION_SELECTORS, "")].length === 1;

export interface VotePdfLegend {
  /** セルの記号 → 凡例の意味（「○」→「賛成」）。凡例の無い PDF では空 */
  votes: Record<string, string>;
  /** 表決方法の凡例（「簡易」→「簡易表決（異議の有無を諮る）」）。原文のまま */
  methods: Record<string, string>;
  /** 会派の略称 → 正式名（「自民」→「自由民主党」）。**会派帯は略称しか出ない**ので要る */
  groups: Record<string, string>;
  /**
   * **凡例に書かれているが、この ETL が表決の記号として扱わない項目**（記号 → 意味）。
   *
   * **秋田では `ー`(U+30FC)＝「議場に不在」がこれに入る**（凡例 B の 10 本。#753 の問題 3）。
   * **`ー` を表決の記号にすると、議案名の長音が票に化ける**——`エネルギー` `センター` `アショア` の
   * `ー` が **268 個 / 73 本**（#753 実測）。**実害は「記号が読めない」ではなく
   * 「記号でないものを記号と読む」側に出る**（#569 の別人の記録と同じ）。
   * **`ー` は 154 本のどの本文セルにも票として 1 個も出ていない**（凡例で `ー` を使う 10 本を含む）。
   *
   * **捨てずにここに残す**——**「凡例にこう書いてあったが、この ETL は記号として読まなかった」
   * という事実を、`meta.json` から見えるようにする。**
   * **もし将来この記号が本文セルに票として出たら、その行の記号の個数が議員の列の数と合わなくなり、
   * その行は丸ごと `不明` に落ちる**（黙って別人の票にはならない。落ちる側に倒してある）。
   */
  ignoredMarks: Record<string, string>;
  /** 凡例の原文（全項目） */
  notes: string[];
}

export interface VotePdfMember {
  /** 縦書きの氏名を上から並べたもの（「加 賀 屋 千 鶴 子」。空きは半角空白 1 つ） */
  nameText: string;
  /** 会派帯の原文（略称「自民」。読めなければ空） */
  group: string;
}

export interface VotePdfRow {
  page: number;
  /** 議案等番号の欄の原文（「議案第 184 号」「認定第１号」。空の行もある） */
  number: string;
  /** 件名の欄の原文（折り返しを繋いだもの） */
  title: string;
  /** 議決月日の欄の原文（「12月22日」）。ISO には直さない（原文主義。年は見出しから補う） */
  dateText: string;
  /** 表決方法の欄の原文（「起立」「簡易」「投票」） */
  method: string;
  /** 議決結果の欄の原文（「原案可決」「同意」「認定」） */
  result: string;
  /** 表決者数・賛成者数・反対者数（数として読めたときだけ） */
  counts?: { yes: number; no: number; voting: number };
  /** members と同じ順。置けなかったセルは UNKNOWN_CELL */
  cells: string[];
}

export interface VotePdf {
  /** 見出しの原文（「平成２９年第２回定例会（１２月２２日）」） */
  headingText: string;
  /** 見出しから読めた年・回次・会期の種別（**無い本がある**ので undefined でありうる） */
  year?: number;
  round?: number;
  kind?: string;
  legend: VotePdfLegend;
  members: VotePdfMember[];
  rows: VotePdfRow[];
  unknownCells: number;
  pages: number;
  /** `/Rotate 90` を打ち消したページ数（測定と突き合わせるため） */
  rotatedPages: number;
}

/**
 * 凡例の記号の項目。**2 通りの書き方がある**（実測 2026-09-13）:
 *   - `「○」：賛成`（鉤括弧つき。**古い形**。`h291222giketu.pdf` など）
 *   - `○ ： 賛成`（鉤括弧なし。**新しい形**。`060220hyoketsu.pdf` など **38 本**）
 * **鉤括弧つきだけを見ると、新しい 38 本の凡例が空になり、全セルが `抽出不能` になった**（実測）。
 * **`：` は全角も半角もあり、前後に空白が入る本もある。**
 *
 * **`(.)` が 1 文字であることを要求する**——**会派の凡例（`自民：自由民主党`）や
 * 表決方法の凡例（`簡易：簡易表決（…）`）は鍵が 2 文字以上なのでここに当たらない。**
 */
const LEGEND_VOTE = /^(?:「(.)」|(.))\s*[：:]\s*(.+)$/;
/** 凡例の項目「簡易：簡易表決（異議の有無を諮る）」「自民：自由民主党」（記号の鉤括弧が無い形） */
const LEGEND_PLAIN = /^([^：:「」]{1,10})\s*[：:]\s*(.+)$/;
/** 表決方法の凡例に出る略称（これだけを `methods` に入れる。会派と混ざらないように） */
const METHOD_KEYS = new Set(["簡易", "起立", "投票"]);
/**
 * 見出し「平成２９年第２回定例会（１２月２２日）」。
 * **`（M月D日）` が無い形もある**（`平成２３年６月定例会` / `平成２４年第２回定例会（９月議会）`）ので、
 * **日付の括弧は任意**にし、**議決日は本文の `議決月日` の列から取る**（154 / 154 本にある。#753）。
 * **`第M回` が無い形もある**（`平成２３年６月定例会`）ので回次も任意。
 */
const HEADING = /^(令和|平成|昭和)\s*([０-９0-9]+|元)年\s*(?:第\s*([０-９0-9]+)\s*回\s*)?(定例会|臨時会|[０-９0-9]+月定例会|[０-９0-9]+月臨時会)/;
/**
 * 議決月日「12月22日」。**全角も半角もある**（実測）。
 *
 * **アイテムがこれ「だけ」であることを求めてはいけない**——**日付が隣の欄と 1 アイテムに同居する本がある**
 * （実測 `041222hyoketsu.pdf`: `12月22日 簡易` が 1 アイテム。**この本の 44 行すべて**）。
 * **求めると、その本の全行で議決月日が空になり、採決が 1 件も出ない**（実際にそうなった）。
 * **だから `DATE_IN` で「含まれているか」を見て、`DATE_CELL` で取り出す。**
 */
const DATE_CELL = /^([０-９0-9]{1,2})月([０-９0-9]{1,2})日$/;
/** アイテムの中の議決月日（同居している本がある。上の docblock）。**行の中に 1 つだけ** */
const DATE_IN = /([０-９0-9]{1,2})月([０-９0-9]{1,2})日/;
/**
 * 議案等番号「議案第184号」「認定第１号」「請願第2号」。
 * **種別の語は 154 本で揺れる**（`議案` `認定` `報告` `請願` `陳情` `発議` `意見書案` `決議案` …）ので
 * **列挙しない**——**`第` と `号` に挟まれた数**という形だけを見る。
 * **`議案第 184 号` のように空白が入る本と入らない本がある**（`joinText` が空白を除いてから当てる）。
 * **当たらなければ番号は空**（推定しない）。
 */
const NUMBER_CELL = /(?:議案|認定|承認|報告|請願|陳情|発議|意見書案|決議案|同意|諮問|人事案件|[一-鿿]{0,6})第[０-９0-9]{1,4}号/;

/* ---------- 回転の打ち消し ---------- */

/**
 * `/Rotate 90` のページの座標を、表示どおりの向き（横長）に直す。
 * **青森（#750）の `unrotate` と同じ計算**なので、**そちらから import せずに書き写す**のではなく、
 * **同じ 1 つの実装を使う**——**県ごとに書き写すと、片方だけ直したときに黙ってずれる。**
 * **ただし秋田は 180 / 270 のページが 154 本に 1 つも無い**ので、出たら例外になる（青森と同じ）。
 *
 * **実測（2026-09-13、この worktree）**: `h291222giketu.pdf` は `rotate=90 view=[0,0,842,1191]` で、
 * **打ち消さないと氏名が y=1117.7 に横並びになり、打ち消すと y=681.9 に 41 列の縦書きになる。**
 */
export { unrotate } from "../aomori/votes-pdf.ts";
import { unrotate } from "../aomori/votes-pdf.ts";

/* ---------- 本体 ---------- */

export async function parseVotePdf(bytes: Buffer): Promise<VotePdf> {
  const raw = await readPages(bytes);
  if (raw.length === 0) throw new Error("PDF has no pages");
  if (raw.every((p) => p.items.length === 0)) throw new Error("PDF has no text layer (image PDF)");
  const pages = raw.map(unrotate);
  const head = parseHeading(pages);
  const legend = parseLegend(pages);
  let members: VotePdfMember[] | undefined;
  const rows: VotePdfRow[] = [];
  for (let p = 0; p < pages.length; p++) {
    const mc = findMemberColumns(pages[p]);
    // **票の行が無いページ**（`R040218hyoketsu.pdf` の 2 ページ目は本文が「2」というページ番号だけ。#753）
    if (!mc) continue;
    const pageMembers = readMembers(pages[p], mc);
    // **議員の並びは 1 ページ目からしか取らない**（後のページの氏名帯で上書きしない）。
    // **列の数が食い違ったら例外**（黙って別の並びで読まない）
    if (!members) members = pageMembers;
    else if (members.length !== pageMembers.length) throw new Error(`page ${p + 1}: member columns ${pageMembers.length} !== ${members.length}`);
    rows.push(...readRows(pages[p], mc, p + 1));
  }
  if (!members || members.length === 0) throw new Error("no member columns found");
  if (rows.length === 0) throw new Error("no rows found");
  let unknownCells = 0;
  for (const row of rows) unknownCells += row.cells.filter((c) => c === UNKNOWN_CELL).length;
  return { ...head, legend, members, rows, unknownCells, pages: pages.length, rotatedPages: raw.filter((p) => p.rotate !== 0).length };
}

/* ---------- heading & legend ---------- */

/**
 * ページ上端の見出し。
 *
 * ## **アイテムを繋いではいけない**（実測 2026-09-13）
 * **同じ見出しが 4 回、しかも断片に割れて重なる本がある**（`h251008giketu.pdf` は上端に 44 アイテム:
 * `各議員|各議員|各議員|各議員の|の|の|の表決状況|…|平成|平成|平成|平成２５|２５|２５|２５年第|…`）。
 * **x で並べて繋ぐと `各議員各議員各議員各議員のののの表決状況…` になる。**
 * **だから「完結した形に当たるアイテムを 1 つ探す」**。断片（`平成` `２５` `年第`）は当たらない。
 *
 * **議案名の和暦を拾わない**——`平成２９年度秋田県一般会計補正予算` は `年度` と続くので
 * `^(元号)N年(第M回)?(定例会|臨時会)` の形にならない。**さらにページ上端の帯だけを見る。**
 *
 * **年も回次も無いことは例外にしない**（`平成２３年６月定例会` は回次が無い）。
 * **議決日はここから取らない**——**本文の `議決月日` 列が 154 / 154 本にある**（#753）。
 */
export function parseHeading(pages: readonly PageGeometry[]): { headingText: string; year?: number; round?: number; kind?: string } {
  const page = pages[0];
  if (page.items.length === 0) throw new Error("page 1 has no items");
  const top = Math.max(...page.items.map((i) => i.cy));
  // 上端から 3 行ぶん（見出しが 2 行に割れる本がある）。凡例より上
  const band = page.items.filter((i) => i.cy >= top - Math.max(i.h, 1) * 3);
  for (const it of [...band].sort((a, b) => b.cy - a.cy || a.cx - b.cx)) {
    const m = it.str.trim().replace(/[\s　]+/g, "").match(HEADING);
    if (!m) continue;
    const n = m[2] === "元" ? 1 : Number(m[2].normalize("NFKC"));
    const year = m[1] === "令和" ? 2018 + n : m[1] === "平成" ? 1988 + n : 1925 + n;
    // `９月定例会` のように月が付く形も原文のまま残す（種別の推定はしない）
    const kind = m[4];
    return {
      headingText: it.str.trim(),
      year,
      ...(m[3] !== undefined ? { round: Number(m[3].normalize("NFKC")) } : {}),
      kind,
    };
  }
  // 見出しの形に当たらなければ、上端の帯の原文だけを返す（年も回次も付けない。推定しない）
  const line = [...band].sort((a, b) => b.cy - a.cy || a.cx - b.cx).map((i) => i.str.trim()).join(" ").trim();
  return { headingText: line };
}

/**
 * 凡例。**4 通りある**（A 130 / B 10 / C 9 / D 5 本。#753）ので、**PDF ごとに読む。**
 * **凡例が無い本では `votes` が空になり、全セルの `legend` が `抽出不能` になる**（推定しない。#569）。
 *
 * **`「－」：棄権又は議場に不在`（凡例 D、5 本）も、原文のまま `votes["－"]` に入れる。**
 * **「棄権」と「議場に不在」のどちらかに決めない**（#569）。**`mapped` は `rollcalls.ts` が付けない。**
 *
 * **同じ記号が違う意味で 2 回出たら例外**（凡例そのものが壊れている）。
 * **同じ意味で 2 回出るのは通す**——**凡例がページごとに繰り返される**（154 本すべてで全ページに出る）。
 */
export function parseLegend(pages: readonly PageGeometry[]): VotePdfLegend {
  const votes: Record<string, string> = {};
  const methods: Record<string, string> = {};
  const groups: Record<string, string> = {};
  const ignoredMarks: Record<string, string> = {};
  const notes: string[] = [];
  for (const page of pages) {
    for (const it of page.items) {
      const text = it.str.trim().replace(/[\s　]+/g, "");
      const v = text.match(LEGEND_VOTE);
      if (v) {
        const key = v[1] ?? v[2];
        const meaning = v[3].trim();
        if (meaning === "") continue;
        // **鉤括弧の無い形は、記号の凡例でなく会派の凡例でありうる**（実測 2026-09-13）:
        // **`鳳：鳳` という 1 文字の会派名が 23 本にある**（平成29年〜令和元年の会派「鳳」）。
        // **記号として入れると `鳳` が表決の記号になり、その意味が「鳳」になる**
        // （実測: 23 本の `legend.votes` に `鳳(U+9CF3)=鳳` が入った）。
        // **本文セルには 1 個も出ない**ので票が化けたわけではないが、
        // **`VOTE_SYMBOLS` に無い字なので、記号として拾われることはそもそも無い。**
        // **それでも凡例に混ぜない**——**凡例は「この PDF で票の記号が何を意味するか」の表**で、
        // **会派名を混ぜると、その表を根拠にした検算（記号の種類の数）が狂う。**
        // **判定は「その字が表決の記号か」**（`VOTE_SYMBOLS`）——**凡例から記号の集合を作らないので、
        // ここで弾いても「凡例に書かれているのに読めない記号」は生まれない**
        // （`VOTE_SYMBOLS` に無い字は本文セルから拾われないため）。
        if (!isVoteSymbol(key)) {
          // **表決の記号ではない 1 文字の鍵**。2 通りありうる:
          //   - **`ー`(U+30FC)＝「議場に不在」**（凡例 B の 10 本）→ `ignoredMarks` に残す
          //   - **`鳳：鳳` のような 1 文字の会派名**（23 本。平成29年〜令和元年の会派「鳳」）→ 会派として下で拾う
          // **分け方は「意味が鍵と同じか」**——**会派の凡例は `鳳：鳳` `みらい：みらい` `きらり：きらり`
          // のように、略称と正式名が同じ会派がある**（実測）。
          // **記号の凡例で「鍵と意味が同じ」ものは無い**（`○：賛成` `ー：議場に不在`）。
          if (v[1] !== undefined || key !== meaning) {
            if (key in ignoredMarks && ignoredMarks[key] !== meaning) throw new Error(`ignored mark ${key} appears twice with different meanings (${ignoredMarks[key]} / ${meaning})`);
            ignoredMarks[key] = meaning;
            if (!notes.includes(text)) notes.push(text);
            continue;
          }
          // 会派の凡例として下で拾う
        } else {
        if (key in votes && votes[key] !== meaning) throw new Error(`legend key ${key} appears twice with different meanings (${votes[key]} / ${meaning})`);
        votes[key] = meaning;
        if (!notes.includes(text)) notes.push(text);
        continue;
        }
      }
      const p = text.match(LEGEND_PLAIN);
      if (!p) continue;
      const key = p[1].trim();
      const meaning = p[2].trim();
      if (key === "" || meaning === "") continue;
      const into = METHOD_KEYS.has(key) ? methods : groups;
      // **会派の凡例は「つなぐ会：次の世代につなぐ会」の形**。**2 会派が 1 アイテムに同居する本がある**
      // （#615 が実測: `つなぐ会：次の世代につなぐ会 ／ 共産：日本共産党`）ので、
      // **`／` で割ってから当てる**
      if (!METHOD_KEYS.has(key) && /[／/]/.test(meaning)) {
        for (const part of text.split(/[／/]/)) {
          const q = part.trim().match(LEGEND_PLAIN);
          if (!q) continue;
          const k = q[1].trim();
          const m2 = q[2].trim();
          if (k === "" || m2 === "") continue;
          if (k in groups && groups[k] !== m2) throw new Error(`group legend ${k} appears twice (${groups[k]} / ${m2})`);
          groups[k] = m2;
        }
        if (!notes.includes(text)) notes.push(text);
        continue;
      }
      if (key in into && into[key] !== meaning) throw new Error(`legend ${key} appears twice with different meanings (${into[key]} / ${meaning})`);
      into[key] = meaning;
      if (!notes.includes(text)) notes.push(text);
    }
  }
  return { votes, methods, groups, ignoredMarks, notes };
}

/* ---------- 票の行 ---------- */

/**
 * **票の行 1 本 ＝ 記号の中心の並び**（結合アイテムは `splitRowItem` で割ってある）。
 * **左端の stray な `議` も入っている**ので、`voteRowCore` で落とす。
 */
export interface VoteRow {
  cy: number;
  h: number;
  /** 左から順。記号の中心の x と原文 */
  marks: { cx: number; ch: string }[];
}

/**
 * ページの票の行（記号の帯）。**上から順に返す。**
 *
 * ## **y の許容は「行の間隔」ではなく「結合アイテムのずれ」で決める**（#753 の問題 6）
 * **結合アイテムの y は同じ行の単独アイテムと 0〜7.68pt ずれる**（154 本で 13 通り）。
 * **一方で行の間隔は最小 4.92pt**（中央 18.24pt）。**重なっている。**
 * **許容は 1.0×h**（8.28pt。**7.68pt のずれを含む**）。
 * **行の間隔 4.92pt の本と重なりうるが、そのときは記号が 2 行ぶん集まって個数が合わず、
 * その 2 行が `不明` に落ちる**——**混ざった票を出すより落とす**（作業合意）。
 *
 * **20 個以上の帯だけを返す**（列見出しの `議決結果` の `議` や、議案名の中の `議` を行にしない。
 * **#753 が数えた stray は 5,298 個 / 154 本すべて**）。
 */
export function voteRows(page: PageGeometry): VoteRow[] {
  const sym = page.items.filter((i) => countVoteSymbols(i.str) > 0);
  const bands: { cy: number; h: number; items: Item[] }[] = [];
  for (const it of [...sym].sort((a, b) => b.cy - a.cy)) {
    const last = bands[bands.length - 1];
    if (last && Math.abs(last.cy - it.cy) <= Math.max(it.h, last.h, 1) * 1.0) { last.items.push(it); continue; }
    bands.push({ cy: it.cy, h: it.h, items: [it] });
  }
  const out: VoteRow[] = [];
  for (const b of bands) {
    const marks: { cx: number; ch: string }[] = [];
    for (const it of b.items) {
      // **記号が 1 個だけのアイテムは実 `cx`。推定しない**
      if (countVoteSymbols(it.str) === 1 && isSingleGlyph(it.str.trim())) marks.push({ cx: it.cx, ch: it.str.trim() });
      else marks.push(...splitRowItem(it));
    }
    if (marks.length < 20) continue;
    out.push({ cy: b.cy, h: b.h, marks: marks.sort((a, c) => a.cx - c.cx) });
  }
  return out;
}

/**
 * **行の「芯」＝ 等間隔に連なっているいちばん長い部分**（左端の stray な `議` をここで落とす）。
 *
 * ## **これが秋田の設計の要である**（#753 の問題 2。**5,298 個 / 154 本すべて**）
 * **議員の帯の外（左の「議案等番号」「議決月日」「議決結果」の欄、議案名の中）に `議` が立つ。**
 * **除かずに測ると 半セル以上 35,097 / 170,686 対、落ちた行 3,863 / 3,930**（#753 の変異 11）。
 * **しかも「数は合う」**（`○` の個数と賛成者数の突き合わせは通る）ので、
 * **利用者からも素朴な検算からも見えない。**
 *
 * **除き方は「等間隔の連なり」**——**議員の票は 1 人 1 列で等間隔に並び、
 * stray はその連なりから大きく離れた所に立つ**（実測 `080703.pdf`: 議員の帯は x=828〜1531 で
 * 間隔 17.2pt、stray な `議` は x=663 と x=749 で、本体から 79pt 以上離れている）。
 * **単位は間隔の中央値**（芯の部分が多数派なので、中央値はそこに落ちる）。
 * **許容は 1.9 倍まで**——**秋田の列は右端の小会派で 1.33 倍に広がる**が、
 * **1.9 倍を超えるのは「議員が 1 人欠けている所」か「帯の外」である。**
 * **議員が 1 人欠けている所で切れたら、その行の芯が短くなって個数が合わず、丸ごと `不明` に落ちる**
 * （**別人の票にはならない**）。
 *
 * **「長いほうを採る」ので、stray が 2 個以上続いても落ちる**（左の 3 欄の `議` `表` は
 * 33〜40pt 間隔で、議員の 17.2pt とは別の連なりになるが、**長さが 3 対 41 なので負ける**）。
 */
export function voteRowCore(marks: readonly { cx: number; ch: string }[]): { cx: number; ch: string }[] {
  if (marks.length < 3) return [...marks];
  const xs = marks.map((m) => m.cx);
  const gaps = xs.slice(1).map((v, k) => v - xs[k]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const step = sorted[Math.floor(sorted.length / 2)];
  if (!(step > 0)) return [...marks];
  let bestStart = 0, bestLen = 1, start = 0, len = 1;
  for (let k = 0; k < gaps.length; k++) {
    if (gaps[k] <= step * 1.9) len++;
    else { if (len > bestLen) { bestLen = len; bestStart = start; } start = k + 1; len = 1; }
  }
  if (len > bestLen) { bestLen = len; bestStart = start; }
  return marks.slice(bestStart, bestStart + bestLen);
}

/* ---------- 議員の列（票の行から作る） ---------- */

/**
 * 議員の列。**氏名からではなく、票の行そのものから作る。**
 *
 * ## **なぜ票の行から作るのか**（実装中に測って決めた。2026-09-13）
 * **最初は青森（#750）と同じく「氏名の 1 文字目の x を列の中心にする」形で書いた。**
 * **秋田では当たらなかった**——**154 本を通して測ると、氏名から作った列の数が
 * その本の記号の個数と一致したのは 43 / 154 本だけで、3,021 行のうち 963 行しか置けなかった**（実測）。
 * **食い違いの機序は 4 つあり、どれも氏名の側の問題である:**
 *
 * | 機序 | 例 | どうなったか |
 * |---|---|---|
 * | **左の列見出しが氏名と同じ y 帯に入る** | `080703.pdf`: `議|表|議|表|賛|反` が cy=903.0、氏名が cy=899.7（**差 3.3pt**） | **44 列。記号 41 個と合わず 26 行が `不明`** |
 * | **氏名帯に列が欠ける** | `020319giketu.pdf`: 41 列しか出ないが記号は 43 個（間隔が 2.10 / 2.50 倍の所に議員が居る） | **41 列。44 行が `不明`** |
 * | **氏名が縦積み 1 アイテムで y がばらける** | `060220hyoketsu.pdf`: 3 文字 `"小 棚 木"` cy=480.7 / 2 文字 `"武 内"` cy=477.3 / 1 文字 `高` cy=470.6 | **帯が 3 つに割れ、19 本が「議員 0 人」で落ちた** |
 * | **凡例の `／` が 1 文字アイテムとして列になる** | `080703.pdf` の凡例に `／` が 11 個 | 上の 1 つ目と重なる |
 *
 * **「欠けを戻す」「端を落とす」で 1 つずつ塞いだが、塞ぐたびに別の本が壊れた**
 * （実測の推移: 963 → 860 → 713 → 407 行）。**氏名の形が本ごとに違いすぎる。**
 *
 * ## **票の行から作れば、機序 4 つが全部消える**
 * **議員の票は「1 人 1 列、等間隔」に並ぶ。** **これは 154 本すべてで変わらない**（#753 が
 * 167,653 対で確かめた）。**そして票の行は本文そのものなので、凡例も列見出しも混ざらない。**
 * **実測: 196 ページ中 193 ページで、すべての行の記号の個数が一致した**
 * （**3,985 行のうち 3,983 行が一致。残り 2 行は `011008giketu.pdf` と `R040318hyoketsu.pdf` の各 1 行**）。
 * **#753 が数えた 3,985 行と一致する。**
 *
 * ## **氏名は「作った列に落とす」だけ**
 * **列を決めるのに氏名を使わないので、氏名が 1 文字欠けても、縦積みでも、列はずれない。**
 * **氏名が落ちた列は `nameText` が空になり、名簿に寄らず `unmatched.json` に落ちる**（#569 のとおり）。
 * **「この列はあの議員だろう」と埋めない。**
 *
 * ## **この設計が見ていないもの**（#757: 母数は 1 つではない）
 * **「k 番目の記号が k 番目の議員のものか」は、この実装では確かめていない。**
 * **確かめているのは「記号の個数が全行で揃っている」ことだけである。**
 * **もし議員の列が 1 つ丸ごと（全行で）欠けていたら、この実装はそれに気づかない**——
 * **記号の個数は全行で揃ったままで、氏名だけが 1 つずれる。**
 * **そこは氏名の突き合わせ（`name-match.ts`）が受け止める**——**ずれれば全員が別人になり、
 * `unmatched.json` が 40 件以上に膨れる**（`meta.json` の `unmatched` で見える）。
 * **#753 が測った「記号 k の x と k 番目の列の氏名の平均 x の差が半セル未満」は、
 * この実装のテストでも別に測っている**（`akita-votes-pdf.test.ts` の「氏名と票が同じ列に落ちる」）。
 */
export interface MemberColumns {
  /** 議員の列の境界（議員数 + 1 本）。**等間隔を仮定しない**（右端の小会派で広がる） */
  cols: number[];
  /** 議員の数（＝ `cols.length - 1`） */
  n: number;
  /** 票の行が張る x の範囲 */
  left: number;
  right: number;
  /** **この列立てに合う票の行**（`voteRowCore` で stray を落としたあと、個数が `n` の行） */
  rows: VoteRow[];
  /** 個数が `n` にならなかった票の行（**その行は丸ごと `不明` にする**） */
  oddRows: VoteRow[];
}

/**
 * ページの議員の列。**票の行の「芯」の個数の最頻値**を議員の数とし、
 * **その個数の行の記号の x の平均**を列の中心にする。
 *
 * **平均を採るのは 1 行の誤差に引きずられないため**——**結合アイテムを割った x は推定を含む**
 * （`splitRowItem`。実測のずれは最大 0.153 セル）。**全行で平均すれば、そのぶんが薄まる。**
 *
 * **最頻値が同数のときは大きいほうを採る**——**記号が 1 個少ない行は「1 人が欠けた行」ではなく
 * 「stray が芯に混ざらなかった行」でありうる**が、**多いほうを採ると帯の外を取り込む。**
 * **どちらに転んでも、合わない行は `不明` に落ちる**（別人の票にはならない）。
 */
export function findMemberColumns(page: PageGeometry): MemberColumns | undefined {
  const all = voteRows(page);
  if (all.length === 0) return undefined;
  const cores = all.map((r) => ({ ...r, marks: voteRowCore(r.marks) }));
  const hist = new Map<number, number>();
  for (const r of cores) hist.set(r.marks.length, (hist.get(r.marks.length) ?? 0) + 1);
  const n = [...hist.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  if (n < 20) return undefined; // 議員の列は 40〜46（#753 は 40〜45）。20 未満は表ではない
  const rows = cores.filter((r) => r.marks.length === n);
  const oddRows = cores.filter((r) => r.marks.length !== n);
  // **列の中心 = その列に落ちた記号の x の平均**（全行ぶん）
  const centers: number[] = [];
  for (let c = 0; c < n; c++) centers.push(rows.reduce((sum, r) => sum + r.marks[c].cx, 0) / rows.length);
  // **境界は中心の中点**（外側は隣の間隔の半分だけ外に伸ばす）。**等間隔で割らない**
  const cols: number[] = [centers[0] - (centers[1] - centers[0]) / 2];
  for (let i = 1; i < centers.length; i++) cols.push((centers[i - 1] + centers[i]) / 2);
  cols.push(centers[n - 1] + (centers[n - 1] - centers[n - 2]) / 2);
  return { cols, n, left: cols[0], right: cols[n], rows, oddRows };
}

/**
 * 議員の列のアイテムか（氏名・会派の略称の候補）。
 *
 * ## **秋田には氏名の入り方が 2 通りある**（実測 2026-09-13。**#753 の「測り方 #1」が踏んだ罠**）
 * **#753 は「氏名を『1 文字 1 アイテム』と決めつけていた」と書き、`noName` が全部になったと記録している。**
 *
 * | 形 | 本数 | 例 | `w` / `h` |
 * |---|---:|---|---|
 * | **A. 縦書き 1 文字 1 アイテム** | **134** | `宇` `住` `児`（1 文字ずつ別アイテム） | w=h（正方） |
 * | **B. 縦書きが 1 アイテムに入る** | **20** | `"武 内"` `"小 棚 木"` `"加 賀 屋 千 鶴 子"` | **w=8.76 固定、h=22.32 / 29.04 / …** |
 *
 * **B は「横書きの複数文字」ではない**——**`w` が 1 文字ぶん（8.76pt）のまま `h` だけが伸びる。**
 * **つまり縦に積まれた文字が 1 アイテムになっているだけで、列は `cx` 1 点である。**
 * **`[...str].length === 1` で弾くと、この 20 本の議員が 1 人も見つからない**（実測: 19 本が
 * 「議員 0 人」で落ち、`R060228hyoketsu.pdf` だけが **35 列**を返した——**落ちるより悪い**）。
 *
 * **`w > h` のアイテム（本当の横書き。会派帯の `みらい`・凡例・議案名）は氏名にしない。**
 * **凡例の項目（`「○」：賛成` `／`）も氏名にしない**——**`／` は 1 文字なので、
 * 除かないと氏名として拾われる**（`080703.pdf` の凡例に 11 個）。
 */
export function isNameItem(it: Item): boolean {
  const s = it.str.replace(VARIATION_SELECTORS, "").replace(/[\s　]/g, "");
  if (s === "") return false;
  if (isLegendItem(it.str)) return false;
  if ([...s].some((c) => isVoteSymbol(c) || /[0-9０-９]/.test(c))) return false;
  if (isSingleGlyph(it.str)) return true;
  // **B の形**: 縦に積まれた文字が 1 アイテム。**幅が 1 文字ぶんで、高さがその整数倍**
  if (it.w <= 0 || it.h <= it.w * 1.2) return false;
  const n = [...s].length;
  if (n < 2) return false;
  const per = it.h / n;
  return per > it.w * 0.6 && per < it.w * 1.8;
}

/**
 * 議員（氏名と会派の略称）。**列は `findMemberColumns` が決めてあり、ここは落とすだけ。**
 *
 * **氏名は「いちばん上の票の行より上、かつ列の中」のアイテム**を上から繋ぐ。
 * **A（1 文字ずつ）は繋がり、B（縦積み 1 アイテム）はそのまま出る。**
 *
 * ## **会派は略称を「その 1 列」にだけ付ける。隣に広げない**
 * **秋田の会派帯は「略称を覆う列の上に置かれた 1 アイテム」**で、**幅は覆う列の幅ではない**
 * （実測 `h291222giketu.pdf`: y=697.4 に `自|民|みらい|社民|つなぐ会|鳳`、
 * y=700.9 / 691.1 に `公|共|もり` `明|産|やま` が **2 段に割れて**並ぶ）。
 * **罫線で割るのも当たらない**（罫線で列を割れるのは 196 ページ中 24 ページだけ。#753）。
 * **「この会派は右に何人ぶん続く」と決めるのは推定であり、境を 1 列間違えれば
 * その議員の会派が嘘になる**（#569）。**空は「読めなかった」であって「無所属」ではない。**
 * **会派名は突き合わせに使っていない**（議員は氏名で名簿と突き合わせる）ので、
 * 空でも別人の記録にはならない。
 *
 * **略称は凡例で正式名に直せる**（`自民：自由民主党`）が、**直さず略称のまま残す**——
 * **`legend.groups` に原文があるので、利用者側で引ける。**
 */
export function readMembers(page: PageGeometry, mc: MemberColumns): VotePdfMember[] {
  // **氏名の候補 = いちばん上の票の行より上、かつ議員の列の x の中**
  // （票の行より下は議案の行。列の外は左の欄・右の余白・見出し）
  const topRowY = Math.max(...mc.rows.map((r) => r.cy), ...mc.oddRows.map((r) => r.cy), -Infinity);
  const cands = page.items.filter((i) => isNameItem(i) && i.cx >= mc.left && i.cx < mc.right && i.cy > topRowY);
  const empty = (): VotePdfMember[] => new Array(mc.n).fill(0).map(() => ({ nameText: "", group: "" }));
  if (cands.length === 0) return empty();

  // ## **氏名と会派の境は「氏名帯の上端」**（実装中に測って決めた）
  //
  // **氏名は縦書きで下に伸びる**（実測 `h291222giketu.pdf` の 1 人目 `佐々木雄太` は
  // cy=681.5 / 672.3 / 663.0 / 644.5 / 626.1 の 5 文字）。**会派の略称はその上に 1〜2 段。**
  // **氏名帯の上端 = 「いちばん多くの列が埋まっている帯」の上端**（**氏名は全員に 1 文字目があるので、
  // 氏名の 1 文字目の帯がいちばん埋まる**）。
  //
  // **境を「氏名の 1 文字目の帯のすぐ上」に置く**——**これより上は会派、これ以下は氏名。**
  // **「いちばん上のアイテム」を境にしてはいけない**——**会派の略称も氏名も混ざる**
  // （実測: そうすると `賛否欄北林丈正` `平成２９年１２月２２日作成つなぐ会沼谷純` のような
  // **どの議員でもない氏名**ができた。**列見出しの `賛否欄` や右上の作成日が氏名に入った**）。
  // ## **帯は「アイテムの下端」でまとめる。上端ではない**（実測 2026-09-13）
  //
  // **B の形（縦積み 1 アイテム）では、氏名の長さでアイテムの高さが変わる**。
  // **上端はばらけるが、下端は揃っている**（実測 `060220hyoketsu.pdf` の姓の帯）:
  //
  // | 氏名 | 文字数 | `h` | 上端 | **下端** |
  // |---|---:|---:|---:|---:|
  // | `"加 賀 屋 千 鶴 子"` | 6 | 59.16 | 525.4 | **466.2** |
  // | `"小 棚 木"` | 3 | 29.04 | 495.2 | **466.2** |
  // | `"武 内"` | 2 | 22.32 | 488.5 | **466.1** |
  // | `高` | 1 | 8.76 | 475.0 | **466.2** |
  //
  // **姓の欄は下揃え**（姓の下に名が続く）。**上端でまとめると 4 つの別の帯になり、
  // 3 文字以上の姓が会派の側に落ちた**（実測: `小棚木` `宇佐見` `佐々木` が会派名になり、
  // **`加賀屋千鶴子` は氏名が空になった**）。
  // **下端でまとめれば 1 つの帯になる。** **A の形（1 文字 1 アイテム）でも同じ**——
  // **1 文字なら上端と下端は 1 文字ぶんしか違わないので、どちらでも同じ帯になる。**
  const bands: { bottom: number; cols: Set<number> }[] = [];
  for (const it of [...cands].sort((a, b) => b.y - a.y)) {
    const c = columnOf(mc.cols, it.cx);
    if (c === undefined) continue;
    const last = bands[bands.length - 1];
    if (last && Math.abs(last.bottom - it.y) <= Math.max(it.w, 1) * 0.6) { last.cols.add(c); continue; }
    bands.push({ bottom: it.y, cols: new Set([c]) });
  }
  if (bands.length === 0) return empty();
  let nameBottom = bands[0].bottom;
  let bestN = 0;
  for (const b of bands) if (b.cols.size > bestN) { bestN = b.cols.size; nameBottom = b.bottom; }
  // ## **姓の帯に「属するか」で分ける。y の境界で切らない**（実装中に 3 回直した）
  //
  // **境界の y を 1 本引く形は、どの引き方でも壊れた**（実測 2026-09-13）:
  //
  // | 引き方 | 壊れ方 |
  // |---|---|
  // | **上端のいちばん高い所** | **B の形で `加賀屋千鶴子`（6 文字ぶん上に伸びる）に引きずられ、会派 5 つが氏名に入った**（`社 民加 藤 麻 里`） |
  // | **下端 ＋ 1 文字ぶん** | **B の形で 3 文字以上の姓（`小棚木` `宇佐見` `佐々木`）が会派に落ちた** |
  // | **いちばん多い列が埋まる帯の上端** | **同じ**（帯の中で上端がばらけるので代表値が要る） |
  //
  // **y の 1 本では分けられない**——**B の形では、`加賀屋千鶴子`（上端 525.4）と `高`（475.0）が
  // 同じ「姓の帯」に属し、会派の `社 民`（上端 506.9）はその 2 つの間にある。**
  //
  // **だから「下端が姓の帯の下端と揃っているか」で分ける**——**姓は下揃え**（下端 466.1〜466.2 で揃う）、
  // **会派の縦書きの略称は別の下端**（`社 民` は 488.5、`自民` は 476.0）。
  // **これは y の 1 本ではなく「属するか」の判定**なので、アイテムの高さに引きずられない。
  const glyph0 = Math.max(...cands.map((i) => i.w), 1);
  const inNameBand = (it: Item): boolean => Math.abs(it.y - nameBottom) <= glyph0 * 0.6;
  // **姓の帯より下は名**（`伸 文` `政 之` `健` …）。**姓の帯より上で、帯に属さないものが会派。**
  const nameCeiling = Math.max(...cands.filter(inNameBand).map((i) => i.y + i.h));

  // **氏名 = 姓の帯に属するもの（姓）＋ それより下のもの（名）**
  const names = cands.filter((i) => inNameBand(i) || i.y + i.h <= nameBottom + glyph0 * 0.6);
  // ## **会派の略称は「氏名帯のすぐ上の 2 段」だけ**（実装中に測って決めた）
  //
  // **「境より上の全部」にしてはいけない**——**議員の帯の x の中に、会派でないものが入る**（実測）:
  //   - **列見出しの `賛否欄`**（`h291222giketu.pdf`: cy=752.7、議員の帯は x=658〜1126 に掛かる）
  //   - **右上の作成日 `平成２９年１２月２２日作成`**（同 cy=716.7、x=1024〜1115）
  //   - **新しい形の `■賛否`**（`060220hyoketsu.pdf`: cy=528.6）
  // **入ると `賛否欄北林丈正` `平成２９年１２月２２日作成つなぐ会沼谷純` のような会派名ができた。**
  // **会派名が嘘になっても別人の記録にはならない**（議員は氏名で名簿と突き合わせる）**が、
  // `meta.json` にも `rollcalls/*.json` にも載るので、読んだ人が誤解する。**
  //
  // **会派の略称は氏名帯のすぐ上に 1〜2 段**（実測 `h291222giketu.pdf`:
  // 氏名の 1 文字目が cy=681.9、会派が cy=697.4 と cy=700.9 / 691.1 の 2 段）。
  // **「氏名帯の上端から 3 文字ぶん」に限る**——**列見出しと作成日はそれより上にある**
  // （実測の差: 会派の 1 段目は 15.5pt ＝ 1.9 文字ぶん、列見出しは 70.8pt ＝ 8.5 文字ぶん）。
  const labels = page.items.filter((i) => i.cx >= mc.left && i.cx < mc.right && !inNameBand(i) && i.y >= nameBottom && i.y + i.h > nameBottom + glyph0 * 0.6 && i.y <= nameCeiling + glyph0 * 3 && !isLegendItem(i.str));
  const out: VotePdfMember[] = [];
  for (let c = 0; c < mc.n; c++) {
    const x0 = mc.cols[c];
    const x1 = mc.cols[c + 1];
    // **A（1 文字ずつ）は上から繋ぐ。B（縦積み 1 アイテム）は 1 つでその列の氏名すべて**
    const nameText = joinVertical(names.filter((i) => i.cx >= x0 && i.cx < x1)).replace(/[\s　]+/g, " ").trim();
    const group = labels.filter((i) => i.cx >= x0 && i.cx < x1).sort((a, b) => b.y - a.y).map((i) => i.str).join("").replace(/[\s　]+/g, "");
    out.push({ nameText, group });
  }
  return out;
}

/* ---------- 議案の行 ---------- */

/** 文字を上の行から順に、行の中は左から結合（空白は除く）。 */
const joinText = (chars: readonly Item[]): string =>
  [...chars].sort((a, b) => b.y - a.y || a.x - b.x).map((c) => c.str).join("").replace(/[\s　]+/g, "");

/**
 * 議案の行。**票の行 1 本 ＝ 議案 1 件。**
 *   1. 票の行（`findMemberColumns` が作ったもの）を上から順に取る
 *   2. **芯の個数が議員の数と一致する行だけ記号を置く**（合わなければその行は丸ごと `不明`）
 *   3. 左の欄は、**議決月日の欄の y を錨**にして配る
 */
function readRows(page: PageGeometry, mc: MemberColumns, pageNo: number): VotePdfRow[] {
  const rows = [...mc.rows, ...mc.oddRows].sort((a, b) => b.cy - a.cy);
  if (rows.length === 0) return [];
  // 氏名帯の下端（票の行より上は氏名・会派・凡例・見出し）
  const bandBottom = rows[0].cy + Math.max(rows[0].h, 1);
  // **議決月日の欄の y を錨にする**（青森 #750 と同じ判断）——
  // **議決月日は 1 議案に 1 つだけ立つ 1 アイテム**（`12月22日`）で、**件名が何行に折り返しても増えない。**
  // **秋田は件名が 2 行に折り返す議案がある**（実測 `h291222giketu.pdf` の 議案第194号 は
  // 件名が y=388.6 と y=379.3 の 2 行に割れ、番号・表決方法・結果は y=384.4 の 1 行にある）。
  // **番号では錨にならない**——**番号と件名が 1 アイテムに繋がる本がある**
  // （実測 `060220hyoketsu.pdf`: `号 令和５年度秋田県一般会計補正予算（第８号）` が 1 アイテム）。
  const anchors = [...new Set(
    page.items
      .filter((i) => i.x + i.w <= mc.left + 1 && i.cy < bandBottom && DATE_IN.test(i.str))
      .map((i) => i.cy),
  )].sort((a, b) => b - a);
  // **1 つの錨を 2 つの票の行に付けない**（青森 #750 と同じ。付けると隣の行が 2 議案ぶんを持つ）
  const used = new Set<number>();
  const rowAnchor = rows.map((b) => {
    let best: number | undefined;
    for (const y of anchors) {
      if (used.has(y)) continue;
      if (best === undefined || Math.abs(y - b.cy) < Math.abs(best - b.cy)) best = y;
    }
    if (best === undefined || Math.abs(best - b.cy) > Math.max(b.h, 1) * 3) return b.cy;
    used.add(best);
    return best;
  });
  const allAnchors = [...new Set([...rowAnchor, ...anchors])];
  const rowItems: Item[][] = rows.map(() => []);
  for (const it of page.items) {
    if (it.x + it.w > mc.left + 1) continue; // 議員の帯の中は票
    if (it.cy >= bandBottom) continue; // 氏名帯より上（見出し・凡例・列見出し）
    const nearest = allAnchors.reduce((bestY, y) => (Math.abs(y - it.cy) < Math.abs(bestY - it.cy) ? y : bestY), allAnchors[0] ?? Infinity);
    const r = rowAnchor.indexOf(nearest);
    if (r >= 0) rowItems[r].push(it);
  }
  const out: VotePdfRow[] = [];
  for (let r = 0; r < rows.length; r++) {
    out.push({ page: pageNo, ...readLeftCells(rowItems[r]), cells: readVoteCells(rows[r], mc) });
  }
  return out;
}

/**
 * 左の欄（議案等番号／件名／議決月日／表決方法／議決結果／表決者数／賛成者数／反対者数）を読む。
 *
 * ## **欄の境で切るのではなく、議決月日を「錨」にして左右に分ける**（実装中に測って決めた）
 *
 * **最初は青森（#750）と同じく「欄の左端を全行ぶん重ねて境界を作り、右から数える」形で書いた。**
 * **秋田では当たらなかった**——**左の欄のアイテムの割れ方が本ごとに違う**（実測 2026-09-13）:
 *
 * | 形 | 例 | アイテムの割れ方 |
 * |---|---|---|
 * | **古い形** | `h291222giketu.pdf` | `議案第 184 号` ＋ `秋田県人事委員会の…` ＋ `12月22日` ＋ `起立` ＋ `同意` ＋ `40` ＋ `40`（**7 アイテム**） |
 * | **新しい形** | `060220hyoketsu.pdf` | `議案第` ＋ `1` ＋ **`号 令和５年度秋田県一般会計補正予算（第８号）`** ＋ `2月20日` ＋ `簡易` ＋ **`原案可決 40 40`**（**6 アイテム。番号と件名が 1 つ、結果と数が 1 つ**） |
 *
 * **新しい形では「番号の欄」と「件名の欄」の境が、アイテムの途中にある**（`号 令和５年度…`）。
 * **境界で切ると `議案第` / `1` / `号令和５年度…` の 3 つが別の欄に入り、
 * 番号が `議案第`、議決月日が `1`、表決方法が `号令和５年度…` になった**（実測）。
 *
 * **採ったのは「議決月日のアイテムを錨にする」形**——**`M月D日` は 154 本すべての各行に 1 つだけ立つ**
 * （#753 が確かめた）**1 アイテム**で、**他のどの欄とも混ざらない。**
 * **その左が「番号＋件名」、その右が「表決方法／議決結果／数」である。**
 * **右側は 154 本すべてで `表決方法` → `議決結果` → 数 の順**（#615 が実測した列立て）。
 *
 * **数は「右側に出る数字を左から 3 つ」**（表決者数／賛成者数／反対者数）。
 * **反対 0 の行は反対者数の欄が空**（実測: `40 40` の 2 つしか出ない行がある）ので、
 * **3 つ揃わなければ counts 無し**（0 と書かない。**原文に無い数を作らない**）。
 *
 * **議決月日のアイテムが無い行は、全部の欄を空にする**（推定しない）。
 * **その行は `rollcalls.ts` が採決にしない**（日付が読めないので）。
 */
function readLeftCells(items: readonly Item[]): { number: string; title: string; dateText: string; method: string; result: string; counts?: { yes: number; no: number; voting: number } } {
  const empty = { number: "", title: "", dateText: "", method: "", result: "" };
  const sorted = [...items].sort((a, b) => a.x - b.x);
  // **議決月日の錨**（`M月D日`。**1 行に 1 つだけ**）。**隣の欄と同居する本がある**ので「含む」で探す
  const dateIdx = sorted.findIndex((i) => DATE_IN.test(i.str));
  if (dateIdx < 0) return empty;
  const dateItem = sorted[dateIdx].str;
  const dm = dateItem.match(DATE_IN)!;
  const dateText = dm[0];
  // ## **番号と件名は「x で分ける」。繋いでから切ってはいけない**（実装中に踏んだ）
  //
  // **件名が 2 行に折り返す議案がある**（実測 `080319.pdf` の 議案第78号）:
  // ```
  // cy=219.8 x=160.3 "秋田県行政手続における…個人番号の利"     ← 件名 1 行目
  // cy=213.7 x=30.8  "34"  x=83.8 "議案第"  x=125.5 "78"  x=146.1 "号"   ← 通し番号と議案等番号
  // cy=207.5 x=160.3 "用及び特定個人情報の提供に関する条例の一部を改正する条例案"  ← 件名 2 行目
  // ```
  // **番号の行が件名の 2 行の「あいだ」にある**（番号は縦の中央に置かれる）。
  // **y の降順で繋ぐと `…個人番号の利` ＋ `34議案第78号` ＋ `用及び…` になり、
  // 件名の途中に番号が挟まる**（実測でこの形の title が出た。**どの議案の件名でもない文字列**）。
  //
  // **番号の欄と件名の欄は x が違う**（実測: 番号 30.8〜151.6、件名 160.3〜）ので、**x で分ける。**
  // **境は「`第N号` に当たるアイテム列の右端」**——**`議案第` `78` `号` が別アイテムに割れる本があるので、
  // 「番号に当たるひとかたまり」を左から探す。**
  const leftItems = sorted.slice(0, dateIdx);
  // **日付のアイテムの中で日付より前の部分**（`議案第 1 号 … 12月22日` が 1 アイテムの本）は
  // **その 1 アイテムの中の話なので、そのまま前に足す**
  const inDateBefore = dateItem.slice(0, dm.index!).replace(/[\s　]+/g, "");
  // **左から順にアイテムを繋いでいって、`第N号` の形になった所で切る。**
  // **通し番号（`34`）が先に来る本がある**ので、**`第` を含むアイテムより前は番号に入れる。**
  let numberEnd = -1;
  let acc = "";
  for (let k = 0; k < leftItems.length; k++) {
    acc += leftItems[k].str.replace(/[\s　]+/g, "");
    if (NUMBER_CELL.test(acc)) { numberEnd = k; break; }
  }
  const numberText = numberEnd >= 0 ? acc : "";
  const numMatch = numberText.match(NUMBER_CELL);
  // **通し番号は番号ではない**（`34議案第78号` の `34`）ので、`第N号` の部分だけを採る
  const number = numMatch ? numMatch[0] : "";
  // **件名は残りのアイテム**（**y の降順・行の中は左から**。折り返しがここで正しく繋がる）
  const titleItems = numberEnd >= 0 ? leftItems.slice(numberEnd + 1) : leftItems;
  const title = joinText(titleItems) + (numberEnd >= 0 ? inDateBefore : "");
  // **番号が取れなかったときは、日付より前の全部を件名にする**（推定しない）
  const fallbackTitle = numberEnd >= 0 ? title : joinText(leftItems) + inDateBefore;
  // **錨より右 = 表決方法 → 議決結果 → 数**。
  // **日付のアイテムの中で日付より後ろの部分も右に足す**（`12月22日 簡易` が 1 アイテムの本がある。
  // 実測 `041222hyoketsu.pdf` の 44 行すべて）
  const afterDate = dateItem.slice(dm.index! + dm[0].length).trim();
  const rightTexts = [...(afterDate !== "" ? [afterDate] : []), ...sorted.slice(dateIdx + 1).map((i) => i.str.trim())];
  const method = rightTexts.length > 0 ? rightTexts[0].replace(/[\s　]+/g, "") : "";
  const restText = rightTexts.slice(1).join(" ");
  // **議決結果は数字より前の部分**（`原案可決 40 40` のように 1 アイテムに同居する本がある）
  const result = restText.replace(/[\s　]*[0-9０-９]+.*$/, "").replace(/[\s　]+/g, "");
  const nums = restText.normalize("NFKC").match(/\d+/g) ?? [];
  const counts = nums.length === 3 ? { voting: Number(nums[0]), yes: Number(nums[1]), no: Number(nums[2]) } : undefined;
  return { number, title: fallbackTitle, dateText, method, result, ...(counts ? { counts } : {}) };
}

/**
 * この行の記号 → 議員ごとのセル。
 *
 * **芯の記号の個数が議員の数と一致しなければ、全セルを `不明` にする**——
 * **数が合わない行を押し込むと、ずれた 1 列ぶん全員が別人の票になる**（#689 が滋賀で踏んだ形）。
 * **`findMemberColumns` が既に「一致した行」と「しなかった行」を分けてあるので、ここは長さで見る。**
 *
 * **一致した行は k 番目の記号を k 番目の列に入れる**——**`columnOf` で当て直しはしない。**
 * **芯は「等間隔に連なっているいちばん長い部分」**（`voteRowCore`）で、
 * **列の中心は「その列に落ちた記号の x の平均」**（`findMemberColumns`）なので、
 * **k 番目は定義上 k 番目の列に落ちる。**
 * **それでも「x が列の境界の中にあるか」を確かめる**——**確かめないと、
 * ずれが積もっても気づけない**（1 つでも外れたらその行は丸ごと `不明`）。
 */
export function readVoteCells(row: VoteRow, mc: MemberColumns): string[] {
  const cells: string[] = new Array(mc.n).fill(UNKNOWN_CELL);
  const core = voteRowCore(row.marks);
  if (core.length !== mc.n) return cells; // 数が合わない＝置かない（推定しない）
  for (let k = 0; k < mc.n; k++) {
    // **k 番目の記号が k 番目の列の中にあることを確かめる**（外れたらその行を丸ごと落とす）
    if (columnOf(mc.cols, core[k].cx) !== k) return new Array(mc.n).fill(UNKNOWN_CELL);
    cells[k] = core[k].ch;
  }
  return cells;
}

/** 値が区間 [lo, hi) のどこに入るか（`bandIndex` と違い境界を落とさない）。外なら undefined。 */
export function columnOf(cols: readonly number[], v: number): number | undefined {
  if (v < cols[0] || v >= cols[cols.length - 1]) return undefined;
  for (let i = 0; i + 1 < cols.length; i++) if (v >= cols[i] && v < cols[i + 1]) return i;
  return undefined;
}

/** アイテムに入っている表決記号の個数。**凡例のアイテムは 0 個**（下の `isLegendItem`）。 */
export const countVoteSymbols = (str: string): number => (isLegendItem(str) ? 0 : [...str].filter(isVoteSymbol).length);

/**
 * 凡例の項目のアイテムか（`「○」：賛成` / `○ ： 賛成` / `簡易：簡易表決（…）` / `自民：自由民主党` / `／`）。
 *
 * ## **凡例は議員の帯と同じ x に入る**（#753 の「測り方を 3 回直した」の 3 番目）
 * **実測 `080703.pdf`: `○ ： 賛成` が cx=940.7、議員の帯は x=825〜1531。**
 * **除かないと凡例の 3 行が票の行として数えられ、記号の個数が合わなくなる**
 * （実測: `080703.pdf` は 26 行の本文に対して 29 行、`h251008giketu.pdf` は 44 行に対して 47 行）。
 * **#753 は「記号の数が半分未満なら落とす」で落としきれず、
 * 『`：`『「』『／』と同じ y 帯を外す』ことで解けたと書いている。**
 *
 * **本文の票のセルには `：` も `「」` も `／` も入らない**（154 本の本文セルは記号と半角空白だけ。#753）。
 * **`／` は 1 文字なので、除かないと氏名としても拾われる**（`080703.pdf` の凡例に 11 個）。
 */
export const isLegendItem = (str: string): boolean => /[：:「」／]/.test(str);

/**
 * 結合アイテム（`"○ ○ … ○ 議 ○ … ○"`）を記号ごとの x に割る（#753 が 154 本で確かめたモデル）。
 *
 * **アイテム自身の文字列と `w` だけから決まる**（氏名の x を使っていないので循環しない）。
 * **半角（ASCII。空白・数字）は全角の半分の送り幅**として単位数を数え、`w ÷ 単位数` を 1 単位の幅とする。
 *
 * **実測**（`h291222giketu.pdf` の 36 記号、x=658.53 w=396.478、全角 36 ＋ 半角 35）:
 * **1 単位 7.4108pt。列の中心からのずれは 0.015 / 0.059 / 0.066 / … / 0.153 セル**（最大 0.153）。
 * **等分（全部同じ幅）に差し替えると 半セル以上 7,123、置けず 3,173、氏名なし 2,401**（#753 の変異 10）。
 *
 * **#753 は「半角の送り幅は全角の半分ではない」と書いている**（`020624giketu.pdf` で 0.371em と実測）。
 * **それでも 0.5 を採るのは、この実装では列の中心に当てるので余裕が半セルあり、
 * 0.371 と 0.5 のどちらでも同じ列に落ちるからである**（上の実測: 0.5 で最大 0.153 セル）。
 * **どちらが正しいかは分かっていない**——**0.371 は 1 本の実測で、フォントの送り幅を
 * 網羅的に測ったわけではない。** **どちらでも落ちる列が同じなら、モデルの単純なほうを採る。**
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
