import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Issue #943: **データ PR の枝には `data/` 以外を入れない。**
 *
 * 2026-09-19 の run 35473644787 で、`etl.yml` の push が GitHub に拒否された:
 *
 *   ! [remote rejected] data/refresh -> data/refresh
 *     (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml`
 *      without `workflows` permission)
 *
 * 機序は「枝の土台が古い」こと。ETL は 2 時間走る（実測: 直近 8 回の中央値 2 時間 10 分）。
 * その間に main が進む。枝のコミット自体は `data/` の 3 ファイルしか触っていないが、
 * **GitHub は「枝の分岐点」ではなく「既定ブランチの現在の tip」と比べる**ので、
 * main 側で進んだ `.github/workflows/ci.yml` が「枝で巻き戻されている」ように見える。
 *
 * **そしてこの拒否は結果として正しかった。** 巻き戻されかけていたのは、
 * `packages/etl` のテストファイル数の**下限を下げる**変更である。push が通っていれば、
 * 検査を弱める変更がデータ更新の PR に紛れて入っていた。
 * **止めたのは権限であって検査ではない。** 権限は「たまたま止まった」でしかないので、
 * `workflows` 権限が付いた日には黙って通る。だから検査を置く。
 *
 * 実体は `scripts/ci/etl-data-only-push.sh`（rebase ＋ `data/` 以外 0 件の確認。
 * 振る舞いの検証は `scripts/ci/test/etl-data-only-push.test.sh` が本物の git リポジトリで行う）。
 * このテストが見るのは**ワークフロー側の配線**である——
 * スクリプトがどれだけ正しくても、ワークフローがそれを呼ばなければ何も起きない。
 */
const here = dirname(fileURLToPath(import.meta.url));
const wfDir = resolve(here, "../../../.github/workflows");
const repoRoot = resolve(here, "../../..");

const GUARD = "scripts/ci/etl-data-only-push.sh";

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
 * 「データ PR を作るワークフロー」を**中身から**拾う。本数をここに書き写さない
 * （書き写すと、4 本目が足されたときにこのテストは何も言わない）。
 * 目印は `DATA_BRANCH:` を env に持つこと——3 本とも同じ形で data PR の枝名を持っている。
 */
const dataPrWorkflows = workflows.filter((w) => /^\s*DATA_BRANCH:/m.test(w.code));

test("#943: データ PR を作るワークフローを中身から拾えている（母数を出す）", () => {
  // 母数を出す（#757: 「0 件」と「数えていない」を区別できない出力を書かない）。
  const names = dataPrWorkflows.map((w) => w.file);
  assert.ok(
    workflows.length >= 10,
    `.github/workflows を読めていない（見つかった本数: ${workflows.length}）`,
  );
  assert.ok(
    names.length > 0,
    `DATA_BRANCH を持つワークフローが 1 本も無い（全 ${workflows.length} 本を見た）。` +
      `目印が変わったなら、このテストの拾い方を直すこと（黙って 0 本になると検査が消える）`,
  );
  // 2026-09-21 時点の実測: etl.yml / districts.yml / local-assemblies.yml の 3 本。
  // 増えるのは構わない（下の検査が新しい 1 本にもそのまま掛かる）が、**減ったら鳴らす**。
  assert.ok(
    names.length >= 3,
    `データ PR ワークフローが 3 本を下回った（${names.length} 本: ${names.join(", ")}）`,
  );
});

test("#943: データ PR の枝は etl-data-only-push.sh を通してのみ push される", () => {
  assert.ok(dataPrWorkflows.length > 0, "母数が 0（拾い方が壊れている）");
  for (const w of dataPrWorkflows) {
    assert.ok(
      w.code.includes(GUARD),
      `${w.file}: ${GUARD} を通っていない。data/ 以外が data PR に紛れ込むのを止めるものが無い`,
    );
  }
});

test("#943: 検査を迂回する素の git push が残っていない", () => {
  assert.ok(dataPrWorkflows.length > 0, "母数が 0（拾い方が壊れている）");
  const offenders: string[] = [];
  for (const w of dataPrWorkflows) {
    for (const [i, line] of w.code.split("\n").entries()) {
      const t = line.trim();
      // `git push <remote> <branch>` の形。`--delete` はスクリプトの中にしか無いので、
      // ワークフロー側に git push が 1 行でも残っていたら迂回経路である。
      if (/^git push\b/.test(t)) offenders.push(`${w.file}:${i + 1}: ${t}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `データ PR ワークフローに素の git push が残っている（${offenders.length} 件 / ` +
      `${dataPrWorkflows.length} 本を見た）:\n${offenders.join("\n")}`,
  );
});

