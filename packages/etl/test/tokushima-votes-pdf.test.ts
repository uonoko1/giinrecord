import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkSameMemberSet, expandDitto, parseLegendLines, parseVotePdf, UNKNOWN_CELL } from "../src/sources/local/tokushima/votes-pdf.ts";

// 徳島県議会「各議員の表決態度」PDF（Issue #183）。行＝議案、列＝議員（縦書き氏名、上段に会派の結合セル）。
//   令和8年6月定例会 7月3日採決: https://www.pref.tokushima.lg.jp/file/attachment/1064407.pdf（2 ページ、2026-08-24 取得）
//   令和8年2月定例会 2月13日採決: …/1036105.pdf（1 ページ、1 行）、2月20日採決: …/1038136.pdf（動議 1 行、議案番号なし）、3月11日採決: …/1042426.pdf（6 ページ）
// 1 つの PDF に「○ 知事提出議案」「○ 議員提出議案」「○ 請願」の節があり、節ごとに表（ページをまたぐ）と凡例（※ 行）がある。
// 宮城と同じく罫線から列・行の境界を取り、文字の中心が入るセルにだけ置く。置けないセルは UNKNOWN_CELL（推定しない）。
const bytes = (name: string) => readFileSync(new URL(`./fixtures/tokushima/${name}`, import.meta.url));
const jul3 = await parseVotePdf(bytes("1064407.pdf"));
const feb13 = await parseVotePdf(bytes("1036105.pdf"));
const feb20 = await parseVotePdf(bytes("1038136.pdf"));
const mar11 = await parseVotePdf(bytes("1042426.pdf"));

test("parseVotePdf: 表題「議案審査結果（令和８年７月３日）」から採決日を取り、議員 36 人の列を会派の結合セルつきで復元する（列見出しと順序の対応）", () => {
  assert.equal(jul3.title, "議案審査結果（令和８年７月３日）");
  assert.equal(jul3.date, "2026-07-03");
  assert.equal(jul3.members.length, 36);
  assert.deepEqual(jul3.members[0], { nameText: "嘉見 博之", group: "徳島県議会自由民主党" });
  assert.deepEqual(jul3.members[11], { nameText: "川真田琢巳", group: "徳島県議会自由民主党" }); // 5 文字で埋まる
  assert.deepEqual(jul3.members[16], { nameText: "眞貝 浩司", group: "徳島県議会自由民主党" });
  assert.deepEqual(jul3.members[17], { nameText: "仁木 啓人", group: "新しい県政を創る会" });
  assert.deepEqual(jul3.members[22], { nameText: "立川 了大", group: "自由民主党県民会議" });
  assert.deepEqual(jul3.members[26], { nameText: "浪越 憲一", group: "グローカルplus" }); // 「ｐｌｕｓ」は NFKC で plus
  assert.deepEqual(jul3.members[29], { nameText: "岡 佑樹", group: "真政会" });
  assert.deepEqual(jul3.members[31], { nameText: "梶原 一哉", group: "公明党徳島県議団" }); // 小さい字で 3 段に割れている
  assert.deepEqual(jul3.members[32], { nameText: "達田 良子", group: "日本共産党" });
  assert.deepEqual(jul3.members[33], { nameText: "扶川 敦", group: "護民官" });
  assert.deepEqual(jul3.members[34], { nameText: "岡田 晋", group: "元気とくしま" });
  assert.deepEqual(jul3.members[35], { nameText: "曽根 大志", group: "日本維新の会" });
  const groups = new Map<string, number>();
  for (const m of jul3.members) groups.set(m.group, (groups.get(m.group) ?? 0) + 1);
  assert.deepEqual([...groups.entries()], [
    ["徳島県議会自由民主党", 17],
    ["新しい県政を創る会", 5],
    ["自由民主党県民会議", 4],
    ["グローカルplus", 3],
    ["真政会", 2],
    ["公明党徳島県議団", 1],
    ["日本共産党", 1],
    ["護民官", 1],
    ["元気とくしま", 1],
    ["日本維新の会", 1],
  ]);
});

