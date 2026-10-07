import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import iconv from "iconv-lite";
import type { Bill } from "@seiji-kiroku/shared";
import { mergeShugiinBill, parseShugiinBill, toBillSummary } from "../src/sources/shugiin-bills.ts";

/**
 * **同じ議案に、審議回次ごとの別の経過ページが在る**（#1218）。
 *
 * `cli.ts` のコメントは **「継続審議の議案は複数回次の一覧に同じ経過ページで載る」** と
 * 書いていたが、**これは誤りである。** 実測（2026-10-07、一次資料を直接取得）:
 *
 * ```
 * 216-衆法-9「政治資金規正法の一部を改正する法律案」の経過ページ（審議回次ごとに別 URL）
 *   kaiji216  1DDDBA6  付託 2024-12-10 政治改革に関する特別   結果 閉会中審査  受理 2024-12-09
 *   kaiji217  1DDDD82  付託 2025-01-24 政治改革に関する特別   結果 閉会中審査  受理 なし
 *   kaiji218  1DDF436  付託 2025-08-01 政治改革に関する特別   結果 閉会中審査  受理 なし
 *   kaiji219  1DE0196  付託 2025-10-24 政治改革に関する特別   結果 閉会中審査  受理 なし
 *   kaiji220  1DE0AEE  **付託の欄が空**                        結果 なし       受理 なし
 * ```
 *
 * **id は `{提出回次}-{種類}-{番号}` なので 5 ページすべてが `216-衆法-9` に衝突する。**
 * 衝突を `Map.set` の後勝ちで解いていたため、**審議中で付託欄がまだ空の kaiji220 のページが
 * 勝ち、前の回次が記録していた付託・結果・受理日が丸ごと消えた。**
 *
 * **各ページは「その審議回次に起きたこと」の部分的な記録**であって、**議案の全体像ではない。**
 * だから **後のページが書いていない欄は、前のページが書いた値を消してはいけない。**
 *
 * 実測（`origin/main` → PR #1222 の `data/`、`data/bills/` の **1,941 件を全数**）:
 * ```
 * キーが消えた議案     18 件 / 1,941     （18/18 すべて sourceUrl が別ページに変わっている）
 *   result   が消えた  18 件
 *   received が消えた  16 件
 *   referral が消えた   4 件   ← bills/index.json の referredCommittees 1,660 → 1,656
 * ```
 */
const fixture = (name: string) => iconv.decode(readFileSync(new URL(`./fixtures/${name}.htm`, import.meta.url)), "Shift_JIS");
const BASE = "https://www.shugiin.go.jp/internet/itdb_gian.nsf/html/gian";
const bill = (keikaId: string) => parseShugiinBill(fixture(`shugiin-keika-${keikaId}`), `${BASE}/keika/${keikaId}.htm`);

/** 216-衆法-9 の 3 つの経過ページ（kaiji216 / kaiji217 / kaiji220）。 */
const S216 = "1DDDBA6";
const S217 = "1DDDD82";
const S220 = "1DE0AEE";
/** 216-衆法-10 の 2 つ（kaiji216 / kaiji217）。この議案は第217回で撤回され、kaiji220 には載らない。 */
const T216 = "1DDDC5E";
const T217 = "1DDDD8A";

describe("同じ議案の回次ごとの経過ページ: 事実が在ることは一次資料で確かめる（#1218）", () => {
  test("3 ページは同じ id に衝突し、kaiji220 のページだけ付託・結果・受理が空", () => {
    for (const k of [S216, S217, S220]) assert.equal(bill(k).id, "216-衆法-9", k);

    assert.deepEqual(bill(S216).referral, { shugiin: { date: "2024-12-10", committee: "政治改革に関する特別" } });
    assert.deepEqual(bill(S216).result, { shugiin: "閉会中審査" });
    assert.deepEqual(bill(S216).received, { shugiin: "2024-12-09" });

    assert.deepEqual(bill(S217).referral, { shugiin: { date: "2025-01-24", committee: "政治改革に関する特別" } });
    assert.equal(bill(S217).received, undefined);

    // **これが喪失を運んだページ**。欄が空なのは「付託が無かった」ではなく「その回次ではまだ付託されていない」。
    assert.equal(bill(S220).referral, undefined);
    assert.equal(bill(S220).result, undefined);
    assert.equal(bill(S220).received, undefined);
  });
});

