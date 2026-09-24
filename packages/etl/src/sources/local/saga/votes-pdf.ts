import { bandIndex, cluster, joinVertical, readPages, type Item, type PageGeometry } from "../pdf-table.ts";

/**
 * 佐賀県議会「議員ごとの採決結果」（議案採決結果一覧表）PDF の表復元（Issue #768）。
 * 1 会期に 1 本。**67 会期・取れる 64 本のうち、文字層があって回転していないのは 16 本**（#765 / この PR が実測）。
 *
 * ## レイアウト（A4 横。**1 本の PDF に「表」が何枚も入る**）
 * ```
 *   （ページの上）令和８年６月定例会  議案採決結果一覧表          ← 表題（ページによっては無い）
 *                （表の記載について）○：賛成 ×：反対 △：退席 欠：欠席 議：議長  ← 凡例
 *   知事提出議案                                     ７月１日採決  ← 表の見出し（左＝区分、右＝議決日）
 *   ┌議案番号│件名│出席者数│欠席者数│議決者数│賛成│反対│退席│採決結果│議員名（1 人 1 列）──┐
 *   │                                              石 留 大 …（縦書き 1 文字 1 アイテム）      │
 *   │甲第36号議案│令和…補正予算（第１号）│37│0│36│36│0│0│可決│○ ○ ○ … ○               │
 * ```
 *
 * ## **この PDF のいちばんの特徴は「1 本に表が何枚もあり、表ごとに議決日と議員の並びが違う」**
 * **実測（16 本 55 ページ）: 表の見出し（`M月D日採決`）は 1 ページに最大 3 つある。**
 * **同じページの上と下で議決日が違う本がある**（令和5年11月定: 12月20日 と 12月21日、
 * 令和5年9月定: 9月22日 と 10月4日）。**「PDF に 1 つの議決日」と決め打ちしてはいけない。**
 * **議員の並びも表ごとに違う**（令和7年2月定は 6 ページが 36 人・1 ページが 37 人。
 * 欠席者が列ごと落ちている）。
 *
 * ## **続きのページには見出しが無い**（実測）
 * **令和4年9月定の 2 ページ目には `M月D日採決` の見出しが 1 つも無い**（氏名帯はある）。
 * **見出しが無いページを飛ばすと 10 行が消える。** **直前の表の議決日を引き継ぐ。**
 *
 * ## 記号の読み方——**粒度が 2 通りあり、会期でも年でも切れない**（#689 の測ったこと 3）
 *   - **1 セル 1 アイテム型**（令和6年4月臨・令和7年9月定・令和8年2月定・6月定の 4 本）
 *   - **1 行 1 アイテム型**（残り 12 本。`"○ ○ ○ 議 ○ …"` が 1 アイテム）
 * **令和8年4月臨時会は 1 行 1 アイテムで、その前後の令和8年2月定・6月定は 1 セル 1 アイテムである。**
 * **日付でも会期の種別でも決め打ちしない。** **アイテムごとに、記号が 1 つか複数かで分ける。**
 *
 * ## **列は罫線から採る。氏名からも進み幅からも作らない**（この PR の設計。#765 とは別の作り方）
 * **#765 は `showText` のグリフ幅・`setCharSpacing` を辿って記号の x を作った**（調査のための一時コード）。
 * **この実装は罫線（`readLines` が CTM を掛けて返す縦線）を `cluster` して列の境界にする。**
 * **どちらでも同じ列に落ちることを、この PR が 16 本 505 行 18,606 対で測り直した**（0 ずれ）。
 * **#764 の教訓どおり、測定の結論をそのまま引かずに自分の作り方で測った。**
 *
 * ### **議員の列は「右端から、幅がほぼ同じ区間が続くところまで」**
 * **罫線は 46〜47 本ある。左から 議案番号／件名／集計 7 欄／議員 36〜37 列。**
 * **集計欄は議員の列より 13〜17% 広い**（実測: 令和8年6月版は 18.35pt 対 15.88pt、
 * 令和7年2月版は 17.10pt 対 14.76pt、令和8年4月版は 13.08pt 対 11.28pt）。
 * **幅の中央値から ±8% を超えたら打ち切る**と、16 本すべてで議員の列だけが残る。
 * **「末尾から N 本」と決め打ちしない**（議員の数が会期で変わる。36 の本と 37 の本がある）。
 * **ここに「±0.35pt のような絶対値で切ると令和7年2月版で 1 列足りなくなる」と
 * 長らく書いてあったが、#1004 で測り直したら成り立たない。**
 * **その本の議員の列は min 14.580 / max 15.000 / 中央値 14.760 で、
 * min と max の差は 0.420pt あるが、実装が見るのは「中央値からの距離」で最大 0.240pt。**
 * **0.240 < 0.35 なので通る**——`> med * 0.08` を `> 0.35` に替えても
 * **フィクスチャ 9 本 29 ページの出力は 1 本も変わらない**（`saga-threshold.test.ts` が固定）。
 * **相対を選んだ判断自体は変えない**（列の幅は本ごとに 10.92〜15.88pt と 1.45 倍ちがい、
 * 絶対値では本ごとに意味が変わる）。**ただし「絶対値だと落ちる」という根拠は今は無い。**
 *
 * ## **氏名の列に混ざるものが 2 種類ある**（#765 が見つけた 5 件とは別の形で出た）
 *   1. **列見出し `議員名` の 3 文字**（`議` `員` `名`）が、**議員の帯の x の中**にある（実測、全 16 本）。
 *      **`議` は票の記号でもあるので、素朴に数えると「記号が 1 個の行」ができる。**
 *   2. **ページ番号**（`１` `２` …）が氏名帯の上に重なる本がある（令和7年9月定・令和8年2月定）。
 * **どちらも「氏名の下からの連なり」で落ちる**（`bottomRun`）——
 * **氏名は 11〜12pt 間隔で縦に並ぶが、見出しとページ番号はそこから 18pt 以上離れている。**
 * **除かないと `員石倉秀郷` `名岡口重文` `１武藤明美` のような氏名ができる**（実測。
 * **名簿に寄らないので `unmatched.json` が膨らむが、票そのものは正しい列に載る**）。
 *
 * ## **`/Rotate 90` の打ち消しは要らない**（#765 の実測。この PR も確かめた）
 * **読める 16 本 55 ページに `/Rotate ≠ 0` は 1 ページも無い。**
 * **回っているのは文字層が無い 16 本と、平成27〜29年の 16 本である**（後者は下記）。
 *
 * ## **平成27年〜平成29年の 16 本は読まない**（この PR の対象外。**理由を書いて落とす**）
 * **#689 / #765 は令和3年以降しか開いていない。この PR が 平成27年まで遡って数えた**（実測 2026-09-13）:
 * **64 本のうち、文字層があって回転していない 16 本 ＝ #765 の 16 本と同じ。**
 * **平成27年2月〜平成29年11月の 16 本にも文字層があるが、全ページ `/Rotate 90` で、
 * しかも表の作りが違う**（1 ページに表が何枚も入り、集計欄が 7 欄ではなく 4 欄）。
 * **青森 #750 の `unrotate` を掛ければ座標は直るが、表の形が違うので同じコードでは読めない。**
 * **測っていないものを読んで出すことはしない**（#569）——**`unreadableSources` に理由つきで残す。**
 */

