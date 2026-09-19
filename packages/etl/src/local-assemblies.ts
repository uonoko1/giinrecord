import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type {
  Assembly, AssemblyId, AssemblySession, LocalAssemblyMeta, LocalMember, LocalMemberDetail, LocalRollCall, LocalRollCallSummary, LocalUnmatchedName, LocalVoteEntry, MemberAssemblyCount, MemberSummary,
} from "@seiji-kiroku/shared";
import { stableJson } from "./json.ts";
import { conflictingRosterNames, isLossyName, nonNameCharacters, unmatchedReason } from "./sources/local/name-match.ts";
import { normalizeTitle } from "./sources/local/title-normalize.ts";
import { MIYAGI_ASSEMBLY } from "./sources/local/miyagi/site.ts";
import { runMiyagi } from "./sources/local/miyagi/index.ts";
import { TOKUSHIMA_ASSEMBLY } from "./sources/local/tokushima/site.ts";
import { runTokushima } from "./sources/local/tokushima/index.ts";
import { TOTTORI_ASSEMBLY } from "./sources/local/tottori/site.ts";
import { runTottori } from "./sources/local/tottori/index.ts";
import { MIE_ASSEMBLY } from "./sources/local/mie/site.ts";
import { runMie } from "./sources/local/mie/index.ts";
import { NARA_ASSEMBLY } from "./sources/local/nara/site.ts";
import { runNara } from "./sources/local/nara/index.ts";
import { SHIMANE_ASSEMBLY } from "./sources/local/shimane/site.ts";
import { runShimane } from "./sources/local/shimane/index.ts";
import { KOCHI_ASSEMBLY } from "./sources/local/kochi/site.ts";
import { runKochi } from "./sources/local/kochi/index.ts";
import { SHIGA_ASSEMBLY } from "./sources/local/shiga/site.ts";
import { runShiga } from "./sources/local/shiga/index.ts";
import { AOMORI_ASSEMBLY } from "./sources/local/aomori/site.ts";
import { runAomori } from "./sources/local/aomori/index.ts";
import { AKITA_ASSEMBLY } from "./sources/local/akita/site.ts";
import { runAkita } from "./sources/local/akita/index.ts";
import { SAGA_ASSEMBLY } from "./sources/local/saga/site.ts";
import { runSaga } from "./sources/local/saga/index.ts";

export { MIYAGI_ASSEMBLY, TOKUSHIMA_ASSEMBLY, TOTTORI_ASSEMBLY, MIE_ASSEMBLY, NARA_ASSEMBLY, SHIMANE_ASSEMBLY, KOCHI_ASSEMBLY, SHIGA_ASSEMBLY, AOMORI_ASSEMBLY, AKITA_ASSEMBLY, SAGA_ASSEMBLY };

/** 議会ごとの取得部が返す形（buildLocalAssembly の入力になる部分）。 */
export interface LocalSourceRun {
  roster: { members: LocalMember[]; asOf: string };
  rollCalls: LocalRollCall[];
  sessions: LocalAssemblyMeta["sessions"];
  sources: LocalAssemblyMeta["sources"];
  /** 取得部が付けた名寄せの候補（鳥取 #184。姓だけの表記で同姓が 2 人以上のとき）。無い議会は省略 */
  unmatched?: LocalUnmatchedName[];
  /** 読めなかった一次資料（滋賀の画像 PDF 3 本。#741）。無い議会は省略 */
  unreadableSources?: { url: string; reason: string }[];
}
export interface LocalSource {
  assembly: Assembly;
  run(opts: { sessions: number; fetchedAt: string; log?: (line: string) => void }): Promise<LocalSourceRun>;
}
/** `pnpm etl:local <name>` の name → 議会。議会を足すときはここに 1 行足す（local-cli.ts は触らない）。 */
export const LOCAL_SOURCES: Record<string, LocalSource> = {
  miyagi: { assembly: MIYAGI_ASSEMBLY, run: runMiyagi },
  tokushima: { assembly: TOKUSHIMA_ASSEMBLY, run: runTokushima },
  tottori: { assembly: TOTTORI_ASSEMBLY, run: runTottori },
  mie: { assembly: MIE_ASSEMBLY, run: runMie },
  nara: { assembly: NARA_ASSEMBLY, run: runNara },
  shimane: { assembly: SHIMANE_ASSEMBLY, run: runShimane },
  kochi: { assembly: KOCHI_ASSEMBLY, run: runKochi },
  shiga: { assembly: SHIGA_ASSEMBLY, run: runShiga },
  aomori: { assembly: AOMORI_ASSEMBLY, run: runAomori },
  akita: { assembly: AKITA_ASSEMBLY, run: runAkita },
  saga: { assembly: SAGA_ASSEMBLY, run: runSaga },
};

/**
 * **`--sessions` を渡さなかったときの既定**（これまで全議会一律だった値。Issue #901）。
 * **`defaultSessionsFor` が議会ごとの値を持たないときに返す。**
 */
export const DEFAULT_LOCAL_SESSIONS = 2;

/**
 * **議会ごとの `--sessions` の既定**（Issue #901）。
 *
 * ## なぜ議会ごとに違う値なのか——**一律に広げてはいけない**
 *
 * **地方の名簿は「今の名簿」1 枚しか公表されていない**（`LocalMemberTerm` は `asOf` しか持たず、
 * 任期の開始日も終了日も持たない）。**一般選挙をまたいだ採決にその名簿を当てると、
 * 引退した議員の票が今の別人に付きうる**——**利用者から検出できない虚偽である**（#569 の重いほう）。
 * **`rosterWindowOf` / `LOCAL_TERM_DAYS`（#928）はこれを捕まえない**——
 * **捕まえるのは「名簿が 1 任期ぶん古すぎる」だけで、「氏名が一致したが別人」は素通りする。**
 *
 * **だから既定は「その議会で、今の任期に収まる会期の数」でなければならない。**
 * **任期の境は議会ごとに違うので、1 つの数では書けない。**
 *
 * ## **三重 = 4 の根拠**（2026-09-20、index の賛否 PDF 151 本すべてを取得して実測）
 *
 * **会期ごとに「PDF に出る氏名の集合」を数えると、一般選挙の年に 9 人が入れ替わる**
 * ——**選挙の日付を外から持ち込まず、一次資料（PDF の氏名そのもの）だけで境が見える:**
 *
 * | 会期 | 氏名 | 直前と共通 | **入れ替わり** | 採決の期間 |
 * |---|---:|---:|---:|---|
 * | r07 | 50 | 47 | 3 | 2025-01-20〜2025-12-22 |
 * | r06 | 49 | 46 | 3 | 2024-02-20〜2024-11-21 |
 * | **r05-2** | 48 | 48 | **0** | **2023-05-12〜2023-12-21** |
 * | **r05-1** | 49 | 40 | **9** | **2023-03-02〜2023-03-17** |
 * | h31 | 48 | 39 | **9** | 2019-02-26〜2019-03-15 |
 * | h27-1 | 49 | 40 | **9** | 2015-02-24〜2015-03-17 |
 *
 * **9 人の入れ替わりが 4 年ごと（2023-03 / 2019-03 / 2015-03 の次の会期）に出る。**
 * **r05-2 以降の入れ替わりは 0〜3 人で、これは任期中の辞職・補選の規模である。**
 *
 * **`--sessions 4`（r08 / r07 / r06 / r05-2）が、今の任期に収まる最大である。**
 * **`--sessions 5` は r05-1 を足して一般選挙をまたぐので、採らない。**
 *
 * **検算**: **この 4 会期に出る 53 の氏名のうち 47 が名簿と完全一致し、
 * 名簿の 47 人は 1 人残らずこの範囲の PDF に現れる**（`.measure/901/n4names.ts`）。
 * **寄らない 6 人はいずれも辞職・引退した議員で、票は `memberId` 空のまま残る**（#529）。
 * **部分列でしか寄らなかった組は 0 組**（30 会期すべてで数えた）。
 *
 * ## **徳島 = 4 の根拠**（2026-09-20、実装が到達できる 28 会期・28 本の PDF をすべて取得して実測）
 *
 * **徳島で効いている上限は名簿ではなく「読めるか」である。**
 * **`parseVotePdf` が読めるのは、いちばん新しい 7 本だけ**（#875 が index 87 本で 7 本と測った形が、
 * 到達可能な 28 本でもそのまま出る）:
 *
 * | `--sessions` | 会期 | PDF | 読めた | 採決 | **止まる理由** |
 * |---:|---|---:|---:|---:|---|
 * | 2 | 2026-09 / 2026-06 | 2 | 2 | **21** | — |
 * | 3 | ＋2026-02 | 5 | 5 | **106** | — |
 * | **4** | **＋2025-11** | **7** | **7** | **153** | — |
 * | 5 | ＋2025-09 | — | — | — | **会期ページが例外**（`no 各議員の表決態度 PDF`。リンク文言が `(N月N日採決)` の半角括弧で `PDF_TEXT` に合わない。#875） |
 * | 6〜18 | 2025-06 〜 2022-05 | 21 | **0** | **0** | **1 本も読めない**（凡例の字の高さが窓の外・記号が 1 行 1 アイテム。#875 の A 群・② 群） |
 * | 19 以降 | 2022-02 以前 | — | — | — | **会期ページが例外**（同上） |
 *
 * **`--sessions 5` は例外で止まる。`--sessions 6` 以降は 1 行も増えない。**
 * **だから 4 が、今の実装で取れるものの全部である。**
 *
 * ## **4 が任期の内側に収まることを、一次資料だけで確かめた**
 *
 * **選挙の日付を外から持ち込まず、「会期ごとに PDF に出る氏名の集合」を数えた**
 * （**凡例で落ちる本からも氏名は採れる**——`readMembers` は凡例の検査より前に走る）:
 *
 * | 会期 | 氏名 | 直前（古い側）と共通 | **入れ替わり** |
 * |---|---:|---:|---|
 * | 2026-09 / 2026-06 | 36 | 36 | 0 |
 * | **2026-02** | **36** | **36** | **OUT 2**（北島 一人・古川 広志） |
 * | 2025-11 〜 2023-05 | 38 | 38 | **0**（9 会期とも同じ 38 人） |
 * | **2023-05** | **38** | **25** | **IN 13 / OUT 11** ← **ここが一般選挙の境** |
 * | 2023-02 〜 2022-05 | 36 | 36 | 0 |
 *
 * **13 人が入り 11 人が去る不連続が 2023-02 と 2023-05 の間に 1 回だけ出る。**
 * **それ以外の会期の入れ替わりは 0〜2 人で、任期中の辞職の規模である。**
 * **`--sessions 4`（2026-09 / 2026-06 / 2026-02 / 2025-11）は、この境のずっと内側にある。**
 *
 * **検算**: **今の名簿 36 人は、2025-11 会期の 38 人に 1 人残らず含まれる**（実測）。
 * **寄らない 2 人（北島 一人・古川 広志）は 2026-02 より前に退いた議員で、票は `memberId` 空のまま残る**（#529）。
 *
 * ## **広げる前に直した欠陥**（**これが無いと `--sessions 4` は例外で止まる**）
 *
 * **`1028727.pdf`（2025-12-19 採決）は 4 枚の表を持ち、4 枚目だけ 11 列目と 12 列目が入れ替わっている**
 * （`沢本 勝彦` ↔ `川真田琢巳`。**PDF のグリフの x 座標そのものが違う**）。
 * **直す前は「1 枚目と違えば例外」だったので、この会期がまるごと出なかった。**
 * **「1 枚目の並びを使い回す」直し方をすると 14 票が別人に付く**（7 行 × 2 人。#569 の重いほう）。
 * **だから `VotePdfRow.members` を足し、行が自分の表の並びを持つようにした。**
 * **`--sessions 2` の 2 本には 1 件も無い形である。**
 *
 * ## **他の 9 議会を 2 のままにした理由**
 *
 * **#901 は「1 県ずつやってよい。11 県を一度に広げないこと」としている。**
 * **この値を変えるには、その議会で同じ 4 つを測る必要がある**——
 * **(1) どこまで読めるか (2) 採決とセルがいくつ増えるか
 * (3) `unmatched` と `unknownCells` がいくつ増えるか (4) 増えた会期に x と y の錨が当たるか。**
 * **測っていない議会の数を動かさない。**
 */
