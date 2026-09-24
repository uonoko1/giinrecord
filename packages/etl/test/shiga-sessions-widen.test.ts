import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseVotePdf } from "../src/sources/local/shiga/votes-pdf.ts";
import { defaultSessionsFor, LOCAL_TERM_DAYS } from "../src/local-assemblies.ts";

/**
 * # 滋賀の `--sessions` を 2 → 19 に広げる（Issue #901）
 *
 * ## 何が問題だったか
 *
 * **本番に出ていたのは 14 採決・604 セルで、これは一次資料のごく一部だった**
 * （`data/assemblies/pref-25/rollcalls/index.json` が 14 行。実測）。
 * **理由は `defaultSessionsFor("shiga")` が `DEFAULT_LOCAL_SESSIONS`＝2 を返していたことだけ**で、
 * **読めない本が黙って飛ばされていたのではなく、取りに行っていなかった。**
 *
 * ## **滋賀で効いている上限は「読めるか」ではない**（2026-09-21、index の賛否 PDF を全部取得して実測）
 *
 * **年の一覧 → 年ページ（年度版と暦年版の両方）→ 会期ページ、と辿って
 * 80 会期・146 本の賛否 PDF に到達し、その 146 本すべてを `parseVotePdf` に通した**:
 *
 * | | 本数 |
 * |---|---:|
 * | index から到達できた賛否 PDF | **146** |
 * | **読めた** | **144** |
 * | 読めなかった | **2** |
 *
 * **読めなかった 2 本は、どちらも 2013〜2014 年でこの窓のはるか外である**:
 *   - `Kg337_sanpi-261127`（2014-11）: `PDF has no text layer`（**showText 0 回**。#947 が測った本）
 *   - `Kg265_250424`（2013-04）: `no member columns found`（**`/Rotate 90` の縦置きページ**。#922）
 *
 * **つまり 20 会期目も例外では止まらない。** **止める位置は名簿が決めている。**
 *
 * ## **止める位置は「名簿が当たるか」で決めた**（#569。**選挙の日付を外から持ち込まない**）
 *
 * **会期ごとに「PDF に出る氏名の集合」を 80 会期ぶん数えると、
 * 2023-02 ← 2023-05招集会議 のあいだに IN 12 / OUT 11 の不連続が 1 回だけ出る**
 * （**2023年4月の一般選挙**）。**他の 18 回の移り変わりは 0〜4 人で、任期中の辞職・補選の規模である。**
 *
 * **だから `--sessions 19`（令和8年7月 〜 令和5年5月招集会議）が今の任期に収まる最大で、
 * 20 は選挙の向こう側になる。**
 *
 * ## **#928 の検査はこの境を捕まえない**（**余地があることは安全ではない**）
 *
 * **`rosterAsOf` 2026-09-21 から 19 会期目の最古の採決 2023-05-09 まで 1,231 日**（**上限 1,461 日の 84%**）。
 * **20 会期目（2023-02-14）まで広げても 1,315 日で、まだ上限の内側（90%）である。**
 * **止める位置を決めたのは #928 ではなく、氏名の集合に出た不連続のほうである。**
 *
 * ## 広げて増えたもの（実測。`--sessions` を 2 から 19 まで 1 つずつ走らせた）
 *
 * | | `--sessions 2`（本番に出ていた値） | **`--sessions 19`** |
 * |---|---:|---:|
 * | 採決 | 14 | **163** |
 * | セル | 604 | **6,886** |
 * | **不明セル** | **0** | **0**（**窓の 19 会期は 1 本残らず読めるので増えない**） |
 * | **寄らなかった氏名**（安全側） | 3 | **10** |
 * | 読めなかった PDF | 0 | **0** |
 *
 * **寄らなかった 10 通りは 8 人ぶんで、8 人とも `candidates` が空＝名簿に同姓同名すらいない**
 * （**別人に付く余地が無い**）。**票は `memberId` 空のまま残す**（#529）。
 */

/* ------------------------------------------------------------------ *
 * 既定の値
 * ------------------------------------------------------------------ */

test("#901 滋賀の `--sessions` の既定は 19（2023年4月の一般選挙の手前まで）", () => {
  assert.equal(defaultSessionsFor("shiga"), 19);
});

/**
 * **#928 は滋賀の境を捕まえない**——**これを数で固定しておく。**
 * **「#928 が守ってくれる」と思って既定を広げると、選挙をまたいだ採決に今の名簿が当たる**（#569 の重いほう）。
 */
