import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../../..");

describe("ビルド成果物はリポジトリに含めない", () => {
  it("apps/web/build/ は git に無視される", () => {
    // 文字列ではなく git の判定で検証する（`build/` でも `apps/web/build/` でもよい）
    const out = execFileSync("git", ["check-ignore", "-q", "apps/web/build/client/index.html"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    expect(out).toBe("");
  });

  it("apps/web/build 配下に追跡中のファイルが無い", () => {
    const tracked = execFileSync("git", ["ls-files", "apps/web/build"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    expect(tracked).toBe("");
  });
});

describe("React Router の生成型 apps/web/.react-router/ はリポジトリに含めない", () => {
  it("apps/web/.react-router/ は git に無視される", () => {
    const out = execFileSync("git", ["check-ignore", "-q", "apps/web/.react-router/types/+routes.ts"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    expect(out).toBe("");
  });

  it("apps/web/.react-router 配下に追跡中のファイルが無い", () => {
    const tracked = execFileSync("git", ["ls-files", "apps/web/.react-router"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    expect(tracked).toBe("");
  });
});

/**
 * Issue #787: 測定・調査の作業ディレクトリの置き場所。
 *
 * **なぜ要るか（実測）**: #769（群馬）の worktree はマージ済みなのに `worktree-sweep.sh` が消さなかった。
 * 理由は `?? .work/` と `?? packages/etl/.work769/`（20M + 12M）が `git status --porcelain` に出るから。
 * `worktree-sweep.sh` の「未コミットがあるなら消さない」は #726 で意図して入れた守りなので**正しい**。
 * 悪いのは、**守りが毎回鳴ることで、鳴っていること自体を見なくなる**こと
 * （本物の取りこぼしか、ただの作業ゴミかが出力から区別できない）。
 *
 * **名前を 1 つに決める**: `.work/` と `.work769/` が同じ worktree に両方あった。
 * 測定 PBI を並列で走らせているので、決めないと担当者の数だけ名前が増える。
 *
 * **リポジトリの外（scratchpad）では代えられない**: #769 の `.work769/` の中身は `.ts` の測定スクリプトで、
 * ワークスペースの依存（`@seiji-kiroku/*`, `tsx`）を import するために**パッケージの中**に居る必要がある。
 * だから「リポジトリ内に一時ファイルを置かない」（WORKING_AGREEMENT）だけでは回らず、実際に破られた。
 *
 * **無視は狭く**: 取りこぼし（コミットしたつもりが入っていない）は、ゴミより高くつく。
 * `.work` のような短い接頭辞ではなく、`.measure/` という 1 つの名前だけを無視する。
 */
/**
 * Issue #830: **`git check-ignore` はファイルシステムを stat する。**
 *
 * 旧版はこのリポジトリの作業ツリーで直に `git check-ignore` を叩いていた。すると
 * **作業合意どおり `.measure/` を作った担当者の手元でだけ**
 * 「`.measure` は git に無視されない」が落ちた（**担当者 3 人が独立に踏んだ**: #811 / #815 / #819）。
 * `.measure` という*ディレクトリ*が実在すると、git は `.gitignore` の `.measure/` に一致させる。
 * 見たいのは「`.measure` という名前の*ファイル*は無視されない」なので、判定の対象が別物になっていた。
 *
 * **`--no-index` では直らない**（#815 の担当者が最小リポジトリで切り分け、PO も確かめた）。
 * `--no-index` は git の index を見ないだけで、**ファイルシステムは stat する**。
 *
 * **直し方**: 一時ディレクトリに使い捨ての repo を作り、**このリポジトリの `.gitignore` を実物のまま
 * コピーして**、検査したいパスを**主張どおりの形**（ファイルなのかディレクトリなのか）で実体化する。
 * `check-ignore` の実挙動は見たままなので、**#797 の変異 M2b（末尾の `/` が要る）の強さは落ちない**
 * —— 末尾の `/` を落とすと、使い捨て repo の中の**ファイル** `.measure` が無視される側に回って落ちる。
 * 前例: `scripts/ci/test/released-ref.test.sh` / `stale-base.test.sh` が同じ形で使い捨て repo を作る。
 *
 * **`.gitignore` を作り直さずコピーする**のが要点。中身を書き写すと、本物が変わっても検査は気づかない。
 */
describe("測定・調査の作業ディレクトリ .measure/ (#787, #830)", () => {
  /** このリポジトリで追跡されている .gitignore を全部（実物をコピーする。書き写さない）。 */
  const gitignoreFiles = execFileSync("git", ["ls-files", "*.gitignore"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);

  it(".gitignore を実際にコピーできている（母数が消えたら落ちる）", () => {
    expect(gitignoreFiles).toContain(".gitignore");
    expect(gitignoreFiles.length).toBeGreaterThanOrEqual(1);
  });

  /**
   * 使い捨て repo を 1 つ作り、`path` を**そのパス自身がファイルである**形で実体化して
   * `git check-ignore` にかける。無視されるなら true。
   * 使い終わったら消すので、このリポジトリの作業ツリーには何も残さない。
   *
   * **1 つの repo に全部は入れられない**（実測）。`.measure/notes.md` は `.measure` が
   * ディレクトリであることを要求し、`.measure` は `.measure` がファイルであることを要求する。
   * 同居させると `EISDIR: illegal operation on a directory` で落ちる——
   * **これは旧版が抱えていた取り違えそのもの**（作業ツリーの `.measure` の形が判定を変えていた）。
   * だから**パス 1 本につき repo 1 つ**にして、形を混ぜない。
   */
  const isIgnoredInScratchRepo = (path: string): boolean => {
    const dir = mkdtempSync(join(tmpdir(), "gl830-ignore-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: dir, stdio: "ignore" });
      for (const rel of gitignoreFiles) {
        const dest = join(dir, rel);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(join(repoRoot, rel), dest);
      }
      // 検査対象を「そのパスがファイルである」形で実体化する。
      // .measure/notes.md のようなパスなら .measure は自然にディレクトリになる。
      // .measure のようなパスなら .measure はファイルになる——**そこが旧版と決定的に違う**。
      // **`writeFileSync` を消す変異は落ちない**（#830 で実測。28/28 緑のまま）。
      // FS に何も無ければ check-ignore は純粋なパターン一致に落ちて、15 本とも正解を返すため——
      // **きれいな作業ツリーでは等価変異**である。**汚れた作業ツリーでは等価ではない**ので残す。
      // 「常にディレクトリとして実体化する」変異（旧版の取り違えの再現）は 2 件落ちる（実測）。
      const dest = join(dir, path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, "x");

      const r = spawnSync("git", ["check-ignore", "-q", path], { cwd: dir });
      // check-ignore は「無視される」で 0、「されない」で 1。1 は異常ではないので拾い直す。
      if (r.status !== 0 && r.status !== 1) throw new Error(`git check-ignore failed for ${path}: ${r.status}`);
      return r.status === 0;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  // --- 無視されるもの（作業ゴミ）: ここに 1 つでも漏れがあると sweep がまた鳴り続ける ---
  const ignoredPaths = [
    ".measure/notes.md",
    ".measure/769/cache/page.html",
    "packages/etl/.measure/advband.ts",
    "packages/etl/.measure/769/adv-base.txt",
    "apps/web/.measure/out.json",
    "packages/shared/.measure/tmp.ts",
    "scripts/.measure/probe.sh",
  ];

  // --- 無視されてはいけないもの（本物の成果物）---
  // **ここがこの検査の主眼**: 無視を広げすぎると、成果物が黙って git status から消える。
  const trackablePaths = [
    // 本番データ。`.measure` の規則が data/ に及んではいけない
    "data/assemblies/pref-10/meta.json",
    "data/districts/by-zip.json",
    // 名前が似ているだけのもの。接頭辞一致で無視してはいけない
    ".measurements/x.json",
    "packages/etl/.measure-notes.md",
    "packages/etl/measure/run.ts",
    "apps/web/app/lib/measure.ts",
    "data/.measurement",
    // **ディレクトリではなく `.measure` という名前のファイル**。
    // `.gitignore` の末尾の `/` が落ちると、これも黙って無視される（変異 M2b で実測した）。
    // 使い捨て repo の中では**必ずファイルとして**実体化されるので、
    // このリポジトリの作業ツリーに `.measure/` が在ろうが無かろうが結果は変わらない（#830）。
    ".measure",
    "packages/etl/.measure",
    // 通常のソース
    "packages/etl/src/index.ts",
    "apps/web/app/root.tsx",
    "scripts/po/worktree-sweep.sh",
  ];

  it.each(ignoredPaths)("%s は git に無視される", (p) => {
    expect(isIgnoredInScratchRepo(p)).toBe(true);
  });
  it("無視されるパスを数えている（母数が消えたら落ちる）", () => {
    expect(ignoredPaths.length).toBe(7);
  });

  it.each(trackablePaths)("%s は git に無視されない（成果物を黙って捨てない）", (p) => {
    expect(isIgnoredInScratchRepo(p)).toBe(false);
  });
  it("無視されないパスを数えている（母数が消えたら落ちる）", () => {
    expect(trackablePaths.length).toBe(12);
  });

  it(".measure 配下に追跡中のファイルが無い", () => {
    const tracked = execFileSync("git", ["ls-files", "*.measure/*"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    expect(tracked).toBe("");
  });

  // **この検査は「data/ を無視する変異」では落ちない**（実測。`git ls-files` は追跡済みのファイルを
  // .gitignore に関係なく出すため）。**落とすのは上の check-ignore の側である。**
  // ここが担っているのは**母数**——「無視されない」と言っている data/ に、本当に成果物が在ること。
  // これが空になったら、上の data/ の検査は「存在しないものが無視されない」を確かめているだけになる。
  it("data/ 配下に追跡中のファイルが実際に在る（上の data/ の検査の母数）", () => {
    const tracked = execFileSync("git", ["ls-files", "data"], { cwd: repoRoot, encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(tracked.length).toBeGreaterThan(100);
  });
});
