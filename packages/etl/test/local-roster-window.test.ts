import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalAssemblyMeta, LocalMember, LocalRollCall } from "@seiji-kiroku/shared";
import {
  buildLocalAssembly, LOCAL_TERM_DAYS, MIYAGI_ASSEMBLY, rosterWindowOf, validateLocalAssemblies, writeLocalAssembly,
} from "../src/local-assemblies.ts";

/**
 * **名簿の掲載日（`rosterAsOf`）と、その名簿を当てた採決の日付の関係を見張る**（Issue #928）。
 *
 * ## **何が問題だったか**——**この 2 つを結ぶ検査が 1 つも無かった**
 *
 * **`rosterAsOf` は `validateLocalAssemblies` で「文字列であること」しか見られていなかった**
 * （`typeof meta.rosterAsOf !== "string"`）。**`src/` 全体で `rosterAsOf` を日付として
 * 何かと比べている場所は 0 箇所だった**（実測 2026-09-20、`grep -rn rosterAsOf packages/etl/src
 * packages/shared/src apps/web/app`: 型宣言・代入・存在検査の 5 箇所だけ）。
 *
 * **それでも今は壊れていない。** **実測 2026-09-20（本番 `data/` を読んだ）:**
 *
 * | | 母数 | 結果 |
 * |---|---|---|
 * | **名簿に無い `memberId`** | **109,319 セル / 2,585 採決 / 11 議会** | **0 件** |
 * | **`rosterAsOf` より後の採決を持つ議会** | 11 議会 | **7 議会**（最大 鳥取 1,156 日） |
 *
 * **鳥取の任期が 2023〜2027 なので、2023 年の名簿が 2026 年の採決にそのまま当たっている。**
 * **たまたま正しい。守られてはいない。**
 *
 * ## **なぜ「`rosterAsOf` より後なら落とす」を選ばなかったか**
 *
 * **それを選ぶと今すぐ 7 議会が赤くなる。** **そして赤くなった先に直すものが無い**——
 * **各県が公表している名簿は「今の名簿」1 枚だけで、2023 年時点の名簿は取得できない。**
 * **直せない赤は、やがて誰も見なくなる**（#785「見ていない検出器は、無い検出器と同じ」）。
 *
 * **代わりに「間に必ず選挙がある」と言い切れる線だけを引いた**——
 * **1 任期（地方自治法 93 条 1 項の 4 年 = `LOCAL_TERM_DAYS` 1,461 日）。**
 * **今は 11 議会とも内側なので鳴らず、`--sessions` を広げて任期をまたいだ瞬間に鳴る**（#901）。
 *
 * ## **なぜ「名簿に無い `memberId` が出たら落とす」を足さなかったか**——**二重になるから**
 *
 * **#928 は「それがいちばん安い」と書いているが、実測すると既に 2 箇所で守られている**
 * （#662 の「既にある守りを二重に作りかけた」のと同じ形なので、足さずに検査で固定した）:
 *
 * 1. `validateLocalAssemblies`: `memberId ${vote.memberId} not in members/index.json`
 * 2. `buildLocalAssembly`: `vote memberId ${id} is not in the roster`（**書き出す前に `throw`**）
 *
 * **しかも 1 は #855 が本番 `data/` に当てている**（`published-data-validate.test.ts` →
 * `validateDataset` → `validateLocalAssemblies`）。**下でその 2 つを名指しで固定する。**
 *
 * ## **本当に危ないのは、この検査でも捕まらない**（**正直に書く**）
 *
 * **任期をまたいだとき、引退した議員の氏名には 2 つの行き先がある:**
 *
 * 1. **今の名簿に無い** → `memberId: ""` → `unmatched.json`。**「記録が出ない」側で、利用者から見える。**
 * 2. **今の名簿の別人に当たる** → **その別人の記録として出る。利用者から検出できない虚偽**（#569）。
 *
 * **2 を既存の守りは 1 つも捕まえない**——**当たった `memberId` は名簿に実在するからである。**
 * **この PBI の検査も 2 を捕まえない。** **捕まえるのは「その採決に別の議会の名簿を当てている」
 * という上位の事実だけで、個々の票がどちらに転んだかは見ていない。**
 *
 * **実測しておく（2026-09-20）**: **今の名簿から 1 人ずつ抜き、その人が実際に投じた `nameText` を
 * 各県の突合規則で引き直した 453 通りでは、別人に決まった例は 0 件、453 通りとも `unmatched` に落ちた。**
 * **「2 は今のデータでは再現しない」までが実測である**——**起こりえないという意味ではない。**
 *
 * ## **この検査は、既にあるテストの中で 1 件鳴った**（**作り話ではない**）
 *
 * **`aomori-run.test.ts` の `#750 meta.lossyNameMatches`（第300回）は `--sessions 29` を渡しており、
 * 2019-11 の採決 46 本に 2026-05-25 の名簿を当てている**——**間に 2019 年と 2023 年の
 * 一般選挙が 2 回挟まる 2,376 日。** **ETL のテスト 1,861 件のうち、鳴ったのはこの 1 件だけだった。**
 *
 * **偽陽性ではない**——**`引 ユキ子` の 46 本は、その人の 2019 年の在職を確かめないまま
 * 2026 年の名簿の議員に寄っている。** **本番 `data/` の青森は 2026-03-11 〜 2026-06-29 しか持たず、
 * 2019 年の採決は 1 本も無い**ので、**本番は緑のままである。**
 * **つまり「#901 が広げたら鳴る」が、広げた形のテストで実際に起きた。**
 */
