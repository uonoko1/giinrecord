import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * **コミットメッセージの `Co-authored-by:` trailer に書くメールアドレスは、
 * 数字 ID 付きの GitHub noreply でなければならない。**
 *
 * **`workflow-commit-identity.test.ts`（#1043）は `.github/workflows/*.yml` の
 * `user.email` しか見ていない。** **コミットメッセージの trailer は完全に無検査だった** ので、
 * `noreply@anthropic.com` がすり抜けた。
 * **これが #1043 が `github.com/claude` を捕まえられなかった理由である**（#1074）。
 *
 * ── 測った数（2026-09-28、`origin/main` = `068be5c2`、696 commits の全履歴）───────────
 *
 * **メッセージ本文の trailer 形の行（`Co-authored-by:`）に現れたアドレスの全数**:
 * ```
 * 1643  noreply@anthropic.com                                  ★ github.com/claude に誤帰属する
 *                                                                 （id=81847 / type=User /
 *                                                                  created_at=2009-05-07。実測）
 *  518  120390190+uonoko1@users.noreply.github.com              OK（数字 ID 付き）
 *   66  41898282+github-actions[bot]@users.noreply.github.com   OK（数字 ID 付き / type=Bot）
 *    2  （利用者本人の個人アドレス。下の「本人のアドレス」節）    squash が合成した 2 件だけ
 *    1  etl@users.noreply.github.com                            ★ github.com/etl（無関係の実在の人）
 * ```
 * **`Co-authored-by:` 以外に、アドレスを運ぶ trailer 形の token は 1 つも無い**
 * （全履歴を token ごとに数えた: `co-authored-by` 2230 行のみ）。
 *
 * ── **`git` の trailer パーサだけを見てはいけない**（この PBI で測って分かったこと）─────
 *
 * **`git log --pretty='%(trailers:only=true)'` は `noreply@anthropic.com` を 640 しか返す。
 * 本文を直接読むと 1643 ある。** 差は **squash merge のメッセージの形** から来る:
 *
 * ```
 * Closes #1053
 *
 * Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>     ← 開発者が書いた分
 * Claude-Session: https://claude.ai/code/session_…
 *
 * ---------                                                  ← GitHub が入れる区切り
 *
 * Co-authored-by: Claude Opus 5 <noreply@anthropic.com>      ← squash が合成した分
 * ```
 * **git は「最後の段落」だけを trailer と見なす**ので、**区切りより上の
 * `Co-Authored-By:` は trailer として数えない。** **実測で、本文の実数がパーサの数より
 * 多いコミットが 696 中に多数ある**（例 `22222a6c` は raw 8 / trailer 1、`068be5c2` は raw 3 / trailer 1）。
 * **`%(trailers)` に頼ると、開発者が書いた分がまるごと検査から落ちる。**
 * **だから本文の行を直接走査する。**
 *
 * ── denylist ではなく形の要求にする（#858 / #1043 と同じ向き）─────────────────────
 *
 * 「`noreply@anthropic.com` を禁じる」だと **次に別のドメインを書いた人を捕まえられない。**
 * **`数字+名前@users.noreply.github.com` という形そのものを要求する。**
 *
 * ── 本人のアドレス（リポジトリには書かない）─────────────────────────────────
 *
 * **利用者本人の個人アドレスは `uonoko1` に正しく紐づくので、本来は通してよい。**
 * **だがこの検査は逐語もハッシュもリポジトリに置かない:**
 * - **#1043 はリポジトリの追跡ファイルに利用者の個人アドレスを書かない方針を採った**
 *   （`git grep` で 0 件を確認して架空のアドレスに置き換えた経緯がある。実測: いまも 0 件）。
 * - **SHA-256 で書いても実質は同じ**である。**メールアドレスはハッシュから総当たりで戻せる**
 *   （よくあるドメインの短いローカル部なら安い）。**「ハッシュだから書いていない」は成り立たない。**
 * - **そして、そもそも要らない。** **履歴に在る本人アドレスの trailer 2 件は、どちらも
 *   squash merge が合成した分である**（実測 `6e6b9b99` / `5fb2cf0e`。合成元はマージした人の
 *   git の author identity）。**合成はマージの瞬間に起きるので、PR の枝には存在しない。**
 *   **この検査が見るのは枝のコミットだけなので、合成された trailer には当たらない。**
 *
 * **通す必要が出た場合の逃げ道**: 環境変数 `GIINRECORD_TRAILER_EMAIL_ALLOW`
 * （カンマ区切り）に入れたアドレスは通る。**リポジトリには残らない。**
 * **既定は空**なので、**何も設定しなければ形の要求だけが効く。**
 * **これは「守れないもの」を増やす**（CI で設定すれば検査を素通しにできる）ので、
 * **下で「空であること」を検査に載せてある**——ローカルで一時的に使う以外の用途を潰す。
 */

