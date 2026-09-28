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

/**
 * **step の頭の行から、その step のマッピングのキーが並ぶ桁を出す**（#1100）。
 *
 * **インデントの深さは「構造」の代理であって、構造そのものではない。**
 * **実体はこうである**: step は `steps:` の下のシーケンス項目で、**頭の行は `<空白>- <最初のキー>`**。
 * **YAML ではその `- ` が占める桁のぶんだけ右に、同じマッピングの残りのキーが並ぶ。**
 * **つまりキーの桁は、頭の行そのものが決めている——定数ではない。**
 *
 * ```yaml
 *       - id: released      ← 頭の行。空白 6 + "- " 2 = キーの桁は 8
 *         run: |            ← 8。同じ step の直下
 *         with:
 *           ref: main       ← 10。孫。step の直下ではない
 * ```
 *
 * **`^ {6}(?:- )?` の決め打ちをやめる理由**:
 * **`{6,8}` のように「いま在る深さを並べる」直しは denylist の裏返しで**（#333 / #1008）、
 * **次に 10 スペースが来たときに同じ事故になる。**
 *
 * ── **どこまで追従するか（測った。誇張しない）** ─────────────────────────────
 *
 * **追従するのは「step の中のキーの桁」だけである。**
 * **`steps:` と `- ` の深さは、呼び手の `parseSteps` が `^ {4}steps:` / `^ {6}- ` で
 * 決め打ちしたままである**（この PR では触っていない）。
 *
 * **実測（2026-09-29。`parseSteps` に合成 YAML を食わせた）:**
 * ```
 * steps: が 4 / 頭が 6（いまの実体）   → 読める   ["six"]
 * steps: が 6 / 頭が 8                 → 読めない []
 * steps: が 8 / 頭が 10                → 読めない []
 * steps: が 2 / 頭が 4                 → 読めない []
 * ```
 * **つまり「job や steps: の深さが変わっても追従する」とは言えない。**
 * **初版の docblock はそう書いていたが、実測と反対だったので撤回した**（レビュー指摘 A-1）。
 *
 * **それでも決め打ちを残してよい理由**: **`parseSteps` は job 直下の行を受け取るので、
 * `steps:` は必ず 4、step の頭は必ず 6 である**（job 見出しが 2 スペースであることから導かれる）。
 * **実測: 実体の step の頭は 6 スペースが 128 件、4 スペースが 11 件（後者は `steps:` 配下ではない）。**
 * **この関数が実際に広げたのは「同じ深さでも `- ` の後ろの桁が違う形」への追従**であり、
 * **素朴な `{6,8}` との差が M4c で 1 件しか出ないのは、そのためである。**
 */
/**
 * **step の頭の行の `<空白>-<空白>` を、同じ幅の空白に畳む**（#1100）。
 *
 * **フラグを付けない。** **`^` が文字列の先頭だけに当たるので、頭の行だけが畳まれる。**
 * **`/m` や `/g` を足すと `run:` ブロックの中の `- id:` まで畳んでしまう**
 * ——**その差は下の検査で逐語に固定してある**（定義はここ 1 か所。#1043）。
 */
const foldStepDash = (body: string, re: RegExp = /^( *)-( +)/): string =>
  body.replace(re, (_m, a: string, b: string) => " ".repeat(a.length + 1 + b.length));

const stepKeyColumn = (head: string): number => {
  const m = head.match(/^( *)-( +)/);
  // 頭の行でない（呼び手が `      - ` で始まる行だけを渡すので、ここには来ない）
  if (!m) return head.match(/^ */)![0].length;
  return m[1].length + 1 + m[2].length;
};

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
    // **step の直下のキーが並ぶ桁は、頭の行が決める**（#1100。深さを決め打ちしない）。
    // 頭の行の `- ` の後ろ（= その桁）と、以降の行のその桁と、2 形のどちらでも同じ 1 つのキーである。
    const col = stepKeyColumn(jobLines[at]);
    // 頭の行の `<空白>-<空白>` は「キーの桁を埋めるもの」なので、空白と同じに畳んで読む
    const flat = foldStepDash(body);
    const key = (k2: string) => flat.match(new RegExp(`^ {${col}}${k2}:\\s*(.+)$`, "m"))?.[1]?.trim();
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

