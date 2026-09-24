import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Issue #1017: **`deploy-data.yml` の `production` job から `needs: resolve` を消しても、誰も気づかなかった。**
 *
 * #134 の設計は「**コードは `released` タグの sha、`data/` は `main`**」。この 2 つが混ざってはいけない。
 * その鎖は 3 本の環でできている:
 *
 *   (1) `resolve` job が `scripts/ci/released-ref.sh resolve` を走らせ、`outputs.ref` に出す
 *   (2) `production` job が `needs: resolve` を宣言する         ← **ここが誰にも見られていなかった**
 *   (3) `production` job が `ref: ${{ needs.resolve.outputs.ref }}` を渡す
 *
 * `needs:` が無いと `needs.resolve.outputs.ref` は**空文字**に解決される。`deploy-site.yml` の
 * `inputs.ref` は空文字を受け取り（`default: main` は「入力が与えられないとき」にしか効かない——
 * 空文字は与えられた値である）、その空文字が `actions/checkout` の `ref:` に渡る。
 *
 * **フォールバック先は「main」ではなく「この run を起こした ref」である**（実測で訂正した点）。
 * `actions/checkout` の `src/input-helper.ts` を読むと、`ref` 入力が空のとき
 * `result.ref = github.context.ref` / `result.commit = github.context.sha` を使う。
 * `deploy-data.yml` の 3 つの起動経路（`push: branches: [main]` / `gh workflow run --ref main` /
 * 既定ブランチで走る `schedule`）はいずれも `github.context.ref` が main なので、
 * **このワークフローでは結果として main のコードが本番に出る**——#134 違反そのものである。
 * **ワークフローを走らせて確かめてはいない**（走らせれば本番に出てしまう）。根拠は
 * `actions/checkout` のソースと、このワークフローの `on:` に書いてある起動経路だけである。
 *
 * ── 既存の検査がなぜ捕まえなかったか ────────────────────────────────────
 * `deploy-docker.test.ts` の #134 ガードは (3) を文字列で見ていた:
 *
 *     assert.match(production, /ref: \$\{\{ needs\.resolve\.outputs\.ref \}\}/)
 *
 * **「`ref:` に何と書いてあるか」は見ているが、「その値が解決されるか」は見ていない。**
 * `needs: resolve` の行だけを消すと、この文字列はそのまま残るので通ってしまう。
 *
 * ── なぜ grep を足すだけにしなかったか ──────────────────────────────────
 * `assert.match(production, /needs: resolve/)` を 1 行足せば、その変異は確かに落ちる。
 * しかし**書き方を変えただけで素通りする**: `needs: [resolve]`、`needs:\n  - resolve`、
 * `needs: resolve-something-else`、あるいは `production` job の外（別 job の行）に
 * たまたま `needs: resolve` があるだけでも通る。
 *
 * そこで**鎖そのものを見る**——`with:` の中の `needs.<X>.outputs.<Y>` という参照を**全部**拾い、
 * それぞれについて (a) その job が `needs` に `X` を挙げているか、(b) job `X` が `outputs` に
 * `Y` を宣言しているか、を確かめる。**どの job にも効く規則**なので、
 * `release.yml` の `released-tag`（`needs.production.outputs.sha`）も同じ 1 本で覆われる。
 *
 * ── 母数（2026-09-25 実測）────────────────────────────────────────────
 * `deploy-site.yml` を `uses:` で呼ぶ job は全部で 4 つ:
 *   deploy-data.yml  staging      ref: main            （needs 参照なし）
 *   deploy-data.yml  production   ref: needs.resolve.outputs.ref   ← #134 の本体
 *   release.yml      production   ref: inputs.ref      （needs 参照なし）
 *   deploy-staging.yml staging    ref: github.sha      （needs 参照なし）
 * `needs.*.outputs.*` を参照している箇所は 2 つ（deploy-data の production、release の released-tag）。
 * 下の検査は 3 ワークフロー（deploy-data 3 job / release 2 job / deploy-staging 1 job、計 6 job）を
 * 走査し、参照 2 件すべてを検証する。**0 件だったら落とす**（「参照が無い」と「数えていない」を分ける）。
 *
 * ── 塞げていない穴（変異で見つけた。この PBI の対象外にした）────────────
 * **`deploy-staging.yml` の `ref: ${{ github.sha }}` を `main` に書き換えても、何も落ちない**
 * （実測 2026-09-25: この 3 件 + deploy-docker.test.ts の計 50 件が 50/50 緑）。
 * **#1017 の対象外にした理由**: 行き先が staging だけで、本番（`target_dir: site`）には触れない。
 * また `on: push: branches: [main]` で走るので `github.sha` は main の先端であり、
 * 差が出るのは「push の直後に main がさらに進んだ」ときの**どの sha を配るか**だけで、
 * **#134 の「released と main が混ざる」とは別の話**である。
 * **直すなら別 PBI。** ここで一緒に固定すると、この検査が見ている主題（needs の鎖）がぼやける。
 */
