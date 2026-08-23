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