// ─────────────────────────────────────────────────────────────────────────────
// #1100 — step の直下のキーを「深さの決め打ち」ではなく「頭の行の形」から読む
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **#1100: `key()` が `^ {6}(?:- )?` を要求していたので、8 スペースの `id:` を読めなかった。**
 *
 * **母数（2026-09-28 実測。`.github/workflows/` の 15 本）:**
 *
 * ```
 * $ grep -rnE '^ *(- )?id:' .github/workflows --include='*.yml' | 先頭の空白を数える
 *    6 sp  3 件   deploy-data.yml:43 / deploy-site.yml:90 / etl.yml:54     ← 読めていた
 *    8 sp  8 件   ci.yml:149,152,297,300 / districts.yml:49 / etl.yml:111
 *                 / link-check.yml:67 / local-assemblies.yml:56           ← 読めていなかった
 * ```
 *
 * **11 件中 8 件、つまり多数派が読めていなかった。**
 * **パーサが見ていた step の id は 112 step 中 3 件だけだった**（実測）。
 *
 * ── **なぜ「6 か 8 のどちらでもよい」にしないか** ────────────────────────────
 *
 * **インデントの深さは「構造」の代理であって、構造そのものではない。**
 * `{6}` を `{6,8}` に緩めるのは、**いま在る 2 つの深さを列挙する denylist の裏返し**で、
 * **次に 10 スペースが来たら同じ事故になる**（#333 / #1008 の型）。
 *
 * **ただし正直に測ると、`{6,8}` はこのリポジトリの実体では全部読める**
 * （実測 M4c: 58 中 **57 pass / 1 fail**。落ちたのは下の (5) `-   ` の 1 件だけで、
 * 孫の (4) も実体の母数 (2)(3) も通る）。**「10 スペースの孫を拾ってしまう」は誤りだった**
 * ——`{6,8}` は 10 スペースには届かないので拾わない。
 * **`{6,8}` が本当に落ちるのは「桁が 6 でも 8 でもない形」のほうである**
 * （実測: 10 スペースでも 4 スペースでも `undefined` を返す）。
 *
 * **それでも決め打ちを採らないのは、`{6,8}` が「いま在る 2 つの値」を写しているだけで、
 * 桁が何で決まるのかを一度も言っていないからである。**
 * **次に桁が動いたとき、`{6,8}` は黙って `undefined` を返す**——
 * **`id:` が読めない step は「id の無い step」と見分けが付かず、
 * `steps.<id>` の参照は「参照先が無い」と報告される**（いま起きているのがこれである）。
 *
 * **実体はこうである**: step は `steps:` の下のシーケンス項目で、
 * **その頭の行 `      - ` の `- ` がちょうど 2 桁を占めるので、
 * step 自身のマッピングのキーは「頭の行のインデント + 2」の桁に並ぶ。**
 * **つまりキーの桁は、頭の行そのものが決めている。定数ではない。**
 * **だから頭の行から桁を計算して、その桁のキーだけを step の直下と見る。**
 *
 * **これで `- ` の後ろに空白が増えた形（`-   id: x`）に、書き換えずに追従する。**
 *
 * **`steps:` と `- ` の深さのほうは追従しない**——**`parseSteps` の入口が
 * `^ {4}steps:` / `^ {6}- ` を決め打ちしているため**（上の `stepKeyColumn` の docblock に実測を置いた）。
 * **初版はここに「6 / 8 / 10 スペースのどれでも読め」と書いていたが、
 * その検査は 1 本も存在せず、測ったら 8 / 10 / 4 はどれも読めなかった**（レビュー指摘 A-1）。
 * **下の (4) の 10 スペースは「孫として拾ってはいけない」側で、向きが逆である。**
 */
