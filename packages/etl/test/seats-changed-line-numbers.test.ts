import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalAssemblyMeta } from "@seiji-kiroku/shared";
import { SEATS_CHANGED_FLAG, sessionRosterCoverageOf } from "../src/local-assemblies.ts";

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
 * ## ⚠ **最初これは「母数と最大」しか見ておらず、#1007 の本題を素通りした**（**レビューが実証した**）
 *
 * **`DATA_CONTRACT.md:237` の本丸——「いちばん小さい境（青森 11）との差が 1」——を
 * 元の誤り文そのままに書き戻しても、母数と最大さえ新しければ 4 テストとも緑で通った**
 * （**`pnpm --filter @seiji-kiroku/etl test` も 2115 / 2115 緑**）。
 * **`青森` も `佐賀 4` も `秋田 9` も、当時は docblock のコメントに在るだけで
 * assert には 1 つも無かった。**
 *
 * **「数字が合っているか」と「その数字が主張していることが正しいか」は別である。**
 * **#1007 が直したのは後者なので、後者を検査しなければ再発は止まらない。**
 *
 * **だから下の `SMALLEST_BOUNDARY` を足した**——
 * **11 県の境を本番 `data/` から組み直し、「いちばん小さい境は佐賀 4」という文ごと突き合わせる。**
 *
 * ## ⚠ **それでもこのテストが見ていないもの**（**正直に書く**）
 *
 * **見るのは「本番 `data/` の実測と、文章に書かれた数字・語が一致するか」までである。**
 * **11 県の境の組み立てそのもの（IN / OUT の当て方と、その仮定）は
 * `local-seats-changed-boundaries.test.ts` が持っており、此処はその値を独立にもう一度出して突き合わせるだけ。**
 * **2 つが同じ仮定を共有しているので、仮定が間違っていれば 2 つとも同じように間違う。**
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

/* ==================== 「いちばん小さい境」を本番 data/ から出し直す ==================== */

/**
 * **11 県の境の IN / OUT**（**#901 / #950 / #953 / #959 / #968 / #973 が一次資料から測った値**）。
 *
 * **`local-seats-changed-boundaries.test.ts` の `BOUNDARIES` と同じ値を、独立に置いてある。**
 * **わざと import していない**——**あちらが壊れたときに此方も一緒に壊れると、
 * 「2 か所が一致する」という此のテストの主張そのものが無意味になるからである。**
 * **ずれたら下の `assert` が落ちる**（**同じ値を 2 か所に持つ、という此の PR の形そのもの**）。
 *
 * - **`inAtBoundary`**: **境の会期にだけ居る氏名の数**
 * - **`outAtBoundary`**: **窓の中の最古の会期にだけ居る氏名の数**
 */
const BOUNDARY_IN_OUT: Readonly<Record<string, { inAtBoundary: number; outAtBoundary: number }>> = {
  "pref-02": { inAtBoundary: 11, outAtBoundary: 15 }, // 青森 #959
  "pref-04": { inAtBoundary: 19, outAtBoundary: 18 }, // 宮城 #953
  "pref-05": { inAtBoundary: 9, outAtBoundary: 7 },   // 秋田 #901
  "pref-25": { inAtBoundary: 11, outAtBoundary: 12 }, // 滋賀 #973
  "pref-29": { inAtBoundary: 17, outAtBoundary: 17 }, // 奈良 #950
  "pref-36": { inAtBoundary: 11, outAtBoundary: 13 }, // 徳島 #901
  "pref-39": { inAtBoundary: 9, outAtBoundary: 10 },  // 高知 #901
  "pref-41": { inAtBoundary: 4, outAtBoundary: 5 },   // 佐賀 #968
};

/** **境の会期を組み立てて、本番の `sessionRosterCoverageOf` に通す**（**式を書き写さない**）。 */
const boundarySeatsChanged = async (pref: string): Promise<number> => {
  const meta = JSON.parse(
    await readFile(join(DATA, "assemblies", pref, "meta.json"), "utf-8"),
  ) as LocalAssemblyMeta;
  const oldest = meta.sessionRosterCoverage.at(-1)!;
  const b = BOUNDARY_IN_OUT[pref];
  const stays = oldest.rosterSeen - b.outAtBoundary;
  const gone = oldest.unmatchedNames + b.inAtBoundary;
  const members = Array.from({ length: meta.counts.members }, (_, i) => ({ id: `m${i}` }));
  const votes = [
    ...members.slice(0, stays).map((m) => ({ memberId: m.id, nameText: `在 ${m.id}` })),
    ...Array.from({ length: gone }, (_, k) => ({ memberId: "", nameText: `退 ${k}` })),
  ];
  const rc = {
    id: "x", assemblyId: pref, sessionId: "boundary", sessionLabel: "boundary", date: "2023-01-01",
    kind: "議案", number: "1", title: "x", result: "可決", page: 1, sourceUrl: "https://example.invalid/x.pdf",
    votes: votes.map((v) => ({ ...v, group: "会派", value: { raw: "○", legend: "賛成", mapped: "賛成" as const } })),
  } as unknown as Parameters<typeof sessionRosterCoverageOf>[0][number];
  return sessionRosterCoverageOf([rc], members)[0].seatsChanged;
};

/** **県コード → 文章で使う県名**（**「佐賀 4」のように語ごと突き合わせるため**）。 */
const PREF_NAME: Readonly<Record<string, string>> = {
  "pref-02": "青森", "pref-04": "宮城", "pref-05": "秋田", "pref-25": "滋賀",
  "pref-29": "奈良", "pref-36": "徳島", "pref-39": "高知", "pref-41": "佐賀",
};