const LOCAL_SESSIONS_DEFAULT: Readonly<Record<string, number>> = {
  // **三重 pref-24**: 令和8年 / 令和7年 / 令和6年 / 令和5年第2回。**令和5年第1回は 2023年4月の一般選挙の前**
  mie: 4,
  // **徳島 pref-36**: 令和8年9月 / 6月 / 2月 / 令和7年11月。**5 会期目は会期ページが例外で止まり、
  // 6 会期目以降は 1 本も読めない**（2023-05 の一般選挙の境よりはるかに手前で、読めるほうが先に尽きる）
  tokushima: 4,
};

/** **その議会の `--sessions` の既定**。持っていない議会（と知らない名前）には `DEFAULT_LOCAL_SESSIONS`。 */
export function defaultSessionsFor(target: string): number {
  return LOCAL_SESSIONS_DEFAULT[target] ?? DEFAULT_LOCAL_SESSIONS;
}

/**
 * 地方議会の出力（Issue #157、docs/DATA_CONTRACT.md「地方議会の Web 表示が読む形」#158）。Web は何も変えずに読める形で書く。
 *   data/assemblies/index.json                        国会の 2 行 ＋ 地方議会の行（この ETL は自分の行だけ入れ替える）
 *   data/members/index.json                           国会の行の後に地方議員の行（LocalMember。自分の議会の行だけ入れ替える）
 *   data/members/{memberId}.json                      LocalMemberDetail（timeline は localVote の行、新しい順）
 *   data/assemblies/{assemblyId}/sessions.json        AssemblySession[]（新しい順）
 *   data/assemblies/{assemblyId}/meta.json            LocalAssemblyMeta
 *   data/assemblies/{assemblyId}/rollcalls/index.json LocalRollCallSummary[]（新しい順）、rollcalls/{sessionId}/{id}.json LocalRollCall（表決の原本）
 *   data/assemblies/{assemblyId}/unmatched.json       LocalUnmatchedName[]
 * 国会の日次 ETL（dataset.ts）とは assemblies/index.json と members/index.json を共有する（互いに相手の行を残す）。
 */
export interface LocalAssemblyInput {
  assembly: Assembly;
  members: LocalMember[];
  rollCalls: LocalRollCall[];
  fetchedAt: string;
  rosterAsOf: string;
  sources: LocalAssemblyMeta["sources"];
  sessions: LocalAssemblyMeta["sessions"];
  /** 取得部が付けた名寄せの候補（同姓が 2 人以上のとき。#184）。unmatched.json は rollCalls の memberId 空の票から作り直すので、候補だけここから写す */
  unmatched?: LocalUnmatchedName[];
  /** 読めなかった一次資料（滋賀の画像 PDF 3 本。#741）。無い議会は省略 */
  unreadableSources?: { url: string; reason: string }[];
}

export interface LocalAssemblyDataset {
  assembly: Assembly;
  index: LocalMember[];
  details: LocalMemberDetail[];
  sessions: AssemblySession[];
  rollCallIndex: LocalRollCallSummary[];
  rollCalls: LocalRollCall[];
  unmatched: LocalUnmatchedName[];
  meta: LocalAssemblyMeta;
}

const byDateDesc = <T extends { date: string; id?: string; rollCallId?: string }>(a: T, b: T) =>
  (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) || cmp(a.id ?? a.rollCallId ?? "", b.id ?? b.rollCallId ?? "");
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** ディレクトリ以下の *.json を全部集める（無ければ []）。 */
async function walkJson(dir: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkJson(p)));
    else if (e.name.endsWith(".json")) out.push(p);
  }
  return out.sort(cmp);
}
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 国会の行か（`diet-` の assemblyId、または assemblyId の無い古い行）。地方議員は `diet-` 以外の assemblyId を持つ。 */
export const isDietMemberRow = (m: { assemblyId?: string }): boolean => m.assemblyId === undefined || m.assemblyId.startsWith("diet-");

