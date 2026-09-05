import { describe, expect, it } from "vitest";
import { checkNoJs, NOJS_PAGE_COUNT, sourceLinks, type NoJsExpectation, type NoJsSnapshot } from "./nojs";

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

const SOURCE_URL = "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/221/giin.htm";

const expectation: NoJsExpectation = {
  path: "/members/m_003005/",
  label: "議員ページ",
  texts: ["青木一彦"],
  times: ["2026-07-24"],
  links: ["/members"],
  sourceUrl: SOURCE_URL,
};

/**
 * `checkNoJs` は「4 ページ揃っているか」も見る（#479 のレビュー指摘）ので、
 * 1 ページだけを検査する単体テストでは残り 3 ページ分の**通る**期待値を足して数を合わせる。
 * ここで見たいのは判定の中身であって、ページ数のガードではない（それは専用の describe で見る）。
 */
function padded(e: NoJsExpectation): NoJsExpectation[] {
  const filler = (n: number): NoJsExpectation => ({ path: `/filler-${n}/`, label: `詰め物${n}`, texts: ["青木一彦"], sourceUrl: null });
  return [e, filler(1), filler(2), filler(3)];
}

/** `padded` の詰め物ページの中身（すべて通る） */
function paddedGot(path: string, snap: NoJsSnapshot): Map<string, NoJsSnapshot> {
  const m = new Map([[path, snap]]);
  for (const n of [1, 2, 3]) m.set(`/filler-${n}/`, filled(`/filler-${n}/`));
  return m;
}

describe("checkNoJs — JS 無効で記録が読めているかの判定（#479）", () => {
  it("本文・出典リンク・内部リンクが揃っていれば通る", () => {
    const got = paddedGot(expectation.path, filled(expectation.path));
    const r = checkNoJs(got, padded(expectation), ORIGIN);
    expect(r.failures).toEqual([]);
    expect(r.checked).toBe(NOJS_PAGE_COUNT);
  });

  it("**空の shell は落ちる**（プリレンダーが壊れたときの形）", () => {
    const got = paddedGot(expectation.path, shell(expectation.path));
    const r = checkNoJs(got, padded(expectation), ORIGIN);
    // 本文・日付・内部リンク・出典 の 4 つが同時に落ちる
    expect(r.failures.length).toBe(4);
    expect(r.failures.join("\n")).toContain("青木一彦");
    expect(r.failures.join("\n")).toContain("出典リンクが 1 本も無い");
  });

  /*
   * #479 のレビュー指摘（変異 M）。判定を「先頭 1 文字が含まれれば可」に緩めても
   * 12/12 緑のままだった＝**厳密一致であることがテストで固定されていなかった**。
   * 「別人の記録が出る」は利用者から検出できない虚偽で、「記録が出ない」より重い。
   * だから**先頭の文字だけが一致する紛らわしい本文**を、はっきり落とす側に置く。
   */
  it("**先頭の文字だけが一致する別の内容**は通さない（部分一致に緩めると素通りする形）", () => {
    // 期待「青木一彦」に対して本文は「青森県議会」。先頭の「青」だけが共通
    const confusable: NoJsSnapshot = { ...filled(expectation.path), text: "青森県議会のページ\n青山\n青葉区" };
    const r = checkNoJs(paddedGot(expectation.path, confusable), padded(expectation), ORIGIN);
    expect(r.failures.join("\n")).toContain("「青木一彦」が出ていない");
  });

  it("氏名の一部だけ（姓だけ・名だけ）でも通さない", () => {
    const partial: NoJsSnapshot = { ...filled(expectation.path), text: "青木\n一彦は別の議員です" };
    const r = checkNoJs(paddedGot(expectation.path, partial), padded(expectation), ORIGIN);
    expect(r.failures.join("\n")).toContain("「青木一彦」が出ていない");
  });

  it("議員の氏名が別人のものなら落ちる（一覧だけ通って詳細が空/取り違え、を捕まえる）", () => {
    const other: NoJsSnapshot = { ...filled(expectation.path), text: "別の議員の名前\n参議院" };
    const r = checkNoJs(paddedGot(expectation.path, other), padded(expectation), ORIGIN);
    expect(r.failures.join("\n")).toContain("「青木一彦」が出ていない");
  });

  it("本文と内部リンクが在っても、一次資料への出典リンクが無ければ落ちる", () => {
    // 「全行に一次資料リンク」が原則なので、出典が消えるのは本文が消えるのと同じ重さで扱う
    const noSource: NoJsSnapshot = { ...filled(expectation.path), hrefs: [`${ORIGIN}/`, `${ORIGIN}/members/`] };
    const r = checkNoJs(paddedGot(expectation.path, noSource), padded(expectation), ORIGIN);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("出典リンクが 1 本も無い");
  });

  it("<time datetime> が出ていなければ落ちる（採決の日付）", () => {
    const noTime: NoJsSnapshot = { ...filled(expectation.path), times: [] };
    const r = checkNoJs(paddedGot(expectation.path, noTime), padded(expectation), ORIGIN);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain('<time datetime="2026-07-24">');
  });

  it("詳細ページへの内部リンクが無ければ落ちる（一覧が空になる形）", () => {
    const noLink: NoJsSnapshot = { ...filled(expectation.path), hrefs: [`${ORIGIN}/`, "https://www.sangiin.go.jp/x.htm"] };
    const r = checkNoJs(paddedGot(expectation.path, noLink), padded(expectation), ORIGIN);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("/members への内部リンクが無い");
  });

  it("末尾の / の有無で内部リンクの判定が変わらない", () => {
    const trailing: NoJsSnapshot = { ...filled(expectation.path), hrefs: [...filled(expectation.path).hrefs, `${ORIGIN}/rollcalls`] };
    const r = checkNoJs(paddedGot(expectation.path, trailing), padded({ ...expectation, links: ["/members/", "/rollcalls/"] }), ORIGIN);
    expect(r.failures).toEqual([]);
  });

  it("ページが開けなければ落ちる", () => {
    const got = paddedGot(expectation.path, filled(expectation.path));
    got.delete(expectation.path);
    const r = checkNoJs(got, padded(expectation), ORIGIN);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("開けなかった");
  });

  it("**期待値が 0 個の検査は落ちる**（data/ が読めず、何も見ていない検査が緑になるのを防ぐ）", () => {
    // ここが緑になると、`data/` が空のときに「JS 無効でも読める」と嘘の緑が出る
    const r = checkNoJs(paddedGot(expectation.path, filled(expectation.path)), padded({ ...expectation, texts: [] }), ORIGIN);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("検査する文字列が 0 個");
  });

  it("外部リンクは内部リンクとして数えない", () => {
    const r = checkNoJs(paddedGot(expectation.path, filled(expectation.path)), padded({ ...expectation, links: ["/japanese/joho1/kousei/giin/221/giin.htm"] }), ORIGIN);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("内部リンクが無い");
  });
});

