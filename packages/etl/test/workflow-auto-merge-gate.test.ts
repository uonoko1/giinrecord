import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Issue #1227: **`gh pr merge --auto` を無条件に打たない。**
 *
 * ## 何が問題だったか
 *
 * `etl.yml` は data PR を作ったあと **毎晩無条件に** `gh pr merge "$NUMBER" --squash --auto` を打っていた。
 * **auto-merge は armed になった瞬間から「必須チェックが緑になったら自分でマージする」**ので、
 * **止めているものは必須チェックの赤だけ**である。
 *
 * ```
 * 2026-10-05  PR #1208  referredCommittees 1,656（-4）  auto-merge 01:43:52Z → PO が手で解除
 * 2026-10-07  PR #1222  referredCommittees 1,656（-4）  auto-merge 02:21:03Z → PO が手で解除
 * ```
 *
 * **2 回とも止めたのは人の作業である。** **1 日忘れた日に、次の 2 つが重なる:**
 *
 *   1. 誰かが赤い検査を緑にする（**いちばん自然な手は #1190 の期待値の表を実測に合わせること**）
 *   2. その瞬間に armed な PR が自分でマージされる
 *
 * **個票に復元元が無い**（実測 5/5 で `referredCommittees` は `bills/{session}/{id}.json` に無い）。
 * **マージしたら戻らない。** これは [[expected-table-is-not-a-knob]] の型である——
 * **期待値の表は、減った方向に合わせられると喪失を通す。**
 * **だから表を守るのではなく、armed にするほうを塞ぐ。**
 *
 * ## このテストが見るもの（スクリプトの振る舞いではない）
 *
 * **門の振る舞いは `scripts/ci/test/etl-auto-merge-gate.test.sh` が本物の git リポジトリで測る**
 * （11 ケース。止める側と止めない側の両方）。
 * **ここが見るのはワークフロー側の配線である**——
 * **門がどれだけ正しくても、ワークフローが `--auto` を門の外で打てば何も起きない。**
 * `workflow-data-pr-push.test.ts`（#943）が `git push` について同じことをしている。
 */
const here = dirname(fileURLToPath(import.meta.url));
const wfDir = resolve(here, "../../../.github/workflows");
const repoRoot = resolve(here, "../../..");

const GATE = "scripts/ci/etl-auto-merge-gate.sh";

/** 行末コメントを落とす（このディレクトリの YAML にクォート内の # は出てこない） */
function stripComment(line: string): string {
  const i = line.indexOf("#");
  return (i < 0 ? line : line.slice(0, i)).trimEnd();
}

type Workflow = { file: string; text: string; code: string };

const workflows: Workflow[] = readdirSync(wfDir)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .sort()
  .map((f) => {
    const text = readFileSync(resolve(wfDir, f), "utf8");
    return { file: f, text, code: text.split("\n").map(stripComment).join("\n") };
  });

/**
 * **`--auto` を打つワークフローを中身から拾う。** 本数をここに書き写さない
 * （書き写すと、4 本目が足されたときにこのテストは何も言わない。#943 と同じ考え方）。
 */
const autoMergeWorkflows = workflows.filter((w) => /gh pr merge[^\n]*--auto/.test(w.code));

test("#1227 母数: --auto を打つワークフローを中身から拾えている", () => {
  assert.ok(
    workflows.length >= 10,
    `.github/workflows を読めていない（見つかった本数: ${workflows.length}）`,
  );
  const names = autoMergeWorkflows.map((w) => w.file);
  // #757: 「0 本だった」と「数えていない」を出力で区別できるようにする。
  assert.ok(
    names.length > 0,
    `gh pr merge --auto を打つワークフローが 1 本も無い（全 ${workflows.length} 本を見た）。` +
      `綴りが変わったなら拾い方を直すこと（黙って 0 本になると、以下の検査が全部空振りして緑になる）`,
  );
  assert.ok(
    names.includes("etl.yml"),
    `etl.yml が --auto を打つワークフローとして拾えていない（拾えたのは: ${names.join(", ")}）`,
  );
  // **実測 2026-10-07: etl.yml / districts.yml / local-assemblies.yml の 3 本**
  // （`grep -rn "gh pr merge.*--auto" .github/workflows/` が 3 件、母数 17 本）。
  // **増えるのは構わない**（下の検査が新しい 1 本にもそのまま掛かる）が、**減ったら鳴らす**——
  // 減るのは「打つのをやめた」か「拾い方が壊れた」のどちらかで、後者だと検査が黙る。
  assert.ok(
    names.length >= 3,
    `--auto を打つワークフローが 3 本を下回った（${names.length} 本: ${names.join(", ")}）`,
  );
});

