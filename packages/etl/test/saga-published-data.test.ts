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

test("#768 本番 pref-41: 採決 366 × 議員 37 = 13,542 セル、抽出不能 0.00%", { skip: !hasData }, () => {
  const m = meta();
  const rcs = rollCalls();
  // **実測 2026-09-23**（**#901 で既定を 2 → 13 にした。23 → 366 採決、851 → 13,542 セル**）。
  // **37 × 366 = 13,542 にはならない**——**令和5年2月定例会は 36 人**…ではなく、
  // **13 会期はすべて 37 人**なので **37 × 366 = 13,542** ちょうどである（下で検算する）。
  assert.equal(m.counts.rollcalls, 366);
  assert.equal(m.counts.members, 37);
  assert.equal(m.counts.cells, 13_542);
  assert.equal(37 * 366, 13_542, "**全 13 会期が 37 人**（欠けた会期があればここが合わない）");
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
  // **実測 2026-09-23**（**母数 13,542。足すと 13,542 になることを下で検算する**）
  assert.deepEqual(Object.fromEntries([...raw].sort()),
    { "×": 482, "△": 13, "○": 12_595, "欠": 83, "議": 365, "除": 4 });
  assert.equal([...raw.values()].reduce((a, b) => a + b, 0), 13_542, "記号の合計 = セルの母数（#757）");
  // **`議` が 366 ではなく 365 なのは、議長も投じた採決が 1 本あるから**（下のテストが名指しする）
  assert.equal(raw.get("議"), 365);
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
    { name: "桃崎裕介", reason: "sourceConflict", rollCalls: 3 },
    { name: "猪村理恵子", reason: "sourceConflict", rollCalls: 126 },
  ]);
  assert.equal(meta().counts.unmatchedNames, 2);
  // **名簿側の 2 人には、その会期の票が 1 つも付いていない**（寄せていないことの確認）
  const index = JSON.parse(readFileSync(join(DATA, "members", "index.json"), "utf-8")) as LocalMember[];
  const saga = index.filter((m) => m.assemblyId === "pref-41");
  assert.equal(saga.length, 37);
  const imura = saga.find((m) => m.name === "猪村 利恵子")!;
  const momo = saga.find((m) => m.name === "桃崎 祐介")!;
  // **欠けた件数が `unmatched.json` の件数とちょうど合う**（#757 の検算）。
  // **「366 から引いた残り」になっていることが、票が消えても増えてもいないことの証拠である**——
  // **寄らなかった票が別人に付いていれば、誰かが 366 を超えるか、この引き算が合わない。**
  assert.equal(imura.counts.rollcalls, 240, "猪村利恵子（利）: 366 − 126（`猪村理恵子` と書かれた採決）");
  assert.equal(366 - 126, 240, "引き算を式で残す");
  assert.equal(momo.counts.rollcalls, 363, "桃崎祐介（祐）: 366 − 3（`桃崎裕介` と書かれた採決）");
  assert.equal(366 - 3, 363, "引き算を式で残す");
  // **ほかの 35 人は 366 件すべてに付く**（この 2 人だけが欠けていること）
  const others = saga.filter((m) => m.id !== imura.id && m.id !== momo.id);
  assert.deepEqual([...new Set(others.map((m) => m.counts.rollcalls))], [366], "ほかの 35 人は 366 件");
  // **誰も 366 を超えない**（**超えたら、寄らなかった票がその人に付いている**。#569 の重いほう）
  assert.deepEqual(saga.filter((m) => m.counts.rollcalls > 366).map((m) => m.name), [], "366 を超える議員");
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
/**
 * ## **`議` は各採決で 1 人——ただし 366 本のうち 1 本だけ 0 人である**（#901 で広げて初めて出た）
 *
 * **`--sessions 2` のときは 23 本すべてが 1 人だった。**
 * **13 会期に広げたら、令和5年11月定例会に `議` が 1 つも無い採決が 1 本出た。**
 *
 * **中身を見ると、これは読み落としではなく一次資料どおりである**:
 * **知事の再議**（地方自治法 176 条）で、**出席議員の 3 分の 2 以上を要する採決**——
 * **`出席者数 37 / 議決者数 37`** で、**議長も投じている**（○ 18 / × 19 で 37）。
 * **「議長は投票しない」は常にではない。**
 *
 * **だから「全 366 本が 1 人」とは書けない。**
 * **書けるのは「1 人か 0 人」「0 人なのはこの 1 本だけ」「その 1 本は議決者数 = 出席者数」である。**
 */
test("#768 本番 pref-41: `議` は各採決で 1 人（再議の 1 本だけ 0 人。議長も投じている）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  assert.equal(rcs.length, 366, "母数（#757）");
  const chairsBySession = new Map<string, Set<string>>();
  const noChair: string[] = [];
  for (const rc of rcs) {
    const gi = rc.votes.filter((v) => v.value.raw === "議");
    assert.ok(gi.length <= 1, `${rc.id}: 議 が ${gi.length} 人（2 人以上は列がずれた印）`);
    if (gi.length === 0) { noChair.push(rc.id); continue; }
    assert.equal(gi[0].value.legend, "議長");
    assert.equal(gi[0].value.mapped, "投票なし");
    const s = chairsBySession.get(rc.sessionId) ?? new Set();
    s.add(gi[0].nameText);
    chairsBySession.set(rc.sessionId, s);
  }
  // **`議` が 0 人なのは 1 本だけ**（**増やしたら気づく。黙って増えない**）
  assert.deepEqual(noChair, ["pref-41-2023-11-teirei-list05990-20231221-－-1"],
    "**知事の再議（地方自治法 176 条）。議長も投じているので `議` が無い**");
  const reconsider = rcs.find((rc) => rc.id === noChair[0])!;
  assert.equal(reconsider.counts?.present, 37, "出席者数");
  assert.equal(reconsider.counts?.voting, 37, "**議決者数 = 出席者数**（議長も数に入っている）");
  assert.equal(reconsider.counts!.yes + reconsider.counts!.no, 37, "○ + × = 37（全員が投じた）");
  assert.equal(reconsider.result, "否決");
  // **会期ごとに議長は 1 人**（**13 会期で 2 人。2023-06 に 宮原真一 → 大場芳博 で交代**）
  const chairs = [...chairsBySession].map(([k, v]) => [k, [...v]] as const).sort();
  assert.equal(chairs.length, 13, "議長の付いた会期の数");
  for (const [sid, names] of chairs) assert.equal(names.length, 1, `${sid}: 議長が ${names.length} 人`);
  assert.deepEqual([...new Set(chairs.flatMap(([, n]) => n))].sort(), ["大場芳博", "宮原真一"],
    "**13 会期に出る議長は 2 人**（一般選挙をまたいでいないので、途中で交代した）");
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
test("#768 本番 pref-41: ○ の数 = counts.yes / × の数 = counts.no（全 366 採決）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  assert.equal(rcs.length, 366);
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
