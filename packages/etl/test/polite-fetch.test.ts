import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedByRobots, parseRobots, PoliteFetcher } from "../src/sources/local/polite-fetch.ts";

// 地方議会サイト向けの丁寧な取得（Issue #157）: 許可ホストだけ・robots.txt 遵守。

test("parseRobots: User-agent: * と giinrecord-etl の Disallow を集める（他の UA のブロックは無視）", () => {
  const rules = parseRobots(["User-agent: GPTBot", "Disallow: /", "", "User-agent: *", "Disallow: /secure/", "Disallow:", "# comment", "User-agent: giinrecord-etl", "Disallow: /private/*"].join("\n"));
  assert.deepEqual(rules.disallow, ["/secure/", "/private/*"]);
  assert.equal(isAllowedByRobots(rules, "https://www.pref.miyagi.jp/site/kengikai/x.html"), true);
  assert.equal(isAllowedByRobots(rules, "https://www.pref.miyagi.jp/secure/1/x.pdf"), false);
  assert.equal(isAllowedByRobots(rules, "https://www.pref.miyagi.jp/private/x"), false);
});

test("parseRobots: 連続する User-agent 行は同じブロック", () => {
  const rules = parseRobots(["User-agent: a", "User-agent: *", "Disallow: /x/"].join("\n"));
  assert.deepEqual(rules.disallow, ["/x/"]);
  assert.deepEqual(parseRobots(""), { disallow: [] });
});

test("PoliteFetcher: 許可ホスト以外・http は取得しない（ネットワークに出る前に例外）", async () => {
  const f = new PoliteFetcher("www.pref.miyagi.jp");
  await assert.rejects(() => f.text("https://example.com/x.html"), /host not allowed/);
  await assert.rejects(() => f.text("http://www.pref.miyagi.jp/x.html"), /host not allowed/);
  await assert.rejects(() => f.bytes("https://evil.example/x.pdf"), /host not allowed/);
});
