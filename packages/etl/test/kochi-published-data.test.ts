import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { LocalAssemblyMeta, LocalMember, LocalRollCall } from "@seiji-kiroku/shared";
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
 * 4. **`除`（除斥）が 104 採決で 1 件だけ。** 下村勝幸 の 1 票。
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

test("#865 本番 pref-39: 採決 104 × 議員 36 = 3,744 セル、抽出不能 0.00%", { skip: !hasData }, () => {
  const m = meta();
  const rcs = rollCalls();
  // **実測 2026-09-14**（直近 2 会期。月次のワークフローは既定の `--sessions 2` で回る）
  assert.equal(m.counts.rollcalls, 104);
  assert.equal(m.counts.members, 36);
  assert.equal(m.counts.cells, 3_744);
  assert.equal(m.counts.unknownCells, 0, "**推定せず残した不明セルは 0**");
  assert.equal(m.counts.unmatchedNames, 0, "**名簿に寄らなかった氏名は 0**");
  // **meta の数が、書いた実物と一致する**（meta だけを書き換えても落ちる）
  assert.equal(rcs.length, m.counts.rollcalls, "rollcalls/ の実ファイル数");
  assert.equal(rcs.reduce((s, r) => s + r.votes.length, 0), m.counts.cells, "票の実数");
  // **104 行とも 36 セルちょうど**（会期の途中で議員が 1 人静かに消えていない。#705 が滋賀で踏んだ形）
  const perRow = new Map<number, number>();
  for (const r of rcs) perRow.set(r.votes.length, (perRow.get(r.votes.length) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries(perRow), { 36: 104 }, "採決ごとのセル数");
  assert.equal(rcs.reduce((s, r) => s + r.votes.filter((v) => v.value.legend === "抽出不能").length, 0), 0, "`抽出不能` の票");
});

/**
 * **票の内訳**（`data/` を読み直して数えた。**3,744 セルすべてを 4 つの記号に分類しきる**）。
 *
 * **3,744 票すべてに `mapped` が付く**（徳島は 94.7% が付かなかった。**議会ごとに違う**）。
 */
test("#865 本番 pref-39: 票の内訳 ○3420 / ×219 / 議104 / 除1（3,744 票すべてに mapped が付く）", { skip: !hasData }, () => {
  const votes = rollCalls().flatMap((r) => r.votes);
  assert.equal(votes.length, 3_744, "母数（減っていたらこの内訳は意味が無い）");
  const raw = new Map<string, number>();
  const legend = new Map<string, number>();
  const mapped = new Map<string, number>();
  for (const v of votes) {
    raw.set(v.value.raw, (raw.get(v.value.raw) ?? 0) + 1);
    legend.set(v.value.legend, (legend.get(v.value.legend) ?? 0) + 1);
    mapped.set(String(v.value.mapped), (mapped.get(String(v.value.mapped)) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries([...raw].sort()), { "×": 219, "○": 3420, "議": 104, "除": 1 });
  assert.deepEqual(Object.fromEntries([...legend].sort()), { "反対": 219, "議長": 104, "賛成": 3420, "除斥": 1 });
  assert.deepEqual(Object.fromEntries([...mapped].sort()), { "反対": 219, "投票なし": 105, "賛成": 3420 });
  assert.equal([...mapped.values()].reduce((a, b) => a + b, 0), 3_744, "mapped の合計");
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
test("#865 本番 pref-39: counts は 104 行とも無い（PDF には欄があるが LocalRollCall に載っていない。既知）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  assert.equal(rcs.length, 104, "母数");
  assert.deepEqual(rcs.filter((r) => r.counts !== undefined).map((r) => r.id), [], "counts のある採決");
  assert.deepEqual(rcs.filter((r) => r.method !== undefined).map((r) => r.id), [], "method のある採決");
  assert.deepEqual(meta().countChecked, { checked: 0, noCounts: 104, rows: 104, unreadableCells: 0 });
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
test("#865 本番 pref-39: result の `〃`(U+3003) は 86 行に残り、date の `〃` は 0 行（日付だけ継いでいる）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  assert.equal(rcs.length, 104, "母数");
  assert.equal("〃".codePointAt(0), 0x3003, "`〃` DITTO MARK");
  // **日付は 104 行とも ISO**（`〃` も `″` も `”` も残っていない）
  assert.deepEqual(rcs.filter((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date)).map((r) => r.id), [], "日付の形");
  assert.deepEqual(rcs.filter((r) => /[〃″”]/.test(r.date)).map((r) => r.id), [], "日付に残った同上記号");
  // **議決日は 2 日**（会期と 1 対 1。会期 1 つに議決日 1 つ）
  const byKey = new Map<string, number>();
  for (const r of rcs) { const k = `${r.sessionId}|${r.date}`; byKey.set(k, (byKey.get(k) ?? 0) + 1); }
  assert.deepEqual(Object.fromEntries([...byKey].sort()), { "2026-02|2026-03-24": 81, "2026-06|2026-07-10": 23 });
  // **`result` の `〃` は 86 行、原文のまま残っている**（上の行から継いでいない）
  const ditto = rcs.filter((r) => r.result === "〃");
  assert.equal(ditto.length, 86, "`〃` の残った result");
  assert.deepEqual(
    Object.fromEntries([...new Set(ditto.map((r) => r.date))].sort().map((d) => [d, ditto.filter((r) => r.date === d).length])),
    { "2026-03-24": 70, "2026-07-10": 16 },
  );
  // **`result` の内訳**（`〃` を含めて 104 行を分類しきる。**`〃` を「原案可決」に読み替えていない**）
  const results = new Map<string, number>();
  for (const r of rcs) results.set(r.result, (results.get(r.result) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries([...results].sort()), { "〃": 86, "否決": 3, "原案可決": 11, "同意": 2, "承認": 2 });
  assert.equal([...results.values()].reduce((a, b) => a + b, 0), 104, "result の合計");
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
test("#865 本番 pref-39: `議` は 104 採決すべてで 1 人、会期ごとに 三石文隆 → 明神健夫", { skip: !hasData }, () => {
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
  assert.deepEqual(Object.fromEntries(perRollCall), { 1: 104 }, "採決ごとの `議` の数");
  assert.equal(ids.size, 2, `\`議\` が付く議員（${[...ids].sort().join(",")}）`);
  assert.ok(![...ids].includes(""), "議長が名簿に寄っている");
  assert.deepEqual(
    Object.fromEntries([...bySession].map(([k, v]) => [k, Object.fromEntries([...v].sort())]).sort()),
    { "2026-02": { "三石文隆": 81 }, "2026-06": { "明神健夫": 23 } },
  );
  // **`除` は 104 採決で 1 件だけ**（下村勝幸。その行で議長ではない）
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
test("#865 本番 pref-39: 36 人が氏名と 1 対 1、票の会派が名簿と 3,744 / 3,744 一致（人数 × 104 になる）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  const votes = rcs.flatMap((r) => r.votes);
  assert.equal(votes.length, 3_744, "母数");
  assert.deepEqual(JSON.parse(readFileSync(join(DIR, "unmatched.json"), "utf-8")), [], "unmatched.json");
  assert.deepEqual(votes.filter((v) => v.memberId === "").map((v) => v.nameText), [], "memberId が空の票");
  const idToNames = new Map<string, Set<string>>();
  const nameToIds = new Map<string, Set<string>>();
  for (const v of votes) {
    (idToNames.get(v.memberId) ?? idToNames.set(v.memberId, new Set()).get(v.memberId)!).add(v.nameText);
    (nameToIds.get(v.nameText) ?? nameToIds.set(v.nameText, new Set()).get(v.nameText)!).add(v.memberId);
  }
  assert.equal(idToNames.size, 36, "票に出る議員");
  assert.equal(nameToIds.size, 36, "票に出る氏名");
  assert.deepEqual([...idToNames].filter(([, s]) => s.size > 1).map(([k]) => k), [], "1 人に 2 通りの氏名");
  assert.deepEqual([...nameToIds].filter(([, s]) => s.size > 1).map(([k]) => k), [], "1 つの氏名が 2 人に");
  assert.deepEqual(rcs.filter((r) => new Set(r.votes.map((v) => v.memberId)).size !== r.votes.length).map((r) => r.id), [], "同じ採決に同じ議員が 2 回");
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
  const bad = votes.filter((v) => v.group !== rosterGroup.get(v.memberId));
  assert.deepEqual(bad.map((v) => `${v.nameText}: ${v.group} ≠ ${rosterGroup.get(v.memberId)}`), [], "票の会派と名簿の会派");
  // **会派ごとの票数が「人数 × 104」**
  const voteGroups = new Map<string, number>();
  for (const v of votes) voteGroups.set(v.group, (voteGroups.get(v.group) ?? 0) + 1);
  const memberGroups = new Map<string, number>();
  for (const m of kochi) memberGroups.set(m.group, (memberGroups.get(m.group) ?? 0) + 1);
  assert.deepEqual(
    Object.fromEntries([...voteGroups].sort()),
    Object.fromEntries([...memberGroups].sort().map(([g, n]) => [g, n * 104])),
  );
  assert.deepEqual(Object.fromEntries([...memberGroups].sort()), {
    "一燈立志の会": 2, "公明党": 3, "県民の会": 4, "自由の風": 1, "自由民主党": 20, "日本共産党": 6,
  });
  assert.equal([...memberGroups.values()].reduce((a, b) => a + b, 0), 36, "会派の内訳の合計");
  assert.deepEqual([...new Set(kochi.map((m) => m.counts?.rollcalls))], [104], "議員ごとの採決数");
});

/**
 * **出典はすべて `gikai.pref.kochi.lg.jp`**——**県庁本体（`www.pref.kochi.lg.jp`）ではない。**
 *
 * **ほかの 10 議会は `www.pref.<県>.lg.jp` なので、「`www.pref.` で始まる」という形の検算を
 * 写すと高知では嘘になる。** `KOCHI_HOST` をそのまま使う。
 */
test("#865 本番 pref-39: sourceUrl は 4 本すべて https://gikai.pref.kochi.lg.jp（www.pref.kochi.lg.jp ではない）", { skip: !hasData }, () => {
  const m = meta();
  const rcs = rollCalls();
  const urls = new Set<string>();
  for (const rc of rcs) urls.add(rc.sourceUrl);
  for (const s of m.sources) urls.add(s.url);
  for (const s of m.sessions) { urls.add(s.sourceUrl); if (s.pdfUrl) urls.add(s.pdfUrl); for (const p of s.pdfUrls ?? []) urls.add(p); }
  assert.equal(urls.size, 4, "**突き合わせた URL の本数**（0 本を見て緑にならないように）");
  assert.deepEqual([...urls].filter((u) => new URL(u).host !== KOCHI_HOST || new URL(u).protocol !== "https:"), [], "公式ホストでない URL");
  assert.equal(KOCHI_HOST, "gikai.pref.kochi.lg.jp");
  assert.deepEqual([...urls].filter((u) => new URL(u).host === "www.pref.kochi.lg.jp"), [], "県庁本体のホストの URL");
  // **採決の出典は 2 本の PDF**（会期ごとに 1 本ずつ）
  const pdfs = new Map<string, number>();
  for (const r of rcs) pdfs.set(r.sourceUrl, (pdfs.get(r.sourceUrl) ?? 0) + 1);
  assert.equal(pdfs.size, 2, "採決の出典 PDF");
  assert.deepEqual([...pdfs.values()].sort((a, b) => b - a), [81, 23], "PDF ごとの採決数");
  assert.equal([...pdfs.values()].reduce((a, b) => a + b, 0), 104, "合計");
  assert.deepEqual([...pdfs.keys()].filter((u) => !u.endsWith(".pdf")), [], "PDF でない出典");
  // **会期は 2 本、内訳は 81 + 23 = 104**
  assert.deepEqual(m.sessions.map((s) => [s.sessionId, s.rollcalls]).sort(), [["2026-02", 81], ["2026-06", 23]]);
  assert.equal(m.sessions.reduce((s, x) => s + (x.rollcalls ?? 0), 0), 104, "会期ごとの採決数の合計");
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
