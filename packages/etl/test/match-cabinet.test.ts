import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Member } from "@seiji-kiroku/shared";
import { mergeRosters } from "../src/aggregate.ts";
import { parseMemberList } from "../src/sources/sangiin-members.ts";
import { decodeRosterPage, memberListUrl, parseShugiinMemberList, ROSTER_PAGES } from "../src/sources/shugiin-members.ts";
import { CABINET, MEIBO_PAGES, meiboPageUrl, parseMeiboPage, type CabinetPost } from "../src/sources/kantei-cabinet.ts";
import { assertTallyConsistent, indexByKana, matchCabinetPosts } from "../src/match-cabinet.ts";
import { indexByName, resolveMember, tenureVerified } from "../src/match-votes.ts";

/**
 * 首相官邸の閣僚等名簿を衆参の名簿に名寄せする（Issue #1140。調査は #1135）。
 *
 * ## なぜ「かなでの救済」が要るのか（**氏名が名簿に存在しない 5 件がある**）
 *
 * **外字 4 件は、官邸の名簿が氏名を画像に置き換えている**（`alt` にはかなしか入っていない）。
 * **`𠮷井 章` の `𠮷` は U+20BB7 で、参院名簿の `吉`（U+5409）とは別の文字で、NFKC では吸収されない。**
 * どちらも**氏名では引けない**。かなで引くしかない。
 *
 * ## なぜ「かなで 2 人以上なら不明」なのか
 *
 * **`かな + 所属院` は 771 人中 1 組で衝突する**——**伊藤 孝江 / 伊藤 孝恵**（ともに参院、
 * ともに `いとう たかえ`）。**今回の 5 件はこの組に当たらないが、この 2 人のどちらかが入閣すれば、
 * かなでは絶対に割れない。** 「**記録が出ない**」と「**別人の記録が出る**」は同じ重さではない（#569）。
 * 後者は**利用者から検出できない虚偽**なので、**不明に倒す。**
 *
 * ## 名簿は data/ ではなくフィクスチャから組む
 *
 * `data/members/` を読むと、**このテストが日次 ETL の出力に依存する**（名簿が更新されると
 * 数が動く）。参院 6 回次 + 衆院 10 ページのフィクスチャから組むと、**同じ入力で同じ数が出る**。
 * 実測 2026-09-30: 参 307 + 衆 465 = **772 人**。
 * **いまの上流は衆 464 人**（`渡辺 孝一` が #1037 で失職）だが、**フィクスチャは
 * 2026-02-18 の名簿という一次資料の写しなので、更新して合わせない**
 * （`shugiin-members.test.ts` の同じ注記）。**下の 76/71/5/0 はこの 772 人で測った値で、
 * `data/` の 771 人でも同じ内訳になることを実測で確かめている。**
 */

const fx = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const SANGIIN_SESSIONS = [216, 217, 218, 219, 220, 221] as const;
const LATEST_SESSION = 221;

const sangiin = mergeRosters(SANGIIN_SESSIONS.map((s) => ({
  session: s,
  members: parseMemberList(readFileSync(fx(`sangiin-giin-${s}.htm`), "utf-8"), `https://www.sangiin.go.jp/japanese/joho1/kousei/giin/${s}/giin.htm`, s),
})));
const shugiin = ROSTER_PAGES.flatMap((p) =>
  parseShugiinMemberList(decodeRosterPage(readFileSync(fx(`shugiin-giin-20260218-${p}.htm`))), memberListUrl(p), LATEST_SESSION));
const ROSTER: Member[] = [...sangiin, ...shugiin];

const meibo = (file: string, kind: "閣僚等" | "副大臣" | "大臣政務官") =>
  parseMeiboPage(readFileSync(fx(`kantei-meibo-105-20260930-${file.replace(".html", "")}.html`), "utf-8"), meiboPageUrl(CABINET, file), kind);
const POSTS: CabinetPost[] = MEIBO_PAGES.flatMap((p) => meibo(p.file, p.kind).posts);