/** 不明なセル（推定しない）。**別人の票を作るより「不明」を出す**（#569） */
export const UNKNOWN_CELL = "不明";
/** 凡例から意味が引けなかったときの印 */
export const UNKNOWN_LEGEND = "抽出不能";

/**
 * 票のセルに出る記号。**この 6 種だけが本文に出る**（#765 が 16 本の議員の帯で数え、この PR も確かめた）:
 *   `○` U+25CB 17,267 / `×` U+00D7 734 / `議` U+8B70 504 / `欠` U+6B20 83 / `△` U+25B3 14 / `除` U+9664 4
 * **凡例に語として出るが本文セルには 1 つも出ない記号として `退` がある**（`退席`。
 * ただし `退` の文字は列見出し「退席」の 1 文字目で、議員の帯の x 範囲に入らない）。
 * **`退` を入れてよいか**——**入れる。** 凡例（`△：退席`）にある記号は `△` であって `退` ではないが、
 * **もし将来 `退` がセルに出たら、記号として拾えなければ `不明` になり、
 * 拾えれば凡例が引けずに `抽出不能` になる。どちらも「決めない」側だが、
 * 後者のほうが「PDF にこう書いてあった」という事実が残る。**
 * **`×` は U+00D7（乗算記号）である**——`✕`(U+2715) でも `x` でもない（#765 が実測）。
 */
const VOTE_SYMBOLS = new Set([..."○×△欠議退除〇✕◯"]);
export const isVoteSymbol = (c: string): boolean => VOTE_SYMBOLS.has(c);

