import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseVotePdf, type VotePdf } from "../src/sources/local/kochi/votes-pdf.ts";
import { parseChairs, chairOn, type Chair } from "./kochi-chairman.ts";

/**
 * # **錨E（x）: 会派の帯 ⇔ 記号帯 —— 2026-02 の 81 行を `除` 1 セルから降ろす**（Issue #913）
 *
 * ## 何が薄かったか（**#913 / #906 が測って残した状態**）
 *
 * **高知の本番は `--sessions 5`（#937）で 5 本・221 行。** **そのうち `0802.pdf`（令和8年2月）の
 * 81 行だけ、x の守りが `除` **1 セル** に乗っている:**
 *
 * | 本 | 行 | 錨A（`議` ⇔ 歴代議長） | 錨B（`除` ⇔ 件名の（○○議員）） |
 * |---|---:|---|---|
 * | `080710.pdf`（令和8年6月） | 23 | **23/23・全回転で落ちる** | `除` **0 セル** → 母数 0 |
 * | **`0802.pdf`（令和8年2月）** | **81** | **81 行すべてが議長交代の当日。`−1` が 0/81（穴）** | **`除` 1 セル**（これだけが `−1` を塞ぐ） |
 * | `0712.pdf`（令和7年12月） | 75 | **75/75・全回転で落ちる** | `除` **0 セル** → 母数 0 |
 * | `0709.pdf`（令和7年9月） | 18 | **18/18・全回転で落ちる** | `除` **0 セル** → 母数 0 |
 * | `0706.pdf`（令和7年6月） | 24 | **24/24・全回転で落ちる** | `除` **0 セル** → 母数 0 |
 *
 * **`除` は 5 本 7,881 セルで 1 個だけ**（**#937 が「広げても増えない」と実測済み**）。
 *
 * ## **#906 / #913 が試して採れなかったもの**（**同じ道を通らないために、ここに写す**）
 *
 * | 試した一次資料 | なぜ駄目か |
 * |---|---|
 * | 賛否 PDF 自身の議決日・議事の順 | **81 行の議決日が全部 `R8.3.24`。議長選挙の行が無い** |
 * | 会期詳細ページ / 議長ページ | **就任日までで、その日の何番目の議事かが無い** |
 * | こうち県議会だより 第109号 | **8 ページで文字アイテム 9 個＝文字層が無い** |
 * | 会議録 | **県ページに「欠席」0 回。本体は別ドメインの検索システム** |
 * | `欠`（欠席） | **本番 5 本に 0 セル**（下で数える） |
 * | `退`（退席） | **凡例にもセルにも無い**（下で数える） |
 * | 12月定例会の 15 本を読めるようにする | **#937 が `--sessions 5` で 3 会期増やしたが、`除` は 1 つも増えなかった** |
 * | 錨C（名簿 ⇔ 列の氏名・会派、#912） | **記号帯の回転に対して恒真（0/36）。x の守りにならない** |
 *
 * ## **この PR が足すもの: どれとも違う**——**外部の一次資料を 1 つも使わない**
 *
 * **上の 8 つはすべて「PDF の外に手がかりを探す」道だった。** **錨E は PDF の中で閉じる。**
 *
 * **高知の賛否 PDF には帯が 3 つある**（`votes-pdf.ts` が別々の y 帯から読む）:
 *
 * 1. **会派の見出しの帯**（`grid.groups`。`groupBottom` より上。`自由民主党` が 20 列ぶん横に伸びる）
 * 2. **氏名の帯**（`bodyTop` 〜 `groupBottom`。縦書きの氏名）
 * 3. **記号の帯**（`bodyTop` より下。行ごとの `○ × 議 除`）
 *
 * **錨A・錨B・錨C はどれも「記号帯 ⇔ PDF の外」か「氏名帯 ⇔ PDF の外」だった。**
 * **錨E は「記号帯 ⇔ 会派の見出しの帯」である**——**PDF の中の 2 つの帯を互いに突き合わせる。**
 *
 * **主張はこうである: 同じ会派の列は、同じ議案で ○ と × に割れない。**
 * **これは推測ではなく、5 本 221 行で 1 件の例外も無い実測である**（下で固定する）。
 *
 * ## **測った結果**（下の各テストが数字ごと固定する）
 *
 * | 本 | 行 | **無改造で割れた行** | **記号帯を回した時に割れた行**（全回転） |
 * |---|---:|---:|---|
 * | `0802.pdf`（2026-02） | **81** | **0** | **`1〜35` の 35 回転すべてで 4 行以上**（`26`:4 / `30`:6 / 他 33 通りは 9） |
 * | `080710.pdf`（2026-06） | 23 | **0** | 35 回転すべてで 5 以上（`26`:5 / `30`:5 / 他 33 通りは 6） |
 * | `0712.pdf`（2025-12） | 75 | **0** | 34 回転すべてで 7 以上（`25`:7 / 他 33 通りは 10） |
 * | `0709.pdf`（2025-09） | 18 | **0** | 35 回転すべてで 1 以上（`25`:1 / 他 34 通りは 3） |
 * | `0706.pdf`（2025-06） | 24 | **0** | 35 回転すべてで 3 |
 *
 * **`−1`（＝ `35` 回転）は 2026-02 で 9 行落ちる。** **これが #913 の穴である。**
 * **`除` 1 セルの隣に、9 行ぶんの別の根拠が並んだ。**
 *
 * ## **正直に書く: これは「81 行を判定できる錨」ではない**
 *
 * **81 行のうち、この錨が何かを言えるのは 9 行だけである**（**残る 72 行は全会一致なので、
 * どう回しても割れない**）。 **「81 行が守られた」とは書かない。**
 *
 * **だが x の守りとしてはそれで足りる**——**記号帯のずれは表ぜんたいに掛かるので、
 * 1 行でも捕まえれば本ごと落ちる。** **母数 81 行のうち 9 行が「口を利く」という形である。**
 * **下では判定できた行（9）と、口を利かなかった行（72）の両方を数えて置く**（#757）。
 *
 * ## **使っていない物差し**（#891 / #911 / #569）
 *
 * - **「半セル未満」を根拠にしていない**（**高知ではずらしたほうが割合が高かった**）。
 * - **公表数との突き合わせを使っていない**（**回転は置換なので ○ と × の個数が変わらない**）。
 * - **「回転で落ちる行数が多いほど強い」とは読まない**（#911）——
 *   **「無改造で 0」と「回すと落ちる」を別々の assert に置いてある。**
 * - **推測で議員を紐づけていない**（#569）。**OCR を使っていない。氏名を読み直していない。**
 */

