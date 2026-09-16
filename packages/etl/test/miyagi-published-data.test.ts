import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { LocalAssemblyMeta, LocalMember, LocalRollCall, LocalUnmatchedName } from "@seiji-kiroku/shared";
import { MIYAGI_HOST } from "../src/sources/local/miyagi/site.ts";

/**
 * **本番 `data/assemblies/pref-04/` に出したものを、出した後から読み直して数える**（Issue #865）。
 *
 * **`votes-pdf.ts` のテストは PDF を読む側を見ている。ここは「書いたもの」を見る。**
 * **同じ実装で 2 回測っているのではない**——**`data/` の JSON を読み直しているので、
 * 書き出し（`buildLocalAssembly` / `writeLocalAssembly`）が壊れたらここが落ちる。**
 *
 * **#864 の `published-data-validate.test.ts` とは重ならない。** あちらは**全県まとめて構造の
 * 不変条件**を見る（index と原本の対応・`assemblyId`・`by-assembly.json` の集計）。
 * **ここが見るのは、共通の検査が原理的に知らない「宮城の中身」**——
 * **`議` が誰か・○ の数が公表値と合うか・会期をまたいで消えた氏名は誰か。**
 *
 * **母数を毎回出す**（#757）。**「違反 0 件」と「1 件も見ていない」を区別できる形で書く。**
 */
const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));
const DIR = join(DATA, "assemblies", "pref-04");

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
  (JSON.parse(readFileSync(join(DATA, "members", "index.json"), "utf-8")) as LocalMember[]).filter((m) => m.assemblyId === "pref-04");

test("#865 本番 pref-04: 採決 133 × 議員 56 = 7,448 セル、不明セル 0", { skip: !hasData }, () => {
  const m = meta();
  const rcs = rollCalls();
  // **実測 2026-09-14**（直近 2 会期。第399回（令和8年2月定）110 本 + 第400回（令和8年6月定）23 本）
  assert.equal(m.counts.rollcalls, 133);
  assert.equal(m.counts.members, 56);
  assert.equal(m.counts.cells, 7_448);
  assert.equal(m.counts.unknownCells, 0, "**推定せず `不明` で残したセルは 0**");
  assert.equal(m.counts.unmatchedNames, 1);
  // **meta の数が、書いた実物と一致する**（meta だけを書き換えても落ちる）
  assert.equal(rcs.length, m.counts.rollcalls, "rollcalls/ の実ファイル数");
  assert.equal(rcs.reduce((s, r) => s + r.votes.length, 0), m.counts.cells, "票の実数");
  // **133 × 56 の長方形**（どの採決も 56 人ぶん。**1 人静かに落ちても合計は合ってしまう**ので行ごとに見る）
  assert.deepEqual([...new Set(rcs.map((r) => r.votes.length))], [56], "採決ごとの票数");
  assert.equal(133 * 56, 7_448, "長方形であることの検算（母数を式で残す）");
});

/**
 * **票の値と凡例**（**凡例に無い値が出ていない**）。
 * **`抽出不能` が 0 であることを、母数つきで言う**——**0 でも数える**のは、
 * **「凡例に無い記号が混ざり始めた」ことに増えてから気づけるようにするため**（#750 と同じ理由）。
 */
