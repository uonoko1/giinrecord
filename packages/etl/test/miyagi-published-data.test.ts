import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { LocalAssemblyMeta, LocalMember, LocalRollCall, LocalUnmatchedName } from "@seiji-kiroku/shared";
import { MIYAGI_HOST } from "../src/sources/local/miyagi/site.ts";

/**
 * **本番 `data/assemblies/pref-04/` に出したものを、出した後から読み直して数える**（Issue #865）。
 *
 * **`votes-pdf.ts` のテストは PDF を読む側を見ている。ここは「書いたもの」を見る。**
 * **同じ実装で 2 回測っているのではない**——**`data/` の JSON を読み直しているので、
 * 書き出し（`buildLocalAssembly` / `writeLocalAssembly`）が壊れたらここが落ちる。**
 *
 * **#864 の `published-data-validate.test.ts` とは重ならない。** あちらは**全県まとめて構造の
 * 不変条件**を見る（index と原本の対応・`assemblyId`・`by-assembly.json` の集計）。
 * **ここが見るのは、共通の検査が原理的に知らない「宮城の中身」**——
 * **`議` が誰か・○ の数が公表値と合うか・会期をまたいで消えた氏名は誰か。**
 *
 * **母数を毎回出す**（#757）。**「違反 0 件」と「1 件も見ていない」を区別できる形で書く。**
 */
const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));
const DIR = join(DATA, "assemblies", "pref-04");

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
  (JSON.parse(readFileSync(join(DATA, "members", "index.json"), "utf-8")) as LocalMember[]).filter((m) => m.assemblyId === "pref-04");

test("#901 本番 pref-04: 採決 584・セル 33,815・不明セル 29（11 会期。#865 の 133 / 7,448 から広げた）", { skip: !hasData }, () => {
  const m = meta();
  const rcs = rollCalls();
  // **実測 2026-09-21**（`--sessions 11`。**第400 〜 第390回**）。
  // **#865 の時点は `--sessions 2` で 133 採決 / 7,448 セル / 不明 0 だった。**
  assert.equal(m.counts.rollcalls, 584);
  assert.equal(m.counts.members, 56);
  assert.equal(m.counts.cells, 33_815);
  // **29 セルは第393回（令和6年9月）の 石川光次郎 の列**——**PDF がその列を 29 行ぶん空欄にしている**
  // （`欠` でも `－` でもなく記号が 1 つも無い。#871 が実測）。**推定せず `不明` で残す。**
  assert.equal(m.counts.unknownCells, 29, "**推定せず `不明` で残したセル**");
  assert.equal(m.counts.unmatchedNames, 5);
  // **meta の数が、書いた実物と一致する**（meta だけを書き換えても落ちる）
  assert.equal(rcs.length, m.counts.rollcalls, "rollcalls/ の実ファイル数");
  assert.equal(rcs.reduce((s, r) => s + r.votes.length, 0), m.counts.cells, "票の実数");
  // **長方形ではない**——**議員数が会期で 56 / 58 / 59 と動く**（**広げて初めて出る形**）。
  // **だから「採決 × 議員」の掛け算では検算できない。会期ごとに人数と本数を突き合わせる。**
  assert.deepEqual([...new Set(rcs.map((r) => r.votes.length))].sort((a, b) => a - b), [56, 58, 59], "採決ごとの票数");
  const perSession = new Map<string, { rows: number; members: Set<number> }>();
  for (const r of rcs) {
    const e = perSession.get(r.sessionId) ?? { rows: 0, members: new Set<number>() };
    e.rows++;
    e.members.add(r.votes.length);
    perSession.set(r.sessionId, e);
  }
  assert.deepEqual(
    Object.fromEntries([...perSession].map(([k, v]) => [k, [v.rows, [...v.members]]]).sort()),
    {
      "390": [46, [59]], "391": [101, [59]], "392": [31, [59]], "393": [31, [59]], "394": [43, [58]],
      "395": [89, [58]], "396": [31, [58]], "397": [29, [58]], "398": [50, [58]], "399": [110, [56]], "400": [23, [56]],
    },
    "**会期ごとの [採決数, 議員数の通り]**（1 人静かに落ちれば会期の人数が変わる）",
  );
  // **足し合わせが meta と合う**（母数を式で残す。#757）
  assert.equal([...perSession.values()].reduce((n, v) => n + v.rows * [...v.members][0], 0), 33_815);
  assert.equal(46 * 59 + 101 * 59 + 31 * 59 + 31 * 59 + 43 * 58 + 89 * 58 + 31 * 58 + 29 * 58 + 50 * 58 + 110 * 56 + 23 * 56, 33_815);
});

