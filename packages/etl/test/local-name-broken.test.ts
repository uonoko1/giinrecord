import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalMember, LocalRollCall } from "@seiji-kiroku/shared";
import { nonNameCharacters, unmatchedReason } from "../src/sources/local/name-match.ts";
import { buildLocalAssembly, validateLocalAssemblies, MIYAGI_ASSEMBLY } from "../src/local-assemblies.ts";
import { stableJson } from "../src/json.ts";

/**
 * 氏名が「別の字に化ける」置換を、突き合わせの失敗と区別する（Issue #680）。
 * 実測は docs/research/local-assemblies.md「滋賀 #680」の節。
 */

test("#680 滋賀の実例: 辻 が □(U+25A1) に化けた氏名から、名前になれない字を拾う", () => {
  assert.deepEqual(nonNameCharacters("□正隆"), ["□"]);
  assert.deepEqual(nonNameCharacters("□ 正隆"), ["□"]);
});

test("#680 化けていない氏名からは 1 文字も拾わない（本番 45,054 票の実測にあった字を全部含む）", () => {
  // 漢字
  assert.deepEqual(nonNameCharacters("辻 正隆"), []);
  // 異体字セレクタ付き（滋賀の 6/30・7/22 版、三重の本番 453 票）
  assert.deepEqual(nonNameCharacters("辻\u{E0100} 正隆"), []);
  // 々（本番 777 票）
  assert.deepEqual(nonNameCharacters("佐々木 一郎"), []);
  // かな（カタカナ氏名の議員が実在する）
  assert.deepEqual(nonNameCharacters("櫛引 ユキ子"), []);
  assert.deepEqual(nonNameCharacters("あさの ひろこ"), []);
  // CJK 互換漢字（滋賀の 隆 U+F9DC）・BMP 外（大分の 𠮷）・康熙部首（島根の ⾧）
  assert.deepEqual(nonNameCharacters("谷 成隆"), []);
  assert.deepEqual(nonNameCharacters("𠮷村 哲彦"), []);
  assert.deepEqual(nonNameCharacters("⾧岡 一郎"), []);
});

test("#680 私用領域の外字（pdf-table.ts が 〓 にするもの）も名前になれない字として拾う", () => {
  assert.deepEqual(nonNameCharacters("〓村 哲彦"), ["〓"]);
  assert.deepEqual(nonNameCharacters("正隆"), [""]);
});

test("#680 unmatchedReason: 名前になれない字があれば brokenGlyph、無ければ undefined（既存の形を変えない）", () => {
  assert.equal(unmatchedReason("□正隆"), "brokenGlyph");
  assert.equal(unmatchedReason("辻 正隆"), undefined);
  assert.equal(unmatchedReason("辻\u{E0100} 正隆"), undefined);
});

/**
 * 否定的対照（#554）: **本番データに 1 件も当たらないことを、本番データそのもので確かめる。**
 * 「壊れた氏名を拾う」だけのテストは、`nonNameCharacters` が全部の氏名を返す実装でも通る。
 * ここが落ちれば allowlist が狭すぎる（＝正しい氏名を壊れていると言う）。
 */
test("#680 否定的対照: 本番 data/ の全議員名・全票の nameText に 1 件も当たらない", async () => {
  const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));

  const members = JSON.parse(await readFile(join(DATA, "members/index.json"), "utf-8")) as { name: string }[];
  assert.ok(members.length > 900, `名簿が読めていなければこの対照は無意味（${members.length} 行）`);
  const memberHits = members.filter((m) => nonNameCharacters(m.name).length > 0);
  assert.deepEqual(memberHits.map((m) => m.name), [], "members/index.json の氏名に当たった");

  let votes = 0;
  const voteHits = new Set<string>();
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { await walk(join(dir, e.name)); continue; }
      if (!e.name.endsWith(".json") || e.name === "index.json") continue;
      const rc = JSON.parse(await readFile(join(dir, e.name), "utf-8")) as { votes?: { nameText: string }[] };
      for (const v of rc.votes ?? []) {
        votes++;
        if (nonNameCharacters(v.nameText).length > 0) voteHits.add(v.nameText);
      }
    }
  };
  await walk(join(DATA, "assemblies"));
  assert.ok(votes > 40000, `票が読めていなければこの対照は無意味（${votes} 票）`);
  assert.deepEqual([...voteHits], [], "rollcalls の nameText に当たった");
});

