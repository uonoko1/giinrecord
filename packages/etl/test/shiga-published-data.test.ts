import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { LocalAssemblyMeta, LocalMember, LocalRollCall, LocalUnmatchedName } from "@seiji-kiroku/shared";
import { SHIGA_HOST } from "../src/sources/local/shiga/site.ts";

/**
 * **本番 `data/assemblies/pref-25/` に出したものを、出した後から読み直して数える**（Issue #865／#901）。
 *
 * **`votes-pdf.ts` のテストは PDF を読む側を見ている。ここは「書いたもの」を見る。**
 * **`data/` の JSON を読み直しているので、書き出しが壊れたらここが落ちる。**
 *
 * **#864 の `published-data-validate.test.ts` とは重ならない**——あちらは**全県まとめて構造の不変条件**。
 *
 * ## **#901 で `--sessions` を 2 → 19 に広げた**（14 採決 → 163 採決）
 *
 * **数字を入れ替えるだけでは「増えたものが正しい」ことの検算にならない**（#901 の本文）。
 * **だから、149 本の新しい採決にも当たる錨を先に決めてから数を書いた**:
 *
 * | 錨 | なぜ増えたぶんにも当たるか |
 * |---|---|
 * | **生の `○` / `×` の数 = 県の公表値**（163 / 163 本） | **凡例に依存しない。** 列が 1 つずれれば数が変わる |
 * | **議長（`議`）が 1 本に 1 人**（163 / 163 本） | **議長は会期の塊ごとに 4 人へ入れ替わる**（下）。塊が崩れれば落ちる |
 * | **1 本の PDF の中では列数が一定**（28 / 28 本） | **議員が静かに落ちれば落ちる** |
 * | **`counts` が 163 本すべてにある** | 母数（#757）。0 件を緑にしない |
 *
 * ## **`抽出不能` が 27.2% → 66.4% に増えた**（**これは欠陥ではない**）
 *
 * **2024-04 〜 2026-06 の PDF には凡例の文が 1 文字も入っていない**
 * （`Kg799_0712go.pdf` を文字アイテムで直接見て確かめた。#901）。
 * **古い本（2023-05 〜 2024-02）と最新の本（2026-07）には入っている。**
 * **県が途中で凡例を落とし、また戻した。**
 *
 * **`raw` は読めている**（`○` 4,015 / `×` 406 / `議` 110 / `欠` 29 / `―` 9）——**引けなかったのは意味だけ。**
 * **だから `mapped` を付けない**（#569。**`○` が賛成だと PDF が言っていない本で、賛成だと書かない**）。
 */
const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));
const DIR = join(DATA, "assemblies", "pref-25");

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
const members = (): LocalMember[] =>
  (JSON.parse(readFileSync(join(DATA, "members", "index.json"), "utf-8")) as LocalMember[]).filter((m) => m.assemblyId === "pref-25");

test("#901 本番 pref-25: 採決 163 / セル 6,886 / 名簿 42 人（meta.json と実物が一致する）", { skip: !hasData }, () => {
  const m = meta();
  const rcs = rollCalls();
  // **実測 2026-09-23**（`--sessions 19`。令和5年5月招集会議 〜 令和8年7月定例会議）
  assert.equal(m.counts.rollcalls, 163);
  assert.equal(m.counts.members, 42);
  assert.equal(m.counts.cells, 6886);
  // **`unknownCells` は `raw === "不明"` の数**（セルを確実に置けなかった数）で、
  // **`抽出不能`（凡例が引けない）とは別の数**——**滋賀は前者 0・後者 4,569。混ぜない。**
  assert.equal(m.counts.unknownCells, 0, "**推定せず `不明` で残したセルは 0**");
  assert.equal(m.counts.unmatchedNames, 10);
  assert.equal(rcs.length, m.counts.rollcalls, "rollcalls/ の実ファイル数");
  assert.equal(rcs.reduce((s, r) => s + r.votes.length, 0), m.counts.cells, "票の実数");
  assert.equal(m.sessions.length, 19, "**会期の数**（`--sessions 19`）");
  assert.deepEqual(m.sessions.map((s) => [s.sessionId, s.rollcalls]).sort(), [
    ["2023-05-rinji", 6], ["2023-06", 8], ["2023-09", 5], ["2023-11", 10], ["2024-02", 14],
    ["2024-04-rinji", 4], ["2024-06", 10], ["2024-09", 7], ["2024-11", 8], ["2025-02", 16],
    ["2025-04-rinji", 4], ["2025-06", 11], ["2025-09", 9], ["2025-11", 12], ["2026-01-rinji", 1],
    ["2026-02", 17], ["2026-04-rinji", 7], ["2026-06-rinji", 4], ["2026-07", 10],
  ].sort());
  assert.equal(m.sessions.reduce((s, x) => s + x.rollcalls, 0), 163, "会期ごとの和 = 母数");
  // **本番に今出ている 2 会期は、広げても件数が変わらない**（広げたぶんが下に積まれただけ）
  assert.deepEqual(m.sessions.filter((s) => s.sessionId === "2026-07" || s.sessionId === "2026-06-rinji").map((s) => s.rollcalls).sort(), [10, 4].sort());
});

