import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Issue #1110: `.github/workflows/scrum-monitor.yml` の**守りの step が実在すること**を
 * 静的に固定する。
 *
 * **なぜ要るか（#1150 のレビューが実測した）:**
 * **`if: always()` の後段（#547 の穴を塞ぐ step）を丸ごと削除しても、
 * `scripts/po/test/run.sh` の 253 件と etl の workflow 検査 69 件が全部緑だった。**
 * 担当者は「ワークフローの `if:` は手元で流せないのでテストが無い」と書いたが、
 * **レビュアーの指摘どおり「流せない」は「`if:` の存在を検査できない」ではない。**
 *
 * **先例がある**: `branch-protection-jobs.test.ts` の
 * 「#940 イベントで閉じてあることを理由に必須外にした job は、その `if:` が実在する」が
 * **同じことをしている**——**`if:` を文字列として読み、理由が成り立っているかを見る。**
 * ここはそれに倣う。
 *
 * **この検査が守るもの**（#547 の型。**`BRANCH_PROTECTION_TOKEN` が無い cron が
 * 23 回連続 failure で死んでいて、誰も気づかなかった**）:
 *   1. **監視を走らせる step が在り、PR では実際の GitHub を読まない**
 *   2. **その step に `id:` が在る**（後段が `steps.<id>.outcome` で参照するため。
 *      **`id:` が消えると後段の条件が常に偽になって黙る**）
 *   3. **`if: always()` を持つ後段が在り、前段が落ちたときに Issue を立てる**
 *   4. **後段が `deploy/monitor/report.sh` を呼ぶ**（Issue を立てる実体）
 *
 * **これは「ワークフローが動くこと」の証明ではない**（YAML の意味論は GitHub 側に在る）。
 * **「守りが消えていないこと」の証明である。** 消えたら落ちる。
 */
const here = dirname(fileURLToPath(import.meta.url));
const wfPath = resolve(here, "../../../.github/workflows/scrum-monitor.yml");
const text = readFileSync(wfPath, "utf8");

/** 行末コメントを落とす（このディレクトリの YAML はクォート内に # を持たない） */
function stripComment(line: string): string {
  const i = line.indexOf("#");
  return (i < 0 ? line : line.slice(0, i)).trimEnd();
}
const lines = text.split("\n").map(stripComment);

/**
 * `steps:` の下の step ブロックを、`- name:` / `- uses:` の区切りで拾う。
 * 各ブロックの本文（その step の行だけ）を返す。
 */
function steps(): string[] {
  const at = lines.findIndex((l) => /^\s*steps:\s*$/.test(l));
  assert.ok(at >= 0, "steps: が無い");
  const indent = (() => {
    for (let i = at + 1; i < lines.length; i++) {
      if (lines[i].trim() === "") continue;
      return lines[i].length - lines[i].trimStart().length;
    }
    return -1;
  })();
  assert.ok(indent > 0, "steps: の下に step が無い");
  const out: string[] = [];
  let cur: string[] | null = null;
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    const ind = l.length - l.trimStart().length;
    if (ind < indent) break; // steps を抜けた
    if (ind === indent && l.trimStart().startsWith("- ")) {
      if (cur) out.push(cur.join("\n"));
      cur = [l];
    } else if (cur) {
      cur.push(l);
    }
  }
  if (cur) out.push(cur.join("\n"));
  return out;
}

const ALL = steps();

// 数え上げそのものの検査（#500）。**拾えていなければ以降の検査は何も主張していない。**
test("#1110 数え上げ: scrum-monitor.yml の step を全部拾えている", () => {
  // checkout / unit tests / watch / 入口が死んだら Issue の 4 つ
  assert.equal(ALL.length, 4, `step の数が変わった（実測 2026-09-30: 4 件）: ${ALL.length}\n${ALL.join("\n---\n")}`);
});

test("#1110 監視を走らせる step が在り、pull_request では実際の GitHub を読まない", () => {
  // **`run:` で実際に呼ぶ step だけを採る**——**後段の step は Issue 本文の中で
  // このファイル名に言及する**ので、単なる出現で数えると 2 件になる（実測でそうなった）。
  const watch = ALL.filter((s) => /bash scripts\/po\/scrum-monitor-report\.sh/.test(s));
  assert.equal(watch.length, 1, `scrum-monitor-report.sh を run: で呼ぶ step が 1 件でない: ${watch.length}`);
  // **PR では読まない**（fork からの PR に issues:write は渡らず、Issue の開閉もしたくない）
  assert.match(
    watch[0],
    /if:\s*github\.event_name\s*!=\s*'pull_request'/,
    `監視の step が pull_request で閉じられていない:\n${watch[0]}`,
  );
});

