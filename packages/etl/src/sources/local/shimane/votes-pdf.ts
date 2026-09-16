import { cluster, joinVertical, readPages, type Item, type PageGeometry } from "../pdf-table.ts";

/**
 * 島根県議会「議員別採決結果一覧」PDF の表復元（Issue #221、会期ごとの差分は #232）。
 *
 * この PDF には罫線がベクタで入っているが、引かれているのは「用紙全体の格子」だけで
 * 1 議案 1 行の高さとは一致しない（件名が 2 行の議案・付託委員会が 4 つの議案は行が高い）。
 * そこで罫線ではなく文字の位置で表を復元する。手がかりは次のとおりで、どれも推定ではなく PDF に書かれている:
 *   - 列: 議員の欄は等間隔（約 11.9pt）の縦書き 1 文字幅。1 ページ目の氏名の x をまとめたものが議員の列。
 *         左側は 議案番号 / 件名 / 付託委員会 / 採決結果 / 賛成 / 反対 の 6 列（→ Columns）。
 *   - 行: 議案番号の欄（1 議案に 1 つ、行の中心）を行の基準にする。件名・票のセルもその中心に揃っている。
 *         付託委員会は 1 議案に複数（最大 4）あり、等間隔に積まれたブロックの中心が行の中心に揃う
 *         （＝ブロックごとにまとめてから、中心が最も近い議案番号の行に入れる）。
 * 「議⾧」「除斥」は 1 セルの中の縦書き 2 文字なので、同じ列の近い y をまとめて 1 つのセルにする。
 * どの行にも置けない文字が出たら、そのセルは UNKNOWN_CELL（「不明」）にして数える（推定しない）。
 *
 * **同じ議会でも会期ごとに PDF の作りが違う**ので、決め打ちにせずその PDF から毎回引き直す（#232）:
 *   - 表の幅・位置（列の x）が違う → ヘッダの文字の位置と、本文の文字の書き出しから引く（Columns）
 *   - 節見出し「（議案）」…が 1 つも無い会期がある → kind は議案番号の欄のヘッダの語と番号の接頭辞から（kindOf）
 *   - 隣り合う 2 つの欄の中身が 1 つの文字列で書かれている行がある → 欄の変わり目の空白で切る（splitAtBoundary）
 *
 * 議決日はこの PDF に書かれていないので、同じ会期ページの「議決結果一覧」PDF（parseResultsPdf）から
 * 議案番号ごとに読む。請願・その他表決は議決結果一覧に載らないので、呼ぶ側（rollcalls.ts）が会期の最終議決日を使う。
 */

/** 置けなかったセルの原文（推定しない）。 */
export const UNKNOWN_CELL = "不明";
/** 置けなかったセルの凡例。 */
export const UNKNOWN_LEGEND = "抽出不能";

