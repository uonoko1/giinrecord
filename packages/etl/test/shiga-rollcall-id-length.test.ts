import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import iconv from "iconv-lite";
import type { LocalMember } from "@seiji-kiroku/shared";
import { toLocalRollCalls } from "../src/sources/local/shiga/rollcalls.ts";
import type { VotePdf } from "../src/sources/local/shiga/votes-pdf.ts";
import { parseRoster } from "../src/sources/local/shiga/roster.ts";

/**
 * # 採決 id がファイル名の上限（255 バイト）を超える（Issue #901）
 *
 * ## 何が起きたか
 *
 * **`--sessions` を 2 → 19 に広げて `data/` を書こうとすると、`ENAMETOOLONG` で落ちた。**
 * **書きかけで止まる**ので `data/assemblies/pref-25/` が半分だけ入れ替わった状態になる
 * （`meta.json` と `unmatched.json` が消え、`rollcalls/` は一部だけ新しい。実測）。
 *
 * ## なぜ滋賀だけか
 *
 * **滋賀の PDF には議案番号の欄が無い**——**件名の欄が議案等番号を兼ねる**（`rollcalls.ts` の docblock）。
 * **だから件名が「議案の列挙」そのものになる**:
 *
 * > 議第２号、議第９号、議第10号、…、議第76号および議第77号を可決すべきものとする各委員長報告
 * > ならびに請願第２号から請願第４号まで、請願第６号および請願第７号を不採択とすべきものとする各常任委員長報告
 *
 * **id は `{assemblyId}-{sessionId}-{日付}-{件名}`** で、**ファイル名は `{id}.json`**。
 * **この 1 件で 576 バイトになる**（UTF-8。漢字 1 文字 3 バイト）。
 *
 * ## 実測（母数を出す。#757）
 *
 * | | `--sessions 2`（本番に今出ている値） | **`--sessions 19`** |
 * |---|---:|---:|
 * | 採決（母数） | 14 | **163** |
 * | **255 バイト超え** | **0** | **15（9.2%）** |
 * | 最長 | **241B**（余裕 14B） | **576B** |
 *
 * **会期ごとの超え**: `2023-09:1 / 2023-11:2 / 2024-02:2 / 2024-09:2 / 2024-11:2 / 2025-02:2 / 2025-11:2 / 2026-02:2`
 * （**8 会期。2月定例会議の委員長報告にまとまって出る**）。
 *
 * **`--sessions 2` の窓には 1 件も無いので、今まで見えていなかった。**
 * **余裕が 14 バイト（漢字 4 文字ぶん）しか無かったので、次の会期で落ちてもおかしくなかった。**
 *
 * ## どう直したか
 *
 * **id の末尾（件名の部分）を、ファイル名が 255 バイトに収まるところで切る。**
 * **切ったことが分かるように、切った id には**
 * **元の件名の SHA-256 の先頭 8 桁を `-h{8桁}` で足す**（**切り詰めで別の採決と衝突しないため**）。
 *
 * **件名そのものは `title` に原文のまま残る**——**id は「場所の名前」であって記録ではない。**
 *
 * **切らない id は 1 バイトも変えない**（**本番に今出ている 14 件の id は動かない**）。
 */

const SESSION = { sessionId: "2026-02", sessionLabel: "令和8年 2月定例会議", year: 2026, month: 2 };
const URL_ = "https://www.shigaken-gikai.jp/voices/GikaiDoc/attach/Congress/Kg000_test.pdf";

/** **本物の名簿**（ここで測るのは id の長さだけなので誰が居ても結果は変わらないが、型に合わせる） */
const roster = (): LocalMember[] => parseRoster(iconv.decode(readFileSync(new URL("./fixtures/shiga/giinlist.html", import.meta.url)), "Shift_JIS"), { asOf: "2026-09-23" }).members;

