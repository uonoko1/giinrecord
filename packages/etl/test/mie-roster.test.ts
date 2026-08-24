import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DISTRICT_INDEX_URL, GOJUON_URL, parseDistrictIndex, parseDistrictPage, parseGojuon, buildRoster } from "../src/sources/local/mie/roster.ts";

// 三重県議会 議員名簿（Issue #203）。選挙区別５０音順（1 ページ）と選挙区別名簿（index → 15 選挙区ページ）を突合する。
// フィクスチャは 2026-08-24 取得の実 HTML（https://www.pref.mie.lg.jp/KENGIKAI/08089011294.htm ほか）。
const read = (name: string) => readFileSync(new URL(`./fixtures/mie/${name}`, import.meta.url), "utf8");
const origin = "https://www.pref.mie.lg.jp";

const DISTRICT_PAGES: Record<string, string> = {
  [`${origin}/KENGIKAI/08109011323.htm`]: "senkyoku-08109011323.htm",
  [`${origin}/KENGIKAI/08111011325.htm`]: "senkyoku-08111011325.htm",
  [`${origin}/KENGIKAI/08097011311.htm`]: "senkyoku-08097011311.htm",
  [`${origin}/KENGIKAI/08101011315.htm`]: "senkyoku-08101011315.htm",
  [`${origin}/KENGIKAI/08100011314.htm`]: "senkyoku-08100011314.htm",
  [`${origin}/KENGIKAI/08106011320.htm`]: "senkyoku-08106011320.htm",
  [`${origin}/KENGIKAI/08103011317.htm`]: "senkyoku-08103011317.htm",
  [`${origin}/KENGIKAI/08104011318.htm`]: "senkyoku-08104011318.htm",
  [`${origin}/KENGIKAI/08098011312.htm`]: "senkyoku-08098011312.htm",
  [`${origin}/KENGIKAI/08095011309.htm`]: "senkyoku-08095011309.htm",
  [`${origin}/KENGIKAI/08105011319.htm`]: "senkyoku-08105011319.htm",
  [`${origin}/KENGIKAI/08094011308.htm`]: "senkyoku-08094011308.htm",
  [`${origin}/KENGIKAI/08102011316.htm`]: "senkyoku-08102011316.htm",
  [`${origin}/KENGIKAI/08107011321.htm`]: "senkyoku-08107011321.htm",
  [`${origin}/KENGIKAI/08110011324.htm`]: "senkyoku-08110011324.htm",
};

test("parseGojuon: ５０音順名簿の h2 から掲載日（令和７年１１月１８日現在 → 2025-11-18）と定数 48、47 人（鈴鹿市の欠員の空行は数えない）を読む", () => {
  const g = parseGojuon(read("meibo-50on.htm"));
  assert.equal(g.asOf, "2025-11-18");
  assert.equal(g.seats, 48);
  assert.equal(g.rows.length, 47);
  assert.deepEqual(g.rows[0], { district: "津市", name: "青木 謙順", kana: "あおき けんじゅん", group: "自由民主党" });
  // 「東　　 豊」の連続空白は 1 つに寄せる。「いなべ市・ 員弁郡」の選挙区名の空白は取る
  assert.ok(g.rows.some((r) => r.name === "東 豊" && r.district === "東紀州" && r.group === "草莽"));
  assert.ok(g.rows.some((r) => r.name === "日沖 正信" && r.district === "いなべ市・員弁郡"));
  assert.ok(g.rows.some((r) => r.name === "辻内 裕也" && r.group === "自民党県議団" && r.district === "桑名市・桑名郡"));
  assert.equal(new Set(g.rows.map((r) => r.district)).size, 15);
});

test("parseDistrictIndex: 選挙区別名簿の 15 選挙区へのリンク（選挙区名 → URL）", () => {
  const links = parseDistrictIndex(read("meibo-senkyoku.htm"), DISTRICT_INDEX_URL);
  assert.equal(links.length, 15);
  assert.deepEqual(links[0], { district: "津市", url: `${origin}/KENGIKAI/08109011323.htm` });
  assert.ok(links.some((l) => l.district === "いなべ市・員弁郡" && l.url === `${origin}/KENGIKAI/08095011309.htm`));
});

