import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { FAKE_ADDRESSES, REQUIRED_TRAILER_ADDRESS } from "./fake-addresses.ts";

/**
 * **`scripts/ci/forbidden-patterns.sh` の `personal-address` 規則と、
 * 架空アドレスの唯一の出どころ（`fake-addresses.ts`）が食い違っていないことを見る**（Issue #1111）。
 *
 * ## 何があったか（実測）
 *
 * **2026-09-28 の 1 日で、利用者本人の個人アドレスが追跡ファイルに入りかける事故が 3 回**:
 *
 * | PR | ファイル | 入りかけた行数 | 誰が見つけたか |
 * |---|---|---|---|
 * | #1092 | `docs/WORKING_AGREEMENT.md` | 1 | レビュアー |
 * | #1103 | `packages/etl/test/commit-identity-allowlist.ts` | 1 | レビュアー |
 * | #1108 | `packages/etl/test/commit-trailer-identity.ts` | 5 | レビュアー |
 *
 * **自動の検査は 1 件も落としていない**（実測: 事故の 4 コミットの木に `origin/main` の
 * `forbidden-patterns.sh` を当てると **4 本とも exit 0**。新しい規則では **4 本とも exit 1**）。
 *
 * ## なぜ「値」ではなく「形」で判定するか
 *
 * **規則そのものに実在のアドレスを書いたら本末転倒**なので、
 * **ローカル部は任意・ドメインだけを個人メール提供者に限る**形にした。
 *
 * **採らなかった案（どちらも実測で穴が開く）**:
 * - **`git config user.email` と突き合わせる** → **CI で何も検出しない。**
 *   実測: HOME に設定の無い環境（Actions の checkout 直後）で `git config user.email` は
 *   空を返して exit 1。検査が要るのはまさにそこ。加えて #1105 のとおり `.git/config` は
 *   全 worktree 共有で、誰でも書き換えられる。
 * - **`git log` の author と突き合わせる** → `fetch-depth` 既定の浅いチェックアウトでは
 *   author が 1 人ぶんしか出ず、取りこぼす。
 *
 * ## ここが見るもの
 *
 * **シェル側のテスト（`scripts/ci/test/forbidden-patterns.test.sh`）は「規則が動くか」を見る。**
 * **ここは「架空アドレスの唯一の出どころが、その規則を通れる綴りのままか」を見る**
 * ——**綴りを 1 か所に決めても、その 1 か所が規則に引っかかる値に書き換わったら、
 * 誰もそこを使えなくなって元の散らばりに戻る。**
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const SCRIPT = resolve(ROOT, "scripts/ci/forbidden-patterns.sh");
const SRC = readFileSync(SCRIPT, "utf8");

/** 規則がシェルスクリプトから消えていないこと（消したら以下の検査は全部無意味になる）。 */
test("personal-address 規則が forbidden-patterns.sh に在る", () => {
  assert.ok(SRC.includes("PERSONAL_MAIL_DOMAINS="), "提供者ドメインの一覧が無い");
  assert.ok(SRC.includes("PERSONAL_ADDR_RE="), "判定の正規表現が無い");
  assert.ok(
    SRC.includes('report personal-address "$PERSONAL_OUT"'),
    "検出しても報告していなければ、この規則は在っても落ちない",
  );
  assert.ok(
    SRC.includes('echo "personal-address: $PERSONAL_N file(s) scanned"'),
    "母数（#757）: 「0 件検出」と「1 本も読めていない」を同じ緑にしない",
  );
});

/**
 * **規則自身が実在のアドレスを持っていないこと。**
 * **`@` の右にドメインだけが並び、`@` の左に具体的なローカル部が書かれていないこと**を見る。
 * （**ここが落ちたら、事故を止める規則自身が事故になっている。**）
 */
