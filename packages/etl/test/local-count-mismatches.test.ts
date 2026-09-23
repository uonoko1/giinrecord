import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalAssemblyMeta, LocalMember, LocalRollCall, LocalVote } from "@seiji-kiroku/shared";
import { buildLocalAssembly, countMismatchesOf, MIYAGI_ASSEMBLY } from "../src/local-assemblies.ts";

/**
 * **記号の数と公表値（`counts`）の食い違いを、11 県すべてで `meta.countMismatches` に残す**（Issue #826）。
 *
 * ## 何が問題だったか
 *
 * **記号の数と `counts` を突き合わせている県が 5 つあり（宮城・鳥取・島根・佐賀・高知）、
 * 5 つとも `assert.equal` で「エラーで止める」形だった。**
 * **山梨には、公表された賛成者数に議長の `〇` が入っていない行が 2 つある**（#782／#811）。
 * **佐賀にも同じ事象（知事の再議・三分の二未満で否決）の行が実在するが、佐賀では議長を数えているので合っている**（#825）。
 * **つまり「規則」ではなく「県ごとの慣行」で、同じ事象でも数え方が違う。**
 *
 * **だから 5 県のどれかに山梨と同じ数え方の行が出れば、そのテストは落ちる。**
 * **落ちれば月次 ETL が止まり、正しい記録まで出なくなる**（#569 の「記録が出ない」側）。
 *
 * ## PO が #811 で決めたこと
 *
 * > **不一致を「エラーで止める」ではなく「件数として出す」**（`unknownCells` / `unmatched.json` と同じ形）。
 * > **記録は出たうえで、人が見に行ける。**
 *
 * ## なぜ共通層（`buildLocalAssembly`）に置けるか
 *
 * **判定に要るのは `rollCalls[].counts`（公表値）と `rollCalls[].votes[].value.mapped`（凡例から引いた意味）だけで、
 * どちらも `buildLocalAssembly` の引数にある。** **PDF の読み方が県ごとに違っても、ここに来る形は同じである。**
 * **生の字では数えられない**——本番 `data/` の実測で、賛成は `○`（10 県）と `〇`（徳島）、
 * 反対は `×`（8 県）と `●`（島根・徳島）に分かれている。**`mapped` は凡例から引いた意味なので、県ごとの字に依存しない。**
 *
 * **`input.countMismatches` は受け取らない**——受け取ると「県が渡さなければ出ない」に戻る（#800 と同じ理由）。
 */

const member = (id: string, name: string): LocalMember => ({
  id, assemblyId: "pref-04", name, kana: "かな", group: "会派", district: "宮城",
  profileUrl: "https://www.pref.miyagi.jp/site/kengikai/x.html", current: true, asOf: "2026-04-23",
  sourceUrl: "https://www.pref.miyagi.jp/site/kengikai/18meibo-kaiha.html", counts: { rollcalls: 0 },
});
const YES: LocalVote = { raw: "○", legend: "賛成", mapped: "賛成" };
const NO: LocalVote = { raw: "×", legend: "反対", mapped: "反対" };
/** 議長（票を投じていない）。山梨ではこの `〇` が公表の賛成者数に入っていない行がある */
const CHAIR_YES: LocalVote = { raw: "〇", legend: "賛成", mapped: "賛成" };
const CHAIR: LocalVote = { raw: "議", legend: "議長", mapped: "投票なし" };
/** 凡例が引けなかったセル（滋賀の 4 行が実際にこの形。`mapped` が無い） */
const UNREADABLE: LocalVote = { raw: "○", legend: "抽出不能" };

const rollCall = (id: string, counts: LocalRollCall["counts"], votes: LocalRollCall["votes"]): LocalRollCall => ({
  id, assemblyId: "pref-04" as LocalRollCall["assemblyId"], sessionId: "398",
  sessionLabel: "令和7年11月定例会（第398回）", date: "2025-12-17", kind: "発議案", number: id.slice(-1),
  title: "条例", result: "可決", page: 1,
  sourceUrl: "https://www.pref.miyagi.jp/documents/62682/hyouketsu071217.pdf",
  ...(counts ? { counts } : {}), votes,
});
const vote = (id: string, value: LocalVote) => ({ memberId: id, nameText: id, group: "会派", value });