test("#901 **#928 は滋賀の境を捕まえない**——19 でも 20 でも上限 1,461 日の内側（止めているのは氏名の集合）", () => {
  // **`rosterAsOf` は本番に出したものを読む**——**固定の日付を書くと、
  //   名簿を取り直すたびに「測ったときの話」と「出したものの話」がずれる**（#963 の形）。
  //   **主張は「出した名簿から見て 20 会期目も窓の内側」であって、ある日の日数ではない。**
  const asOf = Date.parse(publishedRosterAsOf());
  const days = (d: string) => Math.round((asOf - Date.parse(d)) / 86_400_000);
  // **母数**（#757）——名簿の日付が読めていること（読めないまま 0 日で緑にしない）
  assert.match(publishedRosterAsOf(), /^\d{4}-\d{2}-\d{2}$/);
  // 19 会期目の最古の採決（令和5年5月招集会議）／20 会期目（令和5年2月定例会議）
  const inside = days("2023-05-09");
  const outside = days("2023-02-14");
  // **20 会期目のほうが 84 日ぶん古い**（会期の並びが崩れれば落ちる）
  assert.equal(outside - inside, 84);
  assert.ok(inside < LOCAL_TERM_DAYS, `19 会期目は #928 の内側（${inside} 日）`);
  // **選挙の向こう側なのに、まだ内側＝#928 は鳴らない**（これがこのテストの主張）
  assert.ok(outside < LOCAL_TERM_DAYS, `**20 会期目も #928 の内側＝#928 は鳴らない**（${outside} 日）`);
  // **余裕がどれだけあるか**も残す（#961。「鳴らない」だけでなく「かなり手前」だという事実）
  assert.ok(outside < LOCAL_TERM_DAYS * 0.95, `20 会期目の余裕（${LOCAL_TERM_DAYS - outside} 日）`);
});

/* ------------------------------------------------------------------ *
 * 一般選挙の境（氏名の集合の不連続）——**この PR の歯止め**
 * ------------------------------------------------------------------ */

const bytes = (name: string): Buffer => readFileSync(new URL(`./fixtures/shiga/${name}`, import.meta.url));
/** **本番に出した `meta.json` の `rosterAsOf`**（固定の日付を書かない。上の docblock） */
const publishedRosterAsOf = (): string =>
  (JSON.parse(readFileSync(new URL("../../../data/assemblies/pref-25/meta.json", import.meta.url), "utf-8")) as { rosterAsOf: string }).rosterAsOf;
/** 氏名の突き合わせ用に空白と異体字セレクタを落とす（`matchName` と同じ考え方） */
const flat = (s: string): string => s.normalize("NFC").replace(/[\s　\u{E0100}-\u{E01EF}\u{FE00}-\u{FE0F}]/gu, "");

/**
 * **境の両側の 2 本を、一次資料そのもので固定する。**
 *
 * - `Kg749_050509sannpi.pdf` ＝ **19 会期目**（令和5年5月招集会議。**窓の中で最も古い**）
 * - `Kg744_sanpi-0315.pdf` ＝ **20 会期目**（令和5年2月定例会議。**窓の外で最も新しい**）
 *
 * **この 2 本のあいだで議員が 12 人入れ替わり 11 人去る。**
 * **これが「20 会期目を入れてはいけない」ことの一次資料による証拠である**
 * （**選挙の日付を県のサイトの別ページから持ち込んでいない**）。
 */