describe("mergeShugiinBill: 後のページが書いていない欄は、前のページの値を消さない（#1218）", () => {
  test("kaiji220 のページを後から重ねても、付託・結果・受理が残る", () => {
    const merged = mergeShugiinBill(bill(S216), bill(S220));
    assert.deepEqual(merged.referral, { shugiin: { date: "2024-12-10", committee: "政治改革に関する特別" } });
    assert.deepEqual(merged.result, { shugiin: "閉会中審査" });
    assert.deepEqual(merged.received, { shugiin: "2024-12-09" });
    // **index 側（一覧の付託先）も戻る**——ここが 1,660 → 1,656 の 4 件分である。
    assert.deepEqual(toBillSummary(merged).referredCommittees, [{ house: "shugiin", committee: "政治改革に関する特別" }]);
  });

  test("後のページが書いている欄は、後のページを採る（新しい状態を採る、は変えない）", () => {
    const merged = mergeShugiinBill(bill(S216), bill(S217));
    // 付託は第217回のページが書いている → 新しい側（2025-01-24）
    assert.deepEqual(merged.referral, { shugiin: { date: "2025-01-24", committee: "政治改革に関する特別" } });
    // 受理日は第217回のページが書いていない → 第216回のページの値が残る
    assert.deepEqual(merged.received, { shugiin: "2024-12-09" });
    // sourceUrl は後のページ（いま読める最新の記録）
    assert.equal(merged.sourceUrl, `${BASE}/keika/${S217}.htm`);
  });

  test("撤回された議案（第217回まで。kaiji220 に無い）も壊れない", () => {
    for (const k of [T216, T217]) assert.equal(bill(k).id, "216-衆法-10", k);
    const merged = mergeShugiinBill(bill(T216), bill(T217));
    assert.deepEqual(merged.referral, { shugiin: { date: "2025-01-24", committee: "政治改革に関する特別" } });
    assert.deepEqual(merged.received, { shugiin: "2024-12-09" });
    assert.deepEqual(toBillSummary(merged).referredCommittees, [{ house: "shugiin", committee: "政治改革に関する特別" }]);
  });

  test("空の値では上書きしない（空文字・空配列・空オブジェクト）", () => {
    const base = { ...bill(S216), submitterGroups: ["立憲民主党・無所属"], submitterText: "大串 博志君外七名" };
    const next: Bill = { ...bill(S220), submitterGroups: [], submitterText: "" };
    const merged = mergeShugiinBill(base, next);
    assert.deepEqual(merged.submitterGroups, ["立憲民主党・無所属"]);
    assert.equal(merged.submitterText, "大串 博志君外七名");
  });

  test("supporterNames の空配列は「欄はあるが空」なので、後のページを採る", () => {
    // `parseShugiinBill` は「欄が無い」= undefined / 「欄はあるが空」= [] と分けている。
    // **空配列は事実の記録**（賛成者の欄が在って空）なので、undefined とは違い上書きしてよい。
    const base = { ...bill(S216), supporterNames: ["青柳陽一郎"] };
    const next = { ...bill(S220), supporterNames: [] as string[] };
    assert.deepEqual(mergeShugiinBill(base, next).supporterNames, []);
  });

  test("パーサは欄が無いときキーごと落とす（undefined を値に持たない）——それを前提にしている", () => {
    // **この性質が崩れたら `mergeShugiinBill` の `Object.entries` は undefined を書き込む。**
    // だから前提のほうを固定する（崩れたらここで落ちる）。
    for (const k of [S216, S217, S220, T216, T217]) {
      const undef = Object.entries(bill(k)).filter(([, v]) => v === undefined).map(([x]) => x);
      assert.deepEqual(undef, [], `${k}: undefined を値に持つキーが在る`);
    }
    assert.ok(!("referral" in bill(S220)), "kaiji220 のページは referral のキーを持たない");
    assert.ok("referral" in bill(S216), "kaiji216 のページは referral のキーを持つ");
  });

  test("値が明示的に undefined でも上書きしない（キーが在る形で渡されても消さない）", () => {
    // 呼び出し元が `{ ...b, referral: undefined }` のような形を作ったときに事実を消さないこと。
    const next = { ...bill(S220), referral: undefined, result: undefined, received: undefined } as Bill;
    assert.ok("referral" in next, "前提: このオブジェクトは referral のキーを持つ");
    const merged = mergeShugiinBill(bill(S216), next);
    assert.deepEqual(merged.referral, { shugiin: { date: "2024-12-10", committee: "政治改革に関する特別" } });
    assert.deepEqual(merged.result, { shugiin: "閉会中審査" });
    assert.deepEqual(merged.received, { shugiin: "2024-12-09" });
  });

  test("前のページに無く後のページに在る欄は入る", () => {
    const base = { ...bill(S220) };
    const merged = mergeShugiinBill(base, bill(S216));
    assert.deepEqual(merged.referral, { shugiin: { date: "2024-12-10", committee: "政治改革に関する特別" } });
  });

  test("id の違う議案を混ぜたら落とす（取り違えを黙って通さない）", () => {
    assert.throws(() => mergeShugiinBill(bill(S216), bill(T216)), /216-衆法-9.*216-衆法-10|216-衆法-10.*216-衆法-9/);
  });
});

describe("cli.ts の取り込みループが後勝ちに戻っていないこと（#1218）", () => {
  /**
   * **`mergeShugiinBill` が在っても、`cli.ts` が呼ばなければ喪失は戻る。**
   * 直したのは関数ではなくループなので、**ループの側を固定する。**
   * `cli.ts` はトップレベルで `await fetch` する実行スクリプトなので import できない。ソースを読む。
   */
  const src = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");

  test("衆院議案の取り込みは mergeShugiinBill を通る", () => {
    assert.match(src, /mergeShugiinBill/, "cli.ts が mergeShugiinBill を呼んでいない（後勝ちに戻っている）");
    assert.match(src, /import \{[^}]*mergeShugiinBill[^}]*\} from "\.\/sources\/shugiin-bills\.ts";/);
  });

  test("取得したページを素のまま set する行が無い（後勝ちの形が復活していない）", () => {
    // **これが喪失そのものの形**: `for (const b of list) shugiinBills.set(b.id, b);`
    const lastWins = [...src.matchAll(/shugiinBills\.set\(([^)]*)\)/g)].map((m) => m[1]!.trim());
    assert.ok(lastWins.length > 0, "shugiinBills.set の呼び出しが見つからない（検査が何も見ていない）");
    for (const args of lastWins) {
      assert.ok(
        /mergeShugiinBill/.test(args) || !/,\s*b\s*$/.test(args),
        `取得したページを素のまま上書きしている: shugiinBills.set(${args})`,
      );
    }
  });
});
