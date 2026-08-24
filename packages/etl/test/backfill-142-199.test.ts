import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import iconv from "iconv-lite";
import { parseRollCall, parseRollCallList, standingVoteNote } from "../src/sources/sangiin-votes.ts";
import { parseShugiinBill, parseShugiinBillList, shugiinBillListUrl } from "../src/sources/shugiin-bills.ts";
import { matchVotes } from "../src/match-votes.ts";
import { parseMemberList } from "../src/sources/sangiin-members.ts";

/**
 * 第142〜199回への遡り（Issue #219、spike #217 = docs/research/backfill-142-199.md）。
 * 参院の投票結果ページは第142回（1998-01-14）から在り、HTML は現行の旧レイアウト（第200〜216回）と同じ。
 * 回次別の参院名簿は第216回以降にしか無いので、この期間の票はほぼ全部 memberId を埋められない（unmatched）。
 * ここで固定するのは「1998〜2000年の実HTMLでもパーサが変更なしに通ること」と、
 * 「現行名簿と氏名が一致する少数の票が m_ に紐づいてしまう」という**満たせていない事実**（#230 で解消する）。
 */
const BASE = "https://www.sangiin.go.jp/japanese/touhyoulist";
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.htm`, import.meta.url), "utf-8");
const sjisFixture = (name: string) => iconv.decode(readFileSync(new URL(`./fixtures/${name}.htm`, import.meta.url)), "Shift_JIS");
const sumSizes = (groups: { size: number }[]) => groups.reduce((a, g) => a + g.size, 0);

describe("実HTML: 142-0114-v001（第142回・押しボタン投票の最古の回次）", () => {
  const url = `${BASE}/142/142-0114-v001.htm`;
  const rc = parseRollCall(fixture("142-0114-v001"), url, 142);

  test("旧レイアウトのまま id・日付（西暦表記）・案件名・総数が取れる", () => {
    assert.equal(rc.id, "142-0114-v001");
    assert.equal(rc.session, 142);
    assert.equal(rc.date, "1998-01-14");
    assert.ok(rc.title.startsWith("日程第２"), `案件名が取れていない: ${rc.title}`);
    assert.deepEqual(rc.totals, { total: 215, yes: 199, no: 16 });
    assert.equal(rc.sourceUrl, url);
  });

  test("当時の会派（民友連・新党さきがけ など）が原文のまま11件取れる", () => {
    assert.equal(rc.groups.length, 11);
    assert.deepEqual(rc.groups[0], { group: "自由民主党", size: 119, yes: 103, no: 0 });
    const names = rc.groups.map((g) => g.group);
    for (const g of ["民友連", "新党さきがけ", "二院クラブ", "各派に属しない議員"]) {
      assert.ok(names.includes(g), `会派 ${g} が無い: ${names.join(" / ")}`);
    }
  });

  test("個人票数 === Σ 会派人数、賛否の内訳はページの投票総数と一致する", () => {
    assert.equal(rc.votes.length, sumSizes(rc.groups));
    assert.equal(rc.votes.filter((v) => v.value === "賛成").length, 199);
    assert.equal(rc.votes.filter((v) => v.value === "反対").length, 16);
    assert.ok(rc.votes.some((v) => v.value === "投票なし"), "投票なし（賛否どちらの列も空）の票が無い");
  });

  test("押しボタン投票なので起立採決のページではない", () => {
    assert.equal(standingVoteNote(fixture("142-0114-v001")), undefined);
  });
});

describe("実HTML: 150-1201-v001（第150回・反対票 0）", () => {
  const rc = parseRollCall(fixture("150-1201-v001"), `${BASE}/150/150-1201-v001.htm`, 150);

  test("反対票が 0 件でも会派ブロックと票が取れる", () => {
    assert.equal(rc.date, "2000-12-01");
    assert.equal(rc.totals.no, 0);
    assert.equal(rc.votes.filter((v) => v.value === "反対").length, 0);
    assert.equal(rc.votes.length, sumSizes(rc.groups));
    assert.deepEqual(rc.groups[0], { group: "自由民主党・保守党", size: 112, yes: 107, no: 0 });
  });
});

describe("実HTML: 第142回・第199回の一覧ページ", () => {
  test("第142回: 177件のリンクを列挙し、日付見出しは和暦の原文のまま", () => {
    const list = parseRollCallList(fixture("sangiin-vote-ind-142"), 142);
    assert.equal(list.length, 177);
    // 一覧は日付の降順（最終日の採決が先頭）。最古の 142-0114-v001 は末尾側にある
    assert.equal(list[0].href, `${BASE}/142/142-0618-v001.htm`);
    assert.ok(list.some((x) => x.href === `${BASE}/142/142-0114-v001.htm`), "最古の採決が一覧に無い");
    assert.ok(/平成\d+年\d+月\d+日/.test(list[0].dateJa), `和暦の日付見出しが取れていない: ${list[0].dateJa}`);
    assert.ok(list.every((x) => x.dateJa !== ""), "日付見出しが欠けている行がある");
  });

  test("第199回: 採決が1件も無い回次は 0 件を正常に返す（404 ではない）", () => {
    assert.deepEqual(parseRollCallList(fixture("sangiin-vote-ind-199"), 199), []);
  });
});

describe("第142〜199回の票と m_ 空間（#219 の受け入れ条件と、満たせていない事実）", () => {
  // 手元にある唯一の名簿は第221回のもの。第142回（1998年）の氏名が現職の m_ に紐づくのは推定を含む
  // （名簿に termStart が無いので、その回次に在職していたことを一次資料から確認できない）。
  const members = parseMemberList(
    fixture("sangiin-giin-221"),
    "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/221/giin.htm",
    221,
  );
  const matched = matchVotes(parseRollCall(fixture("142-0114-v001"), `${BASE}/142/142-0114-v001.htm`, 142), members);

  // TODO(#230): 現行の resolveMember は「正規化氏名の候補が1人なら回次を名簿が覆っているか見ずに採用する」ため、
  // 1998 年の票が現職 3 人（中曽根 弘文・橋本 聖子・山崎 正昭）に紐づく。名簿に termStart（在職開始日）が無く、
  // その回次に在職していたことを一次資料から確認できないので、これは推定を含む紐づけ。
  // 同じことが第200〜215回でも起きており（約 18,401 票）、一律に厳格化すると公開済みの紐づけが大量に外れて
  // lostVoteMatches が ETL を止める。影響を測ってから独立に直す判断になったので #230 に切り出した（#219 の PO 判断）。
  // それまでこの2つは todo のまま残す（隠さず、満たせていない事実を仕様として残す）。
  test.todo("全票の memberId が空（現職の名簿と氏名が一致しても第142回の票は紐づけない）", () => {
    const linked = matched.rollCall.votes.filter((v) => v.memberId !== "");
    assert.deepEqual(
      linked.map((v) => `${v.nameText}=${v.memberId}`),
      [],
      "第142回の票が現職の memberId に紐づいた（同姓同名の誤紐づけ）",
    );
  });

  test.todo("全票が unmatched に載る（氏名と当時の会派は事実として残る）", () => {
    assert.equal(matched.unmatched.length, matched.rollCall.votes.length);
  });

  test("紐づかなかった票は氏名と当時の会派を事実として残し、rollCallId で回次が引ける", () => {
    assert.ok(matched.unmatched.length > 0);
    assert.ok(matched.unmatched.every((u) => u.rollCallId === "142-0114-v001"));
    assert.ok(matched.unmatched.every((u) => u.nameText !== "" && u.group !== ""));
    // 当時の会派（第221回の名簿には無い）が原文のまま載る
    assert.ok(matched.unmatched.some((u) => u.group === "民友連"));
  });

  // 満たせていない事実を「隠さず仕様として残す」ためのテスト（#219 の PO 判断）。
  // #230 でこの紐づけを解消したら件数は 0 になり、上の test.todo が通る（そのときこのテストは消す）。
  test("【既知の未解決 #230】現行名簿と氏名が一致する少数の票は m_ に紐づく（推定を含む紐づけ）", () => {
    const linked = matched.rollCall.votes.filter((v) => v.memberId !== "");
    assert.equal(linked.length, 3, "推定を含む紐づけの件数が変わった（#230 の対応か、名簿の変化）");
    assert.deepEqual(
      linked.map((v) => v.nameText).sort(),
      ["中曽根 弘文", "山崎 正昭", "橋本 聖子"].sort(),
    );
    // 残りは全部 unmatched（氏名と当時の会派は事実として残る）
    assert.equal(matched.unmatched.length, matched.rollCall.votes.length - linked.length);
  });

  test("氏名だけから Member を作らない（名簿に無い氏名は m_ を持たない）", () => {
    const ids = new Set(members.map((m) => m.id));
    for (const v of matched.rollCall.votes) {
      if (v.memberId !== "") assert.ok(ids.has(v.memberId), `名簿に無い memberId が作られた: ${v.memberId}`);
    }
  });
});

describe("実HTML: 衆院 第142回（会派態度の項目が無い回次）", () => {
  const url = "https://www.shugiin.go.jp/internet/itdb_gian.nsf/html/gian/keika/5516.htm";
  const bill = parseShugiinBill(sjisFixture("shugiin-keika-5516"), url);

  test("議案の事実（件名・提出回次・提出者・議決）は原文のまま取れる", () => {
    // 第142回の一覧に載るが提出は第139回（継続審議）。id は提出回次で作る（DATA_CONTRACT）
    assert.equal(bill.id, "139-衆法-18");
    assert.equal(bill.session, 139);
    assert.equal(bill.house, "shugiin");
    assert.equal(bill.title, "市民活動促進法案");
    assert.equal(bill.submitterText, "熊代 昭彦君外四名");
    assert.deepEqual(bill.submitterGroups, ["自由民主党", "社会民主党・市民連合", "新党さきがけ"]);
    assert.equal(bill.sourceUrl, url);
  });

  test("会派態度の項目自体が無い回次では shugiinGroupStance を持たない（「全会派賛成」等に読み替えない）", () => {
    assert.equal(bill.shugiinGroupStance, undefined);
    assert.equal("shugiinGroupStance" in bill, false);
  });

  test("第142回の一覧は現行パーサで読め、規則・規程の表も落とさない", () => {
    const items = parseShugiinBillList(sjisFixture("shugiin-kaiji-142"), shugiinBillListUrl(142));
    assert.ok(items.length > 100, `一覧が読めていない: ${items.length} 件`);
    const kinds = new Set(items.map((i) => i.kindText));
    for (const k of ["衆法", "閣法", "規則", "規程"]) {
      assert.ok(kinds.has(k), `種別 ${k} が一覧から落ちている: ${[...kinds].join(" / ")}`);
    }
  });
});
