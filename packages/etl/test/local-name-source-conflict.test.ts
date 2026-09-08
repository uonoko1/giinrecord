import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalMember, LocalRollCall } from "@seiji-kiroku/shared";
import { conflictingRosterNames, unmatchedReason, matchBySubsequence } from "../src/sources/local/name-match.ts";
import { buildLocalAssembly, describeUnmatched, validateLocalAssemblies, MIYAGI_ASSEMBLY } from "../src/local-assemblies.ts";
import { stableJson } from "../src/json.ts";

/**
 * **一次資料どうしが氏名で食い違ったときに、それと分かる形で出さない**（Issue #711）。
 *
 * ## 実例（佐賀、#670 の実測）
 *
 * | 出典 | 表記 | コードポイント |
 * |---|---|---|
 * | 令和8年6月版 PDF | `猪村理恵子` | 理 = U+7406 |
 * | 令和6年2月版 PDF | `猪村利恵子` | 利 = U+5229 |
 * | 議員一覧ページ（img の alt） | `猪村利恵子議員` | 利 = U+5229 |
 *
 * **NFC でも異体字セレクタでもない、別の漢字である。** だから `localNameKey` は畳まないし、
 * 畳んではいけない（別字を畳むと別人の記録を作る。#569／`ITAIJI` の docblock）。
 *
 * ## 今どうなっているかは先に測った（#634 の教訓——既にある守りを二重に作らない）
 *
 * 実測（2026-09-09、本番 `data/`）:
 *   - `matchByExact` / `matchBySubsequence` / `matchBySurnamePrefix` のどれに食わせても
 *     `memberId: ""` / `candidates: []` になる。**別人には決まらない**（#569 は既に守られている）。
 *   - だが `unmatchedReason` は `undefined` を返す＝**「名簿に無い議員」と区別が付かない。**
 *     本番の `unmatched.json` にある 4 行（宮城 1・三重 3）はすべて `reason` 無しの
 *     「任期途中で抜けた議員」で、佐賀の食い違いが来ても**同じ見た目で並ぶ。**
 *   - **これは #680 が `brokenGlyph` で解いたのと同じ形の問題である**（落とす側は変えず、理由を書く）。
 *
 * ## 何を足したか——**決めるためではなく、名指しするため**
 *
 * `conflictingRosterNames` は「名簿の中に、**ちょうど 1 文字だけ違う**氏名の議員が居るか」を返す。
 * **返すのは事実だけで、寄せない。**
 *
 * **「1 文字違い＝同一人物」ではない。** 実測（同じ日、本番の地方名簿 285 名）:
 *   宮城 `高橋 克也` / `高橋 宗也`、三重 `喜田 健児` / `津田 健児`、高知 `西森 美和` / `西森 雅和`
 *   ——**現職どうしで 1 文字違いの組が 3 組ある。** だから 1 文字違いを根拠に寄せたら、
 *   その瞬間に別人の記録になる。**この関数の返り値を突き合わせに使ってはいけない。**
 *
 * ## 偽陽性を本番データで測った（#554 の否定的対照）
 *
 * 本番 `unmatched.json` の 4 行に当てて、1 字違いの名簿の議員は **0 件**（下の否定的対照の test）。
 * つまりこの理由が付いた行は、今の本番には 1 行も無い＝**既存 7 県の出力は変わらない。**
 */

/** 佐賀の実例（#670 の実測そのまま）。理 = U+7406 / 利 = U+5229 */
const SAGA_PDF_R8 = "猪村理恵子";
const SAGA_ROSTER = "猪村 利恵子";

test("#711 佐賀の実例: 理/利 は別の漢字なので、どの突合規則でも別人に決まらない（#569 は既に守られている）", () => {
  const roster = [{ id: "p_41_a", name: SAGA_ROSTER }, { id: "p_41_b", name: "山田 太郎" }];
  const m = matchBySubsequence(SAGA_PDF_R8, roster);
  assert.deepEqual(m, { memberId: "", candidates: [] }, "食い違った氏名を名簿の誰かに寄せてはいけない");
  // コードポイントが本当に別字であることを、テスト自身が固定する（NFC の揺れではない）
  assert.equal(SAGA_PDF_R8.codePointAt(2), 0x7406);
  assert.equal(SAGA_ROSTER.codePointAt(3), 0x5229);
});