/**
 * ## **錨 1: 1 本の PDF の中では列数が一定**（**議員が静かに落ちれば落ちる**）
 *
 * **会期ではなく PDF で見る**——**1 会期が別の日の 2 本にまたがることがあり、
 * その間に議員が 1 人辞めると会期の中で 42 → 41 に変わるのが正しい**
 * （`2025-09` は 09-05 の 42 人と 10-17 の 41 人。実測）。
 * **「会期の中で一定」にすると、この正しい形が赤くなる。**
 */
test("#901 本番 pref-25: 1 本の PDF の中では列数が一定（28 / 28 本。議員が静かに落ちていない）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  const byPdf = new Map<string, Set<number>>();
  for (const r of rcs) {
    const s = byPdf.get(r.sourceUrl) ?? new Set<number>();
    s.add(r.votes.length);
    byPdf.set(r.sourceUrl, s);
  }
  // **母数**（#757）——28 本の PDF を 1 本残らず見ている
  assert.equal(byPdf.size, 28, "採決が指す PDF の本数");
  assert.deepEqual([...byPdf].filter(([, v]) => v.size !== 1).map(([k, v]) => [k.split("/").pop(), [...v]]), [], "1 本の中で列数がぶれた PDF");
  // **列数は 40 〜 44 の間で動く**（3 年ぶんなので辞職・補選で動くのが正しい）
  const counts = [...new Set([...byPdf.values()].map((s) => [...s][0]))].sort((a, b) => a - b);
  assert.deepEqual(counts, [40, 41, 42, 43, 44]);
  // **`2025-09` は 1 会期で 2 通り**（09-05 の 42 人 / 10-17 の 41 人）——**これが正しい形**
  const s2509 = rcs.filter((r) => r.sessionId === "2025-09");
  assert.equal(s2509.length, 9, "母数");
  assert.deepEqual(
    Object.fromEntries([...s2509.reduce((m2, r) => m2.set(r.date, r.votes.length), new Map<string, number>())].sort()),
    { "2025-09-05": 42, "2025-10-17": 41 },
  );
});

/**
 * ## **錨 2: 生の `○` / `×` の数 = 県の公表値**（**163 / 163 本**）
 *
 * **`countMismatchesOf` は `mapped` の無いセルがある行を母数から外す**——
 * **意味で数えると 0 対 0 になり、偽の食い違いが出るから**（`local-assemblies.ts` の docblock）。
 * **`--sessions 19` では 163 行のうち 111 行が外れる**（`meta.countChecked`）。
 * **外した 111 行は本番でどこからも突き合わせられていない。**
 *
 * **生の記号を数えれば、凡例が引けない行にも当てられる**——**意味に依存しないので。**
 * **そして 163 / 163 本で県の公表値と合う。**
 *
 * **これは「増えた 149 本が正しい」ことの、いちばん強い錨である**——
 * **列が 1 つでもずれれば `○` の数が変わる**（#819 の x の錨）。
 */
