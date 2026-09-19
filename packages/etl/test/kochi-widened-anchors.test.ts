import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseVotePdf, type VotePdf } from "../src/sources/local/kochi/votes-pdf.ts";
import { parseChairs, chairOn, parseSince, type Chair } from "./kochi-chairman.ts";
import { parseHtmlResults } from "./kochi-html-results.ts";

/**
 * # **`--sessions` を 2 → 5 に広げて増えた 3 会期に、x と y の錨を当て直す**（Issue #901 / #819）
 *
 * **「件数が増えた」は「正しく増えた」ではない。**
 * **#876 が 本番の 2 本（2026-06 / 2026-02）に置いた錨を、増えた 3 本にそのまま当てる。**
 *
 * | 本 | 行 | 議員 | 議決日 | **錨A**（`議` ⇔ 歴代議長） | **錨B**（`除` ⇔ 件名の（○○議員）） | **錨D**（HTML と並び順） |
 * |---|---:|---:|---|---|---|---|
 * | **2025-12**（`0712.pdf`） | **75** | **35** | 2025-12-05 / 12-19 | **75 / 75、全回転で落ちる** | **`除` 0 セル → 母数 0** | **75 / 75** |
 * | **2025-09**（`0709.pdf`） | **18** | 36 | 2025-10-14 | **18 / 18、全回転で落ちる** | **`除` 0 セル → 母数 0** | **行数が違うので当てない**（下） |
 * | **2025-06**（`0706.pdf`） | **24** | 36 | 2025-06-27 | **24 / 24、全回転で落ちる** | **`除` 0 セル → 母数 0** | **24 / 24** |
 *
 * ## **#913 への実測の答え: 広げても錨B の母数は増えない**
 *
 * **#913 は「2026-02 の 81 行は x が `除` 1 セルに乗っている。広げれば `除` の母数が増えるかもしれない」
 * と書いている。** **増えなかった**——**増えた 3 会期の 4,137 セルに `除` は 1 つも無い**（実測）。
 *
 * **だが別の形で状況は良くなった。**
 * **増えた 3 本はどれも議長交代の当日ではない**（**2025-06-27 / 2025-10-14 / 2025-12-05 / 2025-12-19 の
 * 4 つの議決日はいずれも 三石文隆（104 代、2025-03-24 就任。**同名で 94 代・99 代もあるので日付で引く**）の在任中**）——
 * **だから錨A の `−1` の穴が開かず、117 行すべてがどの回転でも落ちる。**
 *
 * **つまり #913 の穴は「2026-02 の 81 行」に閉じたままで、広げたぶんには波及していない。**
 * **広げたことで穴の割合は 81 / 104（77.9%）から 81 / 221（36.7%）に下がった。**
 * **これは「穴が塞がった」ではない**——**穴の在る行は 81 行のままである。**
 *
 * ## **「回転で落ちる行数が多いほど錨が強い」とは読まない**（#911）
 *
 * **下の数字は「無改造で 0」と対で読むこと。** **名簿を丸ごと壊しても「全回転で全行落ちる」は成り立つ。**
 * **だから「無改造で不一致 0」と「回すと落ちる」を、別々の assert に置いてある。**
 *
 * ## **使っていない物差し**（#891 / #911 / PO の指示）
 *
 * - **「半セル未満」を x の根拠にしていない**（**高知ではずらしたほうが割合が高かった**——98.07% < 99.25%）。
 * - **公表数（賛成者数・反対者数）との突き合わせを x の検算に使っていない**
 *   （**記号帯の回転は置換なので `○` と `×` の個数が変わらない**。#876 が 1,282 行で 0 件と実測している）。
 */

const fx = (n: string): Buffer => readFileSync(new URL(`./fixtures/kochi/${n}`, import.meta.url));
const txt = (n: string): string => fx(n).toString("utf-8");

