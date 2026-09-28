import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/**
 * **CI がコミットするときのメールアドレスは、数字 ID 付きでなければならない。**
 *
 * **裸のローカル部は、その名前の GitHub ユーザーに紐づく。** `git config user.email "etl@users.noreply.github.com"`
 * と書くと、GitHub はそのコミットを **github.com/etl**（実在する無関係の人）に紐づけ、
 * **Contributors に並ぶ**。**利用者から見て「誰が作ったか」が事実と違う**ので、
 * このプロジェクトの原則（事実のみ）に直接反する。
 *
 * **実測 2026-09-27**（`git log origin/main` の実体）:
 * ```
 * dev@users.noreply.github.com  author 48 件 / Co-Authored-By 516 件  → github.com/dev
 * etl@users.noreply.github.com  Co-Authored-By 55 件                  → github.com/etl
 * ```
 * **ブラウザの Contributors は 5 人**（API の `/contributors` は 3 人しか返さないので、
 * **API だけ見ていると気づけない**）。
 *
 * **denylist ではなく形の要求にしている**（#858 と同じ向き）——「`dev@` と `etl@` を禁じる」だと
 * 次に `bot@` や `ci@` を書いた人を捕まえられない。**`数字+名前@users.noreply.github.com`
 * という形そのものを要求する。**
 */
/**
 * **数字 ID 付きの GitHub noreply だけを通す**
 * （例: `41898282+github-actions[bot]@users.noreply.github.com`）。
 *
 * **定義は 1 か所だけ。** 初版は走査側と検査側に**同じ正規表現を 2 つ書いていた**ので、
 * **走査側だけを緩めると検査側は自分の写しを見て緑のまま通った**（レビューの実測:
 * `\d+\+` を `\d*\+?` にすると `etl@users.noreply.github.com` が素通りして 2/0 緑）。
 * **#858 を引きながら、同じ形を検査の中で作っていた。**
 * `scripts/ci/pr-closes.sh` が `CLOSING_RE` を写さずに実行時に取り出すのと同じ向きで直した。
 */
const OK = /^\d+\+[^@]+@users\.noreply\.github\.com$/;

/**
 * **メールアドレスらしい文字列**。`[bot]` の角括弧を含める——含めないと
 * `github-actions[bot]@…` が拾えず、**母数 0 で緑になる**（最初にそう書いて `checked > 0` に捕まった）。
 */
const EMAIL = /[A-Za-z0-9._%+\-\[\]]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * **`EMAIL` は `g` フラグ付きなので `.test()` を使い回すと `lastIndex` が残り、
 * 同じ文字列でも 2 度目に false を返す。** **毎回新しい正規表現で判定する。**
 */
const hasEmail = (line: string): boolean => new RegExp(EMAIL.source).test(line);

/**
 * **コメント行**。**飛ばさないと、この検査を説明する散文で CI が赤くなる**
 * （初版の実測: `etl.yml` のコメントを「メールアドレス」→「user.email」に書き換えるだけで落ちた）。
 * **純粋に編集上の書き換えで CI が落ちるのは偽陽性である。**
 *
 * **走査を追跡ファイル全体に広げたので、`#` だけでは足りない**（#1066）。
 * **実測 2026-09-29**: `#` だけのまま広げると、**`packages/etl/test/commit-trailer-identity.test.ts`
 * の JSDoc 2 か所**（L14 と L246。どちらも「`user.email`」と「`noreply@anthropic.com`」が
 * *別々の行* に在り、`foldContinuations` の窓で繋がった）で赤くなった。
 * **どちらも散文で、コミットの身元を 1 ミリも変えない。**
 *
 * **`*` は JSDoc の継続行**（` * …`）。**`*` 始まりの実行行は、この言語たちには無い。**
 */