test("#901 本番 pref-25: 生の ○ / × の数 = 公表値（163 / 163 本。共通の検算が外す 111 行を含む）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  assert.equal(rcs.length, 163, "母数");
  let checked = 0;
  let unreadRows = 0;
  for (const rc of rcs) {
    assert.ok(rc.counts, `${rc.id}: counts が無い`);
    assert.equal(rc.votes.filter((v) => v.value.raw === "○").length, rc.counts!.yes, `${rc.id}: ○`);
    assert.equal(rc.votes.filter((v) => v.value.raw === "×").length, rc.counts!.no, `${rc.id}: ×`);
    checked++;
    if (rc.votes.some((v) => v.value.mapped === undefined)) unreadRows++;
  }
  assert.equal(checked, 163, "**生の記号で突き合わせた採決の数**（1 本残らず）");
  assert.equal(unreadRows, 111, "**そのうち共通の検算（意味で数える側）が母数から外す行**");
  // **meta 側も同じことを言っている**（#757。`unreadableCells` が 111、`checked` は 52）
  assert.deepEqual(meta().countChecked, { rows: 163, checked: 52, noCounts: 0, unreadableCells: 111 });
  assert.equal(meta().countMismatches, undefined, "意味で数えた側の食い違いは 0（省略される）");
  assert.equal(52 + 111, 163, "母数を式で残す");
  // **`present` / `voting` も PDF が印刷している**（滋賀だけ。`yes + no + 棄権` の関係は主張しない）
  assert.deepEqual([...new Set(rcs.map((r) => r.counts!.present))].sort((a, b) => a! - b!), [40, 41, 42, 43, 44]);
});

/**
 * ## **`抽出不能` 4,569 / 6,886 セル（66.4%）——凡例の無い本が 2 年ぶん続く**
 *
 * **`--sessions 2` のときは 164 / 604（27.2%）だった。** **広げて増えたのは欠陥ではない。**
 * **2024-04 〜 2026-06 の 13 会期は、PDF に凡例の文が 1 文字も入っていない**（実測）。
 *
 * **青森・秋田・佐賀・宮城・三重・奈良はいずれも 0 件**——**滋賀だけが違う。**
 * **「0%」を他県から写してくると、滋賀では偽になる。**
 */
