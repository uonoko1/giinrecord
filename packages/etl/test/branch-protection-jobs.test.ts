import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Issue #541（#524 が「そのレイヤでは塞げない」と明記して残した半分）:
 *
 * `deploy/test/branch-protection.test.sh` の `t_required_checks_match_workflows` は
 * **ワークフローの job ⊆ 必須チェック** という片方向の部分集合しか見ていなかった。job を消すと
 * 突き合わせる側の集合が痩せるので、判定は自動的に満たされる（#499「痩せたら落とす」の片側しか
 * カバーしない）。実測（このテストを書く前、origin/main で）:
 *
 *   security.yml の gitleaks: job を改名 → deploy/test/branch-protection.test.sh は 18 passed 1 failed（落ちる）
 *   security.yml から gitleaks: job を丸ごと削除 → 19 passed 0 failed（落ちない）
 *
 * ここでは bash の sed/grep で YAML を読むのをやめ（作業合意「言語の構造は、その言語の実装に解かせる」）、
 * `packages/etl/test/workflow-timeout.test.ts`（#556）と同じ「YAML のインデント規則そのものを使う」
 * 構造的な読み方で job を数え上げ、**双方向**に突き合わせる:
 *
 *   (A) pull_request で走る job のうち、許容リストに無いものは全部 REQUIRED_CHECKS に入っている
 *       ＝ #524 が塞げなかった方向（job を消す／改名すると REQUIRED_CHECKS 側に対応が無くなり検出できる）
 *   (B) REQUIRED_CHECKS の各要素は、pull_request で走るどれかの job に対応している
 *       ＝ #524 が既に塞いでいた方向（すり替え・改名で REQUIRED_CHECKS が浮いたら検出する）
 *
 * 許容リスト（pull_request で走るが意図的に必須にしていない job）は #484/#499 の言う
 * 「allowlist は名指しし、その中身も固定する」形でハードコードする。
 *   ci.yml:stale-base          #536 の検査。#524 のレビューで既に必須外と確認済み
 *   ci.yml:docker-web          Issue #541 本文が名指しした例外そのもの
 *   branch-protection.yml:guard  自分自身の検査。paths 限定の pull_request でしか走らない
 *   environment-protection.yml:guard  同上（#661）。paths 限定なので、必須にすると
 *                              その paths を触らない PR が永久に pending でマージできなくなる
 */
const here = dirname(fileURLToPath(import.meta.url));
const wfDir = resolve(here, "../../../.github/workflows");

type Job = { file: string; name: string; onPullRequest: boolean };

/** 行末コメントを落とす（このディレクトリの YAML にクォート内の # は出てこない） */
function stripComment(line: string): string {
  const i = line.indexOf("#");
  return (i < 0 ? line : line.slice(0, i)).trimEnd();
}

const HEAD_LINE = /^(?:"([A-Za-z_][A-Za-z0-9_-]*)"|'([A-Za-z_][A-Za-z0-9_-]*)'|([A-Za-z_][A-Za-z0-9_-]*)):\s*$/;

/**
 * job 名の集合を、YAML のインデント規則で取り出す（#556 の jobsOfText と同じ考え方: 正規表現で
 * 構文を推測するのではなく、`jobs:` の次のより深いインデントのブロックを job のマッピングとして扱う）。
 * ここでは job の「本文」までは見ず、名前と、その workflow がトップレベルで pull_request を
 * トリガーに持つかどうかだけを持ち帰る。job 個別の `if:` 条件（例: stale-base の
 * `if: github.event_name == 'pull_request'`）まではここでは解かない — その区別は下の許容リストが担う。
 */
function jobNamesOfText(text: string): string[] {
  const lines = text.split("\n").map(stripComment);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.ok(start >= 0, "トップレベルの jobs: が見つからない");

  const body: { i: number; line: string }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    if (!/^\s/.test(l)) break;
    body.push({ i, line: l });
  }
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const depth = Math.min(...body.map((b) => indentOf(b.line)));

  return body
    .filter((b) => indentOf(b.line) === depth)
    .map((b) => b.line.trim().match(HEAD_LINE))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => m[1] ?? m[2] ?? m[3]);
}

