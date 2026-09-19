import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRoster } from "../src/sources/local/tokushima/roster.ts";
import { parseVotePdf } from "../src/sources/local/tokushima/votes-pdf.ts";
import { expectedDateYear, mapLegend, toLocalRollCalls } from "../src/sources/local/tokushima/rollcalls.ts";

// 徳島県議会 表決 PDF の行 → LocalRollCall（Issue #183）。宮城（miyagi/rollcalls.ts）と同じ方針:
// 名寄せは氏名（空白を除く）の完全一致だけ、LocalVote は原文＋その節の凡例、mapped は凡例の文面が機械的に国会の値に対応するときだけ。
const html = (name: string) => readFileSync(new URL(`./fixtures/tokushima/${name}`, import.meta.url), "utf8");
const bytes = (name: string) => readFileSync(new URL(`./fixtures/tokushima/${name}`, import.meta.url));
const roster = parseRoster({ kaihabetu: html("giin-kaihabetu.html"), senkyoku: html("giin-senkyoku.html") }, { asOf: "2026-08-24" });
const jul3 = await parseVotePdf(bytes("1064407.pdf"));
const mar11 = await parseVotePdf(bytes("1042426.pdf"));
const feb20 = await parseVotePdf(bytes("1038136.pdf"));
const feb13 = await parseVotePdf(bytes("1036105.pdf"));
const JUN = { sessionId: "2026-06", sessionLabel: "令和8年6月定例会", year: 2026, month: 6, pdfUrl: "https://www.pref.tokushima.lg.jp/file/attachment/1064407.pdf" };
const FEB = { sessionId: "2026-02", sessionLabel: "令和8年2月定例会", year: 2026, month: 2 };
/** 失敗メッセージに出す label（どの議会・会期・議案か。#679 で他の 6 県とそろえた）。 */
const LABEL = "tokushima-pref-2026-06-20260625-議案-第1号";

test("mapLegend: 議長・退席・欠席・除斥→投票なし。○（委員会審査結果又は議長宣告に起立（賛成）した者）は「議案への賛成」ではなく「委員会審査結果／議長宣告への起立」なので mapped 無し（請願の不採択に ○ なら請願を退けた側）。● も同じく mapped 無し。〇（U+3007）は原文のまま ○ の凡例で読む", () => {
  const yes = "委員会審査結果又は議長宣告に起立（賛成）した者";
  const legend = { "○": yes, "議": "議長", "退": "退席", "除": "除斥", "欠": "欠席", "●": "委員会審査結果又は議長宣告に起立しなかった者" };
  assert.deepEqual(mapLegend("○", legend, LABEL), { raw: "○", legend: yes });
  assert.deepEqual(mapLegend("〇", legend, LABEL), { raw: "〇", legend: yes });
  assert.deepEqual(mapLegend("議", legend, LABEL), { raw: "議", legend: "議長", mapped: "投票なし" });
  assert.deepEqual(mapLegend("退", legend, LABEL), { raw: "退", legend: "退席", mapped: "投票なし" });
  assert.deepEqual(mapLegend("欠", legend, LABEL), { raw: "欠", legend: "欠席", mapped: "投票なし" });
  assert.deepEqual(mapLegend("除", legend, LABEL), { raw: "除", legend: "除斥", mapped: "投票なし" });
  assert.deepEqual(mapLegend("●", legend, LABEL), { raw: "●", legend: "委員会審査結果又は議長宣告に起立しなかった者" });
  assert.deepEqual(mapLegend("不明", legend, LABEL), { raw: "不明", legend: "抽出不能" });
  // 凡例の文面が違っても ○ に mapped は付けない。凡例に無い値は例外
  assert.deepEqual(mapLegend("○", { "○": "起立した者" }, LABEL), { raw: "○", legend: "起立した者" });
  assert.throws(() => mapLegend("×", legend, LABEL), /not in the legend/);
});

