import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { LocalAssemblyMeta, LocalMember, LocalRollCall, LocalUnmatchedName } from "@seiji-kiroku/shared";
import { SAGA_HOST } from "../src/sources/local/saga/site.ts";

/**
 * **本番 `data/assemblies/pref-41/` に出したものを、出した後から読み直して数える**（Issue #768）。
 *
 * **`votes-pdf.ts` のテストは PDF を読む側を見ている。ここは「書いたもの」を見る。**
 * **同じ実装で 2 回測っているのではない**——**`data/` の JSON を読み直しているので、
 * 書き出し（`buildLocalAssembly` / `writeLocalAssembly`）が壊れたらここが落ちる。**
 */
const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));
const DIR = join(DATA, "assemblies", "pref-41");

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

test("#768 本番 pref-41: 採決 23 × 議員 37 = 851 セル、抽出不能 0.00%", { skip: !hasData }, () => {
  const m = meta();
  const rcs = rollCalls();
  // **実測 2026-09-13**（直近 2 会期。月次のワークフローは既定の `--sessions 2` で回る）
  assert.equal(m.counts.rollcalls, 23);
  assert.equal(m.counts.members, 37);
  assert.equal(m.counts.cells, 851);
  // **本番に出るデータのうち `抽出不能` が何％か**——**0.00%**（滋賀 27% / 青森 0% / 秋田 0%）
  assert.equal(m.counts.unknownCells, 0, "**推定せず残した不明セルは 0**");
  // **meta の数が、書いた実物と一致する**（meta だけを書き換えても落ちる）
  assert.equal(rcs.length, m.counts.rollcalls, "rollcalls/ の実ファイル数");
  assert.equal(rcs.reduce((s, r) => s + r.votes.length, 0), m.counts.cells, "票の実数");
  assert.equal(rcs.reduce((s, r) => s + r.votes.filter((v) => v.value.legend === "抽出不能").length, 0), 0, "`抽出不能` の票");
  assert.equal(rcs.reduce((s, r) => s + r.votes.filter((v) => v.value.raw === "不明").length, 0), 0, "`不明` の票");
  // **票の内訳**（`data/` を読み直して数えた）
  const raw = new Map<string, number>();
  for (const r of rcs) for (const v of r.votes) raw.set(v.value.raw, (raw.get(v.value.raw) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries([...raw].sort()), { "×": 47, "○": 780, "議": 23, "除": 1 });
});

/**
 * ## **未突合は 2 件で、どちらも `sourceConflict`**（**この議会の要点**）
 *
 * **一次資料どうしが氏名で食い違っている**——**どちらが正しいかは決めない**（#711 / #569）:
 *   - **`猪村理恵子`（理 U+7406）**: 名簿と令和8年4月臨は `猪村利恵子`（利 U+5229）
 *   - **`桃崎裕介`（裕 U+88D5）**: 名簿と令和8年6月定は `桃崎祐介`（祐 U+7950）
 *
 * **どちらも「多数側が名簿と一致し、少数側が最新ではない」**（#765 が 16 本で数えた:
 * `利` 10 会期 / `理` 3 会期、`祐` 14 会期 / `裕` 2 会期）。
 * **日付では切れない**——**`裕` の 2 本は `利` と書く 2 本と同じ本である。**
 *
 * **`brokenGlyph`（字が壊れている）でも「名簿に無い議員」でもない**——
 * **理由が違えば、運用者が次にすることも違う**（#680 / #711）。
 */
test("#768 本番 pref-41: 未突合 2 件はどちらも sourceConflict（猪村理恵子・桃崎裕介）", { skip: !hasData }, () => {
  const um = JSON.parse(readFileSync(join(DIR, "unmatched.json"), "utf-8")) as LocalUnmatchedName[];
  assert.deepEqual(um.map((u) => ({ name: u.nameText, reason: u.reason, rollCalls: u.rollCallIds.length })), [
    { name: "桃崎裕介", reason: "sourceConflict", rollCalls: 2 },
    { name: "猪村理恵子", reason: "sourceConflict", rollCalls: 21 },
  ]);
  assert.equal(meta().counts.unmatchedNames, 2);
  // **名簿側の 2 人には、その会期の票が 1 つも付いていない**（寄せていないことの確認）
  const index = JSON.parse(readFileSync(join(DATA, "members", "index.json"), "utf-8")) as LocalMember[];
  const saga = index.filter((m) => m.assemblyId === "pref-41");
  assert.equal(saga.length, 37);
  const imura = saga.find((m) => m.name === "猪村 利恵子")!;
  const momo = saga.find((m) => m.name === "桃崎 祐介")!;
  assert.equal(imura.counts.rollcalls, 2, "猪村利恵子（利）に付くのは 4月臨時会の 2 件だけ（6月定の 21 件は付かない）");
  assert.equal(momo.counts.rollcalls, 21, "桃崎祐介（祐）に付くのは 6月定の 21 件だけ（4月臨の 2 件は付かない）");
  // **ほかの 35 人は 23 件すべてに付く**（この 2 人だけが欠けていること）
  const others = saga.filter((m) => m.id !== imura.id && m.id !== momo.id);
  assert.deepEqual([...new Set(others.map((m) => m.counts.rollcalls))], [23], "ほかの 35 人は 23 件");
});

/**
 * ## **`議` は全採決で 1 人**（#529 の錨）
 *
 * **「議長は 1 人」は当たり前に見えるが、当たり前ではない**——
 * **佐賀の列見出し `議員名` の `議` が議員の帯の x の中にある**（全 16 本）ので、
 * **拾い方を誤ると幻の行ができる**（`votes-pdf.ts` の `readRowBands`）。
 * **#765 は「`議` が同じ 1 人の列に立つ」が佐賀では恒真（記号を回しても 16/16 で成り立つ）と測っている**
 * ので、**これは順序の証明ではない**。**順序は `readVoteCells` の「k 番目が k 番目の列」が受け持つ。**
 *
 * **ただし「議長は採決に加わらない」と決め打ちはしていない**——
 * **令和5年11月定の再議の 1 行だけ `議` が 1 つも無く、37 人全員が賛否を出している**
 * （実測。この 2 会期には入っていないが、実装は記号をそのまま読む）。
 */
test("#768 本番 pref-41: `議` は全 23 採決で 1 人（会期ごとに同じ 1 人）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  const chairsBySession = new Map<string, Set<string>>();
  for (const rc of rcs) {
    const gi = rc.votes.filter((v) => v.value.raw === "議");
    assert.equal(gi.length, 1, `${rc.id}: 議 が ${gi.length} 人`);
    assert.equal(gi[0].value.legend, "議長");
    assert.equal(gi[0].value.mapped, "投票なし");
    const s = chairsBySession.get(rc.sessionId) ?? new Set();
    s.add(gi[0].nameText);
    chairsBySession.set(rc.sessionId, s);
  }
  assert.deepEqual(
    [...chairsBySession].map(([k, v]) => [k, [...v]]).sort(),
    [["2026-04-rinji-list06671", ["宮原真一"]], ["2026-06-teirei-list06680", ["宮原真一"]]],
    "どちらの会期も議長は 宮原真一 の 1 人",
  );
});

