import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Bill, LocalRollCall, Member, MemberDetail, MemberSummary, RollCall } from "@seiji-kiroku/shared";
import { groupAt } from "../src/group-history.ts";
import { assertSameByMember } from "./same-by-member.ts";

/**
 * **`timeline` の件数を守る**（Issue #1061）。
 *
 * ## 何が問題だったか
 *
 * **議員 1 人の `stance` 103 件が消えても、テストが 1 件も落ちなかった**
 * （PR #1059 / マージ済み `1e41501f`。泉 健太 の timeline が 116 → 13 になった）。
 *
 * **自分で再現した**（実測 2026-09-28）。**山田 賢司（`h_00eb6be49c`）の timeline は
 * 105 件すべてが `stance` である**——**その 105 件を丸ごと消して（`"timeline": []` にして）
 * 全部のテストを流したところ、`pnpm --filter @seiji-kiroku/etl test` が
 * `ℹ tests 2210 / ℹ pass 2210 / ℹ fail 0`、`pnpm test`（web 1,379 ＋ etl 2,210）も全部緑だった。**
 * **議員 1 人のページが丸ごと空になっても、3,589 件のテストが誰も何も言わない。**
 *
 * ## なぜ既存の検査を素通りしたか（**`counts` に `stance` の欄が無い**）
 *
 * **`dataset.ts:318-321` は `members/index.json` の `counts` と timeline を突き合わせている。**
 * **だが `counts` が持っているのは `rollcalls` / `bills` / `questions` / `speeches` の 4 つだけで、
 * `stance` も `localVote` も `committeeRole` も `attendance` も欄が無い。**
 *
 * **実測 2026-09-28（`data/` を直に数えた）: timeline 全 316,672 件のうち、**
 * **`counts` が見ているのは 71,944 件（`vote` 69,966 ＋ `bill` 1,385 ＋ `question` 593）だけで、**
 * **残る 244,728 件（77%）には件数の歯止めが 1 つも無い**
 * （`stance` 47,659 ／ `localVote` 189,703 ／ `committeeRole` 7,342 ／ `attendance` 24）。
 *
 * **山田 賢司の `counts` は `rollcalls: 0, bills: 0, questions: 0` である**——
 * **105 件を消しても、`counts` が見ている 3 つはすべて 0 のまま動かない。**
 * **`dataset.ts:266-315` は行の *形* だけを見ている**（`estimated: true`、`stance` が賛成/反対、
 * `sourceUrl` が経過ページ）ので、**行が 0 本なら検査する対象が無く、違反も 0 件になる。**
 * **「違反が 0 件」は本当である**——**見ていないものからは違反が出ない**（#855 の青森と同じ形）。
 *
 * ## どう設計したか（**閾値をベタ書きしない**）
 *
 * **件数を固定値で書くと、データが正当に増えるたびに落ちる。**
 * **実測 2026-09-28（`data/members` を版どうしで突き合わせた）:**
 *
 * | 区間 | 1 人でも件数が動いた議員 |
 * |---|---|
 * | `769b71c7` → `c1c2236a`（**refresh → refresh**） | **0 人** |
 * | `c1c2236a` → `4034733a` | **248（議員,種別）組**（`localVote` だけ。`--sessions` を広げた feat コミットを挟む） |
 * | `4034733a` → `02e48234` | **195（議員,種別）組**（`localVote` 189 ／ `bill` 5 ／ `stance` 1） |
 *
 * **ふつうの refresh では 1 人も動かないが、県が `--sessions` を広げると
 * その県の全議員（40 人前後）が一斉に動く。** **per-member の数をベタ書きしたら、
 * `--sessions` を広げる PR のたびに 40 行を手で書き換えることになる。**
 *
 * **だから数を書かない。** **`timeline` の件数は、`data/` の別の成果物から導ける**——
 * **導いた値と実際の値を突き合わせる。** **これなら県が会期を広げても、
 * 導く側（採決ファイル）と導かれる側（timeline）が一緒に増えるので、自動で追いつく。**
 *
 * **実測 2026-09-28: 4 つの種別が、議員ごとに 1 件の食い違いも無く導けた:**
 *
 * | 種別 | 導き元 | 合計 | 議員ごとの食い違い |
 * |---|---|---|---|
 * | `vote` | `rollcalls 配下の json` の `votes[].memberId` | 69,966 = 69,966 | **0**（307 人） |
 * | `localVote` | 各議会の `rollcalls 配下の json` の `votes[].memberId` | 189,703 = 189,703 | **0**（450 人） |
 * | `stance` | `bills 配下の json` の `shugiinGroupStance` × `groupAt(member, session)` | 47,659 = 47,659 | **0**（456 人） |
 * | `bill`（衆院） | `bills 配下の json` の `submitters` / `supporters` | 1,343 = 1,343 | **0** |
 *
 * **合計 308,671 件（全 316,672 件の 97.5%）が、固定値を 1 つも書かずに守られる**
 * （69,966 ＋ 189,703 ＋ 47,659 ＋ 1,343 = 308,671。**#1117 のレビューで、ここを
 * 258,671 / 82% と 50,000 の桁を落として書いていたのを指摘された。表の 4 数字は
 * 正しかったので、足し算だけが誤っていた**）。
 *
 * **固定値で守る残り 8,001 件の内訳**: `committeeRole` 7,342 ＋ `question` 593 ＋
 * **`bill` のうち参院ぶん 42** ＋ `attendance` 24。
 *
 * ### **「正当な増加で落ちない」ことを、別の版で確かめた**
 *
 * **理屈だけでは足りないので、`--sessions` を広げる前の版（`4034733a`）の `data/` を
 * 丸ごと取り出して、同じ導出を当てた**（実測 2026-09-28）:
 *
 * | 種別 | `4034733a` の合計 | いまの合計 | その版での議員ごとの食い違い |
 * |---|---|---|---|
 * | `localVote` | **130,355** | 189,703（**+59,348**） | **0** |
 * | `stance` | **47,867** | 47,659（**−208**） | **0** |
 * | `vote` | — | 69,966 | **0** |
 *
 * **データが 59,348 件増えても、208 件減っても、導出は両方の版で食い違い 0 だった**——
 * **つまりこの検査は、どちらの版に当てても緑である。**
 * **固定値を持っていないので、増えた側と導き元が一緒に動くかぎり赤くならない。**
 *
 * ## **合計だけでは守れない**（#1053 と同じ理由）
 *
 * **#1053 の実例では「滋賀 3→2・青森 0→1 の入れ替え」が合計 3 のまま素通りした。**
 * **ここでも同じことが起きうる**——**だから突き合わせは議員ごとに行う。**
 *
 * **机上の話ではない。実際に入れ替えを当てて測った**（実測 2026-09-28）——
 * **同じ会派の 2 人（`h_00eb6be49c` と `h_06b89f3449`。stance の集合が完全に一致する）の間で
 * 1 件を移す**（**A 105 → 104、B 105 → 106**）。**このとき:**
 *
 * | 見ている粒度 | 変異の前 | 変異の後 | 気づくか |
 * |---|---|---|---|
 * | timeline 合計 | 316,672 | **316,672** | **気づかない** |
 * | `stance` の合計 | 47,659 | **47,659** | **気づかない** |
 * | 議会ごと（`diet-shugiin` の `stance`） | 47,659 | **47,659** | **気づかない** |
 * | **議員ごと** | — | — | **落ちる** |
 *
 * **合計・種別ごと・議会ごとは 1 件も動かない**（上の 3 行は変異を当てた状態で数え直した実測値）。
 * **議員ごとに比べたときだけ落ち、しかも両側を名指しする**——
 * `{ h_06b89f3449: { timeline: 106, derived: 105 }, h_00eb6be49c: { timeline: 104, derived: 105 } }`。
 *
 * ## 導けない種別（`committeeRole` / `attendance`）
 *
 * **この 2 つは `data/` の他の成果物に元が無い**（会議録から作られ、member ファイルにしか残らない）。
 * **合計 7,394 件（実測 2026-10-04: `committeeRole` 7,370 ＋ `attendance` 24）。**
 * **ここだけは数を書く**——**ただし #1175 で「絶対値」から「議会 × 回次の下限」に替えた。**
 * **理由は `UNDERIVABLE_FLOOR` の docblock に測った数字で書いてある**
 * （**絶対値は人が手で直す前提で、その手順が人の居ない日次 cron の経路に在った**）。
 *
 * ## **この検査が見ていない 8,001 件**（#1117 のレビューの指摘。**書いておかないと「見た」と誤読される**）
 *
 * | 種別 | 件数 | ここで見るか | 何が見ているか |
 * |---|---|---|---|
 * | `committeeRole` | 7,370 | **見る**（議会 × 回次の下限 ＋ 行の同一性の重複 0） | — |
 * | `question` | 593 | **見ない** | `counts.questions`（`dataset.ts:321`） |
 * | **`bill` のうち参院ぶん** | **42** | **見ない** | `counts.bills`（`dataset.ts:320`）／#855 の母数 |
 * | `attendance` | 24 | **見る**（議会 × 回次の下限 ＋ 行の同一性の重複 0） | — |
 *
 * **`bill` の 1,385 件は 衆 1,343 ＋ 参 42 で、上の導出は衆院ぶんしか見ていない**
 * （`bills/` の `submitters` / `supporters` から導くのは衆院の議案だけなので）。
 * **実測 2026-09-29: 参院の 42 件を全部消しても、このファイルは全部緑である**（`pass 6 / fail 0`。
 * **当時 6 本。#1175 で 7 本になったが、足した 2 本は `bill` を見ないので変わらない**）
 * ——**捕まえるのは `counts.bills` と #855 の母数のほうである。**
 * **「衆院」とテスト名に書いてあるのはそのためで、参院を見落としているのではなく、
 * 導き元が無いので見ていない。**
 *
 * ## **赤くなったら、まず「会派が動いた」を疑うこと**
 *
 * **`stance` は会派名の文字列一致で推定されている行である**（`aggregate.ts:219`）。
 * **議員が会派を離れれば、その人の `stance` は根拠を失って消える**——
 * **それが #1059 で起きたことで、消えるのが正しい**（残すほうが「別の会派の記録を本人に付ける」害になる。#569）。
 *
 * **導出どうしの突き合わせが落ちたときは、`data/` の中で片方だけが古い**ということである
 * （timeline を作り直さずに `bills/` だけ差し替えた、など）。**直すのは数ではなく `data/` の作り直しである。**
 *
 * **`UNDERIVABLE_FLOOR` の下限が割れたときは、上の表と違って「数を直せば済む」ことがある**——
 * **ただし下限が割れたのは「記録が減った」ということなので、まず `data/` を作り直す。**
 * **作り直しても戻らないなら、その議員が名簿から消えていないかを確かめる**
 * （実測 2026-10-04: **過去 8 遷移で下限を割った唯一の例は、渡辺 孝一が名簿から消えた #1045 の形だった**）。
 * **「赤いから」と下限を下げないこと**（#943）。**下げるときは、どの議員が名簿から消えたかを書く。**
 *
 * ## **このファイルでは守れないことが 1 つある**（Issue #1129）
 *
 * **突き合わせの走査を片側に縮めても、このファイルは全部緑である**
 * （**実測 2026-09-30、`data/` は `61770bd5`。そのときこのファイルは 6 本だった**——
 *  **#1175 で 7 本になったが、足した 2 本（下限・重複）は `assertSameByMember` を使わないので
 *  この測定は変わらない**）:
 *
 * | 当てた変異 | 当時の 6 本 |
 * |---|---|
 * | `...Object.keys(derived)` を落とす | **pass 6 / fail 0** |
 * | `...Object.keys(actual)` を落とす | **pass 6 / fail 0** |
 *
 * **`data/` がきれいなら、定義上どちらの側にも「片側だけのキー」は無い**——
 * **だから「片側にしか無いキー」を見逃す壊れ方は、ここからは測れない。**
 * **`assertSameByMember` は `test/same-by-member.ts` に出してあり、
 * `test/same-by-member.test.ts` が fixture で両方向を固定している**（#1129）。
 * **このファイルが言えるのは「いまの `data/` が導出と一致している」ことだけである。**
 */
