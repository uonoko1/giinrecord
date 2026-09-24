import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseVotePdf, UNKNOWN_CELL, type VotePdf } from "../src/sources/local/mie/votes-pdf.ts";

/**
 * # 三重: x 方向（列）と y 方向（行）の対応を測る（Issue #835）
 *
 * ## 何を測ったか（151 本すべてを取得して測った実測値。PR #835 に全部書いてある）
 *
 * **index（`/KENGIKAI/07976009017.htm`）の `<a>` 518 本のうち `.pdf` は 151 本。
 * 151 本すべてが h3「議員別の賛否等の状況」の下にある**（別の種類の PDF は 0 本）。
 * **151 本を取得して `parseVotePdf` に通した結果、読めたのは 15 本だけである**（10%）。
 * **残り 136 本は例外で落ちる**（`moveText/nextLine` 80 本・`text matrix` 35 本・
 * 凡例の取りこぼし 20 本・議案等番号の形 1 本）。**詳しい内訳は PR #835。**
 *
 * ## **#867（2026-09-14 / 09-16）で A 群（相対移動）を読めるようにした後の実測**
 * **同じ 151 本で 33 本 → 84 本になった**（#835 の 15 本は #841 の凡例修正で 33 本に増えていた）。
 * **A 群 80 本のうち 51 本が読めるようになり、29 本は別の理由で止まる**
 * （表題が見つからない 15 / 未知の演算子 7 / 罫線の形 2 / その他 5。**途中まで読まずに止めている**。#569）。
 * **残る 35 本は B 群（回転・拡大・上下反転）で、#867 では触っていない。**
 * **フィクスチャに足したのは A 群 51 本のうち 3 本だけである**（`000073643` `000674338` `000711542`）——
 * **1 本も足さないと、A 群の枝を丸ごと殺す変異を実物の PDF のテストが 1 件も捕まえない**（#867 で実測）。
 *
 * **本番（`data/assemblies/pref-24`）に出ている 365 件は、この 15 本のうち 13 本から出ている**
 * （`--sessions 2` の既定で 令和8年・令和7年 の 2 会期だけを取っているため）。
 * **残る 138 本は取りに行っていない。** **ETL は読めない本を黙って飛ばさず例外で落ちる**ので、
 * **「読めない本が黙って欠けている」のではなく「取りに行っていない」が正しい。**
 *
 * ## 2 本の検算と、その効き（実測）
 *
 * | 壊し方 | 検算A（公表数 ↔ ○×の数） | 検算B（`議` の列 ↔ 歴代議長） |
 * |---|---|---|
 * | 無改造 | **0 / 378 行が不一致** | **0 / 421 行が不一致** |
 * | `cells` を 1 行回す（y がずれる） | **88 / 374 行で落ちる**（23.5%） | **0 / 417 行**（列は動かないので当然） |
 * | `cells` を 1 列回す（x がずれる） | **0 / 378 行**（置換なので数は変わらない） | **421 / 421 行で落ちる**（100%） |
 *
 * **2 本は互いの代わりにならない**（#774 と同じ問い。ここでは**完全に補い合う形で外れている**）:
 * **検算A は x を 1 件も捕まえない**——記号帯を回しても `○` と `×` の個数は変わらないからである。
 * **検算B は y を 1 件も捕まえない**——全行を同じだけ回せば `議` は同じ列に立ち続けるからである。
 * **片方を外すと、その方向の壊れ方は誰も見ていない状態になる。**
 *
 * ## 検算B が「回転で恒真にならない」のはなぜか
 * **「`議` が本の中で 1 つの列に揃う」だけなら恒真である**——実測でも
 * **x を 1 列回しても 2 列回しても「揃う」は 421 / 421 行で保たれた**（全行が同じだけ動くので）。
 * **だから列の中身を外の事実に結ぶ**: **`議` の列の議員名が、県が公表している歴代議長と一致するか。**
 * 一次資料: 三重県議会「歴代正副議長」 https://www.pref.mie.lg.jp/KENGIKAI/07681011814.htm
 * （更新日 令和8年5月19日。2026-09-13 取得）——
 * **114代 稲垣昭義（令和06.05〜）・115代 服部富男（令和07.05〜）・116代 藤田宜三（令和08.05〜）。**
 * **読めた 15 本の `議` の列は、421 行すべてでこの表と一致した。**
 * **同じページに「歴代副議長」の表が並んでおり、代の番号も氏名も違う**
 * （副議長 116代 は 藤田宜三 で 令和04.05）。**議長の表だけを使うこと。**
 *
 * ## 検算A の弱さ（数として残す）
 * **1 行回して落ちるのは 88 / 374 行（23.5%）でしかない。**
 * **理由は数えてある——421 行のうち 351 行（83%）が全会一致**（`×` が 1 つも無い）で、
 * **隣の議案と `○` の数まで同じことが多いので、ずらしても数が合ってしまう。**
 * **「検算A が通る」ことは「y が正しい」ことの証明にならない。**
 *
 * ## **測れていないこと**（#835 の担当者。**確かめていないので、そう書く**）
 * - **`title` が 1 議案ぶんずれる壊れ方を、この 2 本はどちらも捕まえない**（#829 と同じ形）。
 *   **ただし三重の `readRows` は、左の欄も記号帯も同じ `within(i.cy, y0, y1)` で、
 *   同じ罫線の間から読んでいる**（`votes-pdf.ts`。錨からの距離ではない）。
 *   **「左の欄だけが 1 行ずれる」経路がコードの上に無いことは読んで確かめたが、
 *   それを落とすテストは置けていない**（`VotePdfRow` に y が無いため。#829 と同じ制約）。
 * - **読めない 136 本の中身は測っていない。** **どの議案が欠けているかは分からない。**
 */

const dir = fileURLToPath(new URL("fixtures/mie/", import.meta.url));