const fx = (n: string): Buffer => readFileSync(new URL(`./fixtures/kochi/${n}`, import.meta.url));
const txt = (n: string): string => fx(n).toString("utf-8");
const strip = (s: string): string => s.replace(/[\s　]/g, "").normalize("NFKC");

/** 記号帯だけを `rot` 列**回す**（端から落ちた記号は反対の端に戻る。**ずらしではない**）。 */
const rotateCols = (cells: readonly string[], rot: number): string[] =>
  rot === 0 ? [...cells] : cells.map((_, i) => cells[(i - rot + cells.length * 1000) % cells.length]);

/**
 * **錨E**: 同じ会派の列に ○ と × が混ざった行を数える。
 *
 * - **`judged`** … その行で「口を利いた」行（**○ と × が両方出る行**。全会一致の行は何も言わない）
 * - **`split`** … **同じ会派の中で ○ と × に割れた行**（**無改造では 0 であるべき**）
 * - **`silent`** … 口を利かなかった行（**母数の残り。#757**）
 *
 * **`議` `除` `欠` `－` は数に入れない**——**この錨は ○ と × だけを見る。**
 * **そうしないと「`議` が別の会派の列に回ってきた」が混ざり、○/× の話でなくなる。**
 */
function blocCheck(pdf: VotePdf, rot = 0): { judged: number; split: number; silent: number; splitRows: string[] } {
  const groups = pdf.members.map((m) => m.group);
  let judged = 0, split = 0, silent = 0;
  const splitRows: string[] = [];
  for (const row of pdf.rows) {
    const cells = rotateCols(row.cells, rot);
    const byGroup = new Map<string, Set<string>>();
    for (let i = 0; i < cells.length; i++) {
      if (cells[i] !== "○" && cells[i] !== "×") continue;
      const g = groups[i];
      if (!byGroup.has(g)) byGroup.set(g, new Set());
      byGroup.get(g)!.add(cells[i]);
    }
    // **この行に ○ と × が両方出ているか**（片方しか無い行は、どう回しても割れない＝何も言わない）
    const kinds = new Set([...byGroup.values()].flatMap((s) => [...s]));
    if (kinds.size < 2) { silent++; continue; }
    judged++;
    if ([...byGroup.values()].some((s) => s.size > 1)) { split++; splitRows.push(row.number); }
  }
  return { judged, split, silent, splitRows };
}

