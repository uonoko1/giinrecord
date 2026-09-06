import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Issue #556: 無限ループに入ったジョブが、メッセージも出さずに**既定の 6 時間**走る。
 *
 * #530 のレビュアーの実測（同期の無限ループ）:
 *   exit=124（レビュアーの 600s timeout）  elapsed=656s  出力ゼロ
 *   60 秒後のメモリ 330MB（23GB 環境。OOM には到底届かない）
 * `vitest.config.ts` の `testTimeout: 20000` は**イベントループごとブロックされるので効かない**。
 * ジョブ側の `timeout-minutes` だけが止められる。
 *
 * ── なぜ「全 job に付ける」ではなく「runs-on の job に付ける」なのか ──────────────
 * `uses:` で再利用ワークフローを呼ぶ job には **`timeout-minutes` を書けない**
 * （GitHub の仕様。actionlint も syntax-check で落とす:
 *  「when a reusable workflow is called with "uses", "timeout-minutes" is not available.
 *   only following keys are allowed: "name", "uses", "with", "secrets", "needs", "if", "permissions"」）。
 * 呼び出し側は**ランナーを消費する job にならない**（実測: deploy-staging.yml の run 34030718679 の
 * ジョブ一覧は `staging / deploy` の 1 件だけ）。したがって呼び出し先である deploy-site.yml の
 * `deploy` に付けた 1 つが、4 つの呼び出し側すべての実体を覆う。
 *
 * このテストは「**ランナーを消費する job に timeout-minutes があること**」を固定する。
 * 付けられない job に「付けろ」と要求すると、それを満たす方法が無く、CI を永久に赤にする。
 */
const here = dirname(fileURLToPath(import.meta.url));
const wfDir = resolve(here, "../../../.github/workflows");

type Job = { file: string; name: string; kind: "runs-on" | "uses"; timeout?: number };

/** 行末コメントを落とす（このディレクトリの YAML にクォート内の # は出てこない） */
function stripComment(line: string): string {
  const i = line.indexOf("#");
  return (i < 0 ? line : line.slice(0, i)).trimEnd();
}

/**
 * `jobs:` 直下のキーと、その本体だけを取り出す。
 *
 * 正規表現で YAML を読むのは作業合意が繰り返し戒めている（#451/#472/#481/#483）ので、
 * ここは**構文を推測しない**形にしてある: 使うのは YAML のインデント規則そのもの
 * （`jobs:` の次の、より深いインデントのブロックが jobs のマッピング。その中で
 *  **最も浅いインデントのキー**が job 名。job の本体はその次の同インデントのキーまで）。
 * 依存を足さずに済ませるための割り切りだが、**取りこぼしたら分かる**ように
 * 下の「数え上げそのものの検査」で件数と名前を固定してある（#500: 入口を固定する）。
 */
/**
 * job 名の 1 行にマッチする。GitHub の job ID 規則（英数字・`-`・`_`、先頭は英字か `_`）は
 * クォートしても変わらない値なので、クォート無し／ダブルクォート／シングルクォートの
 * 3 通りを同じ ID 規則で受け止める（#574: クォートを付けるだけで数え上げをすり抜けていた）。
 */
const HEAD_LINE = /^(?:"([A-Za-z_][A-Za-z0-9_-]*)"|'([A-Za-z_][A-Za-z0-9_-]*)'|([A-Za-z_][A-Za-z0-9_-]*)):\s*$/;

function jobsOfText(text: string, file: string): Job[] {
  const lines = text.split("\n").map(stripComment);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.ok(start >= 0, `${file}: トップレベルの jobs: が見つからない`);

  // jobs: 配下（インデントが 1 以上）の行だけを集め、その中の最小インデントを job 名の深さとする
  const body: { i: number; line: string }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    if (!/^\s/.test(l)) break; // インデントが戻った = jobs: の終わり
    body.push({ i, line: l });
  }
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const depth = Math.min(...body.map((b) => indentOf(b.line)));

  const heads = body
    .filter((b) => indentOf(b.line) === depth)
    .map((b) => ({ ...b, m: b.line.trim().match(HEAD_LINE) }))
    .filter((b): b is typeof b & { m: RegExpMatchArray } => b.m !== null);
  return heads.map((h, n) => {
    const end = n + 1 < heads.length ? heads[n + 1].i : lines.length;
    const own = lines.slice(h.i + 1, end).filter((l) => l.trim() !== "" && indentOf(l) > depth);
    // job 直下のキーだけを見る（steps の中の uses: を job の uses: と取り違えないため）
    const keyDepth = own.length ? Math.min(...own.map(indentOf)) : depth + 2;
    const direct = own.filter((l) => indentOf(l) === keyDepth);
    const timeoutLine = direct.find((l) => /^\s*timeout-minutes:/.test(l));
    return {
      file,
      name: h.m[1] ?? h.m[2] ?? h.m[3],
      kind: direct.some((l) => /^\s*uses:/.test(l)) ? "uses" : "runs-on",
      timeout: timeoutLine ? Number(timeoutLine.split(":")[1].trim()) : undefined,
    };
  });
}

