import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  statSync,
  copyFileSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Issue #58 レビュー指摘: deploy 鍵ユーザー ubuntu を adm グループに入れると VPS 上の他サイトのログや
// auth.log まで読めてしまう。cron は root で動かし、集計 TSV だけを ubuntu 所有 mode 600 で渡す。
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const setup = readFileSync(resolve(root, "deploy/analytics/vps-analytics-setup.sh"), "utf8");
const daily = resolve(root, "deploy/analytics/daily.sh");
const fixture = resolve(here, "fixtures/analytics-access.log.txt");

function runDaily(day: string, owner: string) {
  const dir = mkdtempSync(join(tmpdir(), "analytics-"));
  const log = join(dir, "access.log");
  copyFileSync(fixture, log);
  const out = join(dir, "out");
  const r = spawnSync("bash", [daily, day], {
    encoding: "utf8",
    env: { ...process.env, ANALYTICS_LOG: log, ANALYTICS_OUT: out, ANALYTICS_OWNER: owner },
  });
  assert.equal(r.status, 0, r.stderr);
  return { out, stdout: r.stdout };
}

test("setup は ubuntu を adm グループに入れない", () => {
  const code = setup
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  assert.doesNotMatch(code, /usermod/);
  assert.doesNotMatch(code, /\badm\b/);
});

test("cron は root で daily.sh を実行する（ubuntu には /var/log/nginx の読み取り権限を与えない）", () => {
  const cronLine = setup.split("\n").find((l) => /^10 0 \* \* \* /.test(l));
  assert.ok(cronLine, "cron.d の行が無い");
  assert.match(cronLine, /^10 0 \* \* \* root /);
});

test("daily.sh は TSV を mode 600、出力ディレクトリを 700 で書き、tmp ファイルを残さない", () => {
  // root でない環境では chown は効かないが、mode と tmp の後始末は同じ経路で検証できる
  const { out } = runDaily("2026-08-22", "nobody");
  const tsv = join(out, "2026-08-22.tsv");
  assert.equal(statSync(tsv).mode & 0o777, 0o600);
  assert.equal(statSync(out).mode & 0o777, 0o700);
  assert.equal(readFileSync(tsv, "utf8").split("\n")[0], "date\tpage\treferrer\tpv");
  assert.throws(() => statSync(`${tsv}.tmp`));
});

test("daily.sh は ANALYTICS_OWNER が無くても（ubuntu の手動実行）動く", () => {
  const { stdout } = runDaily("2026-08-23", "");
  assert.match(stdout, /2026-08-23 -> /);
});

// ---------------------------------------------------------------------------------------------
// Issue #1184: 計器が 39 日間、無言で壊れていた。
//
// VPS に設置済みの daily.sh が改名前のログ名（存在しないファイル）を読み、**0 行の TSV を書いて
// exit 0 で「成功」を報告していた**。cron は毎日発火し、TSV も毎日生成されていたので、
// どの計器も赤くならなかった。
//
// 原因は 2 つの「不在が成功になる」形が重なったこと:
//   1. daily.sh が `[ -f "$LOG" ] && cat "$LOG"` の形で、**読む先が無いことをエラーにしない**
//   2. aggregate.sh が先にヘッダを printf するので、**0 行でも TSV は必ず 1 行**になる
// 結果「0 rows」と報告して exit 0。**「0 件」と「測れなかった」が区別されていなかった**（#757・#1158 と同じ型）。
//
// ここで固定するのは「読む先が無い」と「1 行も数えられなかった」の両方が**非 0 で落ちる**こと。
// **「0 件」と「測れなかった」を区別する**のがこの PBI の軸なので、両者は別のメッセージで落ちる。
// ---------------------------------------------------------------------------------------------

/** runDaily と同じ経路だが、終了コードを呼び出し側に返す（失敗を期待するテスト用） */
function tryDaily(
  day: string,
  opts: { log?: string; writeLog?: string; owner?: string } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "analytics-"));
  const log = opts.log ?? join(dir, "access.log");
  if (opts.writeLog !== undefined) writeFileSync(log, opts.writeLog);
  else if (opts.log === undefined) copyFileSync(fixture, log);
  const out = join(dir, "out");
  const r = spawnSync("bash", [daily, day], {
    encoding: "utf8",
    env: {
      ...process.env,
      ANALYTICS_LOG: log,
      ANALYTICS_OUT: out,
      ANALYTICS_OWNER: opts.owner ?? "",
    },
  });
  return { out, dir, status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("daily.sh: 読む先のログが 1 つも無ければ非 0 で落ちる（#1184 の本命。改名後 39 日これが 0 だった）", () => {
  const dir = mkdtempSync(join(tmpdir(), "analytics-"));
  const r = tryDaily("2026-08-22", { log: join(dir, "renamed-away.access.log") });
  assert.notEqual(r.status, 0, `不在のログで成功してはいけない: ${r.stdout}`);
  // 「どのファイルも無い」とだけ言う。ログの中身や行は出さない。
  assert.match(r.stderr, /no such log/i);
});

test("daily.sh: ログが不在のときは 0 行の TSV を置かない（空の計測値を記録に残さない）", () => {
  const dir = mkdtempSync(join(tmpdir(), "analytics-"));
  const r = tryDaily("2026-08-22", { log: join(dir, "renamed-away.access.log") });
  assert.throws(
    () => statSync(join(r.out, "2026-08-22.tsv")),
    "不在のログから TSV を作ってはいけない",
  );
});

test("daily.sh: ログは在るが指定日の PV が 1 行も無ければ非 0 で落ち、TSV は置く（cron が走ったことは残す）", () => {
  // ログは実在し中身も在るが、求めた日のアクセスが 0 行。
  const r = tryDaily("2026-01-01");
  assert.notEqual(r.status, 0, `0 行を成功として報告してはいけない: ${r.stdout}`);
  assert.match(`${r.stdout}${r.stderr}`, /0 rows/);
  // 「ログが無い」と「ログは在るが 0 行」は別物。TSV が在るかどうかで区別できるようにする。
  const tsv = join(r.out, "2026-01-01.tsv");
  assert.equal(statSync(tsv).mode & 0o777, 0o600);
  assert.match(readFileSync(tsv, "utf8"), /pv=0\tpages=0/);
});

test("daily.sh: 空のログファイル（0 バイト）も「測れなかった」として非 0 で落ちる", () => {
  const r = tryDaily("2026-08-22", { writeLog: "" });
  assert.notEqual(r.status, 0, `空ログを成功として報告してはいけない: ${r.stdout}`);
});

test("daily.sh: ローテーション後（.log が無く .log.1 だけ在る）は成功する", () => {
  const dir = mkdtempSync(join(tmpdir(), "analytics-"));
  const log = join(dir, "access.log");
  copyFileSync(fixture, `${log}.1`); // .log 自体は作らない
  const out = join(dir, "out");
  const r = spawnSync("bash", [daily, "2026-08-22"], {
    encoding: "utf8",
    env: { ...process.env, ANALYTICS_LOG: log, ANALYTICS_OUT: out, ANALYTICS_OWNER: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /pv=/);
});

test("daily.sh: stdout に pv と pages を両方出す（cron ログに残る唯一の形）", () => {
  const { stdout } = runDaily("2026-08-22", "");
  assert.match(stdout, /pv=8\b/);
  assert.match(stdout, /pages=4\b/);
});
