import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CABINET, CabinetParseError, MEIBO_PAGES, fetchCabinetPosts, meiboPageUrl, parseEffectiveDate, parseMeiboPage,
  setFetchTextForTest, type CabinetPostKind,
} from "../src/sources/kantei-cabinet.ts";

/**
 * 首相官邸の現職の閣僚等名簿のパーサ（Issue #1140。調査は #1135）。
 *
 * ## フィクスチャ（取得日を書く）
 *
 * **2026-09-30 に取得した第105代（第2次高市改造内閣）の 3 ページの生 HTML（UTF-8）。**
 * `https://www.kantei.go.jp/jp/105/meibo/{index,fukudaijin,seimukan}.html`
 * バイト数: index 17,646 / fukudaijin 17,352 / seimukan 17,915。
 *
 * **これを更新して件数を合わせないこと。** 名簿は「いまの内閣」しか公開されず、
 * 改造・総辞職で上流のページは書き換わる。**この写しだけが 2026-09-30 の事実を保持している**
 * （`shugiin-members.test.ts` の「渡辺 孝一」と同じ扱い）。
 *
 * ## フィクスチャが必ず持っていなければならないもの
 *
 * **外字の `<img alt=…>` 4 件と `𠮷`（U+20BB7）1 件**。
 * **これが入っていないと、5 件の救済経路が無検査になる**（#1140 の受け入れ条件）。
 * 下の「外字の行」「𠮷 の行」がそれを毎回確かめる。
 */
const FIXTURE_DATE = "2026-09-30";
const fixture = (file: string): string =>
  readFileSync(new URL(`./fixtures/kantei-meibo-105-${FIXTURE_DATE.replace(/-/g, "")}-${file}.html`, import.meta.url), "utf-8");

const RAW: Readonly<Record<string, string>> = {
  "index.html": fixture("index"),
  "fukudaijin.html": fixture("fukudaijin"),
  "seimukan.html": fixture("seimukan"),
};

const page = (file: string, kind: CabinetPostKind) => parseMeiboPage(RAW[file], meiboPageUrl(CABINET, file), kind);
const cabinet = page("index.html", "閣僚等");
const fukudaijin = page("fukudaijin.html", "副大臣");
const seimukan = page("seimukan.html", "大臣政務官");
const allPosts = [...cabinet.posts, ...fukudaijin.posts, ...seimukan.posts];

test("#1140 名簿は 3 ページある（1 ページ落とすと、その層の全員が「役職に就いていない」と区別がつかない）", () => {
  assert.deepEqual(MEIBO_PAGES.map((p) => p.file), ["index.html", "fukudaijin.html", "seimukan.html"]);
  assert.deepEqual(MEIBO_PAGES.map((p) => p.kind), ["閣僚等", "副大臣", "大臣政務官"]);
  // **列挙を固定しても取得は守れない**ので、取得ループ自体を差し替え口から数える（#1037 の形）。
  const got: string[] = [];
  return (async () => {
    setFetchTextForTest(async (url: string) => {
      got.push(url);
      const file = url.slice(url.lastIndexOf("/") + 1);
      const html = RAW[file];
      assert.ok(html !== undefined, `想定外の URL を取得した: ${url}`);
      return html;
    });
    try {
      const { pages, posts } = await fetchCabinetPosts(CABINET);
      assert.deepEqual(got, MEIBO_PAGES.map((p) => meiboPageUrl(CABINET, p.file)), "3 ページ全部を取得していない");
      assert.equal(pages.length, 3);
      // **取得の結合が 76 件**（21 + 27 + 28）。1 ページ止めれば必ず割れる。
      assert.equal(posts.length, 76);
    } finally {
      setFetchTextForTest(undefined);
    }
  })();
});

