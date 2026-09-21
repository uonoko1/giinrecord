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
  // **#901 で `--sessions` の既定を 2 → 14 にした**（2023年4月の一般選挙の後まで。`local-assemblies.ts`）。
  // **113 → 611 採決 / 5,111 → 29,015 セル。** **不明セルは広げても 0**（56 / 56 本が読める）
  assert.equal(meta.counts.rollcalls, 611);
  assert.equal(meta.counts.members, 46);
  assert.equal(meta.counts.cells, 29_015);
  assert.equal(meta.counts.unknownCells, 0, "**推定せず残した不明セルは 0**");
  assert.equal(meta.counts.unmatchedNames, 10);
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
  assert.equal(votes.length, 29_015, "母数（減っていたらこの割合は意味が無い）");
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
test("#750 本番 pref-02: `議` が全 611 採決でちょうど 1 人（stray を拾っていない）", { skip: !hasData }, () => {
  const byCount = new Map<number, number>();
  for (const r of rollCalls()) {
    const n = r.votes.filter((v) => v.value.raw === "議").length;
    byCount.set(n, (byCount.get(n) ?? 0) + 1);
  }
  // **#901 で 113 → 611 採決に広げても、`議` が 0 人・2 人の採決は 1 件も出ない**
  // （**14 会期 32 ページを全部通して実測**。**秋田は 785 中 1 件だけ 0 人だった**が、青森には無い）
  assert.deepEqual(Object.fromEntries(byCount), { 1: 611 });
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
  // **#901 で 2 → 14 会期。** **会期ごとに議員数が違うのは実際に違うから**
  // （**2026-02 は 45、2026-06 は 46、2025-11 以前は 48**。辞職と欠員による）。
  // **1 つの会期の中で 2 通りの票数が出たら、そこで議員が静かに 1 人落ちている**
  assert.deepEqual(
    Object.fromEntries([...bySession].map(([k, v]) => [k, [...v]]).sort()),
    {
      "2023-05-rinji": [48], "2023-07": [48], "2023-09": [48], "2023-11": [48],
      "2024-02": [48], "2024-06": [48], "2024-09": [48], "2024-11": [48],
      "2025-02": [48], "2025-06": [48], "2025-09": [48], "2025-11": [48],
      "2026-02": [45], "2026-06": [46],
    },
    "**会期の中で票数がぶれたら、その会期のどこかで議員が 1 人落ちている**",
  );
});

/**
 * **`unmatched.json` の 10 行が、それぞれどの機序か。**
 * **「名簿に無い議員」と混ぜない**——**運用者にとっては全く違う話で、確かめる先が違う**（#680／#711）。
 *
 * ## **#901 で 2 → 14 会期に広げて、行が 3 → 10 に増えた**（**人でいうと 2 → 6 人**）
 *
 * **増えた 4 人（`阿部広悦` `谷川政人` `工藤貴弘` `関良`）は、機序が違う**——
 * **`sourceConflict`（名簿と 1 文字違い）ではなく、`reason` なし＝「名簿に無い議員」である。**
 * **4 人とも今の名簿（2026-05-25）に同姓同名すら居ないので、`candidates` が 0 人**
 * ——**別人に寄りようがない**（#569 の安全側）。**任期の途中で退いた議員である。**
 *
 * **これは「広げたら別人の記録が出た」ではなく「広げたら寄らない票が増えた」である。**
 * **票は `memberId` を空にしたまま残す**（#529。**「記録が出ない」にしない**）。
 */
