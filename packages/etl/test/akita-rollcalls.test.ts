import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LocalMember } from "@seiji-kiroku/shared";
import { mapLegend, parseDateText, resolveDate, sessionOf, toLocalRollCalls } from "../src/sources/local/akita/rollcalls.ts";
import { parseVotePdf, UNKNOWN_CELL, UNKNOWN_LEGEND } from "../src/sources/local/akita/votes-pdf.ts";
import { parseRoster } from "../src/sources/local/akita/roster.ts";

const pdf = (name: string) => readFileSync(fileURLToPath(new URL(`fixtures/akita/${name}.pdf`, import.meta.url)));
const html = (name: string) => readFileSync(fileURLToPath(new URL(`fixtures/akita/${name}.html`, import.meta.url)), "utf-8");

test("#759 mapLegend: 凡例の文言が表と完全一致したときだけ `mapped` を付ける", () => {
  assert.deepEqual(mapLegend("○", "賛成"), { raw: "○", legend: "賛成", mapped: "賛成" });
  assert.deepEqual(mapLegend("×", "反対"), { raw: "×", legend: "反対", mapped: "反対" });
  assert.deepEqual(mapLegend("議", "議長"), { raw: "議", legend: "議長", mapped: "投票なし" });
  assert.deepEqual(mapLegend("欠", "欠席"), { raw: "欠", legend: "欠席", mapped: "投票なし" });
  assert.deepEqual(mapLegend("棄", "棄権"), { raw: "棄", legend: "棄権", mapped: "投票なし" });
  assert.deepEqual(mapLegend("除", "除斥"), { raw: "除", legend: "除斥", mapped: "投票なし" });
  assert.deepEqual(mapLegend("－", "議場に不在"), { raw: "－", legend: "議場に不在", mapped: "投票なし" });
  // **`不明` / `抽出不能` には `mapped` を付けない**
  assert.deepEqual(mapLegend(UNKNOWN_CELL, UNKNOWN_LEGEND), { raw: UNKNOWN_CELL, legend: UNKNOWN_LEGEND });
  assert.deepEqual(mapLegend("退", UNKNOWN_LEGEND), { raw: "退", legend: UNKNOWN_LEGEND });
});

/**
 * ## **凡例 D の `－`＝「棄権又は議場に不在」に `mapped` を付けない**（#569。**この PR の判断**）
 *
 * **「棄権」と「議場に不在」は別の事実である**（議場に居たか居なかったか）。
 * **`MAPPED` は「凡例の文言が表と完全一致するとき」だけ引く**（docs/DATA_CONTRACT.md）ので、
 * **`棄権又は議場に不在` はこの表に無く、`mapped` が付かない。**
 * **`抽出不能` にもしない**——**凡例が有り、原文がそう書いてあるので、原文を残す。**
 */
test("#759 凡例 D の `－` は `mapped` が付かず、原文が残る", () => {
  const v = mapLegend("－", "棄権又は議場に不在");
  assert.deepEqual(v, { raw: "－", legend: "棄権又は議場に不在" }, "raw と legend だけ");
  assert.equal("mapped" in v, false, "`mapped` を付けない（片方に決めない）");
  assert.notEqual(v.legend, UNKNOWN_LEGEND, "`抽出不能` にもしない（原文を捨てない）");
  // **凡例 A の `議場に不在` には `mapped` が付く**（同じ `－` でも本によって違う、という事実）
  assert.equal(mapLegend("－", "議場に不在").mapped, "投票なし");
});

test("#759 parseDateText: 議決月日（全角も半角も）", () => {
  assert.deepEqual(parseDateText("12月22日"), { month: 12, day: 22 });
  assert.deepEqual(parseDateText("１２月２２日"), { month: 12, day: 22 }, "全角");
  assert.deepEqual(parseDateText("2月20日"), { month: 2, day: 20 });
  assert.deepEqual(parseDateText(" 3 月 1 日 "), { month: 3, day: 1 }, "空白を除く");
  assert.equal(parseDateText("継続審査"), undefined, "読めない欄は undefined（推定しない）");
  assert.equal(parseDateText(""), undefined);
  assert.equal(parseDateText("13月1日"), undefined, "範囲外");
  assert.equal(parseDateText("12月32日"), undefined, "範囲外");
});