const matched = matchCabinetPosts(POSTS, ROSTER, { session: LATEST_SESSION });
const byId = new Map(ROSTER.map((m) => [m.id, m]));

test("#1140 名簿は 772 人（参 307 / 衆 465）で、かな+院 の衝突は 1 組だけ", () => {
  assert.equal(sangiin.length, 307);
  assert.equal(shugiin.length, 465);
  assert.equal(ROSTER.length, 772);
  // **この 1 組が「かなでは割れない」の実例**（下の「不明に倒す」テストが使う）。
  const collisions = [...indexByKana(ROSTER.filter((m) => m.house === "sangiin"))]
    .filter(([, v]) => v.length > 1)
    .map(([k, v]) => `${k}: ${v.map((m) => `${m.id} ${m.name}`).join(" / ")}`);
  assert.deepEqual(collisions, ["いとうたかえ: m_016005 伊藤 孝江 / m_016006 伊藤 孝恵"]);
  assert.equal([...indexByKana(ROSTER.filter((m) => m.house === "shugiin"))].filter(([, v]) => v.length > 1).length, 0);
});

test("#1140 母数の内訳が 76 / 71 / 5 / 0 で、合計が取得件数と一致する", () => {
  // **「0 件」と「数えていない」は違う**（#757）。4 つの数を全部出して、足して母数に戻す。
  assert.deepEqual(matched.tally, { total: 76, byName: 71, byKana: 5, unresolved: 0 });
  assert.equal(matched.tally.byName + matched.tally.byKana + matched.tally.unresolved, matched.tally.total);
  assert.equal(matched.tally.total, POSTS.length, "名簿から取れた件数と突き合わせた件数が違う");
  assert.equal(matched.unresolved.length, 0);
  // 1 人が複数の役職を持つので、行数は人数より多い（実測 134 件）。
  assert.equal(matched.entries.length, 134);
  // 名寄せできた人は 76 人（重複無し）。
  assert.equal(new Set(matched.entries.map((e) => e.memberId)).size, 76);
});

test("#1140 外字 4 件と異体字 1 件が、かなで実際に解決される（氏名では 1 件も解決できない）", () => {
  const kana = matched.entries.filter((e) => e.resolvedBy === "kana");
  const people = [...new Map(kana.map((e) => [e.memberId, e])).values()];
  assert.equal(people.length, 5, "かなで救済した人数が 5 人でない");
  assert.deepEqual(
    people.map((e) => `${e.memberId} ${byId.get(e.memberId)?.name} ${e.kana}`).sort(),
    [
      "h_28b9a33359 高木 啓 たかぎ けい",
      "h_83486b02c5 高橋 祐介 たかはし ゆうすけ",
      "h_a37689b16f 尾崎 正直 おざき まさなお",
      "h_d9603ac1a4 葉梨 康弘 はなし やすひろ",
      "m_022042 吉井 章 よしい あきら",
    ],
  );
  // 4 件は名簿に氏名が無い（画像）。1 件は氏名が在るが別の文字（𠮷 U+20BB7）。
  const gaiji = POSTS.filter((p) => p.name === undefined);
  assert.equal(gaiji.length, 4);
  const yoshii = POSTS.find((p) => p.kana === "よしい あきら");
  assert.equal(yoshii?.name, "𠮷井 章");
  // **氏名側の正規化を足して救済する道は採っていない**ことを、名簿側の綴りとの差で示す。
  assert.equal(byId.get("m_022042")?.name, "吉井 章");
  assert.notEqual(byId.get("m_022042")?.name, yoshii?.name);
});

