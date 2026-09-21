import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseVotePdf, UNKNOWN_CELL } from "../src/sources/local/tottori/votes-pdf.ts";
// **食い違った行を全部並べる**（#826 で佐賀に作り、#844 で 5 県が使う 1 か所に移した）。
import { countMismatchRows } from "./count-mismatch-rows.ts";

// 鳥取県議会「議決結果（令和N年M月D日議決分）」PDF（Issue #184）。文字層から表を復元する（pdfjs）。
//   令和8年6月定例会（6月29日議決分）: /secure/1422217/R8.6giketsukekka0629.pdf（5 ページ。知事提出議案 15・議員提出議案 4・陳情 11。2026-08-24 取得）
//     同じ会期の /secure/1422215/R8.6.29 giinteishutsugian_giketsukekka.pdf（議員提出議案だけ、1 ページ）、
//     /secure/1422216/R8.6.29_seiganchinjogiketsukekka.pdf（陳情だけ、3 ページ。長い陳情の行はページをまたいで繰り返される）は上の PDF の部分集合。
//   令和8年2月定例会: /secure/1412313/R0802sengikekka.pdf（先議、3月9日議決分、14 件）、/secure/1412311/R8.2giketsukekka0325.pdf（3月25日議決分、6 ページ）
// 列 = 議員（会派見出しの下に縦書き「○○議員」。同姓は「浜田一議員」「浜田妙議員」のように名の 1 文字を添える）、行 = 議案等。
// 左 2 列（議案等番号＝種別＋番号、件名）、右 5 列（賛成者数・反対者数・表決者数・議決結果・表決方法）。請願・陳情の節には 件名 と議員の間に
// 「委員長報告」の列があり、賛否は「委員長報告に対する賛否」（節見出しの行に書いてある）。凡例は最終ページの表の下。
const bytes = (name: string) => readFileSync(new URL(`./fixtures/tottori/${name}`, import.meta.url));
const june = await parseVotePdf(bytes("R8.6giketsukekka0629.pdf"));
const juneSeigan = await parseVotePdf(bytes("R8.6.29_seiganchinjogiketsukekka.pdf"));
const juneGiin = await parseVotePdf(bytes("R8.6.29_giinteishutsugian_giketsukekka.pdf"));
const febSengi = await parseVotePdf(bytes("R0802sengikekka.pdf"));
const feb = await parseVotePdf(bytes("R8.2giketsukekka0325.pdf"));

test("parseVotePdf: 見出しの会期・議決日（ISO）と、その PDF の凡例（賛否欄）を原文で取る。表決方法の凡例は無い", () => {
  assert.equal(june.sessionLabel, "令和8年6月定例会");
  assert.equal(june.date, "2026-06-29");
  assert.deepEqual(june.legend.votes, {
    "○": "賛成",
    "×": "反対",
    "議": "議長",
    "副": "副議長が議長の職務を代理",
    "棄": "棄権",
    "除": "除斥",
    "欠": "欠席",
    "－": "議場に不在であり、表決しなかった議員",
  });
  assert.equal(febSengi.sessionLabel, "令和8年2月定例会");
  assert.equal(febSengi.date, "2026-03-09");
  assert.equal(feb.date, "2026-03-25");
  assert.deepEqual(feb.legend.votes, june.legend.votes);
});

test("parseVotePdf: 議員の列（縦書き「○○議員」）を罫線の列境界で復元し、会派の見出し（結合セル）から会派を付ける。同姓は名の 1 文字付き", () => {
  assert.equal(june.members.length, 35);
  assert.deepEqual(june.members[0], { nameText: "入江議員", group: "自由民主党" });
  assert.deepEqual(june.members[10], { nameText: "内田博議員", group: "自由民主党" });
  assert.deepEqual(june.members[17], { nameText: "浜田一議員", group: "自由民主党" });
  assert.deepEqual(june.members[21], { nameText: "浜田妙議員", group: "民主とっとり" });
  assert.deepEqual(june.members[34], { nameText: "市谷議員", group: "無所属" });
  const groups = new Map<string, number>();
  for (const m of june.members) groups.set(m.group, (groups.get(m.group) ?? 0) + 1);
  assert.deepEqual([...groups.entries()], [["自由民主党", 19], ["民主とっとり", 6], ["公明党", 3], ["無所属", 7]]);
  // 同じ会期の部分集合の PDF は同じ並び。2月の PDF は無所属の 西村・山川 の順が入れ替わっている（PDF ごとに列を読む。並びを仮定しない）
  assert.deepEqual(juneSeigan.members, june.members);
  assert.deepEqual(juneGiin.members, june.members);
  assert.deepEqual(feb.members.map((m) => m.nameText).slice(28, 32), ["玉木議員", "前住議員", "西村議員", "山川議員"]);
  assert.deepEqual(june.members.map((m) => m.nameText).slice(28, 32), ["玉木議員", "前住議員", "山川議員", "西村議員"]);
  assert.deepEqual(febSengi.members, feb.members);
});