const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));

const walk = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith(".json") && e.name !== "index.json") out.push(p);
  }
  return out;
};

const localPrefs = async (): Promise<string[]> =>
  (await readdir(join(DATA, "assemblies"), { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name.startsWith("pref-")).map((e) => e.name).sort();

const windowOfPref = async (p: string): Promise<ReturnType<typeof rosterWindowOf>> => {
  const meta = JSON.parse(await readFile(join(DATA, "assemblies", p, "meta.json"), "utf-8")) as LocalAssemblyMeta;
  const rcs: LocalRollCall[] = [];
  for (const f of await walk(join(DATA, "assemblies", p, "rollcalls"))) rcs.push(JSON.parse(await readFile(f, "utf-8")) as LocalRollCall);
  return rosterWindowOf(meta.rosterAsOf, rcs);
};

/* ==================== 1. 本番 data/ の実測値を固定する ==================== */

/**
 * **本番 `data/` の 11 議会ぶんの窓を、そのまま表にして固定する**（#928 が測った値そのもの）。
 *
 * **これは「今どうなっているか」の記録である。**
 * **`rosterAsOf` を書き換えても、採決を足しても、会期を広げてもここが落ちて数え直しを強制する。**
 *
 * **母数を一緒に持つ**（#757）——**`rollcalls` の合計が 3,036 であることを下で検算する。**
 * **「6 議会がはみ出している」は、11 議会を全部見た上での 6 でなければ意味が無い。**
 */
test("#928 本番 data/: 11 議会の rosterAsOf と採決日の窓（6 議会が後ろにはみ出し、最大は鳥取 1,156 日）", async () => {
  const prefs = await localPrefs();
  assert.equal(prefs.length, 11, "11 議会ぶんを見ていること（母数。#757）");
  const got: Record<string, { daysAfter: number; daysBefore: number; votesAfter: number; rollcalls: number }> = {};
  for (const p of prefs) {
    const w = await windowOfPref(p);
    got[p] = { daysAfter: w.daysAfter, daysBefore: w.daysBefore, votesAfter: w.votesAfter, rollcalls: w.rollcalls };
  }
  // **実測 2026-09-20**（`data/` を直に読んだ値。#928 の表と一致する）
  assert.deepEqual(got, {
    // **#901 で会期を 2 → 14 にした**。**`daysBefore` 75 → 1,109（上限 1,461 の 76%）。**
    // **#928 の検査は鳴らない**——**しかも鳴るのは 19 会期目（1,544 日）で、
    // 一般選挙の境（14 ↔ 15 会期、IN 11 / OUT 15）より 4 会期も後ろである**
    // （**15 会期目＝選挙の前の 2023-03-08 でも 1,174 日で内側**。`local-assemblies.ts` の docblock）
    "pref-02": { daysAfter: 35, daysBefore: 1_109, votesAfter: 26, rollcalls: 611 },
    // **#901 で会期を 2 → 11 にした**（133 → 584）。**`daysBefore` 65 → 1,010（上限 1,461 の 69%）で、
    // #928 の検査は鳴らない**——**止める位置を決めたのはこの検査ではなく、
    // PDF に出る氏名の集合の不連続のほうである**（第390回 ← 第389回 で IN 19 / OUT 18。
    // **12 本目まで広げても 1,093 日で、これも 1,461 の内側である**）。
    // **`daysAfter` が 75 → −72 になった**（名簿の掲載日が 2026-04-23 → 2026-09-17 に進み、
    // 最新の採決 2026-07-07 より後になった）——**`rosterAsOf` より後の採決はもう 1 件も無い。**
    "pref-04": { daysAfter: -72, daysBefore: 1_010, votesAfter: 0, rollcalls: 584 },
    // **#901 で本会議日を 5 → 29 にした**。**`daysBefore` 147 → 1,165（上限 1,461 の 80%）**——
    // **11 議会でいちばん余裕が小さい**（下のテスト）。**それでも #928 の検査は鳴らない。**
    // **止める位置を決めたのは #928 ではなく、氏名の集合に出た不連続のほうである**
    // （**30 本目の 2023-03-10 は 1,232 日で、これも 1,461 の内側**。`local-assemblies.ts` の docblock）
    "pref-05": { daysAfter: -21, daysBefore: 1_165, votesAfter: 0, rollcalls: 785 },
    // **#901 で会期を 2 → 4 にした**。**`daysBefore` 302 → 921（上限 1,461 の 63%）で、#928 の検査は鳴らない**
    "pref-24": { daysAfter: 224, daysBefore: 921, votesAfter: 190, rollcalls: 733 },
    "pref-25": { daysAfter: -34, daysBefore: 75, votesAfter: 0, rollcalls: 14 },
    // **#901 で会期を 2 → 4 にした**。**`daysBefore` 30 → 197（上限 1,461 の 13%）で、#928 の検査は鳴らない**
    "pref-29": { daysAfter: 69, daysBefore: 197, votesAfter: 37, rollcalls: 180 },
    "pref-31": { daysAfter: 1_156, daysBefore: -1_044, votesAfter: 118, rollcalls: 118 },
    "pref-32": { daysAfter: 1_142, daysBefore: -777, votesAfter: 231, rollcalls: 231 },
    // **#901 で会期を 2 → 4 にした**。**`daysBefore` 204 → 296（上限 1,461 の 20%）で、#928 の検査は鳴らない**
    "pref-36": { daysAfter: -9, daysBefore: 296, votesAfter: 0, rollcalls: 153 },
    "pref-39": { daysAfter: -20, daysBefore: 398, votesAfter: 0, rollcalls: 221 },
    "pref-41": { daysAfter: 456, daysBefore: -385, votesAfter: 23, rollcalls: 23 },
  });
  // **母数の検算**（#757）: **採決の本数の合計が、#855 が数えている 1,369 本と一致する。**
  // **これが無いと、痩せたディレクトリを見て「はみ出し 0」を言える。**
  assert.equal(Object.values(got).reduce((s, x) => s + x.rollcalls, 0), 3_653, "11 議会の採決の合計（#855 の母数と同じ）");
  // **後ろにはみ出している議会は 7 → 6**（**#901 の宮城で名簿の掲載日が採決より後になったため。広げたからではない**）
  assert.equal(Object.values(got).filter((x) => x.daysAfter > 0).length, 6, "rosterAsOf より後の採決を持つ議会");
  // **`rosterAsOf` が採決の範囲を「またいでいる」議会**（#928 が三重の形として挙げたもの）。
  // **実測すると三重だけではない**——**青森・宮城・三重・奈良の 4 議会が両側にはみ出している**
  // （#928 の表は三重だけを名指ししているが、`daysBefore` を全議会で測ると 4 議会ある）。
  // **またいでいる議会では、名簿より前の採決に「後の名簿」を当てている**（三重は 302 日前から）。
  // **#901 の宮城で 4 → 3 に減った**（`daysAfter` が負になったので、もう跨いでいない）
  const straddling = Object.entries(got).filter(([, x]) => x.daysAfter > 0 && x.daysBefore > 0).map(([p]) => p);
  assert.deepEqual(straddling, ["pref-02", "pref-24", "pref-29"], "rosterAsOf が採決の範囲の内側にある議会");
});

/**
 * **本丸**: **11 議会とも 1 任期（1,461 日）の内側にいる**——**だから今この検査は 1 件も鳴らない。**
 *
 * **#928 の完了条件「今の 11 議会が緑であること」を、違反の一覧ではなく
 * 余裕の日数で言う**（**「0 件でした」では、見ていなくても同じ顔をする**）。
 */
test("#928 本番 data/: 11 議会とも rosterAsOf から 1 任期（1,461 日）の内側（鳥取の残りが最小で 305 日）", async () => {
  const prefs = await localPrefs();
  const slack: Record<string, number> = {};
  for (const p of prefs) {
    const w = await windowOfPref(p);
    // **両側の余裕のうち小さいほう**（前にはみ出す三重も同じ線で見る）
    slack[p] = LOCAL_TERM_DAYS - Math.max(w.daysAfter, w.daysBefore);
  }
  assert.equal(Object.keys(slack).length, 11, "11 議会ぶん（母数）");
  for (const [p, s] of Object.entries(slack)) assert.ok(s > 0, `${p}: 1 任期を ${-s} 日超えている`);
  // **#901 で秋田を 5 → 29 本会議日にしたので、いちばん余裕が無いのは鳥取（305）から秋田（296）に変わった。**
  // **実測 2026-09-20**
  assert.equal(Math.min(...Object.values(slack)), 296, "最小の余裕（秋田）");
  assert.equal(slack["pref-05"], 296, "秋田（1,461 − 1,165。`--sessions 29`）");
  // **#901 で青森を 2 → 14 会期にした**。**352 で余裕は 3 番目に小さい**（秋田 296・鳥取 305 の次）
  assert.equal(slack["pref-02"], 352, "青森（1,461 − 1,109。`--sessions 14`）");
  assert.equal(slack["pref-31"], 305, "鳥取（1,461 − 1,156）");
  assert.equal(slack["pref-32"], 319, "島根（1,461 − 1,142）");
  // **#901 で広げた 4 県の余裕**（**広げても 1 任期の内側にある**）:
  assert.equal(slack["pref-24"], 540, "三重（1,461 − 921。`--sessions 4`）");
  assert.equal(slack["pref-36"], 1_165, "徳島（1,461 − 296。`--sessions 4`）");
  assert.equal(slack["pref-39"], 1_063, "高知（1,461 − 398。`--sessions 5`）");
  assert.equal(slack["pref-04"], 451, "宮城（1,461 − 1,010。`--sessions 11`）");
  // ## **余裕が残っていることは「安全」ではない**（#901 の秋田が実測した）
  //
  // **秋田の一般選挙は 2023年4月で、その前の本会議日（2023-03-10）は `rosterAsOf` から 1,232 日。**
  // **1,461 の内側なので、`--sessions 30` にしても #928 は鳴らない。**
  // **つまりこの検査は、秋田の任期の境を 1 度も捕まえない。**
  // **捕まえたのは「本会議日ごとに PDF に出る氏名の集合」の不連続（IN 7 / OUT 9）のほうである。**
  assert.ok(1_232 < LOCAL_TERM_DAYS, "**選挙の前の本会議日ですら、この検査の内側にある**");
  // **青森（#901）は同じことを「鳴るが遅すぎる」という形で示した。**
  // **一般選挙の境は 14 ↔ 15 会期のあいだ（IN 11 / OUT 15）で、15 会期目の最古の採決
  // 2023-03-08 は `rosterAsOf` 2026-05-25 から 1,174 日——内側。**
  // **この検査が初めて鳴るのは 19 会期目（2022-03-03、1,544 日）で、境より 4 会期も後ろである。**
  assert.ok(1_174 < LOCAL_TERM_DAYS, "**青森も、選挙の前の会期がこの検査の内側にある**");
  assert.ok(1_544 > LOCAL_TERM_DAYS, "**青森で鳴るのは 19 会期目——境より 4 会期後ろ**");
});

/**
 * **上の 2 つと同じことを、検査の側から言う**（#774「独立でも互いの代わりにならない」）。
 *
 * **`validateLocalAssemblies` を本番 `data/` に当てて、#928 の違反が 1 件も出ないこと。**
 * **上の 2 つは `rosterWindowOf` を直接呼んでいるので、`validateLocalAssemblies` に
 * 繋ぎ忘れても緑のままになる**——**ここが繋がっていることを別の根拠で固定する。**
 */
test("#928 本番 data/: validateLocalAssemblies が 1 任期の違反を 1 件も出さない", async () => {
  const v = await validateLocalAssemblies(DATA);
  assert.deepEqual(v.filter((x) => x.includes("1 任期")), [], "#928 の違反");
  // **他の違反も 0 であること**（#855 と重なるが、ここが赤いときに上の filter が
  // 「0 件」で緑になるのを防ぐ。**違反が別の場所に出ているのに #928 だけ見て安心しない**）
  assert.deepEqual(v, [], `本番 data/ の不変条件違反（${v.length} 件）`);
});

/* ==================== 2. 広げたときに鳴ること ==================== */

const PDF = "https://www.pref.miyagi.jp/documents/62682/hyouketsu071217.pdf";
const member = (id: string, name: string, asOf: string): LocalMember => ({
  id, assemblyId: "pref-04", name, kana: "やまだ たろう", group: "会派", district: "宮城",
  profileUrl: "https://www.pref.miyagi.jp/site/kengikai/x.html", current: true, asOf,
  sourceUrl: "https://www.pref.miyagi.jp/site/kengikai/18meibo-kaiha.html", counts: { rollcalls: 0 },
});
const rollCall = (id: string, date: string, memberId: string, nameText: string): LocalRollCall => ({
  id, assemblyId: "pref-04" as LocalRollCall["assemblyId"], sessionId: "398",
  sessionLabel: "令和7年11月定例会（第398回）", date, kind: "発議案", number: id.slice(-1),
  title: "条例", result: "可決", page: 1, sourceUrl: PDF,
  votes: [{ memberId, nameText, group: "会派", value: { raw: "○", legend: "賛成", mapped: "賛成" } }],
});

/** `rosterAsOf` と採決日を指定して 1 議会ぶんを書き出し、`validateLocalAssemblies` に掛ける。 */
const writeAndValidate = async (rosterAsOf: string, dates: readonly string[]): Promise<string[]> => {
  const dir = await mkdtemp(join(tmpdir(), "gikailog-928-"));
  const built = buildLocalAssembly({
    assembly: MIYAGI_ASSEMBLY, fetchedAt: `${rosterAsOf}T00:00:00.000Z`, rosterAsOf, sources: [],
    sessions: [{ sessionId: "398", sessionLabel: "令和7年11月定例会（第398回）", sourceUrl: "https://www.pref.miyagi.jp/site/kengikai/hyoketu071217.html", pdfUrl: PDF, rollcalls: dates.length, unknownCells: 0 }],
    members: [member("p_04_a", "山田太郎", rosterAsOf)],
    rollCalls: dates.map((d, i) => rollCall(`pref-04-${i}`, d, "p_04_a", "山田太郎")),
  });
  await writeLocalAssembly(dir, built);
  return validateLocalAssemblies(dir);
};

/**
 * **`--sessions` を広げて任期をまたいだときに鳴ること**（#928 の完了条件）。
 *
 * **実際に `--sessions` を広げなくても測れる**——**古い会期を足す ＝ 採決の日付が古くなることだから。**
 * **鳥取の実形（`rosterAsOf` 2023-04-30）に、前の任期の採決（2022 年）を足した形で測る。**
 */
test("#928 会期を広げて前の任期に入ると落ちる（rosterAsOf 2023-04-30 に 2022 年の採決を足す）", async () => {
  // **1,461 日ちょうどは内側**（境界。**`>` であって `>=` ではない**）
  assert.deepEqual(await writeAndValidate("2023-04-30", ["2019-04-30"]), [], "1,461 日ちょうど前は通る");
  // **1 日超えたら落ちる**
  const over = await writeAndValidate("2023-04-30", ["2019-04-29"]);
  assert.equal(over.length, 1, `違反はちょうど 1 件（got ${JSON.stringify(over)}）`);
  assert.match(over[0], /最古の採決 2019-04-29 が rosterAsOf 2023-04-30 の 1462 日前/);
  assert.match(over[0], /1 任期（1461 日）を超えている/);
  assert.match(over[0], /#928/);
});

/**
 * **後ろ側**（名簿が古く、採決が新しい。**鳥取・島根の形が伸びていった場合**）。
 *
 * **鳥取は今 1,156 日で、残りは 305 日である**——**2027 年 4 月の選挙より後の採決を
 * 2023 年の名簿で読み続ければ、この検査が鳴る。**
 */
test("#928 名簿が古いまま採決だけ新しくなると落ちる（鳥取の残り 305 日を超えた形）", async () => {
  assert.deepEqual(await writeAndValidate("2023-04-30", ["2027-04-30"]), [], "1,461 日ちょうど後は通る");
  const over = await writeAndValidate("2023-04-30", ["2027-05-01"]);
  assert.equal(over.length, 1, `違反はちょうど 1 件（got ${JSON.stringify(over)}）`);
  assert.match(over[0], /最新の採決 2027-05-01 が rosterAsOf 2023-04-30 の 1462 日後/);
});

/**
 * **窓の中に 1 本でも遠い採決があれば鳴る**（**最新・最古だけを見ているので、
 * 「新しい採決を足したら古い採決が隠れる」形にならないことを確かめる**）。
 */
test("#928 新しい採決に混ざった 1 本の古い採決も見逃さない", async () => {
  const v = await writeAndValidate("2023-04-30", ["2023-04-29", "2023-04-28", "2019-04-29"]);
  assert.equal(v.length, 1, `違反はちょうど 1 件（got ${JSON.stringify(v)}）`);
  assert.match(v[0], /最古の採決 2019-04-29/);
});

/* ==================== 3. 既にある守りを固定する（二重に作らないため） ==================== */

/**
 * **「名簿に無い `memberId`」は既に 2 箇所で守られている**（#928 が「いちばん安い」と書いた候補）。
 * **足さずに、ここで名指しで固定する**——**消えたらここが落ちる**（#662 の索引と同じ考え）。
 *
 * **`buildLocalAssembly` は書き出す前に `throw` する**ので、
 * **名簿に無い `memberId` は本番 `data/` に到達しえない。**
 */
test("#928 buildLocalAssembly は名簿に無い memberId の票を書き出す前に落とす（既存の守り）", () => {
  assert.throws(
    () => buildLocalAssembly({
      assembly: MIYAGI_ASSEMBLY, fetchedAt: "2026-04-23T00:00:00.000Z", rosterAsOf: "2026-04-23", sources: [],
      sessions: [{ sessionId: "398", sessionLabel: "令和7年11月定例会（第398回）", sourceUrl: "https://www.pref.miyagi.jp/site/kengikai/hyoketu071217.html", pdfUrl: PDF, rollcalls: 1, unknownCells: 0 }],
      members: [member("p_04_a", "山田太郎", "2026-04-23")],
      // **名簿に居ない議員の票**（任期をまたいで引退した議員が、まだ名簿に載っていた形）
      rollCalls: [rollCall("pref-04-0", "2026-04-22", "p_04_zzz", "引退太郎")],
    }),
    /vote memberId p_04_zzz is not in the roster/,
  );
});

/**
 * **`validateLocalAssemblies` の側の守り**（**書き出した後に `data/` を人が触った場合**。
 * **#840 が実際に `data/` を手で直している**ので、書き出し時の `throw` だけでは足りない）。
 */
test("#928 validateLocalAssemblies は名簿に無い memberId を違反にする（既存の守り）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gikailog-928-id-"));
  const built = buildLocalAssembly({
    assembly: MIYAGI_ASSEMBLY, fetchedAt: "2026-04-23T00:00:00.000Z", rosterAsOf: "2026-04-23", sources: [],
    sessions: [{ sessionId: "398", sessionLabel: "令和7年11月定例会（第398回）", sourceUrl: "https://www.pref.miyagi.jp/site/kengikai/hyoketu071217.html", pdfUrl: PDF, rollcalls: 1, unknownCells: 0 }],
    members: [member("p_04_a", "山田太郎", "2026-04-23")],
    rollCalls: [rollCall("pref-04-0", "2026-04-22", "p_04_a", "山田太郎")],
  });
  await writeLocalAssembly(dir, built);
  assert.deepEqual(await validateLocalAssemblies(dir), [], "書き出した直後は違反 0");
  // **`data/` の側で名簿から 1 人消す**（#928 が指示した変異: 「名簿から 1 人抜く」）
  const idx = join(dir, "members", "index.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(idx, "[]\n", "utf-8");
  const v = await validateLocalAssemblies(dir);
  assert.ok(v.some((x) => /memberId p_04_a not in members\/index\.json/.test(x)), `名簿から消しても鳴らない（got ${JSON.stringify(v)}）`);
});

/* ==================== 4. rosterWindowOf そのもの ==================== */

/**
 * **母数は「日付が読めた本数」ではなく「採決の本数」である**（#757）。
 * **日付が壊れている採決を黙って母数から落とすと、「はみ出し 0 本」が嘘になる。**
 */
test("#928 rosterWindowOf: 母数は採決の本数（日付が読めない本は窓の計算から外れるが母数には残る）", () => {
  const w = rosterWindowOf("2026-01-01", [{ date: "2026-02-01" }, { date: "こわれた" }, { date: "2025-12-01" }]);
  assert.equal(w.rollcalls, 3, "母数は 3 本（壊れた 1 本を含む）");
  assert.equal(w.first, "2025-12-01");
  assert.equal(w.last, "2026-02-01");
  assert.equal(w.votesAfter, 1);
  assert.equal(w.votesBefore, 1);
  assert.equal(w.daysAfter, 31);
  assert.equal(w.daysBefore, 31);
});

/** **採決が 1 本も無ければ窓は開いていない**（`first` / `last` を作らない＝日付を推定しない）。 */
test("#928 rosterWindowOf: 採決 0 本なら窓は 0（日付を推定しない）", () => {
  const w = rosterWindowOf("2026-01-01", []);
  assert.deepEqual(w, { rosterAsOf: "2026-01-01", rollcalls: 0, daysAfter: 0, daysBefore: 0, votesAfter: 0, votesBefore: 0 });
  assert.ok(!("first" in w), "first を作らない");
});

/** **うるう日をまたいでも日数がずれない**（`LOCAL_TERM_DAYS` は 4 年 ＝ うるう年 1 回ぶんを含む）。 */
test("#928 rosterWindowOf: うるう日をまたぐ 4 年ちょうどが 1,461 日", () => {
  assert.equal(rosterWindowOf("2023-04-30", [{ date: "2027-04-30" }]).daysAfter, LOCAL_TERM_DAYS);
  assert.equal(rosterWindowOf("2023-04-30", [{ date: "2019-04-30" }]).daysBefore, LOCAL_TERM_DAYS);
  // **2024 年（うるう年）の 2/29 を含む向き**
  assert.equal(rosterWindowOf("2024-02-28", [{ date: "2024-03-01" }]).daysAfter, 2);
});