const gicho: Chair[] = parseChairs(txt("chairman.html"), "歴代議長");
const strip = (s: string): string => s.replace(/[\s　]/g, "").normalize("NFKC");
const dayBefore = (d: string): string => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10); };

/** **測定用**の議決年月日の読み（`R元.10.10` も読む。実装の `parseDateText` は `R<数字>` だけ。#876 の欠陥①）。 */
function measureDate(s: string): string | undefined {
  const m = s.normalize("NFKC").replace(/[\s　]/g, "").match(/^([HR])(元|\d+)\.(\d+)\.(\d+)$/);
  if (!m) return undefined;
  const y = (m[1] === "R" ? 2018 : 1988) + (m[2] === "元" ? 1 : Number(m[2]));
  return `${y}-${String(Number(m[3])).padStart(2, "0")}-${String(Number(m[4])).padStart(2, "0")}`;
}

/** 記号帯だけを `rot` 列**回す**（端から落ちた記号は反対の端に戻る。**ずらしではない**）。 */
const rotateCols = (cells: readonly string[], rot: number): string[] =>
  rot === 0 ? [...cells] : cells.map((_, i) => cells[(i - rot + cells.length * 1000) % cells.length]);

/** **錨A**: `議` の列の議員 == 県が公表しているその議決日の議長。**交代当日は前任も許す**（推定しない）。 */
function chairCheck(pdf: VotePdf, chairs: readonly Chair[], rot = 0): { judged: number; mismatch: number; handover: number } {
  const names = pdf.members.map((m) => m.nameText);
  let date: string | undefined;
  let judged = 0, mismatch = 0, handover = 0;
  for (const r of pdf.rows) {
    const d = measureDate(r.dateText);
    if (d) date = d;
    if (!date) continue;
    const idx = rotateCols(r.cells, rot).flatMap((c, i) => (c === "議" ? [i] : []));
    if (idx.length !== 1) continue;
    const cur = chairOn(chairs, date);
    if (!cur) continue;
    judged++;
    const prev = chairOn(chairs, dayBefore(date));
    const isHandover = parseSince(cur.since) === date && prev !== undefined && strip(prev.name) !== strip(cur.name);
    if (isHandover) handover++;
    const got = strip(names[idx[0]]);
    if (got !== strip(cur.name) && !(isHandover && got === strip(prev!.name))) mismatch++;
  }
  return { judged, mismatch, handover };
}

/** **錨B**: `除` の列の議員 == 同じ行の件名の（○○議員）。**PDF の中で閉じる**ので交代当日の穴が無い。 */
const NAMED_IN_TITLE = /[（(]([^（）()]+?)議員[）)]/;
function josekiCheck(pdf: VotePdf, rot = 0): { judged: number; mismatch: number } {
  const names = pdf.members.map((m) => m.nameText);
  let judged = 0, mismatch = 0;
  for (const r of pdf.rows) {
    const idx = rotateCols(r.cells, rot).flatMap((c, i) => (c === "除" ? [i] : []));
    if (idx.length !== 1) continue;
    const m = strip(r.title).match(NAMED_IN_TITLE);
    if (!m) continue;
    judged++;
    if (!strip(names[idx[0]]).startsWith(m[1])) mismatch++;
  }
  return { judged, mismatch };
}

/** **錨D**: PDF の r 行目 == HTML の r 行目（**並び順**。番号を鍵にして引き当てない）。 */
const stripTitle = (s: string): string => strip(s).replace(/\[PDF[:：][^\]]*\]/g, "");
function htmlCheck(pdf: VotePdf, html: ReturnType<typeof parseHtmlResults>, rot = 0): { judged: number; titleBad: number; numberBad: number } {
  let judged = 0, titleBad = 0, numberBad = 0;
  const n = pdf.rows.length;
  for (let i = 0; i < n; i++) {
    const p = pdf.rows[(i - rot + n * 1000) % n];
    const q = html[i];
    judged++;
    if (stripTitle(p.title) !== stripTitle(q.title)) titleBad++;
    if (strip(p.number) !== strip(q.number)) numberBad++;
  }
  return { judged, titleBad, numberBad };
}

