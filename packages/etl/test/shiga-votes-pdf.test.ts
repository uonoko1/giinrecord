import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseVotePdf, trailingVoteSymbols, legendOf, UNKNOWN_CELL, UNKNOWN_LEGEND, type VotePdf } from "../src/sources/local/shiga/votes-pdf.ts";
import { bandIndex, cluster, readPages, within, type Item } from "../src/sources/local/pdf-table.ts";
import { nonNameCharacters } from "../src/sources/local/name-match.ts";

/**
 * 滋賀県議会「議案等賛否一覧」PDF の表復元（Issue #741）。
 *
 * フィクスチャ 5 本は **147 本のうち、形が違う 5 通りを 1 本ずつ**（#680 が取得した本から選んだ）:
 *   Kg907_sanpi-080810-1  行アイテム型・2 ページ・**`辻` が `□` に化ける**（#680）
 *   Kg229_240711-sanpi    **記号帯が 2 アイテムに割れ、割れ目に `議` が 1 文字で立つ**（#705。8 本 32 行のうち）
 *   Kg280_sanpi-250924    **議決結果が記号と同じアイテムに入る**（`"可決 ○ ○ …"`。#694 の 3 本のうち）
 *   Kg693_sanpi-040318    **2 ページ目の氏名帯から議員 1 人が丸ごと消える**（#718）
 *   Kg265_250424-sanpi    **文字層の無い画像 PDF**（#680 の 3 本のうち。**読めないのが正しい結果**）
 */
const fixture = (name: string): Buffer => readFileSync(fileURLToPath(new URL(`fixtures/shiga/${name}`, import.meta.url)));

test("#741 trailingVoteSymbols: 末尾が記号の連なりで終わるアイテムだけを記号帯と見る", () => {
  // 行アイテム型（1 アイテムに記号がまとまる）
  assert.equal(trailingVoteSymbols("○ ○ × 議 －").length, 5);
  // **1 文字 1 アイテム型**（#718。`cx` をそのまま使う型）
  assert.deepEqual(trailingVoteSymbols("○"), ["○"]);
  // **議決結果が先頭に付く型**（#694）: 記号だけを返し、`可決` は残さない
  assert.equal(trailingVoteSymbols("可決 ○ ○ ○").length, 3);
  assert.equal(trailingVoteSymbols("44 43 19 24 不採択 × × ×").length, 3);
  // **凡例は記号帯ではない**——`。` で終わるので 0 個。**ここを外すと凡例を票の行として読む**
  assert.deepEqual(trailingVoteSymbols("「○」は賛成を、「×」は反対を、「議」は議長（表決権なし）、「－」は表決に参加していないことを表す。"), []);
  assert.deepEqual(trailingVoteSymbols("「-」欠席を、「議」は議長（表決権なし）、「退」は退席を表す。"), []);
  // 会派名・討論の行も記号帯ではない
  assert.deepEqual(trailingVoteSymbols("自由民主党滋賀県議会議員団"), []);
  assert.deepEqual(trailingVoteSymbols("（日本共産党滋賀県議会議員団）反対討論"), []);
});

