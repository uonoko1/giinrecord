import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { LocalAssemblyMeta } from "@seiji-kiroku/shared";
import { anchorReachOf, defaultSessionsFor, LOCAL_SOURCES, LOCAL_TERM_ANCHOR, sessionsShortOfAnchor, termAnchorOf } from "../src/local-assemblies.ts";

/**
 * # **既定の `--sessions` と index の実数が、同じ制約を 2 つの数で分担していた**（Issue #1273 受け入れ条件 3）
 *
 * ## 何が問題だったか
 *
 * **`LOCAL_SESSIONS_DEFAULT` の `N` は「index の新しい側から N 本」である**（どの議会の取得部も
 * `slice(0, opts.sessions)` か、それに相当する歩き方をする）。
 * **だが `N` が表そうとしている事実は「任期の内側でいちばん古い会期がどれか」であって、
 * 数ではなく会期の識別そのものである。**
 *
 * **index は新しい側に伸びる。** **会期が 1 つ公表されるたび、同じ会期の位置が 1 つ後ろにずれる。**
 * **`N` は定数なので、ずれたぶんだけ窓が任期の内側を取りこぼす。**
 *
 * **実測（2026-10-11、11 議会の index を `PoliteFetcher` で全部歩いた。`.measure/1273/`）:**
 *
 * | 議会 | index（#901 の測定時） | **index（2026-10-11）** | 既定 | **錨の位置** | **ずれ** |
 * |---|---:|---:|---:|---:|---:|
 * | 秋田 pref-05 | 154 本 | **155 本** | 29 | **30** | **1** |
 * | 青森 pref-02 | 56 会期 | **57 会期** | 14 | **15** | **1** |
 * | 滋賀 pref-25 | 80 会期 | **81 会期** | 19 | **20** | **1** |
 * | 三重 pref-24 | 30 会期 / 151 本 | **30 会期 / 152 本** | 4 | **4** | **0** |
 *
 * **三重が 0 なのは単位が「会期」だから**（1 会期に PDF が複数本ある）。
 * **本数が 151 → 152 に増えても会期は 30 のままで、錨 `r05-2` の位置は動いていない。**
 * **「index が伸びた」が常に「既定が足りなくなった」を意味するわけではない**——**単位が何かで決まる。**
 *
 * ## **この 2 つの数が矛盾することは、機械が見ていなかった**
 *
 * **`local-sessions-default.test.ts` は `defaultSessionsFor("akita") === 29` を固定している。**
 * **固定しているのは数であって、その数が表している事実ではない。**
 * **index が伸びても 29 は 29 なので、1 件も落ちない。**
 *
 * **関係式を導出して、それを機械に見せる**（#1264 / #1191 と同根）:
 *
 * ```
 * 既定の N  =  min( 錨の位置,  任期内で読める会期の数 )
 * ```
 *
 * **右辺は 2 つの上限の小さいほうである**（`anchorReachOf`）:
 *  - **錨の位置** — **これより先へ行くと一般選挙をまたぐ**（#569 の重いほう）
 *  - **任期内で読める会期の数** — **これより大きくしても何も増えない**
 *
 * **`binds` がどちらが効いているかを名指しする。** **1 つの数に畳まない**——
 * **畳むと「足りない 1」が「選挙をまたぎかけている 1」なのか
 * 「パーサを直せば届く 1」なのか、読む側に見えなくなる。**
 */

const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));
const PREFS = Object.keys(LOCAL_SOURCES).sort();

/** **本番 `data/` が在るか**（`data/` を持たない環境ではその議会を数えない。**母数に出す**） */
const hasData = (id: string): boolean => {
  try { return statSync(join(DATA, "assemblies", id, "meta.json")).isFile(); } catch { return false; }
};
const metaOf = (id: string): LocalAssemblyMeta =>
  JSON.parse(readFileSync(join(DATA, "assemblies", id, "meta.json"), "utf-8")) as LocalAssemblyMeta;

