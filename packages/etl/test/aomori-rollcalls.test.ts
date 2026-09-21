import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseVotePdf, UNKNOWN_CELL, UNKNOWN_LEGEND } from "../src/sources/local/aomori/votes-pdf.ts";
import { parseRoster } from "../src/sources/local/aomori/roster.ts";
import { mapLegend, parseDateText, resolveDate, toLocalRollCalls, type SessionInfo } from "../src/sources/local/aomori/rollcalls.ts";
import { unmatchedReason } from "../src/sources/local/name-match.ts";
import { lossyNameMatchesOf } from "../src/local-assemblies.ts";

const fx = (name: string) => readFileSync(fileURLToPath(new URL(`fixtures/aomori/${name}`, import.meta.url)), "utf-8");
const bin = (name: string) => readFileSync(fileURLToPath(new URL(`fixtures/aomori/${name}`, import.meta.url)));
const roster = () => parseRoster(fx("giin-kaiha.html"), fx("giin-senkyoku.html")).members;
const url = (f: string) => `https://www.pref.aomori.lg.jp/soshiki/gikai/files/${f}.pdf`;

const convert = async (f: string, session: SessionInfo) =>
  toLocalRollCalls([{ pdf: await parseVotePdf(bin(`${f}.pdf`)), pdfUrl: url(f) }], roster(), session);

const S314: SessionInfo = { sessionId: "2023-07", sessionLabel: "令和5年7月第314回定例会", year: 2023, month: 7 };
const S322: SessionInfo = { sessionId: "2025-06", sessionLabel: "令和7年6月第322回定例会", year: 2025, month: 6 };
const S276: SessionInfo = { sessionId: "2013-11", sessionLabel: "平成25年11月第276回定例会", year: 2013, month: 11 };
const S300: SessionInfo = { sessionId: "2019-11", sessionLabel: "令和元年11月第300回定例会", year: 2019, month: 11 };

test("#750 toLocalRollCalls: id・議決日・表決方法・件数", async () => {
  const c = await convert("314teirei_sanpi", S314);
  assert.equal(c.rollCalls.length, 21);
  assert.equal(c.skippedRows, 0, "議決日の読めない行は 0（実測 56 本 2,445 行すべてが M/D）");
  const rc = c.rollCalls[0];
  assert.equal(rc.id, "pref-02-2023-07-20230724-第1号");
  assert.equal(rc.assemblyId, "pref-02");
  assert.equal(rc.sessionId, "2023-07");
  assert.equal(rc.sessionLabel, "令和5年7月第314回定例会");
  assert.equal(rc.date, "2023-07-24");
  assert.equal(rc.kind, "議案等", "**種別の欄が無いので推定しない**（公表されている単位のまま）");
  assert.equal(rc.number, "第1号");
  assert.equal(rc.title, "特別職の職員の給与に関する条例の一部を改正する条例案");
  assert.equal(rc.result, "原案可決");
  assert.deepEqual(rc.method, { raw: "起立", legend: "起立" }, "表決方法の凡例は PDF に無いので原文を入れる");
  assert.deepEqual(rc.counts, { yes: 46, no: 0, voting: 46 });
  assert.equal(rc.votes.length, 48);
  assert.equal(rc.sourceUrl, url("314teirei_sanpi"));
  assert.equal(rc.page, 1);
  // **1 会期に議決日が複数ある**（会期の途中で議決した議案がある）
  assert.deepEqual([...new Set(c.rollCalls.map((r) => r.date))].sort(), ["2023-07-06", "2023-07-19", "2023-07-24"]);
  // すべての id が一意
  assert.equal(new Set(c.rollCalls.map((r) => r.id)).size, c.rollCalls.length);
});

/**
 * **簡易表決でも個人票がある**（#529 が第326回の 5 行で実測、#743 が 46 本に `簡易` があると確認）。
 * **島根は簡易に個人票が無いので別扱いにしている**が、**青森で同じことをすると
 * 実在する 111 行（56 本）の個人票を捨てることになる。**
 */
