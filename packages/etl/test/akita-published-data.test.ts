import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { LocalAssemblyMeta, LocalMember, LocalRollCall } from "@seiji-kiroku/shared";
import { AKITA_HOST } from "../src/sources/local/akita/site.ts";

/**
 * **本番 `data/assemblies/pref-05/` に出したものを、出した後から読み直して数える**（Issue #759）。
 *
 * **`votes-pdf.ts` のテストは PDF を読む側を見ている。ここは「書いたもの」を見る。**
 * **同じ実装で 2 回測っているのではない**——**`data/` の JSON を読み直しているので、
 * 書き出し（`buildLocalAssembly` / `writeLocalAssembly`）が壊れたらここが落ちる。**
 */
const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));
const DIR = join(DATA, "assemblies", "pref-05");

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

test("#759 本番 pref-05: 採決・セル・不明セルの数（meta.json と実物が一致する）", { skip: !hasData }, () => {
  const meta = JSON.parse(readFileSync(join(DIR, "meta.json"), "utf-8")) as LocalAssemblyMeta;
  const rcs = rollCalls();
  // **実測 2026-09-20**（**`--sessions 29`。#901 で 5 本 → 29 本に広げた**。前は 157 / 6,437）
  assert.equal(meta.counts.rollcalls, 785);
  assert.equal(meta.counts.members, 41);
  assert.equal(meta.counts.cells, 32_022);
  // **本番に出るデータのうち `抽出不能` が何％か**——**0.00%**（滋賀は 27%、青森は 0%）。
  // **広げても 1 セルも増えていない**（154 / 154 本すべてが読める。#901）
  assert.equal(meta.counts.unknownCells, 0, "**推定せず残した不明セルは 0**");
  // **寄らなかった氏名は 0 → 2**（**安全側**。#901）——
  // **`沼谷 純`（2025-04-30 まで）と `鈴木 健太`（2024-11-01 まで）で、どちらも任期の途中で退いた議員。**
  // **票は `memberId` 空のまま残す**（#529。**推定して今の誰かに当てない**。#569）
  assert.equal(meta.counts.unmatchedNames, 2, "**名簿に寄らなかった氏名**（退いた議員 2 人）");
  // **meta の数が、書いた実物と一致する**（meta だけを書き換えても落ちる）
  assert.equal(rcs.length, meta.counts.rollcalls, "rollcalls/ の実ファイル数");
  assert.equal(rcs.reduce((s, r) => s + r.votes.length, 0), meta.counts.cells, "票の実数");
  assert.equal(rcs.reduce((s, r) => s + r.votes.filter((v) => v.value.legend === "抽出不能").length, 0), 0, "`抽出不能` の票");
  // ## **母数**（#757）: **1 採決あたりの票数は 41 か 40 の 2 通りだけ**（**欠けた行が無い**）
  //
  // **40 票の 163 件は、議員が 40 人だった 3 本会議日**（2024-12-20 / 2025-02-17 / 2025-03-06）。
  // **`鈴木 健太` が 2024-11-01 までで退き、`川邉 隼之介` と `福田 博之` が 2025-04-30 から入る**
  // ——**その間の 3 日だけ欠員 1 で、PDF の列も 40 列である**（実測。#901）。
  // **`41 × 785 = 32,185` にならないのは、この 163 件ぶん**（32,185 − 163 = 32,022）。
  const perRow = new Map<number, number>();
  for (const r of rcs) perRow.set(r.votes.length, (perRow.get(r.votes.length) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries([...perRow].sort((a, b) => b[0] - a[0])), { 41: 622, 40: 163 }, "1 採決あたりの票数");
  assert.equal(622 * 41 + 163 * 40, meta.counts.cells, "セルの検算");
});

/**
 * ## **`議` は全採決で 1 人**（#748 の罠を回避した証拠）
 *
 * **「議長は 1 人」は当たり前に見えるが、当たり前ではない**——
 * **左端の stray な `議` を拾うと、その行に `議` が 2 人立つ**（#753 は 154 本で 5,298 個を数えた）。
 * **青森（#748）は 55 本中 2 本で会期の途中に議長が交代し、`議` が 2 つの列に立った。**
 * **秋田は 154 / 154 本で 1 本 1 人である**（#753）。
 *
 * **ただし「議長は採決に加わらない」と決め打ちしない**——
 * **#615 が「26 行中 1 行だけ議長も `○` だった」（表決者数が 1 人多い）を実測している。**
 */
test("#759 本番 pref-05: `議` は全採決で 1 人（同じ 1 列にだけ立つ）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  const perRollCall = new Map<number, number>();
  const memberIds = new Set<string>();
  for (const rc of rcs) {
    const gi = rc.votes.filter((v) => v.value.raw === "議");
    perRollCall.set(gi.length, (perRollCall.get(gi.length) ?? 0) + 1);
    for (const v of gi) memberIds.add(v.memberId);
    assert.ok(gi.length <= 1, `${rc.id}: \`議\` が ${gi.length} 人`);
  }
  // **784 / 785 の採決で `議` が 1 人、1 つだけ 0 人**（**議長が投票した行**。#615 が実測）
  assert.deepEqual(Object.fromEntries(perRollCall), { 1: 784, 0: 1 }, "採決ごとの `議` の数");
  // ## **`議` が付く議員は 2 人**（#901 で 1 人 → 2 人）——**列がずれたのではなく、議長が交代した**
  //
  // **`--sessions 5` の範囲（2026-02-27〜2026-07-03）には議長が 1 人しかいなかった。**
  // **29 本に広げると 2023-05-16 まで遡るので、2025-05-14 の交代が範囲に入る。**
  //
  // **この 2 人が県の公表と合うことは `akita-vote-alignment.test.ts` の検算A が見ている**
  // （**歴代正副議長一覧: 69代 北林丈正 令5.5.15〜令7.5.14 / 70代 工藤嘉範 令7.5.14〜**）。
  // **ここでは「3 人以上になっていない」ことだけを固定する**——
  // **列が 1 つでもずれれば、隣の議員にも `議` が付いて 3 人以上になる。**
  assert.equal(memberIds.size, 2, `\`議\` が付く議員（${[...memberIds]}）`);
  assert.ok(![...memberIds].includes(""), "`議` の議員が名簿に寄っている");
  // **交代は 1 回だけ**——**日付順に並べて、議長が変わる日が 1 日しかない**
  const byDate = new Map<string, Set<string>>();
  for (const rc of rcs) for (const v of rc.votes.filter((v) => v.value.raw === "議")) {
    if (!byDate.has(rc.date)) byDate.set(rc.date, new Set());
    byDate.get(rc.date)!.add(v.memberId);
  }
  for (const [d, s] of byDate) assert.equal(s.size, 1, `${d}: 同じ日に \`議\` が ${s.size} 人`);
  const seq = [...byDate].sort().map(([, s]) => [...s][0]);
  const changes = seq.filter((v, i) => i > 0 && v !== seq[i - 1]).length;
  assert.equal(changes, 1, `議長が変わった日（${changes} 回）`);
});