const build = (members: LocalMember[], rollCalls: LocalRollCall[]) => buildLocalAssembly({
  assembly: MIYAGI_ASSEMBLY, members, rollCalls,
  fetchedAt: "2026-09-14T00:00:00.000Z", rosterAsOf: "2026-04-23", sources: [],
  sessions: [{ sessionId: "398", sessionLabel: "令和7年11月定例会（第398回）", sourceUrl: "https://www.pref.miyagi.jp/site/kengikai/x.html", pdfUrl: "https://www.pref.miyagi.jp/documents/62682/hyouketsu071217.pdf", rollcalls: rollCalls.length, unknownCells: 0 }],
});
const roster = [member("a", "甲"), member("b", "乙"), member("c", "丙")];
const walk = async (dir: string): Promise<string[]> => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(async (e) =>
  e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".json") && e.name !== "index.json" ? [join(dir, e.name)] : []))).flat();

/**
 * **山梨の `row9`/`row6` と同じ形**（**公表の賛成者数に議長の `〇` が入っていない**＝
 * **数えた賛成が公表値より 1 多い**）。**票は出たうえで、食い違いが件数として残る。**
 */
test("#826 山梨と同じ形の行（数えた賛成が公表値より 1 多い）が meta.countMismatches に載る。票は出たまま", () => {
  const id = "pref-04-398-20251217-発議案-1";
  const built = build(roster, [
    // 公表の賛成者数は 1（議長の 〇 が入っていない）。数えると 2
    rollCall(id, { yes: 1, no: 1 }, [vote("a", YES), vote("b", CHAIR_YES), vote("c", NO)]),
  ]);
  assert.deepEqual(built.meta.countMismatches, [
    { rollCallId: id, counted: { yes: 2, no: 1 }, published: { yes: 1, no: 1 } },
  ]);
  // **票は 3 人とも出たまま**（#569 の「記録が出ない」側に倒していない）
  assert.deepEqual(built.details.map((d) => d.timeline.length), [1, 1, 1]);
  assert.equal(built.meta.counts.rollcalls, 1, "採決も消えていない");
  assert.equal(built.rollCalls[0].counts?.yes, 1, "公表値もそのまま（数え直していない）");
});

/** **合っている行では欄ごと出ない**（全部に付く実装になっていないこと。否定的対照） */
test("#826 否定的対照: 記号の数と公表値が合っていれば meta.countMismatches は省略される", () => {
  const built = build(roster, [
    rollCall("pref-04-398-20251217-発議案-1", { yes: 2, no: 1 }, [vote("a", YES), vote("b", YES), vote("c", NO)]),
    // 議長が票を投じていない行（`議`）。**議長の行を検算の外に出してはいない**——
    // `投票なし` は賛成でも反対でもないので、数えれば自然に合う（#811 で PO が案 ② を退けた）
    rollCall("pref-04-398-20251217-発議案-2", { yes: 2, no: 0 }, [vote("a", YES), vote("b", YES), vote("c", CHAIR)]),
  ]);
  assert.equal(built.meta.countMismatches, undefined);
});

/**
 * **`counts` の無い行は母数に入れない**（#757。**「0 件」と「1 件も見ていない」は違う**）。
 * **本番 `data/` で 341 件ある**（奈良 125・徳島 105・高知 104・秋田 7。下の実データのテストで数える）。
 */
test("#826 counts の欄が無い行は母数に入らない（見ていないものを「合っている」と数えない）", () => {
  const built = build(roster, [
    rollCall("pref-04-398-20251217-発議案-1", undefined, [vote("a", YES), vote("b", YES), vote("c", NO)]),
  ]);
  assert.equal(built.meta.countMismatches, undefined, "欄が無いので食い違いも出ない");
  assert.deepEqual(built.meta.countChecked, { rows: 1, checked: 0, noCounts: 1, unreadableCells: 0 });
});

/**
 * **凡例が引けなかったセルのある行も母数に入れない。**
 * **本番 `data/` に 5 行ある**（滋賀 4・鳥取 1）。**滋賀の 4 行は生の字（`○`/`×`）では公表値と合っている**
 * **のに `legend` が `抽出不能` で `mapped` が無い**ので、意味で数えると全部 0 になる。
 * **母数に入れると「4 件の食い違い」という偽の件数が出る**（食い違っているのは凡例の読みであって、票ではない）。
 */
test("#826 凡例が引けないセルのある行は母数に入らない（偽の食い違いを出さない）", () => {
  const built = build(roster, [
    rollCall("pref-04-398-20251217-発議案-1", { yes: 2, no: 1 }, [
      vote("a", UNREADABLE), vote("b", UNREADABLE), vote("c", UNREADABLE),
    ]),
  ]);
  assert.equal(built.meta.countMismatches, undefined);
  assert.deepEqual(built.meta.countChecked, { rows: 1, checked: 0, noCounts: 0, unreadableCells: 1 });
});

