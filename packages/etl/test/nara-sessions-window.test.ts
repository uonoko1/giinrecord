import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseVotePdf } from "../src/sources/local/nara/votes-pdf.ts";
import { parseSessionIndex, parseSessionPage, SESSION_INDEX_URL } from "../src/sources/local/nara/sessions.ts";
import { parseRoster } from "../src/sources/local/nara/roster.ts";
import { matchBySubsequence } from "../src/sources/local/name-match.ts";
import { legendKey } from "../src/sources/local/glyph-variants.ts";
import { defaultSessionsFor, LOCAL_TERM_DAYS, rosterWindowOf } from "../src/local-assemblies.ts";

/**
 * # 奈良: `--sessions` をどこで止めたか、なぜそこかを固定する（Issue #901）
 *
 * ## 測った母数（**2026-09-21、index の賛否 PDF 46 本をすべて取得。UA を名乗り・直列・1 秒以上間隔・46 / 46 本が HTTP 200 / 失敗 0**）
 *
 * **会期 index（`/n161/18579.html`）に会期が 32 本。** **そのうち 表決 PDF を持つのが 31 本**
 * （**令和8年9月定例会だけ 0 本＝会期中でまだ議決していない**）。**PDF は合計 46 本。**
 * **`parseVotePdf` が通るのは 10 本（22%）**——**#872 の測定を独立に再現した（同じ 10 本・257 行・10,357 セル）。**
 *
 * ## **`--sessions` を 1 つずつ広げた**（**いきなり最大にしていない**。母数つき。#757）
 *
 * | `--sessions` | 足す会期 | **採決（累計）** | **セル（累計）** | **不明セル** | **未突合の氏名 / 票** | 最古の採決 | #928 | 止まる理由 |
 * |---:|---|---:|---:|---:|---|---|---|---|
 * | 1 | 令和8年6月 | 37 | 1,480 | **0** | **0 / 0** | 2026-07-02 | 鳴らない | — |
 * | 2（**今までの既定**） | ＋令和8年2月 | **125** | **5,000** | **0** | **0 / 0** | 2026-03-25 | 鳴らない | **（本番に出ていた値）** |
 * | 3 | ＋令和7年12月 | 159 | 6,360 | **0** | **0 / 0** | 2025-12-15 | 鳴らない | — |
 * | **4（新しい既定）** | **＋令和7年9月**（PDF 2 本） | **180** | **7,200** | **0** | **0 / 0** | **2025-10-09** | **鳴らない**（197 / 1,461 日） | — |
 * | 5 | ＋令和7年6月 | — | — | — | — | — | — | **`cell value "-" is not in the legend (○×議副除欠退―)`** |
 *
 * **`unknownCells` は 0 のまま、`unmatched` も 0 のまま**——**増えた 55 採決 2,200 セルは
 * 1 セルも「不明」にならず、1 人も名簿から漏れなかった。**
 * **`unmatched` が増えないのは安全である証拠ではない**（#757）——
 * **悪いのは「寄せてはいけないものを寄せた」ほうで、それは数字に出ない。**
 * **だから止める位置の根拠は、下の 2 つ（凡例の衝突・氏名の集合の不連続）から出している。**
 *
 * ## **なぜ 5 で止めたか ①**——**`-` を共有の字形表で寄せると、滋賀の凡例が壊れる**
 *
 * **奈良の 46 本で「不在」のダッシュは 3 通りの符号位置で書かれている**（全数）:
 * **`―` U+2015 が 5 本 9 個 / `－` U+FF0D が 4 本 46 個 / `-` U+002D が 1 本 5 個。**
 * **凡例はどの本でも `―` U+2015 である。**
 *
 * **`glyph-variants.ts` に足せば 令和7年6月 の 1 本（37 行）が読めるようになる**（実測）。
 * **だが足してはいけない。** **同じ符号位置が、議会ごとに違う意味の鍵として使われているためである:**
 *
 * | 符号位置 | 奈良の凡例 | 滋賀の凡例 | 三重・宮城の凡例 |
 * |---|---|---|---|
 * | `-` U+002D | （無い。セルには 5 個出る） | **`欠席`**（`Kg220_240424-sanpi.pdf`） | （無い） |
 * | `－` U+FF0D | （無い。セルには 46 個出る） | （無い） | **`不在` / `議場に不在`** |
 * | `―` U+2015 | **`不在（除斥、欠席及び表決を棄権した場合を除く）`** | （無い） | （無い） |
 *
 * **`-` → `―` に寄せると、滋賀の凡例から `-` が引けなくなる**（下のテストで実測）。
 * **`－` → `―` に寄せると、本番 `data/` に既に出ている 92 票が「凡例に無い」になる**
 * （**pref-32 が 81 票・pref-24 が 6 票・pref-04 が 5 票。母数 81,534 票**。下のテストで数えた）。
 * **`index.ts` は例外を握り潰さないので、その議会の ETL がまるごと止まる。**
 *
 * **これは #674 が扱う「見た目が同じ別コードポイント」ではない。**
 * **`〇` U+3007 / `○` U+25CB は読み手に区別が付かないが、
 * `-` が「欠席」か「不在」かは PDF ごとの凡例が決めており、字形からは決まらない。**
 * **寄せれば「別の意味の記録が出る」側に落ちる**（#569）。
 * **奈良だけで寄せる道もあるが、それは #674 を県ごとに分岐させる設計変更で、この PR の範囲の外。**
 *
 * ## **なぜ 5 で止めたか ②**——**直しても 1 会期しか伸びない**
 *
 * **6 会期目（令和7年2月）は `page 3 row 22: "" does not start with 議第/報第/第N号` で
 * 独立に落ちる**（下のテストで実測）。**ダッシュを寄せても届くのは 5 までである。**
 *
 * ## **一般選挙の境を、一次資料だけで見た**（**選挙の日付を外から持ち込まない**）
 *
 * **読めた 10 本すべてから「その PDF に出る氏名の集合」を採った**
 * （**読めない 36 本からは採れない**——`readMembers` より先に `parseHeader` / `buildGrid` が落ちるため。
 * **徳島（#934）では凡例で落ちる本からも氏名が採れたが、奈良では採れない。正直に書く**）:
 *
 * | 議決日 | 氏名 | 1 つ古い本と共通 | **IN** | **OUT** |
 * |---|---:|---:|---:|---:|
 * | 2026-07-02 | 40 | 39 | 1（`髙清友`） | 1（`芦󠄀髙清友`） ← **同じ議員の字が落ちただけ** |
 * | 2026-03-25 / 2025-12-15 / 2025-10-24 | 40 | 40 | **0** | **0** |
 * | 2025-10-09 | 40 | 40 | 0 | 1（清水勉） |
 * | **2024-10-23** | **41** | **24** | **17** | **17** ← **ここが一般選挙の境** |
 * | 2022-10-24 / 2022-10-12 / 2022-07-01 | 41 | 41 | 0 | 0 |
 *
 * **5 人以上の入れ替わりは、9 回の移り変わりのうち 1 か所だけ**（議員数も 40 ↔ 41 で変わる）。
 * **`--sessions 4` はこの境のずっと内側にある**——**境の手前の読める本は 2024-10-23 で、
 * `--sessions 8` に当たる。** **4 はその半分である。**
 *
 * ## **#928 はこの境を 1 度も捕まえない**——**余裕があることは安全ではない**
 *
 * **`--sessions 4` の最古は 2025-10-09 で `rosterAsOf` 2026-04-24 の 197 日前**（**上限 1,461 日の 13%**）。
 * **境をまたぐ `--sessions 16`（2022-10-12）でも 1,290 日で、まだ鳴らない。**
 * **止める位置を決めたのは #928 ではない。**
 *
 * ## **測れていないこと**（**確かめていないので、そう書く**）
 * - **読めない 36 本の中身は測っていない。** **どの議案が欠けているかは分からない。**
 * - **境をまたいだ 4 本（2022年）で、今の名簿に寄る氏名が 23 通りある**（下のテストで数えた）。
 *   **23 人とも再選した現職だと「思われる」が、それを確かめる一次資料を当てていない。**
 *   **氏名だけで寄せているので、同姓同名の新人がいれば別人の記録になる**（#569）。
 *   **`unmatched` にも `#928` にも出ない形である。**
 */
