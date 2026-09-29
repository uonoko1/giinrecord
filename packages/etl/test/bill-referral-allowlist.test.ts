import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import iconv from "iconv-lite";
import type { Bill, BillSummary } from "@seiji-kiroku/shared";
import { parseShugiinBill, toBillSummary } from "../src/sources/shugiin-bills.ts";
import {
  allReferralCommittees, countedReferralPeriods, isKnownReferralCommittee,
  referralAllowlistCoversDate, referralCommitteeAllowlist,
} from "../src/sources/bill-referral-committees.ts";
import { billReferralViolations } from "../src/dataset.ts";

/**
 * 付託先の許可リスト（#1133 / 利用者の判断 2026-09-30「推測で入れたくないので強制力を持たせて」）。
 *
 * **denylist では、列挙に無い値が委員会名として素通りする。**
 * **実際に素通りした**（`審査省略要求` 2 件）。**allowlist なら「値の集合」については全部と言える。**
 *
 * ここが固定するのは 3 つ:
 *   1. 許可リストの **数**（2019年以降 26/28・1998年 25/18・異なり 64）——表が黙って増減したら落ちる
 *   2. **知らない値が止まる**（委員会名として出ない・data/ に書けない）
 *   3. **いま在る名前は全部通る**（偽陽性が無い。これが無いと使えない）
 */
const fixture = (name: string) => iconv.decode(readFileSync(new URL(`./fixtures/${name}.htm`, import.meta.url)), "Shift_JIS");
const BASE = "https://www.shugiin.go.jp/internet/itdb_gian.nsf/html/gian";
const keika = (id: string) => `${BASE}/keika/${id}.htm`;
const bill = (id: string) => parseShugiinBill(fixture(`shugiin-keika-${id}`), keika(id));

/** 数えた 2 つの時期の、代表的な日付（許可リストはこの日付で引く）。 */
const MODERN = "2026-03-05"; // 第195〜221回の窓（2019-10-04 〜 2026-07-23）
const OLD = "1998-03-11";    // 第142回の窓（1997-06-17 〜 1998-06-18）

/**
 * 経過ページの **衆議院付託委員会のセルだけ** を別の値に差し替えた HTML を返す。
 * **件名などに同じ語が出るので、素朴な `replace` では欄が変わらない**
 * （`1DE1582` の件名には「外務公務員」があり、`"外務"` の置換はそちらに当たる。実際に踏んだ）。
 */
function withShugiinReferral(id: string, committee: string): string {
  const html = fixture(`shugiin-keika-${id}`);
  const out = html.replace(
    /(衆議院付託年月日／衆議院付託委員会<\/span><\/TD>[\s\S]*?／\s*)([^<\s][^<]*?)(<\/span><\/TD>)/,
    `$1${committee}$3`,
  );
  assert.notEqual(out, html, `${id}: 付託先のセルを差し替えられていない`);
  return out;
}

describe("許可リストの母数（#1133）", () => {
  test("2019年以降は 衆 26・参 28、1998年は 衆 25・参 18、合わせて異なり 64", () => {
    // 第195〜221回: data/ の 1,941 件 / 第142回: kaiji142.htm の 241 件（どちらも全数・失敗 0）
    assert.equal(referralCommitteeAllowlist(MODERN, "shugiin").length, 26);
    assert.equal(referralCommitteeAllowlist(MODERN, "sangiin").length, 28);
    assert.equal(referralCommitteeAllowlist(OLD, "shugiin").length, 25);
    assert.equal(referralCommitteeAllowlist(OLD, "sangiin").length, 18);
    assert.equal(allReferralCommittees().length, 64);
  });

  test("数えていない時期の許可リストは空（何も通さない）", () => {
    for (const date of ["1999-01-01", "2005-06-01", "2019-10-03", "2026-07-24"]) {
      assert.deepEqual(referralCommitteeAllowlist(date, "shugiin"), [], date);
      assert.deepEqual(referralCommitteeAllowlist(date, "sangiin"), [], date);
    }
  });

  test("回次・院ごとの表に重複が無い（同じ名前を 2 回書いていない）", () => {
    for (const date of [MODERN, OLD]) {
      for (const house of ["shugiin", "sangiin"] as const) {
        const list = referralCommitteeAllowlist(date, house);
        assert.equal(new Set(list).size, list.length, `${date} ${house}`);
      }
    }
  });

  test("2019年以降は 衆と参で名前が違う（両院に出るのは 15。26 + 28 - 15 = 39）", () => {
    const sh = new Set(referralCommitteeAllowlist(MODERN, "shugiin"));
    const sa = new Set(referralCommitteeAllowlist(MODERN, "sangiin"));
    const both = [...sh].filter((c) => sa.has(c));
    assert.equal(both.length, 15);
    assert.equal([...sh].filter((c) => !sa.has(c)).length, 11);
    assert.equal([...sa].filter((c) => !sh.has(c)).length, 13);
  });

  test("空文字を許可していない（表の作り方を間違えると入りうる）", () => {
    for (const date of [MODERN, OLD]) {
      for (const house of ["shugiin", "sangiin"] as const) {
        assert.equal(referralCommitteeAllowlist(date, house).includes(""), false, `${date} ${house}`);
        assert.equal(isKnownReferralCommittee(date, house, ""), false, `${date} ${house}`);
      }
    }
  });

  test("「審査省略」系は許可リストに入っていない（委員会ではない）", () => {
    for (const house of ["shugiin", "sangiin"] as const) {
      for (const v of ["審査省略", "審査省略要求"]) {
        assert.equal(isKnownReferralCommittee(MODERN, house, v), false, `${house} ${v}`);
      }
    }
  });
});