/** **#901 で増えた 3 本**（2026-09-20 取得）。**本番の 2 本は `kochi-vote-alignment.test.ts` が見ている。** */
const dec7 = await parseVotePdf(fx("0712.pdf"));
const sep7 = await parseVotePdf(fx("0709.pdf"));
const jun7 = await parseVotePdf(fx("0706.pdf"));
/** **本番の 2026-02 の本**。**比較のためだけに読む**（#913 の穴がここに閉じていることを示す）。 */
const feb8 = await parseVotePdf(fx("0802.pdf"));
const ADDED: { name: string; pdf: VotePdf; rows: number; members: number }[] = [
  { name: "0712.pdf（令和7年12月）", pdf: dec7, rows: 75, members: 35 },
  { name: "0709.pdf（令和7年9月）", pdf: sep7, rows: 18, members: 36 },
  { name: "0706.pdf（令和7年6月）", pdf: jun7, rows: 24, members: 36 },
];

/* ============================ 母数を先に固定する（#757） ============================ */

test("#901 増えた 3 本の母数: 117 行 / 4,137 セル（**これが減ったら以降の錨は空回りする**）", () => {
  for (const b of ADDED) {
    assert.equal(b.pdf.rows.length, b.rows, `${b.name} の行`);
    assert.equal(b.pdf.members.length, b.members, `${b.name} の議員の列`);
    assert.equal(b.pdf.unknownCells, 0, `${b.name} の不明セル`);
    for (const r of b.pdf.rows) assert.equal(r.cells.length, b.members, `${b.name} ${r.number}: セル数`);
  }
  const rows = ADDED.reduce((a, b) => a + b.rows, 0);
  const cells = ADDED.reduce((a, b) => a + b.rows * b.members, 0);
  assert.equal(rows, 117, "増えた行（104 → 221 の差）");
  assert.equal(cells, 4_137, "増えた セル（3,744 → 7,881 の差）");
});

/* ============================ 錨A（x）: 議長 ============================ */

test("#901 錨A: 増えた 117 行すべてで `議` の列が県公表の議長と一致する（**無改造で 0 件**）", () => {
  for (const b of ADDED) {
    const r = chairCheck(b.pdf, gicho);
    assert.equal(r.judged, b.rows, `${b.name}: **判定できた行**（\`議\` がちょうど 1 つ立つ行）`);
    assert.equal(r.mismatch, 0, `${b.name}: 県公表の議長と食い違った行`);
  }
  // **`議` が 0 個の行も 2 個以上の行も無い**（母数が満ちている）
  const judged = ADDED.reduce((a, b) => a + chairCheck(b.pdf, gicho).judged, 0);
  assert.equal(judged, 117);
  // **`chairCheck` は「`議` がちょうど 1 つ」の行だけを判定する。**
  // **いま 117 行とも 1 つなので、「ちょうど 1 つ」と「1 つ以上」は同じ結果になる**
  // （**実測: `idx.length !== 1` を `< 1` に変えても 1 件も落ちない**）。
  // **だから機序のほうを直に固定する**——**この分布が崩れたら、上の 0 件は「見た上での 0」ではなくなる。**
  const perRow = new Map<number, number>();
  for (const b of ADDED) for (const r of b.pdf.rows) { const n = r.cells.filter((c) => c === "議").length; perRow.set(n, (perRow.get(n) ?? 0) + 1); }
  assert.deepEqual(Object.fromEntries(perRow), { 1: 117 }, "**行ごとの `議` の数**（0 個も 2 個以上も無い）");
});