const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));

/**
 * **導けない種別の下限**（`committeeRole` / `attendance`）。
 * **議会 × 回次の粒度で「これより減ったら落ちる」を固定する**（**絶対値ではない**）。
 *
 * ## なぜ絶対値をやめたか（#1175）
 *
 * **絶対値は、人が手で直すことを前提にしていた。** docblock はそう書いてあった——
 * 「`data/` を作り直し、どの院が何件動いたかをコミットメッセージに書いてこの数を直す」。
 * **その手順が、人の居ない日次 cron の経路に在った。**
 *
 * **実害が出た**（実測 2026-10-03）:
 *
 * | 日 | run | 結果 |
 * |---|---|---|
 * | 2026-10-02 | `36945202137` | **failure**（この検査が赤 → data PR がマージされず、`etl.yml` の 15 分の待ち合わせが尽きた） |
 * | 2026-10-03 | `37080337404` | **failure**（同じ検査・同じ理由） |
 *
 * **#1170 はマージされずに閉じられ**、**#1173 は 02:07 の PR が 17:57 にやっと入った（15 時間 50 分）**——
 * **人が期待値を手で書き換えて初めて緑になった**（`5fb62347` のコミットメッセージ:
 * 「committeeRole が実データで 28 件増えた——衆 +27 / 参 +1 の内訳を実測に直す」）。
 *
 * **検査は正しかった。数が古かった。** **データが正当に増えるたびに必ず赤くなる形だったのが欠陥である。**
 *
 * ## なぜ下限なら「緩めた」ことにならないか（#943）
 *
 * **#943 が禁じているのは「赤いから検査を黙らせること」である。** **ここは逆向きに替えている:**
 *
 * - **増加は通す**。**増加は、この検査がもともと捕まえたかった形ではない**
 *   （#1061 が捕まえたかったのは「**消える**」ほうで、#855 の青森・#1045 の渡辺孝一・
 *   #1059 の泉健太 103 件は**全部「減る」側**である）
 * - **減少は落ちる**。**しかも粒度を 2 キー → 10 キーに細かくしたので、前より厳しい**
 *   （議会ごと 2 キー → 議会 × 回次 10 キー。実測 2026-10-04）
 * - **黙らせる入口を 1 つも作っていない**。環境変数・`skip`・`--force` に相当するものは無い
 *   （**`UNDERIVABLE_FLOOR` を書き換える以外に通す道が無く、書き換えは PR のレビューに出る**）
 *
 * ## 下限が「増え続けるのを誰も見ていない」状態にならないようにしたこと（#757 の母数）
 *
 * **下限だけだと、増える側は無検査になる。** だから 2 つ足した:
 *
 * 1. **数えたキーの集合が、この表のキーの集合と完全一致すること**——
 *    **新しい（議会, 回次）が黙って現れたら落ちる。** 「0 件」と「数えていない」が区別できる
 * 2. **行の同一性 `(議員id, 回次, 委員会名, meetingId)` が重複しないこと**——
 *    **固定値を 1 つも使わない導出である。** **実測 2026-10-04: 7,370 行で重複 0 件。**
 *    下限だけなら「同じ行を 2 回書いて数を増やす」形が通るが、ここで落ちる
 *
 * ## 下限を採った根拠（**減少がどれだけ稀かを測った**）
 *
 * **`data/members/` の版を 9 つ取り出して、議会 × 回次の committeeRole 件数を全部数えた**
 * （実測 2026-10-04、`844bd22a`〜`5fb62347` = 2026-09-09〜2026-10-03 の 8 遷移）:
 *
 * | 遷移 | 件数が減ったキー | 名簿から消えた議員 |
 * |---|---|---|
 * | 8 遷移のうち 7 | **0 キー** | 0 人 |
 * | `4034733a` → `02e48234` | **`diet-shugiin|221`: 2022 → 2020** | **3 人** |
 *
 * **唯一の減少は、渡辺 孝一（`h_42df80d20e`）が名簿から消え、その 2 行が一緒に落ちたもの**
 * （**#1045 がまさにその人である**）。**行の同一性 `(議員id, 回次, 委員会名, 役職)` で数え直すと、
 * 8 遷移すべてで「名簿に残っている議員の行が消えた件数 = 0」だった**（実測 2026-10-04）。
 *
 * **つまり減少は「議員が名簿から消えたとき」にしか起きていない**——
 * **`data: refresh` 31 本のうち名簿から人が消えたのは 1 本（3%）。**
 * **その 1 本では人が見るべきである**（記録が消えるのは #855 / #1045 の形で、自動で承認してはいけない）。
 * **増加のほうは committeeRole が動くたびに起きるので、そこを自動で通す。**
 *
 * **下限を上げ直す必要は無い**（上げ忘れても、下限は下限として効き続ける）。
 * **上げたいときは `scripts/dev/underivable-floor.mjs` が今の値を出す。**
 */
