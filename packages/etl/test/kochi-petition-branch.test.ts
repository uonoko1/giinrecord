import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseVotePdf } from "../src/sources/local/kochi/votes-pdf.ts";
import { parseRoster } from "../src/sources/local/kochi/roster.ts";
import { toLocalRollCalls } from "../src/sources/local/kochi/rollcalls.ts";

/**
 * # 高知の請願の**枝番**（`請第1-1号`）——**`--sessions` を広げる前に塞ぐ穴**（Issue #901 / #913）
 *
 * ## 何が問題だったか
 *
 * **`votes-pdf.ts` の番号の正規表現は `第<数字>号` が連続していることを要求していた:**
 *
 * ```ts
 * const NUMBER = /^(.*?第[0-9]+号)(.*)$/;   // "第1号" ○ / "請第1号" ○ / **"請第1-1号" ×**
 * ```
 *
 * **請願の番号には枝番が付く**（`請第1-1号` ＝ 1 号の 1）。
 * **枝番の付く議案は 12月定例会に集中している**（請願を議決する会期のため）。
 *
 * **`parseVotePdf` はこの行で例外を投げ、`runKochi` は例外を握り潰さないので会期がまるごと出ない。**
 * **`--sessions 2`（本番）は 2026 年の 2 会期しか読まないので、いまのデータには影響していない。**
 * **だが `--sessions 3` は 2025-12 会期に当たって、その場で止まる**（実測。#901）。
 *
 * ## **母数**（2026-09-20、index の賛否 PDF 65 本すべてを取得して番号の欄の原文を全数収集）
 *
 * **枝番を通した状態で数えた**（**通す前は最初の 1 個で止まるので、母数そのものが測れない**）:
 *
 * | 形（数字を N に寄せた） | 件数 | 直す前の `NUMBER` に当たるか |
 * |---|---:|---|
 * | `第N号` | **1,465** | ○ |
 * | `議発第N号` | **265** | ○ |
 * | `N報第N号` | **204** | ○（**`376報第1号`＝第376回定例会からの継続審査。県の HTML にも同じ文字列がある**） |
 * | `報第N号` | **41** | ○ |
 * | `N第N号` | **20** | ○ |
 * | **`請第N-N号`** | **36** | **×** |
 * | `請第N号` | **5** | ○ |
 * | **合計** | **2,040**（**360 種**） | **外れるのは 36 個＝1.76%** |
 *
 * **末尾に余りが出る形（`m[2] !== ""`）は 2,040 個のうち 0 個**——
 * **この正規表現が原文の一部を黙って捨てている箇所は無い。**
 *
 * **枝番のある 36 行は 9 つの 12月定例会に 4 行ずつ**
 * （2015-12 / 2016-12 / 2017-12 / 2019-12 / 2021-12 / 2022-12 / 2023-12 / 2024-12 / 2025-12）。
 *
 * ## **「枝番を捨てる」実装を採っていたら何件間違っていたか**（`docs/WORKING_AGREEMENT.md`）
 *
 * **`請第1-1号` → `請第1号` と丸める実装**（いちばん楽な直し方）**を採ると、
 * 36 行が 18 種に潰れ、36 行すべてが別の行と番号を共有する**（実測。1 会期あたり 4 行 → 2 種）。
 * **`rollcalls.ts` は同じ議決日・種別・番号の行に出た順で `-1` / `-2` を足す**ので、
 * **`請第1号-1` / `請第1号-2` という、県のどこにも書かれていない番号が出る。**
 * **`-1` / `-2` は「出た順」であって県の枝番ではないので、**
 * **「請願 1 の 1」と「請願 1 の 2」のどちらの記録なのかが分からなくなる**（#569）。
 *
 * **この 36 行では 2 つの枝の票が 1 票も違わなかった**（実測。2025-12 と 2024-12 の 8 行を全票比較）
 * **ので、潰しても票の値は変わらない。** **壊れるのは `number` と `id`——**
 * **「正しく見えるのに、何についての記録かが違う」形である。**
 *
 * ## どう直したか
 *
 * **`NUMBER` に枝番の枝を足しただけ**（`第[0-9]+(?:-[0-9]+)?号`）。
 * **原文をそのまま `number` に入れる**——**`請第1-1号` は `請第1-1号` のまま。**
 * **区切りは `-` U+002D と `－` U+FF0D の 2 通りあるが、`numberText` は NFKC 済みなので
 * どちらもこの時点で `-` U+002D になっている**（下のテストで固定する）。
 */