export interface VoteRow {
  /**
   * 節見出しの原文から「（）」を外したもの（「議案」「請願」「その他表決」）。
   * 節見出しの無い会期は、議案番号の欄のヘッダの語と番号の接頭辞から（kindOf）。
   */
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
  /**
   * **件名のセルの中心と、議案番号の欄の y（行の中心）のずれ（pt）**（Issue #866）。
   * この PDF には罫線が無く、行の上下の端はどこにも描かれていない。件名のセルが行の中心に
   * 揃っているという事実だけが、セルを行に結びつけている。**そこがずれていれば、
   * 件名が隣の行のものと混ざっている**（島根で 5 件、うち 1 件は正しい議案名の後ろに
   * 別議案の請願本文が連結していた）。**この値を公表して、呼ぶ側が見張れるようにする。**
   */
  titleOffset: number;
  /**
   * **付託委員会のセル（複数あれば塊）の中心と、議案番号の欄の y（行の中心）のずれ（pt）**（Issue #896）。
   *
   * **件名と同じで、この欄を行に結びつけているのは「塊の中心が行の中心に揃う」という事実だけである。**
   * **直す前は「隙間が `BLOCK_GAP=13` より狭ければ同じ塊」で切っていたが、
   * 13 本を測ったところ 12 本で「同じ議案の中の隙間」と「別の議案の間の隙間」が重なっていて、
   * 閾値では分けられなかった**（2025-06 はどちらも 10.08pt）。
   * **そこで件名と同じ切り分け方（`splitTitleCells`）に変え、ずれを公表して見張る。**
   */
  referredOffset: number;
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

/**
 * 左側の列の x の範囲。会期によって表の幅・位置が違う（令和8年6月は 議案番号 の中心が x=62.9、
 * 令和8年2月は x=66.2 と、表全体が右に寄って少し広い）ので、x を決め打ちにせず
 * **その PDF のヘッダの文字の位置**から毎回引き直す。手がかりはどれも PDF に書かれているもの:
 *   議案番号（請願だけの節のページでは「番号」）/ 件 名 / 付託委員会 / 採決結果 / 賛 成 / 反 対。
 * ただし 議案番号｜件名 と 件名｜付託委員会 の境目はヘッダの中心の中点では足りない
 * （どちらも欄の左端に寄せて書かれ、ヘッダ「件 名」「付託委員会」はセルの中心にある）ので、
 * 本文の文字が実際に書き出される x から引く（boundaryBetween / leftAlignedBoundary）。
 */
interface Columns {
  number: readonly [number, number];
  title: readonly [number, number];
  /** 件名の文字が実際に書き出される x。番号の文字列がここまで届いていれば件名も同じ文字列に入っている */
  titleLeft: number;
  /** 付託委員会の文字が実際に書き出される x。件名の文字列がここまで届いていれば付託委員会も同じ文字列に入っている */
  referredLeft: number;
  referred: readonly [number, number];
  result: readonly [number, number];
  yes: readonly [number, number];
  no: readonly [number, number];
  /** 議員の欄の左端（反対の欄の右端） */
  membersFrom: number;
  /** 議案番号の欄のヘッダの原文（「議案番号」「番号」）。節見出しが無い PDF の kind の手がかり */
  numberHeader: string;
}

/** ヘッダの文字を探す縦の許容差（「賛 成」は 2 行に分かれて上下にずれる）。 */
const HEADER_Y = 26;
/**
 * 欄の境目を決めるとき、これより狭い隙間しかなければ失敗（表の形が変わったのを黙って通さない）。
 * 実測の隙間は 議案番号｜件名 が 32pt 以上、件名｜付託委員会 が 2.7pt（6月）・2.8pt（2月）と幅が違うので、
 * 狭いほうに合わせた値。欄が詰まって見分けられなくなった場合に落とすための下限で、余裕の確認ではない。
 */
const MIN_COLUMN_GAP = 2;

const center = (i: Item): number => i.x + i.w / 2;

/** 1 ページのヘッダの文字の位置から左側の列の x の範囲を引く。 */
function columnsOf(page: PageGeometry, head: Item, pageNo: number): Omit<Columns, "number" | "title" | "titleLeft" | "referredLeft"> & { numberCenter: number; titleCenter: number; resultCenter: number } {
  const at = (s: string): Item | undefined => page.items.find((i) => i.str === s && Math.abs(i.y - head.y) < HEADER_Y);
  const numberHead = at("議案番号") ?? at("番号");
  const ken = at("件");
  const mei = at("名");
  const result = at("採決結果");
  const yes = at("賛");
  const no = at("反");
  if (!numberHead) throw new Error(`page ${pageNo}: 議案番号 header not found`);
  if (!ken || !mei) throw new Error(`page ${pageNo}: 件名 header not found`);
  if (!result) throw new Error(`page ${pageNo}: 採決結果 header not found`);
  if (!yes || !no) throw new Error(`page ${pageNo}: 賛成/反対 header not found`);
  const referredC = center(head);
  const resultC = center(result);
  const yesC = center(yes);
  const noC = center(no);
  const mid = (a: number, b: number): number => (a + b) / 2;
  const yesNo = mid(yesC, noC);
  return {
    referred: [mid(center(ken) + (center(mei) - center(ken)) / 2, referredC), mid(referredC, resultC)],
    result: [mid(referredC, resultC), mid(resultC, yesC)],
    yes: [mid(resultC, yesC), yesNo],
    no: [yesNo, noC + (noC - yesNo)],
    membersFrom: noC + (noC - yesNo),
    numberHeader: numberHead.str,
    numberCenter: center(numberHead),
    titleCenter: mid(center(ken), center(mei)),
    resultCenter: resultC,
  };
}

/**
 * 隣り合う 2 つの欄の境目を、本文の文字が実際に書き出される x から引く。
 * 左右の欄の内側 [lo, hi) にある本文の文字の左端 x を並べ、一番広い隙間
 * （左の欄の文字の終わりと右の欄の書き出しの間の余白）の真ん中を境目にする。
 * 隙間が狭ければ（＝2 つの欄が見分けられなければ）失敗する（表の形が変わったのを黙って通さない）。
 * `right` は右の欄の文字が実際に書き出される x。左の欄の文字列がここまで届いていれば、
 * その 1 つの文字列に右の欄の中身も入っている（令和8年2月の PDF にある結合された文字列）。
 */
function boundaryBetween(pages: PageGeometry[], bodyTops: number[], lo: number, hi: number, what: string): { boundary: number; right: number } {
  const xs: number[] = [];
  for (const [pi, page] of pages.entries()) {
    for (const i of page.items) {
      if (i.y < bodyTops[pi] && i.x > lo && i.x < hi) xs.push(i.x);
    }
  }
  const groups = cluster(xs, 1);
  let gap = 0;
  let boundary = 0;
  let right = 0;
  for (let i = 0; i + 1 < groups.length; i++) {
    if (groups[i + 1] - groups[i] > gap) {
      gap = groups[i + 1] - groups[i];
      boundary = (groups[i] + groups[i + 1]) / 2;
      right = groups[i + 1];
    }
  }
  if (gap < MIN_COLUMN_GAP) throw new Error(`${what} columns cannot be told apart (widest gap ${gap.toFixed(1)}pt)`);
  return { boundary, right };
}

/**
 * 件名の欄と付託委員会の欄の境目。件名は欄の左端（titleLeft）から書かれて行ごとに長さが違い
 * （2 行にわたる件名の続きの行は途中の x から始まることもある）、付託委員会は 1 議案に 1〜4 個、
 * どれも自分の欄の左端に揃えて書かれる。そこで
 *   付託委員会の書き出し = 件名の書き出しより右にある本文の文字の左端のうち、
 *                          同じ x に一番多く並んでいるもの（＝全議案ぶん揃っている欄の左端）
 * を取り、その手前までを件名の欄にする。境目は「件名の右端の最大」と「付託委員会の書き出し」の中点。
 * 件名が付託委員会の書き出しまで届いている行（＝2 つの欄が 1 つの文字列になっている行）は、
 * 右端の最大を取るときには数えない（その行は後で境目で切り分ける）。
 */
function leftAlignedBoundary(pages: PageGeometry[], bodyTops: number[], titleCenter: number, hi: number, titleLeft: number, what: string): { boundary: number; right: number } {
  const inBody = (i: Item, pi: number): boolean => i.y < bodyTops[pi];
  const lefts: number[] = [];
  for (const [pi, page] of pages.entries()) {
    for (const i of page.items) if (inBody(i, pi) && i.x > titleCenter && i.x < hi) lefts.push(i.x);
  }
  const groups = cluster(lefts, 1);
  if (groups.length === 0) throw new Error(`${what} columns cannot be told apart (no 付託委員会 text found)`);
  const count = (x: number): number => lefts.filter((v) => Math.abs(v - x) <= 1).length;
  // 一番多く並んでいる x。同数なら左のものを取る（付託委員会の欄は必ず全議案ぶん並ぶ）
  const right = groups.reduce((best, x) => (count(x) > count(best) ? x : best), groups[0]);
  let titleRight = titleLeft;
  for (const [pi, page] of pages.entries()) {
    for (const i of page.items) {
      if (!inBody(i, pi) || i.x < titleLeft || i.x >= right) continue;
      if (i.x + i.w > right) continue; // 欄をまたいで結合された文字列は数えない
      titleRight = Math.max(titleRight, i.x + i.w);
    }
  }
  const gap = right - titleRight;
  if (gap < MIN_COLUMN_GAP) throw new Error(`${what} columns cannot be told apart (widest gap ${gap.toFixed(1)}pt)`);
  return { boundary: (titleRight + right) / 2, right };
}

/** 凡例の行（「○」･･･賛成、…）。 */
const LEGEND_LINE = /「(.+?)」\s*[･・.]{2,}\s*([^、。]+)/g;
/** 節見出し（議案）（請願）（その他表決）。 */
const SECTION = /^[（(](.+?)[）)]$/;
/** 見出し（第499回…採決結果）。 */
const TITLE_LINE = /^第.+回島根県議会（.+）採決結果$/;
/** 表の下の注記（「※請願17、29号の「賛成・反対」は…」）。セルではないので notes に移す。 */
const FOOTNOTE = /^※/;
/** 議長の欄（「議⾧」。長は康熙部首 U+2FA7 で書かれている）。 */
const GICHO_CELL = /^議[長⾧]$/;
/** 議長は採決に加わらない、という注記（凡例の記号一覧には「議⾧」が無いので、これを凡例の根拠にする）。 */
const GICHO_NOTE = /議[長⾧]の職務を行う者は採決に加わりません/;

/**
 * **ヘッダ行と本文の境目を、その PDF のヘッダの字の位置から引く**（Issue #896）。
 *
 * **直す前は `付託委員会` の y から一律 `6pt` 下を境目にしていた**（`HEADER_GAP = 6`）。
 * **だがヘッダの「賛 成」「反 対」は 2 行に分かれて書かれており、2 文字目（`成`・`対`）は
 * `付託委員会` より下にある。** **その距離は本によって違う**——
 * **14 本を全部測った実測（`付託委員会` の y から `成`/`対` の y までの pt）**:
 *
 * | 会期 | 距離 | `6pt` で本文に漏れるか |
 * |---|---|---|
 * | 2025-09 | **4.44**（最小） | 漏れない |
 * | 2025-11 / 2024-06 / 2024-09 / 2024-11 / 2025-06 / 2025-02 / 2025-05-rinji | 4.68〜5.28 | 漏れない |
 * | 2026-02 | 5.52 | 漏れない |
 * | **2026-06 / 2024-02** | **5.88**（**余裕 0.12pt**） | **漏れない（紙一重）** |
 * | **2023-11 / 2023-06** | **9.15** | **漏れる**（`成32` / `対2` になって「数ではない」で落ちる） |
 *
 * **つまり一律の値では、いま本番に出ている 2026-06 でさえ余裕が 0.12pt しかない。**
 *
 * **そこで閾値をやめ、境目をその PDF から引く**——
 * **ヘッダの字（`議案番号`/`番号`・`件`・`名`・`付託委員会`・`採決結果`・`賛`・`成`・`反`・`対`）の
 * y の最小を「ヘッダ行の下端」とし、そのすぐ下からを本文にする。**
 * **13 本すべてで、どのページでも下端は `成`/`対` であり、その次に来る字は議員の縦書きの氏名だった**
 * （**表の本文＝議案番号・件名・○● は 1 文字も境目より上に無い**。実測）。
 *
 * **この 0.5pt は「ヘッダの字そのものを本文に入れない」ためだけの余白**であり、
 * 上の表のような「本によって違う距離」を吸収する役目は持たない（そこは PDF から引いている）。
 * **実測の「下端とその次の字」の隙間は 3.36〜6.86pt** なので、0.5 はどちらの側にも当たらない。
 */
const HEADER_EPS = 0.5;
/** ヘッダの字として探す語（`columnsOf` が列を引くのに使うものと同じ。`成`・`対` は 2 行目に落ちる 2 文字目）。 */
const HEADER_WORDS = ["議案番号", "番号", "件", "名", "付託委員会", "採決結果", "賛", "成", "反", "対"] as const;

/**
 * そのページの本文の上端（これより下が表の中身）。
 * ヘッダの字のうち最も下にあるものの y から `HEADER_EPS` だけ下。
 * ヘッダの字は `付託委員会` の y の上下 `HEADER_Y` の範囲で探す（`columnsOf` と同じ探し方）。
 */
function bodyTopOf(page: PageGeometry, head: Item): number {
  const ys = page.items.filter((i) => HEADER_WORDS.includes(i.str.trim() as (typeof HEADER_WORDS)[number]) && Math.abs(i.y - head.y) < HEADER_Y).map((i) => i.y);
  return Math.min(...ys, head.y) - HEADER_EPS;
}

/**
 * 議案番号の欄のヘッダの原文（「議案番号」「番号」）→ その表が何の表かの語。
 * 節見出しの無い PDF（令和8年2月定例会）で kind の手がかりにする。
 */
const NUMBER_HEADER_KIND: Record<string, string> = { "議案番号": "議案" };
/**
 * 議案等番号の原文の接頭辞のうち、それ自体が別の種別を名乗っているもの。
 * 「請願第28号」は請願であって議案ではない（議決結果一覧 PDF にも載らない）。
 * 「承認第N号」「議員提出第N号」は 6月の PDF では（議案）の節にあるので、議案のまま扱う。
 */
const SELF_NAMED_KIND = ["請願", "陳情"] as const;

/**
 * 行の kind。節見出し（「（議案）」「（請願）」「（その他表決）」）があればそれが原文なのでそのまま使う。
 * 令和8年2月定例会の PDF には節見出しが無く、全部が「議案番号」という 1 つの表になっているので、
 * その欄のヘッダの語（「議案番号」→「議案」）を使い、番号自身が別の種別を名乗っている行
 * （「請願第28号」）だけはその接頭辞を使う。どちらも PDF に書かれている語で、推定で足した語ではない。
 */
function kindOf(section: string | undefined, numberHeader: string, number: string, pageNo: number): string {
  if (section !== undefined) return section;
  const self = SELF_NAMED_KIND.find((k) => number.startsWith(k));
  if (self) return self;
  const kind = NUMBER_HEADER_KIND[numberHeader];
  if (!kind) throw new Error(`page ${pageNo} ${number}: no 節見出し and 議案番号 header "${numberHeader}" does not say what the table is`);
  return kind;
}
/**
 * 同じ行に置かれた文字列とみなす y の差（#866）。1 行が 2 つのアイテムに分かれて書かれている行がある
 * （令和8年6月 1 ページ目の「《浜田養護学校整備（高等部棟」「建築）工事》」は y の差が 0.00）。
 * 実測の行送りは 10.6pt（令和8年2月）・11.4pt（令和8年6月）なので、それより十分小さい値。
 */
const SAME_LINE = 2;
/**
 * **件名のセルの中心が、議案番号の欄の y（行の中心）からずれてよい上限（pt）**（Issue #866）。
 *
 * **#866 は 2 本のフィクスチャだけを見て `8` にした。それが 2024-09 で偽陽性になった**（#896）——
 * **`throw` するので、その会期の ETL がまるごと止まる。**
 * **#866 の担当者自身が「余裕は 2.84pt しかない」と書いた懸念が、実測で当たった。**
 *
 * ## **14 本すべてを母数にして測り直した**（#896。**2 本ではなく 14 本**）
 *
 * **正しい側**（`splitTitleCells` が割り当てた、そのままの値。**8 本・320 行**）:
 *
 * | ずれ | 行 | |
 * |---|---|---|
 * | **12.36** | 1 | **2024-09 請願第14号**。**#866 の `8` はここで落ちていた** |
 * | 5.16 | 1 | 2026-06 請願第30号 |
 * | 4.80 以下 | 318 | 残り全部（大半は 0.30 以下） |
 *
 * **壊れている側**（`splitTitleCells` を通さず「1 行ずつ y が近い議案へ」に戻したときの値。**同じ 8 本・210 行**）:
 *
 * | ずれ | 行 |
 * |---|---|
 * | **17.88 〜 47.15** | **10**（請願本文を巻き込んだ行。2023-06 請願第２号の 47.15 が最大） |
 * | **0.30 以下** | **200** |
 * | **その間（0.30 〜 17.88）** | **0 行** |
 *
 * **壊れている側は二山に分かれ、間に 1 行も無い。**
 * **正しい側の最大 12.36 と、壊れている側の最小 17.88 の間**に置けばよい。
 *
 * **`15` はその真ん中である**（正しい側に 2.64pt、壊れている側に 2.88pt）。
 * **8 〜 17 のどの値でも、壊れている側で落ちる行は 210 行中 10 行で変わらない**（実測）——
 * **つまり緩めても、見張りが捕まえる壊れ方は 1 件も減らない。**
 *
 * **「件名が長いほどずれる」ではない**（#874 が「確かめていない」と書いた点を測った）:
 * **請願第11号は 672 字で ずれ 0.00、請願第14号は 610 字で ずれ 12.36。**
 * **字数とずれに対応は無いので、字数で上限を伸び縮みさせることはできない。**
 *
 * **この上限だけでは足りない行がある、と先に書いておく。**
 * 直す前の**請願第28号のずれは −0.20pt で、この上限の内側だった**
 * （上下の行に 5 行ずつ対称に取られたので、塊の中心が動かなかった）。
 * **それでも見張りとして働くのは**、その 5 行を取った先が上下の行であり、
 * **上下の行のほうが ±27pt に飛ぶから**である（同じページの合計のずれは 55.20 → 0.80）。
 * **1 行だけを見て安心しないこと。** ページの全行を通してはじめて壊れを名指しできる。
 */
const MAX_TITLE_OFFSET = 15;
/**
 * **付託委員会の塊の中心が行の中心からずれてよい上限（pt）**（Issue #896）。
 *
 * **14 本すべてを母数にした実測**（`splitTitleCells` で切り分けた、読めた 7 本・**274 行**）:
 *
 * | | 正しい側 | **切り分けをやめた側**（1 行ずつ y が近い議案へ） |
 * |---|---|---|
 * | ずれの最大 | **0.30pt** | **13.81pt** |
 * | ずれが 0.5pt を超える行 | **0 / 274** | **16 / 274** |
 * | その最小 | — | **4.44pt** |
 *
 * **正しい側は 274 行すべてが 0.30pt 以内に収まる**——**件名（最大 12.36pt）より遥かに揃っている。**
 * **2 はその 6 倍以上の余裕を取りつつ、壊れている側の最小 4.44 の半分以下である。**
 */
const MAX_REFERRED_OFFSET = 2;
/** 縦書きのセル（議⾧・除斥）をまとめる距離。1 文字ぶん（約 11.4pt）より少し大きく。 */
const CELL_GAP = 13;


const inX = (it: Item, [lo, hi]: readonly [number, number]): boolean => it.x >= lo && it.x < hi;

/** テキストを詰める（PDF の行内の空白は落とす。原文の文字は変えない）。 */
const joinText = (items: Item[]): string => [...items].sort((a, b) => b.y - a.y || a.x - b.x).map((i) => i.str).join("").replace(/\s+/g, "");

/**
 * 隣り合う 2 つの欄の中身が 1 つの文字列として書かれているとき、それを 2 つに切り分ける。
 * 令和8年2月定例会の PDF にはこの形の行がある（6月の PDF では欄ごとに別の文字列になっている）:
 *   「議 員 提 出 第 2 号 島根県議会委員会条例の一部を改正する条例」（議案番号＋件名）
 *   「非常勤の職員等の報酬及び費用弁償支給条例等の一部を改正する条例 総務委員会」（件名＋付託委員会）
 * どちらも欄の変わり目に**空白**が入っている（左の欄の中身・空白・右の欄の中身）。
 * 切れ目は「右側に空白がもう出てこない最後の空白」＝欄の変わり目の空白とする
 * （議案番号の「議 員 提 出 第 2 号 」は字間に空白を入れて書かれているので、
 * 一番近い空白ではなく最後の空白でなければ番号の途中で切れてしまう）。
 * 空白が無ければどこが変わり目か決められないので切らない（推定で切らない）。
 * 切ったあとの x・幅は、文字列全体を等幅とみなした概算（行に入れるための位置決めにしか使わない）。
 */
function splitAtBoundary(it: Item, boundary: number): { left: Item; right: Item } | undefined {
  const chars = [...it.str];
  if (chars.length < 2) return undefined;
  const isSpace = (c: string): boolean => c === " " || c === "　";
  // 右側に空白がもう出てこない最後の空白の位置（その次の文字から右の欄）
  let n = -1;
  for (let i = chars.length - 1; i >= 0; i--) {
    if (isSpace(chars[i])) { n = i + 1; break; }
  }
  if (n <= 0 || n >= chars.length) return undefined;
  const leftStr = chars.slice(0, n).join("");
  const rightStr = chars.slice(n).join("");
  if (leftStr.trim() === "" || rightStr.trim() === "") return undefined;
  // 切ったあとの右側は、右の欄の書き出し（boundary の右）に置く。
  // 左右の文字幅が違う（番号は字間を空けた細い字、件名は全角）ので、等幅の概算では位置が出せない。
  return {
    left: { ...it, str: leftStr, w: boundary - it.x, cx: (it.x + boundary) / 2 },
    right: { ...it, str: rightStr, x: boundary, w: it.x + it.w - boundary, cx: (boundary + it.x + it.w) / 2 },
  };
}

/**
 * 件名の欄を「行ごとのセル」に切り分ける（Issue #866）。
 *
 * **なぜ 1 行ずつ y の近い議案番号に入れてはいけないか。**
 * この PDF には**罫線が 1 本も無い**（`readPages` の `hlines`/`vlines` はどのページも 0 本）。
 * 行の手がかりは議案番号の欄の y（＝行の**中心**）だけで、**行の上下の端はどこにも描かれていない。**
 * 件名のセルは 1 行のものもあれば、請願の本文が丸ごと入って 20 行を超えるものもある。
 * 高いセルは上下の議案番号より外まで伸びるので、**1 行ずつ「y が一番近い議案番号」に入れると
 * 上端の数行が上の議案へ、下端の数行が下の議案へこぼれる**（島根で 5 件、うち承認第２号は
 * 正しい議案名の後ろに別議案の請願本文が連結した）。
 *
 * **行の高さが違っても使える事実は 1 つだけ**——件名のセルは**行の中心に揃えて**書かれている
 * （付託委員会の欄がすでにそれを使っている）。そこで件名の行を**上から順に、切れ目を入れずに**
 * 議案の数ぶんの塊に分け、**塊の中心と議案番号の y のずれの合計が最小になる分け方**を選ぶ。
 * 上から順に並んだ行を並べ替えずに分けるので、**行が入れ替わることはない**（推定で並べ替えない）。
 *
 * **行の高さやセルの字数は使わない。** 68 字 1 セル（第39号）も 480 字 1 セル（請願第30号）も
 * 同じ規則で通る。**字数の上限は機序ではないので、ここでは見ない。**
 *
 * **件名の行が議案の数より少ないときは分けられない**（件名が空の議案があることになる）。
 * そのときは**分けずに undefined を返し**、呼ぶ側が今までどおり 1 行ずつ近い行へ入れる
 * （その場合は「件名が空」で落ちる。黙って推定で埋めない）。
 */
export function splitTitleCells(lines: Item[][], anchors: number[]): Map<number, Item[]> | undefined {
  const n = lines.length;
  const m = anchors.length;
  if (m === 0 || n < m) return undefined;
  // dp[j][i] = 上から i 行を j 個の塊に分けたときの「塊の中心と議案番号の y のずれ」の合計の最小
  const INF = Number.POSITIVE_INFINITY;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(INF));
  const back: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(-1));
  dp[0][0] = 0;
  for (let j = 1; j <= m; j++) {
    for (let i = j; i <= n; i++) {
      for (let k = j - 1; k < i; k++) {
        if (dp[j - 1][k] === INF) continue;
        // 塊 lines[k..i-1] の中心（上端と下端の y の平均）
        const cost = dp[j - 1][k] + Math.abs((lines[k][0].y + lines[i - 1][0].y) / 2 - anchors[j - 1]);
        if (cost < dp[j][i]) { dp[j][i] = cost; back[j][i] = k; }
      }
    }
  }
  if (dp[m][n] === INF) return undefined;
  const out = new Map<number, Item[]>();
  let i = n;
  for (let j = m; j >= 1; j--) {
    const k = back[j][i];
    out.set(anchors[j - 1], lines.slice(k, i).flat());
    i = k;
  }
  return out;
}

