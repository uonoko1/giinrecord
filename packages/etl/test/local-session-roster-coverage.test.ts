import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalAssemblyMeta, LocalMember, LocalRollCall } from "@seiji-kiroku/shared";
import {
  buildLocalAssembly, LOCAL_TERM_DAYS, MIYAGI_ASSEMBLY, SEATS_CHANGED_FLAG, sessionRosterCoverageOf, validateLocalAssemblies, writeLocalAssembly,
} from "../src/local-assemblies.ts";

/**
 * **一般選挙の境をまたいだ寄せに、痕跡を残す**（Issue #951）。
 *
 * ## **何が問題だったか**——**痕跡が 1 つも残らなかった**
 *
 * **#950 が奈良で実測した**: **`--sessions` を境の向こうまで広げると、
 * 2022 年の 4 本 72 行 / 2,952 票のうち 1,656 票（56.1%）が 2026 年の名簿に寄る**（23 人ぶん）。
 * **担当者の申告: 「再選した現職だと思われますが一次資料で確かめていません。
 * `candidates` も付かないので『迷った』痕跡すら残りません。」**
 *
 * **既存の守りは 4 つとも捕まえない**（#951 の表）:
 *
 * | 守り | 捕まえない理由 |
 * |---|---|
 * | **#928**（`rosterAsOf` の窓） | **境の直前なら 1 任期（1,461 日）の内側**（奈良の境は 1,290 日） |
 * | **`unmatched`** | **寄ってしまうので出ない** |
 * | **`lossyNameMatches`** | **字は落ちていない**（`isLossyName` は false） |
 * | **`sourceConflict`** | **一次資料どうしは食い違っていない** |
 *
 * **「同姓同名の別人」でも「再選した本人」でも、出力が 1 バイトも違わない**（#569 の重いほう）。
 *
 * ## **足したもの**——**`meta.sessionRosterCoverage`（会期ごと、必ず出す）**
 *
 * **会期ごとに「その名簿がその会期をどれだけ写しているか」を数える。**
 * **`seatsChanged = min(rosterAbsent, unmatchedNames)`**——
 * **「名簿に居るのにこの会期に居ない人」と「この会期に居るのに名簿に無い氏名」が
 * 同時にある分だけ、席の持ち主が変わっている。**
 * **誰が誰に替わったかは書かない**（それは推定であり #569 が禁じる側）。
 *
 * ## **止めない。印を付けて数えるだけ**（#951 の PO の判断）
 *
 * **止めると #901 が進まなくなる。** **`data/` に残るので、後から数えられる。**
 */
const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));

const walk = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith(".json") && e.name !== "index.json") out.push(p);
  }
  return out;
};