const UNDERIVABLE_FLOOR = {
  /** **実測 2026-10-04**（`5fb62347` = `data: refresh 2026-10-03T02:07Z`）。合計 7,370 */
  committeeRole: {
    "diet-sangiin|216": 764,
    "diet-sangiin|217": 1263,
    "diet-sangiin|218": 625,
    "diet-sangiin|219": 799,
    "diet-sangiin|220": 608,
    "diet-sangiin|221": 1264,
    "diet-shugiin|221": 2047,
  } as Record<string, number>,
  /** **参院の委員会の発議者だけに付く**（`dataset.ts`: `attendance row is allowed only for house=sangiin`）。合計 24 */
  attendance: {
    "diet-sangiin|216": 3,
    "diet-sangiin|217": 6,
    "diet-sangiin|221": 15,
  } as Record<string, number>,
};

/**
 * **timeline が 1 件も無い議員の数**（#1061）。**「0 件」と「数えていない」を区別するための母数**（#757）。
 *
 * **実測 2026-09-28: 1,222 人中 3 人**。**ここが増えたら、誰かの記録が丸ごと消えている可能性がある**
 * ——**まず「その議員が名簿に載ったばかりで、まだ採決に加わっていない」を疑うこと。**
 * **`--sessions` を広げると減る方向にしか動かない**ので、**増えたときだけが疑わしい。**
 */