/**
 * **件名のセルは行の中心に揃っている**という、この PDF で行とセルを結びつけている唯一の事実を見張る（#866）。
 * ずれていれば隣の行の件名が混ざっている。**字数の上限では見ない**（68 字 1 セルも 480 字 1 セルも正しい）。
 *
 * **`parseVotePdf` の中の `if` ではなく、名前の付いた関数にしてある。**
 * **理由は、この見張りは今の 2 本のフィクスチャでは 1 度も鳴らないからである**——
 * **`if (false)` に変えても 32 本すべてが緑のままだった**（変異テストで実測）。
 * **鳴る条件を直接呼んで確かめられるように、呼べる形にしてある。**
 *
 * @throws ずれが `MAX_TITLE_OFFSET` を超えたとき
 */
export function checkTitleOffset(page: number, number: string, title: string, titleOffset: number): void {
  if (Math.abs(titleOffset) > MAX_TITLE_OFFSET) {
    throw new Error(`page ${page} ${number}: 件名 is ${titleOffset.toFixed(1)}pt off the row centre (max ${MAX_TITLE_OFFSET}) — 隣の行の件名が混ざっている疑い: ${title.slice(0, 30)}`);
  }
}

/**
 * **付託委員会の塊は行の中心に揃っている**——件名と同じく、この欄を行に結びつけている唯一の事実を見張る（#896）。
 *
 * **なぜ閾値（`BLOCK_GAP`）をやめてこちらにしたか。**
 * **`BLOCK_GAP = 13` は「隙間が 13pt より狭ければ同じ議案の付託」という規則だったが、
 * 13 本を全部測った結果、12 本で「同じ議案の中の隙間」と「別の議案の間の隙間」が重なっていた**
 * （2025-06 はどちらも 10.08pt）。**隙間の大きさでは原理的に分けられない。**
 * **通っていた 2 本は、たまたま隣り合った議案の並びがそうなっていただけである。**
 *
 * @throws ずれが `MAX_REFERRED_OFFSET` を超えたとき
 */