test("#750 本番 pref-02: unmatched 10 行の内訳（どちらが正しいかは決めていない）", { skip: !hasData }, () => {
  const um = JSON.parse(readFileSync(join(DIR, "unmatched.json"), "utf-8")) as { nameText: string; group: string; reason?: string; candidates?: unknown[] }[];
  assert.equal(um.length, 10);
  // **(理由, 氏名) の組で数える**——**機序ごとに分けて固定する**（混ぜると片方が消えても気づかない）
  const byReason = new Map<string, Set<string>>();
  for (const u of um) {
    const k = u.reason ?? "(名簿に無い議員)";
    byReason.set(k, (byReason.get(k) ?? new Set()).add(u.nameText));
  }
  assert.deepEqual(
    Object.fromEntries([...byReason].map(([k, v]) => [k, [...v].sort()])),
    {
      // **名簿と 1 文字違い**（下で符号位置を見る）
      "sourceConflict": ["和 田 寛 司", "噰 引 ユキ子"].sort(),
      // **#901 で広げて増えた 4 人**（任期の途中で退いた議員。名簿に同姓同名すら居ない）
      "(名簿に無い議員)": ["工 藤 貴 弘", "谷 川 政 人", "関 良", "阿 部 広 悦"].sort(),
    },
  );
  // **`候補` が 1 人でも居たら「別人に寄りかけた」ということ**——**10 行とも 0 人**（#569）
  assert.deepEqual(um.filter((u) => (u.candidates?.length ?? 0) > 0), [], "候補が挙がった行（別人に寄りうる形）");
  // **同じ氏名が 2 行あるのは会派が違うから**——**罫線の無い 4 本（第322〜325回）は会派が空**
  for (const n of ["和 田 寛 司", "阿 部 広 悦", "谷 川 政 人", "工 藤 貴 弘"])
    assert.deepEqual(um.filter((u) => u.nameText === n).map((u) => u.group).sort(), ["", "自由民主党"], n);
  // **`噰 引 ユキ子` は 1 行だけ**——**化けるのは罫線の無い 4 本だけ**（会派が空の行しか無い）
  assert.deepEqual(um.filter((u) => u.nameText === "噰 引 ユキ子").map((u) => u.group), [""]);
  // **`関 良` も 1 行**（第96回臨時会にしか出ない。会派は読める）
  assert.deepEqual(um.filter((u) => u.nameText === "関 良").map((u) => u.group), ["青和会"]);
  // **機序が符号位置で分かる**（推定ではなく、文字そのものが違う）
  //   `寛` U+5BDB（PDF） vs 名簿 `寬` U+5BEC … #529 が見つけた罠。#636 の「寛/寬 は畳まない」が効いた
  //   `噰` U+5670（PDF） vs 名簿 `櫛` U+6ADB … #749 の機序 ③（埋め込みフォントの ToUnicode）
  assert.equal("寛".codePointAt(0), 0x5bdb);
  assert.equal("寬".codePointAt(0), 0x5bec);
  assert.equal("噰".codePointAt(0), 0x5670);
  assert.equal("櫛".codePointAt(0), 0x6adb);
  // **票そのものは残っている**（`memberId` が空なだけ。「記録が出ない」にしていない）
  const votes = rollCalls().flatMap((r) => r.votes);
  assert.equal(votes.length, 29_015, "母数（#757）");
  const orphan = votes.filter((v) => v.memberId === "");
  assert.equal(orphan.length, 2_306, "7.95% の票が名簿に寄っていない（6 名ぶん）");
  assert.deepEqual(orphan.filter((v) => v.value.mapped === undefined), [], "寄らなくても票は読めている");
  // **寄らなかった票の氏名は、`unmatched.json` の 10 行に 1 つ残らず現れる**
  // （**片方だけ増えたら落ちる**。`unmatched.json` を書き忘れても、票を捨てても落ちる）
  assert.deepEqual(
    [...new Set(orphan.map((v) => `${v.nameText}\t${v.group}`))].sort(),
    [...new Set(um.map((u) => `${u.nameText}\t${u.group}`))].sort(),
  );
});

/**
 * **読めなかった一次資料が 0 本**（滋賀 #741 は画像 PDF が 3 本あった）。
 * **`unreadableSources` が省略されている ＝ 読めない本が無い**、であって
 * **「書き忘れ」ではない**ことを、`sources` の本数と突き合わせて確かめる。
 */
test("#750 本番 pref-02: 読めなかった一次資料は 0 本（出典は名簿 2 + index 1 + PDF 14）", { skip: !hasData }, () => {
  const meta = JSON.parse(readFileSync(join(DIR, "meta.json"), "utf-8")) as LocalAssemblyMeta;
  // **#901 で 2 → 14 会期に広げても、読めなかった本は 1 本も無い**
  // （**index の 56 本すべてを `parseVotePdf` と `toLocalRollCalls` に掛けて 56 / 56 本が通る**。実測）
  assert.equal(meta.unreadableSources, undefined, "読めなかった本が無いので省略される");
  assert.equal(meta.sessions.length, 14);
  // **出典は 17 件**: 会派別・選挙区別・index・会期 14 本ぶんの PDF（**1 会期 1 本**）
  assert.equal(meta.sources.length, 17);
  assert.equal(meta.sources.filter((s) => s.url.endsWith(".pdf")).length, 14);
  assert.equal(meta.sources.filter((s) => s.url.endsWith(".pdf")).length, meta.sessions.length, "1 会期 1 本");
  assert.equal(meta.sources.every((s) => s.url.startsWith("https://www.pref.aomori.lg.jp/")), true);
  // **`lossyNameMatches` は広げても省略されたまま**——**字の落ちた `引 ユキ子`（#749 の機序 ②）が
  // 出るのは第300・301回（2019-11 / 2020-02）で、`--sessions 29` まで広げないと入らない。**
  // **`--sessions 14`（2023-05臨時 まで）はその手前で止まる**（一般選挙の境）
  assert.equal(meta.lossyNameMatches, undefined);
  assert.equal(meta.rosterAsOf, "2026-05-25");
  // **最古の採決が `rosterAsOf` から 1 任期（1,461 日）の内側にいる**（#928）。
  // **実測 1,109 日**——**一般選挙の境で止めた結果であって、#928 が止めたのではない**
  // （**#928 が鳴るのは 19 会期目の 1,544 日で、境より 4 会期も後ろ**。`local-assemblies.ts`）
  const dates = rollCalls().map((r) => r.date).sort();
  assert.equal(dates[0], "2023-05-12", "最古の採決（第96回臨時会）");
  assert.equal(dates[dates.length - 1], "2026-06-29", "最新の採決");
  assert.equal(Math.round((Date.parse("2026-05-25") - Date.parse(dates[0])) / 86_400_000), 1_109);
});

