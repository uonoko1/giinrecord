import assert from "node:assert/strict";

/**
 * **議員ごとの表を突き合わせて、食い違った議員だけを名指しする**（Issue #1061）。
 *
 * **`assert.deepEqual` を表そのものに当てると、落ちたときに 456 行が画面に出る**
 * （**実測 2026-09-28: 1 人の 105 件を消しただけで、`actual` と `expected` に
 * 456 人ぶんの数が並び、どこが違うのか読めなかった**）。
 * **狭い診断から出す**（#1053 の `resultAbsentByAssembly` と同じ考え方）——
 * **食い違いだけを `{議員id: {timeline: n, 導出: m}}` の形にして比べる。**
 * **一致していれば空の表どうしになるので、落ちない。**
 *
 * ## **なぜ両側のキーを合わせるのか**（Issue #1129。**この 1 語が守られていなかった**）
 *
 * **走査を `new Set([...Object.keys(actual)])` に縮めても、
 * `data/` がきれいなかぎり `published-timeline-count.test.ts` の 6 本は全部緑である**
 * （**実測 2026-09-30: `...Object.keys(derived)` を落として `pass 6 / fail 0`。
 * 逆向きに `...Object.keys(actual)` を落としても `pass 6 / fail 0`**）。
 *
 * **原因は `byKind` が 0 件の議員をキーに載せない設計であること**
 * （`published-timeline-count.test.ts` の `scanOnce`。「無い」と「0」を同じ形にしている）。
 * **だから「片側にしか無いキー」は、その片側を走査しないかぎり原理的に見えない:**
 *
 * | 消え方 | `actual` | `derived` | `...derived` を落とすと |
 * |---|---|---|---|
 * | timeline に行が残り、導き元が消えた | 105 | **（キーごと無い）** | 走査すれば分かる |
 * | **timeline の行が丸ごと消えた** | **（キーごと無い）** | 105 | **見えない** |
 *
 * **#1061 が守ろうとしているのは下の行**（**議員 1 人の `stance` 105 件が丸ごと消えた**）
 * **なので、片側走査ではまさにその形が見えなくなる。**
 *
 * **きれいな `data/` では「片側にしか無いキー」を作れない**——
 * **だから `same-by-member.test.ts` が fixture 側で作って、両方向を固定している。**
 * **本番の 6 本は `data/` が正しいことしか言えないので、この 1 語の守りにはならない。**
 */
export const assertSameByMember = (
  actual: Record<string, number>,
  derived: Record<string, number>,
  what: string,
) => {
  const diff: Record<string, { timeline: number; derived: number }> = {};
  for (const id of new Set([...Object.keys(actual), ...Object.keys(derived)])) {
    const a = actual[id] ?? 0;
    const d = derived[id] ?? 0;
    if (a !== d) diff[id] = { timeline: a, derived: d };
  }
  assert.deepEqual(diff, {}, `${what}（食い違った議員だけを出す。timeline = member ファイルの行数、derived = 導き元から数えた件数）`);
};
