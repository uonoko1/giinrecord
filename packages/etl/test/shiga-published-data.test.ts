import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { LocalAssemblyMeta, LocalMember, LocalRollCall, LocalUnmatchedName } from "@seiji-kiroku/shared";
import { SHIGA_HOST } from "../src/sources/local/shiga/site.ts";

/**
 * **本番 `data/assemblies/pref-25/` に出したものを、出した後から読み直して数える**（Issue #865）。
 *
 * **`votes-pdf.ts` のテストは PDF を読む側を見ている。ここは「書いたもの」を見る。**
 * **`data/` の JSON を読み直しているので、書き出しが壊れたらここが落ちる。**
 *
 * **#864 の `published-data-validate.test.ts` とは重ならない**——あちらは**全県まとめて構造の不変条件**。
 *
 * ## **滋賀は 11 議会で唯一「読めなかった本がある」県**
 *
 * **604 セル中 164（27.2%）が `抽出不能`**——**そのすべてが 6月臨時会議の 1 本の PDF に固まっている。**
 * **これは「記号が読めなかった」のではなく「凡例の表が引けなかった」**（`legend` が `抽出不能`、
 * `raw` には `○` `×` `議` がちゃんと入っている）。**#569 のとおり推定していない。**
 *
 * **このため共通の検算（`countMismatchesOf`）は滋賀の 4 行を母数から外す**
 * （`mapped` の無いセルは賛成とも反対とも数えられない。`local-assemblies.ts` の docblock）。
 * **その 4 行を「生の記号で」突き合わせるのは、ここでしかできない**——**共通の検査は意味で数えるので。**
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

test("#865 本番 pref-25: 採決 14 / セル 604 / 名簿 44 人（meta.json と実物が一致する）", { skip: !hasData }, () => {
  const m = meta();
  const rcs = rollCalls();
  // **実測 2026-09-14**（令和8年6月臨時会議 4 本 + 令和8年7月定例会議 10 本）
  assert.equal(m.counts.rollcalls, 14);
  assert.equal(m.counts.members, 44);
  assert.equal(m.counts.cells, 604);
  // **`unknownCells` は `raw === "不明"` の数**（セルを確実に置けなかった数）で、
  // **`抽出不能`（凡例が引けない）とは別の数**——**滋賀は前者 0・後者 164。混ぜない。**
  assert.equal(m.counts.unknownCells, 0, "**推定せず `不明` で残したセルは 0**");
  assert.equal(m.counts.unmatchedNames, 1);
  assert.equal(rcs.length, m.counts.rollcalls, "rollcalls/ の実ファイル数");
  assert.equal(rcs.reduce((s, r) => s + r.votes.length, 0), m.counts.cells, "票の実数");
  // **会期ごとに列数が違う**（6月臨時 41 人 / 7月定例 44 人）。**4 × 41 + 10 × 44 = 604**
  const byCells = new Map<string, Set<number>>();
  for (const r of rcs) {
    const s = byCells.get(r.sessionId) ?? new Set<number>();
    s.add(r.votes.length);
    byCells.set(r.sessionId, s);
  }
  assert.deepEqual(Object.fromEntries([...byCells].map(([k, v]) => [k, [...v]]).sort()),
    { "2026-06-rinji": [41], "2026-07": [44] }, "**会期の中で票数がぶれたら議員が静かに落ちている**");
  assert.equal(4 * 41 + 10 * 44, 604, "母数を式で残す");
  assert.deepEqual(m.sessions.map((s) => [s.sessionId, s.rollcalls]).sort(), [["2026-06-rinji", 4], ["2026-07", 10]]);
});

/**
 * ## **`抽出不能` 164 セル（27.2%）は 6月臨時会議の 4 本に固まっている**
 *
 * **青森・秋田・佐賀・宮城・三重・奈良はいずれも 0 件**——**滋賀だけが違う。**
 * **「0%」を他県から写してくると、滋賀では偽になる。**
 *
 * **`raw` は読めている**（`○` 135 / `×` 25 / `議` 4）——**引けなかったのは凡例だけ。**
 * **だから `mapped` が無い**（賛成とも反対とも言えない）。**推定していない**（#569）。
 */