/** **出典はすべて県議会の公式ホスト**（`validateLocalAssemblies` も見るが、値をここでも固定する）。 */
test("#768 本番 pref-41: sourceUrl はすべて www.pref.saga.lg.jp", { skip: !hasData }, () => {
  const urls = new Set<string>();
  for (const rc of rollCalls()) urls.add(rc.sourceUrl);
  for (const s of meta().sources) urls.add(s.url);
  for (const s of meta().sessions) { urls.add(s.sourceUrl); for (const p of s.pdfUrls ?? []) urls.add(p); }
  const bad = [...urls].filter((u) => new URL(u).host !== SAGA_HOST || new URL(u).protocol !== "https:");
  assert.deepEqual(bad, []);
  assert.ok(urls.size >= 6, `出典が ${urls.size} 本`);
});

/**
 * **`counts`（PDF 自身が印刷している集計）と、抽出した記号の数が合う。**
 * **これは「氏名の列が正しい」証明ではない**（数だけ）が、
 * **記号を落としたり増やしたりしていないことを、`data/` を読み直して確かめられる。**
 */
test("#768 本番 pref-41: ○ の数 = counts.yes / × の数 = counts.no（全 23 採決）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  assert.equal(rcs.length, 23);
  for (const rc of rcs) {
    assert.ok(rc.counts, `${rc.id}: counts がある`);
    assert.equal(rc.votes.filter((v) => v.value.raw === "○").length, rc.counts!.yes, `${rc.id}: ○`);
    assert.equal(rc.votes.filter((v) => v.value.raw === "×").length, rc.counts!.no, `${rc.id}: ×`);
    // **`賛成` / `反対` に落ちるのは `○` / `×` だけ**（`議` `除` は `投票なし`）
    assert.equal(rc.votes.filter((v) => v.value.mapped === "賛成").length, rc.counts!.yes);
    assert.equal(rc.votes.filter((v) => v.value.mapped === "反対").length, rc.counts!.no);
  }
});

/** **`kana` が 37 人すべてにある**（#632 の検算が効く議会。青森・秋田は空だった）。 */
test("#768 本番 pref-41: 37 人全員に kana がある（#632 の検算が効く）", { skip: !hasData }, () => {
  const index = JSON.parse(readFileSync(join(DATA, "members", "index.json"), "utf-8")) as LocalMember[];
  const saga = index.filter((m) => m.assemblyId === "pref-41");
  assert.deepEqual(saga.filter((m) => m.kana === "").map((m) => m.name), []);
  assert.deepEqual(saga.filter((m) => m.district === "").map((m) => m.name), []);
  assert.deepEqual(saga.filter((m) => m.group === "").map((m) => m.name), []);
});
