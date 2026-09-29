import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Issue #1137（項目 1）: **ビルドと deploy 鍵が同じ job に居た。**
 *
 * `deploy-staging.yml` は `push: branches:[main]` で承認なしに `deploy-site.yml` を呼ぶ
 * （`staging` environment の `protection_rules` は 0 件。#659 で実測）。その 1 つの job の中で
 * `pnpm install --frozen-lockfile` / `pnpm build`（= **main に入ったコードの実行**）と
 * `secrets.DEPLOY_SSH_KEY` の両方が居た。つまり `vite.config.ts` や各パッケージの `package.json` の
 * `build` に 1 行入れれば、deploy 鍵を持つ runner の上でそれが走った。
 *
 * 被害の上限は絞られていた（鍵は `authorized_keys` の `command="/usr/bin/rrsync /var/www/giinrecord"`
 * ＋ `restrict` に固定。任意コマンド不可・制限ルート外へ出られない。送った先は nginx が `:ro` で
 * 静的配信するだけ）が、**staging と本番の配信内容は書き換えられた**（同じ鍵）。
 *
 * ── なぜ「名前」ではなく「性質」で見るか ────────────────────────────
 * 「`build` job に secrets が無いこと」を job 名で書くと、**job 名を変えただけで検査が空回りする**
 * （`build` が消えれば、その名前を探す assert は「無い」を見つけられずに通る）。
 * だから**全 job を走査し、job が持つ性質の組み合わせを禁じる**:
 *
 *   (A) ビルド（`pnpm install` / `pnpm build`）を含む job は `secrets.DEPLOY_*` を 1 つも参照しない
 *   (B) 鍵を持つ／rsync する job はビルドを含まない（リポジトリのコードを実行しない）
 *   (C) `environment:`（DEPLOY_* の出どころ）を持つ job はビルドを含まない
 *
 * job 名を何に変えても、(A)(B)(C) は同じ 1 本で効く。
 *
 * ── 母数（2026-09-30 実測、基点 61770bd5 + この枝）──────────────────
 * 走査: `.github/workflows/` の 15 ファイル / 25 job。
 * `deploy-site.yml` は 2 job（`build` / `deploy`）。
 * `secrets.DEPLOY_*` を参照する job は 1 件（`deploy-site.yml` の `deploy`）。
 * `rsync` する行を持つ job は 1 件（同じ job）。
 * ビルドを含む job は 3 件（`ci.yml:check` / `ci.yml:docker-web` / `deploy-site.yml:build`）。
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

type Job = {
  file: string;
  name: string;
  /** job 直下のキーだけ（steps の中と取り違えない） */
  directKeys: string[];
  /** コメントを落とした job 本文 */
  body: string;
  /** job 直下の `uses:`（再利用ワークフローを呼ぶ側） */
  callsReusable: boolean;
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
    return {
      file,
      name: h.m[1] ?? h.m[2] ?? h.m[3],
      directKeys: direct.map((l) => stripComment(l).trim().replace(/:.*$/, "")).filter(Boolean),
      body: own.map(stripComment).join("\n"),
      callsReusable: direct.some((l) => /^\s*uses:\s*\S/.test(stripComment(l))),
    };
  });
}

function allJobs(dir: string = wfDir): Job[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .flatMap((f) => jobsOfText(readFileSync(resolve(dir, f), "utf8"), f));
}

const jobs = allJobs();
const id = (j: Job) => `${j.file}:${j.name}`;

/**
 * その job が **リポジトリのコードを実行する**か。
 *
 * `pnpm build` / `pnpm install` だけでなく、それらを呼ぶ形（`pnpm --filter x build`、
 * `pnpm run build`、`npm ci`、`yarn install`）も拾う。**逐語の 2 語ではなく「install/build を
 * 走らせる形」を拾う**（`pnpm build` を `pnpm run build` に書き換えて鍵と同居させる抜け道を塞ぐ）。
 */
function buildsCode(j: Job): boolean {
  return /\b(?:pnpm|npm|yarn)\b[^\n]*\b(?:install|ci|build)\b/.test(j.body);
}

/** その job が deploy 鍵（DEPLOY_* secrets）を参照するか */
function secretRefs(j: Job): string[] {
  return [...j.body.matchAll(/secrets\.(DEPLOY_[A-Z_]+)/g)].map((m) => m[1]);
}

/** その job が VPS へ rsync する行を持つか */
function rsyncs(j: Job): boolean {
  return j.body.split("\n").some((l) => /(^|\s)rsync\s/.test(l));
}

// ─────────────────────────────────────────────────────────────────────────────
// 母数（#757）: 走査が空回りしていないことを先に固定する
// ─────────────────────────────────────────────────────────────────────────────