function jobsOf(file: string): Job[] {
  return jobsOfText(readFileSync(resolve(wfDir, file), "utf8"), file);
}

/** GitHub は `.yml` と `.yaml` の両方を実行する。`.yml` だけ見ると .yaml のワークフローが丸ごと不可視になる（#574）。 */
const allJobs = readdirSync(wfDir)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .sort()
  .flatMap(jobsOf);

const id = (j: Job) => `${j.file}:${j.name}`;

/**
 * #574: 引用符付きの job 名（`"deploy":` / `'deploy':`）が数え上げをすり抜けていた。
 * YAML としては `deploy:` と同じ job ID だが、パーサの正規表現 `/^[A-Za-z0-9_-]+:\s*$/` は
 * クォート文字を弾いて素通りしていた（timeout-minutes が無くても検出されない）。
 */
test("#574 引用符付きの job 名（ダブルクォート）でも job として拾える", () => {
  const yaml = ["jobs:", '  "quoted":', "    runs-on: ubuntu-latest", "    steps:", "      - run: echo hi"].join("\n");
  const jobs = jobsOfText(yaml, "probe.yml");
  assert.deepEqual(
    jobs.map((j) => j.name),
    ["quoted"],
  );
});

test("#574 引用符付きの job 名（シングルクォート）でも job として拾える", () => {
  const yaml = ["jobs:", "  'quoted':", "    runs-on: ubuntu-latest", "    steps:", "      - run: echo hi"].join("\n");
  const jobs = jobsOfText(yaml, "probe.yml");
  assert.deepEqual(
    jobs.map((j) => j.name),
    ["quoted"],
  );
});

test("#574 引用符付きの job 名で timeout-minutes が無ければ検出できる", () => {
  const yaml = ["jobs:", '  "quoted":', "    runs-on: ubuntu-latest", "    steps:", "      - run: echo hi"].join("\n");
  const jobs = jobsOfText(yaml, "probe.yml");
  const naked = jobs.filter((j) => j.kind === "runs-on" && j.timeout === undefined);
  assert.deepEqual(naked.map(id), ["probe.yml:quoted"]);
});

