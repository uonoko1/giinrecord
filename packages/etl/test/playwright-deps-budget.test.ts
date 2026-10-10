import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Issue #1254: `playwright install-deps` が apt のミラー障害で無言のまま
 * `timeout-minutes` を使い切り、job が **cancelled** になる。
 *
 * ## なぜこの検査が ci.yml の外に居るか
 *
 * **同じ step が ci.yml の中に 2 か所ある**（`check` と `docker-web`）。
 * **#1254 の 3 件は 2 か所の両方から出た**（#1248 docker-web / #1238 check / #1250 check）。
 * メモリの `fix-one-side-check-the-mirror`: **対称性は実装の性質で、検査の性質ではない。**
 * **片方だけ直すと、直した側の run だけ緑になって、もう片方は無言のまま cancelled を続ける。**
 * **だから「両方が同じスクリプトを呼ぶ」ことを、ci.yml を読んで数える。**
 *
 * ## なぜ「数」をここに置かないか
 *
 * **予算の秒数は `scripts/ci/playwright-deps.sh` が持ち、ここはそれを読む**
 * （#556 / #1056: 同じ数が 2 か所に在ると片方が腐る。実測で `ci.yml` の 225s と
 *  `workflow-timeout.test.ts` の 658s が 2.8 倍食い違った）。
 * **ここが固定するのは「値」ではなく「関係」である**:
 *   1 回の予算 × 試行回数 < いちばん短い job の `timeout-minutes`   …… **上限**
 *   1 回の予算 >= 実測で success した最遅の step（554s）            …… **下限**（#1257）
 * **この関係なら、予算を動かしても `timeout-minutes` を動かしても、崩れた側で落ちる。**
 *
 * **#1257 のレビューまで、この表は上限しか持っていなかった。**
 * **＝予算が小さくなる方向の変異（600 → 1）を全部通していた**（レビュアーの実測で
 * etl 64/64・bash 9/9 がどちらも緑）。**下限は下のテストが持つ。**
 * **554 だけが「数」としてこのファイルに在る**——**それは観測値であって設定値ではない**
 * （設定値 600 はスクリプトが 1 か所で持ち、ここは `ask()` で読む）。
 *
 * ## 実測（2026-10-07。`gh api .../runs/<id>/jobs` の step の `completed_at - started_at`）
 *
 * **母数は ci.yml の直近 100 run のうち completed な run で、"Install Chromium for Playwright"
 * の step を持つもの＝ 160 step**（`check` 94 / `docker-web` 66。skipped を含む）。
 *
 * | 日 | n | min | med | max | **60s 以上** |
 * |---|---:|---:|---:|---:|---:|
 * | 2026-10-04 | 50 | 0 | 14 | 35 | **0** |
 * | 2026-10-05 | 19 | 0 | 13 | 16 | **0** |
 * | 2026-10-06 | 1 | 18 | 18 | 18 | **0** |
 * | **2026-10-07** | **90** | 0 | 14 | **1152** | **15** |
 *
 * **4 日のうち 1 日に集中している**（15/90 = 17%、他の 3 日は 0/70）。
 * **だから「毎回起きる」ではなく「起きる日は 1 日の 17% を食う」である。**
 * **ミラー障害の頻度そのもの（何日に 1 回起きるか）は数えていない**——4 日しか見ていない。
 *
 * **「届かない」は 1 つの症状ではなかった**（同じ run 37663904608 の 2 つの job、18 分差）:
 *
 * | job | step の wall | `apt-get update` | `apt-get install` | 結末 |
 * |---|---:|---|---|---|
 * | `check` (18:10:49Z) | **554s** | 12.6 MB を **1 秒**（8537 kB/s） | 32.5 MB を **9 分 2 秒**（**59.9 kB/s**） | **success** |
 * | `docker-web` (18:28:11Z) | **1132s** | `Ign:` を繰り返して**無言で張り付く** | 到達せず | **cancelled** |
 *
 * **Issue #1254 の本文は「`apt-get update` が届かず再試行で粘る」と書いているが、
 * `check` 側では `update` は 1 秒で通っていて、遅かったのは `install` のダウンロードだった**
 * （59.9 kB/s。**帯域の崩壊**で、到達不能ではない）。
 * **メモリの `explaining-a-finding-is-a-second-claim`: 結論（20 分を食い切る）は正しく、
 * 理由（update が届かない）は半分だけ正しかった。**
 * **だから時間で切る**——「届いたか」を見分ける検査は、59.9 kB/s の側を取りこぼす。
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const ciYml = resolve(repoRoot, ".github/workflows/ci.yml");
const script = resolve(repoRoot, "scripts/ci/playwright-deps.sh");

/** スクリプトから数を読む（ここには書かない。#1056） */
function ask(flag: string): number {
  const out = execFileSync("bash", [script, flag], { encoding: "utf8" }).trim();
  assert.match(out, /^[0-9]+$/, `${flag} は数だけを出すはず（got ${JSON.stringify(out)}）`);
  return Number(out);
}

