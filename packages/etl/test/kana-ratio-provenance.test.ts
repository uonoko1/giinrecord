import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { kanaNameRatioExceeds } from "../src/local-assemblies.ts";

const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf-8");
const localDir = fileURLToPath(new URL("../src/sources/local/", import.meta.url));

/**
 * # `kanaNameRatioExceeds` の docblock が主張していた前提は、実装のどこでも成り立っていない（#771）
 *
 * **2026-09-13 まで、`local-assemblies.ts` の docblock はこう書いていた:**
 *
 * > **氏名は名簿の PDF から、かなは名簿の HTML から取る**（衆院の場合は同じ HTML だが、他は別系統）ので、
 * > **独立した 2 つの値による検算になる。**
 *
 * **#763 の担当者が地方について「名簿の氏名を PDF から取る議会は 0」と実測した**（PR #770）。
 * **この test は、その実測を「地方 11 県」と「国会 2 院」の両方に広げて固定する。**
 *
 * ## 測ったこと（2026-09-13、この worktree の実装を数えた）
 *
 * | | 値 |
 * |---|---|
 * | 名簿を作るモジュール | **13**（地方 11 県の `roster.ts` + 衆院 + 参院） |
 * | **そのうち氏名を PDF から取るもの** | **0** |
 * | PDF を読むモジュール | **16**（うち地方の `votes-pdf.ts` が 11、選挙区の 2、共通の 2、字形の 1） |
 * | **そのうち名簿を作るもの** | **0**（全部が採決の投票用紙か、選挙区の資料） |
 *
 * **つまり「氏名は PDF、かなは HTML」という組は、この repo のどこにも存在しない。**
 * **国会でも成り立っていない**ので、**#632 は最初から「独立した 2 つの値の検算」ではなかった。**
 */