/**
 * **未突合は 0 → 2**（#901 で `--sessions` を 5 → 29 に広げた）。
 *
 * **`unmatched` が増えるのは安全側である**——**「寄せられなかった」であって、
 * 「寄せてはいけないものを寄せた」ではない**（#901）。
 * **名簿に同じ氏名が 1 人も居ないので、「同姓同名の別人」以前の問題である。**
 */
test("#759 本番 pref-05: 未突合は退いた議員 2 人だけ（他は全部 memberId がある）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  const unmatched = JSON.parse(readFileSync(join(DIR, "unmatched.json"), "utf-8")) as { nameText: string; rollCallIds: string[] }[];
  assert.deepEqual(
    unmatched.map((u) => [u.nameText, u.rollCallIds.length]).sort(),
    [["沼 谷 純", 459], ["鈴 木 健 太", 296]].sort(),
    "unmatched.json（**票は `memberId` 空のまま残す**。#529）",
  );
  // **母数**（#757）: **空の票は 755 / 32,022 = 2.36%**
  const empty = rcs.flatMap((r) => r.votes).filter((v) => v.memberId === "");
  assert.equal(empty.length, 755, `memberId が空の票（${empty.length} / 32022）`);
  assert.deepEqual([...new Set(empty.map((v) => v.nameText))].sort(), ["沼 谷 純", "鈴 木 健 太"], "空の票の氏名");
  // **41 人全員が少なくとも 1 つの採決に出ている**（誰かが静かに消えていない。#718）。
  // **`+ 1` は `memberId` 空**
  const seen = new Set(rcs.flatMap((r) => r.votes.map((v) => v.memberId)));
  assert.equal(seen.size, 42, `票に出る議員（${seen.size} = 名簿 41 ＋ 空 1）`);
  assert.ok(seen.has(""), "`memberId` 空が残っている");
});