/**
 * **`id:` が消えると後段の `steps.<id>.outcome` が空に解決して、条件が常に偽になる**
 * ——**黙って守りが消える形**（#1017 が扱った「空文字に解決させない」と同じ型）。
 */
test("#1110 監視の step に id: が在り、後段がその id を参照している", () => {
  const watch = ALL.find((s) => /bash scripts\/po\/scrum-monitor-report\.sh/.test(s));
  assert.ok(watch, "監視の step が無い");
  const m = /^\s*id:\s*(\S+)\s*$/m.exec(watch);
  assert.ok(m, `監視の step に id: が無い。後段が outcome を参照できない:\n${watch}`);
  const id = m[1];
  const guard = ALL.find((s) => /always\(\)/.test(s));
  assert.ok(guard, "if: always() を持つ step が無い");
  assert.ok(
    guard.includes(`steps.${id}.outcome`),
    `後段が steps.${id}.outcome を参照していない（id を変えたら両方直すこと）:\n${guard}`,
  );
});

/**
 * **#547 の本体。** **前段が判定に届かずに死んだとき**（checkout 失敗・timeout・OOM）、
 * **`scrum-monitor-report.sh` 自体が走っていないので Issue は立たない。**
 * **そのときこの step が立てる。** **これが無いと、失敗は Actions の履歴にしか残らない。**
 */
test("#1110 if: always() の後段が在り、前段が落ちたときに Issue を立てる (#547)", () => {
  const guard = ALL.filter((s) => /always\(\)/.test(s));
  assert.equal(guard.length, 1, `if: always() を持つ step が 1 件でない: ${guard.length}`);
  const g = guard[0];
  // 前段が **失敗したとき**に走る（`success()` ではなく `failure`）
  assert.match(g, /outcome\s*==\s*'failure'/, `前段の失敗を見ていない:\n${g}`);
  // **Issue を立てる実体を呼んでいる**（呼ばなければ「気づける」は嘘になる）
  assert.match(g, /deploy\/monitor\/report\.sh/, `report.sh を呼んでいない:\n${g}`);
  // **PR では立てない**（fork に issues:write は渡らない）
  assert.match(g, /github\.event_name\s*!=\s*'pull_request'/, `pull_request で閉じられていない:\n${g}`);
});

/**
 * **Issue の本文にサーバー情報を書かない**（OSS。この本文は公開される）。
 * **`scrum-monitor.sh` 側はテストで固定してあるが、この step は本文を自分で組む**ので、
 * ここでも見る。**「件数と URL だけ」**が守りたい線である。
 */
test("#1110 入口が死んだときの Issue 本文に、サーバー情報を書いていない", () => {
  const guard = ALL.find((s) => /always\(\)/.test(s));
  assert.ok(guard, "if: always() を持つ step が無い");
  // 絶対パス・ホスト名・IP らしきものを書いていない（`$RUNNER_TEMP` は GitHub 側の変数で可）
  const bad = [/\/home\//, /\/etc\//, /\/var\/www/, /\b\d{1,3}(\.\d{1,3}){3}\b/, /\bssh\b/i];
  for (const re of bad) {
    assert.ok(!re.test(guard), `Issue 本文に書いてはいけないものが在る（${re}）:\n${guard}`);
  }
});

/**
 * **schedule が在ること**（**入口が無ければ何も見張らない**）。
 * **`monitor.yml` と同じ分に置かない**——**Actions の並列枠を取り合う**ので
 * 10 分刻みの既定（毎時 0 分から）を避け、3 分ずらしてある。
 * **その意図が消えていないかを見る。**
 */
test("#1110 schedule が在り、monitor.yml の 10 分刻みとぶつけていない", () => {
  const cron = /cron:\s*"([^"]+)"/.exec(text);
  assert.ok(cron, "cron が無い。自動の入口が無い");
  // **`assert.notMatch` はこの node には無い**（実測: TypeError）。`!test` で書く。
  assert.ok(!/^\*\/10\b/.test(cron[1]), `monitor.yml と同じ 10 分刻みになっている: ${cron[1]}`);
  // 10 分ごとであること（#1099 の実測の間隔）は保ちたい
  assert.match(cron[1], /^3,13,23,33,43,53\b/, `10 分ごとの刻みが変わった: ${cron[1]}`);
});