const fx = fileURLToPath(new URL("fixtures/nara/", import.meta.url));
const unreadable = fileURLToPath(new URL("fixtures/nara-unreadable/", import.meta.url));

/* ------------------------------------------------------------------ *
 * 既定の値そのもの
 * ------------------------------------------------------------------ */

test("#901 奈良の `--sessions` の既定は 4（他の議会の値は動かしていない）", () => {
  assert.equal(defaultSessionsFor("nara"), 4);
  // **触っていない議会**（この PR は奈良だけ。#901 は「1 県ずつ」と言っている）
  assert.deepEqual(
    ["mie", "tokushima", "kochi", "miyagi", "tottori", "shimane", "shiga", "aomori", "akita", "saga"].map((t) => [t, defaultSessionsFor(t)]),
    [["mie", 4], ["tokushima", 4], ["kochi", 5], ["miyagi", 2], ["tottori", 2], ["shimane", 2], ["shiga", 2], ["aomori", 2], ["akita", 29], ["saga", 2]],
  );
});

/* ------------------------------------------------------------------ *
 * 窓（`--sessions 4` が index のどこまでか）
 * ------------------------------------------------------------------ */

test("#901 `--sessions 4` の窓は index の上から 4 会期（PDF は 5 本。令和7年9月だけ 2 本）", () => {
  const index = parseSessionIndex(readFileSync(fx + "18579.html", "utf-8"), SESSION_INDEX_URL);
  // **フィクスチャ（2026-08-24 取得）は 31 会期。** **本番の index は 2026-09-21 時点で 32 会期**
  // （**令和8年9月定例会が増えた。ただし表決 PDF は 0 本で、`runNara` は飛ばす**）。
  // **フィクスチャを差し替えると `nara-sessions.test.ts` / `nara-run.test.ts` の index[0] が動く**ので、
  // **ここでは差し替えず、「増えた 1 本は窓に入らない」ことだけを事実として書く。**
  assert.equal(index.length, 31, "index の会期の本数（母数。#757）");
  assert.deepEqual(index.slice(0, 4).map((s) => s.sessionId), ["2026-06", "2026-02", "2025-12", "2025-09"]);
  // **窓の 4 会期のページから PDF が 5 本出る**（フィクスチャの 4 ページすべてを通して数える）
  const pages = [
    ["p114029.html", "2026-06", 1],
    ["p114001.html", "2026-02", 1],
    ["70511.html", "2025-12", 1],
    ["70052.html", "2025-09", 2],
  ] as const;
  let pdfs = 0;
  for (const [file, sessionId, expected] of pages) {
    const s = index.find((x) => x.sessionId === sessionId)!;
    const page = parseSessionPage(readFileSync(fx + file, "utf-8"), s.url, { sessionLabel: s.sessionLabel });
    assert.equal(page.pdfUrls.length, expected, `${sessionId}: 表決 PDF の本数`);
    assert.equal(new Set(page.pdfUrls).size, page.pdfUrls.length, `${sessionId}: 同じ PDF を 2 度数えていない`);
    pdfs += page.pdfUrls.length;
  }
  assert.equal(pdfs, 5, "**窓の中の PDF の本数**（フィクスチャの本数と一致する）");
  assert.equal(pdfs, FIXTURES.length);
});