test("parseVotePdf: 節（○ 知事提出議案／議員提出議案／請願）ごとに行と凡例を持つ。凡例は節の表の下の ※ 行の原文（節ごとに違う）", () => {
  assert.deepEqual(jul3.sections.map((s) => [s.kind, s.rows.length]), [["知事提出議案", 15], ["議員提出議案", 2], ["請願", 3]]);
  assert.deepEqual(jul3.sections[0].legend, {
    "○": "委員会審査結果又は議長宣告に起立（賛成）した者",
    "議": "議長",
    "●": "委員会審査結果又は議長宣告に起立しなかった者",
  });
  assert.deepEqual(jul3.sections[2].legend, {
    "○": "委員会審査結果又は議長宣告に起立（賛成）した者",
    "議": "議長",
    "退": "退席",
    "●": "委員会審査結果又は議長宣告に起立しなかった者",
  });
  // 3月11日: 知事提出議案の表が 4 ページにまたがり、凡例は 4 ページ目の表の下に 1 つ（除斥あり）
  assert.deepEqual(mar11.sections.map((s) => [s.kind, s.rows.length]), [["知事提出議案", 78], ["請願", 2], ["議員提出議案", 3]]);
  assert.deepEqual(mar11.sections[0].legend, {
    "○": "委員会審査結果又は議長宣告に起立（賛成）した者",
    "議": "議長",
    "退": "退席",
    "除": "除斥",
    "欠": "欠席",
    "●": "委員会審査結果又は議長宣告に起立しなかった者",
  });
  assert.deepEqual(mar11.sections[0].rows.map((r) => r.page).filter((p, i, a) => a.indexOf(p) === i), [1, 2, 3, 4]);
});

test("parseVotePdf: 行は 議案番号・案名（2 行に折り返しても 1 つ）・委員会審査結果・議決結果 を原文で持つ", () => {
  const rows = jul3.sections[0].rows;
  assert.deepEqual({ ...rows[0], cells: undefined, members: undefined }, { page: 1, number: "第１号", title: "令和8年度徳島県一般会計補正予算（第1号）", committeeResult: "可決", result: "可決", cells: undefined, members: undefined });
  // **並びが 1 通りしか無い PDF では、行の `members` は `VotePdf.members` と同一**（#901。回帰の番人）
  assert.deepEqual(rows[0].members, jul3.members);
  assert.deepEqual([...new Set(jul3.sections.flatMap((s) => s.rows).map((r) => JSON.stringify(r.members)))], [JSON.stringify(jul3.members)]);
  assert.equal(rows[3].number, "第４号");
  assert.equal(rows[3].title, "地方活力向上地域内における県税の課税免除等に関する条例の一部改正について");
  assert.equal(rows[12].number, "第13号");
  assert.equal(rows[12].committeeResult, "－"); // 委員会付託なし（全角）
  assert.equal(rows[13].result, "同意");
  const opinions = jul3.sections[1].rows;
  assert.equal(opinions[0].number, "第１号");
  assert.equal(opinions[0].title, "書店に対する支援強化を求める意見書");
  assert.equal(opinions[0].committeeResult, "-"); // こちらは半角（原文のまま）
  const petitions = jul3.sections[2].rows;
  assert.deepEqual(petitions.map((r) => [r.number, r.committeeResult, r.result]), [["第19号", "不採択", "不採択"], ["第20号", "採択", "採択"], ["第21号", "不採択", "不採択"]]);
});

test("parseVotePdf: セルは議員数ぶん、原文のまま（○ と 〇 U+3007 を区別して保持）。7月3日 第１号は ○31 〇2 議1 ●2", () => {
  const row = jul3.sections[0].rows[0];
  assert.equal(row.cells.length, 36);
  assert.equal(row.cells[0], "○");
  assert.equal(row.cells[7], "〇"); // U+3007（見た目は同じ。原文のまま保持し、凡例の ○ として読む）
  assert.equal(row.cells[25], "議"); // 議長（井川 龍二）
  assert.deepEqual(row.cells.slice(29, 31), ["●", "●"]);
  const count = (cells: string[]) => cells.reduce<Record<string, number>>((o, c) => ({ ...o, [c]: (o[c] ?? 0) + 1 }), {});
  assert.deepEqual(count(row.cells), { "○": 31, "〇": 2, "議": 1, "●": 2 });
  // 請願 第19号: 退席 2 人（仁木 啓人・長池 文武）
  const petition = jul3.sections[2].rows[0];
  assert.equal(petition.cells[17], "退");
  assert.equal(petition.cells[19], "退");
  assert.equal(jul3.unknownCells, 0);
  assert.ok(!jul3.sections.some((s) => s.rows.some((r) => r.cells.includes(UNKNOWN_CELL))));
});

