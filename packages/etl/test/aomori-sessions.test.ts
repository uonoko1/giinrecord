import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FIRST_PERSONAL_ROUND, parseIndex } from "../src/sources/local/aomori/sessions.ts";
import { AOMORI_INDEX_URL } from "../src/sources/local/aomori/site.ts";

const fx = (name: string) => readFileSync(fileURLToPath(new URL(`fixtures/aomori/${name}`, import.meta.url)), "utf-8");
const index = () => parseIndex(fx("katsudo-shinsakekka.html"), AOMORI_INDEX_URL);

/**
 * **#743 が 56 本を取得した**（2026-09-13、`pdf-fetch-log.json` に 56 行）。
 * **ここが 56 でなくなったら、拾い方が変わっている。**
 */
test("#750 parseIndex: 個人別の会期 56・PDF 56 本・新しい順", () => {
  const s = index();
  assert.equal(s.length, 56, "個人別の範囲（第275回以降）の会期は 56（#743 が取得した本数）");
  assert.equal(s.reduce((n, x) => n + x.pdfUrls.length, 0), 56, "1 会期 1 本");
  assert.equal(s[0].sessionId, "2026-06");
  assert.equal(s[0].sessionLabel, "令和8年6月第326回定例会");
  assert.equal(s[0].round, 326);
  assert.equal(s[s.length - 1].sessionId, "2013-09");
  assert.equal(s[s.length - 1].round, FIRST_PERSONAL_ROUND);
  // 新しい順（index の並び順のまま）
  const ym = s.map((x) => x.year * 100 + x.month);
  assert.deepEqual(ym, [...ym].sort((a, b) => b - a), "index の並びが新しい順である");
  assert.equal(new Set(s.map((x) => x.sessionId)).size, 56, "sessionId が一意");
});

/**
 * **第274回より前は会派別で、個人票ではない**（index の注記
 * `※平成25年9月第275回定例会から、議決結果は議員ごとの賛否状況を掲載しています。`。
 * #529 が第274回・第275回の両方を開いて確かめた）。
 * **個人別でない会期を個人票として読むと、全員ぶんの記録が嘘になる。**
 */
test("#750 parseIndex: 第275回より前は返さない（会派別を個人票にしない）", () => {
  const s = index();
  assert.deepEqual(s.filter((x) => x.kind.startsWith("定例") && x.round < FIRST_PERSONAL_ROUND), []);
  // **index には第258回まで載っている**（＝除いた結果であって、元から無いのではない）
  assert.match(fx("katsudo-shinsakekka.html"), /第274回定例会/, "第274回の見出しが index に実在する");
  assert.match(fx("katsudo-shinsakekka.html"), /平成25年9月第275回定例会から/, "注記が index に実在する");
});

/**
 * **この守りは、いまの index では 1 度も走らない**（実測 2026-09-13）。
 *
 * **第274回より前のリンク文言は `知事提出議案` `議員提出議案` `請願・陳情` で、
 * `議決結果` を含まない。** だから**回次で切る行を消しても、返る会期は 56 のまま**である
 * （変異を当てて確かめた。**56 → 56、1 会期も増えない**）。
 *
 * **それでも残す**——**議会が古い会期のリンク文言を「議決結果」に書き換えた瞬間に、
 * 会派別の PDF が個人票として読まれる**（`votes-pdf.ts` は「記号が 10 個以上並ぶ帯」を
 * 行と見るので、会派別の本文 `〔賛成：自民、民主…〕` に当たると何が起こるか分からない）。
 * **効いていない守りを、効いていないと分かる形で残す**（滋賀 #741 の変異 3 と同じ判断）。
 *
 * **走ることは、作った index で確かめる**（下）。
 */
test("#750 第275回より前を除く行は、いまの index では走らない（が、走ると効く）", () => {
  // **いまの index では走らない**ことの証拠: 第274回の文言に `議決結果` が無い
  const html = fx("katsudo-shinsakekka.html");
  const around274 = html.slice(html.indexOf("第274回定例会"), html.indexOf("第274回定例会") + 400);
  assert.equal(around274.includes("議決結果"), false, "第274回のリンク文言に `議決結果` が無い（＝文言だけで落ちている）");
  // **走らせれば効く**: 文言が `議決結果` の第274回を作ると、除かれる
  const made = `<html><body>
    <h3>平成25年6月第274回定例会</h3><div class="textleft"><a href="files/x274.pdf">知事提出議案議決結果</a></div>
    <h3>平成25年9月第275回定例会</h3><div class="textleft"><a href="files/x275.pdf">知事提出議案議決結果</a></div>
    <h3>平成25年6月第92回臨時会</h3><div class="textleft"><a href="files/x92.pdf">知事提出議案議決結果</a></div>
    <h3>平成25年10月第93回臨時会</h3><div class="textleft"><a href="files/x93.pdf">知事提出議案議決結果</a></div>
  </body></html>`;
  const got = parseIndex(made, AOMORI_INDEX_URL);
  assert.deepEqual(got.map((x) => x.round), [275, 93], "**第274回（回次）と第92回臨時会（年月）の両方が落ちる**");
});

