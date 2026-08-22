import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import iconv from "iconv-lite";
import {
  parseGroupList, parseNameList, parseShugiinBill, parseShugiinBillList, shugiinBillListUrl, toBillSummary,
} from "../src/sources/shugiin-bills.ts";

// フィクスチャは Shift_JIS の生バイト（2026-08-23 取得）。fetchText と同じく iconv で復号する。
const fixture = (name: string) => iconv.decode(readFileSync(new URL(`./fixtures/${name}.htm`, import.meta.url)), "Shift_JIS");
const BASE = "https://www.shugiin.go.jp/internet/itdb_gian.nsf/html/gian";
const keika = (id: string) => `${BASE}/keika/${id}.htm`;

describe("実HTML: kaiji221.htm（第221回 議案の一覧、衆議院）", () => {
  const items = parseShugiinBillList(fixture("shugiin-kaiji-221"), shugiinBillListUrl(221));

  test("種類ごとの表から経過ページへのリンクを絶対URLで列挙する（163件、重複なし）", () => {
    assert.equal(items.length, 163);
    assert.equal(new Set(items.map((i) => i.href)).size, 163);
    assert.equal(items[0]?.href, keika("1DE153E"));
  });

  test("衆法の行: 提出回次・番号・件名・審議状況（原文）・種類（表の見出し）", () => {
    assert.deepEqual(items[0], {
      href: keika("1DE153E"), kindText: "衆法", session: 221, number: 1,
      title: "政治資金規正法の一部を改正する法律案", status: "衆議院で閉会中審査",
    });
  });

  test("種類ごとの件数は表のとおり（衆法38・参法21・閣法64）", () => {
    const count = (k: string) => items.filter((i) => i.kindText === k).length;
    assert.equal(count("衆法"), 38);
    assert.equal(count("参法"), 21);
    assert.equal(count("閣法"), 64);
  });

  test("番号の無い表（承諾・決算その他）の行は number が undefined で、提出回次は行のまま（219 の継続案件もある）", () => {
    const kessan = items.filter((i) => i.kindText === "決算");
    assert.ok(kessan.length > 0);
    assert.equal(kessan[0]?.number, undefined);
    assert.ok(kessan.some((i) => i.session === 219));
  });

  test("議案の表が無ければ例外（黙って0件にしない）", () => {
    assert.throws(() => parseShugiinBillList("<html><body><p>準備中</p></body></html>", shugiinBillListUrl(221)), /経過/);
  });
});