const EMPTY_TIMELINE_MEMBERS = 3;

const walkJson = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkJson(p)));
    else if (e.name.endsWith(".json") && e.name !== "index.json") out.push(p);
  }
  return out;
};

const readJson = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, "utf-8")) as T;

/**
 * **議員ごとの timeline を種別で数える。**
 *
 * **1,222 個の member ファイルを読むので、6 本のテストで数え直すと 6 倍かかる**
 * （**実測 2026-09-28、このファイル単体: テストごとに数え直していたとき `duration_ms 134263` →
 * 1 回だけ数えて使い回すと `duration_ms 37619`**）。**promise を 1 つ持って共有する**
 * （`node --test` は同じファイルのテストを同じプロセスで走らせるので、これで 1 回になる）。
 */
const scanOnce = async () => {
  const index = await readJson<MemberSummary[]>(join(DATA, "members/index.json"));
  /** `{ 種別: { 議員id: 件数 } }`。**0 件の議員は載せない**（「無い」と「0」を同じ形にする） */
  const byKind: Record<string, Record<string, number>> = {};
  const byKindAssembly: Record<string, Record<string, number>> = {};
  /**
   * `{ 種別: { "{議会id}|{回次}": 件数 } }`（#1175 の下限の粒度）。
   * **回次を持たない行は `(no session)` に落とす**——**捨てない。**
   * **捨てると「回次が消えた」が件数の減少として見えなくなる**（#757 の母数と同じ理由）。
   */
  const byKindAssemblySession: Record<string, Record<string, number>> = {};
  /**
   * **行の同一性の鍵の重複数**（#1175）。**固定値を使わない検算。**
   * 鍵は `(議員id, 回次, 委員会名/会議名, meetingId)`。**実測 2026-10-04: 7,370 行で重複 0 件。**
   */
  const dupRowKeys: Record<string, string[]> = {};
  const details = new Map<string, MemberDetail>();
  let empty = 0;
  for (const m of index) {
    const d = await readJson<MemberDetail>(join(DATA, `members/${m.id}.json`));
    details.set(m.id, d);
    const timeline = d.timeline ?? [];
    if (timeline.length === 0) empty++;
    const seen: Record<string, Set<string>> = {};
    for (const e of timeline) {
      (byKind[e.kind] ??= {})[m.id] = ((byKind[e.kind] ?? {})[m.id] ?? 0) + 1;
      const asm = m.assemblyId ?? "(none)";
      (byKindAssembly[e.kind] ??= {})[asm] = ((byKindAssembly[e.kind] ?? {})[asm] ?? 0) + 1;
      const session = typeof e.session === "number" ? String(e.session) : "(no session)";
      const key = `${asm}|${session}`;
      (byKindAssemblySession[e.kind] ??= {})[key] = ((byKindAssemblySession[e.kind] ?? {})[key] ?? 0) + 1;
      if (e.kind === "committeeRole" || e.kind === "attendance") {
        const what = e.kind === "committeeRole" ? e.committee : e.meeting;
        const rowKey = `${m.id}|${session}|${what}|${e.meetingId}`;
        if ((seen[e.kind] ??= new Set()).has(rowKey)) (dupRowKeys[e.kind] ??= []).push(rowKey);
        seen[e.kind].add(rowKey);
      }
    }
  }
  return { index, byKind, byKindAssembly, byKindAssemblySession, dupRowKeys, details, empty };
};