test("#1100: step の直下のキーは、頭の行のインデントから決まる（深さを決め打ちしない）", () => {
  // `parseSteps` は `jobLines`（job 名の次の行から）を受け取る
  const jobLines = (s: string) => s.replace(/^\n/, "").replace(/\n$/, "").split("\n");

  // (1) `- id:` の形（6 スペース。直す前から読めていた 3 件の形）
  const onDash = parseSteps(
    jobLines(`
    steps:
      - id: released
        run: echo hi
`),
  );
  assert.deepEqual(
    onDash.map((s) => s.id),
    ["released"],
    "`- id:` の形（頭の行に id）が読めない",
  );

  // (2) **`name:` が先に来て `id:` が 8 スペースの形——このリポジトリの 11 件中 8 件**
  const belowDash = parseSteps(
    jobLines(`
    steps:
      - name: resolve released ref
        id: released
        run: echo hi
`),
  );
  assert.deepEqual(
    belowDash.map((s) => s.id),
    ["released"],
    "8 スペースの `id:` が読めない（#1100 の本体。実体の 11 件中 8 件がこの形）",
  );

  // (3) `uses:` も同じ `key()` を通るので、同じく両方の形で読めること
  assert.equal(
    parseSteps(jobLines(`
    steps:
      - uses: actions/checkout@v4
`))[0].uses,
    "actions/checkout@v4",
  );
  assert.equal(
    parseSteps(jobLines(`
    steps:
      - name: check out
        uses: actions/checkout@v4
`))[0].uses,
    "actions/checkout@v4",
    "8 スペースの `uses:` が読めない（`uses:` を見落とすと外部 action の step を自前 step と誤判定する）",
  );

  // (4) **孫のキーを step の直下と読み違えない**——`with:` の下の `id:` は step の id ではない。
  //     **これは `{6,8}` の素朴な直しでも通る**（実測 M4c）。**桁を計算する側が緩みすぎていないことの確認**で、
  //     `{6,8}` との差を測っているのは (5) のほうである。
  const grandchild = parseSteps(
    jobLines(`
    steps:
      - name: comment
        uses: actions/github-script@v7
        with:
          id: not-a-step-id
          script: console.log(1)
`),
  );
  assert.equal(
    grandchild[0].id,
    undefined,
    "`with:` の下（10 スペース）の `id:` を step の id として拾っている（構造ではなく綴りを見ている）",
  );

  // (5) **`- ` の後ろの空白が 1 つでない形にも追従する**（桁は頭の行が決める）。
  //     **`{6,8}` の素朴な直しと差が出るのは、実測ではここ 1 件だけである**（M4c: 57 pass / 1 fail）。
  //     いまの実体には無い形だが、**桁を数えずに頭の行から出していることの、ただ 1 つの直接の証拠**である。
  assert.deepEqual(
    parseSteps(jobLines(`
    steps:
      -   name: spaced
          id: spaced-id
`)).map((s) => s.id),
    ["spaced-id"],
    "`-   ` の後ろの桁に追従していない（`+2` を決め打ちしている）",
  );

  // (5b) **頭の行そのものに載ったキー**を `-   ` の形で読む。
  //      **(5) だけでは足りない**——(5) の `id:` は頭の「次の行」に在るので、
  //      畳み幅を `+2` に決め打ちしても（頭の行が読めなくなるだけで）次の行の桁は合ってしまう。
  //      **実測: `+2` の変異は (5) を通り抜ける**（畳んだ頭が 8 桁・`col` が 10 桁でも、
  //      2 行目の `id:` は 10 桁に在るため）。**頭の行に載せて初めて、畳み幅そのものを測れる。**
  assert.deepEqual(
    parseSteps(jobLines(`
    steps:
      -   id: on-the-dash-line
          run: echo hi
`)).map((s) => s.id),
    ["on-the-dash-line"],
    "頭の行に載った `-   id:` が読めない（畳み幅が `- ` の実際の桁と合っていない）",
  );

  // (6) 隣の step のキーを混ぜない（step の境が効いていること）
  const two = parseSteps(
    jobLines(`
    steps:
      - name: first
        run: echo one
      - name: second
        id: second-id
        run: echo two
`),
  );
  assert.deepEqual(two.map((s) => s.id), [undefined, "second-id"], "step の境を越えてキーを拾っている");
});