/**
 * **`parseVotePdf` が最後まで読めない本**（Issue #867 B 群「拡大のみ 15 本」から取った 2 本）。
 *
 * **#982 で `000073609.pdf` はこのリストから外れた**（2026-09-24）——
 * **「1 行ぶんの記号が 1 つの showText にまとまっている」壁は #982 が越えた**
 * （`parseVotePdf` が「割らずに読む → 落ちたら全部割って読み直す」の 2 段構えになった。
 * 詳しくは `test/mie-batched-showtext.test.ts`）。
 *
 * **残る `000073620.pdf` は「読めるようになった本」ではない。**
 * **割っても止まる。壁が違う**——**この本は本文の行を区切る全幅の罫線が足りず、
 * 全部の行が 1 行に潰れている**（割ると 7 議案ぶんの議決月日が 1 つのセルに連なり、
 * `date "2/222/222/22…" is not M/D` で止まる）。**推測で切り分けない。**
 *
 * **`000073610.pdf` / `000073614.pdf` は #867 の回転 11 本から取った 2 本**（2026-09-24 に足した）。
 * **回転そのものは打ち消せる**（`Tm × CTM × /Rotate の打ち消し` を合成すると回転が消える。
 * 詳しくは `test/mie-rotated.test.ts`）。**表題も凡例も罫線も正しく立ち、記号も列に正しく落ちる。**
 * **それでも `readGlyphPages` が既定で止める**——
 * **この 11 本は会派見出しが「横書きの複数行」で置かれており、
 * `readVerticalHeading`（縦書き前提。#901）で読むと `新政みえ` が `えみ政新` になる。**
 * **「記録が出ない」ではなく「別の文字列が出る」側なので、出さない側に倒した**（#569）。
 * **縦書きか横書きかを見分ける規則は、151 本で測っても分かれなかったので作っていない。**
 *
 * **握り潰していない。** `parseVotePdf` は今も例外を投げる（#569 の「途中まで読まない」は守られている）。
 * **このファイルの検査（`議` の列 ↔ 歴代議長）は「最後まで読めた本」にしか当てられない**ので、
 * **名指しで外し、理由をここに書く。** **フィクスチャとして置いてあるのは、
 * `local-glyphs-cmap.test.ts` が「CMap 無しならグリフ 0 / CMap ありなら取れる」を実物で固定するため、
 * および `mie-rotated.test.ts` が回転の打ち消しを実物で固定するため。**
 */
const NOT_FULLY_PARSEABLE = new Map<string, RegExp>([
  // 全幅の罫線が足りず、全部の行が 1 行に潰れる（#994 が測って残した）
  ["000073620.pdf", /incomplete row .* after splitting glyphs: .* is not M\/D/],
  // 回転は打ち消せるが、会派見出しが横書きなので票を出さない（#867 / #569）
  ["000073610.pdf", /rotated page \(\/Rotate 90\)/],
  ["000073614.pdf", /rotated page \(\/Rotate 90\)/],
]);

const files = readdirSync(dir).filter((f) => f.endsWith(".pdf")).sort();
const books: { name: string; pdf: VotePdf }[] = [];
for (const f of files.filter((f) => !NOT_FULLY_PARSEABLE.has(f))) books.push({ name: f, pdf: await parseVotePdf(readFileSync(dir + f)) });

// **外した本が本当に「読めない」ままであることを検査にする**（#569）。
// **黙って除外リストに足せば検査をすり抜けられる**ので、除外の理由のほうを固定する。
test("#867 除外した本は parseVotePdf が例外で止まる（握り潰して部分的に読んでいない）", async () => {
  // **本ごとに「どの理由で止まるか」まで固定する**——
  // **理由が変わったら気づけるようにする**（別の壁に移ったのに同じ除外で隠れないように）。
  for (const [f, reason] of NOT_FULLY_PARSEABLE) {
    await assert.rejects(
      () => parseVotePdf(readFileSync(dir + f)),
      reason,
      `${f}: 読めるようになったなら除外リストから外すこと`,
    );
  }
});

/**
 * **三重県議会 歴代議長**（一次資料 https://www.pref.mie.lg.jp/KENGIKAI/07681011814.htm 、
 * 更新日 令和8年5月19日。**2026-09-14 に取り直した**。#835 が 2026-09-13 に取ったものと同じページ）。
 * **就任年月から次の就任年月の前月まで。** **PDF の表題の年月で引く**（議決月日ではない）。
 * **ここに無い年月の本は判定外**（推定しない。#569）。
 *
 * **#835 はこの表を 3 行（114〜116代）しか写していなかった**ので、
 * **平成27年〜令和6年の本が「表に無い年月」として静かに判定外に落ちていた**（#852）。
 * **index の賛否 PDF は平成20年（2008年）から始まる**ので、**その手前の 100代（平成19.05）から写した。**
 *
 * **同じページに「歴代副議長」の表が並んでおり、代の番号も氏名も違う**（**#835 の担当者が実際に取り違えた**）。
 * **ずれの形を数として残す**: **令和06.05 は 議長 114代 稲垣昭義 / 副議長 118代 小林正人。**
 * **代の番号が 4 ずれ、氏名も違う。** **「代の番号が 2 ずれる」ではない**——
 * **議長は平成22・24・28年に交代が無く（表に行が無い）、副議長は毎年交代しているため、ずれ幅は年によって変わる。**
 * **下の `VICE_SPEAKERS` は「副議長の表を使うと落ちる」ことを測るためだけに置いてある**（照合には使わない）。
 */
const SPEAKERS: { from: [number, number]; name: string }[] = [
  { from: [2007, 5], name: "岩名秀樹" },
  { from: [2008, 5], name: "萩野虔一" },
  { from: [2009, 5], name: "三谷哲央" },
  { from: [2011, 5], name: "山本教和" },
  { from: [2013, 5], name: "山本勝" },
  { from: [2014, 5], name: "永田正巳" },
  { from: [2015, 5], name: "中村進一" },
  { from: [2017, 5], name: "舟橋裕幸" },
  { from: [2018, 5], name: "前田剛志" },
  { from: [2019, 5], name: "中嶋年規" },
  { from: [2020, 5], name: "日沖正信" },
  { from: [2021, 5], name: "青木謙順" },
  { from: [2022, 5], name: "前野和美" },
  { from: [2023, 5], name: "中森博文" },
  { from: [2024, 5], name: "稲垣昭義" },
  { from: [2025, 5], name: "服部富男" },
  { from: [2026, 5], name: "藤田宜三" },
];