test("#901 本番 pref-25: 抽出不能 4,569 / 6,886 セル（66.4%）は凡例の無い 13 会期に固まる", { skip: !hasData }, () => {
  const rcs = rollCalls();
  const votes = rcs.flatMap((r) => r.votes);
  assert.equal(votes.length, 6886, "母数（減っていたらこの割合は意味が無い）");
  const unread = votes.filter((v) => v.value.legend === "抽出不能");
  assert.equal(unread.length, 4569, "`抽出不能` のセル");
  assert.equal(Math.round((unread.length / votes.length) * 1000) / 10, 66.4, "割合（%）");
  // **`mapped` が無いのはその 4,569 セルだけ**（過不足なく一致する）
  assert.equal(votes.filter((v) => v.value.mapped === undefined).length, 4569);
  assert.deepEqual(unread.filter((v) => v.value.mapped !== undefined), []);
  // **記号そのものは読めている**（凡例が引けなかっただけ）。**`不明` は 1 つも無い**
  const raw = new Map<string, number>();
  for (const v of unread) raw.set(v.value.raw, (raw.get(v.value.raw) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries([...raw].sort()), { "×": 406, "―": 9, "○": 4015, "欠": 29, "議": 110 });
  assert.equal(raw.get("不明"), undefined, "`不明` のセルは無い");
  // **会期ごとに「全部読めた」か「1 つも読めなかった」かに割れる**——**本の作りが変わった境である**
  const per = new Map<string, { unread: number; total: number }>();
  for (const r of rcs) {
    const p = per.get(r.sessionId) ?? { unread: 0, total: 0 };
    p.total += r.votes.length;
    p.unread += r.votes.filter((v) => v.value.legend === "抽出不能").length;
    per.set(r.sessionId, p);
  }
  const none = [...per].filter(([, p]) => p.unread === 0).map(([k]) => k).sort();
  const all = [...per].filter(([, p]) => p.unread === p.total).map(([k]) => k).sort();
  // **`2023-05-rinji` だけ中途半端**（264 セル中 1 つだけ凡例が引けない）——**丸めない**
  const partial = [...per].filter(([, p]) => p.unread !== 0 && p.unread !== p.total).map(([k, p]) => [k, p.unread, p.total]);
  assert.deepEqual(none, ["2023-06", "2023-09", "2023-11", "2024-02", "2026-07"], "凡例が全部引けた会期");
  assert.deepEqual(all, [
    "2024-04-rinji", "2024-06", "2024-09", "2024-11", "2025-02", "2025-04-rinji",
    "2025-06", "2025-09", "2025-11", "2026-01-rinji", "2026-02", "2026-04-rinji", "2026-06-rinji",
  ], "凡例が 1 つも引けなかった会期");
  assert.deepEqual(partial, [["2023-05-rinji", 1, 264]], "中途半端な会期");
  assert.equal(none.length + all.length + partial.length, 19, "母数を式で残す");
  // **凡例が引けた 2,317 セルの意味の内訳**（推定していない＝この 4 通りしか出ない）
  const ok = votes.filter((v) => v.value.legend !== "抽出不能");
  assert.equal(ok.length, 2317);
  assert.deepEqual(Object.fromEntries([...ok.reduce((m2, v) => m2.set(v.value.legend, (m2.get(v.value.legend) ?? 0) + 1), new Map<string, number>())].sort()),
    { "反対": 230, "表決に参加していない": 15, "議長（表決権なし）": 53, "賛成": 2019 });
  assert.equal(4569 + 2317, 6886, "母数を式で残す");
});

/**
 * ## **錨 3: `議` は 163 / 163 本で 1 人、議長は会期の塊ごとに 4 人へ入れ替わる**
 *
 * **凡例が引けない本でも `議` は読めている**（`raw` は `議`、`legend` が `抽出不能`）。
 * **「`議` の legend が常に議長」は滋賀では偽**——**他県から写すと落ちる。**
 *
 * **3 年ぶんに広げたので議長が 4 人出る。** **4 人それぞれが連続した会期の塊を持つ**——
 * **会期の並びや行の割り当てが崩れれば、塊が混ざって落ちる。**
 * **これは「増えた 149 本が正しい会期に入っている」ことの錨である**（#819 の y の錨）。
 *
 * **氏名が `加 藤 誠 一` と空白入りなのは PDF がそう組んでいるから**——**詰めない**（原文のまま残す）。
 */
test("#901 本番 pref-25: `議` は 163 本すべてで 1 人（議長は 4 人・会期の塊ごとに入れ替わる）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  const perRollCall = new Map<number, number>();
  const bySession = new Map<string, Set<string>>();
  const ids = new Map<string, Set<string>>();
  for (const rc of rcs) {
    const gi = rc.votes.filter((v) => v.value.raw === "議");
    perRollCall.set(gi.length, (perRollCall.get(gi.length) ?? 0) + 1);
    for (const v of gi) {
      const s = bySession.get(v.nameText) ?? new Set<string>();
      s.add(rc.sessionId);
      bySession.set(v.nameText, s);
      const i = ids.get(v.nameText) ?? new Set<string>();
      i.add(v.memberId);
      ids.set(v.nameText, i);
    }
  }
  assert.deepEqual(Object.fromEntries(perRollCall), { 1: 163 }, "採決ごとの `議` の数（母数 163）");
  // **議長は 4 人。会期の塊が重ならない**（1 つの会期に 2 人の議長が出ない）
  assert.equal(bySession.size, 4, "議長の人数");
  assert.deepEqual(Object.fromEntries([...bySession].map(([k, v]) => [k, [...v].sort()]).sort()), {
    "加 藤 誠 一": ["2026-04-rinji", "2026-06-rinji", "2026-07"],
    "奥 村 芳 正": ["2023-05-rinji", "2023-06", "2023-09", "2023-11", "2024-02"],
    "有 村 國 俊": ["2024-04-rinji", "2024-06", "2024-09", "2024-11", "2025-02"],
    "目 片 信 悟": ["2025-04-rinji", "2025-06", "2025-09", "2025-11", "2026-01-rinji", "2026-02"],
  });
  assert.equal([...bySession.values()].reduce((s, v) => s + v.size, 0), 19, "会期の和 = 母数（重なりも抜けも無い）");
  // **4 人とも名簿に寄っている**（1 人 1 つの memberId）
  assert.deepEqual(Object.fromEntries([...ids].map(([k, v]) => [k, [...v]]).sort()), {
    "加 藤 誠 一": ["p_25_159"], "奥 村 芳 正": ["p_25_37"], "有 村 國 俊": ["p_25_141"], "目 片 信 悟": ["p_25_152"],
  });
});