test("#1140 役職 1 件ごとに一次資料 URL と発足日が付き、発足日はページごとに違う", () => {
  assert.equal(matched.entries.filter((e) => e.sourceUrl === "").length, 0);
  assert.equal(matched.entries.filter((e) => e.effectiveDate === "").length, 0);
  assert.deepEqual([...new Set(matched.entries.map((e) => e.sourceUrl))].sort(), [
    "https://www.kantei.go.jp/jp/105/meibo/fukudaijin.html",
    "https://www.kantei.go.jp/jp/105/meibo/index.html",
    "https://www.kantei.go.jp/jp/105/meibo/seimukan.html",
  ]);
  // 閣僚は 09-17、副大臣・政務官は 09-18（1 つに丸めていない）。
  assert.deepEqual([...new Set(matched.entries.map((e) => e.effectiveDate))].sort(), ["2026-09-17", "2026-09-18"]);
  assert.deepEqual([...new Set(matched.entries.filter((e) => e.kind === "閣僚等").map((e) => e.effectiveDate))], ["2026-09-17"]);
  assert.deepEqual([...new Set(matched.entries.filter((e) => e.kind !== "閣僚等").map((e) => e.effectiveDate))], ["2026-09-18"]);
});

test("#1140 兼務・複数役職は 1 人の複数行になり、役職名は原文のまま", () => {
  const katayama = matched.entries.filter((e) => byId.get(e.memberId)?.name === "片山 さつき");
  assert.deepEqual(katayama.map((e) => e.role).sort(), [
    "内閣府特命担当大臣（金融）", "消費税・支援金法案担当", "租税特別措置・補助金見直し担当", "財務大臣",
  ].sort());
  assert.deepEqual([...new Set(katayama.map((e) => e.house))], ["sangiin"]);
  // 全角空白の区切りが残っている（半角に寄せていない）。
  assert.ok(
    matched.entries.some((e) => e.role === "内閣府特命担当大臣（沖縄及び北方対策　消費者及び食品安全　アイヌ施策）"),
    "役職名の全角空白が失われている",
  );
});

/**
 * **同姓同名 3 組が正しい側に付き、参院側の同名には 1 行も付かない**（#1135 の 7 組のうち 3 組）。
 *
 * ## 割っているのは所属院ではなく「在職の確認」だった（変異で分かった）
 *
 * **M3（`poolOf` から院の絞り込みを外し、名簿全体から引く）を当てても、このテストは落ちなかった。**
 * 理由を測った（実測 2026-09-30、このフィクスチャの名簿）:
 *
 *     中田 宏    m_022001/sangiin  terms=[[216,216,"2025-07-28"]]  tenureVerified=false
 *                h_cdaa8fb9e3/shugiin terms=[[221,null,null]]        tenureVerified=true
 *     白坂 亜紀  m_023004/sangiin  同上 false ／ h_c81186438a/shugiin true
 *     田中 昌史  m_023001/sangiin  同上 false ／ h_0c798613f6/shugiin true
 *
 * **3 組とも参院側の任期満了日が 2025-07-28 で、内閣の発足日 2026-09-18 より前である。**
 * だから `resolveMember` の在職の確認（#230）で参院側が候補から落ち、**院で絞らなくても
 * 衆院側 1 人に決まる。** **「院で割れている」と書くのは、この名簿では正確ではない。**
 *
 * **院の絞り込みは効いていないのではなく、別の場所で効いている**——**かなの索引**である
 * （下の「院が違えば結びつかない」が M3 で落ちる。**M3 で落ちたテストはそれ 1 本だけだった**）。
 *
 * **将来 3 組の参院側が在職中に戻れば（再選など）、在職の確認では割れなくなり、
 * そのときは院の絞り込みが唯一の決め手になる。** 両方を別々に検査しておく。
 */
