import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalMember, LocalRollCall } from "@seiji-kiroku/shared";
import { localNameKey, matchByExact, matchBySubsequence, matchBySurnamePrefix } from "../src/sources/local/name-match.ts";
import { buildLocalAssembly, lossyNameMatchesOf, MIYAGI_ASSEMBLY } from "../src/local-assemblies.ts";

/**
 * **字が落ちたまま名簿に寄った氏名を、11 県すべてで `meta.lossyNameMatches` に残す**（Issue #778）。
 *
 * ## 何が問題だったか
 *
 * `lossyNameMatches`（#750 青森・#759 秋田・#768 佐賀）は **11 県中 3 県にしか無かった。**
 * **#771 が「#632 のかな比は最初から検算になっていなかった」と確定させた**ので、
 * **残り 8 県は「文字層から字が落ちて、それでも本人に寄る」機序**——
 * **#749 の機序 ②（青森で `櫛` が文字層に無く `引ユキ子` になる）**——**に対して無防備だった。**
 *
 * **そして実際に起きていた。** **本番 `data/` の 58,057 票を数えると、奈良に 2 件ある**（下の実測）。
 *
 * ## なぜ共通層（`buildLocalAssembly`）に置けるか——**名寄せの規則が決めている**
 *
 * 3 県の実装は「`nameKey(PDF の氏名) !== nameKey(名簿の氏名)` なら記録する」だった。
 * **これをそのまま 11 県に広げると鳥取で 35 人全員が鳴る**——
 * **鳥取の PDF は `○○議員`（姓だけ）で、名簿と一致しないのが正常だから**（`matchBySurnamePrefix`）。
 *
 * **だから共通層の判定は「キーが違う」ではなく「PDF の氏名が名簿の氏名の部分列で、かつ短い」**
 * **＝ 字が落ちた、にする。** これは 3 県にとって**同じ判定である**（下のテストで示す）——
 * **`matchBySubsequence` は完全一致か部分列でしか寄せないので、
 * 「寄った」かつ「キーが違う」なら、それは必ず部分列である。**
 *
 * | 名寄せ | 使う県 | 寄った上でキーが違う状態 | 「キーが違う」判定 | **「部分列で短い」判定** |
 * |---|---|---|---|---|
 * | `matchByExact` | 島根 | **起こりえない** | 常に 0 | 常に 0（**同じ**） |
 * | `matchBySubsequence` | 9 県 | **必ず部分列** | ＝部分列 | **同じ** |
 * | `matchBySurnamePrefix` | 鳥取 | 姓だけ＋`議員` | **35 人全員が鳴る** | **0**（正しく鳴らない） |
 */

const member = (id: string, name: string): LocalMember => ({
  id, assemblyId: "pref-04", name, kana: "かな", group: "会派", district: "宮城",
  profileUrl: "https://www.pref.miyagi.jp/site/kengikai/x.html", current: true, asOf: "2026-04-23",
  sourceUrl: "https://www.pref.miyagi.jp/site/kengikai/18meibo-kaiha.html", counts: { rollcalls: 0 },
});
const YES = { raw: "○", legend: "賛成", mapped: "賛成" as const };
const rollCall = (id: string, votes: LocalRollCall["votes"]): LocalRollCall => ({
  id, assemblyId: "pref-04" as LocalRollCall["assemblyId"], sessionId: "398",
  sessionLabel: "令和7年11月定例会（第398回）", date: "2025-12-17", kind: "発議案", number: id.slice(-1),
  title: "条例", result: "可決", page: 1,
  sourceUrl: "https://www.pref.miyagi.jp/documents/62682/hyouketsu071217.pdf",
  votes,
});
const build = (members: LocalMember[], rollCalls: LocalRollCall[]) => buildLocalAssembly({
  assembly: MIYAGI_ASSEMBLY, members, rollCalls,
  fetchedAt: "2026-09-13T00:00:00.000Z", rosterAsOf: "2026-04-23", sources: [],
  sessions: [{ sessionId: "398", sessionLabel: "令和7年11月定例会（第398回）", sourceUrl: "https://www.pref.miyagi.jp/site/kengikai/x.html", pdfUrl: "https://www.pref.miyagi.jp/documents/62682/hyouketsu071217.pdf", rollcalls: rollCalls.length, unknownCells: 0 }],
});

/**
 * **#749 の機序 ②**（文字層に `櫛` が無い）。**票は本人に付いたまま、事実だけを残す。**
 */
