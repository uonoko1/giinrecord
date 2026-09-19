import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { LocalAssemblyMeta, LocalMember, LocalRollCall, LocalUnmatchedName } from "@seiji-kiroku/shared";
import { MIE_HOST } from "../src/sources/local/mie/site.ts";

/**
 * **本番 `data/assemblies/pref-24/` に出したものを、出した後から読み直して数える**（Issue #865）。
 *
 * **`votes-pdf.ts` のテストは PDF を読む側を見ている。ここは「書いたもの」を見る。**
 * **`data/` の JSON を読み直しているので、書き出し（`buildLocalAssembly` / `writeLocalAssembly`）が
 * 壊れたらここが落ちる。**
 *
 * **#864 の `published-data-validate.test.ts` とは重ならない**——あちらは**全県まとめて構造の不変条件**。
 * **ここは三重の中身**——**三重は 11 議会で一番採決が多い**（365 本 / 17,032 セル）。
 *
 * **母数を毎回出す**（#757）。
 */
const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));
const DIR = join(DATA, "assemblies", "pref-24");

const rollCalls = (): LocalRollCall[] => {
  const out: LocalRollCall[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name !== "index.json" && e.name.endsWith(".json")) out.push(JSON.parse(readFileSync(p, "utf-8")) as LocalRollCall);
    }
  };
  walk(join(DIR, "rollcalls"));
  return out;
};
const hasData = (() => { try { return statSync(join(DIR, "meta.json")).isFile(); } catch { return false; } })();
const meta = (): LocalAssemblyMeta => JSON.parse(readFileSync(join(DIR, "meta.json"), "utf-8")) as LocalAssemblyMeta;
const members = (): LocalMember[] =>
  (JSON.parse(readFileSync(join(DATA, "members", "index.json"), "utf-8")) as LocalMember[]).filter((m) => m.assemblyId === "pref-24");

test("#901 本番 pref-24: 採決 733 / セル 34,590 / 名簿 47 人（meta.json と実物が一致する）", { skip: !hasData }, () => {
  const m = meta();
  const rcs = rollCalls();
  // **実測 2026-09-20**（#901 で `--sessions` の既定を 2 → 4 にした）:
  //   令和8年定例会 110 + 令和7年定例会 255 + **令和6年定例会 222 + 令和5年第2回定例会 146**
  // **令和5年第1回（2023-03）から先は足していない**——**2023年4月の一般選挙の手前だからである**
  // （`defaultSessionsFor` の docblock に、会期ごとの氏名の入れ替わりを数えた表がある）。
  assert.equal(m.counts.rollcalls, 733);
  assert.equal(m.counts.members, 47);
  assert.equal(m.counts.cells, 34_590);
  // **`不明` 43 は令和6年10月の 下野幸助（10/10 に議員辞職）の列で、PDF が空欄にしている**
  // （**「棄権」でも「欠席」でもないので推定せずに残す**。#569）
  assert.equal(m.counts.unknownCells, 43, "**推定せず `不明` で残したセル**");
  assert.equal(m.counts.unmatchedNames, 6);
  assert.equal(rcs.length, m.counts.rollcalls, "rollcalls/ の実ファイル数");
  assert.equal(rcs.reduce((s, r) => s + r.votes.length, 0), m.counts.cells, "票の実数");
  // **宮城（133 × 56 の長方形）と違い、三重は長方形ではない**——
  // **1 年半ぶんあるので、その日に在職していた議員の数だけ列がある**（45〜48）。
  // **「全部同じ人数」を主張すると三重では偽になる。他県から写せない。**
  assert.deepEqual([...new Set(rcs.map((r) => r.votes.length))].sort(), [45, 46, 47, 48], "採決ごとの票数");
  assert.equal(m.sessions.reduce((s, x) => s + x.rollcalls, 0), 733, "会期ごとの本数の和");
  assert.deepEqual(m.sessions.map((s) => [s.sessionId, s.rollcalls]).sort(),
    [["r05-2", 146], ["r06", 222], ["r07", 255], ["r08", 110]]);
  // **最古の採決が一般選挙（2023年4月）より後であること**——**この 1 行が「任期をまたいでいない」の番人**
  const dates = rcs.map((r) => r.date).sort();
  assert.equal(dates[0], "2023-05-12", `最古の採決 ${dates[0]}`);
  assert.equal(dates[dates.length - 1], "2026-06-30", `最新の採決 ${dates[dates.length - 1]}`);
});

