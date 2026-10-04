import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Issue #1039: **PR の本文を読む検査が、本文を直しても走り直さない。**
 *
 * `ci.yml` の `on: pull_request:` は `types:` を書いていなかったので、GitHub の既定
 * `opened` / `synchronize` / `reopened` だけで動いていた。**`edited` が無い。**
 * 本文だけを直しても新しい run が 1 つも作られない。
 *
 * ── 実測（2026-09-27、GraphQL で全 653 PR を走査）────────────────────────
 *
 * `gh pr list --limit 2000 --state all` は **653 件**を返す（打ち切られない）。
 * `pr-closes` job が入ったのは `ac4350d1`（2026-09-13T13:24:19Z）。
 *
 * 本文（作成後）の編集がある PR = 41 件。そのうち
 * **最後の本文編集より後に CI の run が 1 件も作られなかった PR = 12 件**
 * （#856 #893 #937 #967 #973 #974 #998 #1009 #1012 #1013 #1020 #1030）。**12/12 で 0 件。**
 *
 * **害は 0 件**: 12 件について `userContentEdits[].diff`（= その版の**本文全文**。#1020 で
 * 6404 文字が現在の body と一致することで確かめた）から「その run が判定に使った本文」を復元し、
 * 最終の本文と**両方に `scripts/ci/pr-closes.sh` を当てた**。**判定の食い違いは 0 件**
 * （12 件とも PASS → PASS）。**「0 件」であって「数えていない」ではない**（#757）。
 *
 * **危ないのは逆向き**である。本文から `Closes #N` を**消しても**走り直さないので**緑のまま**残る。
 * 「直したのに赤い」は人間から見えるが、**「壊したのに緑」は誰からも見えない。**
 *
 * ── なぜ ci.yml に `edited` を足さず、別ワークフローにしたか ───────────────
 * **最初は `ci.yml` に `types: [... edited]` を足し、本文を読まない job を
 * `if: github.event.action != 'edited'` で止める形で書いた。これは間違いだった**
 * （PR #1050 のレビューで指摘され、実測で確かめた）:
 *
 *   **`if:` で止めた job は「走らない」のではなく、`conclusion: skipped` の check run が
 *   新しい `started_at` で作られる。**
 *
 * 実測（PR #1050 の HEAD `87389bd1`）——`check` の check run が 2 本ある:
 *
 *     {"conclusion":"skipped","started_at":"2026-09-26T23:11:15Z"}   ← edited の run
 *     {"conclusion":"success","started_at":"2026-09-26T23:02:11Z"}   ← synchronize の run
 *
 * `scripts/po/merge-when-green.sh` の `fetch_checks()` は
 * `group_by(.name) | map(max_by(.started_at))` で**同名の最新 1 件だけ**を見て、
 * `skipped` を `pass` に入れる。だから **直前の run で赤かった必須チェックが、
 * 本文を 1 文字直すだけで緑に塗り替わる。** 同じ jq に食わせた実測:
 *
 *     入力: check failure (10:00) → check skipped (10:05)
 *     出力: pass  check  skipped        ← 赤が緑になる
 *
 * 該当する母数（実測 2026-09-27）: 本文編集 86 回のうち**直前の CI run の conclusion が
 * `failure` または `cancelled` だったのは 18 回 / 15 PR**（failure 8 + cancelled 10）。
 * **元の穴の実害が 0 件だったのに対し、こちらは 18 回ぶんの機会がある。**
 * 「赤いのに緑に見える」は #1021 のミスマージ 4 件と同じ構造なので、この道は採らなかった。
 *
 * **そこで `pr-closes` だけを `pr-body.yml` に切り出した。** `ci.yml` は 1 行も変わらない
 * （`pr-closes` job を抜いただけ）ので **`skipped` の check run は 1 つも生まれない。**
 * **チェック名は変わらない**——Actions のチェック名は **job 名だけ**で、ワークフロー名は入らない。
 * 実測: branch protection の必須 4 件は `["check","gitleaks","forbidden-patterns","audit"]` で、
 * **そのうち 3 件はすでに `security.yml` にある**。**branch protection の設定変更は要らない。**
 *
 * ── この検査が主張すること ──────────────────────────────────────────────
 * **「`types:` に `edited` という語が在る」では足りない**（#1017 / #1036 の「キー名しか見ていない
 * 検査が素通りした」実例）。ここが固定するのは**意味**である:
 *
 *   (1) **PR の本文を読む job は、本文が編集されたとき実際に走ること**
 *   (2) **本文を読まない job は、本文編集で `skipped` の check run を作らないこと**
 *
 * (2) が今回の本丸である。**`skipped` は「走らなかった」ではなく「緑」として記録される**ので、
 * **本文編集で走る job を増やすこと自体が危険**である——だから
 * **「本文編集で走るワークフローには、本文を読まない job が 1 つも無い」**を固定する。
 *
 * **「本文を実際に測るか」（step の `if:` や `run:` の早期 exit で緑のまま測らない形）は
 * ここでは見ていない**——`scripts/ci/test/pr-closes.test.sh` の wiring 検査が見る
 * （変異 N1 / N1b / N1c / N2 / N2b で確認済み）。**ワークフローの形はこちら、
 * step の中身はあちら**という分担にしてある。
 */