/** 凡例の 1 項目（`○：賛成`）。**記号 1 文字 ＋ 全角/半角のコロン ＋ 意味**（実測 16 本） */
const LEGEND_ITEM = /^(.)[：:](.+)$/;
/** 表の見出しの右にある議決日（`７月１日採決`。**全角数字**） */
const DECIDED_ON = /^([０-９0-9]{1,2})月([０-９0-9]{1,2})日採決$/;
/** PDF の表題（`令和８年６月定例会` ＋ `議案採決結果一覧表` の 2 アイテム。#689 の罠 7 を塞ぐ） */
const TITLE_TAIL = /議案採決結果一覧表$/;
const TITLE_HEAD = /^(令和|平成)([元０-９0-9]+)年([０-９0-9]{1,2})月(定例会|臨時会)$/;

export interface VotePdfLegend {
  /** 記号 → 意味の原文（`○` → `賛成`）。**PDF ごとに読む**（`除` の語が 2 通りある） */
  votes: Record<string, string>;
}

export interface VotePdfMember {
  /** 氏名の原文（縦書きを上から繋いだもの。空白は落とす） */
  nameText: string;
  /** 会派。**佐賀の賛否 PDF に会派の列は無い**ので常に空（#765 が実測） */
  group: string;
}

export interface VotePdfRow {
  /** 議案番号の欄の原文（`甲第36号議案`）。**番号と件名が 1 アイテムに入る行では空**（11 行） */
  number: string;
  /** 件名の欄の原文 */
  title: string;
  /** 出席者数・欠席者数・議決者数・賛成・反対・退席（原文。数に直さない） */
  counts: { present: string; absent: string; voting: string; yes: string; no: string; withdrew: string };
  /** 採決結果の欄の原文（`可決` `否決` `同意` `採択` …） */
  result: string;
  /** 議決日（`7月1日` の月日。表の見出しから。**続きのページでは直前の表から引き継ぐ**） */
  month: number;
  day: number;
  /** 表の区分の見出しの原文（`知事提出議案` `議員提出議案`）。無ければ空 */
  section: string;
  /** 議員 1 人ぶんの記号（`members` と同じ並び・同じ長さ）。読めなければ `不明` */
  cells: string[];
  /** この行が居るページ（1 始まり） */
  page: number;
}

export interface VotePdf {
  /** 表題の原文（`令和８年６月定例会 議案採決結果一覧表`） */
  headingText: string;
  /** 表題から読んだ西暦の年 */
  year: number;
  /** 表題から読んだ会期の月 */
  month: number;
  /** 表題の会期の種別（`定例会` / `臨時会`） */
  kind: string;
  legend: VotePdfLegend;
  /** 議員の並び（**表ごとに違う**ので、行ごとに `cells` と同じ長さの並びを持つ） */
  members: VotePdfMember[];
  rows: VotePdfRow[];
  /** 行ごとの議員の並び（`rows[i]` に対応。**`members` と違う表がある**） */
  rowMembers: VotePdfMember[][];
  unknownCells: number;
  pages: number;
  /** 表の数（`M月D日採決` の見出しの数ではなく、氏名帯の数） */
  tables: number;
}

/* ---------- 幾何 ---------- */

