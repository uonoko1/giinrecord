import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Issue #541（#524 が「そのレイヤでは塞げない」と明記して残した半分）:
 *
 * `deploy/test/branch-protection.test.sh` の `t_required_checks_match_workflows` は
 * **ワークフローの job ⊆ 必須チェック** という片方向の部分集合しか見ていなかった。job を消すと
 * 突き合わせる側の集合が痩せるので、判定は自動的に満たされる（#499「痩せたら落とす」の片側しか
 * カバーしない）。実測（このテストを書く前、origin/main で）:
 *
 *   security.yml の gitleaks: job を改名 → deploy/test/branch-protection.test.sh は 18 passed 1 failed（落ちる）
 *   security.yml から gitleaks: job を丸ごと削除 → 19 passed 0 failed（落ちない）
 *
 * ここでは bash の sed/grep で YAML を読むのをやめ（作業合意「言語の構造は、その言語の実装に解かせる」）、
 * `packages/etl/test/workflow-timeout.test.ts`（#556）と同じ「YAML のインデント規則そのものを使う」
 * 構造的な読み方で job を数え上げ、**双方向**に突き合わせる:
 *
 *   (A) pull_request で走る job のうち、許容リストに無いものは全部 REQUIRED_CHECKS に入っている
 *       ＝ #524 が塞げなかった方向（job を消す／改名すると REQUIRED_CHECKS 側に対応が無くなり検出できる）
 *   (B) REQUIRED_CHECKS の各要素は、pull_request で走るどれかの job に対応している
 *       ＝ #524 が既に塞いでいた方向（すり替え・改名で REQUIRED_CHECKS が浮いたら検出する）
 *
 * 許容リスト（pull_request で走るが意図的に必須にしていない job）は #484/#499 の言う
 * 「allowlist は名指しし、その中身も固定する」形でハードコードする。
 *   ci.yml:stale-base          #536 の検査。#524 のレビューで既に必須外と確認済み
 *   pr-body.yml:pr-closes      #793 の検査。stale-base と同じく「PR の書き方」を見るもの。
 *                              必須に昇格させるには GitHub 側の branch protection への登録が要る。
 *                              **#1039 で ci.yml から分けた**（本文を編集したら測り直させるため。
 *                              ci.yml に edited を足すと、止めた job が conclusion: skipped の
 *                              check run を作り、直前の failure を緑に塗り替える）
 *   ci.yml:docker-web          Issue #541 本文が名指しした例外そのもの
 *   branch-protection.yml:guard  自分自身の検査。paths 限定の pull_request でしか走らない
 *   environment-protection.yml:guard  同上（#661）。paths 限定なので、必須にすると
 *                              その paths を触らない PR が永久に pending でマージできなくなる
 */
const here = dirname(fileURLToPath(import.meta.url));
const wfDir = resolve(here, "../../../.github/workflows");

type Job = { file: string; name: string; onPullRequest: boolean };

/** 行末コメントを落とす（このディレクトリの YAML にクォート内の # は出てこない） */
function stripComment(line: string): string {
  const i = line.indexOf("#");
  return (i < 0 ? line : line.slice(0, i)).trimEnd();
}

const HEAD_LINE = /^(?:"([A-Za-z_][A-Za-z0-9_-]*)"|'([A-Za-z_][A-Za-z0-9_-]*)'|([A-Za-z_][A-Za-z0-9_-]*)):\s*$/;

/**
 * job 名の集合を、YAML のインデント規則で取り出す（#556 の jobsOfText と同じ考え方: 正規表現で
 * 構文を推測するのではなく、`jobs:` の次のより深いインデントのブロックを job のマッピングとして扱う）。
 * ここでは job の「本文」までは見ず、名前と、その workflow がトップレベルで pull_request を
 * トリガーに持つかどうかだけを持ち帰る。job 個別の `if:` 条件（例: stale-base の
 * `if: github.event_name == 'pull_request'`）まではここでは解かない — その区別は下の許容リストが担う。
 */
