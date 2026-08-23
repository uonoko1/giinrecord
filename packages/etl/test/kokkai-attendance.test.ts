import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { attendancePageUrl, kanjiNumber, parseAttendancePage, parseMeetingHeader } from "../src/sources/kokkai-attendance.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf-8")) as unknown;

describe("attendancePageUrl: 会議録API speech の URL（出席者欄に「発議者」を含む参議院の会議録情報）", () => {
  test("参議院・回次・speaker=会議録情報・any=発議者・JSON・100件・startRecord", () => {
    const u = new URL(attendancePageUrl(221, 101));
    assert.equal(u.origin + u.pathname, "https://kokkai.ndl.go.jp/api/speech");
    assert.equal(u.searchParams.get("nameOfHouse"), "参議院");
    assert.equal(u.searchParams.get("speaker"), "会議録情報");
    assert.equal(u.searchParams.get("any"), "発議者");
    assert.equal(u.searchParams.get("sessionFrom"), "221");
    assert.equal(u.searchParams.get("sessionTo"), "221");
    assert.equal(u.searchParams.get("recordPacking"), "json");
    assert.equal(u.searchParams.get("maximumRecords"), "100");
    assert.equal(u.searchParams.get("startRecord"), "101");
    assert.equal(u.searchParams.get("nameOfMeeting"), null);
  });
});

describe("kanjiNumber: 案件の（参第一一号）の漢数字（位取りなし）を数値にする", () => {
  test("一桁・二桁（一〇・一一・五三）", () => {
    assert.equal(kanjiNumber("七"), 7);
    assert.equal(kanjiNumber("一〇"), 10);
    assert.equal(kanjiNumber("一一"), 11);
    assert.equal(kanjiNumber("五三"), 53);
  });
  test("十・百などの位取り文字は解釈しない（例外。推測しない）", () => {
    assert.throws(() => kanjiNumber("十一"), /十/);
  });
});

describe("parseAttendancePage: 実レスポンス（第221回 参議院、出席者欄に発議者を含む会議録 6 件）", () => {
  const page = parseAttendancePage(fixture("kokkai-attendance-221"), 221);

  test("ページング情報を返す（6 件、次ページ無し）", () => {
    assert.equal(page.numberOfRecords, 6);
    assert.equal(page.nextRecordPosition, null);
  });

  test("参法が案件にある会議録だけが残る（農林水産委員会 第14号・第16号の 2 件）。衆法・憲法審査会は残らない", () => {
    assert.deepEqual(page.meetings.map((m) => m.id), ["122115007X01620260716_000", "122115007X01420260709_000"]);
  });

  test("第14号（7/9）: 出席した発議者 5 名（氏名の全角空白は除く）・会議名・日付・出典・案件の参法", () => {
    const m = page.meetings.find((x) => x.id === "122115007X01420260709_000")!;
    assert.equal(m.session, 221);
    assert.equal(m.meeting, "農林水産委員会 第14号");
    assert.equal(m.date, "2026-07-09");
    assert.equal(m.sourceUrl, "https://kokkai.ndl.go.jp/txt/122115007X01420260709/0");
    assert.deepEqual(m.attendees.map((a) => a.nameText), ["舟山康江", "徳永エリ", "高橋光男", "杉本純子", "岩渕友"]);
    assert.ok(m.attendees.every((a) => a.role === "発議者"));
    assert.deepEqual(m.bills, [{ billId: "221-参法-11", title: "主要農作物の優良な品種を確保するための公的新品種育成の促進等に関する法律案" }]);
  });

  test("第16号（7/16）: 出席した発議者は 2 名だけ（全員ではない事実をそのまま）", () => {
    const m = page.meetings.find((x) => x.id === "122115007X01620260716_000")!;
    assert.deepEqual(m.attendees.map((a) => a.nameText), ["舟山康江", "徳永エリ"]);
  });
});

describe("parseAttendancePage: 実レスポンス（第217回）。衆議院議員の発議者（衆法）は採らない", () => {
  const page = parseAttendancePage(fixture("kokkai-attendance-217"), 217);

  test("厚生労働委員会 第14〜16号（参第七号）だけが残り、財政金融委員会・政治改革特（衆法の発議者＝衆議院議員）は残らない", () => {
    assert.deepEqual(page.meetings.map((m) => m.id), ["121714260X01620250529_000", "121714260X01520250527_000", "121714260X01420250522_000"]);
  });

  test("第14号: 発議者欄の後に「衆議院議員」見出しがあっても、見出しより前の発議者 2 名だけを採る", () => {
    const m = page.meetings.find((x) => x.id === "121714260X01420250522_000")!;
    assert.deepEqual(m.attendees.map((a) => a.nameText), ["石橋通宏", "田村まみ"]);
    assert.deepEqual(m.bills, [{ billId: "217-参法-7", title: "労働安全衛生法及び特定受託事業者に係る取引の適正化等に関する法律の一部を改正する法律案" }]);
  });
});

