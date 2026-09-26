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
  // **分布も返す**（**`max` と `flagged` が「数え直しの結果」であることを、後で分布から検算するため**）。
  // **これが無いと `max = 5;` と定数に潰しても緑だった**（#1007 のレビュー。**自己参照**）。
  const hist = new Map<number, number>();
  for (const d of dirs) {
    const meta = JSON.parse(await readFile(join(DATA, "assemblies", d, "meta.json"), "utf-8")) as LocalAssemblyMeta;
    for (const c of meta.sessionRosterCoverage) {
      sessions++; rollcalls += c.rollcalls; votes += c.votes;
      hist.set(c.seatsChanged, (hist.get(c.seatsChanged) ?? 0) + 1);
      if (c.seatsChanged > max) max = c.seatsChanged;
      if (c.seatsChanged >= SEATS_CHANGED_FLAG) flagged++;
    }
  }
  return { assemblies: dirs.length, sessions, rollcalls, votes, max, flagged, hist };
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
type Quantity = "sessions" | "rollcalls" | "votes" | "max" | "flagged" | "hist";

/**
 * **どの数を書いているかは所によって違う**（**書いていない数まで要求しない**）。
 *
 * **`guards.md` と web の docblock は「会期数と最大」までしか書かない**——
 * **採決数・票数まで書けと強いると、読みに来た人が必要としない数を増やすだけである。**
 * **要求するのは「その所が実際に書いている種類の数が、実測と一致すること」だけ。**
 */
const PLACES: readonly { path: string; why: string; needs: readonly Quantity[] }[] = [
  { path: "docs/DATA_CONTRACT.md", why: "`SEATS_CHANGED_FLAG` の節（#1007 が直した所）",
    needs: ["sessions", "rollcalls", "votes", "max", "flagged"] },
  { path: "docs/ops/guards.md", why: "守りの一覧の `sessionRosterCoverage` の行",
    needs: ["sessions", "max", "flagged"] },
  { path: "packages/shared/src/index.ts", why: "`sessionRosterCoverage` の型の docblock",
    needs: ["sessions", "rollcalls", "votes", "max", "flagged"] },
  // **分布の表を持つ 2 か所**（**#1033 の 3 巡目レビューの【A】——**
  // **「この PR が直した表が、何の抵抗もなく元の 97 会期に戻せた」**）
  { path: "packages/etl/src/local-assemblies.ts", why: "`SEATS_CHANGED_FLAG` の docblock（#990 が直した所）",
    needs: ["sessions", "rollcalls", "votes", "max", "flagged", "hist"] },
  { path: "apps/web/app/lib/session-roster-coverage.ts", why: "web 側の `SEATS_CHANGED_FLAG` の docblock",
    needs: ["sessions", "max", "flagged"] },
  // **この docblock の表は main で 97 会期ぶんのまま取り残されていた**（#1007 のレビューが見つけた）——
  // **同じ表の正しい版が `local-assemblies.ts` に在る「2 か所にあって片方だけ直った」の実例。**
  { path: "packages/etl/test/local-session-roster-coverage.test.ts", why: "本番 data/ を数える test の docblock",
    needs: ["sessions", "rollcalls", "votes", "max", "flagged", "hist"] },
];

const LABEL: Record<Quantity, string> = { sessions: "会期", rollcalls: "採決", votes: "票", max: "最大", flagged: "印", hist: "分布" };

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

/**
 * ## **「10 以上は N 件」**——**この節でいちばん load-bearing な主張**（#1007 のレビューが見つけた）
 *
 * **`seatsChanged >= 10` が 0 件であることは「境をまたいで票が黙って寄っている会期は 1 つも無い」という、
 * この欄で最も重い安全性の主張である。** **それが無検査だった**——
 * **`measure()` は `flagged` を数えていたが、どこからも assert されておらず、
 * `DATA_CONTRACT.md` の「10 以上は 0 件」を「3 件」に改竄しても 2120 / 2120 緑だった。**
 *
 * **`0` は 1 桁なので `mentions` では空回りする**（`max` と同じ理由）。**だから語ごと見る。**
 * **`SEATS_CHANGED_FLAG` の値も語に含める**——**線を動かしたら 5 か所とも書き換わるべきだからである。**
 */
const flaggedPhrase = (text: string, n: number): boolean =>
  spellings(n).some((s) => text.includes(`${SEATS_CHANGED_FLAG} 以上は ${s} 件`));

