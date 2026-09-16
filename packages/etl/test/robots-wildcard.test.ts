import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { isAllowedByRobots, parseRobots, type RobotsRules } from "../src/sources/local/polite-fetch.ts";

/**
 * robots.txt の `*` / `$`（#894）。
 *
 * **直す前の `isAllowedByRobots` は `prefix.replace(/\*$/, "")` で末尾の `*` しか剥がさず、
 * 途中の `*` をただの文字として扱っていた。**
 * そのため `Disallow: /koujisoutatu*.pdf` のとき `/koujisoutatu2024.pdf` を **許可** と判定した
 * ——「取ってはいけない」と書かれた URL を「取ってよい」と言う、**危険側の誤り**である。
 */

const FIXTURE_DIR = new URL("./fixtures/robots/", import.meta.url);

/** フィクスチャの本文（11 県ぶん）。HTML が返る県（robots.txt が 404）もそのまま入っている。 */
function readFixtures(): Map<string, string> {
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".txt")).sort();
  return new Map(files.map((f) => [f.replace(/\.txt$/, ""), readFileSync(new URL(f, FIXTURE_DIR), "utf-8")]));
}

/** `loadRobots` と同じ扱い: HTML が返るホストは「制限なし」。 */
function rulesOf(text: string): RobotsRules {
  if (/^\s*<!doctype html|^\s*<html/i.test(text)) return { disallow: [] };
  return parseRobots(text);
}

/** 11 県の公開ホスト（`src/sources/local/<県>/site.ts` に在るものに合わせた）。 */
const HOSTS: Record<string, string> = {
  akita: "pref.akita.gsl-service.net",
  aomori: "www.pref.aomori.lg.jp",
  kochi: "gikai.pref.kochi.lg.jp",
  mie: "www.pref.mie.lg.jp",
  miyagi: "www.pref.miyagi.jp",
  nara: "www.pref.nara.lg.jp",
  saga: "www.pref.saga.lg.jp",
  shiga: "www.shigaken-gikai.jp",
  shimane: "www.pref.shimane.lg.jp",
  tokushima: "www.pref.tokushima.lg.jp",
  tottori: "www.pref.tottori.lg.jp",
};

test("フィクスチャは 11 県ぶんある（母数。0 件では下の検算が空回りする）", () => {
  const fx = readFixtures();
  assert.equal(fx.size, 11, `robots フィクスチャは 11 県: ${[...fx.keys()].join(",")}`);
  assert.deepEqual([...fx.keys()].sort(), Object.keys(HOSTS).sort());
});

/**
 * **30 → 33 に直した（#875、2026-09-16）。**
 * **徳島のフィクスチャだけが実物ではなく `docs/ops/etl.md` の「`/system` **など**を Disallow」という
 * 一文から起こされており、`Disallow` が 1 行しか入っていなかった**（README の表にそう書いてある）。
 * **#875 の担当者が実物を取り直した**（`https://www.pref.tokushima.lg.jp/robots.txt`
 * **HTTP 200・167 バイト・md5 `e47a08edefc95a4f8a32fdb0ca98af2a`**）。
 * **実物の `Disallow` は 4 行で、`/system` のほかに `/kenseijoho/kenpou/koujisoutatsu` と
 * その `/tb/`・`/sp/` 版がある。** **`*` を含む規則は 0 件**なので、
 * **途中・先頭 `*` の 13 件・末尾のみ `*` の 1 件は動かない**（徳島の寄与は 0）。
 */
test("11 県の Disallow は 33 件、うち途中・先頭に * を持つのは 13 件、末尾のみ * が 1 件、$ 付きは 0 件", () => {
  const all = [...readFixtures().values()].flatMap((t) => rulesOf(t).disallow);
  assert.equal(all.length, 33, "母数が動いたらこのテストの数字を測り直すこと");
  const star = all.filter((d) => d.includes("*"));
  assert.equal(star.length, 14);
  // 末尾 1 文字を除いた部分に * があるもの＝**直す前の実装が剥がせなかったもの**
  const mid = star.filter((d) => d.slice(0, -1).includes("*"));
  assert.equal(mid.length, 13, `途中・先頭 *: ${mid.join(" ")}`);
  assert.equal(star.length - mid.length, 1, "末尾のみ * は奈良の /documents/22137/* の 1 件");
  assert.equal(all.filter((d) => d.endsWith("$")).length, 0, "11 県の実物に $ 付きは無い（実装はするが、現物では効かない）");
});

