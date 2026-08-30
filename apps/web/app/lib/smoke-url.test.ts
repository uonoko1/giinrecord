/**
 * URL モードのスモークチェッカーの仕様（Issue #85）。
 * 配信中のサーバー（nginx コンテナ）に対して、ページが 200 で返り、
 * 旧 server block と同じセキュリティヘッダ・キャッシュヘッダが付くことを検証する。
 * HTTP は境界なので、ここでは取得済みレスポンスの Map に対する純粋関数だけを試験する。
 *
 * Issue #325: 未知のパスは 404 でなければならない（以前は SPA fallback で 200 だった）。
 * ただしプリレンダーしない SPA ページ（/compare、#104）は 200 のまま。両方を別の的として検査する。
 */
import { describe, expect, it } from "vitest";
import { checkServed, EXPECTED_SECURITY_HEADERS, urlSmokeTargets, type ServedResponse } from "./smoke-url";

const sec = { ...EXPECTED_SECURITY_HEADERS };
const res = (over: Partial<ServedResponse> = {}): ServedResponse => ({
  status: 200,
  headers: { "content-type": "text/html", ...sec },
  body: "<html></html>",
  ...over,
});

describe("urlSmokeTargets", () => {
  it("assets も data も無ければ null（チェックをスキップ）", () => {
    const t = urlSmokeTargets(["index.html"], []);
    expect(t.asset).toBeNull();
    expect(t.data).toBeNull();
  });
  it("必須ページ・未知パス・assets・data を、ページ一覧から組み立てる", () => {
    const t = urlSmokeTargets(
      ["index.html", "about/index.html", "members/m_1/index.html"],
      ["robots.txt", "assets/entry-abc.js", "data/data-archive.zip"],
    );
    expect(t.pages).toEqual(["/", "/about/", "/members/m_1/"]);
    expect(t.asset).toBe("/assets/entry-abc.js");
    expect(t.data).toBe("/data/data-archive.zip");
    expect(t.unknown).toBe("/__smoke-no-such-page__/");
  });
  // #325: プリレンダー済みページ一覧に /compare は入らない（クエリ依存で HTML ファイルが無い）。
  // 未知パスと同じ扱いにすると 404 を期待してしまうので、別の的として持つ。
  it("プリレンダーしない SPA ページ（/compare）は未知パスとは別の的で、200 を期待する", () => {
    const t = urlSmokeTargets(["index.html"], []);
    expect(t.spa).toEqual(["/compare?m=m_1,m_2"]);
    expect(t.pages).not.toContain("/compare");
    expect(t.spa).not.toContain(t.unknown);
  });
});