test("parseVotePdf: 議案番号の結合セル（第１号の原案と修正案）は 2 行とも同じ番号。番号の無い行（動議）は原文の「-」", () => {
  const [orig, amendment] = mar11.sections[0].rows;
  assert.deepEqual([orig.number, orig.title, orig.committeeResult, orig.result], ["第１号", "令和８年度徳島県一般会計予算", "可決", "可決"]);
  assert.deepEqual([amendment.number, amendment.title, amendment.committeeResult, amendment.result], ["第１号", "令和８年度徳島県一般会計予算に対する修正案", "-", "否決"]);
  assert.equal(mar11.sections[0].rows[2].number, "第２号");
  // 第77号（監査委員の選任）も 2 行（木下賢功氏・仁木啓人氏）。本人の列は「除」（除斥）
  const audit = mar11.sections[0].rows.filter((r) => r.number === "第77号");
  assert.deepEqual(audit.map((r) => r.title), ["監査委員の選任について（木下賢功氏）", "監査委員の選任について（仁木啓人氏）"]);
  assert.equal(audit[0].cells[13], "除"); // 木下 賢功
  assert.equal(audit[1].cells[17], "除"); // 仁木 啓人
  assert.equal(mar11.date, "2026-03-11");
  assert.equal(mar11.unknownCells, 0);
  assert.deepEqual(feb20.sections.map((s) => [s.kind, s.rows.length]), [["動議", 1]]);
  const motion = feb20.sections[0].rows[0];
  assert.equal(motion.number, "-"); // 番号欄の原文（番号は無い）
  assert.equal(motion.title, "議案第１号のうち、藍場浜公園西エリア新ホール整備事業に関する予算案について、他の予算案と分割の上、再提出を求める動議");
  assert.equal(motion.result, "否決");
  assert.deepEqual(feb20.sections[0].legend, {
    "○": "委員会審査結果又は議長宣告に起立（賛成）した者",
    "議": "議長",
    "欠": "欠席",
    "●": "委員会審査結果又は議長宣告に起立しなかった者",
  });
  assert.equal(feb13.date, "2026-02-13");
  assert.deepEqual(feb13.sections.map((s) => [s.kind, s.rows.length]), [["知事提出議案", 1]]);
  assert.equal(feb13.sections[0].rows[0].number, "第50号");
});

test("parseVotePdf: 凡例に無い値が出たら例外（丸めない）。節に凡例が無ければ例外", async () => {
  // 7月3日 の知事提出議案の凡例には 退 が無い → 請願の表の「退」を知事提出議案の凡例で読もうとすれば失敗する（節ごとに凡例を読む根拠）
  assert.ok(!("退" in jul3.sections[0].legend));
  await assert.rejects(parseVotePdf(Buffer.from("%PDF-1.4 garbage")), /PDF|Invalid/);
});

test("expandDitto / parseLegendLines: 「●」 〃 に起立しなかった者 の 〃 は直前の凡例の同じ位置の語（委員会審査結果又は議長宣告）", () => {
  assert.equal(expandDitto("〃に起立しなかった者", "委員会審査結果又は議長宣告に起立（賛成）した者"), "委員会審査結果又は議長宣告に起立しなかった者");
  assert.throws(() => expandDitto("〃まったく別の文", "委員会審査結果又は議長宣告に起立（賛成）した者"), /ditto/);
  assert.deepEqual(parseLegendLines(["「○」委員会審査結果又は議長宣告に起立（賛成）した者、「議」議長、「欠」欠席", "「●」〃に起立しなかった者"]), {
    "○": "委員会審査結果又は議長宣告に起立（賛成）した者",
    "議": "議長",
    "欠": "欠席",
    "●": "委員会審査結果又は議長宣告に起立しなかった者",
  });
  assert.throws(() => parseLegendLines(["「○」賛成、「○」反対"]), /twice/);
});

/**
 * ## **1 本の PDF の中で、議員の列の並びが表ごとに違う**（Issue #901 の徳島。**実測で見つけた**）
 *
 * **`1028727.pdf`（令和7年11月定例会 12月19日採決）は 4 枚の表を持ち、
 * 4 枚目（3 ページ目の 2 枚目、議員提出議案の表）だけ 11 列目と 12 列目が入れ替わっている。**
 *
 * | | 10 列目 | **11 列目** | **12 列目** | 13 列目 |
 * |---|---|---|---|---|
 * | 1〜3 枚目 | 井村 保裕 | **沢本 勝彦** | **川真田琢巳** | 大塚 明廣 |
 * | **4 枚目** | 井村 保裕 | **川真田琢巳** | **沢本 勝彦** | 大塚 明廣 |
 *
 * **これは読み取りの誤りではない**——**PDF のグリフの x 座標そのものが違う**（実測）:
 * **1 枚目は `沢`/`本`/`勝`/`彦` が cx=415.75、`川真田琢巳` が cx=428.95。
 * 4 枚目は `川真田琢巳` が cx=415.75、`沢本勝彦` が cx=428.95。**
 *
 * **`--sessions 2` の範囲には 1 本も無い。** **4 会期に広げた瞬間に出る形である。**
 * **28 本の到達可能な PDF のうち、表ごとに並びが違うのはこの 1 本だけ**（実測 2026-09-20）。
 *
 * ## **なぜこれが「別の記録が出る」形なのか**
 *
 * **直す前のコードは「1 枚目と違えば例外」だった**——**安全側だが、この会期がまるごと出ない。**
 * **「1 枚目の並びを使い回す」という直し方をすると、4 枚目の 7 行で
 * 沢本 勝彦 の票が 川真田琢巳 に、川真田琢巳 の票が 沢本 勝彦 に付く**——
 * **利用者から検出できない虚偽である**（#569 の重いほう）。
 *
 * **だから「表ごとの並びをその表の行に持たせる」以外に正しい直し方は無い。**
 */