/** **数字 ID 付きの GitHub noreply だけを通す**（`workflow-commit-identity.test.ts` の `OK` と同じ形）。 */
const OK = /^\d+\+[^@]+@users\.noreply\.github\.com$/;

/**
 * **trailer の形をした行のうち、コミットの帰属を決めるもの。**
 *
 * **GitHub が Contributors に数えるのは `Co-authored-by:` だけ**だが、
 * **`Signed-off-by:` などの「人を名指しする trailer」も同じ穴を開けうる**ので一緒に拾う
 * （拾っても偽陽性にならない——どれも本来は実在の人のアドレスを書く場所である）。
 * **列挙なので漏れがそのまま穴になる。** **だから下で列挙自身に当てている。**
 */
const IDENTITY_TRAILERS =
  /^[ \t]*(?:co[-\s]?authored[-\s]?by|signed[-\s]?off[-\s]?by|reviewed[-\s]?by|acked[-\s]?by|tested[-\s]?by|helped[-\s]?by|reported[-\s]?by|suggested[-\s]?by)[ \t]*:/i;

/** **メールアドレスらしい文字列**。`[bot]` の角括弧を含める（`github-actions[bot]@…` を落とさないため）。 */
const EMAIL = /[A-Za-z0-9._%+\-[\]]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** 環境変数で渡された、その場かぎりの許容リスト（既定は空。上の docblock を参照）。 */
const envAllow = (): Set<string> =>
  new Set(
    (process.env.GIINRECORD_TRAILER_EMAIL_ALLOW ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s !== ""),
  );

/**
 * **1 つのメッセージ本文から、誤帰属するアドレスを取り出す。**
 *
 * **戻す 2 つ目の数（`checked`）が母数である**（#757）。
 * **`bad` が空でも `checked` が 0 なら「1 つも見ていない」**ので、呼ぶ側がそれを区別できる。
 */
export const misattributingTrailerEmails = (
  body: string,
  allow: Set<string> = envAllow(),
): { bad: string[]; checked: number } => {
  const bad: string[] = [];
  let checked = 0;
  for (const line of body.split("\n")) {
    if (!IDENTITY_TRAILERS.test(line)) continue;
    for (const m of line.matchAll(EMAIL)) {
      const email = m[0].toLowerCase();
      checked += 1;
      if (OK.test(email)) continue;
      if (allow.has(email)) continue;
      bad.push(email);
    }
  }
  return { bad, checked };
};

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");