/**
 * **票の値と凡例**（**凡例に無い値が出ていない**）。
 * **`抽出不能` が 0 であることを、母数つきで言う**——**0 でも数える**のは、
 * **「凡例に無い記号が混ざり始めた」ことに増えてから気づけるようにするため**（#750 と同じ理由）。
 */
test("#901 本番 pref-04: 票 33,815 の内訳（○ 32500 / × 626 / 議 584 / 欠 61 / 不明 29 / － 11 / 除 3 / - 1）", { skip: !hasData }, () => {
  const votes = rollCalls().flatMap((r) => r.votes);
  assert.equal(votes.length, 33_815, "母数（減っていたら以下の内訳は意味が無い）");
  const raw = new Map<string, number>();
  const legend = new Map<string, number>();
  for (const v of votes) {
    raw.set(v.value.raw, (raw.get(v.value.raw) ?? 0) + 1);
    legend.set(v.value.legend, (legend.get(v.value.legend) ?? 0) + 1);
  }
  // **広げて初めて出た記号が 3 つある**: **`除`（除斥）3 / `-` U+002D 1 / `不明` 29。**
  // **`-` は第391回の 1 セルで、`glyph-variants.ts` が `－` U+FF0D に寄せて凡例を引いている**（#901）——
  // **`raw` は原文のまま `-` で残る**（#674 と同じ方針。**寄せるのは凡例を引くときだけ**）。
  assert.deepEqual(Object.fromEntries([...raw].sort((a, b) => b[1] - a[1])),
    { "○": 32500, "×": 626, "議": 584, "欠": 61, "不明": 29, "－": 11, "除": 3, "-": 1 });
  // **`－`(U+FF0D) は「議場に不在」**——**「欠席」と別の事実**なので畳まない（#569）。
  // **`-` U+002D も同じ意味に落ちる**（11 + 1 = 12）が、**raw は分かれたままである。**
  assert.deepEqual(Object.fromEntries([...legend].sort((a, b) => b[1] - a[1])),
    { "賛成": 32500, "反対": 626, "議長": 584, "欠席": 61, "抽出不能": 29, "議場に不在": 12, "除斥": 3 });
  assert.equal(raw.get("不明"), 29, "`不明` の票（PDF が空欄にしている列。推定していない）");
  assert.equal(legend.get("抽出不能"), 29, "`抽出不能` の票");
  // **`mapped` が付かない票は `不明` の 29 票だけ**（凡例の意味は全部 `MAPPED` に載っている）
  assert.deepEqual([...new Set(votes.filter((v) => v.value.mapped === undefined).map((v) => v.value.raw))], ["不明"]);
  assert.equal(votes.filter((v) => v.value.mapped === undefined).length, 29);
  assert.deepEqual(Object.fromEntries([...votes.reduce((m2, v) => m2.set(String(v.value.mapped), (m2.get(String(v.value.mapped)) ?? 0) + 1), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1])), { "賛成": 32500, "投票なし": 660, "反対": 626, "undefined": 29 });
  assert.equal(584 + 61 + 12 + 3, 660, "「投票なし」の内訳（議長 + 欠席 + 議場に不在 + 除斥）");
});

/**
 * ## **`議` は全 133 採決でちょうど 1 人で、2 会期とも同じ 1 人**
 *
 * **「議長は 1 人」は当たり前に見えるが、当たり前ではない。**
 * **奈良（pref-29）では同じ PDF の中で 2 行だけ `議` が別人に移る**（副知事・監査委員の選任。
 * `nara-published-data.test.ts`）。**三重（pref-24）では会議年度の切り替わりで議長が代わる。**
 * **宮城は 133 / 133 本で同じ 1 人**——**これは県ごとに違う事実であって、共通の検査には書けない。**
 *
 * **ただし「議長は採決に加わらない」と決め打ちしない**——**実装は PDF の記号をそのまま読む。**
 * **`議` が 0 人の行が出たら、それはそう印刷されていたということ**（#615 が秋田で実測）。
 */
