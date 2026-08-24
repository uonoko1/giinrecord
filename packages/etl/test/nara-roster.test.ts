import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRoster } from "../src/sources/local/nara/roster.ts";
import { resolveNaraUrl } from "../src/sources/local/nara/site.ts";

// 奈良県議会 議員名簿（五十音順、/n161/52534.html。2026-08-24 取得）。1 ページに全議員（table.datatable）。
// 行 = [行見出し（あ行…）] 議員名（プロフィールへのリンク）・ふりがな・選挙区・当選回数・所属会派。
// as-of は表の直後の「（令和8年4月24日現在）」。id はプロフィールページ /n161/{番号}.html の番号（氏名からは作らない）。
// フィクスチャ内の「手話で電話」（denwa-relay-service.jp）ウィジェットの公開 token は
// REDACTED に置換済み（#216）。全ページ共通のページ装飾でパース対象ではないため、解析結果には影響しない。
const html = readFileSync(new URL("./fixtures/nara/52534.html", import.meta.url), "utf8");
const roster = parseRoster(html);

test("parseRoster: 40 名。id・氏名・ふりがな・選挙区・会派・プロフィール URL・as-of を名簿の原文から取る", () => {
  assert.equal(roster.members.length, 40);
  assert.equal(roster.asOf, "2026-04-24");
  const ashitaka = roster.members[0];
  assert.equal(ashitaka.id, "p_29_52536");
  assert.equal(ashitaka.assemblyId, "pref-29");
  assert.equal(ashitaka.name, "芦高 清友");
  assert.equal(ashitaka.kana, "あしたか きよとも");
  assert.equal(ashitaka.district, "香芝市");
  assert.equal(ashitaka.group, "自由民主党・無所属の会");
  assert.equal(ashitaka.profileUrl, "https://www.pref.nara.lg.jp/n161/52536.html");
  assert.equal(ashitaka.current, true);
  assert.equal(ashitaka.asOf, "2026-04-24");
  assert.equal(ashitaka.sourceUrl, "https://www.pref.nara.lg.jp/n161/52534.html");
  assert.deepEqual(ashitaka.counts, { rollcalls: 0 });
});

test("parseRoster: 改行で割られた選挙区（「奈良市・」「山辺郡」）は詰める。&nbsp; の氏名（乾 浩之）も半角空白 1 つに", () => {
  const ikeda = roster.members.find((m) => m.id === "p_29_52545")!;
  assert.equal(ikeda.name, "池田 慎久");
  assert.equal(ikeda.district, "奈良市・山辺郡");
  const inui = roster.members.find((m) => m.name === "乾 浩之")!;
  assert.equal(inui.district, "北葛城郡");
  const yamamura = roster.members.find((m) => m.id === "p_29_52581")!;
  assert.equal(yamamura.name, "山村 幸穂");
  assert.equal(yamamura.group, "無所属（日本共産党）");
  // id は一意
  assert.equal(new Set(roster.members.map((m) => m.id)).size, 40);
});

test("parseRoster: 掲載日（（令和N年M月D日現在））が無ければ例外（取得日で代用しない）。表の見出しが変わっていても例外", () => {
  assert.throws(() => parseRoster(html.replace("（令和8年4月24日現在）", "")), /現在.*not found/);
  assert.throws(() => parseRoster(html.replace(">ふりがな<", ">読み<")), /header/);
  assert.throws(() => parseRoster(html.replace(/議員名簿（五十音順）（任期/g, "議員のリスト（任期")), /table not found/);
});

test("resolveNaraUrl: 県の公式ホスト以外は例外（取得先の許可リスト）", () => {
  assert.equal(resolveNaraUrl("/n161/52536.html", "https://www.pref.nara.lg.jp/n161/52534.html"), "https://www.pref.nara.lg.jp/n161/52536.html");
  assert.throws(() => resolveNaraUrl("https://example.com/x.html", "https://www.pref.nara.lg.jp/"), /not on www\.pref\.nara\.lg\.jp/);
  assert.throws(() => resolveNaraUrl("http://www.pref.nara.lg.jp/x.html", "https://www.pref.nara.lg.jp/"), /not on/);
});