/** **年またぎ**: 11月・12月定例会の議決が翌年 1 月になることがある（docs/DATA_CONTRACT.md） */
test("#759 resolveDate: 会期の月より 6 か月以上前の月は翌年", () => {
  assert.equal(resolveDate({ year: 2017, month: 12 }, 12, 22), "2017-12-22", "同じ月");
  assert.equal(resolveDate({ year: 2017, month: 12 }, 1, 15), "2018-01-15", "12月会期の 1月議決は翌年");
  assert.equal(resolveDate({ year: 2017, month: 11 }, 5, 1), "2018-05-01", "11 - 5 = 6 → 翌年");
  assert.equal(resolveDate({ year: 2017, month: 11 }, 6, 1), "2017-06-01", "11 - 6 = 5 → 同じ年");
  assert.equal(resolveDate({ year: 2026, month: 2 }, 3, 19), "2026-03-19", "2月会期の 3月議決は同じ年");
});

test("#759 sessionOf: 年は見出しから、月は議決月日のいちばん大きいもの", async () => {
  const p = await parseVotePdf(pdf("h291222giketu"));
  assert.deepEqual(sessionOf(p, "x"), { year: 2017, month: 12 });
  const q = await parseVotePdf(pdf("080319"));
  assert.deepEqual(sessionOf(q, "x"), { year: 2026, month: 3 });
  // **見出しに年が無ければ例外**（日付の無い記録を出さない）
  assert.throws(() => sessionOf({ ...p, year: undefined }, "u"), /和暦の年が読めない/);
  // **議決月日が 1 行も読めなければ例外**
  assert.throws(() => sessionOf({ ...p, rows: p.rows.map((r) => ({ ...r, dateText: "" })) }, "u"), /議決月日が 1 行も読めない/);
});

const SESSION = { sessionId: "2017-12-22", sessionLabel: "平成２９年第２回定例会（１２月２２日）", year: 2017, month: 12 };

test("#759 toLocalRollCalls: 採決の形（id・日付・種別・表決方法・票）", async () => {
  const roster = parseRoster(html("giin")).members;
  const p = await parseVotePdf(pdf("h291222giketu"));
  const out = toLocalRollCalls([{ pdf: p, pdfUrl: "https://pref.akita.gsl-service.net/_files/00044226/h291222giketu.pdf" }], roster, SESSION);
  assert.equal(out.rollCalls.length, 50, "採決の数（行の数と同じ）");
  assert.equal(out.skippedRows, 0, "議決日が読めなくて落ちた行（154 本 3,985 行すべてが `M月D日`。#753）");
  assert.equal(new Set(out.rollCalls.map((r) => r.id)).size, 50, "id が重複していない");
  const rc = out.rollCalls[0];
  assert.equal(rc.id, "pref-05-2017-12-22-20171222-議案第184号");
  assert.equal(rc.assemblyId, "pref-05");
  assert.equal(rc.date, "2017-12-22");
  assert.equal(rc.kind, "議案等", "**議案種別を推定しない**（この議会が公表している単位）");
  assert.equal(rc.number, "議案第184号");
  assert.equal(rc.title, "秋田県人事委員会の委員の選任について");
  assert.equal(rc.result, "同意");
  // **表決方法の `legend` は凡例の原文**（`簡易表決（異議の有無を諮る）`）
  assert.deepEqual(rc.method, { raw: "起立", legend: "起立表決" });
  assert.equal(rc.votes.length, 41, "議員の数ぶんの票");
  assert.ok(rc.sourceUrl.startsWith("https://pref.akita.gsl-service.net/"), "出典");
  // **「簡易だから個人票が無い」と決め打ちしない**——**秋田は簡易でも全員ぶんの記号が入る**
  const kani = out.rollCalls.filter((r) => r.method?.raw === "簡易");
  assert.ok(kani.length > 0, "簡易表決の行がある");
  assert.ok(kani.every((r) => r.votes.length === 41 && r.votes.every((v) => v.value.raw !== UNKNOWN_CELL)), "簡易でも全員ぶんの票がある");
});

