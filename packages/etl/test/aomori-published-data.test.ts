import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { LocalAssemblyMeta, LocalRollCall } from "@seiji-kiroku/shared";

/**
 * **本番 `data/assemblies/pref-02/` に出したものを、出した後から読み直して数える**（Issue #750）。
 *
 * **`votes-pdf.ts` のテストは PDF を読む側を見ている。ここは「書いたもの」を見る。**
 * **同じ実装で 2 回測っているのではない**——**`data/` の JSON を読み直しているので、
 * 書き出し（`buildLocalAssembly` / `writeLocalAssembly`）が壊れたらここが落ちる。**
 *
 * **PO が #761 のレビューで手元に走らせた検算をそのまま置いた**——
 * **人が 1 回走らせただけの数字は、次の会期で静かに変わる。**
 */
const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));
const DIR = join(DATA, "assemblies", "pref-02");

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

test("#750 本番 pref-02: 採決・セル・不明セルの数（meta.json と実物が一致する）", { skip: !hasData }, () => {
  const meta = JSON.parse(readFileSync(join(DIR, "meta.json"), "utf-8")) as LocalAssemblyMeta;
  const rcs = rollCalls();
  assert.equal(meta.counts.rollcalls, 113);
  assert.equal(meta.counts.members, 46);
  assert.equal(meta.counts.cells, 5_111);
  assert.equal(meta.counts.unknownCells, 0, "**推定せず残した不明セルは 0**");
  assert.equal(meta.counts.unmatchedNames, 3);
  // **meta の数が、書いた実物と一致する**（meta だけを書き換えても落ちる）
  assert.equal(rcs.length, meta.counts.rollcalls, "rollcalls/ の実ファイル数");
  assert.equal(rcs.reduce((s, r) => s + r.votes.length, 0), meta.counts.cells, "票の実数");
});

/**
 * **`抽出不能` が何％か**（滋賀 #741 は 604 セル中 164 件 ＝ **27%**。青森は **0%**）。
 * **0 でも数える**——**「凡例に無い記号が混ざり始めた」ことに、増えてから気づけるように。**
 */
test("#750 本番 pref-02: 抽出不能は 0 件（0.0%）", { skip: !hasData }, () => {
  const votes = rollCalls().flatMap((r) => r.votes);
  assert.equal(votes.length, 5_111, "母数（減っていたらこの割合は意味が無い）");
  assert.deepEqual(votes.filter((v) => v.value.legend === "抽出不能"), []);
  assert.deepEqual(votes.filter((v) => v.value.raw === "不明"), []);
  // **`mapped` が付かない票も 0**（凡例の意味が全部 `MAPPED` に載っている）
  assert.deepEqual(votes.filter((v) => v.value.mapped === undefined), []);
});

/**
 * **#743 の問題 1（左端の stray な `議`）を踏んでいないこと。**
 *
 * **拾うと、その行の記号が 1 つ増えて全員が 1 列ずれる**——
 * **半セル以上 109,482 / 113,408 対、差の中央 2.00 セル**（#743 の変異 8）。
 * **しかも「数は合う」**（`○` の個数と「賛成者数」の突き合わせは通る。#529 が実測）ので、
 * **利用者からも #529 の検算からも見えない。**
 *
 * **`議` が全採決でちょうど 1 人**であることは、その罠を踏んでいない証拠の 1 つである
 * （**十分条件ではない**——#743 が測ったとおり「1 行に `議` は高々 1 個」は恒真で、
 * **1 列ずらしても通る。** 順序の検算は `aomori-votes-pdf.test.ts` にある）。
 */
