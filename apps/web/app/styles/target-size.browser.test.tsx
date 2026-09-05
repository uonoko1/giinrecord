import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Assembly } from "@seiji-kiroku/shared";
import type { AssemblySession, RollCallSummary } from "../lib/data-contract";
import type { Dataset, MemberSummary } from "../lib/dataset";
import assembliesFixture from "../test-fixtures/assemblies/index.json";
import localMembers from "../test-fixtures/assemblies/members-index.json";
import sessionsFixture from "../test-fixtures/assemblies/sessions.json";
import rollcallsIndex from "../test-fixtures/data/rollcalls/index.json";
import fixtureMeta from "../test-fixtures/meta";
import { dataset, members, membersByAssembly } from "../test-fixtures/dataset";
import Home from "../routes/home";
import { AssemblyPage } from "../routes/assembly";
import { RollCallsPage } from "../routes/rollcalls";

/**
 * WCAG 2.2 の 2.5.8（Target Size (Minimum)、AA）で **間隔（Spacing 例外）で合格している行**を、
 * **実ブラウザが解いた computed style** で守る。Issue 481（穴の指摘）/ #470（継承の鎖）/ 判断は #424。
 *
 * ## なぜ隣に `target-size.test.ts` があるのにこれを足すのか
 *
 * `target-size.test.ts` は `inheritedLineHeight(css, chain)` に**手で書いた鎖**を渡す:
 *
 *     .row              [".row a", ".row", ".rows"]
 *     .rollcalls-item   [".rollcalls-item a", ".rollcalls-item", ".rollcalls-list"]
 *     .list__item       [".list__item a", ".list__item", ".list"]
 *     .assembly-sessions td   [".assembly-sessions td", ".assembly-sessions"]
 *
 * **鎖は手で書いた範囲までしか遡らない。** #481 のレビュアーが実測した素通りが 4 件あり、
 * **この worktree でも 4 件すべて再現した**（`main` の `fe13f9e4` で `24 passed` のまま）:
 *
 *     .section { line-height: 0.1 }      素通り  ← `.rows` の**実際の DOM 上の親**（home.tsx:132）
 *     body { line-height: 0.1 }          素通り
 *     :root { line-height: 0.1 }         素通り
 *     @media (…) { .rows { … } }         素通り  ← `declarationsFor` が `CSSStyleRule` しか見ない
 *
 * `.section` が最も現実的である。**実在する DOM 上の親**なので、誰かがそこに `line-height` を
 * 書く可能性は十分ある。**いまは壊れていない**（`:root` / `body` / `html` / `*` / `.section` に
 * `line-height` は 1 件も無い。CSS 全体で 24 件を数えて確認した）——**守られていないだけ**である。
 *
 * 鎖を手で伸ばしても（`:root` / `body` / `html` / `*` を末尾に足す案）**`.section` は拾えない**。
 * `.section` は `.rows` の親だが `.rows` の**鎖には現れない**——「どのクラスが DOM 上の親か」は
 * CSS ファイルからは分からないからである。**鎖を手で書くかぎり、必ず外側が残る。**
 * だから**鎖を書くのをやめて、DOM をブラウザに解かせる**。
 *
 * ## 何を測っているか（**描画された箱の高さではない**）
 *
 * `getComputedStyle` から読むのは 3 つだけで、**そこから先の算術は隣のファイルと同じ**である:
 *
 *     行の箱（padding）      行の要素の computed `padding-top` / `padding-bottom`
 *     文字の大きさ           中のリンクの computed `font-size`
 *     行の高さ               中のリンクの computed `line-height`
 *
 * **`getBoundingClientRect().height` は使わない。** ここには web フォントを当てていないので
 * 描画に使われる face はフォールバックであり、**`line-height: normal` の比が本番と違う**
 * （実測: 13px の行が本番の BIZ UDPGothic では 13px、フォールバックでは 16px）。
 * 箱の高さを読むと**フォント次第で数字が動く**——#431 で 2 度踏んだ穴である。
 *
 * `line-height` が**どこかで宣言されていれば** `getComputedStyle` は **px に解決した値**を返し、
 * **どこにも無いときだけ文字列 `"normal"` を返す**（実測で確認）。つまり:
 *
 *     宣言あり（自分・親・祖先・@media のどこでも）  →  "6.5px" のような px 値をブラウザが解く
 *     宣言がどこにも無い                            →  "normal" → こちらで LINE_HEIGHT_NORMAL に倒す
 *
 * **継承と `@media` の解決だけをブラウザにやらせ、フォント依存の部分は持ち込まない。**
 * だから `target-size.test.ts` と**同じ数字**が出る（境界も同じ。下の検査で固定してある）。
 *
 * ## これは安くない（測った数字を残す）
 *
 * `target-size.test.ts` は 24 件で **1 秒未満**の検査だった。**ブラウザを足すと確実に伸びる。**
 * ローカルで `pnpm vitest run`（web 全体）を 3 回ずつ測った実測:
 *
 *     この検査を外したとき  82.0 / 93.2 / 83.7 s   （987 件）
 *     この検査を入れたとき  114.0 / 141.6 / 124.0 s（994 件）
 *
 * **中央値で +40 秒ほど**（このファイル単体では 10.7 秒。ブラウザ起動 1 回）。
 * CI の `check` ジョブでは `pnpm test` が 65〜90 秒なので、**同じ割合なら 1 分前後は伸びる**。
 * Chromium の**インストールは増えない**——#464 が既に `check` に入れており、
 * 同じキャッシュとブラウザを使う（ここで足すのは**起動 1 回ぶん**である）。
 *
 * **それでも入れる理由**: `.section` は `.rows` の**実在する DOM 上の親**で、誰かが
 * `line-height` を書く可能性が十分ある。**鎖を手で書くかぎり、必ず外側が残る**（伸ばしても
 * `.section` は拾えない）。**穴が閉じないことが分かっている方式**に留まるより、秒を払う。
 *
 * ## なぜ web フォントを読み込まないのか
 *
 * `public/fonts/` は BIZ UDPGothic を **`unicode-range` で数百枚のスライスに割って**配信している。
 * テストで数枚だけ読ませると**スライスに無い文字がフォールバックに落ちて別の数字が出る**
 * （#431 で「昼」「夜」のスライスを読み忘れ、フォールバックの 27px を「実測」と誤って報告した）。
 * 全部読ませるのは重く、`document.fonts.ready` 待ちは #400 で flaky に苦しんだ経路である。
 * **上のとおりフォントに依存しない読み方にしてあるので、そもそも読み込む必要が無い。**
 *
 * ## `LINE_HEIGHT_NORMAL` は隣のファイルと同じ 1.0（勝手に変えない）
 *
 * `--font-body` の BIZ UDPGothic は `line-height: normal` の比が **実測 1.0**（Chromium、
 * font-size 11〜18px・weight 400/700 の全てで）。**フォントを変えるときは測り直すこと。**
 *
 * ## この検査で見えないもの（過信しないこと）
 *
 * - **間隔そのものは測っていない。** ここで見ているのは「縦に並ぶ行の中心間距離 = 行の高さ」で、
 *   横に並ぶターゲット（テーマ切替）は隣のファイルが別に見ている。
 * - **この 4 つの行しか見ていない**（`target-size.test.ts` が鎖を書いている 4 箇所と同じ）。
 *   押せるものが増えても自動では気づかない。
 * - **折り返しが見えない**（2 行になれば箱は倍近くなる。安全側なので許容）。
 * - **`border` / `box-sizing`** は見ていない（現状どちらも行の高さを変えていない）。
 * - **fixture のページに描かれる行だけ**が対象（`.row` と `.list__item` はトップ、
 *   `.assembly-sessions td` は地方議会、`.rollcalls-item` は採決一覧のページ）。
 */