test("#1273 錨は 11 議会すべてに在る（議会を足して書き忘れたら落ちる）", () => {
  // **母数**（#757）: **議会の数**。**0 本なら何も測っていない**
  assert.equal(PREFS.length, 11, `議会 ${PREFS.length}`);
  assert.deepEqual(PREFS.filter((n) => termAnchorOf(n) === undefined), [], "**錨の無い議会**");
  assert.equal(Object.keys(LOCAL_TERM_ANCHOR).length, 11, "錨の表の行数");
  // **表に居ない名前が混ざっていない**（議会を消したのに錨だけ残っていたら落ちる）
  assert.deepEqual(Object.keys(LOCAL_TERM_ANCHOR).filter((n) => !Object.hasOwn(LOCAL_SOURCES, n)), [],
    "**`LOCAL_SOURCES` に無い名前が錨の表にある**");
  // **錨の `assemblyId` が重複していない**（2 つの議会が同じ `data/` を指していたら落ちる）
  const ids = PREFS.map((n) => termAnchorOf(n)!.assemblyId);
  assert.equal(new Set(ids).size, 11, `assemblyId の重複（${ids.join(" ")}）`);
  // **`binds` は 2 通りだけ**（**知らない値を黙って通さない**）
  assert.deepEqual([...new Set(PREFS.map((n) => termAnchorOf(n)!.binds))].sort(), ["readable", "term"], "`binds` の値");
});

/**
 * ## **関係式そのもの**: **既定の N は `min(錨の位置, 任期内で読める会期)` と一致する**
 *
 * **これが #1273 の受け入れ条件 3 の本体である。**
 * **今は 9 議会で一致しない**——**そこが「読めているのに `data/` に出ていない」ぶんである。**
 */
test("#1273 既定の N = min(錨の位置, 任期内で読める会期)（関係式。ずれていれば議会ごとに名指しする）", () => {
  const short: string[] = [];
  const over: string[] = [];
  for (const n of PREFS) {
    const a = termAnchorOf(n)!;
    const want = anchorReachOf(a);
    const got = defaultSessionsFor(n);
    if (got < want) short.push(`${n}: 既定 ${got} < 届くべき ${want}（錨 ${a.oldestInTermSessionId} は ${a.positionAt20261011} 本目 / 読める ${a.readableInTermAt20261011}、効いているのは ${a.binds}）`);
    // **大きすぎる側も見る**（**錨より先へ行くと一般選挙をまたぐ**。#569 の重いほう）
    if (got > a.positionAt20261011) over.push(`${n}: 既定 ${got} > 錨の位置 ${a.positionAt20261011}（一般選挙をまたぐ）`);
  }
  // **両側を見る**（#1256「検査は両側で判断する」）。**片側だけ見ると、
  // 「足りない」を直した拍子に「またぐ」側へ行っても気づかない**
  assert.deepEqual(over, [], "**錨より先まで取りに行っている議会**（一般選挙をまたぐ）");
  assert.deepEqual(short, [], "**既定が届くべき位置に届いていない議会**");
});

/**
 * ## **錨は `data/` で検算できる**（ネットワークに出ない）
 *
 * **`data/assemblies/{id}/meta.json` の `sessions[]` は、その ETL が実際に届いた会期である。**
 * **`binds: "term"` の議会では、錨がそこに入っていなければならない**
 * （全部読めるのだから、窓が錨に届けば `data/` に出る）。
 *
 * **`binds: "readable"` の議会では錨は `data/` に無くてよい**——
 * **錨の手前で読めなくなるので、錨の会期自身が出ないことがある。**
 */
