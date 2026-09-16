import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { LocalAssemblyMeta, LocalMember, LocalRollCall } from "@seiji-kiroku/shared";
import { TOTTORI_HOST } from "../src/sources/local/tottori/site.ts";

/**
 * **本番 `data/assemblies/pref-31/` に出したものを、出した後から読み直して数える**（Issue #865）。
 *
 * **`votes-pdf.ts` のテストは PDF を読む側を見ている。ここは「書いたもの」を見る。**
 * **`data/` の JSON を読み直しているので、書き出し（`buildLocalAssembly` / `writeLocalAssembly`）が
 * 壊れたらここが落ちる。**
 *
 * ## **鳥取で何を主張するか**——**他県から写していない**
 *
 * **鳥取だけにある形が 3 つある**（実測 2026-09-14。他の 10 議会には無い）:
 *
 * 1. **`counts.voting`（表決者数）が 118 / 118 行にある。** 佐賀・島根は `yes` / `no` だけ、
 *    徳島・高知は `counts` そのものが無い。**「表決した人数」が PDF に印刷されている議会は鳥取だけ。**
 * 2. **PDF の氏名が姓だけ（「入江議員」）。** ほかの 10 議会はフルネームである。
 *    だから鳥取だけ `matchBySurnamePrefix` を使う（`tottori/rollcalls.ts` の docblock）。
 * 3. **`棄`（棄権）が 3 票あり、`mapped` が付かない。** 凡例は「棄権」だが、
 *    **賛成にも反対にも投票なしにも対応づけない**（`tottori/rollcalls.ts` の `MAPPED`:
 *    「棄権は対応づけない」）。**その結果、共通層の員数の検算はその 1 行を飛ばす**
 *    （`meta.countChecked.unreadableCells` が 1）。
 *
 * **3. は「共通の検査が原理的に見ない 1 行」である**——`local-assemblies.ts` の
 * `countRollCalls` が `rc.votes.some((v) => v.value.mapped === undefined)` で `continue` する。
 * **ここでは `mapped` ではなく `raw` の記号を数えるので、その 1 行も突き合わせる。**
 */
const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));
const DIR = join(DATA, "assemblies", "pref-31");

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