test("#901 本番 pref-04: `議` は全 584 採決で 1 人、11 会期で 2 人（髙橋 伸二 → 佐々木幸士）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  const perRollCall = new Map<number, number>();
  const bySession = new Map<string, Map<string, number>>();
  for (const rc of rcs) {
    const gi = rc.votes.filter((v) => v.value.raw === "議");
    perRollCall.set(gi.length, (perRollCall.get(gi.length) ?? 0) + 1);
    for (const v of gi) {
      assert.equal(v.value.legend, "議長", `${rc.id}`);
      assert.equal(v.value.mapped, "投票なし", `${rc.id}`);
      const s = bySession.get(rc.sessionId) ?? new Map<string, number>();
      s.set(v.nameText, (s.get(v.nameText) ?? 0) + 1);
      bySession.set(rc.sessionId, s);
    }
  }
  assert.deepEqual(Object.fromEntries(perRollCall), { 1: 584 }, "採決ごとの `議` の数（母数 584）");
  // **広げたので議長が 2 人に跨る**——**「1 人ぶんしか見ていない」状態を抜けた。**
  // **交代は 2025-11-27（46代 髙橋伸二 → 47代 佐々木幸士）で、第398回から新議長になる。**
  // **どの会期も `議` は 1 人だけ**（**議長交代の当日に議決した行は 1 つも無い**——
  // 宮城の交代は 11 月下旬だが、11 月に議決日が 1 日も無い。`miyagi-vote-alignment.test.ts`）。
  assert.deepEqual(
    Object.fromEntries([...bySession].map(([k, v]) => [k, Object.fromEntries(v)]).sort()),
    {
      "390": { "髙橋 伸二": 46 }, "391": { "髙橋 伸二": 101 }, "392": { "髙橋 伸二": 31 }, "393": { "髙橋 伸二": 31 },
      "394": { "髙橋 伸二": 43 }, "395": { "髙橋 伸二": 89 }, "396": { "髙橋 伸二": 31 }, "397": { "髙橋 伸二": 29 },
      "398": { "佐々木幸士": 50 }, "399": { "佐々木幸士": 110 }, "400": { "佐々木幸士": 23 },
    },
    "**会期ごとに `議` が誰で何本か**（列がずれれば別人になる）",
  );
  // **`議` が付く議員は 2 人**（どちらも名簿に寄っている＝空の memberId ではない）
  const ids = new Set(rcs.flatMap((r) => r.votes.filter((v) => v.value.raw === "議").map((v) => v.memberId)));
  assert.deepEqual([...ids].sort(), ["p_04_kosi", "p_04_sinji"], "`議` の memberId");
});

/**
 * **PDF 自身が印刷している集計（`counts`）と、抽出した票の意味が合う。**
 * **宮城は 133 / 133 本すべてに `counts` がある**（奈良は 0 / 125 本、滋賀は読めない行が 4 本ある）。
 *
 * **これは「氏名の列が正しい」証明ではない**（数だけ。1 列ずらしても数は合う——#743 が実測）。
 * **順序の検算は `miyagi-votes-pdf.test.ts` が受け持つ。**
 * **ここで言えるのは「記号を落としても増やしてもいない」こと。**
 */
test("#901 本番 pref-04: 賛成の数 = counts.yes / 反対の数 = counts.no（584 本すべてに counts があり、555 本を突き合わせた）", { skip: !hasData }, () => {
  const rcs = rollCalls();
  assert.equal(rcs.length, 584, "母数");
  let checked = 0, skipped = 0;
  for (const rc of rcs) {
    assert.ok(rc.counts, `${rc.id}: counts が無い`);
    // **`不明` を含む行は判定外**（**`不明` を `○` とも `×` とも数えない**）。
    // **29 行は第393回の 石川光次郎 の空欄で、その 29 行の `出席者数` は 58（○ がある 2 行は 59）**
    // ——**公表数とも矛盾しない**（#871）。
    if (rc.votes.some((v) => v.value.raw === "不明")) { skipped++; continue; }
    assert.equal(rc.votes.filter((v) => v.value.mapped === "賛成").length, rc.counts!.yes, `${rc.id}: 賛成`);
    assert.equal(rc.votes.filter((v) => v.value.mapped === "反対").length, rc.counts!.no, `${rc.id}: 反対`);
    checked++;
  }
  assert.equal(checked, 555, "**突き合わせた採決の数**（0 件を「違反なし」と読み違えないため）");
  assert.equal(skipped, 29, "不明セルを含む行");
  assert.equal(checked + skipped, 584, "母数の検算（#757）");
  // **meta の母数も同じことを言っている**（#757。`countChecked` は `countMismatchesOf` が数える）
  assert.deepEqual(meta().countChecked, { rows: 584, checked: 555, noCounts: 0, unreadableCells: 29 });
  // **#871 が見つけた「一次資料そのものが合わない 1 行」（第388回 知事提出議案104）は
  // `--sessions 11` の範囲の外**（第388回は 13 本目）——**だから食い違いは 0 件のままである。**
  assert.equal(meta().countMismatches, undefined, "食い違いが無ければ省略される");
});