test("鳥取: 途中 * の Disallow で、拒否されるべき URL が拒否される（#894 の本体）", () => {
  const rules = rulesOf(readFixtures().get("tottori")!);
  const host = HOSTS.tottori;
  // Disallow: /koujisoutatu*.pdf
  assert.equal(isAllowedByRobots(rules, `https://${host}/koujisoutatu2024.pdf`), false);
  assert.equal(isAllowedByRobots(rules, `https://${host}/koujisoutatu.pdf`), false);
  // Disallow: */koujisoutatu*.pdf （先頭の * は任意の並び）
  assert.equal(isAllowedByRobots(rules, `https://${host}/secure/1422216/koujisoutatu_r08.pdf`), false);
  // * が「なんでも 1 つ以上」ではなく「0 文字以上」であること
  assert.equal(isAllowedByRobots(rules, `https://${host}/koujisoutatu.pdf`), false);
  // 一致しないもの（.pdf で終わらない／別のパス）
  assert.equal(isAllowedByRobots(rules, `https://${host}/koujisoutatu2024.html`), true);
  assert.equal(isAllowedByRobots(rules, `https://${host}/secure/1422216/r0806_sanpi.pdf`), true);
});

test("高知・佐賀・滋賀: 途中・先頭 * の Disallow が効く", () => {
  const fx = readFixtures();
  const kochi = rulesOf(fx.get("kochi")!);
  // Disallow: /*.html.r
  assert.equal(isAllowedByRobots(kochi, `https://${HOSTS.kochi}/activity/decision.html.r`), false);
  assert.equal(isAllowedByRobots(kochi, `https://${HOSTS.kochi}/x.html.r`), false);
  assert.equal(isAllowedByRobots(kochi, `https://${HOSTS.kochi}/activity/decision.html`), true);

  const saga = rulesOf(fx.get("saga")!);
  // Disallow: */Calendar.aspx
  assert.equal(isAllowedByRobots(saga, `https://${HOSTS.saga}/gikai/Calendar.aspx`), false);
  assert.equal(isAllowedByRobots(saga, `https://${HOSTS.saga}/a/b/c/Yearly.aspx`), false);
  assert.equal(isAllowedByRobots(saga, `https://${HOSTS.saga}/gikai/list01707.html`), true);

  const shiga = rulesOf(fx.get("shiga")!);
  // Disallow: /g07_Video*_View*.asp（* が 2 つ）
  assert.equal(isAllowedByRobots(shiga, `https://${HOSTS.shiga}/g07_Video1_View2.asp`), false);
  assert.equal(isAllowedByRobots(shiga, `https://${HOSTS.shiga}/g07_Video_View.asp`), false);
  assert.equal(isAllowedByRobots(shiga, `https://${HOSTS.shiga}/g07_gian_sanpi.asp`), true);
});

