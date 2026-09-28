import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
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
function listAllJobs(): Job[] {
  return readdirSync(wfDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .flatMap(jobsOf);
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
 * このリポジトリに実際の .yaml ファイルが無いため検出できない（実際に変異させて確かめた:
 * `.filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))` を
 * `.filter((f) => f.endsWith(".yml"))` に戻す変異は、fixture テストだけでは 10/10 緑のまま
 * 通ってしまう＝等価変異になる）。
 * そこで、実際に .github/workflows に .yaml ファイルを一時的に置き、
 * allJobs の実行結果（readdirSync を経由した本物のパス）で見えることを確認する。
 * 確実に後始末するため try/finally で削除する。
 *
 * ## **この置き方は、ほかのテストファイルと競走する**（#1056 で踏んだ。**直していない**）
 *
 * **`node --test` はテストファイルを並行に流す。** **ここは本物の `.github/workflows/` に
 * ファイルを置いて消すので、同じディレクトリを `readdirSync` するほかのファイルが、
 * 「見えたのに開けない」瞬間に当たる**（`ENOENT` で落ちる）。
 *
 * **実測（2026-09-27。`workflow-timeout.test.ts` と `workflow-pr-body-edited.test.ts` を
 * 2 ファイル並べて 6 回ずつ）**:
 *
 * | 版 | 落ちた回数 |
 * |---|---:|
 * | この PR（#1056） | **2 / 6** |
 * | **`origin/main`（0f734507。この PR の変更を戻したもの）** | **1 / 6** |
 *
 * **＝#1056 が作った問題ではない。** **`pnpm test` の全走でも 1 回踏んだ**（435 秒の回）。
 * **直すには「本物のディレクトリに置かない」形（一時ディレクトリを渡す）が要るが、
 * それは #574 が「readdirSync を経由した本物のパスで見る」ために選んだ形を変えることになる。**
 * **この PBI の対象ではないので、測った数だけ残す。別の PBI が要る。**
 */
test("#574 .yaml 拡張子のワークフローも allJobs（readdirSync 経由）から見える", () => {
  const probeName = "probe-574-yaml-visibility.yaml";
  const probePath = resolve(wfDir, probeName);
  const probeYaml = ["jobs:", "  probejob:", "    runs-on: ubuntu-latest", "    timeout-minutes: 5", "    steps:", "      - run: echo hi", ""].join(
    "\n",
  );
  writeFileSync(probePath, probeYaml, "utf8");
  try {
    // モジュール読み込み時に評価済みの allJobs ではなく、実装本体の listAllJobs() を
    // ここで再実行する（実装が使う関数そのものを呼ぶことで、フィルタ行の変異を確実に拾う）。
    const jobs = listAllJobs();
    assert.ok(
      jobs.some((j) => j.file === probeName && j.name === "probejob"),
      ".yaml ワークフローの job が数え上げに現れない",
    );
  } finally {
    rmSync(probePath, { force: true });
  }
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
    "environment-protection.yml:guard",
    "etl.yml:etl",
    "link-check.yml:link-check",
    "local-assemblies.yml:local-assemblies",
    "monitor.yml:production",
    "monitor.yml:staging",
    "pr-body.yml:pr-closes",
    "release.yml:production",
    "release.yml:released-tag",
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
 *   deploy-site.yml:deploy          —     —     —     —     —    → 30 分（**呼び出し元の `production / deploy` と `staging / deploy` で測る:
 *                                                                    production n=38 max 112s /
 *                                                                    staging n=37 max 101s。**2026-09-27）
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
    "deploy-site.yml:deploy": 30,
    // #646: 実測 171s（2026-09-08、本番の data/ 83 件を手元から通しで。1 ラウンド 83 秒 +
    // 再試行の待ち 60 秒 + 落ちた 3 件）。最悪（83 × 30s タイムアウト × 2 ラウンド ≒ 83 分）は切りたいので 20 分。
    "link-check.yml:link-check": 20,
    "release.yml:released-tag": 10,
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
