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
 * **コメントの綴りは言語ごとに違う。** **1 つの正規表現を全言語に当ててはいけない。**
 *
 * **なぜ分けるか（レビューの実測。#1066 の差し戻し）**: 初版は `#` / `//` / `*` を
 * **どの拡張子にも一律に**当てていた。**その結果、シェルの *実行される行* を読み飛ばした。**
 * **対照実験（同じ 1 行で、先頭の `*` の有無だけが違う）**:
 *
 * ```
 * CONTROL-A  git config user.email etl@…            → pass=7 fail=2   捕まる
 * CONTROL-B  *IGNORED* git config user.email etl@…  → pass=9 fail=0   沈黙
 * ```
 *
 * **`//` も `*` も、シェルではコメントではない**（担当者が実機で確認、2026-09-29）:
 * ```
 * //usr/bin/git --version   →  git version 2.43.0     ← 普通に起動する
 * （cd / && echo *sr/bin/git）→  usr/bin/git           ← glob で展開される
 * ```
 * **`//` は POSIX では「絶対パスの先頭」であって、コメントの綴りではない。**
 * **初版の doc コメントに書いた「`*` 始まりの実行行はこの言語たちには無い」は誤りだった。**
 *
 * **だから「その拡張子で実際にコメントである綴り」だけを当てる。**
 * **分からない拡張子は「コメント無し」として扱う**——**落とさない側に倒す**
 * （#569: 「記録が出ない」と「別人の記録が出る」は同じ重さではない）。
 */
const COMMENT_SLASH = /^\s*(?:\/\/|\/?\*)/;
const COMMENT_HASH = /^\s*#/;

/**
 * **拡張子 → コメントの綴り。** `null` は「この形式にコメントは無い（全行を読む）」。
 *
 * **`.md` と `.json` を `null` にしている**のは意図的である。
 * **md のコードブロックに書かれた `git config user.email "etl@…"` は捕まる**——
 * **それでよい**（PO 判断）。**手順書の「悪い例」は `x@example.invalid` のような
 * 明らかに架空の綴りで書くべきで、逐語で書くと数える人も検査も迷う**
 * （`docs/ops/etl-trailer-rewrite.md` で「散文 9 件 / trailer 行 3 件」の数え違いが起きた）。
 */
const commentRuleFor = (file: string): RegExp | null => {
  if (/\.(?:ts|tsx|js|jsx|mjs|cjs|css)$/.test(file)) return COMMENT_SLASH;
  if (/\.(?:sh|bash|ya?ml|toml|py|conf|cfg|ini)$/.test(file)) return COMMENT_HASH;
  if (/(?:^|\/)(?:Makefile|Dockerfile|\.gitignore|\.dockerignore|\.nvmrc)$/.test(file)) return COMMENT_HASH;
  return null;
};

/**
 * **その行が、そのファイルの言語でコメントか。**
 *
 * **飛ばさないと、この検査を説明する散文で CI が赤くなる**
 * （初版の実測: `etl.yml` のコメントを「メールアドレス」→「user.email」に書き換えるだけで落ちた。
 * 走査を `.ts` に広げたときも `commit-trailer-identity.test.ts` の JSDoc 2 か所が赤くなった）。
 * **純粋に編集上の書き換えで CI が落ちるのは偽陽性である。**
 *
 * **実測 2026-09-29（候補を 3 通りで走査した）**:
 * ```
 * コメントを除外しない        偽陽性 2 件（commit-trailer-identity.test.ts の JSDoc）
 * `#` だけを除外する          偽陽性 2 件（同上。`.ts` に `#` は効かない）
 * 言語ごとに分ける            偽陽性 0 件  ← これを採る
 * ```
 */