/**
 * **歴代副議長**（同じページの 2 つ目の表。**照合には使わない**）。
 * **#835 の担当者が踏んだ罠を、テストで落ちることとして固定するためだけに置く。**
 */
const VICE_SPEAKERS: { from: [number, number]; name: string }[] = [
  { from: [2007, 5], name: "桜井義之" },
  { from: [2008, 5], name: "岩田隆嘉" },
  { from: [2009, 5], name: "野田勇喜雄" },
  { from: [2010, 5], name: "森本繁史" },
  { from: [2011, 5], name: "中村進一" },
  { from: [2012, 5], name: "舟橋裕幸" },
  { from: [2013, 5], name: "前田剛志" },
  { from: [2014, 5], name: "奥野英介" },
  { from: [2015, 5], name: "中森博文" },
  { from: [2016, 5], name: "日沖正信" },
  { from: [2017, 5], name: "水谷隆" },
  { from: [2018, 5], name: "前野和美" },
  { from: [2019, 5], name: "北川裕之" },
  { from: [2020, 5], name: "服部富男" },
  { from: [2021, 5], name: "稲垣昭義" },
  { from: [2022, 5], name: "藤田宜三" },
  { from: [2023, 5], name: "杉本熊野" },
  { from: [2024, 5], name: "小林正人" },
  { from: [2025, 5], name: "森野真治" },
  { from: [2026, 5], name: "津田健児" },
];

/**
 * **議長本人の不信任決議案だけは、議長が `除`（除斥）になり、副議長が議事を執る**（#852 で 1 行だけ見つかった）。
 * **これは実装の誤りではなく議会の扱いである。一次資料で 1 行ずつ確かめたものだけをここに書く**（#569）。
 *
 * `001041967.pdf`（令和4年定例会 10月）`決議案第５号`
 * **「三重県議会前野和美議長に対する不信任決議案」**:
 * **`議` は列 14 = 藤田 宜三**（**令和04.05 就任の副議長 116代**）、
 * **`除` は列 35 = 前野 和美**（**その月の議長 112代**）。
 * 一次資料（議決分の審議結果ページ。同じホスト、2026-09-14 取得）:
 * https://www.pref.mie.lg.jp/KENGIKAI/000260788_00007.htm
 * **「１０月１９日　原案を否決した決議案」の下に `決議案第５号　三重県議会前野和美議長に対する不信任決議案` がある。**
 * **PDF 側の数（賛成2・反対44）とも矛盾しない。**
 *
 * **同じ本の 1 つ前の `決議案第４号`（小林貴虎議員に対する辞職勧告決議案）では、
 * `除` が列 21 = 小林 貴虎 に立ち、`議` は列 35 = 前野 和美 のままである。**
 * **`除` が「決議案の名前に出てくる本人の列」にちょうど立つことが、x 方向の独立した裏取りになっている。**
 *
 * **#867 で A 群（相対移動）を読めるようにしたとき、同じ形がもう 1 件見つかった。**
 * `000674338.pdf`（平成28年定例会 12月）`決議案第５号`
 * **「三重県議会中村進一議長に対する不信任決議案」**:
 * **`議` は列 16 = 日沖 正信**（**平成28.05 就任の副議長 110代**。上の `VICE_SPEAKERS` と同じ表の同じ行）、
 * **`除` は列 20 = 中村 進一**（**その月の議長 106代**。同じ本の他の 48 行では `議` が立っている列）。
 * **PDF 側の数（賛成20・反対25・否決）とも矛盾しない。**
 * **同じ本の他の 48 行はすべて `議` = 中村 進一 なので、この 1 行だけが入れ替わっている。**
 */
const SPEAKER_EXCEPTIONS: { file: string; kind: string; number: string; speaker: string; excluded: string }[] = [
  { file: "001041967.pdf", kind: "決議案", number: "第５号", speaker: "藤田宜三", excluded: "前野和美" },
  { file: "000674338.pdf", kind: "決議案", number: "第５号", speaker: "日沖正信", excluded: "中村進一" },
];

/**
 * **議長が交代した月の本は、1 冊の中に前後 2 人の `議` が立つ**（#867 で A 群を読めるようにして初めて出てきた）。
 * **`SPEAKERS` は「就任年月から」でしか引けないので、交代月の本は月だけでは 1 人に決まらない。**
 * **これは実装の誤りではなく、実在する形である**（推定でずらすのではなく、一次資料で 1 行ずつ確かめて書く。#569）。
 *
 * `000073643.pdf`（平成26年定例会 5月、**平成26年5月16日議決分**）:
 * **`議提議案第3号` は `議` = 列 39 山本 勝**（**104代、平成25.05 就任**）、
 * **`議案第126号` は `議` = 列 40 永田 正巳**（**105代、平成26.05 就任**）。
 * **同じ日の同じ本の中で議長が代わっている**——
 * **`議案第126号`「監査委員の選任につき同意を得るについて」は新議長の下で諮られている。**
 * 一次資料（歴代正副議長 https://www.pref.mie.lg.jp/KENGIKAI/07681011814.htm 、2026-09-14 取得）:
 * **104代 山本勝 平成25.05 / 105代 永田正巳 平成26.05。**
 * **議決分の審議結果ページ（「平成26年定例会 平成26年5月16日議決分」）にも
 * `議提議案第３号` と `議案第126号` の 2 件が並んでおり、この本の 2 行と一致する。**
 * **そのページの URL はここに書かない**——**2026-09-16 に確かめようとして 404 だったものを
 * 「確かめた一次資料」として残さない**（#569。**リンクは実際に引けたものだけを書く**）。
 * **この行の根拠は上の「歴代正副議長」（実際に引けた）と、PDF 自身の 2 行である。**
 */