test("#901 **一般選挙の境**: 19 会期目と 20 会期目のあいだで IN 12 / OUT 11（他の移り変わりは 0〜4 人）", async () => {
  const inside = await parseVotePdf(bytes("Kg749_050509sannpi.pdf"));
  const outside = await parseVotePdf(bytes("Kg744_sanpi-0315.pdf"));
  // **母数**（#757）——「0 件」と「数えていない」を区別できる形にする
  assert.equal(inside.members.length, 44, "19 会期目の議員の列");
  assert.equal(outside.members.length, 43, "20 会期目の議員の列");

  const a = new Set(inside.members.map((m) => flat(m.nameText)).filter((n) => n !== ""));
  const b = new Set(outside.members.map((m) => flat(m.nameText)).filter((n) => n !== ""));
  assert.equal(a.size, 44, "19 会期目の氏名（重複なし）");
  assert.equal(b.size, 43, "20 会期目の氏名（重複なし）");

  const inn = [...a].filter((n) => !b.has(n)).sort();
  const out = [...b].filter((n) => !a.has(n)).sort();
  // **12 人が入り 11 人が去る**——この規模の入れ替わりは 80 会期でここ 1 回だけである
  assert.equal(inn.length, 12, `IN が 12 人でない: ${JSON.stringify(inn)}`);
  assert.equal(out.length, 11, `OUT が 11 人でない: ${JSON.stringify(out)}`);
  // **氏名まで固定する**（数だけだと、別の本に差し替わっても通ってしまう）
  assert.deepEqual(inn, [
    "中山和行", "小河文人", "岩崎和也", "柴田栄一", "森重重則", "河村浩史",
    "田中英樹", "田中誠", "谷口典隆", "谷成隆", "赤井康彦", "野田武宏",
  ]);
  assert.deepEqual(out, [
    "中村才次郎", "塚本茂樹", "大橋通伸", "富田博明", "山本正", "成田政隆",
    "杉本敏隆", "松本利寬", "江畑弥八郎", "細江正人", "黄野瀬明子",
  ]);
  // **共通は 32 人**（44 - 12 = 32、43 - 11 = 32。両側から数えて合う）
  assert.equal([...a].filter((n) => b.has(n)).length, 32);
});

/* ------------------------------------------------------------------ *
 * 広げて出た欠陥: **会派帯の上の注記が会派名に流れ込む**
 * ------------------------------------------------------------------ */

/**
 * ## **`--sessions 2` の窓には 1 件も無い形**（#901 で広げて初めて出た）
 *
 * **`readGroups` は会派帯の上端に `grid.top`（＝表の外枠）を使っていた。**
 * **外枠と会派帯のあいだに見出し・注記の段がある本では、その段の文字が会派名の頭に流れ込む。**
 *
 * **実測（146 本すべて）: 25 本・825 列。** 2 通りある:
 *   - `（議案についてはこのホームページの議案詳細情報をご覧ください。）自由民主党滋賀県議会議員団`
 *   - `「○」は賛成を、…表す。チームしが県議団`
 *
 * **`group` は票の 1 件ずつに書かれ、`unmatched.json` の鍵にもなる**ので、
 * **同じ議員の同じ会派が「別の会派」として 2 行に割れていた**
 * （**実測: `--sessions 19` の `unmatched` が 12 行 → 直して 10 行**。
 *  `重田 剛` と `白井 幸則` が会派違いで 2 行ずつ出ていた）。
 *
 * **9 会期目の `Kg835_0425sanpi2.pdf` が、この窓の中で最初に当たる本である。**
 */
test("#901 会派帯の上の注記を会派名に混ぜない（Kg835。42 列のうち 20 列が壊れていた）", async () => {
  const pdf = await parseVotePdf(bytes("Kg835_0425sanpi2.pdf"));
  assert.equal(pdf.members.length, 42);
  const groups = new Map<string, number>();
  for (const m of pdf.members) groups.set(m.group, (groups.get(m.group) ?? 0) + 1);
  // **母数**（#757）: 42 列を 1 つ残らず数えている
  assert.equal([...groups.values()].reduce((a, b) => a + b, 0), 42);
  // **この本の注記の原文**——**会派名のどれにも入っていないこと**
  for (const [g] of groups) {
    assert.ok(!g.includes("ご覧ください"), `会派名に注記が混ざっている: [${g}]`);
    assert.ok(!g.includes("表す。"), `会派名に凡例が混ざっている: [${g}]`);
  }
  assert.deepEqual(Object.fromEntries([...groups].sort()), {
    "さざなみ倶楽部": 3, "チームしが県議団": 10, "公明党滋賀県議団": 2, "日本共産党滋賀県議会議員団": 2,
    "滋賀維新の会": 3, "無所属": 2, "自由民主党滋賀県議会議員団": 20,
  });
});

/**
 * **凡例が同じ段にある型**も直っていること（注記とは別の 1 本で確かめる）。
 * **`Kg744` は 20 会期目の本だが、`readGroups` の検査には使ってよい**——
 * **窓に入れるかどうかと、読み方が正しいかどうかは別の話である。**
 */