test("#865 本番 pref-25: 抽出不能 164 / 604 セル（27.2%）は 6月臨時会議だけ", { skip: !hasData }, () => {
  const rcs = rollCalls();
  const votes = rcs.flatMap((r) => r.votes);
  assert.equal(votes.length, 604, "母数（減っていたらこの割合は意味が無い）");
  const unread = votes.filter((v) => v.value.legend === "抽出不能");
  assert.equal(unread.length, 164, "`抽出不能` のセル");
  assert.equal(Math.round((unread.length / votes.length) * 1000) / 10, 27.2, "割合（%）");
  // **`mapped` が無いのはその 164 セルだけ**（過不足なく一致する）
  assert.equal(votes.filter((v) => v.value.mapped === undefined).length, 164);
  assert.deepEqual(unread.filter((v) => v.value.mapped !== undefined), []);
  // **164 セルは 6月臨時会議の 4 本（4 × 41 = 164）だけ**
  const bySession = new Map<string, number>();
  for (const r of rcs) {
    const n = r.votes.filter((v) => v.value.legend === "抽出不能").length;
    bySession.set(r.sessionId, (bySession.get(r.sessionId) ?? 0) + n);
  }
  assert.deepEqual(Object.fromEntries([...bySession].sort()), { "2026-06-rinji": 164, "2026-07": 0 });
  // **記号そのものは読めている**（凡例が引けなかっただけ）
  const raw = new Map<string, number>();
  for (const v of unread) raw.set(v.value.raw, (raw.get(v.value.raw) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries([...raw].sort()), { "×": 25, "○": 135, "議": 4 });
  assert.equal(raw.get("不明"), undefined, "`不明` のセルは無い");
  // **7月定例会議の 440 セルは全部意味が付いている**
  const ok = rcs.filter((r) => r.sessionId === "2026-07").flatMap((r) => r.votes);
  assert.equal(ok.length, 440);
  assert.deepEqual(Object.fromEntries([...ok.reduce((m2, v) => m2.set(v.value.legend, (m2.get(v.value.legend) ?? 0) + 1), new Map<string, number>())].sort()),
    { "反対": 54, "議長（表決権なし）": 10, "賛成": 376 });
});

/**
 * ## **共通の検算が母数から外す 4 行を、生の記号で突き合わせる**（ここでしかできない）
 *
 * **`countMismatchesOf` は `mapped` の無いセルがある行を外す**——
 * **意味で数えると 0 対 0 になり、偽の食い違いが 4 件出るから**（`local-assemblies.ts` の docblock）。
 * **外した結果、その 4 行は本番でどこからも突き合わせられていない。**
 *
 * **生の `○` / `×` を数えれば、公表値と合う**——**14 / 14 本すべてで。**
 * **つまり「凡例が読めていない」だけで「票を落としている」わけではない、と言える。**
 * **これは意味に依存しないので、凡例が引けない行にも当てられる。**
 */
test("#865 本番 pref-25: 生の ○ / × の数 = 公表値（14 / 14 本。共通の検算が外す 4 行を含む）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  assert.equal(rcs.length, 14, "母数");
  let checked = 0;
  let unreadRows = 0;
  for (const rc of rcs) {
    assert.ok(rc.counts, `${rc.id}: counts が無い`);
    assert.equal(rc.votes.filter((v) => v.value.raw === "○").length, rc.counts!.yes, `${rc.id}: ○`);
    assert.equal(rc.votes.filter((v) => v.value.raw === "×").length, rc.counts!.no, `${rc.id}: ×`);
    checked++;
    if (rc.votes.some((v) => v.value.mapped === undefined)) unreadRows++;
  }
  assert.equal(checked, 14, "**生の記号で突き合わせた採決の数**");
  assert.equal(unreadRows, 4, "**そのうち共通の検算（意味で数える側）が母数から外す行**");
  // **meta 側も同じことを言っている**（#757。`unreadableCells` が 4、`checked` は 10）
  assert.deepEqual(meta().countChecked, { rows: 14, checked: 10, noCounts: 0, unreadableCells: 4 });
  assert.equal(meta().countMismatches, undefined, "意味で数えた側の食い違いは 0（省略される）");
  // **`present` / `voting` も PDF が印刷している**（滋賀だけ。`yes + no + 棄権` の関係は主張しない）
  assert.deepEqual([...new Set(rcs.map((r) => r.counts!.present))].sort((a, b) => a! - b!), [41, 44]);
});

/**
 * ## **`議` は 14 / 14 本で 1 人、2 会期とも 加藤 誠一**
 *
 * **凡例が引けない 4 本でも `議` は読めている**（`raw` は `議`、`legend` が `抽出不能`）。
 * **「`議` の legend が常に議長」は滋賀では偽**——**他県から写すと落ちる。**
 *
 * **氏名が `加 藤 誠 一` と空白入りなのは PDF がそう組んでいるから**——**詰めない**（原文のまま残す）。
 */