/**
 * ## **名簿に寄らなかった氏名 10 行（8 人）——1 行も推定していない**（#529／#569／#680）
 *
 * **10 行とも `candidates` が空**——**名簿に同姓同名すら居ない。**
 * **だから「別人に付けてしまう」余地が無い。** **票は `memberId` 空のまま残す**（消さない）。
 *
 * **中身は 3 通りある。混ぜない**:
 *
 * 1. **`□ 正 隆`（`brokenGlyph`・15 票）**: 姓が `□`（U+25A1）に潰れている。
 *    **名簿に `辻 正隆` がいて、同じ議会の別の本では `辻󠄀 正 隆` と読めている**が、
 *    **「壊れた字がその人である」とは決めない**（#569／#796）。
 * 2. **名簿から消えた 2 人（`白 井 幸 則` 163 票 / `九 里 学` 163 票）**:
 *    **県が 2026-09-13 → 09-23 のあいだに名簿から外した。** **#901 の広げとは無関係**——
 *    **`--sessions 2` のままでも同じことが起きる**（実測: 広げる前の 14 本でも寄らない）。
 * 3. **この任期の途中で退いた議員**（`大野和三郎` / `岩 佐 弘 明` / `河 井 昭 成` / `角 田 航 也` / `重 田 剛`）:
 *    **広げたことで出てきた**。**今の名簿に居ないので寄らないのが正しい。**
 *
 * **このテストは「同一人物である」とも「別人である」とも言わない。**
 * **言うのは「ETL が推定しなかった」という事実だけ**である。
 */
test("#901 本番 pref-25: 未突合 10 行（8 人）は 1 つも候補を持たない（別人に付く余地が無い）", { skip: !hasData }, () => {
  const um = JSON.parse(readFileSync(join(DIR, "unmatched.json"), "utf-8")) as LocalUnmatchedName[];
  assert.equal(um.length, 10, "母数");
  assert.equal(meta().counts.unmatchedNames, 10);
  // **1 行も候補を持たない**——**「2 人以上いてどちらか選べない」ではなく「1 人も居ない」**
  assert.deepEqual(um.filter((u) => (u.candidates ?? []).length > 0).map((u) => u.nameText), [], "候補を持つ行");
  assert.deepEqual(um.map((u) => [u.nameText, u.reason ?? null, u.rollCallIds.length]).sort(), [
    ["□ 正 \u{F9DC}", "brokenGlyph", 15],
    ["九 里 学", null, 57], ["九 里 学", null, 106],
    ["大 野 和 三 郎", null, 46], ["大野和三郎", null, 18],
    ["岩 佐 弘 明", null, 29], ["河 井 昭 成", null, 124],
    ["白 井 幸 則", null, 163], ["角 田 航 也", null, 57],
    ["重 田 剛", null, 142],
  ].sort());
  // **氏名で束ねると 8 人**（`九 里 学` と `大野和三郎` が会派・字詰めの違いで 2 行ずつ）
  assert.equal(new Set(um.map((u) => u.nameText.replace(/[\s　]/g, ""))).size, 8, "人数");
  // **機序が符号位置で分かる**（推定ではなく、文字そのものが違う）
  assert.equal("□".codePointAt(0), 0x25a1, "PDF 側の姓は白い四角（U+25A1）");
  // **`memberId` が空の票は 757**（6,886 のうち 11.0%）。**消していない**
  const rcs = rollCalls();
  const orphan = rcs.flatMap((r) => r.votes).filter((v) => v.memberId === "");
  assert.equal(orphan.length, 757, "母数 6,886 のうち名簿に寄らなかった票");
  assert.deepEqual(
    Object.fromEntries([...orphan.reduce((m2, v) => m2.set(v.nameText, (m2.get(v.nameText) ?? 0) + 1), new Map<string, number>())].sort()),
    { "□ 正 \u{F9DC}": 15, "九 里 学": 163, "大 野 和 三 郎": 46, "大野和三郎": 18, "岩 佐 弘 明": 29, "河 井 昭 成": 124, "白 井 幸 則": 163, "角 田 航 也": 57, "重 田 剛": 142 },
  );
  assert.equal(15 + 163 + 46 + 18 + 29 + 124 + 163 + 57 + 142, 757, "母数を式で残す");
  // **同じ議会の別の PDF では `辻󠄀` が読めている**（異体字セレクタ U+E0100 つき。**寄せている**）
  const ok = rcs.flatMap((r) => r.votes).filter((v) => v.nameText.startsWith("辻"));
  assert.equal(ok.length, 6, "`辻` と読めた票");
  assert.deepEqual([...new Set(ok.map((v) => v.nameText))], ["辻\u{E0100} 正 \u{F9DC}"]);
  assert.deepEqual([...new Set(ok.map((v) => v.memberId))], ["p_25_197"]);
});