/**
 * **`parseSessionPage` の重複除去（`if (!pdfUrls.includes(url))`）は、今のデータでは 1 度も働かない。**
 *
 * **変異で確かめた**（#520）: **その 1 行を `pdfUrls.push(url)` に置き換えても、
 * 奈良のテスト 20 件は 1 件も落ちない。** **等価変異である。**
 *
 * **落ちない理由を実測で言う**（「たぶん重複が無いから」ではなく、数えた）——
 * **2026-09-21 に会期ページ 33 本を取得し、「議員別の議案等に対する表決結果」の
 * `<a href>` を全部集めた: リンク 46 本 / 相異なる 46 本 / 重複のあるページ 0 本。**
 *
 * **だから「守っているのに落ちない」のではなく「守る対象が実在しない」。**
 * **消さない**（県が同じ PDF を 2 回貼ったときに件数が倍になるのを防ぐ）が、
 * **「この行があるから安全だ」とは数えない。**
 */
test("#901 会期ページの重複除去は今のデータでは働かない（フィクスチャ 4 ページに重複リンクが 0 本）", () => {
  const index = parseSessionIndex(readFileSync(fx + "18579.html", "utf-8"), SESSION_INDEX_URL);
  let links = 0;
  for (const [file, sessionId] of [["p114029.html", "2026-06"], ["p114001.html", "2026-02"], ["70511.html", "2025-12"], ["70052.html", "2025-09"]] as const) {
    const html = readFileSync(fx + file, "utf-8");
    const s = index.find((x) => x.sessionId === sessionId)!;
    // **生の `<a href>` を数える**（`parseSessionPage` の除去より前の数）
    const raw = [...html.matchAll(/<a[^>]+href="([^"]+\.pdf)"[^>]*>\s*議員別の議案等に対する表決結果/g)].map((m) => m[1]);
    links += raw.length;
    assert.equal(new Set(raw).size, raw.length, `${sessionId}: 生のリンクに重複がある`);
    // **除去した後と同じ本数**（除去が 1 本も減らしていない）
    assert.equal(parseSessionPage(html, s.url, { sessionLabel: s.sessionLabel }).pdfUrls.length, raw.length, `${sessionId}`);
  }
  assert.equal(links, 5, "母数（見たリンクの本数。0 本なら何も測っていない）");
});