test("#901 本番 pref-24: 票 34,590 の内訳（○ 32180 / × 1057 / 議 733 / 欠 563 / 不明 43 / 除 8 / － 6）", { skip: !hasData }, () => {
  const votes = rollCalls().flatMap((r) => r.votes);
  assert.equal(votes.length, 34_590, "母数（減っていたら以下の内訳は意味が無い）");
  const raw = new Map<string, number>();
  const legend = new Map<string, number>();
  for (const v of votes) {
    raw.set(v.value.raw, (raw.get(v.value.raw) ?? 0) + 1);
    legend.set(v.value.legend, (legend.get(v.value.legend) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries([...raw].sort((a, b) => b[1] - a[1])),
    { "○": 32180, "×": 1057, "議": 733, "欠": 563, "不明": 43, "除": 8, "－": 6 });
  // **`欠席` `除斥` `不在` を畳まない**——**理由が違えば別の事実**（#569）
  assert.deepEqual(Object.fromEntries([...legend].sort((a, b) => b[1] - a[1])),
    { "賛成": 32180, "反対": 1057, "議長": 733, "欠席": 563, "抽出不能": 43, "除斥": 8, "不在": 6 });
  // **`不明` 43 は推定せずに残したセル**（#901 で会期を広げて初めて本番に出た）。
  // **`mapped` が付かないのはこの 43 だけで、「賛成でも反対でもない」ではなく「読めなかった」である。**
  assert.equal(raw.get("不明"), 43, "`不明` の票");
  assert.equal(legend.get("抽出不能"), 43, "`抽出不能` の票");
  assert.equal(votes.filter((v) => v.value.mapped === undefined).length, 43, "`mapped` の付かない票");
  assert.deepEqual([...new Set(votes.filter((v) => v.value.mapped === undefined).map((v) => v.value.raw))], ["不明"]);
  // **`投票なし` は 議 733 + 欠 563 + 除 8 + － 6 = 1,310**（**`不明` は含めない**）
  assert.equal(votes.filter((v) => v.value.mapped === "投票なし").length, 733 + 563 + 8 + 6);
});

/**
 * ## **`議` は 733 / 733 本で 1 人だが、「同じ 1 人」ではない**（三重の要点）
 *
 * **議決日ごとに見ると、議長は 4 人いる**——**三重は会議年度（5 月）で議長を選び直す。**
 * **佐賀（#768）や宮城は「2 会期とも同じ 1 人」なので、その主張を三重に写すと偽になる。**
 * **奈良は同じ PDF の中で 2 行だけ `議` が別人に移る**（`nara-published-data.test.ts`）。
 * **「議長は 1 人で不変」は県ごとに違う。共通の検査には書けない。**
 *
 * ## **#901 で会期を広げたので、外の事実との結び目が 3 本 → 4 本になった**
 *
 * **これがこの PR でいちばん強い検算である**——**増えた 368 本が「正しく」増えたことを、
 * 件数ではなく「誰が議長だったか」で確かめる。**
 * 一次資料: 三重県議会「歴代正副議長」 https://www.pref.mie.lg.jp/KENGIKAI/07681011814.htm
 *
 * | 代 | 議長 | 就任 | **この表に出る議決日** |
 * |---|---|---|---|
 * | **113代** | **中森 博文** | **令和05.05** | **2023-05-12 〜 2024-03-29**（**#901 で増えた範囲**） |
 * | 114代 | 稲垣 昭義 | 令和06.05 | 2024-05-16 〜 2025-03-31 |
 * | 115代 | 服部 富男 | 令和07.05 | 2025-05-16 〜 2026-03-31 |
 * | 116代 | 藤田 宜三 | 令和08.05 | 2026-05-19 〜 2026-06-30 |
 *
 * **交代はすべて 5 月で、表の就任年月と 1 日も食い違わない。**
 * **もし列が 1 つでもずれていれば、`議` の立つ列が別人になり、この表が落ちる**
 * （`mie-vote-alignment.test.ts` が、記号帯を 1 列回すと 733 / 733 行すべて落ちることを測っている）。
 *
 * **下の表は「37 議決日それぞれで、`議` が誰で、その日の列が何本か」**——
 * **列がずれれば `議` が別人に付き、日の途中で人数がぶれる。どちらもこの表が落ちる。**
 *
 * **ただし「議長は採決に加わらない」と決め打ちしない**——**実装は PDF の記号をそのまま読む。**
 */
test("#901 本番 pref-24: `議` は 733 本すべてで 1 人、議決日ごとの議長は 4 人（会議年度で交代）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  const perRollCall = new Map<number, number>();
  const byDate = new Map<string, { chairs: Set<string>; cells: Set<number>; n: number }>();
  for (const rc of rcs) {
    const gi = rc.votes.filter((v) => v.value.raw === "議");
    perRollCall.set(gi.length, (perRollCall.get(gi.length) ?? 0) + 1);
    for (const v of gi) {
      assert.equal(v.value.legend, "議長", rc.id);
      assert.equal(v.value.mapped, "投票なし", rc.id);
      assert.notEqual(v.memberId, "", `${rc.id}: \`議\` が名簿に寄っていない`);
    }
    const k = `${rc.sessionId}/${rc.date}`;
    const e = byDate.get(k) ?? { chairs: new Set<string>(), cells: new Set<number>(), n: 0 };
    for (const v of gi) e.chairs.add(v.nameText);
    e.cells.add(rc.votes.length);
    e.n++;
    byDate.set(k, e);
  }
  assert.deepEqual(Object.fromEntries(perRollCall), { 1: 733 }, "採決ごとの `議` の数（母数 733）");
  assert.deepEqual(
    Object.fromEntries([...byDate].sort().map(([k, v]) => [k, [v.n, [...v.chairs], [...v.cells]]])),
    {
      "r05-2/2023-05-12": [3, ["中森 博文"], [48]],
      "r05-2/2023-06-30": [16, ["中森 博文"], [48]],
      "r05-2/2023-09-26": [2, ["中森 博文"], [48]],
      "r05-2/2023-10-20": [36, ["中森 博文"], [48]],
      "r05-2/2023-10-24": [2, ["中森 博文"], [48]],
      "r05-2/2023-11-22": [12, ["中森 博文"], [48]],
      "r05-2/2023-11-30": [1, ["中森 博文"], [48]],
      "r05-2/2023-12-06": [2, ["中森 博文"], [48]],
      "r05-2/2023-12-21": [72, ["中森 博文"], [48]],
      "r06/2024-02-20": [1, ["中森 博文"], [48]],
      "r06/2024-02-29": [2, ["中森 博文"], [48]],
      "r06/2024-03-22": [92, ["中森 博文"], [48]],
      "r06/2024-03-29": [1, ["中森 博文"], [48]],
      "r06/2024-05-16": [1, ["稲垣 昭義"], [48]],
      "r06/2024-06-28": [28, ["稲垣 昭義"], [48]],
      "r06/2024-10-10": [1, ["稲垣 昭義"], [48]],
      "r06/2024-10-18": [43, ["稲垣 昭義"], [48]],
      "r06/2024-11-21": [12, ["稲垣 昭義"], [46]],
      "r06/2024-12-04": [2, ["稲垣 昭義"], [46]],
      "r06/2024-12-19": [39, ["稲垣 昭義"], [46]],
      "r07/2025-01-20": [1, ["稲垣 昭義"], [46]],
      "r07/2025-02-27": [3, ["稲垣 昭義"], [46]],
      "r07/2025-03-21": [102, ["稲垣 昭義"], [46]],
      "r07/2025-03-31": [1, ["稲垣 昭義"], [46]],
      "r07/2025-05-16": [1, ["服部 富男"], [45]],
      "r07/2025-06-30": [27, ["服部 富男"], [45]],
      "r07/2025-10-24": [40, ["服部 富男"], [48]],
      "r07/2025-11-25": [12, ["服部 富男"], [47]],
      "r07/2025-12-05": [2, ["服部 富男"], [47]],
      "r07/2025-12-22": [66, ["服部 富男"], [47]],
      "r08/2026-01-19": [1, ["服部 富男"], [47]],
      "r08/2026-02-27": [4, ["服部 富男"], [47]],
      "r08/2026-03-23": [81, ["服部 富男"], [47]],
      "r08/2026-03-31": [1, ["服部 富男"], [47]],
      "r08/2026-05-19": [1, ["藤田 宜三"], [47]],
      "r08/2026-06-12": [1, ["藤田 宜三"], [47]],
      "r08/2026-06-30": [21, ["藤田 宜三"], [47]],
    },
    "**議決日ごとの [採決の本数, `議` の氏名, その日の列数]**",
  );
  // **議決日は 37 日で、本数の和が 733**（表そのものが空回りしていないことの検算）
  assert.equal(byDate.size, 37);
  assert.equal([...byDate.values()].reduce((s, v) => s + v.n, 0), 733);
  // **議長は 4 人で、交代はすべて 5 月**（県の「歴代正副議長」と合う。**外の事実との結び目**）
  const order: string[] = [];
  for (const [k, v] of [...byDate].sort()) {
    const who = [...v.chairs][0];
    if (order[order.length - 1] !== who) { order.push(who); assert.match(k, /-0[56]-/, `${k}: 議長の交代が 5〜6 月でない`); }
  }
  assert.deepEqual(order, ["中森 博文", "稲垣 昭義", "服部 富男", "藤田 宜三"], "議長の並び（就任順）");
});

/**
 * **PDF 自身が印刷している集計（`counts`）と、抽出した票の意味が合う。**
 * **三重は 365 / 365 本すべてに `counts` がある**（奈良は 0 / 125 本）。
 * **11 議会で一番大きい突き合わせ**（17,032 セル中 16,415 が賛成か反対）。
 *
 * **これは「氏名の列が正しい」証明ではない**（数だけ。1 列ずらしても数は合う——#743 が実測）。
 * **順序の検算は `mie-vote-alignment.test.ts` が受け持つ。**
 */
test("#901 本番 pref-24: 賛成の数 = counts.yes / 反対の数 = counts.no（690 / 733 本。43 本は不明セルを含むので判定外）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  assert.equal(rcs.length, 733, "母数");
  let checked = 0;
  let skipped = 0;
  let cells = 0;
  for (const rc of rcs) {
    assert.ok(rc.counts, `${rc.id}: counts が無い`);
    // **不明セルのある行は判定外**（`不明` を 賛成 とも 反対 とも数えない。#569）
    if (rc.votes.some((v) => v.value.mapped === undefined)) { skipped++; continue; }
    assert.equal(rc.votes.filter((v) => v.value.mapped === "賛成").length, rc.counts!.yes, `${rc.id}: 賛成`);
    assert.equal(rc.votes.filter((v) => v.value.mapped === "反対").length, rc.counts!.no, `${rc.id}: 反対`);
    checked++;
    cells += rc.counts!.yes + rc.counts!.no;
  }
  assert.equal(checked, 690, "**突き合わせた採決の数**（0 件を「違反なし」と読み違えないため）");
  assert.equal(skipped, 43, "**不明セルを含むので判定外にした採決**");
  assert.equal(checked + skipped, 733, "母数の検算");
  // **判定した 690 本の 賛成+反対 の合計**（全 733 本の 32,180+1,057 = 33,237 ではない——
  // **判定外の 43 本のぶんが入らない。母数を取り違えない**。#757）
  assert.equal(cells, 31_263, "**突き合わせた賛否の合計**");
  assert.deepEqual(meta().countChecked, { rows: 733, checked: 690, noCounts: 0, unreadableCells: 43 });
  assert.equal(meta().countMismatches, undefined, "食い違いが無ければ省略される");
});