test("#771 名簿の氏名を PDF から取るモジュールは 1 つも無い（地方 11 県 + 衆参）", () => {
  const prefs = readdirSync(localDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  // **県が増えたらここが落ちて、前提を測り直すことになる**（数を固定する。#753 の「母数は 1 つではない」）
  assert.equal(prefs.length, 11, `地方は 11 県のはず: ${prefs.join(",")}`);

  // **PDF を読む印**（pdfjs / pdf-table / getTextContent のいずれか）。
  // roster.ts が 1 つでも持っていたら、docblock の「氏名は名簿の PDF から」が成り立つ余地がある
  const readsPdf = (text: string) => /pdfjs|pdf-table|getTextContent|extractPdfText/.test(text);
  const rosters = prefs.map((p) => ({ label: `local/${p}/roster.ts`, text: src(`sources/local/${p}/roster.ts`) }));
  rosters.push({ label: "shugiin-members.ts", text: src("sources/shugiin-members.ts") });
  rosters.push({ label: "sangiin-members.ts", text: src("sources/sangiin-members.ts") });
  assert.equal(rosters.length, 13, "名簿を作るモジュールは 13");

  const pdfRosters = rosters.filter((r) => readsPdf(r.text));
  assert.deepEqual(pdfRosters.map((r) => r.label), [], "名簿の氏名を PDF から取るモジュールは 0");

  // **全部が HTML パーサを使っている**（「PDF ではない」の否定形だけでなく、何を使っているかを固定する。#520）
  const noHtml = rosters.filter((r) => !/node-html-parser/.test(r.text));
  assert.deepEqual(noHtml.map((r) => r.label), [], "13 モジュールすべてが HTML から名簿を作る");
});

/**
 * **国会でも、氏名とかなは同じ `<tr>` の隣り合う `<td>` から来る。**
 *
 * - **衆院**: `name` は `tds[0]` の `<a>` のテキスト、`kana` は `cells[1]`（`parseShugiinMemberList`）
 * - **参院**: `name` は `tds[0]` の `<a>` の innerHTML、`kana` は `cells[1]`（`parseMemberList`）
 *
 * **どちらも 1 回の `fetch` で取った 1 つの HTML の、1 つの行である。**
 * **片方だけが静かに欠ける経路が無いので、「独立した 2 つの値による検算」は成り立たない。**
 */
test("#771 衆院・参院とも、氏名とかなは同じ行の同じ HTML から取る", () => {
  for (const [label, file] of [["衆院", "sources/shugiin-members.ts"], ["参院", "sources/sangiin-members.ts"]] as const) {
    const text = src(file);
    // **かなは名簿ページの 2 列目**（衆院 `const kana = cells[1];` / 参院 `kana: cells[1],`）
    assert.ok(/\bkana(:| =) cells\[1\]/.test(text), `${label}: かなは cells[1]（名簿ページの 2 列目）`);
    // **その `cells` は同じ `tr` の `td` から作られている**（別の fetch でも別のページでもない）
    assert.ok(/const cells = (tr\.querySelectorAll\("td"\)|tds\.map)/.test(text), `${label}: cells は同じ tr の td`);
    // **氏名も同じ行の `tds[0]`／`td a` の `<a>` から取る**（かなと同じ 1 行）
    assert.ok(/const \{ name, legalName \} = parseNameCell\(a\.innerHTML\)|const name = normalize\(a\.text\)/.test(text), `${label}: 氏名も同じ行の a から`);
    // **名簿ページの取得は 1 か所だけ**（かな専用の 2 つ目の取得先が無い）
    const fetches = [...text.matchAll(/fetchText(Or404)?\(/g)].length;
    assert.equal(fetches, 1, `${label}: 名簿の取得は 1 か所（かな用の別系統は無い）`);
  }
});

/**
 * # **この検算が実データで何を捕まえるか**（2026-09-13、`data/members/index.json` 1,225 名で実測）
 *
 * **測り方**: 各議員の氏名（空白を除く）から 1 文字ずつ落とした全通りを作り、
 * **本人のかな**との比を `kanaNameRatioExceeds` に掛けて、鳴った件数を数えた。
 * **これは「氏名が静かに 1 文字欠ける」＝ docblock が捕まえると書いていた壊れ方の上限**である
 * （実際には名簿側は壊れないので、本番でこの比が動くことはもっと少ない）。
 *
 * | | 1 文字欠落の通り数 | 鳴る | 割合 |
 * |---|---:|---:|---:|
 * | **国会（衆参 772 名）** | **3,106** | **14** | **0.45%** |
 * | **地方（11 県 453 名、うちかなあり 366 名）** | **1,448** | **5** | **0.35%** |
 * | **合計** | **4,554** | **19** | **0.42%** |
 *
 * **国会でも 0.45% しか鳴らない。** **「地方では効かないが国会では効く」ではなく、どちらでも効かない。**
 * **鳴るのは氏名が 2 文字前後の議員だけ**で、これは docblock 自身が既に「限界」として書いていたとおりである。
 *
 * **ここでは代表値だけを固定する**（`data/` を読む test にすると、名簿が変わるたびに落ちてしまう）。
 */
test("#771 国会でも 1 文字欠落の 0.45% しか鳴らない——鳴るのは短い氏名だけ", () => {
  // **鳴る側**: 2 文字の氏名から 1 文字落ちた形（国会で鳴った 14 件はすべてこの形）
  assert.equal(kanaNameRatioExceeds("徹", "あずまとおる"), true, "「東 徹」→「徹」は比 6.0 で鳴る");
  // **鳴らない側**: 3 文字以上は落ちても鳴らない（国会 772 名の 9 割以上がこちら）
  assert.equal(kanaNameRatioExceeds("村哲彦", "よしむらてつひこ"), false, "3 文字は比 2.67 で鳴らない");
  assert.equal(kanaNameRatioExceeds("引ユキ子", "くしびきゆきこ"), false, "4 文字は比 1.75 で鳴らない");
  // **無傷の実データの比の最大値は 3.0**（衆院）。閾値 3.5 はこれを通すために選ばれている
  assert.equal(kanaNameRatioExceeds("東 徹", "あずま とおる"), false, "無傷なら鳴らない（比 2.5）");
  // **恒真ではない**ことの対照（#534）: 閾値を下げれば鳴る
  assert.equal(kanaNameRatioExceeds("引ユキ子", "くしびきゆきこ", 1.7), true, "閾値 1.7 なら鳴る");
});

/**
 * # **docblock が事実でない主張に戻らないようにする**
 *
 * **「独立した 2 つの値」「氏名は名簿の PDF から」は、上の 2 つの test が示すとおり
 * この repo のどこでも成り立たない。** **書き戻されたらここで落とす。**
 *
 * ## **「その語が出てこないこと」では検査にならない**
 *
 * **訂正の文自体が「〜と書いていたが事実ではなかった」と引用するので、語の有無では区別できない。**
 * **否定の文脈（「ではない」「事実ではなかった」「成り立っていない」）が同じ文に無い出現だけを数える。**
 *
 * **これは文言の検査であって守りではない**（#534: 消しても緑になる検査を守りと呼ばない）。
 * **守りは `lossyNameMatches`（機序 ②）と `sourceConflict`（機序 ④）が持っている。**
 */
test("#771 docblock は「独立した2つの値」「氏名は名簿の PDF から」を主張として書かない", () => {
  // **否定の印**（この語が同じ文にあれば、引用して打ち消している文である）
  const NEGATED = /ではない|事実ではなかった|成り立って|捕まえない|拾えない|気づけない|誤り/;
  const CLAIMS: [RegExp, string][] = [
    [/独立した\s*2\s*つの値/, "独立した2つの値"],
    [/氏名は名簿の\s*PDF\s*から/, "氏名は名簿の PDF から"],
  ];
  for (const file of ["local-assemblies.ts", "dataset.ts"]) {
    // **docblock は 1 つの文が複数行に折り返されている**ので、**行で割ってはいけない**——
    // **行頭の ` * ` を落として 1 本に繋いでから、句点で文に割る**
    // （繋がないと「〜と書いていたが」と次行の「**それは事実ではなかった**」が別の文になり、
    //  打ち消しを見落として偽陽性になる。実際にこれで 1 回落ちた）
    const joined = src(file).split("\n").map((l) => l.replace(/^\s*(\*|\/\*\*|\/\/)\s?/, "")).join("");
    const sentences = joined.split("。");
    for (const [re, label] of CLAIMS) {
      const asserted = sentences.filter((x) => re.test(x) && !NEGATED.test(x));
      assert.deepEqual(asserted, [], `${file}: 「${label}」を打ち消さずに書いている（#771 で事実でないと測った）`);
    }
  }
});

/**
 * **上の test が恒真でないことの対照**（#534 / #520）。
 * **打ち消しの無い文を与えれば、同じ判定で「主張している」と出る。**
 */
test("#771 主張の検出は恒真ではない（打ち消しの無い文は拾う）", () => {
  const NEGATED = /ではない|事実ではなかった|成り立って|捕まえない|拾えない|気づけない|誤り/;
  const re = /独立した\s*2\s*つの値/;
  const judge = (line: string) => re.test(line) && !NEGATED.test(line);
  // **2026-09-13 まで実際に書いてあった文**（打ち消しが無いので拾う）
  assert.equal(judge("独立した2つの値による検算になる"), true, "元の文は主張として拾う");
  // **今の訂正文**（打ち消しがあるので拾わない）
  assert.equal(judge("「独立した 2 つの値による検算」は国会でも地方でも成り立っていない"), false, "訂正文は拾わない");
  // **語が無ければ拾わない**
  assert.equal(judge("かな長 / 氏名長がこれを超えたら、氏名が壊れている疑い"), false);
});