test("#1137 母数: 走査が空回りしていない（ファイル数 / job 数 / 各性質の件数）", () => {
  const files = readdirSync(wfDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  assert.ok(files.length >= 15, `ワークフローが ${files.length} 本しか見えていない（実測 2026-09-30: 15 本）`);
  assert.ok(jobs.length >= 25, `job が ${jobs.length} 件しか読めていない（実測 2026-09-30: 25 件）`);

  const builders = jobs.filter(buildsCode).map(id);
  const keyed = jobs.filter((j) => secretRefs(j).length > 0).map(id);
  const senders = jobs.filter(rsyncs).map(id);

  // ビルドする job / 鍵を持つ job / rsync する job のどれかが 0 件なら、下の 3 つの検査は全部空回りする。
  assert.ok(builders.length >= 3, `ビルドする job が ${builders.length} 件（実測 3 件: ${builders.join(", ")}）`);
  assert.deepEqual(keyed, ["deploy-site.yml:deploy"], "DEPLOY_* を参照する job が実測（1 件）から変わった");
  assert.deepEqual(senders, ["deploy-site.yml:deploy"], "rsync する job が実測（1 件）から変わった");
});

test("#1137 母数: deploy-site.yml は 2 つの job に割れている", () => {
  const own = jobs.filter((j) => j.file === "deploy-site.yml").map((j) => j.name);
  assert.equal(own.length, 2, `deploy-site.yml の job が ${own.length} 件（割れていない）: ${own.join(", ")}`);
  // 「1 つの job に戻す」が、この母数の検査だけで落ちる（下の (A)(B)(C) を待たずに鳴る）
});

// ─────────────────────────────────────────────────────────────────────────────
// (A)(B)(C) — 名前に依らない規則
// ─────────────────────────────────────────────────────────────────────────────

test("#1137 (A) ビルドを含む job は secrets.DEPLOY_* を 1 つも参照しない", () => {
  const bad = jobs
    .filter(buildsCode)
    .filter((j) => secretRefs(j).length > 0)
    .map((j) => `${id(j)} → ${[...new Set(secretRefs(j))].join(", ")}`);
  assert.deepEqual(
    bad,
    [],
    `**main に入ったコードを実行する job が deploy 鍵を持っている。**\n` +
      `  ${bad.join("\n  ")}\n` +
      `ビルドは secrets を持たない job（artifact で成果物を渡す）に分け、rsync だけを別 job で行うこと（#1137）。`,
  );
});

test("#1137 (B) deploy 鍵を持つ／rsync する job はビルドを含まない", () => {
  const bad = jobs.filter((j) => secretRefs(j).length > 0 || rsyncs(j)).filter(buildsCode).map(id);
  assert.deepEqual(
    bad,
    [],
    `**deploy 鍵を持つ job がリポジトリのコードを実行している（install / build）。**\n` +
      `  ${bad.join(", ")}\n` +
      `この job には artifact の download と rsync だけを置くこと（#1137）。`,
  );
});

test("#1137 (C) environment:（DEPLOY_* の出どころ）を持つ job はビルドを含まない", () => {
  // `environment:` を付けると、その environment に束ねた secrets がその job の `secrets` 文脈に入る。
  // だから「まだ `secrets.DEPLOY_*` と書いていない」だけの job でも、environment を持つなら
  // ビルドと同居させてはならない（1 行足すだけで (A) の状態に戻れてしまう）。
  const bad = jobs
    .filter((j) => !j.callsReusable && j.directKeys.includes("environment"))
    .filter(buildsCode)
    .map(id);
  assert.deepEqual(
    bad,
    [],
    `**environment を持つ job がビルドしている**（その environment の DEPLOY_* が届く場所でコードが走る）: ${bad.join(", ")}（#1137）`,
  );
});

test("#1137 母数: (C) の走査対象（environment を持つ runs-on の job）が 0 件ではない", () => {
  const withEnv = jobs.filter((j) => !j.callsReusable && j.directKeys.includes("environment")).map(id);
  assert.deepEqual(withEnv, ["deploy-site.yml:deploy"], "environment を持つ実 job が実測（1 件）から変わった");
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
      `rrsync のロックは制限ルート全体に掛かる（#308）。ビルドする job に付けると、ビルドの間ずっと` +
      `他のデプロイが詰まる（#1137）。`,
  );
  assert.ok(senders.length > 0, "rsync する job が 0 件（この検査が空回りしている）");
});

