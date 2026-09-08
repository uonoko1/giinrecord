import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Issue #662: **「この事故は誰が防いでいるのか」を引ける索引が無かった。**
 *
 * 2026-09-08 の 1 日で、PO が「守りが無い」と考えて実際には既にあったものが **6 件**あった。
 * **6 件のうち `docs/` にあったのは 1 件だけで、残り 5 件はコードとテストの中**にあった。
 * 実害も出た——**#634 を起票し、既にある守りを二重に作りかけて同日中に取り下げた。**
 *
 * `docs/ops/guards.md` がその索引である。**ここはその索引が腐っていないことを機械で確かめる。**
 *
 * ## なぜ「一覧を書く」だけでは足りないのか（この PBI の核心）
 *
 * **索引が古くなると、「索引に無い＝守りが無い」と読まれて、索引が無かったときより悪くなる。**
 * 守りを消す／改名する側は索引を知らないので、放っておけば必ずずれる。
 * だから索引の各行を**実在するファイルと、そこに逐語である文字列**に結び、
 * ずれたらここが落ちるようにする（`deploy-test-inventory.test.ts` の anchors と同じ形）。
 *
 * ## なぜ etl の node:test なのか（`docs/` の中に置けない理由）
 *
 * #513 と同じ理由である。**索引と同じディレクトリに置いた見張りは、索引ごと消せる。**
 * `pnpm test`（= `pnpm -r test`）が etl を回すので、CI の別ステップからこれが落ちる。
 *
 * ## 「台帳を編集して黙らせる」道を塞ぐ（#507 の学び）
 *
 * `deploy-test-inventory.test.ts` は、**指示どおりに台帳の行を消して下限を下げると
 * 6 pass / 0 fail になった**（＝指示に従うだけで守りが外れた）ことを実測で残している。
 * ここも同じ穴を持つので、2 つ足す:
 *
 *   - `MIN_ROWS`（下限）— 行を消すだけでは通らない。
 *   - `CORE_GUARDS`（核）— **「これが索引から消えたら索引の意味が無い」という守り**を
 *     テスト側にハードコードする。**`guards.md` を編集しても縮まない。**
 *     黙らせるにはこのファイルの `CORE_GUARDS` を書き換えるしかなく、それは diff に出る。
 *
 * ## 逐語の文字列（anchor）に何を選ぶか
 *
 * **散文ではなく、その守りが現に検査している識別子**を選ぶ。
 * 「404」「24」のような短い数字は、**中身を全部消しても残る**ので anchor にならない
 * （最初の版で実際にそう書きかけ、この判定で弾いた）。
 *
 * ## 照合は「単語境界」で行う（#667 で `includes` から変えた）
 *
 * **#665 までの照合は `includes` だった。だから anchor が改名後の名前の接頭辞になる改名を
 * 検出できなかった**（`resolveMember` → `resolveMemberX` は `"resolveMemberX".includes("resolveMember")`
 * が true なので通る）。**#665 時点で 103 anchor 中 47 個、55 行中 20 行がこの形だけに頼っていた。**
 *
 * `containsAnchor` は anchor の**両端が識別子文字なら、その側に `[A-Za-z0-9_]` が続かないこと**を
 * 求める（`\b` 相当を手で書いているのは、anchor に正規表現メタ文字が入るため）。
 *
 * **識別子だけでなく、すべての anchor に同じ規則を当てている。** 分ける理由が無かったからである:
 * `if (candidates.length === 1) return candidates[0];` のようなコード片も、
 * `timeout-minutes` のような語も、末尾が識別子文字なら「そこで語が終わる」ことを求めてよい。
 * **実測（#667）: 103 anchor 全部に当てて、落ちる anchor は 0 個だった**
 * （裸の識別子だけに当てた場合も 0 個。つまり全部に当てるほうが厳しく、かつ既存を壊さない）。
 * 端が識別子文字でない anchor（`.txt` の先頭、`const SOURCE_HOST = ` の末尾）は、
 * その側の境界を要求しない——要求すると意味の無い偽陽性になる。
 *
 * **これで anchor の書き方の制約は減ったが、消えてはいない**: 逐語が短すぎて
 * 「中身を全部消しても残る」ものは依然 anchor にならない（上の節）。
 *
 * **照合の規則そのものを固定するテストが要る理由**（#667 の実測）:
 * `containsAnchor(...)` の呼び出しを `read(a.path).includes(a.text)` に戻す変異を当てると、
 * **既存 55 行 / 103 anchor は 1 つも落ちなかった**（9 pass / 0 fail）。
 * つまり**索引の中身だけでは、照合が緩んだことを検出できない。**
 * だから下の `#667 逐語は単語として照合する` が、索引と無関係に規則を固定する
 * （この変異で 8 pass / 1 fail になる）。
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const INDEX = "docs/ops/guards.md";