/** **母数はいつも出る**（食い違いが 0 でも。#757——「0 件」は「見た上で 0」でなければ意味が無い） */
test("#826 食い違いが 0 でも母数は meta.countChecked に出る（見た上での 0 だと分かるように）", () => {
  const built = build(roster, [
    rollCall("pref-04-398-20251217-発議案-1", { yes: 2, no: 1 }, [vote("a", YES), vote("b", YES), vote("c", NO)]),
    rollCall("pref-04-398-20251217-発議案-2", undefined, [vote("a", YES), vote("b", YES), vote("c", NO)]),
  ]);
  assert.equal(built.meta.countMismatches, undefined);
  assert.deepEqual(built.meta.countChecked, { rows: 2, checked: 1, noCounts: 1, unreadableCells: 0 });
});

/** **反対の側も見ている**（賛成だけ数えていないこと） */
test("#826 反対者数が食い違う行も載る", () => {
  const id = "pref-04-398-20251217-発議案-1";
  const built = build(roster, [rollCall(id, { yes: 2, no: 0 }, [vote("a", YES), vote("b", YES), vote("c", NO)])]);
  assert.deepEqual(built.meta.countMismatches, [
    { rollCallId: id, counted: { yes: 2, no: 1 }, published: { yes: 2, no: 0 } },
  ]);
});

/**
 * **生の字では数えられない**（**`countMismatchesOf` が `mapped` を見ている根拠**）。
 * **本番 `data/` の実測**: 賛成は `○`（10 県）と `〇`（徳島）、反対は `×`（8 県）と `●`（島根・徳島）。
 * **島根の `●` を `×` で数えると、島根の全 112 件が「反対 0」になり偽の食い違いが出る。**
 */
test("#826 島根の形（反対が ●）でも鳴らない——生の字ではなく凡例の意味で数えるから", () => {
  const SHIMANE_NO: LocalVote = { raw: "●", legend: "反対", mapped: "反対" };
  const SHIMANE_CHAIR: LocalVote = { raw: "議⾧", legend: "議長", mapped: "投票なし" };
  const built = build(roster, [
    rollCall("pref-04-398-20251217-発議案-1", { yes: 1, no: 1 }, [vote("a", YES), vote("b", SHIMANE_NO), vote("c", SHIMANE_CHAIR)]),
  ]);
  assert.equal(built.meta.countMismatches, undefined, "× ではなく ● で反対を数えている");
  assert.deepEqual(built.meta.countChecked, { rows: 1, checked: 1, noCounts: 0, unreadableCells: 0 });
});

/** **並びは固定する**（`rollCallId` 順。差分が読めるように） */
test("#826 複数行が食い違ったら全部載る（最初の 1 行で止まらない）", () => {
  const built = build(roster, [
    rollCall("pref-04-398-20251217-発議案-2", { yes: 1, no: 1 }, [vote("a", YES), vote("b", CHAIR_YES), vote("c", NO)]),
    rollCall("pref-04-398-20251217-発議案-1", { yes: 0, no: 1 }, [vote("a", YES), vote("b", CHAIR_YES), vote("c", NO)]),
  ]);
  assert.deepEqual(built.meta.countMismatches?.map((m) => m.rollCallId), [
    "pref-04-398-20251217-発議案-1", "pref-04-398-20251217-発議案-2",
  ]);
});

/** **`countMismatchesOf` は単体でも使える**（`buildLocalAssembly` に入る前の県ごとの run テストから叩けるように） */
test("#826 countMismatchesOf を直接叩ける", () => {
  const id = "pref-04-398-20251217-発議案-1";
  assert.deepEqual(countMismatchesOf([rollCall(id, { yes: 1, no: 1 }, [vote("a", YES), vote("b", CHAIR_YES), vote("c", NO)])]), {
    mismatches: [{ rollCallId: id, counted: { yes: 2, no: 1 }, published: { yes: 1, no: 1 } }],
    checked: { rows: 1, checked: 1, noCounts: 0, unreadableCells: 0 },
  });
});

/* ---------- 本番 data/ の実測を固定する ---------- */

