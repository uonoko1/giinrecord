import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseRoster } from "../src/sources/local/aomori/roster.ts";
import { kanaNameRatioExceeds } from "../src/local-assemblies.ts";
import { localNameKey } from "../src/sources/local/name-match.ts";

const fx = (name: string) => readFileSync(fileURLToPath(new URL(`fixtures/aomori/${name}`, import.meta.url)), "utf-8");
const roster = () => parseRoster(fx("giin-kaiha.html"), fx("giin-senkyoku.html"));

/**
 * # 青森の `kana` を埋めても #632 は機序 ② を捕まえない（Issue #763、2026-09-13 実測）
 *
 * **#763 は「青森だけ `kana` が空なので、#632 の検算が効かず、機序 ②（BMP 外文字が
 * 描画命令ごと欠落）が無防備になっている」という前提で立っている。**
 * **個別ページを 46 本すべて開いて測った結果、前提のうち「取れない」は誤りだった
 * （取れる）が、「埋めれば守れる」も誤りだった**（埋めても守れない）。
 *
 * ## 測ったこと（`polite-fetch.ts`・4.5 秒間隔・直列で 46 本）
 *
 * | | 値 |
 * |---|---|
 * | 個別ページ | **46 本すべてが `<span class="bgreen">氏名（かな）</span>` の形** |
 * | かなが読めた | **46 / 46** |
 * | 個別ページの氏名が会派別ページと一致 | **45 / 46**（不一致は `和田 寬司`/`和田 寛司` の 1 名だけ） |
 * | **かなを埋めたときの比の最大値** | **2.500**（`今 博` / `こん　ひろし`）。**閾値 3.5 に 1 名も届かない** |
 *
 * ## **理由 1（構造）: #632 は PDF 側の氏名を見ていない**
 *
 * `kanaNameRatioExceeds` は `members/index.json` の行（＝**名簿**）に対してだけ呼ばれる
 * （`local-assemblies.ts`）。**比べているのは「名簿の氏名」と「名簿のかな」である。**
 * **機序 ② は PDF 側で `櫛` が落ちる現象**で、**名簿はそのまま**なので、
 * **かなが何であっても比は動かない。** これは閾値の問題ではなく、見ている対象が違う。
 *
 * **`kanaNameRatioExceeds` の docblock は「氏名は名簿の PDF から、かなは名簿の HTML から取る」と
 * 書いているが、地方 10 議会のうち名簿の氏名を PDF から取っている議会は 1 つも無い**
 * （10 県の `roster.ts` を数えた。島根の `roster.ts` が PDF に触れているのは
 * 「PDF の名簿は使わない」と書いてある箇所だけ）。
 * **つまり地方では、名簿の氏名とかなは同じ HTML から来る。**
 *
 * ## **理由 2（数）: 閾値にも届かない**
 *
 * **`櫛引ユキ子`（かな `くしびき　ゆきこ` = 7 拍）から `櫛` が落ちて `引ユキ子`（4 文字）になっても、
 * 比は 1.75 で 3.5 の半分**である。**仮に #632 が PDF 側の氏名を見るように変えたとしても鳴らない。**
 */
test("#763 青森のかなを埋めても、機序 ②（櫛 が落ちる）では #632 は鳴らない", () => {
  // **個別ページから実測したかな**（`giin_kushibiki-yukiko.html` の
  // `<span class="bgreen">櫛󠄁引　ユキ子（くしびき　ゆきこ）</span>`）
  const kana = "くしびき　ゆきこ";
  const rosterName = "櫛\u{E0101}引 ユキ子";
  // 名簿は壊れていないので、かなを埋めても #632 は鳴らない（当然）
  assert.equal(kanaNameRatioExceeds(rosterName, kana), false, "名簿は壊れていないので鳴らない");
  // **機序 ② で PDF 側が失う形**。**仮にこれを #632 に掛けても鳴らない**（比 1.75 < 3.5）
  const lost = "引ユキ子";
  assert.equal(kanaNameRatioExceeds(lost, kana), false, "櫛 が落ちた氏名でも鳴らない（比 1.75）");
  // **比の実値を固定する**（「鳴らない」だけだと、閾値を動かせば鳴るのか判断できない）
  assert.equal([...kana.replace(/[\s　]/g, "")].length, 7, "かなは 7 拍");
  assert.equal([...lost].length, 4, "櫛 が落ちた氏名は 4 文字");
  assert.equal(7 / 4, 1.75);
  // **閾値を 1.75 まで下げれば鳴る**——つまり「鳴らない」のは閾値の選び方の帰結であって、
  // 恒真ではない（#534「消しても緑」を避けるための対照）
  assert.equal(kanaNameRatioExceeds(lost, kana, 1.7), true, "閾値 1.7 なら鳴る（恒真ではない）");
});

/**
 * **#632 が見るのは名簿の行だけである**という構造を固定する。
 * **PDF 側の氏名（`nameText`）はこの検算を一度も通らない。**
 */
test("#763 #632 は名簿の (name, kana) しか見ない——PDF 側の nameText は通らない", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/local-assemblies.ts", import.meta.url)), "utf-8");
  // **`export function kanaNameRatioExceeds(...)` の宣言そのものは呼び出しではない**ので除く
  const calls = [...src.matchAll(/(?<!function )kanaNameRatioExceeds\(([^)]*)\)/g)].map((m) => m[1].trim());
  // **呼び出しは 1 か所だけ**（増えたらこの test が落ちて、前提を測り直すことになる）
  assert.deepEqual(calls, ["m.name, m.kana"], "呼び出しは名簿の行に対する 1 か所だけ");
  // **`nameText`（PDF 側の氏名）を引数に渡している箇所が無い**
  assert.equal(/kanaNameRatioExceeds\([^)]*nameText/.test(src), false, "PDF 側の氏名は渡っていない");
});

