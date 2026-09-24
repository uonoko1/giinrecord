import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalAssemblyMeta } from "@seiji-kiroku/shared";

/**
 * # **`seatsChanged` の線（10）と実測の距離を書いた所を、全部まとめて数え直す**（Issue #1007）
 *
 * ## **何が起きていたか**——**リポジトリが自分と矛盾していた**
 *
 * **`docs/DATA_CONTRACT.md:237` には 2026-09-22 まで、こう書いてあった:**
 *
 * > **線（10）と実測の距離は上下で違う**: 上側は今の 11 県の最大 4 との差が 6、
 * > **下側はいちばん小さい境（青森 11）との差が 1。** **線を 12 以上にすると青森を取りこぼす。**
 *
 * **同じ main の `packages/etl/src/local-assemblies.ts:808`（#990）は、逆のことを言っていた:**
 *
 * > **秋田の境は 9、佐賀の境は 4 で、どちらもこの線の下にある**
 *
 * **正しいのは後者である。** **「いちばん小さい境は青森 11」は誤りで、秋田 9・佐賀 4 が下にある。**
 * **そして本番の最大は 4 ではなく 5（滋賀）である。**
 *
 * ## **なぜ片方だけ直ったのか**——**測ったのは 5 回、書き写したのは 1 回**
 *
 * **2 つの数字は同じ commit（`3da4b9d3` / #954）で同時に書かれた。** **その後:**
 *
 * | | 会期数を書き換えた commit | 値の変遷 |
 * |---|---:|---|
 * | `packages/etl/test/local-session-roster-coverage.test.ts` | **5 回** | 79 → 82 → 93 → 102 → 119 |
 * | `docs/DATA_CONTRACT.md` | **1 回** | 79（**書かれたきりで、以後 4 回すべて素通り**） |
 *
 * **テスト側は本番 `data/` を数え直すので、`#901` が会期を広げるたびに必ず赤くなって直された。**
 * **doc 側は誰も数え直さないので、4 回連続で素通りした。**
 * **「同じ数字が 2 か所にある」だけが問題なのではなく、
 * 「片方には数え直しを強制する仕組みがあり、もう片方には無かった」が問題である。**
 *
 * ## **なぜ「1 か所にまとめる」を選ばなかったか**（#985 / #757）
 *
 * **`DATA_CONTRACT.md` から数字を消して「テストを見よ」にするのが最短だが、そうしない。**
 * **母数（11 議会 / 119 会期 / 4,599 採決 / 198,221 票）は、読む人に数え直させるためにあえて書いてある**
 * ——**「10 以上は 0 件」を「見た上での 0」と読ませるには、何を見たかがその場に要る**（#757）。
 * **数字を消すと、`/coverage` の「0 件」と同じく「数えていない」と区別がつかなくなる。**
 *
 * **だから取った形は「2 か所に持つが、ずれたら落ちる」である。**
 * **これは既にこのリポジトリにある形でもある**——
 * **`apps/web/app/lib/session-roster-coverage.test.ts` が
 * `SEATS_CHANGED_FLAG` について ETL の原文を読んで突き合わせている**（`packages/shared` が定数を持てないため）。
 * **此処はそれを「定数」から「実測の数字」へ広げただけである。**
 *
 * ## ⚠ **このテストが見ていないもの**（**正直に書く**）
 *
 * **見るのは「本番 `data/` の実測と、文章に書かれた数字が一致するか」だけである。**
 * **「その文章の主張が正しいか」は見ていない**——
 * **例えば「いちばん小さい境は佐賀 4」は `local-seats-changed-boundaries.test.ts` が測っており、
 * 此処はその値が doc に正しく写っているかだけを見る。**
 */

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const DATA = join(REPO, "data");

const read = (p: string) => readFile(join(REPO, p), "utf-8");