/**
 * **リンクは文言で選ぶ。ファイル名では選べない**（#529 が 37 通りの綴りを数え、#743 が
 * `sanpi`/`sannpi` を名前に持つのは 41 本だけで残り 15 本は `giketsukekka` 系だと確かめた）。
 */
test("#750 parseIndex: ファイル名の綴りが揺れても 56 本すべて拾う", () => {
  const files = index().flatMap((x) => x.pdfUrls).map((u) => u.split("/").pop()!);
  for (const f of [
    "326teirei_sanpi.pdf",          // teirei_sanpi 型
    "307teirei_sanpi_2.pdf",        // 第307回だけ _2 が付く
    "96rinji_sanpi.pdf",            // 臨時会
    "297_sanpi.pdf",                // _sanpi 型
    "289_sannpi.pdf",               // **綴りが sannpi**
    "giketukekka_288.pdf",          // **s 抜け**
    "giketsukekka_2809_287.pdf",    // 年月が入る
    "275_25.09giketsukekka.pdf",    // 区切りが揺れる
    "270515rinji_giketsukekka.pdf", // 臨時会 + giketsukekka
  ]) assert.ok(files.includes(f), `${f} を拾っていない`);
  assert.equal(new Set(files).size, 56, "重複なく 56 本");
});

/**
 * **「議員提出議案の内容」は議決結果ではない**（同じ `<div>` に並ぶ）。
 * **末尾に `[496KB]` `[PDF.94KB]` が付く会期と付かない会期がある**ので「で終わる」で見ない。
 */
test("#750 parseIndex: 同じ div の「議員提出議案の内容」を拾わない", () => {
  const files = index().flatMap((x) => x.pdfUrls).map((u) => u.split("/").pop()!);
  assert.equal(files.includes("326_giinhatugian.pdf"), false, "議員提出議案の内容 を拾っている");
  assert.equal(files.includes("325_hatsugian.pdf"), false);
  assert.match(fx("katsudo-shinsakekka.html"), /326_giinhatugian\.pdf/, "そのリンクが index に実在する（＝除いた結果である）");
  // 文言のバリエーションが実在すること（「議決結果」で終わるとは限らない）
  assert.match(fx("katsudo-shinsakekka.html"), /知事提出議案・議員提出議案議決結果<img[^>]*><span[^>]*>\[496KB\]/);
  assert.match(fx("katsudo-shinsakekka.html"), /\[PDF\.94KB\]/, "[PDF.94KB] の形も実在する");
});

/** 臨時会は `-rinji`（定例会と回次の系列が別なので、年月で切る） */
test("#750 parseIndex: 臨時会は -rinji・回次は別系列", () => {
  const s = index();
  const rinji = s.filter((x) => x.sessionId.endsWith("-rinji"));
  assert.deepEqual(rinji.map((x) => `${x.sessionId}/${x.round}`), ["2023-05-rinji/96", "2020-05-rinji/95", "2019-05-rinji/94", "2015-05-rinji/93"]);
  assert.equal(rinji.every((x) => x.kind === "臨時会"), true);
  // **臨時会の回次 93〜96 は定例会の 275〜326 より小さい**——回次で切ると 4 本とも落ちる
  assert.equal(rinji.every((x) => x.round < FIRST_PERSONAL_ROUND), true);
});

/** **`class` の綴りが `clsss="subt01"` と壊れている**ので、class では選ばずタグ名で選ぶ */
test("#750 parseIndex: h3 の class の綴りが壊れていても読める（clsss）", () => {
  assert.match(fx("katsudo-shinsakekka.html"), /<h3 clsss="subt01">/, "壊れた class が実在する");
  assert.equal(index().length, 56);
});

test("#750 parseIndex: 議決結果 PDF が 1 本も無ければ例外", () => {
  assert.throws(() => parseIndex("<html><body><h3>令和8年6月第326回定例会</h3><div class=\"textleft\"></div></body></html>", AOMORI_INDEX_URL), /個人別の議決結果 PDF が 1 本も無い/);
});