test("#1140 同姓同名 3 組は衆院側に付き、参院側の同名には 1 行も付かない（割っているのは在職の確認）", () => {
  const at = { session: LATEST_SESSION, date: "2026-09-18" };
  for (const [name, expected] of [["中田 宏", "h_cdaa8fb9e3"], ["白坂 亜紀", "h_c81186438a"], ["田中 昌史", "h_0c798613f6"]] as const) {
    const both = ROSTER.filter((m) => m.name.replace(/[\s　]/g, "") === name.replace(/\s/g, ""));
    assert.equal(both.length, 2, `${name} が名簿に 2 人いない（前提が崩れた）`);
    assert.deepEqual([...new Set(both.map((m) => m.house))].sort(), ["sangiin", "shugiin"]);
    // **何が候補から落としているのかを名指しで固定する**（「割れている」で済ませない）。
    const sangiinTwin = both.find((m) => m.house === "sangiin");
    const shugiinTwin = both.find((m) => m.house === "shugiin");
    assert.equal(tenureVerified(sangiinTwin!, at), false, `${name} の参院側が在職の確認を通っている（前提が変わった）`);
    assert.equal(tenureVerified(shugiinTwin!, at), true);
    const rows = matched.entries.filter((e) => e.memberId === expected);
    assert.ok(rows.length > 0, `${name} が ${expected} に紐づいていない`);
    assert.equal(rows[0].resolvedBy, "name");
    // **参院側の同名には 1 行も付いていない**（別人の記録が出ていない）。
    assert.equal(matched.entries.filter((e) => e.memberId === sangiinTwin?.id).length, 0, `${name} の参院側に記録が付いている`);
  }
});

test("#1140 両院に在職中の同姓同名は、院で絞らなければ割れない（絞りが唯一の決め手になる場合）", () => {
  // **在職の確認では落ちない形**（両方その回次の名簿に載っている）を組んで、
  // **院の絞り込みが無ければ不明になる**ことを示す。実在の名簿にこの形は今は無いが、
  // 参院側が再選すれば起きる（上のテストの docblock）。
  const t = (house: "shugiin" | "sangiin") => ({ house, group: "自由民主党・無所属の会", district: "東京", from: "", sessionFrom: LATEST_SESSION });
  const pair: Member[] = [
    { id: "m_sameS", name: "鬼木 誠", kana: "おにき まこと", house: "sangiin", terms: [t("sangiin")], sourceUrl: "x" },
    { id: "h_sameH", name: "鬼木 誠", kana: "おにき まこと", house: "shugiin", terms: [t("shugiin")], sourceUrl: "x" },
  ];
  const post: CabinetPost = {
    kind: "副大臣", roles: ["防衛副大臣"], name: "鬼木 誠", kana: "おにき まこと", house: "shugiin",
    effectiveDate: "2026-09-18", effectiveDateText: "令和８年９月１８日", sourceUrl: meiboPageUrl(CABINET, "fukudaijin.html"),
  };
  // 院で絞る（実装の挙動）: 衆院側 1 人に決まる。
  const r = matchCabinetPosts([post], pair, { session: LATEST_SESSION });
  assert.deepEqual(r.tally, { total: 1, byName: 1, byKana: 0, unresolved: 0 });
  assert.equal(r.entries[0].memberId, "h_sameH");
  // **院で絞らなければ 2 人のまま**＝絞りを外せば決まらない（在職の確認では落ちない）。
  assert.equal(tenureVerified(pair[0], { session: LATEST_SESSION, date: "2026-09-18" }), true);
  assert.equal(tenureVerified(pair[1], { session: LATEST_SESSION, date: "2026-09-18" }), true);
  assert.equal(resolveMember(indexByName(pair), "鬼木 誠", undefined, { session: LATEST_SESSION, date: "2026-09-18" }), undefined);
});

test("#1140 かな+院 が衝突したら「不明」になり、どちらの議員にも結びつかない（伊藤 孝江 / 伊藤 孝恵）", () => {
  // **実在の衝突組を使う。** 官邸の名簿が氏名を画像にしている形（name なし）を再現して、
  // かなでしか引けない行を作る。
  const post: CabinetPost = {
    kind: "閣僚等",
    roles: ["法務大臣"],
    kana: "いとう たかえ",
    house: "sangiin",
    effectiveDate: "2026-09-17",
    effectiveDateText: "令和８年９月１７日発足",
    sourceUrl: meiboPageUrl(CABINET, "index.html"),
  };
  const r = matchCabinetPosts([post], ROSTER, { session: LATEST_SESSION });
  assert.deepEqual(r.tally, { total: 1, byName: 0, byKana: 0, unresolved: 1 });
  // **1 行も議員に結びついていない。**
  assert.equal(r.entries.length, 0);
  assert.equal(r.unresolved.length, 1);
  assert.equal(r.unresolved[0].reason, "kana-ambiguous");
  assert.equal(r.unresolved[0].kana, "いとう たかえ");
  assert.equal(r.unresolved[0].nameText, "");
  assert.deepEqual(r.unresolved[0].roles, ["法務大臣"]);
  // 候補は運用者が確認するために残す（**結びつけではない**）。
  assert.deepEqual(r.unresolved[0].candidates?.slice().sort(), ["m_016005", "m_016006"]);
  // 出典は残る（記録は失わない）。
  assert.equal(r.unresolved[0].sourceUrl, "https://www.kantei.go.jp/jp/105/meibo/index.html");
});

