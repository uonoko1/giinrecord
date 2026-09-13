import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parsePublishedAt, parseRoster, parseSection } from "../src/sources/local/akita/roster.ts";
import { resolveAkitaUrl, warekiYear, isoDate, cleanText, AKITA_ASSEMBLY, AKITA_HOST } from "../src/sources/local/akita/site.ts";

const html = (name: string) => readFileSync(fileURLToPath(new URL(`fixtures/akita/${name}.html`, import.meta.url)), "utf-8");

test("#759 parseRoster: 議員紹介の 3 つの一覧を突き合わせて 41 人", () => {
  const r = parseRoster(html("giin"));
  // **定数 43 に対して 41 人**（欠員 2）。**定数を議員数として使わない**（#617 の罠）
  assert.equal(r.members.length, 41, "議員の数");
  assert.equal(r.asOf, "2026-07-24", "名簿の as-of（**取得日ではなくページの公開日**）");
  assert.equal(new Set(r.members.map((m) => m.id)).size, 41, "id が重複していない");
  assert.ok(r.members.every((m) => m.id.startsWith("p_05_")), "id の接頭辞");
  assert.ok(r.members.every((m) => m.assemblyId === "pref-05"), "assemblyId");
  // **氏名・会派・選挙区が全員ぶん埋まっている**（空は「読み落とし」の徴候）
  assert.deepEqual(r.members.filter((m) => m.name === ""), [], "氏名が空の議員");
  assert.deepEqual(r.members.filter((m) => m.group === ""), [], "会派が空の議員");
  assert.deepEqual(r.members.filter((m) => m.district === ""), [], "選挙区が空の議員");
  // **`kana` は全員空**（一覧ページにふりがなが無い。ローマ字からも起こさない。#569）。
  // **`kanaNameRatioExceeds` の検算（#632）はこの議会では効かない**という事実をここで固定する
  assert.deepEqual(r.members.filter((m) => m.kana !== ""), [], "かなは全員空（推定しない）");
  // 会派の内訳（**見出しの人数と合っていることは `parseRoster` が例外で守る**）
  const byGroup = new Map<string, number>();
  for (const m of r.members) byGroup.set(m.group, (byGroup.get(m.group) ?? 0) + 1);
  assert.deepEqual(
    Object.fromEntries([...byGroup].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))),
    { "自由民主党": 27, "みらい": 5, "立憲民主党": 4, "きらり": 1, "社会民主党": 1, "公明党": 1, "日本共産党": 1, "ひらく会": 1 },
    "会派の内訳",
  );
});

/**
 * ## **`川邉隼之介` は 3 つの `<a>` に割れている**（秋田固有の罠。実測 2026-09-13）
 *
 * **会派別一覧の 1 つの `<td>` の中が原文でこうなっている:**
 * ```html
 * <a href="http://…/profile/2025040700015/">川邉</a>
 * <a href="https://…/profile/2025040700015/">隼</a>
 * <a href="http://…/profile/2025040700015/">之介</a>
 * ```
 * **`<a>` ごとに議員を作ると、この 1 人が `川邉` `隼` `之介` の 3 人になる。**
 * **しかも 3 つのうち 2 つが `http://`、1 つが `https://`。**
 * **`<td>` 1 つ ＝ 議員 1 人として読み、`<a>` のテキストを繋ぐことで解ける。**
 *
 * ## **割れているのは会派別一覧だけである**（**変異を当てて気づいた。2026-09-13**）
 * **五十音別一覧（名簿の実体）では `<a>` が 1 つ**（`<a href="…/profile/2025040700015/">川邉隼之介</a>`）。
 * **だから「`<a>` のテキストを繋ぐ」をやめる変異を当てても、`members` の氏名は変わらない**——
 * **落ちるのは `parseSection` の単体テストだけだった**（実測: 9 件中 1 件）。
 * **`members` が変わらないのは、会派別一覧が「会派を引くための表」でしかなく、
 * 氏名は五十音別から取っているためである。**
 *
 * **それでも会派別一覧の氏名が壊れると害がある**——
 * **会派は `profileUrl` で引いているので会派は正しく付くが、
 * `parseRoster` の「3 つの一覧に同じ 41 人が居る」という検算は `profileUrl` で見るので、
 * 氏名が壊れても通ってしまう。**
 * **だから、このテストは会派別一覧そのものを読んで氏名を確かめる。**
 */