export function checkReferredOffset(page: number, number: string, committees: string[], referredOffset: number): void {
  if (Math.abs(referredOffset) > MAX_REFERRED_OFFSET) {
    throw new Error(`page ${page} ${number}: 付託委員会 is ${referredOffset.toFixed(1)}pt off the row centre (max ${MAX_REFERRED_OFFSET}) — 隣の行の付託委員会が混ざっている疑い: ${committees.join("／")}`);
  }
}

export async function parseVotePdf(bytes: Buffer): Promise<VotePdf> {
  const pages = await readPages(bytes);
  if (pages.length === 0) throw new Error("empty PDF");

  // 議員の列: 票の欄の x にある縦書きの氏名。氏名は 1 ページ目のヘッダ（付託委員会の行）をまたいで
  // 下にも伸びる（姓が上、名が下）ので、境目はヘッダではなく「一番上の票の行」より上とする。
  // 見出し・凡例・注記も同じ x にあるが、そちらは 1 アイテムに長い文字列が入っているので 1 文字かどうかで分ける。
  const heads = pages.map((page, pi) => {
    const head = page.items.find((i) => i.str === "付託委員会");
    if (!head) throw new Error(`page ${pi + 1}: 付託委員会 header not found`);
    return head;
  });
  // ヘッダ行と本文の境目も、この PDF のヘッダの字の位置から引く（#896。一律 6pt では 2 本で本文に漏れていた）
  const bodyTops = pages.map((page, pi) => bodyTopOf(page, heads[pi]));
  // 列の x はこの PDF のヘッダの位置から引く（会期によって表の幅・位置が違う）
  const raw = pages.map((page, pi) => columnsOf(page, heads[pi], pi + 1));
  // 議案番号｜件名 の境目は、ヘッダの中心の中点では足りない（件名は欄の左端に寄せて書かれ、
  // ヘッダ「件 名」はセルの中心にある）ので、その間にある本文の文字の左端から引く
  const numberTitle = boundaryBetween(pages, bodyTops, raw[0].numberCenter - 40, raw[0].titleCenter, "議案番号 and 件名");
  // 件名｜付託委員会 の境目。付託委員会も欄の左端に寄せて書かれるので、
  // ヘッダの中心より左に本文の書き出しがある。件名の右端と付託委員会の書き出しの間を取る
  const titleReferred = leftAlignedBoundary(pages, bodyTops, raw[0].titleCenter, raw[0].referred[1], numberTitle.right, "件名 and 付託委員会");
  const cols: Columns[] = raw.map((r) => ({
    number: [0, numberTitle.boundary],
    title: [numberTitle.boundary, titleReferred.boundary],
    titleLeft: numberTitle.right,
    referredLeft: titleReferred.right,
    referred: [titleReferred.boundary, r.referred[1]],
    result: r.result,
    yes: r.yes,
    no: r.no,
    membersFrom: r.membersFrom,
    numberHeader: r.numberHeader,
  }));

  const head0 = heads[0];
  const topVoteY = Math.max(...pages[0].items.filter((i) => i.x >= cols[0].membersFrom && (i.str === "○" || i.str === "●")).map((i) => i.y));
  if (!Number.isFinite(topVoteY)) throw new Error("page 1: no ○/● vote cell found");
  const isNameChar = (i: Item): boolean => i.x >= cols[0].membersFrom && i.y > topVoteY + 6 && [...i.str].length === 1;
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
    const head = heads[pi];
    const band = cols[pi];
    // 節見出し（（議案）（請願）（その他表決））はヘッダより上にある。無いページは前のページの続き。
    // 令和8年2月定例会の PDF には節見出しがそもそも 1 つも無く、全部が「議案番号」の 1 つの表になっている
    // （そのぶん kind は議案番号の欄のヘッダの語と、番号の原文の接頭辞から読む。下の kindOf を見よ）。
    for (const it of page.items.filter((i) => i.y > head.y && [...i.str].length > 1).sort((a, b) => b.y - a.y)) {
      const m = it.str.trim().match(SECTION);
      if (m && !/^[０-９0-9]/.test(m[1])) section = m[1];
    }
    // ヘッダ行より下がデータ。境目はこの PDF のヘッダの字の下端から引く（#896）。
    // 表の下の注記（「※請願17、29号の…」）は表のセルではないので、notes に移してデータから外す。
    const top = bodyTops[pi];
    const body: Item[] = [];
    for (const i of page.items) {
      if (i.y >= top) continue;
      if (FOOTNOTE.test(i.str)) { if (!notes.includes(i.str.trim())) notes.push(i.str.trim()); continue; }
      body.push(i);
    }
    // 議案番号 / 件名 / 付託委員会 の 3 つの欄。令和8年2月定例会の PDF には
    // 「議 員 提 出 第 2 号 島根県議会委員会条例の一部を改正する条例」（番号＋件名）や
    // 「非常勤の職員等の報酬及び費用弁償支給条例等の一部を改正する条例 総務委員会」（件名＋付託委員会）のように、
    // 2 つの欄の中身が 1 つの文字列として書かれている行がある（6月の PDF では欄ごとに別の文字列）。
    // 右隣の欄の書き出しまで届いている文字列だけを、欄の境目で切り分ける（原文の文字は変えない）。
    const numItems: Item[] = [];
    const titleItems: Item[] = [];
    const refItems: Item[] = [];
    const place = (i: Item): void => {
      if (i.str.trim() === "") return;
      // 欄をまたぐ結合された文字列は、右隣の欄の書き出しまで届いているかで見分ける
      // （「請願第17号」のように欄から少しはみ出すだけの文字列は切らない）
      if (i.x < band.number[1] && i.x + i.w > band.titleLeft) {
        const split = splitAtBoundary(i, band.number[1]);
        if (split) { numItems.push(split.left); place(split.right); return; }
      } else if (i.x < band.title[1] && i.x + i.w > band.referredLeft) {
        const split = splitAtBoundary(i, band.title[1]);
        if (split) { titleItems.push(split.left); place(split.right); return; }
      }
      if (i.x < band.number[1]) numItems.push(i);
      else if (i.x < band.title[1]) titleItems.push(i);
      else if (inX(i, band.referred)) refItems.push(i);
    };
    for (const i of body) if (i.x < band.referred[1]) place(i);
    // 行の基準: 議案番号の欄（1 議案に 1 つ）
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
    // 件名は 1 行ずつ近い行へ入れると高いセルが上下へこぼれる（#866）。
    // 上から順の行を、議案の数ぶんの塊に切れ目なく分ける（塊の中心が議案番号の y に最も近くなる分け方）。
    // 同じ y に置かれた文字列（1 行が 2 つのアイテムに分かれているもの）は 1 行として扱う。
    const titleLines: Item[][] = [];
    for (const it of [...titleItems].sort((a, b) => b.y - a.y || a.x - b.x)) {
      const last = titleLines.at(-1);
      if (last && Math.abs(last[0].y - it.y) < SAME_LINE) last.push(it);
      else titleLines.push([it]);
    }
    const titleCells = splitTitleCells(titleLines, anchors);
    const titleByRow = titleCells ?? own(titleItems);
    const resultByRow = own(body.filter((i) => inX(i, band.result)));
    const yesByRow = own(body.filter((i) => inX(i, band.yes)));
    const noByRow = own(body.filter((i) => inX(i, band.no)));

    // 付託委員会: 件名と同じく、上から順の行を議案の数ぶんの塊に切れ目なく分ける（#896。下の refLines を見よ）。
    // **隙間の大きさ（BLOCK_GAP）では分けられない**ことを 13 本で実測したので、閾値をやめた。
    const refLines: Item[][] = [];
    for (const it of [...refItems].sort((a, b) => b.y - a.y || a.x - b.x)) {
      const last = refLines.at(-1);
      if (last && Math.abs(last[0].y - it.y) < SAME_LINE) last.push(it);
      else refLines.push([it]);
    }
    const refCells = splitTitleCells(refLines, anchors);
    const refByRow = new Map<number, string[]>(anchors.map((a) => [a, [] as string[]]));
    const refYs = new Map<number, number[]>(anchors.map((a) => [a, [] as number[]]));
    if (refCells) {
      for (const [a, items] of refCells) {
        refYs.set(a, items.map((i) => i.y));
        // 同じ行に並んだ文字は 1 つの委員会名（「防災地域建設委員会」が 1 アイテムで来る本も、
        // 1 文字ずつ来る本もある）。y でまとめ直してから 1 つの名前にする
        const byLine: Item[][] = [];
        for (const it of [...items].sort((a2, b2) => b2.y - a2.y || a2.x - b2.x)) {
          const last = byLine.at(-1);
          if (last && Math.abs(last[0].y - it.y) < SAME_LINE) last.push(it);
          else byLine.push([it]);
        }
        refByRow.set(a, byLine.map((l) => l.map((i) => i.str.trim()).join("")).filter((t) => t !== ""));
      }
    } else {
      // 付託委員会の行が議案の数より少ない（＝付託の無い議案がある）。分けられないので今までどおり近い行へ
      for (const l of refLines) {
        const a = nearest(l[0].y);
        refByRow.get(a)!.push(...l.map((i) => i.str.trim()));
        refYs.get(a)!.push(...l.map((i) => i.y));
      }
    }

    // 票のセル。縦書きの氏名はヘッダ行より下まで伸びるので、票の欄は「一番上の票の行」より下だけを見る。
    const pageTopVoteY = Math.max(...body.filter((i) => i.x >= band.membersFrom && (i.str === "○" || i.str === "●")).map((i) => i.y));
    if (!Number.isFinite(pageTopVoteY)) throw new Error(`page ${pi + 1}: no ○/● vote cell found`);
    const voteItems = body.filter((i) => i.x >= band.membersFrom && i.y < pageTopVoteY + 6);
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
      // 件名のセルの中心と行の中心のずれ（#866）。件名が空の行は測れないので 0（すぐ下で「件名が空」で落ちる）
      const titleYs = titleByRow.get(a)!.map((i) => i.y);
      const titleOffset = titleYs.length === 0 ? 0 : (Math.max(...titleYs) + Math.min(...titleYs)) / 2 - a;
      const title = joinText(titleByRow.get(a)!);
      const result = joinText(resultByRow.get(a)!);
      const yesText = joinText(yesByRow.get(a)!).normalize("NFKC");
      const noText = joinText(noByRow.get(a)!).normalize("NFKC");
      const referredCommittees = refByRow.get(a)!;
      // 付託委員会の塊の中心と行の中心のずれ（#896）。空の行は測れないので 0（すぐ下で「付託委員会が空」で落ちる）
      const refYList = refYs.get(a)!;
      const referredOffset = refYList.length === 0 ? 0 : (Math.max(...refYList) + Math.min(...refYList)) / 2 - a;
      if (number === "") throw new Error(`page ${pi + 1} y=${a.toFixed(0)}: 議案番号 is empty`);
      if (title === "") throw new Error(`page ${pi + 1} ${number}: 件名 is empty`);
      checkTitleOffset(pi + 1, number, title, titleOffset);
      if (result === "") throw new Error(`page ${pi + 1} ${number}: 採決結果 is empty`);
      if (referredCommittees.length === 0) throw new Error(`page ${pi + 1} ${number}: 付託委員会 is empty`);
      checkReferredOffset(pi + 1, number, referredCommittees, referredOffset);
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
      rows.push({ kind: kindOf(section, band.numberHeader, number, pi + 1), number, title, referredCommittees, result, counts: { yes: Number(yesText), no: Number(noText) }, cells, page: pi + 1, titleOffset, referredOffset });
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