const TRANSITION_EXCEPTIONS: { file: string; kind: string; number: string; speaker: string }[] = [
  { file: "000073643.pdf", kind: "議提議案", number: "第3号", speaker: "山本勝" },
  // **#982 で読めるようになった 2 本も、同じ「交代月」の形だった**（2026-09-24）。
  //
  // **`001088736.pdf`（令和２年定例会（５月））**: **3 行とも `議` はちょうど 1 つ立つ。**
  //   `議案第100号` `議案第101号`（**議決 5/14**）→ **列 32「中嶋 年規」**（113代、令和元.05 就任）
  //   `議案第102号`「監査委員の選任につき同意を得るについて」（**議決 5/15**）→ **列 17「日沖 正信」**（114代、令和2.05 就任）
  //   **`speakerAt` は月だけで引くので 3 行とも「日沖正信」を期待するが、
  //   前 2 行は交代前の議決である**（PDF 自身の議決月日が 5/14 と 5/15 で割れている）。
  { file: "001088736.pdf", kind: "議案", number: "第100号", speaker: "中嶋年規" },
  { file: "001088736.pdf", kind: "議案", number: "第101号", speaker: "中嶋年規" },
  // **`000072296.pdf`（平成２５年定例会（５月））**: **2 行とも `議` はちょうど 1 つ立つ。**
  //   `議案第103号` → **列 41「山本 教和」**（103代、平成23.05 就任）
  //   `議案第104号`「監査委員の選任につき同意を得るについて」→ **列 39「山本 勝」**（104代、平成25.05 就任）
  //   **議決月日はどちらも 5/16 で、同じ日の同じ本の中で議長が代わっている**
  //   （**`000073643.pdf` と同じ形**。新議長の下で「監査委員の選任」が諮られる）。
  { file: "000072296.pdf", kind: "議案", number: "第103号", speaker: "山本教和" },
];

const speakerAt = (year: number, month: number, table: { from: [number, number]; name: string }[] = SPEAKERS): string | undefined => {
  let found: string | undefined;
  for (const s of table) if (year > s.from[0] || (year === s.from[0] && month >= s.from[1])) found = s.name;
  return found;
};

const bare = (s: string) => s.replace(/[\s　]/g, "");

/** `cells` を行方向に k 回す（左の欄は動かさない＝「記号帯が k 行ずれた」状態） */
const rotateRows = (rows: readonly string[][], k: number): string[][] =>
  rows.map((_, i) => rows[(((i + k) % rows.length) + rows.length) % rows.length]);

/** `cells` を列方向に k 回す（行ごとに。ずらしではなく回転——空の列に落ちて落ちる、という安い理由を消す） */
const rotateCols = (cells: readonly string[], k: number): string[] =>
  cells.map((_, i) => cells[(((i + k) % cells.length) + cells.length) % cells.length]);

interface Tally { judgeable: number; skipped: number; bad: string[] }

/** 検算A: 公表された賛成者数・反対者数 ↔ その行の記号帯の ○ / × の数 */
function checkCounts(b: { name: string; pdf: VotePdf }, cellsOf: (i: number) => readonly string[]): Tally {
  const t: Tally = { judgeable: 0, skipped: 0, bad: [] };
  b.pdf.rows.forEach((r, i) => {
    const cells = cellsOf(i);
    // **置けていないセルがある行は判定外**（不明を ○ とも × とも数えない）
    if (cells.some((c) => c === UNKNOWN_CELL)) { t.skipped++; return; }
    t.judgeable++;
    const yes = cells.filter((c) => c === "○").length;
    const no = cells.filter((c) => c === "×").length;
    if (yes !== r.counts.yes || no !== r.counts.no) t.bad.push(`${b.name} ${r.kind}${r.number} ○${yes}/${r.counts.yes} ×${no}/${r.counts.no}`);
  });
  return t;
}

/** 検算B: `議` が立つ列の議員が、その月の議長（県の公表）と同じか */
function checkSpeaker(
  b: { name: string; pdf: VotePdf },
  cellsOf: (i: number) => readonly string[],
  table: { from: [number, number]; name: string }[] = SPEAKERS,
): Tally {
  const t: Tally = { judgeable: 0, skipped: 0, bad: [] };
  const month = speakerAt(b.pdf.year, b.pdf.month, table);
  // **表に無い年月は判定外**（推定しない）
  if (month === undefined) { t.skipped = b.pdf.rows.length; return t; }
  b.pdf.rows.forEach((r, i) => {
    const cells = cellsOf(i);
    const at = cells.flatMap((c, k) => (c === "議" ? [k] : []));
    t.judgeable++;
    // **`議` がちょうど 1 つ立っていない行は、それ自体が壊れ**（議長は 1 人）
    if (at.length !== 1) { t.bad.push(`${b.name} ${r.kind}${r.number} 議 が ${at.length} 個`); return; }
    // **議長本人の不信任決議案だけは副議長が議事を執る**（一次資料で 1 行ずつ確かめたものだけ。#852）
    const ex = SPEAKER_EXCEPTIONS.find((e) => e.file === b.name && e.kind === r.kind && e.number === r.number);
    const tr = TRANSITION_EXCEPTIONS.find((e) => e.file === b.name && e.kind === r.kind && e.number === r.number);
    const want = ex ? ex.speaker : tr ? tr.speaker : month;
    const got = bare(b.pdf.members[at[0]].nameText);
    if (got !== want) t.bad.push(`${b.name} ${r.kind}${r.number} 議=${got} ≠ ${want}`);
  });
  return t;
}

const sum = (ts: Tally[]): Tally => ({
  judgeable: ts.reduce((n, t) => n + t.judgeable, 0),
  skipped: ts.reduce((n, t) => n + t.skipped, 0),
  bad: ts.flatMap((t) => t.bad),
});