describe("parseMeetingHeader: 出席者欄と案件の解析（境界）", () => {
  const header = (lines: string[]) => lines.join("\r\n");

  test("「衆議院議員」見出しの下の発議者は衆議院議員なので採らない。見出しが切り替わったら（国務大臣など）も採らない", () => {
    const h = parseMeetingHeader(header([
      "　　出席者は左のとおり。",
      "　　　　委員長　　　　　　　　　藤木　眞也君",
      "　　　衆議院議員",
      "　　　　　　　発議者　　　　　　松野　博一君",
      "　　　国務大臣",
      "　　　　　　　発議者　　　　　　誰か　　某君",
      "　　本日の会議に付した案件",
      "○何かの法律案（参第一号）",
    ]), 221);
    assert.deepEqual(h.attendees, []);
    assert.deepEqual(h.bills, [{ billId: "221-参法-1", title: "何かの法律案" }]);
  });

  test("「委員以外の議員」見出しの下の発議者は参議院議員なので採る", () => {
    const h = parseMeetingHeader(header([
      "　　出席者は左のとおり。",
      "　　　委員以外の議員",
      "　　　　　　　発議者　　　　　　石橋　通宏君",
      "　　本日の会議に付した案件",
      "○何かの法律案（参第七号）",
    ]), 217);
    assert.deepEqual(h.attendees, [{ role: "発議者", nameText: "石橋通宏" }]);
  });

  test("案件の参法は複数あれば全部（衆法・閣法は採らない）。案件欄より後の発議者は採らない", () => {
    const h = parseMeetingHeader(header([
      "　　出席者は左のとおり。",
      "　　　　　　　発議者　　　　　　石橋　通宏君",
      "　　本日の会議に付した案件",
      "○Ａ法律案（参第一号）",
      "○Ｂ法律案（衆第二号）（衆議院提出）",
      "○Ｃ法律案（閣法第三号）（衆議院送付）",
      "○Ｄ法律案（参第一二号）",
      "　　　　　　　発議者　　　　　　本文の　誰か君",
    ]), 221);
    assert.deepEqual(h.bills, [{ billId: "221-参法-1", title: "Ａ法律案" }, { billId: "221-参法-12", title: "Ｄ法律案" }]);
    assert.deepEqual(h.attendees.map((a) => a.nameText), ["石橋通宏"]);
  });

  test("出席者欄が無い会議録は空", () => {
    const h = parseMeetingHeader("令和八年七月九日\r\n○何か（参第一号）", 221);
    assert.deepEqual(h.attendees, []);
    assert.deepEqual(h.bills, []);
  });
});

describe("parseAttendancePage: 異常系", () => {
  test("0 件の実レスポンス（第218回: speechRecord キー自体が無い）は空の meetings。numberOfRecords が 0 でないのに speechRecord が無ければ例外", () => {
    const zero = { numberOfRecords: 0, numberOfReturn: 0, startRecord: 1, nextRecordPosition: null };
    assert.deepEqual(parseAttendancePage(zero, 218), { numberOfRecords: 0, nextRecordPosition: null, meetings: [] });
    assert.throws(() => parseAttendancePage({ numberOfRecords: 3, nextRecordPosition: null }, 221), /speechRecord/);
    assert.throws(() => parseAttendancePage({ nextRecordPosition: null }, 221), /numberOfRecords/);
  });
  test("speechOrder が 0 以外（発言本文）は会議録情報ではないので無視する", () => {
    const json = {
      numberOfRecords: 1, nextRecordPosition: null,
      speechRecord: [{ speechID: "x_001", speechOrder: 1, speaker: "誰か", nameOfMeeting: "内閣委員会", issue: "第1号", date: "2026-07-01", speech: "　　出席者は左のとおり。\r\n　　　　　　　発議者　　　　　　誰か君\r\n　　本日の会議に付した案件\r\n○Ａ（参第一号）", speechURL: "https://kokkai.ndl.go.jp/txt/x/1" }],
    };
    assert.deepEqual(parseAttendancePage(json, 221).meetings, []);
  });
});
