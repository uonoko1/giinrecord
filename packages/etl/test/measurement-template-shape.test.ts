import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Issue #823: **測定 PBI の雛形が無く、PO が毎回手で Issue を書いていた。**
 *
 * PO の実測（2026-09-13。10 本の測定 Issue を走査した）:
 *
 * ```
 *                                    705 718 743 753 765 769 773 774 780 782  計
 * 記号列を 1 つ「回転」させる          o   o   o   o   o   o   o   o   o   o   10/10
 * 恒真な検算を先に潰す                 o   o   o   o   o   o   o   o   o   o   10/10
 * (記号, 議員) の対が半セル未満か      .   o   o   o   o   o   o   o   o   o    9/10
 * 母数を検算に入れる（#757）           .   o   o   o   o   o   o   o   o   o    9/10
 * y 方向（その行がどの議案か）         .   .   .   .   .   .   .   .   .   .    0/10
 * 判定できる母数を先に数える           .   .   .   .   .   .   .   .   .   .    0/10
 * 独立した 2 本が互いの代わりになるか  .   .   .   .   .   .   .   .   .   .    0/10
 * ```
 *
 * **下の 3 つは 0/10 である。9 回とも書かれず、9 回とも測られなかった。**
 * **その結果、8 県の測定すべてで y 方向（その行がどの議案か）が測られていない**（#819）。
 * **行がずれれば、賛成した議案と反対した議案が入れ替わる**——**利用者から検出できない虚偽**（#569）。
 *
 * ## なぜ「雛形を置く」だけでは足りないのか
 *
 * **`board.md` に 4 回書いた教訓が 5 回目に再発した**（#783）。
 * **`DATA_CONTRACT.md` のチェックリストに足した項目は、検査に無かったので消しても落ちなかった**（#762）。
 * **文書に書くことは、それ自体では対策になっていない。**
 *
 * ## #762 の失敗を繰り返さない作り
 *
 * **#762 は「項目が 6 個以上あること」を検査していた。**
 * **だから、足した項目を消して別の項目を足せば通った。** 数だけ数える検査は、
 * **何が書いてあるかを一切見ていない。**
 *
 * ここは **`REQUIRED_ITEMS` を逐語で照合する**。
 * **「13 個ある」ではなく「`y 方向（行）の対応を回転で測る` という文字列が在る」を見る。**
 * さらに下に、**「数だけ数える検査は素通りする」ことを実測する test** を置いてある
 * （否定的対照。#554）——**その test が緑であることが、逐語にした理由の裏づけになる。**
 *
 * ## A だけでなく B もやった理由
 *
 * **この検査（A）は、雛形の中身が消えないことしか保証しない。**
 * **PO は Issue を書くときに雛形を読まない**——9 回とも読まなかった（そもそも無かった）。
 * **だから `scripts/po/measure-pbi.sh`（B）で、本文を雛形から機械的に起こす経路を作った。**
 * **A は B の入力を守る見張りである。** 片方だけでは:
 *
 *   - **A だけ**: 雛形は守られるが、PO は相変わらず手で書く（**#823 の根本原因が残る**）
 *   - **B だけ**: 生成はされるが、雛形から項目が消えても誰も気づかない（**#762 の形**）
 *
 * ## なぜ etl の node:test なのか
 *
 * #513 / #662 / #682 と同じ。**検査対象と同じディレクトリに置いた見張りは、対象ごと消せる。**
 * `docs/research/` の中に検査を置くと、`docs/research/` を触る PR がそれごと消せてしまう。
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const TEMPLATE = "docs/research/MEASUREMENT-TEMPLATE.md";
const GENERATOR = "scripts/po/measure-pbi.sh";

const read = (p: string) => readFileSync(resolve(root, p), "utf8");

/**
 * **測定 PBI に必ず載る項目**（**逐語**で照合する）。
 *
 * **「N 個以上」では数えない**——#762 がそれで素通りした。
 * 表現を変えたいなら、ここと雛形の両方を同時に変えること（片方だけだと落ちる）。
 *
 * 出どころは #823 本文の 13 行の表（**PO が 10 本の Issue と 9 県の測定文書から実測したもの**）。
 */
const REQUIRED_ITEMS: readonly string[] = [
  "本数は index のリンクから機械的に数える",
  "入口を全部見たか",
  "リンクの採り方を複数試す",
  "x 方向（列）の対応を回転で測る",
  "y 方向（行）の対応を回転で測る",
  "判定できる母数を先に数える",
  "恒真な検算を潰し",
  "母数を検算に入れる",
  "片方を壊して他方が落ちるか測る",
  "変異の 4 分類",
  "`robots.txt` と利用条件を取り直す",
  "取得の大きさを記録する",
  "確かめていないことを書く",
];

