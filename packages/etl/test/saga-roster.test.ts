import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseAsOf, parseRoster } from "../src/sources/local/saga/roster.ts";
import { SAGA_ROSTER_URL } from "../src/sources/local/saga/site.ts";
import { kanaNameRatioExceeds } from "../src/local-assemblies.ts";

/**
 * 佐賀県議会の議員一覧（Issue #768）。フィクスチャは本物の HTML の本文だけ
 * （`packages/etl/test/fixtures/saga/roster.html`。2026-09-13 取得、45,179 B のうち本文 21,446 B）。
 */
const html = (): string => readFileSync(new URL("./fixtures/saga/roster.html", import.meta.url), "utf-8");

test("#768 名簿: 37 人・ふりがな・会派・選挙区がそろう", () => {
  const r = parseRoster(html());
  assert.equal(r.members.length, 37, "議員一覧は 37 人（実測 2026-09-13）");
  assert.equal(r.asOf, "2025-04-01");
  assert.equal(r.termText, "（任期）令和5年4月30日～令和9年4月29日");
  const rusu = r.members.find((m) => m.name === "留守 茂幸");
  assert.deepEqual(
    { id: rusu?.id, kana: rusu?.kana, group: rusu?.group, district: rusu?.district, profileUrl: rusu?.profileUrl },
    { id: "p_41_280907", kana: "るす しげゆき", group: "自由民主党", district: "佐賀市", profileUrl: SAGA_ROSTER_URL },
  );
  // **`id` は写真の添付ファイル番号から作る**（氏名からは作らない。`LOCAL_MEMBER_ID` は ASCII しか許さず、
  // **この議会は氏名が一次資料どうしで食い違う**ので氏名を id にすると綴りが変わった日に別人の id ができる）
  assert.ok(r.members.every((m) => /^p_41_\d+$/.test(m.id)), "id は p_41_{写真の番号}");
  assert.equal(new Set(r.members.map((m) => m.id)).size, 37, "37 人すべて違う id");
  assert.ok(r.members.every((m) => m.assemblyId === "pref-41"));
});

/**
 * **`kana` が 1 人でも空になっていないこと**（この議会は #632 の検算が効く議会である）。
 *
 * **`下田 寛` のふりがなだけ `<div>` に入っている**（ほかの 36 人は `<p>`。実測 2026-09-13）。
 * **`<p>` だけを見る実装では、この 1 人の `kana` が空になる。**
 * **空は「壊れている」ではなく「比較できない」なので `kanaNameRatioExceeds` は素通りし、
 * その議員については #632 の守りが消える**——**緑のまま守りが 1 人ぶん抜ける形。**
 */
test("#768 名簿: 37 人全員にふりがながある（下田 寛 だけ <div> に入っている）", () => {
  const r = parseRoster(html());
  const noKana = r.members.filter((m) => m.kana === "");
  assert.deepEqual(noKana.map((m) => m.name), [], "ふりがなが空の議員は居ない");
  assert.equal(r.members.find((m) => m.name === "下田 寛")?.kana, "しもだ ひろし");
});

/** **#632 の検算（かな長 / 氏名長 <= 3.5）が 37 人すべてで通る。** 実測の最大は 2.250。 */
test("#768 名簿: かな長 / 氏名長 の比が 37 人すべて閾値内（#632 の検算がこの議会では効く）", () => {
  const r = parseRoster(html());
  const over = r.members.filter((m) => kanaNameRatioExceeds(m.name, m.kana));
  assert.deepEqual(over.map((m) => m.name), []);
  const max = Math.max(...r.members.map((m) => [...m.kana.replace(/\s/g, "")].length / [...m.name.replace(/\s/g, "")].length));
  assert.ok(max < 2.3 && max > 2.2, `実測の最大は 2.250（${max}）`);
});

/**
 * **会派名が 2 つの `<p>` にまたがる 8 人**（`(自由民主党` + `ネクストさが)`）。
 * **`<p>` ごとに読むと `自由民主党` になり、別の会派と混ざる。**
 */
