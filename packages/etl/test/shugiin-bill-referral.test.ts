import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import iconv from "iconv-lite";
import { parseShugiinBill, toBillSummary } from "../src/sources/shugiin-bills.ts";

/**
 * 議案の「付託」（#1133）。
 *
 * 一次資料（衆院 経過ページ）に **記録された付託先をそのまま写す** ことだけを検査する。
 * **分野の判定はしない。** 委員会名の言い換え・正規化・補完もしない。
 *
 * ページの欄は院ごとに 2 つずつある:
 *   衆議院予備付託年月日／衆議院予備付託委員会
 *   衆議院付託年月日／衆議院付託委員会
 *   参議院予備付託年月日／参議院予備付託委員会
 *   参議院付託年月日／参議院付託委員会
 * 値は「日付 ／ 付託先」で、どちらも空のことがある。
 */
const fixture = (name: string) => iconv.decode(readFileSync(new URL(`./fixtures/${name}.htm`, import.meta.url)), "Shift_JIS");
const BASE = "https://www.shugiin.go.jp/internet/itdb_gian.nsf/html/gian";
const keika = (id: string) => `${BASE}/keika/${id}.htm`;
const bill = (id: string) => parseShugiinBill(fixture(`shugiin-keika-${id}`), keika(id));

describe("付託: 記録された付託先を原文のまま写す（#1133）", () => {
  test("閣法: 衆参それぞれの付託先と付託日が、ページの原文のまま入る", () => {
    // 1DE14D6「所得税法等の一部を改正する法律案」
    //   衆議院付託年月日／衆議院付託委員会  令和 8年 3月 5日 ／ 財務金融
    //   参議院付託年月日／参議院付託委員会  令和 8年 3月23日 ／ 財政金融
    assert.deepEqual(bill("1DE14D6").referral, {
      shugiin: { date: "2026-03-05", committee: "財務金融" },
      sangiin: { date: "2026-03-23", committee: "財政金融" },
    });
  });

  test("同じ議案でも衆と参で委員会名が違う。どちらも原文のままで、片方に寄せない", () => {
    // 一次資料が別の名前で記録している以上、統一するのは私たちの手による書き換えになる。
    const b = bill("1DE1582");
    assert.equal(b.referral?.shugiin?.committee, "外務");
    assert.equal(b.referral?.sangiin?.committee, "外交防衛");
    assert.notEqual(b.referral?.shugiin?.committee, b.referral?.sangiin?.committee);
  });

  test("「委員会」の語を足さない（原文が「外務」なら「外務」。「外務委員会」にしない）", () => {
    for (const [id, expected] of [["1DE1582", "外務"], ["1DE14D2", "財務金融"], ["1DE1E7E", "内閣"]] as const) {
      assert.equal(bill(id).referral?.shugiin?.committee, expected);
    }
  });

  test("委員会以外の付託先も原文のまま（「決算行政監視」「政治改革に関する特別」「憲法審査会」の形）", () => {
    // ページは「〜委員会」「〜特別委員会」「〜審査会」を区別せずこの欄に書く。私たちも区別しない。
    assert.equal(bill("1DE115E").referral?.shugiin?.committee, "決算行政監視");
    assert.equal(bill("1DE153E").referral?.shugiin?.committee, "政治改革に関する特別");
  });

  test("予備付託も別の欄として残す（本付託と混ぜない）", () => {
    // 1DE14C2「令和八年度一般会計予算」は衆に予備付託が無く、参に予備付託がある。
    const b = parseShugiinBill(fixture("shugiin-keika-1DE14D6"), keika("1DE14D6"));
    assert.equal(b.referral?.shugiinPreliminary, undefined);
  });
});