/**
 * ci.yml の中で "Install Chromium for Playwright" という名の step を全部拾い、
 * その `run:` の本体を返す。
 *
 * **正規表現で YAML を読むことの言い訳はしない**（作業合意が戒めている）。
 * 代わりに**取りこぼしたら落ちる**ようにしてある: 下の最初のテストが
 * **件数を 2 で固定する**ので、step が増えても減っても、名前が変わっても落ちる。
 */
function playwrightInstallSteps(): { lineNo: number; run: string; job: string; timeout: number }[] {
  const lines = readFileSync(ciYml, "utf8").split("\n");
  const found: { lineNo: number; run: string; job: string; timeout: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*- name: Install Chromium for Playwright\s*$/.test(lines[i])) continue;
    // この step の中で最初に出てくる `run:` から、次の `- name:` / `- uses:` までを本体とする。
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*- (name|uses):/.test(lines[j])) break;
      body.push(lines[j]);
    }
    // **この step を持つ job の名前と timeout-minutes を、上に向かって探す。**
    // **ci.yml 全体の最小値を取ってはいけない**——`stale-base` の 10 分はこの step を
    // 走らせないので、関係の無い数で落ちる（このテストの最初の版が実際にそうなった。
    // メモリの `check-the-polarity-not-just-the-movement`: 動いた数が目的の数とは限らない）。
    let job = "";
    let timeout = Number.NaN;
    for (let j = i; j >= 0; j--) {
      if (Number.isNaN(timeout)) {
        const t = /^ {4}timeout-minutes:\s*([0-9]+)\s*$/.exec(lines[j]);
        if (t) timeout = Number(t[1]);
      }
      const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[j]);
      if (m) {
        job = m[1];
        break;
      }
    }
    found.push({ lineNo: i + 1, run: body.join("\n"), job, timeout });
  }
  return found;
}

test("#1254 ci.yml の Install Chromium step は 2 つで、**両方**が scripts/ci/playwright-deps.sh を呼ぶ", () => {
  const steps = playwrightInstallSteps();
  assert.equal(
    steps.length,
    2,
    `"Install Chromium for Playwright" は check と docker-web の 2 か所にある想定。` +
      `見つかったのは ${steps.length} 件（行: ${steps.map((s) => s.lineNo).join(", ")}）。` +
      `増えたなら、その step もスクリプト経由にしてこの数を上げること。`,
  );
  // **片方だけ直した形で落ちる**のがこのテストの目的である（#1254 受け入れ条件 3）。
  const viaScript = steps.filter((s) => s.run.includes("scripts/ci/playwright-deps.sh"));
  assert.equal(
    viaScript.length,
    2,
    `両方がスクリプト経由であるはず。スクリプトを呼んでいない step の行: ` +
      steps
        .filter((s) => !s.run.includes("scripts/ci/playwright-deps.sh"))
        .map((s) => s.lineNo)
        .join(", "),
  );
});

test("#1254 どちらの step も apt を直に叩かない（素の playwright install が残っていない）", () => {
  for (const s of playwrightInstallSteps()) {
    // **これが「片方だけ元に戻された」形を捕まえる。**
    // スクリプトを呼ぶ行が増えただけで、元の `pnpm ... install-deps` が残っていたら、
    // そちらが先に走って同じ 20 分を食う。
    assert.ok(
      !/pnpm\s+--filter\s+web\s+exec\s+playwright\s+install/.test(s.run),
      `ci.yml:${s.lineNo} が playwright install を直に呼んでいる。` +
        `時間切れを捕まえられないので scripts/ci/playwright-deps.sh 経由にすること（#1254）`,
    );
  }
});

