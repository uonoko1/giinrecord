import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { LocalAssemblyMeta, LocalMember, LocalRollCall, LocalUnmatchedName } from "@seiji-kiroku/shared";
import { KOCHI_HOST } from "../src/sources/local/kochi/site.ts";

/**
 * **本番 `data/assemblies/pref-39/` に出したものを、出した後から読み直して数える**（Issue #865）。
 *
 * **`votes-pdf.ts` のテストは PDF を読む側を見ている。ここは「書いたもの」を見る。**
 * **`data/` の JSON を読み直しているので、書き出し（`buildLocalAssembly` / `writeLocalAssembly`）が
 * 壊れたらここが落ちる。**
 *
 * ## **高知で何を主張するか**——**他県から写していない**
 *
 * **高知だけにある形が 4 つある**（実測 2026-09-14）:
 *
 * ## **#901 で `--sessions` を 2 → 5 に広げた**（2026-09-20）
 *
 * **104 採決 / 3,744 セル / 2 会期 → 221 採決 / 7,881 セル / 5 会期。**
 * **広げるために直した欠陥は 1 つ**（請願の枝番 `請第1-1号`。`kochi-petition-branch.test.ts`）。
 *
 * **広げて初めて出た形が 2 つある。どちらもここで固定する:**
 *
 * - **会期によって議員の列の数が違う**（**2025-12 だけ 35 人、他の 4 会期は 36 人**）。
 *   **橋本敏男 が 2025-09 と 2025-12 のあいだに退いている**——**`{36: 104}` のような
 *   「全行が同じセル数」の形は、もう書けない**（**書くと会期をまたげなくなる**）。
 * - **`memberId` が空の票が 0 → 276 件**（**武石利彦 117 / 田所裕介 117 / 橋本敏男 42**）。
 *   **3 人とも今の名簿 36 人に居ない**（**候補は 3 人とも 0 人＝同姓同名すら居ない**）。
 *   **推定で今の誰かに寄せていない**（#529 / #569）——**安全側である。**
 *
 * 1. **ホストが `gikai.pref.kochi.lg.jp`**——**議会が県庁本体とは別のホストにある。**
 *    ほかの 10 議会はすべて `www.pref.<県>.lg.jp` である。
 *    **「`www.pref.` で始まる」と書いた検算を写すと、高知では嘘になる。**
 * 2. **`result` に `〃`（U+3003）が 86 / 104 行で残っている。**
 *    **一方 `date` には `〃` が 1 つも無い**（104 行とも ISO）。
 *    **同じ PDF の同じ「同上」を、日付は継いで、結果は継がない**——
 *    **`kochi/rollcalls.ts` がそう決めている**（「議決年月日の『〃』は上の行と同じ日なので継ぐ。
 *    セルの原文は `VotePdfRow.dateText` に残る」。**結果の `〃` は原文のまま**）。
 *    **これは非対称で、写し間違えやすい。だから固定する。**
 * 3. **`counts` が 104 行とも無い。** **PDF には賛成者数・反対者数の欄があり、
 *    `votes-pdf.ts` はそれを読んでいる**（`kochi-votes-pdf.test.ts` が 47 行で突き合わせている）が、
 *    **`rollcalls.ts` が `LocalRollCall` に載せていない。**
 *    **これは既知の状態である**（`kochi-votes-pdf.test.ts` の docblock が
 *    「`data/assemblies/pref-39/` の 104 行は 104 行とも `counts` を出力に入れていない」と書いている）。
 *    **ここでは「無い」を無いまま固定する**——**直すなら別の判断**（このテストは `data/` を変えない）。
 * 4. **`除`（除斥）が 221 採決で 1 件だけ。** 下村勝幸 の 1 票（2026-02 会期）。
 *    **広げても増えなかった**——**増えた 3 会期（2025-12 / 2025-09 / 2025-06）には `除` が 0 セル。**
 *    **これは #913（「2026-02 の x が `除` 1 セルに乗っている」）への実測の答えでもある:**
 *    **広げても錨B の母数は 1 のままである。**
 */
const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));
const DIR = join(DATA, "assemblies", "pref-39");

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

