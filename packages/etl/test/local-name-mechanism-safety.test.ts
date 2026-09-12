import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { localNameKey, matchBySubsequence, matchBySurnamePrefix, unmatchedReason } from "../src/sources/local/name-match.ts";

/**
 * Issue #722: **#711 が「名簿の氏名を 1 文字、同じ議会に実在する別の漢字に差し替えると
 * 16 件が別人に決まる」と測った**（母数 120,010）。**その 16 件に機序があるかを測る。**
 *
 * ## なぜこの検査が要るか
 *
 * **「別人の記録が出る」は利用者から検出できない**（#569）。
 * **だが「1 文字変えたら別人になる組み合わせが存在する」だけでは、実害があるとは言えない。**
 * **実データで起こりうる変化でそうなるかが問題である。**
 *
 * `WORKING_AGREEMENT.md` が実測した **氏名が壊れる 4 機序**（#569 / #529 / #617 / #670）で測る:
 *
 *   1/3. 1 文字欠落（異体字セレクタで幅 0、BMP 外文字が描画命令ごと欠落）
 *   2.   字体違い（名簿と PDF で別コードポイントの同字）
 *   4.   別の字に化ける（滋賀 `辻` → `□`）
 *
 * **実測（2026-09-09）: 3 機序とも「別人に決まる」は 0 件。**
 *
 * ## なぜ母数も固定するか
 *
 * **「別人 0 件」だけを見ると、測る対象が消えても通る**（#714 の「検算が空回り」、#705 の `EDGE` 6.0 の実例）。
 * **母数（当てた変化の総数）と「本人に決まった数」も一緒に見る。**
 *
 * ## 名簿は本番 data/ を読む
 *
 * **合成した名簿で測ると「実データで起こりうるか」を測ったことにならない。**
 * **名簿が変わればこの数字は動く**——**動いたら、この docblock ごと測り直すこと。**
 * **特に「別人 0 件」が崩れたら、それは実データで別人の記録が出る経路が開いたということである。**
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");

type Member = { id: string; name: string; assemblyId?: string };

const roster = (): Map<string, { id: string; name: string }[]> => {
  const all = JSON.parse(readFileSync(resolve(root, "data/members/index.json"), "utf8")) as Member[];
  const locals = all.filter((m) => typeof m.assemblyId === "string" && m.assemblyId.startsWith("pref-"));
  const byAssembly = new Map<string, { id: string; name: string }[]>();
  for (const m of locals) {
    const list = byAssembly.get(m.assemblyId!) ?? [];
    list.push({ id: m.id, name: m.name });
    byAssembly.set(m.assemblyId!, list);
  }
  return byAssembly;
};

/** 鳥取だけ突合規則が違う（姓の前方一致）。県ごとの規則をそのまま使う。 */
const matcherFor = (assemblyId: string) => (assemblyId === "pref-31" ? matchBySurnamePrefix : matchBySubsequence);

/** 各議員のキーに `mutate` を当て、その県の規則で引き直した結果を数える。 */
const measure = (mutate: (key: string[], i: number) => string | null) => {
  let total = 0, self = 0, other = 0, none = 0;
  const wrong: string[] = [];
  for (const [assemblyId, members] of roster()) {
    const match = matcherFor(assemblyId);
    for (const m of members) {
      const key = [...localNameKey(m.name)];
      for (let i = 0; i < key.length; i++) {
        const mutated = mutate(key, i);
        if (mutated === null) continue;
        total++;
        const r = match(mutated, members);
        if (r.memberId === "") { none++; continue; }
        if (r.memberId === m.id) { self++; continue; }
        other++;
        wrong.push(`${assemblyId} ${m.name} → ${mutated} → ${members.find((x) => x.id === r.memberId)?.name}`);
      }
    }
  }
  return { total, self, other, none, wrong };
};