function jobNamesOfText(text: string): string[] {
  const lines = text.split("\n").map(stripComment);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.ok(start >= 0, "トップレベルの jobs: が見つからない");

  const body: { i: number; line: string }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    if (!/^\s/.test(l)) break;
    body.push({ i, line: l });
  }
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const depth = Math.min(...body.map((b) => indentOf(b.line)));

  return body
    .filter((b) => indentOf(b.line) === depth)
    .map((b) => b.line.trim().match(HEAD_LINE))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => m[1] ?? m[2] ?? m[3]);
}

/** トップレベルの `on:` ブロックが `pull_request:` キーを持つかどうか（インデント規則。正規表現で全文を漁らない）。 */
function hasPullRequestTrigger(text: string): boolean {
  const lines = text.split("\n").map(stripComment);
  const start = lines.findIndex((l) => /^on:\s*$/.test(l));
  assert.ok(start >= 0, "トップレベルの on: が見つからない");
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    if (!/^\s/.test(l)) break;
    if (/^\s{2}pull_request:\s*$/.test(l)) return true;
  }
  return false;
}

/**
 * job 直下の `if:` を取り出す（#940）。`jobNamesOfText` と同じ考え方で、`jobs:` の下の
 * job ブロックを見つけ、そのブロック内で**さらに 1 段深い** `if:` を拾う。
 * steps の中の `if:` は 2 段以上深いので拾わない。
 */
function jobIfOf(text: string, jobName: string): string | null {
  const lines = text.split("\n").map(stripComment);
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsAt < 0) return null;
  let at = -1;
  let indent = -1;
  for (let i = jobsAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    if (!/^\s/.test(l)) break;
    const ind = l.length - l.trimStart().length;
    const m = HEAD_LINE.exec(l.trim());
    if (indent < 0) indent = ind;
    if (ind === indent && m && (m[1] ?? m[2] ?? m[3]) === jobName) {
      at = i;
      break;
    }
  }
  if (at < 0) return null;
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    const ind = l.length - l.trimStart().length;
    if (ind <= indent) break; // 次の job に入った
    if (ind === indent + 2) {
      const m = /^if:\s*(.+)$/.exec(l.trim());
      if (m) return m[1].trim();
    }
  }
  return null;
}

function jobsOf(file: string): Job[] {
  const text = readFileSync(resolve(wfDir, file), "utf8");
  const onPR = hasPullRequestTrigger(text);
  return jobNamesOfText(text).map((name) => ({ file, name, onPullRequest: onPR }));
}