test("#711 conflictingRosterNames: 1 文字だけ違う名簿の氏名を、寄せずに名指しする", () => {
  const roster = [{ id: "p_41_a", name: SAGA_ROSTER }, { id: "p_41_b", name: "山田 太郎" }];
  assert.deepEqual(conflictingRosterNames(SAGA_PDF_R8, roster), [{ id: "p_41_a", name: SAGA_ROSTER }]);
  // 空白の有無は localNameKey が落とすので、1 文字違いの数え方に影響しない
  assert.deepEqual(conflictingRosterNames("猪村 理恵子", roster), [{ id: "p_41_a", name: SAGA_ROSTER }]);
});

test("#711 conflictingRosterNames: 長さが違う・2 文字以上違う・完全一致は、食い違いではない", () => {
  const roster = [{ id: "p_41_a", name: SAGA_ROSTER }];
  // 完全一致（＝食い違っていない）。ここが [] でないと、正常に寄った氏名まで食い違い扱いになる
  assert.deepEqual(conflictingRosterNames(SAGA_ROSTER, roster), []);
  // 1 文字落ちた（部分列一致が拾う世界。#617/#648 の「字が落ちる」であって食い違いではない）
  assert.deepEqual(conflictingRosterNames("猪村恵子", roster), []);
  // 2 文字違う（別人の可能性が高く、1 字違いという根拠が無い）
  assert.deepEqual(conflictingRosterNames("猪村理恵美", roster), []);
  // 空文字は何とも比べない
  assert.deepEqual(conflictingRosterNames("", roster), []);
  assert.deepEqual(conflictingRosterNames("　", roster), []);
});

/**
 * **これがこの PBI で一番大事な test である。**
 * 「1 文字違い」を**決め手にしてはいけない**ことを、本番名簿に実在する 3 組で固定する。
 */
test("#711 1 文字違いは同一人物の根拠にならない（本番名簿に現職どうしの組が 3 組ある）", () => {
  const pairs: [string, string][] = [
    ["高橋 克也", "高橋 宗也"], // 宮城（pref-04）
    ["喜田 健児", "津田 健児"], // 三重（pref-24）
    ["西森 美和", "西森 雅和"], // 高知（pref-39）
  ];
  for (const [a, b] of pairs) {
    const roster = [{ id: "x", name: a }, { id: "y", name: b }];
    // 1 文字違いとして名指しはする（事実）
    assert.deepEqual(conflictingRosterNames(a, [{ id: "y", name: b }]), [{ id: "y", name: b }], `${a} と ${b} は 1 文字違い`);
    // **が、突き合わせは完全一致の本人に寄る**——名指しは突合に影響しない
    assert.equal(matchBySubsequence(a, roster).memberId, "x", `${a} は ${b} に寄ってはいけない`);
    assert.equal(matchBySubsequence(b, roster).memberId, "y", `${b} は ${a} に寄ってはいけない`);
  }
});

test("#711 unmatchedReason: 名簿と 1 文字違いなら sourceConflict、そうでなければこれまでどおり", () => {
  const roster = [{ id: "p_41_a", name: SAGA_ROSTER }];
  assert.equal(unmatchedReason(SAGA_PDF_R8, roster), "sourceConflict");
  // 名簿に無いだけの氏名（任期途中で抜けた等）は理由を付けない＝これまでどおり
  assert.equal(unmatchedReason("中島 源陽", roster), undefined);
  // 名簿を渡さなければ（名簿の要らない呼び出し）これまでどおり brokenGlyph だけを見る
  assert.equal(unmatchedReason(SAGA_PDF_R8, []), undefined);
  assert.equal(unmatchedReason("□正隆", []), "brokenGlyph");
});

test("#711 brokenGlyph が sourceConflict より優先する（字が壊れているほうが先に分かる事実）", () => {
  // 「□村 利恵子」は名簿の「猪村 利恵子」と 1 文字違いだが、□ は名前になれない字なので
  // **食い違いではなく文字化けである。** 推定して食い違い扱いにすると、議会に問い合わせる先を間違える。
  const roster = [{ id: "p_41_a", name: SAGA_ROSTER }];
  assert.deepEqual(conflictingRosterNames("□村利恵子", roster), [{ id: "p_41_a", name: SAGA_ROSTER }], "1 文字違いという事実自体は成り立つ");
  assert.equal(unmatchedReason("□村利恵子", roster), "brokenGlyph", "が、理由は brokenGlyph が先");
});

