import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
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

function jobsOf(file: string, dir: string = wfDir): Job[] {
  return jobsOfText(readFileSync(resolve(dir, file), "utf8"), file);
}

/**
 * ワークフローの**生のテキスト**を読む（#1179）。**コメントを落とさない。**
 *
 * **`stripComment` を通さないのは意図である**——**`run:` ブロックの中で `#` を落とすと、
 * シェルの文字列やコメント付きの行が壊れる**（メモリの「YAML の # 落としは安全ではない」）。
 * **ここを使う側は逐語の正規表現しか当てない。**
 *
 * **`jobsOf` と同じ `(file, dir)` の形にしてある**のは #1081 の自己検査のためである
 * （`resolve(wfDir, …)` と書くと「共有ディレクトリへ書き込む手段」の検査が鳴る。
 *  読み取りはこの helper 経由に寄せる、というのがその検査の求めている形）。
 */
function textOf(file: string, dir: string = wfDir): string {
  return readFileSync(resolve(dir, file), "utf8");
}

/**
 * GitHub は `.yml` と `.yaml` の両方を実行する。`.yml` だけ見ると .yaml のワークフローが
 * 丸ごと不可視になる（#574）。
 *
 * #1081: 走査先を引数にしてあるが、**既定は本物の `.github/workflows/`**である。
 * 既定を変えると、このファイルの他の検査（数え上げ・timeout の値）が本番を見なくなる。
 * 既定値が本物のディレクトリであることは下の「既定の走査先」の検査で固定してある。
 */
function listAllJobs(dir: string = wfDir): Job[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .flatMap((f) => jobsOf(f, dir));
}

const allJobs = listAllJobs();

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

/**
 * #574: readdirSync のフィルタが .yml だけを見ていたため、.yaml のワークフローが
 * allJobs から丸ごと不可視だった。
 *
 * fixture 文字列に対するテスト（jobsOfText）だけでは、readdirSync のフィルタ行を壊しても
 * 検出できない（実測: `.filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))` を
 * `.filter((f) => f.endsWith(".yml"))` に戻す変異は、fixture テストだけでは 10/10 緑のまま
 * 通る＝等価変異になる）。**readdirSync を本当に通すことが、この検査の検出能力の source である。**
 *
 * ## **この置き方は、ほかのテストファイルと競走した**（#1056 で測り、**#1081 で直した**）
 *
 * **`node --test` はテストファイルを並行に流す。** **2026-09-28 まで、ここは本物の
 * `.github/workflows/` にファイルを置いて消していたので、同じディレクトリを `readdirSync` する
 * ほかのファイル（実測 8 本）が「見えたのに開けない」瞬間に当たった**（`ENOENT` で落ちる）。
 * **全 PR のマージが止まった**（#1081）。
 *
 * **実測（#1056。2026-09-27。`workflow-timeout.test.ts` と `workflow-pr-body-edited.test.ts` を
 * 2 ファイル並べて 6 回ずつ）**:
 *
 * | 版 | 落ちた回数 |
 * |---|---:|
 * | #1056 の PR | **2 / 6** |
 * | **`origin/main`（0f734507。#1056 の変更を戻したもの）** | **1 / 6** |
 *
 * **＝#1056 が作った問題ではない。** **`pnpm test` の全走でも 1 回踏んだ**（435 秒の回）。
 * **#1081 で独立に再現したもの**: 書き手 1 本 + 読み手 7 本を 8 並列で 8 回走らせて **2 回赤**。
 * 落ちた先は `workflow-pr-body-edited.test.ts:217` の readFileSync。
 *
 * ── #1081: 走査先は使い捨てのディレクトリにする ────────────────────────────
 * 直し方は「消す」ではない（消すと #574 の穴が無検査に戻る）。
 * **`listAllJobs(dir)` に走査先を渡せるようにし、ここでは mkdtempSync のディレクトリに
 * 本物の `.yml` と `.yaml` を置いて呼ぶ。** readdirSync を通る経路は同一なので、
 * フィルタ行の変異は同じように死ぬ（実測: 直した後も 1 fail）。
 * **共有ディレクトリには 1 バイトも書かない。**
 *
 * `.yml` も一緒に置く理由: `.yaml` だけを置くと、フィルタを `.yaml` 単独に**狭める**変異
 * （`f.endsWith(".yaml")` だけ）が通ってしまう。両方が見えることを 1 回で主張する。
 */