/**
 * ## **未突合 1 件は `中島 源陽`——理由は省略（＝名簿に無い氏名）**
 *
 * **`sourceConflict`（字が 1 つ違う）でも `brokenGlyph`（字が壊れている）でもない。**
 * **名簿（`rosterAsOf` 2026-04-23）にこの氏名が無い**——**理由が違えば、運用者が次にすることも違う**（#680／#711）。
 *
 * **事実として言えるのはここまで**（#796。**氏名が近いだけで同一人物と書かない**）:
 *   - **`中島 源陽` は第399回（令和8年2月定）の 110 本すべてに出て、第400回には 1 本も出ない。**
 *   - **`鈴木 敦`（名簿にいる）は第400回の 23 本すべてに出て、第399回には 1 本も出ない。**
 * **「入れ替わった」とはこのテストでは書かない**——**一次資料が言っているのは出欠の範囲だけである。**
 *
 * **票そのものは残っている**（`memberId` が空なだけ。「記録が出ない」にしていない）。
 */
test("#901 本番 pref-04: 未突合 5 件（4 人。うち 1 人は会派が変わって 2 行）と、会期ごとに出る氏名の差", { skip: !hasData }, () => {
  const um = JSON.parse(readFileSync(join(DIR, "unmatched.json"), "utf-8")) as LocalUnmatchedName[];
  // **`unmatched` は「名簿に寄らなかった氏名」で、増えるのは安全側である**（#901 の PO の言葉）。
  // **`--sessions 2` のときは 1 件（中島 源陽）だった。11 会期に広げて 5 件。**
  // **`reason` はどれも省略＝「名簿にこの氏名が無い」**（`sourceConflict` でも `brokenGlyph` でもない）。
  // **`中島 源陽` が 2 行あるのは、鍵が「氏名 + 会派」だからである**——
  // **第397回までは `無所属`、第398・399回は `自由民主党・県民会議` と PDF に書いてある**（原文のまま）。
  // **同一人物だと断定はしない**（#796。**一次資料が言っているのは各会期の会派の表記まで**）。
  assert.deepEqual(um.map((u) => ({ name: u.nameText, reason: u.reason, group: u.group, rollCalls: u.rollCallIds.length })), [
    { name: "ゆさみゆき", reason: undefined, group: "みやぎ県民の声", rollCalls: 401 },
    { name: "中島 源陽", reason: undefined, group: "無所属", rollCalls: 192 },
    { name: "中島 源陽", reason: undefined, group: "自由民主党・県民会議", rollCalls: 369 },
    { name: "渡辺 勝幸", reason: undefined, group: "自由民主党・県民会議", rollCalls: 451 },
    { name: "渡辺 重益", reason: undefined, group: "自由民主党・県民会議", rollCalls: 451 },
  ]);
  assert.equal(meta().counts.unmatchedNames, 5);

  const rcs = rollCalls();
  // **memberId が空の票は 1,864**（母数 33,815 の 5.5%）。**票そのものは読めている**——
  // **「記録が出ない」にはしていない**（`memberId` が空なだけ）。
  const orphan = rcs.flatMap((r) => r.votes).filter((v) => v.memberId === "");
  assert.equal(orphan.length, 1_864, "母数 33,815 のうち名簿に寄らなかった票");
  assert.equal(401 + 192 + 369 + 451 + 451, 1_864, "内訳の検算（#757）");
  assert.deepEqual([...new Set(orphan.map((v) => v.nameText))].sort(), ["ゆさみゆき", "中島 源陽", "渡辺 勝幸", "渡辺 重益"]);
  assert.deepEqual(orphan.filter((v) => v.value.mapped === undefined && v.value.raw !== "不明"), [], "寄らなくても票は読めている");

  // ## **会期ごとに出る氏名の集合**——**止める位置を決めた検算**（#901）
  //
  // **地方の名簿は「今の 1 枚」しか無いので、一般選挙をまたぐと引退した議員の票が
  // 今の別人に付きうる**（#569 の重いほう）。**#928 の検査はこれを捕まえない**——
  // **13 本目まで広げても `rosterAsOf` から 1,178 日で、上限 1,461 日の内側である。**
  //
  // **だから一次資料（PDF に出る氏名そのもの）で境を見た。**
  // **本番の 11 会期では、隣り合う会期の入れ替わりはどれも 0〜2 人である**（任期中の辞職・補選の規模）。
  // **12 本目（第389回）に広げると IN 18 / OUT 19 になる**——**2023-10 の一般選挙。そこで止めた。**
  const bySession = new Map<string, Set<string>>();
  for (const r of rcs) {
    const s = bySession.get(r.sessionId) ?? new Set<string>();
    for (const v of r.votes) s.add(v.nameText);
    bySession.set(r.sessionId, s);
  }
  const ids = [...bySession.keys()].sort((a, b) => Number(b) - Number(a));
  assert.deepEqual(ids, ["400", "399", "398", "397", "396", "395", "394", "393", "392", "391", "390"], "会期（新しい順）");
  const moves: Record<string, [size: number, joined: string[], left: string[]]> = {};
  for (let i = 0; i + 1 < ids.length; i++) {
    const cur = bySession.get(ids[i])!;
    const prev = bySession.get(ids[i + 1])!;
    moves[ids[i]] = [cur.size, [...cur].filter((n) => !prev.has(n)), [...prev].filter((n) => !cur.has(n))];
  }
  assert.deepEqual(moves, {
    "400": [56, ["鈴木 敦"], ["中島 源陽"]],
    "399": [56, [], ["渡辺 重益", "渡辺 勝幸"]],
    "398": [58, ["石川光次郎"], ["ゆさみゆき"]],
    "397": [58, [], []],
    "396": [58, [], []],
    "395": [58, [], []],
    "394": [58, [], ["石川光次郎"]],
    "393": [59, [], []],
    "392": [59, [], []],
    "391": [59, [], []],
  }, "**会期ごとの [人数, 入った, 去った]**（5 人以上の入れ替わりが出たら一般選挙をまたいでいる）");
  const sizes: number[] = [];
  for (const key of Object.keys(moves)) { const [, joined, left] = moves[key]; sizes.push(joined.length, left.length); }
  const biggest = Math.max(...sizes);
  assert.equal(biggest, 2, "**いちばん大きい入れ替わり**（本番の範囲では 2 人。5 以上なら選挙の向こう側）");

  // **名簿側でも同じ形**——**11 会期すべてに出る 54 人が 584、`鈴木 敦` が 23（第400回だけ）、
  // `石川 光次郎` が 392**（**第390〜393回の 209 本 ＋ 第398〜400回の 183 本。第394〜397回に出ない**）。
  const ms = members();
  assert.equal(ms.length, 56);
  assert.deepEqual(
    Object.fromEntries([...ms.reduce((m2, m) => m2.set(m.counts?.rollcalls ?? -1, (m2.get(m.counts?.rollcalls ?? -1) ?? 0) + 1), new Map<number, number>())].sort((a, b) => a[0] - b[0])),
    { 23: 1, 392: 1, 584: 54 },
    "名簿の議員ごとの採決数",
  );
  assert.deepEqual(ms.filter((m) => m.counts?.rollcalls === 23).map((m) => m.name), ["鈴木 敦"]);
  assert.deepEqual(ms.filter((m) => m.counts?.rollcalls === 392).map((m) => m.name), ["石川 光次郎"]);
  assert.equal(46 + 101 + 31 + 31 + 50 + 110 + 23, 392, "石川 光次郎 の内訳の検算（第390〜393回 ＋ 第398〜400回）");
});