test("#711 buildLocalAssembly: 食い違った氏名の unmatched 行にだけ reason: sourceConflict が付く", () => {
  const m = (id: string, name: string): LocalMember => ({
    id, assemblyId: "pref-04", name, kana: "かな", group: "会派", district: "宮城",
    profileUrl: "https://www.pref.miyagi.jp/site/kengikai/x.html", current: true, asOf: "2026-04-23",
    sourceUrl: "https://www.pref.miyagi.jp/site/kengikai/18meibo-kaiha.html", counts: { rollcalls: 0 },
  });
  const yes = { raw: "○", legend: "賛成", mapped: "賛成" as const };
  const built = buildLocalAssembly({
    assembly: MIYAGI_ASSEMBLY,
    members: [m("p_04_a", "猪村 利恵子"), m("p_04_b", "柚木 貴光")],
    rollCalls: [{
      id: "pref-04-398-20251217-発議案-8", assemblyId: "pref-04" as LocalRollCall["assemblyId"], sessionId: "398",
      sessionLabel: "令和7年11月定例会（第398回）", date: "2025-12-17", kind: "発議案", number: "8",
      title: "条例", result: "可決", page: 1,
      sourceUrl: "https://www.pref.miyagi.jp/documents/62682/hyouketsu071217.pdf",
      votes: [
        { memberId: "p_04_b", nameText: "柚木 貴光", group: "会派", value: yes },
        // 一次資料どうしの食い違い（佐賀 猪村理恵子/利恵子）
        { memberId: "", nameText: SAGA_PDF_R8, group: "会派", value: yes },
        // 名簿に無いだけの氏名。ここに reason が付いてはいけない
        { memberId: "", nameText: "辞職 太郎", group: "会派", value: yes },
        // 字が壊れた氏名（#680）。既存の理由が消えていないこと
        { memberId: "", nameText: "□正隆", group: "会派", value: yes },
      ],
    }],
    fetchedAt: "2026-09-09T00:00:00.000Z", rosterAsOf: "2026-04-23",
    sources: [], sessions: [{ sessionId: "398", sessionLabel: "令和7年11月定例会（第398回）", sourceUrl: "https://www.pref.miyagi.jp/site/kengikai/x.html", pdfUrl: "https://www.pref.miyagi.jp/documents/62682/hyouketsu071217.pdf", rollcalls: 1, unknownCells: 0 }],
  });
  const byName = new Map(built.unmatched.map((u) => [u.nameText, u]));
  assert.deepEqual([...byName.keys()].sort(), ["□正隆", SAGA_PDF_R8, "辞職 太郎"].sort());
  assert.equal(byName.get(SAGA_PDF_R8)?.reason, "sourceConflict", "食い違いには理由が付くこと");
  assert.equal(byName.get("□正隆")?.reason, "brokenGlyph", "#680 の理由が消えていないこと");
  assert.equal("reason" in (byName.get("辞職 太郎") ?? {}), false, "名簿に無いだけの氏名に理由の欄を作らないこと");
  // **落とす側は変えない（#569 のまま）。** 食い違った票が誰かの timeline に入っていないこと
  assert.deepEqual(built.details.find((d) => d.id === "p_04_a")?.timeline, [], "食い違った票を名簿の議員に付けてはいけない");
});

test("#711 validateLocalAssemblies: unmatched.json の sourceConflict が名簿と合っているかを検算する", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gl711-"));
  const A = "https://www.pref.miyagi.jp/site/kengikai/x.html";
  await mkdir(join(dir, "assemblies", "pref-04", "rollcalls"), { recursive: true });
  await mkdir(join(dir, "members"), { recursive: true });
  await writeFile(join(dir, "assemblies", "index.json"), stableJson([{ id: "pref-04", kind: "local", name: "宮城県議会", prefCode: "04", sourceUrl: A }]));
  await writeFile(join(dir, "members", "index.json"), stableJson([{
    id: "p_04_a", assemblyId: "pref-04", name: SAGA_ROSTER, kana: "いむらりえこ", group: "会派", district: "宮城",
    profileUrl: A, current: true, asOf: "2026-04-23", sourceUrl: A, counts: { rollcalls: 0 },
  }]));
  // 名簿と 1 文字違いなのに理由が書かれていない（＝#711 の守りを外して書いた unmatched.json）
  await writeFile(join(dir, "assemblies", "pref-04", "unmatched.json"), stableJson([{ nameText: SAGA_PDF_R8, group: "会派", rollCallIds: ["r1"] }]));
  const v = await validateLocalAssemblies(dir);
  assert.ok(v.some((x) => x.includes(SAGA_PDF_R8) && x.includes("reason")), `理由の食い違いを検出すること: ${JSON.stringify(v)}`);
});