test("#759 本番 pref-05: 票の値と凡例（凡例に無い値が出ていない）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  const raws = new Map<string, number>();
  const legends = new Map<string, number>();
  for (const v of rcs.flatMap((r) => r.votes)) {
    raws.set(v.value.raw, (raws.get(v.value.raw) ?? 0) + 1);
    legends.set(v.value.legend, (legends.get(v.value.legend) ?? 0) + 1);
  }
  // **実測 2026-09-20**（直近 29 本）。**`除`（除斥）が新しく出た**——
  // **`--sessions 5` の範囲には 1 つも無く、広げて初めて出た記号である。**
  // **6 個とも凡例にあり、出るのは `秋田県監査委員の選任について`（4 個）と
  // `工事請負契約の締結について`（2 個）で、本人が議に加われない議案である**（原文どおり）。
  assert.deepEqual(Object.fromEntries([...raws].sort((a, b) => b[1] - a[1])), { "○": 30410, "議": 784, "×": 612, "欠": 210, "除": 6 });
  assert.deepEqual(Object.fromEntries([...legends].sort((a, b) => b[1] - a[1])), { "賛成": 30410, "議長": 784, "反対": 612, "欠席": 210, "除斥": 6 });
  // **凡例に無い記号は 1 つも出ていない**（**記号の種類は 5 つだけ**）
  assert.equal(raws.size, 5, `記号の種類（${[...raws.keys()].join(" ")}）`);
  // **`ー`(U+30FC) が票として 1 つも出ていない**（#753 の問題 3。議案名の長音が票に化けていない）
  assert.equal(raws.get("ー"), undefined, "`ー`(U+30FC) が票になっていない");
  // **`不明` / `抽出不能` が 0**
  assert.equal(raws.get("不明"), undefined);
  assert.equal(legends.get("抽出不能"), undefined);
});

