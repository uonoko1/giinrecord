import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { RollCall } from "@seiji-kiroku/shared";
import { committeeBills, matchBillResults, normalizeTitle, parseBill, parseBillList, parseProposers, type BillDecision } from "../src/sources/sangiin-bills.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.htm`, import.meta.url), "utf-8");
const GIAN = "https://www.sangiin.go.jp/japanese/joho1/kousei/gian/221";
const VOTES = "https://www.sangiin.go.jp/japanese/touhyoulist/221";

describe("実HTML: gian.htm（第221回 議案情報 一覧）", () => {
  const bills = parseBillList(fixture("gian-221"), `${GIAN}/gian.htm`);

  test("全カテゴリの議案詳細ページが絶対URLで列挙される（173件）", () => {
    assert.equal(bills.length, 173);
    assert.equal(bills[0]?.href, `${GIAN}/meisai/m221080221001.htm`);
    assert.equal(bills[0]?.title, "財政運営に必要な財源の確保を図るための公債の発行の特例に関する法律の一部を改正する法律案");
    assert.equal(bills[0]?.category, "法律案（内閣提出）");
  });

  test("人事案件（議案要旨PDFのない行）も拾う", () => {
    const jinji = bills.filter((b) => b.category === "人事案件");
    assert.equal(jinji.length, 16);
    assert.equal(jinji[0]?.title, "人事官に菅原晶子君を任命することについて同意を求めるの件");
  });

  test("href は重複しない", () => {
    assert.equal(new Set(bills.map((b) => b.href)).size, bills.length);
  });

  test("議案の表が無ければ空ではなく例外（黙って0件にしない）", () => {
    assert.throws(() => parseBillList("<html><body><p>準備中</p></body></html>", `${GIAN}/gian.htm`), /議案/);
  });
});

describe("実HTML: 議案詳細ページ", () => {
  test("内閣提出法律案: 参議院本会議の議決と投票結果ページの id が取れる", () => {
    const url = `${GIAN}/meisai/m221080221001.htm`;
    const bill = parseBill(fixture("meisai-m221080221001"), url);
    assert.equal(bill.title, "財政運営に必要な財源の確保を図るための公債の発行の特例に関する法律の一部を改正する法律案");
    assert.equal(bill.category, "法律案（内閣提出）");
    assert.equal(bill.sourceUrl, url);
    assert.deepEqual(bill.plenary, [{ decision: "可決", rollCallId: "221-0331-v009" }]);
  });

  test("人事案件: 議決は原文「同意」のまま（可決に言い換えない）", () => {
    const bill = parseBill(fixture("meisai-m221400221001"), `${GIAN}/meisai/m221400221001.htm`);
    assert.equal(bill.category, "人事案件");
    assert.deepEqual(bill.plenary, [{ decision: "同意", rollCallId: "221-0323-v001" }]);
  });

  test("国有財産増減等計算書: 議決は原文「是認」", () => {
    const bill = parseBill(fixture("meisai-m221500219001"), `${GIAN}/meisai/m221500219001.htm`);
    assert.deepEqual(bill.plenary, [{ decision: "是認", rollCallId: "221-0708-v003" }]);
  });

  test("参議院本会議で未議決（議決欄が空）の議案は plenary が空。衆議院の議決は使わない", () => {
    const bill = parseBill(fixture("meisai-m221090221025"), `${GIAN}/meisai/m221090221025.htm`);
    assert.equal(bill.title, "大都市地域における特別区の設置に関する法律の一部を改正する法律案");
    assert.deepEqual(bill.plenary, []);
  });

  test("件名が取れなければ例外", () => {
    assert.throws(() => parseBill("<html><body></body></html>", `${GIAN}/meisai/x.htm`), /件名/);
  });

  test("内閣提出法律案: 発議者は無く、回次・番号・提出日・審議状況（公布済み）が取れる", () => {
    const bill = parseBill(fixture("meisai-m221080221001"), `${GIAN}/meisai/m221080221001.htm`);
    assert.equal(bill.id, "221-閣法-1");
    assert.equal(bill.submittedOn, "2026-02-20");
    assert.equal(bill.proposerText, undefined);
    assert.deepEqual(bill.proposers, []);
    assert.equal(bill.status, "公布（法律第13号）");
  });
});

