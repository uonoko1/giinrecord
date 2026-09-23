import { test } from "node:test";
import assert from "node:assert/strict";
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
