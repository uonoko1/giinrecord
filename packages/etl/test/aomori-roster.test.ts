import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDistricts, parseLastUpdate, parseRoster } from "../src/sources/local/aomori/roster.ts";
import { AOMORI_ASSEMBLY, resolveAomoriUrl, warekiYear, isoDate } from "../src/sources/local/aomori/site.ts";
import { localNameKey } from "../src/sources/local/name-match.ts";

const fx = (name: string) => readFileSync(fileURLToPath(new URL(`fixtures/aomori/${name}`, import.meta.url)), "utf-8");
const roster = () => parseRoster(fx("giin-kaiha.html"), fx("giin-senkyoku.html"));

test("#750 parseRoster: 46 名・会派の内訳・as-of は名簿ページの更新日付", () => {
  const r = roster();
  assert.equal(r.members.length, 46, "会派別ページの 46 名");
  // **取得日ではなくページの掲載日**（`<p class="lastUpdate">更新日付：2026年5月25日</p>`）。
  // 取得日を使ってよいのは、ページに日付が「無い」ときだけ（滋賀・徳島）
  assert.equal(r.asOf, "2026-05-25");
  const groups = new Map<string, number>();
  for (const m of r.members) groups.set(m.group, (groups.get(m.group) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries([...groups].sort()), {
    "オール青森": 5, "公明党": 2, "参政党": 1, "日本共産党": 3,
    "無所属": 2, "立憲民主・憲法をいかす県民の会": 2, "立憲民主・無所属の会": 4, "自由民主党": 27,
  });
  assert.equal(r.members.every((m) => m.assemblyId === AOMORI_ASSEMBLY.id), true);
});

/**
 * **会派の見出しの人数は半角と全角が混ざる**（実測 2026-09-13: 6 会派が `27人`、
 * `立憲民主・憲法をいかす県民の会（２人）` と `無所属（２人）` は**全角**）。
 *
 * **実装中に半角しか見ない正規表現を書いて、この 2 会派の 4 人が丸ごと落ちた。**
 * **落ちても例外にならず「42 人の名簿」が黙って出る**——止めたのは下の人数の突き合わせである。
 */
test("#750 parseRoster: 会派の見出しの人数が全角でも読める（半角だけを見ると 4 人落ちる）", () => {
  const r = roster();
  assert.equal(r.members.filter((m) => m.group === "立憲民主・憲法をいかす県民の会").length, 2);
  assert.equal(r.members.filter((m) => m.group === "無所属").length, 2);
  assert.match(fx("giin-kaiha.html"), /立憲民主・憲法をいかす県民の会（２人）/, "フィクスチャに全角の見出しが実在する");
});

/**
 * **#529 が見つけた罠**: **同じ議員の氏名が 2 ページで違う。**
 *   会派別 `和田　寬司`（寬 U+5BEC）／ 選挙区別 `和田 寛司`（寛 U+5BDB）
 * **NFC でも NFKC でも一致せず、`localNameKey` も畳まない**（別字を畳むと別人の記録を作る。#569）。
 * **氏名で結合すると、この議員だけ選挙区が空になる。**
 * **プロフィールの URL は 46/46 で完全に一致する**ので、URL を鍵にする。
 */
test("#750 parseRoster: 2 ページの突き合わせは氏名ではなく URL（和田寬司/和田寛司）", () => {
  const r = roster();
  const wada = r.members.find((m) => m.id === "p_02_giin_wada-kanji");
  assert.ok(wada, "和田 が名簿に無い");
  assert.equal(wada.name, "和田 寬司", "会派別ページの表記（寬 U+5BEC）をそのまま持つ");
  assert.equal([...wada.name].map((c) => c.codePointAt(0)!.toString(16)).join(" "), "548c 7530 20 5bec 53f8");
  // **選挙区は選挙区別ページ（寛 U+5BDB）から引けている**＝氏名では結合していない
  assert.equal(wada.district, "三戸郡");
  // **2 つの表記は、どの正規化でも一致しない**（畳んではいけない字である、という事実を固定する）
  assert.notEqual("寬".normalize("NFKC"), "寛".normalize("NFKC"));
  assert.notEqual(localNameKey("和田寬司"), localNameKey("和田寛司"));
  // **選挙区が空の議員が 1 人も居ない**（URL の鍵が全員ぶん当たっている）
  assert.deepEqual(r.members.filter((m) => m.district === "").map((m) => m.name), []);
});

/**
 * **`kana` は空にする。** 青森は**一覧ページにふりがなが無い**——ふりがなは議員ごとの個別ページ
 * （`giin_kushibiki-yukiko.html` の `櫛󠄁引　ユキ子（くしびき　ゆきこ）`）にしかなく、
 * 46 名ぶん取ると毎月 46 リクエストが増える。
 * **ローマ字のファイル名からかなを起こさない**（推定である。#569）。
 * **空は「比較できない」であって「壊れている」ではない**ので `kanaNameRatioExceeds`（#632）は効かない。
 * **その代わりに「会派別と選挙区別で 46 人が一致する」という別の検算がある**（上の test）。
 */
test("#750 parseRoster: kana は全員空（一覧ページにふりがなが無い。ローマ字から起こさない）", () => {
  const r = roster();
  assert.deepEqual([...new Set(r.members.map((m) => m.kana))], [""]);
  assert.equal(fx("giin-kaiha.html").includes("くしびき"), false, "会派別ページにふりがなが 1 つも無い");
  assert.equal(fx("giin-senkyoku.html").includes("くしびき"), false, "選挙区別ページにふりがなが 1 つも無い");
});

/**
 * **`櫛引ユキ子` の名簿の表記は `櫛`+U+E0101（IVS）**（#749 が 56 本で測った機序 ①の相手側）。
 * **`localNameKey` は IVS を落とすので、PDF 側の裸の `櫛` とも寄る。**
 */
test("#750 parseRoster: 櫛引ユキ子 は名簿側も IVS 付き（突合キーは IVS を落とす）", () => {
  const r = roster();
  const k = r.members.find((m) => m.id === "p_02_giin_kushibiki-yukiko");
  assert.ok(k);
  assert.equal([...k.name].map((c) => c.codePointAt(0)!.toString(16)).join(" "), "6adb e0101 5f15 20 30e6 30ad 5b50");
  assert.equal(localNameKey(k.name), "櫛引ユキ子");
  assert.equal(localNameKey("櫛 引 ユキ子"), "櫛引ユキ子", "PDF 側の裸の 櫛 と同じ鍵になる");
});

/**
 * **人数の突き合わせが無ければ、読み落としは黙って通る**（かなの検算（#632）が使えないので、
 * ここが青森の唯一の「名簿が痩せたら落ちる」守りである）。
 */
test("#750 parseRoster: 会派の見出しの人数と読めた人数が合わなければ例外", () => {
  // 見出しの人数だけを 1 増やす（＝読み落としがある状態と同じ）。
  // **`replaceAll` にする**——`自由民主党（27人）` は `og:description` の meta にも出るので、
  // 先頭 1 件だけ置き換えると h2 が変わらず、この test が空回りする（実際にそうなった）
  const broken = fx("giin-kaiha.html").replaceAll("自由民主党（27人）", "自由民主党（28人）");
  assert.throws(() => parseRoster(broken, fx("giin-senkyoku.html")), /自由民主党: 見出しは 28 人だが 27 人しか読めない/);
});

test("#750 parseRoster: 選挙区別ページに居ない議員がいたら例外（黙って選挙区を空にしない）", () => {
  const broken = fx("giin-senkyoku.html").replace('<a href="giin_tanaka-junzo.html">田中 順造</a>', "田中 順造");
  assert.throws(() => parseRoster(fx("giin-kaiha.html"), broken), /選挙区別ページに .*giin_tanaka-junzo\.html が無い/);
});

test("#750 parseDistricts: 選挙区の丸数字は名前ではないので落とす・1 つの td に複数の議員", () => {
  const d = parseDistricts(fx("giin-senkyoku.html"), "https://www.pref.aomori.lg.jp/soshiki/gikai/giin-senkyoku.html");
  assert.equal(d.size, 46);
  assert.equal(d.get("https://www.pref.aomori.lg.jp/soshiki/gikai/giin_fukushi-naoharu.html"), "東津軽郡", "（1）東津軽郡 の丸数字を落とす");
  // 青森市の td には 10 人が `、` で並ぶ。**全員に同じ選挙区が付く**
  assert.equal([...d.values()].filter((v) => v === "青森市").length, 10);
  // **href の書き方は 3 通り揺れる**（`giin_*.html` / `*.html` / `/soshiki/gikai/giin_*.html`）
  assert.equal(d.get("https://www.pref.aomori.lg.jp/soshiki/gikai/yamaya-kiyofumi.html"), "青森市", "giin_ が無い href");
  assert.equal(d.get("https://www.pref.aomori.lg.jp/soshiki/gikai/giin_kitamuki-youki.html"), "上北郡", "絶対パスの href");
});

test("#750 parseLastUpdate: 更新日付が無ければ例外（取得日で代用しない）", () => {
  assert.equal(parseLastUpdate(fx("giin-kaiha.html"), "x"), "2026-05-25");
  assert.throws(() => parseLastUpdate("<html><body></body></html>", "x"), /更新日付が読めない/);
});

test("#750 resolveAomoriUrl: 別ホストは例外（取得先の許可リスト）", () => {
  const base = "https://www.pref.aomori.lg.jp/soshiki/gikai/giin-kaiha.html";
  assert.equal(resolveAomoriUrl("giin_x.html", base), "https://www.pref.aomori.lg.jp/soshiki/gikai/giin_x.html");
  assert.equal(resolveAomoriUrl("/a/b.html#c", base), "https://www.pref.aomori.lg.jp/a/b.html");
  assert.throws(() => resolveAomoriUrl("https://example.com/x", base), /not on www\.pref\.aomori\.lg\.jp/);
  assert.throws(() => resolveAomoriUrl("http://www.pref.aomori.lg.jp/x", base), /not on www\.pref\.aomori\.lg\.jp/);
});

test("#750 warekiYear / isoDate", () => {
  assert.equal(warekiYear("令和", "8"), 2026);
  assert.equal(warekiYear("令和", "元"), 2019);
  assert.equal(warekiYear("平成", "25"), 2013);
  assert.equal(warekiYear("平成", "２５"), 2013, "全角も読む");
  assert.throws(() => warekiYear("大正", "3"), /unknown era/);
  assert.equal(isoDate(2026, 6, 29), "2026-06-29");
  assert.throws(() => isoDate(2026, 13, 1), /date out of range/);
});