test("toLocalRollCalls: id は {assemblyId}-{sessionId}-{採決日}-{種別}-{議案番号（NFKC）}。全 36 人が名簿に寄り、各行に委員会審査結果・議決結果・ページ・PDF の URL が付く", () => {
  const { rollCalls, unmatched } = toLocalRollCalls(jul3, roster.members, JUN);
  assert.equal(rollCalls.length, 20);
  assert.deepEqual(unmatched, []);
  const first = rollCalls[0];
  assert.equal(first.id, "pref-36-2026-06-20260703-知事提出議案-第1号");
  assert.equal(first.assemblyId, "pref-36");
  assert.equal(first.sessionId, "2026-06");
  assert.equal(first.sessionLabel, "令和8年6月定例会");
  assert.equal(first.date, "2026-07-03");
  assert.equal(first.kind, "知事提出議案");
  assert.equal(first.number, "第１号");
  assert.equal(first.title, "令和8年度徳島県一般会計補正予算（第1号）");
  assert.equal(first.committeeResult, "可決");
  assert.equal(first.result, "可決");
  assert.equal(first.method, undefined); // PDF に表決方法の欄は無い（推定しない）
  assert.equal(first.counts, undefined); // 人数の欄も無い
  assert.equal(first.page, 1);
  assert.equal(first.sourceUrl, JUN.pdfUrl);
  assert.equal(first.votes.length, 36);
  assert.deepEqual(first.votes[0], { memberId: "p_36_kami", nameText: "嘉見 博之", group: "徳島県議会自由民主党", value: { raw: "○", legend: "委員会審査結果又は議長宣告に起立（賛成）した者" } });
  assert.deepEqual(first.votes[25], { memberId: "p_36_ikawa", nameText: "井川 龍二", group: "自由民主党県民会議", value: { raw: "議", legend: "議長", mapped: "投票なし" } });
  assert.deepEqual(first.votes[29].value, { raw: "●", legend: "委員会審査結果又は議長宣告に起立しなかった者" });
  assert.deepEqual(first.votes[7].value, { raw: "〇", legend: "委員会審査結果又は議長宣告に起立（賛成）した者" });
  // 節ごとの凡例: 請願の「退」はその節の凡例（退席）で読む
  const petition = rollCalls.find((rc) => rc.id === "pref-36-2026-06-20260703-請願-第19号")!;
  assert.deepEqual(petition.votes[17].value, { raw: "退", legend: "退席", mapped: "投票なし" });
  assert.equal(petition.committeeResult, "不採択");
  // 不採択の請願で ○ は「不採択に起立」＝請願を退けた側。賛成と出さない（mapped 無し）
  const petitionYes = petition.votes.find((v) => v.value.raw === "○" || v.value.raw === "〇")!;
  assert.equal(petitionYes.value.mapped, undefined);
  assert.ok(petition.votes.every((v) => v.value.mapped === undefined || v.value.mapped === "投票なし"));
  assert.deepEqual(rollCalls.map((rc) => rc.kind).filter((k, i, a) => a.indexOf(k) === i), ["知事提出議案", "議員提出議案", "請願"]);
  assert.equal(rollCalls.find((rc) => rc.id === "pref-36-2026-06-20260703-議員提出議案-第1号")?.committeeResult, "-");
});

test("toLocalRollCalls: 同じ番号の行が 2 つ（原案と修正案）なら id に -1 / -2 を足す。番号の無い動議（番号欄「-」）は 無番号1", () => {
  const mar = toLocalRollCalls(mar11, roster.members, { ...FEB, pdfUrl: "https://www.pref.tokushima.lg.jp/file/attachment/1042426.pdf" });
  assert.equal(mar.rollCalls.length, 83);
  assert.deepEqual(mar.rollCalls.slice(0, 3).map((rc) => [rc.id, rc.title]), [
    ["pref-36-2026-02-20260311-知事提出議案-第1号-1", "令和８年度徳島県一般会計予算"],
    ["pref-36-2026-02-20260311-知事提出議案-第1号-2", "令和８年度徳島県一般会計予算に対する修正案"],
    ["pref-36-2026-02-20260311-知事提出議案-第2号", "令和８年度徳島県用度・給与集中管理特別会計予算"],
  ]);
  assert.equal(new Set(mar.rollCalls.map((rc) => rc.id)).size, 83);
  assert.deepEqual(mar.rollCalls.filter((rc) => rc.number === "第77号").map((rc) => rc.id), ["pref-36-2026-02-20260311-知事提出議案-第77号-1", "pref-36-2026-02-20260311-知事提出議案-第77号-2"]);
  const feb = toLocalRollCalls(feb20, roster.members, { ...FEB, pdfUrl: "https://www.pref.tokushima.lg.jp/file/attachment/1038136.pdf" });
  assert.equal(feb.rollCalls[0].id, "pref-36-2026-02-20260220-動議-無番号1");
  assert.equal(feb.rollCalls[0].number, "-");
  assert.equal(feb.rollCalls[0].result, "否決");
});