describe("実HTML: 参法の議案詳細ページ（発議者）", () => {
  test("発議者が複数（「打越さく良君 外9名」）: 名前は筆頭の1人だけが原文で載る。外9名の氏名はページに無いので推測しない", () => {
    const url = `${GIAN}/meisai/m221100221016.htm`;
    const bill = parseBill(fixture("meisai-m221100221016"), url);
    assert.equal(bill.id, "221-参法-16");
    assert.equal(bill.category, "法律案（参法）");
    assert.equal(bill.title, "国による全ての水俣病の被害者の救済の実現に向けた給付金等の支給に係る制度の創設に関する法律案");
    assert.equal(bill.submittedOn, "2026-07-09");
    assert.equal(bill.proposerText, "打越さく良君 外9名");
    assert.deepEqual(bill.proposers, ["打越さく良"]);
    assert.equal(bill.status, undefined);
    assert.deepEqual(bill.plenary, []);
  });

  test("発議者が1人（「原田秀一君」）: 外N名が無い", () => {
    const bill = parseBill(fixture("meisai-m221100221017"), `${GIAN}/meisai/m221100221017.htm`);
    assert.equal(bill.id, "221-参法-17");
    assert.equal(bill.submittedOn, "2026-07-10");
    assert.equal(bill.proposerText, "原田秀一君");
    assert.deepEqual(bill.proposers, ["原田秀一"]);
    assert.equal(bill.status, undefined);
  });

  test("委員会で「未了」: 審議状況は段階名＋原文", () => {
    const bill = parseBill(fixture("meisai-m221100221020"), `${GIAN}/meisai/m221100221020.htm`);
    assert.equal(bill.proposerText, "奥村祥大君 外1名");
    assert.equal(bill.status, "参議院 沖縄・北方問題及び地方に関する特別委員会 未了");
  });

  test("衆法の発議者（衆議院議員）も原文のまま取れる（名寄せ側で参法だけを使う）", () => {
    const bill = parseBill(fixture("meisai-m221090221025"), `${GIAN}/meisai/m221090221025.htm`);
    assert.equal(bill.id, "221-衆法-25");
    assert.equal(bill.proposerText, "西岡義高君 外1名");
    assert.deepEqual(bill.proposers, ["西岡義高"]);
    assert.equal(bill.status, "衆議院本会議 否決");
  });
});

describe("実HTML: 委員会提出の参法（第217回 参法5 自殺対策基本法改正案、「提出者 厚生労働委員長」）", () => {
  const GIAN217 = "https://www.sangiin.go.jp/japanese/joho1/kousei/gian/217";
  const bill = parseBill(fixture("meisai-m217100217005"), `${GIAN217}/meisai/m217100217005.htm`);

  test("発議者欄が無く「提出者」欄に委員長名（原文）が載る。個人の氏名ではないので proposers は空", () => {
    assert.equal(bill.id, "217-参法-5");
    assert.equal(bill.kind, "参法");
    assert.equal(bill.submittedOn, "2025-04-15");
    assert.equal(bill.proposerText, undefined);
    assert.equal(bill.submitterText, "厚生労働委員長");
    assert.equal(bill.submitterKind, "委員会発議");
    assert.deepEqual(bill.proposers, []);
  });

  test("議員発議の参法は「提出者区分」が原文「議員発議」で、提出者欄は無い", () => {
    const b = parseBill(fixture("meisai-m221100221016"), `${GIAN}/meisai/m221100221016.htm`);
    assert.equal(b.submitterKind, "議員発議");
    assert.equal(b.submitterText, undefined);
  });

  test("閣法には提出者欄も提出者区分も無い", () => {
    const b = parseBill(fixture("meisai-m221080221001"), `${GIAN}/meisai/m221080221001.htm`);
    assert.equal(b.submitterKind, undefined);
    assert.equal(b.submitterText, undefined);
  });

  test("committeeBills: 参法のうち発議者の氏名が無い（委員会発議）ものを数えられる（黙ってスキップしない）", () => {
    const other = parseBill(fixture("meisai-m221100221016"), `${GIAN}/meisai/m221100221016.htm`);
    const shuho = parseBill(fixture("meisai-m221090221025"), `${GIAN}/meisai/m221090221025.htm`);
    assert.deepEqual(committeeBills([bill, other, shuho]).map((b) => `${b.id} ${b.submitterText}`), ["217-参法-5 厚生労働委員長"]);
  });
});