test("#741 parseVotePdf: 行アイテム型（Kg907、2 ページ）——44 名 8 行、不明 0、凡例 4 種", async () => {
  const pdf = await parseVotePdf(fixture("Kg907_sanpi-080810-1.pdf"));
  assert.equal(pdf.pages, 2);
  assert.equal(pdf.members.length, 44);
  assert.equal(pdf.rows.length, 8);
  assert.equal(pdf.unknownCells, 0);
  assert.equal(pdf.headingText, "８月10日議決分");
  assert.deepEqual([pdf.month, pdf.day], [8, 10]);
  // 凡例は PDF の中の文から読む（決め打ちしない。#694 は 147 本で 2 種類あることを確かめている）
  assert.deepEqual(pdf.legend.votes, { "○": "賛成", "×": "反対", "議": "議長（表決権なし）", "－": "表決に参加していない" });
  // 会派帯は結合セル。名簿（44 名）の内訳と一致する
  const groups = new Map<string, number>();
  for (const m of pdf.members) groups.set(m.group, (groups.get(m.group) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries([...groups].sort()), {
    "さざなみ倶楽部": 3, "チームしが県議団": 9, "公明党滋賀県議団": 2, "日本共産党滋賀県議会議員団": 2,
    "滋賀維新の会": 3, "無所属": 4, "自由民主党滋賀県議会議員団": 21,
  });
  const row = pdf.rows[0];
  assert.equal(row.title, "議第105号から議第109号まで（人事案件）");
  assert.equal(row.dateText, "8/10");
  assert.equal(row.result, "同意");
  assert.deepEqual(row.counts, { present: 44, voting: 43, yes: 43, no: 0 });
  assert.equal(row.cells.length, 44);
});

test("#741 parseVotePdf: **記号帯が 2 アイテムに割れても議長が落ちない**（Kg229、#705）", async () => {
  const pdf = await parseVotePdf(fixture("Kg229_240711-sanpi.pdf"));
  assert.equal(pdf.members.length, 47);
  assert.equal(pdf.rows.length, 6);
  assert.equal(pdf.unknownCells, 0);
  // **この本は `"○ … ○"(20) + "議"(別アイテム) + "○ … ○"(26)` に割れる**（#705 が実測）。
  // **記号 10 個以上のアイテムだけを行と見ると `議` が落ち、その列の議員の記録が丸ごと消える。**
  // **47 名の会期で 46 名しか出なくても合計は 46 で辻褄が合うので、利用者からも検出できない。**
  for (const row of pdf.rows) {
    assert.equal(row.cells.length, 47, `${row.title}: セルが 47 個そろっていない`);
    assert.equal(row.cells.filter((c) => c === UNKNOWN_CELL).length, 0, `${row.title}: 置けないセルがある`);
    const gi = row.cells.indexOf("議");
    assert.notEqual(gi, -1, `${row.title}: 議長の記録が消えている`);
    // **どの列に落ちたかまで見る**——「議 がどこかにある」だけでは、隣の列にずれていても通る
    assert.equal(pdf.members[gi].nameText, "佐 野 高 典", `${row.title}: 議長の列が違う`);
  }
});

test("#741 parseVotePdf: **議決結果が記号と同じアイテムに入る型**（Kg280、#694）", async () => {
  const pdf = await parseVotePdf(fixture("Kg280_sanpi-250924.pdf"));
  assert.equal(pdf.members.length, 46);
  assert.equal(pdf.rows.length, 1);
  assert.equal(pdf.unknownCells, 0);
  const row = pdf.rows[0];
  // 議決結果の欄は空で、`"可決 ○ ○ … ○"` の先頭にある。**原文がそこにあるので取る**（推定ではない）
  assert.equal(row.result, "可決");
  // **記号が議決結果に混ざっていないこと**——`可決○○○…` になったら別の欄の値が壊れている
  assert.doesNotMatch(row.result, /[○×議－―]/);
  assert.equal(row.cells.length, 46);
  assert.equal(row.cells.indexOf("議"), 15);
  assert.equal(pdf.members[15].nameText, "宇 賀 武");
  // 集計数も左の欄から読める（`"46 44 44"` ＋ `"0"` の 2 アイテムに割れている）
  assert.deepEqual(row.counts, { present: 46, voting: 44, yes: 44, no: 0 });
});

test("#741 parseVotePdf: **2 ページ目で氏名が消える列を 1 ページ目から補う**（Kg693、#718）", async () => {
  const pdf = await parseVotePdf(fixture("Kg693_sanpi-040318.pdf"));
  assert.equal(pdf.members.length, 42);
  // **氏名の無い列が 1 つも無いこと。** この本の 2 ページ目には 41 人ぶんの氏名があり
  // （「氏名帯が空」ではない）、欠けるのは 1 列だけ。**「空のときだけ 1 ページ目」では直らない**（#718）
  assert.equal(pdf.members.filter((m) => m.nameText === "").length, 0);
  assert.equal(pdf.members[23].nameText, "角 田 航 也");
  // 2 ページ目の行でも、その列に票が入っている
  const page2 = pdf.rows.filter((r) => r.page === 2);
  assert.ok(page2.length > 0, "2 ページ目に票の行が無い");
  for (const r of page2) assert.notEqual(r.cells[23], UNKNOWN_CELL, `${r.title}: 借りた列に票が置けていない`);
  assert.equal(pdf.unknownCells, 0);
});

test("#741 parseVotePdf: **文字層の無い画像 PDF は読めないのが正しい**（Kg265、#680）", async () => {
  // **推定で埋めない。** 画像 PDF を「賛否が無かった」と書くのも、OCR で埋めるのも、どちらもしない
  await assert.rejects(() => parseVotePdf(fixture("Kg265_250424-sanpi.pdf")), /no text layer/);
});

test("#741 parseVotePdf: **化けた氏名を戻さない**（Kg907 の `辻` → `□`。#680／#674）", async () => {
  const pdf = await parseVotePdf(fixture("Kg907_sanpi-080810-1.pdf"));
  const broken = pdf.members.filter((m) => nonNameCharacters(m.nameText).length > 0);
  assert.equal(broken.length, 1);
  // `隆` は CJK 互換漢字 U+F9DC（この PDF の文字層がそう書いている）。**寄せずに原文のまま持つ**
  assert.deepEqual([...broken[0].nameText].map((c) => c.codePointAt(0)!.toString(16)), ["25a1", "20", "6b63", "20", "f9dc"]);
  // **`辻` に戻していないこと。** 戻すのは推定で、別人の記録を作る側（#569／#674）
  assert.equal(pdf.members.some((m) => m.nameText.includes("辻")), false);
  assert.deepEqual(nonNameCharacters(broken[0].nameText), ["□"]);
});

test("#741 legendOf: 凡例に無い記号は例外にせず抽出不能として残す（#569）", () => {
  const votes = { "○": "賛成", "×": "反対" };
  assert.equal(legendOf("○", votes), "賛成");
  assert.equal(legendOf(UNKNOWN_CELL, votes), UNKNOWN_LEGEND);
  // **凡例に無い記号で例外にすると、その PDF の読めた票まで全部消える。**
  // 滋賀には**凡例の文が 1 つも無い PDF がある**（実測 147 本中 19 本）ので、
  // 例外にすると 19 本ぶんの記録が出ない。**出さない側ではなく「意味は不明」と書く側に倒す。**
  assert.equal(legendOf("退", votes), UNKNOWN_LEGEND);
  // 字形の揺れ（〇 U+3007）は凡例の記号に寄せて引く（#674）
  assert.equal(legendOf("〇", votes), "賛成");
});

/* ---------- k 番目の記号が k 番目の議員のものか（#705 / #718 と同じ検算） ---------- */

const VOTE_SYMBOLS = new Set([..."○×議〇✕－―ー欠退-"]);

/**
 * **実装が置いたセルを、実装の grid を通さずに検算する。**
 *
 * 実装が返した `members[k].nameText` の文字が **PDF のどこにあるか**を x 座標で探し、
 * 実装が返した `cells[k]` の記号が **PDF のどこにあるか**を x 座標で探して、差が半セルより小さいか見る。
 * **列番号を経由しないので、記号だけを 1 列回すと差が 1 セルぶん（約 11.6pt）になる**（#705 の測り方）。
 *
 * 母数（`pairs`）も返す——**「半セル以上が 0 件」だけを見ると、測る対が減っても通る**
 * （#705 の `EDGE` 6.0、#718 の変異 4 で実際に起きた形）。
 */
async function measure(name: string, shift = 0): Promise<{ rows: number; pairs: number; near: number; far: number; maxSlack: number }> {
  const bytes = fixture(name);
  const pdf = await parseVotePdf(bytes);
  const pages = await readPages(bytes);
  const n = pdf.members.length;
  let rows = 0, pairs = 0, near = 0, far = 0, maxSlack = 0;

  // 氏名の列の中心 x: 1 ページ目で、氏名の文字（記号でも数字でもない 1 文字アイテム）を
  // 「氏名の 1 文字目の帯」から拾い、左から n 列に並べる。**実装の罫線は使わない。**
  const p1 = pages[0];
  const nameChars = p1.items.filter((i) => [...i.str].length === 1 && !VOTE_SYMBOLS.has(i.str) && !/^[0-9０-９]$/.test(i.str));
  // 帯にまとめ、n 列ちょうど埋まる帯のうちいちばん上（＝氏名の 1 文字目）
  const bands: Item[][] = [];
  for (const it of [...nameChars].sort((a, b) => b.cy - a.cy)) {
    const last = bands[bands.length - 1];
    if (last && Math.abs(last[0].cy - it.cy) <= Math.max(it.h, last[0].h) * 0.6) last.push(it);
    else bands.push([it]);
  }
  // **左の欄の見出し（議決日・出席者数…）も同じ帯に入る**ので、右から n 個だけ取る。
  // 議員の列は等間隔なので、右から n 個の間隔がそろっていることを確かめる。
  const xsOf = (band: Item[]) => [...new Set(band.map((i) => Math.round(i.cx * 10) / 10))].sort((a, b) => a - b);
  const evenlySpaced = (xs: number[]): boolean => {
    const gaps = xs.slice(1).map((x, i) => x - xs[i]);
    return gaps.every((g) => Math.abs(g - gaps[0]) < 1.0);
  };
  const nameBand = bands.find((b) => { const xs = xsOf(b); return xs.length >= n && evenlySpaced(xs.slice(-n)); });
  assert.ok(nameBand, `${name}: 氏名が n 列そろう帯が見つからない（検算そのものが立たない）`);
  const nameXs = xsOf(nameBand).slice(-n);
  const cellW = (nameXs[n - 1] - nameXs[0]) / (n - 1);

  for (const row of pdf.rows) {
    const page = pages[row.page - 1];
    // この行の記号の x: 実装が返した cells と同じ個数の記号が並ぶ帯を y でまとめて探す
    const symItems = page.items.filter((i) => trailingVoteSymbols(i.str).length > 0);
    const sbands: Item[][] = [];
    for (const it of [...symItems].sort((a, b) => b.cy - a.cy)) {
      const last = sbands[sbands.length - 1];
      if (last && Math.abs(last[0].cy - it.cy) <= Math.max(it.h, last[0].h) * 0.5) last.push(it);
      else sbands.push([it]);
    }
    for (const band of sbands) {
      const total = band.reduce((s, i) => s + trailingVoteSymbols(i.str).length, 0);
      if (total !== n) continue;
      // 記号の x: 1 文字アイテムは実 cx（#718）、複数記号のアイテムは右端からセル幅ずつ左へ（#705）
      const marks: number[] = [];
      for (const it of [...band].sort((a, b) => a.cx - b.cx)) {
        const cs = trailingVoteSymbols(it.str);
        if (cs.length === 1 && [...it.str].every((c) => VOTE_SYMBOLS.has(c) || /\s/.test(c))) { marks.push(it.cx); continue; }
        const r = it.x + it.w;
        for (let k = 0; k < cs.length; k++) marks.push(r - cellW * (cs.length - k - 0.5));
      }
      if (marks.length !== n) continue;
      marks.sort((a, b) => a - b);
      rows++;
      for (let k = 0; k < n; k++) {
        const target = (((k + shift) % n) + n) % n;
        pairs++;
        const d = Math.abs(marks[k] - nameXs[target]);
        if (d < cellW / 2) near++; else far++;
        maxSlack = Math.max(maxSlack, d / cellW);
      }
      break; // 1 行に 1 帯
    }
  }
  return { rows, pairs, near, far, maxSlack };
}

test("#741 **k 番目の記号は k 番目の議員のもの**——差は半セル未満（#705 / #718 の測り方）", async () => {
  for (const name of ["Kg907_sanpi-080810-1.pdf", "Kg229_240711-sanpi.pdf", "Kg280_sanpi-250924.pdf", "Kg693_sanpi-040318.pdf"]) {
    const m = await measure(name);
    assert.ok(m.rows > 0, `${name}: 測れる行が 0（検算が空回りしている）`);
    assert.ok(m.pairs > 0, `${name}: 測れる対が 0（検算が空回りしている）`);
    assert.equal(m.far, 0, `${name}: 半セル以上ずれた対が ${m.far} 件`);
    assert.ok(m.maxSlack < 0.5, `${name}: 余裕 ${m.maxSlack.toFixed(3)} が半セルを超えた`);
  }
});

test("#741 **この検算は順序不変ではない**——記号を 1 列回すと全部落ちる", async () => {
  // **「全部一致した」は測れていない徴候である**（#689 の担当者の言葉）。
  // 回転にしてある——端を空にする「ずらし」だと「空の列に落ちた」という**安い**理由で落ちてしまい、
  // 対応を見たことにならない（#705／#718 が同じ手順を踏んでいる）。
  for (const name of ["Kg907_sanpi-080810-1.pdf", "Kg229_240711-sanpi.pdf", "Kg693_sanpi-040318.pdf"]) {
    for (const shift of [1, -1, 2]) {
      const m = await measure(name, shift);
      assert.ok(m.pairs > 0, `${name} shift=${shift}: 測れる対が 0（母数が減っている）`);
      assert.equal(m.near, 0, `${name} shift=${shift}: ${m.near} 対が半セル未満のまま（この検算は順序不変）`);
    }
  }
});
