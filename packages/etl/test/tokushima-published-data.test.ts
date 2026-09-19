import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { LocalAssemblyMeta, LocalMember, LocalRollCall } from "@seiji-kiroku/shared";
import { TOKUSHIMA_HOST } from "../src/sources/local/tokushima/site.ts";

/**
 * **本番 `data/assemblies/pref-36/` に出したものを、出した後から読み直して数える**（Issue #865）。
 *
 * **`votes-pdf.ts` のテストは PDF を読む側を見ている。ここは「書いたもの」を見る。**
 * **`data/` の JSON を読み直しているので、書き出し（`buildLocalAssembly` / `writeLocalAssembly`）が
 * 壊れたらここが落ちる。**
 *
 * ## **徳島で何を主張するか**——**他県から写していない**
 *
 * **徳島は、ほかの 10 議会で書いた検算のうち 2 つがそもそも当てられない**（実測 2026-09-14）:
 *
 * 1. **`counts` が 153 行とも無い。** だから **「`○` の数 = `counts.yes`」が書けない**
 *    （佐賀・秋田・鳥取・島根で書いた検算）。**PDF に賛成者数・反対者数の欄が無いので付けない**
 *    （`tokushima/rollcalls.ts`: 「表決方法・人数の欄は PDF に無いので method / counts は付けない」）。
 *    **無いことを、無いまま固定する**——**誰かが「他県にあるから」と推定で足したらここが落ちる。**
 * 2. **`○` と `●` に `mapped` が付かない。** 5,562 票のうち **5,305 票（95.4%）が `mapped` 無し。**
 *    **凡例が「委員会審査結果又は議長宣告に起立（賛成）した者」だから**——
 *    **請願が委員会で不採択なら、`○` は請願を退けた側である**（`tokushima/rollcalls.ts` の注記）。
 *    **議案への賛否は凡例から機械的に読めないので、`賛成` に落とさない**（#569: 推定しない）。
 *    **「賛成が 94.7% 欠けている」ように見えるが、それは欠落ではなく、推定を拒んだ跡である。**
 *
 * **徳島だけにある形がもう 2 つ:**
 *
 * 3. **`○` U+25CB と `〇` U+3007 が同じ PDF の同じ行に混ざっている**（1064407.pdf 20 行 / 1075652.pdf 1 行）。
 *    **`raw` は原文のまま残す**ので **2 通りの字が `data/` に出る**（#674 / `glyph-variants.ts` の
 *    コメントが「徳島の本番データ 74 件がその形」と名指ししている）。
 * 4. **`committeeResult`（委員会審査結果）が 153 行ともある。** ほかの 10 議会には無い欄。
 *
 * ## **#901 で `--sessions` を 2 → 4 にした**（2026-09-20）
 *
 * **採決 105 → 153、セル 3,780 → 5,562、`unmatchedNames` 0 → 2。**
 * **寄らなかった 2 人（北島 一人・古川 広志）は 2026-02 会期より前に退いた議員で、
 * 票は `memberId` 空のまま残る**（#529。**推定しない**）。**これは安全側の増え方である。**
 */
const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));
const DIR = join(DATA, "assemblies", "pref-36");

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