test("#1273 `binds: \"term\"` の議会は、錨が `data/` の sessions[] に在る", () => {
  const checked: string[] = [];
  const missing: string[] = [];
  for (const n of PREFS) {
    const a = termAnchorOf(n)!;
    if (a.binds !== "term") continue;
    if (!hasData(a.assemblyId)) continue;
    checked.push(n);
    const ids = metaOf(a.assemblyId).sessions.map((s) => s.sessionId);
    if (!ids.includes(a.oldestInTermSessionId)) missing.push(`${n}: 錨 ${a.oldestInTermSessionId} が data/ の ${ids.length} 会期に無い（最古 ${ids[ids.length - 1]}）`);
  }
  // **母数**（#757）: **`binds: "term"` の議会は 5 つ**（**0 本なら何も測っていない**）
  assert.deepEqual(checked.sort(), ["akita", "aomori", "mie", "miyagi", "shiga"], `測った議会（${checked.length}）`);
  assert.deepEqual(missing, [], "**錨が `data/` に無い議会**");
});

/**
 * ## **既定の N は、`data/` が持つ会期の数より小さくない**
 *
 * **N を下げると `data/` の会期が窓から落ちる**——**これは「出していた記録を取り下げる」ことである。**
 * **`data/` のほうが多ければ、N を下げたか、誰かが `--sessions` を手で渡したかのどちらかである。**
 */
test("#1273 既定の N は `data/` の会期の数より小さくない（出した記録を窓の外に出さない）", () => {
  const rows: { name: string; def: number; published: number }[] = [];
  for (const n of PREFS) {
    const a = termAnchorOf(n)!;
    if (!hasData(a.assemblyId)) continue;
    rows.push({ name: n, def: defaultSessionsFor(n), published: metaOf(a.assemblyId).sessions.length });
  }
  // **母数**（#757）: **11 議会すべてに `data/` が在る**
  assert.equal(rows.length, 11, `母数 ${rows.length} / 11`);
  assert.deepEqual(rows.filter((r) => r.def < r.published).map((r) => `${r.name}: 既定 ${r.def} < data/ の ${r.published} 会期`), [],
    "**既定が `data/` より短い議会**");
});

/**
 * ## **`sessionsShortOfAnchor` そのもののテスト**（`data/` が無くても落ちる）
 *
 * **0 を返すだけの関数なら何も主張しない**ので、**足りている側と足りていない側の両方を測る**
 * （#1241「その数は壊れたとき動くか」）。
 */
test("#1273 `sessionsShortOfAnchor`: 足りている側と足りていない側の両方（壊れたとき動く数）", () => {
  // **秋田の 2026-10-11 の実測**（`.measure/1273/index-lengths.ts` の出力の先頭 31 本）。
  // **錨 `05516`（2023-05-16）は 30 本目**——**#901 の測定時は 29 本目だった**
  const akita = ["081007", "080703", "080615", "080609", "080319", "080227", "080213", "071219", "071208", "071031",
    "071003", "070619", "514", "430", "PDFR736", "PDFR7217", "PDFR61220", "R061101", "R061004", "R060705",
    "060319", "R060228", "060220", "051222", "051102", "051005", "050911", "050728", "050706", "05516", "050310"];
  assert.equal(akita.length, 31, "母数（歩いた本数）");
  assert.equal(akita.indexOf("05516") + 1, 30, "**錨は 30 本目**");
  // **足りていない側**: 既定 29 では錨に 1 本届かない
  assert.equal(sessionsShortOfAnchor(akita, "05516", 29), 1, "既定 29 は 1 本足りない");
  // **ちょうど届く側**: 30 なら 0
  assert.equal(sessionsShortOfAnchor(akita, "05516", 30), 0, "既定 30 で届く");
  // **余っている側は負にしない**（**余らせること自体は違反ではない**）
  assert.equal(sessionsShortOfAnchor(akita, "05516", 31), 0, "31 でも「足りない」は 0");
  // **index が 1 本伸びたら、同じ既定で「足りない」が 1 増える**（**これが #1273 の機序そのもの**）
  assert.equal(sessionsShortOfAnchor(["新しい会期", ...akita], "05516", 29), 2, "index が 1 本伸びると 1 → 2");
  // **測れなかったときは 0 を返さない**（#1241「検出器が黙っても直ったとは限らない」）
  assert.throws(() => sessionsShortOfAnchor(akita, "no-such-session", 29), /not in the index/, "錨が index に無ければ例外");
  assert.throws(() => sessionsShortOfAnchor([], "05516", 29), /index is empty/, "index が空なら例外");
});

