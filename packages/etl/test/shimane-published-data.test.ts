import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { LocalAssemblyMeta, LocalMember, LocalRollCall } from "@seiji-kiroku/shared";
import { SHIMANE_HOST } from "../src/sources/local/shimane/site.ts";

/**
 * **本番 `data/assemblies/pref-32/` に出したものを、出した後から読み直して数える**（Issue #865）。
 *
 * **`votes-pdf.ts` のテストは PDF を読む側を見ている。ここは「書いたもの」を見る。**
 * **`data/` の JSON を読み直しているので、書き出し（`buildLocalAssembly` / `writeLocalAssembly`）が
 * 壊れたらここが落ちる。**
 *
 * ## **島根で何を主張するか**——**他県から写していない**
 *
 * **島根だけにある形が 4 つある**（実測 2026-09-14）:
 *
 * 1. **本番データの中で議長が会期の途中に交代している。** 2026-07-02 の 30 採決のうち、
 *    **最初の 2 件は 高橋雅彦、あとの 28 件は 山根成二 が `議⾧`。**
 *    **「議長は会期ごとに同じ 1 人」は島根では成り立たない**——
 *    **佐賀（#768）・鳥取（#865）でそう書いたのを、そのまま写すと嘘になる。**
 * 2. **交代の 4 件には `除斥` が付いていて、それが「自分の件だから」で説明できる。**
 *    **池田一 が 2 件、高橋雅彦 が 2 件**——**議長を降りる／選ばれる当人が、その採決に加わっていない。**
 * 3. **`議⾧` の `⾧` は U+2FA7（康熙部首）**で、**`長` U+9577 ではない。**
 *    **PDF の文字層がそう出している**ので **`raw` は原文のまま残し、凡例を引くときだけ寄せる**（#674）。
 * 4. **`sessionId` が `499`**（回数）**と `2026-02`（年月）で混ざっている。**
 *    **島根は会期ページに回数（第499回）が書いてあるときだけそれを使う。**
 *
 * ## **#866（`title` の不具合）と衝突しない**
 *
 * **このファイルは `title` の中身を一切見ない。** #866 が `data/assemblies/pref-32/` の
 * `title` を直しても、ここは落ちない（**採決の件数・セル数・記号・氏名・URL・`議⾧` の人数だけを見る**）。
 * **`title` が空でないことだけは見る**——**それは #866 が直す方向と同じで、逆方向にはならない。**
 */
const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));
const DIR = join(DATA, "assemblies", "pref-32");

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

/** **`議⾧` の `⾧` は康熙部首 U+2FA7**（`長` U+9577 ではない）。**この定数がそのことを言う。** */
const GICHO_RAW = "議⾧";