test("#778 字が落ちたまま寄った氏名が meta.lossyNameMatches に載る（票は動かない）", () => {
  const built = build(
    [member("p_04_a", "櫛󠄁引 ユキ子"), member("p_04_b", "柚木 貴光")],
    [rollCall("pref-04-398-20251217-発議案-1", [
      { memberId: "p_04_a", nameText: "引 ユキ子", group: "会派", value: YES },
      { memberId: "p_04_b", nameText: "柚木 貴光", group: "会派", value: YES },
    ])],
  );
  assert.deepEqual(built.meta.lossyNameMatches, [
    { nameText: "引 ユキ子", memberId: "p_04_a", rosterName: "櫛󠄁引 ユキ子", rollCalls: 1 },
  ]);
  // **票は本人に付いたまま**（記録を消していない。#569 の「記録が出ない」側に倒していない）
  assert.equal(built.details.find((d) => d.id === "p_04_a")?.timeline.length, 1);
  assert.equal(built.unmatched.length, 0, "unmatched には落ちない（寄っているのだから）");
});

/** **字が落ちていない議会では欄ごと出ない**（全部に付く実装になっていないこと。否定的対照） */
test("#778 否定的対照: 字が落ちていなければ meta.lossyNameMatches は省略される", () => {
  const built = build(
    [member("p_04_a", "櫛󠄁引 ユキ子"), member("p_04_b", "柚木 貴光")],
    [rollCall("pref-04-398-20251217-発議案-1", [
      // **異体字セレクタと空白の差だけでは鳴らない**（`localNameKey` が畳む。#617）
      { memberId: "p_04_a", nameText: "櫛引ユキ子", group: "会派", value: YES },
      { memberId: "p_04_b", nameText: "柚木 貴光", group: "会派", value: YES },
    ])],
  );
  assert.equal(built.meta.lossyNameMatches, undefined);
});

/**
 * **鳥取（`matchBySurnamePrefix`）で鳴らないこと。**
 * **本番 `data/assemblies/pref-31/` の 35 人全員が「名簿と一致しない」状態で寄っている**
 * （`入江議員` → `入江 誠`）。**これは壊れているのではなく、その議会の公表の形である。**
 * **「キーが違う」判定だと 35 人全員が鳴り、誰も見なくなる**（#771 が閾値 1.7 で測ったのと同じ壊れ方）。
 */
test("#778 鳥取の形（姓＋議員）では鳴らない——部分列でないから", () => {
  const built = build(
    [member("p_31_a", "入江 誠"), member("p_31_b", "浜田 一哉")],
    [rollCall("pref-04-398-20251217-発議案-1", [
      { memberId: "p_31_a", nameText: "入江議員", group: "会派", value: YES },
      { memberId: "p_31_b", nameText: "浜田一議員", group: "会派", value: YES },
    ])],
  );
  assert.equal(built.meta.lossyNameMatches, undefined);
  // **「キーが違う」だけの判定なら 2 件とも鳴っていた**（差がどこから来るかを固定する）
  assert.equal(localNameKey("入江議員") === localNameKey("入江 誠"), false);
  assert.equal(localNameKey("浜田一議員") === localNameKey("浜田 一哉"), false);
});

/**
 * **共通層に移してよい根拠を、名寄せの規則そのもので示す**（3 県の判定と同じであること）。
 *
 * **`matchBySubsequence` が寄せたなら、キーが違う限りそれは必ず部分列である。**
 * **`matchByExact` が寄せたなら、キーは必ず同じである。**
 * **どちらも「キーが違う」判定と「部分列で短い」判定が一致する。**
 */
test("#778 matchBySubsequence / matchByExact では 2 つの判定が一致する（共通化してよい根拠）", () => {
  const roster = [
    { id: "a", name: "櫛󠄁引 ユキ子" }, { id: "b", name: "柚木 貴光" },
    { id: "c", name: "西川 均" }, { id: "d", name: "芦高 清友" },
  ];
  const names = ["引 ユキ子", "櫛引ユキ子", "柚木 貴光", "西川", "髙清友", "芦高清友", "□村 利恵子", "和田 寛司"];
  for (const n of names) {
    for (const m of [matchBySubsequence, matchByExact]) {
      const hit = m(n, roster);
      if (hit.memberId === "") continue;
      const r = roster.find((x) => x.id === hit.memberId)!;
      const keysDiffer = localNameKey(n) !== localNameKey(r.name);
      const lossy = lossyNameMatchesOf([rollCall("x", [{ memberId: hit.memberId, nameText: n, group: "会派", value: YES }])], roster).length > 0;
      assert.equal(lossy, keysDiffer, `${m.name}("${n}") で 2 つの判定が食い違った`);
    }
  }
  // **鳥取の名寄せだけが食い違う**（だからこの判定を選んだ、という事実を固定する）
  const hit = matchBySurnamePrefix("入江議員", [{ id: "a", name: "入江 誠" }]);
  assert.equal(hit.memberId, "a");
  assert.equal(localNameKey("入江議員") !== localNameKey("入江 誠"), true, "キーは違う");
  assert.equal(lossyNameMatchesOf([rollCall("x", [{ memberId: "a", nameText: "入江議員", group: "会派", value: YES }])], [{ id: "a", name: "入江 誠" }]).length, 0, "が、部分列ではないので鳴らない");
});

