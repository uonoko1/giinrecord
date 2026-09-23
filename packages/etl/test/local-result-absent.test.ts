import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import iconv from "iconv-lite";
import { buildLocalAssembly, validateLocalAssemblies, writeLocalAssembly } from "../src/local-assemblies.ts";
import { toLocalRollCalls } from "../src/sources/local/shiga/rollcalls.ts";
import { parseVotePdf } from "../src/sources/local/shiga/votes-pdf.ts";
import { parseRoster } from "../src/sources/local/shiga/roster.ts";
import { SHIGA_ASSEMBLY } from "../src/sources/local/shiga/site.ts";

/**
 * # **議決結果の欄が一次資料で空のとき、何を出すか**（Issue #901）
 *
 * ## 何が起きたか
 *
 * **滋賀の `--sessions` を 2 → 19 に広げると、契約の検査が 3 件で落ちた**:
 *
 * ```
 * assemblies/pref-25/rollcalls/2025-04-rinji/…-議長辞職の件.json: result required
 * assemblies/pref-25/rollcalls/2025-04-rinji/…-特別委員会改編動議.json: result required
 * assemblies/pref-25/rollcalls/2025-04-rinji/…-議第98号（人事案件）.json: result required
 * ```
 *
 * ## **これは読み取りの失敗ではない。一次資料に書かれていない。**
 *
 * **`Kg835_0425sanpi2.pdf` の 1 ページ目を、文字アイテムの座標で直接見た**（#901 の実測）:
 * **`議決結果` の列見出し（x≈242）はあるが、3 行とも値が 1 文字も無い。**
 * **2 ページ目の 1 行（議第97号…委員長報告）には `承認` が x=238 に入っている**ので、
 * **「この本では結果欄が読めない」のではなく「この 3 行に書かれていない」。**
 *
 * | | |
 * |---|---:|
 * | `--sessions 19` の採決（母数。#757） | **163** |
 * | **`result` が空** | **3（1.8%）** |
 * | その会期 | **`2025-04-rinji` だけ**（1 本の PDF の 1 ページ目） |
 * | 11 議会 3,683 採決のうち `result` が空 | **この 3 件だけ** |
 *
 * ## なぜ「埋める」を選ばないか
 *
 * **3 件とも `counts` はある**（`議長辞職の件` は 賛成 40 / 反対 0）。
 * **だから「賛成多数だから可決」と書くことはできる。** **書かない。**
 *
 * **可否を多数決から推論しないのは、この専案の決め事である**（docs/DATA_CONTRACT.md）。
 * **議長辞職の件の議決結果は「可決」とは限らない**（「許可」の議会もある）。
 * **推論して書けば、それは一次資料に無い文字列を県の公表値として出すことになる**——
 * **利用者からは「県がそう書いた」と見分けがつかない**（#569 の重いほう）。
 *
 * ## なぜ「その 3 件を出さない」も選ばないか
 *
 * **賛否そのものは 42 人ぶん全部読めている。** **結果欄が空なだけで採決を丸ごと落とすと、
 * 「県が公表した表決が、うちには無い」ことになる**——**記録が出ないほうも損である**
 * （#569 は「別人の記録が出るほうが重い」と言っているだけで、「出さないのは無料」とは言っていない）。
 *
 * ## どうしたか: **空を「事故」ではなく「主張」にする**
 *
 * **`result: ""` を無条件に通すと、他の 10 議会で読み取りが壊れたときに黙って通る**
 * （今 3,683 採決のうち空は 3 件だけなので、この検査は実際に効いている）。
 *
 * **だから `resultAbsent: true` を付けたときだけ空を許す。**
 * **付けるのは「一次資料のその欄が空だ」と確かめた取得部だけ**で、
 * **`resultAbsent` が無いのに空なら今までどおり違反**。
 * **`resultAbsent` があるのに空でなければ違反**（言っていることと中身が食い違う）。
 */

const FIXTURE = (name: string): Buffer => readFileSync(new URL(`./fixtures/shiga/${name}`, import.meta.url));
const SESSION = { sessionId: "2025-04-rinji", sessionLabel: "令和7年 4月招集会議", year: 2025, month: 4 };
const PDF_URL = "https://www.shigaken-gikai.jp/voices/GikaiDoc/attach/Congress/Kg835_0425sanpi2.pdf";

/** **本物の名簿**（契約の検査は `kana` / `district` / `terms` まで見るので、合成の 1 人では足りない） */
const roster = (): LocalMember[] => parseRoster(iconv.decode(FIXTURE("giinlist.html"), "Shift_JIS"), { asOf: "2026-09-23" }).members;