let scan: ReturnType<typeof scanOnce> | undefined;
const countTimelines = () => (scan ??= scanOnce());

/** **`bills/` も 2 本のテストで使うので 1 回だけ読む**（`countTimelines` と同じ理由） */
const readBillsOnce = async (): Promise<Bill[]> =>
  Promise.all((await walkJson(join(DATA, "bills"))).map((f) => readJson<Bill>(f)));
let billsScan: Promise<Bill[]> | undefined;
const readBills = () => (billsScan ??= readBillsOnce());

/**
 * **導出 1: 国会の採決**（`vote`）。
 *
 * **`rollcalls 配下の json` の `votes[]` のうち `memberId` が付いているセルが、
 * そのまま議員の `vote` 行になる**（`aggregate.ts`）。**議員ごとに突き合わせる。**
 */
test("#1061 vote: 議員ごとの件数が rollcalls/ の memberId 付きセルと一致する（合計だけでなく議員ごと。入れ替えを捕まえる）", async () => {
  const { byKind } = await countTimelines();
  const derived: Record<string, number> = {};
  let cells = 0;
  for (const f of await walkJson(join(DATA, "rollcalls"))) {
    const rc = await readJson<RollCall>(f);
    for (const v of rc.votes ?? []) {
      cells++;
      if (v.memberId) derived[v.memberId] = (derived[v.memberId] ?? 0) + 1;
    }
  }
  // **母数を先に出す**（#757）。**0 件を見て緑になっていないことを、数字で示す**
  assert.ok(cells > 0, "rollcalls/ のセルが 0 件。走査先が空になっている");
  assert.ok(Object.keys(derived).length > 0, "memberId 付きのセルが 0 件。突き合わせる相手がいない");
  assertSameByMember(byKind.vote ?? {}, derived, "timeline の vote 行と rollcalls/ の memberId 付きセルが議員ごとに食い違っている");
});