const app = join(__dirname, "..");

/** `app/**\/*.css` を全部。本番が読む集合の**上位集合**にする（#464 と同じ形）。 */
function allCss(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allCss(full));
    else if (entry.name.endsWith(".css")) out.push(full);
  }
  return out.sort();
}

const cssFiles = allCss(app);
const css = cssFiles.map((f) => `/* ${f.slice(app.length + 1)} */\n${readFileSync(f, "utf8")}`).join("\n");

/**
 * 本番のコンポーネントそのままの markup。**手書きの DOM を置かない**——
 * 置くと「本番の DOM 上の親」が食い違い、**この PBI が塞ごうとしている穴をテスト側に作り直す**
 * ことになる（`.section` が `.rows` の親であることは `home.tsx` にしか書いていない）。
 */
const assemblies = assembliesFixture as Assembly[];
const withLocal: Dataset = { ...dataset, assemblies };
const allMembers: MemberSummary[] = [...members, ...(localMembers as MemberSummary[])];
const sessions = new Map<string, AssemblySession[]>([["pref-04", sessionsFixture as AssemblySession[]]]);

/** `.row`（出典と更新）と `.list__item`（最近の採決）はどちらもトップにある */
const homeMarkup = renderToStaticMarkup(
  <MemoryRouter>
    <Home data={dataset} membersByAssembly={membersByAssembly} />
  </MemoryRouter>,
);

