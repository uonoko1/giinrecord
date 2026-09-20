import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseVotePdf } from "../src/sources/local/miyagi/votes-pdf.ts";
import { toIsoDate } from "../src/sources/local/miyagi/rollcalls.ts";

/**
 * # 宮城の `--sessions` を広げる前に直した 2 つの欠陥（Issue #901）
 *
 * **index の 77 本のうち今の実装で読めるのは 8 本しか無い**（#871 の実測。**2026-09-21 に独立に再現した**）。
 * **だが「読めない 69 本」の内訳を会期の並び順で見ると、`--sessions` を広げる上で邪魔なのは 5 本だけである**:
 *
 * | index の位置 | 会期 | 今の実装 | 何が止めているか |
 * |---:|---|---|---|
 * | 1〜3 | 第400・399・398回 | **読める** | — |
 * | **4〜7** | **第397・396・395・394回** | **例外** | **会派の見出し `無所属` が凡例に無い**（この PR で直す） |
 * | 8・9 | 第393・392回 | **読める** | — |
 * | **10** | **第391回** | **例外** | **セルが ASCII の `-`**（凡例は全角の `－`。この PR で直す） |
 * | 11 | 第390回 | **読める** | — |
 * | 12・13 | 第389・388回 | 読める | **ただし 2023-10 の一般選挙の向こう側**（下記） |
 * | 14 以降 | 第387回 以前（64 本） | **例外** | **1 本も読めない**（凡例の見出しが `＜会派名＞` でない 61 本ほか） |
 *
 * **`index.ts` は `parseVotePdf` の例外を握り潰さないので、1 本でも落ちればその ETL は途中で止まる。**
 * **だから直す前の宮城は `--sessions 3` までしか広げられなかった。**
 *
 * ## **止める位置は「読めるか」ではなく「名簿が当たるか」で決めた**（#569）
 *
 * **会期ごとに PDF に出る氏名の集合を 13 本ぶん数えた**（**凡例の検査より前に氏名は採れる**）:
 * **第390回 ← 第389回 のあいだだけ IN 18 / OUT 19 の不連続が出る**（**2023-10 の一般選挙**）。
 * **他の 11 回の移り変わりは 0〜2 人で、任期中の辞職・補選の規模である。**
 * **だから `--sessions 11`（第400 〜 第390回）が今の任期に収まる最大で、12 は選挙の向こう側になる。**
 *
 * **#928 の検査はこの境を捕まえない**——
 * **`rosterAsOf` から第390回の最古の採決（2023-12-12）まで 1,010 日で、上限 1,461 日の内側**。
 * **止める位置を決めたのは #928 ではなく、氏名の集合の不連続のほうである。**
 */
const bytes = (name: string) => readFileSync(new URL(`./fixtures/miyagi/${name}`, import.meta.url));

/**
 * ## 欠陥 1: **会派の見出し `無所属` が、その本の凡例に書かれていない**（第394〜397回の 4 本）
 *
 * **宮城の凡例の `＜会派名＞` 欄は「略称：正式名称」の辞書である**（`自民：自由民主党・県民会議`）。
 * **第394〜397回はこの辞書が 7 行しか無いのに、表には 8 本目の会派の帯 `無所属` がある**（実測）。
 *
 * **これは県の書き落としではなく、県自身の書き方の揺れである**——
 * **前の任期の第388・389回では、同じ凡例に `無所属：無所属` と `無所属の会：無所属の会` が
 * 書いてある**（**略称と正式名称が同じ会派には恒真な行を置く**。実測。この 2 本だけ）。
 * **つまり県は「略称＝正式名称」の会派を、書く本と書かない本の両方を出している。**
 *
 * **だから辞書に無い見出しは、見出しの原文をそのまま会派名にする**——
 * **原文に無い文字を足していない**（#569）。**県が書くときに書く文字と、1 バイトも違わない。**
 */
