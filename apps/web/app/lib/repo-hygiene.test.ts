import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
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
describe("測定・調査の作業ディレクトリ .measure/ (#787)", () => {
  /** check-ignore は「無視される」で 0、「されない」で 1 を返す。1 は異常ではないので拾い直す。 */
  const ignored = (path: string): boolean => {
    const r = spawnSync("git", ["check-ignore", "-q", "--no-index", path], { cwd: repoRoot });
    if (r.status !== 0 && r.status !== 1) throw new Error(`git check-ignore failed for ${path}: ${r.status}`);
    return r.status === 0;
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
  it.each(ignoredPaths)("%s は git に無視される", (p) => {
    expect(ignored(p)).toBe(true);
  });
  it("無視されるパスを数えている（母数が消えたら落ちる）", () => {
    expect(ignoredPaths.length).toBe(7);
  });

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
    // 通常のソース
    "packages/etl/src/index.ts",
    "apps/web/app/root.tsx",
    "scripts/po/worktree-sweep.sh",
  ];
  it.each(trackablePaths)("%s は git に無視されない（成果物を黙って捨てない）", (p) => {
    expect(ignored(p)).toBe(false);
  });
  it("無視されないパスを数えている（母数が消えたら落ちる）", () => {
    expect(trackablePaths.length).toBe(10);
  });

  it(".measure 配下に追跡中のファイルが無い", () => {
    const tracked = execFileSync("git", ["ls-files", "*.measure/*"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    expect(tracked).toBe("");
  });

  it("data/ 配下に追跡中のファイルが残っている（上の検査の母数。data/ ごと無視したら落ちる）", () => {
    const tracked = execFileSync("git", ["ls-files", "data"], { cwd: repoRoot, encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(tracked.length).toBeGreaterThan(100);
  });
});