test("#750 簡易表決も個人票として出す（島根と同じ扱いにしない）", async () => {
  const c = await convert("314teirei_sanpi", S314);
  const kani = c.rollCalls.filter((r) => r.method?.raw === "簡易");
  assert.equal(kani.length, 2, "`簡易` の行が 2 つ実在する");
  for (const r of kani) {
    assert.equal(r.votes.length, 48, "簡易でも 48 人ぶんの票がある");
    assert.equal(r.votes.filter((v) => v.value.raw === UNKNOWN_CELL).length, 0);
  }
});

/**
 * **凡例の意味で `mapped` を引く**（記号ではなく）。**凡例に無い記号は `mapped` を付けない**（#569）。
 */
test("#750 mapLegend: 凡例の意味で引く・凡例に無ければ mapped を付けない", () => {
  assert.deepEqual(mapLegend("○", "賛成"), { raw: "○", legend: "賛成", mapped: "賛成" });
  assert.deepEqual(mapLegend("×", "反対"), { raw: "×", legend: "反対", mapped: "反対" });
  assert.deepEqual(mapLegend("議", "議長"), { raw: "議", legend: "議長", mapped: "投票なし" });
  assert.deepEqual(mapLegend("副", "副議長が議長の職務を代理"), { raw: "副", legend: "副議長が議長の職務を代理", mapped: "投票なし" });
  assert.deepEqual(mapLegend("除", "除斥"), { raw: "除", legend: "除斥", mapped: "投票なし" });
  assert.deepEqual(mapLegend("欠", "欠席"), { raw: "欠", legend: "欠席", mapped: "投票なし" });
  assert.deepEqual(mapLegend("退", "退席"), { raw: "退", legend: "退席", mapped: "投票なし" });
  // **凡例に無い記号**（`-`）と**置けなかったセル**は `mapped` 無し
  assert.deepEqual(mapLegend("-", UNKNOWN_LEGEND), { raw: "-", legend: UNKNOWN_LEGEND });
  assert.deepEqual(mapLegend(UNKNOWN_CELL, UNKNOWN_LEGEND), { raw: UNKNOWN_CELL, legend: UNKNOWN_LEGEND });
});

test("#750 凡例に無い `-` は mapped が付かない（意味を推定しない）", async () => {
  const c = await convert("276_25.11_giketsukekka", S276);
  const dashes = c.rollCalls.flatMap((r) => r.votes).filter((v) => v.value.raw === "-");
  assert.equal(dashes.length, 40, "`-` が 40 個（実測）");
  assert.equal(dashes.every((v) => v.value.legend === UNKNOWN_LEGEND), true, "意味は `抽出不能`");
  assert.equal(dashes.every((v) => v.value.mapped === undefined), true, "`mapped` を付けない");
  // **`-` 以外は全部 `mapped` が付く**（`抽出不能` が 40 個だけ、という母数を固定する）
  const noMapped = c.rollCalls.flatMap((r) => r.votes).filter((v) => v.value.mapped === undefined);
  assert.equal(noMapped.length, 40, "mapped が無いのは `-` の 40 個だけ");
});

/**
 * **#529 が見つけた罠**: **PDF が `和田寛司`（寛 U+5BDB）、名簿が `和田寬司`（寬 U+5BEC）。**
 * **別の漢字なので `localNameKey` は畳まない。畳んではいけない**（#569）。
 * **`sourceConflict` として `unmatched.json` に落ちる**——**どちらが正しいかは決めない**（#711）。
 */