test("#835 母数: フィクスチャ 25 本が読め、行と議員の数が実測どおり", () => {
  // **#867 で A 群（相対移動）の 3 本を足した**（`000073643` `000674338` `000711542`）。
  // **#901 でさらに 2 本**（`001086178`（令和5年6月）/ `001172850`（令和6年12月））——
  // **この 2 本は `--sessions 3` と `--sessions 4` を塞いでいた本**で、
  // **議案等番号の別の形（`意見書案N号` / `意見書第N案`）と、
  // 2 列に折り返した会派見出し（`草の根運動いが`）の両方を含む。**
  // **#867 A-2 でさらに 2 本**（`000073606.pdf`（平成21年8月・1 行）/ `000995095.pdf`（令和4年1月・2 行））——
  // **表題と凡例が 1 文字ずつ別の `showText` に割れている本**。**足した 3 行は検算B（歴代議長）を通り、
  // 副議長の表では 3 行とも落ちる**（下の #852 のテスト）。**不明セルは 0 増**（43 のまま）。
  assert.equal(books.length, 25, `読めた本 ${books.length}`);
  const rows = books.reduce((n, b) => n + b.pdf.rows.length, 0);
  const cells = books.reduce((n, b) => n + b.pdf.rows.length * b.pdf.members.length, 0);
  const unknown = books.reduce((n, b) => n + b.pdf.unknownCells, 0);
  // **母数を必ず出す**（#757）。「ずれ 0 件」と「1 行も比べていない」を同じ出力にしない
  assert.equal(rows, 498, `行 ${rows}`);
  assert.equal(cells, 23763, `セル ${cells}`);
  // **43 セルはすべて 令和6年10月 の 下野幸助（※１、令和6年10月10日に議員辞職）の列**——
  // **PDF がその列を空欄にしており、「棄権」でも「欠席」でもない。実装は推定せず UNKNOWN_CELL で残す。**
  assert.equal(unknown, 43, `不明セル ${unknown}`);
});

test("#835 検算A: 公表された賛成者数・反対者数が、その行の記号帯の ○ / × の数と合う", () => {
  const t = sum(books.map((b) => checkCounts(b, (i) => b.pdf.rows[i].cells)));
  assert.equal(t.judgeable, 455, `判定できた行 ${t.judgeable}（不明を含む ${t.skipped} 行は判定外）`);
  assert.deepEqual(t.bad, [], `合わない行 ${t.bad.length} / ${t.judgeable}`);
});

test("#835 検算B: `議` の列の議員が、県が公表している歴代議長と一致する", () => {
  const t = sum(books.map((b) => checkSpeaker(b, (i) => b.pdf.rows[i].cells)));
  // **#835 では 259 / 421 しか判定できていなかった**（歴代議長の表を 3 行しか写していなかったため）。
  // **表を 100代（平成19.05）から写し直したので、フィクスチャ 15 本の 379 行すべてが判定できる**（#852）。
  assert.equal(t.skipped, 0, `歴代議長の表に無い年月で判定外になった行 ${t.skipped}（0 が実測。増えたら表が足りていない）`);
  assert.equal(t.judgeable, 498, `判定できた行 ${t.judgeable}（歴代議長の表に無い年月 ${t.skipped} 行は判定外）`);
  assert.deepEqual(t.bad, [], `合わない行 ${t.bad.length} / ${t.judgeable}`);
});

test("#835 y 方向: 記号帯を 1 行回すと検算A が落ちる（検算A が恒真でないこと）", () => {
  let judgeable = 0, caught = 0;
  for (const b of books) {
    if (b.pdf.rows.length < 2) continue; // 1 行の本は回しても同じ
    const rot = rotateRows(b.pdf.rows.map((r) => r.cells), 1);
    const t = checkCounts(b, (i) => rot[i]);
    judgeable += t.judgeable; caught += t.bad.length;
  }
  // **落ちなければ検算A は y を測っていない**
  assert.ok(caught > 0, `1 行回して落ちた行 ${caught} / ${judgeable}（0 なら恒真）`);
  // **実測 47 / 212（フィクスチャ 8 本）= 22%。** 効きが落ちたら気づけるように下限を置く
  assert.ok(caught >= 40, `1 行回して落ちた行 ${caught} / ${judgeable}（実測 47。40 を下回ったら検算の効きが落ちている）`);
});

test("#835 x 方向: 記号帯を 1 列回すと検算B が落ちる（検算B が恒真でないこと）", () => {
  let judgeable = 0, caught = 0;
  for (const b of books) {
    const t = checkSpeaker(b, (i) => rotateCols(b.pdf.rows[i].cells, 1));
    judgeable += t.judgeable; caught += t.bad.length;
  }
  // **実測では 270 / 270 行すべてが落ちる**（列が 1 つ動けば議長の名前が変わる）
  assert.equal(caught, judgeable, `1 列回して落ちた行 ${caught} / ${judgeable}`);
  assert.ok(judgeable > 0, `判定できた行が 0`);
});

test("#835 2 本の検算は互いの代わりにならない（片方ずつ壊して 4 通り測る。#774）", () => {
  const yRot = (b: { name: string; pdf: VotePdf }) => { const r = rotateRows(b.pdf.rows.map((x) => x.cells), 1); return (i: number) => r[i]; };
  const xRot = (b: { name: string; pdf: VotePdf }) => (i: number) => rotateCols(b.pdf.rows[i].cells, 1);
  const multi = books.filter((b) => b.pdf.rows.length >= 2);
  const aY = sum(multi.map((b) => checkCounts(b, yRot(b))));
  const bY = sum(multi.map((b) => checkSpeaker(b, yRot(b))));
  const aX = sum(books.map((b) => checkCounts(b, xRot(b))));
  const bX = sum(books.map((b) => checkSpeaker(b, xRot(b))));
  // **検算A は y を捕まえ、x を 1 件も捕まえない**
  assert.ok(aY.bad.length > 0, `y 回転で検算A が落ちた ${aY.bad.length} / ${aY.judgeable}`);
  assert.equal(aX.bad.length, 0, `x 回転で検算A が落ちた ${aX.bad.length} / ${aX.judgeable}（置換なので数は変わらない。0 が実測）`);
  // **検算B は x を捕まえる**
  assert.ok(bX.bad.length > 0, `x 回転で検算B が落ちた ${bX.bad.length} / ${bX.judgeable}`);
  // **検算B は y をほとんど捕まえない**（#835 では 0 / 417 だった）。
  // **`001041967.pdf` を足して 2 / 373 になり、#867 で A 群の 2 本を足して 6 / 424 になった。**
  // **増えたぶんは「1 冊の中で `議` の列が動く行」がある本の数にちょうど比例している**（実測で 1 行ずつ数えた）:
  //   `001041967.pdf` 決議案第４号 / 第５号（議長本人の不信任決議案。#852）
  //   `000674338.pdf` 意見書案第20号 / 決議案第５号（同じく議長本人の不信任決議案。#867）
  //   `000073643.pdf` 議提議案第3号 / 議案第126号（**議長が交代した月の本**。#867）
  // **どの本も「その行」と「隣の行」の 2 行で氏名が合わなくなるので、3 本 × 2 行 = 6 行。**
  // **424 行のうち 6 行（1.4%）でしかないので、「検算B が y を見ている」とは依然として言えない。**
  // **上限で固定する**（**これが増えたら、その増えた理由を調べること**）。
  // **#982 で「1 冊の中で議長が交代する本」が 2 冊増えた**（2026-09-24。`001088736.pdf` 令和2年5月 /
  //   `000072296.pdf` 平成25年5月。どちらも「監査委員の選任」の行から新議長になる）ので、
  //   **6 → 10 になった**（**3 冊 × 2 行 ＋ 2 冊 × 2 行 = 10**。**増えたのは 4 行ちょうど**）。
  // **498 行のうち 10 行（2.0%）でしかないので、「検算B が y を見ている」とは依然として言えない。**
  assert.equal(bY.bad.length, 10, `y 回転で検算B が落ちた ${bY.bad.length} / ${bY.judgeable}（実測 10 = 議長の列が動く本 5 冊 × 2 行）`);
});