test("#901 第397回: 凡例に無い会派の見出し `無所属` は、見出しの原文をそのまま会派名にする（推定しない）", async () => {
  const pdf = await parseVotePdf(bytes("hyouketsu1002syuusei.pdf"));
  assert.equal(pdf.sessionId, "397");
  // **凡例は 7 行のまま**（**辞書に勝手な行を足していない**）
  assert.deepEqual(Object.keys(pdf.legend.groups), ["自民", "公明", "21世紀ク", "県民の声", "立無ク", "維新", "共産"]);
  // **表の帯は 8 本**。8 本目だけ groupText と group が同じ
  const bands: { text: string; group: string; n: number }[] = [];
  for (const m of pdf.members) {
    const last = bands.at(-1);
    if (last && last.text === m.groupText) last.n++;
    else bands.push({ text: m.groupText, group: m.group, n: 1 });
  }
  assert.deepEqual(bands, [
    { text: "自民", group: "自由民主党・県民会議", n: 31 },
    { text: "県民の声", group: "みやぎ県民の声", n: 10 },
    { text: "共産", group: "日本共産党宮城県会議員団", n: 5 },
    { text: "公明", group: "公明党県議団", n: 4 },
    { text: "立無ク", group: "立憲・無所属クラブ", n: 3 },
    { text: "21世紀ク", group: "21世紀クラブ", n: 2 },
    { text: "維新", group: "日本維新の会", n: 2 },
    { text: "無所属", group: "無所属", n: 1 },
  ]);
  assert.equal(pdf.members.at(-1)!.nameText, "中島 源陽");
});

/**
 * **`無所属：無所属` は、前の任期の本には実際に書いてある**——
 * **この PR の扱いが「県が書くときに書く文字」と同じであることの、一次資料側の根拠。**
 */
test("#901 第388・389回の凡例には `無所属：無所属` が実際に書いてある（恒真な行を県自身が置いている）", async () => {
  for (const f of ["hyouketsu050704.pdf", "hyouketsu051004.pdf"]) {
    const pdf = await parseVotePdf(bytes(f));
    assert.equal(pdf.legend.groups["無所属"], "無所属", f);
    assert.equal(pdf.legend.groups["無所属の会"], "無所属の会", f);
  }
});

/**
 * ## 欠陥 2: **賛否のセルが ASCII の `-`（U+002D）で、凡例は全角の `－`（U+FF0D）**（第391回、1 セル）
 *
 * **第391回のダッシュ様の字を全部数えた**（実測）:
 * **`－` U+FF0D が 5 個・`ー` U+30FC が 11 個（件名の長音）・`-` U+002D が 1 個。**
 * **U+002D と U+FF0D は同じ字の半角形と全角形**（NFKC は FF0D → 002D に畳む）で、
 * **`glyph-variants.ts` が既に持っている `〇`→`○`・`✕`→`×` と同じ種類の揺れである。**
 *
 * **意味の推定ではない**——**寄せた先が凡例に無ければ、これまでどおり例外になる。**
 */