test("規則そのものに実在のアドレスが書かれていない", () => {
  // `名前@ドメイン` の形（ローカル部が具体的に書かれたアドレス）を探す。
  // シェル変数（`$PERSONAL_N` など）や `users.noreply.github.com` のような説明は `@` を含まない。
  const literal = [...SRC.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((m) => m[0]);
  assert.deepEqual(literal, [], `規則の中に逐語のアドレスが在る: ${literal.join(", ")}`);
});

/**
 * **偽陽性の検査（これが無いと使えない）。**
 * **唯一の出どころが持つ架空アドレスは、どれも規則に当たらないこと。**
 */
test("架空アドレスの唯一の出どころは、規則を素通りする", () => {
  const domains = extractDomains(SRC);
  assert.ok(domains.length >= 20, `提供者ドメインが ${domains.length} 個しか読めていない（読み取りの失敗）`);
  const all = [...FAKE_ADDRESSES, REQUIRED_TRAILER_ADDRESS];
  assert.ok(all.length >= 5, `架空アドレスが ${all.length} 個しか無い（出どころが空になっている）`);
  for (const addr of all) {
    const domain = addr.slice(addr.indexOf("@") + 1).toLowerCase();
    assert.ok(
      !domains.includes(domain),
      `${addr} は規則に当たる。架空アドレスとして使えない綴りが出どころに入っている`,
    );
  }
});

/**
 * **事故 3 件が実際に書いた提供者を、規則が持っていること。**
 * **`<ローカル部>@<提供者>` という形が当たることを、提供者名だけで確かめる**
 * （**アドレスは書かない**）。
 */
test("事故 3 件（#1092/#1103/#1108）が書いた提供者を規則が持っている", () => {
  const domains = extractDomains(SRC);
  // 事故 7 行はすべてこの提供者だった（実測: 4 コミットの `+` 行を数えて 1+1+4+1 = 7）。
  assert.ok(domains.includes("gmail.com"), "事故 7 行の提供者が一覧から消えている");
  // 1 ドメインの逐語にしない——次に別の提供者を書いた人を捕まえられなくなる。
  for (const d of ["yahoo.co.jp", "outlook.com", "icloud.com", "protonmail.com"]) {
    assert.ok(domains.includes(d), `${d} が一覧から消えている（提供者が変わると素通りする）`);
  }
});

/**
 * **機関の連絡先を落とさないこと。**
 * **県議会事務局の窓口アドレスはフィクスチャに実在する**（実測 2026-09-29: `…@pref.*.lg.jp` が
 * テキストの追跡ファイル 10 本）。**落としたら、直した人が検査ごと外す。**
 */
test("機関のドメインは提供者の一覧に入っていない", () => {
  const domains = extractDomains(SRC);
  for (const d of ["pref.tokushima.lg.jp", "pref.aomori.lg.jp", "users.noreply.github.com", "anthropic.com"]) {
    assert.ok(!domains.includes(d), `${d} が提供者として登録されている（機関・規約の値を落としてしまう）`);
  }
});

/**
 * `PERSONAL_MAIL_DOMAINS='a\.com|b\.co\.jp'` を小文字のドメイン一覧にする。
 *
 * **入れ子の括弧が無いことを前提にしてよい**——そう書くよう規則側のコメントに残してある。
 * **畳んだ形（`yahoo\.(com|co\.jp)`）だと `|` で割ったときに `yahoo\.(com` / `co\.jp` /
 * `de)` に化けて、「一覧に在るか」の検査が静かに嘘になる**（実測。最初この形で書いて踏んだ）。
 * **だから化けた断片が来たら読み取り失敗として落とす。**
 */
function extractDomains(src: string): string[] {
  const m = /PERSONAL_MAIL_DOMAINS='([^']*)'/.exec(src);
  assert.ok(m, "PERSONAL_MAIL_DOMAINS を読めていない（名前が変わった？）");
  const out: string[] = [];
  for (const alt of m[1].split("|")) {
    assert.ok(
      /^[a-z0-9-]+(\\\.[a-z0-9-]+)+$/.test(alt),
      `提供者の一覧に読めない項目が在る: [${alt}]（入れ子の括弧を使っていないか）`,
    );
    out.push(alt.replace(/\\\./g, ".").toLowerCase());
  }
  return out;
}
