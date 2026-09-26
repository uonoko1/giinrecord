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
const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, "../../../.github/workflows");
const files = readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

test("ワークフローが設定する user.email は、数字 ID 付きの noreply でなければならない", () => {
  assert.ok(files.length > 0, "ワークフローが 1 つも見つからない（走査が空回りしている）");
  const bad: string[] = [];
  let checked = 0;
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    for (const m of text.matchAll(/git config (?:--\S+ )*user\.email\s+"([^"]+)"/g)) {
      checked += 1;
      const email = m[1] ?? "";
      // 数字 ID 付きの GitHub noreply だけを通す（例: 41898282+github-actions[bot]@users.noreply.github.com）
      if (!/^\d+\+[^@]+@users\.noreply\.github\.com$/.test(email)) bad.push(`${f}: ${email}`);
    }
  }
  // **母数を出す**（#757）: 0 件で緑になっていないことを、まず確かめる。
  assert.ok(checked > 0, "user.email を設定している箇所が 1 つも見つからない（走査が空回りしている）");
  assert.deepEqual(bad, [], `裸のローカル部は無関係の GitHub ユーザーに紐づく。数字 ID 付きにすること:\n  ${bad.join("\n  ")}`);
});
