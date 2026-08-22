import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatYearMonth } from "./format";

describe("formatDate", () => {
  it("ISO 日付を 2026.07.24 にする（タイムゾーン変換はしない）", () => {
    expect(formatDate("2026-07-24")).toBe("2026.07.24");
  });
  it("日時が付いていても日付だけにする", () => {
    expect(formatDate("2026-08-22T06:00:00+09:00")).toBe("2026.08.22");
  });
  it("日付でない文字列はそのまま返す", () => {
    expect(formatDate("不明")).toBe("不明");
    expect(formatDate("")).toBe("");
  });
});

describe("formatDateTime", () => {
  it("ISO 日時を 2026.08.22 06:00 にする（文字列のまま。タイムゾーン変換はしない）", () => {
    expect(formatDateTime("2026-08-22T06:00:00+09:00")).toBe("2026.08.22 06:00");
  });
  it("時刻の無い日付は日付だけ", () => {
    expect(formatDateTime("2026-08-22")).toBe("2026.08.22");
  });
  it("日付でない文字列はそのまま返す", () => {
    expect(formatDateTime("未取得")).toBe("未取得");
  });
});

describe("formatYearMonth", () => {
  it("2028-07-25 → 2028.07", () => {
    expect(formatYearMonth("2028-07-25")).toBe("2028.07");
  });
  it("日付でない文字列はそのまま返す", () => {
    expect(formatYearMonth("不明")).toBe("不明");
  });
});