test("#901 錨A: 増えた 3 本は **1 本も議長交代の当日ではない** —— だから `−1` の穴が開かない（#913）", () => {
  for (const b of ADDED) {
    assert.equal(chairCheck(b.pdf, gicho).handover, 0, `${b.name}: 交代当日の行`);
  }
  // **4 つの議決日はいずれも 104 代 三石文隆 の在任中**（2025-03-24 就任 〜 2026-03-24 交代）
  const dates = [...new Set(ADDED.flatMap((b) => b.pdf.rows.map((r) => measureDate(r.dateText)).filter((d): d is string => d !== undefined)))].sort();
  assert.deepEqual(dates, ["2025-06-27", "2025-10-14", "2025-12-05", "2025-12-19"], "増えた本の議決日");
  for (const d of dates) assert.equal(strip(chairOn(gicho, d)!.name), "三石文隆", `${d} の議長`);
  // **就任日を一次資料から確かめる**（**docblock に書いた日付が、県の表と合っているか**）。
  // **三石文隆 も 明神健夫 も 2 回ずつ議長をしている**——**「氏名で引く」と 1 回目に当たる。**
  // **だから `chairOn` は日付で引いている**（**氏名で引く錨を書いたら、11 年前の代を指す**）。
  assert.deepEqual(gicho.filter((c) => strip(c.name) === "三石文隆").map((c) => [c.dai, parseSince(c.since)]), [[94, "2015-05-12"], [99, "2020-03-23"], [104, "2025-03-24"]]);
  assert.deepEqual(gicho.filter((c) => strip(c.name) === "明神健夫").map((c) => [c.dai, parseSince(c.since)]), [[101, "2022-03-23"], [105, "2026-03-24"]]);
  assert.equal(chairOn(gicho, "2025-12-19")!.dai, 104, "**代で引く**（氏名ではない）");
  // **増えた 4 つの議決日は、104 代の就任日より後で、105 代の就任日より前**（**だから交代当日にならない**）
  for (const d of dates) assert.ok(d > "2025-03-24" && d < "2026-03-24", `${d} が 104 代の在任中`);
  // **本番の 2026-02 の 81 行は交代当日のまま**（**広げても塞がっていない。#913 は開いたままである**）
  assert.equal(chairCheck(feb8, gicho).handover, 81, "2026-02 の交代当日の行（**#913 の穴。81 行のまま**）");
  // **穴の在る行の割合は 81/104（77.9%）→ 81/221（36.7%）に下がった。行数は 81 のまま。**
  assert.equal(Math.round((81 / 104) * 1000) / 10, 77.9);
  assert.equal(Math.round((81 / 221) * 1000) / 10, 36.7);
});

