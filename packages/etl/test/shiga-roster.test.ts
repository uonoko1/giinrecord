import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";
import { parseRoster } from "../src/sources/local/shiga/roster.ts";
import { SHIGA_ASSEMBLY, resolveShigaUrl, warekiYear } from "../src/sources/local/shiga/site.ts";

/**
 * 滋賀県議会 議員名簿（Issue #741）。**このサイトは Shift_JIS** なので、
 * フィクスチャは生バイトのまま置き、読むときに復号する（衆議院の名簿と同じ形）。
 */
const roster = () => parseRoster(iconv.decode(readFileSync(fileURLToPath(new URL("fixtures/shiga/giinlist.html", import.meta.url))), "Shift_JIS"), { asOf: "2026-09-13" });

test("#741 parseRoster: 44 名・id は SrchID・会派の内訳が表決 PDF と一致する", () => {
  const r = roster();
  assert.equal(r.members.length, 44);
  assert.equal(r.asOf, "2026-09-13");
  const groups = new Map<string, number>();
  for (const m of r.members) groups.set(m.group, (groups.get(m.group) ?? 0) + 1);
  // **賛否 PDF（Kg907）の会派帯と人数は同じだが、`チームしが 県議団` の空白だけ違う。**
  // 名簿は `チームしが 県議団`（全角空白入り）、PDF の会派帯は空白を詰めた `チームしが県議団`。
  // **どちらも原文のまま残す**（寄せない）——会派名は表示のためのもので、突き合わせには使っていない
  // （議員は `SrchID` の id と氏名で突き合わせる）。**寄せると、どちらが原文か分からなくなる。**
  assert.deepEqual(Object.fromEntries([...groups].sort()), {
    "さざなみ倶楽部": 3, "チームしが 県議団": 9, "公明党滋賀県議団": 2, "日本共産党滋賀県議会議員団": 2,
    "滋賀維新の会": 3, "無所属": 4, "自由民主党滋賀県議会議員団": 21,
  });
  const tsuji = r.members.find((m) => m.name.startsWith("辻"));
  assert.ok(tsuji, "辻 正隆 が名簿に無い");
  // **id は氏名からではなくプロフィールページの番号から作る**（氏名が変わっても id は動かない）
  assert.equal(tsuji.id, "p_25_197");
  assert.equal(tsuji.assemblyId, SHIGA_ASSEMBLY.id);
  assert.equal(tsuji.kana, "つじ まさたか"); // 全角空白は半角 1 つに寄せる（cleanText。7 県と同じ）
  assert.equal(tsuji.profileUrl, "https://www.shigaken-gikai.jp/g07_giinlistS.asp?SrchID=197");
  assert.equal(tsuji.sourceUrl, "https://www.shigaken-gikai.jp/g07_giinlistP.asp");
  assert.equal(tsuji.current, true);
  // **名簿側の `辻` は壊れていない**（U+8FBB）。壊れているのは PDF の文字層のほう（#680）
  assert.equal([...tsuji.name][0].codePointAt(0)!.toString(16), "8fbb");
  // 全員に かな・会派・選挙区 がある（欠けたら例外にしているが、黙って空にならないことも見る）
  for (const m of r.members) {
    assert.notEqual(m.name, "", `${m.id}: 氏名が空`);
    assert.notEqual(m.kana, "", `${m.id}: かなが空`);
    assert.notEqual(m.group, "", `${m.id}: 会派が空`);
    assert.notEqual(m.district, "", `${m.id}: 選挙区が空`);
    assert.match(m.id, /^p_25_\d+$/);
  }
  // id が一意（写真の td のリンクを二重に数えていないこと）
  assert.equal(new Set(r.members.map((m) => m.id)).size, 44);
});

test("#741 parseRoster: asOf は ISO 日付でなければ例外（取得日で代用するのは「掲載日が無い」ときだけ）", () => {
  const html = iconv.decode(readFileSync(fileURLToPath(new URL("fixtures/shiga/giinlist.html", import.meta.url))), "Shift_JIS");
  assert.throws(() => parseRoster(html, { asOf: "2026/09/13" }), /asOf must be ISO date/);
  // **名簿ページに掲載日が 1 つも無いことを、フィクスチャそのもので確かめる**——
  // 「読めなかったから取得日にした」ではなく「無いから取得日にした」であることの根拠（#741）
  assert.equal(/(令和|平成)[0-9０-９元]+年[0-9０-９]+月[0-9０-９]+日現在/.test(html), false);
});

test("#741 parseRoster: 名簿が読めなければ例外（黙って 0 人にしない）", () => {
  assert.throws(() => parseRoster("<html><body><table></table></body></html>", { asOf: "2026-09-13" }), /no members found/);
});

test("#741 resolveShigaUrl: 県議会の公式ホスト以外は例外（取得先の許可リスト）", () => {
  const base = "https://www.shigaken-gikai.jp/g07_giinlistP.asp";
  assert.equal(resolveShigaUrl("g07_giinlistS.asp?SrchID=1", base), "https://www.shigaken-gikai.jp/g07_giinlistS.asp?SrchID=1");
  assert.equal(resolveShigaUrl("/voices/x.pdf#page=2", base), "https://www.shigaken-gikai.jp/voices/x.pdf");
  assert.throws(() => resolveShigaUrl("https://example.com/x", base), /not on www\.shigaken-gikai\.jp/);
  assert.throws(() => resolveShigaUrl("http://www.shigaken-gikai.jp/x", base), /not on www\.shigaken-gikai\.jp/);
});

test("#741 warekiYear: 令和・平成・元年（全角数字も）", () => {
  assert.equal(warekiYear("令和", "8"), 2026);
  assert.equal(warekiYear("令和", "元"), 2019);
  assert.equal(warekiYear("平成", "２４"), 2012);
  assert.throws(() => warekiYear("昭和", "63"), /unknown era/);
});
