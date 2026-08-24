import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseVotePdf, UNKNOWN_CELL, checkCellsAgainstLegend } from "../src/sources/local/kochi/votes-pdf.ts";

// 高知県議会「議員別賛否の状況」の会期 PDF（Issue #220。2026-08-24 取得）。文字層から表を復元する（pdfjs、共通部は pdf-table.ts）。
//   令和8年6月定例会: /_files/00156424/0806.pdf（2 ページ、36 名）
//   令和7年6月定例会: /_files/00141109/0706.pdf（2 ページ、36 名）
// 表: 左から 議案種別（縦書きの結合セル）・番号・件名・議決年月日・議決結果・議員の列（上段に会派の結合セル、下に縦書きの氏名）・賛成者数・反対者数。
// 凡例は最終ページの表の下の「・議決結果の見方」の行。
const bytes = (name: string) => readFileSync(new URL(`./fixtures/kochi/${name}`, import.meta.url));
const june8 = await parseVotePdf(bytes("0806.pdf"));
const june7 = await parseVotePdf(bytes("0706.pdf"));

test("parseVotePdf: 表題の会期を原文で取る", () => {
  assert.equal(june8.title, "令和８年６月定例会議決結果一覧表");
  assert.equal(june8.sessionLabel, "令和８年６月定例会");
  assert.equal(june8.year, 2026);
  assert.equal(june8.month, 6);
  assert.equal(june7.sessionLabel, "令和７年６月定例会");
  assert.equal(june7.year, 2025);
});

test("parseVotePdf: 凡例（議決結果の見方）を原文どおりに取る", () => {
  // 「○・・賛成、×・・反対、議・・議長、副・・副議長が議長の職務を代理、欠・・欠席、除・・除斥、－・・議場に不在であった議員」
  assert.deepEqual(june8.legend.votes, {
    "○": "賛成",
    "×": "反対",
    "議": "議長",
    "副": "副議長が議長の職務を代理",
    "欠": "欠席",
    "除": "除斥",
    "－": "議場に不在であった議員",
  });
  assert.deepEqual(june7.legend.votes, june8.legend.votes);
  // 凡例の但し書き（表決権・裁決権）も原文のまま残す（丸めない）
  assert.ok(june8.legend.notes.some((n) => n.includes("可否同数の場合に決定する権利（裁決権）があります")));
});

test("parseVotePdf: 議員の列（縦書きの氏名）と会派の結合セル", () => {
  assert.equal(june8.members.length, 36);
  assert.deepEqual(june8.members[0], { nameText: "浜口卓也", group: "自由民主党" });
  assert.deepEqual(june8.members[35], { nameText: "塚地佐智", group: "日本共産党" });
  // 会派ごとの人数（PDF の会派見出しの結合セルから）
  const groups = new Map<string, number>();
  for (const m of june8.members) groups.set(m.group, (groups.get(m.group) ?? 0) + 1);
  assert.deepEqual([...groups.entries()], [
    ["自由民主党", 20], ["一燈立志の会", 2], ["公明党", 3], ["自由の風", 1], ["県民の会", 4], ["日本共産党", 6],
  ]);
});

test("parseVotePdf: 行（議案）。種別（結合セル）・番号・件名・議決年月日・結果と各議員のセル", () => {
  const first = june8.rows[0];
  assert.equal(first.kind, "知事提出議案");
  assert.equal(first.number, "第1号");
  assert.equal(first.title, "令和８年度高知県一般会計予算");
  assert.equal(first.dateText, "R8.7.10");
  assert.equal(first.result, "原案可決");
  assert.equal(first.cells.length, 36);
  // 先頭行: 自民〜県民の会が○、議長（19 列目）は「議」、共産 6 名が×
  assert.equal(first.cells[0], "○");
  assert.equal(first.cells[18], "議");
  assert.deepEqual(first.cells.slice(30), ["×", "×", "×", "×", "×", "×"]);
  assert.equal(first.counts?.yes, 29);
  assert.equal(first.counts?.no, 6);
});

test("parseVotePdf: 「〃」（同上）は原文のまま残す（前の行の値で埋めない）", () => {
  const dittos = june8.rows.filter((r) => r.dateText === "〃");
  assert.ok(dittos.length > 0, "「〃」の行があること");
});

test("parseVotePdf: 議員提出議案の行も種別（結合セル）から取る", () => {
  const giin = june8.rows.filter((r) => r.kind === "議員提出議案");
  assert.ok(giin.length > 0);
  const last = june8.rows[june8.rows.length - 1];
  assert.equal(last.kind, "議員提出議案");
  assert.equal(last.number, "議発第12号");
  // 議決結果は上の行と同じなので原文が「〃」。前の行の「否決」で埋めない（原文主義）
  assert.equal(last.result, "〃");
  assert.equal(last.dateText, "〃");
  assert.equal(last.counts?.yes, 10);
  assert.equal(last.counts?.no, 25);
  // 「〃」でない原文が入っている行もある（議発第8号の「否決」）
  const hiketsu = june8.rows.find((r) => r.number === "議発第8号");
  assert.equal(hiketsu?.result, "否決");
});