const fx = (n: string): Buffer => readFileSync(new URL(`./fixtures/kochi/${n}`, import.meta.url));

/** 令和7年12月定例会（`/_files/00147774/0712.pdf`、2026-09-20 取得）。**枝番のある本。5 ページ** */
const dec7 = await parseVotePdf(fx("0712.pdf"));
/** 令和7年9月定例会（`/_files/00145978/0709.pdf`、2026-09-20 取得）。**枝番の無い本**（回帰の対照） */
const sep7 = await parseVotePdf(fx("0709.pdf"));
/** 令和8年6月定例会（本番に出ている本。**1 バイトも変わらないことを見る**） */
const jun8 = await parseVotePdf(fx("080710.pdf"));

test("#901 枝番のある本が読める（直す前は 1 行目の請願で例外になり、会期がまるごと出なかった）", () => {
  assert.equal(dec7.sessionLabel, "令和７年12月定例会");
  assert.equal(dec7.pages, 5);
  assert.equal(dec7.rows.length, 75, "行");
  assert.equal(dec7.members.length, 35, "議員の列");
  assert.equal(dec7.unknownCells, 0, "**推定せず残した不明セルは 0**");
});

test("#901 枝番は原文のまま `number` に入る（`請第1号` に丸めない・`-1` を足さない）", () => {
  const petitions = dec7.rows.filter((r) => r.kind === "請願");
  // **母数**（#757）——**4 行あることを先に固定する。1 行でも落ちたら以降の一致は空回りする**
  assert.equal(petitions.length, 4, "この本の請願の行");
  assert.deepEqual(petitions.map((r) => r.number), ["請第1-1号", "請第1-2号", "請第2-1号", "請第2-2号"]);
  // **区切りは U+002D**（PDF の原文は `－` U+FF0D だが、番号の欄は NFKC してから照合している）
  for (const r of petitions) assert.ok(r.number.includes("-"), `${r.number} の区切りが U+002D でない`);
  for (const r of petitions) assert.ok(!r.number.includes("－"), `${r.number} に U+FF0D が残っている`);
  // **件名は 2 種類しかない**（1 号の枝が 2 つ、2 号の枝が 2 つ）——**枝番を落とすと区別が消える**
  assert.equal(new Set(petitions.map((r) => r.title)).size, 2, "件名の種類");
});

test("#901 **枝番を捨てていたら 4 行が 2 種に潰れていた**（採らなかった実装の被害を数える）", () => {
  const petitions = dec7.rows.filter((r) => r.kind === "請願");
  const stripped = petitions.map((r) => r.number.replace(/(第[0-9]+)-[0-9]+号/, "$1号"));
  assert.deepEqual(stripped, ["請第1号", "請第1号", "請第2号", "請第2号"]);
  assert.equal(new Set(stripped).size, 2, "**潰れる先の種類**");
  assert.equal(stripped.length - new Set(stripped).size, 2, "**番号を別の行と共有してしまう行**");
  // **65 本の全数では 36 行が 18 種に潰れる**（`.measure/901d/`。**この本の 4 行はその一部**）
});

