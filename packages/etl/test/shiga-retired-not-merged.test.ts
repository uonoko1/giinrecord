import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { LocalMember, LocalRollCall, LocalUnmatchedName } from "@seiji-kiroku/shared";
import { localNameKey, matchBySubsequence } from "../src/sources/local/name-match.ts";

/**
 * # **引退した議員の票が、同じ姓の現職に寄っていないこと**（Issue #901 / #569）
 *
 * ## なぜこれを別に測るか
 *
 * **`--sessions` を 2 → 19 に広げると、`unmatched` が 3 → 10 行（8 人）に増えた。**
 * **増えたのは「一次資料に在るが今の名簿に無い」議員**——**この任期の途中で退いた人たちである。**
 *
 * **ここでいちばん危ないのは「記録が出ない」ではなく「別人の記録が出る」ほうである**（#569）。
 * **退いた議員の票が、同じ姓の現職に寄ってしまえば、利用者からは検出できない虚偽になる。**
 *
 * **鳥取が同じ形を実測している**——**`matchName` を `.slice(0, 2)` に壊すと
 * `内田隆議員` が現職の `内田博長` に寄る**（#901 鳥取）。
 *
 * ## **滋賀には実際に「姓の 1 文字目が同じ」組が 2 つある**（実測 2026-09-23）
 *
 * | 寄らなかった氏名（一次資料） | 姓の 1 文字目が同じ現職 |
 * |---|---|
 * | **`岩佐 弘明`**（29 採決） | **`岩崎 和也`**（現職） |
 * | **`河井 昭成`**（124 採決） | **`河村 浩史`**（現職） |
 *
 * **「同姓が 1 人も居ないから安全」ではない。** **前方一致に崩せば寄る距離にある。**
 * **だからこの 2 組を名指しで固定する。**
 *
 * ## 実測（母数を出す。#757）
 *
 * ## **変異を当てて確かめた**（#520）
 *
 * | 変異（`matchBySubsequence` の部分列一致を差し替える） | 落ちた |
 * |---|---:|
 * | **姓の 1 文字で前方一致**（`slice(0, 1)`） | **2 / 4**（`岩佐 弘明` → `岩崎 和也`、`河井 昭成` → `河村 浩史`） |
 * | 姓の 2 文字で前方一致（`slice(0, 2)`） | **0 / 4**（**等価変異**。下の注） |
 *
 * **2 文字で落ちないのは滋賀のデータの形による**——**`岩佐` ≠ `岩崎`、`河井` ≠ `河村` なので、
 * 2 文字まで見れば区別できる。** **落ちないのは検査が弱いからではなく、
 * この県の実データに「姓が 2 文字とも同じ引退議員と現職」の組が無いからである**（#520 の分類 2）。
 * **鳥取は 2 文字でも落ちる**（`内田隆議員` → `内田博長`。姓が 2 文字とも同じ）——**県ごとに違う。**
 *
 * ## 実測（母数を出す。#757）
 *
 * | | |
 * |---|---:|
 * | セル（母数） | **6,886** |
 * | `memberId` が空の票 | **757（11.0%）** |
 * | **そのうち現職に寄ってしまった票** | **0** |
 * | `unmatched` の行 | **10**（8 人） |
 * | **`candidates` を持つ行** | **0**（**「2 人いて選べない」ですらない**） |
 */

const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));
const DIR = join(DATA, "assemblies", "pref-25");
const hasData = (() => { try { return statSync(join(DIR, "meta.json")).isFile(); } catch { return false; } })();

const rollCalls = (): LocalRollCall[] => {
  const out: LocalRollCall[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name !== "index.json" && e.name.endsWith(".json")) out.push(JSON.parse(readFileSync(p, "utf-8")) as LocalRollCall);
    }
  };
  walk(join(DIR, "rollcalls"));
  return out;
};
const members = (): LocalMember[] =>
  (JSON.parse(readFileSync(join(DATA, "members", "index.json"), "utf-8")) as LocalMember[]).filter((m) => m.assemblyId === "pref-25");
const unmatched = (): LocalUnmatchedName[] =>
  JSON.parse(readFileSync(join(DIR, "unmatched.json"), "utf-8")) as LocalUnmatchedName[];

