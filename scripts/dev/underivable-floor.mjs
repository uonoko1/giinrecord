#!/usr/bin/env node
// 導けない種別（committeeRole / attendance）の、議会 × 回次ごとの実測値を出す（#1175）。
//
// `packages/etl/test/published-timeline-count.test.ts` の `UNDERIVABLE_FLOOR` は**下限**なので、
// 増えても更新しなくてよい（下限は下限として効き続ける）。**上げ直したいときだけここを使う。**
//
//   node scripts/dev/underivable-floor.mjs      # 今の data/ を数えて、貼れる形で出す
//
// **下限との比較はここではしない。** 比較するのはテストのほうである
//   pnpm --filter @seiji-kiroku/etl test -- --test-name-pattern 'committeeRole'
// （下限の持ち主を 2 か所にすると腐る。#1056 で実際に腐らせた）
//
// **読むだけで、何も書き換えない。** 貼るのは人の手である
// （下限を自動で書き換えると「ETL が自分の出力を自分で承認する」形になり、#943 の抜け道になる）。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DATA = fileURLToPath(new URL("../../data/", import.meta.url));
const KINDS = ["committeeRole", "attendance"];

const readJson = async (p) => JSON.parse(await readFile(p, "utf-8"));

const count = async () => {
  const index = await readJson(join(DATA, "members/index.json"));
  const out = {};
  for (const kind of KINDS) out[kind] = {};
  let rows = 0;
  for (const m of index) {
    const d = await readJson(join(DATA, `members/${m.id}.json`));
    for (const e of d.timeline ?? []) {
      if (!KINDS.includes(e.kind)) continue;
      rows++;
      const asm = m.assemblyId ?? (d.house ? `diet-${d.house}` : "(none)");
      const session = typeof e.session === "number" ? String(e.session) : "(no session)";
      const key = `${asm}|${session}`;
      out[e.kind][key] = (out[e.kind][key] ?? 0) + 1;
    }
  }
  return { out, rows, members: index.length };
};

const { out, rows, members } = await count();

console.log(`// **実測 ${new Date().toISOString().slice(0, 10)}**（members ${members} 人 / 対象行 ${rows} 件）`);
for (const kind of KINDS) {
  const keys = Object.keys(out[kind]).sort();
  const total = keys.reduce((s, k) => s + out[kind][k], 0);
  console.log(`  /** 合計 ${total} */`);
  console.log(`  ${kind}: {`);
  for (const k of keys) console.log(`    "${k}": ${out[kind][k]},`);
  console.log(`  } as Record<string, number>,`);
}