test("#835 x 方向: 記号のアイテムの中心と、置いた列の中心が半セル未満（列番号を通さずに測る）", async () => {
  const { readGlyphPages } = await import("../src/sources/local/mie/glyphs.ts");
  const { cluster, within, bandIndex } = await import("../src/sources/local/pdf-table.ts");
  let pairs = 0, half = 0, worst = 0;
  // **`NOT_FULLY_PARSEABLE` の 2 本は母数に入れない**（#867）。
  // この本は 1 行ぶんの記号が 1 アイテムにまとまっており、**「記号 1 つ」の対になっていない**
  // （入れると 20564 → 20573 対に増えるが、増えた 9 対は 1 文字の記号ではなく 49 文字の塊である）。
  // **そもそも #891 が「半セル未満は x の根拠にならない」と測っている**（1 列ずらしても 98〜99% が通る）ので、
  // **ここは「壊れていないこと」の弱い確認でしかない。母数を汚さないほうを採る。**
  for (const f of files.filter((f) => !NOT_FULLY_PARSEABLE.has(f))) {
    const pages = await readGlyphPages(readFileSync(dir + f));
    for (const page of pages) {
      const legendBottom = Math.min(...page.items.filter((i) => /^(.)：(.+)$/.test(i.str)).map((i) => i.y));
      const vl = page.vlines.filter((l) => l.y0 < legendBottom);
      const hl = page.hlines.filter((l) => l.y < legendBottom);
      const colXs = cluster(vl.map((l) => l.x));
      const left = colXs[0], right = colXs[colXs.length - 1];
      const full = cluster(hl.filter((l) => l.x0 <= left + 2 && l.x1 >= right - 2).map((l) => l.y)).sort((a, b) => b - a);
      const voteCols = colXs.slice(8); // 左 8 列のぶんを飛ばす（LEFT_HEADERS.length）
      for (const it of page.items) {
        if (!within(it.cy, full[full.length - 1], full[1]) || it.cx <= voteCols[0]) continue;
        const c = bandIndex(voteCols, it.cx);
        if (c === undefined) continue;
        const w = voteCols[c + 1] - voteCols[c];
        const d = Math.abs(it.cx - (voteCols[c] + voteCols[c + 1]) / 2) / w;
        pairs++;
        if (d < 0.5) half++;
        if (d > worst) worst = d;
      }
    }
  }
  // **母数を書く**（#757）。「全部一致」だけでは 0 対を測ったのと区別が付かない
  assert.equal(pairs, 23374, `測った (記号, 列) の対 ${pairs}`);
  assert.equal(half, pairs, `半セル未満 ${half} / ${pairs}`);
  // 実測 max 0.0297（セル幅 14.64pt の 3%）
  assert.ok(worst < 0.05, `いちばん外れた対 ${worst.toFixed(4)} セル幅`);
});

/* ---------- #852: 新たに読めた本の列の割り当てを、歴代議長と照合する ---------- */