test("#865 本番 pref-31: 採決 118 × 議員 35 = 4,130 セル、抽出不能 0.00%", { skip: !hasData }, () => {
  const m = meta();
  const rcs = rollCalls();
  // **実測 2026-09-14**（直近 2 会期。月次のワークフローは既定の `--sessions 2` で回る）
  assert.equal(m.counts.rollcalls, 118);
  assert.equal(m.counts.members, 35);
  assert.equal(m.counts.cells, 4_130);
  assert.equal(m.counts.unknownCells, 0, "**推定せず残した不明セルは 0**");
  assert.equal(m.counts.unmatchedNames, 0, "**名簿に寄らなかった氏名は 0**");
  // **meta の数が、書いた実物と一致する**（meta だけを書き換えても落ちる）
  assert.equal(rcs.length, m.counts.rollcalls, "rollcalls/ の実ファイル数");
  assert.equal(rcs.reduce((s, r) => s + r.votes.length, 0), m.counts.cells, "票の実数");
  // **118 行とも 35 セルちょうど**（会期の途中で議員が 1 人静かに消えていない。#705 が滋賀で踏んだ形）
  const perRow = new Map<number, number>();
  for (const r of rcs) perRow.set(r.votes.length, (perRow.get(r.votes.length) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries(perRow), { 35: 118 }, "採決ごとのセル数");
  // **`抽出不能` / `不明` の票は 0**（読めなかったセルを推定で埋めていない）
  assert.equal(rcs.reduce((s, r) => s + r.votes.filter((v) => v.value.legend === "抽出不能").length, 0), 0, "`抽出不能` の票");
  assert.equal(rcs.reduce((s, r) => s + r.votes.filter((v) => v.value.raw === "不明").length, 0), 0, "`不明` の票");
});

/**
 * **票の内訳**（`data/` を読み直して数えた。**4,130 セルすべてを 4 つの記号に分類しきる**）。
 *
 * **`棄` 3 票に `mapped` が無いことを、ここで固定する**——
 * **これは欠陥ではなく設計である**（`tottori/rollcalls.ts`: 「棄権は対応づけない」）。
 * **`mapped` を付けると「投票なし」に丸めることになり、`賛成`/`反対`/`投票なし` の
 * どれでもない「棄権した」という事実が消える**（#569 の「推定しない」）。
 * **逆に、誰かが「投票なし」を足したらここが落ちる。**
 */
test("#865 本番 pref-31: 票の内訳 ○3814 / ×195 / 議118 / 棄3（棄権だけ mapped が付かない）", { skip: !hasData }, () => {
  const votes = rollCalls().flatMap((r) => r.votes);
  assert.equal(votes.length, 4_130, "母数（減っていたらこの内訳は意味が無い）");
  const raw = new Map<string, number>();
  const legend = new Map<string, number>();
  for (const v of votes) {
    raw.set(v.value.raw, (raw.get(v.value.raw) ?? 0) + 1);
    legend.set(v.value.legend, (legend.get(v.value.legend) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries([...raw].sort()), { "×": 195, "○": 3814, "棄": 3, "議": 118 });
  assert.deepEqual(Object.fromEntries([...legend].sort()), { "反対": 195, "棄権": 3, "議長": 118, "賛成": 3814 });
  // **`mapped` が付かないのは `棄` の 3 票だけ**（ほかの 4,127 票は全部付く）
  const unmapped = votes.filter((v) => v.value.mapped === undefined);
  assert.deepEqual([...new Set(unmapped.map((v) => v.value.raw))], ["棄"], "mapped が無い票の記号");
  assert.equal(unmapped.length, 3, "mapped が無い票の数");
  // **凡例に無い値に落ちていない**（`賛成` / `反対` / `投票なし` の 3 つだけ）
  assert.deepEqual(
    [...new Set(votes.map((v) => v.value.mapped).filter((x) => x !== undefined))].sort(),
    ["反対", "投票なし", "賛成"],
  );
});

/**
 * ## **`counts.voting`（表決者数）と、記号の数が 3 通りで合う**——**鳥取にしかない検算**
 *
 * **PDF に「賛成者数・反対者数・表決者数」の 3 欄がある。** ほかの 10 議会には `voting` が無い。
 *
 * **「`○` の数 = `counts.yes`」だけなら他県と同じだが、`voting` があると 1 本余分に締まる**——
 * **`35 −（賛成でも反対でもない票）= voting`。**
 * **議長 1 人＋棄権 3 人が抜けた行で、その 3 人が本当に抜けていることまで見る**
 * （実測: `voting` は 117 行で 34、**棄権のある 1 行だけ 31**）。
 *
 * **ここが共通層と違う点**: `local-assemblies.ts` の `countRollCalls` は
 * **`mapped` が付かない票が 1 つでもある行を飛ばす**ので、**棄権のある 1 行を一度も突き合わせない**
 * （`meta.countChecked` が `checked: 117 / rows: 118 / unreadableCells: 1` と自分で言っている）。
 * **ここでは `raw` の記号を数えるので、118 / 118 行を突き合わせる。**
 */
test("#865 本番 pref-31: ○=yes / ×=no / 35−非表決=voting を 118 行すべてで（共通層が飛ばす 1 行を含む）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  assert.equal(rcs.length, 118, "母数");
  let checked = 0;
  const votingSeen = new Map<number, number>();
  for (const rc of rcs) {
    assert.ok(rc.counts, `${rc.id}: counts がある`);
    const yes = rc.votes.filter((v) => v.value.raw === "○").length;
    const no = rc.votes.filter((v) => v.value.raw === "×").length;
    assert.equal(yes, rc.counts!.yes, `${rc.id}: ○ の数 = counts.yes`);
    assert.equal(no, rc.counts!.no, `${rc.id}: × の数 = counts.no`);
    // `LocalRollCall["counts"]` は yes/no/voting を持つ（voting は任意）。鳥取は 118 行とも入っている
    const voting = (rc.counts as { voting?: number }).voting;
    assert.equal(typeof voting, "number", `${rc.id}: counts.voting がある`);
    const nonVoting = rc.votes.filter((v) => v.value.mapped !== "賛成" && v.value.mapped !== "反対").length;
    assert.equal(rc.votes.length - nonVoting, voting, `${rc.id}: 35 − 非表決 = counts.voting`);
    assert.equal(yes + no, voting, `${rc.id}: ○ + × = counts.voting`);
    votingSeen.set(voting!, (votingSeen.get(voting!) ?? 0) + 1);
    checked++;
  }
  assert.equal(checked, 118, "**118 行すべてを突き合わせた**（母数が減ったらこの検算は空回りする）");
  // **共通層は 117 行しか見ていない**（`棄` のある 1 行を飛ばしている）。**ここはその 1 行も見た**
  assert.deepEqual(meta().countChecked, { checked: 117, noCounts: 0, rows: 118, unreadableCells: 1 });
  // **表決者数は 34（議長を除く 34 人）が 117 行、棄権 3 人が抜けた 1 行だけ 31**
  assert.deepEqual(Object.fromEntries([...votingSeen].sort()), { 31: 1, 34: 117 });
});

/**
 * ## **`議` は全 118 採決で 1 人、しかも 2 会期を通して同じ 1 人**
 *
 * **「議長は 1 人」は当たり前に見えるが、当たり前ではない**——
 * **青森（#748）は 55 本中 2 本で会期の途中に議長が交代し、`議` が 2 つの列に立った。**
 * **島根（pref-32）は本番データの中で実際に交代している**（2026-07-02 に 高橋雅彦 → 山根成二）。
 * **鳥取は 118 / 118 本で同じ 1 人である。**
 *
 * **これは順序（k 番目のセルが k 番目の議員）の証明ではない**（#743 が「1 行に `議` は高々 1 個」が
 * 恒真であることを実測している）。**順序の検算は `tottori-votes-pdf.test.ts` にある。**
 * **ここで言えるのは「議長の列が会期の途中で動いていない」ことだけである。**
 */
test("#865 本番 pref-31: `議` は 118 採決すべてで 1 人、2 会期とも同じ議員（福田議員）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  const perRollCall = new Map<number, number>();
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const rc of rcs) {
    const gi = rc.votes.filter((v) => v.value.raw === "議");
    perRollCall.set(gi.length, (perRollCall.get(gi.length) ?? 0) + 1);
    for (const v of gi) { ids.add(v.memberId); names.add(v.nameText); assert.equal(v.value.legend, "議長"); assert.equal(v.value.mapped, "投票なし"); }
  }
  assert.deepEqual(Object.fromEntries(perRollCall), { 1: 118 }, "採決ごとの `議` の数");
  assert.equal(ids.size, 1, `\`議\` が付く議員（${[...ids].join(",")}）`);
  assert.deepEqual([...names], ["福田議員"], "PDF に出る議長の氏名（姓だけ）");
  assert.ok(![...ids].includes(""), "議長が名簿に寄っている");
});

