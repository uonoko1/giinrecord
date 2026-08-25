import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

/**
 * 回帰テスト（2026-08-25、#244 の CI 失敗）: **並び順を実行環境のロケールに依存させない。**
 *
 * `matchCommitteeRoles` が委員会名を `localeCompare` で並べていたため、手元（`LANG=ja_JP`）では
 * 読み順（けんぽう < ないかく < よさん）、CI（`LANG` 未設定＝`en-US`）ではコードポイント順
 * （予 U+4E88 < 内 U+5185 < 憲 U+61B2）になり、**手元で緑・CI で赤**になった。
 * 本番でも実行環境しだいで議員ページの表示順が変わるので、フレークではなく実装の欠陥だった。
 *
 * **なぜ振る舞いのテストでは足りないか（実測）**: `localeCompare` に戻したうえで
 * `match-committee.test.ts` を走らせると、`ja_JP` では 5 件落ちるが **CI と同じ `en-US` では
 * 17 件すべて通る**。`en-US` ではこの文字列に限って `localeCompare` の結果がコードポイント順と
 * 一致してしまい、**そもそも差が観測できない**ためで、どんな黒箱テストでも CI では検出できない。
 * したがって検査対象を「振る舞い」ではなく **ソースそのもの**にする（ロケールに依存しない）。
 *
 * 許すのは ASCII だけを比べる `localeCompare`（ISO 日付・英数字の id）。この範囲では
 * ロケールによらず結果が同じで、既存コード（`aggregate.ts` の日付、`rollcall.ts` の id）が使っている。
 * 日本語を含みうるキー（氏名・委員会名・会派名・議案名）に使うと今回の事故になる。
 */
const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "../src");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** コメント（// と / * … * /）を落とす。説明文の中の localeCompare を拾わないため。 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("並び順がロケールに依存しない（#244 の CI 失敗の回帰）", () => {
  const files = tsFiles(SRC);

  test("packages/etl/src に .localeCompare( を書かない（コードポイント順の cmp を使う）", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const [i, line] of code.split("\n").entries()) {
        if (line.includes(".localeCompare(")) offenders.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`);
      }
    }
    assert.deepEqual(offenders, [],
      `localeCompare は実行環境のロケールで結果が変わります（日本語の並びが手元と CI で入れ替わる）。\n` +
      `代わりに cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0) を使ってください:\n${offenders.join("\n")}`);
  });

  test("前提の確認: ja-JP と codepoint で実際に並びが食い違う（この検査が空振りでないこと）", () => {
    const committees = ["予算委員会", "内閣委員会", "憲法審査会"];
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    assert.deepEqual([...committees].sort(cmp), ["予算委員会", "内閣委員会", "憲法審査会"]);
    assert.deepEqual([...committees].sort((a, b) => a.localeCompare(b, "ja-JP")), ["憲法審査会", "内閣委員会", "予算委員会"]);
  });
});