const git = (...args: string[]): string =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/**
 * **この PR が足すコミットだけを見る**（`merge-base(origin/main, HEAD)..HEAD`）。
 *
 * **なぜ全履歴を見ないか**: **いま在る履歴には 1644 件の誤帰属が既に刻まれている**
 * （`noreply@anthropic.com` 1643 / `etl@users.noreply.github.com` 1）。
 * **全履歴に当てると、この検査は `origin/main` で必ず赤になる**——
 * **赤が常態になった検査は誰も見なくなる**（作業合意の「偽陽性を出す検査」）。
 * **既存履歴を直すには protected branch の history rewrite が必要で 640 commits に触る**ので、
 * **#1074 は「利用者に確認してから」として範囲外にしている。**
 *
 * **この選択で守れないもの**（明記する）:
 * - **既に main に在る 1644 件は、この検査では永久に見えない。** 直すのは別の PBI。
 * - **`origin/main` や merge-base が取れない浅い checkout では、この検査は 1 件も見ない**
 *   （下で skip する。緑にはしない）。
 * - **main へ直 push されたコミットは、`..HEAD` が空になるので見えない**
 *   （`main` は protected で直 push できない設定を `branch-protection.yml` が固定している）。
 * - **squash merge が合成する trailer は、マージの瞬間に作られる**ので **枝には存在せず、
 *   この検査を通り抜ける。** **合成元は枝のコミットの author** なので、
 *   **author の側は `workflow-commit-identity.test.ts`（workflow の `user.email`）が受け持つ。**
 *   **#1074 の (B)（`etl@` 1 件）はこの経路であり、#1043 で既に閉じている。**
 */
/**
 * **走らせないでよい理由は、この 2 つだけ。**
 *
 * **「skip」は赤にならないので、理由を増やせば検査は黙って無力化できる。**
 * **だから理由の集合を逐語で固定する**（`SKIP_REASONS` を広げる変異は下のテストが落とす）。
 */
const NO_BASE = "refs/remotes/origin/main が無い";
const NO_MERGE_BASE = "origin/main と HEAD の merge-base が取れない（浅い checkout）";
const SKIP_REASONS: readonly string[] = [NO_BASE, NO_MERGE_BASE];

const addedCommits = (): { shas: string[]; reason?: string; mergeBase?: string; head?: string } => {
  let base: string;
  try {
    base = git("rev-parse", "--verify", "--quiet", "refs/remotes/origin/main").trim();
  } catch {
    return { shas: [], reason: NO_BASE };
  }
  if (base === "") return { shas: [], reason: NO_BASE };
  // **浅い checkout では merge-base が取れない。** 取れないまま `A..B` を走らせると
  // **git は「B から届く範囲だけ」を返す**ので、母数が落ちて検査が無意味になる。
  let mergeBase: string;
  try {
    mergeBase = git("merge-base", base, "HEAD").trim();
  } catch {
    return { shas: [], reason: NO_MERGE_BASE };
  }
  if (mergeBase === "") return { shas: [], reason: NO_MERGE_BASE };
  const head = git("rev-parse", "HEAD").trim();
  const out = git("rev-list", `${mergeBase}..HEAD`).trim();
  return { shas: out === "" ? [] : out.split("\n"), mergeBase, head };
};