/**
 * **導出 2: 地方議会の表決**（`localVote`）。**全 316,672 件のうち最大の 189,703 件。**
 *
 * **県が `--sessions` を広げれば採決ファイルも timeline も一緒に増えるので、
 * ここは固定値を持たなくても自動で追いつく**（上の docblock の実測の表）。
 */
test("#1061 localVote: 議員ごとの件数が assemblies/*/rollcalls/ の memberId 付きセルと一致する（189,703 件。固定値を持たないので県が会期を広げても落ちない）", async () => {
  const { byKind } = await countTimelines();
  const assemblies = await readJson<{ id: string; kind: string }[]>(join(DATA, "assemblies/index.json"));
  const derived: Record<string, number> = {};
  let cells = 0;
  for (const a of assemblies.filter((x) => x.kind !== "national")) {
    for (const f of await walkJson(join(DATA, "assemblies", a.id, "rollcalls"))) {
      const rc = await readJson<LocalRollCall>(f);
      for (const v of rc.votes) {
        cells++;
        if (v.memberId) derived[v.memberId] = (derived[v.memberId] ?? 0) + 1;
      }
    }
  }
  assert.ok(cells > 0, "地方議会の採決セルが 0 件。走査先が空になっている");
  assert.ok(Object.keys(derived).length > 0, "memberId 付きのセルが 0 件。突き合わせる相手がいない");
  assertSameByMember(byKind.localVote ?? {}, derived, "timeline の localVote 行と採決ファイルの memberId 付きセルが議員ごとに食い違っている");
});

/**
 * **導出 3: 会派推定の賛否**（`stance`）。**#1059 で 103 件が黙って消えた、まさにその種別。**
 *
 * **`aggregate.ts:214-222` と同じ導出をここで組み直す**——
 * **衆院の議案の `shugiinGroupStance` に、その議員の提出回次の会派（`groupAt`）が
 * 賛成会派／反対会派として載っていれば 1 行。**
 *
 * **これは「実装と同じ式をもう一度書いている」のではない**——
 * **`aggregate.ts` は ETL の実行時にしか走らず、その出力が `data/` に入ったあと、
 * 誰かが `data/` を手で触っても（#840 で実際に起きた）気づけない。**
 * **ここは *コミットされた* `bills/` と *コミットされた* `members/` を突き合わせるので、
 * 「ETL が書いたあとに片方だけ動いた」を捕まえる。**
 *
 * **#1059 の変更（泉 健太 の会派が `中道改革連合・無所属` → `無所属`）は、
 * `terms` と timeline が両方とも新しくなっているので、この検査は緑になる**——
 * **それでよい。** **この検査が言うのは「timeline が `bills/` と `terms` から導ける値と一致している」
 * ことであって、「会派が動いてはいけない」ことではない**（会派が動くのは事実であって不具合ではない）。
 * **捕まえたいのは「導ける値と食い違う消え方」のほうである。**
 */
test("#1061 stance: 議員ごとの件数が bills/ の shugiinGroupStance × terms から導ける値と一致する（#1059 で 103 件が黙って消えた種別）", async () => {
  const { byKind, details } = await countTimelines();
  const bills = await readBills();
  const shugiin = [...details.values()].filter((d) => d.house === "shugiin");
  const derived: Record<string, number> = {};
  let withStance = 0;
  for (const b of bills) {
    if (b.house !== "shugiin") continue;
    if (!b.received?.shugiin) continue;
    const stance = b.shugiinGroupStance;
    if (!stance) continue;
    withStance++;
    for (const m of shugiin) {
      const group = groupAt(m as Member, b.session)?.group;
      if (!group) continue;
      const side = stance.yes.includes(group) ? "賛成" : stance.no.includes(group) ? "反対" : undefined;
      if (!side) continue;
      derived[m.id] = (derived[m.id] ?? 0) + 1;
    }
  }
  assert.ok(withStance > 0, "shugiinGroupStance を持つ議案が 0 件。導出の入力が空になっている");
  assert.ok(shugiin.length > 0, "衆院の議員が 0 人。導出の入力が空になっている");
  assertSameByMember(byKind.stance ?? {}, derived, "timeline の stance 行と、bills/ の会派賛否 × terms から導ける件数が議員ごとに食い違っている（会派が動いたなら data/ を作り直すこと。#1061）");
});