/**
 * ## **議決結果の欄が一次資料で空の 3 件**（#901。**多数決から埋めない**）
 *
 * **`Kg835_0425sanpi2.pdf` の 1 ページ目は `議決結果` の列見出しがあるのに 3 行とも値が無く、
 * 同じ本の 2 ページ目の行には `承認` がある**——**読めないのではなく書かれていない**（実測）。
 *
 * **`counts` は 3 行とも読めている**ので「賛成多数だから可決」と書けるが、**書かない**
 * （docs/DATA_CONTRACT.md。**推論した文字列を県の公表値として出せば、利用者から見分けがつかない**）。
 */
test("#901 本番 pref-25: `resultAbsent` は 3 件だけ（163 のうち。多数決から埋めていない）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  assert.equal(rcs.length, 163, "母数");
  const absent = rcs.filter((r) => r.resultAbsent === true);
  assert.equal(absent.length, 3);
  assert.deepEqual(absent.map((r) => [r.sessionId, r.title]).sort(), [
    ["2025-04-rinji", "特別委員会改編動議"],
    ["2025-04-rinji", "議第98号（人事案件）"],
    ["2025-04-rinji", "議長辞職の件"],
  ].sort());
  // **`resultAbsent` が付いた行の `result` は空、付いていない行は空でない**（過不足なく一致する）
  for (const r of absent) assert.equal(r.result, "", r.id);
  assert.deepEqual(rcs.filter((r) => r.result === "" && r.resultAbsent !== true).map((r) => r.id), [], "`resultAbsent` 無しで空の行");
  // **`counts` はある**——**埋めようと思えば埋められたのに埋めていない**
  assert.deepEqual(absent.map((r) => r.counts?.yes).sort((a, b) => a! - b!), [38, 40, 41]);
  // **3 件とも 1 本の PDF の 1 ページ目**（散らばっていたら読み取りの壊れを疑うべき形）
  assert.deepEqual([...new Set(absent.map((r) => r.sourceUrl.split("/").pop()))], ["Kg835_0425sanpi2.pdf"]);
  assert.deepEqual([...new Set(absent.map((r) => r.page))], [1]);
});

/** **出典はすべて県議会の公式ホスト**（**Shift_JIS のサイト。PDF は 28 本**）。 */
test("#901 本番 pref-25: sourceUrl はすべて www.shigaken-gikai.jp（採決 163 本 + meta の 49 出典 + 会期 19 本）", { skip: !hasData }, () => {
  const m = meta();
  const rcs = rollCalls();
  const urls: string[] = [];
  for (const rc of rcs) urls.push(rc.sourceUrl);
  for (const s of m.sources) urls.push(s.url);
  for (const s of m.sessions) { urls.push(s.sourceUrl); urls.push(s.pdfUrl); for (const p of s.pdfUrls ?? []) urls.push(p); }
  // **母数**（#757。0 本を「違反なし」と読み違えないため）
  assert.equal(m.sources.length, 49, "meta の出典（名簿 1 + 年の一覧 1 + 会期 19 + PDF 28）");
  assert.equal(1 + 1 + 19 + 28, 49, "母数を式で残す");
  assert.equal(urls.length, 163 + 49 + 19 + 19 + 28, "**見た URL の本数**");
  const bad = urls.filter((u) => new URL(u).host !== SHIGA_HOST || new URL(u).protocol !== "https:");
  assert.deepEqual([...new Set(bad)], []);
  const pdfs = [...new Set(rcs.map((r) => r.sourceUrl))].sort();
  assert.equal(pdfs.length, 28, `採決が指す PDF（${pdfs.length} 本）`);
  assert.deepEqual(pdfs.filter((u) => !u.endsWith(".pdf")), [], "PDF でない出典");
  assert.equal(m.sources.filter((s) => s.url.endsWith(".pdf")).length, 28, "meta の出典の PDF");
  // **会期ページは `.asp?KaigiID=`**（連番に見えて飛ぶので組み立てない。#670）
  const ids = m.sessions.map((s) => Number(new URL(s.sourceUrl).searchParams.get("KaigiID"))).sort((a, b) => a - b);
  assert.deepEqual(ids, [231, 232, 233, 234, 237, 239, 240, 241, 242, 243, 247, 248, 249, 250, 252, 254, 255, 256, 258]);
  assert.equal(ids.length, 19, "母数");
  assert.notEqual(ids[ids.length - 1] - ids[0] + 1, ids.length, "**連番ではない**（組み立てずに一覧から取る根拠）");
  assert.equal(m.unreadableSources, undefined, "**19 会期の PDF は全部読めた**（凡例が引けないのは別の話）");
  assert.equal(m.lossyNameMatches, undefined, "字が落ちた氏名の寄せは無い（省略される）");
  assert.equal(m.rosterAsOf, "2026-09-23");
});

