import { test } from "node:test";
import assert from "node:assert/strict";
import { LOCAL_SOURCES, defaultSessionsFor, DEFAULT_LOCAL_SESSIONS } from "../src/local-assemblies.ts";

/**
 * # 議会ごとの `--sessions` の既定（Issue #901）
 *
 * ## 何が問題だったか
 *
 * **`local-cli.ts` の既定は全議会一律の `--sessions 2` で、月次ワークフローは `--sessions` を渡さない。**
 * **その結果、本番に出ているのは一次資料のごく一部だった**（三重は index の賛否 PDF 151 本のうち
 * **読めるのが 84 本、出ているのは 13 本ぶん（365 件）だけ**）。
 *
 * **「広げてよいか」ではなく「広げたとき何が起きるかを測ったか」が問われている**（#901）。
 *
 * ## **なぜ議会ごとに違う値なのか**——**一律に広げてはいけない**
 *
 * **地方の名簿は「今の名簿」1 枚しか公表されていない**（`LocalMemberTerm` は `asOf` しか持たない）。
 * **一般選挙をまたいだ採決にその名簿を当てると、引退した議員の票が今の別人に付きうる**
 * ——**利用者から検出できない虚偽である**（#569 の重いほう。#928 の検査も捕まえない）。
 *
 * **だから既定は「その議会で、今の任期に収まる会期の数」でなければならない。**
 * **任期の境は議会ごとに違うので、1 つの数では書けない。**
 *
 * ## **三重を 4 にした根拠**（2026-09-20、index の賛否 PDF 151 本すべてを取得して実測）
 *
 * **会期ごとに「PDF に出る氏名の集合」を数えると、一般選挙の年に 9 人が入れ替わる**
 * （`.measure/901/term-boundary.ts`。**選挙の日付を外から持ち込まず、一次資料だけで境を見た**）:
 *
 * | 会期 | 氏名 | 直前と共通 | **入れ替わり** | 採決の期間 |
 * |---|---:|---:|---:|---|
 * | r06 | 49 | 46 | 3 | 2024-02-20〜2024-11-21 |
 * | **r05-2** | 48 | 48 | **0** | **2023-05-12〜2023-12-21** |
 * | **r05-1** | 49 | 40 | **9** | **2023-03-02〜2023-03-17** |
 *
 * **同じ形の 9 人の入れ替わりが h31（2019-03）と h27-1（2015-03）にもある**——**4 年ごと。**
 * **r05-2 から r08 までは入れ替わりが 0〜3 人で、これは任期中の辞職・補選の規模である。**
 *
 * **だから `--sessions 4`（r08 / r07 / r06 / r05-2）が、今の任期に収まる最大である。**
 * **`--sessions 5` は r05-1 を足し、一般選挙をまたぐ。**
 *
 * ## **広げて何が増えたか**（母数つき。#757）
 *
 * | | `--sessions 2` | **`--sessions 4`** |
 * |---|---:|---:|
 * | 採決 | 365 | **733** |
 * | セル | 17,032 | **34,590** |
 * | 不明セル（推定せず残した） | 0 | **43** |
 * | **寄らなかった氏名**（安全側） | 3 | **6** |
 * | **寄らなかった票** | 417 | **2,151** |
 * | `rosterAsOf` からの最大の隔たり | 302 日 | **921 日**（上限 1,461） |
 *
 * **名簿の 47 人は、4 会期すべてに 1 人残らず現れる**（この範囲に「名簿にいるのに票が無い」人はいない）。
 * **寄らなかった 6 人はいずれも辞職・引退した議員で、票は `memberId` 空のまま残る**（#529）。
 */

test("#901 既定は議会ごとに持つ（全議会一律の 1 つの数にしない）", () => {
  // **母数**: 11 議会すべてに既定がある（新しい議会を足して書き忘れたら落ちる）
  const names = Object.keys(LOCAL_SOURCES).sort();
  assert.equal(names.length, 11, `議会 ${names.length}`);
  for (const n of names) {
    const v = defaultSessionsFor(n);
    assert.ok(Number.isInteger(v) && v >= 1, `${n}: 既定 ${v} が 1 以上の整数でない`);
  }
});

test("#901 三重だけ 4、他の 10 議会は 2 のまま（この PR で測ったのは三重だけ）", () => {
  assert.equal(defaultSessionsFor("mie"), 4, "三重は令和5年第2回定例会まで（2023年4月の一般選挙の後）");
  const others = Object.keys(LOCAL_SOURCES).filter((n) => n !== "mie");
  assert.equal(others.length, 10, `三重以外 ${others.length}`);
  assert.deepEqual(
    others.filter((n) => defaultSessionsFor(n) !== DEFAULT_LOCAL_SESSIONS),
    [],
    "**測っていない議会を巻き込んで広げない**（#901 は 1 県ずつ）",
  );
  assert.equal(DEFAULT_LOCAL_SESSIONS, 2, "これまでの一律の既定");
});

test("#901 知らない議会の名前には既定の 2 を返す（CLI が落ちる前にここで壊れない）", () => {
  assert.equal(defaultSessionsFor("no-such-assembly"), DEFAULT_LOCAL_SESSIONS);
  assert.equal(defaultSessionsFor(""), DEFAULT_LOCAL_SESSIONS);
});