/**
 * かな長 / 氏名長（空白を除く）がこれを超えたら、氏名が壊れている疑い（#632）。
 *
 * ## **何を見ているか**（#771 で実態に合わせた。2026-09-13）
 *
 * **見ているのは `members/index.json` の 1 行、つまり名簿の氏名と名簿のかなである。**
 * **採決の PDF から読んだ氏名はこの検算を一度も通らない**（呼び出しは
 * `local-assemblies.ts` と `dataset.ts` の 2 か所で、どちらも引数は `m.name, m.kana`）。
 *
 * **この docblock は 2026-09-13 まで「氏名は名簿の PDF から、かなは名簿の HTML から取るので、
 * 独立した 2 つの値による検算になる」と書いていたが、それは事実ではなかった**（#763 / #771）:
 *
 * - **名簿を作る 13 モジュール（地方 11 県の `roster.ts` + 衆院 + 参院）のうち、
 *   氏名を PDF から取るものは 0。13 すべてが `node-html-parser` で HTML から作る。**
 * - **衆院も参院も、氏名は `tds[0]` の `<a>`、かなは同じ `<tr>` の `cells[1]`**——
 *   **1 回の fetch で取った 1 つの HTML の、1 つの行である。**
 * - **PDF を読む 16 モジュールはすべて採決の投票用紙（`votes-pdf.ts`）か選挙区の資料で、
 *   名簿を作るものは 1 つも無い。**
 *
 * **つまり氏名とかなは同じ源から来るので、片方だけが静かに欠ける経路が無い。**
 * **「独立した 2 つの値による検算」は国会でも地方でも成り立っていない**（`kana-ratio-provenance.test.ts`）。
 *
 * ## **したがって、この検算は PDF 側の壊れ方を守らない**
 *
 * **#617（大分）/ #529（青森）の「フォントのサブセットに文字が無く、描画命令ごと欠落する」は
 * PDF 側で起きるので、名簿は無傷であり、この比は動かない。**
 * **それを守っているのは `meta.lossyNameMatches`**（名簿に寄った後で
 * **PDF の氏名が名簿の氏名の部分列で、かつ短い**ことを積む。#750 が青森に置き、
 * **#778 で `lossyNameMatchesOf` として 11 県すべてが通る 1 か所に移した**）
 * **と `unmatched.json` の `sourceConflict`**（#711）である。
 *
 * **この検算が実際に守るのは「名簿の HTML 自体が壊れた／読み違えた」場合だけ**で、
 * **しかも氏名が 2 文字前後のときしか鳴らない**（下の閾値の根拠と、次の実測）。
 *
 * **実測（2026-09-13、`data/members/index.json` 1,225 名。氏名から 1 文字ずつ落とした全通りに掛けた）**:
 * **国会 3,106 通り中 14 通り（0.45%）／地方 1,448 通り中 5 通り（0.35%）／合計 4,554 通り中 19 通り（0.42%）。**
 * **国会でも地方でもほとんど鳴らない**ので、**これを主たる守りとして数えない。**
 *
 * **閾値を下げて「効くようにする」のは逆**（#771）——**見ている対象が違うだけなので、
 * 下げても PDF 側の欠落は捕まらず、偽陽性だけが増える。**
 * **実測: 閾値を 1.7 にすると 1 文字欠落は 4,097/4,554（89.96%）鳴るようになるが、
 * 同時に「壊れていない本物の議員」1,225 名のうち 739 名（60.3%）が鳴る**——
 * **守りが増えるのではなく、全部が鳴って誰も見なくなる。**
 *
 * 閾値 3.5 の根拠（2026-09-08 実測。data/ の全議員 1,057 名、由来が同じ index.json 分を除く実体数）:
 * - 実データの比の最大値は 3.0（「東 徹」「東 豊」の 2 名、ratio = かな5拍 / 氏名2文字）。3.5 ならこれを含め全件が通る。
 * - PO 案の 4.0 は「実データの氏名が2文字まで短くなったときの1文字欠落」を検出できない
 *   （2文字氏名5名の1文字欠落シミュレーションで、4.0 超は 5 件中 3 件のみ検出、3.5 超なら 5 件とも検出）。
 * - 氏名が3文字以上で1文字欠けるケースは、この閾値でもほとんど検出できない
 *   （4文字氏名の1文字欠落シミュレーションで比は 2.0〜2.67 程度にしかならず、3.5 に届かない。
 *   #617 の実例 `𠮷村哲彦→村哲彦` も欠落後の比は 2.67 で、この検算では検出できない）。
 *   **この検算は短い氏名（2文字前後）で1文字が丸ごと消えるケースしか拾えない**という限界がある。
 *
 * かなが空の議員がいる（HTML の名簿から取れなかった、または未取得）。空は異常ではなく「比較できない」なので、
 * 呼び出し側は kana === "" を先に弾いてから使うこと（このタプルからは判定しない）。
 */
export const KANA_NAME_RATIO_THRESHOLD = 3.5;

/** 空白を除いた文字数（コードポイント単位。サロゲートペアも1文字と数える）。 */
const strippedLength = (s: string): number => [...s.replace(/[\s　]/g, "")].length;

/**
 * name / kana の組が #632 の検算に違反するか（かなが空なら常に false。比較できないため）。
 * name が空文字列になる壊れ方（全消失）は kanaLen > 0 なので Infinity 相当になり、必ず超過する。
 */
export function kanaNameRatioExceeds(name: string, kana: string, threshold = KANA_NAME_RATIO_THRESHOLD): boolean {
  if (kana === "") return false;
  const nameLen = strippedLength(name);
  const kanaLen = strippedLength(kana);
  if (nameLen === 0) return kanaLen > 0;
  return kanaLen / nameLen > threshold;
}

/** timeline の 1 行。公表の原文（会期・方法・結果）をそのまま添える。可否は判定しない。 */
function toVoteEntry(rc: LocalRollCall, vote: LocalRollCall["votes"][number]): LocalVoteEntry {
  return { kind: "localVote", date: rc.date, rollCallId: rc.id, title: rc.title, vote: vote.value, sessionLabel: rc.sessionLabel, method: rc.method?.raw, result: rc.result, sourceUrl: rc.sourceUrl };
}

/**
 * `unmatched.json` の 1 行を、運用者が**次に何をすればよいか**が分かる 1 行にする（#680／#711）。
 *
 * **`unmatched.json` に落とすだけでは「名簿に無い議員だ」と読まれる**（#680 の案A の欠点）。
 * 理由ごとに、確かめる先が違う:
 *   - 理由なし → 名簿を直す（任期途中で入れ替わった／名簿の取得が古い）
 *   - `brokenGlyph` → PDF の文字層を疑う。**元の字は推定しない**（#569／#674）
 *   - `sourceConflict` → **どちらの表記が正しいかを議会に確かめる。**
 *     ここでも**どちらかに寄せない**——1 文字違いは同一人物の根拠にならない（`conflictingRosterNames`）。
 *
 * `local-cli.ts` は起動しただけで走るスクリプトなのでテストから import できない。
 * **だからメッセージの組み立てはここに置く**（テストが読める側に置く。#680 の validate と同じ考え）。
 */
export function describeUnmatched(u: LocalUnmatchedName, roster: readonly { id: string; name: string }[]): string {
  const parts = [`${u.nameText}（${u.group}）: ${u.rollCallIds.length} roll calls`];
  if (u.candidates?.length) parts.push(`candidates (not chosen): ${u.candidates.map((c) => c.name).join(" / ")}`);
  if (u.reason === "brokenGlyph") {
    const chars = nonNameCharacters(u.nameText).map((c) => `${JSON.stringify(c)} U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`).join(" ");
    parts.push(`the PDF's own text layer is broken here: ${chars} cannot be part of a name (not guessed back. #680)`);
  }
  if (u.reason === "sourceConflict") {
    const near = conflictingRosterNames(u.nameText, roster).map((c) => `${c.name} (${c.id})`).join(" / ");
    parts.push(`primary sources disagree on this name: the roster has ${near}, one character apart. ask the assembly which spelling is right; do NOT pick one (#711/#569)`);
  }
  return parts.join("; ");
}

/**
 * **字が落ちたまま名簿に寄った氏名**を、採決の票から数える（Issue #778。#749 の機序 ②）。
 *
 * ## **どこに置くか——11 県すべてが通る 1 か所**
 *
 * **これは #750（青森）が置き、#759（秋田）・#768（佐賀）が写した判定だが、
 * 3 県それぞれの `rollcalls.ts` に同じコードが 3 回書かれており、残り 8 県には無かった。**
 * **`buildLocalAssembly` が `unmatched.json` の `reason` を 1 か所で付けているのと同じ理由でここに置く**
 * ——**県ごとに書くと足し忘れが黙って落ちる**（#680 の判断）。
 * **実際に落ちていた**: **本番 `data/` の 58,057 票を数えると奈良に 2 件あり、
 * `nara/rollcalls.ts` の docblock はそれを知っていたのに、公表データのどこにも出ていなかった。**
 *
 * ## **要る材料はこの関数の引数で足りている**
 *
 * 判定に要るのは **(PDF の氏名, 寄った先の memberId)** と **名簿** だけで、
 * どちらも `buildLocalAssembly` の引数にある（`rollCalls[].votes[].nameText` / `.memberId` と `members`）。
 * **PDF の読み方が県ごとに違っても、ここに来る形は同じ**なので、名簿の取り方の違いに依存しない。
 *
 * **`rollCalls` は「その氏名が出た採決の数」**（3 県の実装と同じ数え方）。
 * **同じ採決に同じ氏名が 2 度出ることは無い**（列が 1 人 1 つ）ので、票の数ではなく採決の数を数える。
 */
