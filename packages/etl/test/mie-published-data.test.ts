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

test("#865 本番 pref-24: 採決 365 / セル 17,032 / 名簿 47 人（meta.json と実物が一致する）", { skip: !hasData }, () => {
  const m = meta();
  const rcs = rollCalls();
  // **実測 2026-09-14**（令和7年定例会 255 本 + 令和8年定例会 110 本）
  assert.equal(m.counts.rollcalls, 365);
  assert.equal(m.counts.members, 47);
  assert.equal(m.counts.cells, 17_032);
  assert.equal(m.counts.unknownCells, 0, "**推定せず `不明` で残したセルは 0**");
  assert.equal(m.counts.unmatchedNames, 3);
  assert.equal(rcs.length, m.counts.rollcalls, "rollcalls/ の実ファイル数");
  assert.equal(rcs.reduce((s, r) => s + r.votes.length, 0), m.counts.cells, "票の実数");
  // **宮城（133 × 56 の長方形）と違い、三重は長方形ではない**——
  // **1 年半ぶんあるので、その日に在職していた議員の数だけ列がある**（45〜48）。
  // **「全部同じ人数」を主張すると三重では偽になる。他県から写せない。**
  assert.deepEqual([...new Set(rcs.map((r) => r.votes.length))].sort(), [45, 46, 47, 48], "採決ごとの票数");
  assert.equal(m.sessions.reduce((s, x) => s + x.rollcalls, 0), 365, "会期ごとの本数の和");
  assert.deepEqual(m.sessions.map((s) => [s.sessionId, s.rollcalls]).sort(), [["r07", 255], ["r08", 110]]);
});