test("この枝が足すコミットの trailer に、誤帰属するアドレスが無い", (t) => {
  const { shas, reason, mergeBase, head } = addedCommits();
  if (reason !== undefined) {
    // **「落ちる」ではなく「明示的に skip」にした理由**:
    // **`pnpm test` を走らせる CI の `check` ジョブは `actions/checkout@v4` の既定
    // （`fetch-depth: 1`）で checkout する**（`ci.yml` 実測: `fetch-depth: 0` を持つのは
    // `stale-base` ジョブと `security.yml` だけ）。**そこで落とすと、誤帰属が 1 件も無い PR まで
    // 赤になる**——**偽陽性で赤が常態になるのを避ける**（作業合意）。
    // **黙って緑にはしない**: skip は `node --test` の出力と CI のログに残り、
    // **履歴が読める環境（開発者の手元・深さを足した checkout）では必ず走る。**
    // **「0 件だから緑」とは区別がつく形になっている**のが要点である。
    //
    // **skip は赤にならないので、「いつも skip」に潰されうる。**
    // **実測（変異）: `if (reason !== undefined)` を `if (true)` に変えると、
    // 下の `assert.ok` が無いときは **tests 8 / 7 pass / 0 fail / skipped 1** で生き残った。**
    // **`assert.ok` と「理由の集合」のテストを足したら **tests 9 / 8 pass / 1 fail** になった**——
    // **理由が `undefined` になったところで落ちる。**
    // **そして CI 側では `ci.yml` の fetch 段が「取れなかった」を echo する**ので、
    // **ログにも理由が残る。**
    assert.ok(
      SKIP_REASONS.includes(reason),
      `知らない理由で skip しようとしている（検査が黙って無力化されている）: ${reason}`,
    );
    t.skip(`履歴が読めないので走らせない: ${reason}`);
    return;
  }
  const bad: string[] = [];
  let checked = 0;
  for (const sha of shas) {
    const r = misattributingTrailerEmails(git("show", "-s", "--format=%B", sha));
    checked += r.checked;
    for (const email of r.bad) bad.push(`${sha.slice(0, 8)}: ${email}`);
  }
  assert.deepEqual(
    bad,
    [],
    "trailer のアドレスが無関係の GitHub ユーザーに誤帰属する。" +
      "数字 ID 付きの `<id>+<name>@users.noreply.github.com` にするか、trailer を落とすこと:\n  " +
      bad.join("\n  "),
  );
  // **母数（#757）。** **`checked` そのものに下限は置けない**——**trailer を 1 つも書かない PR は
  // アドレス 0 件が正しい。** **だが「コミットの数」には置ける。**
  //
  // **これは変異で見つけた穴である**（#705 の「検算が空回り」と同じ形）。
  // **実測: `rev-list` の結果を `""` に潰す変異を当てたら、この `assert.ok` が無いときは
  // **tests 8 / 8 pass / 0 fail** で生き残った。足したら **tests 9 / 8 pass / 1 fail** になった。**
  // **変異は当たっている（md5 が変わった）。振る舞いも変わっている
  // （走査が 1 commit → 0 commit）。それでも緑だった**——
  // **`bad` が空であることしか見ておらず、「見る対象そのものが消えた」ことを誰も見ていなかった。**
  //
  // **塞ぎ方**: **HEAD が merge-base と違うなら、範囲は空であってはならない。**
  // （`merge-base == HEAD` は「枝が base に何も足していない」= main そのものを検査している状態で、
  // そのときだけ 0 が正しい。）
  if (mergeBase !== head) {
    assert.ok(
      shas.length > 0,
      `HEAD が merge-base と違うのに走査した範囲が空である（走査が空回りしている）: ` +
        `merge-base=${mergeBase?.slice(0, 8)} HEAD=${head?.slice(0, 8)}`,
    );
  }
  console.log(`[#1074] 枝が足したコミット ${shas.length} 件 / trailer のアドレス ${checked} 件を走査`);
});

/**
 * **「走らせない理由」の集合を逐語で固定する。**
 *
 * **skip は赤にならない**ので、**理由を 1 つ増やすだけで検査は黙って無力化できる**
 * （実測: `if (reason !== undefined)` を `if (true)` に潰す変異は **7 pass / 0 fail / skipped 1**
 * で生き残った。**赤が出ないので、上のテスト自身では捕まえられない**）。
 * **ここが「その変異を捕まえる唯一の番人」である**——理由が `undefined` や新しい文字列になれば、
 * 上の `assert.ok(SKIP_REASONS.includes(reason))` が落ちる。
 *
 * **2 つの理由はどちらも「履歴が読めない」に限る。**
 * **「trailer が無い」「アドレスが無い」のような、中身に依存する理由を足してはいけない**
 * ——それは skip ではなく、検査が通ったということである。
 */