const dec19 = await parseVotePdf(bytes("1028727.pdf"));

test("#901 parseVotePdf: 表ごとに議員の並びが違う PDF で、行が自分の表の並びを持つ（1028727.pdf の 4 枚目だけ 11/12 列目が入れ替わる）", () => {
  assert.equal(dec19.date, "2025-12-19");
  assert.equal(dec19.members.length, 37, "この会期は 37 人（今の名簿 36 人＋北島 一人）");
  // **`members` は 1 枚目の並び**（従来どおり。互換）
  assert.equal(dec19.members[10].nameText, "沢本 勝彦");
  assert.equal(dec19.members[11].nameText, "川真田琢巳");
  // **行は自分の表の並びを持つ**
  const all = dec19.sections.flatMap((s) => s.rows);
  assert.equal(all.length, 40, "母数（この PDF の全行）");
  assert.deepEqual(dec19.sections.map((sec) => [sec.kind, sec.rows.length]), [["知事提出議案", 32], ["請願", 1], ["議員提出議案", 7]]);
  const swapped = all.filter((r) => r.members[10].nameText === "川真田琢巳");
  const normal = all.filter((r) => r.members[10].nameText === "沢本 勝彦");
  assert.equal(normal.length, 33, "1〜3 枚目の行");
  assert.equal(swapped.length, 7, "**4 枚目（議員提出議案）の 7 行だけ入れ替わっている**");
  // **入れ替わっているのは 11/12 列目だけで、ほかの 35 列は同じ**
  for (const r of swapped) {
    assert.equal(r.members[10].nameText, "川真田琢巳");
    assert.equal(r.members[11].nameText, "沢本 勝彦");
    assert.deepEqual(
      r.members.filter((_, i) => i !== 10 && i !== 11).map((m) => m.nameText),
      dec19.members.filter((_, i) => i !== 10 && i !== 11).map((m) => m.nameText),
      "11/12 列目以外は 1 枚目と同じ",
    );
  }
  // **`members` と `cells` の長さが行ごとに揃う**（37 列 × 37 行）
  assert.deepEqual([...new Set(all.map((r) => r.cells.length))], [37]);
  assert.deepEqual([...new Set(all.map((r) => r.members.length))], [37]);
  assert.equal(dec19.unknownCells, 0);
});

test("#901 parseVotePdf: 入れ替わった 4 枚目の `●` 2 票が、1 枚目の並びで読むと別人に付く（直さずに使い回したときの被害）", () => {
  const swapped = dec19.sections.flatMap((s) => s.rows).filter((r) => r.members[10].nameText === "川真田琢巳");
  // 附帯決議 第１号 は 2 人が `●`
  const teiketsu = swapped.find((r) => r.title.includes("附帯決議"));
  assert.ok(teiketsu, "附帯決議の行");
  const nays = teiketsu.cells.map((c, i) => [c, i] as const).filter(([c]) => c === "●").map(([, i]) => i);
  assert.deepEqual(nays, [30, 31], "`●` の列");
  // **その 2 人は、その行の並びで読む**
  assert.deepEqual(nays.map((i) => teiketsu.members[i].nameText), ["岡 佑樹", "坂口 誠治"]);
  // **`議` も同じ**（この PDF の議長は 須見 一仁）
  const gi = teiketsu.cells.indexOf("議");
  assert.equal(teiketsu.members[gi].nameText, "須見 一仁");

  // **ここが「別の記録が出る」ことの実物である**——**入れ替わった 7 行で、
  // 11 列目と 12 列目を `VotePdf.members`（1 枚目の並び）で読むと、2 人の票が入れ替わる。**
  const swapped7 = dec19.sections.flatMap((s) => s.rows).filter((r) => r.members[10].nameText === "川真田琢巳");
  assert.equal(swapped7.length, 7, "母数");
  let wouldSwap = 0;
  for (const r of swapped7) {
    // 正しい読み（行の並び） ↔ 誤った読み（1 枚目の並び）
    if (r.members[10].nameText !== dec19.members[10].nameText) wouldSwap++;
    if (r.members[11].nameText !== dec19.members[11].nameText) wouldSwap++;
  }
  assert.equal(wouldSwap, 14, "**7 行 × 2 人 = 14 票が別人に付いていたはず**");
});