/**
 * **「必ず守ること」の箇条書き**（**逐語**）。
 *
 * **項目の表だけを逐語で押さえて、ここを押さえないと片手落ちである**——実測した:
 * **`- **\`data/\` を書き換えない。ETL の実装もしない**` を別の語に差し替える変異を当てたところ
 * （md5 は変わった＝当たっている）、etl も po も 1 件も落ちなかった。**
 * **箇条書きは「行数が 0 でなければ生成器が通る」だけで、中身は誰も見ていなかった。**
 * **これは #762 そのもの**（数えるだけで中身を見ない）なので、ここも逐語にする。
 */
const REQUIRED_RULES: readonly string[] = [
  "専用の git worktree で作業する",
  "`data/` を書き換えない。ETL の実装もしない",
  "既存県のコードを変えない",
  "自分の県の節だけを触る",
  "他の担当者の worktree に触らない",
  "変異を当てる前に無改造で緑を確認する",
  "「落ちた」と数えない",
  "「全部一致した」は測れていない徴候として扱う",
  "推測で議員を紐づけない",
  "破壊的な git を打たない",
];

/** `md` に**逐語で**載っていない「必ず守ること」を返す。 */
export const missingRules = (md: string): string[] =>
  REQUIRED_RULES.filter((rule) => !md.includes(rule));

/**
 * **とりわけ 0/10 だった 3 つ**。#823 の起点そのものなので、名指しで固定する。
 * ここが消えたら、この PBI は何も残していないことになる。
 */
const NEVER_WRITTEN_BEFORE: readonly string[] = [
  "y 方向（行）の対応を回転で測る",
  "判定できる母数を先に数える",
  "片方を壊して他方が落ちるか測る",
];

/** `md` に**逐語で**載っていない必須項目を返す。空配列なら型を満たしている。 */
export const missingItems = (md: string): string[] =>
  REQUIRED_ITEMS.filter((item) => !md.includes(item));

test("#823 判定そのものを固定する（対象の文書に依らず、判定が緩んだら落ちる）", () => {
  const full = REQUIRED_ITEMS.join("\n");
  assert.deepEqual(
    {
      full: missingItems(full),
      empty: missingItems(""),
      // **1 つ消すと、その項目が名指しで返る。**——#819 の被害そのもの。
      noYAxis: missingItems(full.replace("y 方向（行）の対応を回転で測る", "")),
      noDenominator: missingItems(full.replace("判定できる母数を先に数える", "")),
      // **言い換えでは満たせない。** 逐語で押さえているので別の語は別物として落ちる。
      renamed: missingItems(
        full.replace("y 方向（行）の対応を回転で測る", "行の対応も見る"),
      ),
      // **項目を「同じ数だけ」別の語に差し替えても通らない**（#762 の形）。
      swapped: missingItems(
        full.replace("y 方向（行）の対応を回転で測る", "何か別の項目"),
      ),
    },
    {
      full: [],
      empty: [...REQUIRED_ITEMS],
      noYAxis: ["y 方向（行）の対応を回転で測る"],
      noDenominator: ["判定できる母数を先に数える"],
      renamed: ["y 方向（行）の対応を回転で測る"],
      swapped: ["y 方向（行）の対応を回転で測る"],
    },
    `missingItems の判定が変わっている。
**この test は対象ファイルを 1 つも読んでいない**ので、雛形が無くても落ちる。
判定を緩めて黙らせないこと——落ちているなら、緩めた側を戻す。`,
  );
});

test("#823 雛形が在り、必須の 13 項目を逐語で持つ", () => {
  assert.ok(
    existsSync(resolve(root, TEMPLATE)),
    `${TEMPLATE} が無い。**測定 PBI の本文はここから起こす**（${GENERATOR}）。
これが無いと、PO はまた手で書くことになる（#823 の再発）。`,
  );
  const missing = missingItems(read(TEMPLATE));
  assert.deepEqual(
    missing,
    [],
    `${TEMPLATE} から必須の項目が消えている:
${missing.map((m) => `  - [${m}]`).join("\n")}

**項目を消すと、次の測定 PBI からその項目が落ちる。**
**8 県すべてで y 方向が測られなかったのは、まさにこれが起きたからである**（#819）。`,
  );
});