/**
 * **導出 4: 衆院の議案の提出者・賛成者**（`bill`）。
 *
 * **`counts.bills` が既に同じものを見ているが**（`dataset.ts:320`）、
 * **あちらは「`members/index.json` の数字」と「timeline の行数」を比べているだけで、
 * 両方が同じように間違っていれば気づかない**（`aggregate.ts` が両方を同じ計算から書くので、
 * 実際に同じように間違いうる）。**ここは `bills/` という別の成果物から導く。**
 */
test("#1061 bill（衆院）: 議員ごとの件数が bills/ の submitters/supporters と一致する（counts.bills とは別の根拠から導く）", async () => {
  const { byKind, details } = await countTimelines();
  const bills = await readBills();
  const derived: Record<string, number> = {};
  for (const b of bills) {
    if (b.house !== "shugiin") continue;
    if (!b.received?.shugiin) continue;
    for (const ids of [b.submitters, b.supporters]) for (const id of ids ?? []) derived[id] = (derived[id] ?? 0) + 1;
  }
  const actual: Record<string, number> = {};
  for (const [id, n] of Object.entries(byKind.bill ?? {})) if (details.get(id)?.house === "shugiin") actual[id] = n;
  assert.ok(Object.keys(derived).length > 0, "submitters/supporters が 0 件。導出の入力が空になっている");
  assertSameByMember(actual, derived, "timeline の bill 行（衆院）と bills/ の submitters/supporters が議員ごとに食い違っている");
});

/**
 * **導けない種別が減っていないこと**（`committeeRole` / `attendance`）。**#1175 で絶対値から下限に替えた。**
 *
 * **議会 × 回次の粒度で下限を持つ。** **院をまたぐ入れ替えは、減った側の下限で捕まる**
 * （衆 2,047 ＋ 参 5,323 が 2,048 ＋ 5,322 になったら、参の回次のどれかが下限を割る。#1053）。
 * **記録が丸ごと消える形も、減少なので捕まる**（#855 / #1045）。
 * **正当な増加だけが通る**（#1175: 日次 cron がそこで止まっていた）。
 */
test("#1061/#1175 committeeRole / attendance: 導き元が data/ に無い種別が、議会 × 回次の下限を割っていない（減少は落ちる・増加は通す）", async () => {
  const { byKindAssemblySession } = await countTimelines();
  for (const kind of ["committeeRole", "attendance"] as const) {
    const actual = byKindAssemblySession[kind] ?? {};
    const floor = UNDERIVABLE_FLOOR[kind];
    // **母数を先に出す**（#757）。**下限の表が空になって「全部通る」ことがないようにする**
    assert.ok(Object.keys(floor).length > 0, `${kind} の下限の表が空。守るものが無い`);
    const total = Object.values(actual).reduce((s, n) => s + n, 0);
    // **正直に書いておく: この 1 行は、下のキー集合の `deepEqual` と検出範囲が重なっている**
    // （**実測 2026-10-04: 走査を殺す変異を当てたとき、この行を `assert.ok(true, …)` に潰しても
    //   キー集合の assert が `fail 1` で落ちた**）。**残しているのは診断のためである**——
    // **先に落ちるほうが「走査先が空になっている」と名指しするので、キー 7 個の差分を読むより速い。**
    assert.ok(total > 0, `${kind} の行が 0 件。走査先が空になっている（「0 件」と「数えていない」を区別する。#757）`);
    // **減ったキーだけを名指しする**（狭い診断。#1053 の resultAbsentByAssembly と同じ考え方）
    const below: Record<string, { actual: number; floor: number }> = {};
    for (const [key, min] of Object.entries(floor)) {
      const a = actual[key] ?? 0;
      if (a < min) below[key] = { actual: a, floor: min };
    }
    assert.deepEqual(below, {}, `${kind} の件数が議会 × 回次の下限を割った（下限を割るのは「記録が消えた」側で、#855 / #1045 の形である。`
      + `**data/ を作り直しても戻らないなら、誰かが名簿から消えたかを確かめること**——`
      + `名簿から人が消えて行が落ちるのは事実なので、そのときだけ UNDERIVABLE_FLOOR を下げる。#1175）`);
    // **増加側を無検査にしない**（#757）: **数えたキーの集合が、下限の表のキーの集合と完全一致すること。**
    // **新しい（議会, 回次）が黙って現れたら落ちる**——「0 件」と「数えていない」が区別できる。
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(floor).sort(),
      `${kind} の（議会, 回次）の集合が下限の表と違う（新しい回次／議会が現れた、または丸ごと消えた。`
      + `増えたほうなら UNDERIVABLE_FLOOR にそのキーを足す。消えたほうなら data/ を作り直す。#1175）`);
  }
});