/**
 * **#850 で読めるようになった 18 本のうち、外の事実と照合されていたのは 1 本だけだった**
 * （`001197758.pdf` の `議` = 稲垣昭義）。**残り 17 本は検算A が通っていることしか言えなかった。**
 * **#835 自身が「検算A は x 方向のずれを 1 件も捕まえない（0 / 378 行）」と測っているので、
 * この 17 本の列の割り当ては実質「未検証」に近かった**（#852）。
 *
 * **原因は歴代議長の表の写し方にあった**: **#835 は 114〜116代の 3 行しか写しておらず、
 * 平成27年〜令和6年の本は `speakerAt` が `undefined` を返して静かに判定外に落ちていた。**
 * **`skipped` は数として出ていたが、「表が足りない」と「照合できない」が同じ出力だった。**
 *
 * ## **151 本すべてを取り直して測った**（2026-09-14。**UA を名乗り・直列・2.5 秒間隔・151 本すべて HTTP 200**）
 *
 * | | 本数 |
 * |---|---:|
 * | 読めた本（今の実装） | **33** |
 * | 読めた本（#850 の前の貪欲な `LEGEND_ITEM` に戻したとき） | **15** |
 * | **新たに読めた本** | **18** |
 * | 読めなくなった本 | **0** |
 *
 * **歴代議長の表を 100代（平成19.05）から写し直したところ、33 本 942 行すべてが判定できた**
 * （**#835 の 259 / 942 から増えた。判定外は 0 行**）:
 *
 * | | 判定できた行 | 一致しなかった行 |
 * |---|---:|---:|
 * | **新たに読めた 18 本** | **521** | **1** |
 * | 元から読めていた 15 本 | **421** | **0** |
 * | 合計 | **942** | **1** |
 *
 * ## **一致しなかった 1 行**（**これが一番重要な発見。実装の誤りではなかった**）
 *
 * `001041967.pdf`（令和4年定例会 10月）`決議案第５号`
 * **「三重県議会前野和美議長に対する不信任決議案」**——
 * **`議` が立つのは列 14 = 藤田 宜三（副議長）で、その月の議長 前野 和美（112代）ではない。**
 * **前野 和美 の列 35 には `除`（除斥）が立っている。**
 * **議長本人の不信任決議案なので、議長は除斥され、副議長が議事を執る。議会の扱いである。**
 * 一次資料で確かめた（https://www.pref.mie.lg.jp/KENGIKAI/000260788_00007.htm 、2026-09-14 取得）:
 * **「１０月１９日　原案を否決した決議案」の下に `決議案第５号　三重県議会前野和美議長に対する不信任決議案` がある。**
 *
 * ## **測れていないこと**（**確かめていないので、そう書く**）
 * - **フィクスチャに入れたのは 18 本のうち 4 本だけである**（`001041967` `000857212` `001101891` `000621935`。
 *   **既に入っていた 2 本（`000599391` `000599392`）と合わせて 6 本**）。
 *   **残り 12 本は、この作業で 1 度測っただけで、リポジトリの中では回帰しない**（**PDF の重さのため**）。
 * - **`議` 以外の列（○ / × / 欠 / －）の割り当てを、議員 1 人ずつ外の事実と照合してはいない。**
 *   **`議` と `除` の 2 種類しか外に結んでいない。**
 * - **A（80 本）・B（35 本）には触っていないので、151 本のうち 118 本は依然として読めない。**
 * - **`data/` は 1 件も変えていない**（**これは検証であって、ETL は走らせていない**）。
 */
test("#852 新たに読めた本を含めて、`議` の列が歴代議長と一致する（判定外を 0 行にする）", () => {
  // **新たに読めた 18 本のうち、フィクスチャに入れた 6 本**（残り 12 本はリポジトリに置いていない）
  const NEW = ["000599391.pdf", "000599392.pdf", "000621935.pdf", "000857212.pdf", "001041967.pdf", "001101891.pdf"];
  const newBooks = books.filter((b) => NEW.includes(b.name));
  // **母数を先に固定する**（#757。**フィクスチャが消えても「一致 0 件」で緑になる形にしない**）
  assert.equal(newBooks.length, 6, `新たに読めた本のうちフィクスチャにあるもの ${newBooks.length}`);
  const t = sum(newBooks.map((b) => checkSpeaker(b, (i) => b.pdf.rows[i].cells)));
  assert.equal(t.skipped, 0, `歴代議長の表に無い年月で判定外になった行 ${t.skipped}`);
  assert.equal(t.judgeable, 120, `判定できた行 ${t.judgeable}（実測 120 = 1+1+15+34+31+38）`);
  assert.deepEqual(t.bad, [], `合わない行 ${t.bad.length} / ${t.judgeable}`);
});

test("#852 議長本人の不信任決議案では、議長が `除`・副議長が `議` になる（一次資料で確かめた 1 行）", () => {
  // **母数を出す**（#757）。例外の表が空になったら落ちる
  assert.equal(SPEAKER_EXCEPTIONS.length, 2, `例外として書いた行 ${SPEAKER_EXCEPTIONS.length}`);
  for (const ex of SPEAKER_EXCEPTIONS) {
    const b = books.find((x) => x.name === ex.file);
    assert.ok(b, `${ex.file} がフィクスチャに無い`);
    const row = b.pdf.rows.find((r) => r.kind === ex.kind && r.number === ex.number);
    assert.ok(row, `${ex.file} に ${ex.kind}${ex.number} が無い`);
    // **議案名に、除斥された議員の氏名がそのまま入っている**（外の事実との結び目。名前が入っていなければ例外扱いは根拠を失う）
    assert.ok(row.title.includes("不信任"), `${ex.kind}${ex.number} の件名に「不信任」が無い: ${row.title}`);
    assert.ok(row.title.replace(/[\s　]/g, "").includes(ex.excluded), `${ex.kind}${ex.number} の件名に ${ex.excluded} が無い: ${row.title}`);
    // **`議` は副議長の列**
    const at = row.cells.flatMap((c, k) => (c === "議" ? [k] : []));
    assert.equal(at.length, 1, `${ex.kind}${ex.number} の 議 が ${at.length} 個`);
    assert.equal(bare(b.pdf.members[at[0]].nameText), ex.speaker, `${ex.kind}${ex.number} の 議 の列`);
    // **`除` は、件名に名前が出てくる議長本人の列**（**x 方向の独立した錨。`議` を使わずに列を当てている**）
    const ex2 = row.cells.flatMap((c, k) => (c === "除" ? [k] : []));
    assert.equal(ex2.length, 1, `${ex.kind}${ex.number} の 除 が ${ex2.length} 個`);
    assert.equal(bare(b.pdf.members[ex2[0]].nameText), ex.excluded, `${ex.kind}${ex.number} の 除 の列`);
    // **その月の歴代議長の表を引いたら、除斥された本人が出る**（例外が「議長でない人を議長と呼んでいる」形になっていないこと）
    assert.equal(speakerAt(b.pdf.year, b.pdf.month), ex.excluded, `${ex.file} の年月の議長`);
  }
});