test("#750 和田寛司/寬司 は寄せずに sourceConflict で名指しする", async () => {
  const c = await convert("314teirei_sanpi", S314);
  const wada = c.unmatched.find((u) => u.nameText.replace(/\s/g, "") === "和田寛司");
  assert.ok(wada, "和田寛司 が unmatched に無い（＝寄せてしまっている）");
  assert.equal(unmatchedReason(wada.nameText, roster()), "sourceConflict");
  // **票は残る**（memberId が空なだけ）——「記録が出ない」にはしない
  const votes = c.rollCalls.flatMap((r) => r.votes).filter((v) => v.nameText.replace(/\s/g, "") === "和田寛司");
  assert.equal(votes.length, 21);
  assert.equal(votes.every((v) => v.memberId === ""), true, "memberId は空（選んでいない）");
  assert.equal(votes.every((v) => v.value.mapped !== undefined), true, "票そのものは読めている");
});

/**
 * **#749 の機序 ③**: `櫛` が `噰`（U+5670）に化ける。**名簿と 1 文字違いなので `sourceConflict`。**
 */
test("#750 噰引ユキ子 は sourceConflict で落ちる（戻さない。機序 ③）", async () => {
  const c = await convert("322teirei_sanpi", S322);
  const k = c.unmatched.find((u) => u.nameText.includes("ユキ子"));
  assert.ok(k, "噰引ユキ子 が unmatched に無い（＝寄せてしまっている）");
  assert.equal(k.nameText, "噰 引 ユキ子");
  assert.equal(unmatchedReason(k.nameText, roster()), "sourceConflict");
});

/**
 * **#749 の機序 ②**: `櫛` が文字層に無く、氏名が `引ユキ子` になる。
 *
 * **`引ユキ子` は 3 つの守りをすべて素通りする**——
 * `nonNameCharacters` は空（漢字とカタカナだけ）、`conflictingRosterNames` は長さが違うので空、
 * `unmatchedReason` は `undefined`。**そのうえ `matchBySubsequence` が本人に寄せてしまうので、
 * `unmatched.json` にも載らない**（人が見る機会が無い）。
 *
 * **寄せ方は変えない**（#617／#648 の部分列一致は、実データの欠落で別人に決まらないと測ってある）。
 * **代わりに `meta.lossyNameMatches` に「字が落ちたまま寄った」という事実を残す。**
 */
test("#750 引ユキ子 は 3 つの守りを素通りする——lossyNameMatches に残す（機序 ②）", async () => {
  const r = roster();
  // **3 つの守りが 1 つも当たらない**ことを固定する（当たるようになったら、この記録は要らなくなる）
  assert.equal(unmatchedReason("引 ユキ子", r), undefined, "unmatchedReason が理由を付けない");
  const c = await convert("300teirei_sanpi", S300);
  // **`unmatched.json` に載らない**（本人に寄っている）
  assert.equal(c.unmatched.some((u) => u.nameText.includes("ユキ子")), false);
  // **`lossyNameMatches` に残る**（**#778 で共通層（`lossyNameMatchesOf`）が数えるようになった**——
  // **青森の `rollcalls.ts` は何も渡していない。渡さなくても出ることがこの検査の要点である**）
  assert.deepEqual(lossyNameMatchesOf(c.rollCalls, r), [{
    nameText: "引 ユキ子", memberId: "p_02_giin_kushibiki-yukiko", rosterName: "櫛󠄁引 ユキ子", rollCalls: 46,
  }]);
  // **票は本人に付いている**（記録が消えてはいない）
  const votes = c.rollCalls.flatMap((x) => x.votes).filter((v) => v.nameText === "引 ユキ子");
  assert.equal(votes.length, 46);
  assert.equal(votes.every((v) => v.memberId === "p_02_giin_kushibiki-yukiko"), true);
});

/** **字が落ちていない本では `lossy` が空**（この記録が「全部に付く」実装になっていないこと） */
test("#750 lossyNameMatches: 字が落ちていない本では空（否定的対照）", async () => {
  for (const [f, s] of [["314teirei_sanpi", S314], ["322teirei_sanpi", S322], ["276_25.11_giketsukekka", S276]] as const) {
    assert.deepEqual(lossyNameMatchesOf((await convert(f, s)).rollCalls, roster()), [], `${f} に lossy が出た`);
  }
});