/* ------------------------------------------------------------------ *
 * 広げた結果（フィクスチャ 5 本 = `--sessions 4` の全部）
 * ------------------------------------------------------------------ */

const FIXTURES = [
  ["18767_20251009_giinbetsu_hyoketsu.pdf", "2025-10-09", 16],
  ["18767_20251024_giinbetsu_hyoketsu.pdf", "2025-10-24", 5],
  ["18768_20251215_giinbetsu_hyoketsu.pdf", "2025-12-15", 34],
  ["20260325_giinbetsu_hyoketsu.pdf", "2026-03-25", 88],
  ["20260702_giinbetsu_hyoketsu.pdf", "2026-07-02", 37],
] as const;

const books: { name: string; pdf: Awaited<ReturnType<typeof parseVotePdf>> }[] = [];
for (const [f] of FIXTURES) books.push({ name: f, pdf: await parseVotePdf(readFileSync(fx + f)) });

test("#901 `--sessions 4` の 5 本: 180 採決 / 7,200 セル / 不明 0（`--sessions 2` は 125 / 5,000）", () => {
  assert.equal(books.length, 5);
  assert.deepEqual(books.map((b) => [b.name, b.pdf.date, b.pdf.rows.length]), FIXTURES.map((f) => [f[0], f[1], f[2]]));
  const rows = books.reduce((n, b) => n + b.pdf.rows.length, 0);
  assert.equal(rows, 180);
  assert.equal(books.reduce((n, b) => n + b.pdf.rows.length * b.pdf.members.length, 0), 7_200);
  assert.equal(books.reduce((n, b) => n + b.pdf.unknownCells, 0), 0, "**推定せず `不明` で残したセルは 0**");
  // **`--sessions 2` の 2 本だけを足すと本番の 125 / 5,000 に戻る**（増えたぶんが 55 / 2,200 だと式で残す）
  const old = books.filter((b) => b.pdf.date >= "2026-03-25");
  assert.equal(old.reduce((n, b) => n + b.pdf.rows.length, 0), 125);
  assert.equal(180 - 125, 55, "増えた採決");
  assert.equal(7_200 - 5_000, 2_200, "増えたセル");
});

