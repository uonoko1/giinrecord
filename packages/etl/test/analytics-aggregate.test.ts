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

// 本文行だけ（ヘッダと `#` の要約行を落とす。#1184 で 2 行目に要約が入った）
function rows(date: string, input = fixture) {
  return run(date, input)
    .trimEnd()
    .split("\n")
    .slice(1)
    .filter((l) => l !== "" && !l.startsWith("#"))
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

// #1184 で 2 行目に要約が入った。空入力でも「0 と測れた」ことが読めるのが要点なので、
// ヘッダ 1 行だけを期待する形は、下の「空入力でも要約行を出し、0 を 0 と書く」に置き換えた。
test("空入力なら本文行が 0 本（ヘッダと要約行だけ）", () => {
  assert.equal(rows("2026-08-22", "").length, 0);
});

test("日付の形式が不正なら非0終了", () => {
  const r = spawnSync("bash", [script, "22/08/2026"], { input: "", encoding: "utf8" });
  assert.notEqual(r.status, 0);
});

// ---------------------------------------------------------------------------------------------
// Issue #1184 受け入れ条件 5: pv と pages（異なるページ数）を両方 TSV に出す。
//
// なぜ: **クローラと人を読み手が区別できる**ようにするため。実測（#1178）:
//   2026-09-25  pv=5631  pages=4938  → 1 ページあたり 1.14 回（全ページを 1 回ずつ辿る＝クローラ）
//   2026-09-16  pv=87    pages=25    → 3.5 回（人の形）
// **クローラを除外しない。** 除外は denylist になり #1133 / #1089 / #1115 と同じ罠に落ちる。
// 区別できる数を出すだけにして、判断は読み手に残す。
//
// 置き場所は**ヘッダ直後の `#` 行**。理由は 2 つ:
//   - `head` しただけで目に入る（この数を見てほしい相手は、まず head する人）
//   - 行空間（date/page/referrer/pv）を汚さない。実測: 本文行として足すと
//     `awk -F"\t" '$1!="date"{r[$3]+=$4}'`（docs/ops/analytics.md のリファラ集計）に
//     余計な 0 行が 1 本混ざる。`#` 行なら `!/^#/` を足すだけで済み、pv 合計の
//     one-liner（`s+=$4`）は $4 が空なので**足す前から正しい**（実測: 63 → 63）。
// ---------------------------------------------------------------------------------------------

function summary(date: string, input = fixture) {
  const line = run(date, input).split("\n")[1];
  assert.ok(line?.startsWith("#"), `2 行目が要約行でない: ${line}`);
  return line;
}

test("2 行目に pv と pages（異なるページ数）を出す", () => {
  // 固定ログの 2026-08-22: pv 合計 8、異なるページは / /members/ /members/sangiin-12345/ /rollcalls/221/ の 4
  assert.equal(summary("2026-08-22"), "# 2026-08-22\tpv=8\tpages=4\tper-page=2.00");
});

test("pages は異なるページ数であって行数ではない（同じページを 2 回 → pv=2, pages=1）", () => {
  const twice = [
    '- - [22/Aug/2026:01:00:00 +0900] "GET /members/ HTTP/2.0" 200 1 "-" "-"',
    '- - [22/Aug/2026:02:00:00 +0900] "GET /members/ HTTP/2.0" 200 1 "-" "-"',
  ].join("\n");
  assert.equal(summary("2026-08-22", twice), "# 2026-08-22\tpv=2\tpages=1\tper-page=2.00");
});

test("同じページでもリファラが違えば行は 2 本だが pages は 1（クローラ判定を行数で誤らせない）", () => {
  const twoRefs = [
    '- - [22/Aug/2026:01:00:00 +0900] "GET /members/ HTTP/2.0" 200 1 "https://www.google.com/" "-"',
    '- - [22/Aug/2026:02:00:00 +0900] "GET /members/ HTTP/2.0" 200 1 "https://t.co/x" "-"',
  ].join("\n");
  assert.equal(rows("2026-08-22").length > 0, true); // sanity: rows() は本文行だけを返す
  assert.equal(summary("2026-08-22", twoRefs), "# 2026-08-22\tpv=2\tpages=1\tper-page=2.00");
});

test("クローラの形（全ページ 1 回ずつ）は per-page が 1.00 に近づく。除外はしない", () => {
  const crawl = Array.from(
    { length: 5 },
    (_, i) => `- - [22/Aug/2026:0${i}:00:00 +0900] "GET /p${i}/ HTTP/2.0" 200 1 "-" "-"`,
  ).join("\n");
  assert.equal(summary("2026-08-22", crawl), "# 2026-08-22\tpv=5\tpages=5\tper-page=1.00");
  // 行は消えていない（除外していないことを、行数そのもので確かめる）
  assert.equal(rows("2026-08-22", crawl).length, 5);
});

test("空入力でも要約行を出し、0 を 0 と書く（「0 件」を「測れなかった」に化けさせない）", () => {
  assert.equal(
    run("2026-08-22", ""),
    "date\tpage\treferrer\tpv\n# 2026-08-22\tpv=0\tpages=0\tper-page=0.00\n",
  );
});

test("要約行は本文の集計 one-liner を壊さない（docs/ops/analytics.md の見方）", () => {
  const out = run("2026-08-22");
  const body = out
    .split("\n")
    .filter((l) => l !== "" && !l.startsWith("#") && !l.startsWith("date\t"));
  const pv = body.reduce((n, l) => n + Number(l.split("\t")[3]), 0);
  const pages = new Set(body.map((l) => l.split("\t")[1])).size;
  // 要約行の数が、本文から再計算した数と一致する（要約が本文から導かれていることの確認）
  assert.equal(summary("2026-08-22"), `# 2026-08-22\tpv=${pv}\tpages=${pages}\tper-page=2.00`);
});