describe("付託: 「記録が無い」を埋めない（#1133）", () => {
  test("欄が空なら付託先を持たない（undefined）。空文字にも「不明」にもしない", () => {
    // 1DE213E（参法・衆院未審議）は衆参とも「／」だけ
    const b = bill("1DE213E");
    assert.equal(b.referral, undefined);
    assert.equal("referral" in b, false);
  });

  test("衆に付託があり参に無い議案は、参の側だけが欠ける（参を衆で埋めない）", () => {
    const b = bill("1DE1E7E"); // 衆: 令和 8年 4月21日 ／ 内閣、参: 空
    assert.equal(b.referral?.shugiin?.committee, "内閣");
    assert.equal(b.referral?.sangiin, undefined);
  });
});

describe("付託: 「審査省略」は付託先ではない（#1133）", () => {
  test("委員会名の位置に「審査省略」と書かれた議案は committee を持たず、原文を別に残す", () => {
    // 1DE1E6A（国土交通委員長提出）は 衆「／ 審査省略」。日付も無い。
    const b = bill("1DE1E6A");
    assert.equal(b.referral?.shugiin?.committee, undefined);
    assert.equal(b.referral?.shugiin?.noteText, "審査省略");
    assert.equal(b.referral?.shugiin?.date, undefined);
  });

  test("「審査省略」の議案でも、付託のあった院は普通に取れる", () => {
    // 同じ 1DE1E6A は 参「令和 8年 3月30日 ／ 国土交通」
    const b = bill("1DE1E6A");
    assert.equal(b.referral?.sangiin?.committee, "国土交通");
    assert.equal(b.referral?.sangiin?.date, "2026-03-30");
  });

  test("決議案も同じ（「審査省略」を委員会として数えない）", () => {
    const b = bill("1DE1FF6");
    assert.equal(b.referral?.shugiin?.committee, undefined);
    assert.equal(b.referral?.shugiin?.noteText, "審査省略");
  });
});

describe("付託: 古い回次でも同じ欄が読める（#1133）", () => {
  test("第142回（1998年）の議案も付託先が取れる", () => {
    const b = parseShugiinBill(fixture("shugiin-keika-5516"), keika("5516"));
    assert.equal(b.referral?.shugiin?.committee, "内閣");
    assert.equal(b.referral?.shugiin?.date, "1998-03-11");
    assert.equal(b.referral?.sangiin?.committee, "労働・社会政策");
  });
});

describe("付託: bills/index.json の行（#1133）", () => {
  test("一覧の行に付託先が載る（出典は既にある sourceUrl）", () => {
    const b = parseShugiinBill(fixture("shugiin-keika-1DE14D6"), keika("1DE14D6"), { status: "成立" });
    const row = toBillSummary(b);
    assert.deepEqual(row.referredCommittees, [
      { house: "shugiin", committee: "財務金融" },
      { house: "sangiin", committee: "財政金融" },
    ]);
    assert.equal(row.sourceUrl, keika("1DE14D6"));
  });

  test("付託の記録が無い議案は欄ごと持たない（「分野なし」を値として持たない）", () => {
    const row = toBillSummary(bill("1DE213E"));
    assert.equal(row.referredCommittees, undefined);
    assert.equal("referredCommittees" in row, false);
  });

  test("「審査省略」しかない議案は一覧に委員会を出さない（審査省略を分野にしない）", () => {
    // 1DE1E6A は衆が「審査省略」で参が「国土交通」。一覧に出るのは参の国土交通だけ。
    const row = toBillSummary(bill("1DE1E6A"));
    assert.deepEqual(row.referredCommittees, [{ house: "sangiin", committee: "国土交通" }]);
  });

  test("一覧の行は本付託だけ（予備付託を混ぜて二重に数えない）", () => {
    const row = toBillSummary(bill("1DE14C2"));
    // 1DE14C2 は衆予備付託が空、衆本付託「予算」、参予備付託「予算」、参本付託「予算」
    assert.deepEqual(row.referredCommittees, [
      { house: "shugiin", committee: "予算" },
      { house: "sangiin", committee: "予算" },
    ]);
  });
});