/**
 * ## **姓だけの氏名が 35 人ぶん、1 対 1 で名簿に寄っている**——**鳥取にしかない機序**
 *
 * **PDF の氏名は「入江議員」のように姓だけ**（同姓は「浜田一議員」のように名の 1 文字付き）。
 * **前方一致でちょうど 1 人に決まるときだけ寄せる**（`tottori/rollcalls.ts`）。
 * **0 人・2 人以上なら寄せずに `unmatched.json` に載せる**——**実測 0 件。**
 *
 * **ここで見るのは「1 対 1 であること」である**（#796: 氏名が一致するだけでは同一人物と書かない）。
 * **1 つの `memberId` に 2 通りの氏名が付いたら、どこかで別人に寄せている。**
 * **逆に 1 つの氏名が 2 つの `memberId` に付いたら、同じ人が 2 人に割れている。**
 */
test("#865 本番 pref-31: 35 人が姓だけの氏名と 1 対 1（未突合 0、票に空の memberId が無い）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  const votes = rcs.flatMap((r) => r.votes);
  assert.equal(votes.length, 4_130, "母数");
  assert.deepEqual(JSON.parse(readFileSync(join(DIR, "unmatched.json"), "utf-8")), [], "unmatched.json");
  assert.deepEqual(votes.filter((v) => v.memberId === "").map((v) => v.nameText), [], "memberId が空の票");
  // **`memberId` ↔ `nameText` が 1 対 1**
  const idToNames = new Map<string, Set<string>>();
  const nameToIds = new Map<string, Set<string>>();
  for (const v of votes) {
    (idToNames.get(v.memberId) ?? idToNames.set(v.memberId, new Set()).get(v.memberId)!).add(v.nameText);
    (nameToIds.get(v.nameText) ?? nameToIds.set(v.nameText, new Set()).get(v.nameText)!).add(v.memberId);
  }
  assert.equal(idToNames.size, 35, "票に出る議員");
  assert.equal(nameToIds.size, 35, "票に出る氏名");
  assert.deepEqual([...idToNames].filter(([, s]) => s.size > 1).map(([k]) => k), [], "1 人に 2 通りの氏名");
  assert.deepEqual([...nameToIds].filter(([, s]) => s.size > 1).map(([k]) => k), [], "1 つの氏名が 2 人に");
  // **同じ採決の中に同じ議員が 2 回出ない**（列がずれて同じ人を 2 度数えていない）
  assert.deepEqual(rcs.filter((r) => new Set(r.votes.map((v) => v.memberId)).size !== r.votes.length).map((r) => r.id), []);
  // **PDF の「○○議員」が、名簿の氏名（空白を除く）の前方に本当に載っている**
  const index = JSON.parse(readFileSync(join(DATA, "members", "index.json"), "utf-8")) as LocalMember[];
  const roster = new Map(index.filter((m) => m.assemblyId === "pref-31").map((m) => [m.id, m.name.replace(/[\s　]/g, "")]));
  assert.equal(roster.size, 35, "名簿");
  let matched = 0;
  for (const [id, names] of idToNames) {
    const full = roster.get(id);
    assert.ok(full !== undefined, `${id} が名簿に居る`);
    const surname = [...names][0].replace(/議員$/, "");
    assert.ok(surname.length >= 1, `${id}: 「議員」を除いた姓が空`);
    assert.ok(full!.startsWith(surname), `${id}: 名簿「${full}」が PDF「${surname}」で始まっていない`);
    matched++;
  }
  assert.equal(matched, 35, "**35 人すべてを名簿と突き合わせた**");
  // **全員が 118 件すべてに出る**（誰かが一部の採決から静かに落ちていない）
  const tottori = index.filter((m) => m.assemblyId === "pref-31");
  assert.deepEqual([...new Set(tottori.map((m) => m.counts?.rollcalls))], [118], "議員ごとの採決数");
});