test("#901 枝番の 4 行は、別々の採決として別々の id を持つ（票の値は同じでも記録は別）", () => {
  const roster = parseRoster(fx("member-categories.html").toString("utf-8"));
  const { rollCalls } = toLocalRollCalls([{ pdf: dec7, pdfUrl: "https://gikai.pref.kochi.lg.jp/_files/00147774/0712.pdf" }], roster.members, {
    sessionId: "2025-12",
    sessionLabel: "令和７年12月定例会",
  });
  assert.equal(rollCalls.length, 75);
  assert.equal(new Set(rollCalls.map((r) => r.id)).size, 75, "**id が 1 つも衝突しない**");
  const petitions = rollCalls.filter((r) => r.kind === "請願");
  assert.deepEqual(petitions.map((r) => r.id), [
    "pref-39-2025-12-20251219-請願-請第1-1号",
    "pref-39-2025-12-20251219-請願-請第1-2号",
    "pref-39-2025-12-20251219-請願-請第2-1号",
    "pref-39-2025-12-20251219-請願-請第2-2号",
  ]);
  // **`-1` / `-2` は `rollcalls.ts` が「同じ番号が複数出たとき」に足す接尾辞である。**
  // **枝番を潰すと、この 4 行にその接尾辞が付く**——**県の枝番と見分けが付かなくなる。**
  for (const r of petitions) assert.ok(!/号-[0-9]+$/.test(r.id), `${r.id} に「出た順」の接尾辞が付いている`);
  // **4 行の票は 1 票も違わない**（実測）——**だから潰しても票では気づけない。壊れるのは番号のほうである**
  const raws = petitions.map((r) => r.votes.map((v) => v.value.raw).join(""));
  assert.equal(new Set(raws).size, 1, "4 行の票の並びは同じ");
  assert.equal(raws[0].length, 35);
  // **「どの議員が」を固定する**（ゴールデン）。
  // **上の `raws` は「票の並び」だけを見ているので、議員の割り当てを 1 つずらしても同じ文字列になる**
  // ——**実測: `rollcalls.ts` の `pdf.members[i]` を `[(i+1)%n]` にしても `raws` は 1 文字も変わらない。**
  // **だから氏名ごとに固定する**（#569: ずれれば「別人の記録」になる）。
  assert.deepEqual(Object.fromEntries(petitions[0].votes.map((v) => [v.nameText, v.value.raw])), {
    "竹内健造": "×", "戸田宗崇": "×", "上治堂司": "×", "桑鶴太朗": "×", "土森正一": "×", "槇尾絢子": "×",
    "久保博道": "×", "上田貢太郎": "×", "今城誠司": "×", "金岡佳時": "×", "下村勝幸": "×", "田中徹": "×",
    "土居央": "×", "横山文人": "×", "西内隆純": "×", "加藤漠": "×", "弘田兼一": "×", "明神健夫": "×",
    "三石文隆": "議", "畠中拓馬": "×", "依光美代子": "×", "武石利彦": "×", "西森美和": "×", "寺内憲資": "×",
    "西森雅和": "×", "樋口秀洋": "×", "岡田竜平": "○", "田所裕介": "○", "坂本茂雄": "○", "はた愛": "○",
    "細木良": "○", "岡田芳秀": "○", "岡本和也": "○", "中根佐知": "○", "塚地佐智": "○",
  });
  // **`議` は 三石文隆**（**2025-12-19 の議長。県公表と合う**——錨A は `kochi-widened-anchors.test.ts`）
  assert.deepEqual(petitions[0].votes.filter((v) => v.value.raw === "議").map((v) => v.nameText), ["三石文隆"]);
});

test("#901 枝番の無い本は 1 文字も変わらない（枝を足しただけで既存の番号の読みは動かない）", () => {
  // **本番に出ている本**（`080710.pdf`）——**`kochi-published-data.test.ts` が固定している 23 行**
  assert.equal(jun8.rows.length, 23);
  assert.deepEqual(jun8.rows.map((r) => r.number).slice(0, 3), ["第1号", "第2号", "第3号"]);
  assert.equal(jun8.rows[jun8.rows.length - 1].number, "議発第12号");
  // **枝番の無い本の番号に `-` は 1 つも出ない**
  assert.deepEqual(jun8.rows.filter((r) => r.number.includes("-")), []);
  assert.deepEqual(sep7.rows.filter((r) => r.number.includes("-")), []);
  assert.equal(sep7.rows.length, 18, "令和7年9月定例会の行");
});

test("#901 `N報第N号`（第376回からの継続審査）は原文のまま残る——枝番とは別の形である", () => {
  // **県の HTML（`/docs/2025121700019/`）にも `376報第1号` と書いてある**（2026-09-20 実測）。
  // **`376` は回次であって、正規表現が別の列から拾ってきた文字ではない**——
  // **PDF のグリフも番号の列の中（議案種別との仕切りの右）にある。**
  const carried = dec7.rows.filter((r) => /^376/.test(r.number));
  assert.equal(carried.length, 25, "**母数**（この本の第376回からの継続審査）");
  assert.deepEqual(carried.slice(0, 3).map((r) => r.number), ["376第15号", "376第16号", "376報第1号"]);
  // **枝番の枝を足しても、この形は 1 文字も変わらない**
  assert.deepEqual(carried.filter((r) => r.number.includes("-")), []);
});