const here = dirname(fileURLToPath(import.meta.url));
const wfDir = resolve(here, "../../../.github/workflows");
const read = (f: string) => readFileSync(resolve(wfDir, f), "utf8");

/** 行末コメントを落とす（このディレクトリの YAML にクォート内の # は出てこない） */
const stripComment = (line: string) => {
  const i = line.indexOf("#");
  return (i < 0 ? line : line.slice(0, i)).trimEnd();
};

type Job = {
  /** job の ID（`jobs:` の直下のキー） */
  id: string;
  /** その job の本体（コメントを落とした生テキスト。assert のメッセージに使う） */
  body: string;
  /** `needs:` に挙がっている job ID（スカラ `needs: a` / フロー `needs: [a, b]` / ブロック `- a` の 3 形すべて） */
  needs: string[];
  /** `outputs:` の直下に宣言されたキー */
  outputs: string[];
  /** `${{ needs.<X>.outputs.<Y> }}` の参照（body 全体から。`with:` も `env:` も含む） */
  refs: { job: string; output: string; raw: string }[];
};

/**
 * ワークフローの `jobs:` を読み、job ごとに needs / outputs / needs 参照を返す。
 *
 * YAML の完全なパーサではない（依存は足せない）。このディレクトリの 2 スペースインデントの
 * ワークフローに限った読み取りで、**「行に何と書いてあるか」ではなく「どの親の下に在るか」**を見る。
 * 親を見ない grep が #1017 を通してしまったので、そこだけは必ず構造で判定する。
 */
function parseJobs(src: string): Job[] {
  const lines = src.split("\n").map(stripComment);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.ok(start >= 0, "トップレベルの jobs: が無い");

  // jobs: 配下（次のトップレベルキーまで）
  const block: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break;
    block.push(lines[i]);
  }

  // 2 スペースのキー = job の頭
  const heads: { id: string; at: number }[] = [];
  block.forEach((l, i) => {
    const m = l.match(/^ {2}([A-Za-z_][\w-]*):\s*$/);
    if (m) heads.push({ id: m[1], at: i });
  });

  return heads.map(({ id, at }, k) => {
    const end = k + 1 < heads.length ? heads[k + 1].at : block.length;
    const jobLines = block.slice(at + 1, end);
    const body = jobLines.join("\n");
    return { id, body, needs: listUnder(jobLines, "needs", 4), outputs: keysUnder(jobLines, "outputs", 4), refs: needsRefs(body) };
  });
}

/**
 * job 直下の `<key>:` が持つ**文字列の一覧**を返す。GitHub Actions が受け付ける 3 つの綴りを
 * すべて同じものとして扱う（#1017: 「同じ意味の別の綴り」で素通りさせない）:
 *
 *     needs: resolve            → ["resolve"]
 *     needs: [resolve, other]   → ["resolve", "other"]
 *     needs:
 *       - resolve               → ["resolve"]
 */