test("#865/#901 本番 pref-36: 採決 153・5,562 セル、抽出不能 0.00%、寄らなかった氏名 2", { skip: !hasData }, () => {
  const m = meta();
  const rcs = rollCalls();
  // **実測 2026-09-20**（直近 4 会期。`defaultSessionsFor("tokushima") === 4`。#901）
  assert.equal(m.counts.rollcalls, 153);
  assert.equal(m.counts.members, 36, "**今の名簿の人数**（票に出る列は会期ごとに 36 / 37 / 38）");
  assert.equal(m.counts.cells, 5_562);
  assert.equal(m.counts.unknownCells, 0, "**推定せず残した不明セルは 0**");
  // **`--sessions 2` では 0 だった**——**2025-11 会期に、今の名簿に居ない 2 人が居るため**（#529。**安全側**）
  assert.equal(m.counts.unmatchedNames, 2, "**名簿に寄らなかった氏名**（北島 一人・古川 広志）");
  // **meta の数が、書いた実物と一致する**（meta だけを書き換えても落ちる）
  assert.equal(rcs.length, m.counts.rollcalls, "rollcalls/ の実ファイル数");
  assert.equal(rcs.reduce((s, r) => s + r.votes.length, 0), m.counts.cells, "票の実数");
  // **1 行あたりのセル数は 3 通り**（会期ごとに議員の人数が違う。**会期の中では動かない**）
  const perRow = new Map<number, number>();
  for (const r of rcs) perRow.set(r.votes.length, (perRow.get(r.votes.length) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries([...perRow].sort((a, b) => a[0] - b[0])), { 36: 106, 37: 40, 38: 7 }, "採決ごとのセル数");
  // **会期ごとに 1 通りずつ**（会期の途中で議員が 1 人静かに消えていない。#705 が滋賀で踏んだ形）
  const perSession = new Map<string, Set<number>>();
  for (const r of rcs) (perSession.get(r.sessionId) ?? perSession.set(r.sessionId, new Set()).get(r.sessionId)!).add(r.votes.length);
  assert.deepEqual(
    Object.fromEntries([...perSession].map(([k, v]) => [k, [...v]]).sort()),
    { "2025-11": [38, 37], "2026-02": [36], "2026-06": [36], "2026-09": [36] },
    "**2025-11 だけ 2 通り**（11月28日は 38 人、12月19日は 37 人。この間に 1 人辞職している）",
  );
  assert.equal(rcs.reduce((s, r) => s + r.votes.filter((v) => v.value.legend === "抽出不能").length, 0), 0, "`抽出不能` の票");
});

/**
 * ## **`counts` が 1 行も無いこと、`○` に `mapped` が付かないことを、無いまま固定する**
 *
 * **これは欠落ではなく、推定を拒んだ跡である。**
 * **`meta.countChecked` が自分で `checked: 0 / noCounts: 105 / rows: 105` と言っている**——
 * **共通層の員数の検算は、徳島では 1 行も走っていない。**
 *
 * **だから「本数の下限」や「違反 0 件」は、徳島については何も言っていない。**
 * **ここで代わりに見るのは「105 行とも 36 セルで、記号が凡例の 5 種に分類しきれること」である。**
 *
 * **逆向きの変異を捕まえる**: **誰かが `○` に `mapped: "賛成"` を足したら、ここが落ちる。**
 * **それは「委員会審査結果に起立した」を「議案に賛成した」と言い換えることで、
 * 請願が委員会で不採択だった行では意味が逆になる**（#569 の「別人の記録が出る」と同じ重さ）。
 */
test("#865/#901 本番 pref-36: counts は 153 行とも無い／○ と ● に mapped が付かない（推定を拒んだ跡）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  assert.equal(rcs.length, 153, "母数");
  // **`counts` も `method` も 1 行も無い**（PDF にその欄が無いので付けない）
  assert.deepEqual(rcs.filter((r) => r.counts !== undefined).map((r) => r.id), [], "counts のある採決");
  assert.deepEqual(rcs.filter((r) => r.method !== undefined).map((r) => r.id), [], "method のある採決");
  // **共通層の員数の検算は 1 行も走っていない**（`meta` が自分でそう言っている）
  assert.deepEqual(meta().countChecked, { checked: 0, noCounts: 153, rows: 153, unreadableCells: 0 });
  // **`mapped` が付くのは「票を投じていない」4 つの凡例だけ**
  const votes = rcs.flatMap((r) => r.votes);
  assert.equal(votes.length, 5_562, "母数");
  const unmapped = votes.filter((v) => v.value.mapped === undefined);
  assert.equal(unmapped.length, 5_305, "mapped の無い票（5,305 / 5,562 = 95.4%）");
  assert.deepEqual([...new Set(unmapped.map((v) => v.value.raw))].sort(), ["○", "●", "〇"], "mapped の無い票の記号");
  assert.deepEqual([...new Set(votes.filter((v) => v.value.mapped !== undefined).map((v) => v.value.mapped))], ["投票なし"], "mapped が付く値");
  assert.equal(votes.length - unmapped.length, 257, "mapped の付く票");
  // **`賛成` / `反対` に落ちた票が 1 つも無い**（凡例から機械的に読めないので落とさない）
  assert.deepEqual(votes.filter((v) => v.value.mapped === "賛成" || v.value.mapped === "反対"), []);
});

/**
 * **票の内訳**（`data/` を読み直して数えた。**3,780 セルすべてを 7 つの記号に分類しきる**）。
 *
 * **`○` U+25CB と `〇` U+3007 が両方出る**——**同じ 1 本の PDF（1064407.pdf）の同じ 20 行の中で。**
 * **凡例を引くときだけ寄せる**ので **`legend` はどちらも同じ文面になる**（#674 / `glyph-variants.ts`）。
 * **`raw` を寄せて書き出すと、それは原文ではない。**
 */