test("#865 本番 pref-25: `議` は 14 本すべてで 1 人（凡例が引けない 4 本を含む）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  const perRollCall = new Map<number, number>();
  const bySessionLegend = new Map<string, Map<string, number>>();
  const ids = new Set<string>();
  for (const rc of rcs) {
    const gi = rc.votes.filter((v) => v.value.raw === "議");
    perRollCall.set(gi.length, (perRollCall.get(gi.length) ?? 0) + 1);
    for (const v of gi) {
      ids.add(v.memberId);
      assert.equal(v.nameText, "加 藤 誠 一", rc.id);
      const s = bySessionLegend.get(rc.sessionId) ?? new Map<string, number>();
      s.set(v.value.legend, (s.get(v.value.legend) ?? 0) + 1);
      bySessionLegend.set(rc.sessionId, s);
    }
  }
  assert.deepEqual(Object.fromEntries(perRollCall), { 1: 14 }, "採決ごとの `議` の数（母数 14）");
  assert.deepEqual([...ids], ["p_25_159"], "`議` の memberId（1 人）");
  // **7月定例は `議長（表決権なし）`、6月臨時は凡例が引けないので `抽出不能`**
  assert.deepEqual(
    Object.fromEntries([...bySessionLegend].map(([k, v]) => [k, Object.fromEntries(v)]).sort()),
    { "2026-06-rinji": { "抽出不能": 4 }, "2026-07": { "議長（表決権なし）": 10 } },
  );
});

/**
 * ## **未突合 1 件は `brokenGlyph`——字が壊れているので名簿に寄せていない**（#680／#569）
 *
 * **8月10日の PDF では姓が `□`（U+25A1）に潰れている。** ETL は**寄せていない**——
 * **名簿に `辻 正隆` がいて、同じ日の他の PDF では `辻󠄀 正 隆` と読めているが、
 * 「壊れた字がその人である」とは決めない**（#569／#796）。**票は残っている**（`memberId` が空）。
 *
 * **このテストは「同一人物である」とも「別人である」とも言わない。**
 * **言うのは「ETL が推定しなかった」という事実だけ**である。
 */
test("#865 本番 pref-25: 未突合 1 件は brokenGlyph（□ 正 隆・8 票は名簿に寄せていない）", { skip: !hasData }, () => {
  const um = JSON.parse(readFileSync(join(DIR, "unmatched.json"), "utf-8")) as LocalUnmatchedName[];
  assert.deepEqual(um.map((u) => ({ name: u.nameText, reason: u.reason, group: u.group, rollCalls: u.rollCallIds.length })), [
    { name: "□ 正 \u{F9DC}", reason: "brokenGlyph", group: "自由民主党滋賀県議会議員団", rollCalls: 8 },
  ]);
  assert.equal(meta().counts.unmatchedNames, 1);
  // **機序が符号位置で分かる**（推定ではなく、文字そのものが違う）
  assert.equal("□".codePointAt(0), 0x25a1, "PDF 側の姓は白い四角（U+25A1）");
  assert.equal(um[0].nameText.codePointAt(4), 0xf9dc, "`隆` は互換漢字 U+F9DC（名簿と同じ）");
  // **8 票は 8月10日の 8 本だけ**（`memberId` が空なのはこの 8 票だけ）
  const rcs = rollCalls();
  const orphan = rcs.flatMap((r) => r.votes).filter((v) => v.memberId === "");
  assert.equal(orphan.length, 8, "母数 604 のうち名簿に寄らなかった票");
  assert.deepEqual([...new Set(orphan.map((v) => v.nameText))], ["□ 正 \u{F9DC}"]);
  const dates = new Set(rcs.filter((r) => r.votes.some((v) => v.memberId === "")).map((r) => r.date));
  assert.deepEqual([...dates], ["2026-08-10"], "壊れた字が出る議決日");
  // **同じ議会の別の PDF では読めている**（`辻󠄀` は異体字セレクタ U+E0100 つき）
  const ok = rcs.flatMap((r) => r.votes).filter((v) => v.nameText.startsWith("辻"));
  assert.equal(ok.length, 6, "`辻` と読めた票");
  assert.deepEqual([...new Set(ok.map((v) => v.nameText))], ["辻\u{E0100} 正 \u{F9DC}"]);
  assert.deepEqual([...new Set(ok.map((v) => v.memberId))], ["p_25_197"]);
});