function listUnder(jobLines: string[], key: string, indent: number): string[] {
  const head = new RegExp(`^ {${indent}}${key}:\\s*(.*)$`);
  const i = jobLines.findIndex((l) => head.test(l));
  if (i < 0) return [];
  const inline = jobLines[i].match(head)![1].trim();
  if (inline) {
    const flow = inline.match(/^\[(.*)\]$/);
    const items = (flow ? flow[1].split(",") : [inline]).map((s) => s.trim().replace(/^["']|["']$/g, ""));
    return items.filter(Boolean);
  }
  const out: string[] = [];
  for (let j = i + 1; j < jobLines.length; j++) {
    if (jobLines[j].trim() === "") continue;
    const m = jobLines[j].match(new RegExp(`^ {${indent + 2}}-\\s*(\\S+)\\s*$`));
    if (!m) break;
    out.push(m[1].replace(/^["']|["']$/g, ""));
  }
  return out;
}

/** job 直下の `<key>:` のマップのキー名を返す（`outputs:` 用）。 */
function keysUnder(jobLines: string[], key: string, indent: number): string[] {
  const i = jobLines.findIndex((l) => new RegExp(`^ {${indent}}${key}:\\s*$`).test(l));
  if (i < 0) return [];
  const out: string[] = [];
  for (let j = i + 1; j < jobLines.length; j++) {
    if (jobLines[j].trim() === "") continue;
    if (!new RegExp(`^ {${indent + 2}}\\S`).test(jobLines[j])) break; // 兄弟キーへ戻った
    const m = jobLines[j].match(new RegExp(`^ {${indent + 2}}([A-Za-z_][\\w-]*):`));
    if (m) out.push(m[1]);
  }
  return out;
}

/** `${{ needs.<X>.outputs.<Y> }}` を全部拾う（空白の揺れを許す）。 */
function needsRefs(body: string): { job: string; output: string; raw: string }[] {
  const out: { job: string; output: string; raw: string }[] = [];
  const re = /\$\{\{\s*needs\.([A-Za-z_][\w-]*)\.outputs\.([A-Za-z_][\w-]*)\s*\}\}/g;
  for (const m of body.matchAll(re)) out.push({ job: m[1], output: m[2], raw: m[0] });
  return out;
}

/** deploy-site.yml を呼ぶ 3 本（呼ばれる側の deploy-site.yml 自身は job 1 本で needs を持たない）。 */
const CALLERS = ["deploy-data.yml", "release.yml", "deploy-staging.yml"];

test("#1017: needs.<job>.outputs.<out> を使う job は、その job を needs に挙げている（空文字に解決させない）", () => {
  const broken: string[] = [];
  let refCount = 0;
  let jobCount = 0;
  for (const f of CALLERS) {
    for (const job of parseJobs(read(f))) {
      jobCount++;
      for (const r of job.refs) {
        refCount++;
        if (!job.needs.includes(r.job)) {
          broken.push(
            `${f}: job \`${job.id}\` は ${r.raw} を使っているが needs に \`${r.job}\` が無い` +
              `（needs: ${JSON.stringify(job.needs)}）→ 空文字に解決される`,
          );
        }
      }
    }
  }
  // 母数を固定する。0 件で緑になったら「参照が消えた」のか「数えていない」のか分からない（#1017 の 3.）。
  assert.equal(jobCount, 6, `走査した job 数が変わった（deploy-data 3 / release 2 / deploy-staging 1 = 6）: ${jobCount}`);
  assert.ok(refCount >= 2, `needs.*.outputs.* の参照が ${refCount} 件しか見つからない（実測 2 件: deploy-data の production, release の released-tag）`);
  assert.deepEqual(broken, [], `needs が宛先を指していない参照がある:\n${broken.join("\n")}`);
});

test("#1017: 参照先の job が、その名前の output を実際に宣言している", () => {
  const broken: string[] = [];
  for (const f of CALLERS) {
    const jobs = parseJobs(read(f));
    const byId = new Map(jobs.map((j) => [j.id, j]));
    for (const job of jobs) {
      for (const r of job.refs) {
        const target = byId.get(r.job);
        if (!target) {
          broken.push(`${f}: job \`${job.id}\` が参照する \`${r.job}\` という job が無い`);
          continue;
        }
        // 再利用ワークフローを呼ぶ job（`uses:`）の outputs は呼び先が宣言する。
        const calls = target.body.match(/^ {4}uses:\s*(\S+)\s*$/m)?.[1];
        if (calls) {
          const called = calls.replace(/^\.\/\.github\/workflows\//, "");
          const declared = keysUnder(read(called).split("\n").map(stripComment), "outputs", 4);
          if (!declared.includes(r.output)) {
            broken.push(`${f}: \`${job.id}\` が ${r.raw} を使うが、${called} は output \`${r.output}\` を宣言していない（宣言: ${JSON.stringify(declared)}）`);
          }
          continue;
        }
        if (!target.outputs.includes(r.output)) {
          broken.push(`${f}: \`${job.id}\` が ${r.raw} を使うが、job \`${r.job}\` は output \`${r.output}\` を宣言していない（宣言: ${JSON.stringify(target.outputs)}）`);
        }
      }
    }
  }
  assert.deepEqual(broken, [], `参照先に存在しない output を使っている:\n${broken.join("\n")}`);
});

test("#134: deploy-data の production は resolve の ref を受け、data/ だけを main から載せる", () => {
  const jobs = parseJobs(read("deploy-data.yml"));
  const production = jobs.find((j) => j.id === "production");
  assert.ok(production, "deploy-data.yml に production job が無い");
  const resolveJob = jobs.find((j) => j.id === "resolve");
  assert.ok(resolveJob, "deploy-data.yml に resolve job が無い");

  // (1) resolve が released-ref.sh で ref を出す
  assert.match(resolveJob.body, /released-ref\.sh resolve/, "resolve job が released-ref.sh resolve を呼んでいない");
  assert.deepEqual(resolveJob.outputs, ["ref"], `resolve の outputs が ref だけでない: ${JSON.stringify(resolveJob.outputs)}`);

  // (2) production が resolve に依存する ← #1017 で欠けていた環
  assert.ok(
    production.needs.includes("resolve"),
    `production job の needs に resolve が無い（needs: ${JSON.stringify(production.needs)}）。` +
      "needs.resolve.outputs.ref は空文字になり、checkout は既定ブランチ（main）へ落ちる——#134 違反（未リリースのコードが本番に出る）",
  );

  // (3) production が with.ref にその出力を渡す（`with:` の中であることまで見る）
  const withRef = production.body.match(/^ {6}ref:\s*(.+)$/m)?.[1]?.trim();
  assert.ok(withRef, "production job の with: に ref が無い");
  assert.match(
    withRef,
    /^\$\{\{\s*needs\.resolve\.outputs\.ref\s*\}\}$/,
    `production の ref が resolve の出力そのものでない: ${withRef}（main や github.sha を直に書くと #134 違反）`,
  );

  // data/ は main から（コードと混ぜない）
  const dataRef = production.body.match(/^ {6}data_ref:\s*(.+)$/m)?.[1]?.trim();
  assert.equal(dataRef, "main", `production の data_ref が main でない: ${dataRef}`);
});
