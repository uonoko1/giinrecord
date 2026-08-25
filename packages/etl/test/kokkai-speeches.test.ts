import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSpeechPage, speechPageUrl, toExcerpt } from "../src/sources/kokkai-speeches.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf-8")) as unknown;

describe("speechPageUrl: 国会会議録API speech の URL", () => {
  test("参議院・本会議・回次・JSON・100件・startRecord を指定する", () => {
    const u = new URL(speechPageUrl(221, 101));
    assert.equal(u.origin + u.pathname, "https://kokkai.ndl.go.jp/api/speech");
    assert.equal(u.searchParams.get("nameOfHouse"), "参議院");
    assert.equal(u.searchParams.get("nameOfMeeting"), "本会議");
    assert.equal(u.searchParams.get("sessionFrom"), "221");
    assert.equal(u.searchParams.get("sessionTo"), "221");
    assert.equal(u.searchParams.get("recordPacking"), "json");
    assert.equal(u.searchParams.get("maximumRecords"), "100");
    assert.equal(u.searchParams.get("startRecord"), "101");
  });

  test("house を shugiin にすると nameOfHouse=衆議院 になる（Issue #73: 衆院本会議も対象）", () => {
    const u = new URL(speechPageUrl(221, 1, "shugiin"));
    assert.equal(u.searchParams.get("nameOfHouse"), "衆議院");
    assert.equal(u.searchParams.get("nameOfMeeting"), "本会議");
    assert.equal(new URL(speechPageUrl(221, 1, "sangiin")).searchParams.get("nameOfHouse"), "参議院");
  });

  /**
   * Issue #242: 委員会も収録する。API は nameOfMeeting を外すだけで委員会・分科会・審査会・連合審査会・
   * 公聴会・調査会を同じ形で返す（#263 が第221回 70,544 件で確認、#242 が第201・204回の分科会で確認）。
   */
  test('scope "all" は nameOfMeeting を付けない（委員会を含む全会議。#242）', () => {
    const u = new URL(speechPageUrl(221, 1, "shugiin", "all"));
    assert.equal(u.searchParams.get("nameOfMeeting"), null);
    assert.equal(u.searchParams.get("nameOfHouse"), "衆議院");
    assert.equal(u.searchParams.get("sessionFrom"), "221");
    assert.equal(u.searchParams.get("sessionTo"), "221");
    assert.equal(u.searchParams.get("maximumRecords"), "100");
  });

  test('scope の既定は "plenary"（本会議のみ）で、既存の URL と byte-identical（#242 が既定の挙動を変えない）', () => {
    assert.equal(speechPageUrl(221, 1, "sangiin"), speechPageUrl(221, 1, "sangiin", "plenary"));
    assert.equal(new URL(speechPageUrl(200, 301, "shugiin", "plenary")).searchParams.get("nameOfMeeting"), "本会議");
  });
});

describe("parseSpeechPage: house 引数（Issue #73）", () => {
  test("既定は sangiin、shugiin を渡すと全発言の house が shugiin になる", () => {
    const json = fixture("kokkai-speech-221-p1");
    assert.ok(parseSpeechPage(json).speeches.every((s) => s.house === "sangiin"));
    const page = parseSpeechPage(json, "shugiin");
    assert.ok(page.speeches.length > 0);
    assert.ok(page.speeches.every((s) => s.house === "shugiin"));
  });
});

describe("parseSpeechPage: 実レスポンス（第221回 参院本会議）", () => {
  const page = parseSpeechPage(fixture("kokkai-speech-221-p1"));

  test("ページング情報を返す（1ページ目: 544件中100件、次は101）", () => {
    assert.equal(page.numberOfRecords, 544);
    assert.equal(page.nextRecordPosition, 101);
  });

  test("最終ページは nextRecordPosition が null", () => {
    assert.equal(parseSpeechPage(fixture("kokkai-speech-221-p6")).nextRecordPosition, null);
  });

  test("speechOrder 0 の「会議録情報」（議事日程）は発言ではないので除く", () => {
    assert.equal(page.speeches.length, 100 - 3);
    assert.ok(page.speeches.every((s) => s.speakerText !== "会議録情報"));
  });

  test("議員の発言: id・話者・会派・会議名・日付・出典URL・冒頭200字・文字数", () => {
    const s = page.speeches.find((x) => x.id === "122115254X01920260605_002")!;
    assert.equal(s.speakerText, "藤川政人");
    assert.equal(s.group, "自由民主党・無所属の会");
    assert.equal(s.position, undefined);
    assert.equal(s.house, "sangiin");
    assert.equal(s.meeting, "本会議 第19号");
    assert.equal(s.date, "2026-06-05");
    assert.equal(s.sourceUrl, "https://kokkai.ndl.go.jp/txt/122115254X01920260605/2");
    assert.equal(s.memberId, undefined);
    assert.ok(s.excerpt.startsWith("ただいま議題となりました令和八年度補正予算二案の審査の経過と結果を御報告申し上げます。"));
    assert.equal([...s.excerpt].length, 200);
    assert.ok(s.chars > 200);
  });

  test("議長・大臣の発言は position を持つ", () => {
    const chair = page.speeches.find((x) => x.id === "122115254X01920260605_001")!;
    assert.equal(chair.position, "議長");
    assert.equal(chair.group, "各派に属しない議員");
    const pm = page.speeches.find((x) => x.speakerText === "高市早苗")!;
    assert.equal(pm.position, "内閣総理大臣");
  });

  test("短い発言は全文が excerpt になり、chars と一致する", () => {
    const s = page.speeches.find((x) => x.id === "122115254X01920260605_005")!;
    assert.equal(s.excerpt, "加藤明良君。 〔加藤明良君登壇、拍手〕");
    assert.equal(s.chars, [...s.excerpt].length);
  });

  test("speechRecord が欠けたレスポンスは例外（黙って空にしない）", () => {
    assert.throws(() => parseSpeechPage({ numberOfRecords: 1 }), /speechRecord/);
    assert.throws(() => parseSpeechPage("oops"), /speechRecord/);
  });

  test("必須項目（speechID・date・speaker）が欠けたレコードは例外", () => {
    assert.throws(() => parseSpeechPage({ numberOfRecords: 1, nextRecordPosition: null, speechRecord: [{ speechID: "x", speechOrder: 1 }] }), /x/);
  });
});