test("#901 錨A: 増えた 3 本は **`−1` を含むどの回転でも全行落ちる**（2026-02 とここが違う）", () => {
  for (const b of ADDED) {
    for (const rot of [1, 2, -1, -2, 7, 17]) {
      const r = chairCheck(b.pdf, gicho, rot);
      assert.equal(r.judged, b.rows, `${b.name} ${rot} 列回転: **母数が減っていないこと**`);
      assert.equal(r.mismatch, b.rows, `${b.name} ${rot} 列回転で落ちた行`);
    }
  }
  // **2026-02 は `−1` だけ 0 / 81 で落ちない**（前任 三石文隆(列19) と後任 明神健夫(列18) が隣の列）。
  // **これが #913 の言う穴であり、増えた本には無い。**
  assert.equal(chairCheck(feb8, gicho).mismatch, 0, "2026-02 の無改造（**交代当日なので前任も許している**）");
  assert.equal(chairCheck(feb8, gicho, -1).mismatch, 0, "**2026-02 の `−1` は落ちない（穴）**");
  assert.equal(chairCheck(feb8, gicho, 1).mismatch, 81, "2026-02 の `+1` は落ちる");
  // **穴の機序を数字で固定する**（**「交代当日は前任も許す」という緩めが、そのまま穴である**）。
  // **PDF の `議` は 列19 の 三石文隆（前任）で、`−1` 回すと 列18 の 明神健夫（後任）になる。**
  // **どちらも許されるので落ちない**——**`−1` ずれた表を「正しい」と言ってしまう。**
  const febNames = feb8.members.map((m) => m.nameText);
  assert.deepEqual(febNames.slice(17, 22).map(strip), ["弘田兼一", "明神健夫", "三石文隆", "畠中拓馬", "依光美代子"]);
  assert.deepEqual(feb8.rows[0].cells.flatMap((c, i) => (c === "議" ? [i] : [])), [19], "無改造の `議` の列");
  assert.equal(strip(chairOn(gicho, "2026-03-24")!.name), "明神健夫", "その日の議長（後任）");
  assert.equal(strip(chairOn(gicho, "2026-03-23")!.name), "三石文隆", "前日の議長（前任）");
  // **「交代当日は前任も許す」を外すと、増えた 3 本は 1 件も動かず（交代日が無い）、
  //   2026-02 だけが 81 / 81 落ちる**——**つまりこの緩めは 2026-02 の 81 行にしか効いていない。**
  let strictFebMismatch = 0;
  for (const r of feb8.rows) {
    const idx = r.cells.flatMap((c, i) => (c === "議" ? [i] : []));
    if (idx.length !== 1) continue;
    if (strip(febNames[idx[0]]) !== strip(chairOn(gicho, "2026-03-24")!.name)) strictFebMismatch++;
  }
  assert.equal(strictFebMismatch, 81, "**前任を許さなければ 2026-02 は 81 / 81 落ちる**（緩めの効き先はここだけ）");
});

test("#901 錨A: 錨を「歴代副議長」に取り違えると 増えた 117 行すべてが落ちる（同じページに 2 つの表）", () => {
  const fuku = parseChairs(txt("chairman.html"), "歴代副議長");
  assert.equal(gicho.length, 105, "歴代議長");
  assert.equal(fuku.length, 110, "歴代副議長");
  for (const b of ADDED) {
    const r = chairCheck(b.pdf, fuku);
    assert.equal(r.judged, b.rows, `${b.name}: 母数`);
    assert.equal(r.mismatch, b.rows, `${b.name}: 副議長の表を錨にすると全行落ちる`);
  }
});

/* ============================ 錨B（x）: 除斥 —— **広げても母数 0 のまま** ============================ */

test("#901 錨B: 増えた 3 本には `除` が 1 セルも無い —— **母数 0 では x を何も言っていない**（#913 の 1 番への答え）", () => {
  for (const b of ADDED) {
    const jo = b.pdf.rows.flatMap((r) => r.cells).filter((c) => c === "除").length;
    assert.equal(jo, 0, `${b.name} の \`除\` のセル`);
    const r = josekiCheck(b.pdf);
    assert.equal(r.judged, 0, `${b.name}: **判定できた行が 0**`);
    assert.equal(r.mismatch, 0, `${b.name}: 0 件を「一致した」と読まないこと`);
  }
  // **件名に（○○議員）がある行も 0 行**（**`除` が無いのではなく、そもそも監査委員の選任議案が無い**）
  const named = ADDED.flatMap((b) => b.pdf.rows).filter((r) => NAMED_IN_TITLE.test(strip(r.title)));
  assert.equal(named.length, 0, "件名が議員を名指しする行");
  // **`除` は 5 会期 7,881 セルで 1 個だけ**（2026-02 の 下村勝幸）——**広げても増えなかった。**
});

/* ============================ 錨D（y）: 県の HTML ============================ */

/**
 * **2025-12 のページは「議決結果一覧」の表が 2 つに割れている**（**請願が別の表**）。
 * **2 つを上から順に繋いで初めて PDF の 75 行と並ぶ。**
 */
const htmlDec7 = parseHtmlResults(txt("decision-2025-12.html"), 2);
const htmlJun7 = parseHtmlResults(txt("decision-2025-06.html"), 1);