test("#574 .yaml 拡張子のワークフローも listAllJobs（readdirSync 経由）から見える", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "seiji-wf-ext-"));
  const yamlProbe = "probe-574-yaml-visibility.yaml";
  const ymlProbe = "probe-574-yml-visibility.yml";
  const probeYaml = (job: string) =>
    ["jobs:", `  ${job}:`, "    runs-on: ubuntu-latest", "    timeout-minutes: 5", "    steps:", "      - run: echo hi", ""].join("\n");
  writeFileSync(resolve(dir, yamlProbe), probeYaml("probejobyaml"), "utf8");
  writeFileSync(resolve(dir, ymlProbe), probeYaml("probejobyml"), "utf8");
  try {
    // 実装本体の listAllJobs() を、走査先だけ差し替えて呼ぶ（readdirSync とフィルタ行は同じ）。
    const found = listAllJobs(dir)
      .map(id)
      .sort();
    assert.deepEqual(found, [`${yamlProbe}:probejobyaml`, `${ymlProbe}:probejobyml`].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * #1081 の穴: 走査先を引数にした結果、「テストは一時ディレクトリを見ているが**本番は本物の
 * ディレクトリを見ている**」ことを誰も検査しなくなる（#1063 と同型）。
 * **既定の走査先が本物の `.github/workflows/` であること**を、引数を渡さない呼び出しの結果で固定する。
 *
 * 母数はハードコードしない（下の「数え上げ」が名前ごと固定している）。ここが見るのは
 * **既定と本物のディレクトリを明示的に渡した場合が同じになること**と、
 * **一時ディレクトリの中身が混ざっていないこと**。
 */
test("#1081 listAllJobs() の既定の走査先は本物の .github/workflows（テストだけが差し替えられる）", () => {
  assert.deepEqual(
    listAllJobs().map(id).sort(),
    listAllJobs(wfDir).map(id).sort(),
  );
  assert.ok(listAllJobs().length > 0, "既定の走査先に job が 1 つも無い（既定が空のディレクトリを指している）");
  assert.deepEqual(
    listAllJobs().filter((j) => j.file.startsWith("probe-")).map(id),
    [],
    "本物のディレクトリに probe- のファイルが残っている（共有ディレクトリを汚した）",
  );
});

/**
 * #1081: このファイルが本物の `.github/workflows/` に書き込む**手段を持たない**ことを、
 * 自分のソースで固定する。値ではなく「手段を持たない」ことを固定する形
 * （`scripts/ci/test/link-check.test.sh` が同じ形を使っている）。
 * これを消すと、次に誰かが「一時的に置いて消す」を書いたときに、また全 PR が止まる。
 *
 * **`resolve(wfDir, ...)` だけを狙わない**——`join(wfDir, x)` でも、
 * `const p = resolve(wfDir, x)` と一度変数に置いてから書いても同じことが起きる。
 * そこで「書き込み API の行」と「`wfDir` から書き込み先のパスを作る行」の**両側**を見る:
 * このファイルで書き込み API を呼んでよいのは `dir`（mkdtempSync で作った使い捨て）の中だけである。
 *
 * **これは denylist なので「これで全部」ではない**（`const d = wfDir;` と別名にすれば抜ける）。
 * 抜けうる形をここに書いておく——それでも、素直に書いたときに必ず鳴るほうが無いより強い。
 */
const WRITE_API = /\b(writeFileSync|writeFile|mkdirSync|mkdir|cpSync|copyFileSync|appendFileSync|appendFile|rmSync|rm|unlinkSync|renameSync|symlinkSync|openSync)\s*\(/;
test("#1081 このテストは共有ディレクトリ（wfDir）へ書き込む手段を持たない", () => {
  const lines = readFileSync(fileURLToPath(import.meta.url), "utf8")
    .split("\n")
    .map((l, i) => ({ n: i + 1, l }))
    // 行コメント（`*` で始まる docblock の中身と `//`）は本文ではないので落とす
    .filter(({ l }) => !/^\s*(\*|\/\/|\/\*)/.test(l));

  // (a) 書き込み API と wfDir が同じ行にある
  const sameLine = lines.filter(({ l }) => WRITE_API.test(l) && /\bwfDir\b/.test(l)).map(({ n, l }) => `${n}: ${l.trim()}`);
  assert.deepEqual(sameLine, [], "書き込み API に wfDir を渡している行がある（並行する読み手 8 本を ENOENT で壊す。#1081）");

  // (b) wfDir からパスを組み立てている行が、宣言以外にある（変数に置いてから書く形を塞ぐ）
  const derives = lines
    .filter(({ l }) => /(resolve|join)\s*\(\s*wfDir\s*,/.test(l))
    .map(({ n, l }) => `${n}: ${l.trim()}`);
  assert.deepEqual(derives, [], "wfDir からパスを組み立てている行がある（読み取りは jobsOf(file, dir) 経由に寄せる。#1081）");

  // (c) 書き込み API を呼ぶ行は、使い捨てディレクトリ `dir` を渡すものだけ
  const writes = lines.filter(({ l }) => WRITE_API.test(l) && !/WRITE_API|assert\./.test(l));
  const notTemp = writes.filter(({ l }) => !/\bdir\b/.test(l)).map(({ n, l }) => `${n}: ${l.trim()}`);
  assert.deepEqual(notTemp, [], "書き込み先が使い捨てディレクトリ（dir）でない行がある。#1081");
  assert.ok(writes.length >= 3, `書き込み API の行が ${writes.length} 本しか無い（この検査が空回りしている。#1081）`);
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
    "build-site.yml:build",
    "deploy-site.yml:build",
    "deploy-site.yml:deploy",
    "deploy-staging.yml:staging",
    "districts.yml:districts",
    "environment-protection.yml:guard",
    "etl.yml:etl",
    "link-check.yml:link-check",
    "local-assemblies.yml:local-assemblies",
    "monitor.yml:production",
    "monitor.yml:staging",
    "pr-body.yml:pr-closes",
    "release.yml:production",
    "release.yml:released-tag",
    // #1110: スクラムの停滞監視の入口（`scripts/po/scrum-monitor.sh` を 10 分ごとに回す）。
    "scrum-monitor.yml:monitor",
    "security-alerts.yml:guard",
    "security.yml:audit",
    "security.yml:forbidden-patterns",
    "security.yml:gitleaks",
    "security.yml:issue-secrets",
  ].sort());
});

/** 再利用ワークフローを呼ぶ job（timeout-minutes を**書けない**側）を名指しで固定する */
test("#556 数え上げ: uses: で再利用ワークフローを呼ぶ job（timeout-minutes を書けない）", () => {
  const uses = allJobs.filter((j) => j.kind === "uses").map(id).sort();
  assert.deepEqual(uses, [
    "deploy-data.yml:production",
    "deploy-data.yml:staging",
    // #1137: deploy-site.yml の `build` は build-site.yml を呼ぶ job になった
    // （ビルドを別ファイルに出して、そこに secrets を渡さないため）。
    "deploy-site.yml:build",
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
 *   ci.yml:check                    26   414   629   652   658s  → 30 分（max の 2.7 倍。**2026-09-27
 *                                                                    再測。ref 0f734507 以降**。#1056）
 *   ci.yml:docker-web               53    82    99   110   114s  → 20 分（max の 10.5 倍。2026-09-27 再測）
 *   ci.yml:stale-base               17     6     8    10    10s  → 10 分
 *   pr-body.yml:pr-closes           32     6     7     9    77s  → 10 分（**2026-09-27 再測。max が
 *                                                                    10 → 77s**。**p90 は 9s で、
 *                                                                    max はランナー待ちの裾**。#1056）
 *   deploy-data.yml:resolve         38     5     9    12    45s  → 10 分（**再測。max が 13 → 45s**）
 *   build-site.yml:build            —     —     —     —     —    → 30 分（**#1137 で切り出した新しい
 *                                                                    workflow。CI 実測はまだ 0 本**——
 *                                                                    `workflow_call` 専用なので PR の run に
 *                                                                    出てこない。**初回はマージ後の push が本番**）
 *   deploy-site.yml:deploy          —     —     —     —     —    → 30 分（**#1137 で download + rsync だけに
 *                                                                    なった。CI 実測はまだ 0 本**）
 *
 *   **#1137 の分割で増えた仕事の CI 実測は 0 本である。** 割る前の「ビルド + rsync」は
 *   production n=38 max 112s / staging n=37 max 101s（2026-09-27、呼び出し元の job で測った）。
 *   分割後は **`apps/web/build/client/` が artifact として 1 往復する**。
 *
 *   **CI では測れないので、手元で artifact の圧縮と展開だけを測った**（2026-10-04、
 *   `SITE_ORIGIN=https://staging.giinrecord.jp pnpm build` の出力 **957 MB / 15,769 ファイル**。
 *   `zip` / `unzip` は `upload-artifact@v4` / `download-artifact@v4` と同じ zip 形式。
 *   **これは runner の実測ではない**——手元のマシンの数で、ネットワークの時間は含まない）:
 *
 *     何を                              level 0   level 6（既定）
 *     zip（upload 側の圧縮）              33.8s      67.6s
 *     サイズ（片道）                      908 MB     183 MB
 *     unzip（download 側の展開）          20.1s      15.9s
 *     往復のバイト（upload + download）  1,815 MB    367 MB
 *
 *   **既定の 6 を使う**（この PR の最初の版は `compression-level: 0` を書いていたが、
 *   根拠にした「中身の大半は既に圧縮済み」が実測で否定された。圧縮済みのバイトは
 *   **46 MB / 901 MB = 5.1%** しかない。測り方と表は
 *   `workflow-deploy-split.test.ts` の docblock が 1 か所で持つ）。
 *
 *   **artifact から `data/` を外せないことも確かめた**（2026-10-04。外すのが一番効く案だった）:
 *   `data/members/` 218 MB は `/compare` が `/data/members/{id}.json` を fetch し、
 *   `data/districts/` 14 MB は `ZipLookup` が `/data/districts/zip/{上3桁}.json` を fetch し、
 *   `data/data-archive.zip` 37 MB は `/about` の一括ダウンロードが指す。
 *   **どれも実行時にサイトが配信する実体なので、外すとサイトが壊れる。**
 *   外せるのは `unmatched*.json` / `group-mismatch.json`（合計 104 KB、app から 1 か所も
 *   fetch されない）だけで、**957 MB に対して 0.01% なので割に合わない**
 *   （`path:` に除外の列挙が増え、1 件の path を固定している検査も緩める必要が出る）。
 *
 *   **だから分割前の 30 分を両方に置いた**（減らすのは CI の n が溜まってから。薄くして
 *   本番の初回を落とすほうが害が大きい）。**最初の数 run を見て測り直すこと。**
 *   release.yml:released-tag        37     3     4     5     8s  → 10 分（再測。変わらず）
 *   security.yml:gitleaks           40     9    11    15    16s  → 20 分（全履歴走査の週次がある。
 *                                                                    再測で max 48 → 16s に下がった）
 *   security.yml:forbidden-patterns 40     7     8    10    12s  → 10 分（再測。変わらず）
 *   security.yml:issue-secrets       0     -     -     -     -    → 10 分（**CI 実測はまだ 0 本**。
 *                                                                    手元で 1,359 件を 1 回の gh api
 *                                                                    ＋ python で読んで 6 秒。週次で
 *                                                                    しか走らないので n が溜まるのは
 *                                                                    遅い。溜まったら測り直すこと）
 *   security.yml:audit              40     8    12    14    17s  → 10 分（再測。max 25 → 17s）
 *   link-check.yml:link-check        3   146   187   335   335s  → 20 分（**手元の 107〜171s より遅い。
 *                                                                    n=3 しか無い**。2026-09-27）
 *
 * 上限も固定する理由: 6 時間の既定に近い値を書くと、付いていても止まらない。
 * ここが落ちたら「実測し直して、この表ごと更新する」のが正しい直し方。
 *
 * ## **この表が実測値の 1 か所である**（Issue #1056）
 *
 * **`ci.yml` にも同じ数が書かれていて、そちらが腐った。** **実測（2026-09-27）**:
 *
 * | 何を読むか | min | med | p90 | max | n |
 * |---|---:|---:|---:|---:|---:|
 * | `ci.yml` のコメント（2026-09-06 の測定） | 153 | 210 | 223 | **225** | 36 |
 * | **実測・#1030 マージ前**（〜 2026-09-27T00:07Z） | 371 | 537 | 592 | **630** | 28 |
 * | **実測・#1030 マージ後** | 414 | 629 | 652 | **658** | 26 |
 *
 * **#1056 の Issue は 508 秒（手元のフルスイート）を #1030 のせいと読んだが、CI の `check` で測ると
 * #1030 の寄与は max 630 → 658（+28s）／med 537 → 629（+92s）で、
 * **225 → 630 のずれは #1030 より前から在った**（2.8 倍）。**数が 1 か所に無いと、こう取り違える。**
 *
 * **だから各ワークフローからは数を消し、この表を指すだけにした**（#1056。`ci.yml` の 2 か所 /
 * `pr-body.yml` / `deploy-site.yml` / `deploy-data.yml` / `link-check.yml` / `security.yml` の 2 か所 /
 * `release.yml`）。
 *
 * **これは「腐らない形」ではない。「1 か所に集めた」だけである**（#1056 のレビューの指摘。**正確に書く**）。
 * **下の assert が固定しているのは `timeout-minutes` の値だけで、この表の秒数は 1 つも assert していない。**
 * **＝秒数が古くなっても CI は落ちない。** **秒数を assert しない選択は意図的である**——
 * **機械の負荷で 2 倍以上動くので、閾値を置くと偽陽性のほうが多くなる**（下の「規約」を見よ）。
 * **効くのは「同じ数が 2 か所にあって片方だけ更新される」形を無くしたことだけである。**
 *
 * ## **表を更新するときの規約**（#1056。#1032 でも同じ型の陳腐化が起きている）
 *
 * **必ず「測った日」と「どの ref／どの期間の run を読んだか」を併記すること。**
 * **「実測 225s」だけでは、いつの何の 225 秒か分からず、腐ったことに誰も気づけない。**
 * **機械の負荷で 2 倍以上動く**（#1032 のレビュアーは同じジョブで 583 秒と 1,175 秒を得ている）ので、
 * **1 本の数ではなく n つきの min/med/p90/max を書くこと。**
 *
 * ## **同じ形の陳腐化を全部数えた**（#1056 の 4 番。**「0 件」と「数えていない」を区別する**）
 *
 * **`grep -rnE '実測[^\n]*([0-9]+ *(秒|s[^a-z]))' .github/` で 14 行。**
 * **そのうち job の所要時間を書いている 10 ジョブを 2026-09-27 に全部測り直した**（上の表）。
 * **記録より max が伸びていたのは 4 ジョブ**:
 *
 * | job | 書いてあった max | **実測の max** | 倍 | `timeout-minutes` に対する余裕 |
 * |---|---:|---:|---:|---:|
 * | `pr-body.yml:pr-closes` | 10s | **77s** | 7.7 | 7.8 倍 |**（下の注を見よ）** |
 * | `deploy-data.yml:resolve` | 13s | **45s** | 3.5 | 13.3 倍 |
 * | `link-check.yml:link-check` | 171s | **335s** | 2.0 | 3.6 倍（**n=3 しか無い**） |
 * | `deploy-site.yml:deploy` | 71s | **112s**（呼び出し元） | 1.6 | 16.1 倍 |
 *
 * **伸びていなかったのは 4 ジョブ**（`release.yml:released-tag` 8→8 /
 * `security.yml:forbidden-patterns` 12→12 / `security.yml:audit` 25→17 /
 * `security.yml:gitleaks` 48→16）。**`ci.yml:stale-base` と `security.yml:issue-secrets` は
 * この測り直しで n を取っていない**（前者は #556 の n=17 のまま、後者は CI 実測がまだ 0 本）。
 *
 * **どれも `timeout-minutes` を破っていない**（最悪は `link-check` の 3.6 倍）。
 * **＝いま落ちる問題は 1 つも無い。腐っているのは「余裕がどれだけあるか」の読みだけである。**
 *
 * ### **`pr-closes` は「日付を併記しても腐りに気づけなかった」実例である**（#1056 のレビュー）
 *
 * **`pr-body.yml` には「実測 min 6 / med 8 / max 10s（n=32、**2026-09-27**）／
 * 伸びる余地はほぼ無い」と書いてあり、この表の「max 77s（n=16、**2026-09-27**）」と
 * 同じ日付で 7.7 倍食い違っていた。** **日付が同じなので、次に読む人はどちらが新しいか判断できない**
 * ——**「測った日と ref を併記すれば腐りに気づける」は、これだけでは足りない。**
 * **数を 1 か所にするほうが効く**（だから `pr-body.yml` からは消した）。
 *
 * **そして「伸びる余地はほぼ無い」は、半分正しく半分誤りだった**（再測 n=32 で確定）:
 *
 * | | min | med | **p90** | max |
 * |---|---:|---:|---:|---:|
 * | `pr-body.yml:pr-closes` | 6 | 7 | **9** | **77** |
 *
 * **p90 が 9s なのに max が 77s**——**外れ値は 2 件だけ（77s / 43s）。**
 *
 * **77s の内訳**（#1056 のレビューが測った。**「割り当て待ち」と書いたのは私の誤りだった**）:
 *
 * | 区間 | 秒 |
 * |---|---:|
 * | `created_at` → `started_at`（**割り当て待ち**） | **2** |
 * | **`started_at` → 最初の step（ランナーの立ち上がり）** | **69** |
 * | step の合計（job の仕事） | **5** |
 *
 * **「API を叩かず install もしない＝仕事は伸びない」は正しい**（step は全件 5〜8s）。
 * **「だから wall も伸びない」は誤り。**
 * **そして 69 秒は「job の仕事」ではないが「job の時間」である——`timeout-minutes` はこれも数える。**
 * **「割り当て待ちだから timeout には関係ない」と読むと 10 分を削る余地を作ってしまうので、
 * そう書かないこと。** **仕事の軽さを wall の短さと読み替えない。**
 */
test("#556 値が実測から外れていない（短すぎる = 偽陽性 / 長すぎる = 止まらない）", () => {
  const expected: Record<string, number> = {
    // #1056: 実測 min 414 / med 629 / p90 652 / max 658s（n=26、2026-09-27、ref 0f734507 以降）。
    // max の 2.7 倍。**ci.yml 側からは数を消した**（2 か所にあると片方が腐る。上の表を見よ）。
    "ci.yml:check": 30,
    // #1056: 実測 min 82 / med 99 / p90 110 / max 114s（n=53、2026-09-27）。max の 10.5 倍。
    "ci.yml:docker-web": 20,
    "ci.yml:stale-base": 10,
    // #793 / #1039 / #1056: **実測値は上の表が持つ**（ここに「min 6 / med 8 / max 10s」と
    // 書いてあったが、**同じファイルの上の表は max 77s** で 7.7 倍食い違っていた。#1056 の
    // レビューが見つけた: `pr-body.yml` から数を消したとき、**「2 か所」が「同じファイルの中で
    // 2 か所」に縮んだだけだった**）。#1039 で ci.yml から pr-body.yml に分けた
    // （本文を編集したら測り直させるため）。stale-base と同値の 10 分。
    "pr-body.yml:pr-closes": 10,
    "deploy-data.yml:resolve": 10,
    // #1137: 割る前は 1 つの job の 30 分が「ビルド + rsync」を覆っていた。
    // いまはビルドが別ファイル（build-site.yml）で 30 分、rsync する deploy が 30 分。
    // **どちらも CI 実測はまだ 0 本**（`deploy-site.yml` は `workflow_call` 専用なので
    // PR の run には出てこない。初回はマージ後の push が本番である）。
    // **だから分割前の 30 分を減らさずに両方に置いた。**
    // 分割で増えた仕事は artifact の upload / download / 展開で、**`apps/web/build/client/` は
    // 小さくない**（`data/members/*.json` と `data/data-archive.zip` を含む）。
    // **薄くして本番の初回を落とすほうが害が大きい**ので、n が溜まってから削る。
    "build-site.yml:build": 30,
    "deploy-site.yml:deploy": 30,
    // #1179: **この 2 本は #556 の数え上げには在ったが、この expected 表には無かった**
    // （鍵が 14 本で、どちらも入っていなかった）。**結果、`timeout-minutes: 30` 側も
    // 待ち合わせのループ上限側も誰も固定しておらず、`seq 1 900`（= 300 分）が素通りした**
    // （#1179 のレビューの実測: `pass 12 / fail 0`）。
    //
    // **実測 2026-10-04、基点 `53e121fe`**（job 全体の wall。`gh api .../runs/<id>/jobs` の
    // `completed_at - started_at`。success / failure のみ、cancelled は除く）:
    //
    //   job                                     n   min   med   p90   max   → 設定
    //   districts.yml:districts                 5   227   674  1011  1011s  → 40 分（max の 2.4 倍）
    //   local-assemblies.yml:local-assemblies   7   168   282   401   401s  → 40 分（max の 6.0 倍）
    //
    // **この max は「仕事の重さ」ではない**——**job の wall には
    // 「データ PR のマージを待っている時間」が含まれる**ので、CI の速さと他 PR の混み具合で動く
    // （`districts` の 1,011s のうち **895s が待ち合わせ**で、仕事は 111s だった）。
    // **だから「仕事が重いから 40 分」ではなく「待ち合わせ 30 分が収まるように 40 分」である**
    // （下の #1179 の検査がその関係を固定している）。
    //
    // **「直近 5 本のうち 1 本が 65 分」という指摘を追いかけた**（PO。**run の wall を見ると本当である**）。
    // **ただし `timeout-minutes` が見る時間は 274s だった。** **run `32674062613` の内訳**
    // （実測 2026-10-04。`pr-closes` の 77s を区間に分けたのと同じ形）:
    //
    //   run created        2026-08-23T23:35:34Z
    //   **job created**    2026-08-24T00:35:55Z   ← **ここまで 60 分。job がまだ存在しない**
    //   job started        2026-08-24T00:35:57Z   （割り当て待ち 2s）
    //   最初の step        2026-08-24T00:35:57Z   （ランナー立ち上がり 0s）
    //   job completed      2026-08-24T00:40:31Z   → **started → completed = 274s**
    //
    // **60 分は job が作られる前の待ちで、`timeout-minutes` は数えない。**
    // **これは `pr-closes` の 69 秒とは別の区間である**——
    // **あちらは `started → 最初の step` で、`timeout-minutes` が数える側だった**
    // （上の docblock の注意書き。**「割り当て待ちだから関係ない」と読み替えてはいけない**のは
    //  `started` 以降の話で、ここは `job created` より前なので当てはまらない）。
    //
    // **それでも n はまだ薄い**（月次なので溜まるのが遅い。`districts` n=5 / `local-assemblies` n=7）。
    // **溜まったら測り直すこと**（`security.yml:issue-secrets` と同じ扱い）。
    "districts.yml:districts": 40,
    "local-assemblies.yml:local-assemblies": 40,
    // #646: 実測 171s（2026-09-08、本番の data/ 83 件を手元から通しで。1 ラウンド 83 秒 +
    // 再試行の待ち 60 秒 + 落ちた 3 件）。最悪（83 × 30s タイムアウト × 2 ラウンド ≒ 83 分）は切りたいので 20 分。
    "link-check.yml:link-check": 20,
    "release.yml:released-tag": 10,
    // #1110: 手元で本物の API に当てて実測（n=3、2026-09-30）: **wall 17 / 18 / 19s**
    // （開いている PR 4 本・check-run 32 件・ボードの項目 454 件を読んだ実行）。
    // **max の約 32 倍の 10 分**。**ボードの項目数に比例して伸びる**（いまは 454 件で 12s 弱）
    // ので、項目が 10 倍になっても 10 分には届かない見込み。
    // **この job は `issues: write` を持ち Issue を開閉するので、無限ループで回り続けるのが
    // いちばん困る**——短めに切ってある。
    "scrum-monitor.yml:monitor": 10,
    "security.yml:gitleaks": 20,
    "security.yml:forbidden-patterns": 10,
    // #940: CI 実測は 0 本。手元で 1,359 件を 6 秒（gh api 1 回 + python）。件数は Issue が
    // 増えれば伸びるが、gh api のページングが支配的なので 10 分で足りる見込み。n が溜まったら
    // 上の表ごと測り直すこと——「まだ測っていない」ことを値ではなくコメントで残しておく。
    "security.yml:issue-secrets": 10,
    "security.yml:audit": 10,
    // #786: この job は「2 本のシェルテスト（ネットワーク無し）＋ gh api 2 回」だけ。
    // 手元の実測でテストは 2 本合わせて 2 秒未満、gh api は CI 上で 1 秒未満（run 34753557512）。
    // branch-protection.yml:guard / environment-protection.yml:guard と同じ 5 分に揃える。
    "security-alerts.yml:guard": 5,
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

/**
 * **データ PR の待ち合わせが、その job の `timeout-minutes` に収まっていること**（#1179 のレビュー）。
 *
 * ## 何が起きていたか
 *
 * **#1175 で待ち合わせを 15 分 → 30 分にしたとき、`districts.yml` と `local-assemblies.yml` は
 * `timeout-minutes: 30` だった。** **待ち合わせだけで job の予算を使い切る形になり、**
 * **ループが最後まで回れない**——**GitHub が先に job を殺すので:**
 *
 * - **`exit 1` の行に到達しない**
 * - **そこで書いている `GITHUB_STEP_SUMMARY` の診断が残らない**（＝**止まった理由が消える**）
 *
 * **診断が消えるのは #1175 の主題そのものである**（人が原因を追えなくなる）。
 *
 * ## なぜ「値を 2 つ固定する」だけでは足りないか（#1056 と同じ型）
 *
 * **ループ上限（`seq 1 N`）と `timeout-minutes` は別のファイルの別の行に在る。**
 * **両方を定数として固定しても、「片方だけ動かす」変更は両方の assert を通る**
 * （どちらの定数も新しい値に書き換えれば緑になるので、**矛盾そのものは誰も見ていない**）。
 *
 * **だからここは値ではなく関係を固定する**:
 *
 * ```
 * ループ上限 × sleep 秒 ＋ 固定費 ≤ timeout-minutes × 60
 * ```
 *
 * **3 つの数（上限・sleep・timeout）はすべてワークフローから読む**ので、
 * **このテストは数を 1 つも持たない**（持つのは固定費だけ。下記）。
 *
 * ## 固定費（**この検査が唯一ハードコードする数**）
 *
 * **待ち合わせステップより前の全 step の合計**（checkout ＋ buildx ＋ docker build ＋
 * ETL 本体 ＋ PR 更新）。**実測 2026-10-04、基点 `53e121fe`**
 * （`gh api repos/.../actions/runs/<id>/jobs` の `steps[]` の `started_at`／`completed_at` を、
 *  `Wait for data PR merge` より前だけ合計した）:
 *
 * | job | n | min | med | p90 | max |
 * |---|---:|---:|---:|---:|---:|
 * | `districts.yml:districts` | **5** | 97 | 114 | 138 | **138s** |
 * | `local-assemblies.yml:local-assemblies` | **7** | 89 | 130 | 185 | **185s** |
 * | 両方あわせて | **12** | 89 | 115 | 175 | **185s** |
 *
 * **`etl.yml:etl` の固定費はここでは測っていない**——**ETL 本体がデータ量で伸びるので、
 * 固定費という概念が当てはまらない**（だから `etl.yml` は `timeout-minutes: 360` と
 * ステップ側の `timeout-minutes: 330` で別に守られている）。
 * **それでも関係の検査には含める**: 360 分 × 60 = 21,600s に対して
 * 待ち合わせは 1,800s なので、**どの固定費を当てても通る**。
 *
 * **固定費には余裕を乗せる**（機械の負荷で 2 倍以上動く。上の「表を更新するときの規約」）。
 * **max 185s の 2 倍を切り上げて 400s を使う。**
 *
 * ## **この検査の限界**（#1056 の「腐らない形ではない」と同じ。**正確に書く**）
 *
 * **固定費の 400s は実測から取った定数で、assert していない。**
 * **＝ETL 本体が遅くなって固定費が 400s を超えても、この検査は落ちない。**
 * **固定費が伸びたかどうかは、上の表を測り直すしかない**（n つきで。日付と基点を併記して）。
 * **効くのは「ループ上限と timeout の一方だけが動く」形を塞いだことだけである。**
 */
test("#1179 データ PR の待ち合わせ（seq 1 N × sleep 秒）＋ 固定費が、その job の timeout-minutes に収まっている", () => {
  /** 固定費の上限（秒）。上の表の max 185s の 2 倍強。**実測から取った定数で、assert していない** */
  const FIXED_COST_BUDGET_SEC = 400;
  const files = readdirSync(wfDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")).sort();
  /** `{ "<file>:<job>": { loops, sleepSec, timeout } }`。**数はワークフローから読む**（定数を置かない） */
  const found: Record<string, { loops: number; sleepSec: number; timeout: number | undefined }> = {};
  for (const f of files) {
    // **コメントを落とさない生のテキストを読む**（`run:` の中で `#` を落とすと行が壊れる。
    // メモリの「YAML の # 落としは安全ではない」。ここは逐語の正規表現しか当てない）
    const text = textOf(f);
    const loop = text.match(/^\s*for i in \$\(seq 1 (\d+)\); do/m);
    if (!loop) continue;
    const slp = text.match(/^\s*sleep (\d+)\s*$/m);
    assert.ok(slp, `${f}: 待ち合わせのループが在るのに sleep の行が読めない（この検査が空回りする）`);
    const jobs = jobsOf(f).filter((j) => j.kind === "runs-on");
    assert.equal(jobs.length, 1, `${f}: 待ち合わせを持つワークフローの job が 1 本でない（${jobs.length} 本）。どの job の予算か決められない`);
    found[id(jobs[0])] = { loops: Number(loop[1]), sleepSec: Number(slp[1]), timeout: jobs[0].timeout };
  }
  // **母数を先に固定する**（#757 / #500: 入口を固定しないと、本体が痩せても誰も気づかない）。
  // **待ち合わせを持つワークフローを足したら、ここが落ちて「予算が足りるか」を考えることになる**
  assert.deepEqual(Object.keys(found).sort(), [
    "districts.yml:districts",
    "etl.yml:etl",
    "local-assemblies.yml:local-assemblies",
  ], "データ PR の待ち合わせ（seq 1 N）を持つ job の集合が変わった。足したなら予算が足りるかを確かめること（#1179）");
  const over: Record<string, { 待ち合わせ秒: number; 固定費: number; 必要: number; 予算: number }> = {};
  for (const [key, v] of Object.entries(found)) {
    assert.ok(v.timeout !== undefined, `${key}: timeout-minutes が無い（#556 の検査が先に落ちるはずだが、念のため）`);
    const waitSec = v.loops * v.sleepSec;
    const need = waitSec + FIXED_COST_BUDGET_SEC;
    const budget = v.timeout * 60;
    if (need > budget) over[key] = { 待ち合わせ秒: waitSec, 固定費: FIXED_COST_BUDGET_SEC, 必要: need, 予算: budget };
  }
  assert.deepEqual(over, {}, "待ち合わせ（seq 1 N × sleep 秒）＋ 固定費が timeout-minutes を超えている。"
    + "**job が先に殺されるので `exit 1` に到達せず、GITHUB_STEP_SUMMARY の診断が残らない**（止まった理由が消える。#1179）。"
    + "ループを縮めるか timeout-minutes を伸ばすこと");
});