test("走らせない理由は「履歴が読めない」2 つだけ（skip で無力化できないようにする）", () => {
  assert.deepEqual(
    [...SKIP_REASONS],
    [
      "refs/remotes/origin/main が無い",
      "origin/main と HEAD の merge-base が取れない（浅い checkout）",
    ],
    "走らせない理由が増えている（skip は赤にならないので、増やせば検査は黙って死ぬ）",
  );
  // **どちらも「履歴が読めない」ことしか言っていない**ことを、語で固定する。
  for (const r of SKIP_REASONS) {
    assert.ok(
      /origin\/main|merge-base/.test(r),
      `履歴の読めなさ以外を理由に skip しようとしている: ${r}`,
    );
  }
});

/**
 * **上の検査は、この枝が正しい trailer だけを書いていれば `bad` が構造的に空になる。**
 * **だから `OK` を「何でも通す」形に緩めても緑のまま通る**（#1043 のレビューが同じ穴を実測した）。
 * **`OK` そのものが何も主張していない。**
 *
 * **だから `OK` を、通すべき綴りと通してはいけない綴りに直接当てる。**
 */
test("数字 ID 付きの noreply だけを通す正規表現そのものを検査する", () => {
  for (const good of [
    "41898282+github-actions[bot]@users.noreply.github.com",
    "120390190+uonoko1@users.noreply.github.com",
  ]) assert.ok(OK.test(good), `通すべき綴りが落ちた: ${good}`);
  for (const bad of [
    "noreply@anthropic.com", // #1074 の発端。github.com/claude（id=81847、実在の個人）に誤帰属する
    "etl@users.noreply.github.com", // #1043 の発端。github.com/etl に誤帰属する
    "dev@users.noreply.github.com",
    "claude@anthropic.com",
    "noreply@example.com",
    "41898282+github-actions[bot]@example.com",
    "+uonoko1@users.noreply.github.com",
    "120390190@users.noreply.github.com",
  ]) assert.ok(!OK.test(bad), `通してはいけない綴りが通った: ${bad}`);
});

/**
 * **`misattributingTrailerEmails` を、`origin/main` の履歴に実際に在った形に当てる。**
 *
 * **これが「いま在る履歴の 2 形を赤にできる」ことの証明である**（#1074 の受け入れ条件）。
 * **母数（`checked`）も一緒に固定する**（#757。`bad` が空でも `checked` が落ちていれば走査が壊れている）。
 */
test("履歴に実際に在った 4 形を、赤 2 / 緑 2 に分ける（母数も固定する）", () => {
  const body = [
    "fix: 何かを直した",
    "",
    "Closes #1074",
    "",
    "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>",
    "Co-authored-by: uonoko1 <120390190+uonoko1@users.noreply.github.com>",
    "Co-authored-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
    "Co-authored-by: giinrecord-etl[bot] <etl@users.noreply.github.com>",
    "Claude-Session: https://claude.ai/code/session_x",
  ].join("\n");
  const { bad, checked } = misattributingTrailerEmails(body, new Set());
  assert.deepEqual(
    bad,
    ["noreply@anthropic.com", "etl@users.noreply.github.com"],
    "履歴に在った 2 つの誤帰属が赤にならない",
  );
  // **母数**: trailer 形の行 4 つからアドレスを 4 つ拾っている
  // （`Claude-Session:` は身元の trailer ではないので数に入らない）。
  assert.equal(checked, 4, "走査したアドレス数が変わっている（走査が空回りしているか、広がりすぎている）");
});

/**
 * **身元を名指ししない trailer を拾ってはいけない**（偽陽性）。
 * **`Claude-Session:` の URL や `mailto:` を拾うと、無関係な行で CI が赤くなる。**
 */