/** トップレベルの `on:` ブロックが `pull_request:` キーを持つかどうか（インデント規則。正規表現で全文を漁らない）。 */
function hasPullRequestTrigger(text: string): boolean {
  const lines = text.split("\n").map(stripComment);
  const start = lines.findIndex((l) => /^on:\s*$/.test(l));
  assert.ok(start >= 0, "トップレベルの on: が見つからない");
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    if (!/^\s/.test(l)) break;
    if (/^\s{2}pull_request:\s*$/.test(l)) return true;
  }
  return false;
}

function jobsOf(file: string): Job[] {
  const text = readFileSync(resolve(wfDir, file), "utf8");
  const onPR = hasPullRequestTrigger(text);
  return jobNamesOfText(text).map((name) => ({ file, name, onPullRequest: onPR }));
}

/** GitHub は `.yml` と `.yaml` の両方を実行する（#574）。 */
function listAllJobs(): Job[] {
  return readdirSync(wfDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .flatMap(jobsOf);
}

const id = (j: { file: string; name: string }) => `${j.file}:${j.name}`;

/**
 * 意図的に必須チェックにしていない job（#541 本文が名指しした docker-web を含む）。
 * ハードコードする（#499: 期待値はハードコードする。対象から生成すると自己参照になる）。
 * 中身が痩せても入れ替わっても、下のテストで固定する。
 */
const EXEMPT_FROM_REQUIRED: readonly string[] = [
  "ci.yml:stale-base",
  "ci.yml:docker-web",
  "branch-protection.yml:guard",
  // #661: branch-protection.yml:guard と同じ理由。paths 限定の pull_request でしか走らないので、
  // 必須チェックにすると**その paths を触らない PR では永久に pending のまま**マージできなくなる。
  "environment-protection.yml:guard",
];

/**
 * 必須ステータスチェックとして GitHub に登録されている名前（deploy/monitor/branch-protection.sh の
 * REQUIRED_CHECKS と同じ値）。ここでもハードコードする — bash 配列を実行時に読みにいくと、
 * 両者が同じ壊れ方をした場合に気づけない（#521 レビューで実際にあった「両方の集合を同時に痩せさせると
 * 通る」形。本ファイルは branch-protection.sh から独立した第三の場所として存在する）。
 */
const REQUIRED_CHECKS: readonly string[] = ["check", "gitleaks", "forbidden-patterns", "audit"];

const allJobs = listAllJobs();

test("数え上げそのものの検査: allJobs が全 workflow の job を拾えている（拾えていなければ以降は無意味）", () => {
  const found = allJobs.map(id).sort();
  assert.deepEqual(found, [
    "branch-protection.yml:guard",
    "ci.yml:check",
    "ci.yml:docker-web",
    "ci.yml:stale-base",
    "deploy-data.yml:production",
    "deploy-data.yml:resolve",
    "deploy-data.yml:staging",
    "deploy-site.yml:deploy",
    "deploy-staging.yml:staging",
    "districts.yml:districts",
    "environment-protection.yml:guard",
    "etl.yml:etl",
    "link-check.yml:link-check",
    "local-assemblies.yml:local-assemblies",
    "monitor.yml:production",
    "monitor.yml:staging",
    "release.yml:production",
    "release.yml:released-tag",
    "security.yml:gitleaks",
    "security.yml:forbidden-patterns",
    "security.yml:audit",
  ].sort());
});

test("数え上げそのものの検査: pull_request トリガーを持つ workflow を正しく識別できている", () => {
  const onPR = [...new Set(allJobs.filter((j) => j.onPullRequest).map((j) => j.file))].sort();
  assert.deepEqual(onPR, ["branch-protection.yml", "ci.yml", "environment-protection.yml", "security.yml"]);
});

/**
 * (A) #524 が塞げなかった方向: pull_request で走る job のうち、許容リストに無いものは
 * 全部 REQUIRED_CHECKS に入っている。job を削除するとその job 自体がここから消えるので
 * 「消えたことに気づけない」ように見えるが、REQUIRED_CHECKS 側は独立にハードコードされているため、
 * その job 名を要求する行が REQUIRED_CHECKS に残る一方 want には現れなくなり、
 * 差は (B) 側で検出される。ここで直接踏む再現は「改名」（job 名が変わり、
 * 新しい名前が allowlist にも REQUIRED_CHECKS にも無い）。
 */
test("#541 pull_request で走る job のうち許容リストに無いものは、全部 REQUIRED_CHECKS に入っている", () => {
  const onPR = allJobs.filter((j) => j.onPullRequest);
  const mustBeRequired = onPR.filter((j) => !EXEMPT_FROM_REQUIRED.includes(id(j)));
  const missing = mustBeRequired.filter((j) => !REQUIRED_CHECKS.includes(j.name)).map(id);
  assert.deepEqual(
    missing,
    [],
    `pull_request で走る job なのに必須チェックに入っておらず、許容リストにも無い: ${missing.join(", ")}`,
  );
});

/**
 * (B) #524 が既に塞いでいた方向: REQUIRED_CHECKS の各要素は、実在する job に対応している。
 * job を削除しても REQUIRED_CHECKS は変わらないので、対応する job が消えればここで検出できる
 * ——これが (A) と組みになって初めて「削除方向」を捕まえる。
 */
test("#541 REQUIRED_CHECKS の各要素は、実在する pull_request 上の job に対応している", () => {
  const names = new Set(allJobs.filter((j) => j.onPullRequest).map((j) => j.name));
  const dangling = REQUIRED_CHECKS.filter((c) => !names.has(c));
  assert.deepEqual(
    dangling,
    [],
    `REQUIRED_CHECKS に名前があるが、対応する job が無い（job が消えた/改名された可能性）: ${dangling.join(", ")}`,
  );
});

/** 許容リストが痩せても入れ替わっても落ちる（#484/#499）。中身をそのまま固定する。 */
test("#541 許容リスト（意図的に必須外にしている job）は中身が固定されている", () => {
  assert.deepEqual(
    [...EXEMPT_FROM_REQUIRED].sort(),
    ["branch-protection.yml:guard", "ci.yml:docker-web", "ci.yml:stale-base", "environment-protection.yml:guard"].sort(),
  );
});

/**
 * 偽陽性が出ないこと: いまの本物の workflow 構成で (A)(B) とも緑になることをこのテスト自身が保証する
 * （上の2テストがまさにそれだが、ここでは「許容リストに載っている job が実在する」ことも確かめる —
 * allowlist が指す先が既に消えた job 名のままだと、許容リストの意味が失われる）。
 */
test("#541 許容リストの各要素は実在する job を指している（消えた job を許し続けない）", () => {
  const ids = new Set(allJobs.map(id));
  const stale = EXEMPT_FROM_REQUIRED.filter((e) => !ids.has(e));
  assert.deepEqual(stale, [], `許容リストが指す job が実在しない（job が消えた/改名された）: ${stale.join(", ")}`);
});

/**
 * #521 のレビューで実際にあった形: 「必須チェックの一覧」を検査する側と、実際に見張る
 * `deploy/monitor/branch-protection.sh` の REQUIRED_CHECKS の両方を**同時に**痩せさせると、
 * どちらも自分の中だけでは矛盾せず通ってしまう。ここは branch-protection.sh の配列を独立に読み、
 * このファイルのハードコード値（REQUIRED_CHECKS 定数）と一致することを確かめる — 一方だけ書き換えると
 * 必ず食い違いが出る。bash の `NAME=(a b c d)` という単純な配列リテラルなので、YAML と違って
 * ネストや複数行を持たず、そのまま安全にトークン分割できる。
 */
test("#541 branch-protection.sh の REQUIRED_CHECKS と、このファイルの REQUIRED_CHECKS が一致する", () => {
  const shPath = resolve(here, "../../../deploy/monitor/branch-protection.sh");
  const sh = readFileSync(shPath, "utf8");
  const m = sh.match(/^REQUIRED_CHECKS=\(([^)]*)\)\s*$/m);
  assert.ok(m, "deploy/monitor/branch-protection.sh に REQUIRED_CHECKS=(...) が見つからない");
  const fromShell = m[1].trim().split(/\s+/).filter(Boolean).sort();
  assert.deepEqual(
    fromShell,
    [...REQUIRED_CHECKS].sort(),
    "branch-protection.sh の REQUIRED_CHECKS と packages/etl 側の REQUIRED_CHECKS が食い違っている",
  );
});