const isComment = (line: string): boolean => /^\s*(?:#|\/\/|\/?\*)/.test(line);

/**
 * **コミットの身元を決めうる書き方**（ここに現れたアドレスを検査する）。
 *
 * **ここは形ではなく列挙なので、漏れがそのまま穴になる。** **列挙は縮めても誰も気づかなかった**
 * （レビューの実測: 4 つを `user\.email` だけに縮めても 2 pass / 0 fail で生き残った）。
 * **だから下で `IDENTITY_KEYS` 自身に「拾うべき行 / 拾ってはいけない行」を当てている。**
 *
 * `author.email` / `committer.email` は **git の正規の設定キー**で、初版は漏らしていた
 * （レビューの実測: `git -c author.email=etl@users.noreply.github.com commit` は
 * **author が `etl@` になったまま 2 pass / 0 fail で通った**）。
 */
const IDENTITY_KEYS = /(?:user\.email|author\.email|committer\.email|GIT_AUTHOR_EMAIL|GIT_COMMITTER_EMAIL|--author[= ])/;

/**
 * **行をまたぐ書き方を畳んでから走査する。**
 *
 * **行単位で走査すると、キーワードと値が別の行にあるだけで素通りする。**
 * **レビューの実測（使い捨て repo で実際にコミットして `%ae` を読んだ）では、
 * 次の 3 形が `etl@users.noreply.github.com` を刻んだまま 2 pass / 0 fail で通った**:
 *
 * ```
 * Y1 シェルの行継続:   git config user.email \
 *                        etl@users.noreply.github.com
 * X2 YAML の折り返し:  GIT_AUTHOR_EMAIL:
 *                        etl@users.noreply.github.com
 * S2 シェル変数経由:   EMAIL=etl@users.noreply.github.com
 *                      git config user.email "$EMAIL"
 * ```
 *
 * **畳み方**: **各行を、直前の行と繋げた窓も作る**。
 * **「身元のキーワードが在る行の近くにアドレスが在る」ことを見る**形にすると、3 形とも 1 つの規則で拾える
 * （Y1 は `git config user.email \ etl@…` という窓になる。**末尾 `\` を別に畳む必要は無い**——
 * **最初は 2 段に分けて書いたが、行継続の畳みを消しても検査が全部緑のままだった**。
 * **守られていないコードは置かない。**）
 *
 * **窓を広げるとアドレスを 2 度数えうるので、`checked` は畳む前の実数で数える**
 * （母数が膨らむと `checked > 0` の意味が薄れる）。
 */
const foldContinuations = (text: string): string[] => {
  const joined = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < joined.length; i += 1) {
    out.push(joined[i]);
    if (isComment(joined[i])) continue;
    // **窓に入れるのは「アドレスを含む行」だけ**にする。
    //
    // **最初は「すべての行を直前の行と繋げる」形で書いたが、偽陽性があった**:
    // **身元の行の *次* の行に無関係なアドレスが在ると、繋げた窓が赤くなる**
    // （`git config user.email "41898282+…"` の次の行に `echo "contact: someone@example.com"`
    // と書いただけで落ちた。**純粋に無関係な行で CI が赤くなるのは偽陽性である**）。
    //
    // **塞ぎ方**: **窓の 2 行のうち、アドレスを含む行と身元のキーワードを含む行が
    // 「別々の行」のときだけ繋げる。** 塞ぎたい 3 形はこれに当たる:
    //   Y1 / X2 は前の行にキーワード・後ろの行にアドレス
    //   S2 は前の行にアドレス・後ろの行にキーワード（`EMAIL=…` → `user.email "$EMAIL"`）
    // **偽陽性の形（身元の行にアドレスも在って、次の行に無関係なアドレス）は繋げない**——
    // **キーワードとアドレスが既に同じ 1 行に揃っているなら、その行だけで判定できる**ので窓は要らない。
    const prev = joined[i - 1];
    if (prev === undefined) continue;
    const selfSufficient = (l: string) => IDENTITY_KEYS.test(l) && hasEmail(l);
    if (selfSufficient(prev) || selfSufficient(joined[i])) continue;
    const pair = `${prev.trim()} ${joined[i].trim()}`;
    if (!IDENTITY_KEYS.test(pair) || !hasEmail(pair)) continue;
    out.push(pair);
  }
  return out;
};

/**
 * **実在の人に紐づきえないドメイン**（RFC 2606 / RFC 6761 の予約 TLD・予約ドメイン）。
 *
 * **これは「テストだから許す」という除外ではない。** **`.invalid` / `.test` / `example.com` は
 * 仕様で永久に解決しないことが決まっている**ので、**そこに実在の誰かの身元が乗ることが原理的に無い。**
 *
 * **パスで除外してはいけない**——`scripts/**\/test/**` を除外すると、**その除外自身が次の穴になる**
 * （`scripts/ci/test/` に本物の identity を置けば黙る）。**値の性質で除外すれば、置き場所に依存しない。**
 *
 * **実測 2026-09-29**（`git ls-files` の全走査）: この規則で落ちるのは `t@example.invalid` 7 件
 * （`scripts/ci/test/released-ref.test.sh` / `scripts/ci/test/stale-base.test.sh` /
 * `scripts/dev/test/mutate.test.sh`）**だけ**で、**本番のスクリプトは 1 件も除外されない。**
 */