describe("parseProposers: 発議者欄の原文から氏名を取り出す", () => {
  test("「君」を除き、「外N名」は氏名ではないので含めない", () => {
    assert.deepEqual(parseProposers("打越さく良君 外9名"), ["打越さく良"]);
    assert.deepEqual(parseProposers("原田秀一君"), ["原田秀一"]);
  });
  test("空欄なら空", () => {
    assert.deepEqual(parseProposers(""), []);
  });
});

describe("normalizeTitle: 投票結果の案件名から装飾を除く", () => {
  test("「日程第N」と末尾の「（…提出、…送付）」を除く", () => {
    assert.equal(normalizeTitle("日程第９　経済社会情勢の変化を踏まえた産業競争力強化法等の一部を改正する法律案（内閣提出、衆議院送付）"),
      "経済社会情勢の変化を踏まえた産業競争力強化法等の一部を改正する法律案");
    assert.equal(normalizeTitle("日程第１２　建築士法の一部を改正する法律案（衆議院提出）"), "建築士法の一部を改正する法律案");
    assert.equal(normalizeTitle("大都市地域における特別区の設置に関する法律の一部を改正する法律案（奥村祥大君外３名発議）"),
      "大都市地域における特別区の設置に関する法律の一部を改正する法律案");
  });
  test("件名の一部である括弧（第１号・（ａ）など）は残す", () => {
    assert.equal(normalizeTitle("日程第１　令和八年度一般会計補正予算（第１号）"), "令和八年度一般会計補正予算（第１号）");
    assert.equal(normalizeTitle("国際民間航空条約第五十条（ａ）の改正に関する議定書の締結について承認を求めるの件（衆議院送付）"),
      "国際民間航空条約第五十条（ａ）の改正に関する議定書の締結について承認を求めるの件");
  });
  test("空白は正規化する", () => {
    assert.equal(normalizeTitle("  所得税法等の一部を改正する法律案 "), "所得税法等の一部を改正する法律案");
  });
});

const rc = (id: string, title: string): RollCall => ({
  id, session: 221, date: "2026-03-31", title, totals: { total: 0, yes: 0, no: 0 }, groups: [], votes: [], sourceUrl: `${VOTES}/${id}.htm`,
});
const decision = (d: Partial<BillDecision> & { title: string; decision: string }): BillDecision => ({ sourceUrl: `${GIAN}/meisai/m.htm`, ...d });

describe("matchBillResults: 採決と議案の審議結果の突合", () => {
  test("議案ページが投票結果ページの id を指していればそれで紐づく（案件名が異なっても）", () => {
    const { results, unmatched } = matchBillResults(
      [rc("221-0331-v009", "日程第３　公債特例法案（内閣提出、衆議院送付）")],
      [decision({ title: "財政運営に必要な財源の確保を図るための公債の発行の特例に関する法律の一部を改正する法律案", decision: "可決", rollCallId: "221-0331-v009" })],
    );
    assert.deepEqual(results.get("221-0331-v009"), { decision: "可決", sourceUrl: `${GIAN}/meisai/m.htm` });
    assert.deepEqual(unmatched, []);
  });

  test("id の紐づけが無ければ、装飾を除いた案件名で一意に突合する", () => {
    const { results, unmatched } = matchBillResults(
      [rc("221-0331-v012", "日程第５　所得税法等の一部を改正する法律案（内閣提出、衆議院送付）")],
      [decision({ title: "所得税法等の一部を改正する法律案", decision: "可決" })],
    );
    assert.equal(results.get("221-0331-v012")?.decision, "可決");
    assert.deepEqual(unmatched, []);
  });

  test("同名の議案が複数あって結果が割れる場合は突合しない（推測しない）", () => {
    const { results, unmatched } = matchBillResults(
      [rc("221-0601-v001", "Ａ法案（衆議院提出）")],
      [decision({ title: "Ａ法案", decision: "可決" }), decision({ title: "Ａ法案", decision: "否決" })],
    );
    assert.equal(results.size, 0);
    assert.equal(unmatched.length, 1);
  });

  test("突合できない採決は unmatched に列挙され、例外にはならない", () => {
    const { results, unmatched } = matchBillResults([rc("221-0601-v002", "日程第１　○○に関する決議案")], []);
    assert.equal(results.size, 0);
    assert.deepEqual(unmatched, [{ rollCallId: "221-0601-v002", title: "日程第１　○○に関する決議案", sourceUrl: `${VOTES}/221-0601-v002.htm` }]);
  });
});