/**
 * 実レスポンス（第221回 衆院本会議、1ページ目）。Issue #107。
 * 取得: 2026-08-23T06:51Z, curl -A "Mozilla/5.0" speechPageUrl(221, 1, "shugiin")
 */
describe("parseSpeechPage: 実レスポンス（第221回 衆院本会議、Issue #107）", () => {
  const json = fixture("kokkai-speech-shugiin-221-p1");
  const page = parseSpeechPage(json, "shugiin");

  test("ページング情報を返す（1ページ目: 919件中100件、次は101）", () => {
    assert.equal(page.numberOfRecords, 919);
    assert.equal(page.nextRecordPosition, 101);
  });

  test("speechOrder 0 の「会議録情報」を除き、全発言の house が shugiin になる", () => {
    assert.equal(page.speeches.length, 100 - 9);
    assert.ok(page.speeches.every((s) => s.house === "shugiin" && s.speakerText !== "会議録情報"));
  });

  test("衆院議員の発言: 話者・会派・会議名・日付・出典URL・冒頭抜粋", () => {
    const s = page.speeches.find((x) => x.id === "122105254X03520260724_002")!;
    assert.equal(s.speakerText, "小寺裕雄");
    assert.equal(s.group, "自由民主党・無所属の会");
    assert.equal(s.position, undefined);
    assert.equal(s.meeting, "本会議 第35号");
    assert.equal(s.date, "2026-07-24");
    assert.equal(s.sourceUrl, "https://kokkai.ndl.go.jp/txt/122105254X03520260724/2");
    assert.ok(s.excerpt.length > 0 && !s.excerpt.startsWith("○"));
    assert.ok(s.chars >= [...s.excerpt].length);
  });

  test("衆院議長の発言は position「議長」を保持する（#35 と同じ扱い）", () => {
    const chair = page.speeches.find((x) => x.id === "122105254X03520260724_001")!;
    assert.equal(chair.speakerText, "森英介");
    assert.equal(chair.position, "議長");
    assert.equal(chair.group, "無所属");
  });

  test("参院の解釈は衆院フィクスチャを足しても変わらない（house 省略 = sangiin と同一）", () => {
    const sangiin = fixture("kokkai-speech-221-p1");
    assert.deepEqual(parseSpeechPage(sangiin), parseSpeechPage(sangiin, "sangiin"));
    assert.equal(speechPageUrl(221, 1), speechPageUrl(221, 1, "sangiin"));
  });
});

/**
 * 実レスポンス（第204回 衆院 予算委員会第一分科会、Issue #242）。
 * 取得: 2026-08-25, UA gikailog-etl/0.1, speechPageUrl(204, 1, "shugiin") に nameOfMeeting=分科会 を足したもの。
 * 1ページ100件のうち、先頭30件と speakerRole の付く5件（参考人）を speechID 順に残した35件。
 *
 * #263 は第221回（特別会）を全量取得したが、その回次には分科会が1件も無かったため
 * 「分科会のレコードの形は未確認」と flag していた。#242 でその1点を実データで確認する。
 * 作りの違う2つ以上の実データでテストする（docs/WORKING_AGREEMENT.md）ため、
 * 本会議のフィクスチャ（第221回 参院・衆院）と並べて同じパーサに通す。
 */
