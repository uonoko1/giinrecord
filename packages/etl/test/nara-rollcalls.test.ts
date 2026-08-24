import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { LocalMember } from "@seiji-kiroku/shared";
import { parseRoster } from "../src/sources/local/nara/roster.ts";
import { parseVotePdf, type VotePdf } from "../src/sources/local/nara/votes-pdf.ts";
import { mapLegend, matchName, nameKey, toLocalRollCalls } from "../src/sources/local/nara/rollcalls.ts";

// 奈良県議会の表決 PDF の行 → LocalRollCall（Issue #202）。
// - 名寄せ: 空白・異体字セレクタを除き字形違い（髙/高）を寄せた完全一致 → 無ければ部分列一致（1 人に決まるときだけ）。
//   PDF の文字層は一部の字が落ちる（「芦髙清友」の外字「芦」、「西川均」の「均」）。推定で補わず、規則で寄せる。
// - mapped は凡例の文言が完全一致するときだけ。棄権（「退」表決を棄権）には付けない。
// フィクスチャ内の「手話で電話」（denwa-relay-service.jp）ウィジェットの公開 token は
// REDACTED に置換済み（#216）。全ページ共通のページ装飾でパース対象ではないため、解析結果には影響しない。
const fixture = (name: string) => readFileSync(new URL(`./fixtures/nara/${name}`, import.meta.url));
const roster = parseRoster(fixture("52534.html").toString("utf8")).members;
const june = await parseVotePdf(fixture("20260702_giinbetsu_hyoketsu.pdf"));
const feb = await parseVotePdf(fixture("20260325_giinbetsu_hyoketsu.pdf"));
const origin = "https://www.pref.nara.lg.jp";
const juneUrl = `${origin}/documents/24098/20260702_giinbetsu_hyoketsu.pdf`;
const febUrl = `${origin}/documents/21459/20260325_giinbetsu_hyoketsu.pdf`;

test("nameKey: 空白と異体字セレクタを除き、字形違い（髙/高 など）を寄せる", () => {
  assert.equal(nameKey("芦高　清友"), "芦高清友");
  assert.equal(nameKey("芦\u{E0100}髙清友"), "芦高清友");
  assert.equal(nameKey("髙清友"), "高清友");
});

test("matchName: 完全一致が 1 人ならその人。無ければ部分列一致で 1 人に決まるときだけ。2 人以上は候補を返して選ばない", () => {
  const r = (name: string, id: string): LocalMember => ({ id, assemblyId: "pref-29", name, kana: "", group: "", district: "", profileUrl: "", current: true, asOf: "2026-04-24", sourceUrl: "", counts: { rollcalls: 0 } });
  const members = [r("芦高 清友", "a"), r("西川 均", "b"), r("川口 信", "c"), r("川口 延良", "d"), r("山田 洋平", "e")];
  assert.deepEqual(matchName("芦\u{E0100}髙清友", members), { memberId: "a", candidates: [{ id: "a", name: "芦高 清友" }] });
  // 先頭の字（外字「芦」）が落ちても部分列一致で 1 人に決まる
  assert.deepEqual(matchName("髙清友", members), { memberId: "a", candidates: [{ id: "a", name: "芦高 清友" }] });
  // 末尾の字（「均」）が落ちても同じ
  assert.deepEqual(matchName("西川", members), { memberId: "b", candidates: [{ id: "b", name: "西川 均" }] });
  // 2 人に含まれる並びは選ばない（候補を全部返す）
  assert.deepEqual(matchName("川口", members), { memberId: "", candidates: [{ id: "c", name: "川口 信" }, { id: "d", name: "川口 延良" }] });
  // 完全一致
  assert.deepEqual(matchName("川口信", members), { memberId: "c", candidates: [{ id: "c", name: "川口 信" }] });
  // 1 文字だけでは寄せない。無関係な氏名は候補なし
  assert.deepEqual(matchName("川", members), { memberId: "", candidates: [] });
  assert.deepEqual(matchName("高橋一郎", members), { memberId: "", candidates: [] });
  assert.deepEqual(matchName("", members), { memberId: "", candidates: [] });
});

test("mapLegend: ○→賛成・×→反対・議/副/除/欠/―→投票なし（凡例の文言が完全一致するときだけ）。退（表決を棄権）と不明には mapped を付けない", () => {
  assert.deepEqual(mapLegend("○", "賛成"), { raw: "○", legend: "賛成", mapped: "賛成" });
  assert.deepEqual(mapLegend("×", "反対（起立採決において、起立しなかった議員）"), { raw: "×", legend: "反対（起立採決において、起立しなかった議員）", mapped: "反対" });
  assert.deepEqual(mapLegend("議", "議長"), { raw: "議", legend: "議長", mapped: "投票なし" });
  assert.deepEqual(mapLegend("副", "副議長が議長職務を代行した場合"), { raw: "副", legend: "副議長が議長職務を代行した場合", mapped: "投票なし" });
  assert.deepEqual(mapLegend("除", "除斥"), { raw: "除", legend: "除斥", mapped: "投票なし" });
  assert.deepEqual(mapLegend("欠", "欠席"), { raw: "欠", legend: "欠席", mapped: "投票なし" });
  assert.deepEqual(mapLegend("―", "不在（除斥、欠席及び表決を棄権した場合を除く）"), { raw: "―", legend: "不在（除斥、欠席及び表決を棄権した場合を除く）", mapped: "投票なし" });
  assert.deepEqual(mapLegend("退", "表決を棄権"), { raw: "退", legend: "表決を棄権" });
  assert.deepEqual(mapLegend("不明", "抽出不能"), { raw: "不明", legend: "抽出不能" });
  // 凡例の文言が変わったら mapped は付かない（推定しない）
  assert.deepEqual(mapLegend("×", "反対"), { raw: "×", legend: "反対" });
});