test("#768 名簿: 会派名が 2 つの <p> にまたがっても 自由民主党ネクストさが になる", () => {
  const r = parseRoster(html());
  const nekusuto = r.members.filter((m) => m.group === "自由民主党ネクストさが");
  assert.equal(nekusuto.length, 11, "実測 2026-09-13: 11 人");
  assert.equal(r.members.find((m) => m.name === "一ノ瀬 裕子")?.group, "自由民主党ネクストさが");
  // **`自由民主党` と別の会派であること**（畳んでいない）
  assert.ok(r.members.some((m) => m.group === "自由民主党"), "自由民主党 も別に存在する");
  assert.deepEqual(
    [...new Set(r.members.map((m) => m.group))].sort(),
    ["公明党", "日本共産党", "県民ネットワーク", "自由民主党", "自由民主党ネクストさが"].sort(),
  );
});

/** **選挙区の定数と読めた人数が合わなければ例外**（読み落としで黙って人が減らない）。 */
test("#768 名簿: 選挙区の定数より人が少なければ例外（黙って減らさない）", () => {
  const h = html();
  // 佐賀市の議員 1 人の `<big>` を空にする（読めなくする）
  const broken = h.replace("<big>留守 茂幸<br></big>", "<big></big>");
  assert.notEqual(broken, h, "変異が当たっていること");
  assert.throws(() => parseRoster(broken), /選挙区 佐賀市 は定数 11 人だが 10 人しか読めない/);
});

/** **`<img alt>` は独立した 2 つ目の綴り**（#765 が読んだ側）。食い違えば例外。 */
/**
 * **`<img alt>` は独立した 2 つ目の綴り**（#765 が読んだ側）。
 * **`<big>` の氏名と食い違えば、写真の番号が引けず `id` が作れない**ので例外。
 * **氏名から id を作って代用しない**——それをすると、綴りが変わった日に黙って別人の id ができる。
 */
test("#768 名簿: 写真の alt と <big> の氏名が食い違えば例外（id を作れない）", () => {
  const h = html();
  const broken = h.replace('alt="留守茂幸議員"', 'alt="留守茂行議員"');
  assert.notEqual(broken, h, "変異が当たっていること");
  assert.throws(() => parseRoster(broken), /留守 茂幸 の写真が見つからない/);
});

/** **写真の番号が 2 人で同じなら例外**（黙って 1 人に畳まない）。 */
test("#768 名簿: 写真の番号が重なれば例外（別人を同じ id にしない）", () => {
  const h = html();
  const broken = h.replace("3_66725_280908_up_okvpz1ph.png", "3_66725_280907_up_okvpz1ph.png");
  assert.notEqual(broken, h, "変異が当たっていること");
  assert.throws(() => parseRoster(broken), /同じ写真番号の議員が 2 人居る/);
});

/** **基準日と最終更新日は独立した 2 つの日付**。食い違えば例外（どちらが正しいかを決めない）。 */
test("#768 名簿: 基準日と <time datetime> が食い違えば例外", () => {
  const h = html();
  const broken = h.replace('<time datetime="2025-04-01', '<time datetime="2025-05-01');
  assert.notEqual(broken, h, "変異が当たっていること");
  assert.throws(() => parseAsOf(broken), /基準日 2025-04-01 と最終更新日 2025-05-01 が食い違う/);
});

/**
 * **`猪村 利恵子`（利 U+5229）と `桃崎 祐介`（祐 U+7950）が名簿の綴りである。**
 * **PDF 側に出る `猪村 理恵子`（理 U+7406）・`桃崎 裕介`（裕 U+88D5）とは別の漢字**で、
 * **どちらが正しいかは決めない**（#711。`saga-rollcalls.test.ts` が落ちる側を固定する）。
 */
test("#768 名簿: 猪村利恵子 は 利(U+5229)、桃崎祐介 は 祐(U+7950)", () => {
  const r = parseRoster(html());
  const imura = r.members.find((m) => m.name.startsWith("猪村"));
  const momozaki = r.members.find((m) => m.name.startsWith("桃崎"));
  assert.equal(imura?.name, "猪村 利恵子");
  assert.equal(imura?.name.codePointAt(3), 0x5229, "利 は U+5229");
  assert.equal(momozaki?.name, "桃崎 祐介");
  assert.equal(momozaki?.name.codePointAt(3), 0x7950, "祐 は U+7950");
});