test("#852 同じ本の 決議案第４号 では、`除` が件名に名前の出る議員の列に立ち、`議` は議長のまま", () => {
  // **例外の表に入れていない行でも `除` が外の名前に当たることを測る**（例外の表だけを根拠にしない）
  const b = books.find((x) => x.name === "001041967.pdf");
  assert.ok(b, "001041967.pdf がフィクスチャに無い");
  const row = b.pdf.rows.find((r) => r.kind === "決議案" && r.number === "第４号");
  assert.ok(row, "決議案第４号 が無い");
  assert.ok(row.title.replace(/[\s　]/g, "").includes("小林貴虎"), `件名: ${row.title}`);
  const ex = row.cells.flatMap((c, k) => (c === "除" ? [k] : []));
  assert.equal(ex.length, 1, `除 が ${ex.length} 個`);
  assert.equal(bare(b.pdf.members[ex[0]].nameText), "小林貴虎", "除 の列");
  const at = row.cells.flatMap((c, k) => (c === "議" ? [k] : []));
  assert.equal(at.length, 1, `議 が ${at.length} 個`);
  assert.equal(bare(b.pdf.members[at[0]].nameText), "前野和美", "議 の列");
});

test("#852 副議長の表で照合すると落ちる（#835 の担当者が実際に踏んだ罠）", () => {
  // **同じページに並ぶ「歴代副議長」を使うと、代の番号も氏名も違う。**
  // **この検算が「どの表を使っても通る」形なら、外の事実に結んだことにならない。**
  const t = sum(books.map((b) => checkSpeaker(b, (i) => b.pdf.rows[i].cells, VICE_SPEAKERS)));
  assert.equal(t.skipped, 0, `副議長の表で判定外になった行 ${t.skipped}`);
  assert.equal(t.judgeable, 498, `副議長の表で判定できた行 ${t.judgeable}`);
  // **実測 428 / 431 行が落ちる。落ちない 3 行を 1 行ずつ数えた**（#867。**まとめて「3 行」と書かない**）:
  //   `001041967.pdf` 決議案第５号 = 藤田宜三（**本当に副議長が `議`**。平成…令和04.05 就任の副議長。#852）
  //   `000674338.pdf` 決議案第５号 = 日沖正信（**本当に副議長が `議`**。平成28.05 就任の副議長。#867）
  //   `000073643.pdf` 議提議案第3号 = 山本勝（**これは理由が違う**——
  //     **議長交代月なので `TRANSITION_EXCEPTIONS` が「山本勝」を期待値に入れており、
  //     どちらの表を使っても期待値が同じになるので、この 1 行だけ副議長の表でも通ってしまう。**
  //     **例外の表は「その行を検算から外す」のと同じ効きしか持たない**、ということがここに出ている。）
  // **#901 で 2 本足して 428 → 485 になった**（足した 57 行はすべて落ちる＝どちらの表でも通る行は増えていない）
  // **#867 A-2 でさらに 2 本足して 485 → 488 になった**（`000073606.pdf` 1 行 / `000995095.pdf` 2 行。
  // **足した 3 行はすべて落ちる**＝**新しく読めた行は、議長の表と副議長の表を区別できている**。
  // **「読めた本が増えたのに、どちらの表でも通る行が増えていない」ことが、ここの数で担保される。**）
  // **#982 で 3 本ぶん 7 行が増えて 488 → 492 になった**（2026-09-24）。
  // **増えた 7 行のうち 4 行が落ち、3 行は落ちない**——
  //   落ちる: `000073609.pdf` 議案第96号 / 第97号（萩野虔一 ≠ 副議長 岩田隆嘉）、
  //           `000072296.pdf` 議案第104号（山本勝 ≠ 副議長 前田剛志）、
  //           `001088736.pdf` 議案第102号（日沖正信 ≠ 副議長 服部富男）
  //   落ちない: `000072296.pdf` 議案第103号 と `001088736.pdf` 議案第100号 / 第101号——
  //     **どれも `TRANSITION_EXCEPTIONS` の行で、どちらの表を使っても期待値が同じになる。**
  //     **例外の表は「その行を検算から外す」のと同じ効きしか持たない**（上の `000073643.pdf` と同じ形）。
  assert.equal(t.bad.length, 492, `副議長の表で落ちた行 ${t.bad.length} / ${t.judgeable}（実測 492）`);
  // **通ってしまう行は 3 → 6 に増えた**（#982。**増えた 3 行はすべて `TRANSITION_EXCEPTIONS` の行である**——
  // `000072296.pdf` 議案第103号 / `001088736.pdf` 議案第100号 / 第101号。**上のコメントに 1 行ずつ書いた。**）
  // **つまり「通ってしまう行 = 例外の表に載っている行 ＋ 本当に副議長が議事を執った行」であり、
  // 例外を足せばここも増える。** **増えるたびに 1 行ずつ理由を書くこと**（まとめて数だけ増やさない）。
  const passed = t.judgeable - t.bad.length;
  assert.equal(passed, 6, `副議長の表でも通った行 ${passed}`);
  // **代の番号のずれは年によって違う**（「2 年ずれる」ではない）。令和06.05 で 議長 114代 稲垣昭義 / 副議長 118代 小林正人
  assert.equal(speakerAt(2024, 6), "稲垣昭義", "令和6年6月の議長");
  assert.equal(speakerAt(2024, 6, VICE_SPEAKERS), "小林正人", "令和6年6月の副議長");
  assert.notEqual(speakerAt(2024, 6), speakerAt(2024, 6, VICE_SPEAKERS), "議長と副議長が同じ人になっている");
});

test("#852 歴代議長の表が、index の賛否 PDF の一番古い年（2008年）より前から始まっている", () => {
  // **表が足りないと `skipped` が増えるだけで緑のままになる**（#835 で実際にそうなった）。
  // **index の賛否 PDF は平成20年（2008年）から始まる**ので、表はその手前から無ければならない。
  assert.equal(SPEAKERS.length, 17, `歴代議長の表の行 ${SPEAKERS.length}`);
  const first = SPEAKERS[0].from;
  assert.ok(first[0] < 2008 || (first[0] === 2008 && first[1] <= 1), `表の最初 ${first[0]}/${first[1]} が 2008年1月 より後`);
  // **昇順であること**（`speakerAt` が「最後に当たったもの」を返すので、順序が崩れると別人を返す）
  for (let i = 1; i < SPEAKERS.length; i++) {
    const a = SPEAKERS[i - 1].from, b = SPEAKERS[i].from;
    assert.ok(b[0] > a[0] || (b[0] === a[0] && b[1] > a[1]), `${i} 行目が昇順でない`);
  }
});