/**
 * **11 月定例会の議決が翌年 1 月になる会期がある**
 * （docs/DATA_CONTRACT.md の規則。宮城・滋賀と同じ）。
 */
test("#750 resolveDate: 会期の月より 6 か月以上前の月は翌年", () => {
  assert.equal(resolveDate({ year: 2025, month: 11 }, 12, 9), "2025-12-09", "同じ年");
  assert.equal(resolveDate({ year: 2025, month: 11 }, 1, 20), "2026-01-20", "11月定例会の 1月議決は翌年");
  assert.equal(resolveDate({ year: 2026, month: 2 }, 3, 17), "2026-03-17", "2月定例会の 3月議決は同じ年");
  // **境界は「6 か月以上前」**。6月定例会の 1月議決は差 5 なので**同じ年**（＝翌年にしない）
  assert.equal(resolveDate({ year: 2026, month: 6 }, 1, 5), "2026-01-05", "差 5 は翌年にしない");
  assert.equal(resolveDate({ year: 2026, month: 7 }, 1, 5), "2027-01-05", "差 6 で翌年");
});

test("#750 parseDateText: M/D だけ読む（`継続審査` は読めない＝推定しない）", () => {
  assert.deepEqual(parseDateText("6/29"), { month: 6, day: 29 });
  assert.deepEqual(parseDateText("１２／９"), { month: 12, day: 9 }, "全角も読む");
  assert.equal(parseDateText("継続審査"), undefined);
  assert.equal(parseDateText("6/29継続審査"), undefined, "繋がっていたら読まない（行が混ざっている合図）");
  assert.equal(parseDateText("13/1"), undefined, "月が範囲外");
  assert.equal(parseDateText(""), undefined);
});

/**
 * **議決日をまたいで同じ番号が出る会期がある**ので、id は `{日付}-{番号}` で作り、
 * **それでも衝突するなら全部に `-1`, `-2` … を足す**（8 県と同じ規則。**片方だけに足さない**）。
 */
test("#750 同じ議決日で同じ議案等番号が複数あれば全部に連番を足す", async () => {
  const c = await convert("322teirei_sanpi", S322);
  const dup = c.rollCalls.filter((r) => r.id.startsWith("pref-02-2025-06-20250627-第1号"));
  assert.deepEqual(dup.map((r) => r.id), ["pref-02-2025-06-20250627-第1号-1", "pref-02-2025-06-20250627-第1号-2"],
    "**片方だけに `-1` を足さない**（どちらが「元の」議案か決められない）");
  assert.equal(new Set(c.rollCalls.map((r) => r.id)).size, c.rollCalls.length, "id が一意");
});

/**
 * **議案等番号が空の行がある**（**番号と件名が 1 アイテムに繋がっている本**。
 * `276` は 46 行中 12 行、`giketsukekka_2809_287` は 9 行）。**その行の id は件名から作る。**
 */
test("#750 議案等番号が空の行は件名で id を作る（日付の無い記録を出さない）", async () => {
  const c = await convert("276_25.11_giketsukekka", S276);
  const noNumber = c.rollCalls.filter((r) => r.number === "");
  assert.equal(noNumber.length, 12, "番号が空の行が 12 行（実測）");
  assert.equal(noNumber.every((r) => r.title !== ""), true, "件名は読めている");
  assert.equal(noNumber.every((r) => r.id.length > "pref-02-2013-11-20131122-".length), true, "id が件名で作られている");
  assert.equal(new Set(c.rollCalls.map((r) => r.id)).size, c.rollCalls.length, "id が一意");
});

/**
 * **名簿に寄らない氏名は `unmatched.json` に落ちる**（黙って捨てない）。
 * **13 年ぶんあるので、過去の会期は名簿（現職 46 名）に寄らないのが普通である。**
 */