/** 件名だけを変えた最小の `VotePdf`（表の読み方はここでは測らない） */
const pdfWith = (titles: string[]): VotePdf => ({
  headingText: "３月19日議決分",
  month: 3,
  day: 19,
  legend: { votes: { "○": "賛成" }, notes: ["「○」は賛成を表す。"] },
  members: [{ nameText: "甲 野 太 郎", group: "テスト会派", seat: "1" }],
  rows: titles.map((title) => ({ page: 1, title, dateText: "3/19", result: "可決", cells: ["○"] })),
  unknownCells: 0,
  pages: 1,
});

/** 本番で実際に 576 バイトになった件名（`--sessions 19` の 2026-02。原文） */
const REAL_LONG =
  "議第２号、議第９号、議第10号、議第13号、議第15号、議第17号から議第20号まで、議第26号、議第28号、議第30号、" +
  "議第33号、議第35号、議第38号、議第40号、議第42号、議第44号、議第46号、議第48号、議第51号、議第52号、" +
  "議第54号、議第76号および議第77号を可決すべきものとする各委員長報告ならびに請願第２号から請願第４号まで、" +
  "請願第６号および請願第７号を不採択とすべきものとする各常任委員長報告";

const bytes = (s: string): number => new TextEncoder().encode(s).length;

test("#901 採決 id: ファイル名（`{id}.json`）が 255 バイトを超えない（本番で 576B になった件名）", () => {
  // **母数**（#757）——この件名が実際に長いことを先に固定する。短い件名で測っても意味が無い
  assert.ok(bytes(REAL_LONG) > 255, `件名が短い: ${bytes(REAL_LONG)}B`);
  const { rollCalls } = toLocalRollCalls([{ pdf: pdfWith([REAL_LONG]), pdfUrl: URL_ }], roster(), SESSION);
  assert.equal(rollCalls.length, 1, "母数");
  assert.ok(bytes(`${rollCalls[0].id}.json`) <= 255, `${bytes(`${rollCalls[0].id}.json`)}B: ${rollCalls[0].id}`);
  // **件名は原文のまま残る**——**id を切っても記録は削れていない**
  assert.equal(rollCalls[0].title, REAL_LONG);
});

test("#901 採決 id: 切った id には元の件名の指紋が付く（切り詰めで別の採決と衝突しない）", () => {
  // **頭が 255 バイトぶん同じで、末尾だけ違う 2 件**——**切るだけだと同じ id になる**
  const a = `${REAL_LONG}を可決`;
  const b = `${REAL_LONG}を否決`;
  const { rollCalls } = toLocalRollCalls([{ pdf: pdfWith([a, b]), pdfUrl: URL_ }], roster(), SESSION);
  assert.equal(rollCalls.length, 2, "母数");
  assert.notEqual(rollCalls[0].id, rollCalls[1].id, "切り詰めで衝突した");
  for (const rc of rollCalls) assert.ok(bytes(`${rc.id}.json`) <= 255, `${bytes(`${rc.id}.json`)}B`);
  // **指紋は件名から決まる**ので、同じ件名なら同じ指紋（並び順で変わらない＝取り直しても id が動かない）
  const again = toLocalRollCalls([{ pdf: pdfWith([b, a]), pdfUrl: URL_ }], roster(), SESSION).rollCalls;
  assert.equal(again.find((r) => r.title === a)!.id, rollCalls.find((r) => r.title === a)!.id);
  assert.equal(again.find((r) => r.title === b)!.id, rollCalls.find((r) => r.title === b)!.id);
});

test("#901 採決 id: 255 バイトに収まる id は 1 バイトも変えない（本番の 14 件は動かない）", () => {
  // **本番に今出ている最長の件名**（241B。`data/assemblies/pref-25/` の実測）
  const longest =
    "議第88号、議第89号、議第92号、議第97号、議第99号および議第102号から議第104号までを可決すべきもの、" +
    "請願第８号を採択すべきものとする各常任委員長報告";
  const short = "議第101号（人事案件）";
  const { rollCalls } = toLocalRollCalls([{ pdf: pdfWith([longest, short]), pdfUrl: URL_ }], roster(), SESSION);
  assert.equal(rollCalls.length, 2, "母数");
  // **切っていない証拠**: id の末尾が件名そのもので終わり、指紋が付いていない
  assert.equal(rollCalls[0].id, `pref-25-2026-02-20260319-${longest}`);
  assert.equal(rollCalls[1].id, `pref-25-2026-02-20260319-${short}`);
  assert.ok(!/-h[0-9a-f]{8}$/.test(rollCalls[0].id), "切っていないのに指紋が付いた");
  assert.ok(!/-h[0-9a-f]{8}$/.test(rollCalls[1].id), "切っていないのに指紋が付いた");
});