test("toLocalRollCalls: 名簿に無い氏名は memberId 空で unmatched に。名簿に同じ氏名が 2 人いれば寄せない", () => {
  const without = roster.members.filter((m) => m.id !== "p_36_kami");
  const r1 = toLocalRollCalls(jul3, without, JUN);
  assert.equal(r1.rollCalls[0].votes[0].memberId, "");
  assert.deepEqual(r1.unmatched.map((u) => [u.nameText, u.group, u.rollCallIds.length]), [["嘉見 博之", "徳島県議会自由民主党", 20]]);
  const twin = [...roster.members, { ...roster.members[0], id: "p_36_kami2" }];
  const r2 = toLocalRollCalls(jul3, twin, JUN);
  assert.equal(r2.rollCalls[0].votes[0].memberId, "");
  assert.equal(r2.unmatched.length, 1);
});

// ── #695: PDF の表題の採決日が、その会期のものかを確かめる ──────────────────────────
// 徳島の PDF の表題には会期名が無く、採決日（「議案審査結果（令和８年２月１３日）」）しか無い。
// index.ts はリンク文言（「各議員の表決態度（2月13日採決）」）と月日だけを突き合わせ、**年を捨てていた**
// （`const [, m, d] = pdf.date.split("-")`）。令和7年2月13日の PDF が令和8年2月定例会に置かれても素通りし、
// 会期名は令和8年・中身は令和7年の rollCall（id は pref-36-2026-02-20250213-…）が出る。
// 会期名が合っているので利用者からは検出できない（#569 の「別人の記録が出る」と同じ重さ）。

test("#695 toLocalRollCalls: 採決日の年が会期の年と食い違えば例外（別の年の PDF を黙って読まない）", () => {
  // 実物の 2026-02-13 の PDF を、1 年前の会期（令和7年2月定例会）に渡す = 県が前年の PDF を置いてしまった形
  const lastYear = { sessionId: "2025-02", sessionLabel: "令和7年2月定例会", year: 2025, month: 2, pdfUrl: "https://www.pref.tokushima.lg.jp/file/attachment/1036105.pdf" };
  assert.throws(() => toLocalRollCalls(feb13, roster.members, lastYear), /PDF says/);
  // 逆向き（会期は令和8年、PDF は 1 年後）も弾く
  const nextYear = { ...FEB, year: 2027, month: 2, pdfUrl: "https://www.pref.tokushima.lg.jp/file/attachment/1036105.pdf" };
  assert.throws(() => toLocalRollCalls(feb13, roster.members, nextYear), /PDF says/);
});

test("#695 toLocalRollCalls: 否定的対照——正しい会期の PDF は通る（上の検査が恒真でないこと）", () => {
  // 採決日が会期の月より後にずれる形（令和8年6月定例会 → 7月3日採決、令和8年2月定例会 → 3月11日採決）も通す。
  // 「採決日の月 = 会期の月」で照合していたら、この 2 本が落ちる
  assert.equal(toLocalRollCalls(jul3, roster.members, JUN).rollCalls.length, 20);
  assert.equal(toLocalRollCalls(mar11, roster.members, { ...FEB, pdfUrl: "x" }).rollCalls.length, 83);
  assert.equal(toLocalRollCalls(feb13, roster.members, { ...FEB, pdfUrl: "x" }).rollCalls.length, 1);
});

test("#695 expectedDateYear: 年またぎ（11月定例会 → 翌年1月採決）だけ翌年を許す", () => {
  // 会期の月以降の採決日は同じ年
  assert.equal(expectedDateYear({ year: 2026, month: 6 }, 7), 2026);
  assert.equal(expectedDateYear({ year: 2026, month: 2 }, 3), 2026);
  assert.equal(expectedDateYear({ year: 2025, month: 11 }, 12), 2025);
  // 会期の月より前の採決日は翌年（11月定例会が翌年1月に採決する形）
  assert.equal(expectedDateYear({ year: 2025, month: 11 }, 1), 2026);
});