test("#750 過去の会期の議員は unmatched に落ちる（黙って捨てない・別人に寄せない）", async () => {
  const c = await convert("279_26.9_giketsukekka", S279());
  assert.equal(c.unmatched.length, 26, "2014 年の会期で 26 名が現職名簿に居ない（実測）");
  // **理由は付かない**（`brokenGlyph` でも `sourceConflict` でもない＝ただ名簿に無い）
  const r = roster();
  assert.deepEqual(c.unmatched.filter((u) => unmatchedReason(u.nameText, r) !== undefined).map((u) => u.nameText), []);
  // **票は残る**（memberId が空なだけ）
  const votes = c.rollCalls.flatMap((x) => x.votes).filter((v) => v.memberId === "");
  assert.equal(votes.length, 26 * 24);
  assert.equal(votes.every((v) => v.value.mapped !== undefined), true, "票そのものは読めている");
});
function S279(): SessionInfo { return { sessionId: "2014-09", sessionLabel: "平成26年9月第279回定例会", year: 2014, month: 9 }; }

/**
 * ## **`skippedRows === 0` は、カウンタが動いている証拠にならない**（#901 で変異を当てて分かった）
 *
 * **`rollcalls.ts` の `if (!md) { skippedRows++; continue; }` から `skippedRows++` を
 * 取り除く変異を当てても、青森のテストは 1 本も落ちなかった**（実測 2026-09-21）。
 * **56 本 2,445 行すべてが `M/D` なので、数えても数えなくても 0 だからである**
 * （**落ちない変異の分類 4: テストが何も主張していない**）。
 *
 * **`skippedRows` は「議決日の欄が別の形になった会期が出た」ことに気づくための数である**
 * （`Converted` の docblock）。**数えていないなら、その会期が来ても黙って行が消える。**
 * **だから「数えられること」を陽性対照で固定する**——
 * **議決日の欄を読めない形にした行を 1 つ作って、それが `skippedRows` に入ることを見る。**
 *
 * **`parseVotePdf` の出力を組み替えている**（PDF を作り直さない）——
 * **確かめたいのは `toLocalRollCalls` の数え方であって、PDF の読み方ではない。**
 */
test("#901 陽性対照: 議決日の読めない行は skippedRows に入る（0 が「数えていない」ではないこと）", async () => {
  const pdf = await parseVotePdf(bin("314teirei_sanpi.pdf"));
  const base = toLocalRollCalls([{ pdf, pdfUrl: url("314teirei_sanpi") }], roster(), S314);
  assert.equal(base.rollCalls.length, 21, "母数（#757）");
  assert.equal(base.skippedRows, 0, "無改造では 0");
  // **1 行目の議決月日を `継続審査` にする**（**実在する形**——`275` `279` `283` にある。
  // **ただしその 3 本では記号が 1 つも無いので `rows` にならない**ので、ここで作る）
  const broken = { ...pdf, rows: pdf.rows.map((r, i) => (i === 0 ? { ...r, dateText: "継続審査" } : r)) };
  const got = toLocalRollCalls([{ pdf: broken, pdfUrl: url("314teirei_sanpi") }], roster(), S314);
  assert.equal(got.skippedRows, 1, "**数えていること**（`skippedRows++` を消すとここが 0 になる）");
  assert.equal(got.rollCalls.length, 20, "**その行は採決にしない**（日付の無い記録を出さない）");
  // **落とした行の票が、別の行に混ざっていないこと**（20 行 × 48 人のまま）
  assert.equal(got.rollCalls.reduce((s, r) => s + r.votes.length, 0), 20 * 48);
  // **2 行目以降の id は 1 バイトも変わらない**（**行がずれていない**）
  assert.deepEqual(got.rollCalls.map((r) => r.id), base.rollCalls.slice(1).map((r) => r.id));
});