/**
 * ## **1 本の件名で測ってはいけない**（#901。**変異を当てて分かった**）
 *
 * **`REAL_LONG` 1 本だけで「文字の境で切る」を測ったら、
 * 「バイトで切る」に変異させても 4 件中 0 件しか落ちなかった**（`mutate.sh` の実測）。
 *
 * **理由は件名の中身である**——`REAL_LONG` は `議第10号` のように
 * **3 バイトの漢字と 1 バイトの ASCII 数字が混ざっている**ので、
 * **予算 240 バイトの切れ目がたまたま文字の境に当たっていた**（切っても U+FFFD が出ない）。
 *
 * **落ちなかったのは実装が正しいからではなく、fixture が弱かったからである。**
 * **だから「1 文字 3 バイトだけで埋めた件名」を足す**——
 * **予算が 3 で割り切れなければ、バイトで切ると必ず U+FFFD が出る。**
 *
 * **さらに 4 バイト文字（サロゲートペア）の件名も測る**（`𠮷` U+20BB7）。
 */
test("#901 採決 id: 切るのは文字の境（UTF-8 の途中で切らない。3 バイト文字・4 バイト文字も）", () => {
  // **予算が 3 の倍数にならないよう、3 バイト文字だけで埋めた件名**（ASCII を混ぜない）
  const kanjiOnly = "議".repeat(300);
  // **4 バイト文字（サロゲートペア）だけの件名**——**切り方を間違えやすい形**
  const surrogateOnly = "\u{20BB7}".repeat(200);
  const titles = [REAL_LONG, kanjiOnly, surrogateOnly];
  const { rollCalls } = toLocalRollCalls([{ pdf: pdfWith(titles), pdfUrl: URL_ }], roster(), SESSION);
  // **母数**（#757）——3 本とも見ている。**3 本とも実際に切られている**
  assert.equal(rollCalls.length, 3);
  for (const t of titles) assert.ok(bytes(t) > 255, `件名が短い: ${bytes(t)}B`);
  assert.equal(rollCalls.filter((rc) => /-h[0-9a-f]{8}$/.test(rc.id)).length, 3, "切られていない件名がある");

  const enc = new TextEncoder();
  for (const rc of rollCalls) {
    const id = rc.id;
    // **ファイル名が収まっている**
    assert.ok(bytes(`${id}.json`) <= 255, `${bytes(`${id}.json`)}B: ${id}`);
    // **壊れた文字（U+FFFD）が入っていない**——バイトで切ると 3 バイト文字の件名では必ずここに出る
    assert.equal(id.includes("\u{FFFD}"), false, `id に壊れた文字がある: ${id}`);
    // **往復して同じ**（バイトで切って戻すと壊れた文字が混じる形を排除する）
    assert.equal(new TextDecoder().decode(enc.encode(id)), id);
    // **孤立サロゲートが残っていない**（4 バイト文字を半分で切ると出る）
    assert.deepEqual([...id].filter((c) => c.codePointAt(0)! >= 0xd800 && c.codePointAt(0)! <= 0xdfff), [], id);
  }
  // **切った id は元の件名の頭で始まる**（別の件名に化けていない）
  const real = rollCalls.find((rc) => rc.title === REAL_LONG)!;
  assert.ok(real.id.startsWith(`pref-25-2026-02-20260319-${REAL_LONG.slice(0, 20)}`), real.id);
  // **3 バイト文字だけの件名は、予算いっぱいまで使っても余りが出る**（3 で割り切れない証拠）
  const kanji = rollCalls.find((rc) => rc.title === kanjiOnly)!;
  assert.ok(bytes(`${kanji.id}.json`) < 255, `余りが出ていない: ${bytes(`${kanji.id}.json`)}B`);
});