test("#1140 名簿に居ない人（官僚・大臣が議員でない場合）は不明で、誰にも結びつかない", () => {
  const post: CabinetPost = {
    kind: "閣僚等",
    roles: ["内閣官房副長官"],
    name: "露木 康浩",
    kana: "つゆき やすひろ",
    house: "shugiin",
    effectiveDate: "2026-09-17",
    effectiveDateText: "令和８年９月１７日発足",
    sourceUrl: meiboPageUrl(CABINET, "index.html"),
  };
  const r = matchCabinetPosts([post], ROSTER, { session: LATEST_SESSION });
  assert.deepEqual(r.tally, { total: 1, byName: 0, byKana: 0, unresolved: 1 });
  assert.equal(r.entries.length, 0);
  assert.equal(r.unresolved[0].reason, "no-candidate");
  assert.equal(r.unresolved[0].nameText, "露木 康浩");
});

test("#1140 かなが 1 人に当たっても、所属院が違えば結びつかない（院をまたいで引かない）", () => {
  // 葉梨 康弘（衆院）を**参院**として出した場合。氏名は画像で引けず、かなも参院には無い。
  const post: CabinetPost = {
    kind: "閣僚等",
    roles: ["国家公安委員会委員長"],
    kana: "はなし やすひろ",
    house: "sangiin",
    effectiveDate: "2026-09-17",
    effectiveDateText: "令和８年９月１７日発足",
    sourceUrl: meiboPageUrl(CABINET, "index.html"),
  };
  const r = matchCabinetPosts([post], ROSTER, { session: LATEST_SESSION });
  assert.deepEqual(r.tally, { total: 1, byName: 0, byKana: 0, unresolved: 1 });
  assert.equal(r.entries.length, 0);
  assert.equal(r.unresolved[0].reason, "no-candidate");
  // 衆院として出せば決まる（院だけが違いであることを示す）。
  const ok = matchCabinetPosts([{ ...post, house: "shugiin" }], ROSTER, { session: LATEST_SESSION });
  assert.deepEqual(ok.tally, { total: 1, byName: 0, byKana: 1, unresolved: 0 });
  assert.equal(ok.entries[0].memberId, "h_d9603ac1a4");
});