test("parseVotePdf: 凡例に無い値が出たら例外（丸めない）", () => {
  assert.throws(() => checkCellsAgainstLegend(["○", "△"], june8.legend.votes, "test"), /not in the legend/);
  // UNKNOWN_CELL は通す
  assert.doesNotThrow(() => checkCellsAgainstLegend(["○", UNKNOWN_CELL], june8.legend.votes, "test"));
});

test("parseVotePdf: 復元したセルの員数が PDF 自身の賛成者数・反対者数と一致する（セルの脱落・余剰の検算）", () => {
  // PDF には行ごとに賛成者数・反対者数の欄がある（cells とは別の列＝countCols から読むので独立した原文）。
  // 数が食い違えば、セルの取りこぼし・二重取りがあるということ（原文どうしの突き合わせなので推定は入らない）。
  // ただしこれは「員数」の一致であって順序は見ていない: セルを並べ替えても合計は変わらないので、
  // 列のずれ（off-by-one）はこの検算では捕まらない。それは下の「どの議員が」のゴールデンテストが受け持つ。
  for (const pdf of [june8, june7]) {
    for (const row of pdf.rows) {
      if (!row.counts) continue;
      const yes = row.cells.filter((c) => c === "○").length;
      const no = row.cells.filter((c) => c === "×").length;
      assert.deepEqual({ yes, no }, row.counts, `${pdf.sessionLabel} ${row.number}`);
    }
  }
});

/** 議員の氏名 → セルの値。「何人が×か」ではなく「どの議員が×か」を見るための形。 */
const byMember = (pdf: typeof june8, number: string): Record<string, string> => {
  const row = pdf.rows.find((r) => r.number === number);
  assert.ok(row, `${number} が無い`);
  return Object.fromEntries(row.cells.map((c, i) => [pdf.members[i].nameText, c]));
};

test("parseVotePdf: どの議員がどう投じたか（ゴールデン）。列がずれたら落ちる", () => {
  // 「何人が×か」は並べ替えに対して不変なので、列が 1 つずれても員数の検算は通ってしまう。
  // ここでは議員ごとの値を原文どおりに固定する（賛否の境目が行ごとに違う議案を選んだので、
  // 全体が 1 列ずれれば必ずどこかの議員の値が変わる）。
  // 令和8年6月 議発第10号（全てのケアラー…、9/26）: 自民は×、一燈立志の会・公明・県民の会は○、
  // 自由の風（樋口）は×、共産は×、議長（明神）は「議」。会派の境目と賛否の境目が一致しない行。
  assert.deepEqual(byMember(june8, "議発第10号"), {
    浜口卓也: "×", 竹内健造: "×", 戸田宗崇: "×", 上治堂司: "×", 桑鶴太朗: "×", 土森正一: "×",
    槇尾絢子: "×", 久保博道: "×", 上田貢太郎: "×", 今城誠司: "×", 金岡佳時: "×", 下村勝幸: "×",
    田中徹: "×", 土居央: "×", 横山文人: "×", 西内隆純: "×", 加藤漠: "×", 弘田兼一: "×",
    明神健夫: "議", 三石文隆: "×",
    畠中拓馬: "○", 依光美代子: "○",
    西森美和: "○", 寺内憲資: "○", 西森雅和: "○",
    樋口秀洋: "×",
    水野雪絵: "○", 岡﨑哲也: "○", 岡田竜平: "○", 坂本茂雄: "○",
    はた愛: "×", 細木良: "×", 岡田芳秀: "×", 岡本和也: "×", 中根佐知: "×", 塚地佐智: "×",
  });
  // 同じ会期の別の行は賛否の境目が違う（議発第12号、10/25）。県民の会から共産までが○
  assert.deepEqual(byMember(june8, "議発第12号"), {
    浜口卓也: "×", 竹内健造: "×", 戸田宗崇: "×", 上治堂司: "×", 桑鶴太朗: "×", 土森正一: "×",
    槇尾絢子: "×", 久保博道: "×", 上田貢太郎: "×", 今城誠司: "×", 金岡佳時: "×", 下村勝幸: "×",
    田中徹: "×", 土居央: "×", 横山文人: "×", 西内隆純: "×", 加藤漠: "×", 弘田兼一: "×",
    明神健夫: "議", 三石文隆: "×",
    畠中拓馬: "×", 依光美代子: "×", 西森美和: "×", 寺内憲資: "×", 西森雅和: "×", 樋口秀洋: "×",
    水野雪絵: "○", 岡﨑哲也: "○", 岡田竜平: "○", 坂本茂雄: "○",
    はた愛: "○", 細木良: "○", 岡田芳秀: "○", 岡本和也: "○", 中根佐知: "○", 塚地佐智: "○",
  });
  // 令和7年6月（議員の顔ぶれも並びも違う PDF）。議発第3号（25/10）は 樋口までが○、岡田竜平から×、議長は三石
  assert.deepEqual(byMember(june7, "議発第3号"), {
    竹内健造: "○", 戸田宗崇: "○", 上治堂司: "○", 桑鶴太朗: "○", 土森正一: "○", 槇尾絢子: "○",
    久保博道: "○", 上田貢太郎: "○", 今城誠司: "○", 金岡佳時: "○", 下村勝幸: "○", 田中徹: "○",
    土居央: "○", 横山文人: "○", 西内隆純: "○", 加藤漠: "○", 弘田兼一: "○", 明神健夫: "○",
    三石文隆: "議",
    畠中拓馬: "○", 依光美代子: "○", 武石利彦: "○",
    西森美和: "○", 寺内憲資: "○", 西森雅和: "○", 樋口秀洋: "○",
    岡田竜平: "×", 田所裕介: "×", 橋本敏男: "×", 坂本茂雄: "×",
    はた愛: "×", 細木良: "×", 岡田芳秀: "×", 岡本和也: "×", 中根佐知: "×", 塚地佐智: "×",
  });
});