describe("実HTML: 経過ページ keika/*.htm", () => {
  test("衆法（賛成者多数・閉会中審査）: 提出者一覧と賛成者の氏名は事実として全員残り、会派態度は空欄なので無い", () => {
    const url = keika("1DE153E");
    const bill = parseShugiinBill(fixture("shugiin-keika-1DE153E"), url, { status: "衆議院で閉会中審査" });
    assert.equal(bill.id, "221-衆法-1");
    assert.equal(bill.house, "shugiin");
    assert.equal(bill.kind, "衆法");
    assert.equal(bill.session, 221);
    assert.equal(bill.number, 1);
    assert.equal(bill.title, "政治資金規正法の一部を改正する法律案");
    assert.equal(bill.sourceUrl, url);
    assert.equal(bill.submitterText, "落合　貴之君外四名");
    assert.deepEqual(bill.submitterNames, ["落合貴之", "中野洋昌", "中川康洋", "古川元久", "臼木秀剛"]);
    assert.equal(bill.supporterNames?.length, 69);
    assert.equal(bill.supporterNames?.[0], "赤羽一嘉");
    assert.equal(bill.supporterNames?.at(-1), "森ようすけ");
    assert.deepEqual(bill.submitterGroups, ["中道改革連合・無所属", "国民民主党・無所属クラブ"]);
    assert.equal(bill.shugiinGroupStance, undefined);
    assert.equal(bill.status, "衆議院で閉会中審査");
    assert.deepEqual(bill.received, { shugiin: "2026-03-02" });
    assert.deepEqual(bill.result, { shugiin: "閉会中審査" });
    assert.equal(bill.submitters, undefined);
  });

  test("閣法（会派態度が割れた）: 賛成会派・反対会派は原文の会派名の配列、態度の原文は stanceText、全会一致ではない", () => {
    const bill = parseShugiinBill(fixture("shugiin-keika-1DE14D6"), keika("1DE14D6"));
    assert.equal(bill.id, "221-閣法-3");
    assert.equal(bill.kind, "閣法");
    assert.equal(bill.title, "所得税法等の一部を改正する法律案");
    assert.equal(bill.submitterText, "内閣");
    assert.equal(bill.submitterNames, undefined);
    assert.equal(bill.supporterNames, undefined);
    assert.deepEqual(bill.shugiinGroupStance, {
      stanceText: "多数",
      yes: ["自由民主党・無所属の会", "日本維新の会", "国民民主党・無所属クラブ"],
      no: ["中道改革連合・無所属", "参政党", "チームみらい", "日本共産党"],
    });
    assert.deepEqual(bill.received, { shugiin: "2026-02-20", sangiin: "2026-03-13" });
    assert.deepEqual(bill.result, { shugiin: "可決", sangiin: "可決", promulgated: "2026-03-31", lawNumber: "12" });
  });

  test("閣法（全会一致）: unanimous: true、反対会派は空配列", () => {
    const bill = parseShugiinBill(fixture("shugiin-keika-1DE1582"), keika("1DE1582"));
    assert.equal(bill.shugiinGroupStance?.stanceText, "全会一致");
    assert.equal(bill.shugiinGroupStance?.unanimous, true);
    assert.equal(bill.shugiinGroupStance?.yes.length, 7);
    assert.deepEqual(bill.shugiinGroupStance?.no, []);
  });

  test("閣法（態度「多数」で反対会派が空欄）: ページが全会一致と言っていないので unanimous は付けない（推論しない）", () => {
    const bill = parseShugiinBill(fixture("shugiin-keika-1DE14D2"), keika("1DE14D2"));
    assert.equal(bill.shugiinGroupStance?.stanceText, "多数");
    assert.equal(bill.shugiinGroupStance?.unanimous, undefined);
    assert.deepEqual(bill.shugiinGroupStance?.no, []);
  });

  test("衆法（委員長提出・全会一致）: 提出者は委員長1名、賛成者欄は空", () => {
    const bill = parseShugiinBill(fixture("shugiin-keika-1DE1E6A"), keika("1DE1E6A"));
    assert.equal(bill.submitterText, "国土交通委員長");
    assert.deepEqual(bill.submitterNames, ["冨樫博之"]);
    assert.deepEqual(bill.supporterNames, []);
    assert.equal(bill.shugiinGroupStance?.unanimous, true);
  });

  test("衆法（少数・否決）: 態度は原文「少数」、結果は原文「否決」", () => {
    const bill = parseShugiinBill(fixture("shugiin-keika-1DE1E7E"), keika("1DE1E7E"));
    assert.equal(bill.shugiinGroupStance?.stanceText, "少数");
    assert.deepEqual(bill.shugiinGroupStance?.yes, ["中道改革連合・無所属", "国民民主党・無所属クラブ"]);
    assert.equal(bill.result?.shugiin, "否決");
  });

  test("参法: 提出者一覧の表が無く、衆院未審議なので会派態度も無い。参院受理日は残る", () => {
    const bill = parseShugiinBill(fixture("shugiin-keika-1DE213E"), keika("1DE213E"));
    assert.equal(bill.kind, "参法");
    assert.equal(bill.id, "221-参法-1");
    assert.equal(bill.submitterText, "竹詰　仁君外一名");
    assert.equal(bill.submitterNames, undefined);
    assert.equal(bill.shugiinGroupStance, undefined);
    assert.deepEqual(bill.received, { sangiin: "2026-03-19" });
  });

  test("決算（番号なし・提出回次219）: id は番号の代わりに経過ページの id、kind は その他 で kindText に原文", () => {
    const bill = parseShugiinBill(fixture("shugiin-keika-1DE115E"), keika("1DE115E"));
    assert.equal(bill.kind, "その他");
    assert.equal(bill.kindText, "決算");
    assert.equal(bill.session, 219);
    assert.equal(bill.number, undefined);
    assert.equal(bill.id, "219-決算-1DE115E");
  });

  test("決議案: 議員提出なので提出者一覧・賛成者がある", () => {
    const bill = parseShugiinBill(fixture("shugiin-keika-1DE1FF6"), keika("1DE1FF6"));
    assert.equal(bill.kind, "決議");
    assert.equal(bill.id, "221-決議-1");
    assert.deepEqual(bill.submitterNames, ["重徳和彦", "伊佐進一", "和田政宗", "峰島侑也", "塩川鉄也"]);
    assert.ok((bill.supporterNames?.length ?? 0) > 5);
  });

  test("件名が無ければ例外", () => {
    assert.throws(() => parseShugiinBill("<html><body><table></table></body></html>", keika("X")), /件名/);
  });
});

describe("会派名の表記ゆれ（テーブル駆動）", () => {
  const table: [string, string[]][] = [
    ["自由民主党・無所属の会; 日本維新の会", ["自由民主党・無所属の会", "日本維新の会"]],
    ["自由民主党・無所属の会;日本維新の会", ["自由民主党・無所属の会", "日本維新の会"]],
    ["自由民主党・無所属の会；日本維新の会", ["自由民主党・無所属の会", "日本維新の会"]],
    ["自由民主党・無所属の会;\n日本維新の会", ["自由民主党・無所属の会", "日本維新の会"]],
    ["　自由民主党・無所属の会　; 日本維新の会 ;", ["自由民主党・無所属の会", "日本維新の会"]],
    ["日本共産党", ["日本共産党"]],
    ["", []],
    ["<br>", []],
  ];
  for (const [input, expected] of table) {
    test(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      assert.deepEqual(parseGroupList(input), expected);
    });
  }
});

describe("氏名一覧（「君」付き・; 区切り）", () => {
  const table: [string, string[]][] = [
    ["落合貴之君; 中野洋昌君", ["落合貴之", "中野洋昌"]],
    ["冨樫博之君", ["冨樫博之"]],
    ["森ようすけ君; 井戸まさえ君", ["森ようすけ", "井戸まさえ"]],
    ["", []],
  ];
  for (const [input, expected] of table) {
    test(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      assert.deepEqual(parseNameList(input), expected);
    });
  }
});

describe("bills/index.json の行", () => {
  test("一覧用の軽量な行（id・回次・種別・件名・院・状況・出典）", () => {
    const bill = parseShugiinBill(fixture("shugiin-keika-1DE14D6"), keika("1DE14D6"), { status: "成立" });
    assert.deepEqual(toBillSummary(bill), {
      id: "221-閣法-3", session: 221, kind: "閣法", house: "shugiin", title: "所得税法等の一部を改正する法律案",
      status: "成立", sourceUrl: keika("1DE14D6"),
    });
  });
});