const UNRESOLVABLE = /@(?:[A-Za-z0-9-]+\.)*(?:invalid|test|example|localhost)$|@(?:[A-Za-z0-9-]+\.)*example\.(?:com|org|net)$/i;

/**
 * **走査の範囲は「追跡されている全ファイル」**（#1066）。
 *
 * **初版は `.github/workflows/` だけを `readdirSync` していた。** **本文には
 * 「新しい workflow を足しても自動で対象になる」と書いてあったが、
 * *workflow が呼ぶスクリプト* は対象外**という非対称が書かれていなかった。
 *
 * **再現（2026-09-29 に実測）**: `etl.yml` の 2 行を `bash scripts/ci/set-identity.sh` に置き換え、
 * その `set-identity.sh` に `git config user.email "etl@users.noreply.github.com"` を書くと、
 * **`pass=5 fail=0`（完全に緑）** で通り、**`forbidden-patterns.sh` も `clean`** だった。
 * **`etl@` は実在する無関係の人**（github.com/etl）で、**履歴の書き換えでしか消せない**
 * （`docs/ops/etl-trailer-rewrite.md`）。**刻まれてからでは遅い。**
 *
 * **「`scripts/` も見る」と足すだけでは同じ型の穴が残る**——**次に別の場所
 * （`deploy/`・`Makefile`・`package.json` の `scripts`・composite action の `action.yml`）に
 * 移されたら、また沈黙する。** **列挙で追わず、`git ls-files` で全部を母数にする。**
 *
 * **母数**（実測 2026-09-29）:
 * ```
 * 追跡ファイル                                  10423
 *   うち #1066 の前に走査していた               15   (.github/workflows/*.yml   0.14%)
 *   うち #1066 の後に絞り込みの母数になる        10423 (git ls-files             100%)
 *   うち身元のキーワードを含む（実際に読む）     9     (git grep -lI             0.09%)
 *     .github/workflows/                        3
 *     packages/etl/test/                        2
 *     scripts/ci/test/                          3
 *     scripts/dev/test/                         1
 * ```
 * **`scripts/` の本番スクリプトに身元を設定しているものは 0 件**（実測）——
 * **これは「見ていないから 0 件」ではなく「全部見たうえで 0 件」である。**
 *
 * **塞げていない形**（範囲は構造で取ったが、それでも残るもの。
 * `scripts/ci/forbidden-patterns.sh` の作法に倣って書き残す）:
 * - **追跡されていないファイル**。`git ls-files` に出ないものは見えない
 *   （CI のランナーが実行時に `curl` で取ってきて実行する、など）。
 * - **`IDENTITY_KEYS` に無い書き方**。`GIT_CONFIG_KEY_0=user.email` / `GIT_CONFIG_COUNT`、
 *   `git commit --amend --reset-author`、`.mailmap`、`git config --global` を別プロセスで置く形。
 *   **列挙は「身元を決める書き方」の側にだけ残っている**（そこは別の検査で縮みを止めている）。
 * - **アドレスを組み立てる形**。`git config user.email "$(echo ZXRs | base64 -d)@…"` のように
 *   実行時にしか綴りが決まらないもの。**静的には読めない。**
 * - **他人の数字 ID**。`999+dev@users.noreply.github.com` は形として正しい。
 *   **逐語の allowlist でだけ止まる**（下の検査）。
 * - **`UNRESOLVABLE` に乗せる形**。`user.email` を `x@example.invalid` にすると通る。
 *   **通ってよい**——**実在の人に紐づかない**ので、誤帰属は起きない
 *   （Contributors には `x@example.invalid` のまま誰にも紐づかずに残る）。
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

const dir = repoRoot;

/** **追跡ファイルの総数**（母数。#757）。 */
const trackedCount = execFileSync("git", ["ls-files", "-z"], {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 1 << 28,
}).split("\0").filter(Boolean).length;