/**
 * ## **表ごとに列の並びが違う PDF で、票が正しい議員に付く**（Issue #901）
 *
 * **`1028727.pdf`（令和7年11月定例会 12月19日採決）の 4 枚目だけ 11/12 列目が入れ替わっている。**
 * **`toLocalRollCalls` は `VotePdf.members`（1 枚目の並び）ではなく `VotePdfRow.members` を使う。**
 *
 * **この会期の名簿は 37 人で、今の名簿は 36 人**——**北島 一人 は 2026-02 会期より前に退いている。**
 * **だからこの PDF の 37 列のうち 1 列は名簿に寄らない**（`memberId` は空。**推定しない**。#569 / #529）。
 */
const dec19 = await parseVotePdf(bytes("1028727.pdf"));
const NOV = { sessionId: "2025-11", sessionLabel: "令和7年11月定例会", year: 2025, month: 11, pdfUrl: "https://www.pref.tokushima.lg.jp/file/attachment/1028727.pdf" };

test("#901 toLocalRollCalls: 入れ替わった 4 枚目の 7 行で、沢本 勝彦 と 川真田琢巳 の票が入れ替わらない", () => {
  const { rollCalls, unmatched } = toLocalRollCalls(dec19, roster.members, NOV);
  assert.equal(rollCalls.length, 40, "母数（この PDF の全行）");
  assert.deepEqual([...new Set(rollCalls.map((r) => r.votes.length))], [37], "37 人ぶんの票");
  // **氏名 → その人が座っている列の番号**（行ごとに集める）。
  // **`votes[i].nameText` が PDF のその表の i 列目の議員であること**を、ここで直に見る。
  const colOf = (name: string) => rollCalls.map((r) => r.votes.findIndex((v) => v.nameText === name));
  const sawamoto = colOf("沢本 勝彦");
  const kawamada = colOf("川真田琢巳");
  assert.equal(sawamoto.length, 40);
  assert.equal(kawamada.length, 40);
  // **2 人とも 40 行すべてに 1 回ずつ出る**（どの行でも消えない）
  assert.deepEqual(sawamoto.filter((i) => i < 0), [], "沢本 勝彦 が出ない行");
  assert.deepEqual(kawamada.filter((i) => i < 0), [], "川真田琢巳 が出ない行");
  // **座る列は 2 通りずつ**——**33 行は 10/11、7 行は 11/10**（4 枚目だけ入れ替わる）
  const tally = (a: number[]) => Object.fromEntries([...new Map(a.map((x) => [x, a.filter((y) => y === x).length]))].sort((x, y) => x[0] - y[0]));
  assert.deepEqual(tally(sawamoto), { 10: 33, 11: 7 }, "**沢本 勝彦 の列**（7 行だけ 11 列目）");
  assert.deepEqual(tally(kawamada), { 10: 7, 11: 33 }, "**川真田琢巳 の列**（同じ 7 行で 10 列目）");
  // **2 人は必ず隣り合い、同じ行で入れ替わる**（片方だけ動く行は無い）
  for (let i = 0; i < 40; i++) {
    assert.equal(Math.abs(sawamoto[i] - kawamada[i]), 1, `行 ${i}: 2 人が隣り合っていない`);
  }
  assert.equal(sawamoto.filter((x, i) => x === 11 && kawamada[i] === 10).length, 7, "**入れ替わっている行は 7**");
  // **`pdf.members` を使い回すと、この 2 つの内訳が { 10: 40 } / { 11: 40 } に潰れる**（変異 M4 が落ちる）
  // **1 人に 1 行 1 票ちょうど**（並びが入れ替わっても重複も欠落も起きない）
  for (const r of rollCalls) {
    assert.equal(new Set(r.votes.map((v) => v.nameText)).size, 37, `${r.id}: 同じ氏名が 2 回出ていない`);
  }
  // **`議` は全 40 行で 須見 一仁 1 人**
  for (const r of rollCalls) {
    const gi = r.votes.filter((v) => v.value.raw === "議");
    assert.equal(gi.length, 1, `${r.id}: 議長の列`);
    assert.equal(gi[0].nameText, "須見 一仁", `${r.id}: 議長`);
  }
  // **入れ替わった 7 行（議員提出議案）でも、附帯決議の `●` 2 票は 岡 佑樹・坂口 誠治 に付く**
  const teiketsu = rollCalls.find((r) => r.title.includes("附帯決議"))!;
  assert.deepEqual(teiketsu.votes.filter((v) => v.value.raw === "●").map((v) => v.nameText), ["岡 佑樹", "坂口 誠治"]);
  // **名簿に寄らないのは 北島 一人 1 人だけ**（今の名簿 36 人には居ない。推定しない）
  assert.deepEqual(unmatched.map((u) => u.nameText), ["北島 一人"], "寄らなかった氏名");
  assert.equal(unmatched[0].rollCallIds.length, 40, "その 40 行すべてで memberId は空");
  const empty = rollCalls.flatMap((r) => r.votes).filter((v) => v.memberId === "");
  assert.equal(empty.length, 40, "**memberId が空の票は 40（= 1 人 × 40 行）**");
  assert.deepEqual([...new Set(empty.map((v) => v.nameText))], ["北島 一人"]);
  // **残る 36 人はすべて名簿に寄る**
  const matched = rollCalls.flatMap((r) => r.votes).filter((v) => v.memberId !== "");
  assert.equal(matched.length, 40 * 36);
  assert.equal(new Set(matched.map((v) => v.memberId)).size, 36);
});

