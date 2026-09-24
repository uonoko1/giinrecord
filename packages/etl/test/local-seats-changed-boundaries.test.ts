import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalAssemblyMeta } from "@seiji-kiroku/shared";
import { SEATS_CHANGED_FLAG, sessionRosterCoverageOf } from "../src/local-assemblies.ts";

/**
 * # **`seatsChanged` が一般選挙の境をどれだけ取りこぼすかを数える**（Issue #986）
 *
 * ## **何を測ったか**
 *
 * **#968（佐賀）の担当者が「本物の一般選挙の境なのに線 10 に掛からなかった」と報告した。**
 * **PO は「`min` が非対称な入れ替わりを縮めるからだ」と見立て、
 * 佐賀の担当者は「名簿の定数が 1 でも減っている県は必ず非対称になる」と申し送った。**
 *
 * **この PBI で測った結果、どちらの見立ても機序としては正しくない**（下の 1 節）。
 * **`min` は「非対称なとき」ではなく、**常に**縮める。**
 *
 * ## **なぜ新しい取得をしていないか**——**境の値は既に測られている**
 *
 * **11 県の境をもう一度 ETL で取りに行くには、数百本の PDF を 1 秒間隔で取り直す必要がある**
 * （`polite-fetch.ts` の `MIN_INTERVAL_MS`）。**県のサイトを叩き直す理由が無い**——
 * **境の氏名の集合（IN / OUT）は #901 / #950 / #953 / #959 / #968 / #973 が
 * 一次資料から既に測り、`defaultSessionsFor` の docblock に残してあるからである。**
 *
 * **ここでやるのは、その IN / OUT と本番 `data/` の実測値から
 * `sessionRosterCoverageOf` の入力を組み立てて、同じ関数に通すことだけである**
 * （**式を書き写さない**——**PO が #986 でそれをやって間違えた**）。
 *
 * ## **docblock の IN / OUT の向き**（**読み違えると答えが裏返る**）
 *
 * **docblock の表は新しい会期から古い会期へ並んでおり、`IN` は「新しい側にだけ居る氏名」である。**
 * **我々が測りたいのは古い側（境の向こう）なので、向きが入れ替わる。**
 * **下の `BOUNDARIES` はすべて「境の会期から見た IN / OUT」に直してある。**
 * **直したことを検算できるよう、docblock が書いている氏名の数もいっしょに持つ**
 * （`namesNewer` / `namesOlder` / `shared`。**引き算が合わなければ落ちる**）。
 */
const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));

const metaOf = async (p: string): Promise<LocalAssemblyMeta> =>
  JSON.parse(await readFile(join(DATA, "assemblies", p, "meta.json"), "utf-8")) as LocalAssemblyMeta;