test("#901 会派帯の上の凡例も会派名に混ぜない（Kg744。43 列のうち 33 列が壊れていた）", async () => {
  const pdf = await parseVotePdf(bytes("Kg744_sanpi-0315.pdf"));
  assert.equal(pdf.members.length, 43);
  const groups = new Map<string, number>();
  for (const m of pdf.members) groups.set(m.group, (groups.get(m.group) ?? 0) + 1);
  assert.equal([...groups.values()].reduce((a, b) => a + b, 0), 43);
  for (const [g] of groups) {
    assert.ok(!g.includes("ご覧ください") && !g.includes("表す。"), `会派名に注記・凡例が混ざっている: [${g}]`);
    assert.notEqual(g, "", "会派名が空の列がある");
  }
});

/**
 * **直したことで、壊れていなかった本まで変えていないこと。**
 *
 * **`--sessions 2` の窓に入る本（`Kg907`）は、直す前も後も同じ会派の内訳である**——
 * **本番に今出ている 14 採決の `group` は 1 文字も変わらない。**
 * （**146 本ぜんぶで測ると 121 本が完全に同一で、変わったのは壊れていた 25 本だけ**。実測）
 */
test("#901 壊れていない本の会派は変えない（Kg907。本番に出ている会期）", async () => {
  const pdf = await parseVotePdf(bytes("Kg907_sanpi-080810-1.pdf"));
  const groups = new Map<string, number>();
  for (const m of pdf.members) groups.set(m.group, (groups.get(m.group) ?? 0) + 1);
  assert.equal([...groups.values()].reduce((a, b) => a + b, 0), 44);
  assert.deepEqual(Object.fromEntries([...groups].sort()), {
    "さざなみ倶楽部": 3, "チームしが県議団": 9, "公明党滋賀県議団": 2, "日本共産党滋賀県議会議員団": 2,
    "滋賀維新の会": 3, "無所属": 4, "自由民主党滋賀県議会議員団": 21,
  });
});

/* ------------------------------------------------------------------ *
 * 化けた氏名は戻さない（広げても増えない安全側）
 * ------------------------------------------------------------------ */

/**
 * **`辻` が `□`（U+25A1）に化ける本がある**（#680 / #674）。**戻さない。**
 * **窓を広げても、この方針は変わらない**——**`□ 正 隆` は `memberId` 空のまま残る**
 * （実測: `--sessions 19` で 15 票。**同じ会期の別の本では `辻󠄀 正 隆` が正しく `p_25_197` に寄る**ので、
 *  **「この議員の記録が全部消える」のではなく「化けた本の票だけが寄らない」**）。
 *
 * **戻すと別人の記録を作る側に倒れる**（#569）——**`□` が `辻` だという根拠が PDF の中に無い。**
 */
test("#901 化けた氏名を戻さない（`□` を `辻` にしない。窓を広げても同じ）", async () => {
  const pdf = await parseVotePdf(bytes("Kg907_sanpi-080810-1.pdf"));
  const names = pdf.members.map((m) => m.nameText);
  // **母数**（#757）——44 列を 1 つ残らず見ている
  assert.equal(names.length, 44);
  // **`□` のまま残っている列がちょうど 1 つ**（**黙って消してもいない**）
  assert.equal(names.filter((n) => n.includes("□")).length, 1);
  // **`辻` に戻していない**——**この本の氏名に `辻` は 1 文字も無い**
  assert.equal(names.filter((n) => n.includes("辻")).length, 0);
  // **化けているのは姓の 1 文字だけで、残りは読めている**（原文をそのまま残す）
  assert.equal(names.filter((n) => n.startsWith("□")).length, 1);
});

/**
 * **境の両側の 2 本には `辻正隆` がそもそも出ない**（実測）。
 * **一般選挙で入った 12 人の中にも居ない**——**この任期の途中で入った議員である**
 * （19 会期目 44 名・20 会期目 43 名の氏名を全部数えたが、どちらにも `正隆` が無い）。
 *
 * **だから「`□` が出るのは新しい会期だけ」であって、広げたことで `□` が増えたのではない。**
 * **窓を広げて化けた氏名が増えていないことを、数で残す。**
 */
test("#901 境の両側の本には `辻` も `□` も無い（広げて化けた氏名が増えたのではない）", async () => {
  for (const name of ["Kg744_sanpi-0315.pdf", "Kg749_050509sannpi.pdf"]) {
    const pdf = await parseVotePdf(bytes(name));
    const names = pdf.members.map((m) => m.nameText);
    assert.ok(names.length > 0, `${name}: 議員の列が 0（母数が取れていない）`);
    assert.equal(names.filter((n) => n.includes("辻") || n.includes("□")).length, 0, `${name}`);
  }
});