test("parseVotePdf: 行（議案等）。種別・番号（NFKC）・件名（原文。本文の引用は含めない）・人数・議決結果・表決方法・各議員のセル。節見出しから賛否の対象を付ける", () => {
  assert.equal(june.rows.length, 30);
  const first = june.rows[0];
  assert.equal(first.page, 1);
  assert.equal(first.kind, "知事提案");
  assert.equal(first.number, "第1号");
  assert.equal(first.title, "令和８年度鳥取県一般会計補正予算（第１号）");
  assert.equal(first.voteSubject, "議案に対する賛否");
  assert.equal(first.committeeReport, undefined);
  assert.deepEqual(first.counts, { yes: 33, no: 1, voting: 34 });
  assert.equal(first.methodText, "起立");
  assert.equal(first.result, "可決");
  assert.equal(first.cells.length, 35);
  assert.equal(first.cells.join(""), "○○○○○○○○○○○○○○○○○○議○○○○○○○○○○○○○○○×");
  assert.equal(first.cells.filter((c) => c === "○").length, 33);
  // 15 件目は人事（同意）。全角・半角の混在する番号は NFKC で揃える（「第10号」）
  const r15 = june.rows[14];
  assert.equal(r15.number, "第15号");
  assert.equal(r15.result, "同意");
  assert.deepEqual(r15.counts, { yes: 34, no: 0, voting: 34 });
  assert.equal(june.rows[9].number, "第10号");
  // 2 ページ目は議員提出議案（節見出しは無く、前の節「議案に対する賛否」を引き継ぐ）
  const giin = june.rows[15];
  assert.equal(giin.page, 2);
  assert.equal(giin.kind, "議員提案");
  assert.equal(giin.number, "第1号");
  assert.equal(giin.title, "2035年国際協同組合年に向けた協同組合の振興を図る決議");
  assert.equal(giin.voteSubject, "議案に対する賛否");
  assert.deepEqual(giin.counts, { yes: 34, no: 0, voting: 34 });
  // 3 ページ目から請願・陳情: 賛否は委員長報告に対するもの。番号「7年－11」は NFKC で「7年-11」
  const chinjo = june.rows[19];
  assert.equal(chinjo.page, 3);
  assert.equal(chinjo.kind, "陳情");
  assert.equal(chinjo.number, "7年-11");
  assert.equal(chinjo.title, "旧姓の通称使用の法制化を求める陳情");
  assert.equal(chinjo.voteSubject, "委員長報告に対する賛否");
  assert.equal(chinjo.committeeReport, "研究留保");
  assert.equal(chinjo.result, "研究留保");
  assert.deepEqual(chinjo.counts, { yes: 23, no: 11, voting: 34 });
  assert.equal(chinjo.cells.join(""), "○○○○○○○○○○○○○○○○○○議×××××××××○○○×○○×");
  // 件名が 2 行に折り返す陳情（本文の引用は含めない）
  const r8_5 = june.rows.find((r) => r.number === "8年-5")!;
  assert.equal(r8_5.title, "自衛隊員の政治的中立性の確保を求める意見書の提出について");
  assert.equal(june.rows.find((r) => r.number === "8年-7")!.title, "高等学校における平和教育及び校外学習の政治的中立性と安全確保を求める陳情");
  assert.equal(june.unknownCells, 0);
  for (const r of june.rows) assert.equal(r.cells.length, 35, `${r.number} cells`);
});

test("parseVotePdf: 長い陳情の行がページをまたぐ PDF（陳情だけの 3 ページ版）。2 ページ目の先頭の本文だけの行は数えず、表の上端より上に繰り返された行（罫線の外）は読まない。部分集合の PDF は全体版と同じ行", () => {
  // 8年-7 は 1 ページ目の最後の行で、下の罫線が無いままページの下端で切れる（縦線の下端までを行として読む）
  const r8_7 = juneSeigan.rows.filter((r) => r.number === "8年-7");
  assert.equal(r8_7.length, 1);
  assert.equal(r8_7[0].page, 1);
  assert.equal(r8_7[0].title, "高等学校における平和教育及び校外学習の政治的中立性と安全確保を求める陳情");
  assert.equal(juneSeigan.rows.length, 11);
  assert.equal(juneGiin.rows.length, 4);
  const strip = (r: (typeof june.rows)[number]) => ({ ...r, page: 0, voteSubject: undefined });
  assert.deepEqual(juneSeigan.rows.map(strip), june.rows.filter((r) => r.kind === "陳情").map(strip));
  assert.deepEqual(juneGiin.rows.map(strip), june.rows.filter((r) => r.kind === "議員提案").map(strip));
  // 議員提出議案だけの版には節見出し（【議案】 … 議案に対する賛否）が無いので voteSubject は付かない（推定しない）
  assert.equal(juneGiin.rows[0].voteSubject, undefined);
  assert.equal(juneSeigan.rows[0].voteSubject, "委員長報告に対する賛否");
});