test("#901 本番 pref-25: 寄らなかった氏名の票は 1 つ残らず `memberId` 空（現職に寄った票は 0）", { skip: !hasData }, () => {
  const names = new Set(unmatched().map((u) => u.nameText));
  assert.equal(names.size, 9, "母数（氏名。`九里 学` と `大野和三郎` は会派違いで 2 行ずつ）");
  const rcs = rollCalls();
  const all = rcs.flatMap((r) => r.votes);
  assert.equal(all.length, 6886, "母数（セル）");
  const theirs = all.filter((v) => names.has(v.nameText));
  // **母数**（#757）——**0 件を緑にしない。この人たちの票が実際に在ることを先に言う**
  assert.equal(theirs.length, 757, "寄らなかった氏名の票");
  // **本丸**: **1 票も現職に寄っていない**
  assert.deepEqual(
    theirs.filter((v) => v.memberId !== "").map((v) => `${v.nameText} → ${v.memberId}`),
    [],
    "**引退した議員の票が現職に寄っている**（#569 の重いほう）",
  );
});

/**
 * **`matchBySubsequence` を直に呼ぶ**ので、`toLocalRollCalls` との繋ぎが切れても
 * ここは「寄らない」ことを言い続ける（#774。`data/` を見るテストとは別の入口）。
 */
test("#901 **姓の 1 文字目が同じ現職に寄らない**（岩佐 弘明 ↮ 岩崎 和也 / 河井 昭成 ↮ 河村 浩史）", { skip: !hasData }, () => {
  const ms = members();
  assert.equal(ms.length, 42, "母数（名簿）");
  // **この組が実在すること**を先に固定する——**居なくなったらこの検査は空回りしている**
  const pairs: [string, string][] = [["岩 佐 弘 明", "岩崎 和也"], ["河 井 昭 成", "河村 浩史"]];
  for (const [, sitting] of pairs) {
    assert.ok(ms.some((m) => m.name === sitting), `現職 ${sitting} が名簿に居ない（この検査は空回りしている）`);
  }
  for (const [retired, sitting] of pairs) {
    // **姓の 1 文字目は同じ**（前方一致に崩せば寄る距離にある、という事実）
    assert.equal(localNameKey(retired)[0], localNameKey(sitting)[0], `${retired} / ${sitting}`);
    const hit = matchBySubsequence(retired, ms);
    assert.equal(hit.memberId, "", `${retired} が ${hit.memberId} に寄った`);
    // **「2 人いて選べない」ですらない**——**候補が 1 人も居ない**
    assert.deepEqual(hit.candidates, [], `${retired} に候補が付いた`);
  }
});

test("#901 本番 pref-25: 寄らなかった 10 行とも `candidates` が空（別人に付く余地が無い）", { skip: !hasData }, () => {
  const um = unmatched();
  assert.equal(um.length, 10, "母数");
  assert.deepEqual(um.filter((u) => (u.candidates ?? []).length > 0).map((u) => u.nameText), [], "候補を持つ行");
  // **名簿側から引き直しても同じ**（`unmatched.json` を手で書き換えても落ちる）
  const ms = members();
  for (const u of um) {
    const hit = matchBySubsequence(u.nameText, ms);
    assert.equal(hit.memberId, "", `${u.nameText} は名簿から引き直すと ${hit.memberId} に寄る`);
    assert.deepEqual(hit.candidates, [], `${u.nameText}`);
  }
});

/**
 * **逆方向の対照**: **名簿の 42 人は、引き直すと 42 人とも自分に寄る。**
 * **これが無いと「全部 `""` を返す実装」でも上の 3 つが通ってしまう**（#757）。
 */
test("#901 否定的対照: 名簿の 42 人は引き直すと 42 人とも自分に寄る（全部 `\"\"` を返す実装では通らない）", { skip: !hasData }, () => {
  const ms = members();
  assert.equal(ms.length, 42, "母数");
  const wrong: string[] = [];
  for (const m of ms) {
    const hit = matchBySubsequence(m.name, ms);
    if (hit.memberId !== m.id) wrong.push(`${m.name} → ${hit.memberId || "(寄らず)"}`);
  }
  assert.deepEqual(wrong, [], "名簿の氏名を引き直して自分に寄らなかった議員");
});
