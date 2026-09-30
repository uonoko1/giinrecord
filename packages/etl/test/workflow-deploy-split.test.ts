import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Issue #1137（項目 1）: **ビルドと deploy 鍵が同じ場所に居た。**
 *
 * `deploy-staging.yml` は `push: branches:[main]` で承認なしに `deploy-site.yml` を呼ぶ
 * （`staging` environment の `protection_rules` は 0 件。#659 で実測）。その 1 つの job の中で
 * `pnpm install --frozen-lockfile` / `pnpm build`（= **main に入ったコードの実行**）と
 * `secrets.DEPLOY_SSH_KEY` の両方が居た。つまり `vite.config.ts` や各パッケージの `package.json` の
 * `build` に 1 行入れれば、deploy 鍵を持つ runner の上でそれが走った。
 *
 * ── **最初の直しは誤っていた**（レビューが変異で示した）────────────────────
 * 最初は `deploy-site.yml` の中で job を 2 つに割り、build job に `environment:` を
 * 付けないことで鍵を遠ざけたつもりだった。**2 つとも誤りだった。**
 *
 * **(1) `DEPLOY_*` は environment secret ではない**（2026-09-30 実測。`gh api`):
 *   repos/<repo>/actions/secrets                      total_count=5   ← DEPLOY_* 4 件はここ
 *   repos/<repo>/environments/staging/secrets          total_count=0
 *   repos/<repo>/environments/production/secrets       total_count=0
 *   repos/<repo>/environments/production-data/secrets  total_count=0
 * **repository secret なので `environment:` の有無と無関係に届く。**
 * 根拠にしていたのは `deploy-site.yml` のコメント（"Every environment needs the same four
 * secrets"）で、**設定を確かめずにコメントを信じた**（このリポジトリが繰り返している「代理と実体」）。
 *
 * **(2) `secrets` 文脈は job 単位ではなく workflow 単位である。**
 * 同じ workflow の中で job を割っても分かれない。呼び出し元が `secrets: inherit` を
 * 書いていたので、build job も `${{ toJSON(secrets) }}` / `secrets['DEPLOY_SSH_KEY']` で読めた。
 *
 * **(3) 検査は denylist だった。** `secrets\.(DEPLOY_[A-Z_]+)` という綴り 1 つだけを数えていたので、
 * レビュアーの変異が素通りした:
 *   MX1  build job に `ALL: ${{ toJSON(secrets) }}` を足す      → 15/15 緑（すり抜け）
 *   MX2  build job に `secrets['DEPLOY_SSH_KEY']` を足す         → 15/15 緑（すり抜け）
 * **#1008 / #1022 / #1043 / #1089 / #1133 / #1153 と同じ型。**
 *
 * ── いまの形 ────────────────────────────────────────────────────
 * **場所を分けた。** ビルドは `build-site.yml`（別ファイル）に在り、`deploy-site.yml` は
 * **`secrets:` を 1 つも書かずに** それを呼ぶ。呼び先が読めるのは呼び出し元が明示的に渡した
 * secrets だけなので、**`build-site.yml` の `secrets` 文脈は空である**。
 * 呼び出し元 4 か所は `secrets: inherit` をやめ、`DEPLOY_*` 4 件を名指しで渡す。
 *
 * ── **検査は denylist をやめ、allowlist にした** ───────────────────────
 * **「`DEPLOY_` という綴りを禁じる」のではなく、「ビルドが在る workflow では `secrets` という
 * 語が出る形を一切許さない」**。綴りを列挙しないので、`toJSON(secrets)` でも
 * `secrets['X']` でも `secrets.ANY` でも、**まだ思いついていない形でも**落ちる。
 *
 * ── 母数（2026-09-30 実測、基点 08e72c6e + この枝）──────────────────
 * 走査: `.github/workflows/` の 16 ファイル / 26 job。
 * **ビルドを含む workflow ファイルは 2 件**（`build-site.yml` / `ci.yml`）。
 * **`secrets` という語（コメント外）を持つ job は 11 件。**
 * **`ci.yml` は 0 件**（コメント外。`FORBIDDEN_PATTERNS` を使うのは `security.yml` 側で、
 * ビルドする job とはファイルが別である。これは実測して確かめた——最初は
 * 「ci.yml も secrets を使う」と書いたが、コメントを落として数えたら 0 件だった）。
 * `rsync` する job は 1 件（`deploy-site.yml` の `deploy`）。
 * **0 件で緑になる形を全部塞ぐ**（数えていないことと、無いことを分ける。#757）。
 */