/**
 * `buildLocalAssembly` に載せる（#680）。**県ごとの rollcalls.ts ではなく、全県が通る 1 か所で付ける。**
 * 県ごとに書くと、次に足す県（滋賀）が写し忘れたときに黙って落ちる（#636 が異体字セレクタで踏んだ道）。
 */
test("#680 buildLocalAssembly: 壊れた字を含む氏名の unmatched 行にだけ reason: brokenGlyph が付く", () => {
  const m = (id: string, name: string): LocalMember => ({
    id, assemblyId: "pref-04", name, kana: "かな", group: "会派", district: "宮城",
    profileUrl: "https://www.pref.miyagi.jp/site/kengikai/x.html", current: true, asOf: "2026-04-23",
    sourceUrl: "https://www.pref.miyagi.jp/site/kengikai/18meibo-kaiha.html", counts: { rollcalls: 0 },
  });
  const yes = { raw: "○", legend: "賛成", mapped: "賛成" as const };
  const built = buildLocalAssembly({
    assembly: MIYAGI_ASSEMBLY,
    members: [m("p_04_a", "柚木 貴光")],
    rollCalls: [{
      id: "pref-04-398-20251217-発議案-8", assemblyId: "pref-04" as LocalRollCall["assemblyId"], sessionId: "398",
      sessionLabel: "令和7年11月定例会（第398回）", date: "2025-12-17", kind: "発議案", number: "8",
      title: "条例", result: "可決", page: 1,
      sourceUrl: "https://www.pref.miyagi.jp/documents/62682/hyouketsu071217.pdf",
      votes: [
        { memberId: "p_04_a", nameText: "柚木 貴光", group: "会派", value: yes },
        // 滋賀 Kg907_sanpi-080810-1.pdf の実測（辻 が □ に化けた形）
        { memberId: "", nameText: "□正隆", group: "会派", value: yes },
        // 名簿に無いだけの氏名（字は壊れていない）。ここに reason が付いてはいけない
        { memberId: "", nameText: "辞職 太郎", group: "会派", value: yes },
      ],
    }],
    fetchedAt: "2026-09-09T00:00:00.000Z", rosterAsOf: "2026-04-23",
    sources: [], sessions: [{ sessionId: "398", sessionLabel: "令和7年11月定例会（第398回）", sourceUrl: "https://www.pref.miyagi.jp/site/kengikai/x.html", pdfUrl: "https://www.pref.miyagi.jp/documents/62682/hyouketsu071217.pdf", rollcalls: 1, unknownCells: 0 }],
  });
  const byName = new Map(built.unmatched.map((u) => [u.nameText, u]));
  assert.deepEqual([...byName.keys()].sort(), ["□正隆", "辞職 太郎"]);
  assert.equal(byName.get("□正隆")?.reason, "brokenGlyph", "化けた氏名には理由が付くこと");
  assert.equal("reason" in (byName.get("辞職 太郎") ?? {}), false, "壊れていない氏名に理由の欄を作らないこと");
});

/**
 * 運用者に見える形にする（#680 の案B の目的）。`unmatched.json` に落とすだけでは
 * 「名簿に無い議員だ」と読まれる（案A の欠点そのもの）。ログでも区別が付くこと。
 */
test("#680 validateLocalAssemblies: unmatched.json の reason が実際の氏名と合っているかを検算する", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gl680-"));
  const A = "https://www.pref.miyagi.jp/site/kengikai/x.html";
  await mkdir(join(dir, "assemblies", "pref-04", "rollcalls"), { recursive: true });
  await mkdir(join(dir, "members"), { recursive: true });
  await writeFile(join(dir, "assemblies", "index.json"), stableJson([{ id: "pref-04", kind: "local", name: "宮城県議会", prefCode: "04", sourceUrl: A }]));
  await writeFile(join(dir, "members", "index.json"), stableJson([]));
  // 壊れていない氏名に brokenGlyph が付いている（人手で書き換えた／県の実装が誤って付けた）
  await writeFile(join(dir, "assemblies", "pref-04", "unmatched.json"), stableJson([{ nameText: "辞職 太郎", group: "会派", rollCallIds: ["r1"], reason: "brokenGlyph" }]));
  const v = await validateLocalAssemblies(dir);
  assert.ok(v.some((x) => x.includes("辞職 太郎") && x.includes("reason")), `reason の食い違いを検出すること: ${JSON.stringify(v)}`);
});
