import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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
const IDENTITY_KEYS = /(?:user\.email|author\.email|committer\.email|GIT_AUTHOR_EMAIL|GIT_COMMITTER_EMAIL|--author)/;

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
    if (/^\s*#/.test(joined[i])) continue;
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

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, "../../../.github/workflows");
const files = readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

test("ワークフローが設定する user.email は、数字 ID 付きの noreply でなければならない", () => {
  assert.ok(files.length > 0, "ワークフローが 1 つも見つからない（走査が空回りしている）");
  const bad: string[] = [];
  let checked = 0;
  // **値は allowlist、書き方も allowlist にする。**
  // 最初の版はダブルクォートだけを拾っていた。**レビューの実測（使い捨て repo で実際にコミットして
  // `%ae` を読んだ）では、次の 5 形が素通りしたうえで `etl@users.noreply.github.com` を刻んだ**:
  //   シングルクォート / クォートなし / GIT_AUTHOR_EMAIL / git -c user.email= / git commit --author=
  // **「値だけ allowlist で、書き方は denylist」だと列挙漏れが残る**（#858 / #1022 と同じ向き）。
  // **メールアドレスらしい文字列を先に全部拾い、そのうえで形を要求する。**
  // `[bot]` の角括弧を含める——`github-actions[bot]@…` が拾えなくなり、
  // **母数 0 で緑になる**（最初にそう書いて `checked > 0` に捕まった）。
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    // **母数は畳む前の実数で数える**（畳んだ窓は同じアドレスを 2 度通しうる）。
    for (const line of text.split("\n")) {
      if (/^\s*#/.test(line)) continue;
      if (!IDENTITY_KEYS.test(line)) continue;
      for (const _ of line.matchAll(EMAIL)) checked += 1;
    }
    for (const line of foldContinuations(text)) {
      // **コメント行は飛ばす。** 飛ばさないと、**この検査を説明する日本語のコメントに
      // `user.email` と書いた瞬間に赤くなる**（レビューの実測: `etl.yml` のコメントを
      // 「メールアドレス」→「user.email」に書き換えるだけで落ちた）。**純粋に編集上の
      // 書き換えで CI が落ちるのは偽陽性である。**
      if (/^\s*#/.test(line)) continue;
      if (!IDENTITY_KEYS.test(line)) continue;
      for (const m of line.matchAll(EMAIL)) {
        const email = m[0];
        if (!OK.test(email) && !bad.includes(`${f}: ${email}`)) bad.push(`${f}: ${email}`);
      }
    }
  }
  // **母数を出す**（#757）: 0 件で緑になっていないことを、まず確かめる。
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
  ]) assert.ok(IDENTITY_KEYS.test(key), `身元を決める書き方が走査から漏れている: ${key}`);
  // 拾う必要が無い行（ここまで広げると、無関係な行のアドレスで赤くなる）
  for (const other of [
    "      - uses: actions/checkout@v4",
    "        run: pnpm install --frozen-lockfile",
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
    for (const line of foldContinuations(readFileSync(join(dir, f), "utf8"))) {
      if (/^\s*#/.test(line)) continue;
      if (!IDENTITY_KEYS.test(line)) continue;
      for (const m of line.matchAll(EMAIL)) seen.add(m[0]);
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
        !/^\s*#/.test(line) &&
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
      !/^\s*#/.test(line) &&
      IDENTITY_KEYS.test(line) &&
      [...line.matchAll(EMAIL)].some((m) => !OK.test(m[0])),
  );
  assert.ok(!falsePositive, "無関係な行のアドレスを身元の行に繋げている（偽陽性）");
});