const read = (p: string) => readFileSync(resolve(root, p), "utf8");

/**
 * 索引の 1 行: 事故と、それを防いでいるもの（ファイル群 + 逐語）。
 *
 * **逐語は「行のどこかのファイルにあればよい」ではなく、直前に書かれたパスに紐づける。**
 * 最初の版は「行のどれかのファイルにあれば通る」にしていたが、**変異が生き残った**（実測）:
 * `deploy/monitor/environment-protection.sh` の `EXPECTED_RULES` を全部改名しても、
 * 同じ行が並記していた `environment-protection-report.sh` に同じ語が 1 か所あったため **7 pass / 0 fail**。
 * 複数のファイルを並記する行ほど守りが厚いのに、**並記するほど検出が緩む**という逆立ちだった。
 */
interface Row {
  accident: string;
  guard: string;
  paths: string[];
  /** `path` は「その逐語の直前に書かれたパス」。逐語はそのファイルの中だけを探す。 */
  anchors: { path: string; text: string }[];
  line: number;
  /** `line.split("|")` の要素数。正しい 2 列の行は必ず 4（先頭と末尾の空文字を含む）。 */
  cellCount: number;
}

/** `パス`（バッククォート内、リポジトリ相対、拡張子つき）に見えるか。 */
const looksLikePath = (t: string): boolean =>
  t.includes("/") && /^[\w.@/-]+\.(ts|tsx|sh|yml|md|txt|css)$/.test(t);

/** 識別子を構成する文字（`\w` から Unicode の揺れを除いた ASCII のみ）。 */
const WORD = /[A-Za-z0-9_]/;

const escapeRe = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `text` が `src` に**単語として**現れるか。
 *
 * `src.includes(text)` ではない理由は docblock の「照合は単語境界で行う」を読むこと。
 * **`text` の端が識別子文字のときだけ、その側に識別子文字が続かないことを求める。**
 * 端が `.`（`.txt`）や空白（`const SOURCE_HOST = `）なら境界は要求しない。
 */
export const containsAnchor = (src: string, text: string): boolean => {
  if (text === "") return false;
  const pre = WORD.test(text[0]) ? "(?<![A-Za-z0-9_])" : "";
  const post = WORD.test(text[text.length - 1]) ? "(?![A-Za-z0-9_])" : "";
  return new RegExp(pre + escapeRe(text) + post).test(src);
};

/**
 * `docs/ops/guards.md` の表を読む。
 * 見出し行（`| 事故 |`）と罫線（`|---|`）は行ではない。
 */
