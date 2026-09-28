import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/**
 * Issue #1036: **#1017 が塞いだのは鎖 5 環のうち `needs:` の 1 環だけだった。**
 *
 * #134 の設計は「**本番のコードは `released` タグの sha、`data/` は main**」。
 * **未リリースのコードが本番（https://giinrecord.jp）に出ないことが、この鎖の唯一の担保である。**
 *
 * `deploy-data.yml` の鎖は 5 環でできている:
 *
 * ```yaml
 *   resolve:
 *     outputs:
 *       ref: ${{ steps.released.outputs.ref }}    # ← 環 (c): 束縛。何に束縛されているか
 *     steps:
 *       - id: released                            # ← 環 (b): その step が実在するか
 *         run: |
 *           REF=$(bash scripts/ci/released-ref.sh resolve)   # ← 環 (a): 値の出どころ
 *           echo "ref=$REF" >> "$GITHUB_OUTPUT"              # ← 環 (a): 書き出す名前
 *   production:
 *     needs: resolve                              # ← 環 (d)  #1017 が塞いだのはここだけ
 *     with:
 *       ref: ${{ needs.resolve.outputs.ref }}     # ← 環 (e)
 * ```
 *
 * ── #1017 の検査が (a)(b)(c) を通した理由（PO が追試）────────────────────────
 * ```ts
 * assert.deepEqual(resolveJob.outputs, ["ref"])   // workflow-needs-resolve.test.ts:243
 * ```
 * **キー名しか見ておらず、何に束縛されているかを一度も読んでいない。**
 * `outputs: { ref: main }` でも `["ref"]` なので通る。
 *
 * **#1036 の起票時に緑で生き残っていた変異**（issue #1036 の表。全部 2118/2118 緑）:
 *
 * | 変異 | 切る環 | 結果 |
 * |---|---|---|
 * | **Y2**: `ref: ${{ steps.released.outputs.ref }}` → `ref: main` | (c) | **緑** |
 * | Y2': 同じ行を `refs/heads/main` / `${{ github.sha }}` / `${{ github.ref }}` に | (c) | 3 通りとも緑 |
 * | **Y3**: `REF=$(bash scripts/ci/released-ref.sh resolve)` → `REF=main` | (a) | 緑 |
 * | **Y4**: `steps.released.outputs.ref` → `steps.released.outputs.sha`（出力名タイポ＝空文字） | (c) | **緑** |
 * | **Y5**: `- id: released` → `- id: resolved` | (b) | **緑** |
 *
 * **Y2 が最も重い**——`needs:` も `with.ref:` も**文字どおり全部正しいまま**、main のコードが本番に出る。
 *
 * ── #1036 で測った結果（2026-09-28。母数 86 テスト = ワークフロー検査 8 ファイル）──────
 * **`scripts/dev/mutate.sh run` で当てた。**「before」は main の時点の検査 7 ファイル（82 テスト）、
 * 「after」はこのファイルを足した 8 ファイル（86 テスト）。
 *
 * | 変異 | 切る環 | before | after |
 * |---|---|---|---|
 * | Y2  `ref: main` | (c) | 82 pass / **0 fail** | 83 pass / **3 fail** |
 * | Y2' `refs/heads/main` | (c) | 82 / **0** | 83 / **3** |
 * | Y2' `${{ github.sha }}` | (c) | 82 / **0** | 83 / **3** |
 * | Y2' `${{ github.ref }}` | (c) | 82 / **0** | 83 / **3** |
 * | Y2'' `${{ github.ref_name }}`（**issue の表に無い綴り**） | (c) | 82 / **0** | 83 / **3** |
 * | Y2'' `HEAD`（**issue の表に無い綴り**） | (c) | 82 / **0** | 83 / **3** |
 * | Y3  `REF=main` | (a) 値 | 80 / **2** ← **元から落ちていた** | 83 / **3** |
 * | Y4  `outputs.ref` → `outputs.sha` | (c) | 82 / **0** | 83 / **3** |
 * | Y4' `echo "ref=$REF"` → `echo "sha=$REF"` | (a) 名前 | 82 / **0** | 83 / **3** |
 * | Y5  `- id: released` → `- id: resolved` | (b) | 82 / **0** | 83 / **3** |
 * | (d) `needs: resolve` の行を消す（#1017 の変異） | (d) | — | 83 / **3** |
 * | (e) `with.ref` を `main` に | (e) | — | 82 / **4** |
 *
 * **Y2'' の 2 行が「denylist ではない」ことの証拠である**——**issue が挙げていない綴りでも同じく落ちる。**
 *
 * **issue #1036 の表は Y3 を「緑」と書いているが、実測は before で 2 fail だった。**
 * **落としていたのは `workflow-needs-resolve.test.ts:242` の `assert.match(resolveJob.body, /released-ref\.sh resolve/)`
 * と `deploy-docker.test.ts:789` の同じ形**で、**どちらも #1017 より前から在った。**
 * **Y3 だけは元から守られていた**（**「5 環のうち 1 環」ではなく「5 環のうち 2 環」が守られていた**）。
 *
 * **偽陽性（正しい形・純粋な書き換えが緑であること。すべて 86/86）:**
 *   ・`resolve` job にコメントを 1 行足す
 *   ・`needs: resolve` → `needs: [resolve]`（フロー形式）
 *   ・`needs: resolve` → ブロック形式（`needs:` + `  - resolve`）
 *
 * ── なぜ denylist にしないか（#858 / #1043 と同じ向き）──────────────────────
 * 「`ref: main` を禁じる」だと、次に `ref: HEAD` / `ref: ${{ github.ref_name }}` と書いた人を
 * 捕まえられない。**禁じる綴りを数える側に回った時点で、列挙漏れが原理的に残る。**
 * だから**鎖の構造そのものを要求する**:
 *
 *   1. job の `outputs.<k>` が `${{ steps.<id>.outputs.<n> }}` の形をしていること（**束縛の形**）
 *   2. その `<id>` の step が同じ job に実在すること（**(b)**）
 *   3. その step が `<n>=` を `$GITHUB_OUTPUT` に書いていること（**(a) の名前**）
 *   4. `production` が受け取る `ref` の値を**辿った先**が `released-ref.sh resolve` であること（**(a) の出どころ**）
 *
 * **1〜3 は全ワークフローの全 job に効く一般規則**なので、`etl.yml` に壊れた job を足しても効く
 * （#1017 の `CALLERS = [...3 本]` は **14 本中 3 本の手書きリスト**で、`readdirSync` に直した）。
 *
 * ── 走らせて確かめてはいない ────────────────────────────────────────────
 * **このワークフローは本番に配る経路なので、変異を当てたまま走らせることはできない。**
 * 根拠は GitHub Actions の仕様（`steps.<id>.outputs.<n>` は宣言の無い名前に対して空文字を返し、
 * `actions/checkout` の `ref:` は空文字のとき `github.context.ref` に落ちる——#1017 で
 * `actions/checkout` の `src/input-helper.ts` を読んで確認済み）と、`.github/workflows/` の実体だけである。
 */

