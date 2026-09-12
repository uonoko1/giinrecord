import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";
import type { LocalMember } from "@seiji-kiroku/shared";
import { mapLegend, parseDateText, resolveDate, toLocalRollCalls } from "../src/sources/local/shiga/rollcalls.ts";
import { parseVotePdf, UNKNOWN_CELL, UNKNOWN_LEGEND } from "../src/sources/local/shiga/votes-pdf.ts";
import { parseRoster } from "../src/sources/local/shiga/roster.ts";
import { unmatchedReason } from "../src/sources/local/name-match.ts";

const fixture = (name: string): Buffer => readFileSync(fileURLToPath(new URL(`fixtures/shiga/${name}`, import.meta.url)));
const roster = (): LocalMember[] => parseRoster(iconv.decode(fixture("giinlist.html"), "Shift_JIS"), { asOf: "2026-09-13" }).members;
const SESSION = { sessionId: "2026-07", sessionLabel: "令和8年 7月定例会議", year: 2026, month: 7 };

test("#741 parseDateText: 議決日の欄（8/10）。読めなければ undefined（推定しない）", () => {
  assert.deepEqual(parseDateText("8/10"), { month: 8, day: 10 });
  assert.deepEqual(parseDateText("１２／３１"), { month: 12, day: 31 });
  assert.equal(parseDateText("8-10"), undefined);
  assert.equal(parseDateText("13/1"), undefined);
  assert.equal(parseDateText("8/0"), undefined);
  assert.equal(parseDateText(""), undefined);
});

test("#741 resolveDate: **年は PDF に無いので会期から補う。年またぎに注意**", () => {
  // 7月定例会議の 8月10日議決 → 同じ年
  assert.equal(resolveDate({ year: 2026, month: 7 }, 8, 10), "2026-08-10");
  // **11月定例会の 1月議決は翌年**（会期の月より 6 か月以上前の月）。
  // これを外すと 1 年ずれた日付が出る——**会期名は合っているので利用者からは検出できない**
  assert.equal(resolveDate({ year: 2025, month: 11 }, 1, 20), "2026-01-20");
  assert.equal(resolveDate({ year: 2025, month: 11 }, 12, 20), "2025-12-20");
  // 6 か月ちょうどの境目（2月定例会の 8月は翌年にしない＝同じ年）
  assert.equal(resolveDate({ year: 2026, month: 2 }, 8, 1), "2026-08-01");
});

test("#741 mapLegend: 凡例の意味が表にあるときだけ mapped を付ける（記号では引かない）", () => {
  assert.deepEqual(mapLegend("○", "賛成"), { raw: "○", legend: "賛成", mapped: "賛成" });
  assert.deepEqual(mapLegend("×", "反対"), { raw: "×", legend: "反対", mapped: "反対" });
  assert.deepEqual(mapLegend("議", "議長（表決権なし）"), { raw: "議", legend: "議長（表決権なし）", mapped: "投票なし" });
  // **`-` の意味は会期で違う**（「表決に参加していない」／「欠席」）。どちらも投票なしだが、
  // **記号ではなく凡例の意味で引く**ので、意味が変われば別の行として引かれる
  assert.deepEqual(mapLegend("－", "表決に参加していない"), { raw: "－", legend: "表決に参加していない", mapped: "投票なし" });
  assert.deepEqual(mapLegend("-", "欠席"), { raw: "-", legend: "欠席", mapped: "投票なし" });
  assert.deepEqual(mapLegend("退", "退席"), { raw: "退", legend: "退席", mapped: "投票なし" });
  // **凡例が読めなかったセルに mapped を付けない**（#569）
  assert.deepEqual(mapLegend(UNKNOWN_CELL, UNKNOWN_LEGEND), { raw: UNKNOWN_CELL, legend: UNKNOWN_LEGEND });
  assert.deepEqual(mapLegend("○", UNKNOWN_LEGEND), { raw: "○", legend: UNKNOWN_LEGEND });
  // 凡例に無い意味には mapped を付けない（推定しない）
  assert.deepEqual(mapLegend("欠", "欠"), { raw: "欠", legend: "欠" });
});

