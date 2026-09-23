import { fileURLToPath } from "node:url";
import { buildLocalAssembly, defaultSessionsFor, describeUnmatched, LOCAL_SOURCES, validateLocalAssemblies, writeLocalAssembly } from "./local-assemblies.ts";
import { DEFAULT_SESSIONS, dietAssemblies, readSessionsOnDisk } from "./dataset.ts";

/**
 * 地方議会 ETL（Issue #157 宮城、#183 徳島）。月次（.github/workflows/local-assemblies.yml）。国会の日次 ETL（cli.ts）・選挙区（districts-cli.ts）とは独立。
 *   議会ごとの取得部（LOCAL_SOURCES: 名簿 × 直近 N 会期の表決 PDF）
 *   → data/members/index.json のその議会の行と data/members/p_{prefCode}_*.json（Web の議員ページが読む。#158）、
 *     data/assemblies/{assemblyId}/{meta.json, sessions.json, rollcalls/, unmatched.json}、data/assemblies/index.json のその議会の行。
 * 推定しない: PDF のセルを確実に置けなければ「不明」（凡例「抽出不能」）として残し、件数をログと meta に出す。
 * 名簿に寄せられない氏名は memberId 空で unmatched.json に出す。凡例に無い値が出たら非 0 終了。
 *   鳥取県議会（#184）: 議員名簿（1 ページ）× 直近 N 会期の「議案等の議決結果」ページの賛否 PDF（会期に複数）→ 同じ形で pref-31。
 *     PDF の氏名は姓だけ（「○○議員」）なので、名簿で 1 人に決まるときだけ寄せ、同姓が複数なら候補を unmatched.json に列挙する。
 *   高知県議会（#220）: 議員名簿（会派別、1 ページ）×「議員別賛否の状況」index の直近 N 会期の議決結果一覧 PDF → pref-39。
 *   滋賀県議会（#741）: 議員名簿（五十音順、1 ページ、**Shift_JIS**）× 年ページ（年度版と暦年版の 2 通り）→ 会期の賛否ページ → 直近 N 会期の議案等賛否一覧 PDF（1 会期に複数本）→ pref-25。
 *     **文字層の無い画像 PDF が 3 本ある**（#680）。読めない本は落とさず `meta.notes.unreadablePdfs` に記録して先へ進む。
 *   青森県議会（#750）: 議員名簿（**会派別と選挙区別の 2 ページ**。突き合わせは氏名ではなく
 *     プロフィールの URL——**2 ページで氏名の字が違う議員がいる**（`和田寬司`/`和田寛司`。#529））
 *     × 審査結果 index（**1 ページに全 56 会期**）の直近 N 会期の議決結果 PDF → pref-02。
 *     **11 本が `/Rotate 90`、4 本に罫線が 1 本も無い、記号のアイテムの粒度が 2 通り**（#743 が 56 本で実測）。
 *     **`kana` は空**（一覧ページにふりがなが無く、議員ごとの個別ページにしか無い）。
 *   秋田県議会（#759）: 議員紹介（**1 ページに五十音別・選挙区別・会派別の 3 つの一覧**。
 *     突き合わせはプロフィールの URL——**`川邉隼之介` が 3 つの `<a>` に割れている**）
 *     × 概要ハブ → 年度の一覧 → **年度ページ 21 本**の賛否 PDF（**154 本。1 本会議日に 1 本**）→ pref-05。
 *     **`sessionId` は議決日**（`2017-12-22`）——**年度ページの会期の名前は 154 本のうち 8 本で形が違う**
 *     （`第１定例会` のように `回` が無い）ので、**PDF 自身の中の事実だけから決める。**
 *     **`/Rotate 90` が 96 ページ / 70 本、左端の stray な `議` が 5,298 個 / 154 本すべて、
 *     1 行の中で分割単位が揃わないのが 110 本 / 2,780 アイテム、凡例が 4 通り**（#753 が 154 本で実測）。
 *     **議員の列は氏名からではなく票の行から作る**（氏名から作ると 154 本のうち 43 本しか
 *     記号の個数と一致しない。`votes-pdf.ts` の `findMemberColumns`）。
 *     **`ー`(U+30FC) を表決の記号にしない**——**凡例 B の 10 本がそれを「議場に不在」に使うが、
 *     記号として拾うと議案名の長音が票に化ける**（`エネルギー` `センター`。268 個 / 73 本）。
 *     **`kana` は空**（一覧ページにふりがなが無い）。**ホストは `pref.akita.gsl-service.net`**（`pref.*.lg.jp` ではない）。
 *   佐賀県議会（#768）: 議員一覧（**1 ページに 37 名。ふりがな・会派・選挙区・期数が揃う**。
 *     **議員ごとのページが無い**ので `profileUrl` は名簿ページ自身、`id` は**写真の添付ファイル番号**から作る）
 *     × 議案等の審議結果 → 年 → 定例会/臨時会 → 会期 → **議案件名一覧表**（**ここに初めて
 *     「議員ごとの採決結果」のリンクが出る**。会期ページからは見えない。#670）→ 賛否 PDF → pref-41。
 *     **リンク 67 本 / 取れる 64 本のうち読めるのは 16 本**——**文字層が無い 32 本**（`ToUnicode` 無し。#689）、
 *     **`/Rotate 90` の 16 本**（平成27〜29年。表の作りも違うので読まない）、**404 が 3 本**。
 *     **1 本の PDF に表が何枚も入り、表ごとに議決日も議員の並びも違う**（実測 16 本 76 表 505 行）。
 *     **続きのページには見出しが無い**ので、直前の表の議決日と議員の並びを引き継ぐ。
 *     **議員の列は罫線から採る**（右端から幅がそろっている run。集計欄は 13〜17% 広い）。
 *     **列見出し `議員名` の `議` が議員の帯の x の中にある**ので、
 *     **「記号が 1 個の y」を行にしない**（列の数の半分以上を要求する）。
 *     **氏名の食い違いが 2 人ぶんある**（`猪村利恵子`/`猪村理恵子`、`桃崎祐介`/`桃崎裕介`）——
 *     **どちらにも寄せず `unmatched.json` に `sourceConflict` で落ちる**（#711）。
 * Usage: pnpm etl:local <miyagi|tokushima|tottori|mie|nara|shimane|kochi|shiga|aomori|akita|saga> [--sessions N]
 *   **N の既定は議会ごと**（`defaultSessionsFor`。#901）——**秋田 29 / 青森 14 / 佐賀 13 / 宮城 11 / 鳥取 11 / 高知 5 / 島根 5 / 三重 4 / 徳島 4 / 奈良 4 / 滋賀だけ 2。**
 *   **秋田の 29 だけ単位が違う**——**秋田の賛否 PDF は 1 本会議日に 1 本**なので、
 *   **N は「定例会」ではなく「本会議日」を数える**（`akita/index.ts` の docblock）。
 *   **一律の数にしないのは、名簿が「今の 1 枚」しか無く、一般選挙をまたぐと
 *   引退した議員の票が今の別人に付きうるため**（#569。任期の境は議会ごとに違う）。
 */