test("#1140 名簿から 76 件取れる（閣僚 21 / 副大臣 27 / 大臣政務官 28。合計が母数）", () => {
  assert.equal(cabinet.posts.length, 21, "閣僚名簿の件数が違う");
  assert.equal(fukudaijin.posts.length, 27, "副大臣名簿の件数が違う");
  assert.equal(seimukan.posts.length, 28, "大臣政務官名簿の件数が違う");
  assert.equal(allPosts.length, 76);
  // **所属院の無い行を「無かったこと」にしない**（#757: 0 件と数えていないは違う）。
  // 実測 2026-09-30: 閣僚名簿に 2 件（露木 康浩 内閣官房副長官 / 岩尾 信行 内閣法制局長官＝事務方）。
  assert.equal(cabinet.withoutHouse, 2, "所属院の無い行の数が違う");
  assert.equal(fukudaijin.withoutHouse, 0);
  assert.equal(seimukan.withoutHouse, 0);
  // 落とした行が名簿に居ることは原文で確かめる（落とし損ねと「そもそも居ない」を区別する）。
  assert.match(RAW["index.html"], /露木 康浩/);
  assert.match(RAW["index.html"], /岩尾 信行/);
  assert.equal(allPosts.filter((p) => p.name === "露木 康浩").length, 0, "国会議員でない行が混ざっている");
});

test("#1140 内閣の発足日はページごとに違う（閣僚 09-17 / 副大臣・政務官 09-18。1 つに丸めない）", () => {
  assert.equal(cabinet.effectiveDate, "2026-09-17");
  assert.equal(cabinet.effectiveDateText, "令和８年９月１７日発足");
  // **副大臣・政務官のページは「発足」が付かず、日付が 1 日ずれている。**
  // 閣僚の日付を使い回すと、一次資料に無い日付を出すことになる。
  assert.equal(fukudaijin.effectiveDate, "2026-09-18");
  assert.equal(fukudaijin.effectiveDateText, "令和８年９月１８日");
  assert.equal(seimukan.effectiveDate, "2026-09-18");
  assert.equal(seimukan.effectiveDateText, "令和８年９月１８日");
  assert.notEqual(cabinet.effectiveDate, fukudaijin.effectiveDate, "ページごとの日付の違いが消えている");
  // 全 76 行が、自分のページの日付を持っている。
  assert.equal(allPosts.filter((p) => p.effectiveDate === "2026-09-17").length, 21);
  assert.equal(allPosts.filter((p) => p.effectiveDate === "2026-09-18").length, 55);
});

test("#1140 発足日は全角数字で書かれている（NFKC を通さないと 76 件が丸ごと落ちる）", () => {
  // 原文は「令和８年９月１７日発足」（全角）。
  assert.match(RAW["index.html"], /令和８年９月１７日発足/);
  assert.equal(parseEffectiveDate("令和８年９月１７日発足")?.date, "2026-09-17");
  // **「発足」を必須にしない**（副大臣・政務官のページには付かない。必須にすると 55 件が落ちる）。
  assert.equal(parseEffectiveDate("令和８年９月１８日")?.date, "2026-09-18");
  assert.equal(parseEffectiveDate("平成31年4月30日")?.date, "2019-04-30");
  assert.equal(parseEffectiveDate("令和元年5月1日")?.date, "2019-05-01");
  assert.equal(parseEffectiveDate("日付はありません"), undefined);
});