test("toLocalRollCalls: id は {assemblyId}-{sessionId}-{議決日}-{種別}-{番号}。名簿の全員に票が付き、unmatched 0。会派は PDF の見出しの原文", () => {
  const { rollCalls, unmatched } = toLocalRollCalls([{ pdf: june, pdfUrl: juneUrl }], roster, { sessionId: "2026-06", sessionLabel: "令和8年6月定例会" });
  assert.equal(rollCalls.length, 37);
  assert.deepEqual(unmatched, []);
  const first = rollCalls[0];
  assert.equal(first.id, "pref-29-2026-06-20260702-知事提出議案-議第56号");
  assert.equal(first.assemblyId, "pref-29");
  assert.equal(first.sessionLabel, "令和8年6月定例会");
  assert.equal(first.date, "2026-07-02");
  assert.equal(first.result, "原案可決");
  assert.equal(first.sourceUrl, juneUrl);
  // 表決方法・人数の欄は PDF に無いので書かない（推定しない）
  assert.ok(!("method" in first));
  assert.ok(!("counts" in first));
  // 文字層で欠けた氏名も名簿に寄る（芦高清友・西川均）。nameText は PDF の原文のまま
  const ashitaka = first.votes.find((v) => v.memberId === "p_29_52536")!;
  assert.equal(ashitaka.nameText, "髙清友");
  assert.equal(ashitaka.value.raw, "○");
  const nishikawa = first.votes.find((v) => v.memberId === "p_29_52575")!;
  assert.equal(nishikawa.nameText, "西川");
  // 会派は表決時点の PDF の見出し（名簿と食い違っても事実のまま）
  assert.equal(first.votes.find((v) => v.memberId === "p_29_52581")!.group, "日本共産党");
  // 山村幸穂の × は 反対 に mapped、退（棄権）はそのまま
  const zeisei = rollCalls.find((rc) => rc.id.endsWith("議第56号"))!;
  assert.deepEqual(zeisei.votes.find((v) => v.memberId === "p_29_52581")!.value, { raw: "×", legend: "反対（起立採決において、起立しなかった議員）", mapped: "反対" });
  const iken5 = rollCalls.find((rc) => rc.id === "pref-29-2026-06-20260702-意見書-第5号")!;
  assert.deepEqual(iken5.votes.find((v) => v.nameText === "中川崇")!.value, { raw: "退", legend: "表決を棄権" });
});

test("toLocalRollCalls: 2月定例会分（88 件）も unmatched 0。同じ番号でも種別と議決日で id が分かれる", () => {
  const { rollCalls, unmatched } = toLocalRollCalls([{ pdf: feb, pdfUrl: febUrl }], roster, { sessionId: "2026-02", sessionLabel: "令和8年2月定例会" });
  assert.equal(rollCalls.length, 88);
  assert.deepEqual(unmatched, []);
  assert.equal(new Set(rollCalls.map((rc) => rc.id)).size, 88);
  assert.ok(rollCalls.some((rc) => rc.id === "pref-29-2026-02-20260325-決議-第1号"));
  assert.ok(rollCalls.some((rc) => rc.id === "pref-29-2026-02-20260325-意見書-第1号"));
  assert.ok(rollCalls.some((rc) => rc.id === "pref-29-2026-02-20260325-議員提出議案-議第112号"));
  // 全行 欠 の議員（山本進章・阪口保）も票（欠席）として残る
  const yamamoto = rollCalls[0].votes.find((v) => v.memberId === "p_29_52582")!;
  assert.deepEqual(yamamoto.value, { raw: "欠", legend: "欠席", mapped: "投票なし" });
});

test("toLocalRollCalls: PDF の会期見出しと index の会期が食い違えば例外。同じ議決日・種別・番号の行が複数なら -1, -2 … を全部に足す", () => {
  assert.throws(
    () => toLocalRollCalls([{ pdf: june, pdfUrl: juneUrl }], roster, { sessionId: "2026-02", sessionLabel: "令和8年2月定例会" }),
    /PDF says 令和8年6月定例会/,
  );
  // 同じ番号の行が 2 回出る PDF（監査委員の選任 2 人のような場合）を合成して確かめる
  const twice: VotePdf = {
    ...june,
    rows: [june.rows[0], { ...june.rows[0], title: "別件" }, june.rows[1]],
  };
  const { rollCalls } = toLocalRollCalls([{ pdf: twice, pdfUrl: juneUrl }], roster, { sessionId: "2026-06", sessionLabel: "令和8年6月定例会" });
  assert.deepEqual(rollCalls.map((rc) => rc.id), [
    "pref-29-2026-06-20260702-知事提出議案-議第56号-1",
    "pref-29-2026-06-20260702-知事提出議案-議第56号-2",
    "pref-29-2026-06-20260702-知事提出議案-議第57号",
  ]);
});