test("#901 増えた 3 本は 40 人ちょうどで、名簿 40 人に 1 人残らず寄る（未突合 0）", () => {
  const roster = parseRoster(readFileSync(fx + "52534.html", "utf-8"));
  assert.equal(roster.members.length, 40, "名簿の母数");
  assert.equal(roster.asOf, "2026-04-24");
  const added = books.filter((b) => b.pdf.date < "2026-03-25");
  assert.equal(added.length, 3, "増えた本（母数が 0 なら以下は空回り。#757）");
  const matchedIds = new Set<string>();
  let cols = 0;
  let unmatched = 0;
  for (const b of added) {
    assert.equal(b.pdf.members.length, 40, `${b.name}: 列数`);
    for (const m of b.pdf.members) {
      cols++;
      const r = matchBySubsequence(m.nameText, roster.members);
      if (r.memberId === "") unmatched++;
      else matchedIds.add(r.memberId);
    }
  }
  assert.equal(cols, 120, "見た列の数（3 本 × 40）");
  assert.equal(unmatched, 0, "**寄らなかった列**");
  assert.equal(matchedIds.size, 40, "**名簿 40 人が 1 人残らず出る**（「名簿にいるのに票が無い」人が 0 人）");
  // **2 人だけ部分列一致**（`西川` ← `西川 均` / `芦󠄀髙清友` ← `芦高 清友`）。**推定で字を足していない**
  const lossy = added.flatMap((b) => b.pdf.members.filter((m) => !roster.members.some((x) => x.name.replace(/[\s　]/g, "") === m.nameText.replace(/[\s　\u{E0100}-\u{E01EF}]/gu, ""))));
  assert.deepEqual([...new Set(lossy.map((m) => m.nameText))].sort(), ["芦\u{E0100}髙清友", "西川"]);
  assert.equal(lossy.length, 6, "3 本 × 2 人");
});

test("#901 増えた 3 本に #928 は鳴らない（197 / 1,461 日）", () => {
  const roster = parseRoster(readFileSync(fx + "52534.html", "utf-8"));
  const dates = books.flatMap((b) => b.pdf.rows.map(() => ({ date: b.pdf.date })));
  assert.equal(dates.length, 180, "母数");
  const w = rosterWindowOf(roster.asOf, dates);
  assert.equal(w.first, "2025-10-09");
  assert.equal(w.last, "2026-07-02");
  assert.equal(w.daysBefore, 197);
  assert.ok(w.daysBefore <= LOCAL_TERM_DAYS, `${w.daysBefore} > ${LOCAL_TERM_DAYS}`);
  // **余裕があることは安全ではない**——**一般選挙の境をまたいでも #928 は鳴らない**（下のコメントの実測）
  const acrossElection = rosterWindowOf(roster.asOf, [{ date: "2022-10-12" }, { date: "2026-07-02" }]);
  assert.equal(acrossElection.daysBefore, 1_290);
  assert.ok(acrossElection.daysBefore <= LOCAL_TERM_DAYS, "**選挙をまたいでも鳴らない**。止める位置を決めたのは #928 ではない");
});

/* ------------------------------------------------------------------ *
 * **止めた理由 ①: `-` を共有の字形表で寄せると、別の議会の凡例が壊れる**
 * ------------------------------------------------------------------ */