/** **本番に出ている 5 本**（`--sessions 5`。#937）。 */
const feb8 = await parseVotePdf(fx("0802.pdf"));
const jun8 = await parseVotePdf(fx("080710.pdf"));
const dec7 = await parseVotePdf(fx("0712.pdf"));
const sep7 = await parseVotePdf(fx("0709.pdf"));
const jun7 = await parseVotePdf(fx("0706.pdf"));

const BOOKS: { name: string; pdf: VotePdf; rows: number; members: number }[] = [
  { name: "0802.pdf（令和8年2月）", pdf: feb8, rows: 81, members: 36 },
  { name: "080710.pdf（令和8年6月）", pdf: jun8, rows: 23, members: 36 },
  { name: "0712.pdf（令和7年12月）", pdf: dec7, rows: 75, members: 35 },
  { name: "0709.pdf（令和7年9月）", pdf: sep7, rows: 18, members: 36 },
  { name: "0706.pdf（令和7年6月）", pdf: jun7, rows: 24, members: 36 },
];

/* ======================= 1. 母数を先に固定する（#757） ======================= */

test("#913 母数: 本番の 5 本は 221 行 / 7,881 セル、`除` は全部で 1 セルしか無い", () => {
  for (const b of BOOKS) {
    assert.equal(b.pdf.rows.length, b.rows, `${b.name} の行`);
    assert.equal(b.pdf.members.length, b.members, `${b.name} の議員の列`);
    assert.equal(b.pdf.unknownCells, 0, `${b.name} の不明セル`);
    for (const r of b.pdf.rows) assert.equal(r.cells.length, b.members, `${b.name} ${r.number}: セル数`);
  }
  assert.equal(BOOKS.reduce((a, b) => a + b.rows, 0), 221, "本番の採決（#937 の 221）");
  assert.equal(BOOKS.reduce((a, b) => a + b.rows * b.members, 0), 7_881, "本番のセル");

  // **`除` は 5 本で 1 セル**（2026-02 の 下村勝幸）——**#937 が広げても増えなかったことの再確認。**
  const joseki = BOOKS.map((b) => b.pdf.rows.flatMap((r) => r.cells).filter((c) => c === "除").length);
  assert.deepEqual(joseki, [1, 0, 0, 0, 0], "本ごとの `除` のセル");

  // **#913 の表にある「`欠` は本番に 0 セル」「`退` はセルにも凡例にも無い」を、数えて固定する**
  // （**「試したが駄目だった」を、後から来た人が測り直さずに済むように**）。
  const ketsu = BOOKS.map((b) => b.pdf.rows.flatMap((r) => r.cells).filter((c) => c === "欠").length);
  assert.deepEqual(ketsu, [0, 0, 0, 0, 0], "本番の `欠`（**母数 0。錨にならない**）");
  const tai = BOOKS.map((b) => b.pdf.rows.flatMap((r) => r.cells).filter((c) => c === "退").length);
  assert.deepEqual(tai, [0, 0, 0, 0, 0], "本番の `退`");
  for (const b of BOOKS) assert.equal(Object.keys(b.pdf.legend.votes).includes("退"), false, `${b.name} の凡例に \`退\` は無い`);
});

test("#913 母数: 2026-02 の 81 行は全部が同じ議決日で、全部が議長交代の当日である（穴の在りか）", () => {
  const dates = new Set(feb8.rows.map((r) => r.dateText).filter((s) => s !== "〃" && s !== ""));
  assert.deepEqual([...dates], ["R8.3.24"], "この本の議決年月日（**1 つしか無い**）");
  const gicho: Chair[] = parseChairs(txt("chairman.html"), "歴代議長");
  assert.equal(strip(chairOn(gicho, "2026-03-24")!.name), "明神健夫", "当日の議長（後任・列18）");
  assert.equal(strip(chairOn(gicho, "2026-03-23")!.name), "三石文隆", "前日の議長（前任・列19）");
  // **PDF の `議` は 列19（前任）。`−1` 回すと 列18（後任）になり、どちらも許されるので錨A が落ちない。**
  assert.deepEqual(feb8.members.slice(17, 21).map((m) => strip(m.nameText)), ["弘田兼一", "明神健夫", "三石文隆", "畠中拓馬"]);
  for (const r of feb8.rows) assert.deepEqual(r.cells.flatMap((c, i) => (c === "議" ? [i] : [])), [19], `${r.number} の \`議\` の列`);
});

