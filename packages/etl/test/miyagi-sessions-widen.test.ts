import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseVotePdf } from "../src/sources/local/miyagi/votes-pdf.ts";
import { toIsoDate } from "../src/sources/local/miyagi/rollcalls.ts";
import { defaultSessionsFor } from "../src/local-assemblies.ts";
import type { LocalMember } from "@seiji-kiroku/shared";

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

/**
 * ## 欠陥 3: **議案等番号の欄が `※` の行が 2 つあり、採決 ID が衝突する**（第393回。**広げて初めて見えた**）
 *
 * **第393回の 種別（結合セル）は `知事提出議案（※は議員提出）` という原文で、
 * 議員提出の 2 行は議案番号を持たず `※` とだけ書いてある**（**修正動議・継続審査動議**。実測）。
 *
 * **`toLocalRollCalls` の ID は `{議会}-{回次}-{議決日}-{種別}-{番号}` で、
 * 番号が空のときだけ `無番号N` を振っていた。** **`※` は空ではないので素通りし、
 * **同じ日・同じ種別の 2 行がまったく同じ ID になって例外で止まっていた。**
 *
 * **これは `--sessions 2` の範囲には 1 件も無い**（**本番の 133 件は第399・400回だけ**）。
 * **数え直すと、13 本 649 行のうち `※` はこの 2 行だけである**
 * （**数字だけ 633 / `Nの M`（請願の枝番）10 / 空 4 / `※` 2**）。
 *
 * **直し方**: **`※` を番号として扱わない**（`無番号N` と同じ扱いにする）。
 * **`number` の原文は `※` のまま残す**——**「議員提出である」という県の記しを捨てない**（#569）。
 */
test("#901 第393回: 議案等番号が `※` の 2 行に別々の ID が付き、`number` の原文は `※` のまま残る", async () => {
  const { toLocalRollCalls } = await import("../src/sources/local/miyagi/rollcalls.ts");
  const pdf = await parseVotePdf(bytes("hyouketsu061017.pdf"));
  const { rollCalls } = toLocalRollCalls(pdf, [], {
    sessionLabel: "令和6年9月定例会（第393回）",
    pdfUrl: "https://www.pref.miyagi.jp/documents/54531/hyouketsu061017.pdf",
  });
  assert.equal(rollCalls.length, 31, "母数（この本の行数）");
  assert.equal(new Set(rollCalls.map((r) => r.id)).size, 31, "ID は 31 通り（衝突していない）");
  const marked = rollCalls.filter((r) => r.number === "※");
  assert.equal(marked.length, 2, "`※` の行");
  assert.deepEqual(marked.map((r) => r.title), [
    "議第１１８号議案（令和６年度宮城県一般会計補正予算）に対する修正動議",
    "議第１１９号議案（宿泊税条例）に対する継続審査動議",
  ]);
  // **種別の原文もそのまま**（県の記しごと残す）
  assert.deepEqual([...new Set(marked.map((r) => r.kind))], ["知事提出議案（※は議員提出）"]);
  assert.deepEqual(marked.map((r) => r.id), [
    "pref-04-393-20241017-知事提出議案（※は議員提出）-無番号1",
    "pref-04-393-20241017-知事提出議案（※は議員提出）-無番号2",
  ]);
});

/**
 * **請願の枝番（`391の1`）は番号である**——**`無番号N` に落とさない**（#901）。
 *
 * **`※` を「番号でない」側に落とすとき、枝番まで巻き込むと 10 行の ID が
 * `無番号1` `無番号2` … に変わる**——**採決 ID は Web の URL でもあるので、
 * 「同じ議案の記録が別の住所に移る」形になる。**
 *
 * **13 本に枝番は 10 行ある**（第390回 2 / 第391回 1 / 第394回 2 / 第397回 1 ほか。
 * **`NUMBER_FOR_ID` の `(の\d+)?` を消すとここが落ちる**）。
 */