test("#865 本番 pref-04: 票 7,448 の内訳（○ 7155 / × 154 / 議 133 / － 5 / 欠 1）", { skip: !hasData }, () => {
  const votes = rollCalls().flatMap((r) => r.votes);
  assert.equal(votes.length, 7_448, "母数（減っていたら以下の内訳は意味が無い）");
  const raw = new Map<string, number>();
  const legend = new Map<string, number>();
  for (const v of votes) {
    raw.set(v.value.raw, (raw.get(v.value.raw) ?? 0) + 1);
    legend.set(v.value.legend, (legend.get(v.value.legend) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries([...raw].sort((a, b) => b[1] - a[1])), { "○": 7155, "×": 154, "議": 133, "－": 5, "欠": 1 });
  // **`－`(U+FF0D) は「議場に不在」**——**「欠席」と別の事実**なので畳まない（#569）
  assert.deepEqual(Object.fromEntries([...legend].sort((a, b) => b[1] - a[1])),
    { "賛成": 7155, "反対": 154, "議長": 133, "議場に不在": 5, "欠席": 1 });
  assert.equal(raw.get("不明"), undefined, "`不明` の票");
  assert.equal(legend.get("抽出不能"), undefined, "`抽出不能` の票");
  // **`mapped` が付かない票が 0**（凡例の意味が全部 `MAPPED` に載っている）
  assert.deepEqual(votes.filter((v) => v.value.mapped === undefined), []);
  assert.deepEqual(Object.fromEntries([...votes.reduce((m2, v) => m2.set(v.value.mapped!, (m2.get(v.value.mapped!) ?? 0) + 1), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1])), { "賛成": 7155, "反対": 154, "投票なし": 139 });
});

/**
 * ## **`議` は全 133 採決でちょうど 1 人で、2 会期とも同じ 1 人**
 *
 * **「議長は 1 人」は当たり前に見えるが、当たり前ではない。**
 * **奈良（pref-29）では同じ PDF の中で 2 行だけ `議` が別人に移る**（副知事・監査委員の選任。
 * `nara-published-data.test.ts`）。**三重（pref-24）では会議年度の切り替わりで議長が代わる。**
 * **宮城は 133 / 133 本で同じ 1 人**——**これは県ごとに違う事実であって、共通の検査には書けない。**
 *
 * **ただし「議長は採決に加わらない」と決め打ちしない**——**実装は PDF の記号をそのまま読む。**
 * **`議` が 0 人の行が出たら、それはそう印刷されていたということ**（#615 が秋田で実測）。
 */
test("#865 本番 pref-04: `議` は全 133 採決で 1 人、2 会期とも 佐々木幸士", { skip: !hasData }, () => {
  const rcs = rollCalls();
  const perRollCall = new Map<number, number>();
  const bySession = new Map<string, Map<string, number>>();
  for (const rc of rcs) {
    const gi = rc.votes.filter((v) => v.value.raw === "議");
    perRollCall.set(gi.length, (perRollCall.get(gi.length) ?? 0) + 1);
    for (const v of gi) {
      assert.equal(v.value.legend, "議長", `${rc.id}`);
      assert.equal(v.value.mapped, "投票なし", `${rc.id}`);
      const s = bySession.get(rc.sessionId) ?? new Map<string, number>();
      s.set(v.nameText, (s.get(v.nameText) ?? 0) + 1);
      bySession.set(rc.sessionId, s);
    }
  }
  assert.deepEqual(Object.fromEntries(perRollCall), { 1: 133 }, "採決ごとの `議` の数（母数 133）");
  assert.deepEqual(
    Object.fromEntries([...bySession].map(([k, v]) => [k, Object.fromEntries(v)]).sort()),
    { "399": { "佐々木幸士": 110 }, "400": { "佐々木幸士": 23 } },
    "**会期ごとに `議` が誰で何本か**（列がずれれば別人になる）",
  );
  // **`議` が付く議員は 1 人だけ**（名簿にも寄っている＝空の memberId ではない）
  const ids = new Set(rcs.flatMap((r) => r.votes.filter((v) => v.value.raw === "議").map((v) => v.memberId)));
  assert.deepEqual([...ids], ["p_04_kosi"], "`議` の memberId");
});

/**
 * **PDF 自身が印刷している集計（`counts`）と、抽出した票の意味が合う。**
 * **宮城は 133 / 133 本すべてに `counts` がある**（奈良は 0 / 125 本、滋賀は読めない行が 4 本ある）。
 *
 * **これは「氏名の列が正しい」証明ではない**（数だけ。1 列ずらしても数は合う——#743 が実測）。
 * **順序の検算は `miyagi-votes-pdf.test.ts` が受け持つ。**
 * **ここで言えるのは「記号を落としても増やしてもいない」こと。**
 */
test("#865 本番 pref-04: 賛成の数 = counts.yes / 反対の数 = counts.no（133 / 133 本すべてに counts がある）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  assert.equal(rcs.length, 133, "母数");
  let checked = 0;
  for (const rc of rcs) {
    assert.ok(rc.counts, `${rc.id}: counts が無い`);
    assert.equal(rc.votes.filter((v) => v.value.mapped === "賛成").length, rc.counts!.yes, `${rc.id}: 賛成`);
    assert.equal(rc.votes.filter((v) => v.value.mapped === "反対").length, rc.counts!.no, `${rc.id}: 反対`);
    checked++;
  }
  assert.equal(checked, 133, "**突き合わせた採決の数**（0 件を「違反なし」と読み違えないため）");
  // **meta の母数も同じことを言っている**（#757。`countChecked` は `countMismatchesOf` が数える）
  assert.deepEqual(meta().countChecked, { rows: 133, checked: 133, noCounts: 0, unreadableCells: 0 });
  assert.equal(meta().countMismatches, undefined, "食い違いが無ければ省略される");
});

/**
 * ## **未突合 1 件は `中島 源陽`——理由は省略（＝名簿に無い氏名）**
 *
 * **`sourceConflict`（字が 1 つ違う）でも `brokenGlyph`（字が壊れている）でもない。**
 * **名簿（`rosterAsOf` 2026-04-23）にこの氏名が無い**——**理由が違えば、運用者が次にすることも違う**（#680／#711）。
 *
 * **事実として言えるのはここまで**（#796。**氏名が近いだけで同一人物と書かない**）:
 *   - **`中島 源陽` は第399回（令和8年2月定）の 110 本すべてに出て、第400回には 1 本も出ない。**
 *   - **`鈴木 敦`（名簿にいる）は第400回の 23 本すべてに出て、第399回には 1 本も出ない。**
 * **「入れ替わった」とはこのテストでは書かない**——**一次資料が言っているのは出欠の範囲だけである。**
 *
 * **票そのものは残っている**（`memberId` が空なだけ。「記録が出ない」にしていない）。
 */
test("#865 本番 pref-04: 未突合 1 件（中島 源陽・理由の記載なし）と、会期ごとに出る氏名の差", { skip: !hasData }, () => {
  const um = JSON.parse(readFileSync(join(DIR, "unmatched.json"), "utf-8")) as LocalUnmatchedName[];
  assert.deepEqual(um.map((u) => ({ name: u.nameText, reason: u.reason, group: u.group, rollCalls: u.rollCallIds.length })), [
    { name: "中島 源陽", reason: undefined, group: "自由民主党・県民会議", rollCalls: 110 },
  ]);
  assert.equal(meta().counts.unmatchedNames, 1);

  const rcs = rollCalls();
  // **memberId が空の票は 110**（1 人 × 110 本。**それ以外の 7,338 票は名簿に寄っている**）
  const orphan = rcs.flatMap((r) => r.votes).filter((v) => v.memberId === "");
  assert.equal(orphan.length, 110, "母数 7,448 のうち名簿に寄らなかった票");
  assert.deepEqual([...new Set(orphan.map((v) => v.nameText))], ["中島 源陽"]);
  assert.deepEqual(orphan.filter((v) => v.value.mapped === undefined), [], "寄らなくても票は読めている");

  // **会期ごとに出る氏名の集合**（56 人ずつで、差は 1 人だけ）
  const bySession = new Map<string, Set<string>>();
  for (const r of rcs) {
    const s = bySession.get(r.sessionId) ?? new Set<string>();
    for (const v of r.votes) s.add(v.nameText);
    bySession.set(r.sessionId, s);
  }
  const s399 = bySession.get("399")!;
  const s400 = bySession.get("400")!;
  assert.equal(s399.size, 56);
  assert.equal(s400.size, 56);
  assert.deepEqual([...s399].filter((n) => !s400.has(n)), ["中島 源陽"], "399 にだけ出る氏名");
  assert.deepEqual([...s400].filter((n) => !s399.has(n)), ["鈴木 敦"], "400 にだけ出る氏名");
  // **名簿側でも同じ形**——**`鈴木 敦` の採決数は 23**（400 の本数）で、ほかの 55 人は 133
  const ms = members();
  assert.equal(ms.length, 56);
  assert.deepEqual(
    Object.fromEntries([...ms.reduce((m2, m) => m2.set(m.counts?.rollcalls ?? -1, (m2.get(m.counts?.rollcalls ?? -1) ?? 0) + 1), new Map<number, number>())].sort()),
    { 23: 1, 133: 55 },
    "名簿の議員ごとの採決数",
  );
  assert.deepEqual(ms.filter((m) => m.counts?.rollcalls === 23).map((m) => m.name), ["鈴木 敦"]);
});

/** **出典はすべて県の公式ホスト**（`validateLocalAssemblies` も見るが、**本数と PDF の数もここで固定する**）。 */
test("#865 本番 pref-04: sourceUrl はすべて www.pref.miyagi.jp（採決 133 本 + meta の 6 出典 + 会期 2 本）", { skip: !hasData }, () => {
  const m = meta();
  const rcs = rollCalls();
  const urls: string[] = [];
  for (const rc of rcs) urls.push(rc.sourceUrl);
  for (const s of m.sources) urls.push(s.url);
  for (const s of m.sessions) { urls.push(s.sourceUrl); urls.push(s.pdfUrl); for (const p of s.pdfUrls ?? []) urls.push(p); }
  assert.equal(urls.length, 133 + 6 + 2 * 2, "**見た URL の本数**（0 本を「違反なし」と読み違えないため）");
  const bad = urls.filter((u) => new URL(u).host !== MIYAGI_HOST || new URL(u).protocol !== "https:");
  assert.deepEqual([...new Set(bad)], []);
  // **採決の出典は 2 本の PDF だけ**（会期ごとに 1 本）
  assert.deepEqual([...new Set(rcs.map((r) => r.sourceUrl))].sort(), [
    "https://www.pref.miyagi.jp/documents/63622/syuusei_hyouketsu080318.pdf",
    "https://www.pref.miyagi.jp/documents/65634/hyoketu080707.pdf",
  ]);
  assert.equal(m.sources.filter((s) => s.url.endsWith(".pdf")).length, 2, "出典の PDF");
  assert.equal(m.unreadableSources, undefined, "読めなかった一次資料は無い（省略される）");
  assert.equal(m.lossyNameMatches, undefined, "字が落ちた氏名の寄せは無い（省略される）");
  assert.equal(m.rosterAsOf, "2026-04-23");
});

/**
 * **名簿 56 人**——**かな・選挙区・会派が全員に埋まっている**（#632 の検算が効く議会。秋田は かな が空）。
 * **全員が採決に出ている**（`counts.rollcalls` が 0 の議員がいない。#718）。
 */
test("#865 本番 pref-04: 名簿 56 人（かな・選挙区・会派が全員にある）", { skip: !hasData }, () => {
  const ms = members();
  assert.equal(ms.length, 56, "母数");
  assert.deepEqual(ms.filter((m) => m.kana === "").map((m) => m.name), [], "かなが空の議員");
  assert.deepEqual(ms.filter((m) => m.district === "").map((m) => m.name), [], "選挙区が空の議員");
  assert.deepEqual(ms.filter((m) => m.group === "").map((m) => m.name), [], "会派が空の議員");
  assert.deepEqual(ms.filter((m) => (m.counts?.rollcalls ?? 0) === 0).map((m) => m.name), [], "採決 0 件の議員");
  assert.deepEqual(ms.filter((m) => !m.profileUrl.startsWith(`https://${MIYAGI_HOST}/`)).map((m) => m.name), [], "別ホストの profileUrl");
  assert.equal(new Set(ms.map((m) => m.id)).size, 56, "id の重複");
  // **票に出る memberId は 56 通り**（空の 1 通りを除く。名簿と同じ人数）
  const seen = new Set(rollCalls().flatMap((r) => r.votes.map((v) => v.memberId)));
  seen.delete("");
  assert.equal(seen.size, 56, `票に出る議員（${seen.size} 人）`);
});