/* ======================= 2. 錨E: 無改造で 0 件（#911 の片割れ） ======================= */

test("#913 錨E: 本番 5 本 221 行のどこにも、同じ会派が ○ と × に割れた行は無い（**無改造で 0 件**）", () => {
  const perBook = BOOKS.map((b) => {
    const r = blocCheck(b.pdf);
    assert.equal(r.judged + r.silent, b.rows, `${b.name}: judged + silent が行数と合うこと`);
    assert.equal(r.split, 0, `${b.name}: 同じ会派が割れた行`);
    return r;
  });
  // **判定できた行と、口を利かなかった行の両方を出す**（#757。**「0 件」を「数えていない」と混ぜない**）
  assert.deepEqual(perBook.map((r) => r.judged), [9, 6, 10, 3, 3], "**口を利いた行**（○ と × が両方出る行）");
  assert.deepEqual(perBook.map((r) => r.silent), [72, 17, 65, 15, 21], "**何も言わない行**（全会一致）");
  assert.equal(perBook.reduce((a, r) => a + r.judged, 0), 31, "本番 221 行のうち、錨E が口を利く行");
  assert.equal(perBook.reduce((a, r) => a + r.silent, 0), 190, "残り（全会一致で、どう回しても割れない）");
});

/* ======================= 3. 錨E: 回すと落ちる（#911 のもう片割れ） ======================= */

test("#913 錨E: 2026-02 は `−1` を含む **35 通りの回転すべて** で落ちる（錨A の `−1` の穴が塞がる）", () => {
  const n = feb8.members.length;
  assert.equal(n, 36, "列の数（回転の通り数 = n − 1）");
  const got: Record<number, number> = {};
  for (let rot = 1; rot < n; rot++) {
    const r = blocCheck(feb8, rot);
    assert.equal(r.judged + r.silent, 81, `${rot} 列回転: **母数が減っていないこと**`);
    assert.ok(r.split > 0, `${rot} 列回転で落ちた行が 0 件だった（**そこが盲点になる**）`);
    got[rot] = r.split;
  }
  // **落ちた行数をそのまま固定する**（**「> 0」だけだと、分布が崩れても気づけない**）。
  // **`26` と `30` だけ少ないのは、その回転量だと大きい会派の内側に収まる列が増えるからである。**
  assert.deepEqual(got, {
    1: 9, 2: 9, 3: 9, 4: 9, 5: 9, 6: 9, 7: 9, 8: 9, 9: 9, 10: 9, 11: 9, 12: 9,
    13: 9, 14: 9, 15: 9, 16: 9, 17: 9, 18: 9, 19: 9, 20: 9, 21: 9, 22: 9, 23: 9,
    24: 9, 25: 9, 26: 4, 27: 9, 28: 9, 29: 9, 30: 6, 31: 9, 32: 9, 33: 9, 34: 9, 35: 9,
  }, "2026-02: 回転ごとに落ちた行");
  // **`−1` は `35` 回転と同じもの**（**#906 が見つけた錨A の穴は、ここで 9 行落ちる**）
  assert.equal(blocCheck(feb8, -1).split, 9, "**`−1` 回転**（#913 の穴。錨A は 0/81 だった）");
  assert.equal(blocCheck(feb8, -1).split, blocCheck(feb8, 35).split, "`−1` と `35` は同じ回転");
  // **落ちた 9 行が何かを名指しで固定する**（**別の 9 行に入れ替わったら気づける**）
  assert.deepEqual(blocCheck(feb8, -1).splitRows,
    ["第1号", "第20号", "第50号", "第54号", "第55号", "第75号", "議発第2号", "議発第3号", "議発第5号"],
    "`−1` で落ちた行の議案番号");
});