/**
 * ## **未突合 6 件**（`--sessions` を 2 → 4 にして 3 件 → 6 件に増えた。#901）
 *
 * **`unmatched` が増えるのは悪いことではない**——**「寄せられなかった」は安全側である**（#569）。
 * **悪いのは「寄せてはいけないものを寄せた」ほうで、それは数字には出ない。**
 * **票そのものは残っている**（`memberId` が空なだけ。#529）。
 *
 * | 氏名 | 理由 | 採決 | 出る会期 |
 * |---|---|---:|---|
 * | 平畑 武 | （記載なし＝名簿に無い） | 543 | r07 / r06 / r05-2 |
 * | 三谷 哲央 | （記載なし） | 503 | r07 / r06 / r05-2 |
 * | 小島 智子 | （記載なし） | 475 | r07 / r06 / r05-2 |
 * | **稲森 稔尚** | （記載なし） | **315** | **r06 / r05-2**（#901 で増えた） |
 * | **下野 幸助** | （記載なし） | **271** | **r06 / r05-2**（#901 で増えた） |
 * | **下野 幸助 ※１** | **`brokenGlyph`** | **44** | **r06**（#901 で増えた） |
 *
 * **`下野 幸助 ※１` は同じ人の別表記ではなく、別の `nameText` として落ちている**——
 * **PDF が `※１`（令和6年10月10日に議員辞職の注）を氏名の列に入れており、
 * `※` U+203B と `１` U+FF11 は名前になれる文字ではないので `brokenGlyph` になる**（#680）。
 * **「同じ人だ」と寄せ直さない**——**元の氏名を推定する側に回ることになる**（#569 / #674）。
 * **`下野 幸助`（271 本）と `下野 幸助 ※１`（44 本）が同一人物だとは、ここでは書かない。**
 *
 * **事実として言えるのはここまで**（#796。**氏名が近いだけで同一人物と書かない**）:
 *   - **6 人はいずれも令和7年定例会（r07）までにしか出ない**（r08 の 110 本には 1 票も無い）。
 *   - **名簿にいて採決が 733 本に満たない 4 人は、2025-10-24 から出る。**
 * **「誰が誰の後任か」は書かない**——**一次資料が言っているのは出欠の範囲だけである。**
 */