test("#759 `川邉隼之介` が 3 つの `<a>` に割れていても 1 人になる", () => {
  const r = parseRoster(html("giin"));
  // **会派別一覧を直接読む**（ここが割れている側。五十音別は 1 つの `<a>` なので壊れても気づけない）
  const body = html("giin");
  const kaiha = body.slice(body.indexOf('id="kaiha"'), body.indexOf('id="giin"'));
  const inKaiha = parseSection(kaiha, "h4").filter((x) => x.profileUrl.includes("2025040700015"));
  assert.equal(inKaiha.length, 1, "会派別一覧でも 1 人（3 つの `<a>` を 3 人にしない）");
  assert.equal(inKaiha[0].name, "川邉隼之介", "会派別一覧でも氏名が繋がっている");
  // **会派別一覧の `<a>` が本当に 3 つに割れている**（フィクスチャがこの罠を持っていることの確認）
  const anchors = [...kaiha.matchAll(/<a[^>]*href="[^"]*2025040700015[^"]*"[^>]*>([^<]*)<\/a>/g)].map((m) => m[1]);
  assert.deepEqual(anchors, ["川邉", "隼", "之介"], "会派別一覧の `<a>` は 3 つ");
  // **2 つが `http://`、1 つが `https://`**（URL を鍵にするなら寄せないと 2 つに見える）
  const schemes = [...kaiha.matchAll(/<a[^>]*href="(https?):\/\/[^"]*2025040700015[^"]*"/g)].map((m) => m[1]);
  assert.deepEqual(schemes, ["http", "https", "http"], "スキームが混在している");
  const kawabe = r.members.filter((m) => m.name.includes("川邉"));
  assert.equal(kawabe.length, 1, `川邉 で始まる議員は 1 人（実際: ${JSON.stringify(kawabe.map((m) => m.name))}）`);
  assert.equal(kawabe[0].name, "川邉隼之介", "氏名が繋がっている");
  assert.equal(kawabe[0].id, "p_05_2025040700015", "id はプロフィールの連番から");
  assert.equal(kawabe[0].profileUrl, "https://pref.akita.gsl-service.net/profile/2025040700015/", "URL は https に寄せる");
  // **`隼` や `之介` だけの議員が居ない**（割れたまま読んでいない）
  assert.deepEqual(r.members.filter((m) => m.name === "隼" || m.name === "之介"), [], "断片の議員が居ない");
});

/**
 * ## **`高橋` 姓が字形違いで 3 人いる**（#615 が実測）
 * `高橋 健`（U+9AD8 通常の高）／ `髙橋 豪`・`髙橋武浩`（U+9AD9 はしごだか）。
 * **`localNameKey` は `髙` と `高` を寄せる**ので、**3 人が同じ姓の鍵になる。**
 * **名で分かれる**（`健` / `豪` / `武浩`）——**同姓同名が出たら `matchBySubsequence` が
 * 1 人に決められず `unmatched.json` に落ちる**（**別人に寄せない**。#569）。
 */
test("#759 `高橋` 3 人が字形の違いを保ったまま名簿に入っている", () => {
  const r = parseRoster(html("giin"));
  const takahashi = r.members.filter((m) => /^[高髙]橋/.test(m.name)).map((m) => m.name).sort();
  assert.deepEqual(takahashi, ["高橋 健", "髙橋 豪", "髙橋武浩"], "3 人の氏名（**字形を寄せていない**）");
  // **`高` U+9AD8 と `髙` U+9AD9 が両方ある**（片方に寄せていないことの証拠）
  assert.ok(takahashi.some((n) => n.startsWith("高")), "U+9AD8（通常の高）の議員が居る");
  assert.ok(takahashi.some((n) => n.startsWith("髙")), "U+9AD9（はしごだか）の議員が居る");
});

/**
 * **3 つの一覧に同じ議員が居ることが検算になっている**（独立した一覧の突き合わせ）。
 * **`kana` が空で `kanaNameRatioExceeds`（#632）が効かないぶん、ここで守る。**
 */
test("#759 否定的対照: 選挙区別・会派別から議員を 1 人抜くと例外になる", () => {
  const src = html("giin");
  // **会派別一覧から `石田　寛` の 1 行を消す**（五十音別には残る）
  const broken = src.replace(/<td[^>]*><a href="\/profile\/2018052300021\/">石田[^<]*<\/a><\/td>\s*(?=[\s\S]{0,4000}id="giin")/, "<td></td>");
  assert.notEqual(broken, src, "フィクスチャを実際に壊せている（置換が空振りしていない）");
  assert.throws(() => parseRoster(broken), /会派別一覧に|数が合わない|人しか読めない/, "1 人欠けたら例外");
});