/**
 * ## **`anchorReachOf` は小さいほうを返す**（**両方の上限を測る**）
 */
test("#1273 `anchorReachOf`: 錨の位置と読める会期の、小さいほう", () => {
  const base = { assemblyId: "pref-00", oldestInTermSessionId: "x", why: "" } as const;
  // **錨が効く側**（全部読める）
  assert.equal(anchorReachOf({ ...base, positionAt20261011: 30, readableInTermAt20261011: 30, binds: "term" }), 30);
  // **読めるかが効く側**（錨の手前で尽きる）
  assert.equal(anchorReachOf({ ...base, positionAt20261011: 14, readableInTermAt20261011: 13, binds: "readable" }), 13);
  // **読めるほうが大きい値でも、錨で止める**（**錨より先は一般選挙の向こう側**）
  assert.equal(anchorReachOf({ ...base, positionAt20261011: 4, readableInTermAt20261011: 30, binds: "term" }), 4,
    "**読める会期が多くても錨で止まる**（#569 の重いほう）");
  // **11 議会の実物でも、`binds` と「どちらが小さいか」が食い違っていない**
  for (const n of PREFS) {
    const a = termAnchorOf(n)!;
    const bindsSaysReadable = a.readableInTermAt20261011 < a.positionAt20261011;
    assert.equal(a.binds === "readable", bindsSaysReadable,
      `${n}: binds=${a.binds} だが 読める ${a.readableInTermAt20261011} / 錨 ${a.positionAt20261011}`);
  }
});

/**
 * ## **2026-10-11 の実測を逐語で残す**（**この表は「つまみ」ではない**）
 *
 * **数が減る方向に動いたら、それが「本当に読めない」のか「こちらが壊した」のかを
 * 区別した記録が要る**（#1218「期待値の表はつまみではない」）。
 * **ここに書いてある数はすべて 2026-10-11 に `PoliteFetcher` で一次資料を取って測ったものである。**
 *
 * ### **#1273 の起票時の表と食い違った 3 件**（**実測が優先する**）
 *
 * | 議会 | 起票時の (A) | **2026-10-11 の実測** | 違いの正体 |
 * |---|---:|---:|---|
 * | 奈良 pref-29 | 4 | **2** | **起票時の 4 は未確認の自己申告**（#1273 の「未測」2 件目）。**錨までの 14 会期のうち 8 会期が読めない** |
 * | 鳥取 pref-31 | 3 | **2** | **錨（令和5年5月臨時会）の PDF が 0 本**なので、読める会期は 15・16 本目の 2 つ |
 * | 徳島 pref-36 | 3 | **0** | **既定 4 が、任期内で読める 4 会期をすべて覆っている**（5 本目に PDF が無く、6 本目以降は凡例が無い） |
 *
 * **3 件とも「読めない」側の実測で減っている**（こちらが壊したのではない）——
 * **奈良の 2 本は repo が `fixtures/nara-unreadable/` に置いている同じ 2 本で、
 * 例外の文言も `nara-sessions-window.test.ts` が固定しているものと逐語で一致した**
 * （`cell value "-" is not in the legend` と `does not start with 議第/報第/第N号`）。
 *
 * ### **高知の 8 は実測で裏が取れた**（#1273 の「未測」1 件目）
 *
 * **起票時の 8 は docblock の括弧つきの記述からの数で、PDF を通していなかった。**
 * **2026-10-11 に index の 1〜16 本目を全部取って測った: 任期内 14 会期のうち 13 会期が読める。**
 * **既定 5 なので 13 − 5 = 8。** **数は合っていたが、根拠が無かったところに根拠が付いた。**
 */