test("#741 toLocalRollCalls: Kg907 → 8 件。id・日付・票が名簿に寄る", async () => {
  const pdf = await parseVotePdf(fixture("Kg907_sanpi-080810-1.pdf"));
  const { rollCalls, unmatched } = toLocalRollCalls([{ pdf, pdfUrl: "https://www.shigaken-gikai.jp/voices/GikaiDoc/attach/Congress/Kg907_sanpi-080810-1.pdf" }], roster(), SESSION);
  assert.equal(rollCalls.length, 8);
  const rc = rollCalls[0];
  assert.equal(rc.assemblyId, "pref-25");
  assert.equal(rc.sessionId, "2026-07");
  assert.equal(rc.date, "2026-08-10");
  assert.equal(rc.id, "pref-25-2026-07-20260810-議第105号から議第109号まで（人事案件）");
  // **番号の欄が無い議会なので番号を作らない**（「議第105号から議第109号まで」を 1 つに丸めたら嘘になる）
  assert.equal(rc.number, "");
  assert.equal(rc.kind, "議案等");
  assert.equal(rc.result, "同意");
  assert.deepEqual(rc.counts, { present: 44, voting: 43, yes: 43, no: 0 });
  assert.equal(rc.votes.length, 44);
  // 44 名のうち 43 名が名簿に寄る（残り 1 名は `□ 正 隆`）
  assert.equal(rc.votes.filter((v) => v.memberId !== "").length, 43);
  // **id は一意**（同じ議決日で同じ件名の行が複数なら -1, -2 が付く）
  assert.equal(new Set(rollCalls.map((r) => r.id)).size, rollCalls.length);
  // **寄せられなかったのは「字が壊れている」1 名だけ**
  assert.equal(unmatched.length, 1);
  // `隆` は CJK 互換漢字 U+F9DC（PDF の文字層がそう書いている）。**寄せずに原文のまま持つ**
  assert.deepEqual([...unmatched[0].nameText].map((c) => c.codePointAt(0)!.toString(16)), ["25a1", "20", "6b63", "20", "f9dc"]);
  // **`brokenGlyph` と分かること**——これが無いと「名簿に無い議員」と 1 バイトも区別が付かない（#680）
  assert.equal(unmatchedReason(unmatched[0].nameText, roster()), "brokenGlyph");
  // **`辻正隆` に寄せていないこと**（#569／#674。推定は別人の記録を作る側）
  assert.equal(rc.votes.some((v) => v.nameText.includes("辻")), false);
  const brokenVote = rc.votes.find((v) => v.nameText.startsWith("□"));
  assert.ok(brokenVote);
  assert.equal(brokenVote.memberId, "");
  // **票そのものは読めている**（氏名が壊れていても記号は正しく置けている）
  assert.equal(brokenVote.value.raw, "○");
  assert.equal(brokenVote.value.mapped, "賛成");
});

test("#741 toLocalRollCalls: **同じ議決日で同じ件名の行が複数なら全部に連番を足す**", async () => {
  const pdf = await parseVotePdf(fixture("Kg907_sanpi-080810-1.pdf"));
  // 同じ PDF を 2 本渡す（同じ件名・同じ議決日の行が 2 回出る形を作る）
  const src = { pdf, pdfUrl: "https://www.shigaken-gikai.jp/voices/GikaiDoc/attach/Congress/Kg907_sanpi-080810-1.pdf" };
  const { rollCalls } = toLocalRollCalls([src, src], roster(), SESSION);
  assert.equal(rollCalls.length, 16);
  // **全部に連番が付く**（先に出たほうだけ素の id、では突き合わせる側が壊れる）
  assert.equal(new Set(rollCalls.map((r) => r.id)).size, 16);
  for (const r of rollCalls) assert.match(r.id, /-[12]$/);
});

test("#741 toLocalRollCalls: **凡例の無い PDF では mapped を 1 つも付けない**（#569）", async () => {
  const pdf = await parseVotePdf(fixture("Kg907_sanpi-080810-1.pdf"));
  const noLegend = { ...pdf, legend: { votes: {}, notes: [] } };
  const { rollCalls } = toLocalRollCalls([{ pdf: noLegend, pdfUrl: "https://www.shigaken-gikai.jp/voices/GikaiDoc/attach/Congress/Kg907_sanpi-080810-1.pdf" }], roster(), SESSION);
  for (const rc of rollCalls) for (const v of rc.votes) {
    assert.equal(v.value.legend, UNKNOWN_LEGEND, `${rc.id}: 凡例が無いのに意味が付いた`);
    assert.equal("mapped" in v.value, false, `${rc.id}: 凡例が無いのに mapped が付いた`);
    // **記号そのものは原文のまま残る**（読めた事実は捨てない）
    assert.notEqual(v.value.raw, "");
  }
});