test("#913 錨E: 本番の残る 4 本も、すべての回転で落ちる（盲点が 1 つも無い）", () => {
  for (const b of BOOKS.slice(1)) {
    const n = b.pdf.members.length;
    for (let rot = 1; rot < n; rot++) {
      const r = blocCheck(b.pdf, rot);
      assert.equal(r.judged + r.silent, b.rows, `${b.name} ${rot} 列回転: 母数`);
      assert.ok(r.split > 0, `${b.name}: ${rot} 列回転で 0 件（盲点）`);
    }
  }
  // **最小値を固定する**（**「> 0」の中身。ここが 1 に落ちている本があることを隠さない**）
  const minSplit = (pdf: VotePdf): number => {
    let m = Infinity;
    for (let rot = 1; rot < pdf.members.length; rot++) m = Math.min(m, blocCheck(pdf, rot).split);
    return m;
  };
  assert.deepEqual(BOOKS.map((b) => minSplit(b.pdf)), [4, 5, 7, 1, 3], "本ごとの **最も落ちにくい回転で落ちた行**");
  // **`0709.pdf` は最小 1 行**——**18 行のうち 3 行しか口を利かず、その 1 行に乗る回転がある。**
  // **この本は錨A が 18/18 効いている**（交代当日ではない）**ので、錨E が薄くても穴にならない。**
});

/* ======================= 4. 「会派の帯」が記号帯と別物であることを示す ======================= */

test("#913 錨E の土台: 会派は PDF の **別の帯**（見出し行）から読まれていて、記号帯とは独立である", () => {
  // **`votes-pdf.ts` は 会派の見出しを `groupBottom` より上の帯から、記号を `bodyTop` より下から読む。**
  // **同じ帯を 2 回読んでいるなら、この錨は自分自身と突き合わせているだけになる**（#911 の「恒真」）。
  // **だから「会派の並びが連続した塊になっている」ことを直に確かめる**——
  // **記号帯からは決して出てこない性質である。**
  for (const b of BOOKS) {
    const groups = b.pdf.members.map((m) => m.group);
    const runs = groups.reduce<string[]>((a, g) => (a[a.length - 1] === g ? a : [...a, g]), []);
    assert.equal(runs.length, new Set(groups).size, `${b.name}: 会派が飛び飛びになっていない（塊が会派の数と同じ）`);
  }
  // **本番 5 本の会派の並びは、どれも同じ順である**（**名簿の会派順と同じ。#912 の錨C が見ている**）
  assert.deepEqual(
    BOOKS.map((b) => b.pdf.members.reduce<string[]>((a, m) => (a[a.length - 1] === m.group ? a : [...a, m.group]), [])),
    Array(5).fill(["自由民主党", "一燈立志の会", "公明党", "自由の風", "県民の会", "日本共産党"]),
    "本ごとの会派の並び",
  );
  // **会派ごとの人数**（**2025-12 だけ 35 人で、自民 19・一燈 3 になる**）
  assert.deepEqual(BOOKS.map((b) => {
    const c = new Map<string, number>();
    for (const m of b.pdf.members) c.set(m.group, (c.get(m.group) ?? 0) + 1);
    return [...c.values()];
  }), [[20, 2, 3, 1, 4, 6], [20, 2, 3, 1, 4, 6], [19, 3, 3, 1, 3, 6], [19, 3, 3, 1, 4, 6], [19, 3, 3, 1, 4, 6]]);
});

test("#913 錨E: **会派の帯だけを回す** と、記号帯を回したのと同じだけ落ちる（向きが逆でも効く）", () => {
  // **記号帯がずれる事故と、会派の帯がずれる事故は、この錨から見ると同じ形である。**
  // **どちらか片方しか捕まえないなら、それは錨ではなく偶然である。**
  const rotateGroups = (pdf: VotePdf, rot: number): VotePdf => {
    const n = pdf.members.length;
    return { ...pdf, members: pdf.members.map((m, i) => ({ ...m, group: pdf.members[(i - rot + n * 1000) % n].group })) };
  };
  for (const rot of [1, 2, -1, -2]) {
    assert.ok(blocCheck(rotateGroups(feb8, rot)).split > 0, `会派帯を ${rot} 回した時に落ちること`);
  }
  assert.equal(blocCheck(rotateGroups(feb8, -1)).split, 9, "会派帯 `−1`（記号帯 `+1` と鏡）");
  assert.equal(blocCheck(rotateGroups(feb8, 1)).split, 9, "会派帯 `+1`（記号帯 `−1` と鏡）");
});

/* ======================= 5. **この錨が言っていないこと**（#569 / #757） ======================= */