test("#901 5 会期目（令和7年6月）は `-` U+002D で落ちる——凡例は `―` U+2015", async () => {
  await assert.rejects(
    () => parseVotePdf(readFileSync(unreadable + "13377_20250702_giinbetsu_hyoketsu.pdf")),
    (e: Error) => {
      assert.match(e.message, /cell value "-" is not in the legend \(○×議副除欠退―\)/);
      return true;
    },
  );
  // **符号位置で機序が分かる**（推定ではなく、文字そのものが違う）
  assert.equal("-".codePointAt(0), 0x002d, "セル側は `-` U+002D HYPHEN-MINUS");
  assert.equal("―".codePointAt(0), 0x2015, "凡例側は `―` U+2015 HORIZONTAL BAR");
});

test("#901 6 会期目（令和7年2月）は別の理由で落ちる——`-` を直しても 1 会期しか伸びない", async () => {
  await assert.rejects(
    () => parseVotePdf(readFileSync(unreadable + "13378_20250325_giinbetsu_hyoketsu.pdf")),
    (e: Error) => {
      assert.match(e.message, /does not start with 議第\/報第\/第N号/);
      assert.doesNotMatch(e.message, /legend/, "凡例とは関係が無い（`-` の直しでは届かない）");
      return true;
    },
  );
});

/**
 * **共有の字形表（`glyph-variants.ts`）に `-` → `―` を足したら何が壊れるか。**
 *
 * **「足した版」を別ファイルで用意せず、`legendKey` の結果に同じ畳み込みを掛けて再現する**
 * （**実装を変異させて測るのではなく、「採らなかった実装を採っていたら何件間違っていたか」を数える**。
 * 作業合意の「否定的対照」）。
 */
const wouldFold = (raw: string): string => legendKey(raw).replace(/-/g, "―");

test("#901 否定的対照: `-` → `―` を共有表に足すと、滋賀の凡例から `-`（欠席）が引けなくなる", async () => {
  // **一次資料**: 滋賀 `Kg220_240424-sanpi.pdf` の凡例（`shiga-votes-pdf.test.ts` が同じ値を固定している）
  const { parseVotePdf: parseShiga } = await import("../src/sources/local/shiga/votes-pdf.ts");
  const shiga = await parseShiga(readFileSync(fileURLToPath(new URL("fixtures/shiga/Kg220_240424-sanpi.pdf", import.meta.url))));
  assert.deepEqual(Object.keys(shiga.legend.votes), ["-", "議", "退"], "滋賀の凡例の鍵（母数 3）");
  assert.equal(shiga.legend.votes["-"], "欠席", "**同じ `-` U+002D が滋賀では「欠席」**");
  // **今**: 引ける
  assert.ok(legendKey("-") in shiga.legend.votes, "今の `legendKey` は `-` をそのまま返す");
  // **足した後**: 引けない ＝ 例外 ＝ 滋賀の ETL が止まる
  assert.ok(!(wouldFold("-") in shiga.legend.votes), "**足すと滋賀の凡例から外れる**");
  // **奈良では逆**（足せば引けるようになる）——**同じ符号位置が 2 つの意味を持つ、という形をここで固定する**
  const nara = books[0].pdf.legend.votes;
  assert.ok(!(legendKey("-") in nara), "今の奈良: `-` は凡例に無い（例外）");
  assert.ok(wouldFold("-") in nara, "足した後の奈良: 引ける");
  assert.equal(nara[wouldFold("-")], "不在（除斥、欠席及び表決を棄権した場合を除く）");
  assert.notEqual(shiga.legend.votes["-"], nara[wouldFold("-")], "**同じ字が議会ごとに違う意味**（字形の揺れではない）");
});