/**
 * ## **分布の表そのものを、文書と突き合わせる**（#1033 の 3 巡目レビューの【A】【B】)
 *
 * ## 【A】**この PR が直した表が、何の抵抗もなく元の誤りに戻せた**
 *
 * **`local-session-roster-coverage.test.ts` の docblock を `0:48 1:17 2:29`（合計 119）から
 * `0:32 1:12 2:28`（合計 97）に戻しても、対象テスト 7/7・`etl` 全体が緑だった。**
 * **`PLACES` に入れても防げていなかった**——**`needs` が見ていたのは
 * `sessions` / `rollcalls` / `votes` / `max` / `flagged` の 5 つのスカラーだけで、
 * 分布の表そのものは誰も読んでいなかった**
 * （**docblock の他の行に `119` が残るので `mentions(text, 119)` は当たり続ける**）。
 *
 * **`measure()` は `hist` を計算していたが、`max` と `flagged` の自己整合の検算にしか
 * 使っていなかった**——**#1013 の `flagged` が「数えているのに参照 0 件」だったのと同じ形が、
 * `hist` で再発していた。**
 *
 * ## 【B】**`measure()` を協調して潰すと、本物の異常が隠れた**
 *
 * **`hist` / `max` / `flagged` を「揃えて」`SEATS_CHANGED_FLAG` の手前で頭打ちにする変異は
 * 対象テスト 7/7 緑で、しかも等価変異ではなかった**——
 * **本番 `data/` の 1 会期を `seatsChanged: 17` にすると、変異なしでは落ちるのに、
 * 頭打ちを当てると完全に緑になった。** **この欄でいちばん load-bearing な事故
 * （「境をまたいで票が黙って寄った会期が出た」）そのものが見えなくなる。**
 *
 * ## **1 つの直しで両方閉じる**——**`hist` を「文書に書かれた表」と比べる**
 *
 * **自己整合ではなく、`measure()` が数えた分布と、文書が固定値で主張している表を比べる。**
 * - **文書の表が古い値に戻れば、実測とずれて落ちる**（【A】）。
 * - **`hist` が痩せれば、文書の固定値とずれて落ちる**（【B】）——
 *   **`17` は頭打ちで `5` に流れ込み、`| 5 | 8 |` が `| 5 | 9 |` になって文書と食い違う。**
 *
 * **2 つの表は同じ `| N | M |` の書式で書かれている**
 * （`packages/etl/src/local-assemblies.ts` と
 * `packages/etl/test/local-session-roster-coverage.test.ts`）。
 */
const histRows = (hist: ReadonlyMap<number, number>): string[] =>
  [...hist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k} | ${v}`);

/**
 * **文書の分布の表から `| 0 | 48 |` の行を拾う**（**`0 | 48` の形に正規化して返す**）。
 *
 * ## **表の見出しで場所を決める**（**ファイル全体から拾ってはいけない**)
 *
 * **最初は「ファイル中の `| 数 | 数 |` の行を全部」にしたが、`local-assemblies.ts` には
 * 境の表（`| 2 | 2026 |` など 9 行）が別に在り、それを分布の行と誤って拾った**
 * （**実測: 余計な行 9 本で落ちた**）。
 * **だから `| \`seatsChanged\` | 会期 |` という見出しの行から、表が終わるまでだけを読む。**
 *
 * **太字の `**` と余分な空白は落とす**——**`| **5** | **8**（滋賀 …） |` も `5 | 8` にする。**
 * **左の欄が数だけでない行（`| **6 以上** | **0** |` /
 * `| **10 以上は 0 件**（印が付く会期） | **0** |`）は拾わない**——
 * **分布の行ではなく、`flaggedPhrase` が別に見ている主張だからである。**
 * **行頭の `* `（docblock）と桁揃えの `|---:|` も落ちる。**
 */
const HIST_TABLE_HEAD = "| `seatsChanged` | 会期 |";
const tableRows = (text: string): Set<string> => {
  const out = new Set<string>();
  let inside = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s*\*\s?/, "").trim(); // docblock の `* ` を落とす
    if (line.startsWith(HIST_TABLE_HEAD)) { inside = true; continue; }
    if (!inside) continue;
    if (!line.startsWith("|")) { inside = false; continue; } // 表の終わり
    const m = /^\|\s*\*{0,2}(\d+)\*{0,2}\s*\|\s*\*{0,2}(\d+)\*{0,2}/.exec(line);
    if (m) out.add(`${m[1]} | ${m[2]}`);
  }
  return out;
};