const here = dirname(fileURLToPath(import.meta.url));
const wfDir = resolve(here, "../../../.github/workflows");

/**
 * **`CALLERS = [...3 本]` の手書きリストをやめる**（#1036 の 2.）。
 * **#1017 のリストは 14 本中 3 本**で、`etl.yml` に壊れた鎖の job を足すと **3/3 緑**だった。
 * **#1008 / #1022 / #1043 と同じ型**——denylist は列挙漏れを原理的に塞げない。
 *
 * **`probe-` の除外は置かない**（#1082 のレビューで実測）。
 * **初版は flake 避けに `.filter((f) => !/^probe-/.test(f))` を置いていたが、これも denylist だった**
 * ——`.github/workflows/probe-evil.yml`（壊れた鎖を持つ job）を置くと**このファイルと
 * `workflow-needs-resolve.test.ts` で 7/7 緑**になり、**母数の `equal(jobCount, 24)` すら鳴らなかった**
 * （2 ファイルが同じ除外を持つので、その job は「存在しないこと」になる。
 * **母数で気づく道まで塞がれていた**。#333 / #757）。
 *
 * **flake の本筋は #1086（#1081）が直した**——`workflow-timeout.test.ts` の #574 検査は
 * probe を一時ディレクトリに書くようになり、実ディレクトリには現れない。
 * **`readIfPresent` の try/catch は残す**（走査の途中で消えたファイルを飛ばす一般の備え）。
 */