test("#901 否定的対照: `－` U+FF0D → `―` を共有表に足すと、本番に出ている 92 票が凡例から外れる", async () => {
  // **本番 `data/` を読み直して数える**（#865 と同じ層。**推測ではない**）
  const { readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const DATA = fileURLToPath(new URL("../../../data/assemblies/", import.meta.url));
  const foldFF0D = (raw: string): string => legendKey(raw).replace(/－/g, "―");
  let total = 0;
  const brokenPerAssembly = new Map<string, number>();
  for (const a of readdirSync(DATA, { withFileTypes: true })) {
    if (!a.isDirectory()) continue;
    const dir = join(DATA, a.name, "rollcalls");
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    // その議会が実際に使っている凡例（本番の票の原文から作る）
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name !== "index.json" && e.name.endsWith(".json")) files.push(p);
      }
    };
    walk(dir);
    const rcs = files.map((f) => JSON.parse(readFileSync(f, "utf-8")) as { votes?: { value: { raw: string; legend: string } }[] });
    const legend = new Set<string>();
    for (const rc of rcs) for (const v of rc.votes ?? []) legend.add(legendKey(v.value.raw));
    let broken = 0;
    for (const rc of rcs) for (const v of rc.votes ?? []) { total++; if (!legend.has(foldFF0D(v.value.raw))) broken++; }
    if (broken) brokenPerAssembly.set(a.name, broken);
  }
  assert.ok(total > 50_000, `母数が小さすぎる（${total} 票）。data/ が無いなら、この検算は空回りしている（#757）`);
  assert.deepEqual(Object.fromEntries([...brokenPerAssembly].sort()), { "pref-04": 5, "pref-24": 6, "pref-32": 81 });
  assert.equal([...brokenPerAssembly.values()].reduce((a, b) => a + b, 0), 92, "合計（母数 " + total + " 票）");
  // **奈良（pref-29）は 0**——**壊すのは奈良ではなく、他の 3 議会である**
  assert.equal(brokenPerAssembly.get("pref-29"), undefined);
});

/* ------------------------------------------------------------------ *
 * **止めた理由 ②: 一般選挙の境**（**選挙の日付を外から持ち込まない**）
 * ------------------------------------------------------------------ */

/**
 * **読める 10 本から採った「その PDF に出る氏名の集合」**（**2026-09-21 実測**）。
 * **空白と異体字セレクタを落として比べる**（`芦󠄀髙清友` ↔ `芦髙清友`）。
 * **`--sessions 4` に入るのは上の 5 本だけ**で、残り 5 本は窓の外にある。
 */
const NAME_SETS: { date: string; sessions: number; names: number; in: number; out: number }[] = [
  { date: "2026-07-02", sessions: 1, names: 40, in: 1, out: 1 },
  { date: "2026-03-25", sessions: 2, names: 40, in: 0, out: 0 },
  { date: "2025-12-15", sessions: 3, names: 40, in: 0, out: 0 },
  { date: "2025-10-24", sessions: 4, names: 40, in: 0, out: 0 },
  { date: "2025-10-09", sessions: 4, names: 40, in: 0, out: 1 },
  { date: "2024-10-23", sessions: 8, names: 41, in: 17, out: 17 },
  { date: "2022-10-24", sessions: 16, names: 41, in: 0, out: 0 },
  { date: "2022-10-12", sessions: 16, names: 41, in: 0, out: 0 },
  { date: "2022-07-01", sessions: 17, names: 41, in: 0, out: 0 },
];

test("#901 一般選挙の境は 9 回の移り変わりのうち 1 か所だけ（IN 17 / OUT 17）", () => {
  const big = NAME_SETS.filter((s) => s.in >= 5 || s.out >= 5);
  assert.equal(big.length, 1, "5 人以上の入れ替わりが出る境");
  assert.deepEqual(big[0], { date: "2024-10-23", sessions: 8, names: 41, in: 17, out: 17 });
  // **他の 8 回は 0〜1 人**（任期中の辞職の規模）
  assert.deepEqual([...new Set(NAME_SETS.filter((s) => s !== big[0]).flatMap((s) => [s.in, s.out]))].sort(), [0, 1]);
  // **`--sessions 4` はこの境のずっと内側**（境の手前の読める本は `--sessions 8` に当たる）
  assert.equal(defaultSessionsFor("nara"), 4);
  assert.ok(big[0].sessions > defaultSessionsFor("nara"), "境は既定の外にある");
  assert.equal(NAME_SETS.filter((s) => s.sessions <= 4).length, 5, "既定の窓に入る本（フィクスチャの本数と一致）");
  assert.deepEqual(NAME_SETS.filter((s) => s.sessions <= 4).map((s) => s.date).sort(), books.map((b) => b.pdf.date).sort());
});