/** 同じ氏名が複数の採決に出たら 1 行にまとめ、`rollCalls` に数える（3 県の実装と同じ形）。 */
test("#778 同じ氏名は 1 行にまとめ、rollCalls に採決の数を数える", () => {
  const built = build(
    [member("p_04_a", "西川 均"), member("p_04_b", "芦高 清友")],
    [1, 2, 3].map((i) => rollCall(`pref-04-398-20251217-発議案-${i}`, [
      { memberId: "p_04_a", nameText: "西川", group: "会派", value: YES },
      { memberId: "p_04_b", nameText: "髙清友", group: "会派", value: YES },
    ])),
  );
  assert.deepEqual(built.meta.lossyNameMatches, [
    // 並びは nameText 昇順（`buildLocalAssembly` が meta を作るときに揃える）
    { nameText: "西川", memberId: "p_04_a", rosterName: "西川 均", rollCalls: 3 },
    { nameText: "髙清友", memberId: "p_04_b", rosterName: "芦高 清友", rollCalls: 3 },
  ]);
});

/**
 * **本番 `data/` の実測を固定する**（#778 で数えた値。測り方も書く）。
 *
 * **測り方**: `data/assemblies/pref-*​/rollcalls/**​/*.json`（index.json を除く）の全票について、
 * `memberId` が空でないものを `data/members/index.json` の氏名と突き合わせた。**母数 58,057 票。**
 *
 * | 議会 | 票 | **字が落ちたまま寄った異なり** |
 * |---|---:|---:|
 * | 奈良 pref-29 | 5,000 | **2**（`西川`→`西川 均` 125 票 ／ `髙清友`→`芦高 清友` 37 票） |
 * | 他 10 県 | 53,057 | **0** |
 *
 * **奈良の 2 件は `nara/rollcalls.ts` の docblock が書いていた**
 * （「文字層に落ちて欠ける列がある。`芦髙清友` の外字 `芦`、`西川均` の `均`」）**が、**
 * **公表データのどこにも出ていなかった。** この PR で `meta.json` に出る。
 */
test("#778 本番 data/: 字が落ちたまま寄った氏名は奈良の 2 件だけ（測定の固定）", async () => {
  const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));
  const members = JSON.parse(await readFile(join(DATA, "members", "index.json"), "utf8")) as { id: string; name: string }[];
  const walk = async (dir: string): Promise<string[]> => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(async (e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".json") && e.name !== "index.json" ? [join(dir, e.name)] : []))).flat();
  const found: Record<string, string[]> = {};
  let votes = 0;
  const prefs = (await readdir(join(DATA, "assemblies"), { withFileTypes: true })).filter((e) => e.isDirectory() && e.name.startsWith("pref-")).map((e) => e.name).sort();
  assert.equal(prefs.length, 11, "11 県ぶんを数えていること（母数が減ったらこの測定は無意味）");
  for (const p of prefs) {
    const rollCalls: LocalRollCall[] = [];
    for (const f of await walk(join(DATA, "assemblies", p, "rollcalls"))) {
      const rc = JSON.parse(await readFile(f, "utf8")) as LocalRollCall;
      votes += rc.votes.length;
      rollCalls.push(rc);
    }
    const lossy = lossyNameMatchesOf(rollCalls, members);
    if (lossy.length) found[p] = lossy.map((l) => `${l.nameText}→${l.rosterName} (${l.rollCalls})`).sort();
  }
  assert.equal(votes, 58057, "母数が変わったら数え直すこと");
  assert.deepEqual(found, { "pref-29": ["西川→西川 均 (125)", "髙清友→芦高 清友 (37)"] });
});