test("#901 第391回: ASCII の `-` を全角の `－` に寄せて凡例を引く（凡例に無ければ例外のまま）", async () => {
  const pdf = await parseVotePdf(bytes("hyouketsu060313.pdf"));
  assert.equal(pdf.sessionId, "391");
  const dashRows = pdf.rows.filter((r) => r.cells.some((c) => c === "-"));
  assert.equal(dashRows.length, 1, "ASCII の `-` が出る行");
  const r = dashRows[0];
  assert.equal(r.kind, "知事提出議案");
  assert.equal(r.number, "1");
  assert.equal(r.title, "令和６年度宮城県一般会計予算");
  // **raw は原文のまま**（`-` を `－` に書き換えない。#674 と同じ方針）
  assert.equal(r.cells.filter((c) => c === "-").length, 1);
  assert.equal(r.cells.filter((c) => c === "－").length, 0);
  // **公表数と合う**: 出席 59 / 表決 57 / 賛成 41 / 反対 16。**`議` 1 と `-` 1 が表決に加わらない 2 人**
  assert.deepEqual(r.counts, { present: 59, voting: 57, yes: 41, no: 16 });
  assert.equal(r.cells.filter((c) => c === "○").length, 41);
  assert.equal(r.cells.filter((c) => c === "×").length, 16);
  assert.equal(r.cells.filter((c) => c === "議").length, 1);
  assert.equal(r.cells.length, 59);
  // **本文のセルに全角の `－` は 1 つも無い**——**この本はダッシュを 1 個しか使っておらず、それが ASCII だった。**
  // **5 個の `－` は 5 ページに繰り返される凡例の行（`－：議場に不在`）で、本文のセルではない**（実測）。
  assert.equal(pdf.rows.reduce((n, x) => n + x.cells.filter((c) => c === "－").length, 0), 0);
  // **本の全セルの内訳**（母数つき。#757）。**畳んだせいで他の記号が増減していないこと**
  const tally = new Map<string, number>();
  for (const x of pdf.rows) for (const c of x.cells) tally.set(c, (tally.get(c) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries([...tally].sort((a, b) => b[1] - a[1])), { "○": 5754, "×": 103, "議": 101, "-": 1 });
  assert.equal(pdf.rows.length * pdf.members.length, 5_959, "母数（101 行 × 59 人）");
});

/**
 * ## **直した 5 本を足すと、`--sessions 11` まで途切れずに読める**
 *
 * **母数を出す**（#757）。**「増えた」だけでなく「何本を見て何本読めたか」を書く。**
 */
test("#901 `--sessions 11` の範囲の 11 本がすべて読める（直す前は 3 本目までで止まっていた）", async () => {
  // **index の並び順（新しい順）に 11 本**。**第389・388回（12・13 本目）は一般選挙の向こう側なので入れない**
  const FILES = [
    ["400", "hyoketu080707.pdf", 23, 56],
    ["399", "syuusei_hyouketsu080318.pdf", 110, 56],
    ["398", "hyouketsu071217.pdf", 50, 58],
    ["397", "hyouketsu1002syuusei.pdf", 29, 58],
    ["396", "hyouketsu070630.pdf", 31, 58],
    ["395", "hyouketsu070314.pdf", 89, 58],
    ["394", "hyouketsu061211.pdf", 43, 58],
    ["393", "hyouketsu061017.pdf", 31, 59],
    ["392", "hyouketsu060701.pdf", 31, 59],
    ["391", "hyouketsu060313.pdf", 101, 59],
    ["390", "hyouketsu051219.pdf", 46, 59],
  ] as const;
  let rows = 0, cells = 0, unknown = 0;
  const dates: string[] = [];
  for (const [id, file, nRows, nMembers] of FILES) {
    const pdf = await parseVotePdf(bytes(file));
    assert.equal(pdf.sessionId, id, file);
    assert.equal(pdf.rows.length, nRows, `${file} rows`);
    assert.equal(pdf.members.length, nMembers, `${file} members`);
    rows += pdf.rows.length;
    cells += pdf.rows.length * pdf.members.length;
    unknown += pdf.unknownCells;
    for (const r of pdf.rows) dates.push(toIsoDate(r.dateText, pdf.sessionYear, pdf.sessionMonth));
  }
  assert.equal(FILES.length, 11, "母数（読んだ本）");
  assert.equal(rows, 584, `行 ${rows}`);
  assert.equal(cells, 33_815, `セル ${cells}`);
  // **29 セルは第393回の 石川光次郎 の列**（PDF がその列を空欄にしている。#871）。**増えていない**
  assert.equal(unknown, 29, `不明セル ${unknown}`);
  dates.sort();
  assert.equal(dates[0], "2023-12-12", "最古の議決日");
  assert.equal(dates.at(-1), "2026-07-07", "最新の議決日");
});