test("#901 本番 pref-24: 未突合 6 件（うち 1 件は brokenGlyph）と、途中から出る名簿の 4 人", { skip: !hasData }, () => {
  const um = JSON.parse(readFileSync(join(DIR, "unmatched.json"), "utf8")) as LocalUnmatchedName[];
  assert.deepEqual(
    um.map((u) => ({ name: u.nameText, reason: u.reason, group: u.group, rollCalls: u.rollCallIds.length }))
      .sort((a, b) => a.name.localeCompare(b.name, "ja")),
    [
      { name: "稲森 稔尚", reason: undefined, group: "草の根運動いが", rollCalls: 315 },
      { name: "下野 幸助", reason: undefined, group: "新政みえ", rollCalls: 271 },
      { name: "下野 幸助 ※１", reason: "brokenGlyph", group: "新政みえ", rollCalls: 44 },
      { name: "三谷 哲央", reason: undefined, group: "新政みえ", rollCalls: 503 },
      { name: "小島 智子", reason: undefined, group: "新政みえ", rollCalls: 475 },
      { name: "平畑 武", reason: undefined, group: "新政みえ", rollCalls: 543 },
    ].sort((a, b) => a.name.localeCompare(b.name, "ja")),
  );
  assert.equal(meta().counts.unmatchedNames, 6);
  // **会派見出しが崩れていないこと**（#901。**2 列に折り返した `草の根運動いが` が
  // `運草動のい根が` になっていた。`--sessions 2` の範囲には 1 件も無かったので誰も見ていなかった**）
  assert.deepEqual(um.map((u) => u.group).sort(),
    ["新政みえ", "新政みえ", "新政みえ", "新政みえ", "新政みえ", "草の根運動いが"].sort(),
    "**5 人が新政みえ（`下野 幸助` が 2 通りの nameText で 2 行）、1 人が草の根運動いが**");

  const rcs = rollCalls();
  const orphan = rcs.flatMap((r) => r.votes).filter((v) => v.memberId === "");
  assert.equal(orphan.length, 2151, "母数 34,590 のうち名簿に寄らなかった票（2,151 = 6.22%）");
  assert.equal(orphan.length, 543 + 503 + 475 + 315 + 271 + 44, "6 人の和");
  const byName = new Map<string, number>();
  for (const v of orphan) byName.set(v.nameText, (byName.get(v.nameText) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries([...byName].sort()),
    { "下野 幸助": 271, "下野 幸助 ※１": 44, "三谷 哲央": 503, "小島 智子": 475, "平畑 武": 543, "稲森 稔尚": 315 });
  // **寄らなくても票は読めている**（`不明` の 43 を除く。**「寄らない」と「読めない」は別の事実**）
  assert.equal(orphan.filter((v) => v.value.mapped === undefined).length, 43, "寄らず、かつ読めなかった票");
  // **6 人はいずれも r08 には出ない**
  assert.deepEqual([...new Set(rcs.filter((r) => r.votes.some((v) => v.memberId === "")).map((r) => r.sessionId))].sort(),
    ["r05-2", "r06", "r07"]);

  // **名簿側**: 47 人中 43 人が 733 本、4 人が 230 本
  const ms = members();
  assert.equal(ms.length, 47);
  assert.deepEqual(
    Object.fromEntries([...ms.reduce((m2, m) => m2.set(m.counts?.rollcalls ?? -1, (m2.get(m.counts?.rollcalls ?? -1) ?? 0) + 1), new Map<number, number>())].sort()),
    { 230: 4, 733: 43 },
    "名簿の議員ごとの採決数",
  );
  const partial = ms.filter((m) => m.counts?.rollcalls === 230).map((m) => m.name).sort((a, b) => a.localeCompare(b, "ja"));
  assert.deepEqual(partial, ["市川 岳人", "市野 修平", "曽我 正彦", "難波 聖子"]);
  // **その 4 人の初出は 2025-10-24**（**会期を広げても変わらない**——
  // **広げて増えたのは 2023〜2024 年ぶんなので、この 4 人の初出より前である**）
  const partialIds = new Set(ms.filter((m) => m.counts?.rollcalls === 230).map((m) => m.id));
  const dates = new Set(rcs.filter((r) => r.votes.some((v) => partialIds.has(v.memberId))).map((r) => r.date));
  assert.equal([...dates].sort()[0], "2025-10-24", "4 人が最初に出る議決日");
});

/** **出典はすべて県の公式ホスト**（**採決 733 本 + meta の 44 出典 + 会期 4 本 ＝ 見た URL を数える**）。 */
test("#901 本番 pref-24: sourceUrl はすべて www.pref.mie.lg.jp（PDF は 26 本）", { skip: !hasData }, () => {
  const m = meta();
  const rcs = rollCalls();
  const urls: string[] = [];
  for (const rc of rcs) urls.push(rc.sourceUrl);
  for (const s of m.sources) urls.push(s.url);
  for (const s of m.sessions) { urls.push(s.sourceUrl); urls.push(s.pdfUrl); for (const p of s.pdfUrls ?? []) urls.push(p); }
  // **採決 733 + meta.sources 44 + 会期 4 本ぶんの (sourceUrl + pdfUrl + pdfUrls)**
  assert.equal(urls.length, 733 + 44 + (1 + 1 + 5) + (1 + 1 + 8) + (1 + 1 + 7) + (1 + 1 + 6),
    "**見た URL の本数**（0 本を「違反なし」と読み違えないため）");
  const bad = urls.filter((u) => new URL(u).host !== MIE_HOST || new URL(u).protocol !== "https:");
  assert.deepEqual([...new Set(bad)], []);
  // **採決の出典は 13 本の PDF**（三重は 1 会期が複数の PDF に分かれる。佐賀・宮城は会期 1 本）
  // **採決の出典は 26 本の PDF**（三重は 1 会期が複数の PDF に分かれる。佐賀・宮城は会期 1 本）。
  // **`--sessions` を 2 → 4 にして 13 → 26 本になった**（令和6年 7 本 + 令和5年第2回 6 本）。
  // **151 本の index のうち「取りに行った」のがこの 26 本である**（読めないから飛ばしたのではない。#901）。
  const pdfs = [...new Set(rcs.map((r) => r.sourceUrl))];
  assert.equal(pdfs.length, 26, `採決が指す PDF（${pdfs.length} 本）`);
  assert.deepEqual(pdfs.filter((u) => !u.endsWith(".pdf")), [], "PDF でない出典");
  assert.deepEqual(m.sessions.map((s) => s.pdfUrls?.length).sort((a, b) => (a ?? 0) - (b ?? 0)), [5, 6, 7, 8], "会期ごとの PDF の本数");
  assert.equal(m.sources.filter((s) => s.url.endsWith(".pdf")).length, 26, "meta の出典の PDF");
  assert.equal(m.unreadableSources, undefined, "読めなかった一次資料は無い（省略される）");
  assert.equal(m.lossyNameMatches, undefined, "字が落ちた氏名の寄せは無い（省略される）");
  assert.equal(m.rosterAsOf, "2025-11-18");
});

/** **名簿 47 人**——**かな・選挙区・会派が全員にある**（#632 の検算が効く議会）。 */
test("#865 本番 pref-24: 名簿 47 人（かな・選挙区・会派が全員にある）", { skip: !hasData }, () => {
  const ms = members();
  assert.equal(ms.length, 47, "母数");
  assert.deepEqual(ms.filter((m) => m.kana === "").map((m) => m.name), [], "かなが空の議員");
  assert.deepEqual(ms.filter((m) => m.district === "").map((m) => m.name), [], "選挙区が空の議員");
  assert.deepEqual(ms.filter((m) => m.group === "").map((m) => m.name), [], "会派が空の議員");
  assert.deepEqual(ms.filter((m) => (m.counts?.rollcalls ?? 0) === 0).map((m) => m.name), [], "採決 0 件の議員");
  assert.deepEqual(ms.filter((m) => !m.profileUrl.startsWith(`https://${MIE_HOST}/`)).map((m) => m.name), [], "別ホストの profileUrl");
  assert.equal(new Set(ms.map((m) => m.id)).size, 47, "id の重複");
  const seen = new Set(rollCalls().flatMap((r) => r.votes.map((v) => v.memberId)));
  seen.delete("");
  assert.equal(seen.size, 47, `票に出る議員（${seen.size} 人）`);
});