test("#865/#901 本番 pref-36: 票の内訳と、○ U+25CB / 〇 U+3007 が同じ 21 行に混ざっていること", { skip: !hasData }, () => {
  const rcs = rollCalls();
  const votes = rcs.flatMap((r) => r.votes);
  assert.equal(votes.length, 5_562, "母数（減っていたらこの内訳は意味が無い）");
  const raw = new Map<string, number>();
  const legend = new Map<string, number>();
  for (const v of votes) {
    raw.set(v.value.raw, (raw.get(v.value.raw) ?? 0) + 1);
    legend.set(v.value.legend, (legend.get(v.value.legend) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries([...raw].sort()), { "●": 102, "〇": 77, "○": 5126, "欠": 92, "議": 153, "退": 10, "除": 2 });
  assert.deepEqual(Object.fromEntries([...legend].sort()), {
    "欠席": 92, "委員会審査結果又は議長宣告に起立しなかった者": 102, "委員会審査結果又は議長宣告に起立（賛成）した者": 5203,
    "退席": 10, "議長": 153, "除斥": 2,
  });
  // **2 つの字は別の符号位置**（寄せていない）
  assert.equal("○".codePointAt(0), 0x25cb, "○ WHITE CIRCLE");
  assert.equal("〇".codePointAt(0), 0x3007, "〇 IDEOGRAPHIC NUMBER ZERO");
  // **どちらも同じ凡例に引けている**（3411 + 74 = 3485）
  assert.equal(raw.get("○")! + raw.get("〇")!, legend.get("委員会審査結果又は議長宣告に起立（賛成）した者"));
  // **`〇` は 1 本の PDF にしか出ず、その 20 行では `○` と混ざっている**
  const withMaru2 = rcs.filter((r) => r.votes.some((v) => v.value.raw === "〇"));
  assert.equal(withMaru2.length, 21, "`〇` の出る採決");
  assert.equal(new Set(withMaru2.map((r) => r.sourceUrl)).size, 2, "`〇` の出る PDF は 2 本（1064407 / 1075652）");
  assert.deepEqual([...new Set(withMaru2.map((r) => r.sessionId))].sort(), ["2026-06", "2026-09"], "`〇` の出る会期");
  assert.deepEqual(withMaru2.filter((r) => !r.votes.some((v) => v.value.raw === "○")).map((r) => r.id), [],
    "**21 行とも `○` と `〇` が同じ行に混ざっている**");
});

/**
 * ## **`議` は全 105 採決で 1 人、会期をまたいで交代している**
 *
 * **2026-02 会期の 85 件は 須見 一仁、2026-06 会期の 20 件は 井川 龍二。**
 * **会期の中では交代していない**（島根は会期の中で交代していた）。
 *
 * **これは順序（k 番目のセルが k 番目の議員）の証明ではない**（#743 が「1 行に `議` は高々 1 個」が
 * 恒真であることを実測している）。**順序の検算は `tokushima-votes-pdf.test.ts` にある。**
 */
test("#865/#901 本番 pref-36: `議` は 153 採決すべてで 1 人、会期ごとに 須見 一仁 → 井川 龍二", { skip: !hasData }, () => {
  const rcs = rollCalls();
  const perRollCall = new Map<number, number>();
  const bySession = new Map<string, Map<string, number>>();
  const ids = new Set<string>();
  for (const rc of rcs) {
    const gi = rc.votes.filter((v) => v.value.raw === "議");
    perRollCall.set(gi.length, (perRollCall.get(gi.length) ?? 0) + 1);
    for (const v of gi) {
      assert.equal(v.value.legend, "議長", `${rc.id}: 凡例`);
      assert.equal(v.value.mapped, "投票なし", `${rc.id}: mapped`);
      ids.add(v.memberId);
      const s = bySession.get(rc.sessionId) ?? new Map<string, number>();
      s.set(v.nameText, (s.get(v.nameText) ?? 0) + 1);
      bySession.set(rc.sessionId, s);
    }
  }
  assert.deepEqual(Object.fromEntries(perRollCall), { 1: 153 }, "採決ごとの `議` の数");
  assert.equal(ids.size, 2, `\`議\` が付く議員（${[...ids].sort().join(",")}）`);
  assert.ok(![...ids].includes(""), "議長が名簿に寄っている");
  assert.deepEqual(
    Object.fromEntries([...bySession].map(([k, v]) => [k, Object.fromEntries([...v].sort())]).sort()),
    { "2025-11": { "須見 一仁": 47 }, "2026-02": { "須見 一仁": 85 }, "2026-06": { "井川 龍二": 20 }, "2026-09": { "井川 龍二": 1 } },
  );
});

/**
 * ## **`欠`（欠席）85 件は 1 人に集中、`退`（退席）10 件は 9 人に散る**
 *
 * **坂口 誠治 が 2026-02 会期の 85 件すべてで `欠`。**
 * **`退` は 9 人に 1 件ずつ（仁木 啓人 だけ 2 件）で、`除`（除斥）は 2 人に 1 件ずつ。**
 *
 * **列がずれていたら、`欠` は 1 人に集中しない**（85 件が別々の議員に散る）。
 * **逆に `退` が 1 人に集中したら、それも列のずれを疑う形である。**
 * **どちらも「数は合うが人が違う」ずれ**で、**利用者からは検出できない**（#569）。
 */
test("#865/#901 本番 pref-36: `欠` 92 件は坂口 誠治 1 人に集中、`退` 10 件は 9 人、`除` 2 件は 2 人", { skip: !hasData }, () => {
  const rcs = rollCalls();
  const by = (mark: string) => {
    const m = new Map<string, number>();
    for (const r of rcs) for (const v of r.votes) if (v.value.raw === mark) m.set(v.nameText, (m.get(v.nameText) ?? 0) + 1);
    return m;
  };
  const ketsu = by("欠");
  assert.deepEqual(Object.fromEntries(ketsu), { "坂口 誠治": 92 }, "`欠` の内訳");
  // **92 件は 2025-11 と 2026-02 の 2 会期**（2026-06 / 2026-09 には `欠` が無い）
  const ketsuSessions = new Set(rcs.filter((r) => r.votes.some((v) => v.value.raw === "欠")).map((r) => r.sessionId));
  assert.deepEqual([...ketsuSessions].sort(), ["2025-11", "2026-02"]);
  const tai = by("退");
  assert.equal([...tai.values()].reduce((a, b) => a + b, 0), 10, "`退` の合計");
  assert.equal(tai.size, 9, "`退` の付く議員の人数");
  assert.deepEqual(Object.fromEntries([...tai].filter(([, n]) => n > 1)), { "仁木 啓人": 2 }, "2 件付いた議員");
  const jo = by("除");
  assert.deepEqual(Object.fromEntries([...jo].sort()), { "仁木 啓人": 1, "木下 賢功": 1 }, "`除` の内訳");
  // **`除` の 2 件は別々の採決**（同じ行に 2 人ではない）
  const joRows = rcs.filter((r) => r.votes.some((v) => v.value.raw === "除"));
  assert.equal(joRows.length, 2, "`除` のある採決");
  assert.deepEqual(joRows.map((r) => r.votes.filter((v) => v.value.raw === "除").length), [1, 1]);
});

/**
 * ## **氏名は 36 人と 1 対 1、未突合 0**
 *
 * **徳島の PDF はフルネーム。** 名寄せは**空白を除いた完全一致だけ**
 * （`tokushima/rollcalls.ts`: 「名簿に同じ氏名が 2 人いれば名寄せしない。異体字も寄せない」）。
 *
 * **1 対 1 であることを見る**（#796: 氏名が一致するだけでは同一人物と書かない）。
 */
test("#865/#901 本番 pref-36: 36 人が氏名と 1 対 1。寄らない 2 人の 54 票は memberId 空のまま（推定しない）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  const votes = rcs.flatMap((r) => r.votes);
  assert.equal(votes.length, 5_562, "母数");
  // **寄らなかった 2 人**（2025-11 会期にだけ出る。**今の名簿 36 人には居ない**）
  const unmatchedJson = JSON.parse(readFileSync(join(DIR, "unmatched.json"), "utf-8")) as { nameText: string; group: string; rollCallIds: string[] }[];
  assert.deepEqual(unmatchedJson.map((u) => [u.nameText, u.group, u.rollCallIds.length]).sort(),
    [["北島 一人", "自由民主党県民会議", 47], ["古川 広志", "公明党徳島県議団", 7]].sort(), "unmatched.json");
  const empty = votes.filter((v) => v.memberId === "");
  assert.equal(empty.length, 54, "**memberId が空の票**（47 + 7 = 54 / 5,562 = 0.97%）");
  assert.deepEqual([...new Set(empty.map((v) => v.nameText))].sort(), ["北島 一人", "古川 広志"].sort());
  // **その 54 票はすべて 2025-11 会期**（今の名簿と食い違うのは、その会期だけ）
  assert.deepEqual([...new Set(rcs.filter((r) => r.votes.some((v) => v.memberId === "")).map((r) => r.sessionId))], ["2025-11"]);
  const idToNames = new Map<string, Set<string>>();
  const nameToIds = new Map<string, Set<string>>();
  for (const v of votes.filter((v) => v.memberId !== "")) {
    (idToNames.get(v.memberId) ?? idToNames.set(v.memberId, new Set()).get(v.memberId)!).add(v.nameText);
    (nameToIds.get(v.nameText) ?? nameToIds.set(v.nameText, new Set()).get(v.nameText)!).add(v.memberId);
  }
  assert.equal(idToNames.size, 36, "票に出る議員");
  assert.equal(nameToIds.size, 36, "票に出る氏名");
  assert.deepEqual([...idToNames].filter(([, s]) => s.size > 1).map(([k]) => k), [], "1 人に 2 通りの氏名");
  assert.deepEqual([...nameToIds].filter(([, s]) => s.size > 1).map(([k]) => k), [], "1 つの氏名が 2 人に");
  // **`memberId` が空の票は 1 行に 2 つ出うる**（2025-11-28 は 北島・古川 の 2 人が寄らない）ので、空を除いて数える。
  // **氏名のほうは 1 行に 1 回ずつ**——**そちらで重複を見る**（空の id で潰れない）。
  assert.deepEqual(rcs.filter((r) => {
    const ids = r.votes.map((v) => v.memberId).filter((x) => x !== "");
    return new Set(ids).size !== ids.length;
  }).map((r) => r.id), [], "同じ採決に同じ議員が 2 回");
  assert.deepEqual(rcs.filter((r) => new Set(r.votes.map((v) => v.nameText)).size !== r.votes.length).map((r) => r.id), [], "同じ採決に同じ氏名が 2 回");
  // **票の氏名（空白を除く）が、名簿の氏名（空白を除く）と完全一致する**
  const index = JSON.parse(readFileSync(join(DATA, "members", "index.json"), "utf-8")) as LocalMember[];
  const tokushima = index.filter((m) => m.assemblyId === "pref-36");
  assert.equal(tokushima.length, 36, "名簿");
  const strip = (s: string) => s.replace(/[\s　]/g, "");
  const roster = new Map(tokushima.map((m) => [m.id, strip(m.name)]));
  let matched = 0;
  for (const [id, names] of idToNames) {
    assert.equal(roster.get(id), strip([...names][0]), `${id}: PDF「${[...names][0]}」と名簿「${roster.get(id)}」`);
    matched++;
  }
  assert.equal(matched, 36, "**36 人すべてを名簿と突き合わせた**");
  assert.deepEqual([...idToNames.keys()].sort(), tokushima.map((m) => m.id).sort(), "名簿と票に出る議員が同じ集合");
  assert.deepEqual([...new Set(tokushima.map((m) => m.counts?.rollcalls))], [153], "議員ごとの採決数");
});

/**
 * **出典はすべて県議会の公式ホスト。`committeeResult`（委員会審査結果）が 105 行ともある。**
 *
 * **`-` / `－` が 16 行にある**（委員会に付託しなかった議案。原文のまま。**空にも「なし」にもしない**）。
 */
test("#865/#901 本番 pref-36: sourceUrl は 15 本すべて https://www.pref.tokushima.lg.jp、委員会審査結果が 153 行とも", { skip: !hasData }, () => {
  const m = meta();
  const rcs = rollCalls();
  const urls = new Set<string>();
  for (const rc of rcs) urls.add(rc.sourceUrl);
  for (const s of m.sources) urls.add(s.url);
  for (const s of m.sessions) { urls.add(s.sourceUrl); if (s.pdfUrl) urls.add(s.pdfUrl); for (const p of s.pdfUrls ?? []) urls.add(p); }
  assert.equal(urls.size, 15, "**突き合わせた URL の本数**（0 本を見て緑にならないように）");
  assert.deepEqual([...urls].filter((u) => new URL(u).host !== TOKUSHIMA_HOST || new URL(u).protocol !== "https:"), [], "公式ホストでない URL");
  // **採決の出典は 4 本の PDF**（1 会期に複数の採決日があり、日ごとに別の PDF）
  const pdfs = new Map<string, number>();
  for (const r of rcs) pdfs.set(r.sourceUrl, (pdfs.get(r.sourceUrl) ?? 0) + 1);
  assert.equal(pdfs.size, 7, "採決の出典 PDF");
  assert.deepEqual([...pdfs.values()].sort((a, b) => b - a), [83, 40, 20, 7, 1, 1, 1], "PDF ごとの採決数");
  assert.equal([...pdfs.values()].reduce((a, b) => a + b, 0), 153, "合計");
  assert.deepEqual([...pdfs.keys()].filter((u) => !u.endsWith(".pdf")), [], "PDF でない出典");
  // **会期は 2 本、内訳は 85 + 20 = 105。採決日は 4 日**
  assert.deepEqual(m.sessions.map((s) => [s.sessionId, s.rollcalls]).sort(), [["2025-11", 47], ["2026-02", 85], ["2026-06", 20], ["2026-09", 1]]);
  assert.deepEqual(
    Object.fromEntries([...new Set(rcs.map((r) => r.date))].sort().map((d) => [d, rcs.filter((r) => r.date === d).length])),
    { "2025-11-28": 7, "2025-12-19": 40, "2026-02-13": 1, "2026-02-20": 1, "2026-03-11": 83, "2026-07-03": 20, "2026-09-11": 1 },
  );
  // **`committeeResult` が 105 行ともある**（ほかの 10 議会には無い欄）
  assert.deepEqual(rcs.filter((r) => r.committeeResult === undefined).map((r) => r.id), [], "委員会審査結果の無い採決");
  const cr = new Map<string, number>();
  for (const r of rcs) cr.set(r.committeeResult!, (cr.get(r.committeeResult!) ?? 0) + 1);
  // **`-`（半角）と `－`（全角）が両方そのまま残っている**（原文を寄せていない）
  // **横棒は 3 通り**（`-` U+002D / `―` U+2015 / `－` U+FF0D。**原文のまま。U+2015 は広げて初めて出た**。#901）
  assert.deepEqual(Object.fromEntries([...cr].sort()), { "-": 14, "―": 7, "－": 7, "不採択": 4, "可決": 111, "可決及び認定": 4, "承認": 1, "採択": 2, "認定": 3 });
  assert.equal([...cr.values()].reduce((a, b) => a + b, 0), 153, "委員会審査結果の合計");
  assert.deepEqual(["-".codePointAt(0), "―".codePointAt(0), "－".codePointAt(0)], [0x002d, 0x2015, 0xff0d], "3 つは別の符号位置");
  // **全部の採決に日付・件名がある**
  assert.deepEqual(rcs.filter((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date)).map((r) => r.id), [], "日付の形");
  assert.deepEqual(rcs.filter((r) => r.title === "").map((r) => r.id), [], "件名が空の採決");
  assert.equal(new Set(rcs.map((r) => r.id)).size, rcs.length, "id の重複");
});

/** **名簿 36 人に kana / district / group が揃っている**（#632 の検算が効く議会）。 */
test("#865 本番 pref-36: 36 人全員に kana・選挙区・会派がある", { skip: !hasData }, () => {
  const index = JSON.parse(readFileSync(join(DATA, "members", "index.json"), "utf-8")) as LocalMember[];
  const tokushima = index.filter((m) => m.assemblyId === "pref-36");
  assert.equal(tokushima.length, 36, "母数");
  assert.deepEqual(tokushima.filter((m) => m.kana === "").map((m) => m.name), [], "かなの無い議員");
  assert.deepEqual(tokushima.filter((m) => m.district === "").map((m) => m.name), [], "選挙区の無い議員");
  assert.deepEqual(tokushima.filter((m) => m.group === "").map((m) => m.name), [], "会派の無い議員");
  const groups = new Map<string, number>();
  for (const m of tokushima) groups.set(m.group, (groups.get(m.group) ?? 0) + 1);
  // **実測 2026-09-14。10 会派**（1 人だけの会派が 5 つある。**まとめない**——原文のまま）
  assert.deepEqual(Object.fromEntries([...groups].sort()), {
    "グローカルplus": 3, "元気とくしま": 1, "公明党徳島県議団": 1, "徳島県議会自由民主党": 17,    "新しい県政を創る会": 5, "日本共産党": 1, "日本維新の会": 1, "真政会": 2, "自由民主党県民会議": 4, "護民官": 1,
  });
  assert.equal([...groups.values()].reduce((a, b) => a + b, 0), 36, "会派の内訳の合計");
  assert.equal(groups.size, 10, "会派の数（1 人だけの会派を含めて 10。まとめていない）");
  assert.equal(meta().rosterAsOf, "2026-09-20");
});