test("#1140 役職は複数・兼務があり、原文のまま持つ（分類・要約・代表 1 件への丸めをしない）", () => {
  const katayama = allPosts.find((p) => p.name === "片山 さつき");
  assert.ok(katayama !== undefined, "片山 さつき が名簿から取れていない");
  assert.deepEqual(katayama.roles, [
    "財務大臣",
    "内閣府特命担当大臣（金融）",
    "租税特別措置・補助金見直し担当",
    "消費税・支援金法案担当",
  ]);
  assert.equal(katayama.house, "sangiin");
  // 「兼」で始まる役職も原文のまま（副大臣の名簿の形）。
  const koyari = fukudaijin.posts.find((p) => p.name === "こやり 隆史");
  assert.ok(koyari !== undefined);
  assert.deepEqual(koyari.roles, ["防衛副大臣", "兼内閣府副大臣"]);
  // 7 件持つ行（経済産業大臣）。役職の数の合計＝ timeline に出る行数の母数。
  const akazawa = cabinet.posts.find((p) => p.name === "赤澤 亮正");
  assert.equal(akazawa?.roles.length, 7);
  // 実測 2026-09-30: 76 人で役職 134 件（1 人あたり平均 1.76。最大 7）。
  assert.equal(allPosts.reduce((n, p) => n + p.roles.length, 0), 134, "役職の総数が違う");
  // 役職が 1 件も無い行は無い。
  assert.equal(allPosts.filter((p) => p.roles.length === 0).length, 0);
});

test("#1140 役職名の中の全角空白は区切りなので半角に寄せない（原文が変わる）", () => {
  // 原文（実測 3 件）。括弧の中で全角空白が担当分野の区切りに使われている。
  const withIdeographic = allPosts.flatMap((p) => p.roles).filter((r) => r.includes("　")).sort();
  assert.deepEqual(withIdeographic, [
    "内閣府特命担当大臣（こども政策　少子化対策　若者活躍　規制改革　共生・共助）",
    "内閣府特命担当大臣（沖縄及び北方対策　消費者及び食品安全　アイヌ施策）",
    "内閣府特命担当大臣（知的財産戦略　科学技術政策　宇宙政策　人工知能戦略　海洋政策　サイバー安全保障）",
  ]);
  // **前後の空白は落とす**（原文には `…共生・共助）　<br />` と末尾に全角空白がある行がある）。
  assert.equal(allPosts.flatMap((p) => p.roles).filter((r) => /^[\s　]|[\s　]$/.test(r)).length, 0);
});

test("#1140 日付は見出しの兄弟から取る（ページ全体から拾うと副大臣の 09-18 が 09-17 に化ける）", () => {
  // **ページ上部の説明文と末尾のリンク文に「令和8年9月17日に発足した…」が入っている**
  // （副大臣・政務官のページにも入っている）。ここを拾うと日付を取り違える。
  assert.match(RAW["fukudaijin.html"], /令和8年9月17日に発足した/);
  assert.match(RAW["fukudaijin.html"], /令和８年９月１７日に発足した/);
  // それでも副大臣のページの発足日は 09-18 になる（＝見出しの兄弟の `<p>` だけを見ている）。
  assert.equal(fukudaijin.effectiveDate, "2026-09-18");
  assert.equal(seimukan.effectiveDate, "2026-09-18");
});

test("#1140 外字の行は氏名が画像で、本文テキストに漢字が無い（alt にはかなしか入っていない）", () => {
  // フィクスチャに実例が入っていることを原文で固定する（**入っていなければ救済経路が無検査になる**）。
  assert.match(RAW["index.html"], /<img [^>]*alt="はなし やすひろ"[^>]*class="externalCharacter gaiji size-reg">/);
  assert.match(RAW["index.html"], /<img [^>]*alt="（おざき まさなお）"[^>]*class="externalCharacter gaiji size-reg">/);
  assert.match(RAW["fukudaijin.html"], /<img [^>]*alt="たかぎ けい"[^>]*class="externalCharacter gaiji size-reg">/);
  assert.match(RAW["seimukan.html"], /<img [^>]*alt="たかはし ゆうすけ"[^>]*class="externalCharacter gaiji size-reg">/);
  // **氏名の漢字は名簿のどこにも無い。** ここが「取れない」の根拠。
  assert.doesNotMatch(RAW["index.html"], /葉梨/);
  assert.doesNotMatch(RAW["index.html"], /尾崎/);
  assert.doesNotMatch(RAW["fukudaijin.html"], /高木/);
  assert.doesNotMatch(RAW["seimukan.html"], /高橋/);

  // パーサは name を **undefined** にする（`alt` のかなを氏名に使わない）。
  const gaiji = allPosts.filter((p) => p.name === undefined);
  assert.deepEqual(gaiji.map((p) => p.kana).sort(), ["おざき まさなお", "たかぎ けい", "たかはし ゆうすけ", "はなし やすひろ"]);
  // `alt` が `（おざき まさなお）` と括弧付きで入っている行でも、ふりがなは括弧なしで取れる。
  const ozaki = allPosts.find((p) => p.kana === "おざき まさなお");
  assert.deepEqual(ozaki?.roles, ["内閣官房副長官"]);
  assert.equal(ozaki?.house, "shugiin");
  assert.equal(ozaki?.name, undefined);
});