/** `.assembly-sessions td`（会期の表）は地方議会のページにある */
const assemblyMarkup = renderToStaticMarkup(
  <MemoryRouter>
    <AssemblyPage id="pref-04" data={withLocal} sessions={sessions} allMembers={allMembers} />
  </MemoryRouter>,
);

/** `.rollcalls-item`（採決一覧の行）は `/rollcalls` にある */
const rollcallsMarkup = renderToStaticMarkup(
  <MemoryRouter>
    <RollCallsPage
      rollcalls={rollcallsIndex as RollCallSummary[]}
      session={undefined}
      onSessionChange={() => {}}
      meta={fixtureMeta}
    />
  </MemoryRouter>,
);

/** このサイトのフォントでの `line-height: normal`。**実測 1.0**（`target-size.test.ts` と同じ値） */
const LINE_HEIGHT_NORMAL = 1;
const MINIMUM = 24;

/**
 * そのセレクタが `line-height` を宣言しているか（**自己検査を条件づけるためだけ**に使う）。
 *
 * 本体の計測はブラウザに任せているので、ここで CSS を読むのは
 * 「**外側の指定が届かないのが正しい状況かどうか**」を判定するときだけである。
 * `@media` の中も含めて見たいので、**素の文字列検索**にしてある——`CSSStyleRule` しか見ない
 * `declarationsFor` を使うと、この判定自体が `@media` を見落とす（それがこの PBI の穴だった）。
 * **多めに拾う側に倒す**（拾いすぎると検査を飛ばすので、最後に `checked > 0` で歯止めをかけている）。
 */
function declaresLineHeight(selector: string): boolean {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `.rows { … line-height: … }` / `.a, .rows { … }` のどちらも拾えるよう、宣言ブロックごと見る
  const re = new RegExp(`(^|[,{}])[^{}]*${escaped}\\s*(,[^{}]*)?\\{[^{}]*line-height\\s*:`, "m");
  return re.test(css);
}

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

interface Row {
  /** 当たった要素の数。**0 なら空振り**なので、検査が成立していない */
  count: number;
  /** 行の高さ（= 縦に並ぶリンクの中心間距離）。要素ごとに出す（1 件でも違えば見える） */
  heights: number[];
  /** 何をどう読んだか（落ちたときに追えるように） */
  detail: { padding: string; fontSize: string; lineHeight: string }[];
}

/**
 * `rowSelector` に当たる行それぞれについて、**行の高さ**を computed style から出す。
 *
 * - `padding` は**行の要素**から読む（行の箱が中心間距離を決めるため）
 * - `font-size` / `line-height` は**中のリンク**から読む（行の高さを決めるのは中身の行の箱）。
 *   リンクが無い行（`.assembly-sessions td` の一部）は行自身から読む
 *
 * `line-height` が `"normal"`（＝ CSS のどこにも宣言が無い）のときだけ `LINE_HEIGHT_NORMAL` に倒す。
 * それ以外はブラウザが px に解いた値をそのまま使う——**継承も `@media` もここで解けている**。
 *
 * `viewport` と `colorScheme` を変えて呼べるようにしてあるのは、**`@media` は条件が合ったときだけ
 * 効く**からである。1 つの幅でしか測らないと、反対向きの `@media`（`min-width`）を見落とす。
 */