test("parseDistrictPage: 選挙区ページの h1（選挙区名・定数・掲載日・欠員）と、議員ごとの a name（プロフィールの slug）・ふりがな・氏名・所属会派", () => {
  const p = parseDistrictPage(read("senkyoku-08109011323.htm"), `${origin}/KENGIKAI/08109011323.htm`);
  assert.equal(p.district, "津市");
  assert.equal(p.seats, 7);
  assert.equal(p.asOf, "2026-05-19");
  assert.equal(p.members.length, 7);
  assert.deepEqual(p.members[0], { slug: "aoki_kenjyun15", name: "青木 謙順", kana: "あおき けんじゅん", group: "自由民主党", anchorUrl: `${origin}/KENGIKAI/08109011323.htm#aoki_kenjyun15` });
  // 「川口　　円」の連続空白は 1 つに
  assert.ok(p.members.some((m) => m.slug === "kawaguchi_madoka15" && m.name === "川口 円"));
  // 鈴鹿市は h1 に「・欠員１名」があり、定数 4 で議員 3 人
  const suzuka = parseDistrictPage(read("senkyoku-08106011320.htm"), `${origin}/KENGIKAI/08106011320.htm`);
  assert.equal(suzuka.district, "鈴鹿市");
  assert.equal(suzuka.seats, 4);
  assert.equal(suzuka.vacancies, 1);
  assert.equal(suzuka.members.length, 3);
  // td が colspan の選挙区ページも同じ形に読める
  const inabe = parseDistrictPage(read("senkyoku-08095011309.htm"), `${origin}/KENGIKAI/08095011309.htm`);
  assert.deepEqual(inabe.members.map((m) => [m.slug, m.name]), [["ishigaki_tomoya15", "石垣 智矢"], ["hioki_masanobu15", "日沖 正信"]]);
});

test("buildRoster: ５０音順と選挙区ページを突合して LocalMember 47 人（id は p_24_{slug}）。会派・ふりがなが食い違えば例外", () => {
  const gojuon = parseGojuon(read("meibo-50on.htm"));
  const links = parseDistrictIndex(read("meibo-senkyoku.htm"), DISTRICT_INDEX_URL);
  const pages = links.map((l) => parseDistrictPage(read(DISTRICT_PAGES[l.url]), l.url));
  const roster = buildRoster(gojuon, links, pages);
  assert.equal(roster.members.length, 47);
  assert.equal(roster.asOf, "2025-11-18");
  const aoki = roster.members.find((m) => m.id === "p_24_aoki_kenjyun15")!;
  assert.deepEqual(aoki, {
    id: "p_24_aoki_kenjyun15",
    assemblyId: "pref-24",
    name: "青木 謙順",
    kana: "あおき けんじゅん",
    group: "自由民主党",
    district: "津市",
    profileUrl: `${origin}/KENGIKAI/08109011323.htm#aoki_kenjyun15`,
    current: true,
    asOf: "2025-11-18",
    sourceUrl: GOJUON_URL,
    counts: { rollcalls: 0 },
  });
  // id は一意
  assert.equal(new Set(roster.members.map((m) => m.id)).size, 47);

  // 会派が食い違えば例外（どちらを正とするか推定しない）
  const broken = pages.map((p) => (p.district === "津市" ? { ...p, members: p.members.map((m) => (m.slug === "aoki_kenjyun15" ? { ...m, group: "新政みえ" } : m)) } : p));
  assert.throws(() => buildRoster(gojuon, links, broken), /青木/);

  // 選挙区ページに居ない人が５０音順に居れば例外
  const missing = pages.map((p) => (p.district === "津市" ? { ...p, members: p.members.filter((m) => m.slug !== "aoki_kenjyun15") } : p));
  assert.throws(() => buildRoster(gojuon, links, missing), /青木/);
});