/**
 * 議員の列の幅の許容（中央値からの相対）。**±8%。**
 *
 * ## 安全帯（**#1004 で二分探索して実測**。2026-09-25、フィクスチャ 9 本 29 ページ）
 *
 * 「佐賀のフィクスチャ全ページで `memberColumns` の出力が 1 ビットも変わらない区間」:
 *
 * ```
 * 安全帯 [0.020162, 0.086955]   選んだ値 0.080
 *   下の余裕 0.059838           上の余裕 0.006955   ← 上は下の 8.6 分の 1
 * ```
 *
 * **実データの列間隔のばらつきは最大 1.63%**
 * （`3_111805_349057_up_7elgmado.pdf` p2、中央値 14.760pt、37 間隔）なので、
 * **下方向は潤沢だが、上は余裕が 1 桁少ない。非対称である。**
 *
 * ## 上に外すと何が起きるか（**#1004 で実測**）
 *
 * **`0.087`**（**上限を 0.000045 だけ越える**）で、集計欄の 1 つが議員の列に混ざる:
 *
 * | 本 | 列 | `members[0]` | 記号が読めたセル |
 * |---|---:|---|---:|
 * | `3_87962_253631_up_ita1q1dw.pdf` | 37 → **38** | `石井秀夫` → **`可`** | 962 → **0**（`不明` 988） |
 * | `3_95237_272348_up_pqtj45d7.pdf` | 36 → **37** | `石井秀夫` → **`可`** | 2,844 → **0**（`不明` 2,923） |
 *
 * **議員の並びが丸ごと 1 つ右へずれる**（`可` が先頭に入り、`石井秀夫` が 2 番目になる）。
 * **`parseVotePdf` は例外を投げない**——`members.length !== n` の検査は
 * 氏名帯も一緒に 1 つ伸びるので通ってしまう。**黙って通る。**
 *
 * `0.16` では 37 → 40・44、`0.30` では全 7 本が 43〜44 列になり、
 * `members[0]` は `出席者数`（集計欄の見出し）になる。
 *
 * **ずれた並びのセルはすべて `不明` に落ちる。これは偶然ではなく、`readVoteCells` の
 * `placed.length !== n` が個数で受け止めている**（#1015 のレビューが指摘し、実測で確かめた）。
 *
 * **機序は構造的**: **記号の個数は PDF が持っている定数**（36 か 37）で、
 * **列を増やしても記号は増えない**。よって **`n` が増えた瞬間に `placed.length !== n` が必ず成立する。**
 *
 * **実測**（許容 6 水準 × フィクスチャ全ページ、**列が増えた 88 組**）:
 * **823 行が 1 件残らず `placed.length !== n` で `不明` に落ちた。
 * その次の番人 `b !== k` は 1 度も発火せず、記号が読めてしまった行は 0。**
 *
 * **だから `readVoteCells` の `placed.length !== n` を「余計な検査」として弱めてはいけない**——
 * **閾値が外れたときに `不明` へ倒している唯一の仕掛けである。**
 * **2 つ目の `b !== k` は実データで 1 度も発火しない**ので**テストで固定できていない**が、
 * **個数が合ったまま並びだけ崩れる本が来たときの最後の砦なので残す。**
 *
 * **ただしこの番人が守るのは「票が誤帰属しないこと」だけ**である。
 * **`members[0]` が `可` になること自体は止まらない**（氏名帯は列と一緒に伸びる）。
 * **票は出ないが、議員の並びは壊れたまま通る。**
 *
 * ## 下に外すと何が起きるか（**#1004 で実測**）
 *
 * `0.020`（下限のすぐ下）で `3_111805_349057_up_7elgmado.pdf` の 6 ページが
 * **`cols.length === 0`（列が取れない）**に落ち、その表は読めなくなる。
 * `0.005` では `3_119791_394982_up_cda325jj.pdf` が 37 → 36 に縮む。
 *
 * **下は「記録が出ない」、上は「別人に紐づく」。同じ重さではない**（#569）。
 * **迷ったら下げる側に倒すこと。**
 *
 * ## 県が罫線を少し動かしたら
 *
 * **上限 0.086955 は「今のフィクスチャ 9 本での」値**である。
 * 佐賀が表の作りを変えて集計欄を議員の列に近づければ、**0.08 のままでも越える。**
 * そのときの合図は **`unknownCells` が跳ねること**と
 * **`members[0]` が氏名でなくなること**（`可` / `出席者数` のような語）。
 * **`test/saga-threshold.test.ts` が両方を固定してある。**
 *
 * ## 「絶対値では落ちる」は、今のフィクスチャでは**成り立たない**（**#1004 で測り直した**）
 *
 * **この関数の docblock は長らく「±0.35pt のような絶対値では令和7年2月版が落ちる」と
 * 書いていたが、測ったら落ちない。**
 * `> med * 0.08` を `> 0.35` に差し替えても、**フィクスチャ 9 本 29 ページの出力が 1 本も変わらない**
 * （`saga-votes-pdf.test.ts` 21 件も `saga-threshold.test.ts` 8 件も全部通る）。
 *
 * **理由は基準点の取り違え。** `3_111805_349057_up_7elgmado.pdf` p2 の議員の列は
 * **min 14.580 / max 15.000 / 中央値 14.760** で、
 * **min と max の差は 0.420pt だが、中央値からの最大距離は 0.240pt** しかない。
 * 検査は `|g - med| > 0.35` なので **0.240 < 0.35 で通る。**
 * **「幅が 0.42pt ある」は「±0.35pt で切れる」を意味しない。**
 *
 * **相対を選んだこと自体は変えない**（列の幅は本ごとに 10.92〜15.88pt と 1.45 倍ちがい、
 * 絶対値では本ごとに意味が変わる）。**ただし「絶対値だと落ちる」という根拠は今は無い。**
 *
 * **同じ理由で、中央値を平均に替えても 29 ページの出力は変わらない**（#1004 で実測）。
 * **どちらも等価変異である**——**この 2 つは今のフィクスチャでは固定できていない。**
 */
export const MEMBER_COLUMN_TOLERANCE = 0.08;

/**
 * 議員の列の境界（縦罫線を `cluster` したもののうち、右端から幅がそろっている run）。
 * 列が 10 本に満たなければ空（表紙のページ）。
 *
 * **許容は `MEMBER_COLUMN_TOLERANCE`（±8%）。緩める前にそちらの docblock を読むこと**——
 * **上の余裕は 0.007 しかなく、越えると議員の並びが 1 つずれる**（#1004）。
 */