/**
 * **本番 `data/` で、いま食い違っている行が 1 つでもあるか**（#826 の「まず測る」）。
 *
 * **測り方**: `data/assemblies/pref-*​/rollcalls/**​/*.json`（`index.json` を除く）を全部読み、
 * `counts.yes`／`counts.no`（公表値）と `votes[].value.mapped`（凡例から引いた意味）を数えて突き合わせた。
 *
 * | | 件数（#826 のとき） | **件数（今。#829 で更新）** |
 * |---|---:|---:|
 * | 採決（11 県ぜんぶ） | 1,369 | **1,785**（#901 で三重が 365 → 733、徳島が 105 → 153） |
 * | **`counts` の欄が無いので外した** | 341（奈良 125・徳島 105・高知 104・**秋田 7**） | **382**（奈良 125・**徳島 153**・高知 104。**秋田は 0 になった**） |
 * | **凡例の引けないセルがあるので外した** | 5（滋賀 4・鳥取 1） | **48**（滋賀 4・鳥取 1・**三重 43**） |
 * | **母数** | 1,023 | **1,355** |
 * | **食い違った行** | 0 | **0** |
 *
 * ## **#901 で 1,369 → 1,785 / 5 → 48 に動いた**（2026-09-20。**三重と徳島、2 回に分けて**）
 *
 * **三重の `--sessions` の既定を 2 → 4 にした**（`defaultSessionsFor`）。
 * **増えた 368 本のうち 43 本に「凡例の引けないセル」がある**——
 * **令和6年10月の 下野幸助（10月10日に議員辞職）の列を PDF が空欄にしており、
 * 「棄権」でも「欠席」でもないので推定せず `不明` で残した**（#569）。
 * **その 43 本は `○`/`×` の数を数えられないので、この突き合わせの外に出る。**
 * **三重のぶんでは `noCounts` 334 は 1 件も動かなかった**——**三重は 733 / 733 本すべてに `counts` がある。**
 *
 * **徳島の `--sessions` も 2 → 4 にした**（採決 105 → 153。**別の PR**）。
 * **徳島は `counts` の欄が PDF に無いので、増えた 48 本はそのまま `noCounts` に入る**
 * （**334 → 382**。`checked` は **1,355 のまま 1 件も動かない**）。
 * **つまり徳島を広げても、この突き合わせの母数は 1 件も増えない**——
 * **突き合わせる相手が公表されていないからである**（#757）。
 *
 * **食い違った行は 0 のまま**（**増えた 325 + 48 本も、公表値と数が合っている／相手が無い**）。
 *
 * **つまり今は 1 件も落ちていない。** **「落ちるから緩めた」のではない**——
 * **落ちる行が 0 のまま、落ちたときに何が起きるかを決めた**（件数として出す）。
 *
 * **`counts` を出力に入れていない 334 件は、この突き合わせの外にある**（#757——
 * 突き合わせる相手が公表されていないので、「合っている」とも「食い違っている」とも言えない）。
 *
 * ## **#829 で 341 → 334 / 1,023 → 1,030 に動いた。その理由を書いておく。**（2026-09-14）
 *
 * **#826 の担当者は「#829 がマージされて行の読み方が変わると、
 * 固定した 1,369 / 1,023 / 341 / 5 は変わりうる。その場合は本 PR のテストが落ちて知らせる」
 * と書いていた。** **予告どおりに落ちたので、実測に直した。**
 *
 * **動いたのは秋田の 7 件だけ**——**`readRows` の「いちばん近い錨に配る」に距離の上限が無く、
 * ページ下端のページ番号（`1` `2` `3`）が `counts` の数字に混ざって、
 * 「数字が 4 つある」状態になり `counts` が丸ごと捨てられていた**（#829 が直した機序）。
 *
 * **「公表記録に無い」のではなく「我々が読み落としていた」**ので、
 * **7 件は母数の外ではなく中に入るのが正しい。**
 * **`counts` が入った 7 件は、7 件とも `○`/`×` の数と一致する**（**だから食い違いは 0 のまま**）。
 * **推定した数は 1 つも無い**（#569。7 件とも PDF の原文の欄にある数）。
 *
 * **採決の数 1,369 は 1 件も変わっていない**——**#829 は行を増やしても減らしてもいない。**
 * **変えたのは「その行の `counts` を読めるかどうか」だけである。**
 */
