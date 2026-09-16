import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseVotePdf, type VotePdf } from "../src/sources/local/nara/votes-pdf.ts";

/**
 * # 奈良: x 方向（列）と y 方向（行）の対応を測る（Issue #872）
 *
 * ## 何を測ったか（**index の 46 本すべてを取得して測った実測値。PR に全部書いてある**）
 *
 * **会期 index（`/n161/18579.html`）の `#tmp_contents` に会期が 32 本。** **4 通りの採り方が全部 32 で一致した。**
 * **その 32 ページから「議員別の議案等に対する表決結果」PDF が 46 本**（3 通りの採り方が一致。
 * **`.pdf` を全部拾うと 336 本**——**7.3 倍。混ざっているのは日程・質問通告・議決結果など別の PDF である**）。
 *
 * **46 本を取得して `parseVotePdf` に通した結果、読めたのは 10 本だけである**（**22%**）。
 * **残り 36 本は例外で落ちる**（見出しに「M月D日議決分」が無い 12 本・
 * 「議案等名」の右に「議決月日」の列がある古い様式 10 本・見出しの段を貫く縦線が 0 本 7 本・
 * 右端まで届く横罫線が 4 本未満 3 本・議案等番号が空 2 本・種別の結合セル 1 本・凡例に無い記号 1 本）。
 *
 * **本番（`data/assemblies/pref-29`）の 125 採決・5,000 セルは、この 10 本のうち 2 本から出ている**
 * （`--sessions 2` の既定で 令和8年6月・令和8年2月 の 2 会期だけを取っているため）。
 * **実測でも 2 本の行の合計はちょうど 125 行・5,000 セルで、本番と 1 件も食い違わない。**
 * **`runNara` は `parseVotePdf` の例外を握り潰さない**（コードを読んで確かめた。`try` が 1 つも無い）ので、
 * **「読めない本が黙って欠けている」のではなく「取りに行っていない」が正しい。**
 * **実測では `--sessions 4` までは全部読め**（2025-12 と 2025-09 が増えて +55 行）、
 * **`--sessions 5` で 令和7年6月 の本が例外で落ちる**（下の「U+2015 と U+002D」）。
 *
 * ## 3 本の検算と、その効き（**46 本のうち読めた 10 本・257 行・10,357 セルで実測**）
 *
 * | 壊し方 | 検算B（`議` の列 ↔ 歴代議長, **x**） | 検算E（`result` ↔ 議決結果一覧表, **y**） | 検算A（`除` ⇒ 監査委員の選任, **y**） |
 * |---|---|---|---|
 * | 無改造 | 178 判定 / **0 落ち** | 238 判定 / **0 落ち** | 2 判定 / **0 落ち** |
 * | 記号帯を 1 列回す（**x**） | 178 判定 / **178 落ち** | 238 判定 / **0 落ち** | 2 判定 / **0 落ち** |
 * | 記号帯を 2 列回す / −1 列回す | どちらも **178 / 178 落ち** | どちらも **0 落ち** | どちらも **0 落ち** |
 * | 記号帯だけを 1 行回す（**y**） | 178 判定 / **0 落ち** | 238 判定 / **0 落ち** | 2 判定 / **2 落ち** |
 * | 記号帯だけを −1 行 / 2 行回す | どちらも **0 落ち** | どちらも **0 落ち** | どちらも **2 / 2 落ち** |
 * | **議決結果の欄だけ**を 1 行ずらす | 178 判定 / **0 落ち** | 238 判定 / **36 落ち** | 2 判定 / **0 落ち** |
 * | **件名の欄だけ**を 1 行ずらす | 178 判定 / **0 落ち** | 238 判定 / **0 落ち** | 2 判定 / **2 落ち** |
 *
 * **3 本はどれも互いの代わりにならない**（#774 と同じ問い。**壊し方ごとに落ちる検算が入れ替わる**）:
 * **検算B は y を 1 件も捕まえない**（全行を同じだけ回せば `議` は同じ列に立ち続ける）。
 * **検算E は x を 1 件も捕まえない**（記号帯は `result` に触らない）。
 * **検算A は「議決結果の欄だけ」の壊れ方を捕まえない**（`除` と `title` の対しか見ていない）。
 *
 * ## 検算B が「回転で恒真にならない」のはなぜか
 * **奈良の `議` は読めた 10 本・257 行すべてでちょうど 1 つだけ立つ**（`議` が 0 個や 2 個の行は 0 行）。
 * **だが「`議` が 1 つ立つ」だけなら恒真である**——**列を回しても 1 つ立ったままだから。**
 * **だから列の中身を外の事実に結ぶ**: **`議` の列の議員名が、県が公表している歴代議長と一致するか。**
 * 一次資料: 奈良県議会「歴代正副議長一覧」PDF
 * https://www.pref.nara.lg.jp/documents/13374/r080702ichiran.pdf （**2026-09-16 取得。HTTP 200**）
 * **同じ PDF に「歴代副議長」の列が並んでいる**（左が議長・右が副議長。**代の番号が違う**——
 * **令和8年7月2日は 議長 107代 乾浩之 / 副議長 114代 中川崇**）。**議長の列だけを使うこと。**
 *
 * ## **議長選出の当日は、1 本の中に議長が 2 人いる**（**奈良に固有。実測で見つけた**）
 * **読めた 10 本のうち 2 本（2022-07-01・2026-07-02）で、`議` の列が行によって 2 つある。**
 * **どちらも「その日に新議長が選出された日」で、新議長の議案（副知事・監査委員の選任）だけ
 * 新議長の列に `議` が立つ**（**旧議長はその行では `○` を投じている**）:
 *
 * | 本 | 行 | `議` の列 | 歴代正副議長一覧 |
 * |---|---|---|---|
 * | `r040701`（2022-07-01） | 議第64号 監査委員の選任 | **岩田国夫** | **議長 103代 岩田国夫 令和4年7月1日 就任** |
 * | `r040701`（同上） | 他の 41 行 | **荻田義雄** | **議長 102代 荻田義雄 令和3年7月2日 就任** |
 * | `20260702`（2026-07-02） | 議第68号 副知事の選任・議第69号 監査委員の選任 | **乾浩之** | **議長 107代 乾浩之 令和8年7月2日 就任** |
 * | `20260702`（同上） | 他の 35 行 | **田中惟允** | **議長 106代 田中惟允 令和7年7月2日 就任** |
 *
 * **2 人目は副議長ではない**（**2026-07-02 の副議長は 中川崇、2022-07-01 の副議長は 西川 均**）。
 * **凡例には `副`「副議長が議長職務を代行した場合」があるが、257 行・10,357 セルに 1 つも現れない。**
 * **だから「新旧どちらの議長でも通す」のではなく、就任当日の 2 本（79 行）は母数から外して数えた**
 * （**残り 178 行で不一致 0**）。**外した 79 行は上の表で 1 行ずつ確かめてある。**
 *
 * ## **`nara-published-data.test.ts`（#882）と重なる部分がある**（**正直に書く**）
 * **#882 は本番 `data/` の側から「議長が 2 人いる 2 本」と「字が落ちたまま寄った氏名 2 件」を
 * 既に固定している。** **このファイルの同名の検査はそれと重なる。**
 * **重ならないのは 3 つだけである**:
 * **(1) 46 本を全部開いたこと**（#882 が見ているのは本番に出ている 2 本）、
 * **(2) `議` の列を県公表の「歴代正副議長一覧」PDF に結んだこと**
 * （**#882 は氏名を逐語で固定しており、県の公表と食い違っても落ちない**）、
 * **(3) `result` と議決日を別の一次資料「提出議案と議決結果一覧表」に結んだこと**（PR にだけ数字がある）。
 *
 * ## **測れていないこと**（#872 の担当者。**確かめていないので、そう書く**）
 * - **検算A の母数は 2 行しかない。** **`除` は 257 行のうち 2 行にしか立たない**ので、
 *   **「y が正しい」ことの証明としてはほとんど力が無い。** **落ちるのは 2 / 2 だが、2 は 2 である。**
 * - **逆向き（監査委員の選任 ⇒ `除`）は成り立たない。** **実測で 2026-03-25 議第131号
 *   「監査委員の選任について」に `除` が 1 つも無い**（`欠` 2・`議` 1・`○` 37）。
 *   **なぜ除斥が無いのかは確かめていない。**
 * - **読めない 36 本の中身は測っていない。** **どの議案が欠けているかは分からない。**
 */