test("#943: workflows 権限を足して直していない（権限で誤魔化さない）", () => {
  // `workflows: write` を付ければ push は通る。**しかしそれは「検査を弱める変更が
  // 黙って入る」状態を作ることである。** 今回それを止めたのは権限だった。
  // 母数が 0 だと「1 本も違反していない」と「1 本も見ていない」が同じ緑になる（#757）。
  assert.ok(dataPrWorkflows.length > 0, "母数が 0（拾い方が壊れている）");
  const offenders = dataPrWorkflows.filter((w) => /^\s*workflows:\s*write/m.test(w.code));
  assert.deepEqual(
    offenders.map((w) => w.file),
    [],
    `データ PR ワークフローに workflows: write が付いている（${dataPrWorkflows.length} 本を見た）`,
  );
});

test("#943: 比較は merge base（三点）ではなく tip 同士で行う", () => {
  // 三点（A...B）は merge base と比べるので、**土台が古いままでも「data/ しか変わっていない」と
  // 言ってしまう**（実測済み: 同じ枝で三点は data/a.json の 1 件、tip 同士は
  // .github/workflows/ci.yml を含む 2 件になった）。GitHub が見ているのは既定ブランチの
  // 現在の tip なので、こちらもそれに合わせないと検査が素通りする。
  const guard = readFileSync(resolve(repoRoot, GUARD), "utf8");
  const diffLines = guard
    .split("\n")
    .map(stripComment)
    .filter((l) => l.includes("git diff"));
  assert.ok(diffLines.length > 0, `${GUARD} に git diff が無い`);
  for (const l of diffLines) {
    assert.ok(
      !/\.\.\./.test(l),
      `${GUARD}: 三点の diff は merge base と比べるので土台の古さを見逃す: ${l.trim()}`,
    );
  }
});

test("#943: 検査は push より前に走る（落ちたら push しない）", () => {
  const guard = readFileSync(resolve(repoRoot, GUARD), "utf8");
  const lines = guard.split("\n").map(stripComment);
  const firstPush = lines.findIndex((l) => /^\s*git push\b/.test(l));
  const outsideCheck = lines.findIndex((l) => /outside\s*>\s*0/.test(l));
  assert.ok(firstPush >= 0, `${GUARD} に git push が無い`);
  assert.ok(outsideCheck >= 0, `${GUARD} に data/ 外の件数を見る分岐が無い`);
  assert.ok(
    outsideCheck < firstPush,
    `${GUARD}: 検査（行 ${outsideCheck + 1}）が push（行 ${firstPush + 1}）より後にある`,
  );
});

/**
 * Issue #1132: **データ PR の本文に閉じる語が無いので、`pr-closes` が毎回赤くなっていた。**
 *
 * 実測（2026-09-30、`gh pr list --state all --limit 1000` の 687 本のうち
 * 自動データ PR を `scripts/ci/pr-closes.sh` に掛けた）:
 *
 *   **自動データ PR 60 本のうち 59 本が赤。**（内訳: `data: refresh` 50 本 /
 *   `data: districts` 4 本 / `data: local assemblies` 6 本）
 *   **緑だった 1 本は #1131 で、PO が本文を手で直したものである**
 *   （GitHub の check-run: `FAILURE@2026-09-29T02:47:20Z` → 手で直したあと
 *    `SUCCESS@2026-09-29T03:08:15Z`。**`--auto` のマージが 21 分止まっていた**）。
 *
 * **赤の中身は無害だが、無害な赤が毎日 1 件並ぶと本物の赤を見落とす。**
 * **PO は #1131 のとき実際に「また ETL か」で済ませかけた**（Issue #1132 のコメント）。
 *
 * ## なぜ「検査を黙らせる」側を選ばなかったか
 *
 * **`pr-closes.sh` も `pr-body.yml` も 1 行も変えていない。**
 * `data: refresh` を対象外にする分岐（`if:` の skip や検査側の除外リスト）を足すと、
 * **その分岐の射程がずれた日に、人が出す PR でも検査が効かなくなる**——
 * そして**効かなくなったことは緑からは読めない**。
 *
 * 逃げ道は**すでに `pr-closes.sh` に在る**（`Closes なし（理由）`。#793 で
 * PO 自身が作業合意の更新 PR に使い始めた形）。**それを使うだけで済むなら、
 * 検査の側に穴を開ける理由が無い。**
 *
 * **だからこのテストは「本物の `pr-closes.sh` に、ワークフローが実際に書く本文を食わせる」**。
 * 逃げ道の綴りをここに写して `includes()` で見る形にはしない——
 * **写した綴りは、`pr-closes.sh` が綴りを変えた日に嘘になる**（`pr-closes.sh` が
 * `CLOSING_RE` を board-audit.sh から実行時に取り出しているのと同じ理由）。
 *
 * **3 本すべてに掛かる**（`data: refresh` だけ直して他の 2 本を残すと、
 * 頻度が下がるだけで同じ赤が残る）。**4 本目が足されても、上の `dataPrWorkflows` が
 * 中身から拾うので、このテストがそのまま掛かる**——denylist にならない。
 */