describe("parseSpeechPage: 実レスポンス（第204回 衆院 予算委員会第一分科会、Issue #242）", () => {
  const page = parseSpeechPage(fixture("kokkai-speech-shugiin-204-bunkakai-p1"), "shugiin");

  test("本会議と同じパーサで読める（改造不要）: speechOrder 0 を除いた34件", () => {
    assert.equal(page.numberOfRecords, 3861);
    assert.equal(page.speeches.length, 35 - 1);
    assert.ok(page.speeches.every((s) => s.house === "shugiin" && s.speakerText !== "会議録情報"));
  });

  test("会議名は原文（「予算委員会第一分科会 第2号」）。本会議と区別できる", () => {
    assert.ok(page.speeches.every((s) => s.meeting === "予算委員会第一分科会 第2号"));
  });

  test("分科会の主査（議員）は会派を持ち、名寄せの材料になる", () => {
    const s = page.speeches.find((x) => x.id === "120405266X00220210226_001")!;
    assert.equal(s.speakerText, "藤原崇");
    assert.equal(s.group, "自由民主党・無所属の会");
    assert.equal(s.position, undefined);
    assert.equal(s.date, "2021-02-26");
    assert.equal(s.session, 204);
    assert.equal(s.sourceUrl, "https://kokkai.ndl.go.jp/txt/120405266X00220210226/1");
    assert.ok(s.excerpt.startsWith("これより予算委員会第一分科会を開会いたします。"));
  });

  test("政府参考人は会派を持たず position（原文の肩書き）だけを持つ", () => {
    const s = page.speeches.find((x) => x.id === "120405266X00220210226_007")!;
    assert.equal(s.speakerText, "梶尾雅宏");
    assert.equal(s.group, undefined);
    assert.equal(s.position, "内閣官房内閣審議官");
  });

  test("参考人（speakerRole=参考人）も会派を持たず position だけを持つ（#263 が全量で観測した性質）", () => {
    const s = page.speeches.find((x) => x.id === "120405266X00220210226_073")!;
    assert.equal(s.speakerText, "尾身茂");
    assert.equal(s.group, undefined);
    assert.equal(s.position, "独立行政法人地域医療機能推進機構理事長");
  });

  test("話者表示（○◯◯主査 / ○◯◯政府参考人 / ○◯◯参考人）は全件 excerpt から落ちる", () => {
    assert.ok(page.speeches.every((s) => !s.excerpt.startsWith("○")));
  });

  /**
   * #230 と #242 の境界。#230 以降 `matchSpeeches` は回次を呼び出し側から受け取らず、
   * **発言レコード自身の `session` と `date`** を `resolveMember` に渡して在職を確認する
   * （`resolveMember(index, nameText, group, { session, date })`）。
   * どちらかが欠けると `tenureVerified` が判定できず、**その発言は例外にもならず黙って未突合になる**。
   * 委員会のレコードでも必ず埋まっていることを固定する（実データでの確認: 第219回の衆参 20,162 件・
   * 第204回の分科会 34 件で欠け 0。2026-08-25 実測）。
   */
  test("委員会のレコードも session（整数）と date（YYYY-MM-DD）を必ず持つ（#230 の在職確認の入力）", () => {
    assert.ok(page.speeches.length > 0);
    for (const s of page.speeches) {
      assert.equal(s.session, 204, s.id);
      assert.match(s.date, /^\d{4}-\d{2}-\d{2}$/, s.id);
    }
  });

  test("session が無いレコードは例外（黙って未突合にしない）", () => {
    const rec = { speechID: "x_001", speechOrder: 1, speaker: "誰か", nameOfMeeting: "予算委員会第一分科会", issue: "第2号", date: "2021-02-26", speech: "○誰か　本文", speechURL: "https://kokkai.ndl.go.jp/txt/x/1" };
    assert.throws(() => parseSpeechPage({ numberOfRecords: 1, nextRecordPosition: null, speechRecord: [rec] }, "shugiin"), /session/);
    const { date: _drop, ...noDate } = { ...rec, session: 204 };
    assert.throws(() => parseSpeechPage({ numberOfRecords: 1, nextRecordPosition: null, speechRecord: [noDate] }, "shugiin"), /date/);
  });
});

describe("toExcerpt: 冒頭抜粋（要約しない）", () => {
  const cases: [string, string, string, number][] = [
    ["冒頭の「○話者名君　」を除く", "○藤川政人君　本文。", "本文。", 3],
    ["役職付きの話者名も除く", "○議長（関口昌一君）　これより会議を開きます。", "これより会議を開きます。", 12],
    ["改行・全角空白の連続は1つの空白に", "○Ａ君　一行目。\r\n　　二行目。", "一行目。 二行目。", 9],
    ["話者名の無い本文はそのまま", "本文のみ。", "本文のみ。", 5],
  ];
  for (const [label, input, excerpt, chars] of cases) {
    test(label, () => assert.deepEqual(toExcerpt(input), { excerpt, chars }));
  }
  test("200字を超える本文は先頭200字（コードポイント単位）で切る", () => {
    const body = "あ".repeat(150) + "𠮷".repeat(100);
    const r = toExcerpt(`○Ａ君　${body}`);
    assert.equal([...r.excerpt].length, 200);
    assert.equal(r.chars, 250);
  });
});