const isComment = (file: string, line: string): boolean => {
  const rule = commentRuleFor(file);
  return rule !== null && rule.test(line);
};

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
 *
 * **`i` フラグが要る。git の設定キーは大小を区別しない**（レビューの指摘。#1066 の差し戻し）。
 * **担当者が実機で確認した（2026-09-29、git 2.43.0）**:
 * ```
 * git config --local user.EMAIL 'etl@users.noreply.github.com'
 * git commit --allow-empty -m probe
 *   刻まれた author: etl@users.noreply.github.com      ← 大文字でも効いてしまう
 * git config --local User.Email 'dev@users.noreply.github.com'
 *   刻まれた author: dev@users.noreply.github.com      ← 混在でも効く
 * ```
 * **`i` を付ける前は `pass=9 fail=0` で沈黙した**（実測）。
 *
 * **一方、CLI のフラグと環境変数は大小を区別する**ので、`i` で広がる分は空振りに終わる
 * （実機で確認: `git commit --Author=…` は `error: unknown option`、
 * `git_author_email=…` は無視されて `user.email` のほうが勝った）。
 * **広がっても誤検出にならないことは下の検査で固定している**
 * （`--author-date-order` / `--Author-Date-Order` はどちらも拾わない——
 * **`[= ]` の要求が大小に関係なく効くため**）。
 */