/** **出典はすべて県の公式ホスト**（`validateLocalAssemblies` も見るが、**本数と PDF の数もここで固定する**）。 */
test("#901 本番 pref-04: sourceUrl はすべて www.pref.miyagi.jp（採決 584 本 + meta の 15 出典 + 会期 11 本）", { skip: !hasData }, () => {
  const m = meta();
  const rcs = rollCalls();
  const urls: string[] = [];
  for (const rc of rcs) urls.push(rc.sourceUrl);
  for (const s of m.sources) urls.push(s.url);
  for (const s of m.sessions) { urls.push(s.sourceUrl); urls.push(s.pdfUrl); for (const p of s.pdfUrls ?? []) urls.push(p); }
  assert.equal(urls.length, 584 + 15 + 11 * 2, "**見た URL の本数**（0 本を「違反なし」と読み違えないため）");
  const bad = urls.filter((u) => new URL(u).host !== MIYAGI_HOST || new URL(u).protocol !== "https:");
  assert.deepEqual([...new Set(bad)], []);
  // **採決の出典は 11 本の PDF だけ**（会期ごとに 1 本。**新しい順の index の先頭 11 会期**）
  assert.deepEqual([...new Set(rcs.map((r) => r.sourceUrl))].sort(), [
    "https://www.pref.miyagi.jp/documents/50057/hyouketsu051219.pdf",   // 第390回
    "https://www.pref.miyagi.jp/documents/50597/hyouketsu060313.pdf",   // 第391回
    "https://www.pref.miyagi.jp/documents/53087/hyouketsu060701.pdf",   // 第392回
    "https://www.pref.miyagi.jp/documents/54531/hyouketsu061017.pdf",   // 第393回
    "https://www.pref.miyagi.jp/documents/55094/hyouketsu061211.pdf",   // 第394回
    "https://www.pref.miyagi.jp/documents/56771/hyouketsu070314.pdf",   // 第395回
    "https://www.pref.miyagi.jp/documents/60482/hyouketsu070630.pdf",   // 第396回
    "https://www.pref.miyagi.jp/documents/61559/hyouketsu1002syuusei.pdf", // 第397回
    "https://www.pref.miyagi.jp/documents/62682/hyouketsu071217.pdf",   // 第398回
    "https://www.pref.miyagi.jp/documents/63622/syuusei_hyouketsu080318.pdf", // 第399回
    "https://www.pref.miyagi.jp/documents/65634/hyoketu080707.pdf",     // 第400回
  ]);
  assert.equal(m.sources.filter((s) => s.url.endsWith(".pdf")).length, 11, "出典の PDF");
  assert.equal(m.unreadableSources, undefined, "読めなかった一次資料は無い（省略される）");
  assert.equal(m.lossyNameMatches, undefined, "字が落ちた氏名の寄せは無い（省略される）");
  // **`rosterAsOf` は名簿ページの「掲載日」で、取得日ではない**（`parsePostedDate`）。
  // **最古の採決 2023-12-12 まで 1,010 日で、#928 の上限 1,461 日の内側**（**鳴らない**）。
  assert.equal(m.rosterAsOf, "2026-09-17");
});

