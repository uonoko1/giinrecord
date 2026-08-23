import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchText, fetchTextOr404 } from "../src/fetch.ts";

// Issue #103: 回次ごとの参院名簿は第215回以前が 404。404 だけを「無い」として返し、他の障害は例外のまま。HTTP 境界だけをモックする。

const original = globalThis.fetch;
const stub = (status: number, body = "") => {
  globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch;
};
afterEach(() => { globalThis.fetch = original; });
// 同じ URL でもキャッシュに当たらないよう noCache。404 はキャッシュに書かれない
const URL_404 = "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/215/giin.htm";

describe("fetchTextOr404", () => {
  test("404 は undefined（例外にしない）", async () => {
    stub(404, "Not Found");
    assert.equal(await fetchTextOr404(URL_404, "utf-8", { noCache: true }), undefined);
  });
  test("5xx は例外（障害を名簿無しと混同しない）", async () => {
    stub(503);
    await assert.rejects(() => fetchTextOr404(URL_404, "utf-8", { noCache: true }), /HTTP 503/);
  });
  test("fetchText は 404 も例外のまま（従来どおり）", async () => {
    stub(404);
    await assert.rejects(() => fetchText(URL_404, "utf-8", { noCache: true }), /HTTP 404/);
  });
});