/**
 * **`row.members` と `row.cells` の長さが食い違ったら例外**（#901）。
 *
 * **今の `votes-pdf.ts` では起こりえない**——**`readRows` が `cells` を `members.length` で作り、
 * 同じ `push` で `members` を入れているからである**（**変異 M11 で「検査を消しても落ちない」ことを実測した**）。
 * **だからこれは等価変異ではなく、モジュールの境で張った検査である**——
 * **`votes-pdf.ts` の側が将来ずれたときに、票が黙って別人に付くのを止める。**
 * **その検査が働くことを、ここで組み立てた行で確かめる**（**フィクスチャでは作れない**）。
 */
test("#901 toLocalRollCalls: 行の members と cells の長さが食い違えば例外（黙って短いほうに合わせない）", () => {
  const base = structuredClone(dec19);
  // **1 行だけ members を 1 人減らす**（cells は 37 のまま）
  base.sections[0].rows[0].members = base.sections[0].rows[0].members.slice(0, 36);
  assert.throws(() => toLocalRollCalls(base, roster.members, NOV), /36 members but 37 cells/);
  // **逆向き（cells を減らす）も止まる**
  const base2 = structuredClone(dec19);
  base2.sections[0].rows[0].cells = base2.sections[0].rows[0].cells.slice(0, 36);
  assert.throws(() => toLocalRollCalls(base2, roster.members, NOV), /37 members but 36 cells/);
  // **否定的対照: 無改造は通る**（この検査が恒真でないこと）
  assert.equal(toLocalRollCalls(structuredClone(dec19), roster.members, NOV).rollCalls.length, 40);
});

/**
 * **「1 枚目の並びを使い回す」直し方をしたときの被害を、そのまま数える**（#901）。
 *
 * **これは「変異を書いたテスト」ではない**——**誤った読み方を実際に組み立てて、
 * 何票が別人に付くかを数えている。** **落ちるのは実装ではなく、誤った読み方のほうである。**
 */
test("#901 toLocalRollCalls: 1 枚目の並びを使い回すと 14 票が別人に付く（数えた）", () => {
  const { rollCalls } = toLocalRollCalls(dec19, roster.members, NOV);
  let wrong = 0;
  for (const r of rollCalls) {
    const row = dec19.sections.flatMap((s) => s.rows).find((x) => x.title === r.title && x.number === r.number)!;
    for (let i = 0; i < row.cells.length; i++) {
      // 誤った読み: 1 枚目の並び（`dec19.members`）で i 番目の議員に当てる
      if (dec19.members[i].nameText !== r.votes[i].nameText) wrong++;
    }
  }
  assert.equal(wrong, 14, "**7 行 × 2 人 = 14 票**（40 行 × 37 列 = 1,480 票中）");
  assert.equal(rollCalls.reduce((s, r) => s + r.votes.length, 0), 1_480, "母数");
});
