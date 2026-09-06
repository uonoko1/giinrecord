import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["app/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
    /*
     * Issue 400: 既定の 5000ms では、折りたたみの境界テスト（200 行の表を描く）が
     * **不定期に落ちていた**。原因は遅い実装ではなく**並行実行の取り合い**:
     *
     *     単独で走らせたとき: 224ms
     *     ワークスペース全体を並行で走らせたとき: 5000ms 超（18 倍以上）
     *
     * 折りたたみの境界は「FOLD 件ちょうど」を描かないと検査にならないので、
     * **これ以上データを減らせない**（減らすと境界を検査しなくなる）。
     * fixture は定数から導く形にして 394 → 206 まで落としたうえで、
     * 残りは上限を上げて受ける。**遅い実装を隠すためではない**——単独では 224ms で終わる。
     *
     * 20000ms の根拠（Issue 400 時点）: 並行実行時の実測で、折りたたみ系のいちばん遅いテストが
     * **7.6 秒**（既定の 5000ms を超えるのでこれが flaky の正体）。倍以上の余裕を取りつつ、
     * **本当に遅い実装が入れば落ちる**幅にしてある。
     *
     * **#538 でこの前提が崩れていることを実測した。** 開発機で他プロセス（他プロジェクトの
     * vitest・意図的に張られた CPU 負荷）と CPU を取り合っている状態で、フルスイートの
     * 折りたたみ系（`member.test.tsx` の発言タブ・`member-local.test.tsx` の表決タブ・
     * `members.test.tsx` の絞り込み中）が **17〜50 秒**まで伸びるのを確認した
     * （load average 90〜143、`ps aux` で他プロジェクトの vitest プロセスが同時に多数動いている
     * ことも確認済み）。**20000ms を書き換えていない**理由: この開発機の外部負荷は
     * gikailog のテストが作ったものではなく、上げても「その日の外部負荷が収まる値」を
     * 言い当てられない。フォールドの fixture は既に最小（#400 の 206 行）で、これ以上は
     * 境界の検査を弱める側にしかならない。上げる代わりに、**このリポジトリの側で減らせる
     * 重さ（`/coverage` の loader の重複読み込み・`data-files.ts` の逐次 I/O）を減らした**
     * （#538、詳細は下の `hookTimeout` のコメントと `data-files.ts` を参照）。
     */
    testTimeout: 20000,
    /*
     * **`testTimeout` が効くのは `tests` だけで、`collect`（import 時に走る処理）は管轄外**（#520 / #556）。
     * 実測: `collect` に 27 秒かけても 20,000ms を超えたまま緑になる。
     * つまり **import 時の重い処理は、遅くなっても誰も鳴らさない**。
     * `font-subset-coverage.test.ts` は `data/` 全体の走査を `describe` の外に置いている——
     * **`testTimeout` の余裕（他人と共有している）を食い潰さないため**だが、
     * **代わりに無制限の側へ荷重が移っている**ことは自覚しておくこと。
     */
    /*
     * #538: `hookTimeout` は既定 10000ms で、`testTimeout` とは別の予算。
     * `coverage.test.tsx` の `beforeAll` は `data/bills`（1,943 ファイル）と
     * `data/rollcalls`（381 ファイル）を走査する本番の `loader()` を呼ぶ
     * （#538 でこの `describe` 内の 3 つの `it` それぞれが呼び直していたのを 1 回に集約した）。
     *
     * 集約しただけでは足りなかった。逐次 I/O のままだと 1 回でも重く、
     * `tsx` で直に `readShugiinBillNameStats` + `readSangiinVoteLinkStats` を計測すると
     * （cwd は apps/web、他プロセスと CPU を取り合っている状態）:
     *
     *     並列化前  load average  48〜71: 3.4 秒 / 75〜89: 4.8〜10 秒
     *     並列化前  フルスイート内（load 90〜118）: `Hook timed out in 20000ms` を実際に踏んだ
     *
     * そこで `data-files.ts` 側でディレクトリ内のファイル読み込みを `Promise.all` にした
     * （集計は加算と Set への追加だけで、どの順で足しても結果が同じ——既存の
     * `data-files.test.ts` 47 件がその契約を固定している。全件 green を確認済み）。並列化後:
     *
     *     並列化後  load average 117〜129: 2.5〜4.5 秒（4 関数合計）
     *
     * 高負荷下で 4〜8 倍の余裕になった。`hookTimeout` は `testTimeout` と同じ 20000ms のまま
     * 据え置いている——上げているのは「新しく重い処理を足した」からではなく、**既存の重い処理を
     * `beforeAll` に集約した結果、`testTimeout` の管轄から `hookTimeout` の管轄に移った**ため
     * （#520/#556 の「`beforeAll` は速くするのではなく管轄を移すだけ」と同じ形）。
     */
    hookTimeout: 20000,
  },
});