const localPrefs = async (): Promise<string[]> =>
  (await readdir(join(DATA, "assemblies"), { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name.startsWith("pref-")).map((e) => e.name).sort();

const metaOf = async (p: string): Promise<LocalAssemblyMeta> =>
  JSON.parse(await readFile(join(DATA, "assemblies", p, "meta.json"), "utf-8")) as LocalAssemblyMeta;

/* ==================== 1. 本番 data/ で何件あるかを数える（母数つき。#757） ==================== */

/**
 * **#951 のやること 2「今の 11 県で、境をまたいだ寄せが何件あるかを数える」**。
 *
 * **答えは 0 件である。** **「数えていない」と区別するため、母数と分布をそのまま固定する**（#757）。
 *
 * **実測 2026-09-21**（`data/` を直に読んだ）:
 * **11 議会 / 110 会期 / 4,145 採決 / 182,728 票**（#901 の島根 2 → 5・佐賀 2 → 13・滋賀 2 → 19 で動いた）。
 *
 * | `seatsChanged` | 会期 |
 * |---:|---:|
 * | 0 | 32 |
 * | 1 | 12 |
 * | 2 | 28 |
 * | 3 | 9 |
 * | 4 | 8 |
 * | **5** | **8**（滋賀 2023-05 〜 2024-09。母数 42 人） |
 * | **10 以上（印が付く）** | **0** |
 *
 * **最大は 5**（#901 で滋賀を `--sessions 19` にして 4 → 5 に動いた。**印の線 10 の半分**）。
 * **滋賀の 20 会期目（2023年4月の一般選挙の向こう側）は `seatsChanged` 17 になる**——
 * **だから 19 で止めた**（#901。**印はこの境で鳴る**）。
 * **奈良が境をまたいだ場合は 17 になる**（#950 が測った 41 名中 17 名の入れ替わり）。
 */
test("#951 本番 data/: 11 議会 110 会期の seatsChanged 分布（最大 5、印が付く会期は 0 件）", async () => {
  const prefs = await localPrefs();
  assert.equal(prefs.length, 11, "11 議会ぶんを見ていること（母数。#757）");
  const rows: LocalAssemblyMeta["sessionRosterCoverage"] = [];
  for (const p of prefs) {
    const cov = (await metaOf(p)).sessionRosterCoverage;
    assert.ok(Array.isArray(cov) && cov.length > 0, `${p}: sessionRosterCoverage が無い（以降の検算が空回りする）`);
    rows.push(...cov);
  }
  // **母数を 3 通りで持つ**（会期・採決・票）。**どれか 1 つが痩せても気づける**
  assert.equal(rows.length, 110, "会期の合計");
  assert.equal(rows.reduce((s, r) => s + r.rollcalls, 0), 4_145, "採決の合計（#855 / #928 の母数と同じ）");
  assert.equal(rows.reduce((s, r) => s + r.votes, 0), 182_728, "票の合計（#928 の母数と同じ）");
  // **分布**（**「0 件でした」では、見ていなくても同じ顔をする**）
  const hist = new Map<number, number>();
  for (const r of rows) hist.set(r.seatsChanged, (hist.get(r.seatsChanged) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries([...hist].sort((a, b) => a[0] - b[0])), { 0: 42, 1: 15, 2: 28, 3: 9, 4: 8, 5: 8 });
  assert.equal(Math.max(...rows.map((r) => r.seatsChanged)), 5, "今までに実際に起きた最大の入れ替わり");
  // **本丸**: **印が付く会期は 0 件**（**11 議会を全部見たうえでの 0**）
  assert.deepEqual(rows.filter((r) => r.seatsChanged >= SEATS_CHANGED_FLAG).map((r) => `${r.sessionId} (${r.date})`), [],
    `seatsChanged >= ${SEATS_CHANGED_FLAG} の会期`);
  // **線が今の実測の外にあること**（**内側に引けば、今すぐ赤くなって誰も見なくなる**。#785）
  assert.ok(SEATS_CHANGED_FLAG > 5, "線は今までに起きた最大（5）より外に在る");
});

/**
 * **`rosterSeen + rosterAbsent` が名簿の人数に一致する**——**この式が成り立たないと
 * `seatsChanged` は読めない**（#757。母数を検算に入れる）。
 */
test("#951 本番 data/: rosterSeen + rosterAbsent == counts.members（110 会期すべて）", async () => {
  const prefs = await localPrefs();
  let checked = 0;
  for (const p of prefs) {
    const m = await metaOf(p);
    for (const r of m.sessionRosterCoverage) {
      assert.equal(r.rosterSeen + r.rosterAbsent, m.counts.members, `${p} ${r.sessionId}`);
      // **`seatsChanged` は両方向の小さいほう**（定義そのものを固定する）
      assert.equal(r.seatsChanged, Math.min(r.rosterAbsent, r.unmatchedNames), `${p} ${r.sessionId}: seatsChanged`);
      checked++;
    }
  }
  assert.equal(checked, 110, "見た会期の数（母数）");
});

/**
 * **`meta.json` が採決の原本と一致している**——**meta だけ書き換えても落ちる。**
 * **`sessionRosterCoverageOf` を直に呼ぶ**ので、`buildLocalAssembly` への繋ぎが切れても
 * ここは緑のままである（だから下の `validateLocalAssemblies` も別に見る。#774）。
 */
test("#951 本番 data/: meta.sessionRosterCoverage が rollcalls/ + members/index.json から作り直した値と一致", async () => {
  const prefs = await localPrefs();
  const members = JSON.parse(await readFile(join(DATA, "members", "index.json"), "utf-8")) as LocalMember[];
  let sessions = 0;
  for (const p of prefs) {
    const rcs: LocalRollCall[] = [];
    for (const f of await walk(join(DATA, "assemblies", p, "rollcalls"))) rcs.push(JSON.parse(await readFile(f, "utf-8")) as LocalRollCall);
    const roster = members.filter((m) => m.assemblyId === p);
    assert.ok(roster.length > 0, `${p}: 名簿が空（検算が空回りする）`);
    const want = sessionRosterCoverageOf(rcs, roster);
    assert.deepEqual((await metaOf(p)).sessionRosterCoverage, want, p);
    sessions += want.length;
  }
  assert.equal(sessions, 110, "作り直した会期の数（母数）");
});

/** **検査の側からも言う**（#774）——**`validateLocalAssemblies` に繋がっていること。** */
test("#951 本番 data/: validateLocalAssemblies が sessionRosterCoverage の違反を 1 件も出さない", async () => {
  const v = await validateLocalAssemblies(DATA);
  assert.deepEqual(v.filter((x) => x.includes("sessionRosterCoverage")), [], "#951 の違反");
  assert.deepEqual(v, [], `本番 data/ の不変条件違反（${v.length} 件）`);
});

/* ==================== 2. 境をまたいだ形を作って、印が付くこと ==================== */

const PDF = "https://www.pref.miyagi.jp/documents/62682/hyouketsu071217.pdf";
const ASSEMBLY_ID = "pref-04" as LocalRollCall["assemblyId"];
const ROSTER_AS_OF = "2026-04-23";

/**
 * **氏名は漢字だけで作る**（**数字を入れると `unmatchedReason` が `brokenGlyph` を返す**——
 * **`nonNameCharacters` が「名前になれる文字」の allowlist で見ているため**。#680）。
 * **名簿の 41 人と、境の向こうの 41 人が、どの 2 つを取っても 2 文字以上違うように組む**
 * （**1 文字違いだと `sourceConflict` が付いてしまい、「4 つとも黙る」を測れない**）。
 */
const KANJI = [..."一二三四五六七八九十百千万甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥春夏秋冬東西南北"];
const rosterName = (i: number): string => `山田 ${KANJI[i]}${KANJI[(i + 7) % KANJI.length]}`;
const formerName = (i: number): string => `佐藤 ${KANJI[(i + 3) % KANJI.length]}${KANJI[(i + 19) % KANJI.length]}`;

const member = (i: number): LocalMember => ({
  id: `p_04_${i}`, assemblyId: "pref-04", name: rosterName(i), kana: "ぎいん", group: "会派", district: "宮城",
  profileUrl: "https://www.pref.miyagi.jp/site/kengikai/x.html", current: true, asOf: ROSTER_AS_OF,
  sourceUrl: "https://www.pref.miyagi.jp/site/kengikai/18meibo-kaiha.html", counts: { rollcalls: 0 },
});

/** 1 本の採決。`votes` は (memberId, nameText) の組の並び（`memberId` が `""` なら未突合）。 */
const rollCall = (sessionId: string, date: string, n: number, votes: readonly [string, string][]): LocalRollCall => ({
  id: `pref-04-${sessionId}-${date.replace(/-/gu, "")}-x-${n}`, assemblyId: ASSEMBLY_ID, sessionId,
  sessionLabel: `${sessionId} 定例会`, date, kind: "発議案", number: String(n),
  title: "条例", result: "可決", page: 1, sourceUrl: PDF,
  votes: votes.map(([memberId, nameText]) => ({ memberId, nameText, group: "会派", value: { raw: "○" as const, legend: "賛成", mapped: "賛成" as const } })),
});

/**
 * **名簿 41 人に対して、2 つの会期を作る**:
 *   - **`now`**: 41 人全員が名簿に寄る（境のこちら側）
 *   - **`old`**: **`crossed` 人ぶんが名簿に寄らず、その席は名簿の別の 41 − `crossed` 人で埋まる**
 *     （**境の向こう側**。**再選した現職がそのまま寄り、落選した議員は名簿に無い**）
 */
const buildWithBoundary = (crossed: number) => {
  const members = Array.from({ length: 41 }, (_, i) => member(i));
  const now: [string, string][] = members.map((m) => [m.id, m.name]);
  // **境の向こう**: 先頭 `crossed` 人は**当時の別の議員**（名簿に無い氏名）で、残りは再選した現職
  const old: [string, string][] = members.map((m, i) => (i < crossed ? ["", formerName(i)] : [m.id, m.name]));
  return buildLocalAssembly({
    assembly: MIYAGI_ASSEMBLY, fetchedAt: `${ROSTER_AS_OF}T00:00:00.000Z`, rosterAsOf: ROSTER_AS_OF, sources: [],
    sessions: [
      { sessionId: "now", sessionLabel: "now 定例会", sourceUrl: "https://www.pref.miyagi.jp/site/kengikai/a.html", pdfUrl: PDF, rollcalls: 1, unknownCells: 0 },
      { sessionId: "old", sessionLabel: "old 定例会", sourceUrl: "https://www.pref.miyagi.jp/site/kengikai/b.html", pdfUrl: PDF, rollcalls: 1, unknownCells: 0 },
    ],
    members,
    // **`rosterAsOf` から 1,290 日前**（奈良の境と同じ幅。**#928 の 1,461 日の内側**）
    rollCalls: [rollCall("now", "2026-03-18", 1, now), rollCall("old", "2022-10-12", 1, old)],
  });
};

/**
 * ## **本丸**——**境をまたいだ会期に印が付き、またいでいない会期には付かない**
 *
 * **奈良の形をそのまま作る**（41 人中 17 人が入れ替わり、24 人が名簿に寄る）。
 */
test("#951 境をまたいだ会期に印が付く（41 人中 17 人入れ替わり → seatsChanged 17）", () => {
  const ds = buildWithBoundary(17);
  const cov = ds.meta.sessionRosterCoverage;
  assert.equal(cov.length, 2, "会期の数（母数）");
  const old = cov.find((r) => r.sessionId === "old")!;
  const now = cov.find((r) => r.sessionId === "now")!;
  // **境の向こう**: **41 人中 24 人が今の名簿に寄っている**（**#950 が奈良で測ったのと同じ形**）
  assert.deepEqual(old, {
    sessionId: "old", date: "2022-10-12", rollcalls: 1, votes: 41,
    rosterSeen: 24, rosterAbsent: 17, unmatchedNames: 17, unmatchedVotes: 17, seatsChanged: 17,
  });
  assert.ok(old.seatsChanged >= SEATS_CHANGED_FLAG, "境をまたいだ会期に印が付く");
  // **境のこちら側には印が付かない**（**否定的対照**。全部に印が付くなら何も言っていない）
  assert.deepEqual(now, {
    sessionId: "now", date: "2026-03-18", rollcalls: 1, votes: 41,
    rosterSeen: 41, rosterAbsent: 0, unmatchedNames: 0, unmatchedVotes: 0, seatsChanged: 0,
  });
  assert.ok(now.seatsChanged < SEATS_CHANGED_FLAG, "またいでいない会期には印が付かない");
  // **並びは日付の降順**（`sessions.json` と同じ）
  assert.deepEqual(cov.map((r) => r.sessionId), ["now", "old"]);
});

/**
 * ## **既存の守りが 4 つとも黙ることを、同じ形で実測する**（#951 の表を作り話にしない）
 *
 * **これが無いと「新しい守りが要る」の根拠が無い。**
 */
test("#951 境をまたいでも、既存の 4 つの守りは 1 つも鳴らない（だから新しい印が要る）", async () => {
  const ds = buildWithBoundary(17);
  // **1. `unmatched`**: **寄らなかった 17 人は出る**が、**寄ってしまった 24 人は 1 人も出ない**
  assert.equal(ds.unmatched.length, 17, "未突合の氏名（落選した側だけ）");
  assert.deepEqual(ds.unmatched.map((u) => u.nameText).sort(), Array.from({ length: 17 }, (_, i) => formerName(i)).sort());
  // **2. `lossyNameMatches`**: **字は落ちていないので 0 件**
  assert.equal(ds.meta.lossyNameMatches, undefined, "字の欠落は無い（省略される）");
  // **3. `sourceConflict`**: **一次資料どうしは食い違っていないので、理由は 1 件も付かない**
  assert.deepEqual(ds.unmatched.filter((u) => u.reason !== undefined).map((u) => u.nameText), [], "reason の付いた氏名");
  // **4. `candidates`**: **同姓同名がいないので「迷った」痕跡も残らない**（#950 の申告そのもの）
  assert.deepEqual(ds.unmatched.filter((u) => u.candidates !== undefined).map((u) => u.nameText), [], "candidates の付いた氏名");
  // **5. #928（`rosterAsOf` の窓）**: **1,290 日は 1,461 日の内側なので鳴らない**
  const dir = await mkdtemp(join(tmpdir(), "gikailog-951-"));
  await writeLocalAssembly(dir, ds);
  const v = await validateLocalAssemblies(dir);
  assert.deepEqual(v.filter((x) => x.includes("1 任期")), [], "#928 の違反");
  assert.deepEqual(v, [], `不変条件違反（${v.length} 件）`);
  // **それでも `data/` には痕跡が残っている**——**これがこの PBI の成果物である**
  const meta = JSON.parse(await readFile(join(dir, "assemblies", "pref-04", "meta.json"), "utf-8")) as LocalAssemblyMeta;
  assert.equal(meta.sessionRosterCoverage.find((r) => r.sessionId === "old")!.seatsChanged, 17,
    "**書き出した `data/` に残る**（ログに出すだけでは消える。#951）");
});

/**
 * ## **2 県目の実例——宮城**（**奈良だけで設計していないことを、別の県の測定で示す**）
 *
 * **#953 は宮城を `--sessions 11`（第390回まで）で止めた**——
 * **第389・388回は「2023-10 の一般選挙の向こう側」だからである**（PR #953 の 5 節）。
 * **#953 が一次資料（PDF の氏名）で測った境: 第390回は 59 名中 IN 19 / OUT 18。**
 *
 * **つまり本番の宮城 584 採決 11 会期は、境のこちら側で止まっている**——
 * **だから `seatsChanged` の最大は 2 で、印は付かない**（上の分布の 67 会期に含まれる）。
 * **「鳴らなかった」ではなく「境をまたいでいないので鳴りようがない」である。**
 *
 * **ここで測るのは、その 1 つ手前（第389回）を足したらどうなるか。**
 * **第389回の PDF は取得していない**——**#953 が測った「58 名のうち 18 名が入れ替わる」形を、
 * 本番の名簿と本物の採決の形に当てて再現する**（奈良でやったのと同じ方法）。
 */
test("#951 宮城で境をまたぐと印が付く（#953 が --sessions 12 にしなかった境。seatsChanged 16）", () => {
  // **今の名簿 56 人のうち 40 人が前の任期にも居て、18 名は名簿に無い**
  // （#953 の「59 名中 OUT 18」から。**寄る側は 56 − 16 = 40**）
  const members = Array.from({ length: 56 }, (_, i) => member(i));
  const across: [string, string][] = [
    ...members.slice(0, 40).map((m) => [m.id, m.name] as [string, string]),
    ...Array.from({ length: 18 }, (_, k) => ["", formerName(k)] as [string, string]),
  ];
  const cov = sessionRosterCoverageOf([rollCall("389", "2023-07-12", 1, across)], members);
  assert.equal(cov.length, 1, "会期の数（母数）");
  assert.deepEqual(cov[0], {
    sessionId: "389", date: "2023-07-12", rollcalls: 1, votes: 58,
    rosterSeen: 40, rosterAbsent: 16, unmatchedNames: 18, unmatchedVotes: 18, seatsChanged: 16,
  });
  assert.ok(cov[0].seatsChanged >= SEATS_CHANGED_FLAG, "**境をまたいだ宮城にも印が付く**");
  // **票の 69.0% が今の名簿に黙って寄る**（**奈良の 56.1% より悪い**）
  assert.equal(across.filter(([id]) => id !== "").length, 40);
  assert.equal(Math.round((1_000 * 40) / 58) / 10, 69.0, "名簿に寄る票の割合");
  // **#928 は鳴らない**: **2023-07-12 は `rosterAsOf` 2026-09-17 の 1,163 日前で、1,461 の内側**
  assert.ok(daysApart("2023-07-12", "2026-09-17") < LOCAL_TERM_DAYS, "**#928 の窓の内側**");
  assert.equal(daysApart("2023-07-12", "2026-09-17"), 1_163);
});

/**
 * ## **3 県目の実例——青森**（**#959 の境。3 県が独立に測った境が、3 つとも線の外にある**）
 *
 * **#959 は青森を `--sessions 14`（2023-05臨時まで）で止めた**——
 * **`--sessions 15`（2023-02定例）は 2023年4月の一般選挙をまたぐ**（#959 が一次資料で
 * **44 名中 IN 11 / OUT 15**、`unmatchedNames` 0〜3 → **11** と測った）。
 *
 * **#959 の要点は「#928 は鳴るが、境より 4 会期も遅い」である**——
 * **境は 14 ↔ 15 だが、`LOCAL_TERM_DAYS` が初めて超えるのは 19 会期目。**
 * **`--sessions 15`（境の向こう）ですら 1,174 / 1,461 日で #928 は鳴らない。**
 * **この 4 会期ぶんの隙間が、`seatsChanged` の要る理由そのものである**（#961）。
 *
 * **2023-02 の PDF は取得していない**——**#959 の数を本番の名簿と採決の形に当てて再現する。**
 *
 * **数え方が #959 と違うので、値も違う**（**正直に書く**）:
 * **#959 は「氏名の集合の入れ替わり」（OUT 15）を数え、ここは `min(rosterAbsent, unmatchedNames)`
 * = `min(13, 11)` = **11** を数える。** **どちらも線（10）の外にある、というのが言えることである。**
 */
test("#951 青森で境をまたぐと印が付く（#959 が --sessions 15 にしなかった境。seatsChanged 11）", () => {
  // **今の名簿 46 人のうち 33 人が前の任期にも居て、11 名は名簿に無い**（#959 の `unmatchedNames` 11）
  const members = Array.from({ length: 46 }, (_, i) => member(i));
  const across: [string, string][] = [
    ...members.slice(0, 33).map((m) => [m.id, m.name] as [string, string]),
    ...Array.from({ length: 11 }, (_, k) => ["", formerName(k)] as [string, string]),
  ];
  const cov = sessionRosterCoverageOf([rollCall("2023-02", "2023-03-08", 1, across)], members);
  assert.deepEqual(cov, [{
    sessionId: "2023-02", date: "2023-03-08", rollcalls: 1, votes: 44,
    // **名簿 46 − 出てきた 33 = 13 が absent、名簿に無い氏名が 11** → **小さいほう 11**
    rosterSeen: 33, rosterAbsent: 13, unmatchedNames: 11, unmatchedVotes: 11, seatsChanged: 11,
  }]);
  assert.ok(cov[0].seatsChanged >= SEATS_CHANGED_FLAG, "**境をまたいだ青森にも印が付く**");
  // **票の 75.0% が今の名簿に黙って寄る**（**3 県でいちばん悪い**）
  assert.equal(Math.round((1_000 * 33) / 44) / 10, 75.0, "名簿に寄る票の割合");
  // **#928 は鳴らない**: **#959 の実測 1,174 日。1,461 の内側**
  assert.equal(daysApart("2023-03-08", "2026-05-25"), 1_174, "#959 が測った daysBefore");
  assert.ok(daysApart("2023-03-08", "2026-05-25") < LOCAL_TERM_DAYS, "**#928 の窓の内側**");
});

/**
 * ## **3 県の境をまとめて 1 つの表にする**（**#961 の出どころ**）
 *
 * **3 県とも、担当者が氏名の集合の不連続を見て手前で止めた**——**機械が止めたのではない。**
 * **#928（`LOCAL_TERM_DAYS`）は 3 県とも境の向こうで鳴らない。**
 *
 * **これが「`seatsChanged` が要る」ことの根拠のすべてである。**
 * **この表が壊れたら、線の置き方の根拠も壊れている。**
 */
test("#951 境をまたいだ 3 県は、3 つとも線の外・3 つとも #928 の内側（#961 の根拠）", () => {
  const border = (roster: number, stays: number, gone: number, date: string, asOf: string) => {
    const members = Array.from({ length: roster }, (_, i) => member(i));
    const votes: [string, string][] = [
      ...members.slice(0, stays).map((m) => [m.id, m.name] as [string, string]),
      ...Array.from({ length: gone }, (_, k) => ["", formerName(k)] as [string, string]),
    ];
    const c = sessionRosterCoverageOf([rollCall("x", date, 1, votes)], members)[0];
    return {
      seatsChanged: c.seatsChanged,
      flagged: c.seatsChanged >= SEATS_CHANGED_FLAG,
      snappedPct: Math.round((1_000 * stays) / (stays + gone)) / 10,
      daysBefore: daysApart(date, asOf),
      rings928: daysApart(date, asOf) > LOCAL_TERM_DAYS,
    };
  };
  assert.deepEqual(
    {
      // **奈良**（#950 の境 2022-10-12。41 名中 17 名入れ替わり。rosterAsOf 2026-04-24）
      nara: border(40, 23, 18, "2022-10-12", "2026-04-24"),
      // **宮城**（#953 の境 2023-07-12。58 名中 18 名。rosterAsOf 2026-09-17）
      miyagi: border(56, 40, 18, "2023-07-12", "2026-09-17"),
      // **青森**（#959 の境 2023-03-08。44 名中 11 名が名簿に無い。rosterAsOf 2026-05-25）
      aomori: border(46, 33, 11, "2023-03-08", "2026-05-25"),
    },
    {
      nara: { seatsChanged: 17, flagged: true, snappedPct: 56.1, daysBefore: 1_290, rings928: false },
      miyagi: { seatsChanged: 16, flagged: true, snappedPct: 69.0, daysBefore: 1_163, rings928: false },
      aomori: { seatsChanged: 11, flagged: true, snappedPct: 75.0, daysBefore: 1_174, rings928: false },
    },
    "**3 県とも印が付き、3 県とも #928 は鳴らない**",
  );
  // **いちばん小さい境（青森 11）が、線（10）のすぐ外にある**——**余裕は 1 しかない。**
  // **線を 12 以上にすると青森を取りこぼす。** 母数つきでそう書いておく（#961 が動かすときの材料）
  assert.equal(SEATS_CHANGED_FLAG, 10);
  assert.equal(11 - SEATS_CHANGED_FLAG, 1, "**いちばん小さい境と線の差**（3 県の実測のうち最小）");
});

/** 2 つの ISO 日付の差（日数）。`rosterWindowOf` が中で使っているのと同じ計算。 */
const daysApart = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * ## **境の幅を変えて、線のどちら側に落ちるかを見る**（**1 点だけで測らない**）
 *
 * **`SEATS_CHANGED_FLAG` は「今までに実際に起きた幅（最大 4）の外」に引いてある。**
 * **9 で鳴らず 10 で鳴ることを、両側で固定する**（**閾値を動かせば落ちる**）。
 */
test("#951 入れ替わりの幅ごとの印（0/1/4 は付かず、10/17/41 は付く）", () => {
  const got: Record<number, { seatsChanged: number; flagged: boolean }> = {};
  for (const crossed of [0, 1, 4, 9, 10, 17, 41]) {
    const old = buildWithBoundary(crossed).meta.sessionRosterCoverage.find((r) => r.sessionId === "old")!;
    got[crossed] = { seatsChanged: old.seatsChanged, flagged: old.seatsChanged >= SEATS_CHANGED_FLAG };
  }
  assert.deepEqual(got, {
    0: { seatsChanged: 0, flagged: false },
    // **1 人の入れ替わり（補選）では鳴らない**
    1: { seatsChanged: 1, flagged: false },
    // **4 は今の 11 県の最大（三重）。ここで鳴ったら本番が赤くなる**
    4: { seatsChanged: 4, flagged: false },
    // **境界のすぐ内側**
    9: { seatsChanged: 9, flagged: false },
    // **境界**
    10: { seatsChanged: 10, flagged: true },
    // **奈良の境**
    17: { seatsChanged: 17, flagged: true },
    // **全員入れ替わり**
    41: { seatsChanged: 41, flagged: true },
  });
});

/**
 * ## **片方向だけでは印を付けない**——**`min` を採った理由**
 *
 * **`rosterAbsent` だけ / `unmatchedNames` だけでは、席の入れ替わりの証拠にならない:**
 *   - **`rosterAbsent` だけ**: **PDF の列がその会期だけ少ない**（読めた本数が少ない等）かもしれない。
 *   - **`unmatchedNames` だけ**: **字が壊れているだけ**かもしれない（#680 の `□`）。
 *
 * **どちらも #569 の「記録が出ない」側で、既存の守りが見ている。**
 * **`seatsChanged` が見るのは「両方が同時にある」ときだけである。**
 */
test("#951 片方向だけでは印を付けない（名簿が 20 人欠けても、未突合が 0 なら seatsChanged は 0）", () => {
  const members = Array.from({ length: 41 }, (_, i) => member(i));
  const build = (votes: readonly [string, string][]) => buildLocalAssembly({
    assembly: MIYAGI_ASSEMBLY, fetchedAt: `${ROSTER_AS_OF}T00:00:00.000Z`, rosterAsOf: ROSTER_AS_OF, sources: [],
    sessions: [{ sessionId: "s", sessionLabel: "s 定例会", sourceUrl: "https://www.pref.miyagi.jp/site/kengikai/a.html", pdfUrl: PDF, rollcalls: 1, unknownCells: 0 }],
    members, rollCalls: [rollCall("s", "2026-03-18", 1, votes)],
  }).meta.sessionRosterCoverage[0];

  // **(a) 名簿の 20 人がこの会期の票に居ない**（列が 21 本しかない）。**未突合は 0**
  const a = build(members.slice(20).map((m) => [m.id, m.name] as [string, string]));
  assert.equal(a.rosterAbsent, 20);
  assert.equal(a.unmatchedNames, 0);
  assert.equal(a.seatsChanged, 0, "**名簿が欠けているだけでは印を付けない**");

  // **(b) 20 人ぶんの氏名が名簿に寄らない**が、**名簿の 41 人は全員この会期に居る**（61 列）
  const b = build([
    ...members.map((m) => [m.id, m.name] as [string, string]),
    ...Array.from({ length: 20 }, (_, i) => ["", formerName(i)] as [string, string]),
  ]);
  assert.equal(b.rosterAbsent, 0);
  assert.equal(b.unmatchedNames, 20);
  assert.equal(b.seatsChanged, 0, "**未突合が出ているだけでは印を付けない**（#680 の `□` がここに落ちる）");

  // **(c) 両方が同時にあるときだけ数える**（小さいほう）
  const c = build([
    ...members.slice(5).map((m) => [m.id, m.name] as [string, string]),
    ...Array.from({ length: 20 }, (_, i) => ["", formerName(i)] as [string, string]),
  ]);
  assert.equal(c.rosterAbsent, 5);
  assert.equal(c.unmatchedNames, 20);
  assert.equal(c.seatsChanged, 5, "**小さいほう**（5 席ぶんしか「入れ替わった」と言えない）");
});

/**
 * ## **`rosterAbsent` は「欠席」ではない**
 *
 * **表決 PDF は議員全員の列を持ち、欠席者にも `欠` の記号が入る**（奈良の 176 票）。
 * **「票に現れない」は「その会期の PDF に列が無い」であって、欠席とは別である。**
 * **これを取り違えると、欠席の多い会期に偽の印が付く。**
 */
test("#951 欠席（`欠` の票）は rosterAbsent に数えない", () => {
  const members = Array.from({ length: 41 }, (_, i) => member(i));
  const rc = rollCall("s", "2026-03-18", 1, members.map((m) => [m.id, m.name] as [string, string]));
  // **先頭 10 人を `欠席` にする**（**列は在る**）
  for (let i = 0; i < 10; i++) rc.votes[i].value = { raw: "欠", legend: "欠席", mapped: "投票なし" };
  const cov = sessionRosterCoverageOf([rc], members);
  assert.deepEqual(cov, [{
    sessionId: "s", date: "2026-03-18", rollcalls: 1, votes: 41,
    rosterSeen: 41, rosterAbsent: 0, unmatchedNames: 0, unmatchedVotes: 0, seatsChanged: 0,
  }]);
});

/**
 * ## **会期をひとまとめに数えると、ずれが消える**（**なぜ会期ごとなのか**）
 *
 * **奈良が境をまたいだとき、新しい会期は名簿と完全に一致し、古い会期だけが半分ずれる。**
 * **議会をひとまとめに数えると「41 人中 41 人が居る」になって、ずれが見えない。**
 */
test("#951 議会ひとまとめでは消える（全体では rosterAbsent 0、会期ごとだと 17）", () => {
  const ds = buildWithBoundary(17);
  const all = ds.rollCalls.flatMap((rc) => rc.votes);
  const seenAll = new Set(all.filter((v) => v.memberId !== "").map((v) => v.memberId));
  assert.equal(seenAll.size, 41, "**議会全体では名簿の 41 人が全員「票に出ている」**");
  assert.equal(ds.meta.counts.members - seenAll.size, 0, "**ひとまとめの `rosterAbsent` は 0**（ずれが見えない）");
  // **会期ごとに数えると 17 が出る**
  assert.equal(ds.meta.sessionRosterCoverage.find((r) => r.sessionId === "old")!.rosterAbsent, 17);
});

/**
 * ## **`validateLocalAssemblies` が写しのずれを捕まえる**（#851 / #826 と同じ形）
 *
 * **`meta.json` は運用者が見る唯一の窓なので、そこが票とずれたまま出ている状態にしない。**
 */
test("#951 meta.sessionRosterCoverage を書き換えると validateLocalAssemblies が落ちる", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gikailog-951-"));
  const ds = buildWithBoundary(17);
  await writeLocalAssembly(dir, ds);
  assert.deepEqual(await validateLocalAssemblies(dir), [], "書いた直後は緑");
  // **印を消す**（**運用者が「赤いのが邪魔だから」と手で消した形**）
  const path = join(dir, "assemblies", "pref-04", "meta.json");
  const meta = JSON.parse(await readFile(path, "utf-8")) as LocalAssemblyMeta;
  meta.sessionRosterCoverage = meta.sessionRosterCoverage.map((r) => ({ ...r, seatsChanged: 0 }));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, JSON.stringify(meta));
  const v = await validateLocalAssemblies(dir);
  assert.equal(v.filter((x) => x.includes("sessionRosterCoverage")).length, 1, `違反: ${v.join(" / ")}`);
  // **欄ごと消しても落ちる**（**「省略されている」を「違反が無い」と読ませない**。#757）
  delete (meta as Partial<LocalAssemblyMeta>).sessionRosterCoverage;
  await writeFile(path, JSON.stringify(meta));
  assert.equal((await validateLocalAssemblies(dir)).filter((x) => x.includes("sessionRosterCoverage")).length, 1, "欄ごと消した場合");
});

/**
 * ## **会期が 1 つでも、入れ替わりが 0 でも、必ず出す**（#757）
 *
 * **「省略されている」と「見た上で 0」が同じ形になってはいけない。**
 * **`lossyNameMatches` / `countMismatches` は 0 件なら省略されるが、
 * `sessionRosterCoverage` は `countChecked` と同じで必ず出る。**
 */
test("#951 入れ替わりが 0 でも sessionRosterCoverage は省略しない", () => {
  const ds = buildWithBoundary(0);
  assert.equal(ds.meta.sessionRosterCoverage.length, 2, "2 会期ぶん出ている");
  assert.deepEqual(ds.meta.sessionRosterCoverage.map((r) => r.seatsChanged), [0, 0]);
  // **同じ形の 0 件でも、`lossyNameMatches` のほうは省略される**（対比）
  assert.equal(ds.meta.lossyNameMatches, undefined);
  assert.equal(ds.meta.countMismatches, undefined);
});