test("回帰: * を含まない Disallow（16 件）の判定は直す前と変わらない", () => {
  const fx = readFixtures();
  // 青森 /kensei/kojisotatsu/
  const aomori = rulesOf(fx.get("aomori")!);
  assert.equal(isAllowedByRobots(aomori, `https://${HOSTS.aomori}/kensei/kojisotatsu/x.pdf`), false);
  assert.equal(isAllowedByRobots(aomori, `https://${HOSTS.aomori}/soshiki/gikai/katsudo-shinsakekka.html`), true);
  // 三重 /TOPICS/200809027610.pdf（ファイル 1 本）
  const mie = rulesOf(fx.get("mie")!);
  assert.equal(isAllowedByRobots(mie, `https://${HOSTS.mie}/TOPICS/200809027610.pdf`), false);
  assert.equal(isAllowedByRobots(mie, `https://${HOSTS.mie}/common/content/000123456.pdf`), true);
  // 鳥取 /dde.aspx は /dd.aspx に掛からない（#873 が 1 件ずつ確かめた形）
  const tottori = rulesOf(fx.get("tottori")!);
  assert.equal(isAllowedByRobots(tottori, `https://${HOSTS.tottori}/dde.aspx`), false);
  assert.equal(isAllowedByRobots(tottori, `https://${HOSTS.tottori}/dd.aspx`), true);
  assert.equal(isAllowedByRobots(tottori, `https://${HOSTS.tottori}/secure/221685/x.pdf`), false);
  assert.equal(isAllowedByRobots(tottori, `https://${HOSTS.tottori}/secure/1422216/x.pdf`), true);
  // **徳島 4 件（#875 が実物を取り直した）。`*` は 1 つも無い**
  const tokushima = rulesOf(fx.get("tokushima")!);
  assert.deepEqual(tokushima.disallow, ["/system", "/kenseijoho/kenpou/koujisoutatsu", "/tb/kenseijoho/kenpou/koujisoutatsu", "/sp/kenseijoho/kenpou/koujisoutatsu"]);
  assert.deepEqual(tokushima.disallow.filter((d) => d.includes("*")), [], "徳島の実物に * は 0 件");
  assert.equal(isAllowedByRobots(tokushima, `https://${HOSTS.tokushima}/system/x`), false);
  assert.equal(isAllowedByRobots(tokushima, `https://${HOSTS.tokushima}/kenseijoho/kenpou/koujisoutatsu/x.pdf`), false);
  assert.equal(isAllowedByRobots(tokushima, `https://${HOSTS.tokushima}/sp/kenseijoho/kenpou/koujisoutatsu/x.pdf`), false);
  // **`/kenseijoho/` の下でも `koujisoutatsu` でなければ掛からない**（接頭辞の切れ目を見る）
  assert.equal(isAllowedByRobots(tokushima, `https://${HOSTS.tokushima}/kenseijoho/kenpou/x.pdf`), true);
  // **賛否の経路は 4 件のどれにも当たらない**（#875 が実物 160 URL を 1 件ずつ判定して 0 件）
  assert.equal(isAllowedByRobots(tokushima, `https://${HOSTS.tokushima}/gikai/honkaigi/gaiyou/`), true);
  assert.equal(isAllowedByRobots(tokushima, `https://${HOSTS.tokushima}/gikai/honkaigi/r08/7314697/`), true);
  assert.equal(isAllowedByRobots(tokushima, `https://${HOSTS.tokushima}/file/attachment/1064407.pdf`), true);
  assert.equal(isAllowedByRobots(tokushima, `https://${HOSTS.tokushima}/gikai/giin/kaihabetu/`), true);
  // 秋田（GPTBot だけ）・宮城／島根（404）は Disallow が 0 件
  for (const name of ["akita", "miyagi", "shimane"]) {
    const r = rulesOf(fx.get(name)!);
    assert.deepEqual(r.disallow, [], name);
    assert.equal(isAllowedByRobots(r, `https://${HOSTS[name]}/anything/x.pdf`), true);
  }
  // 奈良 /documents/22137/*（末尾のみ *。直す前も剥がせていた）
  const nara = rulesOf(fx.get("nara")!);
  assert.equal(isAllowedByRobots(nara, `https://${HOSTS.nara}/documents/22137/x.pdf`), false);
  assert.equal(isAllowedByRobots(nara, `https://${HOSTS.nara}/documents/13377/x.pdf`), true);
});

test("$ で終わる規則は行末に固定される（RFC 9309。11 県の実物には無いが、出たときに緩く外さない）", () => {
  const rules = parseRobots(["User-agent: *", "Disallow: /*.pdf$"].join("\n"));
  assert.equal(isAllowedByRobots(rules, "https://www.pref.mie.lg.jp/a/b.pdf"), false);
  assert.equal(isAllowedByRobots(rules, "https://www.pref.mie.lg.jp/a/b.pdf.html"), true);
  const root = parseRobots(["User-agent: *", "Disallow: /$"].join("\n"));
  assert.equal(isAllowedByRobots(root, "https://www.pref.mie.lg.jp/"), false);
  assert.equal(isAllowedByRobots(root, "https://www.pref.mie.lg.jp/KENGIKAI/"), true);
});

test("正規表現のメタ文字は文字として扱う（緩む方にも厳しすぎる方にも外さない）", () => {
  // `.` を「任意の 1 文字」にしてしまうと、当たらないはずの URL まで拒否になる（厳しすぎる側）
  const rules = parseRobots(["User-agent: *", "Disallow: /a.b/"].join("\n"));
  assert.equal(isAllowedByRobots(rules, "https://www.pref.mie.lg.jp/a.b/x"), false);
  assert.equal(isAllowedByRobots(rules, "https://www.pref.mie.lg.jp/axb/x"), true);
  // `(` `[` `+` `?` が入っても例外にならない（例外になれば取得自体が落ちる）
  const meta = parseRobots(["User-agent: *", "Disallow: /a(b[c+d?e/"].join("\n"));
  assert.equal(isAllowedByRobots(meta, "https://www.pref.mie.lg.jp/a(b[c+d?e/x"), false);
  assert.equal(isAllowedByRobots(meta, "https://www.pref.mie.lg.jp/other"), true);
});

test("判定はパスだけでなくクエリも見る（RFC 9309。?KaigiID= を持つ滋賀の経路がある）", () => {
  const rules = parseRobots(["User-agent: *", "Disallow: /g07_gian_sanpi.asp?KaigiID=1"].join("\n"));
  assert.equal(isAllowedByRobots(rules, `https://${HOSTS.shiga}/g07_gian_sanpi.asp?KaigiID=1`), false);
  assert.equal(isAllowedByRobots(rules, `https://${HOSTS.shiga}/g07_gian_sanpi.asp?KaigiID=256`), true);
});