test("#901 本番 pref-39: 採決 221 / 7,881 セル / 5 会期、抽出不能 0.00%（#865 の 104 / 3,744 から広げた）", { skip: !hasData }, () => {
  const m = meta();
  const rcs = rollCalls();
  // **実測 2026-09-20**（`--sessions 5`。月次のワークフローは `defaultSessionsFor("kochi")` = 5 で回る）
  assert.equal(m.counts.rollcalls, 221);
  assert.equal(m.counts.members, 36, "名簿の人数（**票に出る議員の数ではない**——下を見よ）");
  assert.equal(m.counts.cells, 7_881);
  assert.equal(m.counts.unknownCells, 0, "**推定せず残した不明セルは 0**");
  assert.equal(m.counts.unmatchedNames, 3, "**名簿に寄らなかった氏名**（#865 の時点は 0。安全側に増えた）");
  // **meta の数が、書いた実物と一致する**（meta だけを書き換えても落ちる）
  assert.equal(rcs.length, m.counts.rollcalls, "rollcalls/ の実ファイル数");
  assert.equal(rcs.reduce((s, r) => s + r.votes.length, 0), m.counts.cells, "票の実数");
  // **セル数は会期ごとに違う**——**2025-12 だけ 35 人**（橋本敏男 が 2025-09 と 2025-12 のあいだに退いた）。
  // **「全行が同じセル数」を主張すると会期をまたげない**ので、**会期ごとに固定する**。
  // **1 つの会期の中で数が揺れたら落ちる**（#705 が滋賀で踏んだ「途中で 1 人静かに消える」形）。
  const perRow = new Map<number, number>();
  for (const r of rcs) perRow.set(r.votes.length, (perRow.get(r.votes.length) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries(perRow), { 35: 75, 36: 146 }, "採決ごとのセル数");
  const perSession = new Map<string, Set<number>>();
  for (const r of rcs) (perSession.get(r.sessionId) ?? perSession.set(r.sessionId, new Set()).get(r.sessionId)!).add(r.votes.length);
  assert.deepEqual(
    Object.fromEntries([...perSession].map(([k, v]) => [k, [...v]]).sort()),
    { "2025-06": [36], "2025-09": [36], "2025-12": [35], "2026-02": [36], "2026-06": [36] },
    "**会期の中では 1 通り**（会期の途中で議員が消えていない）",
  );
  assert.equal(rcs.reduce((s, r) => s + r.votes.filter((v) => v.value.legend === "抽出不能").length, 0), 0, "`抽出不能` の票");
});

/**
 * **票の内訳**（`data/` を読み直して数えた。**3,744 セルすべてを 4 つの記号に分類しきる**）。
 *
 * **3,744 票すべてに `mapped` が付く**（徳島は 94.7% が付かなかった。**議会ごとに違う**）。
 */
test("#901 本番 pref-39: 票の内訳 ○7173 / ×486 / 議221 / 除1（7,881 票すべてに mapped が付く）", { skip: !hasData }, () => {
  const votes = rollCalls().flatMap((r) => r.votes);
  assert.equal(votes.length, 7_881, "母数（減っていたらこの内訳は意味が無い）");
  const raw = new Map<string, number>();
  const legend = new Map<string, number>();
  const mapped = new Map<string, number>();
  for (const v of votes) {
    raw.set(v.value.raw, (raw.get(v.value.raw) ?? 0) + 1);
    legend.set(v.value.legend, (legend.get(v.value.legend) ?? 0) + 1);
    mapped.set(String(v.value.mapped), (mapped.get(String(v.value.mapped)) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries([...raw].sort()), { "×": 486, "○": 7173, "議": 221, "除": 1 });
  assert.deepEqual(Object.fromEntries([...legend].sort()), { "反対": 486, "議長": 221, "賛成": 7173, "除斥": 1 });
  assert.deepEqual(Object.fromEntries([...mapped].sort()), { "反対": 486, "投票なし": 222, "賛成": 7173 });
  assert.equal([...mapped.values()].reduce((a, b) => a + b, 0), 7_881, "mapped の合計");
  // **凡例にある 7 種のうち、5 会期に出たのは 4 種だけ**（`副` / `欠` / `－` は 0 セル）。
  // **凡例にあることは、出ることを意味しない。**
  for (const absent of ["副", "欠", "－"]) assert.equal(raw.get(absent), undefined, `${absent} は 5 会期に出ない`);
  assert.deepEqual(votes.filter((v) => v.value.mapped === undefined), [], "mapped の無い票");
  // **`〇` U+3007 / `✕` U+2715 が票として出ていない**（徳島は `〇` が 74 件出る。県ごとに違う）
  assert.equal(raw.get("〇"), undefined, "`〇` U+3007");
  assert.equal(raw.get("✕"), undefined, "`✕` U+2715");
  assert.equal(raw.get("不明"), undefined, "`不明`");
});

/**
 * ## **`counts` は 104 行とも無い**——**無いまま固定する**
 *
 * **PDF には賛成者数・反対者数の欄があり、`votes-pdf.ts` の `VotePdfRow.counts` はそれを読んでいる。**
 * **`rollcalls.ts` が `LocalRollCall` に載せていないだけである**（既知。
 * `kochi-votes-pdf.test.ts` の docblock が名指ししている）。
 *
 * **だから「`○` の数 = `counts.yes`」という他県の検算は、高知では書けない。**
 * **共通層の員数の検算も 1 行も走っていない**（`meta.countChecked` が `checked: 0 / noCounts: 104`）。
 *
 * **ここで「無い」を固定するのは、誰かが推定で足すのを止めるためではない**
 * （足すなら PDF から読み直すのが正しい）。**「今は無い」と「あるはずなのに落ちた」を
 * 区別できるようにするため**である——**足したときにここが落ちて、
 * そのとき初めて「本当に PDF の数字か」を見に行くことになる。**
 */
test("#901 本番 pref-39: counts は 221 行とも無い（PDF には欄があるが LocalRollCall に載っていない。既知）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  assert.equal(rcs.length, 221, "母数");
  assert.deepEqual(rcs.filter((r) => r.counts !== undefined).map((r) => r.id), [], "counts のある採決");
  assert.deepEqual(rcs.filter((r) => r.method !== undefined).map((r) => r.id), [], "method のある採決");
  assert.deepEqual(meta().countChecked, { checked: 0, noCounts: 221, rows: 221, unreadableCells: 0 });
});

/**
 * ## **`result` の `〃` は残り、`date` の `〃` は解けている**——**非対称を固定する**
 *
 * **同じ PDF の同じ「同上」を、日付は上の行から継ぎ、結果は原文のまま残す**
 * （`kochi/rollcalls.ts` / `kochi/votes-pdf.ts` の docblock）。
 *
 * **`result` に `〃` が 86 / 104 行**、**`date` に `〃` が 0 行**。
 * **どちらかが崩れたら、片方の方針が静かに変わっている**——
 * **日付が `〃` のまま出たら記録が一次資料に辿れなくなり、
 * 結果を勝手に継いだら「原文に無いことを書いた」ことになる**（#569）。
 */
test("#901 本番 pref-39: result の `〃`(U+3003) は 182 行に残り、date の `〃` は 0 行（日付だけ継いでいる）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  assert.equal(rcs.length, 221, "母数");
  assert.equal("〃".codePointAt(0), 0x3003, "`〃` DITTO MARK");
  // **日付は 104 行とも ISO**（`〃` も `″` も `”` も残っていない）
  assert.deepEqual(rcs.filter((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date)).map((r) => r.id), [], "日付の形");
  assert.deepEqual(rcs.filter((r) => /[〃″”]/.test(r.date)).map((r) => r.id), [], "日付に残った同上記号");
  // **議決日は 6 つ**。**会期 1 つに議決日 1 つとは限らない**——**2025-12 会期だけ 2 日ある**
  // （2025-12-05 の 25 行は第376回定例会からの継続審査、2025-12-19 の 50 行がこの会期ぶん）。
  // **#865 の時点は 2 会期 2 日で 1 対 1 だったので、そう書くと会期をまたげない。**
  const byKey = new Map<string, number>();
  for (const r of rcs) { const k = `${r.sessionId}|${r.date}`; byKey.set(k, (byKey.get(k) ?? 0) + 1); }
  assert.deepEqual(Object.fromEntries([...byKey].sort()), {
    "2025-06|2025-06-27": 24, "2025-09|2025-10-14": 18,
    "2025-12|2025-12-05": 25, "2025-12|2025-12-19": 50,
    "2026-02|2026-03-24": 81, "2026-06|2026-07-10": 23,
  });
  // **`result` の `〃` は 182 行、原文のまま残っている**（上の行から継いでいない）
  const ditto = rcs.filter((r) => r.result === "〃");
  assert.equal(ditto.length, 182, "`〃` の残った result");
  assert.deepEqual(
    Object.fromEntries([...new Set(ditto.map((r) => r.date))].sort().map((d) => [d, ditto.filter((r) => r.date === d).length])),
    { "2025-06-27": 19, "2025-10-14": 14, "2025-12-05": 22, "2025-12-19": 41, "2026-03-24": 70, "2026-07-10": 16 },
  );
  // **`result` の内訳**（`〃` を含めて 221 行を分類しきる。**`〃` を「原案可決」に読み替えていない**）。
  // **広げて `不採択` と `認定` が新しく出た**（`不採択` は請願、`認定` は決算）
  const results = new Map<string, number>();
  for (const r of rcs) results.set(r.result, (results.get(r.result) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries([...results].sort()), { "〃": 182, "不採択": 1, "否決": 6, "原案可決": 22, "同意": 4, "承認": 4, "認定": 2 });
  assert.equal([...results.values()].reduce((a, b) => a + b, 0), 221, "result の合計");
  // **全部の採決に result がある**（空の結果を出していない）
  assert.deepEqual(rcs.filter((r) => !r.result).map((r) => r.id), [], "result が空の採決");
});

/**
 * ## **`議` は全 104 採決で 1 人、会期をまたいで交代している**
 *
 * **2026-02 会期の 81 件は 三石文隆、2026-06 会期の 23 件は 明神健夫。**
 * **会期の中では交代していない**（島根は会期の中で交代していた）。
 *
 * **これは順序（k 番目のセルが k 番目の議員）の証明ではない**（#743 が「1 行に `議` は高々 1 個」が
 * 恒真であることを実測している）。**順序の検算は `kochi-votes-pdf.test.ts` にある。**
 */
test("#901 本番 pref-39: `議` は 221 採決すべてで 1 人、2026-06 会期でだけ 三石文隆 → 明神健夫", { skip: !hasData }, () => {
  const rcs = rollCalls();
  const perRollCall = new Map<number, number>();
  const bySession = new Map<string, Map<string, number>>();
  const ids = new Set<string>();
  for (const rc of rcs) {
    const gi = rc.votes.filter((v) => v.value.raw === "議");
    perRollCall.set(gi.length, (perRollCall.get(gi.length) ?? 0) + 1);
    for (const v of gi) {
      assert.equal(v.value.legend, "議長", `${rc.id}: 凡例`);
      assert.equal(v.value.mapped, "投票なし", `${rc.id}: mapped`);
      ids.add(v.memberId);
      const s = bySession.get(rc.sessionId) ?? new Map<string, number>();
      s.set(v.nameText, (s.get(v.nameText) ?? 0) + 1);
      bySession.set(rc.sessionId, s);
    }
  }
  assert.deepEqual(Object.fromEntries(perRollCall), { 1: 221 }, "採決ごとの `議` の数");
  assert.equal(ids.size, 2, `\`議\` が付く議員（${[...ids].sort().join(",")}）`);
  assert.ok(![...ids].includes(""), "議長が名簿に寄っている");
  // **交代は 1 回だけ**——**4 会期（2025-06 〜 2026-02）が 三石文隆、2026-06 だけ 明神健夫。**
  // **県の公表（105 代 明神健夫 は 2026-03-24 就任）と合う**（錨A。`kochi-vote-alignment.test.ts`）。
  assert.deepEqual(
    Object.fromEntries([...bySession].map(([k, v]) => [k, Object.fromEntries([...v].sort())]).sort()),
    { "2025-06": { "三石文隆": 24 }, "2025-09": { "三石文隆": 18 }, "2025-12": { "三石文隆": 75 }, "2026-02": { "三石文隆": 81 }, "2026-06": { "明神健夫": 23 } },
  );
  // **`除` は 221 採決で 1 件だけ**（下村勝幸。その行で議長ではない）。
  // **広げても増えなかった**——**増えた 3 会期には `除` が 0 セル**（#913 への実測の答え）
  const jo = rcs.flatMap((r) => r.votes.filter((v) => v.value.raw === "除").map((v) => ({ id: r.id, n: v.nameText, m: v.memberId })));
  assert.deepEqual(jo, [{ id: "pref-39-2026-02-20260324-知事提出議案-第75号", n: "下村勝幸", m: "p_39_12" }]);
});

/**
 * ## **氏名は 36 人と 1 対 1、票の `group` が名簿の会派と 3,744 / 3,744 で一致する**
 *
 * **票の 1 つ 1 つに `group`（会派）が入っている。**
 * **それが名簿の会派と食い違っていたら、票を別人に寄せているか、名簿が古い。**
 * **実測 0 件。**
 *
 * **さらに、会派ごとの票数が「その会派の人数 × 104」ちょうどになる**
 * （自由民主党 20 人 × 104 = 2,080 など）——**列がずれたら、この積は崩れる。**
 *
 * **1 対 1 であることを見る**（#796: 氏名が一致するだけでは同一人物と書かない）。
 */
test("#901 本番 pref-39: 寄った 36 人が氏名と 1 対 1、寄らなかった 3 人は 276 票が空のまま（推定しない）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  const votes = rcs.flatMap((r) => r.votes);
  assert.equal(votes.length, 7_881, "母数");
  // **寄らなかった 3 人**（**いずれも今の名簿 36 人に居ない、前に退いた議員**）。
  // **`candidates` が 3 人とも 0 件**——**名簿に同姓同名すら居ないので、別人に寄せる余地が無い**（#569）。
  const unmatched = JSON.parse(readFileSync(join(DIR, "unmatched.json"), "utf-8")) as LocalUnmatchedName[];
  assert.deepEqual(
    unmatched.map((u) => [u.nameText, u.group, u.rollCallIds.length, u.candidates?.length ?? 0]).sort(),
    [["武石利彦", "一燈立志の会", 117, 0], ["橋本敏男", "県民の会", 42, 0], ["田所裕介", "県民の会", 117, 0]].sort(),
  );
  const empty = votes.filter((v) => v.memberId === "");
  assert.equal(empty.length, 276, "**memberId が空の票**（#865 の時点は 0。**安全側に増えた**）");
  const emptyNames = new Map<string, number>();
  for (const v of empty) emptyNames.set(`${v.nameText}|${v.group}`, (emptyNames.get(`${v.nameText}|${v.group}`) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries([...emptyNames].sort()), { "武石利彦|一燈立志の会": 117, "橋本敏男|県民の会": 42, "田所裕介|県民の会": 117 });
  assert.equal(276 / 7_881 < 0.04, true, "寄らなかった票の割合（3.50%）");
  const idToNames = new Map<string, Set<string>>();
  const nameToIds = new Map<string, Set<string>>();
  for (const v of votes) {
    if (v.memberId === "") continue;
    (idToNames.get(v.memberId) ?? idToNames.set(v.memberId, new Set()).get(v.memberId)!).add(v.nameText);
    (nameToIds.get(v.nameText) ?? nameToIds.set(v.nameText, new Set()).get(v.nameText)!).add(v.memberId);
  }
  assert.equal(idToNames.size, 36, "**名簿に寄った議員**（寄らなかった 3 人は上で数えた）");
  assert.equal(nameToIds.size, 36, "寄った氏名");
  assert.deepEqual([...idToNames].filter(([, s]) => s.size > 1).map(([k]) => k), [], "1 人に 2 通りの氏名");
  assert.deepEqual([...nameToIds].filter(([, s]) => s.size > 1).map(([k]) => k), [], "1 つの氏名が 2 人に");
  // **同じ採決に同じ議員が 2 回出ない**（**空の `memberId` は 1 採決に 2〜3 個あるので、寄った票だけで数える**）
  assert.deepEqual(
    rcs.filter((r) => { const ids = r.votes.map((v) => v.memberId).filter((x) => x !== ""); return new Set(ids).size !== ids.length; }).map((r) => r.id),
    [], "同じ採決に同じ議員が 2 回",
  );
  // **票の氏名（空白を除く）が、名簿の氏名（空白を除く）と完全一致する**
  const index = JSON.parse(readFileSync(join(DATA, "members", "index.json"), "utf-8")) as LocalMember[];
  const kochi = index.filter((m) => m.assemblyId === "pref-39");
  assert.equal(kochi.length, 36, "名簿");
  const strip = (s: string) => s.replace(/[\s　]/g, "");
  const rosterName = new Map(kochi.map((m) => [m.id, strip(m.name)]));
  const rosterGroup = new Map(kochi.map((m) => [m.id, m.group]));
  let matched = 0;
  for (const [id, names] of idToNames) {
    assert.equal(rosterName.get(id), strip([...names][0]), `${id}: PDF「${[...names][0]}」と名簿「${rosterName.get(id)}」`);
    matched++;
  }
  assert.equal(matched, 36, "**36 人すべてを名簿と突き合わせた**");
  // **票 1 つ 1 つの `group` が名簿の会派と一致する**（3,744 票すべて）
  const bad = votes.filter((v) => v.memberId !== "" && v.group !== rosterGroup.get(v.memberId));
  assert.deepEqual(bad.map((v) => `${v.nameText}: ${v.group} ≠ ${rosterGroup.get(v.memberId)}`), [], "票の会派と名簿の会派（寄った 7,605 票）");
  // **会派ごとの票数**。**「人数 × 採決数」の形はもう書けない**——
  // **議員ごとに出る会期が違う**（**3 人は 2026-02 からの就任で 104 件、33 人は 221 件**）
  // **うえに、寄らなかった 3 人の 276 票にも会派が付いている**（PDF の原文）。
  const voteGroups = new Map<string, number>();
  for (const v of votes) voteGroups.set(v.group, (voteGroups.get(v.group) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries([...voteGroups].sort()), {
    "一燈立志の会": 559, "公明党": 663, "県民の会": 809, "自由の風": 221, "自由民主党": 4303, "日本共産党": 1326,
  });
  assert.equal([...voteGroups.values()].reduce((a, b) => a + b, 0), 7_881, "会派ごとの票数の合計");
  const memberGroups = new Map<string, number>();
  for (const m of kochi) memberGroups.set(m.group, (memberGroups.get(m.group) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries([...memberGroups].sort()), {
    "一燈立志の会": 2, "公明党": 3, "県民の会": 4, "自由の風": 1, "自由民主党": 20, "日本共産党": 6,
  });
  assert.equal([...memberGroups.values()].reduce((a, b) => a + b, 0), 36, "会派の内訳の合計");
  // **議員ごとの採決数は 2 通り**——**221（33 人）と 104（3 人）。**
  // **104 の 3 人は 2026-02 会期から出ている**（2025-09 と 2026-02 のあいだに入った。**実測**）。
  const perMember = new Map<number, string[]>();
  for (const m of kochi) (perMember.get(m.counts?.rollcalls ?? -1) ?? perMember.set(m.counts?.rollcalls ?? -1, []).get(m.counts?.rollcalls ?? -1)!).push(m.name);
  assert.deepEqual([...perMember.keys()].sort((a, b) => a - b), [104, 221], "議員ごとの採決数");
  assert.deepEqual(perMember.get(104)!.sort(), ["岡﨑 哲也", "水野 雪絵", "浜口 卓也"].sort(), "**2026-02 会期から出ている 3 人**");
  assert.equal(perMember.get(221)!.length, 33);
});

/**
 * **出典はすべて `gikai.pref.kochi.lg.jp`**——**県庁本体（`www.pref.kochi.lg.jp`）ではない。**
 *
 * **ほかの 10 議会は `www.pref.<県>.lg.jp` なので、「`www.pref.` で始まる」という形の検算を
 * 写すと高知では嘘になる。** `KOCHI_HOST` をそのまま使う。
 */
test("#901 本番 pref-39: sourceUrl は 7 本すべて https://gikai.pref.kochi.lg.jp（www.pref.kochi.lg.jp ではない）", { skip: !hasData }, () => {
  const m = meta();
  const rcs = rollCalls();
  const urls = new Set<string>();
  for (const rc of rcs) urls.add(rc.sourceUrl);
  for (const s of m.sources) urls.add(s.url);
  for (const s of m.sessions) { urls.add(s.sourceUrl); if (s.pdfUrl) urls.add(s.pdfUrl); for (const p of s.pdfUrls ?? []) urls.add(p); }
  assert.equal(urls.size, 7, "**突き合わせた URL の本数**（名簿 1 ＋ index 1 ＋ 会期の PDF 5。0 本を見て緑にならないように）");
  assert.deepEqual([...urls].filter((u) => new URL(u).host !== KOCHI_HOST || new URL(u).protocol !== "https:"), [], "公式ホストでない URL");
  assert.equal(KOCHI_HOST, "gikai.pref.kochi.lg.jp");
  assert.deepEqual([...urls].filter((u) => new URL(u).host === "www.pref.kochi.lg.jp"), [], "県庁本体のホストの URL");
  // **採決の出典は 2 本の PDF**（会期ごとに 1 本ずつ）
  const pdfs = new Map<string, number>();
  for (const r of rcs) pdfs.set(r.sourceUrl, (pdfs.get(r.sourceUrl) ?? 0) + 1);
  assert.equal(pdfs.size, 5, "採決の出典 PDF");
  assert.deepEqual([...pdfs.values()].sort((a, b) => b - a), [81, 75, 24, 23, 18], "PDF ごとの採決数");
  assert.equal([...pdfs.values()].reduce((a, b) => a + b, 0), 221, "合計");
  assert.deepEqual([...pdfs.keys()].filter((u) => !u.endsWith(".pdf")), [], "PDF でない出典");
  // **会期は 5 本、内訳は 23 + 81 + 75 + 18 + 24 = 221**
  assert.deepEqual(m.sessions.map((s) => [s.sessionId, s.rollcalls]).sort(), [["2025-06", 24], ["2025-09", 18], ["2025-12", 75], ["2026-02", 81], ["2026-06", 23]]);
  assert.equal(m.sessions.reduce((s, x) => s + (x.rollcalls ?? 0), 0), 221, "会期ごとの採決数の合計");
  // **`rosterAsOf` から最古の採決まで 398 日**（**上限 1,461 日の 27%。#928 の検査は鳴らない**）
  const oldest = rcs.map((r) => r.date).sort()[0];
  assert.equal(oldest, "2025-06-27", "最古の採決");
  assert.equal(Math.round((Date.parse(`${m.rosterAsOf}T00:00:00Z`) - Date.parse(`${oldest}T00:00:00Z`)) / 86_400_000), 398, "rosterAsOf からの隔たり（日）");
  // **全部の採決に件名がある。id が重複していない**
  assert.deepEqual(rcs.filter((r) => r.title === "").map((r) => r.id), [], "件名が空の採決");
  assert.equal(new Set(rcs.map((r) => r.id)).size, rcs.length, "id の重複");
  assert.equal(m.rosterAsOf, "2026-07-30");
});

/** **名簿 36 人に kana / district / group が揃っている**（#632 の検算が効く議会）。 */
test("#865 本番 pref-39: 36 人全員に kana・選挙区・会派がある", { skip: !hasData }, () => {
  const index = JSON.parse(readFileSync(join(DATA, "members", "index.json"), "utf-8")) as LocalMember[];
  const kochi = index.filter((m) => m.assemblyId === "pref-39");
  assert.equal(kochi.length, 36, "母数");
  assert.deepEqual(kochi.filter((m) => m.kana === "").map((m) => m.name), [], "かなの無い議員");
  assert.deepEqual(kochi.filter((m) => m.district === "").map((m) => m.name), [], "選挙区の無い議員");
  assert.deepEqual(kochi.filter((m) => m.group === "").map((m) => m.name), [], "会派の無い議員");
  // **`岡﨑哲也` の `﨑` U+FA11 が名簿にそのまま残っている**（`崎` U+5D0E に寄せていない。#636 の `ITAIJI` は
  // 突き合わせのときだけ寄せる）。**`はた愛` のように氏名の一部がひらがなの議員も、そのまま。**
  // **名簿は姓と名の間に空白がある（`岡﨑 哲也`）が、PDF は空白が無い（`岡﨑哲也`）。**
  // **突き合わせのときだけ空白を落とす**（上の 1 対 1 のテスト）。**書き出す原文はどちらも寄せない。**
  assert.deepEqual(kochi.filter((m) => m.name.includes("﨑")).map((m) => m.name), ["岡﨑 哲也"]);
  assert.equal("﨑".codePointAt(0), 0xfa11);
  assert.deepEqual(kochi.filter((m) => /^[ぁ-ん]/.test(m.name)).map((m) => m.name), ["はた 愛"]);
  // **名簿は 36 人とも姓と名の間に空白がある**（PDF は 36 人とも無い。**どちらも寄せていない**）
  assert.deepEqual(kochi.filter((m) => !/[\s　]/.test(m.name)).map((m) => m.name), [], "空白の無い名簿の氏名");
});