export function memberColumns(vlines: readonly { x: number }[]): number[] {
  const vx = cluster(vlines.map((v) => v.x));
  if (vx.length < 10) return [];
  const gaps = vx.slice(1).map((v, k) => v - vx[k]);
  let i = gaps.length - 1;
  while (i > 0) {
    const run = gaps.slice(i - 1);
    const sorted = [...run].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    if (run.some((g) => Math.abs(g - med) > med * MEMBER_COLUMN_TOLERANCE)) break;
    i--;
  }
  const cols = vx.slice(i);
  return cols.length >= 10 ? cols : [];
}

/** 空白を除いた文字（アイテムの中身）。 */
const chars = (s: string): string[] => [...s].filter((c) => !/[\s　]/.test(c));

/**
 * アイテムの中の記号を 1 つずつ、x つきで返す。
 *   - **1 文字のアイテム**: アイテム自身の `cx`（推定しない）
 *   - **複数記号のアイテム**: **アイテムの幅を文字数で割って、k 番目を `x + (k + 0.5) * pitch` に置く**
 * **滋賀（#718）は右端から数えたが、佐賀は行アイテムが記号だけでできていて
 * 末尾に空白が付かない**ので、左端から等分で当たる（実測: 16 本 18,606 対すべて 0 ずれ）。
 */
export function splitRowItem(it: Item): { ch: string; x: number }[] {
  const cs = chars(it.str);
  if (cs.length === 0) return [];
  if (cs.length === 1) return [{ ch: cs[0], x: it.cx }];
  const pitch = it.w / cs.length;
  return cs.map((ch, k) => ({ ch, x: it.x + (k + 0.5) * pitch }));
}

/**
 * 列の文字を「下から続く連なり」だけに切る（`議員名` の見出しとページ番号を落とす。docblock）。
 * **文字の高さの 1.4 倍より離れたら切る**——**氏名は 11〜12pt 間隔、見出しは 18pt 以上離れている**（実測）。
 */
export function bottomRun(items: readonly Item[]): Item[] {
  const sorted = [...items].sort((a, b) => a.cy - b.cy);
  const out: Item[] = [];
  for (const it of sorted) {
    const prev = out[out.length - 1];
    if (prev && it.cy - prev.cy > Math.max(it.h, prev.h, 1) * 1.4) break;
    out.push(it);
  }
  return out;
}

/* ---------- 本体 ---------- */

export async function parseVotePdf(bytes: Buffer): Promise<VotePdf> {
  const pages = await readPages(bytes);
  if (pages.length === 0) throw new Error("PDF has no pages");
  // **文字層が無い PDF は「読めない」のが正しい結果**（16 本ある。黙って 0 行にしない）
  if (pages.every((p) => p.items.length === 0)) throw new Error("PDF に文字層が無い（ToUnicode 無し。#689）");
  // **回っているページがあれば読まない**（平成27〜29年の 16 本。表の作りも違う。docblock）
  const rotated = pages.filter((p) => p.rotate !== 0).length;
  if (rotated > 0) throw new Error(`/Rotate ≠ 0 のページが ${rotated} / ${pages.length} ある（平成27〜29年の形。#768 では読まない）`);

  const head = parseHeading(pages);
  const legend = parseLegend(pages);
  const rows: VotePdfRow[] = [];
  const rowMembers: VotePdfMember[][] = [];
  /** 直前の表から引き継ぐ議決日と議員の並び（続きのページには見出しも氏名帯も無いことがある） */
  let carriedDate: { month: number; day: number } | undefined;
  let carriedMembers: VotePdfMember[] | undefined;
  let carriedSection = "";
  let tables = 0;
  for (let p = 0; p < pages.length; p++) {
    const cols = memberColumns(pages[p].vlines);
    if (cols.length === 0) continue; // 表紙のページ（罫線が 6 本しかない。#765 の「測れなかった 2 ページ」）
    const n = cols.length - 1;
    const leftBounds = leftColumns(pages[p], cols[0]);
    const rowsOnPage = readRowBands(pages[p], cols);
    for (const band of rowsOnPage) {
      if (band.members) { carriedMembers = band.members; tables++; }
      if (band.decided) carriedDate = band.decided;
      if (band.section !== undefined) carriedSection = band.section;
      const members = carriedMembers;
      if (!members) throw new Error(`page ${p + 1}: 氏名帯が 1 つも見つかっていないのに票の行がある`);
      if (!carriedDate) throw new Error(`page ${p + 1}: 議決日の見出し（M月D日採決）が 1 つも見つかっていないのに票の行がある`);
      if (members.length !== n) throw new Error(`page ${p + 1}: 議員 ${members.length} 人 / 列 ${n} 本 で合わない`);
      const cells = readVoteCells(band.items, cols, n);
      const left = readLeftCells(pages[p], leftBounds, band.y);
      rows.push({ ...left, month: carriedDate.month, day: carriedDate.day, section: carriedSection, cells, page: p + 1 });
      rowMembers.push(members);
    }
  }
  if (rows.length === 0) throw new Error("票の行が 1 行も読めない");
  const unknownCells = rows.reduce((s, r) => s + r.cells.filter((c) => c === UNKNOWN_CELL).length, 0);
  // **`members` は「いちばん多い並び」ではなく 1 つ目の表のもの**（行ごとの並びは `rowMembers`）
  return { ...head, legend, members: rowMembers[0], rows, rowMembers, unknownCells, pages: pages.length, tables };
}