test("#1140 氏名が名簿に在るのに絞れなかった行は、かなに落とさない（別人に化けるのを防ぐ）", () => {
  // **危険な向き**: 名簿に**同姓同名で、かなが違う 2 人**が居るとき、氏名では割れない。
  // そこでかなに落とすと、**かなが一致した片方に「確信を持って」紐づいてしまう。**
  // 氏名が割れていないのだから、かなが 1 人に当たっても他方を消す根拠は無い。
  // **実在の衝突ではないので、名簿を組んで示す**（実在の名簿に「同姓同名でかなが違う」組は無い）。
  const t = { house: "shugiin" as const, group: "自由民主党・無所属の会", district: "東京1", from: "", sessionFrom: 221 };
  const twins: Member[] = [
    { id: "h_twinA", name: "山田 一郎", kana: "やまだ いちろう", house: "shugiin", terms: [t], sourceUrl: "x" },
    { id: "h_twinB", name: "山田 一郎", kana: "やまだ かずお", house: "shugiin", terms: [t], sourceUrl: "x" },
  ];
  const post: CabinetPost = {
    kind: "副大臣",
    roles: ["文部科学副大臣"],
    name: "山田 一郎",
    kana: "やまだ いちろう", // ← かなでは h_twinA に 1 人で当たる
    house: "shugiin",
    effectiveDate: "2026-09-18",
    effectiveDateText: "令和８年９月１８日",
    sourceUrl: meiboPageUrl(CABINET, "fukudaijin.html"),
  };
  // 前提の確認: かなだけで引けば 1 人に当たってしまう（＝落とせば紐づく）。
  assert.deepEqual((indexByKana(twins).get("やまだいちろう") ?? []).map((m) => m.id), ["h_twinA"]);
  const r = matchCabinetPosts([post], twins, { session: 221 });
  assert.deepEqual(r.tally, { total: 1, byName: 0, byKana: 0, unresolved: 1 });
  assert.equal(r.entries.length, 0, "氏名で割れていないのに、かなで紐づいた");
  assert.equal(r.unresolved[0].reason, "no-candidate");
  // **氏名が名簿に無い行（外字）なら、同じかなでちゃんと救済される**（この歯止めが救済を殺していない）。
  const gaiji = matchCabinetPosts([{ ...post, name: undefined }], twins, { session: 221 });
  assert.deepEqual(gaiji.tally, { total: 1, byName: 0, byKana: 1, unresolved: 0 });
  assert.equal(gaiji.entries[0].memberId, "h_twinA");
});

/**
 * **検算そのものを検査する**（#757）。
 *
 * **これが無いと検算は無検査だった**——**変異 M10（`throw` を `if (false)` で殺す）を当てても、
 * 24 本のテストが 1 件も落ちなかった。** 正しい入力では検算は発火しないので、
 * 「検算が在る」ことは「検算が効く」ことの証明にならない。**外から壊した値で呼ぶ。**
 */
test("#1140 母数が合わなければ例外にする（4 つの壊れ方を全部落とす）", () => {
  const ok = matchCabinetPosts(POSTS, ROSTER, { session: LATEST_SESSION });
  assert.equal(ok.tally.total, 76);
  // 正しい組み合わせは通る。
  assert.doesNotThrow(() => assertTallyConsistent(ok.tally, ok.entries, ok.unresolved, POSTS.length));

  // (1) 分類の合計が母数に足りない（足すのを忘れた）。
  assert.throws(() => assertTallyConsistent({ ...ok.tally, byKana: 4 }, ok.entries, ok.unresolved, POSTS.length), /!== total/);
  // (2) **行を読み飛ばした**（母数そのものが入力より少ない）。合計は合っているのに間違っている形。
  assert.throws(() => assertTallyConsistent({ total: 75, byName: 70, byKana: 5, unresolved: 0 }, ok.entries, ok.unresolved, POSTS.length), /読み飛ばしている/);
  // (3) 不明の数と不明の行が食い違う（数だけ 0 にして行を捨てる形）。
  assert.throws(() => assertTallyConsistent({ ...ok.tally, byName: 70, unresolved: 1 }, ok.entries, ok.unresolved, POSTS.length), /unresolved rows/);
  // (4) **同じ議員に 2 回紐づいた**（人数が減る）。**「別人の記録が出る」に直接効く検査。**
  const dup = ok.entries.map((e) => ({ ...e, memberId: ok.entries[0].memberId }));
  assert.throws(() => assertTallyConsistent(ok.tally, dup, ok.unresolved, POSTS.length), /2 回紐づいた/);

  // 0 件は 0 件として通る（「0 件」と「数えていない」を区別する）。
  const empty = matchCabinetPosts([], ROSTER, { session: LATEST_SESSION });
  assert.deepEqual(empty.tally, { total: 0, byName: 0, byKana: 0, unresolved: 0 });
});

test("#1140 並びは memberId → 区分 → 役職名（取得順に依存しない）", () => {
  const shuffled = [...POSTS].reverse();
  const a = matchCabinetPosts(POSTS, ROSTER, { session: LATEST_SESSION });
  const b = matchCabinetPosts(shuffled, ROSTER, { session: LATEST_SESSION });
  assert.deepEqual(b.entries, a.entries, "取得順を変えると出力の並びが変わる");
});