test("#826 本番 data/: 母数 2,714 件のうち、記号の数と公表値が食い違う行は 0（測定の固定。#901 で 1,030 → 2,714。秋田で +397、宮城で +422、青森で +498、滋賀で +42）", async () => {
  const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));
  const prefs = (await readdir(join(DATA, "assemblies"), { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name.startsWith("pref-")).map((e) => e.name).sort();
  assert.equal(prefs.length, 11, "11 県ぶんを数えていること（母数が減ったらこの測定は無意味）");
  const total = { rows: 0, checked: 0, noCounts: 0, unreadableCells: 0 };
  const perPref: Record<string, number> = {};
  const mismatched: string[] = [];
  for (const p of prefs) {
    const rollCalls: LocalRollCall[] = [];
    for (const f of await walk(join(DATA, "assemblies", p, "rollcalls"))) rollCalls.push(JSON.parse(await readFile(f, "utf8")));
    const { mismatches, checked } = countMismatchesOf(rollCalls);
    for (const k of ["rows", "checked", "noCounts", "unreadableCells"] as const) total[k] += checked[k];
    if (checked.noCounts) perPref[p] = checked.noCounts;
    mismatched.push(...mismatches.map((m) => `${m.rollCallId}: 数えた ${m.counted.yes}/${m.counted.no} 公表 ${m.published.yes}/${m.published.no}`));
  }
  // **#901 で 1,369 → 1,785 → 1,902 → 2,530 → 2,585 → 3,036 / 1,030 → 1,355 → 1,752 → 2,174 / 5 → 48 → 77**
  // **宮城で 2 → 11（133 → 584 採決）**。**宮城は 584 / 584 本すべてに `counts` があるので
  // `noCounts` は 785 のまま動かない**。**`unreadableCells` の +29 は第393回の 石川光次郎 の
  // 空欄の列**（推定せず `不明` で残した。#569）——**その 29 本は突き合わせの外に出る。**
  // （**三重・徳島・奈良の会期を 2 → 4、高知を 2 → 5、秋田を 5 → 29 本会議日にした**。上の docblock）。
  // **`checked` は徳島でも高知でも 1 件も動かなかったが、秋田で 157 → 554 に増え、食い違いは 0 のまま**
  // （**増えた 397 件も、公表値と ○/× の数が 1 件残らず合っている**）。
  // **奈良を 2 → 4 会期にしても `checked` は 1 件も動かない**——**奈良の PDF に集計の欄が無く、
  // 125 → 180 がまるごと `noCounts` に行くため**（#865。**730 → 785**）。
  assert.deepEqual(total, { rows: 3683, checked: 2714, noCounts: 785, unreadableCells: 184 }, "母数が変わったら数え直すこと");
  // **内訳の和が母数**（#757。黙って母数から外していない）
  assert.equal(total.checked + total.noCounts + total.unreadableCells, total.rows, "内訳の和 = 母数");
  // **785 件の内訳**——**`counts` が出力に入っていない 4 県。**
  // ## **秋田の 231 件は #829 の逆戻りではない**
  // **#829 は「我々がページ番号を混ぜて counts を捨てていた」を直した**（読み落としの側）。
  // **この 231 件は違う**——**一次資料の反対者数の欄がそもそも空である**（`akita/votes-pdf.ts` の docblock）。
  // **`--sessions 5`（旧・本番）の 157 件には 1 件も無く、29 本に広げて出た形である。**
  // **「空欄 = 反対 0」と読む実装を実際に書いて 154 本で測った**——
  // **`--sessions 29` の範囲では 1 行も嘘にならないが、154 本では 180 行が嘘になる**
  // （**反対 32 人を 0 人と公表することになる行が実在する**。`akita-votes-pdf.test.ts` の #901）。
  assert.deepEqual(perPref, { "pref-05": 231, "pref-29": 180, "pref-36": 153, "pref-39": 221 });
  assert.equal(231 + 180 + 153 + 221, 785, "母数を式で残す");
  assert.deepEqual(mismatched, [], "食い違った行");
});

/**
 * **公表した `meta.json` が、公表した `rollcalls/` から計算し直したものと一致すること**（#778 と同じ理由）。
 *
 * **上のテストは `countMismatchesOf` を直に呼ぶので、`meta.json` の中身がずれても気づかない。**
 * **`meta.json` は運用者が見る唯一の窓**なので、そこが票と食い違ったまま出ている状態にしない。
 * **`rollcalls/` のほうを正とする**——票が一次資料に最も近い形だから。
 */
test("#826 公表した meta.json の countChecked / countMismatches は、公表した票から計算し直したものと一致する", async () => {
  const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));
  const prefs = (await readdir(join(DATA, "assemblies"), { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name.startsWith("pref-")).map((e) => e.name).sort();
  assert.equal(prefs.length, 11, "11 県ぶんを見ていること");
  for (const p of prefs) {
    const rollCalls: LocalRollCall[] = [];
    for (const f of await walk(join(DATA, "assemblies", p, "rollcalls"))) rollCalls.push(JSON.parse(await readFile(f, "utf8")));
    const meta = JSON.parse(await readFile(join(DATA, "assemblies", p, "meta.json"), "utf8")) as LocalAssemblyMeta;
    const { mismatches, checked } = countMismatchesOf(rollCalls);
    assert.deepEqual(meta.countChecked, checked, `${p}/meta.json の countChecked`);
    assert.deepEqual(meta.countMismatches ?? [], mismatches, `${p}/meta.json の countMismatches`);
  }
});