test("parseVotePdf: 令和8年2月定例会。先議（14 件）と 3月25日議決分（74 件）。議決結果が 2 行のセル（「趣旨採択（措置済）」）は結合する", () => {
  assert.equal(febSengi.rows.length, 14);
  assert.equal(febSengi.rows[0].number, "第22号");
  assert.deepEqual(febSengi.rows[0].counts, { yes: 33, no: 1, voting: 34 });
  assert.equal(feb.rows.length, 74);
  const shochi = feb.rows.find((r) => r.result === "趣旨採択（措置済）");
  assert.ok(shochi, "趣旨採択（措置済）");
  assert.equal(shochi.committeeReport, "趣旨採択（措置済）");
  assert.equal(shochi.kind, "陳情");
  assert.ok(feb.rows.some((r) => r.result === "否決"));
  assert.ok(feb.rows.some((r) => r.result === "承認"));
  const seigan = feb.rows.find((r) => r.kind === "請願");
  assert.ok(seigan, "請願の行");
  assert.equal(seigan.voteSubject, "委員長報告に対する賛否");
  assert.equal(feb.unknownCells + febSengi.unknownCells, 0);
  // 3月25日分は 6 ページ目が「別紙」（陳情の本文）。表ではないので読まない
  assert.equal(feb.trailingPages, 1);
  assert.equal(june.trailingPages, 0);
  // 全 PDF のセルは凡例の値だけ（不明は 0）。員数の検算は下の別のテストが受け持つ（#844）
  for (const pdf of [june, juneSeigan, juneGiin, febSengi, feb]) {
    for (const r of pdf.rows) {
      for (const c of r.cells) assert.ok(c === UNKNOWN_CELL || c in pdf.legend.votes, `${r.number}: ${c}`);
    }
  }
  // 番号の列に番号でない原文が入る行（附帯意見）も、議決結果の原文（「決定」）もそのまま
  const futai = feb.rows.find((r) => r.number === "附帯意見");
  assert.ok(futai, "附帯意見");
  assert.equal(futai.title, "（議案第1号関係）");
  assert.equal(futai.result, "決定");
  assert.equal(june.rows[1].result, "決定");
});

/**
 * **○ の数 ＝ 賛成者数 / × の数 ＝ 反対者数**（抽出の検算。ETL は数え直さない）。
 *
 * **食い違った行を全部並べて比べる**（#826／#844）——**`assert.equal` を行ごとに撃つと最初の 1 行で止まり、**
 * **「1 行だけ数え方が違う」のか「表の復元が壊れて 26 行ずれた」のかが読めない**
 * （**前者は記録が正しく、後者は記録が偽なのに、どちらも「テストが赤い」では同じに見える**）。
 * **検算は緩めていない——食い違いが 1 行でもあれば落ちる。**
 *
 * **本番側（`data/`）では代えられない**: **フィクスチャは 5 本 133 行だが、
 * `data/assemblies/pref-31/` で本番側（`meta.countMismatches`）が見ているのは 117 行**
 * （**118 行のうち 1 行は凡例の引けないセルがあるので母数の外**。#844 の実測）。
 */
test("parseVotePdf: ○の数＝賛成者数、×の数＝反対者数（PDF 5 本 133 行。食い違いは全部並べる）", () => {
  const rows = [june, juneSeigan, juneGiin, febSengi, feb].flatMap((pdf) => pdf.rows.map((r) => ({ ...r, date: pdf.date })));
  assert.equal(rows.length, 133, "30 + 11 + 4 + 14 + 74");
  const { mismatches, checked } = countMismatchRows(rows, { yes: "○", no: "×", cells: (r) => r.cells, label: (r) => `${r.date} ${r.kind} ${r.number}` });
  // **母数を先に固定する**（#757）——**突き合わせた行が減ったら、「食い違い 0 件」は「見た上での 0」ではない**
  assert.equal(checked, 133, "133 行とも突き合わせた（母数が減ったらこの検算は空回りする）");
  assert.deepEqual(mismatches, []);
});

test("parseVotePdf: 見出し（会期・議決日）が無い・凡例が無い PDF は失敗する", async () => {
  await assert.rejects(parseVotePdf(Buffer.from("%PDF-1.4\n%%EOF")), /PDF|Invalid/);
});

/* ============================================================ *
 * **#901 で `--sessions` を広げたとき、次の 3 会期が例外で止めていた 3 つの欠陥**
 *
 * **`--sessions 2` の 5 本には 1 本も無い形である。**
 * **どれも「読めない」であって「別人が出る」ではない**（#569 の軽いほう）が、
 * **直さないと 3 会期めから先が 1 行も出ない。**
 * ============================================================ */

