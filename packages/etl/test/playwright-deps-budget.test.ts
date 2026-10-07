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
 *   合計予算 < いちばん短い job の `timeout-minutes`
 * **この関係なら、予算を動かしても `timeout-minutes` を動かしても、崩れた側で落ちる。**
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

test("#1254 合計予算は、いちばん短い job の timeout-minutes の内側で終わる", () => {
  const total = ask("--total-budget-sec");
  const per = ask("--budget-sec");
  const attempts = ask("--attempts");

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
    total < shortest * 60,
    `合計予算 ${total}s が、この step を持つ job のいちばん短い timeout-minutes ` +
      `(${shortest} 分 = ${shortest * 60}s; jobs: ${steps.map((s) => `${s.job}=${s.timeout}`).join(", ")}) に収まっていない。` +
      `収まらないと job 側の cancelled が先に来て、「ミラーに届かなかった」を言えないまま無言で終わる（#1254）`,
  );
  assert.ok(per <= total, `1 回の予算 ${per}s が合計 ${total}s を超えている`);
  assert.ok(attempts >= 2, `1 回で諦めると、18 分で表情を変えるミラー障害を取りこぼす（実測は docblock）`);
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
