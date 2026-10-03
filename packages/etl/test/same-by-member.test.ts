import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSameByMember } from "./same-by-member.ts";

/**
 * **`assertSameByMember` の走査が片側に縮んでも落ちなかった**（Issue #1129）。
 *
 * ## 何が壊れていたか
 *
 * **`published-timeline-count.test.ts` の 6 本は、`data/` がきれいなかぎり
 * 走査を片側に縮めても全部緑である**（実測 2026-09-30、`data/` は `61770bd5`）:
 *
 * | 当てた変異 | そのファイルの 6 本 | `pnpm --filter @seiji-kiroku/etl test` |
 * |---|---|---|
 * | `...Object.keys(derived)` を落とす | **pass 6 / fail 0** | **pass 2,219 / fail 0** |
 * | `...Object.keys(actual)` を落とす | **pass 6 / fail 0** | （同上。片側走査は両向きとも素通り） |
 *
 * **原因は `byKind` が 0 件の議員をキーに載せない設計であること**——
 * **「片側にしか無いキー」は、その片側を走査しないかぎり原理的に見えない**
 * （表は `same-by-member.ts` の docblock）。
 * **#1061 が守ろうとしているのは「議員 1 人の記録が丸ごと消える」形なので、
 * まさにその形が見えなくなっていた。**
 *
 * ## なぜ本番の 6 本では守れないか（**だから fixture で作る**）
 *
 * **`data/` がきれいなら、定義上どちらの側にも「片側だけのキー」は無い。**
 * **片側走査で落とすには「片側にしか無いキー」を持つ入力が要る**——
 * **それは `data/` を壊さないと作れないので、ここで合成する。**
 * **`data/` には一切触らない**（ここは `assertSameByMember` を関数として直に呼ぶ）。
 *
 * ## 実装を動かさずにテストだけ足した（**実装はもともと正しい**）
 *
 * **`published-timeline-count.test.ts` の中にあった `assertSameByMember` を
 * `test/same-by-member.ts` に出しただけで、式は 1 文字も変えていない**
 * （`test/count-mismatch-rows.ts` / `test/comparator-shape.ts` と同じ形）。
 * **#1129 が言っているのは「実装が壊れている」ではなく
 * 「その 1 語を守る検査がどこにも無い」ことである。**
 */

/** **食い違いを見つけたか**（`assert.deepEqual` が投げたかどうかで測る） */
const throws = (actual: Record<string, number>, derived: Record<string, number>): boolean => {
  try {
    assertSameByMember(actual, derived, "fixture");
    return false;
  } catch {
    return true;
  }
};

/**
 * **`derived` 側にしか無いキー**（**`...Object.keys(derived)` を落とすと見えなくなる形**）。
 *
 * **これが「議員 1 人の timeline が丸ごと消えた」ときに起きる形である**——
 * **`byKind` は 0 件の議員をキーに載せないので、消えた議員は `actual` からキーごと消える。**
 */
test("#1129 derived 側にしか無いキー（議員の timeline が丸ごと消えた形）で落ちる——片側走査ではここが原理的に見えない", () => {
  // **`m_gone` は derived に 105 件あるのに timeline には行が 1 本も無い**（キーごと無い）
  const actual = { m_stay: 7 };
  const derived = { m_stay: 7, m_gone: 105 };
  assert.equal(throws(actual, derived), true, "derived 側にしか無いキーを見逃した（...Object.keys(derived) が走査から落ちていないか）");
  // **名指しの中身も固定する**（「落ちた」だけでは、別の理由で落ちていても緑に見える）
  assert.throws(
    () => assertSameByMember(actual, derived, "fixture"),
    (e: unknown) => {
      const m = (e as { message?: string }).message ?? "";
      assert.ok(m.includes("m_gone"), `落ちた理由が m_gone を名指ししていない: ${m}`);
      assert.ok(!m.includes("m_stay"), `一致している m_stay まで名指しされている: ${m}`);
      return true;
    },
  );
});

/**
 * **`actual` 側にしか無いキー**（**`...Object.keys(actual)` を落とすと見えなくなる形**）。
 *
 * **対称に守る**——**片方だけ守ると、残った側が同じ穴になる**（#1129 の受け入れ条件）。
 * **こちらは「timeline に行が残っているのに導き元が消えた」ときに起きる形である。**
 */