test("#901 錨D の母数: 表の数を宣言してあり、違う数で読もうとすると例外になる（**黙って空にしない**）", () => {
  // **`parseHtmlResults(html, n)` の `n` は「このページに議決結果の表が n 個ある」という宣言である。**
  // **数を書かずに「1 つ以上あればよい」にすると、県がページの作りを変えて表が 1 つ消えても
  //   黙って母数が減り、「不一致 0 件」が「見た上での 0」ではなくなる**（#757）。
  // **実測**: 2025-12 だけ 2 個（請願が別の表）、2025-09 / 2025-06 / 2026-06 / 2026-02 は 1 個。
  assert.throws(() => parseHtmlResults(txt("decision-2025-12.html"), 1), /expected exactly 1 .*got 2/, "2025-12 を 1 個として読もうとすると例外");
  assert.throws(() => parseHtmlResults(txt("decision-2025-06.html"), 2), /expected exactly 2 .*got 1/, "2025-06 を 2 個として読もうとすると例外");
  assert.throws(() => parseHtmlResults(txt("decision-2025-09.html"), 2), /expected exactly 2 .*got 1/);
  // **2 個のうち 1 個だけを読むと 71 行にしかならない**（**請願の 4 行が落ちる**）——
  // **母数を宣言していなければ、その 71 行で PDF の 75 行と突き合わせることになる。**
  assert.equal(htmlDec7.length, 75, "2 個を繋いだ行");
  assert.equal(htmlDec7.filter((h) => /請第/.test(h.number)).length, 4, "**2 個目の表にしかない請願の行**");
});

test("#901 錨D: 2025-12 の 75 行と 2025-06 の 24 行が、県の HTML と並び順で対応する（**無改造**）", () => {
  assert.equal(htmlDec7.length, 75, "2025-12 の HTML の行（表 2 つを繋いだ数）");
  assert.equal(htmlJun7.length, 24, "2025-06 の HTML の行");
  const d = htmlCheck(dec7, htmlDec7);
  assert.equal(d.judged, 75, "母数");
  assert.equal(d.numberBad, 0, "2025-12: 番号が食い違った行");
  // **件名は 1 行だけ食い違う**——**県の 2 つの一次資料が違う**（実装の誤りではない。どちらが正しいかは決めない）
  assert.equal(d.titleBad, 1, "2025-12: 件名が食い違った行");
  const j = htmlCheck(jun7, htmlJun7);
  assert.equal(j.judged, 24, "母数");
  assert.equal(j.numberBad, 0, "2025-06: 番号");
  assert.equal(j.titleBad, 0, "2025-06: 件名（**24 行とも 1 文字も違わない**）");
});

test("#901 錨D: 1 行 回すと 2025-12 は 75 / 75、2025-06 は 24 / 24 の番号が落ちる（**y の検算**）", () => {
  for (const rot of [1, -1, 2]) {
    const d = htmlCheck(dec7, htmlDec7, rot);
    assert.equal(d.judged, 75, "母数");
    assert.equal(d.numberBad, 75, `2025-12 ${rot} 行回転で番号が落ちた行`);
    const j = htmlCheck(jun7, htmlJun7, rot);
    assert.equal(j.judged, 24, "母数");
    assert.equal(j.numberBad, 24, `2025-06 ${rot} 行回転で番号が落ちた行`);
  }
});

test("#901 錨D は **x を 1 件も捕まえない**（列を回しても番号も件名も動かない）", () => {
  const rotated: VotePdf = { ...dec7, rows: dec7.rows.map((r) => ({ ...r, cells: rotateCols(r.cells, 1) })) };
  assert.deepEqual(htmlCheck(rotated, htmlDec7), htmlCheck(dec7, htmlDec7), "記号帯を回しても錨D の結果は 1 つも変わらない");
});