test("#1007 線と実測の距離を書いた 6 か所が、本番 data/ の実測と一致する", async () => {
  const m = await measure();
  // **母数を先に置く**（#757。**数え直しが空回りしていたら以降は無意味**）
  assert.equal(m.assemblies, 11, "11 議会ぶんを数えたこと（母数）");
  assert.ok(m.sessions > 0 && m.rollcalls > 0 && m.votes > 0, "data/ から数が出ていること");
  // ## **`max` と `flagged` も「数え直しの結果である」ことを守る**（#1007 のレビューが見つけた）
  //
  // **`sessions` / `rollcalls` / `votes` にはこの守りが在ったが、`max` と `flagged` だけ外れていた**——
  // **`measure()` の `max` 集計を `max = 5;` と定数にしても 2120 / 2120 緑だった**
  // （**期待値が `measure()` から来るので、`measure()` が痩せれば期待値も痩せる＝自己参照**。#1001）。
  // **分布から独立に出し直して、`max` / `flagged` が数え直しの結果であることを検算する**
  // （**`max = 5;` と定数に潰す変異は、此処で落ちる**——**分布は潰れていないため**）
  const keys = [...m.hist.keys()];
  assert.ok(keys.length > 0, "分布が空でない（母数）");
  assert.equal(m.max, Math.max(...keys), "**最大は分布の最大と一致する**（**定数に潰すと落ちる**）");
  assert.equal(m.flagged, [...m.hist].filter(([k]) => k >= SEATS_CHANGED_FLAG).reduce((n, [, v]) => n + v, 0),
    "**印の件数は分布から数え直したものと一致する**");
  assert.equal([...m.hist.values()].reduce((a, b) => a + b, 0), m.sessions, "**分布の合計は会期数**（母数の検算）");
  assert.equal(m.flagged, 0, "**`seatsChanged >= 10` の会期は 0 件**（**この欄で最も重い主張**）");
  assert.equal(PLACES.length, 6, "見る所の数（母数。rg の 14 本のうち数字を書いている所）");

  // **数え直しの母数**（**検査した (所 × 数) の組の数。0 を緑にしない**。#757）
  assert.equal(PLACES.reduce((n, p) => n + p.needs.length, 0), 28,
    "検査する (所 × 数) の組の数（母数。5+3+5+6+3+6）");
  // **分布の表を持つ所の数**（母数。**2 か所とも見る**——**片方だけ直るのが #1007 の病気**）
  assert.equal(PLACES.filter((p) => p.needs.includes("hist")).length, 2,
    "**分布の表を突き合わせる所の数**（母数。**同じ表が 2 か所にある**）");
  // **分布の行数の母数**（**`hist` が痩せたら此処が先に落ちる**。0 を緑にしない）
  assert.equal(histRows(m.hist).length, 6, "**分布の行数**（母数。実測 0〜5 の 6 行）");

  const missing: string[] = [];
  for (const { path, why, needs } of PLACES) {
    const text = await read(path);
    // **その場所が本当に `seatsChanged` の話をしていること**（**関係の無いファイルを緑で通さない**）
    assert.ok(/seatsChanged|SEATS_CHANGED_FLAG/.test(text), `${path}: seatsChanged の話が無い（${why}）`);
    for (const q of needs) {
      if (q === "hist") {
        // **分布は行ごとに突き合わせる**（**どの行がずれたかを名指しして落ちる**）
        const rows = tableRows(text);
        const bad = histRows(m.hist).filter((r) => !rows.has(r));
        if (bad.length > 0) missing.push(`${path}: 分布の行が実測と違う（無いのは ${bad.join(" / ")}）（${why}）`);
        // **文書が実測より多い行を持っていないこと**（**古い行が残っていたら落ちる**）
        const extra = [...rows].filter((r) => !histRows(m.hist).includes(r));
        if (extra.length > 0) missing.push(`${path}: 実測に無い分布の行がある（${extra.join(" / ")}）（${why}）`);
        continue;
      }
      // **1 桁（最大 5 / 印 0）は「本文のどこかに在るか」では空回りする**ので語ごと見る
      const ok = q === "max" ? maxPhrase(text, m.max)
        : q === "flagged" ? flaggedPhrase(text, m.flagged)
        : mentions(text, m[q]);
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

  // ## **語が在るだけでは足りない**——**主張の向きまで見る**（#1007 のレビューが見つけた）
  //
  // **初版は `text.includes("秋田 9・佐賀 4")` だけだったので、
  // 「線の下にあるのは」を「線の上にあるのは」に反転しても緑だった**（素通り④）。
  // **#1007 が直したのは「上か下か」なので、向きが素通りするなら本丸の半分が無検査である。**
  //
  // **さらに「1 文だけ裏返す」「誤った文を隣に足す」も素通りしていた**（素通り⑤⑥）——
  // **doc は「最後に書いてあることが正しい」とは限らないので、
  // 「正しい語が在るか」だけでなく「誤った語が無いか」も見る。**
  const phrase = under.map((b) => `${PREF_NAME[b.pref]} ${b.seatsChanged}`).reverse().join("・");
  assert.equal(phrase, "秋田 9・佐賀 4", "**文章に要求する語**（**実測から組み立てた**）");
  // **向きごと要求する**（**「線の下にあるのは 秋田 9・佐賀 4」**）
  const claim = `線の下にあるのは ${phrase}`;
  const smallest = `いちばん小さい境は${PREF_NAME[boundaries[0].pref]} ${boundaries[0].seatsChanged}`;
  assert.equal(claim, "線の下にあるのは 秋田 9・佐賀 4");
  assert.equal(smallest, "いちばん小さい境は佐賀 4");

  const missing: string[] = [];
  for (const { path, why } of PLACES) {
    if (!(await read(path)).includes(phrase)) missing.push(`${path}: 「${phrase}」が無い（${why}）`);
  }
  assert.deepEqual(missing, [], "**本丸の主張が書かれていない所**（**#1007 の再発**）");

  // ## **向きは 6 か所すべてに要求する**（#1033 の 3 巡目レビューの【C】）
  //
  // **初版は `DATA_CONTRACT.md` の 1 か所でしか向きを見ていなかった**——
  // **残りの 5 か所は `秋田 9・佐賀 4` が在るかしか見ておらず、
  // 3 か所（`packages/shared/src/index.ts` / `packages/etl/src/local-assemblies.ts` /
  // `docs/ops/guards.md`）で「線の下」を「線の上」に同時に反転しても 8/8 緑だった**（実測）。
  // **#1007 が起きた原因はまさに「片方だけ直って、もう片方が取り残された」ことである。**
  //
  // **文面は所によって違う**（`この線の下にある` / `線 10 の下にある` / `線の下は`）。
  // **文面を揃えさせるのは窮屈なので、`秋田 9・佐賀 4` の近傍だけを見る**——
  // **「下」が在り、かつ「上」が無いこと。**
  // **「上」も見るのが要点である**——**「下」だけを要求すると、
  // 同じ近傍に別の「下」が在る所（`（線の下 6）で、線の下にあるのは …` /
  // `（下の表。**線の下は …`）で反転が素通りする**（実測: 6 か所のうち 2 か所が該当）。
  //
  // ## **近傍の幅は測って決めた**（**当て推量で 60 などと置かない**）
  //
  // **`秋田 9・佐賀 4` から最も近い「下」までの距離**（**実測。文字数**）:
  //
  // | 所 | 距離 |
  // |---|---:|
  // | `docs/DATA_CONTRACT.md` | **前 6** |
  // | `docs/ops/guards.md` | 後 8 |
  // | `packages/shared/src/index.ts` | **後 10**（**いちばん遠い**） |
  // | `packages/etl/src/local-assemblies.ts` | 前 2 |
  // | `apps/web/app/lib/session-roster-coverage.ts` | 後 8 |
  // | `packages/etl/test/local-session-roster-coverage.test.ts` | 後 6 |
  //
  // **下の余裕は 6**（**10 まで縮めると `shared` が落ちる**）。
  // **上の余裕は 3**——**20 にすると `local-assemblies.ts` の窓に
  // 「線を 12 以上にすると」の「上」が入って落ちる**（実測）。
  // **だから安全帯は 10 〜 19 で、16 を採った。**
  const NEAR = 16;
  const wrongWay: string[] = [];
  for (const { path, why } of PLACES) {
    const text = await read(path);
    const at = text.indexOf(phrase);
    assert.notEqual(at, -1, `${path}: 上の検査が通ったのに ${phrase} が無い（前提が壊れている）`);
    const around = text.slice(Math.max(0, at - NEAR), at + phrase.length + NEAR);
    if (!around.includes("下")) wrongWay.push(`${path}: 「${phrase}」の近くに「下」が無い（${why}）`);
    if (around.includes("上")) wrongWay.push(`${path}: 「${phrase}」の近くに「上」がある（向きが反転している？）（${why}）`);
  }
  assert.deepEqual(wrongWay, [], "**主張の向きが書かれていない所**（**「線の上に」に反転すると落ちる**）");
  assert.equal(PLACES.length, 6, "**向きを見た所の数**（母数。**6 か所すべて**。1 か所だけでは【C】が素通りした）");

  // **`DATA_CONTRACT.md` だけは文面まで揃えてある**（**いちばん読まれる所なので厳しく見る**）
  assert.ok((await read("docs/DATA_CONTRACT.md")).includes(claim),
    `**主張の向きが書かれていない**（「${claim}」。**「線の上に」に反転すると此処が落ちる**）`);

  // ## **誤った主張が「隣に足されて」いないこと**（**素通り⑤⑥**）
  //
  // **`いちばん小さい境は青森 11` は、`… ではなく` が続くとき（訂正文）だけ許す。**
  // **「いちばん小さい境は青森 11 との差が 1」のような、主張として書かれた形は落とす。**
  const aomoriName = PREF_NAME[aomori.pref];
  // **「…は誤りである」「…ではなく」と注記された形は許す**（**過去の誤りを記録に残すのは正しい**）。
  // **許さないのは「事実として言い切っている」形だけ。**
  //
  // ## **言い換えも捕まえる**（#1033 の 3 巡目レビュー【D】）
  //
  // **初版は `いちばん小さい境` の literal を要求していたので、
  // `**最小の境は青森 11 で、線 10 との差は 1 しかない。**` は素通りした**
  // （**引用でも何でもない、素の誤り文である**。実測: 9/9 緑）。
  // **「いちばん小さい」「最小」「最も小さい」のどれでも捕まえるようにした。**
  //
  // **`境` の語まで要求するのが要点である**——
  // **`最小` だけで捕まえると、`**この 3 県の中での最小（青森 11）と線の差**` のような
  // 範囲を限った正しい記述まで落ちる**
  // （`packages/etl/test/local-session-roster-coverage.test.ts:420`。**実測で 1 件当たった**）。
  // **`境` を要求すると誤検出は 0 件になった**（**当たる 15 本を全部走らせて測った**）。
  const smallestWord = "(?:いちばん小さい|最小|最も小さい)の?境";
  const wrong = new RegExp(
    `${smallestWord}[はがのも（(]?[^。]*?${aomoriName}\\s*11(?![^。]*(?:ではなく|は誤り|誤りである|訂正))`,
  );
  //
  // **これは `PLACES` の 6 本ではなく、`git grep` に当たる 15 本すべてを見る**——
  // **誤りの復活は「検査すると決めた所」だけに起きるとは限らない**
  // （**レビュアーは `docs/WORKING_AGREEMENT.md`（`PLACES` の外）に足して素通りさせた。素通り③**）。
  //
  // ## ⚠ **「誤りを引用している行」と「誤りを主張している行」は、機械では見分けきれない**
  //
  // **`「…」` で括った引用・`> ` の引用・このファイル自身の否定的対照は、**
  // **どれも誤り文を本文に含むが、誤りではない。** **そこは除く**——
  // **除いたぶん、この検査は「引用の形に偽装した誤り」を見逃す**（**正直に書く**）。
  //
  // ## ⚠ **塞げていない形**（**denylist の限界そのもの。実例つきで残す**。#1022 / #1033【D】）
  //
  // **下の 4 つは、この PR のあとも 9/9 緑のまま素通りする**（**測った。推測ではない**）:
  //
  // | 素通りする書き方 | なぜ塞がないか |
  // |---|---|
  // | `> **下側はいちばん小さい境（青森 11）との差が 1。**` | **`> ` の引用はレビューの記録に日常的に使う。塞ぐと歴史が書けない** |
  // | `**「いちばん小さい境は青森 11」は誤りである**` | **同上。「…」で括った引用を落とすと訂正が書けない** |
  // | `**下側は取りこぼしていない。いちばん小さい境は。青森 11 との差が 1。**` | **句点を挟むと `[^。]` を越えられない。文をまたいで読むと誤検出が増える** |
  // | `**下限は青森 11 で、線 10 との差は 1 しかない。**` | **`境` の語を使わない言い換え。`境` を外すと正しい記述（`3 県の中での最小（青森 11）`）が落ちる** |
  //
  // **「引用は除く」という但し書きでは下 2 つをカバーできていなかった**——**引用ですらないため。**
  // **塞ぐより、塞げていない形を実例で書き残すほうが読む人の役に立つと判断した。**
  const quoted = (line: string): boolean =>
    /^\s*(?:\*\s*)?>/.test(line)          // 引用ブロック（`> …` / ` * > …`）
    || /「[^」]*(?:いちばん小さい|最小|最も小さい)の?境/.test(line)  // 「…」で括った引用
    || /assert\.|wrong\.test|expect\(/.test(line); // このファイル自身の否定的対照
  const revived: string[] = [];
  for (const path of await grepHits()) {
    // **このファイル自身は、誤り文を説明のために何度も書くので除く**（**上の否定的対照が代わりに見ている**）
    if (path === "packages/etl/test/seats-changed-line-numbers.test.ts") continue;
    const text = await read(path);
    for (const line of text.split("\n")) {
      if (wrong.test(line) && !quoted(line)) revived.push(`${path}: ${line.trim().slice(0, 60)}`);
    }
  }
  assert.deepEqual(revived, [], "**「いちばん小さい境は青森 11」が主張として書かれている所**（**#1007 の誤りの復活**）");
  // **否定的対照**: **訂正文の形は許し、誤りの形は捕まえる**（**正規表現が空回りしていない**）
  assert.equal(wrong.test("いちばん小さい境は青森 11 ではなく佐賀 4（線の下 6）"), false, "訂正文は許す");
  assert.equal(wrong.test("**⚠ 「いちばん小さい境は青森 11」は 2026-09-23 から在った誤りである**"), false,
    "**過去の誤りを記録に残す形は許す**（**歴史を消させない**）");
  assert.equal(wrong.test("下側はいちばん小さい境（青森 11）との差が 1。"), true, "**元の誤り文は捕まえる**");
  assert.equal(wrong.test("いちばん小さい境は青森 11 との差が 1"), true, "**言い切る形は捕まえる**");
  // **言い換え**（#1033【D】。**`いちばん小さい` の literal を要求していたので素通りしていた**）
  assert.equal(wrong.test("**最小の境は青森 11 で、線 10 との差は 1 しかない。**"), true,
    "**「最小の境」への言い換えも捕まえる**（**#1033【D】の素通り**）");
  assert.equal(wrong.test("最も小さい境は青森 11 である"), true, "**「最も小さい境」も捕まえる**");
  // **範囲を限った正しい記述は許す**（**`境` の語を要求しているので当たらない**）
  assert.equal(wrong.test("**この 3 県の中での最小（青森 11）と線の差**——**11 県の最小ではない**（**最小は佐賀 4**）"), false,
    "**3 県に限った最小は正しい記述なので許す**（**`境` の語が無い**）");
  assert.equal(wrong.test("いちばん小さい境は佐賀 4"), false, "正しい主張は許す");
});

/**
 * ## **`PLACES` が denylist であることを、母数で見えるようにする**（#1007 のレビュー。素通り③）
 *
 * **`rg -l 'seatsChanged|SEATS_CHANGED_FLAG'` に当たるが `PLACES` に無いファイルに、
 * 元の誤り文をそっくり足しても 2120 / 2120 緑だった**
 * （**レビュアーは `docs/WORKING_AGREEMENT.md` で実証した**）。
 *
 * **`PLACES` は denylist なので、その外は素通りする。これは消せない**——
 * **が、「何本を対象外にしたか」を数えれば、新しいファイルが増えたときに気づける。**
 * **`local-seats-changed-boundaries.test.ts` が `BOUNDARIES` + `UNMEASURED_BOUNDARIES` = 11 で
 * やっているのと同じ形である。**
 *
 * **PR 本文は当初「rg で当たるのは 9 本」と書いていたが誤りだった**（**レビュアーが見つけた**）。
 * **手で数えたのが原因なので、機械に数えさせる。**
 *
 * ## ⚠ **`rg` と `git grep` で本数が違う**（**どちらが正しいかを決めておく**）
 *
 * **`rg` の既定は隠しディレクトリを見ないので 14 本、`git grep`（＝ `rg --hidden`）は 15 本になる。**
 * **差は `.claude/agents/README.md` の 1 本**（**`SEATS_CHANGED_FLAG` の恒真式に言及している**）。
 * **レビュアーの「14 本」は `rg` の既定での実測で、正しい。**
 *
 * **此処では `git grep` を採る**——**追跡されているファイルを漏れなく見るため。**
 * **「隠しディレクトリだから見なくてよい」は、この検査の目的（denylist の外を数える）に反する。**
 */
const OUT_OF_SCOPE: Readonly<Record<string, string>> = {
  "apps/web/app/lib/session-roster-coverage.test.ts": "線の値そのものを ETL の原文と突き合わせている（数字を書かない）",
  "apps/web/app/routes/coverage.tsx": "数字を書かず `meta.json` から描いている",
  // **⚠ 理由を訂正した**（#1033 の 3 巡目レビュー【E】）——**`toEqual` は確かに数え直しているが、
  // 同じファイルの docblock（53 行）が `96 会期` のまま 23 会期ぶん腐っていた。**
  // **直したうえで、下の「`11 議会 … N 会期` の N」の検査で次の腐りを止める。**
  "apps/web/app/routes/session-roster-coverage-published.test.tsx": "`toEqual` が本番 `data/` から数え直して固定している（docblock の会期数は下の SESSIONS_PHRASE が見る）",
  // **⚠ 理由を訂正した**（#1033 の 3 巡目レビュー【E】）——**「数字を書いていない」は事実と違った。**
  // **379 行に `4,599`、390 行に `198,221` を書いている**（ref: `origin/main` = `42f9c225`）。
  // **ただし書いてあるのは「grep が何か所に当たるか」という過去の測定の記録であって、
  // 「今の本番の母数」の主張ではない**ので、対象外の判断そのものは変えない。
  "docs/WORKING_AGREEMENT.md": "`4,599` / `198,221` を書いているが、grep の当たり本数を数えた過去の測定の記録で、今の母数の主張ではない",
  "packages/etl/test/local-roster-window.test.ts": "#928 の窓の話で、`seatsChanged` は母数として触れるだけ",
  "packages/etl/test/local-seats-changed-boundaries.test.ts": "本番 `data/` から境を組み直しているので、ずれたらそれ自身が落ちる",
  "packages/etl/test/saga-sessions-widen.test.ts": "佐賀の境を一次資料から組み立てている（#959 の値は注記つきで保存）",
  "packages/etl/test/seats-changed-line-numbers.test.ts": "このファイル自身",
  ".claude/agents/README.md": "レビューの手順書。`SEATS_CHANGED_FLAG` の恒真式に言及するだけで、母数の数字を書かない",
};

/**
 * **`seatsChanged` に触れている追跡ファイル**（**`data/` は出力なので除く**）。
 *
 * ## ⚠ **`git grep` は未追跡ファイルを見ない**（#1033 の 3 巡目レビュー【F】）
 *
 * **`docs/NEW_NOTE.md` を未追跡のまま作って誤り文を書くと素通りする**（**レビュアーが実証**）。
 * **`git add` すれば落ちる**（**denylist の母数の検査が、足りない 1 本を名指しする**）。
 * **CI は追跡ファイルしか持たないので実害はほぼ無いが、性質として書き残す。**
 */
const grepHits = async (): Promise<string[]> => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("git", ["grep", "-l", "-E", "seatsChanged|SEATS_CHANGED_FLAG"], { cwd: REPO });
  return stdout.split("\n").filter(Boolean)
    // **`data/` は出力であって記述ではない。`pnpm-lock.yaml` も同じ**
    .filter((f) => !f.startsWith("data/") && f !== "pnpm-lock.yaml").sort();
};

/**
 * ## **`11 議会 … N 会期` と書いた所すべての N を見る**（#1033 の 3 巡目レビュー【E】）
 *
 * **`PLACES` は denylist なので、「読んだ上で対象外にした」所は無検査になる。**
 * **そこで実際に腐りが見つかった**——
 * **`apps/web/app/routes/session-roster-coverage-published.test.tsx:53` の docblock が
 * `11 議会 / 96 会期` のままで、同じファイルの `toEqual` が要求する `sessions: 119` と
 * 23 会期ぶん食い違っていた**（ref: `origin/main` = `42f9c225`。**この PR で直した**）。
 * **「本番 `data/` から数え直しているので安全」と名指しして対象外にした所に在った。**
 *
 * **だからこの検査だけは denylist を通さない**——
 * **追跡ファイル全部を見て、`11 議会 … N 会期` の N が実測と違えば落ちる。**
 * **語を決め打ちにしているぶん取りこぼすが、`PLACES` の外でも効く。**
 *
 * **母数は実測**（**手で数えない**）。**`git grep` で当たる行を数えている**——
 * **実測 2026-09-27: 10 行 / 7 ファイル**（**このファイル自身の 6 行を除く。除く前は 16 行 / 8 ファイル**）。
 *
 * **ref を併記する**（#1033）——**行番号や本数は測った時点の ref でしか意味を持たない。**
 * **上の 10 / 7 は `origin/main` = `42f9c225` にこの PR を載せた状態での実測である。**
 */
const SESSIONS_PHRASE = /11 議会\s*\/?\s*([0-9０-９,_]+) 会期/g;

test("#1033 「11 議会 … N 会期」と書いた所すべてで N が実測と一致する（denylist の外も見る）", async () => {
  const m = await measure();
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  // **`data/` は出力なので除く**（**`pnpm-lock.yaml` も同じ**）
  const { stdout } = await promisify(execFile)("git", ["grep", "-l", "-E", "11 議会"], { cwd: REPO });
  const files = stdout.split("\n").filter(Boolean)
    // **`data/` は出力であって記述ではない。`pnpm-lock.yaml` も同じ**
    .filter((f) => !f.startsWith("data/") && f !== "pnpm-lock.yaml")
    // **このファイル自身は除く**——**腐っていた `96 会期` を説明と否定的対照で何度も書くため**
    // （**上の `wrong` の検査が自分自身を除いているのと同じ形。実測で 5 行が此処に在る**）
    .filter((f) => f !== "packages/etl/test/seats-changed-line-numbers.test.ts").sort();

  const hits: { path: string; n: string }[] = [];
  for (const path of files) {
    const text = await read(path);
    for (const g of text.matchAll(SESSIONS_PHRASE)) hits.push({ path, n: g[1] });
  }
  // **母数**（**0 を緑にしない**。#757。**実測 2026-09-27 で 11 行 / 8 ファイル**）
  assert.equal(hits.length, 10, `**「11 議会 … N 会期」と書いた行の数**（母数。実測。今は ${hits.length} 行）`);
  assert.equal(new Set(hits.map((h) => h.path)).size, 7,
    "**それを書いているファイルの数**（母数。**このファイル自身を除いた 7**——`git grep -l '11 議会'` は 8）");

  // **どの行の N も実測の会期数**（**`96` のような古い値が 1 行でも残っていたら名指しして落ちる**）
  const stale = hits.filter((h) => !spellings(m.sessions).includes(h.n)).map((h) => `${h.path}: 11 議会 … ${h.n} 会期`);
  assert.deepEqual(stale, [], `**会期数が実測（${m.sessions}）とずれている行**（**#1033【E】の再発**）`);

  // **否定的対照**: **正規表現が空回りしていないこと**（**在り得ない値は捕まえる**）
  assert.deepEqual([...("**実測: 11 議会 / 96 会期**".matchAll(SESSIONS_PHRASE))].map((g) => g[1]), ["96"],
    "**`11 議会 / 96 会期` を拾える**（**腐っていた実物の書式**）");
  assert.deepEqual([...("**11 議会 119 会期で**".matchAll(SESSIONS_PHRASE))].map((g) => g[1]), ["119"],
    "**`/` の無い書式も拾える**（`guards.md` はこの形）");
  assert.deepEqual([...("11 議会 / 119 会期 / 4,599 採決".matchAll(SESSIONS_PHRASE))].map((g) => g[1]), ["119"],
    "**採決数を会期数と読み違えない**");
});

test("#1007 git grep に当たる 15 本が、検査する 6 本と対象外 9 本に過不足なく分かれる（denylist の母数）", async () => {
  const hits = await grepHits();
  assert.equal(hits.length, 15, `**git grep に当たる本数**（母数。実測。今は ${hits.length} 本）`);
  const covered = PLACES.map((p) => p.path).sort();
  const excluded = Object.keys(OUT_OF_SCOPE).sort();
  assert.equal(covered.length, 6, "**検査する本数**");
  assert.equal(excluded.length, 9, "**対象外にした本数**（**理由つきで名指ししている**）");
  // **足して 15**（**どちらにも入っていないファイルを作らない**）
  assert.deepEqual([...covered, ...excluded].sort(), hits,
    "**検査する所と対象外を足すと、rg に当たる全部になる**（**新しいファイルが増えたら此処が落ちる**）");
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
  assert.equal(PLACES.filter((p) => p.needs.includes("max")).length, 6, "最大を見る所の数（母数）");
});

/**
 * ## **`flaggedPhrase` が語ごと見ていること**（**`0` を素で探すと常に緑になる**）
 *
 * **「10 以上は 0 件」は、この欄でいちばん load-bearing な安全性の主張である**——
 * **それが `3 件` に書き換えられても緑だった**（#1007 のレビュー）。
 */
/**
 * ## **`tableRows` が空回りしていないこと**（#1033 の【A】【B】の鍵）
 *
 * **`tableRows` が常に空集合を返すなら、上の突き合わせは `bad = 全部` で落ちる**
 * （**空回りが「緑」にならない向きに組んである**）。
 * **危ないのは逆向き**——**関係の無い表を拾って、分布の行が「在る」ことになってしまう形。**
 * **だから見出しで場所を決めていることと、数だけの欄しか拾わないことを、ここで固定する。**
 */
test("#1033 分布の表は見出しの下だけを読み、数だけの欄しか拾わない", () => {
  const doc = [
    "| 別の表 | 年 |",
    "| 2 | 2026 |",                        // **見出しの外**（**拾ってはいけない**）
    "| `seatsChanged` | 会期 |",
    "|---:|---:|",
    "| 0 | 48 |",
    "| **5** | **8**（滋賀 2023-05 〜 2024-09。母数 42 人） |",
    "| **6 以上** | **0** |",              // **左が数だけでない**（**拾わない**）
    "",
    "| 9 | 99 |",                          // **表が終わった後**（**拾ってはいけない**）
  ].join("\n");
  assert.deepEqual([...tableRows(doc)].sort(), ["0 | 48", "5 | 8"],
    "**見出しの下の、数だけの行だけ**（**`2 | 2026` も `9 | 99` も `6 以上` も拾わない**）");
  // **docblock の `* ` が付いていても同じに読める**（**2 か所のうち片方は docblock の中にある**）
  assert.deepEqual([...tableRows(" * | `seatsChanged` | 会期 |\n * | 3 | 9 |")].sort(), ["3 | 9"]);
  // **古い値に戻したら、実測の行が「無い」ことになる**（【A】の形）
  const oldDoc = "| `seatsChanged` | 会期 |\n| 0 | 32 |\n| 1 | 12 |";
  const measured = histRows(new Map([[0, 48], [1, 17]]));
  assert.deepEqual(measured.filter((r) => !tableRows(oldDoc).has(r)), ["0 | 48", "1 | 17"],
    "**97 会期ぶんの表に戻すと、実測の行が 1 つも見つからない**（**#1033【A】**）");
  // **`hist` が痩せたら、文書の固定値とずれる**（【B】の形。**17 が 5 に流れ込むと 8 → 9**）
  const clipped = histRows(new Map([[0, 48], [5, 9]]));
  assert.deepEqual(clipped.filter((r) => !tableRows("| `seatsChanged` | 会期 |\n| 0 | 48 |\n| 5 | 8 |").has(r)),
    ["5 | 9"], "**頭打ちで 5 に流れ込むと `5 | 8` と食い違う**（**#1033【B】**）");
});

test("#1007 印は「10 以上は N 件」の語ごと見る（素の 0 では当たらない）", () => {
  assert.equal(flaggedPhrase("…0 件…10 以上…", 0), false, "語が離れていれば当たらない");
  assert.equal(flaggedPhrase("**10 以上は 3 件**", 0), false, "**0 件でない主張は落ちる**（**素通り① の再現**）");
  assert.equal(flaggedPhrase("**10 以上は 0 件**", 0), true);
  // **線の値も語に含む**——**線を動かしたら 6 か所とも書き換わるべき**
  assert.equal(SEATS_CHANGED_FLAG, 10, "線（この語の一部になっている）");
  assert.equal(flaggedPhrase("**20 以上は 0 件**", 0), false, "**別の線の話は当たらない**");
  assert.equal(PLACES.filter((p) => p.needs.includes("flagged")).length, 6, "印を見る所の数（母数）");
});
