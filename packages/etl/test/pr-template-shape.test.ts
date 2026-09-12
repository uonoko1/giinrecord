import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Issue #725: **PR の雛形が「実態に追い越されて」死んでいた。**
 *
 * PO は直近 6 本で 0 本と数えた。全 PR を数え直すと、もっと明確だった（実測 2026-09-09、
 * `gh pr list --state all --limit 1000 --json number,body,createdAt`、全 440 本）:
 *
 * ```
 * 2026-08-22  PR数=60  「## TDD の痕跡」あり=27
 * 2026-08-23  PR数=54  あり=13
 * 2026-08-24  PR数=35  あり=0     ← ここで死んだ
 * 2026-08-25  PR数=26  あり=1     ← PR #281 が最後
 * 2026-08-26 以降 …    あり=0
 * ```
 *
 * **PR #281 より後に作られた 274 本のうち、旧雛形の 5 節を含むものは 1 本**
 * （`## TDD の痕跡` に限れば 0 本）。
 *
 * ## なぜ誰も使わなかったか（PO の見立ては当たっていた）
 *
 * **`gh pr create` に `--body` / `--body-file` を渡すと、雛形は読まれない。**
 * `gh pr create --help` に `A prompt will also ask for the title and the body.
 * Use --title and --body to skip this` とあり、`--template` は**別の opt-in フラグ**である。
 * 担当者は毎回、指示テキスト（「本文は日本語」「本文末尾に…」）に従って本文を組み立て、
 * `--body` で渡している。**その経路にファイルは 1 度も登場しない。**
 *
 * 傍証: 直近 115 本（2026-09-06 以降）のうち **111 本が `Generated with` の脚注**を、
 * **108 本が `claude.ai/code/session` の行**を持つ。これらは雛形には無く、指示テキストにしか無い。
 * **つまり本文は雛形ではなく指示から作られている。**
 *
 * ## だから「書き直す」（案 A）だけでは同じことが起きる
 *
 * 雛形を実態に合わせても、**読まれない経路は読まれないまま**である。
 * 一方 **案 C（CI で PR 本文を検査する）は採らなかった**。理由は
 * `sprint-doc-shape.test.ts` の docblock と同じで、
 * **必須を増やすと「型を満たすために書く」ようになり中身が薄くなる**（#682）。
 * PR 本文は書き手の思考そのものなので、機械で節を強制すると最も薄くなる場所である。
 *
 * ## この検査が守るもの（PR 本文ではなく、雛形そのもの）
 *
 * **本文は検査しない。雛形が実態から再び乖離することを検査する。**
 * 雛形が死んだのは「誰も見ないまま 274 本が過ぎた」からで、
 * **乖離は、乖離した本人からは見えない**（#682 の「書き忘れは書いた人からは見えない」と同型）。
 *
 *   1. 雛形が、実際の PR が使っている 6 節を持つこと
 *   2. 雛形が、**この経路の限界そのもの**（`--body` を渡すと出ない）を明記していること
 *      ——これを消すと、次の担当者はまた「置いたのに使われない」を繰り返す
 *
 * `missingSections()` を in-memory の文字列にも当てている。
 * **雛形を 1 つ読むだけの検査は、判定が壊れても気づけない**（#682 の「恒真」対策と同じ）。
 *
 * ## なぜ etl の node:test なのか
 *
 * #513 / #662 / #682 と同じ。**検査対象と同じディレクトリに置いた見張りは、対象ごと消せる。**
 * `.github/` の中に検査を置くと、`.github/` を触る PR がそれごと消せてしまう。
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const TEMPLATE = ".github/pull_request_template.md";

const read = (p: string) => readFileSync(resolve(root, p), "utf8");

/**
 * **必須の節**（見出しの先頭一致で照合する）。
 *
 * 実測（2026-09-09、2026-09-06 以降の PR 115 本、`^#+ .*<語>` を行頭一致で数えた）:
 *
 * ```
 * 何が問題   63 / 115      変異     58 / 115
 * どう直した 52 / 115      対象外   61 / 115
 * 測った数字 63 / 115      自信     53 / 115
 * ```
 *
 * **どれも過半数前後で、旧雛形の 5 節（274 本中 1 本）とは桁が違う。**
 * これが「実態」である。
 */
const REQUIRED_SECTIONS: readonly string[] = [
  "何が問題だったか",
  "どう直したか",
  "測った数字",
  "変異テストの結果",
  "対象外にしたもの",
  "自信が無い点",
];

/** `## 何が問題だったか` などの見出しから、題を取り出す。 */
const headings = (md: string): string[] =>
  md
    .split("\n")
    .map((l) => /^#{1,6}\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1].trim());

/** 必須の節のうち、見出しとして現れないものを返す（先頭一致）。 */
const missingSections = (md: string): string[] => {
  const hs = headings(md);
  return REQUIRED_SECTIONS.filter((s) => !hs.some((h) => h.startsWith(s)));
};

test("#725: missingSections() 自体が、雛形を読まなくても判定として正しい", () => {
  // 全部ある
  const full = REQUIRED_SECTIONS.map((s) => `## ${s}\n\n本文\n`).join("");
  assert.deepEqual(missingSections(full), []);

  // 括弧の補足は許す（先頭一致）
  assert.deepEqual(
    missingSections(full.replace("## 測った数字", "## 測った数字（測り方つき）")),
    [],
  );

  // 節が 1 つ欠けたら、その節だけを名指しする
  assert.deepEqual(
    missingSections(full.replace("## 自信が無い点", "## どうでもいい節")),
    ["自信が無い点"],
  );

  // **見出しでなく地の文にあるだけでは通さない**（「変異テストの結果は省略」と書いて
  // 節を消す逃げ道を塞ぐ）。旧雛形が死んだのは節が形骸化したからで、語の出現では測れない。
  assert.deepEqual(missingSections("変異テストの結果 は無し\n"), REQUIRED_SECTIONS);

  // 空文字はすべて欠けている
  assert.deepEqual(missingSections(""), REQUIRED_SECTIONS);
});

test("#725: PR の雛形が、実際の PR が使っている節を持つ", () => {
  const md = read(TEMPLATE);
  assert.deepEqual(
    missingSections(md),
    [],
    `${TEMPLATE} に必須の節が足りない。
実測（2026-09-09）で直近 115 本の PR の過半数前後がこの節立てを使っている。
雛形を実態から外すと、また 274 本のあいだ誰も見ない状態に戻る。`,
  );
});

test("#725: 雛形が「--body を渡すと出ない」という経路の限界を明記している", () => {
  const md = read(TEMPLATE);
  // これを消すと、次の担当者は「雛形を置いたのに使われない」を繰り返す。
  // #725 の核心は節の中身ではなく、**雛形が読まれない経路がある**という事実のほうにある。
  assert.ok(
    /--body/.test(md),
    `${TEMPLATE} から「--body を渡すと雛形は読まれない」旨の記述が消えている。
これが #725 の根本原因（PR #281 以降 274 本で不使用）なので、雛形自身に残すこと。`,
  );
});