test("#901 錨D を 2025-09 には当てない —— **HTML 43 行 / PDF 18 行で、差の 25 行に説明が付く**", () => {
  const html = parseHtmlResults(txt("decision-2025-09.html"), 1);
  assert.equal(html.length, 43, "HTML の行");
  assert.equal(sep7.rows.length, 18, "PDF の行");
  // **並び順で突き合わせない**（**行数が違うので、突き合わせれば必ず全行ずれる。母数を偽装することになる**）。
  // **差の 25 行は、HTML 側が `継続審査` としている行である**——
  // **この会期では議決されておらず、賛否 PDF に載らない。**
  const onlyHtml = html.filter((h) => !sep7.rows.some((p) => strip(p.number) === strip(h.number)));
  assert.equal(onlyHtml.length, 25, "**HTML にあって PDF に無い行**");
  assert.deepEqual([...new Set(onlyHtml.map((h) => h.result))], ["継続審査", "〃"], "その 25 行の議決結果");
  assert.deepEqual(sep7.rows.filter((p) => !html.some((h) => strip(h.number) === strip(p.number))).map((p) => p.number), [], "PDF にあって HTML に無い行");
  // **その 25 行は 2025-12 の本に `376報第N号` / `376第N号` として現れ、そこで議決されている**
  // （**第376回＝令和7年9月定例会からの継続審査**。**この対応こそが「広げて初めて見えた事実」である**）。
  const carried = dec7.rows.filter((r) => /^376/.test(r.number));
  assert.equal(carried.length, 25, "**2025-12 の本の継続審査の行**（**25 行でちょうど一致する**）");
  const tail = (s: string) => strip(s).replace(/^376/, "");
  assert.deepEqual(carried.map((r) => tail(r.number)).sort(), onlyHtml.map((h) => strip(h.number)).sort(), "**番号が 25 行とも一致する**");
});

/* ============================ 使っていない物差しを、使っていないまま固定する ============================ */

test("#901 公表数（賛成者数・反対者数）は増えた本でも x を 1 件も捕まえない（**だから x の検算に使わない**）", () => {
  // **記号帯の回転は置換なので `○` と `×` の個数が変わらない**——**恒真である。**
  // **恒真であることを assert で固定する**（#912 の形。**「錨を足した」と数えないため**）。
  for (const b of ADDED) {
    let judged = 0, mismatch = 0;
    for (const r of b.pdf.rows) {
      if (!r.counts) continue;
      judged++;
      const c = rotateCols(r.cells, 1);
      if (c.filter((x) => x === "○").length !== r.counts.yes || c.filter((x) => x === "×").length !== r.counts.no) mismatch++;
    }
    assert.equal(judged, b.rows, `${b.name}: **母数**（\`counts\` のある行。0 を見て緑にならないように）`);
    assert.equal(mismatch, 0, `${b.name}: **1 列回しても 1 件も落ちない**（恒真）`);
  }
});

test("#901 公表数は **y は捕まえる**（記号帯だけを 1 行回すと落ちる）——x と役割が分かれている", () => {
  for (const b of ADDED) {
    const rows = b.pdf.rows;
    let judged = 0, mismatch = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row.counts) continue;
      judged++;
      const src = rows[(i - 1 + rows.length) % rows.length];
      if (src.cells.filter((x) => x === "○").length !== row.counts.yes || src.cells.filter((x) => x === "×").length !== row.counts.no) mismatch++;
    }
    assert.equal(judged, b.rows, `${b.name}: 母数`);
    assert.ok(mismatch > 0, `${b.name}: 1 行回転（y）で落ちた行 ${mismatch}`);
  }
  // **実測**: 2025-12 は 30 / 75、2025-09 は 6 / 18、2025-06 は 6 / 24。
  // **全会一致の行が続くと回しても数が変わらない**ので、**これだけでは y に足りない**（錨D が 100% 落とす）。
});