const workflowFiles = (): string[] =>
  readdirSync(wfDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();

/** 走査の途中で消えたファイルは `undefined` を返す（上の flake を参照）。 */
const readIfPresent = (f: string): string | undefined => {
  try {
    return readFileSync(join(wfDir, f), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
};

const read = (f: string) => readFileSync(join(wfDir, f), "utf8");

/** 行末コメントを落とす（このディレクトリの YAML にクォート内の # は出てこない）。 */
const stripComment = (line: string) => {
  const i = line.indexOf("#");
  return (i < 0 ? line : line.slice(0, i)).trimEnd();
};

/**
 * **`${{ steps.<id>.outputs.<name> }}` の参照を書くただ 1 つの定義。**
 *
 * **定義は 1 か所だけ**（#1043 でこれを破って捕まった。走査側と検査側に同じ正規表現を 2 つ書くと、
 * **走査側だけを緩めても検査側は自分の写しを見て緑のまま通る**）。
 * 下の「綴りそのものを当てる」検査も、この同じ定数を使う。
 */
const STEP_OUTPUT_REF = /\$\{\{\s*steps\.([A-Za-z_][\w-]*)\.outputs\.([A-Za-z_][\w-]*)\s*\}\}/;

/** 上を全件拾う版（`g` 付きの正規表現は `lastIndex` が残るので、使うたびに作り直す）。 */
const allStepOutputRefs = (s: string): { step: string; output: string; raw: string }[] => {
  const out: { step: string; output: string; raw: string }[] = [];
  for (const m of s.matchAll(new RegExp(STEP_OUTPUT_REF.source, "g"))) {
    out.push({ step: m[1], output: m[2], raw: m[0] });
  }
  return out;
};

type Step = {
  /** `id:` の値（無ければ undefined） */
  id?: string;
  /** その step の本体（コメントを落とした生テキスト） */
  body: string;
  /** `uses:` の値（無ければ undefined） */
  uses?: string;
};

type Job = {
  id: string;
  body: string;
  /** `outputs:` の直下のキー → 束縛されている値（**キー名だけでなく値まで持つ**。#1017 が見ていなかった環） */
  outputs: Map<string, string>;
  /** `steps:` の下の step */
  steps: Step[];
};

/**
 * ワークフローの `jobs:` を読み、job ごとに `outputs` の**束縛**と step の一覧を返す。
 *
 * YAML の完全なパーサではない（依存を足していない）。このディレクトリの 2 スペースインデントの
 * ワークフローに限った読み取りで、**「行に何と書いてあるか」ではなく「どの親の下に在るか」**を見る。
 *
 * **自前パースの限界は下の `parse-shape` の検査で固定している**——
 * **パーサが黙って空を返すようになったら、母数の assert が落ちる。**
 */
function parseJobs(src: string): Job[] {
  const lines = src.split("\n").map(stripComment);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return [];

  const block: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break;
    block.push(lines[i]);
  }

  const heads: { id: string; at: number }[] = [];
  block.forEach((l, i) => {
    const m = l.match(/^ {2}([A-Za-z_][\w-]*):\s*$/);
    if (m) heads.push({ id: m[1], at: i });
  });

  return heads.map(({ id, at }, k) => {
    const end = k + 1 < heads.length ? heads[k + 1].at : block.length;
    const jobLines = block.slice(at + 1, end);
    return { id, body: jobLines.join("\n"), outputs: outputBindings(jobLines), steps: parseSteps(jobLines) };
  });
}

/**
 * job 直下の `outputs:` を **キー → 束縛された値**で返す。
 *
 * **#1017 はここでキー名だけを返していた**（`keysUnder`）。**`ref: main` と
 * `ref: ${{ steps.released.outputs.ref }}` が区別できず、Y2 / Y4 が緑で通った。**
 */
function outputBindings(jobLines: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const i = jobLines.findIndex((l) => /^ {4}outputs:\s*$/.test(l));
  if (i < 0) return out;
  for (let j = i + 1; j < jobLines.length; j++) {
    if (jobLines[j].trim() === "") continue;
    if (!/^ {6}\S/.test(jobLines[j])) break; // 兄弟キーへ戻った
    const m = jobLines[j].match(/^ {6}([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}

/** job 直下の `steps:` を step 単位に切る（`      - ` で始まる行が step の頭）。 */
function parseSteps(jobLines: string[]): Step[] {
  const i = jobLines.findIndex((l) => /^ {4}steps:\s*$/.test(l));
  if (i < 0) return [];
  const heads: number[] = [];
  for (let j = i + 1; j < jobLines.length; j++) {
    if (jobLines[j].trim() !== "" && !/^ {6}/.test(jobLines[j])) break; // steps: を抜けた
    if (/^ {6}- /.test(jobLines[j])) heads.push(j);
  }
  return heads.map((at, k) => {
    // 次の step の頭まで（最後の step は steps: ブロックの終わりまで）
    let end = k + 1 < heads.length ? heads[k + 1] : jobLines.length;
    if (k + 1 >= heads.length) {
      for (let j = at + 1; j < jobLines.length; j++) {
        if (jobLines[j].trim() !== "" && !/^ {6}/.test(jobLines[j])) {
          end = j;
          break;
        }
      }
    }
    const body = jobLines.slice(at, end).join("\n");
    // step の直下のキーは `      - id: x` か `        id: x` の 2 形で書ける
    const key = (k2: string) => body.match(new RegExp(`^ {6}(?:- )?${k2}:\\s*(.+)$`, "m"))?.[1]?.trim();
    return { id: key("id")?.replace(/^["']|["']$/g, ""), body, uses: key("uses") };
  });
}

/**
 * step が `$GITHUB_OUTPUT` に書き出す名前の集合。
 *
 * **`GITHUB_OUTPUT` に向かって書いている行の中の `<name>=` を拾う。**
 *
 * **`run:` の 2 形（ブロック `run: |` と 1 行 `run: echo ...`）の両方を通す。**
 * 最初は `echo` を行頭（か `;`/`&` の直後）に要求していたが、**`deploy-site.yml:86` の
 * `run: echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"` が拾えず、本物の鎖を
 * 「壊れている」と報告した**（偽陽性）。**行の中のどこに `echo` が在ってもよい形に直した。**
 *
 * **`uses:` の step（外部 action）は、出力を action 側が宣言するのでここでは判定できない**
 * ——**その場合は「不明」として通す**（偽陽性を作らないため。`actions/cache` の `cache-hit` など）。
 */
/**
 * **行ごとの `<pattern>` に当たる最後の 1 件の捕獲を返す**（#1082 のレビューで見つかった穴）。
 *
 * **シェルも `$GITHUB_OUTPUT` も「最後が勝つ」:**
 * ```
 * REF=$(bash scripts/ci/released-ref.sh resolve)
 * REF=main                                        ← 実行時に効くのはこちら
 * ```
 * ```
 * ref=<released タグの sha>
 * ref=main                                        ← Actions が採るのはこちら（追記ファイル）
 * ```
 *
 * **`String.match` は `m` フラグでも最初の 1 件しか返す**ので、それで読むと
 * **「検査が読む行」と「実行時に効く行」が別物になる**——
 * **`REF=main` への「置換」は捕まえられても、次の行への「追記」は素通りする。**
 * **実測（この直しの前）: G1 / G4 / G5 とも 54 pass / 0 fail、etl 全体でも緑だった。**
 *
 * **だから `matchAll` で全件拾って `.at(-1)` を採る**——**実行系と同じ読み方をする。**
 * 定義はここ 1 か所だけ（走査側と検査側に写しを 2 つ書かない。#1043 の型）。
 */
const lastAssignment = (body: string, pattern: string): string | undefined =>
  [...body.matchAll(new RegExp(`^\\s*${pattern}`, "gm"))].at(-1)?.[1]?.trim();

function githubOutputNames(step: Step): Set<string> {
  const out = new Set<string>();
  for (const line of step.body.split("\n")) {
    if (!line.includes("GITHUB_OUTPUT")) continue;
    for (const m of line.matchAll(/echo\s+"?([A-Za-z_][\w-]*)=/g)) out.add(m[1]);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 環 (b)(c) — 一般規則。全ワークフロー・全 job に効く
// ─────────────────────────────────────────────────────────────────────────────

test("#1036 (b)(c): job の outputs は、同じ job に実在する step の、実在する出力に束縛されている", () => {
  const files = workflowFiles();
  // 母数（#757）: 走査が空回りしていないことを先に確かめる
  assert.ok(files.length > 0, "ワークフローが 1 つも見つからない（走査が空回りしている）");

  const bad: string[] = [];
  let bindings = 0; // 走査した `outputs:` の束縛の数
  let stepRefs = 0; // そのうち `steps.<id>.outputs.<n>` を参照しているものの数

  for (const f of files) {
    const src = readIfPresent(f);
    if (src === undefined) continue; // 走査中に消えた（#574 の probe）
    for (const job of parseJobs(src)) {
      // 再利用ワークフローを呼ぶ job（`uses:`）の outputs は呼び先が宣言する。step は無い。
      const callsReusable = /^ {4}uses:\s*\S+\s*$/m.test(job.body);
      for (const [key, value] of job.outputs) {
        bindings++;
        const refs = allStepOutputRefs(value);
        if (refs.length === 0) {
          // `steps.*` を参照しない出力（`${{ inputs.x }}` や `${{ jobs.deploy.outputs.sha }}` など）は
          // この規則の対象外。**ここで見逃してよいのは「step の出力を騙っていない」ものだけである。**
          continue;
        }
        stepRefs += refs.length;
        if (callsReusable) {
          bad.push(`${f}: job \`${job.id}\` は再利用ワークフローを呼ぶのに steps.* を参照している: ${key}: ${value}`);
          continue;
        }
        for (const r of refs) {
          const target = job.steps.find((s) => s.id === r.step);
          if (!target) {
            // ← 環 (b)。`- id: released` を `- id: resolved` にすると（Y5）ここで落ちる
            bad.push(
              `${f}: job \`${job.id}\` の outputs.${key} が ${r.raw} を参照しているが、` +
                `\`id: ${r.step}\` の step が無い（実在する id: ${JSON.stringify(job.steps.map((s) => s.id).filter(Boolean))}）` +
                "→ 空文字に解決される",
            );
            continue;
          }
          if (target.uses) continue; // 外部 action の出力名はここでは判定できない（偽陽性を作らない）
          const written = githubOutputNames(target);
          if (!written.has(r.output)) {
            // ← 環 (a) の名前。`outputs.ref` → `outputs.sha` にすると（Y4）ここで落ちる
            bad.push(
              `${f}: job \`${job.id}\` の outputs.${key} が ${r.raw} を参照しているが、` +
                `step \`${r.step}\` は \`${r.output}=\` を $GITHUB_OUTPUT に書いていない` +
                `（書いているのは ${JSON.stringify([...written])}）→ 空文字に解決される`,
            );
          }
        }
      }
    }
  }

  // 母数（#757）: 「0 件だから緑」を塞ぐ。実測 2026-09-28 の内訳は parse-shape の検査に固定してある
  assert.ok(bindings > 0, `job の outputs: の束縛が 1 件も見つからない（走査が空回りしている）: ${bindings}`);
  assert.ok(
    stepRefs >= 2,
    `steps.<id>.outputs.<n> に束縛された job outputs が ${stepRefs} 件しか無い` +
      "（実測 2 件: deploy-data.yml resolve.ref, deploy-site.yml deploy.sha）。走査が空回りしていないか",
  );
  assert.deepEqual(bad, [], `job outputs の束縛先が存在しない:\n  ${bad.join("\n  ")}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 環 (a)(c)(d)(e) — #134 の鎖。`production` が受け取る ref の出どころを辿る
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **`production` に届く `ref` を、`released-ref.sh resolve` まで辿る。**
 *
 * **「`ref:` に何と書いてあるか」を文字列で見るのではなく、書いてある参照を 1 環ずつ辿る。**
 * 途中のどの環が切れても、辿り着けないので落ちる。
 * **Y2 / Y2'（`ref: main` / `refs/heads/main` / `${{ github.sha }}` / `${{ github.ref }}`）は
 * 「`steps.*.outputs.*` を参照していない」時点で落ちる**——**禁じる綴りを数えていないので、
 * `HEAD` でも `${{ github.ref_name }}` でも同じく落ちる。**
 */
test("#134 / #1036 (a)〜(e): deploy-data の production の ref は、released-ref.sh resolve の出力まで辿れる", () => {
  const jobs = parseJobs(read("deploy-data.yml"));
  assert.ok(jobs.length > 0, "deploy-data.yml の jobs が読めていない（走査が空回りしている）");

  const production = jobs.find((j) => j.id === "production");
  assert.ok(production, "deploy-data.yml に production job が無い");

  // 環 (e): production の with.ref が `needs.<job>.outputs.<name>` を参照している
  const withRef = production.body.match(/^ {6}ref:\s*(.+)$/m)?.[1]?.trim();
  assert.ok(withRef, "production job の with: に ref が無い");
  const needsRef = withRef.match(/^\$\{\{\s*needs\.([A-Za-z_][\w-]*)\.outputs\.([A-Za-z_][\w-]*)\s*\}\}$/);
  assert.ok(
    needsRef,
    `production の with.ref が他 job の出力の参照でない: ${withRef}\n` +
      "本番のコードは released タグの sha でなければならない（#134）。ここに ref を直接書くと未リリースのコードが本番に出る",
  );
  const [, refJobId, refOutputName] = needsRef;

  // 環 (d): その job を needs に挙げている（#1017 が塞いだ環。ここでも辿る）
  const needs = production.body.match(/^ {4}needs:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const needsList = (needs.match(/^\[(.*)\]$/)?.[1].split(",") ?? [needs]).map((s) => s.trim().replace(/^["']|["']$/g, ""));
  const blockNeeds = [...production.body.matchAll(/^ {4}needs:\s*$\n((?:^ {6}- .*$\n?)+)/gm)]
    .flatMap((m) => m[1].split("\n"))
    .map((l) => l.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);
  assert.ok(
    [...needsList, ...blockNeeds].includes(refJobId),
    `production job の needs に \`${refJobId}\` が無い（needs: ${JSON.stringify([...needsList, ...blockNeeds].filter(Boolean))}）。` +
      "needs が無いと参照は空文字になり、checkout は run を起こした ref（= main）に落ちる——#134 違反",
  );

  // 環 (c): その job の outputs.<name> が step の出力に束縛されている
  const producer = jobs.find((j) => j.id === refJobId);
  assert.ok(producer, `deploy-data.yml に job \`${refJobId}\` が無い`);
  const binding = producer.outputs.get(refOutputName);
  assert.ok(
    binding,
    `job \`${refJobId}\` が output \`${refOutputName}\` を宣言していない（宣言: ${JSON.stringify([...producer.outputs.keys()])}）`,
  );
  const stepRef = binding.match(new RegExp(`^${STEP_OUTPUT_REF.source}$`));
  assert.ok(
    stepRef,
    `job \`${refJobId}\` の outputs.${refOutputName} が step の出力に束縛されていない: ${refOutputName}: ${binding}\n` +
      "**ここが #1036 の本体である**（Y2 / Y2'）。needs も with.ref も文字どおり正しいまま、" +
      "この 1 行を `main` / `refs/heads/main` / `${{ github.sha }}` に変えるだけで未リリースのコードが本番に出る",
  );
  const [, stepId, stepOutput] = stepRef;

  // 環 (b): その id の step が実在する（Y5）
  const step = producer.steps.find((s) => s.id === stepId);
  assert.ok(
    step,
    `job \`${refJobId}\` に \`id: ${stepId}\` の step が無い（実在する id: ${JSON.stringify(producer.steps.map((s) => s.id).filter(Boolean))}）` +
      "→ 参照は空文字に解決される（Y5）",
  );

  // 環 (a) の名前: その step がその名前を $GITHUB_OUTPUT に書いている（Y4）
  const written = githubOutputNames(step);
  assert.ok(
    written.has(stepOutput),
    `step \`${stepId}\` は \`${stepOutput}=\` を $GITHUB_OUTPUT に書いていない（書いているのは ${JSON.stringify([...written])}）` +
      "→ 参照は空文字に解決される（Y4）",
  );

  // 環 (a) の値: その step が書き出す値が released-ref.sh resolve から来ている（Y3）
  //
  // **`REF=$(bash scripts/ci/released-ref.sh resolve)` → `REF=main` にすると（Y3）ここで落ちる。**
  // **シェル変数を辿る**: `<name>=$VAR` / `<name>=${VAR}` / `<name>=$(...)` の右辺を見て、
  // その VAR が `released-ref.sh resolve` の出力で代入されていることを要求する。
  //
  // **「最後が勝つ」を読む**（#1082 のレビューで見つかった穴。G1 / G4 / G5）。
  // **`String.match` は `m` フラグでも最初の 1 件しか返す。** それで読むと
  // **「置換」は捕まえるが「追記」は捕まえない**——`REF=$(...)` の次の行に `REF=main` を
  // 1 行足すだけで、**検査は 1 行目を読み、シェルは 2 行目を使う**ので素通りする
  // （実測: G1 / G4 / G5 とも 54 pass / 0 fail で緑だった）。
  // **`$GITHUB_OUTPUT` も追記ファイルなので、同じ名前を 2 回書けば Actions は最後の行を採る。**
  // **だから `lastAssignment` で「最後の 1 件」を読む**（#333 の向き。
  // 禁じる綴りを並べるのではなく、実行系と同じ読み方をする）。
  const assign = lastAssignment(step.body, `echo\\s+"?${stepOutput}=([^"\\s]*)"?\\s*>>`);
  assert.ok(assign, `step \`${stepId}\` の \`${stepOutput}=\` の右辺が読めない`);
  const varName = assign.match(/^\$\{?([A-Za-z_]\w*)\}?$/)?.[1];
  const source = varName
    ? lastAssignment(step.body, `${varName}=(.+)`) // 変数への最後の代入（シェルと同じ）
    : assign; // 変数を経由せず直に書いている形
  assert.ok(source, `\`${stepOutput}=${assign}\` の出どころ（${varName ?? "直値"}）が step の中に見つからない`);
  assert.match(
    source,
    /released-ref\.sh\s+resolve/,
    `\`${stepOutput}\` の値が released-ref.sh resolve から来ていない: ${source}\n` +
      "本番のコードは released タグの sha でなければならない（#134 / Y3）",
  );

  // data/ は main から（コードと混ぜない）
  const dataRef = production.body.match(/^ {6}data_ref:\s*(.+)$/m)?.[1]?.trim();
  assert.equal(dataRef, "main", `production の data_ref が main でない: ${dataRef}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 検査自身が何かを主張していることを確かめる（#1043）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **上の 2 つの検査は、いま在る形が正しいので `bad` が構造的に空になる。**
 * **だから `STEP_OUTPUT_REF` を「何でも通す」形に緩めても緑のまま通りうる**——
 * **正規表現そのものが何も主張していない状態である**（#1043 で実際に起きた）。
 *
 * **だから「通すべき綴り」と「通してはいけない綴り」を逐語で当てる。**
 * ここが落ちれば「定義が緩んだ」と分かる（走査の側とは別の理由で落ちる）。
 *
 * **定義は 1 か所**（`STEP_OUTPUT_REF`）。**写しを 2 つ書かない。**
 */
test("#1036: steps.<id>.outputs.<n> の定義そのものを検査する（通す綴り / 通さない綴り）", () => {
  const ok = (s: string) => new RegExp(`^${STEP_OUTPUT_REF.source}$`).test(s);
  // 通すべき（実体。空白の揺れも通る）
  for (const good of [
    "${{ steps.released.outputs.ref }}",
    "${{steps.released.outputs.ref}}",
    "${{ steps.head.outputs.sha }}",
    "${{ steps.playwright-cache.outputs.cache-hit }}",
  ]) {
    assert.ok(ok(good), `通すべき綴りが落ちた: ${good}`);
  }
  // 通してはいけない（#1036 の Y2 / Y2'。**どれも step の出力ではない**）
  for (const bad of [
    "main",
    "refs/heads/main",
    "HEAD",
    "${{ github.sha }}",
    "${{ github.ref }}",
    "${{ github.ref_name }}",
    "${{ inputs.ref }}",
    "${{ needs.resolve.outputs.ref }}", // needs は step ではない（job outputs の束縛先にはなれない）
    "${{ steps.released.outputs.ref }} # trailing", // 束縛全体が参照そのものであることを要求する
  ]) {
    assert.ok(!ok(bad), `通してはいけない綴りが通った: ${bad}`);
  }
});

/**
 * **`lastAssignment` が「最後が勝つ」を読んでいることを逐語で当てる**（#1082 のレビュー）。
 *
 * **上の鎖の検査は、いま在る実体が `REF=` 1 回だけなので、`lastAssignment` を
 * `match`（最初の 1 件）に戻しても緑のまま通る。** **つまり走査の側からは、この関数が
 * 「最初」を読んでいるか「最後」を読んでいるかが見えない**（#1043 と同じ型）。
 * **だから関数そのものに当てる。**
 *
 * **これは「置換」ではなく「追記」の形である**（#333 の向き）——
 * **禁じる綴りを並べるのではなく、実行系と同じ読み方をしていることを要求する。**
 * **`REF=main` への置換だけを検査していると、次に 1 行追記した人を捕まえられない。**
 *
 * **実測（2026-09-28。この直しの前は 3 種とも素通りした）:**
 *
 * | 変異（`deploy-data.yml` に 1 行足す） | 直す前 | 直した後 |
 * |---|---|---|
 * | **G1** `REF=$(...resolve)` の次の行に `REF=main` | **54 pass / 0 fail** | 53 / **1** |
 * | **G4** `echo "ref=main" >> "$GITHUB_OUTPUT"` を 2 行目に追記 | **54 / 0** | 53 / **1** |
 * | **G5** `REF="${OVERRIDE:-main}"` を次の行に | **54 / 0** | 53 / **1** |
 *
 * （母数は鎖 3 ファイル = `workflow-released-chain` / `workflow-needs-resolve` / `deploy-docker`。
 * **「置換」の変異は直す前から赤だった**: `REF=main` への置換は 51 / 3。**追記だけが抜けていた。**）
 */
test("#1082: シェルと $GITHUB_OUTPUT の「最後が勝つ」を読む（追記で抜けさせない）", () => {
  // 実体と同じ形（代入 1 回）。最後 = 最初なので、そのまま読める
  assert.match(
    lastAssignment('          REF=$(bash scripts/ci/released-ref.sh resolve)\n', "REF=(.+)")!,
    /released-ref\.sh\s+resolve/,
  );

  // **G1**: `REF=` を 2 回。シェルが使うのは 2 行目なので、読むのも 2 行目
  assert.equal(
    lastAssignment("          REF=$(bash scripts/ci/released-ref.sh resolve)\n          REF=main\n", "REF=(.+)"),
    "main",
    "G1: 追記された `REF=main` ではなく 1 行目を読んでいる（シェルは最後の代入を使う）",
  );

  // **G5**: 追記の右辺が既定値つきの展開でも、読むのは最後の行
  assert.equal(
    lastAssignment(
      '          REF=$(bash scripts/ci/released-ref.sh resolve)\n          REF="${OVERRIDE:-main}"\n',
      "REF=(.+)",
    ),
    '"${OVERRIDE:-main}"',
    "G5: 追記された `REF=\"${OVERRIDE:-main}\"` ではなく 1 行目を読んでいる",
  );

  // **G4**: `$GITHUB_OUTPUT` は追記ファイル。同じ名前を 2 回書けば Actions は最後の行を採る
  assert.equal(
    lastAssignment(
      '          echo "ref=$REF" >> "$GITHUB_OUTPUT"\n          echo "ref=main" >> "$GITHUB_OUTPUT"\n',
      'echo\\s+"?ref=([^"\\s]*)"?\\s*>>',
    ),
    "main",
    "G4: $GITHUB_OUTPUT に 2 回書かれた `ref=` の 1 行目を読んでいる（Actions は最後の行を採る）",
  );

  // 1 件も当たらなければ undefined（「読めない」と「読んだ結果が空」を混ぜない）
  assert.equal(lastAssignment("          echo hi\n", "REF=(.+)"), undefined);
});

/**
 * **自前 YAML パースの形を固定する**（#1036 の 4.: 「値まで見るなら自前パースの限界に当たる」）。
 *
 * **依存を足していないので、パーサが黙って空を返すようになったら、上の検査は全部
 * 「0 件だから緑」になる。** 母数の assert はそれを塞ぐが、**母数の assert 自身が
 * 何を数えているかは、実体と突き合わせないと分からない。**
 *
 * **だから実測値を逐語で置く。** 2026-09-28 実測（`.github/workflows/` の実体）。
 *
 * **この 1 本は、正当なリファクタでも落ちる**（意図した動作）。
 * **実測**: `- id: released` と `steps.released.outputs` を**一貫して** `codeRef` に改名すると、
 * **鎖の検査は 2 本とも緑のまま**（正しく「同じ意味の別の綴り」を受け入れた）**この 1 本だけが赤くなる**
 * （86 中 85 pass / 1 fail）。**赤くなるのは「実体が変わったので母数の逐語を測り直せ」という意味**で、
 * **守りが緩んだという意味ではない。** 分けてあるのはそのためである——
 * **1 本にまとめると、改名した人が鎖の検査ごと緩める誘惑に当たる。**
 */
test("#1036: 自前パースが deploy-data.yml の実体どおりに読めている（母数の検算）", () => {
  const jobs = parseJobs(read("deploy-data.yml"));
  assert.deepEqual(
    jobs.map((j) => j.id),
    ["resolve", "staging", "production"],
    "deploy-data.yml の job が読めていない",
  );

  const resolveJob = jobs.find((j) => j.id === "resolve")!;
  // outputs は **キーだけでなく値まで**（#1017 が見ていなかったところ）
  assert.deepEqual([...resolveJob.outputs], [["ref", "${{ steps.released.outputs.ref }}"]]);
  // steps: checkout（uses、id なし）と released（id あり）の 2 つ
  assert.deepEqual(
    resolveJob.steps.map((s) => s.id ?? `uses:${s.uses}`),
    ["uses:actions/checkout@v4", "released"],
  );
  assert.deepEqual([...githubOutputNames(resolveJob.steps[1])], ["ref"]);

  // 全ワークフローを走査したときの母数（走査対象が減ったら落ちる）
  const files = workflowFiles();
  assert.ok(files.length >= 15, `ワークフローが ${files.length} 本しか無い（実測 2026-09-28: 15 本）`);
  const jobCount = files.reduce((n, f) => {
    const src = readIfPresent(f);
    return src === undefined ? n : n + parseJobs(src).length;
  }, 0);
  // **24 は `workflow-timeout.test.ts` の「#556 数え上げ」の job 名リスト（24 件）と一致する**
  // ——**別の実装が別の目的で維持している値と突き合わせてある**ので、
  // 「自分の写しを見て緑」になっていない。
  assert.ok(jobCount >= 24, `走査した job が ${jobCount} 件しか無い（実測 2026-09-28: 24 件）`);
});