function rows(): Row[] {
  const out: Row[] = [];
  const lines = read(INDEX).split("\n");
  for (const [i, line] of lines.entries()) {
    if (!line.startsWith("| ")) continue;
    const cells = line.split("|").map((s) => s.trim());
    if (cells.length < 4) continue;
    const [, accident, guard] = cells;
    if (accident === "事故" || /^-+$/.test(accident)) continue;
    const toks = [...guard.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    // 逐語は「直前に現れたパス」に紐づく。パスより前に書かれた逐語は所属先が無いので path: ""。
    let current = "";
    const anchors: { path: string; text: string }[] = [];
    for (const t of toks) {
      if (looksLikePath(t)) current = t;
      else anchors.push({ path: current, text: t });
    }
    out.push({
      accident,
      guard,
      paths: toks.filter(looksLikePath),
      anchors,
      line: i + 1,
      cellCount: cells.length,
    });
  }
  return out;
}

/**
 * 実測（2026-09-08、この索引を作ったとき）: **44 行 / 67 anchor**
 * （最初 43 行 / 66 anchor で書き、rebase 中に main へ入った #661 の守りを 1 行足して 44 / 67）。
 * **#665 で 55 行 / 103 anchor**——国会側の名寄せ（`resolveMember` / `tenureVerified` / `unmatched` /
 * 国会側の `estimated`）が 0 行、出典の許可ホスト（`SOURCE_HOST`）も 0 行だった。
 * **索引ができた翌日に、索引を使って抜けを探して見つかったもの**である（#664 の担当者が
 * 「44 行が全部だとは主張できない。下限である」と自己申告したのが起点）。
 * 数え方: `guards.md` の表の行（見出しと罫線を除く）と、`防いでいるもの` 欄の
 * バッククォート内のうち**リポジトリ相対のパスに見えないもの**の総数。
 *
 * 下限なので、守りが増えて行が増えるぶんには落ちない。**減ったら落ちる。**
 */
const MIN_ROWS = 58;
const MIN_ANCHORS = 107;

/**
 * **索引から消えてはならない守り**（#662 で PO が「無い」と誤読した 6 件を必ず含む）。
 * ここは `guards.md` の外にあるので、**索引の行を消しても縮まない**。
 *
 * 各要素は「そのファイルを名指しする行が、索引に少なくとも 1 行あること」を要求する。
 */
const CORE_GUARDS: readonly string[] = [
  // #662 の 6 件そのもの
  "packages/etl/src/fetch.ts", // 一次資料のリンク切れ（コード）
  ".github/workflows/etl.yml", // 同上（CI が Issue を立てる）
  "apps/web/app/routes/member-tabs.test.tsx", // 衆院の「推定」ラベル（#238）
  "packages/etl/src/sources/local/name-match.ts", // BMP 外文字の欠落／別人に決めない（#569/#636）
  "packages/etl/test/name-normalization-table.test.ts", // 氏名正規化の規則の固定（#581）
  // 索引を作った動機に直結するもの（テストが死ぬ・CI が緩む）
  "packages/etl/test/deploy-test-inventory.test.ts", // #513/#526
  "packages/etl/test/test-file-inventory.test.ts", // #533
  "packages/etl/test/branch-protection-jobs.test.ts", // #541/#601
  "packages/etl/test/workflow-timeout.test.ts", // #556/#574
  "deploy/monitor/branch-protection.sh", // #521/#540
  "deploy/monitor/environment-protection.sh", // #659/#661
  "scripts/ci/forbidden-patterns.sh", // #133/#542/#557
  "scripts/ci/stale-base.sh", // #536
  "deploy/test/nginx-headers.test.sh", // #505/#580/#642/#652
  "apps/web/app/lib/font-subset-coverage.test.ts", // #477/#520
  // #665: 国会側の名寄せと出典の許可ホスト。**索引ができた当日は 0 行だった。**
  // 「別人の記録が出る」は利用者から検出できない虚偽なので、地方（name-match.ts）と
  // 同じ重さで核に置く。dataset.ts は SOURCE_HOST（出典の許可ホスト）と
  // 「空 memberId は unmatched に載っていなければ止める」の両方をここだけで持つ。
  "packages/etl/src/match-votes.ts", // resolveMember / tenureVerified（#3/#24/#230/#320）
  "packages/etl/src/dataset.ts", // SOURCE_HOST・unmatched の検証・estimated の形（#4/#219）
];

test("#662 索引そのものが在る（消えたら落ちる）", () => {
  assert.ok(
    existsSync(resolve(root, INDEX)),
    `${INDEX} が無い。これは「事故 → それを防いでいるもの」を引くための索引で、
無いと PO は毎回 grep で探し、探す先は「最初に思いついた場所」に偏る（#662 で 1 日に 6 回起きた）。`,
  );
});

test("#662 索引の各行が名指しするファイルは実在する（守りを消す・改名すると落ちる）", () => {
  const missing: string[] = [];
  const noPath: string[] = [];
  const audited: string[] = [];
  for (const r of rows()) {
    audited.push(r.accident);
    if (r.paths.length === 0) {
      noPath.push(`${INDEX}:${r.line} 「${r.accident}」`);
      continue;
    }
    for (const p of r.paths)
      if (!existsSync(resolve(root, p)))
        missing.push(`${INDEX}:${r.line} 「${r.accident}」→ ${p}`);
  }
  // #507: 監査は judge の申告ではなく対象集合そのものを起点に回し、結果は脇に置かず検出に合流させる。
  const skipped = rows()
    .map((r) => r.accident)
    .filter((a) => !audited.includes(a));
  assert.deepEqual(
    { missing, noPath, skipped },
    { missing: [], noPath: [], skipped: [] },
    `${INDEX} の行が、実在しないファイルを指している（＝守りが消えたか改名された）。
${missing.map((m) => `  - ${m}`).join("\n") || "  （検出なし）"}
ファイルを1つも名指ししていない行:
${noPath.map((m) => `  - ${m}`).join("\n") || "  （検出なし）"}
検査を飛ばした行: ${skipped.join(", ") || "なし"}

守りを改名したなら索引も直す。**守りを消したなら、消してよいかをまず考える。**
索引の行を消して黙らせる道は MIN_ROWS と CORE_GUARDS が塞いでいる。`,
  );
});

test("#662 索引の逐語の文字列は、名指ししたファイルに今もある（中身を抜くと落ちる）", () => {
  const gone: string[] = [];
  const noAnchor: string[] = [];
  const audited: string[] = [];
  for (const r of rows()) {
    audited.push(r.accident);
    if (r.anchors.length === 0) {
      // **パスだけの行は「消えた」は見つけるが「空にした」を見逃す**（#504: 名前を固定した は 値を固定した ではない）。
      noAnchor.push(`${INDEX}:${r.line} 「${r.accident}」`);
      continue;
    }
    for (const a of r.anchors) {
      if (a.path === "") {
        gone.push(
          `${INDEX}:${r.line} 「${r.accident}」→ [${a.text}] の前にパスが無い（どのファイルの話か決まらない）`,
        );
        continue;
      }
      if (!existsSync(resolve(root, a.path))) continue; // ファイルの不在は上の test の担当
      if (!containsAnchor(read(a.path), a.text))
        gone.push(
          `${INDEX}:${r.line} 「${r.accident}」→ [${a.text}] が ${a.path} に無い`,
        );
    }
  }
  const skipped = rows()
    .map((r) => r.accident)
    .filter((a) => !audited.includes(a));
  assert.deepEqual(
    { gone, noAnchor, skipped },
    { gone: [], noAnchor: [], skipped: [] },
    `${INDEX} が「そこに書いてある」と主張する逐語が、実際には無い。
${gone.map((m) => `  - ${m}`).join("\n") || "  （検出なし）"}
逐語を 1 つも持たない行（＝ファイルが空になっても気付けない行）:
${noAnchor.map((m) => `  - ${m}`).join("\n") || "  （検出なし）"}
検査を飛ばした行: ${skipped.join(", ") || "なし"}

守りの中身が変わったなら索引の逐語も直す。**逐語を消して黙らせないこと**——
逐語が無い行は「ファイルが在る」しか言えず、**空にされたことを見逃す。**

**逐語は直前に書いたパスの中だけを探す**（バッククォートで囲んだパスを先に、逐語をその後に書くこと）。
行のどれかにあればよい、にすると**並記するほど検出が緩む**（実測で変異が 1 つ生き残った）。`,
  );
});

test("#662 索引の行数と逐語の数が下限を割らない（行を消すだけでは黙らない）", () => {
  const rs = rows();
  const anchors = rs.reduce((n, r) => n + r.anchors.length, 0);
  assert.deepEqual(
    {
      rowsAtLeast: rs.length >= MIN_ROWS,
      anchorsAtLeast: anchors >= MIN_ANCHORS,
    },
    { rowsAtLeast: true, anchorsAtLeast: true },
    `${INDEX} が縮んでいる。行 ${rs.length}（下限 ${MIN_ROWS}）/ 逐語 ${anchors}（下限 ${MIN_ANCHORS}）。
守りを本当にやめたのなら、**なぜやめたかを PR 本文に書いた上で**下限も下げること。
「索引の行が落ちるから消す」は逆で、**落ちているのは索引が指す守りのほう**である（#507）。`,
  );
});

test("#662 核の守りは索引から消せない（guards.md を編集しても縮まない）", () => {
  const named = new Set(rows().flatMap((r) => r.paths));
  const missing = CORE_GUARDS.filter((g) => !named.has(g));
  assert.deepEqual(
    missing,
    [],
    `索引が、**索引から消えてはならない守り**を名指ししなくなった:
${missing.map((m) => `  - ${m}`).join("\n")}

この集合は ${INDEX} の外（このファイルの CORE_GUARDS）にあるので、
**索引の行を消しても縮まない。** 黙らせるにはここを書き換えるしかなく、それは diff に出る（#507）。
先頭の 5 件は、**2026-09-08 に PO が「無い」と誤読した実物**である（#662）。`,
  );
});

test("#662 核の守りのファイル自体が実在する（索引ごと消しても落ちる）", () => {
  // 上の test は「索引が名指ししているか」しか見ない。**索引を丸ごと空にすると、
  // 上は落ちるがファイルの実在は誰も見ていない。** ここが索引と無関係にそれを見る。
  const missing = CORE_GUARDS.filter((g) => !existsSync(resolve(root, g)));
  assert.deepEqual(
    missing,
    [],
    `索引が指すかどうか以前に、守りのファイルそのものが無い:
${missing.map((m) => `  - ${m}`).join("\n")}`,
  );
});

test("#662 索引は「ここに無い＝守りが無い ではない」と明記している（下限であることを読者に伝える）", () => {
  const md = read(INDEX);
  const required = [
    "ここに無いからといって「守りが無い」とは限りません",
    "packages/etl/test/guards-inventory.test.ts",
    "packages/etl/test/",
    "apps/web/app/**/*.test.*",
    "deploy/test/",
    "scripts/ci/test/",
  ];
  const missing = required.filter((r) => !md.includes(r));
  assert.deepEqual(
    missing,
    [],
    `${INDEX} から、読み方の但し書きが消えている:
${missing.map((m) => `  - [${m}]`).join("\n")}

この索引は**全数ではなく下限**である。それを書かずに一覧だけ置くと、
**「索引に無い＝守りが無い」と読まれて、索引が無かったときより悪くなる**（#662 の起点）。
grep する先の 4 か所も、**今日の 6 件のうち 5 件がそこにあった**ので必ず残す。`,
  );
});

test("#667 逐語は単語として照合する（接頭辞になる改名で落ちる）", () => {
  // **この test が守っているのは「照合の規則そのもの」である。**
  // 索引の中身とは無関係に、`containsAnchor` が満たすべき性質をここに固定する。
  // これが無いと、`containsAnchor` を `includes` に戻しても既存 55 行は全部通ってしまい、
  // **緩めたことに誰も気付けない**（#667 の起点はまさにその状態だった）。
  assert.deepEqual(
    {
      // 改名: anchor が改名後の名前の接頭辞になる形。**これを検出できないのが #667 の欠陥だった。**
      suffixAdded: containsAnchor(
        "export const resolveMemberX = 1;",
        "resolveMember",
      ),
      // **前に足す形**。`myResolveMember` だと大文字 R で `includes` すら false になり、
      // 前方境界を消しても落ちない（実測で M5 が生き残った）。**同じ綴りのまま前に足す。**
      prefixAdded: containsAnchor(
        "export const myresolveMember = 1;",
        "resolveMember",
      ),
      constSuffix: containsAnchor(
        "const EXPECTED_COUNT_V2 = 3;",
        "EXPECTED_COUNT",
      ),
      // 同一なら当然通る。
      exact: containsAnchor("export const resolveMember = 1;", "resolveMember"),
      // 記号で区切られていれば「別の語」なので通る。
      calledAsFunction: containsAnchor(
        "resolveMember(index, x)",
        "resolveMember",
      ),
      dotted: containsAnchor("a.resolveMember;", "resolveMember"),
      // 端が識別子文字でない anchor は、その側の境界を要求しない。
      dotPrefixed: containsAnchor("読む: foo.txt を", ".txt"),
      trailingSpace: containsAnchor(
        'const SOURCE_HOST = "x";',
        "const SOURCE_HOST = ",
      ),
      // が、識別子文字で終わる側は効く。
      dotPrefixedExtended: containsAnchor("foo.txtx", ".txt"),
      // 正規表現のメタ文字を含む逐語が、正規表現として解釈されない。
      metaChars: containsAnchor(
        "if (candidates.length === 1) return candidates[0];",
        "if (candidates.length === 1) return candidates[0];",
      ),
      metaCharsNotRegex: containsAnchor(
        "if (xxxxxxxxxxlengthxxx1) return candidatesX0Y;",
        "if (candidates.length === 1) return candidates[0];",
      ),
      // 非 ASCII は識別子文字ではないので境界を要求しない（日本語の逐語が使えなくならない）。
      japanese: containsAnchor(
        "これは記録するのは会派名であって本人ではないという話",
        "記録するのは会派名であって本人ではない",
      ),
    },
    {
      suffixAdded: false,
      prefixAdded: false,
      constSuffix: false,
      exact: true,
      calledAsFunction: true,
      dotted: true,
      dotPrefixed: true,
      trailingSpace: true,
      dotPrefixedExtended: false,
      metaChars: true,
      metaCharsNotRegex: false,
      japanese: true,
    },
    `逐語の照合が単語境界で行われていない。**includes に戻すとここが落ちる。**
includes だと resolveMember → resolveMemberX の改名を索引が見逃す（#667）。
**照合を緩めて黙らせないこと**——落ちているなら、索引の逐語のほうを実在する形に直す。`,
  );
});

test("#667 索引の表の行は 2 列ちょうど（セル内の `||` で行の構造が壊れない）", () => {
  // **`guards.md` の表のセルの中に `|` を書くと、`line.split("|")` で列が増える。**
  // 増えた列は `const [, accident, guard] = cells` で捨てられるので、
  // **その行の逐語のうち 2 本目の `|` より後ろにあるものが、まるごと検査から外れる。**
  // 落ちずに黙って弱くなるので、**索引に行を足す人が踏む罠**である
  // （#666 の担当者が実装中に踏み、逐語を書き換えて回避した）。
  // Markdown の表でセル内に縦棒を出したいときは `\|` ではなく `｜`（全角）か
  // バッククォート外の別の書き方にすること。
  const over = rows()
    .filter((r) => r.cellCount !== 4)
    .map(
      (r) =>
        `${INDEX}:${r.line} 「${r.accident}」→ ${r.cellCount} 列に割れている`,
    );
  assert.deepEqual(
    over,
    [],
    `${INDEX} の表の行が 2 列に収まっていない（セルの中に縦棒がある）:
${over.map((m) => `  - ${m}`).join("\n")}

**この行の逐語は、2 本目の縦棒より後ろのぶんが検査されていない。**
セルの中で縦棒を書かないこと。`,
  );
});