test("#865 本番 pref-32: 採決 112 × 議員 35 = 3,920 セル、抽出不能 0.00%", { skip: !hasData }, () => {
  const m = meta();
  const rcs = rollCalls();
  // **実測 2026-09-14**（直近 2 会期。月次のワークフローは既定の `--sessions 2` で回る）
  assert.equal(m.counts.rollcalls, 112);
  assert.equal(m.counts.members, 35);
  assert.equal(m.counts.cells, 3_920);
  assert.equal(m.counts.unknownCells, 0, "**推定せず残した不明セルは 0**");
  assert.equal(m.counts.unmatchedNames, 0, "**名簿に寄らなかった氏名は 0**");
  // **meta の数が、書いた実物と一致する**（meta だけを書き換えても落ちる）
  assert.equal(rcs.length, m.counts.rollcalls, "rollcalls/ の実ファイル数");
  assert.equal(rcs.reduce((s, r) => s + r.votes.length, 0), m.counts.cells, "票の実数");
  // **112 行とも 35 セルちょうど**（会期の途中で議員が 1 人静かに消えていない。#705 が滋賀で踏んだ形）
  const perRow = new Map<number, number>();
  for (const r of rcs) perRow.set(r.votes.length, (perRow.get(r.votes.length) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries(perRow), { 35: 112 }, "採決ごとのセル数");
  // **112 行とも共通層の員数の検算を通っている**（`mapped` の付かない票が 1 つも無い）
  assert.deepEqual(m.countChecked, { checked: 112, noCounts: 0, rows: 112, unreadableCells: 0 });
});

/**
 * **票の内訳**（`data/` を読み直して数えた。**3,920 セルすべてを 5 つの記号に分類しきる**）。
 *
 * **`議⾧` の `⾧` が U+2FA7 のまま残っていることを、ここで固定する**——
 * **`長` U+9577 に直して書き出すと、それは原文ではない**（#674: `raw` は原文のまま）。
 * **凡例を引くときだけ寄せる**ので **`legend` は `議長`（U+9577）である。**
 * **この 2 つが同じ文字になったら、どちらかの方針が静かに変わっている。**
 */
test("#865 本番 pref-32: 票の内訳（`議⾧` の ⾧ は康熙部首 U+2FA7 のまま、legend は 議長 U+9577）", { skip: !hasData }, () => {
  const votes = rollCalls().flatMap((r) => r.votes);
  assert.equal(votes.length, 3_920, "母数（減っていたらこの内訳は意味が無い）");
  const raw = new Map<string, number>();
  const legend = new Map<string, number>();
  for (const v of votes) {
    raw.set(v.value.raw, (raw.get(v.value.raw) ?? 0) + 1);
    legend.set(v.value.legend, (legend.get(v.value.legend) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries([...raw].sort()), { "○": 3686, "●": 37, "－": 81, "除斥": 4, [GICHO_RAW]: 112 });
  assert.deepEqual(Object.fromEntries([...legend].sort()), {
    "反対": 37, "欠席等による不在": 81, "議案と一定の利害関係を有する議員": 4, "議長": 112, "賛成": 3686,
  });
  // **原文の `⾧` は康熙部首、凡例の `長` は通常の漢字**（寄せているのは凡例を引くときだけ）
  assert.equal(GICHO_RAW.codePointAt(1), 0x2fa7, "PDF の `⾧`");
  assert.equal("議長".codePointAt(1), 0x9577, "凡例の `長`");
  assert.notEqual(GICHO_RAW, "議長", "**原文を凡例の字に寄せて書き出していない**");
  assert.equal(raw.get("議長"), undefined, "`長` U+9577 の票が出ていない");
  // **3,920 票すべてに `mapped` が付く**（凡例の意味が全部 `MAPPED` に載っている）
  assert.deepEqual(votes.filter((v) => v.value.mapped === undefined), [], "mapped の無い票");
  const mapped = new Map<string, number>();
  for (const v of votes) mapped.set(v.value.mapped!, (mapped.get(v.value.mapped!) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries([...mapped].sort()), { "反対": 37, "投票なし": 197, "賛成": 3686 });
  assert.equal([...mapped.values()].reduce((a, b) => a + b, 0), 3_920, "mapped の合計");
});

/** **`counts`（PDF 自身が印刷している賛成者数・反対者数）と、抽出した記号の数が合う。** */
test("#865 本番 pref-32: ○ の数 = counts.yes / ● の数 = counts.no（112 採決すべて）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  assert.equal(rcs.length, 112, "母数");
  let checked = 0;
  for (const rc of rcs) {
    assert.ok(rc.counts, `${rc.id}: counts がある`);
    assert.equal(rc.votes.filter((v) => v.value.raw === "○").length, rc.counts!.yes, `${rc.id}: ○`);
    assert.equal(rc.votes.filter((v) => v.value.raw === "●").length, rc.counts!.no, `${rc.id}: ●`);
    // **`賛成` / `反対` に落ちるのは `○` / `●` だけ**（`議⾧` `－` `除斥` は `投票なし`）
    assert.equal(rc.votes.filter((v) => v.value.mapped === "賛成").length, rc.counts!.yes, `${rc.id}: 賛成`);
    assert.equal(rc.votes.filter((v) => v.value.mapped === "反対").length, rc.counts!.no, `${rc.id}: 反対`);
    checked++;
  }
  assert.equal(checked, 112, "**112 行すべてを突き合わせた**（母数が減ったらこの検算は空回りする）");
});

/**
 * ## **議長が会期の途中で交代している**——**島根の本番データにだけ在る形**
 *
 * **2026-07-02 の 30 採決で `議⾧` の列が 1 度動く**:
 * **最初の 2 件が 高橋雅彦（副議長）、あとの 28 件が 山根成二。**
 * **もう 1 つの会期（2026-02、82 採決）は 池田一 が通して 1 人である。**
 *
 * **だから「議長は会期ごとに同じ 1 人」は島根では成り立たない**——
 * **佐賀（#768）・秋田（#759）・鳥取（#865）でそう書いた検算を、そのまま島根に写すと嘘になる。**
 * **青森（#748）は 55 本中 2 本で同じ交代を踏んで、実装を直した。**
 *
 * **ここで見るのは「どの行でも `議⾧` はちょうど 1 人」と「その 1 人が 3 人のどれか」まで。**
 * **順序（k 番目のセルが k 番目の議員）の証明ではない**（#743 が「1 行に `議` は高々 1 個」が
 * 恒真であることを実測している）。
 */
test("#865 本番 pref-32: `議⾧` は 112 採決すべてで 1 人、2026-07-02 に 高橋雅彦 → 山根成二 と交代", { skip: !hasData }, () => {
  const rcs = rollCalls();
  const perRollCall = new Map<number, number>();
  const bySession = new Map<string, Map<string, number>>();
  const ids = new Set<string>();
  for (const rc of rcs) {
    const gi = rc.votes.filter((v) => v.value.raw === GICHO_RAW);
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
  assert.deepEqual(Object.fromEntries(perRollCall), { 1: 112 }, "採決ごとの `議⾧` の数");
  assert.equal(ids.size, 3, `\`議⾧\` が付く議員（${[...ids].sort().join(",")}）`);
  assert.ok(![...ids].includes(""), "議長が名簿に寄っている");
  // **会期ごとの内訳**——**499（令和8年6月定）で 1 度交代している**
  assert.deepEqual(
    Object.fromEntries([...bySession].map(([k, v]) => [k, Object.fromEntries([...v].sort())]).sort()),
    { "2026-02": { "池田一": 82 }, "499": { "山根成二": 28, "高橋雅彦": 2 } },
  );
});

/**
 * ## **`除斥` の 4 件は「自分の件だから」で説明がつく**
 *
 * **2026-07-02 の「その他表決」4 件で、`除斥` が付く議員と `議⾧` の議員が入れ替わっている**:
 *
 * | 行 | `議⾧` | `除斥` |
 * |---|---|---|
 * | 1・2 | 高橋雅彦（副議長） | **池田一** |
 * | 3・4 | 山根成二 | **高橋雅彦** |
 *
 * **議長を降りる当人・選ばれる当人が、その採決に加わっていない**——
 * **「除斥された人は、その行で議長ではない」**が 4 / 4 で成り立つ。
 *
 * **これは「除斥は議長選挙のとき」という規則の証明ではない**（4 件しか見ていない）。
 * **見ているのは「同じ行で `除斥` と `議⾧` が同じ人に付いていないこと」**で、
 * **それが崩れたら列が 1 つずれている。**
 *
 * **議案の中身（`title`）は見ない**——**#866 が `title` を直している最中だから**（衝突しない）。
 */
test("#865 本番 pref-32: 除斥 4 件は 2026-07-02 のその他表決で、同じ行の議長とは別人", { skip: !hasData }, () => {
  const rcs = rollCalls();
  const rows = rcs.filter((r) => r.votes.some((v) => v.value.raw === "除斥"));
  assert.equal(rows.length, 4, "`除斥` のある採決");
  const seen: { date: string; kind: string; excluded: string[]; chair: string[] }[] = [];
  for (const rc of rows) {
    const ex = rc.votes.filter((v) => v.value.raw === "除斥");
    const ch = rc.votes.filter((v) => v.value.raw === GICHO_RAW);
    for (const v of ex) {
      assert.equal(v.value.legend, "議案と一定の利害関係を有する議員");
      assert.equal(v.value.mapped, "投票なし");
      assert.notEqual(v.memberId, "", `${rc.id}: 除斥の議員が名簿に寄っている`);
    }
    // **同じ行で `除斥` と `議⾧` が同じ人に付いていない**（列が 1 つずれていたら起きる）
    assert.deepEqual(
      ex.map((v) => v.memberId).filter((id) => ch.some((c) => c.memberId === id)), [],
      `${rc.id}: 除斥と議長が同じ議員`,
    );
    seen.push({ date: rc.date, kind: rc.kind, excluded: ex.map((v) => v.nameText), chair: ch.map((v) => v.nameText) });
  }
  assert.deepEqual(
    seen.map((s) => [s.date, s.kind, s.excluded.join(","), s.chair.join(",")]).sort(),
    [
      ["2026-07-02", "その他表決", "池田一", "高橋雅彦"],
      ["2026-07-02", "その他表決", "池田一", "高橋雅彦"],
      ["2026-07-02", "その他表決", "高橋雅彦", "山根成二"],
      ["2026-07-02", "その他表決", "高橋雅彦", "山根成二"],
    ],
  );
});

/**
 * ## **`－`（欠席等による不在）81 件は、2026-02 会期の 1 人が通して欠けている形**
 *
 * **福田正明 が 2026-02 会期の 82 採決のうち 81 件で `－`**（残り 1 件は `○`）。
 * **もう 1 つの会期（499）には `－` が 1 つも無い。**
 *
 * **「81 件も欠けている」は一見おかしいが、これは「記録が出ていない」ではなく
 * 「記録が『不在』と言っている」である**——**PDF の凡例に「欠席等による不在」がある。**
 * **推定で埋めてはいけない側**（#569）。
 *
 * **ここで見るのは「`－` が 1 人に集中していること」**——
 * **列がずれていたら、`－` は別の議員に散る。**
 */
test("#865 本番 pref-32: `－` 81 件は 2026-02 会期の福田正明に集中（もう 1 会期は 0 件）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  const dashes = rcs.flatMap((r) => r.votes.filter((v) => v.value.raw === "－").map((v) => ({ s: r.sessionId, n: v.nameText, id: v.memberId })));
  assert.equal(dashes.length, 81, "`－` の票");
  assert.deepEqual([...new Set(dashes.map((d) => d.n))], ["福田正明"], "`－` が付く議員");
  assert.deepEqual([...new Set(dashes.map((d) => d.id))], ["p_32_giin33_fukuda"], "その memberId");
  assert.deepEqual([...new Set(dashes.map((d) => d.s))], ["2026-02"], "`－` の出る会期");
  // **1 行に `－` は高々 1 つ**（81 行に 1 つずつ、31 行には 0 つ）
  const perRow = new Map<number, number>();
  for (const r of rcs) { const n = r.votes.filter((v) => v.value.raw === "－").length; perRow.set(n, (perRow.get(n) ?? 0) + 1); }
  assert.deepEqual(Object.fromEntries([...perRow].sort()), { 0: 31, 1: 81 });
});

/**
 * ## **氏名は PDF の字のまま、名簿とは 1 対 1**
 *
 * **`絲原德康`（德 U+5FB7）が PDF、名簿は `絲原徳康`（徳 U+5FB3）。**
 * **`data/` には PDF の字が残っている**（`nameText`）が、**`memberId` は名簿の人に寄っている。**
 * **字形を寄せるのは突き合わせのときだけで、書き出す原文は寄せない**（#636 の `ITAIJI`）。
 *
 * **1 対 1 であることを見る**（#796: 氏名が一致するだけでは同一人物と書かない）——
 * **1 つの `memberId` に 2 通りの氏名が付いたら、どこかで別人に寄せている。**
 */
test("#865 本番 pref-32: 35 人が氏名と 1 対 1、絲原は PDF の `德` U+5FB7 のまま名簿の `徳` に寄っている", { skip: !hasData }, () => {
  const rcs = rollCalls();
  const votes = rcs.flatMap((r) => r.votes);
  assert.equal(votes.length, 3_920, "母数");
  assert.deepEqual(JSON.parse(readFileSync(join(DIR, "unmatched.json"), "utf-8")), [], "unmatched.json");
  assert.deepEqual(votes.filter((v) => v.memberId === "").map((v) => v.nameText), [], "memberId が空の票");
  const idToNames = new Map<string, Set<string>>();
  const nameToIds = new Map<string, Set<string>>();
  for (const v of votes) {
    (idToNames.get(v.memberId) ?? idToNames.set(v.memberId, new Set()).get(v.memberId)!).add(v.nameText);
    (nameToIds.get(v.nameText) ?? nameToIds.set(v.nameText, new Set()).get(v.nameText)!).add(v.memberId);
  }
  assert.equal(idToNames.size, 35, "票に出る議員");
  assert.equal(nameToIds.size, 35, "票に出る氏名");
  assert.deepEqual([...idToNames].filter(([, s]) => s.size > 1).map(([k]) => k), [], "1 人に 2 通りの氏名");
  assert.deepEqual([...nameToIds].filter(([, s]) => s.size > 1).map(([k]) => k), [], "1 つの氏名が 2 人に");
  assert.deepEqual(rcs.filter((r) => new Set(r.votes.map((v) => v.memberId)).size !== r.votes.length).map((r) => r.id), [], "同じ採決に同じ議員が 2 回");
  // **`德`（PDF）と `徳`（名簿）が両方そのまま残っている**
  const index = JSON.parse(readFileSync(join(DATA, "members", "index.json"), "utf-8")) as LocalMember[];
  const shimane = index.filter((m) => m.assemblyId === "pref-32");
  assert.equal(shimane.length, 35, "名簿");
  const itohara = shimane.find((m) => m.id === "p_32_giin20_itohara")!;
  assert.equal(itohara.name, "絲原徳康", "名簿の字（徳 U+5FB3）");
  assert.equal(itohara.name.codePointAt(2), 0x5fb3);
  assert.deepEqual([...idToNames.get("p_32_giin20_itohara")!], ["絲原德康"], "PDF の字（德 U+5FB7）");
  assert.equal("絲原德康".codePointAt(2), 0x5fb7);
  // **名簿の 35 人と、票に出る 35 人が同じ集合**（どちらかにだけ居る人が 0）
  assert.deepEqual([...idToNames.keys()].sort(), shimane.map((m) => m.id).sort());
  // **全員が 112 件すべての採決の記録に出る**（`－` の 81 件も「不在と記録された」で出ている）
  assert.deepEqual([...new Set(shimane.map((m) => m.counts?.rollcalls))], [112], "議員ごとの採決数");
});

/**
 * **出典はすべて県議会の公式ホスト。会期の id は `499`（回数）と `2026-02`（年月）が混ざる。**
 *
 * **`title` の中身は見ない**（#866 が直している最中）。**空でないことだけ見る。**
 */
test("#865 本番 pref-32: sourceUrl は 9 本すべて https://www.pref.shimane.lg.jp、会期は 499 と 2026-02", { skip: !hasData }, () => {
  const m = meta();
  const rcs = rollCalls();
  const urls = new Set<string>();
  for (const rc of rcs) urls.add(rc.sourceUrl);
  for (const s of m.sources) urls.add(s.url);
  for (const s of m.sessions) { urls.add(s.sourceUrl); if (s.pdfUrl) urls.add(s.pdfUrl); for (const p of s.pdfUrls ?? []) urls.add(p); }
  assert.equal(urls.size, 9, "**突き合わせた URL の本数**（0 本を見て緑にならないように）");
  assert.deepEqual([...urls].filter((u) => new URL(u).host !== SHIMANE_HOST || new URL(u).protocol !== "https:"), [], "公式ホストでない URL");
  // **会期は 2 本、内訳は 30 + 82 = 112**。**`499` は回数で、`2026-02` は年月**（島根は回数が分かるときだけ使う）
  assert.deepEqual(m.sessions.map((s) => [s.sessionId, s.rollcalls]).sort(), [["2026-02", 82], ["499", 30]]);
  assert.equal(m.sessions.reduce((s, x) => s + (x.rollcalls ?? 0), 0), 112, "会期ごとの採決数の合計");
  assert.deepEqual([...new Set(rcs.map((r) => r.sessionId))].sort(), ["2026-02", "499"]);
  // **全部の採決に日付・件名がある**（**中身は見ない**——#866 が `title` を直している最中）
  assert.deepEqual(rcs.filter((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date)).map((r) => r.id), [], "日付の形");
  assert.deepEqual(rcs.filter((r) => r.title === "").map((r) => r.id), [], "件名が空の採決");
  assert.deepEqual([...new Set(rcs.map((r) => r.date))].sort(), ["2026-03-12", "2026-07-02"], "議決日");
  assert.equal(new Set(rcs.map((r) => r.id)).size, rcs.length, "id の重複");
});

/** **名簿 35 人に kana / district / group が揃っている**（#632 の検算が効く議会）。 */
test("#865 本番 pref-32: 35 人全員に kana・選挙区・会派がある", { skip: !hasData }, () => {
  const index = JSON.parse(readFileSync(join(DATA, "members", "index.json"), "utf-8")) as LocalMember[];
  const shimane = index.filter((m) => m.assemblyId === "pref-32");
  assert.equal(shimane.length, 35, "母数");
  assert.deepEqual(shimane.filter((m) => m.kana === "").map((m) => m.name), [], "かなの無い議員");
  assert.deepEqual(shimane.filter((m) => m.district === "").map((m) => m.name), [], "選挙区の無い議員");
  assert.deepEqual(shimane.filter((m) => m.group === "").map((m) => m.name), [], "会派の無い議員");
  const groups = new Map<string, number>();
  for (const m of shimane) groups.set(m.group, (groups.get(m.group) ?? 0) + 1);
  // **実測 2026-09-14**。**「会派に属しない」も会派の欄の原文**（空にしていない）
  assert.deepEqual(Object.fromEntries([...groups].sort()), {
    "会派に属しない": 1, "公明党島根県議団": 2, "日本共産党島根県議団": 2, "民主県民クラブ": 5, "自民党ネクスト島根": 10, "自民党議員連盟": 15,
  });
  assert.equal([...groups.values()].reduce((a, b) => a + b, 0), 35, "会派の内訳の合計");
  assert.equal(meta().rosterAsOf, "2023-05-17");
});