describe("許可リスト: いま在る名前は全部通る（偽陽性が無いこと。#1133）", () => {
  test("表に在る 97 件（26+28+25+18）が、その時期・その院で 1 つ残らず通る", () => {
    let n = 0;
    for (const date of [MODERN, OLD]) {
      for (const house of ["shugiin", "sangiin"] as const) {
        for (const c of referralCommitteeAllowlist(date, house)) {
          assert.equal(isKnownReferralCommittee(date, house, c), true, `${date} ${house} ${c}`);
          n++;
        }
      }
    }
    assert.equal(n, 97);
  });

  test("数えた窓の中ならどの日でも表がそのまま引ける（日付で穴が開いていない）", () => {
    for (const date of ["2019-10-04", "2020-06-01", "2023-01-15", "2026-07-23"]) {
      assert.equal(referralCommitteeAllowlist(date, "shugiin").length, 26, date);
      assert.equal(isKnownReferralCommittee(date, "shugiin", "内閣"), true, date);
    }
    for (const date of ["1997-06-17", "1998-01-12", "1998-06-18"]) {
      assert.equal(referralCommitteeAllowlist(date, "shugiin").length, 25, date);
      assert.equal(isKnownReferralCommittee(date, "shugiin", "大蔵"), true, date);
    }
  });

  test("fixture の経過ページから出た付託先は、1 つ残らず許可リストに在る", () => {
    const ids = readdirSync(new URL("./fixtures/", import.meta.url))
      .filter((f) => f.startsWith("shugiin-keika-") && f.endsWith(".htm"))
      .map((f) => f.slice("shugiin-keika-".length, -".htm".length));
    assert.ok(ids.length >= 10, `経過ページの fixture が少なすぎる: ${ids.length}`);
    let checked = 0;
    for (const id of ids) {
      const b = bill(id);
      for (const [key, house] of [["shugiinPreliminary", "shugiin"], ["shugiin", "shugiin"], ["sangiinPreliminary", "sangiin"], ["sangiin", "sangiin"]] as const) {
        const c = b.referral?.[key]?.committee;
        if (c === undefined) continue;
        // **その欄の付託日で**照合する（1998 年の fixture を現在の表で通してしまわない）
        const date = b.referral?.[key]?.date;
        assert.ok(date !== undefined, `${id} ${key}: 委員会名があるのに付託日が無い`);
        assert.equal(isKnownReferralCommittee(date, house, c), true, `${id}(${date}) ${key}: ${c} が許可リストに無い`);
        checked++;
      }
    }
    assert.ok(checked >= 10, `付託先のある欄が少なすぎる: ${checked}`);
  });

  test("院をまたいだ名前は、その院でだけ通る（衆の外務は参では通らない）", () => {
    assert.equal(isKnownReferralCommittee(MODERN, "shugiin", "外務"), true);
    assert.equal(isKnownReferralCommittee(MODERN, "sangiin", "外務"), false);
    assert.equal(isKnownReferralCommittee(MODERN, "sangiin", "外交防衛"), true);
    assert.equal(isKnownReferralCommittee(MODERN, "shugiin", "外交防衛"), false);
    assert.equal(isKnownReferralCommittee(MODERN, "shugiin", "財務金融"), true);
    assert.equal(isKnownReferralCommittee(MODERN, "sangiin", "財務金融"), false);
    assert.equal(isKnownReferralCommittee(MODERN, "shugiin", "文部科学"), true);
    assert.equal(isKnownReferralCommittee(MODERN, "sangiin", "文部科学"), false);
    assert.equal(isKnownReferralCommittee(MODERN, "sangiin", "文教科学"), true);
    assert.equal(isKnownReferralCommittee(MODERN, "shugiin", "文教科学"), false);
  });
});

