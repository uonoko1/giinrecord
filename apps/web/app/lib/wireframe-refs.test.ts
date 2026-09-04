import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * Issue #462。#453 / #456 は「ワイヤーフレームにこう書いてある」を根拠に見た目を変えた。
 * 根拠にしたファイルが**実在し、かつ採用案として README に記録されている**ことを機械で守る。
 *
 * 守るのは 3 つだけ:
 *   1. docs から参照されるワイヤーフレームのパスが実在する（消えた／改名されたら落ちる）
 *   2. そのファイルが README に載っている（記録の無いファイルを根拠にしていたら落ちる）
 *   3. README が 21 ファイル全部を扱っている（増減したら記録を更新させる）
 *
 * 中身の「採用/不採用」まではテストしない。判断は人がするもので、
 * 文字列一致で守ると README の文面を縛るだけの無意味なテストになる。
 */

const repo = join(__dirname, "..", "..", "..", "..");
const wireframeDir = join(repo, "design", "wireframes");
const readmePath = join(wireframeDir, "README.md");
const docsDir = join(repo, "docs");

/** docs/ 配下の .md を再帰で集める */
function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...markdownFiles(p));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

/** 本文から design/wireframes/<name>.dc.html を全部拾う（行番号付きの参照も拾う） */
function referencedWireframes(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/design\/wireframes\/([A-Za-z0-9_.-]+\.dc\.html)/g)) {
    found.add(m[1]);
  }
  return [...found].sort();
}

const onDisk = readdirSync(wireframeDir)
  .filter((f) => f.endsWith(".dc.html"))
  .sort();

describe("ワイヤーフレームの参照と記録（#462）", () => {
  it("design/wireframes に .dc.html がある", () => {
    expect(onDisk.length).toBeGreaterThan(0);
  });

  it("design/wireframes/README.md がある", () => {
    expect(existsSync(readmePath)).toBe(true);
  });

  it("README は .dc.html 全ファイルに言及している", () => {
    const readme = readFileSync(readmePath, "utf8");
    const missing = onDisk.filter((f) => !readme.includes(f));
    expect(missing).toEqual([]);
  });

  const docRefs = markdownFiles(docsDir).flatMap((file) =>
    referencedWireframes(readFileSync(file, "utf8")).map((name) => ({ file, name })),
  );

  it("docs からワイヤーフレームが参照されている（参照ゼロならこの検査は意味を失う）", () => {
    expect(docRefs.length).toBeGreaterThan(0);
  });

  it.each(docRefs.map((r) => [`${r.name} (${r.file.slice(repo.length + 1)})`, r.name]))(
    "docs が参照する %s は実在し、README に記録がある",
    (_label, name) => {
      expect(existsSync(join(wireframeDir, name))).toBe(true);
      expect(readFileSync(readmePath, "utf8")).toContain(name);
    },
  );
});