test("#913 錨E は 81 行のうち **9 行しか口を利かない**。残る 72 行は守られていないと書く", () => {
  const r = blocCheck(feb8);
  assert.equal(r.judged, 9, "口を利いた行");
  assert.equal(r.silent, 72, "**全会一致なので何も言わない行**");
  assert.equal(r.judged + r.silent, 81, "母数");
  // **「9 行で 81 行を守った」とは書かない。** **記号帯のずれは表ぜんたいに掛かるので、
  //   1 行でも捕まえれば本ごと落ちる**——**だが「どの行も個別に検算された」ではない。**
  // **この区別は #757 の「0 件と数えていないを混ぜない」と同じ種類のことである。**
  //
  // **72 行が全会一致であることを直に確かめる**（**「口を利かない」の中身**）
  let unanimous = 0;
  for (const row of feb8.rows) {
    const kinds = new Set(row.cells.filter((c) => c === "○" || c === "×"));
    if (kinds.size < 2) unanimous++;
  }
  assert.equal(unanimous, 72, "○ だけ（または × だけ）の行");
});

test("#913 錨E の射程を数え切る: 列の 1 対入れ替え 630 通りのうち、捕まえるのは 353 通り", () => {
  // **「捕まえる」だけ書いて「捕まえない」を書かないのは #757 の逆をやることである。**
  // **36 列から 2 つ選ぶ 630 通りを全部当てて、捕まえた数と見逃した数を両方出す。**
  const swap = (pdf: VotePdf, a: number, b: number): VotePdf => ({
    ...pdf,
    rows: pdf.rows.map((r) => { const c = [...r.cells]; [c[a], c[b]] = [c[b], c[a]]; return { ...r, cells: c }; }),
  });
  const groups = feb8.members.map((m) => m.group);
  let sameTotal = 0, sameCaught = 0, crossTotal = 0, crossCaught = 0;
  const missedPairs: string[] = [];
  for (let a = 0; a < 36; a++) for (let b = a + 1; b < 36; b++) {
    const caught = blocCheck(swap(feb8, a, b)).split > 0;
    if (groups[a] === groups[b]) { sameTotal++; if (caught) sameCaught++; }
    else { crossTotal++; if (caught) crossCaught++; else missedPairs.push(`${groups[a]}/${groups[b]}`); }
  }
  assert.equal(sameTotal + crossTotal, 630, "36 列から 2 つ選ぶ通り数");

  // **(a) 同じ会派の中の入れ替えは 1 つも捕まえない**——**これがこの錨の射程の外側である。**
  // **弱点ではなく、「会派をまたぐ対応の壊れ」しか見ていないという定義そのものである。**
  // **恒真であることを assert で固定する**（#912 の形。**「足した」だけでは厚くならない**）。
  assert.equal(sameTotal, 215, "同じ会派どうしの対");
  assert.equal(sameCaught, 0, "**同じ会派の中の入れ替えは 0 / 215 —— 恒真**");

  // **(b) 会派をまたぐ入れ替えでも、62 通りは捕まえない。** **黙っていないで数える。**
  assert.equal(crossTotal, 415, "会派をまたぐ対");
  assert.equal(crossCaught, 353, "**捕まえた**（85.1%）");
  assert.equal(crossTotal - crossCaught, 62, "**見逃した**（14.9%）");

  // **見逃す 62 通りの機序**: **この本では 自由民主党・一燈立志の会・自由の風 の 3 会派が
  //   81 行すべてで同じ票を投じている**——**だから互いに入れ替えても ○/× が割れない。**
  // **「会派が違えば必ず捕まえる」ではない。実測で確かめた通りに書く。**
  const alwaysSame = ["自由民主党", "一燈立志の会", "自由の風"];
  assert.deepEqual([...new Set(missedPairs.map((s) => s.split("/").sort().join("/")))].sort(),
    ["一燈立志の会/自由の風", "一燈立志の会/自由民主党", "自由の風/自由民主党"],
    "見逃す対は、票がまったく同じ 3 会派の組み合わせだけ");
  // **その 3 会派が 81 行すべてで同票であることを、直に確かめる**（**上の説明が推測でないこと**）
  for (const row of feb8.rows) {
    const marks = new Set(row.cells.flatMap((c, i) => (alwaysSame.includes(groups[i]) && (c === "○" || c === "×") ? [c] : [])));
    assert.equal(marks.size <= 1, true, `${row.number}: 3 会派の票`);
  }
  // **だから錨E は 錨A・錨B の代わりにはならない。3 本を並べて置くこと**（#906 / #913）。
});