const here = dirname(fileURLToPath(import.meta.url));
const wfDir = resolve(here, "../../../.github/workflows");
const read = (f: string) => readFileSync(resolve(wfDir, f), "utf8");

/** 行末コメントを落とす（クォート内の `#` は扱わない。この用途では出てこない） */
function stripComment(line: string): string {
  const i = line.indexOf("#");
  return (i < 0 ? line : line.slice(0, i)).trimEnd();
}

/** コメントを落とした本文（行頭コメントも消える） */
const uncommented = (s: string) => s.split("\n").map(stripComment).join("\n");

type Job = {
  file: string;
  name: string;
  /** job 直下のキーだけ（steps の中と取り違えない） */
  directKeys: string[];
  /** コメントを落とした job 本文 */
  body: string;
  /** job 直下の `uses:` の値（再利用ワークフローを呼ぶ側）。呼んでいなければ undefined */
  uses?: string;
};

const HEAD = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+)):\s*$/;

/**
 * `jobs:` 直下の job を拾う。`workflow-timeout.test.ts` の同型の実装から独立に書いてある
 * （#521: 同じ集合を 2 か所で別々に持たないと、両方を同時に痩せさせたときに気づけない）。
 */
function jobsOfText(text: string, file: string): Job[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.ok(start >= 0, `${file}: トップレベルの jobs: が見つからない`);
  const indentOf = (l: string) => l.length - l.trimStart().length;

  const body: { i: number; line: string }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    if (!/^\s/.test(l)) break;
    body.push({ i, line: l });
  }
  if (body.length === 0) return [];
  const depth = Math.min(...body.map((b) => indentOf(b.line)));

  const heads = body
    .filter((b) => indentOf(b.line) === depth)
    .map((b) => ({ ...b, m: b.line.trim().match(HEAD) }))
    .filter((b): b is typeof b & { m: RegExpMatchArray } => b.m !== null);

  return heads.map((h, n) => {
    const end = n + 1 < heads.length ? heads[n + 1].i : lines.length;
    const own = lines.slice(h.i + 1, end).filter((l) => l.trim() !== "" && indentOf(l) > depth);
    const keyDepth = own.length ? Math.min(...own.map(indentOf)) : depth + 2;
    const direct = own.filter((l) => indentOf(l) === keyDepth);
    const usesLine = direct.map(stripComment).find((l) => /^\s*uses:\s*\S/.test(l));
    return {
      file,
      name: h.m[1] ?? h.m[2] ?? h.m[3],
      directKeys: direct.map((l) => stripComment(l).trim().replace(/:.*$/, "")).filter(Boolean),
      body: own.map(stripComment).join("\n"),
      uses: usesLine?.replace(/^\s*uses:\s*/, "").trim(),
    };
  });
}

