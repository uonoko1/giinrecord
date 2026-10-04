import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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
 *
 * **走査の範囲を #1036 で直した。** 初版は「3 ワークフロー / 6 job」だった——**手書きの 3 本**で、
 * **`etl.yml` に壊れた鎖の job を足すとこのファイルは 3/3 緑だった**（#1036 で実測）。
 * **いまは `readdirSync` で全 15 ワークフロー / 24 job を走査する**（2026-09-28 実測）。
 * 参照 2 件すべてを検証する。**0 件だったら落とす**（「参照が無い」と「数えていない」を分ける）。
 *
 * ── #1017 が塞いだのは鎖 5 環のうち 1 環だけだった（#1036）──────────────────
 * **`resolve` job の内部 3 環（`outputs` の束縛 / step の `id` / `$GITHUB_OUTPUT` に書く名前）は
 * 無防備だった。** 下の `assert.deepEqual(resolveJob.outputs, ["ref"])` は**キー名しか見ておらず、
 * 何に束縛されているかを一度も読んでいない**ので、`ref: main` と書いても通った。
 * **その 3 環は `workflow-released-chain.test.ts`（#1036）が構造で要求している。**
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

/**
 * **`.github/workflows/` の全ワークフロー**（#1036 の 2.）。
 *
 * **初版は `["deploy-data.yml", "release.yml", "deploy-staging.yml"]` の手書き 3 本だった。**
 * **14 本中 3 本の denylist で、`etl.yml` に壊れた鎖の job を足すとこのファイルは 3/3 緑だった**
 * （#1036 で実測。#1008 / #1022 / #1043 と同じ型——**列挙は漏れがそのまま穴になる**）。
 * **`readdirSync` の全走査にした。** 下の母数の assert も、実数（15 本 / 24 job）に合わせて測り直した。
 */