const localPrefs = async (): Promise<string[]> =>
  (await readdir(join(DATA, "assemblies"), { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name.startsWith("pref-")).map((e) => e.name).sort();

/**
 * **境の 1 つ向こうの会期の氏名の集合**（**前の PBI が一次資料から測った値**）。
 *
 * - **`inAtBoundary`**: **境の会期にだけ居る氏名の数**（＝ docblock の表の「古い側にだけ居る」側）
 * - **`outAtBoundary`**: **窓の中の最古の会期にだけ居る氏名の数**（＝ docblock の `IN`）
 * - **`namesNewer` / `namesOlder` / `shared`**: docblock が書いている氏名の数（**向きの検算用**）
 *
 * **記録が無い 3 県は入っていない**（`UNMEASURED_BOUNDARIES`）。
 */
const BOUNDARIES: Readonly<Record<string, {
  label: string; inAtBoundary: number; outAtBoundary: number;
  namesNewer?: number; namesOlder?: number; shared?: number; source: string;
}>> = {
  // **青森**: docblock の表「14: 氏名 48 / 共通 37」「15: 氏名 44 / 共通 33 / IN 11 / OUT 15」
  "pref-02": { label: "15 会期目 2023-02", inAtBoundary: 11, outAtBoundary: 15, namesNewer: 48, namesOlder: 44, shared: 33, source: "#959" },
  // **宮城**: 第390回 ← 第389回 が IN 18 / OUT 19（docblock は「IN 18 / OUT 19」と書く）
  "pref-04": { label: "第389回 2023-07", inAtBoundary: 19, outAtBoundary: 18, source: "#953" },
  // **秋田**: docblock の表「29: 氏名 41 / 共通 34」「30: 氏名 43 / 共通 43」、境は IN 7 / OUT 9
  "pref-05": { label: "30 本目 2023-03-10", inAtBoundary: 9, outAtBoundary: 7, namesNewer: 41, namesOlder: 43, shared: 34, source: "#901 秋田" },
  // **滋賀**: 2023-02 ← 2023-05招集会議 が IN 12 / OUT 11
  "pref-25": { label: "20 会期目 2023-02", inAtBoundary: 11, outAtBoundary: 12, source: "#973" },
  // **奈良**: 2024-10-23 ↔ 2022-10-24 が IN 17 / OUT 17（対称なので向きで値が動かない）
  "pref-29": { label: "2022-10-24", inAtBoundary: 17, outAtBoundary: 17, source: "#950" },
  // **徳島**: docblock の表「2023-05: 氏名 38 / 共通 25 / IN 13 / OUT 11」（古い側 2023-02 は 36 名）
  "pref-36": { label: "2023-02", inAtBoundary: 11, outAtBoundary: 13, namesNewer: 38, namesOlder: 36, shared: 25, source: "#901 徳島" },
  // **高知**: 2023-02 と 2023-05臨時 のあいだが IN 10 / OUT 9
  "pref-39": { label: "2023-02", inAtBoundary: 9, outAtBoundary: 10, source: "#901 高知" },
  // **佐賀**: 令和5年5月臨 ← 令和5年2月定 が IN 4 / OUT 5。
  // **入る 4 人は今の名簿に 1 人もおらず、出る 5 人は全員いる**（docblock が氏名を名指ししている）
  "pref-41": { label: "14 会期目 令和5年2月定", inAtBoundary: 4, outAtBoundary: 5, source: "#968" },
};

/**
 * **境が記録されていない 3 県**（**「測っていない」を「0 件」と混ぜない**。#757）。
 *
 * **3 県とも、止めているのは名簿ではなく「一次資料が読めるか」である**——
 * **境まで `--sessions` を伸ばしても `parseVotePdf` が先に落ちるので、
 * 境の氏名の集合そのものが取れていない。** **この PBI では測れない。**
 */
const UNMEASURED_BOUNDARIES: Readonly<Record<string, string>> = {
  // **三重**: 5 会期目（令和5年第1回）が境だが、**IN / OUT の内訳が記録されていない**。
  // **総量は「9 人」とだけ残っている**（`defaultSessionsFor` の鳥取の docblock）——
  // **下の「上限」の節で、その 9 だけから言えることを言う。**
  "pref-24": "境は隣（令和5年第1回）だが IN / OUT の内訳が記録されていない（総量 9 人のみ）",
  // **鳥取**: 12 会期目で `group heading rule … not found`。**読めるほうが先に尽きる。**
  "pref-31": "12 会期目が読めない（会派の見出しの罫線が無い）。境まで届いていない",
  // **島根**: 議員別採決結果 PDF を持つ 14 会期がすべて 2023-04 の一般選挙より後。**境が索引に無い**
  "pref-32": "議員別 PDF を持つ 14 会期がすべて選挙より後。境が一次資料に無い",
};

/* ==================== 1. `min` はいつ縮むのか（見立ての検証） ==================== */

/**
 * ## **佐賀の担当者の見立て**——**「定数が 1 でも減っている県は必ず非対称になる」**
 *
 * **非対称になること自体は正しい。** **だが「非対称だから縮む」ではない。**
 *
 * **`seatsChanged = min(rosterAbsent, unmatchedNames)` は、
 * `rosterAbsent` と `unmatchedNames` の**どちらも 0 でない限り、
 * 必ず総量 `rosterAbsent + unmatchedNames` より小さい。**
 * **`min(a, b) <= floor((a + b) / 2)` は a = b のときですら等号で、a = b でも半分である。**
 *
 * **つまり「対称なら縮まない」は成り立たない。** **青森が 11 のまま縮まなかったように見えたのは、
 * `seatsChanged` を IN + OUT と比べたのではなく OUT（15）と比べていたからである。**
 *
 * **本番の 119 会期で、`seatsChanged` が総量と一致した会期は 1 つも無い**（下のテスト）。
 *
 * ## ⚠ **このテストは `data/` の中身を主張していて、実装を主張していない**（**変異で確かめた**）
 *
 * **`meta.json` を読むだけなので、`sessionRosterCoverageOf` を `min` → `max` に変異させても落ちない**
 * （**書き出し済みの `data/` は変わらないため**）。**`data/assemblies/pref-41/meta.json` の
 * `seatsChanged` を 1 つ書き換えると落ちる**——**つまり見ているのは出荷しているデータである。**
 *
 * **実装が `min` であること自体は `local-session-roster-coverage.test.ts` が
 * `assert.equal(r.seatsChanged, Math.min(...))` で固定しており、
 * `meta.sessionRosterCoverage` が採決の原本と一致することも同じファイルが見ている。**
 * **ここで測りたいのは「出荷しているデータでこの性質が成り立っているか」なので、これでよい。**
 */
test("#986 seatsChanged <= floor((rosterAbsent + unmatchedNames) / 2)（本番 119 会期すべて）", async () => {
  const prefs = await localPrefs();
  assert.equal(prefs.length, 11, "11 議会ぶんを見ていること（母数。#757）");
  let checked = 0;
  let equalToHalf = 0;
  let strictlyUnderHalf = 0;
  const ratios = new Map<number, number>();
  for (const p of prefs) {
    for (const r of (await metaOf(p)).sessionRosterCoverage) {
      const churn = r.rosterAbsent + r.unmatchedNames;
      assert.ok(r.seatsChanged <= Math.floor(churn / 2), `${p} ${r.sessionId}: ${r.seatsChanged} > floor(${churn}/2)`);
      // **総量と一致することは無い**（**片方が 0 の会期も含めて**）
      assert.notEqual(r.seatsChanged, churn === 0 ? -1 : churn, `${p} ${r.sessionId}: seatsChanged が総量と一致した`);
      if (churn > 0) {
        if (r.seatsChanged === Math.floor(churn / 2)) equalToHalf++; else strictlyUnderHalf++;
        const k = Math.round((100 * r.seatsChanged) / churn) / 100;
        ratios.set(k, (ratios.get(k) ?? 0) + 1);
      }
      checked++;
    }
  }
  assert.equal(checked, 119, "見た会期の数（母数）");
  // **総量が 0 でない 77 会期のうち、ちょうど半分が 29 会期**（**残りはそれより小さい**）
  assert.equal(equalToHalf + strictlyUnderHalf, 77, "総量が 0 でない会期の数（母数）");
  assert.equal(119 - 77, 42, "総量が 0 の会期の数（母数の残り。#757）");
  assert.equal(Math.max(...[...ratios.keys()]), 0.5, "**`seatsChanged / 総量` の最大は 0.5**（1.0 は 1 会期も無い）");
});

/* ==================== 2. 11 県の境（測れた 8 県 ＋ 測れない 3 県） ==================== */

/**
 * **境の会期の `sessionRosterCoverage` を組み立てる。**
 *
 * **窓の中で最も古い会期（`data/` の実測）を起点に、docblock の IN / OUT を当てる:**
 *   - **`outAtBoundary` 人が境の会期には居ない**（**名簿に寄っていた側から抜ける**）
 *   - **`inAtBoundary` 人が境の会期に現れる**（**今の名簿に無い氏名として**）
 *
 * **⚠ これは仮定であって観測ではない**（**正直に書く**）——
 * **`out` の全員が名簿に寄っていたか、`in` の全員が名簿に無いかは、
 * 佐賀以外では一次資料で確かめていない**（佐賀の docblock だけが氏名を名指ししている）。
 * **仮定が外れたときに答えが変わるかは、下の「感度」のテストで幅として出す。**
 */
const boundaryCoverage = (pref: string, roster: number, oldest: LocalAssemblyMeta["sessionRosterCoverage"][number]) => {
  const b = BOUNDARIES[pref];
  const stays = oldest.rosterSeen - b.outAtBoundary;
  const gone = oldest.unmatchedNames + b.inAtBoundary;
  const members = Array.from({ length: roster }, (_, i) => ({ id: `m${i}` }));
  const votes = [
    ...members.slice(0, stays).map((m) => ({ memberId: m.id, nameText: `在 ${m.id}` })),
    ...Array.from({ length: gone }, (_, k) => ({ memberId: "", nameText: `退 ${k}` })),
  ];
  const rc = {
    id: "x", assemblyId: pref, sessionId: "boundary", sessionLabel: b.label, date: "2023-01-01",
    kind: "議案", number: "1", title: "x", result: "可決", page: 1, sourceUrl: "https://example.invalid/x.pdf",
    votes: votes.map((v) => ({ ...v, group: "会派", value: { raw: "○", legend: "賛成", mapped: "賛成" as const } })),
  } as unknown as Parameters<typeof sessionRosterCoverageOf>[0][number];
  return sessionRosterCoverageOf([rc], members)[0];
};

/**
 * ## **本丸**——**11 県のうち 2 県の境が線 10 を下回る**（**母数 11、測れた 8**）
 *
 * **「1 県だけ」でも「半分」でもない。**
 *
 * | 県 | 名簿 | `rosterAbsent` | `unmatchedNames` | 総量 | **`seatsChanged`** | 線 10 |
 * |---|---:|---:|---:|---:|---:|---|
 * | **宮城** (04) | 56 | 19 | 23 | 42 | **19** | 鳴る |
 * | **滋賀** (25) | 42 | 17 | 18 | 35 | **17** | 鳴る |
 * | **奈良** (29) | 40 | 17 | 17 | 34 | **17** | 鳴る |
 * | **青森** (02) | 46 | 18 | 16 | 34 | **16** | 鳴る |
 * | **徳島** (36) | 36 | 13 | 13 | 26 | **13** | 鳴る |
 * | **高知** (39) | 36 | 13 | 12 | 25 | **12** | 鳴る |
 * | **秋田** (05) | 41 | 9 | 11 | 20 | **9** | **鳴らない**（線の下 1） |
 * | **佐賀** (41) | 37 | 5 | 4 | 9 | **4** | **鳴らない**（線の下 6） |
 *
 * **佐賀は #968 の担当者の実測と 1 も違わない**（`rosterAbsent` 5 / `unmatchedNames` 4 / `seatsChanged` 4）
 * ——**この計算の当たりを確かめる 1 点として使える。**
 * **滋賀の 17 も、`local-session-roster-coverage.test.ts` の docblock が
 * 別の PBI（#973）で独立に書いた値と一致する。**
 */
test("#986 11 県の境: 測れた 8 県のうち 2 県（秋田・佐賀）が線 10 を下回る", async () => {
  const prefs = await localPrefs();
  assert.equal(prefs.length, 11, "母数（#757）");
  assert.equal(Object.keys(BOUNDARIES).length + Object.keys(UNMEASURED_BOUNDARIES).length, 11,
    "**測れた県と測れない県を足すと 11 になる**（**どちらにも入っていない県を作らない**）");
  const table: Record<string, { rosterAbsent: number; unmatchedNames: number; churn: number; seatsChanged: number; flagged: boolean }> = {};
  for (const p of Object.keys(BOUNDARIES)) {
    const m = await metaOf(p);
    const oldest = m.sessionRosterCoverage.at(-1)!;
    const c = boundaryCoverage(p, m.counts.members, oldest);
    table[p] = {
      rosterAbsent: c.rosterAbsent, unmatchedNames: c.unmatchedNames,
      churn: c.rosterAbsent + c.unmatchedNames, seatsChanged: c.seatsChanged,
      flagged: c.seatsChanged >= SEATS_CHANGED_FLAG,
    };
  }
  assert.deepEqual(table, {
    "pref-02": { rosterAbsent: 18, unmatchedNames: 16, churn: 34, seatsChanged: 16, flagged: true },
    "pref-04": { rosterAbsent: 19, unmatchedNames: 23, churn: 42, seatsChanged: 19, flagged: true },
    // **秋田**: **線の下 1**。**総量 20 の半分が 10 なので、`min` が 1 でも削れば落ちる**
    "pref-05": { rosterAbsent: 9, unmatchedNames: 11, churn: 20, seatsChanged: 9, flagged: false },
    "pref-25": { rosterAbsent: 17, unmatchedNames: 18, churn: 35, seatsChanged: 17, flagged: true },
    "pref-29": { rosterAbsent: 17, unmatchedNames: 17, churn: 34, seatsChanged: 17, flagged: true },
    "pref-36": { rosterAbsent: 13, unmatchedNames: 13, churn: 26, seatsChanged: 13, flagged: true },
    "pref-39": { rosterAbsent: 13, unmatchedNames: 12, churn: 25, seatsChanged: 12, flagged: true },
    // **佐賀**: **#968 の担当者の実測と一致**（**この計算の当たりを確かめる 1 点**）
    "pref-41": { rosterAbsent: 5, unmatchedNames: 4, churn: 9, seatsChanged: 4, flagged: false },
  });
  const missed = Object.entries(table).filter(([, v]) => !v.flagged).map(([p]) => p);
  assert.deepEqual(missed, ["pref-05", "pref-41"], "**線を下回る境**");
  assert.equal(missed.length, 2, "**2 県**");
  assert.equal(Object.keys(BOUNDARIES).length, 8, "**測れた境の数**（母数）");
  assert.equal(Object.keys(UNMEASURED_BOUNDARIES).length, 3, "**測れなかった県の数**（「0 件」と混ぜない。#757）");
});

/**
 * ## **仮定が外れても答えが変わらないことを確かめる**（**1 通りの組み立てで結論を出さない**）
 *
 * **上の組み立ては「`out` は全員名簿に寄っていた／`in` は全員名簿に無い」を仮定している。**
 * **その仮定を崩して、`out` のうち何人が名簿側だったか（k）と
 * `in` のうち何人が名簿に寄るか（j）を、あり得る組み合わせすべてに振る。**
 *
 * **秋田と佐賀は、どの組み合わせでも 10 に届かない**——**仮定のせいで落ちているのではない。**
 * **逆に、鳴った 6 県は「組み合わせ次第では鳴らない」**（k と j を極端に振れば 0 になる）
 * ——**だから 6 県の「鳴る」は上の仮定に依存している。正直にそう書く。**
 */
test("#986 感度: 秋田と佐賀は IN/OUT の分け方をどう振っても 10 に届かない", async () => {
  const span = async (p: string) => {
    const m = await metaOf(p);
    const a = m.sessionRosterCoverage.at(-1)!;
    const b = BOUNDARIES[p];
    const R = m.counts.members;
    const scs: number[] = [];
    for (let k = 0; k <= b.outAtBoundary; k++) {
      for (let j = 0; j <= b.inAtBoundary; j++) {
        const stays = a.rosterSeen - k + j;
        const gone = a.unmatchedNames - (b.outAtBoundary - k) + (b.inAtBoundary - j);
        if (gone < 0 || stays < 0 || stays > R) continue;
        scs.push(Math.min(R - stays, gone));
      }
    }
    assert.ok(scs.length > 0, `${p}: あり得る組み合わせが 0（検算が空回りする）`);
    return { combos: scs.length, max: Math.max(...scs) };
  };
  // **秋田**: **52 通りの組み合わせすべてで 9 以下**
  assert.deepEqual(await span("pref-05"), { combos: 52, max: 9 });
  // **佐賀**: **15 通りすべてで 4 以下**
  assert.deepEqual(await span("pref-41"), { combos: 15, max: 4 });
  for (const p of ["pref-05", "pref-41"]) {
    assert.ok((await span(p)).max < SEATS_CHANGED_FLAG, `${p}: どう振っても線に届かない`);
  }
});

/**
 * ## **三重は、内訳が無くても「鳴らない」と言える**（**総量 9 だけから**）
 *
 * **三重の境（5 会期目・令和5年第1回）は IN / OUT の内訳が記録されていないが、
 * 総量が 9 人であることは記録されている。**
 *
 * **`seatsChanged <= floor(総量 / 2)` なので、総量 9 では最大でも 4 である。**
 * **線 10 に掛かるには総量が 20 以上要る。** **だから三重は内訳を測らなくても鳴らない。**
 *
 * **⚠ ただし「総量 9」が境の会期自身の `rosterAbsent + unmatchedNames` である保証は無い**
 * （**docblock は氏名の集合の入れ替わりとして 9 と書いている**）。
 * **窓の中の最古の会期が既に `rosterAbsent` 4 / `unmatchedNames` 5 を持っているので、
 * 境ではそれより大きくなりうる。** **この節が言えるのは「入れ替わりが 9 人なら、
 * それだけでは線に届かない」ということだけで、三重の境が鳴らないことの証明ではない。**
 */
test("#986 線 10 に掛かるには入れ替わりの総量が 20 以上要る（三重の 9 では届かない）", async () => {
  const ceiling = (churn: number) => Math.max(...Array.from({ length: churn + 1 }, (_, a) => Math.min(a, churn - a)));
  assert.equal(ceiling(9), 4, "**三重の境の総量 9**（内訳が無くても上限は 4）");
  assert.equal(ceiling(19), 9, "総量 19 でも届かない");
  assert.equal(ceiling(20), 10, "**総量 20 が線 10 に届く最小**");
  // **本番の最大の総量は、書き写さずに `data/` から数える**（#986 の PO の誤りと同じ轍を踏まない）
  let maxChurn = 0;
  let where = "";
  let sessions = 0;
  for (const p of await localPrefs()) {
    for (const r of (await metaOf(p)).sessionRosterCoverage) {
      sessions++;
      const churn = r.rosterAbsent + r.unmatchedNames;
      if (churn > maxChurn) { maxChurn = churn; where = `${p} ${r.sessionId}`; }
    }
  }
  assert.equal(sessions, 119, "母数（#757）");
  assert.equal(maxChurn, 12, "**本番 11 県の最大の総量**");
  assert.equal(where, "pref-25 2023-11", "**どの会期か**（滋賀。母数 42 人）");
  // **その最大の総量ですら、線には届かない**——**本番が鳴らないのは境をまたいでいないからである**
  assert.ok(ceiling(maxChurn) < SEATS_CHANGED_FLAG, "本番の最大の総量でも線には届かない");
  assert.equal(ceiling(maxChurn), 6);
});

/* ==================== 3. `flagged: 0` が何を意味するか ==================== */

/**
 * ## **今の `flagged: 0` は「境が無い」ではない**（#986 の 5 番目の測定項目）
 *
 * **11 県とも `seatsChanged` の印が付いていないが、それは
 * **担当者が境の手前で `--sessions` を止めているから**であって、
 * **信号が境を検出して止めた実績は 1 件も無い。**
 *
 * **この区別を機械で言えるようにしておく**——
 * **「窓の中で最も古い会期の 1 つ向こうに、記録された境がある県が何県あるか」を数える。**
 * **8 県は境がすぐ隣にあり、印が付いていないのは「越えていない」からである。**
 */
test("#986 flagged 0 の意味: 8 県は境がすぐ隣にあり、越えていないから鳴っていない", async () => {
  const prefs = await localPrefs();
  let flagged = 0;
  let sessions = 0;
  for (const p of prefs) {
    for (const r of (await metaOf(p)).sessionRosterCoverage) {
      sessions++;
      if (r.seatsChanged >= SEATS_CHANGED_FLAG) flagged++;
    }
  }
  assert.equal(sessions, 119, "母数（#757）");
  assert.equal(flagged, 0, "印の付いた会期");
  // **その 0 の意味**: **8 県は境が隣にあり、そこを越えれば 6 県で鳴る**（上のテスト）
  assert.equal(Object.keys(BOUNDARIES).length, 8, "境が記録されている県");
  // **3 県は境そのものが取れていない**——**「鳴らなかった」とも「鳴る」とも言えない**
  assert.deepEqual(Object.keys(UNMEASURED_BOUNDARIES).sort(), ["pref-24", "pref-31", "pref-32"]);
});

/**
 * ## **docblock の IN / OUT の向きを、docblock 自身の氏名の数で検算する**
 *
 * **向きを取り違えると答えが裏返る**（**秋田は 9 ↔ 7 で、線の下 1 か下 3 かが変わる**）。
 * **氏名の数が書かれている 3 県では、引き算が合うことを機械で確かめる。**
 */
test("#986 docblock の氏名の数から IN/OUT の向きを検算する（3 県）", () => {
  const checked: string[] = [];
  for (const [p, b] of Object.entries(BOUNDARIES)) {
    if (b.namesNewer === undefined || b.namesOlder === undefined || b.shared === undefined) continue;
    // **新しい側にだけ居る氏名 = 境から見た OUT**、**古い側にだけ居る氏名 = 境から見た IN**
    assert.equal(b.namesNewer - b.shared, b.outAtBoundary, `${p}: 新しい側にだけ居る氏名の数`);
    assert.equal(b.namesOlder - b.shared, b.inAtBoundary, `${p}: 古い側にだけ居る氏名の数`);
    checked.push(p);
  }
  assert.deepEqual(checked.sort(), ["pref-02", "pref-05", "pref-36"], "氏名の数が docblock にある県（母数）");
});
