import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import iconv from "iconv-lite";
import type { Bill, BillSummary } from "@seiji-kiroku/shared";
import { parseShugiinBill, toBillSummary } from "../src/sources/shugiin-bills.ts";
import { billReferralViolations } from "../src/dataset.ts";

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

  test("予備付託は本付託と別の欄。同じ委員会でも日付が違うので、潰すと日付が1つ失われる", () => {
    // 1DDEF5A「自殺対策基本法の一部を改正する法律案」（第217回 参法5）
    //   衆議院予備付託年月日／衆議院予備付託委員会  令和 7年 4月15日 ／ 厚生労働
    //   衆議院付託年月日／衆議院付託委員会          令和 7年 4月16日 ／ 厚生労働
    const b = bill("1DDEF5A");
    assert.deepEqual(b.referral?.shugiinPreliminary, { date: "2025-04-15", committee: "厚生労働" });
    assert.deepEqual(b.referral?.shugiin, { date: "2025-04-16", committee: "厚生労働" });
  });

  test("予備付託の欄が空なら予備付託を持たない（本付託で埋めない）", () => {
    // 1DE14D6 は衆の予備付託が「／」だけ。本付託は「令和 8年 3月 5日 ／ 財務金融」
    const b = bill("1DE14D6");
    assert.equal(b.referral?.shugiinPreliminary, undefined);
    assert.equal(b.referral?.shugiin?.committee, "財務金融");
  });

  test("参の予備付託だけがあり衆には無い議案でも、欄ごとに別々に残る", () => {
    // 1DE14C2「令和八年度一般会計予算」: 衆予備 空 / 衆本 予算(2/20) / 参予備 予算(2/20) / 参本 予算(3/13)
    const b = bill("1DE14C2");
    assert.equal(b.referral?.shugiinPreliminary, undefined);
    assert.deepEqual(b.referral?.sangiinPreliminary, { date: "2026-02-20", committee: "予算" });
    assert.deepEqual(b.referral?.sangiin, { date: "2026-03-13", committee: "予算" });
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
    // 1DE14C2 は衆予備付託が空、衆本付託「予算」、参予備付託「予算」、参本付託「予算」。
    // 参の予備と本は同じ「予算」なので、混ぜると参が 2 回並ぶ
    assert.deepEqual(row.referredCommittees, [
      { house: "shugiin", committee: "予算" },
      { house: "sangiin", committee: "予算" },
    ]);
  });

  test("衆の予備付託と本付託が同じ委員会の議案でも、一覧に 1 回しか出ない", () => {
    // 1DDEF5A は衆予備「厚生労働」・衆本「厚生労働」・参本「審査省略」。
    // 予備付託を混ぜると「厚生労働」が 2 回並び、2 つの委員会に付託されたように見える
    const row = toBillSummary(bill("1DDEF5A"));
    assert.deepEqual(row.referredCommittees, [{ house: "shugiin", committee: "厚生労働" }]);
    assert.equal(row.referredCommittees?.length, 1);
  });

  test("一覧の付託先は重複しない（同じ院・同じ委員会が 2 行並ばない）", () => {
    for (const id of ["1DE14C2", "1DDEF5A", "1DE14D6", "1DE1E6A", "1DE1582", "5516"]) {
      const rows = toBillSummary(bill(id)).referredCommittees ?? [];
      const keys = rows.map((r) => `${r.house}\t${r.committee}`);
      assert.equal(new Set(keys).size, keys.length, `${id}: 付託先が重複している ${JSON.stringify(rows)}`);
    }
  });
});