test("#1129 actual 側にしか無いキー（導き元が消えて timeline だけ残った形）で落ちる——対称に守る", () => {
  const actual = { m_stay: 7, m_orphan: 3 };
  const derived = { m_stay: 7 };
  assert.equal(throws(actual, derived), true, "actual 側にしか無いキーを見逃した（...Object.keys(actual) が走査から落ちていないか）");
  assert.throws(
    () => assertSameByMember(actual, derived, "fixture"),
    (e: unknown) => {
      const m = (e as { message?: string }).message ?? "";
      assert.ok(m.includes("m_orphan"), `落ちた理由が m_orphan を名指ししていない: ${m}`);
      return true;
    },
  );
});

/**
 * **両側にキーが在って数だけ違う形**（#1053 の入れ替え。**片側走査でも見える形**）。
 *
 * **この 1 本だけでは #1129 の穴は塞げない**——**わざと分けて置いてある。**
 * **「両側にキーが在る食い違い」は片側走査でも見えるので、
 * 上の 2 本が無ければ走査の縮退は素通りする。**
 */
test("#1129 両側にキーが在って数だけ違う形（会派内の入れ替え）で落ち、両側の数を出す", () => {
  const actual = { a: 104, b: 106 };
  const derived = { a: 105, b: 105 };
  assert.throws(
    () => assertSameByMember(actual, derived, "fixture"),
    (e: unknown) => {
      const m = (e as { message?: string }).message ?? "";
      for (const s of ["104", "106", "105"]) assert.ok(m.includes(s), `両側の数が出ていない（${s} が無い）: ${m}`);
      return true;
    },
  );
});

/**
 * **偽陽性が出ないこと**（#1129 の受け入れ条件）。
 *
 * **一致していれば落ちない。** **空どうしでも落ちない**（`data/` にその種別が 1 件も無い版でも緑）。
 * **`0` を明示的に持つキーと、キーが無い側は同じ意味として扱う**
 * （`byKind` が 0 件を載せない設計と噛み合わせる。**ここが落ちたら本番が偽陽性で赤くなる**）。
 */
test("#1129 一致している入力では落ちない（きれいな data で偽陽性が出ない）", () => {
  assert.equal(throws({}, {}), false, "空どうしで落ちた");
  assert.equal(throws({ a: 1, b: 2 }, { b: 2, a: 1 }), false, "同じ表でキーの順だけ違うのに落ちた");
  assert.equal(throws({ a: 0 }, {}), false, "0 を明示したキーと、キーが無い側を別物として扱っている");
  assert.equal(throws({}, { a: 0 }), false, "0 を明示したキーと、キーが無い側を別物として扱っている（逆向き）");
});

/**
 * **`what` が名指しに入ること。**
 *
 * **呼び手は 4 か所あり、どれが落ちたか読めないと `data/` のどこを作り直すか分からない**
 * （`published-timeline-count.test.ts` の 4 本は vote / localVote / stance / bill）。
 */
test("#1129 落ちたときに、呼び手が渡した種別の名前が出る（4 か所のどれが落ちたか読める）", () => {
  assert.throws(
    () => assertSameByMember({ a: 1 }, {}, "timeline の stance 行と bills/ が食い違っている"),
    (e: unknown) => {
      const m = (e as { message?: string }).message ?? "";
      assert.ok(m.includes("timeline の stance 行と bills/ が食い違っている"), `what がメッセージに無い: ${m}`);
      return true;
    },
  );
});

/**
 * **母数**（#757）。**`published-timeline-count.test.ts` の呼び手が 4 か所であることを固定する。**
 *
 * **呼び手が増えたのに、この助け手を直に測る検査がここ 1 本しか無いままだと、
 * 「4 か所ぜんぶ守れている」が根拠を失う**——**増えたら気づくようにしておく。**
 * **「0 件」と「数えていない」は違う**ので、数えた場所と数を書く。
 */
test("#1129 母数: assertSameByMember の呼び手は published-timeline-count.test.ts の 4 か所だけ", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const src = await readFile(fileURLToPath(new URL("./published-timeline-count.test.ts", import.meta.url)), "utf-8");
  const calls = src.match(/\bassertSameByMember\(/g) ?? [];
  assert.equal(calls.length, 4, "assertSameByMember の呼び手の数（増えたら、この助け手の検査で足りているか見直すこと）");
  assert.ok(
    src.includes('import { assertSameByMember } from "./same-by-member.ts";'),
    "published-timeline-count.test.ts が同じ助け手を読んでいない（写しが 2 つあると、こちらを守っても向こうは守られない）",
  );
});