const workflowFiles = (dir: string = wfDir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();

function allJobs(dir: string = wfDir): Job[] {
  return workflowFiles(dir).flatMap((f) => jobsOfText(readFileSync(resolve(dir, f), "utf8"), f));
}

const jobs = allJobs();
const id = (j: Job) => `${j.file}:${j.name}`;

/**
 * その本文が **リポジトリのコードを実行する**か。
 *
 * `pnpm build` / `pnpm install` だけでなく、それらを呼ぶ形（`pnpm --filter x build`、
 * `pnpm run build`、`npm ci`、`yarn install`）も拾う。**逐語の 2 語ではなく「install/build を
 * 走らせる形」を拾う**（`pnpm build` を `pnpm run build` に書き換えて鍵と同居させる抜け道を塞ぐ）。
 *
 * **`ci` は `npm ci` の形だけ拾う。** 最初は `install|ci|build` を並べていたが、
 * `security.yml:94`（`pnpm audit high+ (scripts/ci/audit.sh, ...)`）が **`pnpm` … `ci`** で
 * 一致して偽陽性になった（`scripts/ci/` のパスに `ci` が入る）。**偽陽性は本物の分割を落とすので、
 * `ci` は直後に来る形に限る。**
 */
function buildsCode(body: string): boolean {
  return /\b(?:pnpm|npm|yarn)\b[^\n]*\b(?:install|build)\b/.test(body) || /\bnpm\s+ci\b/.test(body);
}

/**
 * その本文が `secrets` という語を（コメント外で）使っている行。
 *
 * **allowlist 側の判定である**（#1137 のレビュー）。前身は `secrets\.(DEPLOY_[A-Z_]+)` という
 * **綴り 1 つの denylist** で、`${{ toJSON(secrets) }}` と `secrets['DEPLOY_SSH_KEY']` が
 * 素通りした。**ここでは綴りを列挙せず、`secrets` という語が出ることそのものを数える。**
 * `secrets.X` / `secrets['X']` / `secrets["X"]` / `toJSON(secrets)` / `secrets:` の宣言 —— 全部入る。
 */
function secretLines(body: string): string[] {
  return body
    .split("\n")
    .filter((l) => /\bsecrets\b/.test(l))
    .map((l) => l.trim());
}

/** その job が VPS へ rsync する行を持つか */
function rsyncs(j: Job): boolean {
  return j.body.split("\n").some((l) => /(^|\s)rsync\s/.test(l));
}

/** ビルドを含む workflow ファイル（job の本文で判定する。ファイル全体のコメントに釣られない） */
const buildingFiles = [...new Set(jobs.filter((j) => buildsCode(j.body)).map((j) => j.file))].sort();

// ─────────────────────────────────────────────────────────────────────────────
// 母数（#757）: 走査が空回りしていないことを先に固定する
// ─────────────────────────────────────────────────────────────────────────────

test("#1137 母数: 走査が空回りしていない（ファイル数 / job 数 / 各性質の件数）", () => {
  assert.ok(workflowFiles().length >= 16, `ワークフローが ${workflowFiles().length} 本しか見えていない（実測 2026-09-30: 16 本）`);
  assert.ok(jobs.length >= 26, `job が ${jobs.length} 件しか読めていない（実測 2026-09-30: 26 件）`);

  const builders = jobs.filter((j) => buildsCode(j.body)).map(id);
  const withSecrets = jobs.filter((j) => secretLines(j.body).length > 0).map(id);
  const senders = jobs.filter(rsyncs).map(id);

  // どれかが 0 件なら、下の検査は全部空回りする。
  assert.ok(builders.length >= 3, `ビルドする job が ${builders.length} 件（実測 3 件: ${builders.join(", ")}）`);
  assert.ok(withSecrets.length >= 5, `\`secrets\` を使う job が ${withSecrets.length} 件（実測 2026-09-30: 11 件）: ${withSecrets.join(", ")}`);
  assert.deepEqual(senders, ["deploy-site.yml:deploy"], "rsync する job が実測（1 件）から変わった");
  // **ビルドを含むファイルは 2 つだけである。** `build-site.yml`（#1137 で切り出した先）と
  // `ci.yml`（VPS に触らない。`secrets` を 1 語も持たないことは下で別に固定する）。
  // **ここが増えたら「ビルドが在る場所が増えた」ということなので、(A) の対象に足すか判断が要る。**
  assert.deepEqual(buildingFiles, ["build-site.yml", "ci.yml"], `ビルドを含むファイルが実測から変わった: ${buildingFiles.join(", ")}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// (A) allowlist: ビルドが在る場所に `secrets` を 1 語も置かせない
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **これが #1137 の中心の検査である。**
 *
 * **綴りを禁じるのではなく、`secrets` という語が出ることを禁じる。**
 * だから `secrets.DEPLOY_SSH_KEY` でも `${{ toJSON(secrets) }}` でも `secrets['X']` でも、
 * **まだ思いついていない形でも**落ちる。
 *
 * **`ci.yml` は対象外にしている**（下の別の検査で理由ごと固定する）。
 * `ci.yml` はビルドするが VPS に触らず、`DEPLOY_*` を 1 語も持たない。そこは別に見る。
 */
test("#1137 (A) ビルドする workflow は `secrets` という語を 1 つも持たない（denylist ではなく allowlist）", () => {
  const target = "build-site.yml";
  assert.ok(buildingFiles.includes(target), `${target} がビルドする workflow として拾えていない（検査が空回りしている）`);
  const src = uncommented(read(target));
  const hits = secretLines(src);
  assert.deepEqual(
    hits,
    [],
    `**${target} に \`secrets\` が現れた。** ここは main に入ったコードを実行する場所なので、` +
      `\`secrets\` 文脈に何かが入った時点で鍵が漏れる経路になる。\n  ${hits.join("\n  ")}\n` +
      `（#1137: 綴りではなく語そのものを禁じている。\`toJSON(secrets)\` も \`secrets['X']\` も同じく落ちる）`,
  );
  // `workflow_call.secrets` の宣言も置かない（宣言が無ければ呼び出し元は渡せない）
  assert.doesNotMatch(src, /^\s*secrets:/m, `${target} に \`secrets:\` の宣言がある（呼び出し元が渡せてしまう）`);
});

test("#1137 (A) ビルドする workflow を呼ぶ側は、secrets を 1 つも渡さない", () => {
  const target = "build-site.yml";
  const callers = workflowFiles().filter((f) => f !== target && new RegExp(`uses:\\s*\\./\\.github/workflows/${target}`).test(uncommented(read(f))));
  assert.ok(callers.length > 0, `${target} の呼び出し元が 0 件（この検査が空回りしている）`);
  for (const f of callers) {
    for (const j of jobsOfText(read(f), f)) {
      if (!j.uses?.includes(target)) continue;
      const hits = secretLines(j.body);
      assert.deepEqual(
        hits,
        [],
        `${id(j)} が ${target} に secrets を渡している（\`inherit\` も名指しも同じく禁止。渡した時点で` +
          `ビルドが鍵を読める）:\n  ${hits.join("\n  ")}`,
      );
    }
  }
});

test("#1137 (A) 呼び出し元は `secrets: inherit` を使わない（名指しで渡す）", () => {
  // `inherit` は**宣言されていない secret まで**呼び先の全 job に流し込む。
  // #1137 の前は 4 か所すべてが `inherit` で、だから `environment:` を付けない build job でも
  // `DEPLOY_SSH_KEY` が読めた（FORBIDDEN_PATTERNS も一緒に流れていた）。
  const bad: string[] = [];
  for (const f of workflowFiles()) {
    uncommented(read(f))
      .split("\n")
      .forEach((l, i) => {
        if (/^\s*secrets:\s*inherit\s*$/.test(l)) bad.push(`${f}:${i + 1}`);
      });
  }
  assert.deepEqual(
    bad,
    [],
    `\`secrets: inherit\` が残っている（宣言していない secret まで呼び先の全 job に流れる。#1137）: ${bad.join(", ")}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// (B)(C) 名前に依らない規則
// ─────────────────────────────────────────────────────────────────────────────

test("#1137 (B) rsync する job はビルドを含まない（リポジトリのコードを実行しない）", () => {
  const bad = jobs.filter(rsyncs).filter((j) => buildsCode(j.body)).map(id);
  assert.deepEqual(
    bad,
    [],
    `**deploy 鍵を持つ job がリポジトリのコードを実行している（install / build）**: ${bad.join(", ")}\n` +
      `この job には artifact の download と rsync だけを置くこと（#1137）。`,
  );
});

test("#1137 (B) `secrets` を使う job はビルドを含まない", () => {
  // (A) は「ビルドする workflow に secrets を置かない」方向。ここは逆方向
  // （secrets を置いた job にビルドを足す形）を塞ぐ。**両方向が要る。**
  // `ci.yml` は `secrets` を使う job（gitleaks / forbidden-patterns / audit）と
  // ビルドする job（check / docker-web）が別 job なので、ここは通る。
  const bad = jobs.filter((j) => secretLines(j.body).length > 0).filter((j) => buildsCode(j.body)).map(id);
  assert.deepEqual(
    bad,
    [],
    `**\`secrets\` を使う job がビルドしている**: ${bad.join(", ")}（#1137）`,
  );
});

test("#1137 (C) VPS に触る workflow（rsync が在る）では、ビルドが同じファイルに無い", () => {
  const senderFiles = [...new Set(jobs.filter(rsyncs).map((j) => j.file))];
  assert.ok(senderFiles.length > 0, "rsync する workflow が 0 件（この検査が空回りしている）");
  for (const f of senderFiles) {
    assert.ok(
      !buildingFiles.includes(f),
      `${f} は rsync もビルドもしている。**同じ workflow なら \`secrets\` 文脈が共有される**ので、` +
        `job を割っても鍵は分かれない（#1137: これが最初の直しの誤りだった）。ビルドは別ファイルに出すこと。`,
    );
  }
});

test("#1137 `ci.yml` はビルドするが `secrets` を 1 語も持たない（(A) の対象外にした理由）", () => {
  // `ci.yml` はビルドする（`check` / `docker-web`）が VPS に触らない。
  //
  // **実測 2026-09-30: `ci.yml` のコメント外に `secrets` は 0 件である**
  // （`FORBIDDEN_PATTERNS` を使う `forbidden-patterns` / `gitleaks` / `audit` は `security.yml` 側で、
  // ビルドする job とはファイルが別）。**だから (A) の規則が ci.yml にもそのまま当てはまる。**
  // 「対象外にした」のではなく「たまたま同じ性質だった」が正確なので、そう固定する。
  // **将来 ci.yml に secrets が入ったら落ちる**（そのときは (A) の対象に足すか、理由を書き直す）。
  assert.ok(buildingFiles.includes("ci.yml"), "ci.yml がビルドする workflow として拾えていない");
  const hits = secretLines(uncommented(read("ci.yml")));
  assert.deepEqual(
    hits,
    [],
    `ci.yml に \`secrets\` が入った（ここはビルドする場所である。#1137）:\n  ${hits.join("\n  ")}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 分割で壊れうるもの（#1137 本文の「絶対に壊してはいけないもの」）
// ─────────────────────────────────────────────────────────────────────────────

test("#1137 / #308 concurrency group は rsync する job の側に在る（ビルド中にロックを占有しない）", () => {
  const holders = jobs.filter((j) => /^\s*group:\s*deploy-vps\s*$/m.test(j.body)).map(id);
  const senders = jobs.filter(rsyncs).map(id);
  assert.deepEqual(
    holders,
    senders,
    `\`group: deploy-vps\` を持つ job と rsync する job が一致しない。\n` +
      `  group: ${holders.join(", ") || "(無し)"}\n  rsync: ${senders.join(", ") || "(無し)"}\n` +
      `rrsync のロックは制限ルート全体に掛かる（#308）。ビルドする側に付けると、ビルドの間ずっと` +
      `他のデプロイが詰まる（#1137）。`,
  );
  assert.ok(senders.length > 0, "rsync する job が 0 件（この検査が空回りしている）");
});

test("#1137 rsync する job は artifact で成果物を受け取る（自分で checkout しない）", () => {
  const sender = jobs.find(rsyncs);
  assert.ok(sender, "rsync する job が無い");
  assert.match(sender.body, /actions\/download-artifact@/, "rsync する job が artifact を download していない");
  assert.doesNotMatch(
    sender.body,
    /actions\/checkout@/,
    "rsync する job が checkout している（リポジトリのコードがこの job に入る。#1137）",
  );
  // **artifact 名を両側で二重に持たない。** ビルド側が output で返し、rsync 側はそれを参照する
  // （綴りを 2 か所に書くと片方だけ腐り、download が落ちる）。
  const m = sender.body.match(/^\s*name:\s*\$\{\{\s*needs\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\s*\}\}\s*$/m);
  assert.ok(m, "download-artifact の name が `needs.<job>.outputs.<n>` を参照していない（綴りを二重に持っている）");
  const producer = jobs.find((j) => j.file === sender.file && j.name === m[1]);
  assert.ok(producer, `${sender.file} に job \`${m[1]}\` が無い`);
  // 産む側は別 workflow を呼ぶ job。その workflow が同名の output を宣言していること
  assert.ok(producer.uses, `job \`${m[1]}\` が再利用ワークフローを呼んでいない`);
  const calledFile = producer.uses.replace(/^\.\/\.github\/workflows\//, "");
  const called = uncommented(read(calledFile));
  assert.match(
    called,
    new RegExp(`^\\s+${m[2]}:\\s*$`, "m"),
    `${calledFile} が output \`${m[2]}\` を宣言していない（download 側は空文字を受け取る）`,
  );
});

test("#1137 artifact に入れるのは rsync する 1 ディレクトリだけ（余計なものを VPS に送らない）", () => {
  const builder = jobs.find((j) => /actions\/upload-artifact@/.test(j.body) && buildsCode(j.body));
  assert.ok(builder, "ビルドして upload-artifact する job が無い");
  const paths = [...builder.body.matchAll(/^\s*path:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(paths, ["apps/web/build/client"], `artifact の path が 1 件ではない: ${paths.join(", ")}`);
  const days = builder.body.match(/^\s*retention-days:\s*(\d+)\s*$/m)?.[1];
  assert.ok(days && Number(days) <= 3, `retention-days が ${days}（短く保つ。成果物を runner の外に長く置かない）`);
  // **空の artifact を上げさせない。** 既定は `warn` なので、ビルドが何も出さなくても警告だけで
  // 緑になり、rsync する job が空を受け取って `rsync --delete` が配信中のサイトを消す。
  // 分割前は同じ workspace の中で rsync していたので、この経路は無かった。
  assert.match(
    builder.body,
    /^\s*if-no-files-found:\s*error\s*$/m,
    "upload-artifact に `if-no-files-found: error` が無い（既定の warn では空の artifact が緑で通り、rsync --delete が配信中のサイトを消す。#1137）",
  );
});

test("#1137 / #134 workflow_call の outputs.sha は、ビルドした commit まで辿れる（release.yml が使う）", () => {
  const src = read("deploy-site.yml");
  const m = src.match(/^\s+sha:\s*\n(?:\s+description:[^\n]*\n)?\s+value: \$\{\{ jobs\.([A-Za-z0-9_-]+)\.outputs\.sha \}\}$/m);
  assert.ok(m, "deploy-site.yml の outputs.sha が `jobs.<id>.outputs.sha` の形で書かれていない");
  const producer = jobs.find((j) => j.file === "deploy-site.yml" && j.name === m[1]);
  assert.ok(producer, `outputs.sha が参照する job \`${m[1]}\` が deploy-site.yml に無い`);
  // 産む側は別 workflow を呼ぶので、その workflow の outputs.sha を辿る
  assert.ok(producer.uses, `job \`${m[1]}\` が再利用ワークフローを呼んでいない`);
  const calledFile = producer.uses.replace(/^\.\/\.github\/workflows\//, "");
  const called = read(calledFile);
  const inner = called.match(/^\s+sha:\s*\n(?:\s+description:[^\n]*\n)?\s+value: \$\{\{ jobs\.([A-Za-z0-9_-]+)\.outputs\.sha \}\}$/m);
  assert.ok(inner, `${calledFile} の outputs.sha が `.concat("`jobs.<id>.outputs.sha` の形で書かれていない"));
  const innerJob = jobsOfText(called, calledFile).find((j) => j.name === inner[1]);
  assert.ok(innerJob, `${calledFile} に job \`${inner[1]}\` が無い`);
  assert.match(
    innerJob.body,
    /^\s+sha: \$\{\{ steps\.([A-Za-z0-9_-]+)\.outputs\.sha \}\}$/m,
    `${calledFile} の job \`${inner[1]}\` が outputs.sha を step の出力に束ねていない（空文字に解決され、release.yml の released タグが動かない）`,
  );
  assert.match(read("release.yml"), /needs\.production\.outputs\.sha/);
});

test("#1137 呼び出し元 3 つから見た inputs の契約が変わっていない", () => {
  const src = read("deploy-site.yml");
  const declared = [...src.matchAll(/^ {6}([a-z_]+):\s*$/gm)].map((m) => m[1]);
  for (const k of ["environment", "site_origin", "target_dir", "ref", "data_ref"]) {
    assert.ok(declared.includes(k), `inputs.${k} が消えた（呼び出し元が渡す名前）`);
  }
  // **コメントを落としてから `uses:` を見る。** 生文字列の `includes` だと、`etl.yml` /
  // `districts.yml` / `local-assemblies.yml` の #308 のコメント（deploy-vps の説明で
  // deploy-site.yml に言及）が呼び出し元として数えられる（実測: 3 → 6 件）。
  const callers = workflowFiles()
    .filter((f) => f !== "deploy-site.yml")
    .filter((f) =>
      uncommented(read(f))
        .split("\n")
        .some((l) => /^\s*uses:\s*\.\/\.github\/workflows\/deploy-site\.yml\s*$/.test(l)),
    );
  assert.deepEqual(callers, ["deploy-data.yml", "deploy-staging.yml", "release.yml"], "呼び出し元の集合が変わった");
  for (const f of callers) {
    for (const j of jobsOfText(read(f), f)) {
      if (!j.uses?.includes("deploy-site.yml")) continue;
      const withAt = j.body.indexOf("with:");
      assert.ok(withAt >= 0, `${id(j)} に with: が無い`);
      const after = j.body.slice(withAt);
      const stopAt = after.search(/^\s{4}secrets:/m);
      const withBlock = stopAt < 0 ? after : after.slice(0, stopAt);
      const keys = [...withBlock.matchAll(/^\s{6}([a-z_]+):/gm)].map((m) => m[1]);
      assert.ok(keys.length > 0, `${id(j)} の with: からキーが読めない`);
      for (const k of keys) assert.ok(declared.includes(k), `${id(j)} が渡す \`${k}\` は deploy-site.yml の inputs に無い`);
    }
  }
});

test("#1137 deploy-site.yml が宣言する secrets は DEPLOY_* 4 件だけ（呼び出し元がそれ以上渡せない）", () => {
  const src = uncommented(read("deploy-site.yml"));
  const block = src.slice(src.indexOf("\n    secrets:"));
  const declared = [...block.matchAll(/^ {6}([A-Z_]+):\s*$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(declared, ["DEPLOY_HOST", "DEPLOY_KNOWN_HOSTS", "DEPLOY_SSH_KEY", "DEPLOY_USER"]);
  // 呼び出し元が渡すキーも同じ 4 件であること
  for (const f of ["deploy-staging.yml", "release.yml", "deploy-data.yml"]) {
    const passed = [...uncommented(read(f)).matchAll(/^ {6}(DEPLOY_[A-Z_]+):/gm)].map((m) => m[1]);
    assert.ok(passed.length > 0, `${f} が DEPLOY_* を 1 つも渡していない`);
    for (const k of passed) assert.ok(declared.includes(k), `${f} が渡す \`${k}\` は deploy-site.yml が宣言していない`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 検査そのものの検査（allowlist が本当に「語」を拾っていることを合成 YAML で確かめる）
// ─────────────────────────────────────────────────────────────────────────────

test("#1137 検査の検査: secretLines は 5 つの形すべてを拾う（denylist ではない）", () => {
  // **前身の denylist（`secrets\.(DEPLOY_[A-Z_]+)`）が素通しした形を全部並べる。**
  const forms = [
    "          KEY: ${{ secrets.DEPLOY_SSH_KEY }}", // 元の 1 形（denylist が唯一拾えた形）
    "          ALL: ${{ toJSON(secrets) }}", // MX1（レビュアーの変異。すり抜けていた）
    "          KEY: ${{ secrets['DEPLOY_SSH_KEY'] }}", // MX2（同上）
    '          KEY: ${{ secrets["DEPLOY_SSH_KEY"] }}',
    "          KEY: ${{ secrets.SOMETHING_ELSE }}", // 綴りを列挙しないので、これも拾う
    "    secrets: inherit", // 宣言・受け渡しの形
  ];
  for (const l of forms) {
    assert.deepEqual(secretLines(l), [l.trim()], `この形を拾えていない: ${l.trim()}`);
  }
  // 行頭コメントは拾わない（偽陽性で本物の分割を落とさない）
  assert.deepEqual(secretLines(uncommented("      # note: secrets used to be here (#1137)")), []);
});

test("#1137 検査の検査: ビルドと secrets が同じファイルに在る形を合成すると (A) が検出する", () => {
  const yaml = [
    "jobs:",
    "  fused:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: pnpm build",
    "      - run: echo x",
    "        env:",
    "          ALL: ${{ toJSON(secrets) }}",
    "",
  ].join("\n");
  const [j] = jobsOfText(yaml, "probe.yml");
  assert.ok(buildsCode(j.body), "合成した job のビルドを検出できていない");
  assert.equal(secretLines(j.body).length, 1, "合成した job の secrets を検出できていない");
});

test("#1137 検査の検査: 行頭コメントに `pnpm build` と書いただけでは buildsCode にならない（#570 の罠）", () => {
  const yaml = [
    "jobs:",
    "  d:",
    "    runs-on: ubuntu-latest",
    "    # note: pnpm build used to happen here (#1137)",
    "    steps:",
    "      - run: rsync -az x/ y/",
    "",
  ].join("\n");
  const [j] = jobsOfText(yaml, "probe.yml");
  assert.ok(!buildsCode(j.body), "コメントの `pnpm build` を実体と取り違えている（偽陽性で本物の分割を落とす）");
});

test("#1137 検査の検査: `pnpm run build` / `pnpm --filter web build` / `npm ci` も拾う", () => {
  for (const cmd of ["pnpm run build", "pnpm --filter web build", "npm ci", "yarn install --frozen-lockfile"]) {
    const yaml = ["jobs:", "  x:", "    runs-on: ubuntu-latest", "    steps:", `      - run: ${cmd}`, ""].join("\n");
    const [j] = jobsOfText(yaml, "probe.yml");
    assert.ok(buildsCode(j.body), `\`${cmd}\` をビルドとして拾えていない（この形で鍵と同居できてしまう）`);
  }
});

test("#1137 検査の検査: uses: の値を読めている（別 workflow への鎖を辿る足場）", () => {
  const yaml = [
    "jobs:",
    "  b:",
    "    uses: ./.github/workflows/build-site.yml",
    "    with:",
    "      ref: main",
    "",
  ].join("\n");
  const [j] = jobsOfText(yaml, "probe.yml");
  assert.equal(j.uses, "./.github/workflows/build-site.yml");
  assert.deepEqual(secretLines(j.body), [], "secrets を渡していない呼び出しを誤検出している");
});