describe("許可リスト: 知らない値は止まる（#1133）", () => {
  /** **許可リストに無い「65 番目」**を作る。実在の委員会名に見えるが、全数調査に出ていない。 */
  const UNKNOWN = [
    "科学技術・イノベーション推進特別委員会", // 「委員会」を足しただけ。許可リストは付けない形で持つ
    "外交",                                   // 言い換え
    "こども家庭",                             // ありそうだが記録に無い
    "情報監視審査会",                         // 実在の審査会だが付託先としての記録が無い
    "審査省略の要求",                         // 「審査省略要求」の別表記
    "",                                       // 空
    "　",                                     // 全角空白だけ
    "未分類",
    "その他",
  ];

  test("65 番目の値は、どの院でも通らない（9 形 × 2 院 = 18 通り）", () => {
    let n = 0;
    for (const house of ["shugiin", "sangiin"] as const) {
      for (const v of UNKNOWN) {
        assert.equal(isKnownReferralCommittee(MODERN, house, v), false, `${house} ${JSON.stringify(v)} が通ってしまう`);
        n++;
      }
    }
    assert.equal(n, 18);
  });

  test("パーサ: 知らない値は committee にならず unknownText に入る（黙って捨てない）", () => {
    // 実ページの HTML の**付託先のセルだけ**を知らない値にする
    // （素朴に "外務" を置換すると、件名の「外務公務員」に当たって欄が変わらない。実際に踏んだ）
    const b = parseShugiinBill(withShugiinReferral("1DE1582", "宇宙開発特別"), keika("1DE1582"));
    assert.equal(b.referral?.shugiin?.committee, undefined, "知らない値が committee として出ている");
    assert.equal(b.referral?.shugiin?.unknownText, "宇宙開発特別");
    // 日付は読めているので残る（値が 1 つ知らないだけで欄ごと消さない）
    assert.equal(b.referral?.shugiin?.date, "2026-03-06");
  });

  test("一覧: 知らない値は bills/index.json に載らない（data/ に推測が入らない）", () => {
    const row = toBillSummary(parseShugiinBill(withShugiinReferral("1DE1582", "宇宙開発特別"), keika("1DE1582")));
    assert.deepEqual(row.referredCommittees, [{ house: "sangiin", committee: "外交防衛" }]);
  });

  test("検査: 知らない値が referral に在れば違反として止まる（CI が赤くなる）", () => {
    const b: Bill = { id: "221-閣法-3", session: 221, kind: "閣法", house: "shugiin", title: "T", sourceUrl: keika("1DE14D6"), referral: { shugiin: { date: "2026-03-05", committee: "宇宙開発特別" } } };
    const s: BillSummary = { id: b.id, session: 221, kind: "閣法", house: "shugiin", title: "T", sourceUrl: b.sourceUrl, referredCommittees: [{ house: "shugiin", committee: "宇宙開発特別" }] };
    assert.match(billReferralViolations("bills/221/x.json", "bills/index.json[0]", b, s).join("\n"), /not recorded in the source|許可/);
  });

  test("検査: 院を取り違えた値も止まる（参の名前が衆の欄に在る）", () => {
    const b: Bill = { id: "221-閣法-3", session: 221, kind: "閣法", house: "shugiin", title: "T", sourceUrl: keika("1DE14D6"), referral: { shugiin: { date: "2026-03-05", committee: "外交防衛" } } };
    const s: BillSummary = { id: b.id, session: 221, kind: "閣法", house: "shugiin", title: "T", sourceUrl: b.sourceUrl, referredCommittees: [{ house: "shugiin", committee: "外交防衛" }] };
    assert.notDeepEqual(billReferralViolations("bills/221/x.json", "bills/index.json[0]", b, s), []);
  });

  test("検査: 一覧だけに知らない値を書いても止まる（原本を経由しない差し込み）", () => {
    const b: Bill = { id: "221-閣法-3", session: 221, kind: "閣法", house: "shugiin", title: "T", sourceUrl: keika("1DE14D6") };
    const s: BillSummary = { id: b.id, session: 221, kind: "閣法", house: "shugiin", title: "T", sourceUrl: b.sourceUrl, referredCommittees: [{ house: "shugiin", committee: "宇宙開発特別" }] };
    assert.notDeepEqual(billReferralViolations("bills/221/x.json", "bills/index.json[0]", b, s), []);
  });

  test("検査: 9 形すべてが止まる（母数つき。通ったものが 1 つでもあれば落ちる）", () => {
    let stopped = 0;
    for (const v of UNKNOWN) {
      const b: Bill = { id: "221-閣法-3", session: 221, kind: "閣法", house: "shugiin", title: "T", sourceUrl: keika("1DE14D6"), referral: { shugiin: { committee: v } } };
      const s: BillSummary = { id: b.id, session: 221, kind: "閣法", house: "shugiin", title: "T", sourceUrl: b.sourceUrl, referredCommittees: [{ house: "shugiin", committee: v }] };
      if (billReferralViolations("bills/221/x.json", "bills/index.json[0]", b, s).length > 0) stopped++;
    }
    assert.equal(stopped, UNKNOWN.length, `${UNKNOWN.length} 形のうち止まったのは ${stopped} 形`);
  });
});