test("#574 .yaml 拡張子のワークフローも数え上げの対象になる", () => {
  const files = readdirSync(wfDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  // このリポジトリの実ファイルは全部 .yml だが、フィルタ自体が .yaml も拾える形であることを
  // readdirSync の結果とは独立に確かめる（フィルタ関数を直接検査する）。
  const filterFn = (f: string) => f.endsWith(".yml") || f.endsWith(".yaml");
  assert.equal(filterFn("probe.yaml"), true, ".yaml を拾えていない");
  assert.equal(filterFn("probe.yml"), true, ".yml を拾えていない（対照）");
  assert.equal(filterFn("probe.txt"), false, "無関係の拡張子まで拾ってしまっている（対照）");
  // 実ディレクトリに .yaml が無いことも確認する前提を明示しておく（無ければこのテストの意味が薄れる）
  assert.equal(
    files.some((f) => f.endsWith(".yaml")),
    false,
    "このリポジトリに .yaml のワークフローがある想定はしていない（無いことの確認）",
  );
});

/**
 * 数え上げそのものの検査（#500: 入口を固定しないと、本体が痩せても誰も気づかない）。
 *
 * 期待値は**ハードコードする**（#499: 検査対象から生成すると自己参照になり、
 * 対象が痩せれば期待値も一緒に痩せる）。ワークフローを足したらここが落ちるので、
 * そのとき「新しい job に timeout を付けたか」を必ず考えることになる。
 */
test("#556 数え上げ: jobs: 直下の job を全部拾えている（拾えていなければ以降の検査は無意味）", () => {
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
    "etl.yml:etl",
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

/** 再利用ワークフローを呼ぶ job（timeout-minutes を**書けない**側）を名指しで固定する */
test("#556 数え上げ: uses: で再利用ワークフローを呼ぶ job（timeout-minutes を書けない）", () => {
  const uses = allJobs.filter((j) => j.kind === "uses").map(id).sort();
  assert.deepEqual(uses, [
    "deploy-data.yml:production",
    "deploy-data.yml:staging",
    "deploy-staging.yml:staging",
    "release.yml:production",
  ]);
});

test("#556 ランナーを消費する job には、すべて timeout-minutes がある", () => {
  const naked = allJobs.filter((j) => j.kind === "runs-on" && j.timeout === undefined).map(id);
  assert.deepEqual(
    naked,
    [],
    `timeout-minutes の無い job がある。無限ループが既定の 6 時間走り、その間ほかの PR も詰まる（#556）: ${naked.join(", ")}`,
  );
});

test("#556 uses: の job に timeout-minutes を書かない（GitHub が受け付けず、actionlint が落とす）", () => {
  const bad = allJobs.filter((j) => j.kind === "uses" && j.timeout !== undefined).map(id);
  assert.deepEqual(bad, [], `uses: の job に timeout-minutes がある（syntax エラーになる）: ${bad.join(", ")}`);
});

/**
 * 値そのものを固定する（#504: 「名前を固定した」は「値を固定した」ではない）。
 *
 * 各値は**過去の実行の実測**から決めた。測り方:
 *   gh run list --workflow <wf> --limit 40 → 完了した run の id
 *   gh api repos/uonoko1/giinrecord/actions/runs/<id>/jobs
 *   → completed_at - started_at（skipped / cancelled は除く）
 * 2026-09-06 時点、n は下の表のとおり。中央値ではなく **max** を基準に、
 * 負荷で伸びる余裕を見て倍以上を取っている（#538: フルスイートが load 90 以上で 40% 落ちる。
 * #501: 個々は速いままでも wall time は 4.4 倍に伸びた）。
 *
 *   job                              n   min   med   p90   max   → 設定
 *   ci.yml:check                    36   153   210   223   225s  → 30 分（max の 8 倍）
 *   ci.yml:docker-web               35    72    84    93    96s  → 20 分
 *   ci.yml:stale-base               17     6     8    10    10s  → 10 分
 *   deploy-data.yml:resolve         40     4     8    10    13s  → 10 分
 *   deploy-site.yml:deploy          40    28    56    62    71s  → 30 分（本番に触るので厚め）
 *   release.yml:released-tag        39     3     4     5     8s  → 10 分
 *   security.yml:gitleaks           40     7    11    13    48s  → 20 分（全履歴走査の週次がある）
 *   security.yml:forbidden-patterns 40     7    10    11    12s  → 10 分
 *   security.yml:audit              40    11    13    16    25s  → 10 分
 *
 * 上限も固定する理由: 6 時間の既定に近い値を書くと、付いていても止まらない。
 * ここが落ちたら「実測し直して、この表ごと更新する」のが正しい直し方。
 */
test("#556 値が実測から外れていない（短すぎる = 偽陽性 / 長すぎる = 止まらない）", () => {
  const expected: Record<string, number> = {
    "ci.yml:check": 30,
    "ci.yml:docker-web": 20,
    "ci.yml:stale-base": 10,
    "deploy-data.yml:resolve": 10,
    "deploy-site.yml:deploy": 30,
    "release.yml:released-tag": 10,
    "security.yml:gitleaks": 20,
    "security.yml:forbidden-patterns": 10,
    "security.yml:audit": 10,
  };
  for (const [key, want] of Object.entries(expected)) {
    const job = allJobs.find((j) => id(j) === key);
    assert.ok(job, `${key} が見つからない`);
    assert.equal(job.timeout, want, `${key} の timeout-minutes が実測に基づく値から外れている`);
  }
});

/**
 * ETL は例外として残す（データ量で伸びるので、この表の外）。
 * 上限そのものなので「延ばして直す」ができないことを、値として固定しておく。
 */
test("#556 etl.yml はホステッドランナーの上限 360 分のまま（データ量で伸びるので別扱い）", () => {
  const etl = allJobs.find((j) => id(j) === "etl.yml:etl");
  assert.equal(etl?.timeout, 360);
});