test("#823 雛形の「必ず守ること」も逐語で持つ（行数だけでは中身の差し替えを見逃す）", () => {
  // **この test を書く前に実測した**: `data/` の行を別の語に差し替える変異は md5 が変わった
  // （＝当たった）のに、**etl も po も 1 件も落ちなかった。**
  // 生成器は「箇条書きが 0 行でないこと」しか見ていないので、**中身は何でもよかった。**
  // **#762 と同じ形が、項目の表の隣で口を開けていた。**
  const missing = missingRules(read(TEMPLATE));
  assert.deepEqual(
    missing,
    [],
    `${TEMPLATE} の「必ず守ること」から項目が消えている（または言い換えられている）:
${missing.map((m) => `  - [${m}]`).join("\n")}

**この箇条書きはそのまま Issue 本文になる。** 消えれば、次の担当者はそれを守らない。`,
  );
  // 生成器の出力にも載ること（**PO が受け取るのはこちら**）。
  const body = execFileSync("bash", [resolve(root, GENERATOR), "--pref", "熊本", "--prior", "3 本"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  assert.deepEqual(missingRules(body), [], `${GENERATOR} の本文に「必ず守ること」が載っていない。`);
});

test("#823 「0/10 だった 3 項目」が雛形に在り、9 回書かれなかったことが書いてある", () => {
  // **なぜ足したのかが書いていないと、次の人が「要らなそう」で消せる。**
  // 13 項目のうち 3 つは **9 回とも書かれなかった**もので、
  // **理由を添えないかぎり、消す側にとっては他の 10 項目と区別がつかない。**
  const md = read(TEMPLATE);
  const missing = NEVER_WRITTEN_BEFORE.filter((i) => !md.includes(i));
  assert.deepEqual(missing, [], `0/10 だった項目が雛形から消えている: ${missing.join(" / ")}`);
  const why = ["0 / 10", "#819", "#762", "#783"];
  const missingWhy = why.filter((w) => !md.includes(w));
  assert.deepEqual(
    missingWhy,
    [],
    `${TEMPLATE} から「なぜこの項目が要るのか」の根拠が消えている: ${missingWhy.join(" / ")}
**根拠の無い項目は、次の人から見れば消してよい項目である。**`,
  );
});

test("#823 雛形は「手でコピーするな」と言い、生成器と検査の在処を指している", () => {
  // 雛形だけ見た人が手でコピーすると、**また項目を落とせるようになる**（#823 の原因）。
  const md = read(TEMPLATE);
  const required = [
    GENERATOR, // 本文を起こす道具
    "packages/etl/test/measurement-template-shape.test.ts", // 検査の在処
    "REQUIRED_ITEMS", // 項目を足すときに何を直すか
    "手でコピーしないでください",
  ];
  const missing = required.filter((r) => !md.includes(r));
  assert.deepEqual(
    missing,
    [],
    `${TEMPLATE} から、雛形を雛形たらしめている記述が消えている:
${missing.map((m) => `  - [${m}]`).join("\n")}`,
  );
});

test("#823 生成器が雛形から本文を起こし、13 項目すべてが本文に載る（生成器と雛形がずれたら落ちる）", () => {
  // **雛形を守るだけでは足りない。** PO が実際に受け取るのは生成器の出力である。
  // ここで実物を走らせるので、**生成器が雛形を読まなくなったら（ハードコードに戻したら）
  // 雛形を編集しても出力が変わらなくなり、下の「雛形を壊すと出力も壊れる」test が落ちる。**
  const body = execFileSync("bash", [resolve(root, GENERATOR), "--pref", "熊本", "--prior", "3 本"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const missing = missingItems(body);
  assert.deepEqual(
    missing,
    [],
    `${GENERATOR} が出した本文に必須の項目が載っていない:
${missing.map((m) => `  - [${m}]`).join("\n")}

**PO が受け取るのはこの本文である。** 雛形に在っても本文に載らなければ、担当者は測らない。`,
  );
  // **母数を出していること**（#757）。0 件のまま静かに本文を出すのが最悪の壊れ方なので、
  // 何項目を写したかが本文に出る。
  assert.match(
    body,
    /\*\*13 項目すべてに答えること。\*\*/,
    `本文に「何項目を写したか」が出ていない。
**「項目 0 件の本文」と「13 項目の本文」が見分けられなくなる**（#757）。`,
  );
});

test("#823 生成器は雛形を読んでいる（雛形を壊すと出力も壊れる＝ハードコードしていないことの実測）", () => {
  // **これが無いと、上の test は「生成器が 13 項目をハードコードしているだけ」でも通る。**
  // **その場合、雛形に項目を足しても Issue には載らない**——#823 の再発である。
  // 項目を 1 つ抜いた雛形を一時ファイルに作り、生成器にそれを読ませる。
  // **本物の雛形は触らない**（`MEASURE_TEMPLATE` で差し替える）。
  const broken = read(TEMPLATE).replace("y 方向（行）の対応を回転で測る", "（消した）");
  assert.ok(
    !broken.includes("y 方向（行）の対応を回転で測る"),
    "壊した雛形に項目が残っている。置換が空振りしている（#514 の形）。",
  );
  const tmp = resolve(root, "packages/etl/test/.measurement-template-broken.md");
  writeFileSync(tmp, broken);
  try {
    const body = execFileSync("bash", [resolve(root, GENERATOR), "--pref", "熊本", "--prior", "3 本"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, MEASURE_TEMPLATE: tmp },
      stdio: ["ignore", "pipe", "ignore"],
    });
    assert.deepEqual(
      missingItems(body),
      ["y 方向（行）の対応を回転で測る"],
      `雛形から項目を消したのに、生成器の出力は変わっていない。
**生成器が雛形を読まずに項目を持っている**ということなので、
雛形に足しても Issue には載らない（#823 の再発）。`,
    );
  } finally {
    rmSync(tmp, { force: true });
  }
});

test("#823 生成器は項目 0 件の本文を静かに出さない（母数。#757）", () => {
  // **「y 方向が抜けたまま 9 回走った」と同じ形の壊れ方**——静かに不完全な本文を出すこと——を塞ぐ。
  // 実際、この機能を書いた日に **awk のコメント除去の誤りで「必ず守ること」が 0 行になり、
  // この exit 4 が捕まえた**（PR 本文に記録）。
  const tmp = resolve(root, "packages/etl/test/.measurement-template-empty.md");
  writeFileSync(tmp, "# 空\n\n## 測る項目（必須）\n\n## 必ず守ること（必須）\n");
  try {
    let status = 0;
    let stderr = "";
    try {
      execFileSync("bash", [resolve(root, GENERATOR), "--pref", "熊本", "--prior", "3 本"], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, MEASURE_TEMPLATE: tmp },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      status = err.status ?? -1;
      stderr = err.stderr ?? "";
    }
    assert.equal(status, 4, `項目 0 件の雛形で異常終了しなかった（exit ${status}）。
**空の本文を静かに出すのが、この道具の最悪の壊れ方である。**`);
    assert.match(stderr, /測る項目 0 行/, "何が 0 件だったかを言っていない");
  } finally {
    rmSync(tmp, { force: true });
  }
});

test("#823 否定的対照: 「項目数だけ数える」検査は、項目の差し替えを素通りする（#762 の実測）", () => {
  // **これが逐語にした理由の裏づけである**（#554: 否定的対照を CI に残す）。
  // #762 は「項目が N 個以上」を見ていた。**だから足した項目を消して別の語を足せば通った。**
  // ここでその検査を再現し、**実際に素通りすることを測る。**
  const countOnly = (md: string): boolean =>
    md.split("\n").filter((l) => /^\| \d+ \|/.test(l)).length >= REQUIRED_ITEMS.length;

  const real = read(TEMPLATE);
  // **y 方向の行を、まるごと別の項目に差し替える**（行数は変わらない）。
  const swapped = real.replace(
    /^\| 5 \| \*\*y 方向（行）の対応を回転で測る\*\*.*$/m,
    "| 5 | **好きな色を書く** | 特に理由は無い |",
  );
  assert.ok(swapped !== real, "差し替えが空振りしている（#514 の形）。この test は無意味になる。");

  assert.deepEqual(
    {
      // **数だけ数える検査は、差し替えられた雛形を通してしまう**（= #762 が起きた形）
      countOnlyPasses: countOnly(swapped),
      // **逐語の検査は落とす**
      verbatimCatches: missingItems(swapped),
    },
    {
      countOnlyPasses: true,
      verbatimCatches: ["y 方向（行）の対応を回転で測る"],
    },
    `「項目数だけ数える検査」と「逐語の検査」の差が消えている。
**countOnlyPasses が false になったなら、数える検査でも足りることになる**ので、
そのときは逐語をやめてよい理由をここに書くこと。
**verbatimCatches が空になったなら、逐語の照合が効いていない**（#762 の再演）。`,
  );
});