const here = dirname(fileURLToPath(import.meta.url));
const wfDir = resolve(here, "../../../.github/workflows");

/** 行末コメントを落とす（このディレクトリの YAML にクォート内の # は出てこない） */
function stripComment(line: string): string {
  const i = line.indexOf("#");
  return (i < 0 ? line : line.slice(0, i)).trimEnd();
}

const indentOf = (l: string) => l.length - l.trimStart().length;
const HEAD_LINE = /^(?:"([A-Za-z_][\w-]*)"|'([A-Za-z_][\w-]*)'|([A-Za-z_][\w-]*)):\s*$/;

type Job = {
  /** job ID */
  name: string;
  /** job 直下の `if:` の値（無ければ undefined） */
  cond?: string;
  /** job 直下の `needs:` に挙がった job ID */
  needs: string[];
  /** job の本文すべて（step の run:/env: を含む）。本文を読んでいるかの判定に使う */
  body: string;
};

type Workflow = {
  file: string;
  /** `on:` に pull_request があるか */
  onPullRequest: boolean;
  /** `on: pull_request: types:` に挙がった action。`types:` を書いていなければ undefined */
  prTypes?: string[];
  /** トップレベルの `concurrency: group:` の値（無ければ undefined） */
  concurrencyGroup?: string;
  /** トップレベルの `concurrency: cancel-in-progress:` の値 */
  cancelInProgress?: boolean;
  jobs: Job[];
};

/** GitHub の既定（`types:` を書かなかったときに動く action）。 */
const DEFAULT_PR_TYPES = ["opened", "synchronize", "reopened"];

/** `key:` 直下のブロックの行を、インデント規則だけで取り出す（#556 / #541 と同じ読み方）。 */
function blockUnder(lines: string[], topKey: RegExp): { i: number; line: string }[] {
  const start = lines.findIndex((l) => topKey.test(l));
  if (start < 0) return [];
  const body: { i: number; line: string }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    if (!/^\s/.test(l)) break;
    body.push({ i, line: l });
  }
  return body;
}