/**
 * ## **1 桁の数は「本文のどこかに在る」では検査にならない**（**変異で見つけた**）
 *
 * **最初はこのテストも最大（5）を `mentions` で見ていたが、
 * `needs` から `max` を外す変異を当てても 1 件も落ちなかった**——
 * **`5` も `4` も、5 か所すべての本文のどこかには必ず出てくるからである**（実測: 5 / 5 か所）。
 * **`99` のような在り得ない 2 桁は 5 か所中 1 か所にしか出てこないので、
 * 桁が増えれば効くが、1 桁では常に緑になる。**
 *
 * **だから最大だけは「数が在るか」ではなく「`seatsChanged` の最大は N」という語ごと見る。**
 * **5 か所すべてがこの綴りに揃えてある**（#1007 が揃えた。**揃っていなければ落ちる**）。
 */
const maxPhrase = (text: string, n: number): boolean =>
  spellings(n).some((s) => text.includes(`\`seatsChanged\` の最大は ${s}`));

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
      const ok = q === "max" ? maxPhrase(text, m.max) : mentions(text, m[q]);
      if (!ok) missing.push(`${path}: ${LABEL[q]} ${m[q]} がどの綴りでも出てこない（${why}）`);
    }
  }
  assert.deepEqual(missing, [], "**実測とずれている所**（**片方だけ直すと此処が落ちる**——#1007 の再発防止）");
});

/**
 * ## **#1007 の本題**——**「いちばん小さい境はどれか」を文ごと突き合わせる**
 *
 * **これが無いと、母数と最大さえ新しければ本丸の誤り文が素通りする**（上の docblock。**レビューが実証**）。
 *
 * **本番 `data/` から 8 県の境を組み直し、`min` を採って
 * 「線の下にあるのは 秋田 9・佐賀 4」という語を 5 か所すべてに要求する。**
 * **県名も数も実測から組み立てる**——**リテラルを 1 つも挟まない**（**恒真式にしない**）。
 */
test("#1007 「いちばん小さい境」の主張が、本番 data/ から組み直した境と一致する", async () => {
  const prefs = Object.keys(BOUNDARY_IN_OUT);
  assert.equal(prefs.length, 8, "**測れた境の数**（母数。測れない 3 県を足して 11）");

  const boundaries: { pref: string; seatsChanged: number }[] = [];
  for (const p of prefs) boundaries.push({ pref: p, seatsChanged: await boundarySeatsChanged(p) });
  boundaries.sort((a, b) => a.seatsChanged - b.seatsChanged);

  // **線の下に落ちた境**（**実測から出す。「2 県」と書き写さない**）
  const under = boundaries.filter((b) => b.seatsChanged < SEATS_CHANGED_FLAG);
  // **その顔ぶれと値**（**ここが #1007 の訂正そのもの**）
  assert.deepEqual(under.map((b) => `${PREF_NAME[b.pref]} ${b.seatsChanged}`), ["佐賀 4", "秋田 9"],
    "**線 10 の下にある境**（**「いちばん小さい境は青森 11」は誤り**）");
  // **いちばん小さい境は佐賀**（**青森ではない**——**#1007 が直した主張**）
  assert.equal(PREF_NAME[boundaries[0].pref], "佐賀", "**いちばん小さい境の県**");
  assert.notEqual(PREF_NAME[boundaries[0].pref], "青森", "**否定的対照**: **青森ではない**");
  // **青森は線の外**（**11 ではなく 16**。**測り方が違うと値が変わる**）
  const aomori = boundaries.find((b) => PREF_NAME[b.pref] === "青森")!;
  assert.equal(aomori.seatsChanged, 16, "**青森の境は 16**（#951 の組み立てでの 11 ではない）");
  assert.ok(aomori.seatsChanged >= SEATS_CHANGED_FLAG, "**青森は線の外**（取りこぼしてはいない）");

  // **その主張が 5 か所すべてに、語ごと書いてあること**（**1 か所だけ書き戻すと落ちる**）
  const phrase = under.map((b) => `${PREF_NAME[b.pref]} ${b.seatsChanged}`).reverse().join("・");
  assert.equal(phrase, "秋田 9・佐賀 4", "**文章に要求する語**（**実測から組み立てた**）");
  const missing: string[] = [];
  for (const { path, why } of PLACES) {
    if (!(await read(path)).includes(phrase)) missing.push(`${path}: 「${phrase}」が無い（${why}）`);
  }
  assert.deepEqual(missing, [], "**本丸の主張が書かれていない所**（**#1007 の再発**）");
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

/**
 * ## **`maxPhrase` が語ごと見ていること**（**1 桁を素で探すと常に緑になる**）
 *
 * **これが無いと `max` の検査は空回りする**——**実際に変異で空回りを見つけた**（上の docblock）。
 */
test("#1007 最大は「`seatsChanged` の最大は N」の語ごと見る（素の 1 桁では当たらない）", () => {
  assert.equal(maxPhrase("…5 か所…4 件…", 5), false, "1 桁が本文に在るだけでは当たらない");
  assert.equal(maxPhrase("**`seatsChanged` の最大は 4（三重）**", 5), false, "**古い最大（4）のままなら落ちる**");
  assert.equal(maxPhrase("**`seatsChanged` の最大は 5（滋賀）**", 5), true);
  // **母数**: **5 か所すべてがこの綴りに揃っていること**（**揃っていなければ上のテストが落ちる**）
  assert.equal(PLACES.filter((p) => p.needs.includes("max")).length, 5, "最大を見る所の数（母数）");
});
