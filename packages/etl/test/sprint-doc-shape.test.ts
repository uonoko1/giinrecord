import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Issue #682: **スプリント文書に共通の型が無く、「次に持ち越すもの」を 3 回中 2 回落とした。**
 *
 * PO の実測（2026-09-09）:
 *
 * ```
 * sprint-22: スプリントゴール / 完了 / 1〜4（個別の話題）/ 計測
 * sprint-23: ゴール / レビュー（成果）/ レトロスペクティブ / 計測 / 次に持ち越すもの
 * sprint-24: ゴール / 本番に出したもの / マージしたもの / 起票したもの / … （持ち越し無し）
 * sprint-25: ゴール / 本番に出したもの / マージしたもの / … / 次に持ち越すもの（#681 で後から足した）
 * ```
 *
 * **「次に何をやるか」が文書に無いと、次のスプリントの計画が毎回ゼロから始まる。**
 * 実際に Sprint 26 のプランニングで、PO は Sprint 24 から何も引き継げず、
 * `docs/research/local-assemblies.md` を読み直して PBI を作り直した。
 *
 * ## なぜ「注意する」では足りないのか
 *
 * **3 回中 2 回落としている。** 落とした本人（PO）は毎回「次は気をつける」と思っており、
 * それでも #681 で後から足すまで気づかなかった。**書き忘れは、書いた人からは見えない。**
 * だから機械で見る。
 *
 * ## 必須をこの 3 つに絞った理由
 *
 * `ゴール` / `本番に出したもの` / `次に持ち越すもの` の 3 つだけを必須にした。
 * **必須を増やすと「型を満たすために書く」ようになり、中身が薄くなる**（#682 の注意書き）。
 * `マージしたもの` `落としたもの` `数字` は、回によって本当に書くことが無いので任意にした。
 *
 * `本番に出したもの` を必須にしたのは、**「リリースされて初めて成果物」**という
 * このチームの原則をスプリント文書が体現する唯一の節だからである。
 * 出なかった回も「出なかった」と書けばよい（TEMPLATE.md にそう書いてある）ので、
 * 空を強いる節にはならない。
 *
 * ## なぜ Sprint 26 以降なのか（過去に遡らない理由）
 *
 * **過去のスプリント文書は当時の記録なので書き換えない**（#682 の注意書き）。
 * その上で、実測すると **25 以前は今の型を満たしていない**:
 *
 *   - sprint-22 以前: `本番に出したもの` も `次に持ち越すもの` も無い
 *     （`レビュー（成果）` / `完了` / `計測` という別の語彙で書かれている）
 *   - sprint-23: `本番に出したもの` が無い（`レビュー（成果）` に混ざっている）
 *   - sprint-24: `次に持ち越すもの` が無い（**これが #682 の被害そのもの**）
 *   - sprint-25: 3 つとも在る（`次に持ち越すもの` は #681 で後から足したもの）
 *
 * つまり「25 以降」にすると通ってしまうが、それは **25 が偶然通るだけ**で、
 * 24 を落とすことはできない（24 は直せないので、落としたままにはできない）。
 * **この型は「これから書く文書」に効かせるものである。** だから境界は
 * **この検査が入った次の回＝Sprint 26** に置いた。
 *
 * **境界を上げて黙らせる道は塞いである**（下の `FIRST_ENFORCED_SPRINT` の test）。
 * 落ちたときに 27 へ上げれば通るようでは、注意書きと同じで意味が無い。
 *
 * ## 検査が空回りしないための作り
 *
 * **境界を 26 に置いた時点で、対象が 0 件の期間がある**（この PR の時点では 0 件）。
 * 対象 0 件で `assert.deepEqual(missing, [])` を書いても、それは**恒真**である。
 * だから 3 つに分けてある:
 *
 *   1. `missingSections()` という**関数そのもの**を、in-memory の文字列に当てて固定する
 *      （対象ファイルが 1 件も無くても、判定の中身が壊れたら落ちる）
 *   2. `TEMPLATE.md` を**その関数に通す**（雛形は常に型を満たす。＝常に 1 件は実物を測っている）
 *   3. `docs/sprints/sprint-N.md`（N >= 26）を全部通す（回が増えたら自動で対象になる）
 *
 * ## なぜ etl の node:test なのか
 *
 * #513 / #662 と同じ。**検査対象と同じディレクトリに置いた見張りは、対象ごと消せる。**
 * `docs/sprints/` の中に検査を置くと、`docs/sprints/` を触る PR がそれごと消せてしまう。
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const SPRINTS = "docs/sprints";
const TEMPLATE = `${SPRINTS}/TEMPLATE.md`;

const read = (p: string) => readFileSync(resolve(root, p), "utf8");

/**
 * **必須の節**（見出しの先頭一致で照合する）。
 *
 * 先頭一致にしているのは、既存の文書が `## 本番に出したもの（「リリースされて初めて成果物」）`
 * のように**括弧で補足を付けている**ため。補足は書き手の自由にしたいが、
 * **語の先頭は固定する**（`## 本番に出せたもの` は別の語なので落ちる）。
 */