test("#759 本番 pref-05: 日付・出典・id（一次資料に辿れる）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  const meta = JSON.parse(readFileSync(join(DIR, "meta.json"), "utf-8")) as LocalAssemblyMeta;
  // **全部の採決に日付がある**（日付の無い記録を出さない）
  assert.deepEqual(rcs.filter((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date)).map((r) => r.id), [], "日付の形");
  // **全部の採決に件名がある**（名の無い採決を出さない）
  assert.deepEqual(rcs.filter((r) => r.title === "").map((r) => r.id), [], "件名が空の採決");
  // **全部の採決の出典が公式ホストの PDF**（別ホストの URL が混ざっていない）
  assert.deepEqual(
    rcs.filter((r) => !r.sourceUrl.startsWith(`https://${AKITA_HOST}/`) || !r.sourceUrl.endsWith(".pdf")).map((r) => r.sourceUrl),
    [], "出典の URL",
  );
  // **id が重複していない**
  assert.equal(new Set(rcs.map((r) => r.id)).size, rcs.length, "id の重複");
  // **`sessionId` は議決日**（HTML の文言に依らない。`index.ts` の docblock）
  // **`--sessions 29`（#901）**。**いちばん古いのは 2023-05-16 で、2023年4月の一般選挙の後である**
  const ids = meta.sessions.map((s) => s.sessionId).sort();
  assert.equal(ids.length, 29, `会期（${ids.length}）`);
  assert.equal(ids[0], "2023-05-16", "いちばん古い本会議日（**選挙の後**。#901）");
  assert.equal(ids[ids.length - 1], "2026-07-03", "いちばん新しい本会議日");
  // **`sessionId` はすべて議決日の形で、重複しない**
  assert.deepEqual(ids.filter((v) => !/^\d{4}-\d{2}-\d{2}$/.test(v)), [], "`sessionId` の形");
  assert.equal(new Set(ids).size, ids.length, "`sessionId` の重複");
  // **採決の日付も全部この範囲に入る**（会期の外の日付が混ざっていない）
  const dates = rcs.map((r) => r.date).sort();
  assert.ok(dates[0] >= "2023-05-16", `いちばん古い採決（${dates[0]}）`);
  assert.ok(dates[dates.length - 1] <= "2026-07-03", `いちばん新しい採決（${dates[dates.length - 1]}）`);
  // **meta の sources が全部公式ホスト**
  assert.deepEqual(meta.sources.filter((s) => !s.url.startsWith(`https://${AKITA_HOST}/`)).map((s) => s.url), [], "sources の URL");
});

test("#759 本番 pref-05: 名簿（41 人・かなは空・字形を寄せていない）", { skip: !hasData }, () => {
  const index = JSON.parse(readFileSync(join(DATA, "members/index.json"), "utf-8")) as LocalMember[];
  const akita = index.filter((m) => m.assemblyId === "pref-05");
  assert.equal(akita.length, 41, "名簿");
  // **かなは全員空**（一覧ページにふりがなが無い。ローマ字からも起こさない。#569）
  assert.deepEqual(akita.filter((m) => m.kana !== "").map((m) => m.name), [], "かな");
  // **`高橋` 3 人の字形が寄っていない**（`高` U+9AD8 と `髙` U+9AD9 が両方ある）
  const takahashi = akita.filter((m) => /^[高髙]橋/.test(m.name)).map((m) => m.name).sort();
  assert.deepEqual(takahashi, ["高橋 健", "髙橋 豪", "髙橋武浩"], "`高橋` 3 人");
  // **`川邉隼之介` が 1 人**（3 つの `<a>` に割れていた議員）
  assert.deepEqual(akita.filter((m) => m.name.includes("川邉")).map((m) => m.name), ["川邉隼之介"]);
  // **全員が採決に出ている**（`counts.rollcalls` が 0 の議員が居ない）
  assert.deepEqual(akita.filter((m) => (m.counts?.rollcalls ?? 0) === 0).map((m) => m.name), [], "採決 0 件の議員");
});

/**
 * **既存 9 県を壊していない**（共通層に触ったので、ここで固定する）。
 * **`assemblies/index.json` に 10 議会 ＋ 国会の 2 行が居ることを見る。**
 */
test("#759 既存の議会を消していない（assemblies/index.json）", { skip: !hasData }, () => {
  const index = JSON.parse(readFileSync(join(DATA, "assemblies/index.json"), "utf-8")) as { id: string }[];
  const ids = index.map((a) => a.id).sort();
  for (const id of ["pref-02", "pref-04", "pref-05", "pref-24", "pref-25", "pref-29", "pref-31", "pref-32", "pref-36", "pref-39"]) {
    assert.ok(ids.includes(id), `${id} が index.json に居る（${ids.join(" ")}）`);
  }
  assert.ok(ids.some((id) => id.startsWith("diet-")), "国会の行も残っている");
});
