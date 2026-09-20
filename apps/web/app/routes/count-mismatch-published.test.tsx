import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { Assembly } from "@seiji-kiroku/shared";
import type { LocalAssemblyMeta } from "../lib/data-contract";
import { defaultDataDir, readAssemblies, readLocalAssemblyMetas } from "../lib/data-files";
import { countMismatchSummary } from "../lib/count-mismatch";
import { CoveragePage } from "./coverage";
import { billsBySession, dataset } from "../test-fixtures/dataset";

/**
 * #826 の本丸: **本番の `data/` に書いた突き合わせの結果が、画面にも出ていること。**
 *
 * **fixture だけだと、ETL が書いた欄と画面のつなぎが切れても緑のままになる**——
 * **それが #800 で実際に起きていたこと**（`meta.lossyNameMatches` を 11 県すべてに書いたのに
 * `grep -rn lossyNameMatches apps/web` が 0 件だった）。
 *
 * **本番の食い違いは今 0 件である**（下で数える）。**だから「該当が 1 件以上ある」を前提にできない。**
 * **代わりに母数が画面に出ていることを見る**——**#757 の言う「0 件」は「見た上での 0」でなければ
 * 意味が無く、それを担保するのは母数だけだから。**
 */

const DATA = defaultDataDir();

async function realLocalMetas(): Promise<LocalAssemblyMeta[]> {
  const metas = await readLocalAssemblyMetas(DATA);
  expect(metas, "assemblies/index.json が読めない").not.toBeNull();
  return metas ?? [];
}

const SECTION = "記号の数と公表された賛成者数・反対者数の突き合わせ";

async function renderCoverage(metas: LocalAssemblyMeta[]) {
  const assemblies = (await readAssemblies(DATA)) as Assembly[];
  render(
    <MemoryRouter>
      <CoveragePage data={{ ...dataset, assemblies }} billsBySession={billsBySession} localMetas={metas} />
    </MemoryRouter>,
  );
}