test("#1227 --auto は門の判定に条件づけられている（無条件に打っていない）", () => {
  assert.ok(autoMergeWorkflows.length > 0, "母数が 0（拾い方が壊れている）");
  for (const w of autoMergeWorkflows) {
    assert.ok(
      w.code.includes(GATE),
      `${w.file}: ${GATE} を通っていない。` +
        `--auto を無条件に打つと、必須チェックが緑になった瞬間に喪失を運ぶ PR が自分でマージされる（#1227）`,
    );
    const lines = w.code.split("\n");
    const gateLine = lines.findIndex((l) => l.includes(GATE));
    const autoLine = lines.findIndex((l) => /gh pr merge[^\n]*--auto/.test(l));
    assert.ok(gateLine >= 0 && autoLine >= 0, `${w.file}: 門と --auto の行を特定できない`);
    assert.ok(
      gateLine < autoLine,
      `${w.file}: 門（行 ${gateLine + 1}）が --auto（行 ${autoLine + 1}）より後にある。` +
        `armed にしてから測っても、もう止められない`,
    );
  }
});

test("#1227 --auto を打つ行は、門の結果を見る分岐の中にある", () => {
  // **「門を呼んでいる」だけでは足りない。** 呼んだ結果を捨てて `--auto` を打てば、
  // **検査は在るのに素通りする**（#943 の「権限で止まっていただけ」と同じ形）。
  // 門の終了コードを受けた変数を見る分岐の**中**に `--auto` が在ることを、インデントで測る。
  assert.ok(autoMergeWorkflows.length > 0, "母数が 0（拾い方が壊れている）");
  for (const w of autoMergeWorkflows) {
    const lines = w.code.split("\n");
    const autoIdx = lines.findIndex((l) => /gh pr merge[^\n]*--auto/.test(l));
    assert.ok(autoIdx >= 0, `${w.file}: --auto の行が無い`);
    const autoIndent = lines[autoIdx].length - lines[autoIdx].trimStart().length;
    // 直前の 12 行以内に、より浅いインデントの `if` が在り、その条件が門の結果を参照している。
    let found = "";
    for (let i = autoIdx - 1; i >= 0 && i >= autoIdx - 12; i--) {
      const t = lines[i];
      if (!t.trim()) continue;
      const indent = t.length - t.trimStart().length;
      if (indent < autoIndent && /^\s*(if|elif)\b/.test(t)) { found = t.trim(); break; }
    }
    assert.ok(
      found.length > 0,
      `${w.file}: --auto（行 ${autoIdx + 1}）がより浅い if の中に入っていない。` +
        `門を呼んでも結果を見ていなければ、無条件に打っているのと同じである`,
    );
    assert.match(
      found,
      /GATE_RC|gate/i,
      `${w.file}: --auto を囲む分岐が門の結果を見ていない: ${found}`,
    );
  }
});

test("#1227 門が exit 10 でも job は失敗しない（赤を毎晩並べない）", () => {
  // **「止める」を failure で表すと、毎晩 failure Issue が立つ。**
  // **それは「赤に慣れて本物の赤を見落とす」形そのものである**
  // （#1132 が毎日の赤を消したのと同じ理由。[[noise-can-disable-a-real-guard]]）。
  // **だから門の非 0 を受け止める変数が在り、10 を成功として扱っていること**を形で固定する。
  assert.ok(autoMergeWorkflows.length > 0, "母数が 0（拾い方が壊れている）");
  const called = new RegExp(`bash ${GATE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*\\|\\|`);
  for (const w of autoMergeWorkflows) {
    assert.match(
      w.code,
      called,
      `${w.file}: 門の呼び出しが \`|| GATE_RC=$?\` で受けていない。` +
        `set -e のもとでは exit 10 がそのまま step の失敗になり、毎晩 failure Issue が立つ`,
    );
    assert.match(w.code, /"10"|= 10\b/, `${w.file}: 10 を「止めた」として扱う分岐が無い`);
  }
});

