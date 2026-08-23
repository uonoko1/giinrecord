import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRoster } from "../src/sources/local/tokushima/roster.ts";
import { parseVotePdf } from "../src/sources/local/tokushima/votes-pdf.ts";
import { mapLegend, toLocalRollCalls } from "../src/sources/local/tokushima/rollcalls.ts";

// 徳島県議会 表決 PDF の行 → LocalRollCall（Issue #183）。宮城（miyagi/rollcalls.ts）と同じ方針:
// 名寄せは氏名（空白を除く）の完全一致だけ、LocalVote は原文＋その節の凡例、mapped は凡例の文面が機械的に国会の値に対応するときだけ。
const html = (name: string) => readFileSync(new URL(`./fixtures/tokushima/${name}`, import.meta.url), "utf8");
const bytes = (name: string) => readFileSync(new URL(`./fixtures/tokushima/${name}`, import.meta.url));
const roster = parseRoster({ kaihabetu: html("giin-kaihabetu.html"), senkyoku: html("giin-senkyoku.html") }, { asOf: "2026-08-24" });
const jul3 = await parseVotePdf(bytes("1064407.pdf"));
const mar11 = await parseVotePdf(bytes("1042426.pdf"));
const feb20 = await parseVotePdf(bytes("1038136.pdf"));
const JUN = { sessionId: "2026-06", sessionLabel: "令和8年6月定例会", pdfUrl: "https://www.pref.tokushima.lg.jp/file/attachment/1064407.pdf" };
const FEB = { sessionId: "2026-02", sessionLabel: "令和8年2月定例会" };

test("mapLegend: 議長・退席・欠席・除斥→投票なし。○（委員会審査結果又は議長宣告に起立（賛成）した者）は「議案への賛成」ではなく「委員会審査結果／議長宣告への起立」なので mapped 無し（請願の不採択に ○ なら請願を退けた側）。● も同じく mapped 無し。〇（U+3007）は原文のまま ○ の凡例で読む", () => {
  const yes = "委員会審査結果又は議長宣告に起立（賛成）した者";
  const legend = { "○": yes, "議": "議長", "退": "退席", "除": "除斥", "欠": "欠席", "●": "委員会審査結果又は議長宣告に起立しなかった者" };
  assert.deepEqual(mapLegend("○", legend), { raw: "○", legend: yes });
  assert.deepEqual(mapLegend("〇", legend), { raw: "〇", legend: yes });
  assert.deepEqual(mapLegend("議", legend), { raw: "議", legend: "議長", mapped: "投票なし" });
  assert.deepEqual(mapLegend("退", legend), { raw: "退", legend: "退席", mapped: "投票なし" });
  assert.deepEqual(mapLegend("欠", legend), { raw: "欠", legend: "欠席", mapped: "投票なし" });
  assert.deepEqual(mapLegend("除", legend), { raw: "除", legend: "除斥", mapped: "投票なし" });
  assert.deepEqual(mapLegend("●", legend), { raw: "●", legend: "委員会審査結果又は議長宣告に起立しなかった者" });
  assert.deepEqual(mapLegend("不明", legend), { raw: "不明", legend: "抽出不能" });
  // 凡例の文面が違っても ○ に mapped は付けない。凡例に無い値は例外
  assert.deepEqual(mapLegend("○", { "○": "起立した者" }), { raw: "○", legend: "起立した者" });
  assert.throws(() => mapLegend("×", legend), /not in the legend/);
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