/**
 * **候補を絞るのに `git grep` を使う**（追跡ファイル全部を Node で読むと遅すぎる）。
 *
 * **実測 2026-09-29**: 全 9918 件を `readFileSync` すると **446 秒**かかった
 * （`data/*.json` が 2417 件在り、そこが支配的）。**`git grep -lI` は 0.9 秒**で、
 * **10423 件 → 9 件**に絞る。**絞った後は Node 側が全行を見る**ので、判定は変わらない。
 *
 * **絞り込みは「身元のキーワードを 1 つでも含むファイル」**——`foldContinuations` の窓は
 * **同じファイルの隣り合う行**しか繋がないので、**キーワードがどこにも無いファイルは
 * どう畳んでも赤くならない。** **だから絞っても取りこぼさない。**
 *
 * **パターンは `IDENTITY_KEYS.source` から作る。写さない。** **写すと、片方だけ緩めても
 * もう片方が自分の写しを見て緑のまま通る**（この検査が `OK` で一度踏んだ形。#858）。
 */
const grepPattern = IDENTITY_KEYS.source.replace(/^\(\?:/, "(").replace(/\)$/, ")");
const listCandidates = (): string[] => {
  let out: string;
  try {
    out = execFileSync("git", ["grep", "-lIzE", "--", grepPattern], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
  } catch (e) {
    // `git grep` は「1 件も一致しない」とき exit 1 を返す。**その区別は呼び出し側で
    // `checked > 0` に当たる**ので、ここでは空として扱う。
    const status = (e as { status?: number }).status;
    if (status === 1) return [];
    throw e;
  }
  return out.split("\0").filter(Boolean);
};

/** **この検査ファイル自身**。`etl@…` を *通してはいけない綴り* として持っているので、走査の対象から外す。
 * **パス除外はここ 1 件だけ**で、**その 1 件が身元を *設定* していないことを別の検査で固定する**（下）。 */
const SELF = "packages/etl/test/workflow-commit-identity.test.ts";
const candidates = listCandidates();
const files = candidates.filter((f) => f !== SELF);

/**
 * **テキストとして読めたものだけを返す**（PDF / woff2 / png などのバイナリは NUL を含む）。
 * **読めなかったものは `null`** ——数に入れない（母数を膨らませない）。
 */
const readText = (f: string): string | null => {
  let text: string;
  try {
    text = readFileSync(join(dir, f), "utf8");
  } catch {
    return null;
  }
  return text.includes("\0") ? null : text;
};

test("ワークフローが設定する user.email は、数字 ID 付きの noreply でなければならない", () => {
  assert.ok(files.length > 0, "身元のキーワードを含むファイルが 1 つも見つからない（走査が空回りしている）");
  const bad: string[] = [];
  let checked = 0;
  let scanned = 0;
  // **値は allowlist、書き方も allowlist にする。**
  // 最初の版はダブルクォートだけを拾っていた。**レビューの実測（使い捨て repo で実際にコミットして
  // `%ae` を読んだ）では、次の 5 形が素通りしたうえで `etl@users.noreply.github.com` を刻んだ**:
  //   シングルクォート / クォートなし / GIT_AUTHOR_EMAIL / git -c user.email= / git commit --author=
  // **「値だけ allowlist で、書き方は denylist」だと列挙漏れが残る**（#858 / #1022 と同じ向き）。
  // **メールアドレスらしい文字列を先に全部拾い、そのうえで形を要求する。**
  // `[bot]` の角括弧を含める——`github-actions[bot]@…` が拾えなくなり、
  // **母数 0 で緑になる**（最初にそう書いて `checked > 0` に捕まった）。
  for (const f of files) {
    const text = readText(f);
    if (text === null) continue;
    scanned += 1;
    // **母数は畳む前の実数で数える**（畳んだ窓は同じアドレスを 2 度通しうる）。
    for (const line of text.split("\n")) {
      if (isComment(line)) continue;
      if (!IDENTITY_KEYS.test(line)) continue;
      for (const _ of line.matchAll(EMAIL)) checked += 1;
    }
    for (const line of foldContinuations(text)) {
      // **コメント行は飛ばす。** 飛ばさないと、**この検査を説明する日本語のコメントに
      // `user.email` と書いた瞬間に赤くなる**（レビューの実測: `etl.yml` のコメントを
      // 「メールアドレス」→「user.email」に書き換えるだけで落ちた）。**純粋に編集上の
      // 書き換えで CI が落ちるのは偽陽性である。**
      if (isComment(line)) continue;
      if (!IDENTITY_KEYS.test(line)) continue;
      for (const m of line.matchAll(EMAIL)) {
        const email = m[0];
        // **実在の人に紐づきえないドメインは通す**（テスト用の使い捨て repo で必要になる）。
        // **パスではなく値の性質で除外している**ので、置き場所を変えても抜けられない。
        if (UNRESOLVABLE.test(email)) continue;
        if (!OK.test(email) && !bad.includes(`${f}: ${email}`)) bad.push(`${f}: ${email}`);
      }
    }
  }
  // **母数を出す**（#757）: 0 件で緑になっていないことを、まず確かめる。
  // **「0 件」と「見ていないから 0 件」を区別する**——走査したファイル数も固定する。
  // **実測 2026-09-29: 追跡 10423 件 → テキスト 9918 件。** 下限を置いて、
  // **`git ls-files` が空を返した / 1 ファイルしか読めなかったときに緑にならない**ようにする。
  // **追跡ファイルが数えられていること**（`git ls-files` が空を返したら走査は無意味）。
  // **実測 2026-09-29: 10423 件。**
  assert.ok(trackedCount > 1000, `追跡ファイルが少なすぎる（${trackedCount} 件。走査が空回りしている）`);
  // **候補が 1 件も無い ＝ `git grep` が空振りした**（パターンが壊れた等）。**実測 2026-09-29: 9 件。**
  assert.ok(scanned > 0, "身元のキーワードを含むファイルが 1 件も無い（絞り込みが空回りしている）");
  assert.ok(checked > 0, "user.email を設定している箇所が 1 つも見つからない（走査が空回りしている）");
  assert.deepEqual(bad, [], `裸のローカル部は無関係の GitHub ユーザーに紐づく。数字 ID 付きにすること:\n  ${bad.join("\n  ")}`);
});

/**
 * **上の検査は、いま在る 3 件が全部正しいので `bad` が構造的に空**になる。
 * **だから `OK` を「何でも通す」形に緩めても緑のまま通る**（レビューの実測）——
 * **`OK` そのものが何も主張していない。** #858 を引きながら、同じ形を検査の中で作っていた。
 *
 * **だから `OK` を、通すべき綴りと通してはいけない綴りに直接当てる。**
 * ここが落ちれば「正規表現が緩んだ」と分かる（走査の側とは別の理由で落ちる）。
 */
test("数字 ID 付きの noreply だけを通す正規表現そのものを検査する", () => {
  // 通すべき（実在の形）
  for (const good of [
    "41898282+github-actions[bot]@users.noreply.github.com",
    "120390190+uonoko1@users.noreply.github.com",
  ]) assert.ok(OK.test(good), `通すべき綴りが落ちた: ${good}`);
  // 通してはいけない（#1043 の発端。裸のローカル部はその名前のユーザーに紐づく）
  for (const bad of [
    "dev@users.noreply.github.com",
    "etl@users.noreply.github.com",
    "bot@users.noreply.github.com",
    "someone@example.com", // **実在の個人アドレスを OSS のソースに書かないこと**（レビューの指摘）。外部ドメインが落ちることは架空のアドレスで完全に言える
    "41898282+github-actions[bot]@example.com",
    "+uonoko1@users.noreply.github.com",
    "120390190@users.noreply.github.com",
  ]) assert.ok(!OK.test(bad), `通してはいけない綴りが通った: ${bad}`);
});

/**
 * **`IDENTITY_KEYS` は形ではなく列挙なので、縮めても誰も気づかなかった**
 * （レビューの実測: 4 つを `user\.email` だけに縮めても **2 pass / 0 fail で生き残った**）。
 * **上の走査は「いま在る 3 件が正しい」ので、列挙が縮んでも `bad` は空のまま緑になる。**
 *
 * **だから列挙自身に当てる。** ここが落ちれば「拾う範囲が狭まった」と分かる。
 */
test("身元を決める書き方の列挙（IDENTITY_KEYS）が縮んでいない", () => {
  // 拾わなければならない書き方（すべて実際にコミットの身元を変えられる。レビューが使い捨て repo で `%ae` を実測）
  for (const key of [
    'git config user.email "x@y.z"',
    "git -c author.email=x@y.z commit -m x",
    "git -c committer.email=x@y.z commit -m x",
    "GIT_AUTHOR_EMAIL=x@y.z git commit -m x",
    "GIT_COMMITTER_EMAIL=x@y.z git commit -m x",
    "git commit --author='N <x@y.z>' -m x",
    "git commit --author 'N <x@y.z>' -m x",
  ]) assert.ok(IDENTITY_KEYS.test(key), `身元を決める書き方が走査から漏れている: ${key}`);
  // 拾う必要が無い行（ここまで広げると、無関係な行のアドレスで赤くなる）
  for (const other of [
    "      - uses: actions/checkout@v4",
    "        run: pnpm install --frozen-lockfile",
    // **`--author` の部分一致で拾ってはいけない行**（レビューの指摘）。
    // **身元を変えないのに拾うと、無関係な行のアドレスで CI が赤くなる**
    // （`--author` のままだと `git log --author-date-order` も `git shortlog --author-date` も拾った）。
    "          git log --author-date-order -1",
    "          git shortlog --author-date",
  ]) assert.ok(!IDENTITY_KEYS.test(other), `関係の無い行を拾っている: ${other}`);
});

/**
 * **`OK` は「数字 ID 付きの形」しか要求できない。** **他人の数字 ID を書いた場合は通る**
 * （レビューの実測: `999+dev@users.noreply.github.com` は 2 pass / 0 fail で通る）。
 * **正規表現では「その数字が本人の ID か」を言えない**ので、これは設計上の限界である。
 *
 * **いま在る 3 か所は逐語で同じアドレスなので、逐語を要求する**のが一番安い塞ぎ方になる。
 * **`41898282` は GitHub API で確認した**（`id=41898282` / `login=github-actions[bot]` / `type=Bot`。
 * 実測 2026-09-27。**逆引きでも一致**）。**Bot なので、実在の人に誤帰属しない。**
 *
 * **意図して別の identity に変えるときは、この逐語も一緒に直すことになる**——
 * **それが狙いである**（「誰の名前でコミットするか」は黙って変わってよい設定ではない）。
 */
test("ワークフローが使う identity は、本人確認した逐語のアドレスだけ", () => {
  const EXPECT = "41898282+github-actions[bot]@users.noreply.github.com";
  const seen = new Set<string>();
  for (const f of files) {
    const text = readText(f);
    if (text === null) continue;
    for (const line of foldContinuations(text)) {
      if (isComment(line)) continue;
      if (!IDENTITY_KEYS.test(line)) continue;
      for (const m of line.matchAll(EMAIL)) {
        if (UNRESOLVABLE.test(m[0])) continue;
        seen.add(m[0]);
      }
    }
  }
  assert.ok(seen.size > 0, "identity を設定している箇所が 1 つも見つからない（走査が空回りしている）");
  assert.deepEqual(
    [...seen].sort(),
    [EXPECT],
    `本人確認していない identity が使われている（許すのは ${EXPECT} だけ）`,
  );
});

/**
 * **`foldContinuations` は「行をまたぐ書き方」を塞ぐための道具だが、
 * いま在る 3 か所が 1 行に収まっているので、素通しに戻しても上の検査は全部緑になる**
 * （実測: `return out` を `return joined` に変えても 4 pass / 0 fail）。
 * **道具を足しただけでは、道具は守られていない**（#1043 の初版と同じ過ち）。
 *
 * **だから畳む側に直接当てる。** ここが落ちれば「行をまたぐ穴が開いた」と分かる。
 * **入れる 3 形は、レビュアーが使い捨て repo で実際にコミットして `%ae` を読み、
 * `etl@users.noreply.github.com` が刻まれることを確かめたもの**である。
 */
test("行をまたぐ書き方を畳んでいる（素通しに戻すと落ちる）", () => {
  const cases: [string, string][] = [
    [
      "Y1 シェルの行継続",
      '          git config user.email \\\n            etl@users.noreply.github.com\n',
    ],
    [
      "X2 YAML の plain scalar の折り返し",
      "        env:\n          GIT_AUTHOR_EMAIL:\n            etl@users.noreply.github.com\n",
    ],
    [
      "S2 シェル変数を経由",
      '          EMAIL=etl@users.noreply.github.com\n          git config user.email "$EMAIL"\n',
    ],
  ];
  for (const [name, yaml] of cases) {
    const hit = foldContinuations(yaml).some(
      (line) =>
        !isComment(line) &&
        IDENTITY_KEYS.test(line) &&
        [...line.matchAll(EMAIL)].some((m) => !OK.test(m[0])),
    );
    assert.ok(hit, `行をまたぐ書き方が走査から漏れている: ${name}`);
  }
  // **畳みすぎていないことも見る**——無関係な行のアドレスを身元の行に繋げてはいけない。
  // **身元の行の *次* の行に無関係なアドレスが在る形**。
  // **これは実際に偽陽性だった**（「すべての行を直前の行と繋げる」形で書いていたとき、
  // `echo "contact: …"` を足しただけで落ちた）。**窓の後ろ側がアドレスを含む行のときだけ
  // 繋げる形に直して塞いだ。** ここが落ちれば偽陽性が戻ったと分かる。
  const benign =
    '          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"\n          echo "contact: someone@example.com"\n';
  const falsePositive = foldContinuations(benign).some(
    (line) =>
      !isComment(line) &&
      IDENTITY_KEYS.test(line) &&
      [...line.matchAll(EMAIL)].some((m) => !OK.test(m[0])),
  );
  assert.ok(!falsePositive, "無関係な行のアドレスを身元の行に繋げている（偽陽性）");
});

/**
 * **走査の範囲が `.github/workflows/` の外に届いていること**（#1066 の本体）。
 *
 * **初版は `.github/workflows/` を `readdirSync` するだけだった。** **workflow が呼ぶスクリプトに
 * identity を移した瞬間に黙る**（実測 2026-09-29: `etl.yml` の 2 行を
 * `bash scripts/ci/set-identity.sh` に置き換え、そのスクリプトに `etl@users.noreply.github.com`
 * を書くと **`pass=5 fail=0`** で通り、`forbidden-patterns.sh` も `clean` だった）。
 *
 * **ここが落ちれば「走査が `.github/` に戻った」と分かる。** **上の走査だけでは分からない**
 * ——**いま在る 3 件が全部正しいので、範囲を狭めても `bad` は空のまま緑になる。**
 */
test("走査の候補が .github/ の外にも届いている（範囲が狭まっていない）", () => {
  assert.ok(
    candidates.length > 0,
    "身元のキーワードを含むファイルが 1 件も無い（git grep が空回りしている）",
  );
  // **`.github/` 以外の候補が在ること。** **実測 2026-09-29: 候補 9 件のうち 6 件が `.github/` の外**
  // （`packages/etl/test/` 2 / `scripts/ci/test/` 3 / `scripts/dev/test/` 1）。
  const outside = candidates.filter((f) => !f.startsWith(".github/"));
  assert.ok(
    outside.length > 0,
    `走査が .github/ の中だけに戻っている（候補 ${candidates.length} 件すべてが .github/ 配下）`,
  );
  // **`scripts/` に届いていること**を名指しで固定する。**#1066 の逃げ道がそこだった。**
  assert.ok(
    candidates.some((f) => f.startsWith("scripts/")),
    `走査が scripts/ に届いていない（候補: ${candidates.join(", ")}）`,
  );
  // **母数を出す**（#757）: **「0 件」と「見ていないから 0 件」を区別する。**
  // **絞り込みの前が追跡ファイル全部であること**を数で固定する。
  assert.ok(
    trackedCount > candidates.length * 10,
    `絞り込みの母数が小さすぎる（追跡 ${trackedCount} 件 / 候補 ${candidates.length} 件）`,
  );
});

/**
 * **`git grep` に渡すパターンは `IDENTITY_KEYS` から作る。写さない。**
 *
 * **写すと、片方だけ緩めてももう片方が自分の写しを見て緑のまま通る**
 * （この検査は `OK` で一度その形を踏んでいる。#858）。
 * **絞り込みが `IDENTITY_KEYS` より狭くなると、狭くなった分だけ黙って沈黙する。**
 *
 * **ここが落ちれば「絞り込みと判定がずれた」と分かる。**
 */
test("git grep の絞り込みパターンは IDENTITY_KEYS から導かれている（写しではない）", () => {
  // **`IDENTITY_KEYS` が拾う書き方は、すべて絞り込みも拾わなければならない。**
  const asGrep = new RegExp(grepPattern);
  for (const key of [
    'git config user.email "x@y.z"',
    "git -c author.email=x@y.z commit -m x",
    "git -c committer.email=x@y.z commit -m x",
    "GIT_AUTHOR_EMAIL=x@y.z git commit -m x",
    "GIT_COMMITTER_EMAIL=x@y.z git commit -m x",
    "git commit --author='N <x@y.z>' -m x",
  ]) {
    assert.ok(IDENTITY_KEYS.test(key), `前提が壊れている: ${key}`);
    assert.ok(asGrep.test(key), `絞り込みが IDENTITY_KEYS より狭い（取りこぼす）: ${key}`);
  }
  // **逆向き**——絞り込みが `IDENTITY_KEYS` より *広い* のは安全側だが、
  // **同じ列挙から作られていること**を綴りで固定しておく（写しに戻したら落ちる）。
  const rebuilt = IDENTITY_KEYS.source.replace(/^\(\?:/, "(").replace(/\)$/, ")");
  assert.equal(grepPattern, rebuilt, "絞り込みパターンが IDENTITY_KEYS から導かれていない");
});

/**
 * **`UNRESOLVABLE` は「テストだから許す」ではなく「実在の人に紐づきえないから許す」。**
 *
 * **パスで除外すると、その除外自身が次の穴になる**——`scripts/**\/test/**` を除外したら
 * **`scripts/ci/test/` に本物の identity を置けば黙る。** **値の性質で除外すれば置き場所に依存しない。**
 *
 * **`UNRESOLVABLE` は走査だけでは守られない**——**いま在る除外対象が全部 `.invalid` なので、
 * 何でも通す形に緩めても走査は緑のまま**（`OK` が一度踏んだ形）。**だから直接当てる。**
 */
test("実在の人に紐づきえないドメインだけを除外している（UNRESOLVABLE）", () => {
  // **除外してよい**（RFC 2606 / RFC 6761。永久に解決しない）
  for (const safe of [
    "t@example.invalid", // **いま実際に除外している綴り**（7 件）
    "etl@example.invalid",
    "dev@example.test",
    "x@localhost",
    "a@example.com",
    "a@example.org",
    "a@example.net",
    "a@sub.example.com",
  ]) assert.ok(UNRESOLVABLE.test(safe), `実在しえないドメインを除外していない: ${safe}`);
  // **除外してはいけない**（実在の人に紐づきうる）
  for (const real of [
    "etl@users.noreply.github.com", // **#1043 の発端。github.com/etl は実在の個人**
    "dev@users.noreply.github.com",
    "bot@users.noreply.github.com",
    "noreply@anthropic.com",
    "41898282+github-actions[bot]@users.noreply.github.com",
    // **`example` を含むだけのドメインは実在しうる**（`example.co.jp` は予約ではない）
    "a@example.co.jp",
    "a@notexample.com",
    "a@invalid.com",
    "a@test.com",
  ]) assert.ok(!UNRESOLVABLE.test(real), `実在しうるドメインを除外している: ${real}`);
});

/**
 * **パス除外は `SELF` の 1 件だけ**（この検査ファイル自身。`etl@…` を *通してはいけない綴り*
 * として持っているので、自分を走査すると必ず赤くなる）。
 *
 * **除外は新しい穴になりうる**ので、**除外した 1 件が身元を *設定* していないこと**を別に検査する。
 * **`git config user.email` を実行する行がこのファイルに在れば落ちる。**
 *
 * **判定の仕方**: **文字列リテラルやコメントではなく、実際に実行されうる行**を見る。
 * このファイルは **`node:child_process` の `execFileSync` しか外部を呼ばない**ので、
 * **`git` に `config` / `commit` を渡している呼び出しが無いこと**を要求する。
 */
test("パス除外した 1 件（この検査ファイル自身）は、身元を設定していない", () => {
  const self = readText(SELF);
  assert.ok(self !== null, `除外したファイルが読めない: ${SELF}`);
  const text = self as string;
  // **`execFileSync("git", [...])` の第 2 引数に `config` / `commit` が現れないこと。**
  const calls = [...text.matchAll(/execFileSync\(\s*"git"\s*,\s*\[([^\]]*)\]/g)].map((m) => m[1]);
  assert.ok(calls.length > 0, "git の呼び出しが 1 つも見つからない（この検査が空回りしている）");
  for (const args of calls) {
    assert.ok(
      !/"(?:config|commit)"/.test(args),
      `除外したファイルが身元を設定しうる git を呼んでいる: git [${args.trim()}]`,
    );
  }
  // **`-c user.email=` のような形も、*呼び出しの引数配列の中に* 無いこと。**
  // **ファイル全体を `/"-c"/` で見てはいけない**——**この検査の *フィクスチャ* の文字列
  // （`"git -c author.email=x@y.z commit -m x"`）に当たって赤くなる**。
  // **実際に赤くなったので直した**（フィクスチャを消すのではなく、判定を呼び出しに絞る）。
  for (const args of calls) {
    assert.ok(
      !/"-c"/.test(args),
      `除外したファイルが git -c を呼んでいる（身元を渡しうる）: git [${args.trim()}]`,
    );
  }
});