test("#1227 止めたことが Job summary に出る（黙って armed にしない）", () => {
  // **黙って armed にしないのは、黙って armed にするのと同じく悪い。**
  // **#1221 の誤帰属と同じ教訓**: 読めない状態は、誰かが別の原因を疑う。
  assert.ok(autoMergeWorkflows.length > 0, "母数が 0（拾い方が壊れている）");
  for (const w of autoMergeWorkflows) {
    const summaryStep = w.code.split(/^      - name: /m).find((s) => s.startsWith("Job summary"));
    assert.ok(summaryStep, `${w.file} に Job summary の step が無い`);
    assert.match(
      summaryStep,
      /GATE/,
      `${w.file}: Job summary が門の結果（GATE）を読んでいない。止めたことが人の読む表に出ない（#1056）`,
    );
    assert.match(
      summaryStep,
      /auto-merge/,
      `${w.file}: Job summary に auto-merge の行が無い。armed にしたかどうかが表から読めない`,
    );
  }
});

test("#1227 門が止めた日は「マージ待ち」を走らせない（30 分待って赤くしない）", () => {
  // 走らせると 30 分ポーリングして exit 1 し、**毎晩 failure Issue が立つ**。
  assert.ok(autoMergeWorkflows.length > 0, "母数が 0（拾い方が壊れている）");
  let checked = 0;
  for (const w of autoMergeWorkflows) {
    const waitStep = w.code
      .split(/^      - name: /m)
      .find((s) => s.startsWith("Wait for data PR merge"));
    assert.ok(waitStep, `${w.file} に「マージ待ち」の step が無い`);
    const ifLine = waitStep.split("\n").find((l) => /^\s*if:/.test(l));
    assert.ok(ifLine, `${w.file}: 「マージ待ち」の step に if: が無い`);
    assert.match(
      ifLine,
      /outputs\.gate\s*==\s*'0'/,
      `${w.file}: 「マージ待ち」の if: が門の結果を見ていない: ${ifLine.trim()}。` +
        `門が止めた日に走ると 30 分待って失敗し、毎晩 failure Issue が立つ`,
    );
    checked++;
  }
  // #757: 「0 本だった」と「数えていない」を区別する。
  assert.ok(checked >= 3, `見た step が ${checked} 件しかない（--auto を打つのは ${autoMergeWorkflows.length} 本）`);
});

test("#1227 門は checkout したツリーの中に在り、実行できる", () => {
  const p = resolve(repoRoot, GATE);
  assert.ok(existsSync(p), `${GATE} が無い（ワークフローが呼ぶのに在らなければ毎晩失敗する）`);
  const src = readFileSync(p, "utf8");
  // 止める理由を 2 つ持っていること。**片方では足りない**（理由はスクリプトの docblock）。
  assert.match(src, /HOLD_FILE/, `${GATE}: 停止ファイル（人の判断を持ち越す器）を持っていない`);
  assert.match(src, /name-status/, `${GATE}: 消えたファイルを実測する部分が無い`);
  // 三点の diff は merge base と比べるので土台の古さを見逃す（#943 が実測した）。
  for (const l of src.split("\n").map(stripComment).filter((l) => l.includes("git diff"))) {
    assert.ok(!/\.\.\./.test(l), `${GATE}: 三点の diff は土台の古さを見逃す: ${l.trim()}`);
  }
});

test("#1227 門を迂回する素の gh pr merge --auto が残っていない", () => {
  // denylist ではなく**全件**見る: `--auto` を打つ行を全部拾い、どれも門の後に在ること。
  const offenders: string[] = [];
  for (const w of workflows) {
    for (const [i, line] of w.code.split("\n").entries()) {
      if (!/gh pr merge[^\n]*--auto/.test(line)) continue;
      if (!w.code.includes(GATE)) offenders.push(`${w.file}:${i + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `門を通さずに --auto を打つ行が ${offenders.length} 件ある（全 ${workflows.length} 本を見た）:\n` +
      offenders.join("\n"),
  );
});