const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));
const args = process.argv.slice(2);
const target = args[0] ?? "";
const sessionsArg = args.indexOf("--sessions");
// **`--sessions` が無ければ議会ごとの既定**（#901。秋田は 29、青森は 14、佐賀は 13、宮城・鳥取は 11、高知・島根は 5、三重・徳島・奈良は 4、滋賀だけ 2）
const sessions = sessionsArg >= 0 ? Number(args[sessionsArg + 1]) : defaultSessionsFor(target);
const source = Object.hasOwn(LOCAL_SOURCES, target) ? LOCAL_SOURCES[target] : undefined;
if (!source || !Number.isInteger(sessions) || sessions < 1) {
  console.error(`Usage: pnpm etl:local <${Object.keys(LOCAL_SOURCES).join("|")}> [--sessions N]`);
  process.exit(2);
}
const fetchedAt = new Date().toISOString();

const run = await source.run({ sessions, fetchedAt, log: (line) => console.log(line) });
const built = buildLocalAssembly({
  assembly: source.assembly,
  members: run.roster.members,
  rollCalls: run.rollCalls,
  fetchedAt,
  rosterAsOf: run.roster.asOf,
  sources: run.sources,
  sessions: run.sessions,
  unmatched: run.unmatched,
  ...(run.unreadableSources?.length ? { unreadableSources: run.unreadableSources } : {}),
});
console.log(`rollcalls: ${built.meta.counts.rollcalls}, cells: ${built.meta.counts.cells}, unknown cells (kept as 不明, not guessed): ${built.meta.counts.unknownCells}`);
if (built.unmatched.length) {
  console.warn(`names in the PDF not matched to the roster (memberId left empty; see data/assemblies/${source.assembly.id}/unmatched.json): ${built.unmatched.length}`);
  for (const u of built.unmatched) console.warn(`  ${describeUnmatched(u, built.index)}`);
}
// assemblies/index.json に国会の 2 行が無ければ（日次 ETL がまだ #156 以降の形で走っていない）国会の行も補う
const national = dietAssemblies(Math.max(...DEFAULT_SESSIONS, ...(await readSessionsOnDisk(DATA))));
await writeLocalAssembly(DATA, built, { national });

const violations = await validateLocalAssemblies(DATA);
if (violations.length) {
  console.error(`local assembly contract violations: ${violations.length}`);
  for (const line of violations) console.error(`  ${line}`);
  process.exit(1);
}
console.log("done");
