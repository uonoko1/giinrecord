import { describe, expect, it } from "vitest";
import { checkNoJs, sourceLinks, type NoJsExpectation, type NoJsSnapshot } from "./nojs";

/**
 * `checkNoJs` の判定そのものの検査（Issue #479）。
 * 実ブラウザで JS を切って開くのは scripts/browser-check.ts（`javaScriptEnabled: false`）で、
 * ここで見るのは**集めた DOM をどう判定するか**——とくに
 * **「空の shell を通してしまわないか」**と**「何も見ていない検査を緑にしないか」**。
 */

const ORIGIN = "http://127.0.0.1:8081";

/** 中身の入ったページ（プリレンダーが効いている状態） */
function filled(path: string): NoJsSnapshot {
  return {
    url: `${ORIGIN}${path}`,
    text: "青木一彦\n参議院・自由民主党\n記名採決 12件\n出典：参議院",
    hrefs: [`${ORIGIN}/`, `${ORIGIN}/members/`, "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/221/giin.htm"],
    times: ["2026-07-24"],
  };
}

/** プリレンダーが壊れたときの形: HTML は在るが本文が無い SPA shell */
function shell(path: string): NoJsSnapshot {
  return { url: `${ORIGIN}${path}`, text: "", hrefs: [], times: [] };
}

const expectation: NoJsExpectation = {
  path: "/members/m_003005/",
  label: "議員ページ",
  texts: ["青木一彦"],
  times: ["2026-07-24"],
  links: ["/members"],
  source: true,
};

describe("checkNoJs — JS 無効で記録が読めているかの判定（#479）", () => {
  it("本文・出典リンク・内部リンクが揃っていれば通る", () => {
    const got = new Map([[expectation.path, filled(expectation.path)]]);
    const r = checkNoJs(got, [expectation], ORIGIN);
    expect(r.failures).toEqual([]);
    expect(r.checked).toBe(1);
  });

  it("**空の shell は落ちる**（プリレンダーが壊れたときの形）", () => {
    const got = new Map([[expectation.path, shell(expectation.path)]]);
    const r = checkNoJs(got, [expectation], ORIGIN);
    // 本文・日付・内部リンク・出典 の 4 つが同時に落ちる
    expect(r.failures.length).toBe(4);
    expect(r.failures.join("\n")).toContain("青木一彦");
    expect(r.failures.join("\n")).toContain("出典リンクが 1 本も無い");
  });

  it("議員の氏名が別人のものなら落ちる（一覧だけ通って詳細が空/取り違え、を捕まえる）", () => {
    const other: NoJsSnapshot = { ...filled(expectation.path), text: "別の議員の名前\n参議院" };
    const r = checkNoJs(new Map([[expectation.path, other]]), [expectation], ORIGIN);
    expect(r.failures.join("\n")).toContain("「青木一彦」が出ていない");
  });

  it("本文と内部リンクが在っても、一次資料への出典リンクが無ければ落ちる", () => {
    // 「全行に一次資料リンク」が原則なので、出典が消えるのは本文が消えるのと同じ重さで扱う
    const noSource: NoJsSnapshot = { ...filled(expectation.path), hrefs: [`${ORIGIN}/`, `${ORIGIN}/members/`] };
    const r = checkNoJs(new Map([[expectation.path, noSource]]), [expectation], ORIGIN);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("出典リンクが 1 本も無い");
  });

  it("<time datetime> が出ていなければ落ちる（採決の日付）", () => {
    const noTime: NoJsSnapshot = { ...filled(expectation.path), times: [] };
    const r = checkNoJs(new Map([[expectation.path, noTime]]), [expectation], ORIGIN);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain('<time datetime="2026-07-24">');
  });

  it("詳細ページへの内部リンクが無ければ落ちる（一覧が空になる形）", () => {
    const noLink: NoJsSnapshot = { ...filled(expectation.path), hrefs: [`${ORIGIN}/`, "https://www.sangiin.go.jp/x.htm"] };
    const r = checkNoJs(new Map([[expectation.path, noLink]]), [expectation], ORIGIN);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("/members への内部リンクが無い");
  });

  it("末尾の / の有無で内部リンクの判定が変わらない", () => {
    const trailing: NoJsSnapshot = { ...filled(expectation.path), hrefs: [...filled(expectation.path).hrefs, `${ORIGIN}/rollcalls`] };
    const r = checkNoJs(new Map([[expectation.path, trailing]]), [{ ...expectation, links: ["/members/", "/rollcalls/"] }], ORIGIN);
    expect(r.failures).toEqual([]);
  });

  it("ページが開けなければ落ちる", () => {
    const r = checkNoJs(new Map(), [expectation], ORIGIN);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("開けなかった");
  });

  it("**期待値が 0 個の検査は落ちる**（data/ が読めず、何も見ていない検査が緑になるのを防ぐ）", () => {
    // ここが緑になると、`data/` が空のときに「JS 無効でも読める」と嘘の緑が出る
    const r = checkNoJs(new Map([[expectation.path, filled(expectation.path)]]), [{ ...expectation, texts: [] }], ORIGIN);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("検査する文字列が 0 個");
  });

  it("外部リンクは内部リンクとして数えない", () => {
    const r = checkNoJs(new Map([[expectation.path, filled(expectation.path)]]), [{ ...expectation, links: ["/japanese/joho1/kousei/giin/221/giin.htm"] }], ORIGIN);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("内部リンクが無い");
  });
});

describe("sourceLinks — 一次資料のホストだけを拾う", () => {
  it("参院・衆院のリンクだけを返す", () => {
    expect(
      sourceLinks([
        "https://www.sangiin.go.jp/japanese/touhyoulist/221/221-0724-v007.htm",
        "https://www.shugiin.go.jp/internet/itdb_annai.nsf/html/statics/syu/1giin.htm",
        "http://127.0.0.1:8081/members/",
        "https://example.com/sangiin.go.jp",
        "mailto:x@example.com",
        "/relative/path",
      ]),
    ).toEqual([
      "https://www.sangiin.go.jp/japanese/touhyoulist/221/221-0724-v007.htm",
      "https://www.shugiin.go.jp/internet/itdb_annai.nsf/html/statics/syu/1giin.htm",
    ]);
  });

  it("ホスト名を含むだけの他所のドメインは拾わない", () => {
    expect(sourceLinks(["https://evil.example/?u=www.sangiin.go.jp"])).toEqual([]);
  });
});