test("#1137 rsync する job は build job の成果物を artifact で受け取る（自分で checkout しない）", () => {
  const sender = jobs.find(rsyncs);
  assert.ok(sender, "rsync する job が無い");
  assert.match(sender.body, /actions\/download-artifact@/, "rsync する job が artifact を download していない");
  assert.doesNotMatch(
    sender.body,
    /actions\/checkout@/,
    "rsync する job が checkout している（リポジトリのコードがこの job に入る。#1137）",
  );
  // artifact 名は upload 側と download 側で一致していなければならない（食い違うと download が落ちる）。
  //
  // **2 つの名前は逐語では一致しない。** 同じ「ビルドした sha」を、upload 側は自分の step の
  // 出力（`steps.<id>.outputs.sha`）から、download 側は `needs.<builder>.outputs.sha` から読む。
  // そこで**両方を「ビルドした sha」という同じ記号に正規化してから比べる**。
  // **job 名や step の id を逐語で書かない**（名前を変えただけで空回りする形にしない）。
  const builder = jobs.find((j) => j.file === sender.file && /actions\/upload-artifact@/.test(j.body));
  assert.ok(builder, `${sender.file} に upload-artifact する job が無い`);
  const nameOf = (b: string) => b.match(/^\s*name:\s*(site-[^\n]*)$/m)?.[1]?.trim();
  const up = nameOf(builder.body);
  const down = nameOf(sender.body);
  assert.ok(up, "upload-artifact の name が読めない");
  assert.ok(down, "download-artifact の name が読めない");
  const normalise = (s: string) =>
    s
      .replace(/\$\{\{\s*steps\.[A-Za-z0-9_-]+\.outputs\.sha\s*\}\}/g, "<BUILT_SHA>")
      .replace(/\$\{\{\s*needs\.[A-Za-z0-9_-]+\.outputs\.sha\s*\}\}/g, "<BUILT_SHA>");
  assert.equal(
    normalise(down ?? ""),
    normalise(up ?? ""),
    `artifact 名が upload 側と download 側で食い違っている（download が落ちる）: up=${up} down=${down}`,
  );
  // 正規化が空回り（両方が `<BUILT_SHA>` を含まないまま一致）していないこと
  assert.match(normalise(up ?? ""), /<BUILT_SHA>/, "artifact 名にビルドした sha が入っていない（呼び出しごとに衝突しうる）");
  // download 側は `needs.<builder>` を辿っている（自分の step の出力を騙っていない）
  assert.match(
    down ?? "",
    new RegExp(`needs\\.${builder.name}\\.outputs\\.sha`),
    `download 側の artifact 名が \`needs.${builder.name}.outputs.sha\` を参照していない`,
  );
});