test("#865 本番 pref-24: 票 17,032 の内訳（○ 16018 / × 397 / 議 365 / 欠 246 / 除 4 / － 2）", { skip: !hasData }, () => {
  const votes = rollCalls().flatMap((r) => r.votes);
  assert.equal(votes.length, 17_032, "母数（減っていたら以下の内訳は意味が無い）");
  const raw = new Map<string, number>();
  const legend = new Map<string, number>();
  for (const v of votes) {
    raw.set(v.value.raw, (raw.get(v.value.raw) ?? 0) + 1);
    legend.set(v.value.legend, (legend.get(v.value.legend) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries([...raw].sort((a, b) => b[1] - a[1])),
    { "○": 16018, "×": 397, "議": 365, "欠": 246, "除": 4, "－": 2 });
  // **`欠席` `除斥` `不在` を畳まない**——**理由が違えば別の事実**（#569）
  assert.deepEqual(Object.fromEntries([...legend].sort((a, b) => b[1] - a[1])),
    { "賛成": 16018, "反対": 397, "議長": 365, "欠席": 246, "除斥": 4, "不在": 2 });
  assert.equal(raw.get("不明"), undefined, "`不明` の票");
  assert.equal(legend.get("抽出不能"), undefined, "`抽出不能` の票");
  assert.deepEqual(votes.filter((v) => v.value.mapped === undefined), [], "`mapped` の付かない票");
  // **`投票なし` は 議 365 + 欠 246 + 除 4 + － 2 = 617**
  assert.equal(votes.filter((v) => v.value.mapped === "投票なし").length, 365 + 246 + 4 + 2);
});

/**
 * ## **`議` は 365 / 365 本で 1 人だが、「同じ 1 人」ではない**（三重の要点）
 *
 * **議決日ごとに見ると、議長は 3 人いる**——**三重は会議年度（5 月）で議長を選び直す。**
 * **佐賀（#768）や宮城は「2 会期とも同じ 1 人」なので、その主張を三重に写すと偽になる。**
 * **奈良は同じ PDF の中で 2 行だけ `議` が別人に移る**（`nara-published-data.test.ts`）。
 * **「議長は 1 人で不変」は県ごとに違う。共通の検査には書けない。**
 *
 * **下の表は「17 議決日それぞれで、`議` が誰で、その日の列が何本か」**——
 * **列がずれれば `議` が別人に付き、日の途中で人数がぶれる。どちらもこの表が落ちる。**
 *
 * **ただし「議長は採決に加わらない」と決め打ちしない**——**実装は PDF の記号をそのまま読む。**
 */
test("#865 本番 pref-24: `議` は 365 本すべてで 1 人、議決日ごとの議長は 3 人（会議年度で交代）", { skip: !hasData }, () => {
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
  assert.deepEqual(Object.fromEntries(perRollCall), { 1: 365 }, "採決ごとの `議` の数（母数 365）");
  assert.deepEqual(
    Object.fromEntries([...byDate].sort().map(([k, v]) => [k, [v.n, [...v.chairs], [...v.cells]]])),
    {
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
  // **議決日は 17 日で、本数の和が 365**（表そのものが空回りしていないことの検算）
  assert.equal(byDate.size, 17);
  assert.equal([...byDate.values()].reduce((s, v) => s + v.n, 0), 365);
});

/**
 * **PDF 自身が印刷している集計（`counts`）と、抽出した票の意味が合う。**
 * **三重は 365 / 365 本すべてに `counts` がある**（奈良は 0 / 125 本）。
 * **11 議会で一番大きい突き合わせ**（17,032 セル中 16,415 が賛成か反対）。
 *
 * **これは「氏名の列が正しい」証明ではない**（数だけ。1 列ずらしても数は合う——#743 が実測）。
 * **順序の検算は `mie-vote-alignment.test.ts` が受け持つ。**
 */
test("#865 本番 pref-24: 賛成の数 = counts.yes / 反対の数 = counts.no（365 / 365 本）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  assert.equal(rcs.length, 365, "母数");
  let checked = 0;
  let cells = 0;
  for (const rc of rcs) {
    assert.ok(rc.counts, `${rc.id}: counts が無い`);
    assert.equal(rc.votes.filter((v) => v.value.mapped === "賛成").length, rc.counts!.yes, `${rc.id}: 賛成`);
    assert.equal(rc.votes.filter((v) => v.value.mapped === "反対").length, rc.counts!.no, `${rc.id}: 反対`);
    checked++;
    cells += rc.counts!.yes + rc.counts!.no;
  }
  assert.equal(checked, 365, "**突き合わせた採決の数**（0 件を「違反なし」と読み違えないため）");
  assert.equal(cells, 16_018 + 397, "**突き合わせた賛否の合計**");
  assert.deepEqual(meta().countChecked, { rows: 365, checked: 365, noCounts: 0, unreadableCells: 0 });
  assert.equal(meta().countMismatches, undefined, "食い違いが無ければ省略される");
});

/**
 * ## **未突合 3 件はいずれも理由の記載なし（＝名簿に無い氏名）**
 *
 * **`sourceConflict` でも `brokenGlyph` でもない**——**名簿（`rosterAsOf` 2025-11-18）に無い氏名。**
 * **理由が違えば運用者が次にすることも違う**（#680／#711）。
 *
 * **事実として言えるのはここまで**（#796。**氏名が近いだけで同一人物と書かない**）:
 *   - **3 人はいずれも令和7年定例会（r07）の途中までにしか出ない。**
 *   - **名簿にいて採決が 365 本に満たない 4 人は、2025-10-24 から出る。**
 * **「誰が誰の後任か」は書かない**——**一次資料が言っているのは出欠の範囲だけである。**
 *
 * **票そのものは残っている**（`memberId` が空なだけ）。
 */
test("#865 本番 pref-24: 未突合 3 件（理由の記載なし）と、途中から出る名簿の 4 人", { skip: !hasData }, () => {
  const um = JSON.parse(readFileSync(join(DIR, "unmatched.json"), "utf-8")) as LocalUnmatchedName[];
  assert.deepEqual(
    um.map((u) => ({ name: u.nameText, reason: u.reason, group: u.group, rollCalls: u.rollCallIds.length }))
      .sort((a, b) => a.name.localeCompare(b.name, "ja")),
    [
      { name: "三谷 哲央", reason: undefined, group: "新政みえ", rollCalls: 135 },
      { name: "小島 智子", reason: undefined, group: "新政みえ", rollCalls: 107 },
      { name: "平畑 武", reason: undefined, group: "新政みえ", rollCalls: 175 },
    ],
  );
  assert.equal(meta().counts.unmatchedNames, 3);

  const rcs = rollCalls();
  const orphan = rcs.flatMap((r) => r.votes).filter((v) => v.memberId === "");
  assert.equal(orphan.length, 135 + 107 + 175, "母数 17,032 のうち名簿に寄らなかった票（417 = 2.45%）");
  const byName = new Map<string, number>();
  for (const v of orphan) byName.set(v.nameText, (byName.get(v.nameText) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries([...byName].sort()), { "三谷 哲央": 135, "小島 智子": 107, "平畑 武": 175 });
  assert.deepEqual(orphan.filter((v) => v.value.mapped === undefined), [], "寄らなくても票は読めている");
  // **3 人はいずれも r07 にしか出ない**（r08 の 110 本には 1 票も無い）
  assert.deepEqual([...new Set(rcs.filter((r) => r.votes.some((v) => v.memberId === "")).map((r) => r.sessionId))], ["r07"]);

  // **名簿側**: 47 人中 43 人が 365 本、4 人が 230 本
  const ms = members();
  assert.equal(ms.length, 47);
  assert.deepEqual(
    Object.fromEntries([...ms.reduce((m2, m) => m2.set(m.counts?.rollcalls ?? -1, (m2.get(m.counts?.rollcalls ?? -1) ?? 0) + 1), new Map<number, number>())].sort()),
    { 230: 4, 365: 43 },
    "名簿の議員ごとの採決数",
  );
  const partial = ms.filter((m) => m.counts?.rollcalls === 230).map((m) => m.name).sort((a, b) => a.localeCompare(b, "ja"));
  assert.deepEqual(partial, ["市川 岳人", "市野 修平", "曽我 正彦", "難波 聖子"]);
  // **その 4 人の初出は 2025-10-24**（それ以前の 134 本には 1 票も無い）
  const partialIds = new Set(ms.filter((m) => m.counts?.rollcalls === 230).map((m) => m.id));
  const dates = new Set(rcs.filter((r) => r.votes.some((v) => partialIds.has(v.memberId))).map((r) => r.date));
  assert.equal([...dates].sort()[0], "2025-10-24", "4 人が最初に出る議決日");
});

/** **出典はすべて県の公式ホスト**（**採決 365 本 + meta の 31 出典 + 会期 2 本 ＝ 見た URL を数える**）。 */
test("#865 本番 pref-24: sourceUrl はすべて www.pref.mie.lg.jp（PDF は 13 本）", { skip: !hasData }, () => {
  const m = meta();
  const rcs = rollCalls();
  const urls: string[] = [];
  for (const rc of rcs) urls.push(rc.sourceUrl);
  for (const s of m.sources) urls.push(s.url);
  for (const s of m.sessions) { urls.push(s.sourceUrl); urls.push(s.pdfUrl); for (const p of s.pdfUrls ?? []) urls.push(p); }
  assert.equal(urls.length, 365 + 31 + (1 + 1 + 5) + (1 + 1 + 8), "**見た URL の本数**（0 本を「違反なし」と読み違えないため）");
  const bad = urls.filter((u) => new URL(u).host !== MIE_HOST || new URL(u).protocol !== "https:");
  assert.deepEqual([...new Set(bad)], []);
  // **採決の出典は 13 本の PDF**（三重は 1 会期が複数の PDF に分かれる。佐賀・宮城は会期 1 本）
  const pdfs = [...new Set(rcs.map((r) => r.sourceUrl))];
  assert.equal(pdfs.length, 13, `採決が指す PDF（${pdfs.length} 本）`);
  assert.deepEqual(pdfs.filter((u) => !u.endsWith(".pdf")), [], "PDF でない出典");
  assert.deepEqual(m.sessions.map((s) => s.pdfUrls?.length).sort(), [5, 8], "会期ごとの PDF の本数");
  assert.equal(m.sources.filter((s) => s.url.endsWith(".pdf")).length, 13, "meta の出典の PDF");
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