/** `types: [a, b]`（フロー）と `types:` + `- a`（ブロック）の両方を受ける。 */
function parseSeq(own: string[], key: string): string[] | undefined {
  const line = own.find((l) => new RegExp(`^\\s*${key}:`).test(l));
  if (!line) return undefined;
  const rhs = line.slice(line.indexOf(`${key}:`) + key.length + 1).trim();
  if (rhs.startsWith("[")) {
    return rhs
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter((s) => s !== "");
  }
  if (rhs !== "") return [rhs.replace(/^["']|["']$/g, "")];
  const d = indentOf(line);
  const seq: string[] = [];
  for (const l of own.slice(own.indexOf(line) + 1)) {
    if (indentOf(l) <= d) break;
    const m = l.trim().match(/^-\s*["']?([\w-]+)["']?$/);
    if (m) seq.push(m[1]);
  }
  return seq;
}

function parseOn(lines: string[], file: string): { onPullRequest: boolean; prTypes?: string[] } {
  // `on: push` のような 1 行形式はこのリポジトリに無いが、見落としを黙らせない
  assert.ok(!lines.some((l) => /^on:\s*\S/.test(l)), `${file}: 1 行形式の on: は未対応（この検査を書き直すこと）`);
  const body = blockUnder(lines, /^on:\s*$/);
  if (body.length === 0) return { onPullRequest: false };
  const depth = Math.min(...body.map((b) => indentOf(b.line)));
  const pr = body.find((b) => indentOf(b.line) === depth && /^pull_request:\s*$/.test(b.line.trim()));
  if (!pr) return { onPullRequest: false };
  const after = body.filter((b) => b.i > pr.i);
  const endIdx = after.findIndex((b) => indentOf(b.line) <= depth);
  const own = (endIdx < 0 ? after : after.slice(0, endIdx)).map((b) => b.line);
  return { onPullRequest: true, prTypes: own.length === 0 ? undefined : parseSeq(own, "types") };
}

/** `jobs:` 直下の job を、名前・`if:`・`needs:`・本文ごと取り出す。 */
function parseJobs(lines: string[], file: string): Job[] {
  const body = blockUnder(lines, /^jobs:\s*$/);
  if (body.length === 0) return [];
  const depth = Math.min(...body.map((b) => indentOf(b.line)));
  const heads = body
    .filter((b) => indentOf(b.line) === depth)
    .map((b) => ({ ...b, m: b.line.trim().match(HEAD_LINE) }))
    .filter((b): b is typeof b & { m: RegExpMatchArray } => b.m !== null);
  assert.ok(heads.length > 0, `${file}: jobs: の下に job が 1 つも無い`);
  return heads.map((h, n) => {
    const end = n + 1 < heads.length ? heads[n + 1].i : lines.length;
    const raw = lines.slice(h.i + 1, end).filter((l) => l.trim() !== "" && indentOf(l) > depth);
    const keyDepth = raw.length ? Math.min(...raw.map(indentOf)) : depth + 2;
    const direct = raw.filter((l) => indentOf(l) === keyDepth);
    const ifLine = direct.find((l) => /^\s*if:/.test(l));
    return {
      name: h.m[1] ?? h.m[2] ?? h.m[3],
      cond: ifLine ? ifLine.slice(ifLine.indexOf("if:") + "if:".length).trim() : undefined,
      needs: parseSeq(raw, "needs") ?? [],
      body: raw.join("\n"),
    };
  });
}

/** トップレベルの `concurrency:` を読む（job 内の concurrency はこのリポジトリに無い）。 */
function parseConcurrency(lines: string[]): { group?: string; cancel?: boolean } {
  const body = blockUnder(lines, /^concurrency:\s*$/).map((b) => b.line);
  const g = body.find((l) => /^\s*group:/.test(l));
  const c = body.find((l) => /^\s*cancel-in-progress:/.test(l));
  return {
    group: g ? g.slice(g.indexOf("group:") + "group:".length).trim() : undefined,
    cancel: c ? c.slice(c.indexOf("cancel-in-progress:") + "cancel-in-progress:".length).trim() === "true" : undefined,
  };
}

function parseWorkflowText(text: string, file: string): Workflow {
  const lines = text.split("\n").map(stripComment);
  const { onPullRequest, prTypes } = parseOn(lines, file);
  const { group, cancel } = parseConcurrency(lines);
  return { file, onPullRequest, prTypes, concurrencyGroup: group, cancelInProgress: cancel, jobs: parseJobs(lines, file) };
}

/** GitHub は .yml と .yaml の両方を実行する（#574）。 */
function allWorkflows(): Workflow[] {
  return readdirSync(wfDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .map((f) => parseWorkflowText(readFileSync(resolve(wfDir, f), "utf8"), f));
}

/**
 * **本文を読んでいる job** を名指しで見つける。
 * `github.event.pull_request.body` は**イベントのペイロード**から本文を取る唯一の書き方で、
 * API 経由（`gh pr view --json body` など）はこのリポジトリのワークフローには無い。
 * 実測 2026-09-27: `grep -rn 'pull_request.body\|pull_request.title' .github/workflows/` は 2 件
 * （どちらも pr-body.yml の pr-closes。1 件はその解説コメント）。
 */
const BODY_EXPR = /github\.event\.pull_request\.(body|title)/;
function jobsReadingBody(): { file: string; job: Job }[] {
  return allWorkflows().flatMap((w) => w.jobs.filter((j) => BODY_EXPR.test(j.body)).map((j) => ({ file: w.file, job: j })));
}

/**
 * `if:` は GitHub の式言語なので完全には解けない。**このリポジトリに実在する形だけを解いて、
 * 知らない形は落とす**（fail-closed）。知らない式が入ったらこの検査が落ちるので、
 * そのとき人が読んで解き方を足すことになる。**「解けないから走る」と黙って通さない。**
 *
 * `push` イベントでは `github.event.action` は**空**なので、`action != 'edited'` は真になる
 * （= push では今までどおり全部走る）。ここでは action を必ず渡すので pull_request だけを見る。
 */
function evalJobCondition(cond: string | undefined, action: string, file: string, job: string): boolean {
  if (cond === undefined) return true;
  const c = cond.replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "").trim();
  const and = c.split("&&");
  if (and.length > 1) return and.every((p) => evalJobCondition(p.trim(), action, file, job));
  if (/^github\.event_name\s*==\s*'pull_request'$/.test(c)) return true;
  if (/^github\.event_name\s*!=\s*'pull_request'$/.test(c)) return false;
  // 本文編集で重い job を走らせないための形
  const neq = c.match(/^github\.event\.action\s*!=\s*'([a-z_]+)'$/);
  if (neq) return action !== neq[1];
  const eq = c.match(/^github\.event\.action\s*==\s*'([a-z_]+)'$/);
  if (eq) return action === eq[1];
  // schedule / workflow_dispatch 専用の job（security.yml の issue-secrets）は pull_request では走らない
  if (/^github\.event_name\s*==\s*'(schedule|workflow_dispatch)'(\s*\|\|\s*github\.event_name\s*==\s*'(schedule|workflow_dispatch)')*$/.test(c)) return false;
  assert.fail(`${file}:${job}: if: の形を解けない [${cond}]。この検査に解き方を足すこと（#1039）`);
}

/**
 * **`pull_request` の 1 つの action を模擬して、走る job の集合を返す。**
 *
 * ここがこの検査の本体である。`types` に語が在るかではなく、
 * **「その action のとき、その job は実際に走るか」**を組み立てる:
 *   1. ワークフローが `pull_request` を持ち、その action が types に含まれるか（未指定なら既定の 3 つ）
 *   2. job 自身の `if:` が、その action で真になるか
 *   3. `needs:` の相手が走るか（相手が走らなければこの job も走らない）
 */
function jobsRunningFor(action: string): Set<string> {
  const run = new Set<string>();
  for (const w of allWorkflows()) {
    if (!w.onPullRequest) continue;
    if (!(w.prTypes ?? DEFAULT_PR_TYPES).includes(action)) continue;
    const cand = w.jobs.filter((j) => evalJobCondition(j.cond, action, w.file, j.name));
    const ok = new Set<string>();
    // needs は収束するまで回す（このリポジトリの needs は 1 段だが、一般に書く）
    for (let pass = 0; pass <= w.jobs.length; pass++) {
      for (const j of cand) if (!ok.has(j.name) && j.needs.every((n) => ok.has(n))) ok.add(j.name);
    }
    for (const n of ok) run.add(`${w.file}:${n}`);
  }
  return run;
}

// ── 数え上げそのものの検査（#500: 入口を固定する。ここが壊れたら下は全部無意味）─────────

test("#1039 パーサ: types 未指定の pull_request は GitHub の既定 3 つとして読む", () => {
  const w = parseWorkflowText(["on:", "  pull_request:", "  push:", "    branches: [main]", "jobs:", "  a:", "    runs-on: x"].join("\n"), "p.yml");
  assert.equal(w.onPullRequest, true);
  assert.equal(w.prTypes, undefined);
  // 未指定は既定の 3 つで動き、edited では動かない
  assert.equal(DEFAULT_PR_TYPES.includes("edited"), false);
});

test("#1039 パーサ: types のフロー形式 [a, b] とブロック形式（- a）の両方を読む", () => {
  const flow = parseWorkflowText(["on:", "  pull_request:", "    types: [opened, edited]", "jobs:", "  a:", "    runs-on: x"].join("\n"), "p.yml");
  assert.deepEqual(flow.prTypes, ["opened", "edited"]);
  const block = parseWorkflowText(["on:", "  pull_request:", "    types:", "      - opened", "      - edited", "jobs:", "  a:", "    runs-on: x"].join("\n"), "p.yml");
  assert.deepEqual(block.prTypes, ["opened", "edited"]);
});

test("#1039 パーサ: job の if: と needs: を拾い、needs の相手が止まれば連れて止まる", () => {
  const w = parseWorkflowText(
    ["on:", "  pull_request:", "    types: [edited]", "jobs:", "  a:", "    if: github.event.action != 'edited'", "    runs-on: x", "  b:", "    needs: a", "    runs-on: x"].join("\n"),
    "p.yml",
  );
  assert.deepEqual(w.jobs.map((j) => j.name), ["a", "b"]);
  assert.equal(w.jobs[0].cond, "github.event.action != 'edited'");
  assert.deepEqual(w.jobs[1].needs, ["a"]);
  // a が止まるので b も走らない（needs を解いている証拠）
  assert.equal(evalJobCondition(w.jobs[0].cond, "edited", "p.yml", "a"), false);
});

test("#1039 パーサ: 解けない if: は「走る」と決めつけず落とす（fail-closed）", () => {
  assert.throws(() => evalJobCondition("github.actor == 'dependabot[bot]'", "edited", "p.yml", "j"), /解けない/);
});

// ── 本丸 ─────────────────────────────────────────────────────────────────

/**
 * **母数を固定する。** 本文を読む job が増えたら、この検査の対象も増えなければならない。
 * 名前を書き換えて対象から外す／本文の読み方を変えて不可視にする、が黙って通らないように
 * **件数と名前の両方**を固定する（#499: allowlist は名指しし、中身も固定する）。
 */
test("#1039 母数: PR の本文を読む job は pr-body.yml:pr-closes だけ", () => {
  assert.deepEqual(jobsReadingBody().map((x) => `${x.file}:${x.job.name}`).sort(), ["pr-body.yml:pr-closes"]);
});

/**
 * **これがこの Issue の本丸。**
 *
 * 「壊したのに緑」——本文から `Closes #N` を消しても検査が走り直さない——が塞がったことを、
 * **`edited` イベントを模擬して**固定する。`types` に `edited` を足しただけで
 * job の `if:` が `edited` を弾いていれば、ここは落ちる。
 */
test("#1039 PR の本文を読む job は、本文が編集された（edited）ときに実際に走る", () => {
  const readers = jobsReadingBody().map((x) => `${x.file}:${x.job.name}`);
  assert.ok(readers.length > 0, "本文を読む job が 1 つも無い（母数の検査が先に落ちるはず）");
  const running = jobsRunningFor("edited");
  for (const r of readers) {
    assert.ok(running.has(r), `${r} は PR の本文を読むのに、本文が編集されても走らない（#1039）。edited で走る job: [${[...running].sort().join(", ")}]`);
  }
});

/**
 * **`edited` を足しても、既定の 3 つが落ちていないこと。**
 * `types:` を書いた瞬間、書かなかった分は**消える**（GitHub の仕様）。
 * `types: [edited]` だけにすると **PR を開いても CI が走らなくなる**——
 * それは「緑にならない」ではなく「**検査が存在しなくなる**」で、はるかに重い。
 */
test("#1039 types を書いたワークフローは opened / synchronize / reopened を落としていない", () => {
  const written = allWorkflows().filter((w) => w.onPullRequest && w.prTypes !== undefined);
  assert.ok(written.length > 0, "types: を書いた pull_request ワークフローが 1 つも無い（#1039 は types を足す PBI）");
  for (const w of written) {
    for (const d of DEFAULT_PR_TYPES) {
      assert.ok(w.prTypes?.includes(d), `${w.file}: types に ${d} が無い。types を書くと既定は消える`);
    }
  }
});

/**
 * **これが今回の本丸。**
 *
 * **`if:` で止めた job は「走らない」のではなく、`conclusion: skipped` の check run が
 * 新しい `started_at` で作られる**（PR #1050 の HEAD で実測。上の docblock 参照）。
 * `merge-when-green.sh` は同名の最新 1 件だけを見て `skipped` を `pass` に入れるので、
 * **直前の run で赤かった必須チェックが、本文を 1 文字直すだけで緑に塗り替わる。**
 *
 * だから **`if:` で止めるのでは足りない**——**本文編集で起動するワークフロー自体に、
 * 本文を読まない job を 1 つも置かない。** そのワークフローの job が全部「本文を読む」なら、
 * `skipped` で塗り替わる相手がいない。
 *
 * **この検査は `if:` を数えない。** 「`edited` で起動するワークフローの job 集合」と
 * 「本文を読む job 集合」が**一致する**ことだけを見るので、
 * `if:` を使って逃げる形（= `skipped` が生まれる形）はすべてここで落ちる。
 */
test("#1039 edited で起動するワークフローの job は、すべて PR の本文を読む（skipped を作らない）", () => {
  const readers = new Set(jobsReadingBody().map((x) => `${x.file}:${x.job.name}`));
  const editedWfs = allWorkflows().filter((w) => w.onPullRequest && (w.prTypes ?? DEFAULT_PR_TYPES).includes("edited"));
  assert.ok(editedWfs.length > 0, "edited で起動する pull_request ワークフローが 1 つも無い（#1039 は edited を足す PBI）");
  // **`if:` の有無に関わらず、そのワークフローに在る job を全部**数える。
  // `if:` で止めた job は「走らない」のではなく `skipped` の check run を作るので、
  // **在るだけで危険**である（それが今回の本丸）。
  const nonReaders = editedWfs
    .flatMap((w) => w.jobs.map((j) => `${w.file}:${j.name}`))
    .filter((n) => !readers.has(n))
    .sort();
  assert.deepEqual(
    nonReaders,
    [],
    `edited で起動するワークフローに、PR の本文を読まない job がある: ${nonReaders.join(", ")}。` +
      " その job は本文編集で conclusion: skipped の check run を作り、merge-when-green.sh の" +
      " max_by(started_at) が直前の failure を上書きして pass に見せる（#1039）",
  );
});

/**
 * **逆向き: `ci.yml` は `edited` で起動しないこと。**
 * 上の検査は「`edited` のワークフローに本文を読まない job を置かない」を見るが、
 * **`ci.yml` に `edited` を足したうえで `check` に `if:` を付ける**という形は、
 * 上だけでは「`check` は本文を読まない job だ」として落ちる——つまり上で覆えている。
 * それでも **名指しで固定する**のは、`ci.yml` が必須チェック `check` を持つ唯一のワークフローで、
 * **ここに `edited` が入った瞬間に「赤が緑に塗り替わる」道が開く**からである（#1050 で実測した穴）。
 */
test("#1039 ci.yml（必須の check を持つ）は edited で起動しない", () => {
  const ci = allWorkflows().find((w) => w.file === "ci.yml");
  assert.ok(ci, "ci.yml が無い");
  assert.ok(ci.onPullRequest, "ci.yml が pull_request で起動しない（前提が変わった）");
  assert.ok(
    ci.jobs.some((j) => j.name === "check"),
    "ci.yml に check job が無い（必須チェックの居場所が変わったなら、この検査を書き直すこと）",
  );
  assert.equal(
    (ci.prTypes ?? DEFAULT_PR_TYPES).includes("edited"),
    false,
    "ci.yml が edited で起動する。本文編集で check に conclusion: skipped の check run が作られ、" +
      " 直前の failure を上書きして緑に見せる（#1039 / PR #1050 で実測）",
  );
});

/**
 * **`edited` のワークフローが、`ci.yml` の走っている run を cancel しないこと。**
 *
 * `ci.yml` は `cancel-in-progress: true` である。もし `pr-body.yml` が同じ concurrency group を
 * 使ってしまうと、**本文を 1 文字直すたびに走っている `check`（実測 中央値 531s）を cancel する。**
 * cancel は成功でも失敗でもないので、**必須チェックの `check` が「無い」状態**になる。
 * 実測（2026-09-27）: 本文編集 86 回のうち **39 回（45%）が CI run の実行中**に起きていた
 * （run の `created_at` <= 編集時刻 <= `updated_at` で数えた。窓の仮定を置かない実測）。
 *
 * **別ワークフローなら group 名が別なので原理的に起きない**——それを**固定する**。
 * group 名は**文字列として別**であればよいので、ここでは「同じ式になっていないこと」を見る。
 */
test("#1039 edited のワークフローは ci.yml と別の concurrency group を使う", () => {
  const editedWfs = allWorkflows().filter((w) => w.onPullRequest && (w.prTypes ?? DEFAULT_PR_TYPES).includes("edited"));
  assert.ok(editedWfs.length > 0, "edited で起動する pull_request ワークフローが 1 つも無い");
  const ci = allWorkflows().find((w) => w.file === "ci.yml");
  assert.ok(ci?.concurrencyGroup, "ci.yml に concurrency group が無い");
  // **この検査が守っているものの前提**: ci.yml が cancel-in-progress: true であること。
  // false になれば巻き込みは原理的に起きないので、そのときはこの検査ごと見直す
  // （黙って「何も主張しない緑」にならないよう、前提を明示して落とす）。
  assert.equal(ci.cancelInProgress, true, "ci.yml の cancel-in-progress が true でなくなった（この検査の射程を見直すこと）");
  for (const w of editedWfs) {
    assert.ok(w.concurrencyGroup, `${w.file}: concurrency group が無い（同じ PR で run が積み上がる）`);
    assert.notEqual(
      w.concurrencyGroup,
      ci.concurrencyGroup,
      `${w.file} が ci.yml と同じ concurrency group [${ci.concurrencyGroup}] を使っている。` +
        " ci.yml は cancel-in-progress: true なので、本文編集が走っている check を cancel し、必須チェックが消える（#1039）",
    );
    // **group は ref を含むこと。** 含まないと **別の PR の run を互いに cancel する**
    // （同じ group 名になるので）。これは「本文編集で必須チェックが消える」より広い事故になる。
    assert.match(
      w.concurrencyGroup as string,
      /github\.ref|github\.event\.pull_request\.number|github\.head_ref/,
      `${w.file}: concurrency group が PR ごとに分かれていない（別の PR の run を cancel する）`,
    );
  }
});

/**
 * **必須の 4 つに同じ穴が無いこと**（Issue #1039 のやること 4）。
 * `check` / `gitleaks` / `forbidden-patterns` / `audit`（`gh api .../branches/main/protection`
 * で実測した必須 4 件）は**コードを見る**検査なので本文編集の影響を受けない——
 * **「はず」ではなく、本文を読んでいないことを確かめる。**
 */
test("#1039 必須の 4 つ（check/gitleaks/forbidden-patterns/audit）は PR の本文を読まない", () => {
  const REQUIRED = ["check", "gitleaks", "forbidden-patterns", "audit"];
  const readers = jobsReadingBody().map((x) => x.job.name);
  const found = allWorkflows().flatMap((w) => w.jobs.filter((j) => REQUIRED.includes(j.name)).map((j) => j.name));
  assert.deepEqual(found.sort(), [...REQUIRED].sort(), "必須 4 件の job が見つからない（名前が変わった？）");
  for (const r of REQUIRED) assert.ok(!readers.includes(r), `${r} が PR の本文を読んでいる（#1039 の穴が必須の検査に及ぶ）`);
});

/**
 * **`synchronize`（push）と `opened` では、今までどおり全部走ること。**
 * `if:` の付け方を間違えて重い job を常に止めてしまう、という壊し方を塞ぐ。
 * これが無いと「本文編集で余計な job が走らない」を `if: false` で満たせてしまう。
 */
for (const action of ["synchronize", "opened", "reopened"]) {
  test(`#1039 ${action} では ci.yml / pr-body.yml / security.yml の job が全部走る`, () => {
    const running = jobsRunningFor(action);
    // #1162: `stale-base-net-deletions` を足した。**割った job は、割る前と同じく
    // `synchronize` / `opened` / `reopened` で走らなければならない。**
    // これを書かないと、**割ったほうの 1 本だけ #1039 の穴が無検査**になる
    // （`if:` を書き損じて止めても、ここは緑のまま）。
    for (const n of ["ci.yml:stale-base", "ci.yml:stale-base-net-deletions", "ci.yml:check", "ci.yml:docker-web", "pr-body.yml:pr-closes", "security.yml:gitleaks", "security.yml:forbidden-patterns", "security.yml:audit"]) {
      assert.ok(running.has(n), `${n} が ${action} で走らない`);
    }
  });
}