/**
 * ワークフローが `gh pr create --body` に渡す本文を取り出す。
 *
 * **本文を正規表現で読んで「シェルならこうなるだろう」と組み直さない。**
 * 最初にそう書いて**間違えた**: `--body "…\n\n…"` を「`\n` は改行」と解いたが、
 * **bash の二重引用符の中の `\n` は改行にならない**（実測: `od -c` が `\` `n` の 2 文字を出す。
 * `gh` も `--body` の値を解釈しない）。**解く側が間違っていると、テストは
 * 実際には出ない本文を測って緑になる**——#1124 と同じ「測る道具が嘘をつく」形である。
 *
 * だから**ワークフローに書かれている代入文を、そのまま bash に実行させる**。
 * 組み立て方（`printf` か `cat <<EOF` か素の文字列か）が変わっても、
 * **bash が出す答えが本物**なので、このテストは付いていける。
 */
function prCreateBodies(w: Workflow): string[] {
  // 行継続（`\` + 改行）をつなぐ。以後 1 行 = 1 文とみなせる。
  const lines = w.code.replace(/\\\n\s*/g, " ").split("\n");
  const bodies: string[] = [];
  for (const [i, line] of lines.entries()) {
    if (!/\bgh pr create\b/.test(line)) continue;
    const m = line.match(/--body\s+("(?:[^"\\]|\\.)*"|\S+)/);
    assert.ok(m, `${w.file}:${i + 1}: gh pr create に --body が無い: ${line.trim()}`);
    // `--body` の値が変数参照なら、その変数への代入文を**同じ step の中から**探して前に置く。
    const varName = m[1].match(/^"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?$/)?.[1];
    const prelude = varName
      ? lines
          .slice(0, i)
          .filter((l) => new RegExp(`^\\s*${varName}=`).test(l))
          .join("\n")
      : "";
    if (varName) {
      assert.ok(
        prelude.length > 0,
        `${w.file}:${i + 1}: --body が $${varName} を参照しているが、代入文が見つからない`,
      );
    }
    // **bash に組ませる。** `printf '%s'` で出すので末尾の改行の有無まで実物と同じ。
    const script = `${prelude}\nprintf '%s' ${m[1]}`;
    const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    assert.equal(r.status, 0, `${w.file}:${i + 1}: 本文の組み立てを bash で再現できない: ${r.stderr}`);
    bodies.push(r.stdout);
  }
  return bodies;
}

const PR_CLOSES = "scripts/ci/pr-closes.sh";

test("#1132: データ PR ワークフローの本文を取り出せている（母数を出す）", () => {
  assert.ok(dataPrWorkflows.length > 0, "母数が 0（拾い方が壊れている）");
  const counts = dataPrWorkflows.map((w) => `${w.file}=${prCreateBodies(w).length}`);
  for (const w of dataPrWorkflows) {
    assert.ok(
      prCreateBodies(w).length > 0,
      `${w.file}: gh pr create の --body を取り出せない。` +
        `書き方が変わったならこのテストの取り出し方を直すこと（黙って 0 件になると検査が消える）。` +
        `全 ${dataPrWorkflows.length} 本の内訳: ${counts.join(", ")}`,
    );
  }
});

test("#1132: データ PR の本文は本物の pr-closes.sh を通る（毎日の赤が消えること）", () => {
  const checker = resolve(repoRoot, PR_CLOSES);
  assert.ok(dataPrWorkflows.length > 0, "母数が 0（拾い方が壊れている）");
  let checked = 0;
  for (const w of dataPrWorkflows) {
    for (const body of prCreateBodies(w)) {
      const r = spawnSync("bash", [checker, "-"], { input: body, encoding: "utf8" });
      assert.equal(
        r.status,
        0,
        `${w.file}: この本文では pr-closes が赤になる（exit ${r.status}）。\n` +
          `--- 本文 ---\n${body}\n--- 検査の言い分 ---\n${r.stderr}${r.stdout}`,
      );
      checked++;
    }
  }
  // #757: 「0 件だった」と「数えていない」を出力で区別できるようにする。
  assert.ok(
    checked >= 3,
    `検査に掛けた本文が ${checked} 件しかない（データ PR ワークフローは ${dataPrWorkflows.length} 本）`,
  );
});

test("#1132: 本文が複数行に分かれている（\\n の 2 文字が PR 本文に出ていない）", () => {
  // **この PBI の実装で一度踏んだ罠をここで留める。**
  // `--body "1 行目\n\nCloses なし（…）"` と書くと、**bash の二重引用符の中の `\n` は
  // 改行にならない**（実測: `od -c` が `\` `n` の 2 文字を出す）。`gh` も値を解釈しないので、
  // **PR 本文に `\n` という 2 文字がそのまま出る。**
  // **`pr-closes` は通ってしまう**（行単位で見るので、1 行に全部入っていても当たる）——
  // **つまり緑だけを見ていると気づけない。** 利用者に見えるのは崩れた本文だけである。
  assert.ok(dataPrWorkflows.length > 0, "母数が 0（拾い方が壊れている）");
  let checked = 0;
  for (const w of dataPrWorkflows) {
    for (const body of prCreateBodies(w)) {
      assert.ok(
        !body.includes("\\n"),
        `${w.file}: PR 本文に \\n の 2 文字が入っている（改行になっていない）: ${JSON.stringify(body)}`,
      );
      assert.ok(
        body.split("\n").length >= 2,
        `${w.file}: 本文が 1 行しかない。閉じる語は別の行に置くこと: ${JSON.stringify(body)}`,
      );
      checked++;
    }
  }
  assert.ok(checked >= 3, `見た本文が ${checked} 件しかない`);
});

test("#1132: 閉じる語の無い本文なら赤になる（測る道具が空振りしていない）", () => {
  // **上のテストが「本文を直したから緑」なのか「何も測っていないから緑」なのかを分ける。**
  // #1124 と同じ形（フィルタが 0 件でも緑になっていた）。
  // **#1132 の直前まで main に在った本文**（実測: マージ済み `data: refresh` 50 本のうち
  // 49 本がこの綴りだった）を食わせて、赤になることを見る。
  const checker = resolve(repoRoot, PR_CLOSES);
  const before =
    "Automated ETL output. Validated by validateDataset in the ETL run; CI builds the site with it.";
  const r = spawnSync("bash", [checker, "-"], { input: before, encoding: "utf8" });
  assert.equal(
    r.status,
    1,
    `#1132 以前の本文で pr-closes が緑になった。検査が空振りしているか、検査が緩んだ` +
      `（exit ${r.status}）: ${r.stderr}${r.stdout}`,
  );
});

test("#1132: 検査の側に穴を開けていない（pr-closes.sh / pr-body.yml がデータ PR を名指ししない）", () => {
  // **この PBI は「検査を弱める」方向に倒れうる**ので、倒れていないことを固定する。
  // `data: refresh` や `data/` の枝名、bot の名前を**検査の側が**知っていたら、
  // それは「この PR では検査しない」という分岐であり、**射程がずれた日に人の PR も素通りする。**
  // **素通りしたことは緑からは読めない**ので、ここで形として止める。
  const suspects = [PR_CLOSES, ".github/workflows/pr-body.yml"];
  const NAMES = /data:\s*refresh|data\/refresh|data\/districts|data\/local-assemblies|github-actions\[bot\]|giinrecord-etl/;
  const offenders: string[] = [];
  for (const rel of suspects) {
    const text = readFileSync(resolve(repoRoot, rel), "utf8");
    for (const [i, raw] of text.split("\n").entries()) {
      // **コメントは読まない。** 説明としてデータ PR に触れるのは構わない——
      // 検査を分岐させているのは実行される行だけである。
      const line = stripComment(raw);
      if (NAMES.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `検査の側がデータ PR を名指ししている（${offenders.length} 件 / ${suspects.length} ファイルを見た）。` +
      `#1132 は本文の側で直す PBI であって、検査に穴を開ける PBI ではない:\n${offenders.join("\n")}`,
  );
});