describe("許可リスト: 実データは違反ゼロ（偽陽性が無いことの確認。#1133）", () => {
  test("fixture の経過ページ全部を data/ に書いても違反が出ない", () => {
    const ids = readdirSync(new URL("./fixtures/", import.meta.url))
      .filter((f) => f.startsWith("shugiin-keika-") && f.endsWith(".htm"))
      .map((f) => f.slice("shugiin-keika-".length, -".htm".length));
    for (const id of ids) {
      const b = bill(id);
      assert.deepEqual(billReferralViolations(`bills/${b.session}/${b.id}.json`, "bills/index.json[0]", b, toBillSummary(b)), [], id);
    }
  });
});

describe("許可リスト: 数えていない時期は止まる（#1133）", () => {
  test("数えた期間は 2 つ（1997-06-17〜1998-06-18 と 2019-10-04〜2026-07-23）", () => {
    const periods = countedReferralPeriods();
    assert.equal(periods.length, 2);
    assert.deepEqual(periods.map((p) => [p.from, p.to]), [
      ["1997-06-17", "1998-06-18"],
      ["2019-10-04", "2026-07-23"],
    ]);
  });

  test("数えていない時期は、正しい委員会名でも通らない（表に根拠が無いので）", () => {
    // 1999〜2019年（省庁再編を挟む 20 年）と、窓の外側 1 日
    for (const date of ["1998-06-19", "1999-01-01", "2005-06-01", "2015-03-10", "2019-10-03"]) {
      assert.equal(referralAllowlistCoversDate(date), false, date);
      assert.equal(isKnownReferralCommittee(date, "shugiin", "内閣"), false, `${date} 内閣`);
      assert.equal(isKnownReferralCommittee(date, "sangiin", "予算"), false, `${date} 予算`);
    }
  });

  test("窓の両端はちょうど含む（off-by-one が無い）", () => {
    for (const date of ["1997-06-17", "1998-06-18", "2019-10-04", "2026-07-23"]) {
      assert.equal(referralAllowlistCoversDate(date), true, date);
    }
    for (const date of ["1997-06-16", "1998-06-19", "2019-10-03", "2026-07-24"]) {
      assert.equal(referralAllowlistCoversDate(date), false, date);
    }
  });

  test("未来（数えた窓より後）も通らない——数えるまで止まる", () => {
    assert.equal(referralAllowlistCoversDate("2026-07-24"), false);
    assert.equal(isKnownReferralCommittee("2027-01-01", "shugiin", "内閣"), false);
  });

  test("1998年の旧称は1998年でだけ通る（現在の時期では通らない）", () => {
    // 2001 年の省庁再編の前後で委員会が別物。どちらも原文で、統合しない
    for (const [house, name] of [["shugiin", "大蔵"], ["shugiin", "逓信"], ["sangiin", "国民福祉"], ["sangiin", "労働・社会政策"]] as const) {
      assert.equal(isKnownReferralCommittee(OLD, house, name), true, `1998 ${house} ${name}`);
      assert.equal(isKnownReferralCommittee(MODERN, house, name), false, `2026 ${house} ${name}`);
    }
  });

  test("現在の名前は1998年では通らない（当時は存在しない）", () => {
    for (const [house, name] of [["shugiin", "財務金融"], ["shugiin", "厚生労働"], ["sangiin", "外交防衛"], ["sangiin", "財政金融"]] as const) {
      assert.equal(isKnownReferralCommittee(MODERN, house, name), true, `2026 ${house} ${name}`);
      assert.equal(isKnownReferralCommittee(OLD, house, name), false, `1998 ${house} ${name}`);
    }
  });

  test("中黒の有無を正規化していない（`外交・防衛` と `外交防衛` は別の名前）", () => {
    // 参議院は 1998 年に「外交・防衛」、2019 年以降は「外交防衛」と記録している。どちらも原文
    assert.equal(isKnownReferralCommittee(OLD, "sangiin", "外交・防衛"), true);
    assert.equal(isKnownReferralCommittee(OLD, "sangiin", "外交防衛"), false);
    assert.equal(isKnownReferralCommittee(MODERN, "sangiin", "外交防衛"), true);
    assert.equal(isKnownReferralCommittee(MODERN, "sangiin", "外交・防衛"), false);
    for (const [a, b] of [["財政・金融", "財政金融"], ["文教・科学", "文教科学"], ["経済・産業", "経済産業"]] as const) {
      assert.equal(isKnownReferralCommittee(OLD, "sangiin", a), true, a);
      assert.equal(isKnownReferralCommittee(MODERN, "sangiin", b), true, b);
      assert.equal(isKnownReferralCommittee(MODERN, "sangiin", a), false, `${a} が現在の時期で通る`);
    }
  });

  test("検査: 数えていない時期の付託は、正しい名前でも違反になる", () => {
    const b: Bill = { id: "150-閣法-1", session: 150, kind: "閣法", house: "shugiin", title: "T", sourceUrl: keika("X"), referral: { shugiin: { date: "2000-01-01", committee: "内閣" } } };
    const s: BillSummary = { id: b.id, session: 150, kind: "閣法", house: "shugiin", title: "T", sourceUrl: b.sourceUrl, referredCommittees: [{ house: "shugiin", committee: "内閣" }] };
    assert.match(billReferralViolations("bills/150/x.json", "bills/index.json[0]", b, s).join("\n"), /2000-01-01/);
  });

  test("検査: 日付の無い committee も止まる（照合できない値を通さない）", () => {
    const b: Bill = { id: "221-閣法-3", session: 221, kind: "閣法", house: "shugiin", title: "T", sourceUrl: keika("X"), referral: { shugiin: { committee: "内閣" } } };
    const s: BillSummary = { id: b.id, session: 221, kind: "閣法", house: "shugiin", title: "T", sourceUrl: b.sourceUrl, referredCommittees: [{ house: "shugiin", committee: "内閣" }] };
    assert.match(billReferralViolations("bills/221/x.json", "bills/index.json[0]", b, s).join("\n"), /no date/);
  });

  test("パーサ: 数えていない時期では委員会名を出さず unknownText に入れる", () => {
    // 第142回の fixture の**付託日だけ**を、数えていない時期に書き換える（平成10年 → 平成12年）
    const html = fixture("shugiin-keika-5516").replace(
      /(衆議院付託年月日／衆議院付託委員会<\/span><\/TD>[\s\S]*?)平成10年/,
      "$1平成12年",
    );
    const b = parseShugiinBill(html, keika("5516"));
    assert.equal(b.referral?.shugiin?.date, "2000-03-11", "付託日の書き換えが当たっていない");
    assert.equal(b.referral?.shugiin?.committee, undefined);
    assert.equal(b.referral?.shugiin?.unknownText, "内閣");
    // 参の欄は 1998 年のままなので、そちらは通る（**欄ごとに日付で判定している**ことの確認）
    assert.equal(b.referral?.sangiin?.committee, "労働・社会政策");
    assert.deepEqual(toBillSummary(b).referredCommittees, [{ house: "sangiin", committee: "労働・社会政策" }]);
  });
});