const REQUIRED_SECTIONS: readonly string[] = [
  "ゴール",
  "本番に出したもの",
  "次に持ち越すもの",
];

/**
 * **この回以降のスプリント文書に型を要求する。**
 *
 * 26 である理由は docblock の「なぜ Sprint 26 以降なのか」。
 * **落ちたからといってここを上げないこと**——下の test がハードコードした値と突き合わせる。
 */
const FIRST_ENFORCED_SPRINT = 26;

/** `## ゴール` `### x` などの見出しから、レベルと題を取り出す。 */
const headings = (md: string): { level: number; title: string }[] =>
  md
    .split("\n")
    .map((l) => /^(#{1,6})\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ level: m[1].length, title: m[2].trim() }));

/**
 * `md` に無い必須の節を返す。**空配列なら型を満たしている。**
 *
 * `##`（レベル 2）の見出しだけを見る。**`###` の小見出しでは満たせない**——
 * sprint-13 の `### 調査（Sprint 14 の土台）` のように、小見出しは回ごとの話題であって
 * 文書の骨格ではないため。骨格は `##` に揃える（TEMPLATE.md がそうなっている）。
 */
export const missingSections = (md: string): string[] => {
  const h2 = headings(md)
    .filter((h) => h.level === 2)
    .map((h) => h.title);
  return REQUIRED_SECTIONS.filter(
    (req) => !h2.some((t) => t.startsWith(req)),
  );
};

/** `docs/sprints/sprint-<N>.md` を N 付きで列挙する（TEMPLATE.md は含まない）。 */
const sprintDocs = (): { n: number; path: string }[] =>
  readdirSync(resolve(root, SPRINTS))
    .map((name) => ({ name, m: /^sprint-(\d+)\.md$/.exec(name) }))
    .filter((x): x is { name: string; m: RegExpExecArray } => x.m !== null)
    .map((x) => ({ n: Number(x.m[1]), path: `${SPRINTS}/${x.name}` }))
    .sort((a, b) => a.n - b.n);

test("#682 判定そのものを固定する（対象が 0 件でも、判定が壊れたら落ちる）", () => {
  // **対象ファイルに依らない。** 境界を 26 に置いたので、対象が 0 件の期間がある。
  // そのとき対象を回すだけの test は恒真になる。ここは関数の性質だけを見る。
  const full = [
    "# Sprint 99",
    "## ゴール",
    "## 本番に出したもの（補足）",
    "## 次に持ち越すもの",
  ].join("\n");
  assert.deepEqual(
    {
      // 3 つ揃っていれば空。括弧の補足があっても先頭一致で通る。
      full: missingSections(full),
      // 1 つ落とすと、その名前が返る。**これが #682 の被害そのもの（sprint-24）。**
      noCarryOver: missingSections(full.replace("## 次に持ち越すもの", "")),
      noProduction: missingSections(
        full.replace("## 本番に出したもの（補足）", ""),
      ),
      noGoal: missingSections(full.replace("## ゴール", "")),
      // 空文書なら 3 つとも返る。
      empty: missingSections(""),
      // **`###` では満たせない**（骨格は `##` に揃える）。
      h3Only: missingSections(
        full.replace("## 次に持ち越すもの", "### 次に持ち越すもの"),
      ),
      // **語の先頭は固定する。** 言い換えは別の語として落ちる。
      renamed: missingSections(
        full.replace("## 次に持ち越すもの", "## 次にやること"),
      ),
      // 見出しではない本文中の言及では満たせない（`#` が無い行）。
      proseOnly: missingSections(
        full.replace("## 次に持ち越すもの", "次に持ち越すものは無い"),
      ),
      // 先頭一致なので、前に何か付くと落ちる（`## 補足：次に持ち越すもの`）。
      prefixed: missingSections(
        full.replace("## 次に持ち越すもの", "## 補足：次に持ち越すもの"),
      ),
    },
    {
      full: [],
      noCarryOver: ["次に持ち越すもの"],
      noProduction: ["本番に出したもの"],
      noGoal: ["ゴール"],
      empty: ["ゴール", "本番に出したもの", "次に持ち越すもの"],
      h3Only: ["次に持ち越すもの"],
      renamed: ["次に持ち越すもの"],
      proseOnly: ["次に持ち越すもの"],
      prefixed: ["次に持ち越すもの"],
    },
    `missingSections の判定が変わっている。
**この test は対象ファイルを 1 つも読んでいない**ので、docs/sprints/ が空でも落ちる。
判定を緩めて黙らせないこと——落ちているなら、緩めた側を戻す。`,
  );
});

test("#682 雛形が在り、雛形自身が型を満たす（雛形と検査がずれたら落ちる）", () => {
  assert.ok(
    existsSync(resolve(root, TEMPLATE)),
    `${TEMPLATE} が無い。**次に書く人がコピーする雛形**で、
これが無いと型は「どこにも書いていない決まり」になり、#682 の再発になる。`,
  );
  const md = read(TEMPLATE);
  assert.deepEqual(
    missingSections(md),
    [],
    `${TEMPLATE} が、この検査の必須の節を満たしていない: ${missingSections(md).join(" / ")}
**雛形だけ直して検査が古いまま（またはその逆）を防ぐのがこの test である。**
節名を変えるなら、${TEMPLATE} と REQUIRED_SECTIONS の両方を同時に変えること。`,
  );
});

test("#682 雛形は必須の節を必須だと明記し、検査の在処を指している（写経だけの雛形にしない）", () => {
  // 雛形が「必須の節がある」ことを言っていないと、コピーした人は節を消してよいと思う。
  // また、**検査の在処を書いておかないと、落ちたときに何を直せばよいか分からない。**
  const md = read(TEMPLATE);
  const required = [
    "packages/etl/test/sprint-doc-shape.test.ts", // 検査の在処
    "REQUIRED_SECTIONS", // 何を直せば節名を変えられるか
    "必須", // 必須と任意の区別がある
    "Sprint 26 以降", // 適用範囲
  ];
  const missing = required.filter((r) => !md.includes(r));
  assert.deepEqual(
    missing,
    [],
    `${TEMPLATE} から、雛形を雛形たらしめている記述が消えている:
${missing.map((m) => `  - [${m}]`).join("\n")}

節の見出しだけ並べた雛形は、**コピーした人が節を消してよいのか分からない。**`,
  );
});

test(`#682 Sprint ${FIRST_ENFORCED_SPRINT} 以降のスプリント文書は必須の節を持つ（どの回のどの節かを名指しする）`, () => {
  const targets = sprintDocs().filter((d) => d.n >= FIRST_ENFORCED_SPRINT);
  const violations = targets
    .map((d) => ({ d, missing: missingSections(read(d.path)) }))
    .filter((x) => x.missing.length > 0)
    .map((x) => `${x.d.path}: ${x.missing.join(" / ")} が無い`);
  assert.deepEqual(
    violations,
    [],
    `スプリント文書に必須の節が無い:
${violations.map((v) => `  - ${v}`).join("\n")}

雛形は ${TEMPLATE}。**「次に持ち越すもの」は Issue 番号と、なぜ持ち越したかを書く。**
持ち越しが無い回は「無し」と書く——**節ごと消さないこと**（消せることが #682 の原因）。`,
  );
});

test("#682 過去の回（25 以前）は対象外のままである（境界を上げて黙らせない）", () => {
  // **落ちたときに FIRST_ENFORCED_SPRINT を上げれば通る、では注意書きと同じである。**
  // ここが値そのものを固定するので、上げるとこの test が落ちて diff に出る。
  //
  // 下げる（＝より厳しくする）ぶんには落ちない、という作りにはしていない。
  // 25 以前は**書き換えない前提**で、下げれば必ず落ちるからである（実測は下の test）。
  assert.equal(
    FIRST_ENFORCED_SPRINT,
    26,
    `FIRST_ENFORCED_SPRINT が 26 から動いている。
**上げると、落ちている回をそのまま対象外にできてしまう**（#682 の再発）。
**下げると、書き換えられない過去の記録（22/23/24）が落ちる。**
動かすなら、なぜ動かすかをこのファイルに書くこと。`,
  );
});

test("#682 25 以前を対象にすると実際に落ちる（境界が意味を持っていることの実測）", () => {
  // **この test が無いと、境界の値だけを固定していることになり、
  // 「26 以降には 1 件も対象が無いから通っているだけ」と区別がつかない。**
  // ここは**対象外にしている回が、本当に今の型を満たしていない**ことを実物で示す。
  // （＝上の「26 以降」の test が緑なのは、恒真だからではなく境界を選んだ結果である）
  const past = sprintDocs()
    .filter((d) => d.n < FIRST_ENFORCED_SPRINT)
    .map((d) => ({ n: d.n, missing: missingSections(read(d.path)) }))
    .filter((x) => x.missing.length > 0);
  assert.ok(
    past.length > 0,
    `25 以前のスプリント文書が全部いまの型を満たしている。
**それなら境界は要らない**ので、FIRST_ENFORCED_SPRINT を下げること。`,
  );
  // **#682 の被害そのもの**を名指しで固定する。sprint-24 に「次に持ち越すもの」が無いことが
  // この PBI の起点なので、ここが「実は在った」に変わったら、この PBI の前提が変わっている。
  const s24 = past.find((x) => x.n === 24);
  assert.deepEqual(
    s24?.missing,
    ["次に持ち越すもの"],
    `sprint-24 の欠落が、#682 の起点（「次に持ち越すもの」が無い）と違っている: ${JSON.stringify(s24)}
**過去の記録は書き換えない。** 24 に節を足したのなら、この test の期待も直すこと。`,
  );
});