export function lossyNameMatchesOf(
  rollCalls: readonly LocalRollCall[],
  members: readonly { id: string; name: string }[],
): NonNullable<LocalAssemblyMeta["lossyNameMatches"]> {
  const nameOf = new Map(members.map((m) => [m.id, m.name]));
  const out = new Map<string, NonNullable<LocalAssemblyMeta["lossyNameMatches"]>[number]>();
  for (const rc of rollCalls) {
    const seen = new Set<string>();
    for (const v of rc.votes) {
      if (v.memberId === "") continue;
      const rosterName = nameOf.get(v.memberId);
      // **名簿に無い memberId はここでは黙る**——それは別の壊れ方で、`buildLocalAssembly` が例外にする
      if (rosterName === undefined || !isLossyName(v.nameText, rosterName)) continue;
      const k = `${v.nameText}\t${v.memberId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const cur = out.get(k) ?? { nameText: v.nameText, memberId: v.memberId, rosterName, rollCalls: 0 };
      cur.rollCalls++;
      out.set(k, cur);
    }
  }
  return [...out.values()];
}

/**
 * **記号の数と公表値（`counts`）を突き合わせる**（Issue #826）。**11 県すべてが通る 1 か所。**
 *
 * ## なぜ例外にしないか
 *
 * **5 県（宮城・鳥取・島根・佐賀・高知）はこれを `assert.equal` で突き合わせてきた**が、
 * **食い違いの原因は「記号の取りこぼし」だけではない。**
 * **山梨には、公表された賛成者数に議長の `〇` が入っていない行が 2 つある**（#782／#811）。
 * **佐賀にも同じ事象（知事の再議・三分の二未満で否決）の行が実在するが、佐賀では議長を数えているので合っている**（#825）。
 * **同じ事象でも県ごとに数え方が違うので、食い違いは「壊れている」の証明にならない。**
 * **止めれば正しい記録まで出なくなる**ので、**件数として残す**（#811 の PO の判断）。
 *
 * ## なぜ `mapped`（凡例から引いた意味）で数えるか——**生の字では数えられない**
 *
 * **本番 `data/` の 58,000 票を数えた実測**: 賛成は `○`（10 県）と `〇`（徳島）、
 * 反対は `×`（8 県）と `●`（島根・徳島）に分かれている。
 * **島根の `●` を `×` で数えれば、島根の全 112 件が「反対 0」になり、偽の食い違いが 112 件出る。**
 * **`mapped` は各県が凡例（PDF の原文）から引いた意味なので、県ごとの字に依存しない。**
 *
 * ## 母数から外すもの（**外した数も返す**。#757）
 *
 * - **`counts` の欄が無い行**（本番 334 件。奈良 125・徳島 105・高知 104。**2026-09-14 実測**——
 * **秋田の 7 件は #840 が埋めたので 0 になった**）——**突き合わせる相手が無い。**
 * - **凡例の引けないセルがある行**（本番 5 件。滋賀 4・鳥取 1）——**`mapped` が無いセルは賛成とも反対とも数えられない。**
 *   **滋賀の 4 行は生の字では公表値と合っている**（`legend` が `抽出不能` なだけ）ので、
 *   **母数に入れると「票が食い違った」という偽の件数になる**（食い違っているのは凡例の読みであって、票ではない）。
 *
 * **議長の行は外さない**——`議` は `mapped: "投票なし"` なので賛成にも反対にも数えず、自然に合う。
 * **議長が投票した行は一番壊れやすいので、検算の外に出さない**（#811 で PO が退けた案 ②）。
 */
export function countMismatchesOf(rollCalls: readonly LocalRollCall[]): {
  mismatches: NonNullable<LocalAssemblyMeta["countMismatches"]>;
  checked: LocalAssemblyMeta["countChecked"];
} {
  const mismatches: NonNullable<LocalAssemblyMeta["countMismatches"]> = [];
  const checked = { rows: 0, checked: 0, noCounts: 0, unreadableCells: 0 };
  for (const rc of rollCalls) {
    checked.rows++;
    if (!rc.counts) { checked.noCounts++; continue; }
    if (rc.votes.some((v) => v.value.mapped === undefined)) { checked.unreadableCells++; continue; }
    checked.checked++;
    const yes = rc.votes.filter((v) => v.value.mapped === "賛成").length;
    const no = rc.votes.filter((v) => v.value.mapped === "反対").length;
    if (yes === rc.counts.yes && no === rc.counts.no) continue;
    mismatches.push({ rollCallId: rc.id, counted: { yes, no }, published: { yes: rc.counts.yes, no: rc.counts.no } });
  }
  return { mismatches: mismatches.sort((a, b) => cmp(a.rollCallId, b.rollCallId)), checked };
}

/** 2 つの ISO 日付の差（日数）。`to - from`。 */
const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * **地方議会議員の任期 4 年（地方自治法 93 条 1 項）を日数にしたもの。うるう年を 1 回含めて 1,461 日。**
 *
 * **これは「どこまで許すか」の好みの値ではなく、一次資料から決まる上限である**（#928）:
 * **`rosterAsOf` から 1,461 日より離れた採決は、間に必ず一般選挙を挟んでいる**
 * ——**その名簿がその採決の議会を写している可能性は無い。**
 *
 * **1,461 日以内なら安全、という意味ではない**（**任期の途中でも辞職・死去・補選で名簿は動く**）。
 * **「ここから先は確実に別の議会である」という一方向の線だけを引いている。**
 * **`rosterWindowOf` の docblock のとおり、名簿に任期が無いので、これ以上細かくは言えない。**
 *
 * **実測 2026-09-20（本番 `data/` の 11 議会）: いちばん開いている鳥取で 1,156 日。**
 * **11 議会とも 1,461 日以内なので、この検査は今 1 件も鳴らない**
 * （**足した時点で赤くならない**——#928 の完了条件）。**鳥取の残りは 305 日である。**
 */
export const LOCAL_TERM_DAYS = 1_461;

/**
 * **名簿の掲載日（`rosterAsOf`）と、その名簿を当てた採決の日付の関係**（Issue #928）。
 *
 * ## **何を測るか**
 *
 * **地方の名簿は「掲載日時点の一枚の写真」である**——`LocalMemberTerm` は `asOf` しか持たず、
 * **任期の開始日も終了日も持たない**（`packages/shared/src/index.ts` の `LocalMemberTerm`:
 * 「国会の MemberTerm（院・回次・任期）に当たる情報は名簿に無いので持たない」）。
 * **だから「この議員はこの採決の日に在職していたか」は、我々のデータからは答えられない。**
 *
 * **答えられないものを答えたふりをしない**（#569）。**ここが返すのは「どれだけ離れているか」だけである。**
 *
 * - `daysAfter` — **最新の採決が `rosterAsOf` より何日後か**（負なら名簿のほうが新しい）
 * - `daysBefore` — **最古の採決が `rosterAsOf` より何日前か**（負なら採決のほうが新しい）
 * - `votesAfter` / `votesBefore` — **窓の外に出ている採決の本数**（母数は `rollcalls`。#757）
 *
 * ## **なぜ「後ろに出ていること」自体を違反にしないか**
 *
 * **実測 2026-09-20（本番 `data/` の 11 議会・1,369 本）: 7 議会で `daysAfter > 0` である。**
 * **いちばん開いているのは鳥取の 1,156 日**（`rosterAsOf` 2023-04-30 / 最新の採決 2026-06-29）。
 * **だが 11 議会すべてで「名簿に無い memberId」は 0 件**（母数 58,057 セル）——
 * **鳥取の任期が 2023〜2027 なので、2023 年の名簿が 2026 年の採決にそのまま当たっている。**
 *
 * **つまり「窓の外に出ている」は、それ自体では壊れていることを意味しない。**
 * **違反にすれば今すぐ 7 議会が赤くなるが、赤くなった先に直すものが無い**
 * （名簿の一次資料は「今の名簿」1 枚しか公表されていない。過去の名簿は取得できない）。
 * **直せない赤は、やがて誰も見なくなる**（#785「見ていない検出器は、無い検出器と同じ」）。
 *
 * ## **では何が危ないのか**——**任期をまたいだときに起きること**
 *
 * **#901 が `--sessions` を広げると、任期をまたぐ採決が入る。そのとき 2 つのことが起こりうる:**
 *
 * 1. **引退した議員の氏名が今の名簿に無い** → 突合が `memberId: ""` を返し、`unmatched.json` に落ちる。
 *    **これは「記録が出ない」側で、利用者から見える**（#569）。
 * 2. **引退した議員の氏名が、今の名簿の別人に当たる** → **その別人の記録として出る。**
 *    **これは利用者から検出できない虚偽であり、1 より重い**（#569）。
 *
 * **2 を既存の守りは 1 つも捕まえない**——**当たった `memberId` は名簿に実在するからである**
 * （`validateLocalAssemblies` の `memberId ... not in members/index.json` も、
 * `buildLocalAssembly` の `vote memberId ... is not in the roster` も、どちらも素通りする）。
 *
 * **実測しておく（2026-09-20）**: **今の名簿から 1 人ずつ抜いて、その人が実際に投じた `nameText` を
 * 各県の突合規則で引き直した 453 通りでは、別人に決まった例は 0 件で、453 通りとも `unmatched` に落ちた。**
 * **「2 は今のデータでは再現しない」までが実測である**——**起こりえないという意味ではない。**
 * **だから 2 を直接見張ることはできない。見張れるのは「窓がどれだけ開いているか」だけである。**
 *
 * **返すのは事実だけで、判断はしない。** 判断（どこまで開いてよいか）は呼ぶ側に置く。
 */
export function rosterWindowOf(rosterAsOf: string, rollCalls: readonly { date: string }[]): {
  rosterAsOf: string;
  rollcalls: number;
  first?: string;
  last?: string;
  daysAfter: number;
  daysBefore: number;
  votesAfter: number;
  votesBefore: number;
} {
  const dates = rollCalls.map((rc) => rc.date).filter((d) => ISO_DATE.test(d)).sort(cmp);
  // **母数は採決の本数であって、日付が読めた本数ではない**（#757。読めない日付があれば下の件数と合わなくなる）
  const base = { rosterAsOf, rollcalls: rollCalls.length };
  if (dates.length === 0) return { ...base, daysAfter: 0, daysBefore: 0, votesAfter: 0, votesBefore: 0 };
  const first = dates[0];
  const last = dates[dates.length - 1];
  return {
    ...base, first, last,
    daysAfter: daysBetween(rosterAsOf, last),
    daysBefore: daysBetween(first, rosterAsOf),
    votesAfter: dates.filter((d) => d > rosterAsOf).length,
    votesBefore: dates.filter((d) => d < rosterAsOf).length,
  };
}

/**
 * **`rollcalls/index.json` の行を、採決の原本（`rollcalls/{sessionId}/{id}.json`）から作る**（Issue #851）。
 *
 * ## 何が問題だったか
 *
 * **#840 が秋田の `counts` 7 件を個別ファイルと `meta.json` に入れたが、`index.json` は古いままだった。**
 * **本番の採決ページは `index.json` を読むので、公表されている人数が
 * 「人数は公表記録にありません」と表示され続けた**（利用者から検出できない虚偽。#569 より悪い側）。
 *
 * **`index.json` は「採決の原本から `votes` を落としただけ」**——**独立した記録ではない。**
 * **だから作る側（`buildLocalAssembly`）と検算する側（`validateLocalAssemblies`）が
 * この 1 つの関数を共有する**（`countMismatchesOf` / `lossyNameMatchesOf` と同じ形）。
 * **手で写さない**——写せば同じずれがまた起きる。
 *
 * **並びは `buildLocalAssembly` の `rollCalls` と同じ（日付の降順 → id 順）。**
 */
export function rollCallIndexOf(rollCalls: readonly LocalRollCall[]): LocalRollCallSummary[] {
  return [...rollCalls].sort(byDateDesc).map(({ votes: _v, ...s }) => s);
}

export function buildLocalAssembly(input: LocalAssemblyInput): LocalAssemblyDataset {
  const ids = new Set<string>();
  for (const rc of input.rollCalls) {
    if (ids.has(rc.id)) throw new Error(`duplicate rollCall id ${rc.id}`);
    ids.add(rc.id);
    if (rc.assemblyId !== input.assembly.id) throw new Error(`${rc.id}: assemblyId ${rc.assemblyId} !== ${input.assembly.id}`);
  }
  // 件名の字だけ正規化する（#648）。ここは 7 議会すべての採決が通る 1 か所で、
  // rollcalls/{id}.json・rollcalls/index.json・members/{id}.json の timeline はすべてこの rollCalls から作る。
  // votes（氏名・vote.raw）はスプレッドでそのまま持ち越す＝原文のまま。
  const rollCalls = input.rollCalls.map((rc) => ({ ...rc, title: normalizeTitle(rc.title) })).sort(byDateDesc);
  const timelines = new Map<string, LocalVoteEntry[]>();
  const unmatched = new Map<string, LocalUnmatchedName>();
  let cells = 0;
  let unknownCells = 0;
  for (const rc of rollCalls) {
    for (const v of rc.votes) {
      cells++;
      if (v.value.raw === "不明") unknownCells++;
      if (v.memberId === "") {
        const key = `${v.nameText}\t${v.group}`;
        const u = unmatched.get(key) ?? { nameText: v.nameText, group: v.group, rollCallIds: [] };
        u.rollCallIds.push(rc.id);
        unmatched.set(key, u);
        continue;
      }
      const list = timelines.get(v.memberId) ?? [];
      list.push(toVoteEntry(rc, v));
      timelines.set(v.memberId, list);
    }
  }
  const memberIds = new Set(input.members.map((m) => m.id));
  for (const id of timelines.keys()) if (!memberIds.has(id)) throw new Error(`vote memberId ${id} is not in the roster`);
  const details: LocalMemberDetail[] = input.members.map((m) => {
    const timeline = (timelines.get(m.id) ?? []).sort(byDateDesc);
    return { ...m, counts: { rollcalls: timeline.length }, terms: [{ group: m.group, district: m.district, asOf: m.asOf }], timeline };
  });
  const index: LocalMember[] = details.map(({ timeline: _t, terms: _terms, ...m }) => m);
  const candidates = new Map((input.unmatched ?? []).filter((u) => u.candidates?.length).map((u) => [`${u.nameText}\t${u.group}`, u.candidates!]));
  const unmatchedList = [...unmatched.values()]
    .map((u) => {
      const c = candidates.get(`${u.nameText}\t${u.group}`);
      // 「なぜ寄せられなかったか」は全県が通るここで付ける（県ごとに書くと足し忘れが黙って落ちる。#680）
      // 名簿を渡すのは #711（一次資料どうしの食い違い）を見るため。**寄せるためではない**——
      // 1 文字違いは同一人物の根拠にならない（本番名簿に現職どうしの組が 3 組ある）。
      const reason = unmatchedReason(u.nameText, input.members);
      return { ...u, rollCallIds: [...u.rollCallIds].sort(cmp), ...(c ? { candidates: c } : {}), ...(reason ? { reason } : {}) };
    })
    .sort((a, b) => cmp(a.nameText, b.nameText) || cmp(a.group, b.group));
  // 会期一覧（sessions.json）: date はその会期の最終議決日（rollcalls から）。表決の無い会期は書けない（date を推定しない）
  const sessions: AssemblySession[] = input.sessions
    .map((s) => {
      const dates = rollCalls.filter((rc) => rc.sessionId === s.sessionId).map((rc) => rc.date);
      if (dates.length === 0) throw new Error(`session ${s.sessionId} (${s.sessionLabel}) has no roll calls; cannot determine its last vote date`);
      return { id: s.sessionId, label: s.sessionLabel, date: dates.reduce((a, b) => (a > b ? a : b)), rollcalls: s.rollcalls, sourceUrl: s.sourceUrl, fetchedAt: input.fetchedAt };
    })
    .sort((a, b) => cmp(b.date, a.date) || cmp(b.id, a.id));
  // **字が落ちたまま寄った氏名は、11 県すべてが通るここで数える**（#778。県ごとに書かない）。
  // **`input.lossyNameMatches` は受け取らない**——受け取ると「県が渡さなければ出ない」に戻る。
  const lossyNameMatches = lossyNameMatchesOf(rollCalls, input.members);
  // **記号の数と公表値の突き合わせも同じ理由でここに置く**（#826）。
  // **`input.countMismatches` は受け取らない**——受け取ると「県が渡さなければ出ない」に戻る。
  const counted = countMismatchesOf(rollCalls);
  const meta: LocalAssemblyMeta = {
    assemblyId: input.assembly.id,
    fetchedAt: input.fetchedAt,
    sources: input.sources,
    rosterAsOf: input.rosterAsOf,
    sessions: input.sessions,
    counts: { members: index.length, rollcalls: rollCalls.length, cells, unknownCells, unmatchedNames: unmatchedList.length },
    ...(input.unreadableSources?.length ? { unreadableSources: [...input.unreadableSources].sort((a, b) => cmp(a.url, b.url)) } : {}),
    ...(lossyNameMatches.length ? { lossyNameMatches: lossyNameMatches.sort((a, b) => cmp(a.nameText, b.nameText) || cmp(a.memberId, b.memberId)) } : {}),
    // **母数はいつも出す**（食い違いが 0 でも。「0 件」は「見た上での 0」でなければ意味が無い。#757）
    countChecked: counted.checked,
    ...(counted.mismatches.length ? { countMismatches: counted.mismatches } : {}),
  };
  return { assembly: input.assembly, index, details, sessions, rollCallIndex: rollCallIndexOf(rollCalls), rollCalls, unmatched: unmatchedList, meta };
}

/** `assemblies/index.json` を読む（無ければ []）。 */
async function readAssemblies(dir: string): Promise<Assembly[]> {
  try { return JSON.parse(await readFile(join(dir, "assemblies", "index.json"), "utf8")) as Assembly[]; } catch { return []; }
}

/** `members/index.json` を読む（無ければ []）。国会の行と地方の行が混ざる。 */
export async function readMemberIndex(dir: string): Promise<(MemberSummary | LocalMember)[]> {
  try { return JSON.parse(await readFile(join(dir, "members", "index.json"), "utf8")) as (MemberSummary | LocalMember)[]; } catch { return []; }
}

/** 国会の 2 行の後に地方議会の行を id 順で並べる（国会の日次 ETL と地方 ETL のどちらが書いても同じ並び）。 */
export function mergeAssemblies(national: Assembly[], local: Assembly[]): Assembly[] {
  const locals = new Map<string, Assembly>();
  for (const a of local) if (a.kind !== "national") locals.set(a.id, a);
  return [...national.filter((a) => a.kind === "national"), ...[...locals.values()].sort((a, b) => cmp(a.id, b.id))];
}

/**
 * `members/index.json` の並び: 国会の行（日次 ETL の順のまま）→ 地方議員の行（assemblyId 順 → id 順）。
 * 地方の行が無ければ国会の行だけ（byte-identical）。
 */
export function mergeMemberIndex(national: readonly (MemberSummary | LocalMember)[], local: readonly (MemberSummary | LocalMember)[]): (MemberSummary | LocalMember)[] {
  const locals = new Map<string, MemberSummary | LocalMember>();
  for (const m of local) if (!isDietMemberRow(m)) locals.set(m.id, m);
  return [...national.filter(isDietMemberRow), ...[...locals.values()].sort((a, b) => cmp(a.assemblyId, b.assemblyId) || cmp(a.id, b.id))];
}

/**
 * `members/by-assembly.json`（#441）: `members/index.json` を議会ごとに数えた行。assemblyId 昇順（決定的な並び）。
 * 0 人の議会の行は作らない（行が無い＝0 人）。
 *
 * **`current` と `total` の 2 つを出す**のは、画面によって数えるものが違うから（どちらも事実）:
 * - `current`（`current !== false` の行数）は「今この議会にいる人数」。`/` と `/assemblies` が出す。
 *   元職を足すと参議院が 307 名になり**定数248を超える**（#351/#355）。
 * - `total`（全行数）は「何を収録しているか」。`/coverage` が出す（`buildCoverage` のコメント）。
 *
 * assemblyId が無い古い行は `diet-{house}` として数える（Web の `memberAssemblyId` と同じ規則）。
 */
export function membersByAssembly(members: readonly { house?: string; assemblyId?: string; current?: boolean }[]): MemberAssemblyCount[] {
  const rows = new Map<string, MemberAssemblyCount>();
  for (const m of members) {
    const assemblyId = (m.assemblyId ?? `diet-${String(m.house)}`) as AssemblyId;
    const row = rows.get(assemblyId) ?? { assemblyId, current: 0, total: 0 };
    row.total++;
    if (m.current !== false) row.current++;
    rows.set(assemblyId, row);
  }
  return [...rows.values()].sort((a, b) => (a.assemblyId < b.assemblyId ? -1 : a.assemblyId > b.assemblyId ? 1 : 0));
}

/**
 * 書き込み先は data/assemblies/{assemblyId}/ と、members/ のうち自分の議会の議員。assemblies/index.json・members/index.json は自分の行を入れ替える。
 * index.json にまだ国会の 2 行が無ければ（#156 以降の日次 ETL が一度も走っていない）`national` で補う（Web が国会の議員を引けなくならないように）。
 */
export async function writeLocalAssembly(dir: string, ds: LocalAssemblyDataset, opts: { national?: Assembly[] } = {}): Promise<void> {
  if (!/^(pref|city)-[0-9]+$/.test(ds.assembly.id)) throw new Error(`refusing to write assembly id ${ds.assembly.id}`);
  const base = join(dir, "assemblies", ds.assembly.id);
  await rm(base, { recursive: true, force: true });
  const put = async (file: string, value: unknown) => {
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, stableJson(value));
  };
  await put(join(base, "sessions.json"), ds.sessions);
  await put(join(base, "rollcalls", "index.json"), ds.rollCallIndex);
  for (const rc of ds.rollCalls) await put(join(base, "rollcalls", rc.sessionId, `${rc.id}.json`), rc);
  await put(join(base, "unmatched.json"), ds.unmatched);
  await put(join(base, "meta.json"), ds.meta);

  // members/: 自分の議会の古い行（名簿から消えた人の detail ファイル）を消し、国会と他の議会の行は触らない
  const existingMembers = await readMemberIndex(dir);
  const keep = new Set(ds.index.map((m) => m.id));
  for (const m of existingMembers) {
    if (m.assemblyId === ds.assembly.id && !keep.has(m.id)) await rm(join(dir, "members", `${m.id}.json`), { force: true });
  }
  const others = existingMembers.filter((m) => m.assemblyId !== ds.assembly.id);
  const memberIndex = mergeMemberIndex(others, [...others, ...ds.index]);
  await put(join(dir, "members", "index.json"), memberIndex);
  // #441: members/index.json を書いた側が集計も書く。片方だけ更新すると /・/assemblies・/coverage が
  // 古い人数を出す（validateDataset が食い違いで止めるが、そこまで行かせない）
  await put(join(dir, "members", "by-assembly.json"), membersByAssembly(memberIndex));
  for (const d of ds.details) await put(join(dir, "members", `${d.id}.json`), d);

  const existing = await readAssemblies(dir);
  const national = existing.some((a) => a.kind === "national") ? existing : [...(opts.national ?? []), ...existing];
  const merged = mergeAssemblies(national, [...existing.filter((a) => a.id !== ds.assembly.id), ds.assembly]);
  await put(join(dir, "assemblies", "index.json"), merged);
}

/* ---------- 不変条件 ---------- */

const VOTE_VALUES = new Set(["賛成", "反対", "投票なし"]);
const LOCAL_MEMBER_ID = /^p_(0[1-9]|[1-3]\d|4[0-7])_[A-Za-z0-9_-]+$/;

const safeHost = (url: string): string | undefined => { try { return new URL(url).host; } catch { return undefined; } };

/**
 * 地方議会のデータの不変条件（docs/DATA_CONTRACT.md「地方議会」）。assemblies/index.json の prefectural / municipal の行ごとに検査する。
 * data/assemblies/{id}/ が無い議会は、members/index.json にその議会の行が無ければ違反にしない（その議会の ETL がまだ走っていないだけ）。
 */
export async function validateLocalAssemblies(dir: string): Promise<string[]> {
  const v: string[] = [];
  const assemblies = await readAssemblies(dir);
  const allMembers = await readMemberIndex(dir);
  const localIds = new Set(assemblies.filter((a) => a.kind !== "national").map((a) => a.id));
  for (const m of allMembers) {
    if (!isDietMemberRow(m) && !localIds.has(m.assemblyId)) v.push(`members/index.json ${m.id}: assemblyId ${m.assemblyId} not in assemblies/index.json (地方議会の行が無い)`);
  }
  for (const a of assemblies) {
    if (a.kind === "national") continue;
    const base = join(dir, "assemblies", a.id);
    const index = allMembers.filter((m) => m.assemblyId === a.id) as LocalMember[];
    try { await readdir(base); } catch {
      if (index.length) v.push(`assemblies/${a.id}/: missing but members/index.json has ${index.length} rows of ${a.id}`);
      continue;
    }
    const host = safeHost(a.sourceUrl);
    if (!host) { v.push(`assemblies/index.json ${a.id}: sourceUrl invalid`); continue; }
    const read = async <T,>(rel: string): Promise<T | undefined> => {
      let text: string;
      try { text = await readFile(join(dir, rel), "utf-8"); } catch { v.push(`${rel}: missing`); return undefined; }
      let value: T;
      try { value = JSON.parse(text) as T; } catch { v.push(`${rel}: not JSON`); return undefined; }
      if (text !== stableJson(value)) v.push(`${rel}: not in stableJson form (sorted keys, indent 1, trailing newline)`);
      return value;
    };
    const checkSource = (label: string, rec: { sourceUrl?: unknown }) => {
      const h = typeof rec.sourceUrl === "string" ? safeHost(rec.sourceUrl) : undefined;
      if (!h || !/^https:\/\//.test(String(rec.sourceUrl))) v.push(`${label}: sourceUrl missing or not https (${String(rec.sourceUrl)})`);
      else if (h !== host) v.push(`${label}: sourceUrl host not allowed for ${a.id}: ${h} (expected ${host})`);
    };
    const meta = await read<LocalAssemblyMeta>(`assemblies/${a.id}/meta.json`);
    if (meta) {
      if (meta.assemblyId !== a.id) v.push(`assemblies/${a.id}/meta.json: assemblyId ${meta.assemblyId} !== ${a.id}`);
      if (typeof meta.fetchedAt !== "string" || typeof meta.rosterAsOf !== "string" || !Array.isArray(meta.sessions)) v.push(`assemblies/${a.id}/meta.json: fetchedAt / rosterAsOf / sessions required`);
    }
    const memberIds = new Set<string>();
    const voteCounts = new Map<string, number>();
    /** members/{id}.json の timeline の件名（採決の原本と突き合わせる。#866） */
    const timelineTitles: { label: string; rollCallId: string; title: string }[] = [];
    for (const m of index) {
      const label = `members/index.json ${m.id}`;
      if (memberIds.has(m.id)) v.push(`${label}: duplicate id`);
      memberIds.add(m.id);
      if (!LOCAL_MEMBER_ID.test(m.id) || (a.prefCode && !m.id.startsWith(`p_${a.prefCode}_`))) v.push(`${label}: id must be p_{prefCode}_…`);
      if ("house" in m) v.push(`${label}: local member row must not carry house (国会の院)`);
      if (typeof m.name !== "string" || m.name === "") v.push(`${label}: name required`);
      if (typeof m.kana !== "string" || typeof m.group !== "string" || typeof m.district !== "string") v.push(`${label}: kana / group / district required`);
      else if (typeof m.name === "string" && kanaNameRatioExceeds(m.name, m.kana)) v.push(`${label}: kana "${m.kana}" is disproportionate to name "${m.name}" (name may have lost a character. #632)`);
      if (typeof m.current !== "boolean") v.push(`${label}: current must be boolean`);
      if (typeof m.asOf !== "string" || !ISO_DATE.test(m.asOf)) v.push(`${label}: asOf must be ISO date`);
      checkSource(label, m);
      checkSource(`${label} profileUrl`, { sourceUrl: m.profileUrl });
      const rel = `members/${m.id}.json`;
      const d = await read<LocalMemberDetail>(rel);
      if (!d) continue;
      if (d.id !== m.id) v.push(`${rel}: id ${d.id} !== ${m.id}`);
      if (d.assemblyId !== a.id) v.push(`${rel}: assemblyId ${String(d.assemblyId)} !== ${a.id}`);
      if ("house" in d) v.push(`${rel}: local member must not carry house`);
      if (!Array.isArray(d.terms) || d.terms.length === 0 || d.terms.some((t) => typeof t.group !== "string" || typeof t.district !== "string" || !ISO_DATE.test(String(t.asOf)))) v.push(`${rel}: terms[] of { group, district, asOf } required`);
      if (!Array.isArray(d.timeline)) { v.push(`${rel}: timeline required`); continue; }
      let votes = 0;
      for (let i = 0; i < d.timeline.length; i++) {
        const e = d.timeline[i];
        if (e.kind !== "localVote") { v.push(`${rel} timeline[${i}]: kind must be localVote`); continue; }
        votes++;
        checkSource(`${rel} timeline[${i}]`, e);
        checkLocalVote(v, `${rel} timeline[${i}]`, e.vote);
        if (typeof e.sessionLabel !== "string" || e.sessionLabel === "") v.push(`${rel} timeline[${i}]: sessionLabel required`);
        if (typeof e.rollCallId !== "string" || typeof e.title !== "string" || !ISO_DATE.test(String(e.date))) v.push(`${rel} timeline[${i}]: rollCallId / title / date required`);
        // **件名は採決の原本から来る 1 つの事実で、timeline はその写しである**（#866）。
        // 原本を読んだあとで突き合わせるので、ここでは集めるだけ（原本はこのループの下で読む）。
        else timelineTitles.push({ label: `${rel} timeline[${i}]`, rollCallId: e.rollCallId, title: e.title });
        if (i > 0 && d.timeline[i - 1].date < e.date) v.push(`${rel}: timeline not in descending date order at [${i}]`);
      }
      voteCounts.set(m.id, votes);
      if (m.counts?.rollcalls !== votes) v.push(`${label}: counts.rollcalls ${String(m.counts?.rollcalls)} !== timeline votes ${votes}`);
      if (d.counts?.rollcalls !== votes) v.push(`${rel}: counts.rollcalls ${String(d.counts?.rollcalls)} !== timeline votes ${votes}`);
    }
    const unmatched = (await read<LocalUnmatchedName[]>(`assemblies/${a.id}/unmatched.json`)) ?? [];
    const unmatchedKeys = new Set<string>();
    for (const u of unmatched) {
      for (const id of u.rollCallIds) unmatchedKeys.add(`${id}\t${u.nameText}`);
      // 候補（同姓が 2 人以上）は名簿の id を指す。空の配列は書かない（無ければ省略）
      // reason は氏名と名簿から決まる（#680／#711）。人手で書き換えても、県の実装が誤って付けても、ここで食い違いが出る
      const expected = unmatchedReason(u.nameText, index);
      if (u.reason !== expected) v.push(`assemblies/${a.id}/unmatched.json ${u.nameText}: reason ${JSON.stringify(u.reason)} !== ${JSON.stringify(expected)} (氏名から決まる。#680)`);
      if ("candidates" in u) {
        if (!Array.isArray(u.candidates) || u.candidates.length === 0) v.push(`assemblies/${a.id}/unmatched.json ${u.nameText}: candidates must be a non-empty array when present`);
        else for (const c of u.candidates) if (!memberIds.has(c.id) || typeof c.name !== "string" || c.name === "") v.push(`assemblies/${a.id}/unmatched.json ${u.nameText}: candidate ${String(c.id)} not in members/index.json`);
      }
    }
    const summaries = (await read<LocalRollCallSummary[]>(`assemblies/${a.id}/rollcalls/index.json`)) ?? [];
    const seenVotes = new Map<string, number>();
    const perSession = new Map<string, { rollcalls: number; last: string }>();
    let cells = 0;
    let unknownCells = 0;
    // **記号の数と公表値の突き合わせを meta と照合するために、読んだ採決を集める**（#826）
    const rollCallsOnDisk: LocalRollCall[] = [];
    for (let i = 0; i < summaries.length; i++) {
      const s = summaries[i];
      const label = `assemblies/${a.id}/rollcalls/index.json[${i}]`;
      checkSource(label, s);
      if ("votes" in s) v.push(`${label}: index row must not carry votes`);
      if (i > 0 && summaries[i - 1].date < s.date) v.push(`assemblies/${a.id}/rollcalls/index.json: not in descending date order at [${i}]`);
      const ps = perSession.get(s.sessionId) ?? { rollcalls: 0, last: "" };
      ps.rollcalls++;
      if (s.date > ps.last) ps.last = s.date;
      perSession.set(s.sessionId, ps);
      const rel = `assemblies/${a.id}/rollcalls/${s.sessionId}/${s.id}.json`;
      const rc = await read<LocalRollCall>(rel);
      // **原本が無ければ黙って飛ばさない**（#851。飛ばすと下の突き合わせの母数から消える）
      if (!rc) { v.push(`${label}: ${rel} が無い（index にある採決の原本が読めない）`); continue; }
      rollCallsOnDisk.push(rc);
      if (rc.id !== s.id || rc.assemblyId !== a.id) v.push(`${rel}: id/assemblyId mismatch`);
      if (!ISO_DATE.test(rc.date)) v.push(`${rel}: date must be ISO`);
      if (typeof rc.kind !== "string" || rc.kind === "" || typeof rc.title !== "string" || rc.title === "") v.push(`${rel}: kind / title required`);
      // method は PDF に表決方法の欄がある議会（宮城）だけ。あれば raw と legend（空でない）を持つ
      if (rc.method !== undefined && (typeof rc.method.raw !== "string" || typeof rc.method.legend !== "string" || rc.method.legend === "")) v.push(`${rel}: method.raw / method.legend required when method is present`);
      if (rc.committeeResult !== undefined && typeof rc.committeeResult !== "string") v.push(`${rel}: committeeResult must be a string`);
      if (typeof rc.result !== "string" || rc.result === "") v.push(`${rel}: result required`);
      // counts はその欄がある PDF（宮城・鳥取・島根）だけ。あれば yes / no は数値、present（宮城）・voting（宮城・鳥取）は公表する議会だけ
      if (rc.counts !== undefined && ([rc.counts.yes, rc.counts.no].some((n) => typeof n !== "number") || ("present" in rc.counts && typeof rc.counts.present !== "number") || ("voting" in rc.counts && typeof rc.counts.voting !== "number"))) v.push(`${rel}: counts.yes / no must be numbers (counts, present and voting optional)`);
      // referredCommittees は付託委員会の欄がある議会（島根）だけ。あれば空でない文字列の空でない配列
      if ("referredCommittees" in rc && (!Array.isArray(rc.referredCommittees) || rc.referredCommittees.length === 0 || rc.referredCommittees.some((c) => typeof c !== "string" || c === ""))) v.push(`${rel}: referredCommittees must be a non-empty array of non-empty strings when present`);
      if ("voteSubject" in rc && (typeof rc.voteSubject !== "string" || rc.voteSubject === "")) v.push(`${rel}: voteSubject must be a non-empty string when present`);
      if ("committeeReport" in rc && (typeof rc.committeeReport !== "string" || rc.committeeReport === "")) v.push(`${rel}: committeeReport must be a non-empty string when present`);
      checkSource(rel, rc);
      if (!Array.isArray(rc.votes)) { v.push(`${rel}: votes required`); continue; }
      for (const vote of rc.votes) {
        cells++;
        checkLocalVote(v, `${rel} (${vote.nameText})`, vote.value);
        if (vote.value?.raw === "不明") unknownCells++;
        if (vote.memberId === "") {
          if (!unmatchedKeys.has(`${rc.id}\t${vote.nameText}`)) v.push(`${rel}: "${vote.nameText}" has empty memberId but is not listed in unmatched.json`);
        } else if (!memberIds.has(vote.memberId)) v.push(`${rel}: memberId ${vote.memberId} not in members/index.json`);
        else seenVotes.set(vote.memberId, (seenVotes.get(vote.memberId) ?? 0) + 1);
      }
    }
    // **公表した `rollcalls/index.json` が、公表した採決の原本と一致すること**（#851）。
    // **#842（`meta.json` ↔ `rollcalls/`）は 2 つを突き合わせているが、3 つ目の `index.json` は誰も見ていなかった**
    // （#774「独立でも互いの代わりにならない」と同じ形）。**実際に #840 が原本と `meta.json` だけを直し、
    // `index.json` が古いまま本番に出て、公表されている人数が「公表記録にありません」と表示されていた。**
    // **原本のほうを正とする**——票が一次資料に最も近い形だから。**行ごとに比べる**（1 行ずれても名指しできるように）。
    {
      // **原本は `rollcalls/` を歩いて集める**——**index を辿って集めると、
      // index に載っていない原本（載せ忘れ）が母数から消え、永久に見つからない。**
      const onDisk = [...rollCallsOnDisk];
      const seen = new Set(onDisk.map((rc) => rc.id));
      for (const f of await walkJson(join(base, "rollcalls"))) {
        if (f.endsWith(`${sep}index.json`)) continue;
        const rc = await read<LocalRollCall>(relative(dir, f).split(sep).join("/"));
        if (rc && !seen.has(rc.id)) { seen.add(rc.id); onDisk.push(rc); }
      }
      const expected = rollCallIndexOf(onDisk);
      const byId = new Map(expected.map((e) => [e.id, e]));
      for (let i = 0; i < summaries.length; i++) {
        const e = byId.get(summaries[i].id);
        if (!e) continue; // 原本が読めなかった行は上で違反にしている
        if (stableJson(summaries[i]) !== stableJson(e)) {
          v.push(`assemblies/${a.id}/rollcalls/index.json[${i}] (${summaries[i].id}): rollcalls/ の原本と食い違っている（原本が正）`);
        }
      }
      // **原本にあるのに index.json に無い採決**（載せ忘れは「記録が出ない」側）
      const inIndex = new Set(summaries.map((s2) => s2.id));
      for (const e of expected) if (!inIndex.has(e.id)) v.push(`assemblies/${a.id}/rollcalls/index.json: ${e.id} が原本にあるのに index に無い`);
      // **並びも原本から決まる**（日付の降順 → id 順）
      if (expected.length === summaries.length && stableJson(summaries.map((s2) => s2.id)) !== stableJson(expected.map((e) => e.id))) {
        v.push(`assemblies/${a.id}/rollcalls/index.json: 並びが rollcalls/ の原本から作った並びと違う`);
      }
      // **members/{id}.json の timeline の件名も、原本から来る写しである**（#866）。
      // **#851 は index.json だけを見ていた**ので、timeline は件名が「文字列であること」しか見ていなかった。
      // **島根の壊れた件名 5 件は 35 人の timeline 175 か所に同じ値で写っていた**——
      // **原本だけ直して写しを忘れれば、本番の議員ページに古い件名が残る**（#840 が index.json でやったのと同じ形）。
      // **母数を残す**: 何か所突き合わせたかを、違反が 0 のときにも数えられるようにここで数える（#757）。
      const titleById = new Map(onDisk.map((rc) => [rc.id, rc.title]));
      for (const t of timelineTitles) {
        const want = titleById.get(t.rollCallId);
        if (want === undefined) v.push(`${t.label}: rollCallId ${t.rollCallId} の原本が rollcalls/ に無い`);
        else if (want !== t.title) v.push(`${t.label}: title が採決の原本と食い違っている（原本が正）`);
      }
    }
    for (const [id, n] of voteCounts) if ((seenVotes.get(id) ?? 0) !== n) v.push(`assemblies/${a.id}: member ${id} has ${n} timeline votes but ${seenVotes.get(id) ?? 0} in rollcalls/`);
    // sessions.json（Web の会期一覧）: rollcalls/ と同じ会期・件数・最終議決日
    const sessions = (await read<AssemblySession[]>(`assemblies/${a.id}/sessions.json`)) ?? [];
    const sessionIds = new Set<string>();
    sessions.forEach((s, i) => {
      const label = `assemblies/${a.id}/sessions.json[${i}]`;
      if (typeof s.id !== "string" || s.id === "" || sessionIds.has(s.id)) v.push(`${label}: id must be non-empty and unique`);
      sessionIds.add(s.id);
      if (typeof s.label !== "string" || s.label === "") v.push(`${label}: label required`);
      if (!ISO_DATE.test(String(s.date))) v.push(`${label}: date must be ISO`);
      if (typeof s.fetchedAt !== "string" || Number.isNaN(Date.parse(s.fetchedAt))) v.push(`${label}: fetchedAt must be ISO datetime`);
      checkSource(label, s);
      if (i > 0 && sessions[i - 1].date < s.date) v.push(`assemblies/${a.id}/sessions.json: not in descending date order at [${i}]`);
      const ps = perSession.get(s.id);
      if (!ps) v.push(`${label}: session ${s.id} has no roll calls in rollcalls/index.json`);
      else {
        if (ps.rollcalls !== s.rollcalls) v.push(`${label}: rollcalls ${s.rollcalls} !== ${ps.rollcalls} in rollcalls/index.json`);
        if (ps.last !== s.date) v.push(`${label}: date ${s.date} !== last vote date ${ps.last}`);
      }
    });
    for (const id of perSession.keys()) if (!sessionIds.has(id)) v.push(`assemblies/${a.id}/sessions.json: session ${id} of rollcalls/ is missing`);
    if (meta) {
      // 議員数×議案数＝セル数（不明を含む）は PDF 単位の不変条件。meta の counts と実ファイルの数が一致することを検査する
      if (meta.counts.cells !== cells) v.push(`assemblies/${a.id}/meta.json: counts.cells ${meta.counts.cells} !== ${cells} cells in rollcalls/`);
      if (meta.counts.unknownCells !== unknownCells) v.push(`assemblies/${a.id}/meta.json: counts.unknownCells ${meta.counts.unknownCells} !== ${unknownCells}`);
      if (meta.counts.rollcalls !== summaries.length) v.push(`assemblies/${a.id}/meta.json: counts.rollcalls ${meta.counts.rollcalls} !== ${summaries.length}`);
      if (meta.counts.members !== index.length) v.push(`assemblies/${a.id}/meta.json: counts.members ${meta.counts.members} !== ${index.length}`);
      if (meta.counts.unmatchedNames !== unmatched.length) v.push(`assemblies/${a.id}/meta.json: counts.unmatchedNames ${meta.counts.unmatchedNames} !== ${unmatched.length}`);
      // **公表した meta が、公表した票と食い違っていないこと**（#826。**#778 と同じ理由**——
      // **`meta.json` は運用者が見る唯一の窓**なので、そこが票とずれたまま出ている状態にしない）。
      // **`rollcalls/` のほうを正とする**（票が一次資料に最も近い形だから）
      const counted = countMismatchesOf(rollCallsOnDisk);
      if (stableJson(meta.countChecked) !== stableJson(counted.checked)) v.push(`assemblies/${a.id}/meta.json: countChecked ${stableJson(meta.countChecked).trim()} !== ${stableJson(counted.checked).trim()} from rollcalls/`);
      if (stableJson(meta.countMismatches ?? []) !== stableJson(counted.mismatches)) v.push(`assemblies/${a.id}/meta.json: countMismatches (${(meta.countMismatches ?? []).length} rows) !== ${counted.mismatches.length} rows from rollcalls/`);
      // **名簿の掲載日から 1 任期より遠い採決に、その名簿を当てていないこと**（#928。理由は `rosterWindowOf`）。
      // **`rollcalls/` のほうを正とする**（採決の日付が一次資料に最も近い形だから）。
      const w = rosterWindowOf(meta.rosterAsOf, rollCallsOnDisk);
      if (w.daysAfter > LOCAL_TERM_DAYS) v.push(`assemblies/${a.id}/meta.json: 最新の採決 ${String(w.last)} が rosterAsOf ${meta.rosterAsOf} の ${w.daysAfter} 日後で、1 任期（${LOCAL_TERM_DAYS} 日）を超えている（間に必ず選挙がある。#928）`);
      if (w.daysBefore > LOCAL_TERM_DAYS) v.push(`assemblies/${a.id}/meta.json: 最古の採決 ${String(w.first)} が rosterAsOf ${meta.rosterAsOf} の ${w.daysBefore} 日前で、1 任期（${LOCAL_TERM_DAYS} 日）を超えている（間に必ず選挙がある。#928）`);
    }
  }
  return v;
}

/** LocalVote の形: raw は空でなく、legend は空でない原文、mapped は国会の 3 値だけ（凡例から読めたときだけ）。 */
function checkLocalVote(v: string[], label: string, value: { raw?: unknown; legend?: unknown; mapped?: unknown } | undefined): void {
  if (!value || typeof value.raw !== "string" || value.raw === "") { v.push(`${label}: vote raw required`); return; }
  if (typeof value.legend !== "string" || value.legend === "") v.push(`${label}: vote legend required (raw ${value.raw})`);
  if (value.mapped !== undefined && !VOTE_VALUES.has(value.mapped as string)) v.push(`${label}: vote mapped must be 賛成/反対/投票なし, got ${String(value.mapped)}`);
  if (value.raw === "不明" && value.mapped !== undefined) v.push(`${label}: vote mapped must be omitted for 不明`);
}