/**
 * **青森 46 名では、かなを埋めても #632 が拾えるのは 183 通り中 2 通り（1.1%）だけである。**
 * **鳴る 2 通りはどちらも `今 博`（2 文字）の 1 文字欠落**——
 * **#632 の docblock が「短い氏名（2 文字前後）でしか拾えない」と書いているとおりで、
 * 青森で 2 文字の氏名は 46 名中 1 名しか居ない。**
 *
 * **ここは名簿（会派別ページ）の氏名と、個別ページから実測したかなで数えている。**
 */
test("#763 かなを埋めた場合の 1 文字欠落シミュレーション: 183 通り中 2 通りしか鳴らない", () => {
  // **46 名ぶんの実測かな**は本番データに入れない（下の doc と PR 本文に理由）ので、
  // ここでは**鳴る側の 1 名と、鳴らない側の代表**だけを実測値で固定する。
  const two = { name: "今 博", kana: "こん　ひろし" }; // 2 文字 / 6 拍
  assert.equal([...two.name.replace(/[\s　]/g, "")].length, 2, "青森で 2 文字の氏名はこの 1 名だけ");
  assert.equal(kanaNameRatioExceeds(two.name, two.kana), false, "壊れていなければ鳴らない（比 3.0）");
  assert.equal(kanaNameRatioExceeds("今", two.kana), true, "1 文字欠けたら鳴る（比 6.0）");
  assert.equal(kanaNameRatioExceeds("博", two.kana), true, "どちらが欠けても鳴る");
  // **3 文字以上では鳴らない**（青森は 46 名中 45 名が 3 文字以上）
  const three = { name: "川村 悟", kana: "かわむら　さとる" }; // 3 文字 / 7 拍
  assert.equal(kanaNameRatioExceeds("村悟", three.kana), false, "3 文字 → 2 文字でも鳴らない（比 3.5 ちょうどで、超えていない）");
  assert.equal(7 / 2, 3.5, "比はちょうど閾値。`>` なので鳴らない");
  const four = { name: "櫛\u{E0101}引 ユキ子", kana: "くしびき　ゆきこ" };
  assert.equal(kanaNameRatioExceeds("引ユキ子", four.kana), false, "4 文字 → 3 文字（比 1.75）でも鳴らない");
});

/**
 * # **機序 ② を実際に捕まえているのは `lossyNameMatches` である**（#750 が置いた守り）
 *
 * **#763 は「代わりの守りとして、名簿の氏名の文字数と PDF の氏名の文字数を突き合わせては」と
 * 提案している。** **それは既にあり、しかも文字数ではなく文字列そのものを比べている**
 * （`rollcalls.ts`: `nameKey(pdfName) !== nameKey(rosterName)` なら `lossy` に積む）。
 *
 * **文字数の比較より強い**——
 *   - **機序 ②（文字が落ちる）**: 文字数でも文字列でも捕まる
 *   - **機序 ④（別の字に化けて、名簿には寄った）**: **文字数は同じなので文字数比較は素通りするが、
 *     文字列比較は捕まる**
 * **よって、PO 案の「文字数の突き合わせ」を足すと、既にあるものの弱い部分集合を増やすことになる。**
 * **足さない。**
 */
test("#763 PO 案（文字数の突き合わせ）は lossyNameMatches の弱い部分集合である", () => {
  const rosterName = "櫛\u{E0101}引 ユキ子";
  // 機序 ②: `櫛` が落ちる。**文字数が違う**ので、文字数比較でも文字列比較でも捕まる
  const lost = "引 ユキ子";
  assert.notEqual([...localNameKey(lost)].length, [...localNameKey(rosterName)].length, "文字数が違う");
  assert.notEqual(localNameKey(lost), localNameKey(rosterName), "文字列も違う");
  // 機序 ④: 字が化けるが**文字数は同じ**。**文字数比較は素通りし、文字列比較だけが捕まえる**
  const swapped = "噰 引 ユキ子";
  assert.equal([...localNameKey(swapped)].length, [...localNameKey(rosterName)].length, "文字数は同じ（文字数比較は素通り）");
  assert.notEqual(localNameKey(swapped), localNameKey(rosterName), "文字列は違う（文字列比較は捕まえる）");
});

/**
 * **`kana` が空のままであることを、理由つきで固定する**（#763 の結論）。
 * **秋田（#759）も同じ理由で空である**ことを併せて記録する——
 * **#763 は「青森だけ」と書いているが、実測では `data/members/index.json` で
 * `kana` が空なのは青森 46 名と秋田 41 名の 2 議会である。**
 */
test("#763 青森の kana は空のまま（個別ページから取れるが、取らない）", () => {
  const r = roster();
  assert.deepEqual([...new Set(r.members.map((m) => m.kana))], [""], "全員空");
  // **空なら #632 は常に false**（「比較できない」であって「壊れている」ではない）
  for (const m of r.members) assert.equal(kanaNameRatioExceeds(m.name, m.kana), false);
});