/**
 * ## **広げて「別人に寄る余地」が増えていないこと**（#569 の重いほう。#901）
 *
 * **`--sessions` を 2 → 14 にすると `unmatched.json` が 3 → 10 行に増える。**
 * **だが「寄らなかった」は安全側である**（#901）——**本当に危ないのは
 * 「寄ってはいけないものが寄った」ほうで、`unmatched.json` には出ない。**
 *
 * **それを出力の側から見る方法が 1 つある**——**`candidates` である。**
 * **`candidates` が 2 人以上ある行は「名簿の 2 人のどちらかだったかもしれない」行で、
 * 名寄せの規則が 1 行変われば別人に寄りうる**（`matchBySubsequence` は 1 人に決まるときだけ寄せる）。
 *
 * **実測 2026-09-21: 10 行とも `candidates` が 0 件である。**
 * **この範囲に出る 51 通りの氏名のうち 45 は名簿と完全一致で寄り、
 * 部分列でしか寄らなかった組は 0 組、寄らなかった 6 人は名簿に同姓同名すら居ない。**
 *
 * **変異で確かめた**（2026-09-21）: **`name-match.ts` の
 * `hits.length === 1 ? hits[0].id : ""` を `hits.length >= 1 ? ...` に差し替えると
 * ETL 全体で 17 本のテストが落ちるが、青森のテストは 1 本も落ちない。**
 * **青森には「2 人以上の候補から 1 人を選ぶ」判断が 1 件も無いからである**
 * （**この範囲では等価変異。だからこそ安全だと言える**）。
 * **このテストは、その状態が崩れたら知らせる。**
 */
test("#901 本番 pref-02: unmatched 10 行とも候補 0 人（別人に寄る余地が無い）", { skip: !hasData }, () => {
  const um = JSON.parse(readFileSync(join(DIR, "unmatched.json"), "utf-8")) as { nameText: string; candidates?: { id: string; name: string }[] }[];
  assert.equal(um.length, 10, "母数（#757）");
  assert.deepEqual(
    um.filter((u) => (u.candidates?.length ?? 0) > 0).map((u) => `${u.nameText}: ${u.candidates!.map((c) => c.name).join("/")}`),
    [],
    "**候補が 1 人でも挙がった行**——**名寄せの規則が変われば別人に寄りうる**（#569）",
  );
  // **寄った票の側も見る**——**`memberId` が名簿に実在し、1 人の議員に 2 通りの `nameText` が
  // 寄っていないこと。** **寄っていたら「別人を同じ人にした」可能性がある**
  const rcs = rollCalls();
  const byMember = new Map<string, Set<string>>();
  for (const r of rcs) for (const v of r.votes) {
    if (v.memberId === "") continue;
    byMember.set(v.memberId, (byMember.get(v.memberId) ?? new Set()).add(v.nameText.replace(/[\s　]/g, "")));
  }
  assert.equal(byMember.size, 45, "票が寄った議員（名簿 46 人のうち `和田 寬司` だけ寄らない）");
  const multi = [...byMember].filter(([, names]) => names.size > 1).map(([id, names]) => `${id}: ${[...names].sort().join("/")}`);
  // **1 人の議員に 2 通りの氏名が寄るのは `櫛引ユキ子` だけ**（**`櫛󠄁引`+IVS と `櫛引`。
  // 異体字セレクタの有無で、`localNameKey` が同じ人だと決める**——**別字ではない**。#617）
  assert.deepEqual(multi, ["p_02_giin_kushibiki-yukiko: 櫛引ユキ子/櫛󠄁引ユキ子"]);
  // **`噰引ユキ子`（U+5670 に化けた形）はこの 2 つに含まれない**——**寄せていない**（#569）
  assert.equal(byMember.get("p_02_giin_kushibiki-yukiko")!.has("噰引ユキ子"), false);
});