test("#759 否定的対照: 公開日が無ければ例外（取得日で代用しない）", () => {
  const src = html("giin");
  const broken = src.replace(/<p class="publishedAt">[^<]*<\/p>/, "");
  assert.notEqual(broken, src, "フィクスチャを実際に壊せている");
  assert.throws(() => parsePublishedAt(broken), /公開日が読めない/, "公開日が無ければ例外");
});

test("#759 parseSection: `<td>` 1 つ ＝ 議員 1 人", () => {
  const td = (href: string, text: string) => `<td><a href="${href}">${text}</a></td>`;
  const rows = parseSection(
    `<h4>自由民主党（2人）</h4><table><tbody><tr>${td("/profile/1111111111111/", "山田太郎")}` +
    `<td><a href="http://${AKITA_HOST}/profile/2222222222222/">川邉</a>` +
    `<a href="https://${AKITA_HOST}/profile/2222222222222/">隼</a>` +
    `<a href="http://${AKITA_HOST}/profile/2222222222222/">之介</a></td></tr></tbody></table>`,
    "h4",
  );
  assert.equal(rows.length, 2, "2 人（3 つの `<a>` を 3 人にしない）");
  assert.equal(rows[1].name, "川邉隼之介", "繋がる");
  assert.equal(rows[1].profileUrl, `https://${AKITA_HOST}/profile/2222222222222/`, "https に寄る");
  assert.equal(rows[0].heading, "自由民主党（2人）", "見出し");
  // **1 つの `<td>` に 2 人ぶんのリンクがあれば例外**（黙って 1 人にしない）
  assert.throws(
    () => parseSection(`<table><tbody><tr><td><a href="/profile/1111111111111/">甲</a><a href="/profile/3333333333333/">乙</a></td></tr></tbody></table>`, "none"),
    /1 つの td に 2 人ぶんのリンクがある/,
  );
});

/** **ホストは `pref.akita.gsl-service.net`**（`pref.*.lg.jp` ではない） */
test("#759 resolveAkitaUrl: 別ホストは例外、`http://` は `https://` に寄せる", () => {
  const base = `https://${AKITA_HOST}/doc/2018042300017/`;
  assert.equal(resolveAkitaUrl("/profile/1/", base), `https://${AKITA_HOST}/profile/1/`);
  // **`http://` と `https://` が混在する**（議員紹介ページの `川邉隼之介`、年度一覧のリンク）
  assert.equal(resolveAkitaUrl(`http://${AKITA_HOST}/profile/1/`, base), `https://${AKITA_HOST}/profile/1/`, "http は https に寄せる");
  // **フラグメントは落とす**（`#R7-1208` は同じページの中の位置でしかない）
  assert.equal(resolveAkitaUrl(`${base}#R7`, base), base, "フラグメントを落とす");
  // **県のサイト（`www.pref.akita.lg.jp`）も別ホスト**——取りに行かない
  assert.throws(() => resolveAkitaUrl("https://www.pref.akita.lg.jp/", base), /not on/, "県のサイトは別ホスト");
  assert.throws(() => resolveAkitaUrl("https://example.com/x.pdf", base), /not on/, "外部は例外");
  assert.throws(() => resolveAkitaUrl("javascript:alert(1)", base), /not on|not http/, "スキームが違えば例外");
});

test("#759 warekiYear / isoDate / cleanText", () => {
  assert.equal(warekiYear("令和", "8"), 2026);
  assert.equal(warekiYear("令和", "元"), 2019);
  assert.equal(warekiYear("平成", "２９"), 2017, "全角数字");
  assert.equal(warekiYear("昭和", "64"), 1989);
  assert.throws(() => warekiYear("大正", "1"), /unknown era/);
  assert.throws(() => warekiYear("令和", "0"), /bad wareki/);
  assert.equal(isoDate(2026, 7, 3), "2026-07-03");
  assert.throws(() => isoDate(2026, 13, 1), /out of range/);
  assert.equal(cleanText(" 石田　寛 "), "石田 寛", "全角空白も 1 つの半角に");
  assert.equal(cleanText("a&nbsp;b"), "a b");
});

test("#759 AKITA_ASSEMBLY", () => {
  assert.equal(AKITA_ASSEMBLY.id, "pref-05");
  assert.equal(AKITA_ASSEMBLY.prefCode, "05");
  assert.equal(AKITA_ASSEMBLY.kind, "prefectural");
  assert.equal(AKITA_ASSEMBLY.name, "秋田県議会");
  // **ホストは `pref.*.lg.jp` ではない**（#759 の罠。link-check の許可リストに名指しで足した）
  assert.ok(AKITA_ASSEMBLY.sourceUrl.startsWith(`https://${AKITA_HOST}/`), "sourceUrl のホスト");
  assert.equal(AKITA_HOST, "pref.akita.gsl-service.net");
});