/**
 * **`- ` を畳む `replace` にフラグを付けないことを固定する**（レビュー指摘 A-3）。
 *
 * **`flat` の `body.replace(/^( *)-( +)/, …)` はフラグを持たない。**
 * **フラグが無いので `^` は文字列の先頭だけに当たり、`body` は必ず step の頭の行で始まる**
 * ——**だから「頭の行の `- ` だけを畳む」が成立している。**
 *
 * ── **ここで「素通りする変異」を追試したら、結論が変わった（そのまま残す）** ─────────
 *
 * **レビュアーの実測**: `flat` の式**単体**に当てると、`/gm` は `run:` の中の行を畳んで
 * `"from-a-heredoc-or-docs"` を返す（as-shipped は `undefined`）。**この再現は正しい。**
 * **PO も追試して同じ結果を得た。**
 *
 * **しかし `parseSteps` を通すと、`/m` も `/gm` も as-shipped と同じ結果になる。**
 * **追試（2026-09-29。合成 YAML を `parseSteps` に食わせた）:**
 * ```
 * run: の中の `- id:` が 10 スペース   shipped [null]        /m [null]        /gm [null]
 * run: の中の `- id:` が  6 スペース   shipped [null,"at-six"] /m 同じ         /gm 同じ
 * ```
 *
 * **理由は桁の算術で尽きる**（例ではなく網羅）:
 * - **step の頭は必ず 6 スペース**（`parseSteps` が `^ {6}- ` しか head にしない）→ **`col` は必ず 8**
 * - **body の 2 行目以降に深さ 6 未満の行は入らない**（`^ {6}` でないと `steps:` を抜ける判定に当たる）
 * - **深さちょうど 6 の `- ` 行は「次の step の頭」なので、境で切れて body に入らない**
 * - **深さ 7 以上の `- ` 行は、畳むと `d + 1 + 空白数 >= 9 > 8 = col`** → **拾われない**
 *
 * **つまり `/m` `/gm` は、`parseSteps` 経由では等価変異である。**
 * **「落ちないのは検査が弱いから」ではなく、「呼び手が到達させないから」だった**
 * （作業合意「落ちない変異が等価変異なら、そう書いて残す」）。
 *
 * **それでも検査を置く理由**: **この等価性は `parseSteps` の入口の決め打ち
 * （`^ {4}steps:` / `^ {6}- `）に依存している。** **入口を構造的にした瞬間に崩れる。**
 * **だから「畳み込みの式そのもの」に当てて、フラグが付いたら落ちるようにする**
 * ——**呼び手の都合に守られている状態を、検査のほうで固定しておく。**
 *
 * ── **検査を置いた後の実測（2026-09-29）** ──────────────────────────────────
 * ```
 * N1  既定の正規表現に /m       59 / 0   ← **真に等価**。落ちなくて正しい（下記）
 * N2  既定の正規表現に /gm      58 / 1   ← **撃墜**（この検査が落とす）
 * N3  `+ 1 + b.length` → `+ 2`  58 / 1   ← **撃墜**（上の (5b) が落とす）
 * ```
 *
 * **N1 が等価である理由**: **`/m` はグローバルでないので「最初の一致」しか置換しない。**
 * **`body` は必ず step の頭の行で始まり、頭の行は必ず `^( *)-( +)` に当たる**ので、
 * **最初の一致は常に頭の行になる。** **実測: フラグ無しと `/m` の出力は文字列として一致し、
 * `/gm` だけが一致しない。** **だから N1 は「検査の穴」ではない。**
 *
 * **N3 について 1 つ記録する**（自分で踏んだ）: **初版はこの検査の中に畳み込みの式を
 * 書き写していた。** **その結果 N3 の変異が実装と検査の両方に当たり、
 * 検査が自分の写しを見て 59 / 0 で素通りした**——**#1043 の型そのものである。**
 * **`foldStepDash` を 1 定義にして呼ぶ形に直したら 58 / 1 で落ちるようになった。**
 * **さらに (5) だけでは N3 を捕まえられなかった**（`id:` が頭の「次の行」に在るので、
 * 畳み幅を間違えても 2 行目の桁は合ってしまう）——**(5b) で頭の行に載せて初めて測れた。**
 */