test("身元を名指ししない trailer は走査しない（偽陽性を出さない）", () => {
  const body = [
    "docs: 何か",
    "",
    "Claude-Session: https://claude.ai/code/session_01N",
    "Refs: https://example.com/a@b.co",
    "Link-To: mailto:someone@example.com",
    "Co-authored-by: uonoko1 <120390190+uonoko1@users.noreply.github.com>",
  ].join("\n");
  const { bad, checked } = misattributingTrailerEmails(body, new Set());
  assert.deepEqual(bad, [], "身元でない trailer のアドレスで赤になっている（偽陽性）");
  assert.equal(checked, 1, "身元の trailer だけを拾っていない");
});

/**
 * **正しい形だけを書いた本物のメッセージが緑であること**（偽陽性の確認）。
 * **この 2 形は `origin/main` の履歴で 518 件 / 66 件の実数を持つ**（実測 2026-09-28）。
 */
test("正しい 2 形だけのメッセージは緑（偽陽性の確認）", () => {
  const body = [
    "test(etl): 何かを検査に載せる (#1065)",
    "",
    "本文に Co-authored-by: という語を書いても拾わない。",
    "",
    "Closes #1074",
    "",
    "Co-Authored-By: uonoko1 <120390190+uonoko1@users.noreply.github.com>",
    "Co-authored-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
    "Claude-Session: https://claude.ai/code/session_x",
  ].join("\n");
  const { bad, checked } = misattributingTrailerEmails(body, new Set());
  assert.deepEqual(bad, [], "正しい形のメッセージで赤になっている（偽陽性）");
  assert.equal(checked, 2, "正しい 2 形を走査していない");
});

/**
 * **`IDENTITY_TRAILERS` は形ではなく列挙なので、縮めても上の検査は緑のまま通りうる。**
 * **だから列挙自身に当てる。**
 *
 * **大文字小文字の揺れは履歴に実在する**（`Co-authored-by:` 1175 行 / `Co-Authored-By:` 51 行、
 * 実測 2026-09-28）。**先頭に空白が付く形も squash のメッセージに実在する。**
 */
test("身元を名指しする trailer の列挙が縮んでいない", () => {
  for (const line of [
    "Co-authored-by: N <x@y.z>",
    "Co-Authored-By: N <x@y.z>", // 履歴に 51 行実在する
    "CO-AUTHORED-BY: N <x@y.z>",
    "co-authored by: N <x@y.z>",
    "Co-authored-by : N <x@y.z>",
    "  Co-authored-by: N <x@y.z>", // 先頭に空白
    "\tCo-authored-by: N <x@y.z>",
    "Signed-off-by: N <x@y.z>",
    "Reviewed-by: N <x@y.z>",
    "Tested-by: N <x@y.z>",
    "Reported-by: N <x@y.z>",
    "Acked-by: N <x@y.z>",
    "Helped-by: N <x@y.z>",
    "Suggested-by: N <x@y.z>",
  ]) assert.ok(IDENTITY_TRAILERS.test(line), `身元を名指しする trailer が走査から漏れている: ${line}`);
  for (const other of [
    "Claude-Session: https://claude.ai/code/session_x",
    "Closes #1074",
    "fix: Co-authored-by という語を件名に書いただけ", // 行頭の token: でない
    "本文の途中に Co-authored-by: と書いた文",
    "Refs: https://example.com",
    "Signed: N <x@y.z>",
  ]) assert.ok(!IDENTITY_TRAILERS.test(other), `関係の無い行を拾っている: ${other}`);
});

/**
 * **`git` の trailer パーサ（`%(trailers:only=true)`）に頼ると、
 * squash merge の区切りより上の `Co-Authored-By:` がまるごと落ちる**（この PBI の実測）。
 *
 * **実測（`origin/main` = `068be5c2`、696 commits）**:
 * `%(trailers:only=true)` で `noreply@anthropic.com` は **640**。本文を直接読むと **1643**。
 * **1003 件、つまり 61% が見えていなかった。**
 *
 * **だから「本文を行ごとに走査する」ことを固定する。**
 * **`%(trailers)` に切り替える変異はここが落とす。**
 */
