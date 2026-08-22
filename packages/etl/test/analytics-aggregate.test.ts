import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Issue #58: nginx アクセスログ（IP を書かない log_format）を日次で PV/ページ/リファラ/日付 に集計する。
// deploy/analytics/aggregate.sh は VPS の cron から呼ばれる。ここでは固定ログで仕様を固定する。
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const script = resolve(root, "deploy/analytics/aggregate.sh");
const fixture = readFileSync(resolve(here, "fixtures/analytics-access.log.txt"), "utf8");

function run(date: string, input = fixture) {
  const r = spawnSync("bash", [script, date], { input, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function rows(date: string) {
  return run(date)
    .trimEnd()
    .split("\n")
    .slice(1)
    .filter((l) => l !== "")
    .map((l) => l.split("\t"));
}

test("出力は date/page/referrer/pv の 4 列 TSV でヘッダー行を持つ", () => {
  const out = run("2026-08-22");
  assert.equal(out.split("\n")[0], "date\tpage\treferrer\tpv");
  for (const r of rows("2026-08-22")) assert.equal(r.length, 4);
});

test("指定した日付（nginx の time_local, JST）だけを数え、前後の日は含めない", () => {
  const dates = new Set(rows("2026-08-22").map((r) => r[0]));
  assert.deepEqual([...dates], ["2026-08-22"]);
  assert.equal(rows("2026-08-23").length, 1);
  assert.equal(rows("2026-01-01").length, 0);
});

test("PV は GET かつ 200/304 の HTML ページだけ。assets/data/favicon/robots/sitemap、404、POST、HEAD は除外", () => {
  const pages = new Set(rows("2026-08-22").map((r) => r[1]));
  assert.deepEqual([...pages].sort(), ["/", "/members/", "/members/sangiin-12345/", "/rollcalls/221/"]);
});

test("クエリ文字列を落とし、末尾スラッシュを揃える（/members?q=… は /members/）", () => {
  const members = rows("2026-08-22").filter((r) => r[1] === "/members/");
  assert.equal(
    members.reduce((n, r) => n + Number(r[3]), 0),
    3,
  );
});

test("リファラはホスト名だけに縮め、自サイト内・無しは '-' にまとめる", () => {
  const referrers = new Set(rows("2026-08-22").map((r) => r[2]));
  assert.deepEqual([...referrers].sort(), ["-", "android-app://com.google.android.gm", "b.hatena.ne.jp", "t.co", "www.google.com"]);
  const internal = rows("2026-08-22").find((r) => r[1] === "/members/sangiin-12345/");
  assert.equal(internal?.[2], "-");
});

test("同じ page×referrer は 1 行にまとめて pv を合計し、pv 降順で並ぶ", () => {
  const r = rows("2026-08-22");
  const google = r.filter((x) => x[1] === "/members/" && x[2] === "www.google.com");
  assert.equal(google.length, 1);
  assert.equal(google[0][3], "2");
  const pvs = r.map((x) => Number(x[3]));
  assert.deepEqual(pvs, [...pvs].sort((a, b) => b - a));
});

test("壊れた行があっても落ちず、IP アドレスは出力に現れない", () => {
  const out = run("2026-08-22");
  assert.doesNotMatch(out, /\b\d{1,3}(\.\d{1,3}){3}\b/);
});

test("空入力ならヘッダー行だけを出す", () => {
  assert.equal(run("2026-08-22", ""), "date\tpage\treferrer\tpv\n");
});

test("日付の形式が不正なら非0終了", () => {
  const r = spawnSync("bash", [script, "22/08/2026"], { input: "", encoding: "utf8" });
  assert.notEqual(r.status, 0);
});