test("#750 本番 pref-02: `議` が全 113 採決でちょうど 1 人（stray を拾っていない）", { skip: !hasData }, () => {
  const byCount = new Map<number, number>();
  for (const r of rollCalls()) {
    const n = r.votes.filter((v) => v.value.raw === "議").length;
    byCount.set(n, (byCount.get(n) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries(byCount), { 1: 113 });
});

/**
 * **会期ごとに票数が一定**（＝**議員が静かに 1 人消えていない**）。
 * **1 人消えても合計の辻褄は合う**ので、**利用者からは検出できない**（#705 が滋賀で踏んだ形）。
 */
test("#750 本番 pref-02: 会期ごとに票数が一定（静かな欠落なし）", { skip: !hasData }, () => {
  const bySession = new Map<string, Set<number>>();
  for (const r of rollCalls()) {
    const s = bySession.get(r.sessionId) ?? new Set<number>();
    s.add(r.votes.length);
    bySession.set(r.sessionId, s);
  }
  assert.deepEqual(
    Object.fromEntries([...bySession].map(([k, v]) => [k, [...v]]).sort()),
    { "2026-02": [45], "2026-06": [46] },
    "**会期の中で票数がぶれたら、その会期のどこかで議員が 1 人落ちている**",
  );
});

/**
 * **`unmatched.json` の 3 行が、それぞれどの機序か。**
 * **「名簿に無い議員」と混ぜない**——**運用者にとっては全く違う話で、確かめる先が違う**（#680／#711）。
 */
test("#750 本番 pref-02: unmatched 3 行の内訳（どちらが正しいかは決めていない）", { skip: !hasData }, () => {
  const um = JSON.parse(readFileSync(join(DIR, "unmatched.json"), "utf-8")) as { nameText: string; group: string; reason?: string }[];
  assert.equal(um.length, 3);
  // **3 行とも `sourceConflict`**（名簿と 1 文字違い）。**名簿に無い議員（理由なし）は 0 行**
  assert.deepEqual([...new Set(um.map((u) => u.reason))], ["sourceConflict"]);
  assert.deepEqual([...new Set(um.map((u) => u.nameText))].sort(), ["和 田 寛 司", "噰 引 ユキ子"].sort());
  // **`和 田 寛 司` が 2 行あるのは会派が違うから**——第325回は罫線が無いので会派が空
  assert.deepEqual(um.filter((u) => u.nameText === "和 田 寛 司").map((u) => u.group).sort(), ["", "自由民主党"]);
  // **機序が符号位置で分かる**（推定ではなく、文字そのものが違う）
  //   `寛` U+5BDB（PDF） vs 名簿 `寬` U+5BEC … #529 が見つけた罠。#636 の「寛/寬 は畳まない」が効いた
  //   `噰` U+5670（PDF） vs 名簿 `櫛` U+6ADB … #749 の機序 ③（埋め込みフォントの ToUnicode）
  assert.equal("寛".codePointAt(0), 0x5bdb);
  assert.equal("寬".codePointAt(0), 0x5bec);
  assert.equal("噰".codePointAt(0), 0x5670);
  assert.equal("櫛".codePointAt(0), 0x6adb);
  // **票そのものは残っている**（`memberId` が空なだけ。「記録が出ない」にしていない）
  const orphan = rollCalls().flatMap((r) => r.votes).filter((v) => v.memberId === "");
  assert.equal(orphan.length, 200, "3.91% の票が名簿に寄っていない（2 名ぶん）");
  assert.deepEqual(orphan.filter((v) => v.value.mapped === undefined), [], "寄らなくても票は読めている");
});

/**
 * **読めなかった一次資料が 0 本**（滋賀 #741 は画像 PDF が 3 本あった）。
 * **`unreadableSources` が省略されている ＝ 読めない本が無い**、であって
 * **「書き忘れ」ではない**ことを、`sources` の本数と突き合わせて確かめる。
 */
test("#750 本番 pref-02: 読めなかった一次資料は 0 本（出典は名簿 2 + index 1 + PDF 2）", { skip: !hasData }, () => {
  const meta = JSON.parse(readFileSync(join(DIR, "meta.json"), "utf-8")) as LocalAssemblyMeta;
  assert.equal(meta.unreadableSources, undefined, "読めなかった本が無いので省略される");
  assert.equal(meta.sessions.length, 2);
  // **出典は 5 件**: 会派別・選挙区別・index・会期 2 本ぶんの PDF
  assert.equal(meta.sources.length, 5);
  assert.equal(meta.sources.filter((s) => s.url.endsWith(".pdf")).length, 2);
  assert.equal(meta.sources.every((s) => s.url.startsWith("https://www.pref.aomori.lg.jp/")), true);
  // **`lossyNameMatches` も省略される**（直近 2 会期に字の落ちた氏名が無い。#749 の機序 ② は第300・301回）
  assert.equal(meta.lossyNameMatches, undefined);
  assert.equal(meta.rosterAsOf, "2026-05-25");
});
