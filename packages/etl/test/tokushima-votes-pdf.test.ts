import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { expandDitto, parseLegendLines, parseVotePdf, UNKNOWN_CELL } from "../src/sources/local/tokushima/votes-pdf.ts";

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
  assert.deepEqual({ ...rows[0], cells: undefined }, { page: 1, number: "第１号", title: "令和8年度徳島県一般会計補正予算（第1号）", committeeResult: "可決", result: "可決", cells: undefined });
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
