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
  const EMAIL = /[A-Za-z0-9._%+\-\[\]]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  // コミットの身元を決めうる書き方（ここに現れたアドレスを検査する）
  const IDENTITY = /(?:user\.email|GIT_AUTHOR_EMAIL|GIT_COMMITTER_EMAIL|--author)/;
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    for (const line of text.split("\n")) {
      // **コメント行は飛ばす。** 飛ばさないと、**この検査を説明する日本語のコメントに
      // `user.email` と書いた瞬間に赤くなる**（レビューの実測: `etl.yml` のコメントを
      // 「メールアドレス」→「user.email」に書き換えるだけで落ちた）。**純粋に編集上の
      // 書き換えで CI が落ちるのは偽陽性である。**
      if (/^\s*#/.test(line)) continue;
      if (!IDENTITY.test(line)) continue;
      for (const m of line.matchAll(EMAIL)) {
        checked += 1;
        const email = m[0];
        if (!OK.test(email)) bad.push(`${f}: ${email}`);
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
    "sakai.personal@gmail.com",
    "41898282+github-actions[bot]@example.com",
    "+uonoko1@users.noreply.github.com",
    "120390190@users.noreply.github.com",
  ]) assert.ok(!OK.test(bad), `通してはいけない綴りが通った: ${bad}`);
});