/**
 * **導けない種別の行が重複していないこと**（#1175）。**固定値を 1 つも使わない検算。**
 *
 * **上の下限は「減っていないこと」しか言わない**——**同じ行を 2 回書いて数を増やす形は下限を通る。**
 * **行の同一性 `(議員id, 回次, 委員会名/会議名, meetingId)` は一次資料そのものの鍵なので、
 * 重複は「同じ会議録を 2 回数えた」ということである。**
 *
 * **実測 2026-10-04: `committeeRole` 7,370 行・`attendance` 24 行で重複 0 件。**
 *
 * ## **鍵の 4 要素のうち、いま効いているのは `meetingId` だけである**（#1179 のレビューの指摘）
 *
 * **鍵の各要素を 1 つずつ落として、実データの重複数を数えた**（実測 2026-10-04、基点 `53e121fe`）:
 *
 * | 鍵 | `committeeRole` の重複 | `attendance` の重複 |
 * |---|---|---|
 * | `(議員id, 回次, 委員会名, meetingId)`（いまの形） | **0** | 0 |
 * | **`meetingId` を落とす** | **28** | 0 |
 * | **`回次` を落とす** | **0** | 0 |
 * | **`委員会名` を落とす** | **0** | 0 |
 *
 * **つまり「鍵から `回次` を落とす」変異は等価変異である**
 * （**実測: `$\{session\}|` を消すと `tests 7 / pass 7 / fail 0`**）。
 * **`委員会名` も同じ**。**落ちるのは `meetingId` を落としたときだけ。**
 *
 * **それでも 4 要素を残しているのは、`meetingId` の一意性に寄りかからないためである**——
 * **`meetingId` は「出席した最初の会議」の id で、バックフィルが届くと前にずれる**
 * （実測: `fed91465` → `5fb62347` で `m_010038` の 総務委員会 の行が
 * 04-02 の会議から 03-24 の会議に移り、`meetings` が 8 → 9 になった）。
 * **ずれた先が既存の行と衝突する余地があるので、回次と委員会名を鍵に残す。**
 * **ただし「いま効いている」とは書かない**——**上の表が実測である。**
 *
 * ## **混同しないこと: 「鍵から回次を落とす」と「行から回次の欄を落とす」は別の変異である**
 *
 * **行の `session` の欄を消す変異は落ちる**（実測: `tests 7 / pass 6 / fail 1`）。
 * **ただし落ちるのは下限のテストのほうで、この重複のテストではない**
 * （`(no session)` のキーに落ちるので `diet-shugiin|221` が 2,047 → 2,046 になり下限を割る）。
 * **#1179 の初版の本文は、この 2 つを「重複テストが落ちる」と書き違えていた。**
 */
test("#1175 committeeRole / attendance: 行の同一性（議員id × 回次 × 委員会名 × meetingId）が重複していない（固定値を使わない検算。下限だけだと二重計上が通る）", async () => {
  const { dupRowKeys, byKindAssemblySession } = await countTimelines();
  for (const kind of ["committeeRole", "attendance"] as const) {
    const total = Object.values(byKindAssemblySession[kind] ?? {}).reduce((s, n) => s + n, 0);
    // **母数**（#757）: 何行を見た上での「重複 0」なのかを必ず出す
    assert.ok(total > 0, `${kind} の行が 0 件。重複を数える対象が無い（0 件を見て緑になっていないことを示す。#757）`);
    assert.deepEqual(dupRowKeys[kind] ?? [], [], `${kind} の行の同一性が重複している（${total} 行を見た。同じ会議録を 2 回数えている。#1175）`);
  }
});

/**
 * **timeline が空の議員の数**（#757 の母数）。
 *
 * **上の 4 つの導出は「導ける値と一致するか」しか言わない**——
 * **導き元ごと消えれば、導いた値も 0 になって一致してしまう**（#855 の青森と同じ形）。
 * **ここは「記録が 1 件も無い議員」を直に数えて、増えていないことを言う。**
 */
test("#1061 母数: timeline が 1 件も無い議員は 3 人（増えたら、誰かの記録が丸ごと消えていないか疑うこと）", async () => {
  const { index, empty } = await countTimelines();
  assert.ok(index.length > 0, "members/index.json が空。数えるものが無い");
  assert.equal(empty, EMPTY_TIMELINE_MEMBERS, "timeline が 1 件も無い議員の数");
});