describe("sourceLinks — sourceUrl と同じホストのリンクだけを拾う", () => {
  it("そのページの出典と同じホストのリンクを返す", () => {
    expect(
      sourceLinks(
        [
          "https://www.sangiin.go.jp/japanese/touhyoulist/221/221-0724-v007.htm",
          "https://www.shugiin.go.jp/internet/itdb_annai.nsf/html/statics/syu/1giin.htm",
          "http://127.0.0.1:8081/members/",
          "https://example.com/sangiin.go.jp",
          "mailto:x@example.com",
          "/relative/path",
        ],
        SOURCE_URL,
      ),
    ).toEqual(["https://www.sangiin.go.jp/japanese/touhyoulist/221/221-0724-v007.htm"]);
  });

  it("ホスト名を含むだけの他所のドメインは拾わない", () => {
    expect(sourceLinks(["https://evil.example/?u=www.sangiin.go.jp"], SOURCE_URL)).toEqual([]);
  });

  /*
   * #479 のレビュー指摘。allowlist を手書きしていた頃は、全 1,057 名のうち
   * **285 名（27%）の地方議会の議員ページが偽陽性で落ちた**（記録は完全に読めているのに）。
   * 偽陽性は docker-web を赤くして、正常な本番リリースを止める。
   */
  it("地方議会のホストでも、そのページの sourceUrl と一致すれば拾う（allowlist を手書きしない）", () => {
    const pref = "https://www.pref.miyagi.jp/soshiki/gikai/giin.html";
    expect(sourceLinks(["https://www.pref.miyagi.jp/soshiki/gikai/meibo.html", "http://127.0.0.1:8081/"], pref)).toEqual([
      "https://www.pref.miyagi.jp/soshiki/gikai/meibo.html",
    ]);
  });

  it("別の議会のホストへのリンクでは代用できない", () => {
    // 参院の議員ページに衆院へのリンクしか無い、という形を出典と認めない
    expect(sourceLinks(["https://www.shugiin.go.jp/x.htm"], SOURCE_URL)).toEqual([]);
  });
});

describe("検査そのものが縮んでいないか（#479 のレビュー指摘 / #451 と同じ形）", () => {
  /*
   * 期待値は data/ の `rc`（採決）と `detail`（議員）の 2 つの `if` で作られるので、
   * data/rollcalls/index.json が [] になると**採決の 2 ページが黙って消え**、
   * 残り 2 ページだけで 0 failure = 緑になっていた（レビュアーの実測）。
   * 「検査するものが無いから緑」を作らない。
   */
  it("**4 ページ揃っていなければ落ちる**（採決データが欠けて 2 ページに縮んだ形）", () => {
    const two = [expectation, { ...expectation, path: "/members/", label: "議員一覧" }];
    const got = new Map([
      [expectation.path, filled(expectation.path)],
      ["/members/", filled("/members/")],
    ]);
    const r = checkNoJs(got, two, ORIGIN);
    expect(r.failures.join("\n")).toContain("検査するページが 2 ページしかない");
  });

  it("多すぎても落ちる（数を固定する）", () => {
    const five = [...padded(expectation), { ...expectation, path: "/extra/", label: "余分" }];
    const got = paddedGot(expectation.path, filled(expectation.path));
    got.set("/extra/", filled("/extra/"));
    const r = checkNoJs(got, five, ORIGIN);
    expect(r.failures.join("\n")).toContain("5 ページしかない");
  });

  it("4 ページ揃っていれば、この検査は何も言わない", () => {
    const r = checkNoJs(paddedGot(expectation.path, filled(expectation.path)), padded(expectation), ORIGIN);
    expect(r.failures).toEqual([]);
  });
});