test("#1100: `- ` の畳み込みは頭の行だけに効く（フラグを付けると run: の中の `- id:` を拾う）", () => {
  // **実装と同じ `foldStepDash` を呼ぶ**（写しを 2 つ置かない。#1043）。
  // **初版はここに同じ式を書き写していた**——**その結果 N3（`+1+b.length` → `+2`）の変異が
  // 実装と検査の両方に当たり、検査が自分の写しを見て緑のままになった**（59/59 で素通り）。
  // **1 定義にしたら 58/1 で落ちる。**
  // step の頭（6 スペース）+ `run:` の中に、頭とまったく同じ綴りの行
  const body = [
    "      - name: write a workflow",
    "        run: |",
    "          cat <<'YAML' > out.yml",
    "      - id: from-a-heredoc-or-docs",
  ].join("\n");
  const readId = (s: string) => s.match(new RegExp("^ {8}id:\\s*(.+)$", "m"))?.[1]?.trim();

  // **実装と同じ「フラグ無し」**: 頭の行だけ畳むので、`run:` の中の行は残り、id は読めない
  assert.equal(
    readId(foldStepDash(body)),
    undefined,
    "フラグ無しの畳み込みが `run:` の中の `- id:` を拾っている",
  );

  // **`/gm` を付けると拾う**——**この検査が何かを主張していることの対照**
  // （恒真ではない: 同じ入力で結果が変わることを、ここで示している）
  assert.equal(
    readId(foldStepDash(body, /^( *)-( +)/gm)),
    "from-a-heredoc-or-docs",
    "`/gm` でも拾えないなら、この fixture は畳み込みの差を測れていない（fixture を疑う）",
  );
});

/**
 * **#1100 の母数を実体に固定する**（#757）。
 *
 * **「0 件だから緑」も「数えていないから緑」も塞ぐ**——
 * **`.github/workflows/` に実在する `id:` の件数を grep と同じ規則で数え、
 * パーサが見つけた件数と突き合わせる。**
 *
 * **直す前の実測: 実体 11 件 / パーサが見たのは 3 件**（8 件を黙って落としていた）。
 * **直した後: 11 / 11。**
 *
 * **この 1 本は、ワークフローに step を足したり `id:` を増やしたりすると落ちる**（意図した動作）。
 * **落ちたら数え直す**——**「パーサが実体を全部見ているか」を人手で再確認する合図である。**
 */