/** **出典はすべて県議会の公式ホスト**（**Shift_JIS のサイト。PDF は 3 本**）。 */
test("#865 本番 pref-25: sourceUrl はすべて www.shigaken-gikai.jp（採決 14 本 + meta の 7 出典 + 会期 2 本）", { skip: !hasData }, () => {
  const m = meta();
  const rcs = rollCalls();
  const urls: string[] = [];
  for (const rc of rcs) urls.push(rc.sourceUrl);
  for (const s of m.sources) urls.push(s.url);
  for (const s of m.sessions) { urls.push(s.sourceUrl); urls.push(s.pdfUrl); for (const p of s.pdfUrls ?? []) urls.push(p); }
  assert.equal(urls.length, 14 + 7 + (1 + 1 + 2) + (1 + 1 + 1), "**見た URL の本数**（0 本を「違反なし」と読み違えないため）");
  const bad = urls.filter((u) => new URL(u).host !== SHIGA_HOST || new URL(u).protocol !== "https:");
  assert.deepEqual([...new Set(bad)], []);
  const pdfs = [...new Set(rcs.map((r) => r.sourceUrl))].sort();
  assert.equal(pdfs.length, 3, `採決が指す PDF（${pdfs.length} 本）`);
  assert.deepEqual(pdfs.filter((u) => !u.endsWith(".pdf")), [], "PDF でない出典");
  assert.equal(m.sources.filter((s) => s.url.endsWith(".pdf")).length, 3, "meta の出典の PDF");
  // **会期ページは `.asp?KaigiID=`**（連番に見えて飛ぶので組み立てない。#670）
  assert.deepEqual(m.sessions.map((s) => s.sourceUrl).sort(), [
    "https://www.shigaken-gikai.jp/g07_gian_sanpi.asp?KaigiID=256",
    "https://www.shigaken-gikai.jp/g07_gian_sanpi.asp?KaigiID=258",
  ]);
  assert.equal(m.unreadableSources, undefined, "**PDF は全部読めた**（凡例が引けないのは別の話）");
  assert.equal(m.lossyNameMatches, undefined, "字が落ちた氏名の寄せは無い（省略される）");
  assert.equal(m.rosterAsOf, "2026-09-13");
});

/**
 * **名簿 44 人**——**かな・選挙区・会派が全員にある**。
 * **採決数は 44 / 14 / 10 / 6 に割れる**（14 本すべてに出るのは 40 人）。
 * **名簿は 2026-09-13 現在**なので、**6月臨時（41 人）より 3 人多い。**
 */
test("#865 本番 pref-25: 名簿 44 人（採決数は 14 が 40 人・10 が 3 人・6 が 1 人）", { skip: !hasData }, () => {
  const ms = members();
  assert.equal(ms.length, 44, "母数");
  assert.deepEqual(ms.filter((m) => m.kana === "").map((m) => m.name), [], "かなが空の議員");
  assert.deepEqual(ms.filter((m) => m.district === "").map((m) => m.name), [], "選挙区が空の議員");
  assert.deepEqual(ms.filter((m) => m.group === "").map((m) => m.name), [], "会派が空の議員");
  assert.deepEqual(ms.filter((m) => (m.counts?.rollcalls ?? 0) === 0).map((m) => m.name), [], "採決 0 件の議員");
  assert.deepEqual(ms.filter((m) => !m.profileUrl.startsWith(`https://${SHIGA_HOST}/`)).map((m) => m.name), [], "別ホストの profileUrl");
  assert.equal(new Set(ms.map((m) => m.id)).size, 44, "id の重複");
  assert.deepEqual(
    Object.fromEntries([...ms.reduce((m2, m) => m2.set(m.counts?.rollcalls ?? -1, (m2.get(m.counts?.rollcalls ?? -1) ?? 0) + 1), new Map<number, number>())].sort((a, b) => a[0] - b[0])),
    { 6: 1, 10: 3, 14: 40 },
    "名簿の議員ごとの採決数",
  );
  // **`辻 正隆` が 6 本**（8月10日の 8 票は壊れた字なので寄せていない。上のテストと同じ事実の名簿側）
  // **名簿の `隆` も互換漢字 U+F9DC**（県のページがそう書いている。畳まない）
  assert.deepEqual(ms.filter((m) => m.counts?.rollcalls === 6).map((m) => m.name), ["辻 正\u{F9DC}"]);
  const seen = new Set(rollCalls().flatMap((r) => r.votes.map((v) => v.memberId)));
  seen.delete("");
  assert.equal(seen.size, 44, `票に出る議員（${seen.size} 人）`);
});