/** **出典はすべて県議会の公式ホスト**（`validateLocalAssemblies` も見るが、値をここでも固定する）。 */
test("#865 本番 pref-31: sourceUrl は 12 本すべて https://www.pref.tottori.lg.jp", { skip: !hasData }, () => {
  const m = meta();
  const urls = new Set<string>();
  for (const rc of rollCalls()) urls.add(rc.sourceUrl);
  for (const s of m.sources) urls.add(s.url);
  for (const s of m.sessions) { urls.add(s.sourceUrl); if (s.pdfUrl) urls.add(s.pdfUrl); for (const p of s.pdfUrls ?? []) urls.add(p); }
  assert.equal(urls.size, 12, "**突き合わせた URL の本数**（0 本を見て緑にならないように）");
  const bad = [...urls].filter((u) => new URL(u).host !== TOTTORI_HOST || new URL(u).protocol !== "https:");
  assert.deepEqual(bad, [], "公式ホストでない URL");
  // **会期は 2 本、内訳は 30 + 88 = 118**
  assert.deepEqual(m.sessions.map((s) => [s.sessionId, s.rollcalls]).sort(), [["2026-02", 88], ["2026-06", 30]]);
  assert.equal(m.sessions.reduce((s, x) => s + (x.rollcalls ?? 0), 0), 118, "会期ごとの採決数の合計");
  // **全部の採決に日付・件名がある**（名や日付の無い記録を出さない）
  const rcs = rollCalls();
  assert.deepEqual(rcs.filter((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date)).map((r) => r.id), [], "日付の形");
  assert.deepEqual(rcs.filter((r) => r.title === "").map((r) => r.id), [], "件名が空の採決");
  assert.equal(new Set(rcs.map((r) => r.id)).size, rcs.length, "id の重複");
});

/** **名簿 35 人に kana / district / group が揃っている**（#632 の検算が効く議会）。 */
test("#865 本番 pref-31: 35 人全員に kana・選挙区・会派がある", { skip: !hasData }, () => {
  const index = JSON.parse(readFileSync(join(DATA, "members", "index.json"), "utf-8")) as LocalMember[];
  const tottori = index.filter((m) => m.assemblyId === "pref-31");
  assert.equal(tottori.length, 35, "母数");
  assert.deepEqual(tottori.filter((m) => m.kana === "").map((m) => m.name), [], "かなの無い議員");
  assert.deepEqual(tottori.filter((m) => m.district === "").map((m) => m.name), [], "選挙区の無い議員");
  assert.deepEqual(tottori.filter((m) => m.group === "").map((m) => m.name), [], "会派の無い議員");
  // **会派の内訳**（実測 2026-09-14。合計が 35 に戻ることまで見る）
  const groups = new Map<string, number>();
  for (const m of tottori) groups.set(m.group, (groups.get(m.group) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries([...groups].sort()), { "公明党": 3, "民主とっとり": 6, "無所属": 7, "自由民主党": 19 });
  assert.equal([...groups.values()].reduce((a, b) => a + b, 0), 35, "会派の内訳の合計");
  // **名簿の日付**（`rosterAsOf` は一覧ページが自分で書いている日付。ここが古いままなら一次資料が動いていない）
  assert.equal(meta().rosterAsOf, "2023-04-30");
});