test("#722 機序 1/3（1 文字欠落）: 別人に決まる例は無い", () => {
  const r = measure((key, i) => [...key.slice(0, i), ...key.slice(i + 1)].join(""));
  assert.equal(r.total, 1123, "母数が変わった＝名簿が変わっている。docblock ごと測り直すこと");
  assert.deepEqual(r.wrong, [], "**実データで起こりうる欠落で別人に決まる経路が開いた**（#569）");
  assert.equal(r.self, 1010, "本人に決まる数が変わった。名簿が変わっている");
});

test("#722 機序 4（別の字に化ける）: 別人に決まらず、全件 brokenGlyph として落ちる", () => {
  // 滋賀の実例は `□`(U+25A1)。同じ形になりうる代替文字も測る（#680 は □ しか見ていない）
  for (const replacement of ["□", "◇", "■", "?", "�"]) {
    const r = measure((key, i) => [...key.slice(0, i), replacement, ...key.slice(i + 1)].join(""));
    assert.equal(r.total, 1123, `母数が変わった（${replacement}）`);
    assert.deepEqual(r.wrong, [], `**${replacement} に化けて別人に決まる経路が開いた**`);
    assert.equal(r.none, 1123, `${replacement} は全件 unmatched に落ちるはず`);
    // #680 の守り: 「名簿に無い」ではなく「字が化けた」と区別できること
    for (const [assemblyId, members] of roster()) {
      const sample = [...localNameKey(members[0].name)];
      const broken = [replacement, ...sample.slice(1)].join("");
      assert.equal(unmatchedReason(broken, members), "brokenGlyph",
        `${assemblyId} で ${replacement} が brokenGlyph と判定されない（#680 の守りが効いていない）`);
    }
  }
});

test("#722 16 件が要求する字の置換は、どの正規化でも同一にならない（＝機序が無い）", () => {
  // #711 が挙げた 16 件の (元の字 → 置換後の字)。
  // **異体字でも似た字形でもないことを固定する**——ここが崩れたら「機序の無い置換」という結論が変わる。
  const pairs: [string, string][] = [
    ["啓", "二"], ["啓", "伸"], ["啓", "克"], ["啓", "宗"],
    ["克", "宗"], ["宗", "克"], ["喜", "津"], ["津", "喜"],
    ["信", "延"], ["信", "良"], ["絢", "信"], ["絢", "芳"],
    ["晋", "理"], ["晋", "絵"], ["美", "雅"], ["雅", "美"],
  ];
  assert.equal(pairs.length, 16, "16 件を全部並べること");
  for (const [a, b] of pairs) {
    assert.notEqual(a.normalize("NFC"), b.normalize("NFC"), `${a} と ${b} が NFC で同一`);
    assert.notEqual(a.normalize("NFKC"), b.normalize("NFKC"), `${a} と ${b} が NFKC で同一`);
    assert.notEqual(localNameKey(a), localNameKey(b), `${a} と ${b} が ITAIJI で畳まれる（＝畳みすぎ。#636）`);
  }
});

test("#722 #711 の sourceConflict は、寄ってしまった 16 件には届かない（範囲の記録）", () => {
  // **`unmatchedReason` は 16 件すべてを sourceConflict と判定するが、
  // `local-assemblies.ts` はそれを unmatched に落ちたものにしか呼ばない。**
  // 16 件は matchBySubsequence が先に別人を返すので unmatched に入らない。
  // **これは #711 の欠陥ではない**（#711 は「寄せられなかった氏名」の PBI だった）。
  // ここが変わったら（＝寄る前に見るようになったら）、この test を消してよい。
  const byAssembly = roster();
  const miyagi = byAssembly.get("pref-04");
  assert.ok(miyagi, "宮城の名簿が読めない");
  const m = matchBySubsequence("高橋克也", miyagi!);
  assert.notEqual(m.memberId, "", "「高橋克也」は今も誰かに寄る（寄らなくなったら状況が変わった）");
  assert.equal(unmatchedReason("高橋克也", miyagi!), "sourceConflict",
    "unmatchedReason 自体は食い違いだと判定できる（呼ばれていないだけ）");
});