test("#1273 2026-10-11 の実測: 任期内で読めるのに既定の窓の外にある会期（母数つき）", () => {
  /**
   * **`[議会名, index の長さ, #1273 の前の既定, #1273 の後の既定, 任期内で読める会期, 窓の外にあった行数]`**
   *
   * **「前」と「後」を両方持つ**——**後だけ持つと「直した」と書いてあるのに
   * 何も動いていない場合に気づけない**（#1241）。
   */
  const MEASURED: readonly [string, number, number, number, number, number][] = [
    ["shimane", 108, 5, 9, 9, 133],
    ["kochi", 65, 5, 13, 13, 357],
    ["nara", 32, 4, 6, 6, 26],
    ["tottori", 74, 11, 13, 13, 6],
    ["tokushima", 28, 4, 4, 4, 0],
    ["saga", 68, 13, 14, 14, 2],
    ["akita", 155, 29, 30, 30, 6],
    ["aomori", 57, 14, 15, 15, 8],
    ["shiga", 81, 19, 20, 20, 6],
    ["mie", 30, 4, 4, 4, 0],
    ["miyagi", 77, 11, 11, 11, 0],
  ];
  // **母数**（#757）: **11 議会すべてを測った**
  assert.equal(MEASURED.length, 11, "母数（測った議会）");
  assert.deepEqual([...MEASURED.map((r) => r[0])].sort(), PREFS, "測った議会 = LOCAL_SOURCES");
  // **この表の「任期内で読める会期」が、錨の表の `readableInTermAt20261011` と一致する**
  // （**表だけ直して実装を直さない、を塞ぐ**）
  for (const [name, , , , readable] of MEASURED) {
    assert.equal(termAnchorOf(name)!.readableInTermAt20261011, readable, `${name}: 任期内で読める会期`);
  }
  // **この表の「後の既定」が、実装の既定と一致する**（**表と実装の両方を直させる**）
  for (const [name, , , after] of MEASURED) assert.equal(defaultSessionsFor(name), after, `${name}: 直した後の既定`);
  // **直した後は、窓の外の会期が 11 議会すべてで 0**（**関係式の検算**）
  for (const [name, , , after, readable] of MEASURED) {
    const a = termAnchorOf(name)!;
    assert.equal(Math.max(0, Math.min(a.positionAt20261011, readable) - after), 0, `${name}: 窓の外の会期（既定 ${after}）`);
  }
  // **直す前は 20 会期が窓の外だった**（**動いた量を数で残す**）
  const outsideBefore = MEASURED.reduce((n, [name, , before, , readable]) => {
    const a = termAnchorOf(name)!;
    return n + Math.max(0, Math.min(a.positionAt20261011, readable) - before);
  }, 0);
  assert.equal(outsideBefore, 20, `**直す前は 20 会期が窓の外だった**（${outsideBefore}）`);
  assert.equal(MEASURED.reduce((n, r) => n + r[5], 0), 544, "**その 20 会期の行数は 544**");
  // **直す前から 0 だった議会は 3 つ**（**「全部足りなかった」ではない**）
  assert.deepEqual(MEASURED.filter((r) => r[5] === 0).map((r) => r[0]).sort(), ["mie", "miyagi", "tokushima"],
    "**直す前から既定の窓が覆い切っていた議会**");
  // **既定が動いた議会は 8 つ**（**動かなかった 3 つと合わせて 11**）
  assert.deepEqual(MEASURED.filter((r) => r[2] !== r[3]).map((r) => r[0]).sort(),
    ["akita", "aomori", "kochi", "nara", "saga", "shiga", "shimane", "tottori"], "**既定が動いた議会**");
  assert.equal(MEASURED.filter((r) => r[2] === r[3]).length, 3, "既定が動かなかった議会");
});
