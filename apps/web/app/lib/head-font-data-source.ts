/**
 * `data/` から「明朝 700 で描かれる欄」を読み出す（#477）。Node 専用（ビルド時と検査でしか動かない）。
 *
 * **サブセットを作る側（`scripts/font-subset.ts`）と、覆えているか検査する側
 * （`font-subset-coverage.test.ts`）が、必ず同じ欄を読むためにここ 1 か所に置く。**
 * 片方だけに欄が増えると、**検査は緑のままサブセットが足りなくなる**（＝気づけない）。
 * これは #477 が最も避けたい形そのものである。
 *
 * 読む欄と、それが描かれるクラス:
 *
 * | 欄 | クラス | ページ |
 * |---|---|---|
 * | 議員の氏名 | `.members-item__name` / `.assembly-member__name` | `/members`（200 件折りたたみ）/ `/assemblies/:id` |
 * | 会派・選挙区 | `.members-row-heading` ほか絞り込みの見出し | `/members` |
 * | 発言の役職（会議録の原文） | `.member-position` | 議員ページの発言タブ（**HTML に焼き込まれない**、#242） |
 * | 採決の会派名 | `.rollcall-group-name` | `/rollcalls/:session/:id` |
 * | 地方議会の判の原文 | `.member-stamp` | 議員ページの表決タブ |
 * | 議会名 | `.coverage-assembly__name` | `/coverage`（ETL が県議会を足す経路） |
 *
 * **この表と実装が食い違うと、検査は緑のままサブセットが足りなくなる。**
 * `head-font-data-source.test.ts` が、4 欄すべてが実 `data/` に対して非空であることを固定している
 * （**源が痩せたら鳴る**。#520 のレビューで「`speakerPositions` を潰しても 7 tests 全部緑」だった穴）。
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { HeadFontDataSource } from "./head-font-data-chars";

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

function listDir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** `dataDir`（既定は `data/`）を舐めて、明朝 700 で描かれる欄だけを集める。無い欄は空。 */
export function readHeadFontDataSource(dataDir: string): HeadFontDataSource {
  const members = readJson<{ name?: string; group?: string; district?: string }[]>(path.join(dataDir, "members", "index.json")) ?? [];

  const rollCallGroups: string[] = [];
  for (const session of listDir(path.join(dataDir, "rollcalls"))) {
    if (!session.isDirectory()) continue;
    for (const f of listDir(path.join(dataDir, "rollcalls", session.name))) {
      if (!f.isFile() || !f.name.endsWith(".json")) continue;
      const rc = readJson<{ groups?: { group?: string }[]; votes?: { group?: string }[] }>(path.join(dataDir, "rollcalls", session.name, f.name));
      for (const g of rc?.groups ?? []) if (g.group) rollCallGroups.push(g.group);
      // `votes[].group` にしか無い会派も `.rollcall-group-name` で描かれる（`unlistedGroups()`）。
      // ここを読まないと「票にだけ現れた新しい会派」が静かにシステム書体になる（#520 のレビュー指摘）
      for (const v of rc?.votes ?? []) if (v.group) rollCallGroups.push(v.group);
    }
  }

  const speakerPositions: string[] = [];
  const localVoteMarks: string[] = [];
  for (const e of listDir(path.join(dataDir, "members"))) {
    if (e.isDirectory()) {
      for (const s of readJson<{ speeches?: { position?: string }[] }>(path.join(dataDir, "members", e.name, "speeches.json"))?.speeches ?? []) {
        if (s.position) speakerPositions.push(s.position);
      }
    } else if (e.name.endsWith(".json") && e.name !== "index.json" && e.name !== "by-assembly.json") {
      for (const t of readJson<{ timeline?: { kind?: string; vote?: { raw?: string } }[] }>(path.join(dataDir, "members", e.name))?.timeline ?? []) {
        if (t.kind === "localVote" && t.vote?.raw) localVoteMarks.push(t.vote.raw);
      }
    }
  }
  // `/coverage` は議会名を明朝700（`.coverage-assembly__name`）で描く。
  // ETL が新しい県議会を足す経路なので、読まないと追加のたびに気づけない穴になる（#520 のレビュー指摘）
  const assemblyNames = (readJson<{ name?: string }[]>(path.join(dataDir, "assemblies", "index.json")) ?? []).flatMap((a) => (a.name ? [a.name] : []));

  return { members, speakerPositions, rollCallGroups, localVoteMarks, assemblyNames };
}