test("#901 滋賀 Kg835: 議決結果が空の 3 行に `resultAbsent` が付く（4 行中 3 行。母数を出す）", async () => {
  const pdf = await parseVotePdf(FIXTURE("Kg835_0425sanpi2.pdf"));
  const { rollCalls } = toLocalRollCalls([{ pdf, pdfUrl: PDF_URL }], roster(), SESSION);
  // **母数**（#757）——この本の行を 1 つ残らず見ている
  assert.equal(rollCalls.length, 4);
  const absent = rollCalls.filter((rc) => rc.resultAbsent === true);
  const present = rollCalls.filter((rc) => rc.resultAbsent === undefined);
  assert.equal(absent.length, 3, "議決結果の欄が空の行");
  assert.equal(present.length, 1, "議決結果の欄に値がある行");
  // **空の 3 行の件名**（原文。別の行に付いていたら落ちる）
  assert.deepEqual(absent.map((rc) => rc.title).sort(), ["特別委員会改編動議", "議第98号（人事案件）", "議長辞職の件"]);
  // **`resultAbsent` が付いた行の `result` は空**（**多数決から埋めていない**）
  for (const rc of absent) assert.equal(rc.result, "", rc.title);
  // **値がある行は `承認`**（2 ページ目。**この本で結果欄が読めないのではない、という証拠**）
  assert.equal(present[0].result, "承認");
  assert.equal(present[0].title, "議第97号を承認すべきものとする総務・企画・公室常任委員長報告");
  // **`counts` は 3 行とも読めている**——**埋めようと思えば埋められたのに埋めていない**
  assert.deepEqual(absent.map((rc) => rc.counts?.yes).sort((a, b) => a! - b!), [38, 40, 41]);
});

test("#901 契約: `resultAbsent: true` のときだけ `result` の空を通す（無ければ今までどおり違反）", async () => {
  const pdf = await parseVotePdf(FIXTURE("Kg835_0425sanpi2.pdf"));
  const { rollCalls } = toLocalRollCalls([{ pdf, pdfUrl: PDF_URL }], roster(), SESSION);
  const build = () => buildLocalAssembly({
    assembly: SHIGA_ASSEMBLY,
    members: roster(),
    rollCalls,
    fetchedAt: "2026-09-23T00:00:00.000Z",
    rosterAsOf: "2026-09-23",
    sources: [{ name: "滋賀県議会 賛否状況", url: PDF_URL, fetchedAt: "2026-09-23T00:00:00.000Z" }],
    sessions: [{ sessionId: SESSION.sessionId, sessionLabel: SESSION.sessionLabel, sourceUrl: PDF_URL, pdfUrl: PDF_URL, rollcalls: rollCalls.length, unknownCells: 0 }],
    unmatched: [],
  });

  // (1) **`resultAbsent` が付いていれば通る**
  const dir = await mkdtemp(join(tmpdir(), "shiga-result-absent-"));
  await writeLocalAssembly(dir, build(), { national: [] });
  assert.deepEqual(await validateLocalAssemblies(dir), [], "契約違反");

  // (2) **`resultAbsent` を外すと違反になる**（読み取りが壊れて空になった場合を今までどおり捕まえる）
  const rel = "assemblies/pref-25/rollcalls/2025-04-rinji";
  const idx = join(dir, "assemblies/pref-25/rollcalls/index.json");
  const index = JSON.parse(await readFile(idx, "utf-8")) as { id: string; result: string; resultAbsent?: true }[];
  assert.equal(index.filter((r) => r.resultAbsent === true).length, 3, "index にも載る（母数）");
  const target = index.find((r) => r.resultAbsent === true)!;
  const file = join(dir, rel, `${target.id}.json`);
  const rc = JSON.parse(await readFile(file, "utf-8")) as Record<string, unknown>;
  delete rc.resultAbsent;
  await writeFile(file, JSON.stringify(rc));
  const v2 = await validateLocalAssemblies(dir);
  assert.equal(v2.filter((l) => l.includes("result required")).length, 1, `${JSON.stringify(v2)}`);

  // (3) **`resultAbsent` があるのに `result` が空でなければ違反**（言っていることと中身が食い違う）
  rc.resultAbsent = true;
  rc.result = "可決";
  await writeFile(file, JSON.stringify(rc));
  const v3 = await validateLocalAssemblies(dir);
  assert.equal(v3.filter((l) => l.includes("resultAbsent")).length, 1, `${JSON.stringify(v3)}`);
});