async function measure(
  markup: string,
  selectors: readonly (readonly [row: string, content: string])[],
  opts: { width: number; colorScheme: "light" | "dark"; extraCss?: string } = { width: 390, colorScheme: "light" },
): Promise<Row[]> {
  // **1 ページで全部測る。** 行ごとにページを開くと、同じ markup を条件の数だけ描き直すことになり
  // 実測で 4 倍以上遅くなる（行ごとに開く形は 44.9s、この形は 10.7s）。読むのは computed style
  // だけなので、1 つのページから全部の行をまとめて読めば足りる。
  const page = await browser.newPage({ viewport: { width: opts.width, height: 900 }, colorScheme: opts.colorScheme });
  try {
    await page.setContent(`<style>\n${css}\n${opts.extraCss ?? ""}\n</style>\n${markup}`, { waitUntil: "load" });
    const raw = await page.evaluate(
      (sels) =>
        sels.map(([rowSel, contentSel]) =>
          [...document.querySelectorAll(rowSel)].map((row) => {
            // 行の中の「文字の箱を決めるもの」。無ければ行自身（td にリンクが無い行がある）
            const content = row.querySelector(contentSel) ?? row;
            const rc = getComputedStyle(row);
            const cc = getComputedStyle(content);
            return { paddingTop: rc.paddingTop, paddingBottom: rc.paddingBottom, fontSize: cc.fontSize, lineHeight: cc.lineHeight };
          }),
        ),
      selectors as unknown as [string, string][],
    );
    return raw.map((rows) => {
      const heights: number[] = [];
      const detail: Row["detail"] = [];
      for (const r of rows) {
        const fontSize = Number.parseFloat(r.fontSize);
        // **`"normal"` のときだけ**こちらの実測比に倒す。宣言があればブラウザの px 値を使う
        const lineBox = r.lineHeight === "normal" ? fontSize * LINE_HEIGHT_NORMAL : Number.parseFloat(r.lineHeight);
        heights.push(Number.parseFloat(r.paddingTop) + Number.parseFloat(r.paddingBottom) + lineBox);
        detail.push({ padding: `${r.paddingTop} / ${r.paddingBottom}`, fontSize: r.fontSize, lineHeight: r.lineHeight });
      }
      return { count: rows.length, heights, detail };
    });
  } finally {
    await page.close();
  }
}

/** 1 つの行だけを測る薄い包み（変異の検査で使う） */
async function rowHeights(
  markup: string,
  rowSelector: string,
  contentSelector: string,
  opts: { width: number; colorScheme: "light" | "dark"; extraCss?: string } = { width: 390, colorScheme: "light" },
): Promise<Row> {
  return (await measure(markup, [[rowSelector, contentSelector]], opts))[0]!;
}

/**
 * 検査する 4 つの行。**`target-size.test.ts` が鎖を書いている 4 箇所と同じ**である
 * （あちらは CSS の鎖、こちらは実 DOM）。
 */
const HOME_ROWS = [
  { name: ".row（トップ「出典と更新」・余裕が一番少ない）", row: ".row", content: "a" },
  { name: ".list__item（トップ「最近の採決」）", row: ".list__item", content: "a" },
] as const;
const ASSEMBLY_ROWS = [
  { name: ".assembly-sessions td（地方議会の会期の表）", row: ".assembly-sessions td", content: "a" },
] as const;
const ROLLCALL_ROWS = [
  { name: ".rollcalls-item（採決一覧の行）", row: ".rollcalls-item", content: "a" },
] as const;