test("#1137 artifact に入れるのは rsync する 1 ディレクトリだけ（余計なものを VPS に送らない）", () => {
  const builder = jobs.find((j) => j.file === "deploy-site.yml" && /actions\/upload-artifact@/.test(j.body));
  assert.ok(builder, "deploy-site.yml に upload-artifact する job が無い");
  const paths = [...builder.body.matchAll(/^\s*path:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(paths, ["apps/web/build/client"], `artifact の path が 1 件ではない: ${paths.join(", ")}`);
  const days = builder.body.match(/^\s*retention-days:\s*(\d+)\s*$/m)?.[1];
  assert.ok(days && Number(days) <= 3, `retention-days が ${days}（短く保つ。成果物を runner の外に長く置かない）`);
  // **空の artifact を上げさせない。** `upload-artifact` の既定は `warn` なので、ビルドが
  // 何も出さなくても警告だけで緑になり、deploy job が空を受け取って `rsync --delete` が
  // 配信中のサイトを消す。分割前は同じ workspace の中で rsync していたので、この経路は無かった。
  assert.match(
    builder.body,
    /^\s*if-no-files-found:\s*error\s*$/m,
    "upload-artifact に `if-no-files-found: error` が無い（既定の warn では空の artifact が緑で通り、rsync --delete が配信中のサイトを消す。#1137）",
  );
});

test("#1137 / #134 workflow_call の outputs.sha は、いまも step の出力まで辿れる（release.yml が使う）", () => {
  const src = read("deploy-site.yml");
  // workflow_call の outputs が参照している job を読み、その job が本当に sha を出しているか
  const m = src.match(/^\s+sha:\s*\n(?:\s+description:[^\n]*\n)?\s+value: \$\{\{ jobs\.([A-Za-z0-9_-]+)\.outputs\.sha \}\}$/m);
  assert.ok(m, "workflow_call の outputs.sha が `jobs.<id>.outputs.sha` の形で書かれていない");
  const producer = jobs.find((j) => j.file === "deploy-site.yml" && j.name === m[1]);
  assert.ok(producer, `outputs.sha が参照する job \`${m[1]}\` が deploy-site.yml に無い`);
  assert.match(
    producer.body,
    /^\s+sha: \$\{\{ steps\.([A-Za-z0-9_-]+)\.outputs\.sha \}\}$/m,
    `job \`${m[1]}\` が outputs.sha を step の出力に束ねていない（空文字に解決され、release.yml の released タグが動かない）`,
  );
  // release.yml 側の受け取り名が変わっていないこと
  assert.match(read("release.yml"), /needs\.production\.outputs\.sha/);
});

test("#1137 呼び出し元 3 つから見た inputs の契約が変わっていない", () => {
  const src = read("deploy-site.yml");
  const declared = [...src.matchAll(/^ {6}([a-z_]+):\s*$/gm)].map((m) => m[1]);
  // workflow_call.inputs の 5 つ（deploy-staging / release / deploy-data が渡す名前）
  for (const k of ["environment", "site_origin", "target_dir", "ref", "data_ref"]) {
    assert.ok(declared.includes(k), `inputs.${k} が消えた（呼び出し元が渡す名前）`);
  }
  // **コメントを落としてから `uses:` を見る。** 生文字列で `includes("deploy-site.yml")` を
  // すると、`etl.yml` / `districts.yml` / `local-assemblies.yml` の #308 のコメント（deploy-vps の
  // 説明で deploy-site.yml に言及している）が呼び出し元として数えられる（実測: 3 → 6 件）。
  const callers = readdirSync(wfDir)
    .filter((f) => (f.endsWith(".yml") || f.endsWith(".yaml")) && f !== "deploy-site.yml")
    .filter((f) =>
      read(f)
        .split("\n")
        .map(stripComment)
        .some((l) => /^\s*uses:\s*\.\/\.github\/workflows\/deploy-site\.yml\s*$/.test(l)),
    )
    .sort();
  assert.deepEqual(callers, ["deploy-data.yml", "deploy-staging.yml", "release.yml"], "呼び出し元の集合が変わった");
  // 呼び出し元が `with:` で渡しているキーが、すべて宣言されている inputs であること
  for (const f of callers) {
    const s = read(f);
    for (const j of jobsOfText(s, f)) {
      if (!/uses:\s*\.\/\.github\/workflows\/deploy-site\.yml/.test(j.body)) continue;
      const withAt = j.body.indexOf("with:");
      assert.ok(withAt >= 0, `${id(j)} に with: が無い`);
      const keys = [...j.body.slice(withAt).matchAll(/^\s{6}([a-z_]+):/gm)].map((m) => m[1]);
      assert.ok(keys.length > 0, `${id(j)} の with: からキーが読めない`);
      for (const k of keys) assert.ok(declared.includes(k), `${id(j)} が渡す \`${k}\` は deploy-site.yml の inputs に無い`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 検査そのものの検査（パーサが「性質」を読めていることを、合成 YAML で確かめる）
// ─────────────────────────────────────────────────────────────────────────────

test("#1137 検査の検査: ビルドと鍵が同居する job を合成すると、(A) が検出する", () => {
  const yaml = [
    "jobs:",
    "  fused:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: pnpm build",
    "      - run: rsync -az x/ y/",
    "        env:",
    "          SSH_KEY: ${{ secrets.DEPLOY_SSH_KEY }}",
    "",
  ].join("\n");
  const [j] = jobsOfText(yaml, "probe.yml");
  assert.ok(buildsCode(j), "合成した job のビルドを検出できていない");
  assert.deepEqual([...new Set(secretRefs(j))], ["DEPLOY_SSH_KEY"]);
  assert.ok(rsyncs(j), "合成した job の rsync を検出できていない");
});

test("#1137 検査の検査: 分割された 2 job は、どちらも (A)(B) に触れない", () => {
  const yaml = [
    "jobs:",
    "  b:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: pnpm build",
    "  d:",
    "    needs: b",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: rsync -az x/ y/",
    "        env:",
    "          SSH_KEY: ${{ secrets.DEPLOY_SSH_KEY }}",
    "",
  ].join("\n");
  const js = jobsOfText(yaml, "probe.yml");
  assert.deepEqual(js.map((j) => j.name), ["b", "d"]);
  assert.ok(buildsCode(js[0]) && secretRefs(js[0]).length === 0, "build 側の判定が壊れている");
  assert.ok(!buildsCode(js[1]) && secretRefs(js[1]).length === 1, "deploy 側の判定が壊れている");
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
  assert.ok(!buildsCode(j), "コメントの `pnpm build` を実体と取り違えている（偽陽性で本物の分割を落とす）");
});

test("#1137 検査の検査: `pnpm run build` / `pnpm --filter web build` / `npm ci` も拾う", () => {
  for (const cmd of ["pnpm run build", "pnpm --filter web build", "npm ci", "yarn install --frozen-lockfile"]) {
    const yaml = ["jobs:", "  x:", "    runs-on: ubuntu-latest", "    steps:", `      - run: ${cmd}`, ""].join("\n");
    const [j] = jobsOfText(yaml, "probe.yml");
    assert.ok(buildsCode(j), `\`${cmd}\` をビルドとして拾えていない（この形で鍵と同居できてしまう）`);
  }
});