const dir = fileURLToPath(new URL("fixtures/nara/", import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith(".pdf")).sort();
const books: { name: string; pdf: VotePdf }[] = [];
for (const f of files) books.push({ name: f, pdf: await parseVotePdf(readFileSync(dir + f)) });

/**
 * **奈良県議会 歴代議長**（一次資料 https://www.pref.nara.lg.jp/documents/13374/r080702ichiran.pdf 、
 * **2026-09-16 取得**）。**就任日から次の就任日の前日まで。** **PDF の議決日で引く。**
 * **ここに無い日付の本は判定外**（推定しない。#569）。
 *
 * **フィクスチャの 2 本（令和8年2月・令和8年6月 議決分）が掛かる範囲だけを写している。**
 * **範囲外の日付が来たら判定外になるので、写し漏れは「静かに母数が減る」形で効く**（#852 が三重で踏んだ形）。
 * **そのため下の `SPEAKER_DENOMINATOR` で母数そのものを固定する**（#757）。
 */
const SPEAKERS: { from: string; name: string }[] = [
  { from: "2024-07-03", name: "中野雅史" },
  { from: "2025-07-02", name: "田中惟允" },
  { from: "2026-07-02", name: "乾浩之" },
];

/**
 * **歴代副議長**（同じ PDF の右の列。**照合には使わない**）。
 * **「副議長の表を使うと落ちる」ことを測るためだけに置く**（三重 #835 で担当者が実際に取り違えた形）。
 */
const VICE_SPEAKERS: { from: string; name: string }[] = [
  { from: "2024-07-03", name: "川口延良" },
  { from: "2025-07-02", name: "藤野良次" },
  { from: "2026-07-02", name: "中川崇" },
];

/**
 * **議長が交代した当日の本で、行ごとにどちらの議長が議事を執ったか**（**一次資料で 1 行ずつ確かめた**）。
 * **`20260702_giinbetsu_hyoketsu.pdf`（令和8年6月定例会 7月2日議決分）:**
 * **議第68号「副知事の選任について」と 議第69号「監査委員の選任について」だけが新議長 乾浩之。**
 * **残り 35 行は旧議長 田中惟允。** **推定ではない——`議` の列の氏名と、
 * 歴代正副議長一覧の「107代 乾浩之 令和8年7月2日」「106代 田中惟允 令和7年7月2日」を突き合わせた。**
 */
const HANDOVER: Record<string, { date: string; newSpeakerRows: string[]; newSpeaker: string; oldSpeaker: string }> = {
  "20260702_giinbetsu_hyoketsu.pdf": {
    date: "2026-07-02",
    newSpeakerRows: ["議第68号", "議第69号"],
    newSpeaker: "乾浩之",
    oldSpeaker: "田中惟允",
  },
};

/** 氏名の比較用。空白と異体字セレクタを落とす（PDF の原文は `芦󠄀髙清友` のように IVS 付き）。 */
const norm = (s: string) => s.replace(/[\s　\u{E0100}-\u{E01EF}]/gu, "");

/** その日に在任していた議長（就任日当日はその人）。無ければ undefined。 */
function speakerOn(date: string, table: readonly { from: string; name: string }[]): string | undefined {
  const past = table.filter((s) => s.from <= date);
  return past.length ? past[past.length - 1].name : undefined;
}

/** 記号帯だけを k 列回す（ずらしではなく回転。空の列に落ちる安い理由で落とさないため）。 */
function rotateCols<T>(cells: readonly T[], k: number): T[] {
  const n = cells.length;
  return cells.map((_, i) => cells[((i - k) % n + n) % n]);
}

/** ある欄だけを k 行回す（左の欄と記号帯が食い違う形を作る）。 */
function rotateRows<T>(values: readonly T[], k: number): T[] {
  const n = values.length;
  return values.map((_, i) => values[((i - k) % n + n) % n]);
}

/* ------------------------------------------------------------------ *
 * 母数（#757）。**先に固定する。** 検算が「全部一致」でも、母数が 0 なら何も測っていない。
 * ------------------------------------------------------------------ */

/** フィクスチャ 2 本の行数（実測。本番 `data/assemblies/pref-29` の 125 採決と一致する）。 */
const ROWS_TOTAL = 125;
/** そのうち `議` がちょうど 1 つ立つ行（実測: 全部）。 */
const SPEAKER_ROWS = 125;
/** そのうち歴代議長の表で判定できる行（**議長交代の当日の 37 行を除いた 88 行**）。 */
const SPEAKER_DENOMINATOR = 88;

test("#872 母数: フィクスチャ 2 本は 125 行・5,000 セル（本番 pref-29 と同じ）", () => {
  assert.equal(books.length, 2, "フィクスチャは 2 本");
  const rows = books.reduce((n, b) => n + b.pdf.rows.length, 0);
  assert.equal(rows, ROWS_TOTAL);
  const cells = books.reduce((n, b) => n + b.pdf.rows.length * b.pdf.members.length, 0);
  assert.equal(cells, 5000);
  assert.equal(books.reduce((n, b) => n + b.pdf.unknownCells, 0), 0, "不明セルは 0");
});

test("#872 母数: `議` は全 125 行でちょうど 1 つ立つ（0 個・2 個の行は無い）", () => {
  let one = 0;
  for (const b of books) {
    for (const r of b.pdf.rows) {
      const idx = r.cells.flatMap((c, i) => (c === "議" ? [i] : []));
      assert.equal(idx.length, 1, `${b.name} ${r.number}: 議 が ${idx.length} 個`);
      one++;
    }
  }
  assert.equal(one, SPEAKER_ROWS);
});

/* ------------------------------------------------------------------ *
 * 検算B（x 方向）: `議` の列の議員 == 県が公表している歴代議長
 * ------------------------------------------------------------------ */

/** 記号帯を k 列回したときの (判定できた行, 不一致の行)。k=0 が無改造。 */
function checkSpeaker(k: number): { judged: number; mismatch: number } {
  let judged = 0;
  let mismatch = 0;
  for (const b of books) {
    const handover = HANDOVER[b.name];
    // 議長交代の当日の本は、行によって議長が違う（別のテストで 1 行ずつ確かめる）ので母数から外す
    if (handover && handover.date === b.pdf.date) continue;
    const expected = speakerOn(b.pdf.date, SPEAKERS);
    if (expected === undefined) continue; // 表に無い日付は判定外（推定しない）
    for (const r of b.pdf.rows) {
      const cells = k === 0 ? r.cells : rotateCols(r.cells, k);
      const idx = cells.flatMap((c, i) => (c === "議" ? [i] : []));
      if (idx.length !== 1) continue;
      judged++;
      if (norm(b.pdf.members[idx[0]].nameText) !== norm(expected)) mismatch++;
    }
  }
  return { judged, mismatch };
}

test("#872 検算B(x): `議` の列は歴代議長と一致する（88 / 88 行）", () => {
  const r = checkSpeaker(0);
  assert.equal(r.judged, SPEAKER_DENOMINATOR, "母数が減っていたら、この検算は空回りしている（#757）");
  assert.equal(r.mismatch, 0);
});

test("#872 検算B(x): 記号帯を 1 列・2 列・−1 列回すと、88 行すべてが落ちる", () => {
  for (const k of [1, 2, -1]) {
    const r = checkSpeaker(k);
    assert.equal(r.judged, SPEAKER_DENOMINATOR, `${k} 列回転で母数が変わった`);
    assert.equal(r.mismatch, SPEAKER_DENOMINATOR, `${k} 列回転で落ちたのは ${r.mismatch} / ${r.judged} 行`);
  }
});

test("#872 検算B(x): 歴代「副議長」の表を使うと落ちる（表を取り違えたら気づける）", () => {
  let judged = 0;
  let mismatch = 0;
  for (const b of books) {
    if (HANDOVER[b.name]?.date === b.pdf.date) continue;
    const vice = speakerOn(b.pdf.date, VICE_SPEAKERS);
    if (vice === undefined) continue;
    for (const r of b.pdf.rows) {
      const idx = r.cells.flatMap((c, i) => (c === "議" ? [i] : []));
      if (idx.length !== 1) continue;
      judged++;
      if (norm(b.pdf.members[idx[0]].nameText) !== norm(vice)) mismatch++;
    }
  }
  assert.equal(judged, SPEAKER_DENOMINATOR);
  assert.equal(mismatch, SPEAKER_DENOMINATOR, "副議長の表で一致してしまうなら、この検算は議長の表を見ていない");
});

test("#872 議長交代の当日: 2 行だけ新議長、残り 35 行は旧議長（一次資料で 1 行ずつ確かめた 37 行）", () => {
  const b = books.find((x) => x.name === "20260702_giinbetsu_hyoketsu.pdf");
  assert.ok(b, "フィクスチャ 20260702_giinbetsu_hyoketsu.pdf");
  const h = HANDOVER[b.name];
  assert.equal(b.pdf.date, h.date);
  let newRows = 0;
  let oldRows = 0;
  for (const r of b.pdf.rows) {
    const idx = r.cells.flatMap((c, i) => (c === "議" ? [i] : []));
    assert.equal(idx.length, 1);
    const who = norm(b.pdf.members[idx[0]].nameText);
    if (h.newSpeakerRows.includes(r.number)) {
      assert.equal(who, norm(h.newSpeaker), `${r.number} は新議長 ${h.newSpeaker} が議事を執った行`);
      newRows++;
    } else {
      assert.equal(who, norm(h.oldSpeaker), `${r.number} は旧議長 ${h.oldSpeaker} の行`);
      oldRows++;
    }
  }
  assert.equal(newRows, 2);
  assert.equal(oldRows, 35);
});

test("#872 議長交代の当日: 旧議長はその 2 行で `○` を投じている（`除` でも `―` でもない）", () => {
  const b = books.find((x) => x.name === "20260702_giinbetsu_hyoketsu.pdf")!;
  const h = HANDOVER[b.name];
  const old = b.pdf.members.findIndex((m) => norm(m.nameText) === norm(h.oldSpeaker));
  assert.ok(old >= 0, `${h.oldSpeaker} の列`);
  for (const num of h.newSpeakerRows) {
    const r = b.pdf.rows.find((x) => x.number === num)!;
    assert.equal(r.cells[old], "○", `${num}: 旧議長の欄`);
  }
});

/* ------------------------------------------------------------------ *
 * 検算A（y 方向）: `除`（除斥）が立つ行 ⇒ 件名が「監査委員の選任について」
 * ------------------------------------------------------------------ */

/** `除` が立つ行の数（実測: 125 行のうち 1 行。**母数は 1 しかない。弱い検算である**）。 */
const EXCLUSION_ROWS = 1;

/** 記号帯だけを k 行回したときの (判定できた行, 落ちた行)。 */
function checkExclusion(k: number): { judged: number; bad: number } {
  let judged = 0;
  let bad = 0;
  for (const b of books) {
    const rotated = k === 0 ? b.pdf.rows.map((r) => r.cells) : rotateRows(b.pdf.rows.map((r) => r.cells), k);
    for (const [i, r] of b.pdf.rows.entries()) {
      if (!rotated[i].includes("除")) continue;
      judged++;
      if (r.title !== "監査委員の選任について") bad++;
    }
  }
  return { judged, bad };
}

test("#872 検算A(y): `除` が立つ行の件名は「監査委員の選任について」（1 / 1 行）", () => {
  const r = checkExclusion(0);
  assert.equal(r.judged, EXCLUSION_ROWS, "母数。**1 行しかない。この検算は弱い**");
  assert.equal(r.bad, 0);
});

test("#872 検算A(y): 記号帯だけを 1 行・−1 行・2 行回すと落ちる", () => {
  for (const k of [1, -1, 2]) {
    const r = checkExclusion(k);
    assert.equal(r.bad, r.judged, `${k} 行回転: ${r.bad} / ${r.judged}`);
    assert.ok(r.judged > 0, `${k} 行回転で母数が 0 になった（空回り。#757）`);
  }
});

test("#872 逆向き（監査委員の選任 ⇒ `除`）は成り立たない——実測でそういう行がある", () => {
  const rows = books.flatMap((b) => b.pdf.rows.filter((r) => r.title === "監査委員の選任について"));
  assert.equal(rows.length, 2, "フィクスチャ 2 本に「監査委員の選任について」は 2 行");
  const withJo = rows.filter((r) => r.cells.includes("除"));
  assert.equal(withJo.length, 1, "そのうち `除` が立つのは 1 行だけ（なぜ片方に無いかは確かめていない）");
});

/* ------------------------------------------------------------------ *
 * 記号帯と左の欄が同じ行から読まれていること（x でも y でもない壊れ方）
 * ------------------------------------------------------------------ */

test("#872 検算B は y を 1 件も捕まえない（記号帯だけを 1 行回しても 0 / 88）", () => {
  // 記号帯だけを回したものを、そのまま検算B にかける
  let judged = 0;
  let mismatch = 0;
  for (const b of books) {
    if (HANDOVER[b.name]?.date === b.pdf.date) continue;
    const expected = speakerOn(b.pdf.date, SPEAKERS);
    if (expected === undefined) continue;
    const rotated = rotateRows(b.pdf.rows.map((r) => r.cells), 1);
    for (const cells of rotated) {
      const idx = cells.flatMap((c, i) => (c === "議" ? [i] : []));
      if (idx.length !== 1) continue;
      judged++;
      if (norm(b.pdf.members[idx[0]].nameText) !== norm(expected)) mismatch++;
    }
  }
  assert.equal(judged, SPEAKER_DENOMINATOR);
  assert.equal(mismatch, 0, "y を捕まえてしまうなら、この検算は x だけを見ていない（表の読み方を疑う）");
});

/* ------------------------------------------------------------------ *
 * 氏名が欠ける（#778 の A 型）。**推定で補わない**（#569）
 * ------------------------------------------------------------------ */

test("#872 氏名の欠落: 県自身が「JIS に無い漢字を同音類似の漢字に置き換えている」と書いている 2 人", () => {
  // 一次資料: https://www.pref.nara.lg.jp/n161/p114004.html 「議員氏名等の正確な表記」（2026-09-16 取得）
  //   「当ホームページでは、議員名の表記にあたって、JISコードに無い漢字を同音類似の漢字に置き換えています。」
  //   ホームページ上での表記: 西川 均 / 芦高 清友（正確な表記は画像でのみ示されている）
  const names = books.flatMap((b) => b.pdf.members.map((m) => m.nameText));
  // 西川 均 は 2 本とも「西川」（名が文字層に無い）
  assert.equal(names.filter((n) => n === "西川").length, 2, "`西川`（2 文字）が 2 本に 1 列ずつ");
  assert.equal(names.filter((n) => n.startsWith("西川") && n.length > 2).length, 0, "`西川均` は 1 本も無い");
  // 芦高 清友 は本によって違う: 令和8年2月は IVS 付きで 4 文字、令和8年6月は先頭の `芦󠄀` が落ちて 3 文字
  const feb = books.find((b) => b.name === "20260325_giinbetsu_hyoketsu.pdf")!;
  const jun = books.find((b) => b.name === "20260702_giinbetsu_hyoketsu.pdf")!;
  assert.ok(feb.pdf.members.some((m) => m.nameText === "芦\u{E0100}髙清友"), "令和8年2月: `芦󠄀髙清友`（芦 + U+E0100）");
  assert.ok(jun.pdf.members.some((m) => m.nameText === "髙清友"), "令和8年6月: `髙清友`（`芦󠄀` が文字層に無い）");
  assert.equal(jun.pdf.members.filter((m) => m.nameText.startsWith("芦")).length, 0);
});

test("#872 氏名の欠落: 落ちた字を推定で補っていない（`nameText` は PDF の原文のまま）", () => {
  // 「読めなかったから補う」をやると別人を作りうる（#569）。原文のままであることを固定する。
  for (const b of books) {
    for (const m of b.pdf.members) {
      assert.ok(m.nameText.length > 0);
      assert.equal(m.nameText, m.nameText.replace(/[\s　]/g, ""), "空白は詰めるが、字は足さない");
    }
  }
});

/* ------------------------------------------------------------------ *
 * 件名が長い行（#866 の島根と同じ問い。**字数は機序ではない**）
 * ------------------------------------------------------------------ */

test("#872 長い件名は連結が正しい——専決処分の報告は 1 行に内訳が並ぶ（罫線で確かめた）", () => {
  // 一次資料の座標で確かめたこと（PR に書いた）:
  //   報第19号 の行は y 614.1..711.2 の 1 行で、その中に x 139.2..422.9 だけの細い横罫線が 6 本ある
  //   （議案等名の欄の中だけの「内訳」の区切り）。表決の記号（○）はこの行に 1 段だけ（y=660.2）。
  //   つまり PDF 自身が「1 つの表決に対して件名の欄が複数行」という作りになっている。
  const jun = books.find((b) => b.name === "20260702_giinbetsu_hyoketsu.pdf")!;
  const r19 = jun.pdf.rows.find((r) => r.number === "報第19号")!;
  assert.equal(r19.title.length, 190);
  assert.ok(r19.title.startsWith("地方自治法第179条第１項の規定による専決処分の報告について"));
  assert.ok(r19.title.includes("奈良県税条例の一部を改正する条例"));
  // 1 行ぶんの表決しか無い（セル数は議員数と同じ。2 議案ぶんに割れていない）
  assert.equal(r19.cells.length, jun.pdf.members.length);
  assert.equal(r19.cells.filter((c) => c === "○").length, 39);
  assert.equal(r19.cells.filter((c) => c === "議").length, 1);
  // 125 行のうち 100 字を超えるのは 2 行だけ（実測。中央値は 25 字）
  const long = books.flatMap((b) => b.pdf.rows).filter((r) => r.title.length > 100);
  assert.deepEqual(long.map((r) => r.number).sort(), ["報第19号", "報第20号"]);
});

/* ------------------------------------------------------------------ *
 * 凡例（**凡例にあるが実物を見ていない記号を数として残す**）
 * ------------------------------------------------------------------ */

test("#872 凡例は 8 種類。うち `副` は 125 行・5,000 セルに 1 度も現れない", () => {
  for (const b of books) {
    assert.deepEqual(Object.keys(b.pdf.legend.votes), ["○", "×", "議", "副", "除", "欠", "退", "―"]);
  }
  const seen = new Set(books.flatMap((b) => b.pdf.rows.flatMap((r) => r.cells)));
  assert.ok(!seen.has("副"), "`副` が出たら、この議会の扱いを確かめ直すこと（凡例にはある）");
  // 実際に現れる記号（実測）
  assert.deepEqual([...seen].sort(), ["×", "○", "欠", "議", "退", "除"].sort());
});