/** GitHub は `.yml` と `.yaml` の両方を実行する（#574）。 */
function listAllJobs(): Job[] {
  return readdirSync(wfDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .flatMap(jobsOf);
}

const id = (j: { file: string; name: string }) => `${j.file}:${j.name}`;

/**
 * 意図的に必須チェックにしていない job（#541 本文が名指しした docker-web を含む）。
 * ハードコードする（#499: 期待値はハードコードする。対象から生成すると自己参照になる）。
 * 中身が痩せても入れ替わっても、下のテストで固定する。
 */
const EXEMPT_FROM_REQUIRED: readonly string[] = [
  "ci.yml:stale-base",
  // #793: stale-base と同じ扱い。どちらも「PR の書き方」を見る検査で、本体の正しさは見ていない。
  // **必須チェックにするかどうかは PO の判断**——REQUIRED_CHECKS に足すだけでは足りず、
  // GitHub 側の branch protection に同じ名前を登録する必要があり、登録されていない必須チェックは
  // **全 PR を永久に pending にしてマージ不能にする**（環境を触れるのは PO だけ）。
  // 必須に昇格させるなら、GitHub 側の登録と同じ PR でここに移すこと。
  // #1039: ci.yml から pr-body.yml に移った。**チェック名（= job 名）は変わっていない**ので
  // REQUIRED_CHECKS も branch protection も変わらない。ここの鍵だけが変わる。
  "pr-body.yml:pr-closes",
  "ci.yml:docker-web",
  "branch-protection.yml:guard",
  // #661: branch-protection.yml:guard と同じ理由。paths 限定の pull_request でしか走らないので、
  // 必須チェックにすると**その paths を触らない PR では永久に pending のまま**マージできなくなる。
  "environment-protection.yml:guard",
  // #786: 上の 2 つとまったく同じ理由。paths 限定の pull_request でしか走らないので、
  // 必須チェックにすると**その paths を触らない PR では永久に pending のまま**になる。
  // そもそもこの job が見るのは「リポジトリ全体の現在のアラート」で、**PR の内容とは無関係**
  // ——他人が入れたアラートで自分の PR が赤くなるべきではない。
  "security-alerts.yml:guard",
  // #940: security.yml は `pull_request` トリガーを持つので、このファイルの job は全部
  // `onPullRequest` と判定される（判定は**ファイル単位**で、job の `if:` を見ていない）。
  // だが issue-secrets は `if: github.event_name == 'schedule' || 'workflow_dispatch'` で
  // 閉じてあるので、PR では**必ず skipped** になる。
  //
  // **実測**（PR #940、commit の check-runs API）: `issue-secrets completed skipped`
  // ——`docker-web completed skipped` とまったく同じ形である。
  //
  // 必須チェックにすると、**全 PR で skipped のまま**になる。GitHub の branch protection は
  // skipped を success として扱わないので、全 PR が永久にマージ不能になる
  // （branch-protection.yml:guard / environment-protection.yml:guard と同じ壊れ方）。
  //
  // Issue は push と無関係に書かれるので、PR ごとに見ても意味が無い。週次で十分である。
  "security.yml:issue-secrets",
  // #1110: branch-protection.yml:guard / environment-protection.yml:guard / security-alerts.yml:guard
  // とまったく同じ理由。**paths 限定の pull_request でしか走らないので、必須チェックにすると
  // その paths を触らない PR では永久に pending のまま**マージできなくなる。
  //
  // そもそもこの job が見るのは「いまボードと PR が止まっていないか」で、**PR の内容とは無関係**
  // ——他人の PBI が止まっていることで自分の PR が赤くなるべきではない。
  // **PR で走るときは実際の GitHub を読まない**（`if: github.event_name != 'pull_request'`）ので、
  // PR 上では単体テストだけが走る。
  "scrum-monitor.yml:monitor",
];

/**
 * 必須ステータスチェックとして GitHub に登録されている名前（deploy/monitor/branch-protection.sh の
 * REQUIRED_CHECKS と同じ値）。ここでもハードコードする — bash 配列を実行時に読みにいくと、
 * 両者が同じ壊れ方をした場合に気づけない（#521 レビューで実際にあった「両方の集合を同時に痩せさせると
 * 通る」形。本ファイルは branch-protection.sh から独立した第三の場所として存在する）。
 */
const REQUIRED_CHECKS: readonly string[] = ["check", "gitleaks", "forbidden-patterns", "audit"];

const allJobs = listAllJobs();

test("数え上げそのものの検査: allJobs が全 workflow の job を拾えている（拾えていなければ以降は無意味）", () => {
  const found = allJobs.map(id).sort();
  assert.deepEqual(found, [
    "branch-protection.yml:guard",
    "ci.yml:check",
    "ci.yml:docker-web",
    "ci.yml:stale-base",
    "deploy-data.yml:production",
    "deploy-data.yml:resolve",
    "deploy-data.yml:staging",
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
    // #1110: スクラムの停滞監視の入口。paths 限定の pull_request を持つので
    // EXEMPT_FROM_REQUIRED に入っている（理由はそちらに書いてある）。
    "scrum-monitor.yml:monitor",
    "security-alerts.yml:guard",
    "security.yml:gitleaks",
    "security.yml:issue-secrets",
    "security.yml:forbidden-patterns",
    "security.yml:audit",
  ].sort());
});

test("数え上げそのものの検査: pull_request トリガーを持つ workflow を正しく識別できている", () => {
  const onPR = [...new Set(allJobs.filter((j) => j.onPullRequest).map((j) => j.file))].sort();
  // #1039: pr-body.yml が増えた（pr-closes を ci.yml から分けた）。
  // #1110: scrum-monitor.yml が増えた（監視そのものを触る PR でテストを走らせるため、
  // paths 限定の pull_request を持つ）。
  assert.deepEqual(onPR, [
    "branch-protection.yml",
    "ci.yml",
    "environment-protection.yml",
    "pr-body.yml",
    "scrum-monitor.yml",
    "security-alerts.yml",
    "security.yml",
  ]);
});

/**
 * (A) #524 が塞げなかった方向: pull_request で走る job のうち、許容リストに無いものは
 * 全部 REQUIRED_CHECKS に入っている。job を削除するとその job 自体がここから消えるので
 * 「消えたことに気づけない」ように見えるが、REQUIRED_CHECKS 側は独立にハードコードされているため、
 * その job 名を要求する行が REQUIRED_CHECKS に残る一方 want には現れなくなり、
 * 差は (B) 側で検出される。ここで直接踏む再現は「改名」（job 名が変わり、
 * 新しい名前が allowlist にも REQUIRED_CHECKS にも無い）。
 */
test("#541 pull_request で走る job のうち許容リストに無いものは、全部 REQUIRED_CHECKS に入っている", () => {
  const onPR = allJobs.filter((j) => j.onPullRequest);
  const mustBeRequired = onPR.filter((j) => !EXEMPT_FROM_REQUIRED.includes(id(j)));
  const missing = mustBeRequired.filter((j) => !REQUIRED_CHECKS.includes(j.name)).map(id);
  assert.deepEqual(
    missing,
    [],
    `pull_request で走る job なのに必須チェックに入っておらず、許容リストにも無い: ${missing.join(", ")}`,
  );
});

/**
 * (B) #524 が既に塞いでいた方向: REQUIRED_CHECKS の各要素は、実在する job に対応している。
 * job を削除しても REQUIRED_CHECKS は変わらないので、対応する job が消えればここで検出できる
 * ——これが (A) と組みになって初めて「削除方向」を捕まえる。
 */
test("#541 REQUIRED_CHECKS の各要素は、実在する pull_request 上の job に対応している", () => {
  const names = new Set(allJobs.filter((j) => j.onPullRequest).map((j) => j.name));
  const dangling = REQUIRED_CHECKS.filter((c) => !names.has(c));
  assert.deepEqual(
    dangling,
    [],
    `REQUIRED_CHECKS に名前があるが、対応する job が無い（job が消えた/改名された可能性）: ${dangling.join(", ")}`,
  );
});

/** 許容リストが痩せても入れ替わっても落ちる（#484/#499）。中身をそのまま固定する。 */
test("#541 許容リスト（意図的に必須外にしている job）は中身が固定されている", () => {
  assert.deepEqual(
    [...EXEMPT_FROM_REQUIRED].sort(),
    [
      "branch-protection.yml:guard",
      "ci.yml:docker-web",
      "ci.yml:stale-base",
      "environment-protection.yml:guard",
      "pr-body.yml:pr-closes", // #793 / #1039（ci.yml から分けた）
      "security-alerts.yml:guard", // #786
      "security.yml:issue-secrets", // #940: PR では必ず skipped（実測）。必須にすると全 PR が詰まる
      "scrum-monitor.yml:monitor", // #1110: paths 限定の pull_request。必須にすると全 PR が詰まる
    ].sort(),
  );
});

/**
 * #940: **許容リストに載せた理由が、workflow 側で本当に成り立っているか**を確かめる。
 *
 * `onPullRequest` の判定は**ファイル単位**で、job の `if:` を見ていない。security.yml は
 * `pull_request` トリガーを持つので、その中の issue-secrets も「PR で走る」と判定される。
 * それを必須外にしてよい理由は「`if:` で閉じてあるので PR では必ず skipped になる」であり、
 * **その `if:` が消えたら理由ごと崩れる**。
 *
 * 変異で測った（実測）: 許容リストから issue-secrets を消すと 2 件落ちる。しかし
 * **workflow 側の `if:` を消しても、この検査を足す前は 1 件も落ちなかった**——つまり
 * 「1,364 件の Issue を全 PR で読みに行く」形に変えても誰も気づかなかった。
 * 理由を書いた側（許容リスト）と、理由が成り立つ側（workflow）を突き合わせる。
 */
test("#940 イベントで閉じてあることを理由に必須外にした job は、その `if:` が実在する", () => {
  // 「PR では skipped になるから必須外」と判断した job → その理由が成り立つ条件
  const GATED_BY_EVENT: Record<string, RegExp> = {
    "security.yml:issue-secrets": /github\.event_name/,
  };
  const checked: string[] = [];
  for (const [jobId, want] of Object.entries(GATED_BY_EVENT)) {
    assert.ok(EXEMPT_FROM_REQUIRED.includes(jobId), `${jobId} が許容リストから消えている`);
    const [file, name] = jobId.split(":");
    const cond = jobIfOf(readFileSync(resolve(wfDir, file), "utf8"), name);
    assert.ok(cond, `${jobId} に job 直下の \`if:\` が無い。PR ごとに走るようになっている`);
    assert.match(cond, want, `${jobId} の \`if:\` がイベントで閉じていない: ${cond}`);
    checked.push(jobId);
  }
  // 母数（#757）: 0 件を緑にしない。上の表が空になったらこの検査は何も主張していない。
  assert.ok(checked.length > 0, "GATED_BY_EVENT が空。この検査は何も見ていない");
});

/**
 * 偽陽性が出ないこと: いまの本物の workflow 構成で (A)(B) とも緑になることをこのテスト自身が保証する
 * （上の2テストがまさにそれだが、ここでは「許容リストに載っている job が実在する」ことも確かめる —
 * allowlist が指す先が既に消えた job 名のままだと、許容リストの意味が失われる）。
 */
test("#541 許容リストの各要素は実在する job を指している（消えた job を許し続けない）", () => {
  const ids = new Set(allJobs.map(id));
  const stale = EXEMPT_FROM_REQUIRED.filter((e) => !ids.has(e));
  assert.deepEqual(stale, [], `許容リストが指す job が実在しない（job が消えた/改名された）: ${stale.join(", ")}`);
});

/**
 * #521 のレビューで実際にあった形: 「必須チェックの一覧」を検査する側と、実際に見張る
 * `deploy/monitor/branch-protection.sh` の REQUIRED_CHECKS の両方を**同時に**痩せさせると、
 * どちらも自分の中だけでは矛盾せず通ってしまう。ここは branch-protection.sh の配列を独立に読み、
 * このファイルのハードコード値（REQUIRED_CHECKS 定数）と一致することを確かめる — 一方だけ書き換えると
 * 必ず食い違いが出る。bash の `NAME=(a b c d)` という単純な配列リテラルなので、YAML と違って
 * ネストや複数行を持たず、そのまま安全にトークン分割できる。
 */
/**
 * #1069: **`scripts/po/merge-when-green.sh` の `SKIPPABLE_CHECKS`**（`conclusion: skipped` を
 * 緑として数えてよい検査の名前）**が、`GATED_BY_EVENT` と一致している**ことを固定する。
 *
 * **背景**: merge-when-green.sh は `skipped` を一律 pass として数えていたので、
 * **必須 5 件が全部 `skipped` の PR を「all 5 checks green」でマージした**（再現済み）。
 * **`skipped` は「0 件（問題なし）」ではなく「数えていない」である**（#757）。
 *
 * **直し方**: `skipped` を緑と数えるのは、**その job が PR では構造的に走らない**と
 * 分かっている名前だけに限る。**その「構造的に走らない」の根拠は、この上の
 * `GATED_BY_EVENT` が workflow の `if:` を実際に読んで確かめている。**
 *
 * **ここで突き合わせる理由**: 根拠（`if:` がイベントで閉じている）と、
 * それを使う側（merge-when-green.sh の一覧）が**別のファイルに在る**ので、
 * 片方だけが増えても誰も気づかない。**`SKIPPABLE_CHECKS` に名前を足すと、
 * ここで `GATED_BY_EVENT` にも足すことを強いられ、`GATED_BY_EVENT` に足すと
 * workflow の `if:` の実在を #940 の検査が確かめる。**
 *
 * **`docker-web` を入れてはいけない**（#1069 で測った）: `needs: check` だけで
 * **job 直下の `if:` を持たない**ので、その `skipped` は「走る必要が無かった」ではなく
 * **「上流の `check` が赤くて巻き添えになった」**である（実測: docker-web が skipped の
 * PR {1084, 1092, 1103} と check が failure の PR {1084, 1092, 1103} が 3/3 で一致）。
 * **この検査は、それを足そうとすると落ちる**——`docker-web` に `if:` は無いので
 * `GATED_BY_EVENT` に入れられず、入れなければここで食い違う。
 */
test("#1069 merge-when-green.sh の SKIPPABLE_CHECKS は、イベントで閉じた job だけである", () => {
  const shPath = resolve(here, "../../../scripts/po/merge-when-green.sh");
  const sh = readFileSync(shPath, "utf8");
  const m = sh.match(/^SKIPPABLE_CHECKS=\(([^)]*)\)\s*$/m);
  assert.ok(m, "scripts/po/merge-when-green.sh に SKIPPABLE_CHECKS=(...) が見つからない");
  const fromShell = m[1].trim().split(/\s+/).filter(Boolean).sort();

  // 母数（#757）: 空の一覧を緑にしない。空なら「skipped を緑と数える名前が 1 つも無い」で、
  // **`issue-secrets` が全 PR に出る以上、この道具は全 PR で止まる**。
  assert.ok(fromShell.length > 0, "SKIPPABLE_CHECKS が空。issue-secrets が全 PR で赤になる");

  // `GATED_BY_EVENT`（上のテストが workflow の `if:` の実在を確かめている集合）の job 名。
  // **ここをハードコードせず上のテストと同じ根拠から作る**のではなく、
  // **両方を独立にハードコードする**（#499/#521: 同時に痩せたら気づけない形を避ける）。
  const GATED_JOB_NAMES = ["issue-secrets"];

  assert.deepEqual(
    fromShell,
    [...GATED_JOB_NAMES].sort(),
    "SKIPPABLE_CHECKS と、イベントで閉じてあると確かめた job の一覧が食い違っている",
  );

  // その名前が本当に `if:` を持ち、イベントで閉じていること（#940 と同じ根拠をここでも引く）。
  // **一覧に名前を足しただけでは通らない**——workflow 側に `if:` が無ければここで落ちる。
  const GATED_SOURCE: Record<string, string> = { "issue-secrets": "security.yml" };
  for (const name of fromShell) {
    const file = GATED_SOURCE[name];
    assert.ok(file, `${name} がどの workflow の job か決まっていない`);
    const cond = jobIfOf(readFileSync(resolve(wfDir, file), "utf8"), name);
    assert.ok(cond, `${file}:${name} に job 直下の \`if:\` が無い。PR で必ず skip されるとは言えない`);
    assert.match(
      cond,
      /github\.event_name/,
      `${file}:${name} の \`if:\` がイベントで閉じていない: ${cond}`,
    );
  }
});

test("#541 branch-protection.sh の REQUIRED_CHECKS と、このファイルの REQUIRED_CHECKS が一致する", () => {
  const shPath = resolve(here, "../../../deploy/monitor/branch-protection.sh");
  const sh = readFileSync(shPath, "utf8");
  const m = sh.match(/^REQUIRED_CHECKS=\(([^)]*)\)\s*$/m);
  assert.ok(m, "deploy/monitor/branch-protection.sh に REQUIRED_CHECKS=(...) が見つからない");
  const fromShell = m[1].trim().split(/\s+/).filter(Boolean).sort();
  assert.deepEqual(
    fromShell,
    [...REQUIRED_CHECKS].sort(),
    "branch-protection.sh の REQUIRED_CHECKS と packages/etl 側の REQUIRED_CHECKS が食い違っている",
  );
});
