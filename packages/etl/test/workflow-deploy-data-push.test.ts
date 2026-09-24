import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Issue #995: **人が `data/` を含む PR をマージしても、何も本番に配らない。**
 *
 * `deploy-data.yml` を起動していたのは、`etl.yml` / `districts.yml` / `local-assemblies.yml` の
 * 末尾にある `gh workflow run deploy-data.yml --ref main` と、安全網の cron（06:30 JST）だけだった。
 * **人がマージする経路には、どこにも起動が無かった。**
 *
 * ── 測った数（2026-09-25、origin/main の全履歴）──────────────────────────
 *   `data/` を触るコミット           85 本
 *     うち bot（ETL/districts/local） 54 本 … 自分で deploy-data を起動する
 *     うち人のマージ                   29 本 … **何も起動しない**（母数 29 / 85 = 34%）
 *
 *   人のマージ 29 本が deploy-data で公開されるまでの待ち時間（次に成功した deploy-data run まで）:
 *     min 0.26h / median 9.70h / p90 21.62h / max 27.99h
 *     6h 超  17 / 29     12h 超 10 / 29     18h 超 5 / 29     24h 超 1 / 29
 *   **「最悪 24 時間」ではない。** cron の run が失敗・キャンセルされると 24h を超える（実測 27.99h）。
 *
 * ── なぜ `on.push` で二重起動しないか（測った）────────────────────────────
 * **GITHUB_TOKEN のマージは push イベントを起こさない。** これは推測ではなく、
 * 既に `on: push: branches: [main]` を持つ `deploy-staging.yml` の実績で測れる。
 * 観測窓（deploy-staging の直近 400 run が覆う 2026-09-02T20:05Z 〜 2026-09-24T17:56Z）で:
 *
 *   窓内の `data/` コミット 47 本
 *     bot   22 本 → push イベントの deploy-staging run が存在したのは **0 / 22**
 *     人    25 本 → 存在したのは **25 / 25**
 *
 * つまり `on: push: paths: ['data/**']` は**欠けている経路だけ**を拾い、
 * ETL の経路とは 1 度も重ならない（重なりの実測 0 件）。
 *
 * ── staging を push のときだけ外す理由 ──────────────────────────────────
 * 同じ push で `deploy-staging.yml` が既に staging を配る（上の実測 25/25）。
 * `deploy-data.yml` の `staging` job をそのまま走らせると、**同じ成果物を 2 回ビルドして
 * 2 回 rsync する**。両者は `deploy-site.yml` の concurrency group `deploy-vps`
 * （`cancel-in-progress: false`）で直列化されるので、**待ち行列が 1 本ぶん伸びるだけ**で
 * 害は無いが、無駄である（deploy job の実測は 73〜106s / 直近 6 run）。
 * cron と workflow_dispatch では今までどおり staging も配る（これらは push を伴わない）。
 */
const here = dirname(fileURLToPath(import.meta.url));
const wfDir = resolve(here, "../../../.github/workflows");
const deployData = readFileSync(resolve(wfDir, "deploy-data.yml"), "utf8");

/** 行末コメントを落とす（このディレクトリの YAML にクォート内の # は出てこない） */
function stripComment(line: string): string {
  const i = line.indexOf("#");
  return (i < 0 ? line : line.slice(0, i)).trimEnd();
}

const code = deployData.split("\n").map(stripComment).join("\n");

/** `on:` ブロック（次のトップレベルキーまで）をコメント除去した状態で返す */
function onBlock(): string[] {
  const lines = code.split("\n");
  const start = lines.findIndex((l) => /^on:\s*$/.test(l));
  assert.ok(start >= 0, "deploy-data.yml にトップレベルの on: が無い");
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    if (/^\S/.test(l)) break; // 次のトップレベルキー
    out.push(l);
  }
  return out;
}

/**
 * `on:` の中の 1 つのトリガ（`push:` など）の本体だけを返す。
 *
 * **`on:` ブロック全体から `paths:` を探してはいけない。** 変異 #1（`push:` を `pull_request:` に
 * 差し替える）を当てたとき、paths の検査が**素通りした**——`paths:` は依然として `on:` の中に
 * 在ったからである。**在る場所が意味を決める**ので、ここは親を指定して取り出す。
 */
function triggerBody(name: string): string[] | undefined {
  const block = onBlock();
  const head = new RegExp(`^\\s{2}${name}:\\s*$`);
  const start = block.findIndex((l) => head.test(l));
  if (start < 0) return undefined;
  const out: string[] = [];
  for (let i = start + 1; i < block.length; i++) {
    if (/^\s{2}\S/.test(block[i])) break; // 次のトリガ
    out.push(block[i]);
  }
  return out;
}

test("deploy-data.yml は main への push で起動する（#995: 人のマージが 29 本、何も起動していなかった）", () => {
  const push = triggerBody("push");
  assert.ok(
    push,
    "on: に push: が無い。人が data/ を含む PR をマージしても deploy-data が起動せず、" +
      "安全網の cron まで最大 27.99h（実測）本番が main から遅れる",
  );
  assert.match(push.join("\n"), /branches:\s*\[\s*main\s*\]/, "push の branches が [main] でない");
});

test("push の paths は data/ だけを拾う（コードの push で本番データ配信を起こさない）", () => {
  const push = triggerBody("push");
  assert.ok(push, "on: に push: が無い（paths 以前の問題）");
  const m = push.join("\n").match(/paths:\s*\n((?:\s{6}-\s*\S+\n?)+)/);
  assert.ok(m, "on.push に paths が無い。全 push で起動すると deploy-vps の待ち行列が不要に伸びる");
  const paths = m[1]
    .split("\n")
    .map((l) => l.trim().replace(/^-\s*/, "").replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  assert.deepEqual(paths, ["data/**"], `paths が data/** だけではない: ${JSON.stringify(paths)}`);
});

test("push のときは staging を配らない（deploy-staging.yml が同じ push で既に配る）", () => {
  const lines = code.split("\n");
  const start = lines.findIndex((l) => /^\s{2}staging:\s*$/.test(l));
  assert.ok(start >= 0, "deploy-data.yml に staging job が無い");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s{2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const job = lines.slice(start, end).join("\n");
  const cond = job.match(/^\s{4}if:\s*(.+)$/m)?.[1]?.trim();
  assert.ok(cond, "staging job に if: が無い。push のたびに同じ成果物を 2 回ビルドして 2 回 rsync する");
  assert.match(
    cond,
    /github\.event_name\s*!=\s*'push'/,
    `staging の if が push を除外していない: ${cond}`,
  );
});

test("production-data は push でも必ず配る（#995 で欠けていたのはこちら）", () => {
  const lines = code.split("\n");
  const start = lines.findIndex((l) => /^\s{2}production:\s*$/.test(l));
  assert.ok(start >= 0, "deploy-data.yml に production job が無い");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s{2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const job = lines.slice(start, end).join("\n");
  assert.doesNotMatch(
    job,
    /^\s{4}if:/m,
    "production job に if: が付いている。ここを条件付きにすると #995 が再発する",
  );
  assert.match(job, /environment:\s*production-data/, "production job の environment が production-data でない");
  assert.match(job, /data_ref:\s*main/, "production job の data_ref が main でない（#134: コードは released、データは main）");
});