test("ゴールデンテストは 1 列のずれを実際に検出する（安全網そのものの検査）", () => {
  // 員数の検算が off-by-one に対して盲目であることと、ゴールデンが実際にそれを捕まえることを、
  // 「1 列巡回シフトさせた偽の抽出結果」で確かめる（安全網が本当に張れているかを回帰させる）。
  for (const pdf of [june8, june7]) {
    let countsCaught = 0;
    let goldenCaught = 0;
    let rowsWithCounts = 0;
    for (const row of pdf.rows) {
      const shifted = [...row.cells.slice(1), row.cells[0]];
      // 員数の検算: シフトしても ○ / × の数は変わらない ＝ 捕まらない
      if (row.counts) {
        rowsWithCounts++;
        const yes = shifted.filter((c) => c === "○").length;
        const no = shifted.filter((c) => c === "×").length;
        if (yes !== row.counts.yes || no !== row.counts.no) countsCaught++;
      }
      // 議員ごとの対応: シフトすれば必ずどこかの議員の値が変わる（全会一致の行は無い）
      const before = row.cells.map((c, i) => `${pdf.members[i].nameText}=${c}`).join(",");
      const after = shifted.map((c, i) => `${pdf.members[i].nameText}=${c}`).join(",");
      if (before !== after) goldenCaught++;
    }
    assert.equal(countsCaught, 0, `${pdf.sessionLabel}: 員数の検算は 1 列シフトを捕まえない（順序不変）`);
    assert.equal(goldenCaught, pdf.rows.length, `${pdf.sessionLabel}: 議員ごとの対応なら全行で 1 列シフトを捕まえる`);
    assert.ok(rowsWithCounts > 0);
  }
});

test("parseVotePdf: 抽出できなかったセルは無い（この 2 本の PDF は全セル読める）", () => {
  assert.equal(june8.unknownCells, 0);
  assert.equal(june7.unknownCells, 0);
});

test("parseVotePdf: 会期ごとに議員の顔ぶれ（並び・会派）は PDF から読む（名簿ではなく表決時点の原文）", () => {
  // 令和7年6月は 武石利彦・田所裕介・橋本敏男 が居て、令和8年6月には居ない（改選・異動）
  assert.ok(june7.members.some((m) => m.nameText === "武石利彦"));
  assert.ok(!june8.members.some((m) => m.nameText === "武石利彦"));
  assert.ok(june8.members.some((m) => m.nameText === "浜口卓也"));
  assert.ok(!june7.members.some((m) => m.nameText === "浜口卓也"));
});

test("parseVotePdf: すべてのセルが凡例の値か不明のどちらか。ページごとの議員の並びは同じ", () => {
  for (const pdf of [june8, june7]) {
    assert.ok(pdf.rows.length > 0);
    for (const row of pdf.rows) {
      assert.equal(row.cells.length, pdf.members.length);
      for (const c of row.cells) assert.ok(c === UNKNOWN_CELL || c in pdf.legend.votes, `cell ${c}`);
    }
    // 2 ページにまたがる（ヘッダは各ページで繰り返される）
    assert.deepEqual([...new Set(pdf.rows.map((r) => r.page))], [1, 2]);
  }
});