test("#1254 最悪（1 回の予算 × 試行回数）は、いちばん短い job の timeout-minutes の内側で終わる", () => {
  const per = ask("--budget-sec");
  const attempts = ask("--attempts");
  const worst = per * attempts;

  // **この step を実際に走らせる job の timeout-minutes だけを見る**（いまは check 30 / docker-web 20）。
  // **その 20 / 30 という数はここに書かない**——ci.yml から読む（#1056: 数は 1 か所）。
  const steps = playwrightInstallSteps();
  for (const s of steps) {
    assert.ok(
      Number.isFinite(s.timeout),
      `ci.yml:${s.lineNo}（job ${s.job || "?"}）の timeout-minutes を読めなかった。` +
        `読めないまま通すと、下の「内側で終わる」の検査が空振りする（#1254）`,
    );
    assert.ok(s.job !== "", `ci.yml:${s.lineNo} の job 名を読めなかった`);
  }
  const shortest = Math.min(...steps.map((s) => s.timeout));

  assert.ok(
    worst < shortest * 60,
    `最悪 ${worst}s（1 回 ${per}s × ${attempts} 回）が、この step を持つ job のいちばん短い timeout-minutes ` +
      `(${shortest} 分 = ${shortest * 60}s; jobs: ${steps.map((s) => `${s.job}=${s.timeout}`).join(", ")}) に収まっていない。` +
      `収まらないと job 側の cancelled が先に来て、「ミラーに届かなかった」を言えないまま無言で終わる（#1254）`,
  );
  // **#1257 のレビュー指摘 1**: 試行は **1 回**である。
  // `timeout` は直接の子にしかシグナルを送らないので `apt-get`（孫）が生き残り、
  // **dpkg のロックを握ったまま 2 回目が rc=100 で落ちる**。すると時間切れではないので
  // スクリプトは「ミラー障害ではない」と言って `exit 1` する——**#1254 の目的の逆である。**
  // **2 回試す道には孫までプロセスグループごと KILL する実装が要る**（#1254 の射程外）。
  // **この上限（1 回まで）が無いと、再試行が呼び分けを自分で壊す形に戻れる。**
  assert.equal(
    attempts,
    1,
    `試行は 1 回でなければならない（いまは ${attempts}）。` +
      `timeout は孫（apt-get）を殺さないので、2 回目は dpkg のロックで rc=100 になり、` +
      `本物のミラー障害が「ミラー障害ではない」と報告されて exit 1 する（#1257 のレビュー指摘 1）`,
  );
});

/**
 * **#1257 のレビュー指摘 2: 下限の守りが無かった。**
 *
 * **レビュアーの変異が完全に緑だった**: `BUDGET_SEC` 600 → 1 ／ 旧 TOTAL 900 → 2 で
 * **etl 64/64 pass、bash 9/9 pass**。**いまの検査は「上限（job の timeout の内側）」しか
 * 見ていないので、予算が小さくなる方向には歯止めが無かった。**
 * **`check-the-polarity-not-just-the-movement`: 片側しか見ていない検査は、
 * もう片側の壊れ方を全部通す。**
 *
 * **554 は観測値である**（2026-10-07、174 step を数えた）:
 *
 *   600s を超えた step: **2 件**（どちらも cancelled 済みの `docker-web`）
 *   **成功した中で最も遅い step: 554s**（run 37663904608 の `check`。
 *     `apt-get update` は 12.6 MB を 1 秒で取り、`install` が 32.5 MB を
 *     **59.9 kB/s** で 9 分 2 秒かけた末に **success** で終わった）
 *
 * **＝予算を 554s より下に置くと、実際に成功した run を落とすことになる。**
 * **偽陽性の赤（無言の cancelled）を、別の偽陽性の赤（届いていたのに時間切れ）に
 * 付け替えるだけである。** だから下限をここで固定する。
 */
test("#1257 1 回の予算は、実測で成功した中で最も遅い 554s を下回らない（下限の守り）", () => {
  /**
   * **成功した中で最も遅い step の秒数**（2026-10-07、ci.yml の 174 step を数えた実測値）。
   * **これは「理想」ではなく「実際に success で終わった最遅の観測値」である。**
   * **ここを下回る予算は、通る見込みが在るものを落とす。**
   */
  const SLOWEST_SUCCESS_SEC = 554;
  const per = ask("--budget-sec");
  assert.ok(
    per >= SLOWEST_SUCCESS_SEC,
    `1 回の予算が ${per}s になっている。**実測で success で終わった最も遅い step は ` +
      `${SLOWEST_SUCCESS_SEC}s**（2026-10-07、174 step。run 37663904608 の check が ` +
      `install を 59.9 kB/s で 9 分 2 秒かけて通した）。` +
      `これを下回ると、届いていたものを「ミラーに届かなかった」と言って落とす（#1257 のレビュー指摘 2）。` +
      `下げるなら、まず packages/etl/test/workflow-timeout.test.ts の表を測り直すこと。`,
  );
});

test("#1254 スクリプトは「ミラーに届かなかった」と言える（語が実物に在る）", () => {
  const src = readFileSync(script, "utf8");
  // **語そのものを固定する。** `waiting-loops-must-fail-closed`:
  // 諦めたことを言わない待機ループは、「測れなかった」を「測れた」に倒す。
  assert.match(src, /ミラーに届かなかった/, "諦めたときの文言が無い（#1254 受け入れ条件 2）");
  assert.match(src, /exit 7/, "時間切れ専用の終了コードが無い（1 と混ざると呼び分けられない）");
  // **「コードの赤ではない」と「ミラー障害ではない」の両方が要る**——
  // 前者は時間切れ、後者は時間切れでない失敗。**片方だけだと呼び分けにならない。**
  assert.match(src, /コードの赤ではない/, "時間切れを「コードの赤ではない」と言えていない");
  assert.match(src, /ミラー障害ではない/, "時間切れでない失敗を「ミラー障害ではない」と言えていない");
});