/**
 * ## **`議` は 1 本の中で同じ 1 人**（#753 が 154 / 154 本で確かめた。#748 の罠の回避）
 * **ただし「議長は採決に加わらない」と決め打ちしない**——
 * **#615 が令和8年7月3日版で「26 行中 1 行だけ議長も `○` だった」を実測している。**
 */
test("#759 `議` は全採決で 1 人（ただし議長が投票する行はありうる）", async () => {
  const roster = parseRoster(html("giin")).members;
  for (const f of ["h291222giketu", "080319", "041222hyoketsu", "060220hyoketsu"] as const) {
    const p = await parseVotePdf(pdf(f));
    const out = toLocalRollCalls([{ pdf: p, pdfUrl: `https://pref.akita.gsl-service.net/x/${f}.pdf` }], roster, SESSION);
    const cols = new Set<number>();
    for (const rc of out.rollCalls) {
      const n = rc.votes.filter((v) => v.value.raw === "議").length;
      assert.ok(n <= 1, `${f}: 1 つの採決に \`議\` が ${n} 人`);
      rc.votes.forEach((v, i) => { if (v.value.raw === "議") cols.add(i); });
    }
    assert.equal(cols.size, 1, `${f}: \`議\` が立つ列（${[...cols]}）`);
  }
});

/** **名寄せできない氏名は `memberId` 空で `unmatched` に出す**（別人に寄せない。#569） */
test("#759 名簿に無い氏名は unmatched に落ちる（別人に寄せない）", async () => {
  const p = await parseVotePdf(pdf("h291222giketu"));
  // **空の名簿**を渡せば、41 人全員が寄らない
  const out = toLocalRollCalls([{ pdf: p, pdfUrl: "https://pref.akita.gsl-service.net/x.pdf" }], [], SESSION);
  assert.equal(out.unmatched.length, 41, "全員が unmatched");
  assert.ok(out.rollCalls.every((r) => r.votes.every((v) => v.memberId === "")), "memberId は空");
  // **票そのものは残る**（読めた事実は捨てない）
  assert.ok(out.rollCalls[0].votes.every((v) => v.value.raw !== ""), "票の原文は残る");
});

/**
 * **否定的対照: 同姓同名が 2 人いたら、どちらにも寄せない。**
 * **秋田には `高橋`/`髙橋` が 3 人いる**（`健` / `豪` / `武浩`。名で分かれる）が、
 * **名まで同じ 2 人が出たら 1 人に決められない。**
 */
test("#759 否定的対照: 同じ氏名が名簿に 2 人いたら寄せない", async () => {
  const p = await parseVotePdf(pdf("h291222giketu"));
  const first = p.members[0].nameText.replace(/[\s　]/g, "");
  const dup = (id: string): LocalMember => ({
    id, assemblyId: "pref-05", name: first, kana: "", group: "", district: "",
    profileUrl: `https://pref.akita.gsl-service.net/profile/${id}/`, current: true,
    asOf: "2026-07-24", sourceUrl: "https://pref.akita.gsl-service.net/doc/2018042300017/", counts: { rollcalls: 0 },
  });
  const out = toLocalRollCalls([{ pdf: p, pdfUrl: "https://pref.akita.gsl-service.net/x.pdf" }], [dup("a"), dup("b")], SESSION);
  assert.equal(out.rollCalls[0].votes[0].memberId, "", "1 人に決まらないので寄せない");
  assert.ok(out.unmatched.some((u) => u.nameText.replace(/[\s　]/g, "") === first), "unmatched に出る");
});

test("#759 同じ議決日で同じ番号の採決が 2 つあれば id に連番を足す", async () => {
  const p = await parseVotePdf(pdf("h291222giketu"));
  const dup = { ...p, rows: [p.rows[0], p.rows[0]] };
  const out = toLocalRollCalls([{ pdf: dup, pdfUrl: "https://pref.akita.gsl-service.net/x.pdf" }], [], SESSION);
  assert.deepEqual(out.rollCalls.map((r) => r.id), [
    "pref-05-2017-12-22-20171222-議案第184号-1",
    "pref-05-2017-12-22-20171222-議案第184号-2",
  ], "全部に連番（片方だけに足さない）");
});