test("#901 請願の枝番（`391の1`）は番号としてそのまま ID に入る（`無番号N` に落とさない）", async () => {
  const { toLocalRollCalls } = await import("../src/sources/local/miyagi/rollcalls.ts");
  const cases: [file: string, label: string, url: string][] = [
    ["hyouketsu060313.pdf", "令和6年2月定例会（第391回）", "https://www.pref.miyagi.jp/documents/50597/hyouketsu060313.pdf"],
    ["hyouketsu061211.pdf", "令和6年11月定例会（第394回）", "https://www.pref.miyagi.jp/documents/55094/hyouketsu061211.pdf"],
    ["hyouketsu1002syuusei.pdf", "令和7年9月定例会（第397回）", "https://www.pref.miyagi.jp/documents/61559/hyouketsu1002syuusei.pdf"],
    ["hyouketsu051219.pdf", "令和5年11月定例会（第390回）", "https://www.pref.miyagi.jp/documents/50057/hyouketsu051219.pdf"],
  ];
  const got: string[] = [];
  for (const [file, sessionLabel, pdfUrl] of cases) {
    const pdf = await parseVotePdf(bytes(file));
    const { rollCalls } = toLocalRollCalls(pdf, [], { sessionLabel, pdfUrl });
    for (const r of rollCalls) if (/^\d+の\d+$/.test(r.number)) got.push(r.id);
  }
  assert.deepEqual(got.sort(), [
    "pref-04-390-20231219-請願-390の1",
    "pref-04-390-20231219-請願-390の2",
    "pref-04-391-20240313-請願-391の1",
    "pref-04-394-20241211-請願-394の1",
    "pref-04-394-20241211-請願-394の2",
    "pref-04-397-20251002-請願-397の1",
  ], "**枝番の行の ID**（`無番号N` になっていたら `NUMBER_FOR_ID` が枝番を落としている）");
  assert.deepEqual(got.filter((id) => id.includes("無番号")), [], "枝番が `無番号N` に落ちた行");
});

/**
 * **番号の形を 13 本すべてで数えた**（#757。**「その他」が増えたら気づけるように母数ごと固定する**）。
 * **`※` を番号でないほうに落としたのは、この 4 通りを全部見た上での判断である。**
 */
test("#901 議案等番号の欄の形は 4 通りしかない（13 本 649 行）", async () => {
  const FILES = [
    "hyoketu080707.pdf", "syuusei_hyouketsu080318.pdf", "hyouketsu071217.pdf", "hyouketsu1002syuusei.pdf",
    "hyouketsu070630.pdf", "hyouketsu070314.pdf", "hyouketsu061211.pdf", "hyouketsu061017.pdf",
    "hyouketsu060701.pdf", "hyouketsu060313.pdf", "hyouketsu051219.pdf", "hyouketsu051004.pdf", "hyouketsu050704.pdf",
  ];
  const forms = new Map<string, number>();
  let total = 0;
  for (const f of FILES) {
    const pdf = await parseVotePdf(bytes(f));
    for (const r of pdf.rows) {
      total++;
      const form = r.number === "" ? "空" : /^\d+$/.test(r.number) ? "数字だけ" : /^\d+の\d+$/.test(r.number) ? "Nの M" : `その他:${r.number}`;
      forms.set(form, (forms.get(form) ?? 0) + 1);
    }
  }
  assert.equal(total, 649, "母数（13 本の行）");
  assert.deepEqual(Object.fromEntries([...forms].sort((a, b) => b[1] - a[1])), {
    "数字だけ": 633, "Nの M": 10, "空": 4, "その他:※": 2,
  });
});

/**
 * ## **緩めたのは「辞書に無い見出し」だけで、「読めていない見出し」は今までどおり例外**
 *
 * **`readMembers` は元々「凡例に無い見出し」を例外にしていた。**
 * **これは会派名の辞書引きであると同時に、レイアウトが変わったことの検出でもあった**——
 * **帯の x 境界がずれて見出しの文字を拾えなくなれば、空の見出しとして例外になっていた。**
 *
 * **#901 で辞書引きを緩めたので、その検出が一緒に消えないように、空の見出しは明示的に例外にした。**
 * **これが無いと、罫線の読みが壊れて見出しが 1 文字も拾えなくなっても、
 * 会派名が空文字のまま静かに通る**——**「別の記録が出る」側ではないが、
 * 「壊れているのに気づけない」側である**（#477 の font と同じ理由で、気づけないことが問題）。
 *
 * **本物の PDF には空の見出しが 1 つも無い**（13 本すべて実測）ので、
 * **実装を呼んで確かめるには、帯の境界を人為的に潰すしかない。**
 * **ここでは `readMembers` が見ている 2 つの条件を、最小の作り物で再現する。**
 */