/**
 * **名簿 56 人**——**かな・選挙区・会派が全員に埋まっている**（#632 の検算が効く議会。秋田は かな が空）。
 * **全員が採決に出ている**（`counts.rollcalls` が 0 の議員がいない。#718）。
 */
test("#865 本番 pref-04: 名簿 56 人（かな・選挙区・会派が全員にある）", { skip: !hasData }, () => {
  const ms = members();
  assert.equal(ms.length, 56, "母数");
  assert.deepEqual(ms.filter((m) => m.kana === "").map((m) => m.name), [], "かなが空の議員");
  assert.deepEqual(ms.filter((m) => m.district === "").map((m) => m.name), [], "選挙区が空の議員");
  assert.deepEqual(ms.filter((m) => m.group === "").map((m) => m.name), [], "会派が空の議員");
  assert.deepEqual(ms.filter((m) => (m.counts?.rollcalls ?? 0) === 0).map((m) => m.name), [], "採決 0 件の議員");
  assert.deepEqual(ms.filter((m) => !m.profileUrl.startsWith(`https://${MIYAGI_HOST}/`)).map((m) => m.name), [], "別ホストの profileUrl");
  assert.equal(new Set(ms.map((m) => m.id)).size, 56, "id の重複");
  // **票に出る memberId は 56 通り**（空の 1 通りを除く。名簿と同じ人数）
  const seen = new Set(rollCalls().flatMap((r) => r.votes.map((v) => v.memberId)));
  seen.delete("");
  assert.equal(seen.size, 56, `票に出る議員（${seen.size} 人）`);
});