/**
 * **顔ぶれが違う表は、並びが違うだけの表とは別に扱う**（#901）。
 *
 * **並びの違いは許す**（実在する）が、**1 人でも増減したら止める**——
 * **「同じ会期の同じ議員の表」ではないので、推定して読まない**（#569）。
 */
/**
 * **`parseVotePdf` が、2 枚目以降の表について実際に `checkSameMemberSet` を呼んでいること**（#901）。
 *
 * **これが無いと、`checkSameMemberSet` のテストは「関数が正しいこと」しか言わない**——
 * **`parseVotePdf` の中の呼び出しを丸ごと消しても 1 件も落ちない**（**変異 M2 で実測した。分類 4**）。
 * **#932 の M9 とまったく同じ形である。**
 *
 * **フィクスチャに「顔ぶれが違う表を持つ PDF」が 1 本も無い**（7 本すべて、表ごとの顔ぶれは同じ）
 * **ので、振る舞いでは書けない。** **だから #932 が `CMAP_OPTIONS` でやったのと同じく、
 * 呼び出し側の原文を読んで固定する。** **弱い検査であることを、弱いまま書く。**
 */
test("#901 parseVotePdf は 2 枚目以降の表に checkSameMemberSet を当てている（呼び出し側の原文を読む）", () => {
  const src = readFileSync(new URL("../src/sources/local/tokushima/votes-pdf.ts", import.meta.url), "utf-8");
  // **1 枚目は `members` に入れ、2 枚目以降は `checkSameMemberSet` に掛ける**
  assert.match(src, /if \(!members\) members = tableMembers;\s+else checkSameMemberSet\(members, tableMembers, /,
    "**`parseVotePdf` の中で `checkSameMemberSet` を呼んでいない**（変異 M2 が素通りする）");
  // **行に渡すのは `tableMembers`（その表の並び）であって `members`（1 枚目の並び）ではない**
  assert.match(src, /readRows\(page, grid, pageNo, tableMembers\)/,
    "**行に 1 枚目の並びを渡している**（14 票が別人に付く。変異 M1）");
  assert.doesNotMatch(src, /readRows\(page, grid, pageNo, members\)/);
  // **同じ関数の中に両方がある**（別の場所の文字列を拾って緑にならないように）
  const body = src.slice(src.indexOf("export async function parseVotePdf"), src.indexOf("export function checkCellsAgainstLegend"));
  assert.ok(body.includes("checkSameMemberSet(members, tableMembers,"), "parseVotePdf の中に無い");
  assert.ok(body.includes("readRows(page, grid, pageNo, tableMembers)"), "parseVotePdf の中に無い");
});

test("#901 checkSameMemberSet: 並びの違いは通し、顔ぶれの違いは例外（どちらが増減したかをメッセージに出す）", () => {
  const a = [{ nameText: "沢本 勝彦", group: "自民" }, { nameText: "川真田琢巳", group: "自民" }, { nameText: "扶川 敦", group: "護民官" }];
  const swapped = [a[1], a[0], a[2]];
  assert.doesNotThrow(() => checkSameMemberSet(a, swapped, "t"), "並びが違うだけなら通す");
  assert.doesNotThrow(() => checkSameMemberSet(a, a, "t"));
  // 1 人減る
  assert.throws(() => checkSameMemberSet(a, a.slice(0, 2), "t"), /only in the first: 扶川 敦/);
  // 1 人入れ替わる（人数は同じ）
  assert.throws(() => checkSameMemberSet(a, [a[0], a[1], { nameText: "北島 一人", group: "自民" }], "t"), /only in the first: 扶川 敦.*only here: 北島 一人/s);
  // **会派だけ違っても別の顔ぶれ**（同じ氏名でも会派が違えば、名簿の会派と食い違う）
  assert.throws(() => checkSameMemberSet(a, [a[0], a[1], { nameText: "扶川 敦", group: "別会派" }], "t"), /member columns differ/);
});