const workflowFiles = (): string[] =>
  readdirSync(wfDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    // **`probe-` の除外は置かない**（#1082 のレビューで実測: `.github/workflows/probe-evil.yml` を
    // 置くと壊れた鎖の job が 7/7 緑になり、**母数の `equal(jobCount, 24)` すら鳴らなかった**
    // ——2 ファイルが同じ除外を持つので、その job は「存在しないこと」になっていた）。
    // **除外は denylist で、列挙漏れがそのまま穴になる**（#333）。
    // **flake（#574 の probe が並行して現れて消える）は #1086 が本筋で直した**——
    // probe は一時ディレクトリに書くようになり、実ディレクトリには現れない
    // （`workflow-timeout.test.ts` の「本物のディレクトリに probe- のファイルが残っている」検査が守る）。
    .sort();

/**
 * **job 数の期待値を、別ファイルが維持している job 名の一覧から導出する**（#1162）。
 *
 * **2026-10-04 まで、ここは `assert.equal(jobCount, 25)` という裸の数値だった。**
 * 25 の正しさは**コメントで主張されていただけ**だった（当時の逐語）:
 *
 *     **`25` は独立に維持されている `workflow-timeout.test.ts` の「#556 数え上げ」の
 *     job 名リスト（25 件）と一致する**——**別の実装が別の目的で数えた値と突き合わせてある。**
 *
 * **突き合わせは人の目でしか行われていなかったので、維持されなかった。**
 * #1162 が `ci.yml` の `stale-base` を 2 つの job に割ったとき、**job 名の一覧を持つ 3 か所**
 * （`workflow-timeout.test.ts` / `branch-protection-jobs.test.ts` / `docs/ops/ci-throughput.md`）は
 * 直されたが、**数値だけを持つこの 1 か所は直されず、CI で初めて落ちた**
 * （run 37186553065 / job 111389582166。**2358 件中 1 件だけの失敗**）。
 *
 * **一覧は数えられるが、数値は単独では検証できない。** だから**数値を一覧の長さから導出する。**
 * こうすると、job を足した／割った／消した人は**一覧（1 か所）を直せば両方が同時に動く**。
 * **「一覧を直さずに数値だけ合わせる」という操作が存在しなくなる。**
 *
 * **並行して実際に衝突していた**（PO 報告 2026-10-04）: PR #1142 が `deploy-site.yml` を
 * `build` / `deploy` に割り `build-site.yml` を新設して **+2**、この PR が `stale-base` を割って **+1**。
 * **どちらが後にマージされても、裸の数値は相手の増分を知らないので間違いになる。**
 * 導出にすれば、どちらの順序でも一覧の長さが真値を運ぶ。
 *
 * ── なぜ `import` ではなく「ソースを読む」のか ─────────────────────────────
 * `workflow-timeout.test.ts` から一覧を `export` して import すると、
 * `node --test --import tsx test/*.test.ts` が**同じファイルを 2 回読み込み、
 * その中のテストが二重に走る**（その数も二重に数えられる）。
 * また**この PR は #1142 と `workflow-timeout.test.ts` で衝突している**ので、
 * そのファイルへの変更は増やさない（**このファイルは 1 バイトも触らない**）。
 * **テストのソースを読む形はこのディレクトリに先例がある**
 * （`kochi-x-anchor-roster.test.ts:356` が `kochi-vote-alignment.test.ts` を `readFileSync` している）。
 *
 * ── 抽出が空振りしたら落とす ───────────────────────────────────────────
 * **「一覧が読めなかった」が「0 件」になって緑になるのが、この型の最悪の壊れ方である**
 * （#1082 で実際に起きた: 母数の `equal(jobCount, 24)` すら鳴らなかった）。
 * だから下限と、**必ず在る 1 件**（`ci.yml:check` ——`check` は branch protection の
 * 必須 contexts に入っているので消せない。実測 2026-10-04: contexts は
 * `check` / `gitleaks` / `forbidden-patterns` / `audit` の 4 件）の実在を先に要求する。
 */
const CANON = resolve(here, "workflow-timeout.test.ts");
const CANON_TEST = "#556 数え上げ: jobs: 直下の job を全部拾えている";

/** `workflow-timeout.test.ts` の「#556 数え上げ」が固定している `<file>:<job>` の一覧。 */
function canonicalJobIds(): string[] {
  const src = readFileSync(CANON, "utf8");
  const at = src.indexOf(CANON_TEST);
  assert.ok(at >= 0, `${CANON} に「${CANON_TEST}」のテストが無い（一覧の持ち主が改名された？）`);
  // そのテストの本体（次の `]);` まで）だけを見る。ファイル全体から拾うと、
  // 別のテストが持つ部分集合（`uses:` の 4 件など）や、コメント中の job 名まで数えてしまう。
  //
  // **この終端は、いまは等価変異である**（#1162 で実測 2026-10-04）。
  // `src.slice(at, end)` を `src.slice(at)` に変えても **4/4 緑のまま**だった。理由は測って分かった:
  // 同ファイルの `uses:` の一覧（4 件）は**この 26 件の真部分集合**で、`new Set` が重複を落とすので
  // **集合の差が空**になる（scoped 26 / 終端なし 26 / 差 `[]`）。
  // **それでも終端を置く。** `workflow-timeout.test.ts` が**この 26 に無い job 名**を
  // どこかに 1 つ書いた日（例: 削除した job を「以前は在った」として列挙する、probe の名前を足す）に、
  // 終端が無いと母数が黙って増え、**実体とずれたまま緑になる**。
  // **「いま等価」は「要らない」ではない**——いま差が空なのは一覧の中身の偶然であって、設計上の保証ではない。
  const end = src.indexOf("]);", at);
  assert.ok(end > at, `${CANON} の「${CANON_TEST}」の一覧の終端（]);）が見つからない`);
  const body = src.slice(at, end);
  const ids = [...body.matchAll(/^\s*"([A-Za-z0-9_-]+\.ya?ml:[A-Za-z_][A-Za-z0-9_-]*)",$/gm)].map((m) => m[1]);
  return [...new Set(ids)].sort();
}

test("#1162: 母数の持ち主は 1 か所（workflow-timeout の一覧から導出できている）", () => {
  const ids = canonicalJobIds();
  // 抽出が空回りしていないこと。**下限なので、job が増えても更新は要らない**（#1175 と同じ形）。
  assert.ok(ids.length >= 20, `一覧から ${ids.length} 件しか抽出できていない（抽出が空回りしている。下限 20）`);
  assert.ok(ids.includes("ci.yml:check"), `一覧に ci.yml:check が無い（抽出が壊れている。check は branch protection の必須 contexts なので消せない）: ${JSON.stringify(ids.slice(0, 5))}`);
  // 一覧の形そのもの（`<file>.yml:<job>`）が崩れていないこと。
  assert.deepEqual(ids.filter((s) => !/^[a-z0-9-]+\.yml:[A-Za-z_][A-Za-z0-9_-]*$/.test(s)), [], "一覧に <file>.yml:<job> の形でない要素がある");
});

test("#1017: needs.<job>.outputs.<out> を使う job は、その job を needs に挙げている（空文字に解決させない）", () => {
  const broken: string[] = [];
  let refCount = 0;
  let jobCount = 0;
  for (const f of workflowFiles()) {
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
  //
  // **#1036 で 6 → 24 に測り直した**（手書き 3 本 → `readdirSync` の全 15 本）。
  // **#1110 で 24 → 25**（`scrum-monitor.yml` の `monitor` が 1 本増えた）。
  // **#1162 で裸の数値をやめ、`workflow-timeout.test.ts` の一覧の長さから導出する**
  // （理由は `canonicalJobIds` の上に書いた。**数値を手で合わせる経路を無くす**）。
  // **実測 2026-10-04（この枝を origin/main に rebase した後）: 16 ワークフロー / 26 job。**
  // `equal` のままにする（`>=` にすると job を消したときに気づけない）。
  const expected = canonicalJobIds();
  assert.equal(
    jobCount,
    expected.length,
    `走査した job 数が、workflow-timeout.test.ts の「${CANON_TEST}」の一覧（${expected.length} 件）と合わない: ${jobCount}。` +
      `**どちらかが実体とずれている。** job を足した／割った／消したなら、**一覧のほうを直す**（この数値は一覧から導出されるので、ここは直さない）`,
  );
  assert.ok(refCount >= 2, `needs.*.outputs.* の参照が ${refCount} 件しか見つからない（実測 2 件: deploy-data の production, release の released-tag）`);
  assert.deepEqual(broken, [], `needs が宛先を指していない参照がある:\n${broken.join("\n")}`);
});

test("#1017: 参照先の job が、その名前の output を実際に宣言している", () => {
  const broken: string[] = [];
  for (const f of workflowFiles()) {
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