describe("付託: data/ に書く前の検査（#1133）", () => {
  const b = (referral: Bill["referral"]): Bill =>
    ({ id: "221-閣法-3", session: 221, kind: "閣法", house: "shugiin", title: "T", sourceUrl: keika("1DE14D6"), ...(referral ? { referral } : {}) });
  const s = (referredCommittees?: BillSummary["referredCommittees"]): BillSummary =>
    ({ id: "221-閣法-3", session: 221, kind: "閣法", house: "shugiin", title: "T", sourceUrl: keika("1DE14D6"), ...(referredCommittees ? { referredCommittees } : {}) });
  const check = (bill: Bill, sum: BillSummary) => billReferralViolations("bills/221/221-閣法-3.json", "bills/index.json[0]", bill, sum);

  test("原本と一覧が一致していれば違反なし", () => {
    const bill = b({ shugiin: { date: "2026-03-05", committee: "財務金融" }, sangiin: { date: "2026-03-23", committee: "財政金融" } });
    assert.deepEqual(check(bill, s([{ house: "shugiin", committee: "財務金融" }, { house: "sangiin", committee: "財政金融" }])), []);
  });

  test("付託が無い議案は、原本も一覧も持たなければ違反なし", () => {
    assert.deepEqual(check(b(undefined), s(undefined)), []);
  });

  test("一覧だけ委員会名を言い換えたら違反（原本から導き直して突き合わせる）", () => {
    const bill = b({ shugiin: { date: "2026-03-06", committee: "外務" } });
    assert.match(check(bill, s([{ house: "shugiin", committee: "外交" }])).join("\n"), /referredCommittees does not match/);
  });

  test("原本に無い付託先を一覧が持っていたら違反（分野を後から足せない）", () => {
    assert.match(check(b(undefined), s([{ house: "shugiin", committee: "環境" }])).join("\n"), /referredCommittees does not match/);
  });

  test("原本にあるのに一覧が落としていたら違反", () => {
    const bill = b({ shugiin: { date: "2026-03-06", committee: "外務" } });
    assert.match(check(bill, s(undefined)).join("\n"), /referredCommittees does not match/);
  });

  test("予備付託は一覧に出さない。出したら違反", () => {
    const bill = b({ shugiinPreliminary: { date: "2025-04-15", committee: "厚生労働" }, shugiin: { date: "2025-04-16", committee: "厚生労働" } });
    assert.deepEqual(check(bill, s([{ house: "shugiin", committee: "厚生労働" }])), []);
    assert.match(check(bill, s([{ house: "shugiin", committee: "厚生労働" }, { house: "shugiin", committee: "厚生労働" }])).join("\n"), /does not match/);
  });

  test("「審査省略」を committee として書いたら違反（付託先ではない）", () => {
    const bill = b({ shugiin: { committee: "審査省略" } });
    assert.match(check(bill, s([{ house: "shugiin", committee: "審査省略" }])).join("\n"), /must be a committee recorded in the source/);
  });

  test("空文字・「不明」「なし」を committee として書いたら違反", () => {
    for (const bad of ["", "不明", "なし", "-", "ー", "－"]) {
      const bill = b({ shugiin: { committee: bad } });
      assert.match(check(bill, s([{ house: "shugiin", committee: bad }])).join("\n"), /must be a committee recorded in the source/, bad);
    }
  });

  test("committee と noteText の両方を持っていたら違反（一次資料は片方しか書かない）", () => {
    const bill = b({ shugiin: { committee: "国土交通", noteText: "審査省略" } });
    assert.match(check(bill, s([{ house: "shugiin", committee: "国土交通" }])).join("\n"), /has both committee and noteText/);
  });

  test("中身の無い付託の欄を持っていたら違反（欄ごと落とすのが正）", () => {
    assert.match(check(b({ shugiin: {} }), s(undefined)).join("\n"), /is present but empty/);
  });

  test("実データ（経過ページ）から作った議案は違反なし", () => {
    for (const id of ["1DE14D6", "1DE14C2", "1DDEF5A", "1DE1E6A", "1DE213E", "1DE1582", "5516", "1DE115E"]) {
      const bill = parseShugiinBill(fixture(`shugiin-keika-${id}`), keika(id));
      assert.deepEqual(billReferralViolations(`bills/x.json`, `bills/index.json[0]`, bill, toBillSummary(bill)), [], id);
    }
  });
});