test("#1140 𠮷井 章 は U+20BB7（サロゲートペア）で、名簿側の 吉 U+5409 とは別の文字", () => {
  const yoshii = seimukan.posts.find((p) => p.kana === "よしい あきら");
  assert.ok(yoshii !== undefined, "𠮷井 章 が名簿から取れていない");
  assert.equal(yoshii.name, "𠮷井 章");
  assert.deepEqual([...yoshii.name].map((c) => c.codePointAt(0)), [0x20bb7, 0x4e95, 0x20, 0x7ae0]);
  // **NFKC では吸収されない**（吸収されるなら、かなの救済は要らないことになる）。
  assert.notEqual("𠮷井 章".normalize("NFKC").replace(/\s/g, ""), "吉井章");
  assert.equal(yoshii.house, "sangiin");
  assert.deepEqual(yoshii.roles, ["防衛大臣政務官"]);
});

test("#1140 役職 1 件ごとに一次資料 URL が付く（3 ページのどれか）", () => {
  assert.equal(meiboPageUrl(105, "index.html"), "https://www.kantei.go.jp/jp/105/meibo/index.html");
  const urls = new Set(allPosts.map((p) => p.sourceUrl));
  assert.deepEqual([...urls].sort(), [
    "https://www.kantei.go.jp/jp/105/meibo/fukudaijin.html",
    "https://www.kantei.go.jp/jp/105/meibo/index.html",
    "https://www.kantei.go.jp/jp/105/meibo/seimukan.html",
  ]);
  assert.equal(allPosts.filter((p) => p.sourceUrl === "").length, 0);
});

test("#1140 名簿の形が変わったら黙って空を返さず例外にする", () => {
  const url = meiboPageUrl(CABINET, "index.html");
  assert.throws(() => parseMeiboPage("<html><body></body></html>", url, "閣僚等"), CabinetParseError);
  // 見出しはあるが日付が無い。
  assert.throws(() => parseMeiboPage('<h2 class="heading-lv2">閣僚名簿</h2>', url, "閣僚等"), /発足日/);
  // 日付はあるが、所属院のある行が 1 件も無い（全員が事務方に見える形）。
  const noHouse = '<h2 class="heading-lv2">閣僚名簿</h2><p>令和８年９月１７日発足</p>'
    + '<li class="list-profile__item"><div class="list-profile__title">内閣法制局長官</div>'
    + '<p class="list-profile__name">岩尾 信行 <span class="list-profile__name--ruby">（いわお のぶゆき）</span></p></li>';
  assert.throws(() => parseMeiboPage(noHouse, url, "閣僚等"), /所属院のある行が 1 件もありません/);
  // ふりがなが無い行（かなでしか引けない外字の救済が死ぬので、黙って通さない）。
  const noRuby = '<h2 class="heading-lv2">閣僚名簿</h2><p>令和８年９月１７日発足</p>'
    + '<li class="list-profile__item"><div class="list-profile__title">内閣総理大臣</div>'
    + '<p class="list-profile__name">高市 早苗</p><p class="label">衆議院</p></li>';
  assert.throws(() => parseMeiboPage(noRuby, url, "閣僚等"), /ふりがな/);
});