const dec2025 = await parseVotePdf(bytes("R7.12.22giketsukekka.pdf"));
const feb2025 = await parseVotePdf(bytes("R7.2giketsukekka0324.pdf"));
const sep2024 = await parseVotePdf(bytes("R0609gikeysukekka.pdf"));

test("#901 議案等番号が空の行（決算認定に係る指摘事項）を読む。番号を推定せず空のまま出す", () => {
  // **令和7年12月定例会（2025-12-22 議決分）の 2 ページ目 9 行目**——
  // **議案等番号のセルが一次資料で空**（件名のほうに「9月定例会第13号、第14号及び第15号」と書いてある）。
  // **直す前は `incomplete row (kind/number/method/result)` で PDF まるごと落ちていた。**
  assert.equal(dec2025.sessionLabel, "令和7年12月定例会");
  assert.equal(dec2025.date, "2025-12-22");
  const blank = dec2025.rows.filter((r) => r.number === "");
  assert.equal(blank.length, 1, "**番号が空の行は 1 行だけ**（母数。#757。増えたら数え直す）");
  assert.equal(blank[0].kind, "知事提案");
  assert.equal(blank[0].title, "決算認定に係る指摘事項「9月定例会第13号、第14号及び第15号」並びに12月定例会第13号」");
  assert.deepEqual(blank[0].counts, { yes: 33, no: 1, voting: 34 });
  assert.equal(blank[0].result, "決定");
  assert.equal(blank[0].methodText, "起立");
  // **セルは 35 人ぶんそろう**（番号が空でも賛否は読める）
  assert.equal(blank[0].cells.length, 35);
  assert.equal(blank[0].cells.filter((c) => c === "○").length, 33);
  assert.equal(blank[0].cells.filter((c) => c === "×").length, 1);
  assert.equal(blank[0].cells.filter((c) => c === "議").length, 1);
  assert.equal(blank[0].cells.filter((c) => c === UNKNOWN_CELL).length, 0);
});

test("#901 種別・表決方法・議決結果はどれか 1 つでも空なら今までどおり例外（空を許したのは番号だけ）", () => {
  // **「番号が空でも通す」を「どれが空でも通す」に広げてはいけない**——
  // **種別が読めない行は、その行がどの表のものか分からない。**
  for (const r of dec2025.rows) {
    assert.notEqual(r.kind, "", `${r.number}: 種別は空にならない`);
    assert.notEqual(r.result, "", `${r.number}: 議決結果は空にならない`);
    assert.notEqual(r.methodText, "", `${r.number}: 表決方法は空にならない`);
  }
});

test("#901 見出しが複数の文字アイテムに割れている PDF（令和7年2月定例会）でも会期と議決日を読む", () => {
  // **同じ会期の先議 PDF は `令和7年2月定例会` が 1 アイテムなのに、
  // この本は `令和` / `7` / `年` / `2` / `月定例会` の 5 アイテムに割れている**（実測）。
  // **直す前は `session label (令和N年M月定例会) not found in page 1 header` で落ちていた。**
  assert.equal(feb2025.sessionLabel, "令和7年2月定例会");
  assert.equal(feb2025.date, "2025-03-24");
});

test("#901 同じ凡例が同じページに何度も印刷される PDF は通す。値が食い違う凡例は今までどおり例外", () => {
  // **令和6年9月定例会の PDF は、最終ページに同じ凡例ブロックを 3 回印刷している**
  // （**7 項目 × 3 回。値は 1 文字も違わない**——実測）。
  // **直す前は `legend key ○ appears twice` で落ちていた。**
  assert.equal(sep2024.sessionLabel, "令和6年9月定例会");
  assert.deepEqual(sep2024.legend.votes, {
    "○": "賛成",
    "×": "反対",
    "議": "議長",
    "副": "副議長が議長の職務を代理",
    "除": "除斥",
    "欠": "欠席",
    "－": "議場に不在であり、表決しなかった議員",
  });
});

test("#901 広げた 3 本でも ○の数＝賛成者数、×の数＝反対者数（母数を数える）", () => {
  const rows = [dec2025, feb2025, sep2024].flatMap((pdf) => pdf.rows.map((r) => ({ ...r, date: pdf.date })));
  assert.equal(rows.length, 160, "**母数**（実測 2026-09-21。ここが減ったら下の 0 件は「見た上での 0」ではない）");
  const { mismatches, checked } = countMismatchRows(rows, { yes: "○", no: "×", cells: (r) => r.cells, label: (r) => `${r.date} ${r.kind} ${r.number}` });
  assert.equal(checked, 160);
  assert.deepEqual(mismatches, []);
});