/* ---------- 表題・凡例 ---------- */

/**
 * PDF の表題（`令和８年６月定例会` ＋ `議案採決結果一覧表` の 2 アイテム。**必ず隣り合う**）。
 *
 * **会期ページとの突き合わせに使う**（#689 の罠 7: 会期ページが「まだ無い一覧表」を
 * 前の会期のもので埋める。**表題を見ないと 9月定例会の賛否として 2月定例会の票が出る**）。
 * **表題が無ければ例外**——**どの会期の票か分からないものを出さない。**
 */
export function parseHeading(pages: readonly PageGeometry[]): { headingText: string; year: number; month: number; kind: string } {
  for (const page of pages) {
    const items = [...page.items].sort((a, b) => b.cy - a.cy || a.cx - b.cx);
    for (let i = 0; i + 1 < items.length; i++) {
      const a = items[i].str.replace(/[\s　]/g, "");
      const b = items[i + 1].str.replace(/[\s　]/g, "");
      if (!TITLE_TAIL.test(b)) continue;
      const m = TITLE_HEAD.exec(a);
      if (!m) continue;
      const era = m[1];
      const y = m[2] === "元" ? 1 : Number(m[2].normalize("NFKC"));
      const year = era === "令和" ? 2018 + y : 1988 + y;
      return { headingText: `${a} ${b}`, year, month: Number(m[3].normalize("NFKC")), kind: m[4] };
    }
  }
  throw new Error("表題（「令和N年M月定例会」＋「議案採決結果一覧表」）が読めない");
}

/**
 * 凡例（`（表の記載について）○：賛成 ×：反対 △：退席 欠：欠席 議：議長`）。
 *
 * **PDF ごとに読む**（滋賀・秋田と同じ罠）——**`除` の語が 2 通りある**:
 *   令和5年5月臨（前半） `除：地方自治法第117条による除斥` / 令和6年4月臨ほか `除：除席`。
 * **「除斥」と「除席」は字が違う。どちらも原文。丸めない。**
 * **同じ記号に違う語が付いていたら例外**（黙って片方を採らない）。
 * **凡例が 1 つも無ければ例外**（`抽出不能` にしない——**凡例はこの 16 本すべてにある**ので、
 * 無いということは読み方が壊れている）。
 */
export function parseLegend(pages: readonly PageGeometry[]): VotePdfLegend {
  const votes: Record<string, string> = {};
  for (const page of pages) {
    for (const it of page.items) {
      const m = LEGEND_ITEM.exec(it.str.replace(/[\s　]/g, ""));
      if (!m || !isVoteSymbol(m[1])) continue;
      const prev = votes[m[1]];
      if (prev !== undefined && prev !== m[2]) throw new Error(`凡例の ${m[1]} に 2 通りの意味がある（${prev} / ${m[2]}）`);
      votes[m[1]] = m[2];
    }
  }
  if (Object.keys(votes).length === 0) throw new Error("凡例（「○：賛成」の形）が 1 つも無い");
  return { votes };
}

/** 凡例から意味を引く。引けなければ `抽出不能`（推定しない）。 */
export function legendOf(raw: string, votes: Record<string, string>): string {
  if (raw === UNKNOWN_CELL) return UNKNOWN_LEGEND;
  return votes[raw] ?? UNKNOWN_LEGEND;
}

/* ---------- 行と列 ---------- */

/** 左側の欄の境界（議員の列の左端まで）。**9 欄** ＝ 議案番号・件名・集計 6 欄・採決結果（実測 505 行）。 */
export function leftColumns(page: PageGeometry, memberLeft: number): number[] {
  const vx = cluster(page.vlines.map((v) => v.x));
  const i = vx.indexOf(memberLeft);
  return i < 0 ? [] : vx.slice(0, i + 1);
}