const IDENTITY_KEYS = /(?:user\.email|author\.email|committer\.email|GIT_AUTHOR_EMAIL|GIT_COMMITTER_EMAIL|--author[= ])/i;

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
const foldContinuations = (file: string, text: string): string[] => {
  const joined = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < joined.length; i += 1) {
    out.push(joined[i]);
    if (isComment(file, joined[i])) continue;
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
 * 追跡ファイル                                  10426
 *   うち #1066 の前に走査していた               15    (.github/workflows/*.yml   0.14%)
 *   うち #1066 の後に絞り込みの母数になる        10426 (git ls-files             100%)
 *   うち身元のキーワードを含む（実際に読む）     13    (git grep -lIzi           0.12%)
 *     .github/workflows/                        3
 *     packages/etl/test/                        3
 *     scripts/ci/test/                          3
 *     .claude/agents/                           2
 *     scripts/dev/test/                         1
 *     scripts/po/                               1
 * ```
 * **基点が動くと数も動く**（#1074）——**これは 2026-09-29 に
 * `origin/main` を取り込んだ時点の数である。** **数え方:**
 * ```
 * git ls-files | wc -l
 * git grep -lIziE -- '(user\.email|author\.email|committer\.email|GIT_AUTHOR_EMAIL|GIT_COMMITTER_EMAIL|--author[= ])' | tr '\0' '\n' | grep -c .
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
 * **実測 2026-09-29**: 追跡ファイル全件を `readFileSync` すると **446 秒**かかった
 * （`data/` の JSON が支配的）。**`git grep -lI` は 0.9 秒**で、
 * **10426 件 → 13 件**に絞る。**絞った後は Node 側が全行を見る**ので、判定は変わらない。
 *
 * **`data/` の JSON の件数は、数え方で変わる**（レビューで 8905 と 8900 が並んだ。
 * **どちらも正しく、glob の意味が違う**）。**次に数える人が同じ数を出せるように、
 * コマンドごと書き残す**（#757）:
 * ```
 * git ls-files 'data/*.json'      → 8905   git の pathspec の `*` は `/` を跨ぐ（全階層）
 * git ls-files 'data/**\/*.json'  → 8900   直下の 5 件を含まない
 *   差の 5 件 = data/{meta,unmatched,unmatched-bills,unmatched-groups,group-mismatch}.json
 * git ls-files '*.json'           → 8961   data/ の外も含む追跡 JSON の全部
 * ```
 * **初版はここに 2417 と書いていたが、それは誤りだった**——
 * `git ls-files | sed 's/.*\.//' | uniq -c` で数えたときに、
 * **パスの一部が `json"` として別に数えられていた。**
 *
 * **絞り込みは「身元のキーワードを 1 つでも含むファイル」**——`foldContinuations` の窓は
 * **同じファイルの隣り合う行**しか繋がないので、**キーワードがどこにも無いファイルは
 * どう畳んでも赤くならない。** **だから絞っても取りこぼさない。**
 *
 * **パターンは `IDENTITY_KEYS.source` から作る。写さない。** **写すと、片方だけ緩めても
 * もう片方が自分の写しを見て緑のまま通る**（この検査が `OK` で一度踏んだ形。#858）。
 */
const grepPattern = IDENTITY_KEYS.source.replace(/^\(\?:/, "(").replace(/\)$/, ")");

/**
 * **`git grep` のフラグは `IDENTITY_KEYS.flags` から作る。手で書かない。**
 *
 * **片方だけに `i` が付くと、絞り込みの段階で落ちて黙って沈黙する**
 * （判定側だけ `i` にしても、`git grep` が `user.EMAIL` の行を候補に含めなければ
 * その行は一度も読まれない）。**「片方だけ」の事故は #1103 で実際に起きている。**
 *
 * **だから 2 つを別々に書かず、1 つの事実（`IDENTITY_KEYS` の flags）から導く。**
 */
const grepFlagsFor = (re: RegExp): string => `-lIzE${re.flags.includes("i") ? "i" : ""}`;
const grepFlags = grepFlagsFor(IDENTITY_KEYS);
const listCandidates = (): string[] => {
  let out: string;
  try {
    out = execFileSync("git", ["grep", grepFlags, "--", grepPattern], {
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
      if (isComment(f, line)) continue;
      if (!IDENTITY_KEYS.test(line)) continue;
      for (const _ of line.matchAll(EMAIL)) checked += 1;
    }
    for (const line of foldContinuations(f, text)) {
      // **コメント行は飛ばす。** 飛ばさないと、**この検査を説明する日本語のコメントに
      // `user.email` と書いた瞬間に赤くなる**（レビューの実測: `etl.yml` のコメントを
      // 「メールアドレス」→「user.email」に書き換えるだけで落ちた）。**純粋に編集上の
      // 書き換えで CI が落ちるのは偽陽性である。**
      if (isComment(f, line)) continue;
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
  // **実測 2026-09-29: 追跡 10426 件。** 下限を置いて、
  // **`git ls-files` が空を返した / 1 ファイルしか読めなかったときに緑にならない**ようにする。
  // **追跡ファイルが数えられていること**（`git ls-files` が空を返したら走査は無意味）。
  // **実測 2026-09-29: 10426 件。**
  assert.ok(trackedCount > 1000, `追跡ファイルが少なすぎる（${trackedCount} 件。走査が空回りしている）`);
  // **候補が 1 件も無い ＝ `git grep` が空振りした**（パターンが壊れた等）。**実測 2026-09-29: 13 件。**
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
  // **本人確認済みの逐語のアドレスだけを許す**（形ではなく綴りで固定する）。
  //
  // **2 件在るのは、走査が追跡ファイル全体に広がったから**（#1066）。
  // **どちらも「実際にこのプロジェクトが使う identity」で、誤帰属しない:**
  // ```
  // 41898282+github-actions[bot]@…  GitHub Actions 自身（Bot。実在の人に紐づかない）
  //                                 .github/workflows/{etl,districts,local-assemblies}.yml が設定する
  // 120390190+uonoko1@…             この repo の所有者（本人確認済み: gh api user/120390190 → uonoko1）
  //                                 .claude/agents/developer.md が「使うべき値」として書いている
  // ```
  //
  // **`developer.md` の 1 行を「例だから」と走査から外す道は採らなかった**（#1066 の差し戻し）。
  // **一度 `stripQuotedSpans` で「md のバッククォートの中は引用」として外したが、
  // それは「バッククォートで囲めば何でも書ける」という逃げ場を作っていた**
  // （レビューの実測: `.claude/agents/*.md` に
  // `` `git config user.email etl@users.noreply.github.com` `` と書くと **14 pass / 0 fail で沈黙**。
  // **囲まなければ 12 pass / 2 fail で捕まる**）。
  // **`.claude/agents/*.md` はエージェントが読んで *従う* 指示であって、ただの散文ではない。**
  // **この PR の発端そのものが、その証拠である。**
  //
  // **逐語で 2 件を許すほうが安全である**——**増えたら必ずここが落ちるので、
  // 「誰の名前でコミットするか」が黙って変わることはない。**
  const EXPECT = [
    "120390190+uonoko1@users.noreply.github.com",
    "41898282+github-actions[bot]@users.noreply.github.com",
  ];
  const seen = new Set<string>();
  for (const f of files) {
    const text = readText(f);
    if (text === null) continue;
    for (const line of foldContinuations(f, text)) {
      if (isComment(f, line)) continue;
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
    [...EXPECT].sort(),
    `本人確認していない identity が使われている（許すのは次の ${EXPECT.length} 件だけ）:\n  ${EXPECT.join("\n  ")}`,
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
    const hit = foldContinuations("x.yml", yaml).some(
      (line) =>
        !isComment("x.yml", line) &&
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
  const falsePositive = foldContinuations("x.yml", benign).some(
    (line) =>
      !isComment("x.yml", line) &&
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
  // **`.github/` 以外の候補が在ること。** **実測 2026-09-29: 候補 13 件のうち 10 件が `.github/` の外**
  // （`packages/etl/test/` 3 / `scripts/ci/test/` 3 / `.claude/agents/` 2 /
  // `scripts/dev/test/` 1 / `scripts/po/` 1）。
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
  // **除外が「1 件だけ」であることを数で固定する。**
  //
  // **これは変異で見つけた穴である**（実測 2026-09-29。M10）:
  // 除外を `f !== SELF` から `!f.startsWith("packages/etl/test/")` に広げると、
  // **9 pass / 0 fail で生き残った**——**ディレクトリごと除外しても誰も気づかない。**
  // **除外が広がれば、そこは identity の新しい逃げ場になる。**
  const excluded = candidates.filter((f) => !files.includes(f));
  assert.deepEqual(
    excluded,
    [SELF],
    `パス除外は ${SELF} の 1 件だけ（除外が広がると、そこが identity の逃げ場になる）`,
  );

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

/**
 * **コメント判定は言語ごとに分かれていなければならない**（#1066 の差し戻し。要修正 1）。
 *
 * **初版は `#` / `//` / `*` を全言語に一律に当てていたので、
 * シェルの *実行される行* を読み飛ばした。** **レビュアーの対照実験
 * （同じ 1 行で、先頭の `*` の有無だけが違う）**:
 *
 * ```
 * CONTROL-A  git config user.email etl@…            → pass=7 fail=2   捕まる
 * CONTROL-B  *IGNORED* git config user.email etl@…  → pass=9 fail=0   沈黙
 * ```
 *
 * **`//` も `*` もシェルではコメントではない**（実機確認 2026-09-29、git 2.43.0）:
 * `//usr/bin/git --version` は `git version 2.43.0` を返し、`*sr/bin/git` は glob で展開される。
 *
 * **走査だけでは守られない**——**いま追跡されているファイルに
 * `*` 始まりの identity 行が無いので、規則を戻しても `bad` は空のまま緑になる。**
 * **だから判定そのものに当てる。**
 */
test("コメント判定は言語ごとに分かれている（シェルの実行行を読み飛ばさない）", () => {
  // **シェル**: `#` だけがコメント。**`//` と `*` は実行される。**
  assert.ok(
    isComment("scripts/ci/x.sh", "# git config user.email etl@users.noreply.github.com"),
    "シェルの # をコメントとして扱っていない",
  );
  for (const [line, why] of [
    ["*IGNORED* git config user.email etl@users.noreply.github.com", "CONTROL-B: glob で展開され実行される"],
    ["//usr/bin/git config user.email dev@users.noreply.github.com", "`//` は絶対パスの先頭で、普通に起動する"],
    ["  * git config user.email etl@users.noreply.github.com", "字下げした `*` も同じ"],
  ]) assert.ok(!isComment("scripts/ci/x.sh", line), `シェルの実行行をコメント扱いしている（沈黙する）: ${why}`);

  // **YAML**: `#` だけ。
  assert.ok(isComment(".github/workflows/x.yml", "  # note"), "YAML の # をコメントとして扱っていない");
  assert.ok(
    !isComment(".github/workflows/x.yml", "          //usr/bin/git config user.email etl@users.noreply.github.com"),
    "YAML の実行行（run: の中身）をコメント扱いしている",
  );

  // **TypeScript**: `//` と JSDoc の `*`。**`#` はコメントではない。**
  assert.ok(isComment("packages/etl/test/a.test.ts", "// git config user.email x"), ".ts の // を落としている");
  assert.ok(isComment("packages/etl/test/a.test.ts", " * user.email … noreply@anthropic.com"), "JSDoc の継続行を落としている");
  assert.ok(
    !isComment("packages/etl/test/a.test.ts", '# git config user.email "etl@users.noreply.github.com"'),
    ".ts で `#` をコメント扱いしている（.ts に `#` のコメントは無い）",
  );

  // **md / json / 拡張子なし**: **コメントとして除外しない**（落とさない側に倒す。#569）。
  //
  // **fixture は「どれかの規則に *当たる* 行」でなければならない**（レビューの指摘。#1066 の再差し戻し）。
  // **初版は `git config user.email etl@…` しか当てていなかった**——**`g` で始まるので
  // `#` にも `//` にも `*` にも当たらず、`commentRuleFor` が何を返しても assert が通った。**
  // **実測: `return null;` を `return COMMENT_HASH;` に変える変異が 12 pass / 0 fail で生存した**
  // （同型の「`md` を `COMMENT_HASH` 側に足す」変異も生存）。
  // **その状態では、`.md` と拡張子なしスクリプトの `# git config user.email etl@…` が沈黙した。**
  //
  // **だから各規則の *先頭文字* を持つ行を当てる。** ここが落ちれば「安全側に倒す」が壊れたと分かる。
  for (const f of ["docs/ops/a.md", "package.json", "some/unknown-file", "LICENSE", "justfile"]) {
    for (const line of [
      // **`#` で始まる行**——`COMMENT_HASH` を返すようになったら、ここが落ちる
      "# git config user.email etl@users.noreply.github.com",
      "#git config user.email etl@users.noreply.github.com",
      // **`//` と `*` で始まる行**——`COMMENT_SLASH` を返すようになったら、ここが落ちる
      "//usr/bin/git config user.email etl@users.noreply.github.com",
      "* git config user.email etl@users.noreply.github.com",
      "/* git config user.email etl@users.noreply.github.com",
      // **どの規則にも当たらない行**（初版はこれだけだった。単独では何も主張しない）
      "git config user.email etl@users.noreply.github.com",
    ]) {
      assert.ok(
        !isComment(f, line),
        `コメント規則の無い形式でコメント扱いしている（沈黙する）: ${f} :: ${line}`,
      );
    }
  }

  // **`.md` を `COMMENT_HASH` 側に足す変異**も、ここで落ちる
  // （**md の `#` は見出しであって、コードブロックの中身を読み飛ばす理由にならない**）。
  assert.ok(
    !isComment("docs/ops/etl-trailer-rewrite.md", "# git config user.email etl@users.noreply.github.com"),
    "md の # をコメント扱いしている（手順書のコードブロックが沈黙する）",
  );

  // **逆向きも固定する**——**`#` を持つ形式で `#` を落としてはいけない。**
  //
  // **これは「安全側」なので、走査だけでは落ちない**（読む行が増えるだけで、
  // いまの追跡ファイルには「コメントの中に裸のアドレス」が無いため。
  // **実測: `ya?ml` を列挙から外しても走査の 2 本は緑のままだった**——
  // **落ちたのはこの assert だけ**）。
  // **それでも固定するのは、偽陽性は「純粋に編集上の書き換えで CI が赤くなる」形だからで、
  // いま無いだけでコメントに例示のアドレスを 1 行足せば起きる。**
  assert.ok(isComment("scripts/ci/x.sh", "# note"), "シェルの # を落としている");
  assert.ok(isComment(".github/workflows/x.yml", "  # note"), "YAML の # を落としている");
});

/**
 * **`git` の設定キーは大小を区別しない**（#1066 の差し戻し。要修正 2）。
 *
 * **担当者が実機で確認した**（2026-09-29、git 2.43.0）:
 * ```
 * git config --local user.EMAIL 'etl@users.noreply.github.com'  → author に etl@… が刻まれた
 * git config --local User.Email 'dev@users.noreply.github.com'  → author に dev@… が刻まれた
 * ```
 * **`i` を付ける前は `pass=9 fail=0` で沈黙した。**
 *
 * **CLI のフラグと環境変数は大小を区別する**（実機確認: `--Author=` は `unknown option`、
 * `git_author_email=` は無視された）ので、**`i` で広がる分は空振りに終わる。**
 */
test("設定キーの大文字・小文字を区別しない（user.EMAIL が通らない）", () => {
  for (const key of [
    'git config user.EMAIL "etl@users.noreply.github.com"', // **実機で author に刻まれた綴り**
    'git config User.Email "dev@users.noreply.github.com"', // **同上（混在）**
    "git config USER.EMAIL x@y.z",
    "git -c AUTHOR.EMAIL=x@y.z commit -m x",
    "git -c Committer.Email=x@y.z commit -m x",
  ]) assert.ok(IDENTITY_KEYS.test(key), `大小を区別して取りこぼしている（沈黙する）: ${key}`);

  // **広げても、無関係な行は拾わないままであること**（`[= ]` の要求が大小に関係なく効く）。
  for (const other of [
    "          git log --author-date-order -1",
    "          git log --Author-Date-Order -1",
    "          git shortlog --author-date",
    "      - uses: actions/checkout@v4",
  ]) assert.ok(!IDENTITY_KEYS.test(other), `i フラグで無関係な行を拾うようになった: ${other}`);
});

/**
 * **`i` は判定と絞り込みの両方に要る。片方だけだと沈黙する**（#1066 の差し戻し。要修正 2）。
 *
 * **判定側だけ `i` にしても、`git grep` が `user.EMAIL` の行を候補に含めなければ
 * その行は一度も読まれない。** **「片方だけ」の事故は #1103 で実際に起きている。**
 *
 * **だから 2 つを別々に書かず、`grepFlags` を `IDENTITY_KEYS.flags` から導いている。**
 * **ここが落ちれば「片方だけになった」と分かる。**
 */
test("大小無視は判定と git grep の両方に効いている（片方だけにならない）", () => {
  assert.ok(IDENTITY_KEYS.flags.includes("i"), "判定側に i が無い");
  assert.ok(grepFlags.includes("i"), "git grep 側に i が無い（絞り込みで落ちて沈黙する）");
  // **導出であることを固定する。**
  //
  // **最初は `grepFlags` を「同じ式」と比べていたが、それは循環していた**
  // （実測 N5: `grepFlags` を `"-lIzEi"` と直に書いても **12 pass / 0 fail** で生き残った。
  // **いまの値がたまたま一致するので、写しに戻したことを検出できなかった**）。
  //
  // **だから導出そのものを関数にして、*別の* 正規表現を通す。**
  // **写し（定数）に戻すと、`i` の無い正規表現でも `i` 付きを返してしまうので落ちる。**
  assert.equal(grepFlagsFor(/x/), "-lIzE", "i の無い正規表現から i 付きのフラグを作っている（写しになっている）");
  assert.equal(grepFlagsFor(/x/i), "-lIzEi", "i のある正規表現から i 付きのフラグを作れていない");
  assert.equal(grepFlags, grepFlagsFor(IDENTITY_KEYS), "grepFlags が導出を経由していない");
  // **残る等価変異**（正直に書き残す）: `grepFlags` を `"-lIzEi"` と直に書く変異は、
  // **`IDENTITY_KEYS` が `i` を持っている限り同じ文字列**なので、**単独では落とせない**
  // （実測 N5: 12 pass / 0 fail で生存）。**等価変異なので、これは検査の漏れではない。**
  // **危険なのは「写しに戻した *あとで* 正規表現側の `i` が外れる」形**（#1103 のドリフト）で、
  // **その組み合わせは落ちる**（実測 N10: 2 件が fail）。
  // **git 自身に聞いて確かめる**——**正規表現どうしの突き合わせだけでは
  // 「`git grep` が実際にそう動く」ことの証明にならない。**
  // **使い捨てのファイルは作らない**ので、`--no-index` に標準入力ではなく
  // **既知の文字列を `-e` で当てて、フラグが効いていることだけ**を見る。
  const probe = (flags: string): boolean => {
    try {
      execFileSync("git", ["grep", flags, "-e", "USER\\.EMAIL", "--", ":!*"], {
        cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 20,
      });
      return true;
    } catch (e) {
      // 0 件一致は exit 1。**フラグ自体が不正なら exit 128 になる**ので、そこを区別する。
      const status = (e as { status?: number }).status;
      assert.notEqual(status, 128, `git grep がフラグを受け付けない: ${flags}`);
      return false;
    }
  };
  probe(grepFlags);
});

/**
 * **バッククォートで囲んでも、走査から外れてはいけない**（#1066 の再々差し戻し）。
 *
 * **一度、md の「自己完結したコードスパン」を引用として取り除く実装を入れた**
 * （`stripQuotedSpans`）。**`.claude/agents/developer.md` が直し方の手本として
 * 逐語のアドレスを書いているのを「例であって設定ではない」と見なすためだった。**
 *
 * **それは逃げ場を作っていた**（レビューの実測）:
 * ```
 * .claude/agents/*.md に
 *   **必ずこうする**: `git config user.email etl@users.noreply.github.com`
 *     → 14 pass / 0 fail    沈黙
 *   同じ内容をバッククォート無しで
 *     → 12 pass / 2 fail    捕まる
 * ```
 * **md にコマンドを書くときバッククォートで囲むのは最も自然な書き方**なので、
 * **「囲んであるか」が新しい逃げ場になっていた**——**#1066 が塞ごうとした型そのもの。**
 * **`.claude/agents/*.md` はエージェントが読んで *従う* 指示であって、ただの散文ではない。**
 *
 * **だから実装を丸ごと外し、逐語 allowlist を 2 件にした。**
 * **「例として書いてある」ことを理由に走査から外さない。**
 *
 * **ここが落ちれば「囲めば通る」が戻ったと分かる。**
 */
test("バッククォートで囲んだだけでは走査から外れない", () => {
  const line = "**必ずこうする**: `git config user.email etl@users.noreply.github.com`";
  for (const f of [
    ".claude/agents/developer.md",
    ".claude/agents/probe.md",
    "docs/ops/a.md",
    "README.md",
  ]) {
    assert.ok(
      !isComment(f, line) && IDENTITY_KEYS.test(line) && hasEmail(line),
      `バッククォートで囲むと走査から外れている（逃げ場になる）: ${f}`,
    );
    // **囲みの中のアドレスが、ちゃんと「形の検査」に掛かること。**
    const bad = [...line.matchAll(EMAIL)].filter((m) => !UNRESOLVABLE.test(m[0]) && !OK.test(m[0]));
    assert.ok(bad.length > 0, `囲みの中のアドレスを拾えていない: ${f}`);
  }
});

/**
 * **`.claude/agents/*.md` が「逐語のアドレスを書いてある」ことは、
 * main 側の `commit-identity-allowlist.test.ts` が要求している。**
 * **こちらはそれを「走査して、逐語 allowlist に在ること」で受ける。**
 *
 * **2 つの検査は矛盾しない**——**同じ 1 つの綴りを、
 * 片方は「在れ」、もう片方は「これ以外は許さない」と言っているだけである。**
 *
 * **初版はここを「矛盾している」と読み違えた**（差し戻しの記録）:
 * **`grep -v <アドレス>` で消して測ったので、*行 89 と行 111 の両方* が消え、
 * main 側が落ちた。** **落ちた原因は行 89（単独行）で、行 111 ではなかった。**
 * **1 行だけ消して測り直すと main 側は 4 pass / 0 fail のままだった。**
 * **「消したら落ちた」を「その行のせいで落ちた」と読んだのが誤りだった。**
 */
test("エージェントの指示に在る逐語のアドレスは、allowlist に含まれている", () => {
  const doc = join(repoRoot, ".claude/agents/developer.md");
  let text: string;
  try {
    text = readFileSync(doc, "utf8");
  } catch {
    return; // **この枝に指示ファイルが無いなら、確かめようが無い**
  }
  const ALLOWED = [
    "120390190+uonoko1@users.noreply.github.com",
    "41898282+github-actions[bot]@users.noreply.github.com",
  ];
  // **指示ファイルの中で、身元を決める書き方の行に現れるアドレス**を全部集める。
  const seen = new Set<string>();
  for (const line of foldContinuations(".claude/agents/developer.md", text)) {
    if (isComment(".claude/agents/developer.md", line)) continue;
    if (!IDENTITY_KEYS.test(line)) continue;
    for (const m of line.matchAll(EMAIL)) {
      if (UNRESOLVABLE.test(m[0])) continue;
      seen.add(m[0]);
    }
  }
  for (const a of seen) {
    assert.ok(
      ALLOWED.includes(a),
      `エージェントの指示が、allowlist に無い identity を手本として書いている: ${a}`,
    );
  }
});