test("squash merge の区切りより上の trailer も拾う（%(trailers) に頼らない）", () => {
  const body = [
    "feat: 何か (#1065)",
    "",
    "Closes #1053",
    "",
    "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>", // 開発者が書いた分（区切りより上）
    "Claude-Session: https://claude.ai/code/session_x",
    "",
    "---------",
    "",
    "Co-authored-by: Claude Opus 5 <noreply@anthropic.com>", // squash が合成した分
  ].join("\n");
  const { bad, checked } = misattributingTrailerEmails(body, new Set());
  assert.equal(checked, 2, "区切りより上の trailer を拾っていない（%(trailers) と同じ見落とし）");
  assert.deepEqual(bad, ["noreply@anthropic.com", "noreply@anthropic.com"]);
  // **git のパーサが 1 しか返すこと**を、その場で実測して固定する。
  // **前提が変わったら（git が区切りより上も数えるようになったら）ここが落ちて気づける。**
  const parsed = execFileSync("git", ["interpret-trailers", "--parse"], { input: body, encoding: "utf8" });
  const parsedCount = parsed.split("\n").filter((l) => /^co-authored-by:/i.test(l)).length;
  assert.equal(
    parsedCount,
    1,
    "git のパーサが 2 つ返すようになった（この検査の前提が変わった。本文走査はそれでも正しい）",
  );
});

/**
 * **`GIINRECORD_TRAILER_EMAIL_ALLOW` は逃げ道であり、検査を素通しにもできる。**
 * **だから「CI では空であること」を検査に載せる**——ローカルで一時的に使う以外の用途を潰す。
 *
 * **これが無いと、誰かが workflow に `GIINRECORD_TRAILER_EMAIL_ALLOW: noreply@anthropic.com` と
 * 書くだけで、この検査全体が黙って無力化される。**
 */
test("逃げ道の環境変数は、リポジトリのどこからも設定されていない", () => {
  // **`--untracked` を付ける**——付けないと、**まだコミットしていないこのファイル自身が
  // 見えず「母数 0」で落ちる**（実測。最初にそう書いて自分の検算に捕まった）。
  // **同時に、コミット前に workflow へ書き足された設定も見えるようになる。**
  const hits = (() => {
    try {
      return git("grep", "-n", "--untracked", "--", "GIINRECORD_TRAILER_EMAIL_ALLOW")
        .trim()
        .split("\n")
        .filter((l) => l !== "");
    } catch {
      return [] as string[];
    }
  })();
  assert.ok(hits.length > 0, "自分自身を grep できていない（走査が空回りしている）");
  const SELF = "packages/etl/test/commit-trailer-identity.test.ts:";
  const outside = hits.filter((l) => !l.startsWith(SELF));
  assert.deepEqual(
    outside,
    [],
    "この検査の外から逃げ道の環境変数が設定されている（検査が無力化される）:\n  " + outside.join("\n  "),
  );
  // **既定が空であること**——**未設定なら形の要求だけが効く。**
  // （`envAllow()` の既定を `?? ""` から `?? "noreply@anthropic.com"` に変える変異はここが落とす。）
  const saved = process.env.GIINRECORD_TRAILER_EMAIL_ALLOW;
  delete process.env.GIINRECORD_TRAILER_EMAIL_ALLOW;
  try {
    assert.equal(envAllow().size, 0, "環境変数が未設定のときに許容集合が空でない");
    // **未設定のままでも、誤帰属するアドレスが赤になること**（既定の許容集合が広がっていない）。
    const { bad } = misattributingTrailerEmails("x\n\nCo-authored-by: C <noreply@anthropic.com>");
    assert.deepEqual(bad, ["noreply@anthropic.com"], "既定の許容集合が広がっている");
  } finally {
    if (saved !== undefined) process.env.GIINRECORD_TRAILER_EMAIL_ALLOW = saved;
  }
});
