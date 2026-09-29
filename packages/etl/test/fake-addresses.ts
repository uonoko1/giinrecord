/**
 * **テストで使う「架空のメールアドレス」の綴りを 1 か所で持つ**（Issue #1111）。
 *
 * ## なぜ 1 か所に要るか
 *
 * **2026-09-28 の 1 日に、利用者本人の個人アドレスが追跡ファイルに入りかける事故が 3 回起きた**
 * （**#1092 に 1 行 / #1103 に 1 行 / #1108 に 5 行、計 7 行**）。**3 回ともレビュアーが見つけた**
 * ——**gitleaks も forbidden-patterns も 1 件も落としていない**（実測）。
 *
 * **#1108 がいちばん分かりやすい**: **同じファイルの 90 行目に
 * 「個人アドレスを書かない方針を採った（実測: いまも 0 件）」と書いてあるのに、
 * その同じ PR が 5 行書き込んでいた。** **方針の文と、方針を破る行が同居していた。**
 *
 * **悪意ではない。** **「実測を逐語で書く」作法の副作用**である——
 * **実測の対象が人のアドレスだと、そのまま貼ってしまう。**
 *
 * **だから「代わりに何を書けばいいか」を、探さなくても手に届く場所に置く。**
 * **綴りを思い出そうとした人が毎回その場で作ると、`person@example.com` /
 * `x@example.com` / `someone@example.com` / `t@example.invalid` のように散らばり
 * （実測 2026-09-29: 追跡ファイル中で example.com が 14 / example.invalid が 7 / claude.ai が 5）、
 * 「ここに書いてよい綴りはどれか」が誰にも分からなくなる。**
 *
 * ## 使い方
 *
 * **実在の人のアドレスを書きたくなったら、代わりにここを import する。**
 * **`scripts/ci/forbidden-patterns.sh` の `personal-address` 規則は、
 * ここの綴りをすべて素通りさせる**（実測: `scripts/ci/test/forbidden-patterns.test.sh` の
 * 「架空アドレス…は素通り」が、下の 4 つを 1 行に並べて exit 0 を確かめている）。
 *
 * ## **どこまで移したか（実測。「唯一の出どころ」はまだ半分である）**
 *
 * **#1126 のレビューで「import しているのは 1 件だけ」と指摘された。そのとおりだった。**
 * **数え直した結果（2026-09-29、`git grep -o` で逐語の綴りを全部拾った）**:
 *
 * | ファイル | 逐語の綴り | 移したか |
 * |---|---|---|
 * | `commit-trailer-identity.test.ts` | 11 → **4** | **7 件を定数に移した** |
 * | `workflow-commit-identity.test.ts` | 1 → **0** | **移した** |
 * | `scripts/ci/test/forbidden-patterns.test.sh` | 7 | **移せない**（シェルなので TS を import できない） |
 * | ここ（定義） | 5 | — |
 *
 * **残っている 4 件は、綴り自体が検査の対象なので定数にすると何を見ているか分からなくなる**:
 * `a.b_c%d+e-f@example.com`（ローカル部の記号を全部入れた形）、`x@example.com`（1 文字の
 * ローカル部）、`etl@example.com`（`etl` というローカル部であることに意味がある）、
 * `noreply@example.com`（`noreply` というローカル部であることに意味がある）。
 * **これらを `FAKE_*` に隠すと、テストの意図が読めなくなる。だから意図して残している。**
 *
 * **シェル側の 7 件は、この定数を読めない**（`.sh` から `.ts` は import できない）。
 * **代わりに `personal-address-guard.test.ts` が「ここの綴りが規則を素通りすること」を
 * 毎回確かめているので、両者が食い違えば赤くなる。**
 *
 * ## 綴りの根拠（勝手に増やさない）
 *
 * - `example.com` / `example.invalid` — **RFC 2606 が「文書用」に予約したドメイン。**
 *   **誰にも割り当てられないので、将来だれかの実アドレスになることが無い。**
 * - `anthropic.com` の `noreply@` — **作業合意が全コミットの trailer に要求している値**なので、
 *   **これは架空ではなく「書いてよい実在の値」である**（#1106 / #1074。実測で `github.com/claude`
 *   に帰属し、誤帰属ではない）。**ここに置くのは「消してはいけない」と分かるようにするため。**
 * - `claude.ai` の `bot@` — **`claude.ai` は実在のドメインだが `bot@` は割り当てが無い。**
 *   **誤帰属の検査（#1074）が「外部ドメインは帰属しない」を示すために使っている。**
 *   **実在のアドレスではないが、実在のドメインなので、ここ以外では増やさない。**
 */

/** 架空の個人（人を指す例が要るとき）。RFC 2606 の予約ドメイン。 */
export const FAKE_PERSON = "person@example.com";

/** 架空のもう 1 人（2 人を区別したいとき）。 */
export const FAKE_OTHER = "other@example.com";

/** 架空の「誰か」（ワークフローに紛れ込んだ第三者の連絡先を置くとき）。 */
export const FAKE_SOMEONE = "someone@example.com";

/** 架空の bot（実在ドメイン + 割り当ての無いローカル部。誤帰属の検査が使う）。 */
export const FAKE_BOT = "bot@claude.ai";

/** シェルスクリプトのテストが `git commit` の author に使う値（RFC 2606 の `.invalid`）。 */
export const FAKE_COMMIT_IDENTITY = "t@example.invalid";

/**
 * **作業合意が trailer に要求している値。架空ではない。**
 * **誤帰属の検査から外すと #1075 のように全 PR が赤くなる**（実測）。
 */
export const REQUIRED_TRAILER_ADDRESS = "noreply@anthropic.com";

/** 上の架空アドレスの一覧（`personal-address` 規則が全部素通りさせることを確かめる用）。 */
export const FAKE_ADDRESSES = [
  FAKE_PERSON,
  FAKE_OTHER,
  FAKE_SOMEONE,
  FAKE_BOT,
  FAKE_COMMIT_IDENTITY,
] as const;