test("#1100: パーサが見つける step の id が、実体の `id:` 行と 1 件も食い違わない（母数）", () => {
  const files = workflowFiles();
  assert.ok(files.length >= 15, `ワークフローが ${files.length} 本しか無い（実測 2026-09-28: 15 本）`);

  // 実体側: `id:` と書いてある行を、パーサとは**別の読み方**で数える（自分の写しを見ない。#1043）
  const literal: { file: string; indent: number; id: string }[] = [];
  for (const f of files) {
    const src = readIfPresent(f);
    if (src === undefined) continue;
    for (const line of src.split("\n").map(stripComment)) {
      const m = line.match(/^( *)(?:- )?id:\s*(.+)$/);
      if (m) literal.push({ file: f, indent: m[1].length, id: m[2].trim().replace(/^["']|["']$/g, "") });
    }
  }

  // パーサ側
  const parsed: { file: string; id: string }[] = [];
  let steps = 0;
  for (const f of files) {
    const src = readIfPresent(f);
    if (src === undefined) continue;
    for (const job of parseJobs(src)) {
      for (const s of job.steps) {
        steps++;
        if (s.id) parsed.push({ file: f, id: s.id });
      }
    }
  }

  // 母数（走査が空回りしていないこと）
  assert.ok(steps >= 100, `走査した step が ${steps} 件しか無い（実測 2026-09-28: 112 件）`);
  assert.ok(literal.length >= 11, `実体の \`id:\` が ${literal.length} 件しか無い（実測 2026-09-28: 11 件）`);

  // **8 スペースの id: が多数派であることを固定する**——
  // **fixture が 6 スペースばかりだと、8 スペースの検査を足したつもりで何も守っていない**（#1100 の注文）。
  const deep = literal.filter((x) => x.indent === 8);
  assert.ok(
    deep.length >= 8,
    `8 スペースの \`id:\` が ${deep.length} 件しか無い（実測 2026-09-28: 11 件中 8 件が 8 スペース）。` +
      "実体が浅い形ばかりになったなら、上の parse の検査だけが #1100 を守っている",
  );

  // **本体**: 実体に在る id を、パーサが 1 件残らず同じファイルで見つけている
  const key = (x: { file: string; id: string }) => `${x.file}:${x.id}`;
  const missing = literal.map(key).filter((k) => !parsed.map(key).includes(k));
  assert.deepEqual(
    missing,
    [],
    `実体に在る \`id:\` をパーサが見ていない（直す前は 8 件が見えていなかった）:\n  ${missing.join("\n  ")}`,
  );
  assert.equal(
    parsed.length,
    literal.length,
    `パーサが見た id が ${parsed.length} 件、実体は ${literal.length} 件（直す前は 3 / 11 だった）`,
  );
});

/**
 * **#1100: `steps.<id>.outputs.<n>` の参照先が、すべて実在の step に辿れる。**
 *
 * **これまでは job の `outputs:` に書かれた 2 件しか辿っていなかった**
 * （`deploy-data.yml resolve.ref` / `deploy-site.yml deploy.sha`。どちらも 6 スペースの id）。
 * **実体には `steps.*` の参照が 21 件ある**（2026-09-28 実測）——
 * **直す前に辿れたのは 4 件だけだった**（`deploy-data` の `released` / `deploy-site` の `head` /
 * `etl.yml` の `date` 2 件。どれも 6 スペースの id）。
 * **残る 17 件は step の本体（`if:` / `env:` / `key:`）の中から 8 スペースの id を指していたので、
 * 直す前は 1 件も辿れなかった**（実測: この検査を直す前のパーサに当てると 17 件が `bad` に出る）。
 *
 * **参照先が無い `steps.*` は Actions では空文字に解決され、黙って通る**
 * （`if: steps.pr.outputs.number != ''` は常に真、`env: PR: ${{ steps.pr.outputs.number }}` は空）。
 * **鎖の検査が見ていなかった 19 件も、同じ性質の穴である。**
 */
test("#1100: すべての `steps.<id>.outputs.<n>` 参照が、同じ job の実在する step を指している（21 件）", () => {
  const files = workflowFiles();
  const bad: string[] = [];
  let refs = 0;

  for (const f of files) {
    const src = readIfPresent(f);
    if (src === undefined) continue;
    for (const job of parseJobs(src)) {
      const ids = new Set(job.steps.map((s) => s.id).filter(Boolean) as string[]);
      // job の outputs: と step の本体の両方を見る（`if:` は `${{ }}` 無しでも書けるので別に拾う）
      const texts = [...[...job.outputs.values()], ...job.steps.map((s) => s.body)];
      for (const t of texts) {
        for (const m of t.matchAll(/steps\.([A-Za-z_][\w-]*)\.outputs\.([A-Za-z_][\w-]*)/g)) {
          refs++;
          if (!ids.has(m[1])) {
            bad.push(
              `${f}: job \`${job.id}\` が \`steps.${m[1]}.outputs.${m[2]}\` を参照しているが、` +
                `\`id: ${m[1]}\` の step が無い（実在する id: ${JSON.stringify([...ids])}）→ 空文字に解決される`,
            );
          }
        }
      }
    }
  }

  // 母数（#757）。**直す前はここが 21 件のうち 18 件を「参照先が無い」と報告した。**
  assert.ok(
    refs >= 21,
    `\`steps.*.outputs.*\` の参照が ${refs} 件しか見つからない（実測 2026-09-28: 21 件）。走査が空回りしていないか`,
  );
  assert.deepEqual(bad, [], `参照先の step が無い:\n  ${bad.join("\n  ")}`);
});