export interface RowBand {
  /** 行の y（記号の `cy`） */
  y: number;
  /** この行の記号アイテム */
  items: Item[];
  /** この行の直上に氏名帯があれば、その議員の並び */
  members?: VotePdfMember[];
  /** この行の直上に議決日の見出しがあれば、その月日 */
  decided?: { month: number; day: number };
  /** この行の直上に区分の見出し（`知事提出議案`）があれば、その原文 */
  section?: string;
}

/**
 * 1 ページの票の行を上から順に。**行の上に氏名帯・議決日の見出しがあれば添える。**
 *
 * ## **行かどうかは「議員の帯にある記号の数」で決める**（**1 個では行にしない**）
 * **列見出し `議員名` の `議` が議員の帯の x の中にある**（全 16 本。docblock）ので、
 * **「記号が 1 個でもあれば行」とすると、氏名帯の上に幻の行ができる。**
 * **実測（令和8年6月版 1 ページ目）: `議`(x=833.6) `員`(866.4) `名`(899.2) が cy=704 に並び、
 * 氏名帯（cy=648〜685）の上にある。** **幻の行を作ると氏名帯が「行の下」に落ち、
 * その表の議員が 1 人も読めなくなる。**
 * **列の数の半分以上の記号がある y だけを行とする**（実測: 本物の行は 36〜37 個、
 * 幻の行は 1 個。**間に何も無い**）。
 */
export function readRowBands(page: PageGeometry, cols: readonly number[]): RowBand[] {
  const n = cols.length - 1;
  const lo = cols[0];
  const hi = cols[cols.length - 1];
  // 記号アイテムを y でまとめる
  const byY = new Map<number, { y: number; items: Item[]; count: number }>();
  for (const it of page.items) {
    const cs = chars(it.str);
    if (cs.length === 0) continue;
    const isRowItem = cs.length >= 10 && cs.every(isVoteSymbol);
    const isCell = cs.length === 1 && isVoteSymbol(cs[0]) && it.cx > lo && it.cx < hi;
    if (!isRowItem && !isCell) continue;
    const key = Math.round(it.cy);
    const cur = byY.get(key) ?? { y: it.cy, items: [], count: 0 };
    cur.items.push(it);
    cur.count += cs.length;
    byY.set(key, cur);
  }
  const rows = [...byY.values()].filter((r) => r.count >= n / 2).sort((a, b) => b.y - a.y);
  // 氏名の文字（議員の帯にある、記号でない 1 文字）
  const nameChars = page.items.filter((it) => chars(it.str).length === 1 && !isVoteSymbol(it.str.trim()) && bandIndex([...cols], it.cx) !== undefined);
  // 見出し
  const decided = page.items
    .map((it) => ({ it, m: DECIDED_ON.exec(it.str.replace(/[\s　]/g, "")) }))
    .filter((x): x is { it: Item; m: RegExpExecArray } => x.m !== null);
  const sections = page.items.filter((it) => /^(知事|議員)提出議案$/.test(it.str.replace(/[\s　]/g, "")));

  const out: RowBand[] = [];
  for (let k = 0; k < rows.length; k++) {
    const above = k === 0 ? Infinity : rows[k - 1].y;
    const band: RowBand = { y: rows[k].y, items: rows[k].items };
    // 氏名帯: この行と 1 つ上の行のあいだにある氏名の文字が、n 列すべてに揃っていれば採る
    const inGap = nameChars.filter((c) => c.cy < above && c.cy > rows[k].y);
    const byCol = new Map<number, Item[]>();
    for (const it of inGap) {
      const b = bandIndex([...cols], it.cx);
      if (b === undefined) continue;
      const list = byCol.get(b) ?? [];
      list.push(it);
      byCol.set(b, list);
    }
    if (byCol.size === n) {
      band.members = [...byCol.entries()].sort((a, b) => a[0] - b[0])
        .map(([, v]) => ({ nameText: joinVertical(bottomRun(v)).replace(/[\s　]/g, ""), group: "" }));
    }
    const d = decided.filter((x) => x.it.cy < above && x.it.cy > rows[k].y).sort((a, b) => b.it.cy - a.it.cy)[0];
    if (d) band.decided = { month: Number(d.m[1].normalize("NFKC")), day: Number(d.m[2].normalize("NFKC")) };
    const s = sections.filter((x) => x.cy < above && x.cy > rows[k].y).sort((a, b) => b.cy - a.cy)[0];
    if (s) band.section = s.str.replace(/[\s　]/g, "");
    out.push(band);
  }
  return out;
}