/**
 * 否定的対照（#554）: **本番 `data/` の unmatched 4 行に 1 件も当たらない。**
 * ここが落ちれば、既存 7 県の出力に差分が出る（＝この PBI の「data/ を変えない」条件を破っている）。
 * 「食い違いを拾う」だけの test は、全部を食い違いと言う実装でも通るので、この対照が要る。
 */
test("#711 否定的対照: 本番 data/ の unmatched 行は 1 つも sourceConflict にならない", async () => {
  const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));
  const members = JSON.parse(await readFile(join(DATA, "members/index.json"), "utf-8")) as (LocalMember & { assemblyId?: string })[];
  const locals = members.filter((m) => typeof m.assemblyId === "string" && m.assemblyId.startsWith("pref-"));
  assert.ok(locals.length > 200, `地方名簿が読めていなければこの対照は無意味（${locals.length} 名）`);
  const assemblies = [...new Set(locals.map((m) => m.assemblyId!))].sort();
  assert.equal(assemblies.length, 7, `既存 7 県を全部見ていること: ${assemblies.join(",")}`);

  let rows = 0;
  const hits: string[] = [];
  for (const a of assemblies) {
    const roster = locals.filter((m) => m.assemblyId === a).map((m) => ({ id: m.id, name: m.name }));
    const um = JSON.parse(await readFile(join(DATA, `assemblies/${a}/unmatched.json`), "utf-8")) as { nameText: string; reason?: string }[];
    for (const u of um) {
      rows++;
      const reason = unmatchedReason(u.nameText, roster);
      if (reason !== u.reason) hits.push(`${a} ${u.nameText}: ${String(reason)} !== ${String(u.reason)}`);
    }
  }
  assert.equal(rows, 4, `本番の unmatched は 4 行のはず（宮城 1・三重 3）。増減したらこの対照を測り直すこと（実測 2026-09-09）`);
  assert.deepEqual(hits, [], "本番 data/ の unmatched.json と理由が食い違った＝再生成すると data/ に差分が出る");
});

/**
 * **`unmatched.json` に落とすだけでは「名簿に無い議員だ」と読まれる**（#680 の案A の欠点そのもの）。
 * 運用者が**次に何を確かめればよいか**が 1 行で分かること。
 * `local-cli.ts` は起動しただけで走るのでテストから import できない——だから組み立ては
 * `local-assemblies.ts` の `describeUnmatched` に置いてある（#680 の validate と同じ考え）。
 */
test("#711 describeUnmatched: 理由ごとに、確かめる先が違うことが 1 行で分かる", () => {
  const roster = [{ id: "p_41_a", name: SAGA_ROSTER }];
  const row = (nameText: string, reason?: "brokenGlyph" | "sourceConflict") => ({ nameText, group: "会派", rollCallIds: ["r1", "r2"], ...(reason ? { reason } : {}) });

  const conflict = describeUnmatched(row(SAGA_PDF_R8, "sourceConflict"), roster);
  assert.match(conflict, /primary sources disagree on this name/);
  assert.ok(conflict.includes(SAGA_ROSTER), `どの氏名と食い違ったかを出すこと: ${conflict}`);
  assert.ok(conflict.includes("p_41_a"), `名簿のどの行かを出すこと: ${conflict}`);
  assert.match(conflict, /do NOT pick one/, "どちらかに寄せてはいけないと書くこと（#569）");

  // #680 のメッセージが消えていないこと（この関数は 1 行を丸ごと引き取っている）
  const broken = describeUnmatched(row("□正隆", "brokenGlyph"), roster);
  assert.match(broken, /text layer is broken/);
  assert.ok(broken.includes("U+25A1"), `化けた字のコードポイントを出すこと: ${broken}`);
  // **元の字を推定しない**（#569／#674）。名簿の氏名を「たぶんこれ」として出していないこと
  assert.equal(broken.includes(SAGA_ROSTER), false, `brokenGlyph の行に名簿の氏名を混ぜない: ${broken}`);

  // 理由なし（名簿に無いだけ）は、余計なことを言わない
  const plain = describeUnmatched(row("辞職 太郎"), roster);
  assert.equal(plain, "辞職 太郎（会派）: 2 roll calls");

  // 候補（#184 鳥取）の欄が残っていること
  const withCandidates = describeUnmatched({ ...row("浜田議員"), candidates: [{ id: "p_31_a" as never, name: "浜田 一穂" }] }, roster);
  assert.match(withCandidates, /candidates \(not chosen\): 浜田 一穂/);
});