describe("#826 本番データ: 記号の数と公表値の突き合わせが画面に出る", () => {
  it("11 県すべての meta.json に countChecked がある（前提の確認。無ければ以降の検査は空回りしている）", async () => {
    const metas = await realLocalMetas();
    const local = metas.filter((m) => m.assemblyId.startsWith("pref-"));
    expect(local.length).toBe(11);
    for (const m of local) expect(countMismatchSummary(m), `${m.assemblyId} に countChecked が無い`).not.toBeNull();
  });

  it("本番の母数と食い違いの件数を固定する（測定の固定。変わったら数え直すこと）", async () => {
    const metas = await realLocalMetas();
    const local = metas.filter((m) => m.assemblyId.startsWith("pref-"));
    const sum = (f: (s: NonNullable<ReturnType<typeof countMismatchSummary>>) => number) =>
      local.reduce((n, m) => n + f(countMismatchSummary(m)!), 0);
    expect({
      rows: sum((s) => s.rows),
      checked: sum((s) => s.checked),
      noCounts: sum((s) => s.noCounts),
      unreadableCells: sum((s) => s.unreadableCells),
      mismatches: sum((s) => s.mismatches),
      // ## **#829 で 1,023 → 1,030 / 341 → 334 に動いた**（2026-09-14）
      // **#826 の担当者が「#829 がマージされて行の読み方が変わると変わりうる。
      // その場合は本 PR のテストが落ちて知らせる」と書いたとおりに落ちたので、実測に直した。**
      // **動いたのは秋田の 7 件だけ**——**ページ下端のページ番号が `counts` の数字に混ざって
      // 「数字が 4 つある」状態になり、`counts` が丸ごと捨てられていた**（#829 が直した）。
      // **「公表記録に無い」のではなく「我々が読み落としていた」**ので、
      // **7 件は母数の外ではなく中に入るのが正しい。**
      // **採決の数 1,369 と「凡例が引けない 5」は 1 件も動いていない。**
      //
      // ## **#901 で 1,369 → 1,785 / 1,030 → 1,355 / 5 → 48 に動いた**（2026-09-20。三重と徳島）
      // **三重の `--sessions` の既定を 2 → 4 にした**（一般選挙の手前まで）。
      // **増えた 368 本のうち 43 本に「凡例の引けないセル」がある**——
      // **令和6年10月の 下野幸助（10月10日に議員辞職）の列を PDF が空欄にしており、
      // 推定せず `不明` で残した**（#569）。**その 43 本は突き合わせの外に出る。**
      // **三重のぶんでは `noCounts` 334 は動かなかった**（三重は 733 / 733 本すべてに `counts` がある）。
      // **徳島も 2 → 4 にした**（105 → 153）——**徳島の PDF には `counts` の欄が無いので、
      // 増えた 48 本はそのまま `noCounts` に入る**（**334 → 382**。`checked` は **1,355 のまま**）。
      // **食い違いは 0 のまま。**
      //
      // ## **#901 で 1,785 → 1,902 に動いた**（2026-09-20。高知）
      // **高知の `--sessions` の既定を 2 → 5 にした**（104 → 221）。
      // **高知の PDF には `counts` の欄があるが、`kochi/rollcalls.ts` が `LocalRollCall` に
      // 載せていない**ので、**221 本がまるごと `noCounts` に入る**（**382 → 499**。
      // **104 本ぶんは既に入っていたので +117**）。**`checked` は 1,355 のまま、`unreadableCells` も 48 のまま。**
      //
      // ## **秋田も 5 → 29 本会議日にした**（採決 157 → 785。別の PR）
      // **`checked` は 157 → 554 に増え、食い違いは 0 のまま**（**増えた 397 件も公表値と合っている**）。
      // **残る 231 件は反対者数の欄が PDF で空**なので `noCounts` に入る（**499 → 730**）。
      // **「空欄 = 反対 0」と読む実装を書いて 154 本で測ったが、180 行が嘘になるので採らなかった**
      // （`packages/etl/src/sources/local/akita/votes-pdf.ts` の docblock）。
      // **食い違いは 0 のまま。**
    }).toEqual({ rows: 2530, checked: 1752, noCounts: 730, unreadableCells: 48, mismatches: 0 });
  });

  it("/coverage に、本番の母数（1,752 件）と食い違い（0 件）と未突合の内訳が出る", async () => {
    await renderCoverage(await realLocalMetas());
    const section = screen.getByRole("region", { name: SECTION });
    // **母数が出ていること**（#757。「0 件」は「見た上での 0」でなければ意味が無い）
    expect(section).toHaveTextContent("1,752");
    // **突き合わせなかった 730 件と 48 件の内訳も出す**（黙って母数から外さない）
    expect(section).toHaveTextContent("730");
    expect(section).toHaveTextContent("48");
    // **今は食い違いが無い**、を母数つきで言う
    expect(within(section).getByTestId("coverage-count-mismatch-none")).toBeInTheDocument();
  });

  it("本番に食い違いが出たら、その議会のブロックが画面に出る（今 0 件なので、本番の meta に 1 行足して確かめる）", async () => {
    const metas = await realLocalMetas();
    const saga = metas.find((m) => m.assemblyId === "pref-41");
    expect(saga, "pref-41 の meta.json が読めない").toBeDefined();
    // **本番のファイルは書き換えない。** 読み込んだ値のコピーに、山梨と同じ形の行を 1 つ足す
    const withOne: LocalAssemblyMeta[] = metas.map((m) =>
      m.assemblyId === "pref-41"
        ? ({ ...m, countMismatches: [{ rollCallId: "pref-41-2026-06-teirei-list06680-20260701-甲第36号議案", counted: { yes: 37, no: 0 }, published: { yes: 36, no: 0 } }] } as LocalAssemblyMeta)
        : m,
    );
    await renderCoverage(withOne);
    const section = screen.getByRole("region", { name: SECTION });
    const block = within(section).getByTestId("coverage-count-mismatch-pref-41");
    expect(block).toHaveTextContent("37");
    expect(block).toHaveTextContent("36");
    expect(within(block).getByRole("link", { name: /甲第36号議案/ })).toHaveAttribute(
      "href",
      "/assemblies/pref-41/rollcalls/pref-41-2026-06-teirei-list06680-20260701-甲第36号議案",
    );
  });
});