/**
 * 1 行の記号を議員の列に置く。
 *
 * **k 番目の記号が k 番目の列に落ちることを検算する**（#529 の錨。この PR が 18,606 対で測った）。
 * **落ちなければ、その行は丸ごと `不明`**——**1 つでもずれていれば全部が別人の票になりうる。**
 * **記号の数が列の数と合わない行も丸ごと `不明`**（実測: 16 本 505 行で 0 行。
 * **ここは「そういう行が出たときに気づく」ための守り**）。
 */
export function readVoteCells(items: readonly Item[], cols: readonly number[], n: number): string[] {
  const placed = [...items].sort((a, b) => a.cx - b.cx).flatMap(splitRowItem).sort((a, b) => a.x - b.x);
  if (placed.length !== n) return Array<string>(n).fill(UNKNOWN_CELL);
  const cells: string[] = [];
  for (let k = 0; k < n; k++) {
    const b = bandIndex([...cols], placed[k].x);
    // **k 番目の記号が k 番目の列に落ちないなら、この行は信用しない**
    if (b !== k) return Array<string>(n).fill(UNKNOWN_CELL);
    cells.push(placed[k].ch);
  }
  return cells;
}

/**
 * 左の欄のアイテムを、**2 つ以上の欄にまたがるときだけ**空白で割って置き直す。
 *
 * **実測（16 本 55 ページ、左の欄のアイテム 7,511 個）: またがるのは 295 個で、
 * そのうち票の行にあるのは `35 35` `36 36` `35 33` の形の 125 個**
 * （**議決者数と賛成が 1 アイテムに入っている**。令和4年9月定・11月定・令和5年2月定の 3 本）。
 * **割らないと「賛成」の欄が空になり、「議決者数」の欄が `35 33` になる**——
 * **`counts` が原文でなくなり、票の記号との検算（賛成の数 ＝ `○` の数）が落ちる。**
 *
 * **1 つの欄に収まるアイテムは割らない**——**件名には空白が入りうる**ので、
 * 常に割ると件名が切れる。
 * **割るときは「空白で区切られた塊」を、アイテムの幅を文字数で按分した位置に置く**
 * （記号の `splitRowItem` と同じ考え方）。
 */
export function splitLeftItem(it: Item, bounds: readonly number[]): Item[] {
  const left = bandIndex([...bounds], it.x + 0.5);
  const right = bandIndex([...bounds], it.x + it.w - 0.5);
  if (left === undefined || right === undefined || left === right) return [it];
  const all = [...it.str];
  if (all.length === 0) return [it];
  const per = it.w / all.length;
  const out: Item[] = [];
  let i = 0;
  for (const token of it.str.split(/[\s　]+/)) {
    const start = it.str.indexOf(token, i);
    if (token === "" || start < 0) continue;
    i = start + token.length;
    const x = it.x + [...it.str.slice(0, start)].length * per;
    const w = [...token].length * per;
    out.push({ ...it, str: token, x, w, cx: x + w / 2 });
  }
  return out.length > 0 ? out : [it];
}

/**
 * 左側の 9 欄（議案番号・件名・出席者数・欠席者数・議決者数・賛成・反対・退席・採決結果）。
 *
 * **`議案番号` が空の行が 11 行ある**（意見書案の行で、番号と件名が 1 アイテムに入る）。
 * **番号を件名から切り出さない**——**それは原文の再分割であって、`title` に原文が残っている。**
 * **`rollcalls.ts` が `number` が空なら `title` から id を作る**（秋田 #759 と同じ）。
 */
export function readLeftCells(page: PageGeometry, bounds: readonly number[], y: number): Pick<VotePdfRow, "number" | "title" | "counts" | "result"> {
  const inRow = page.items.filter((it) => it.cx < bounds[bounds.length - 1] && Math.abs(it.cy - y) < 14);
  const cell = (i: number): string => {
    if (i + 1 >= bounds.length) return "";
    const parts: Item[] = [];
    for (const it of inRow) {
      // **2 つの欄にまたがるアイテムは、空白で割ってそれぞれの欄に置く**（docblock の `35 33`）。
      // **1 つの欄に収まるものは割らない**（件名の中の空白で切ってはいけない）
      for (const piece of splitLeftItem(it, bounds)) {
        if (piece.cx > bounds[i] && piece.cx < bounds[i + 1]) parts.push(piece);
      }
    }
    return joinVertical(parts).replace(/[\s　]+/g, " ").trim();
  };
  return {
    number: cell(0),
    title: cell(1),
    counts: { present: cell(2), absent: cell(3), voting: cell(4), yes: cell(5), no: cell(6), withdrew: cell(7) },
    result: cell(8),
  };
}