/**
 * **名簿 42 人**——**かな・選挙区・会派が全員にある**。
 *
 * **`--sessions 2` のときは 44 人だった**——**県が 2026-09-13 → 09-23 のあいだに
 * `白井 幸則` と `九里 学` を名簿から外した。** **#901 の広げとは無関係である。**
 *
 * **採決数は 163 / 126 / 99 / 10 / 6 に割れる**（19 会期すべてに出るのは 36 人）。
 */
test("#901 本番 pref-25: 名簿 42 人（採決数は 163 が 36 人・126 が 1 人・99 が 1 人・10 が 3 人・6 が 1 人）", { skip: !hasData }, () => {
  const ms = members();
  assert.equal(ms.length, 42, "母数");
  assert.deepEqual(ms.filter((m) => m.kana === "").map((m) => m.name), [], "かなが空の議員");
  assert.deepEqual(ms.filter((m) => m.district === "").map((m) => m.name), [], "選挙区が空の議員");
  assert.deepEqual(ms.filter((m) => m.group === "").map((m) => m.name), [], "会派が空の議員");
  assert.deepEqual(ms.filter((m) => (m.counts?.rollcalls ?? 0) === 0).map((m) => m.name), [], "採決 0 件の議員");
  assert.deepEqual(ms.filter((m) => !m.profileUrl.startsWith(`https://${SHIGA_HOST}/`)).map((m) => m.name), [], "別ホストの profileUrl");
  assert.equal(new Set(ms.map((m) => m.id)).size, 42, "id の重複");
  assert.deepEqual(
    Object.fromEntries([...ms.reduce((m2, m) => m2.set(m.counts?.rollcalls ?? -1, (m2.get(m.counts?.rollcalls ?? -1) ?? 0) + 1), new Map<number, number>())].sort((a, b) => a[0] - b[0])),
    { 6: 1, 10: 3, 99: 1, 126: 1, 163: 36 },
    "名簿の議員ごとの採決数",
  );
  assert.equal(1 + 3 + 1 + 1 + 36, 42, "母数を式で残す");
  // **`辻 正隆` が 6 本**（壊れた字の 15 票は寄せていない。上のテストと同じ事実の名簿側）
  // **名簿の `隆` も互換漢字 U+F9DC**（県のページがそう書いている。畳まない）
  assert.deepEqual(ms.filter((m) => m.counts?.rollcalls === 6).map((m) => m.name), ["辻 正\u{F9DC}"]);
  // **名簿の 42 人は 1 人残らず票に出る**（「名簿にいるのに記録が無い」人が 0 人）
  const seen = new Set(rollCalls().flatMap((r) => r.votes.map((v) => v.memberId)));
  seen.delete("");
  assert.equal(seen.size, 42, `票に出る議員（${seen.size} 人）`);
  assert.deepEqual([...seen].filter((id) => !ms.some((m) => m.id === id)), [], "名簿に無い memberId の票");
});