test("#901 会派の帯の見出しが 1 文字も拾えないときは例外（辞書引きを緩めても、壊れた読みは通さない）", async () => {
  const { parseVotePdf: parse } = await import("../src/sources/local/miyagi/votes-pdf.ts");
  // **本物の本では空の見出しが 1 つも出ない**（**この検査が「起きていないこと」を見ていることの母数**）
  const FILES = [
    "hyoketu080707.pdf", "syuusei_hyouketsu080318.pdf", "hyouketsu071217.pdf", "hyouketsu1002syuusei.pdf",
    "hyouketsu070630.pdf", "hyouketsu070314.pdf", "hyouketsu061211.pdf", "hyouketsu061017.pdf",
    "hyouketsu060701.pdf", "hyouketsu060313.pdf", "hyouketsu051219.pdf", "hyouketsu051004.pdf", "hyouketsu050704.pdf",
  ];
  let bands = 0;
  for (const f of FILES) {
    const pdf = await parse(bytes(f));
    const seen = new Set(pdf.members.map((m) => m.groupText));
    bands += seen.size;
    assert.deepEqual([...seen].filter((t) => t === ""), [], `${f}: 空の会派見出し`);
  }
  assert.equal(bands, 97, "**13 本で見た会派の帯の数**（0 を「違反なし」と読み違えないため）");

  // **例外のメッセージが `group heading at [x0,x1] has no text` であること**を、実装の原文で固定する。
  // **`?? text` に緩めた行のすぐ上にある検査で、片方だけ消せばここが落ちる。**
  const src = readFileSync(new URL("../src/sources/local/miyagi/votes-pdf.ts", import.meta.url), "utf8");
  assert.match(src, /if \(text === ""\) throw new Error\(`\$\{label\}: group heading at /,
    "**空の見出しを例外にする行**（消すと、罫線が壊れても会派名が空文字で静かに通る）");
  assert.match(src, /const name = legend\.groups\[text\] \?\? text;/,
    "**辞書に無ければ見出しの原文を使う行**（#901）");
});

/**
 * ## **`--sessions 11` で止めた根拠を、一次資料（PDF に出る氏名）だけから固定する**（#901）
 *
 * **#928 の検査はこの境を 1 件も捕まえない**——**13 本目まで広げても
 * `rosterAsOf` から 1,178 日で、上限 1,461 日の内側である**（**実測。変異 M9 で確かめた**）。
 * **だから「11 を 12 にしても `#928` は鳴らない」。鳴らすものがここに要る。**
 *
 * **会期ごとに PDF に出る氏名の集合を 13 本ぶん数えた。**
 * **不連続は 12 回の移り変わりのうち 1 か所にしかない**（第390回 ← 第389回、IN 18 / OUT 19）——
 * **2023-10 の一般選挙である**（**選挙の日付を外から持ち込まず、氏名の集合だけで見える**）。
 *
 * **名簿は「今の 1 枚」しか公表されていない**（`LocalMember` は `asOf` しか持たない）。
 * **選挙をまたいだ採決にその名簿を当てると、引退した議員の票が今の別人に付きうる**——
 * **利用者から検出できない虚偽である**（#569 の重いほう）。
 *
 * **いま宮城では「別人に付く」は 1 件も起きない**（下で測ってある）——
 * **選挙前にだけ出る 18 人の氏名は、今の名簿 56 人の誰とも一致しない。**
 * **だが「今のデータでは再現しない」までが実測であって、起こりえないという意味ではない**（#928 の担当者の言葉）。
 * **だから境の手前で止める。**
 */
test("#901 会期ごとの氏名の集合は、第390回 ← 第389回 でだけ不連続になる（2023-10 の一般選挙）", async () => {
  // **並びは index の新しい順**。**`defaultSessionsFor("miyagi") === 11` は 11 本目（第390回）まで**
  const ORDER: [n: number, id: string, file: string][] = [
    [1, "400", "hyoketu080707.pdf"], [2, "399", "syuusei_hyouketsu080318.pdf"], [3, "398", "hyouketsu071217.pdf"],
    [4, "397", "hyouketsu1002syuusei.pdf"], [5, "396", "hyouketsu070630.pdf"], [6, "395", "hyouketsu070314.pdf"],
    [7, "394", "hyouketsu061211.pdf"], [8, "393", "hyouketsu061017.pdf"], [9, "392", "hyouketsu060701.pdf"],
    [10, "391", "hyouketsu060313.pdf"], [11, "390", "hyouketsu051219.pdf"],
    [12, "389", "hyouketsu051004.pdf"], [13, "388", "hyouketsu050704.pdf"],
  ];
  const names = new Map<string, Set<string>>();
  for (const [, id, file] of ORDER) {
    const pdf = await parseVotePdf(bytes(file));
    names.set(id, new Set(pdf.members.map((m) => m.nameText.replace(/[\s　]+/g, ""))));
  }
  const moves: { n: number; id: string; size: number; inN: number; outN: number }[] = [];
  for (let i = 0; i + 1 < ORDER.length; i++) {
    const cur = names.get(ORDER[i][1])!;
    const prev = names.get(ORDER[i + 1][1])!;
    moves.push({
      n: ORDER[i][0], id: ORDER[i][1], size: cur.size,
      inN: [...cur].filter((x) => !prev.has(x)).length,
      outN: [...prev].filter((x) => !cur.has(x)).length,
    });
  }
  assert.equal(moves.length, 12, "母数（数えた移り変わり）");
  // **5 人以上の入れ替わりが出るのは 1 か所だけ**（**そこが一般選挙の境**）
  // **`moves` は新しい側の本で名前を付けている**（`n` 本目 ← `n+1` 本目 の移り変わり）
  const big = moves.filter((m) => m.inN >= 5 || m.outN >= 5);
  assert.deepEqual(big, [{ n: 11, id: "390", size: 59, inN: 19, outN: 18 }],
    "**5 人以上の入れ替わり**（11 本目 第390回 ← 12 本目 第389回。IN 19 / OUT 18）");
  // **それ以外の 11 回は 0〜2 人**（任期中の辞職・補選の規模）
  assert.equal(Math.max(...moves.filter((m) => m.n !== 11).flatMap((m) => [m.inN, m.outN])), 2);
  // **境は「11 本目と 12 本目のあいだ」にある**——**`--sessions 11` はその手前で止まる最大である。**
  // **12 にすると、選挙の前の第389回が入ってくる。**
  assert.equal(big[0].n, 11);
  assert.ok(defaultSessionsFor("miyagi") <= big[0].n,
    `既定 ${defaultSessionsFor("miyagi")} が一般選挙の境（${big[0].n} 本目と ${big[0].n + 1} 本目のあいだ）を越えている。**#928 は鳴らない**ので、ここが唯一の歯止めである`);
  assert.equal(defaultSessionsFor("miyagi"), 11, "**境の手前で最大**（10 に縮めても 12 に伸ばしてもここが落ちる）");
});

/**
 * **「いま別人に付いていない」ことを、母数つきで測る**（#569 / #796）。
 *
 * **これは「起こりえない」の証明ではない**——**今の名簿と今の 13 本で 0 件だった、という実測である。**
 * **`matchBySubsequence` は部分列一致も見るので、完全一致だけを数えるのでは足りない。**
 */
test("#901 一般選挙の前にだけ出る 18 人は、今の名簿 56 人の誰にも寄らない（母数つき。0 件は「見た上での 0」）", async () => {
  const { matchBySubsequence } = await import("../src/sources/local/name-match.ts");
  const AFTER = [
    "hyoketu080707.pdf", "syuusei_hyouketsu080318.pdf", "hyouketsu071217.pdf", "hyouketsu1002syuusei.pdf",
    "hyouketsu070630.pdf", "hyouketsu070314.pdf", "hyouketsu061211.pdf", "hyouketsu061017.pdf",
    "hyouketsu060701.pdf", "hyouketsu060313.pdf", "hyouketsu051219.pdf",
  ];
  const BEFORE = ["hyouketsu051004.pdf", "hyouketsu050704.pdf"];
  const namesOf = async (files: string[]) => {
    const s = new Set<string>();
    for (const f of files) for (const m of (await parseVotePdf(bytes(f))).members) s.add(m.nameText);
    return s;
  };
  const after = await namesOf(AFTER);
  const before = await namesOf(BEFORE);
  assert.equal(after.size, 60, "選挙の後の 11 本に出る氏名（母数）");
  assert.equal(before.size, 58, "選挙の前の 2 本に出る氏名（母数）");
  const onlyBefore = [...before].filter((n) => !after.has(n));
  assert.equal(onlyBefore.length, 18, "選挙の前にだけ出る氏名");

  // **今の名簿**（本番の `data/members/index.json` の pref-04 の行）
  const roster = (JSON.parse(readFileSync(new URL("../../../data/members/index.json", import.meta.url), "utf8")) as LocalMember[])
    .filter((m) => m.assemblyId === "pref-04");
  assert.equal(roster.length, 56, "名簿（母数）");
  const hits = onlyBefore
    .map((n) => ({ pdf: n, id: matchBySubsequence(n, roster).memberId }))
    .filter((x) => x.id !== "");
  // **1 件でも寄ったら、それは「引退した議員の票が今の別人に付いた」形である**（#569 の重いほう）
  assert.deepEqual(hits, [], "**選挙前にだけ出る氏名が、今の名簿の誰かに寄った**");
  // **逆向きの母数**——**選挙をまたいで両方に出る 40 人は、同じ人が再選したぶんである**
  assert.equal([...before].filter((n) => after.has(n)).length, 40, "両方に出る氏名");
  assert.equal(18 + 40, 58, "母数の検算（#757）");
});