test("#901 フィクスチャ 5 本の氏名の集合は、上の表と 1 件も食い違わない（表が古びたら落ちる）", () => {
  const norm = (s: string) => s.replace(/[\s　\u{E0100}-\u{E01EF}]/gu, "");
  const byDate = new Map(books.map((b) => [b.pdf.date, new Set(b.pdf.members.map((m) => norm(m.nameText)))]));
  for (const s of NAME_SETS.filter((x) => x.sessions <= 4)) {
    const set = byDate.get(s.date);
    assert.ok(set, `${s.date} の本`);
    assert.equal(set.size, s.names, `${s.date}: 氏名の数`);
  }
  // **新しい順に並べて、1 つ古い本との差を数え直す**（表の IN / OUT を実データから再現する）
  const sorted = [...books].sort((a, b) => (a.pdf.date < b.pdf.date ? 1 : -1));
  for (let i = 0; i + 1 < sorted.length; i++) {
    const cur = new Set(sorted[i].pdf.members.map((m) => norm(m.nameText)));
    const prev = new Set(sorted[i + 1].pdf.members.map((m) => norm(m.nameText)));
    const expected = NAME_SETS.find((s) => s.date === sorted[i].pdf.date)!;
    assert.equal([...cur].filter((n) => !prev.has(n)).length, expected.in, `${sorted[i].pdf.date}: IN`);
    assert.equal([...prev].filter((n) => !cur.has(n)).length, expected.out, `${sorted[i].pdf.date}: OUT`);
  }
});

/**
 * **境をまたいだらどうなるか**——**「寄らない」ではなく「23 人ぶん寄る」。**
 *
 * **2022 年の 4 本（72 行 / 2,952 票）を今の名簿に当てると、56.1% が寄る。**
 * **寄った 23 人は再選した現職だと思われるが、確かめていない**——
 * **氏名だけで寄せているので、同姓同名の新人がいれば別人の記録になる**（#569）。
 * **`unmatched` にも #928 にも出ない。** **これが「広げてはいけない」の本体である。**
 *
 * **フィクスチャに 2022 年の本を入れていないので、ここでは数だけを残す**
 * （**入れると 1MB 増え、かつ「本番に出ない本」をリポジトリに置くことになる**）。
 */
test("#901 境をまたぐと 56.1% の票が今の名簿に寄る——`unmatched` には出ない（実測の数だけ残す）", () => {
  // **2026-09-21 実測**（`13389_r041024` / `13389_r041012` / `13390_r040701` / `13390_r040622`）
  const measured = { rows: 72, cells: 2_952, matched: 1_656, unmatched: 1_296, matchedNames: 23 };
  assert.equal(measured.matched + measured.unmatched, measured.cells, "母数の検算（#757）");
  assert.equal(Math.round((measured.matched / measured.cells) * 1000) / 10, 56.1);
  // **寄った 23 人には `candidates` が付かない**（同姓同名がいないため）ので、
  // **「迷った」という痕跡すら残らない。** **`unmatched` が 0 でも安全ではない、の具体例**
  assert.ok(measured.matchedNames > 0, "寄った氏名が 0 なら、この警告は成り立たない");
  assert.ok(defaultSessionsFor("nara") < 16, "既定はこの 4 本（`--sessions 16` 以上）に届かない");
});