/** **本番 `data/` の 11 県を数え直す**（**文章から読まない。数え直す**）。 */
const measure = async () => {
  const dirs = (await readdir(join(DATA, "assemblies"), { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name.startsWith("pref-")).map((e) => e.name).sort();
  let sessions = 0, rollcalls = 0, votes = 0, flagged = 0, max = 0;
  for (const d of dirs) {
    const meta = JSON.parse(await readFile(join(DATA, "assemblies", d, "meta.json"), "utf-8")) as LocalAssemblyMeta;
    for (const c of meta.sessionRosterCoverage) {
      sessions++; rollcalls += c.rollcalls; votes += c.votes;
      if (c.seatsChanged > max) max = c.seatsChanged;
      if (c.seatsChanged >= 10) flagged++;
    }
  }
  return { assemblies: dirs.length, sessions, rollcalls, votes, max, flagged };
};

/** **「4,599」「4_599」「4599」のどれで書いてあっても引ける形にする**（#993）。 */
const spellings = (n: number): string[] => {
  const plain = String(n);
  const comma = plain.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const under = plain.replace(/\B(?=(\d{3})+(?!\d))/g, "_");
  const full = plain.replace(/\d/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0));
  return [...new Set([plain, comma, under, full])];
};

/**
 * **その本文のどこかに、その数が「どれかの綴りで」出てくるか。**
 *
 * **数の前後が数字だと `119` が `1198` に当たってしまう**ので、境で切る。
 */
const mentions = (text: string, n: number): boolean =>
  spellings(n).some((s) => new RegExp(`(?<![0-9０-９,_])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9０-９])`).test(text));

/**
 * **線と実測の距離を書いている所**（**grep で数えた母数。手で数えていない**）。
 *
 * **拾い方**: `rg -l 'seatsChanged|SEATS_CHANGED_FLAG'` でファイルを出し、
 * **そのうち「本番の母数・最大・印の件数」を数字で書いている所だけを載せた。**
 *
 * **載せていないもの**（**「測っていない」と「0 件」を混ぜない**。#757）:
 * - `packages/etl/test/local-seats-changed-boundaries.test.ts` / `saga-sessions-widen.test.ts` —
 *   **本番 `data/` を読んで自分で数え直しているので、ずれたらそれ自身が落ちる。**
 * - `apps/web/app/routes/coverage.tsx` — **数字を書かず `meta.json` から描いている。**
 */
type Quantity = "sessions" | "rollcalls" | "votes" | "max";

/**
 * **どの数を書いているかは所によって違う**（**書いていない数まで要求しない**）。
 *
 * **`guards.md` と web の docblock は「会期数と最大」までしか書かない**——
 * **採決数・票数まで書けと強いると、読みに来た人が必要としない数を増やすだけである。**
 * **要求するのは「その所が実際に書いている種類の数が、実測と一致すること」だけ。**
 */
const PLACES: readonly { path: string; why: string; needs: readonly Quantity[] }[] = [
  { path: "docs/DATA_CONTRACT.md", why: "`SEATS_CHANGED_FLAG` の節（#1007 が直した所）",
    needs: ["sessions", "rollcalls", "votes", "max"] },
  { path: "docs/ops/guards.md", why: "守りの一覧の `sessionRosterCoverage` の行",
    needs: ["sessions", "max"] },
  { path: "packages/shared/src/index.ts", why: "`sessionRosterCoverage` の型の docblock",
    needs: ["sessions", "rollcalls", "votes", "max"] },
  { path: "packages/etl/src/local-assemblies.ts", why: "`SEATS_CHANGED_FLAG` の docblock（#990 が直した所）",
    needs: ["sessions", "rollcalls", "votes", "max"] },
  { path: "apps/web/app/lib/session-roster-coverage.ts", why: "web 側の `SEATS_CHANGED_FLAG` の docblock",
    needs: ["sessions", "max"] },
];

const LABEL: Record<Quantity, string> = { sessions: "会期", rollcalls: "採決", votes: "票", max: "最大" };

test("#1007 線と実測の距離を書いた 5 か所が、本番 data/ の実測と一致する", async () => {
  const m = await measure();
  // **母数を先に置く**（#757。**数え直しが空回りしていたら以降は無意味**）
  assert.equal(m.assemblies, 11, "11 議会ぶんを数えたこと（母数）");
  assert.ok(m.sessions > 0 && m.rollcalls > 0 && m.votes > 0, "data/ から数が出ていること");
  assert.equal(PLACES.length, 5, "見る所の数（母数。grep で数えた）");

  // **数え直しの母数**（**検査した (所 × 数) の組の数。0 を緑にしない**。#757）
  assert.equal(PLACES.reduce((n, p) => n + p.needs.length, 0), 16, "検査する (所 × 数) の組の数（母数。4+2+4+4+2）");

  const missing: string[] = [];
  for (const { path, why, needs } of PLACES) {
    const text = await read(path);
    // **その場所が本当に `seatsChanged` の話をしていること**（**関係の無いファイルを緑で通さない**）
    assert.ok(/seatsChanged|SEATS_CHANGED_FLAG/.test(text), `${path}: seatsChanged の話が無い（${why}）`);
    for (const q of needs) {
      if (!mentions(text, m[q])) missing.push(`${path}: ${LABEL[q]} ${m[q]} がどの綴りでも出てこない（${why}）`);
    }
  }
  assert.deepEqual(missing, [], "**実測とずれている所**（**片方だけ直すと此処が落ちる**——#1007 の再発防止）");
});

/**
 * ## **否定的対照**——**「どれも見ていないから緑」になっていないこと**
 *
 * **上のテストは「本文のどこかに在る」しか見ないので、ゆるい。**
 * **ゆるすぎて何でも通るなら意味が無いので、在り得ない数では落ちることを見る。**
 */
test("#1007 実測と違う数を要求すると落ちる（検査が空回りしていない）", async () => {
  const m = await measure();
  const bogus = m.sessions + 10_000; // **本番にあり得ない会期数**
  const hits: string[] = [];
  for (const { path } of PLACES) if (mentions(await read(path), bogus)) hits.push(path);
  assert.deepEqual(hits, [], `あり得ない会期数 ${bogus} がどこかに書いてある（検査の前提が壊れている）`);
  // **逆向き**: **実測の会期数は、少なくとも 1 か所では引けること**
  const found: string[] = [];
  for (const { path } of PLACES) if (mentions(await read(path), m.sessions)) found.push(path);
  assert.equal(found.length, PLACES.length, "**5 か所すべてで会期数が引けること**（母数）");
});

/**
 * ## **`mentions` が「4,599 と 4_599 の両方」を引けること**（#993）
 *
 * **これを外すと、綴りが違うだけの古い数字を見逃す**——
 * **#993 が「同じ値の別の綴りを先に潰す」と言っているのはこの形である。**
 */
test("#1007 数の綴りの揺れ（4599 / 4,599 / 4_599 / ４５９９）をどれも引ける", () => {
  assert.deepEqual(spellings(4_599).sort(), ["4,599", "4599", "4_599", "４５９９"].sort(), "4 通りの綴り");
  for (const s of ["4599", "4,599", "4_599", "４５９９"]) {
    assert.ok(mentions(`… ${s} 採決 …`, 4_599), `${s} を引けない`);
  }
  // **3 桁以下は区切りが入らないので 1 通り**（**余計な綴りを作っていない**）
  assert.deepEqual(spellings(119).sort(), ["119", "１１９"].sort());
  // **境**: **`119` が `1198` や `2119` に当たらない**（**当たると誤って緑になる**）
  assert.equal(mentions("1198 会期", 119), false, "後ろに数字が続く所に当たってはいけない");
  assert.equal(mentions("2119 会期", 119), false, "前に数字がある所に当たってはいけない");
  assert.equal(mentions("119 会期", 119), true);
  // **カンマ区切りの中に当たらない**（**`4,599` の `599` を `599` として引かない**）
  assert.equal(mentions("4,599 採決", 599), false, "カンマ区切りの下 3 桁に当たってはいけない");
});