describe("checkServed", () => {
  const base = {
    pages: ["/", "/about/"],
    spa: [] as string[],
    unknown: "/__x__/",
    asset: "/assets/a.js",
    data: "/data/members/index.json",
  };

  it("全部そろっていれば失敗なし", () => {
    const got = new Map<string, ServedResponse>([
      ["/", res()],
      ["/about/", res()],
      ["/__x__/", res({ status: 404 })],
      ["/assets/a.js", res({ headers: { ...sec, "cache-control": "public, max-age=31536000, immutable" } })],
      ["/data/members/index.json", res({ headers: { ...sec, "cache-control": "public, max-age=3600" } })],
    ]);
    expect(checkServed(got, base).failures).toEqual([]);
  });

  it("ページが 404 なら失敗", () => {
    const got = new Map([["/", res()], ["/about/", res({ status: 404 })]]);
    const r = checkServed(got, { ...base, asset: null, data: null });
    expect(r.failures).toContain("/about/: status 404 (expected 200)");
  });

  // #325: 存在しない URL が 200 を返すと、検索エンジンが実在ページとして索引する。
  it("未知パスが 200 なら失敗（404 を返さなければならない）", () => {
    const got = new Map([["/", res()], ["/about/", res()], ["/__x__/", res({ status: 200 })]]);
    const r = checkServed(got, { ...base, asset: null, data: null });
    expect(r.failures).toContain("/__x__/: status 200 (expected 404)");
  });

  it("未知パスが 404 なら失敗なし、かつセキュリティヘッダは 404 にも付く", () => {
    const noSec = res({ status: 404, headers: { "content-type": "text/html" } });
    const r = checkServed(new Map([["/", res()], ["/about/", res()], ["/__x__/", noSec]]), { ...base, asset: null, data: null });
    expect(r.failures).toContain('/__x__/: header x-frame-options missing (expected "DENY")');
    expect(r.failures).not.toContain("/__x__/: status 404 (expected 404)");
  });

  // #104: /compare はプリレンダーしないが、実在するルートなので 200 でなければならない。
  it("プリレンダーしない SPA ページが 404 なら失敗（#325 で壊しやすい所）", () => {
    const got = new Map([["/", res()], ["/about/", res()], ["/__x__/", res({ status: 404 })], ["/compare?m=m_1", res({ status: 404 })]]);
    const r = checkServed(got, { ...base, spa: ["/compare?m=m_1"], asset: null, data: null });
    expect(r.failures).toContain("/compare?m=m_1: status 404 (expected 200)");
  });

  it("プリレンダーしない SPA ページが 200 なら失敗なし", () => {
    const got = new Map([["/", res()], ["/about/", res()], ["/__x__/", res({ status: 404 })], ["/compare?m=m_1", res()]]);
    expect(checkServed(got, { ...base, spa: ["/compare?m=m_1"], asset: null, data: null }).failures).toEqual([]);
  });

  it("セキュリティヘッダが欠けている／違う値なら失敗（CSP を含む）", () => {
    const headers = { ...sec, "content-security-policy": "default-src *" };
    delete (headers as Record<string, string>)["x-frame-options"];
    const got = new Map([["/", res({ headers })]]);
    const r = checkServed(got, { ...base, pages: ["/"], unknown: null, asset: null, data: null });
    expect(r.failures).toContain(`/: header content-security-policy = "default-src *" (expected "${sec["content-security-policy"]}")`);
    expect(r.failures).toContain('/: header x-frame-options missing (expected "DENY")');
  });

  it("キャッシュヘッダは /assets/ が immutable 1年、/data/ が 1 時間", () => {
    const got = new Map([
      ["/", res()],
      ["/assets/a.js", res({ headers: { ...sec, "cache-control": "no-cache" } })],
      ["/data/members/index.json", res({ headers: { ...sec } })],
    ]);
    const r = checkServed(got, { ...base, pages: ["/"], unknown: null });
    expect(r.failures).toContain('/assets/a.js: header cache-control = "no-cache" (expected "public, max-age=31536000, immutable")');
    expect(r.failures).toContain('/data/members/index.json: header cache-control missing (expected "public, max-age=3600")');
  });

  it("取得できなかった URL は失敗として報告する", () => {
    const r = checkServed(new Map(), { ...base, pages: ["/"], unknown: null, asset: null, data: null });
    expect(r.failures).toEqual(["/: no response"]);
  });

  // #168: 配信中の HTML にも外部リソース（Google Fonts 等）への参照が無いこと
  it("ページ本文が外部リソースを読み込んでいれば失敗（出典リンクは可）", () => {
    const got = new Map([
      ["/", res({ body: '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X"><a href="https://www.sangiin.go.jp/">出典</a>' })],
      ["/about/", res({ body: '<link rel="stylesheet" href="/fonts/fonts.css">' })],
    ]);
    const r = checkServed(got, { ...base, unknown: null, asset: null, data: null });
    expect(r.failures).toEqual(["/: external resource https://fonts.googleapis.com/css2?family=X"]);
  });

  it("checked は確認した URL の数", () => {
    const got = new Map([["/", res()], ["/__x__/", res({ status: 404 })], ["/compare?m=m_1", res()]]);
    expect(checkServed(got, { ...base, pages: ["/"], spa: ["/compare?m=m_1"], unknown: "/__x__/", asset: null, data: null }).checked).toBe(3);
  });
});