/** 1 条件ぶんを、ページ 3 枚（トップ / 地方議会 / 採決一覧）で測る */
async function allRows(opts: { width: number; colorScheme: "light" | "dark"; extraCss?: string }) {
  const [home, assembly, rollcalls] = await Promise.all([
    measure(homeMarkup, HOME_ROWS.map((r) => [r.row, r.content] as const), opts),
    measure(assemblyMarkup, ASSEMBLY_ROWS.map((r) => [r.row, r.content] as const), opts),
    measure(rollcallsMarkup, ROLLCALL_ROWS.map((r) => [r.row, r.content] as const), opts),
  ]);
  return [
    ...HOME_ROWS.map((r, i) => ({ ...r, got: home[i]! })),
    ...ASSEMBLY_ROWS.map((r, i) => ({ ...r, got: assembly[i]! })),
    ...ROLLCALL_ROWS.map((r, i) => ({ ...r, got: rollcalls[i]! })),
  ];
}

describe("一覧の行の中心間距離を、実ブラウザの computed style で守る（WCAG 2.5.8・Issue 481 / #470 / 判断は #424）", () => {
  it("検査する行が実際に描かれている（空振りで通るテストにしない）", async () => {
    for (const r of await allRows({ width: 390, colorScheme: "light" })) {
      expect(r.got.count, `${r.row} が 1 つも描かれていない（fixture かコンポーネントが変わった）`).toBeGreaterThan(0);
    }
  }, 120_000);

  /**
   * **これが本体。** 49 箇所の行は 2.5.8 の **Spacing 例外**（隣のターゲットの中心まで 24px 以上）で
   * 合格しており、**大きさでは合格していない**（`docs/research/target-size-rows.md`）。
   * だからここで守るのは**大きさではなく間隔** ＝ 縦に並ぶ行の中心間距離である。
   *
   * `.row` は余裕が **6px しかない**（29px。必要な 24px に対して）。
   */
  it("どの行も中心間距離が 24px を割らない（Spacing 例外の根拠）", async () => {
    for (const r of await allRows({ width: 390, colorScheme: "light" })) {
      const got = r.got;
      expect(got.count).toBeGreaterThan(0);
      const worst = Math.min(...got.heights);
      const i = got.heights.indexOf(worst);
      expect(
        worst,
        `${r.name} の行が 24px を割った（${worst}px）。\n` +
          `読んだ値: padding ${got.detail[i]!.padding} / font-size ${got.detail[i]!.fontSize} / line-height ${got.detail[i]!.lineHeight}\n` +
          "**これは Spacing 例外の根拠を壊している**（行の中のリンクは大きさでは 24px に満たない）。\n" +
          "**`line-height` はどこに書いても、どの親に書いても、`@media` の中でもここに出る。**\n" +
          "行の padding を詰めたか、どこかの祖先の line-height を縮めたはず。docs/research/target-size-rows.md を読むこと。",
      ).toBeGreaterThanOrEqual(MINIMUM);
    }
  }, 120_000);

  /**
   * **`@media` は条件が合ったときだけ効く。** 1 つの幅でしか測らないと反対向きの `@media`
   * （`min-width`）を見落とす。実測で確認済み:
   *
   *     390px で測る    @media (max-width:600px) は捕まる / @media (min-width:1000px) は素通り
   *     1280px で測る   その逆
   *     colorScheme     @media (prefers-color-scheme: dark) はこれを変えないと捕まらない
   *
   * いま CSS にある `@media` は `tokens.css` の `prefers-color-scheme: dark` **1 件だけ**で、
   * `line-height` は含まない（CSS 全体の `line-height` 24 件を数えて確認）。
   * **将来 `@media` の中に書かれても落ちるように**、幅とテーマの組み合わせで測る。
   */
  it("幅とテーマを変えても 24px を割らない（@media の中に書かれても見落とさない）", async () => {
    const conditions = [
      { width: 390, colorScheme: "light" as const }, // 本番のスマホ幅（#413 の実測もこの幅）
      { width: 390, colorScheme: "dark" as const },
      { width: 1280, colorScheme: "light" as const }, // min-width 側の @media を捕まえる
    ];
    for (const c of conditions) {
      for (const r of await allRows(c)) {
        expect(r.got.count).toBeGreaterThan(0);
        expect(
          Math.min(...r.got.heights),
          `${r.name} が ${c.width}px / ${c.colorScheme} で 24px を割った（@media の中の指定を疑うこと）`,
        ).toBeGreaterThanOrEqual(MINIMUM);
      }
    }
  }, 120_000);

  /**
   * **境界そのものを固定する**（#470 が実測した値。**動かさないこと**）。
   *
   * `.row` は `padding: 8px 0` = 16px、文字 13px なので `16 + 13×lh ≥ 24` ⇔ **`lh ≥ 0.6154`**。
   * ここが動くと「24×24 未満の数 ＝ 違反の数」という #413 の誤りに戻る——
   * **押せる範囲を実際に潰していない変異まで「違反」と呼ばない**ための検査である。
   *
   * **`.section`（実 DOM 上の親）経由で入れている**ことに意味がある。鎖を手で書く形では
   * ここに届かなかった（それがこの PBI）。**同じ境界が、鎖の外からでも同じ値で切れる**ことを見る。
   */
  it("境界が動いていない（.section 経由でも lh 0.61 は落ち、0.62 は通る）", async () => {
    const below = await rowHeights(homeMarkup, ".row", "a", {
      width: 390,
      colorScheme: "light",
      extraCss: ".section { line-height: 0.61 }",
    });
    const above = await rowHeights(homeMarkup, ".row", "a", {
      width: 390,
      colorScheme: "light",
      extraCss: ".section { line-height: 0.62 }",
    });
    // 16 + 13×0.61 = 23.93 / 16 + 13×0.62 = 24.06
    expect(Math.min(...below.heights)).toBeCloseTo(23.93, 2);
    expect(Math.min(...below.heights)).toBeLessThan(MINIMUM);
    expect(Math.min(...above.heights)).toBeCloseTo(24.06, 2);
    expect(Math.min(...above.heights)).toBeGreaterThanOrEqual(MINIMUM);
  }, 120_000);

  /**
   * **この検査が実際に鎖の外を見ていることの証明**（＝ #481 の受け入れ条件）。
   *
   * ここで足す 4 つは、**`target-size.test.ts` では 4 つとも素通りする**
   * （`main` の `fe13f9e4` で実測。`24 passed` のまま）。**こちらでは 4 つとも捕まる**ことを、
   * テストとして固定しておく——**この能力が将来こっそり失われたら、ここが落ちる。**
   *
   * `.section` は `.rows` の**実際の DOM 上の親**（`home.tsx:132`）で、**最も現実的**である。
   *
   * **「24px を割ること」ではなく「変異前より縮むこと」を見る**（絶対値で書いて 1 度誤って落とした）。
   * 素朴に `toBeLessThan(24)` と書くと、**本物の CSS 側の値に依存**してしまう。
   *
   * **`.rows`（= 行に一番近い祖先）に `line-height` を書いた CSS を渡すと、`.rows` より外側の
   * 祖先（`.section` / `body` / `:root` / `html` / `*`）はそもそも行に届かない。** これは
   * CSS の正しい振る舞い（近い宣言が勝つ）であって、**検査能力が落ちたのではない**。
   * だから**その場合はその条件を飛ばす**——「届かないのが正しい」ものを「届かない」と落とさない。
   * （`!important` では直らない。**`!important` は継承では伝わらない**: 実測で
   * 祖先の `body { line-height: 0.1 !important }` は、子孫自身の `.section { line-height: 0.62 }` に負ける。）
   *
   * 見たいのは**「祖先に書いた値が行の計算に反映される経路があるか」**であって、
   * 特定の数字に届くかではない。だから**同じ CSS で変異あり・なしを両方測って比べる**。
   */
  it("鎖の外（.section / body / :root / @media）に書いても検出する", async () => {
    const base = await rowHeights(homeMarkup, ".row", "a", { width: 390, colorScheme: "light" });
    expect(base.count).toBeGreaterThan(0);
    /**
     * `[書く場所, 足す CSS, その場所より内側で line-height を宣言していたら飛ばすセレクタ列]`。
     * 内側に宣言があれば、外側の指定が届かないのは**CSS として正しい**ので検査しない。
     */
    const outside: [string, string, string[]][] = [
      [".section（.rows の実際の DOM 上の親・home.tsx:132）", ".section { line-height: 0.1 }", [".rows", ".row", ".row a"]],
      ["body", "body { line-height: 0.1 }", [".section", ".rows", ".row", ".row a"]],
      [":root", ":root { line-height: 0.1 }", [".section", ".rows", ".row", ".row a"]],
      ["@media の中", "@media (max-width: 600px) { .rows { line-height: 0.1 } }", [".row", ".row a"]],
      ["html", "html { line-height: 0.1 }", [".section", ".rows", ".row", ".row a"]],
      ["*（全称セレクタ）", "* { line-height: 0.1 }", [".row", ".row a"]],
    ];
    let checked = 0;
    for (const [where, extraCss, shadowedBy] of outside) {
      // 内側に宣言があるなら、外側が届かないのは CSS として正しい（＝この条件は成立しない）
      if (shadowedBy.some((sel) => declaresLineHeight(sel))) continue;
      checked += 1;
      const got = await rowHeights(homeMarkup, ".row", "a", { width: 390, colorScheme: "light", extraCss });
      expect(got.count).toBeGreaterThan(0);
      expect(
        Math.min(...got.heights),
        `${where} に line-height を足しても行の高さが変わらない。` +
          "**祖先に書いた値が届いていない ＝ この検査の存在理由が失われている**（#481）",
      ).toBeLessThan(Math.min(...base.heights));
    }
    // **全部飛ばして「緑」になるのを許さない**（飛ばす条件が広がりすぎたら、ここが落ちる）
    expect(checked, "鎖の外の検査が 1 件も実行されていない（飛ばす条件が広すぎる）").toBeGreaterThan(0);
  }, 120_000);

  /**
   * **等価変異は緑のままであること**（＝ 偽陽性を出さないこと）。
   * **実物が壊れていないのに落とすのは、見逃しと同じくらい悪い**（#413 で 110 箇所を
   * 誤って「違反」と起票した前例がある）。
   *
   *     .rollcalls-item     `padding: 12px 0` = 上下 24px **だけで**基準を満たす。
   *                         line-height をどこに入れても中心間距離は 24px を割らない
   *     .list__item a       `line-height: 1.5` が**最内で勝つ**ので、上位に何を書いても行は縮まない
   *
   * **どちらも「実物が壊れていない」ので緑が正しい。**
   * 等価であることの証明（padding を削る / 最内を消す）は下の検査で見る。
   */
  it("等価変異では落ちない（実物が壊れていないものを違反と呼ばない）", async () => {
    // .list__item の上位に line-height を入れても、最内の `.list__item a { line-height: 1.5 }` が勝つ
    for (const extraCss of [".list { line-height: 0.1 }", ".section { line-height: 0.1 }"]) {
      const got = await rowHeights(homeMarkup, ".list__item", "a", { width: 390, colorScheme: "light", extraCss });
      expect(got.count).toBeGreaterThan(0);
      expect(
        Math.min(...got.heights),
        `${extraCss} は .list__item a { line-height: 1.5 } に負けるので実物は縮まない。落とすのは偽陽性`,
      ).toBeGreaterThanOrEqual(MINIMUM);
    }
  }, 120_000);

  /**
   * **上の等価性が「たまたま」ではないことの証明。**
   * 勝っている最内の宣言を打ち消すと、上位の `line-height` が**届いて落ちる**。
   * これが無いと「等価変異だから緑」と「検出できていないから緑」を区別できない。
   */
  it("最内の line-height を打ち消すと、上位（.section）の指定が届いて落ちる", async () => {
    const got = await rowHeights(homeMarkup, ".list__item", "a", {
      width: 390,
      colorScheme: "light",
      // 最内を `inherit` にして無効化したうえで、鎖の外（.section）に縮める指定を置く
      extraCss: ".section { line-height: 0.1 } .list__item a { line-height: inherit }",
    });
    expect(got.count).toBeGreaterThan(0);
    expect(
      Math.min(...got.heights),
      "最内を打ち消しても落ちないなら、上位の指定がそもそも届いていない（＝検出できていない）",
    ).toBeLessThan(MINIMUM);
  }, 120_000);
});
