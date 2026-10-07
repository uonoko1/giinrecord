import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import iconv from "iconv-lite";
import type { Bill } from "@seiji-kiroku/shared";
import { addShugiinBillPage, mergeShugiinBill, parseShugiinBill, toBillSummary } from "../src/sources/shugiin-bills.ts";

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

  test("referral はページ単位で採る——一次資料のどのページにも無い組み合わせを作らない", () => {
    // **これが一番危ない形**（「別人の記録が出る」と同型の、利用者から検出できない虚偽）。
    // 欄単位で混ぜると、**第216回の衆院付託と別の回次の参院付託を 1 件の referral に並べる**ことになる。
    const prev: Bill = { ...bill(S216), referral: { shugiin: { date: "2024-12-10", committee: "政治改革に関する特別" } } };
    const next: Bill = { ...bill(S217), referral: { sangiin: { date: "2025-06-01", committee: "政治改革に関する特別" } } };
    const merged = mergeShugiinBill(prev, next);
    // 後のページの referral をそのまま採る（shugiin を混ぜ込んで 2 院ぶんにしない）
    assert.deepEqual(merged.referral, { sangiin: { date: "2025-06-01", committee: "政治改革に関する特別" } });
    assert.equal(Object.keys(merged.referral!).length, 1, "2 つのページの付託が 1 件の referral に混ざっている");
  });

  test("id の違う議案を混ぜたら落とす（取り違えを黙って通さない）", () => {
    assert.throws(() => mergeShugiinBill(bill(S216), bill(T216)), /216-衆法-9.*216-衆法-10|216-衆法-10.*216-衆法-9/);
  });
});

describe("同じ回次の一覧の中でも衝突する（回次を跨がなくても起きる。#1218）", () => {
  /**
   * **`217-予算-1` は kaiji217 の一覧に 2 ページ載っている。**
   * ```
   *   keika/1DDE03E  衆 2025-01-24 予算 ／ 参(予備) 2025-01-24 予算 ／ 参 2025-03-04 予算
   *   keika/1DDEE9E  **3 欄とも空**
   * ```
   * **「後の回次が勝つ」ではなく「一覧に後から出たページが勝つ」ので、同じ回次の中でも事実が消える。**
   * **実測: `origin/main` の `data/bills/217/217-予算-1.json` は既に `referral` を持たない**
   * ——#1218 が報告された 4 件より前から、**誰にも数えられずに落ちていた。**
   */
  const Y1 = "1DDE03E";
  const Y2 = "1DDEE9E";

  test("2 ページは同じ id で、後のページは両院の付託が空", () => {
    for (const k of [Y1, Y2]) assert.equal(bill(k).id, "217-予算-1", k);
    assert.deepEqual(bill(Y1).referral, {
      shugiin: { date: "2025-01-24", committee: "予算" },
      sangiinPreliminary: { date: "2025-01-24", committee: "予算" },
      sangiin: { date: "2025-03-04", committee: "予算" },
    });
    assert.equal(bill(Y2).referral, undefined);
  });

  test("マージすれば両院の付託が残る（後勝ちでは両方消える）", () => {
    const merged = mergeShugiinBill(bill(Y1), bill(Y2));
    assert.deepEqual(toBillSummary(merged).referredCommittees, [
      { house: "shugiin", committee: "予算" },
      { house: "sangiin", committee: "予算" },
    ]);
    // 後勝ちだと欄ごと落ちる（これが main の現状）
    assert.equal(toBillSummary(bill(Y2)).referredCommittees, undefined);
  });
});

describe("cli.ts の取り込みループが後勝ちに戻っていないこと（#1218）", () => {
  /**
   * **`mergeShugiinBill` が在っても、`cli.ts` が呼ばなければ喪失は戻る。**
   * 直したのは関数ではなくループなので、**ループの側を固定する。**
   * `cli.ts` はトップレベルで `await fetch` する実行スクリプトなので import できない。ソースを読む。
   */
  const src = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");

  test("衆院議案の取り込みは addShugiinBillPage を通る", () => {
    assert.match(src, /addShugiinBillPage/, "cli.ts が addShugiinBillPage を呼んでいない（後勝ちに戻っている）");
    assert.match(src, /import \{[^}]*addShugiinBillPage[^}]*\} from "\.\/sources\/shugiin-bills\.ts";/);
  });

  test("取得したページを素のまま set する行が無い（後勝ちの形が復活していない）", () => {
    // **これが喪失そのものの形**: `for (const b of list) shugiinBills.set(b.id, b);`
    // **`shugiinBills.set(` が 1 つも無いのが正しい**（重ねるのは addShugiinBillPage の役目）。
    // **「0 件だから clean」ではない**ので、取り込みループ自体が在ることを別に確かめる。
    assert.match(src, /for \(const b of list\)/, "取り込みループが見つからない（検査が何も見ていない）");
    const lastWins = [...src.matchAll(/shugiinBills\.set\(([^)]*)\)/g)].map((m) => m[1]!.trim());
    assert.deepEqual(lastWins, [], "cli.ts が自分で shugiinBills.set している（後勝ちに戻せる形）");
  });
});

describe("取り込みの順序: 新しいページが古いページに負けないこと（#1218 レビュー指摘 1）", () => {
  /**
   * **引数順は「語が在るか」では守れない。**
   *
   * `mergeShugiinBill(previous, b)` を `mergeShugiinBill(b, previous)` に変えると
   * **「古いページが新しいページを上書きする」**——この PR が直したバグがそのまま戻る。
   * **それでも `mergeShugiinBill` という語は在るので、ソースを見る検査は落ちない。**
   *
   * **実測（レビューが一次資料 79 件で測った）**: 引数を逆にすると
   * **21/79 件の付託日が古い値に化けるのに、`referredCommittees` の件数は 1 件しか動かない。**
   * **件数の検査でも、語を見る検査でも鳴らない**＝**黙って別の値が出る**形である。
   *
   * **だから「取り込みの 1 歩」を関数に出して、振る舞いで固定する。**
   */
  test("addShugiinBillPage: 同じ id の 2 ページ目を重ねても、新しいページの値が勝つ", () => {
    const bills = new Map<string, Bill>();
    addShugiinBillPage(bills, bill(S216));
    addShugiinBillPage(bills, bill(S217));
    const got = bills.get("216-衆法-9")!;
    // **第217回のページが書いた付託日を採る**（引数が逆だと 2024-12-10 のまま＝古いページが勝つ）
    assert.deepEqual(got.referral, { shugiin: { date: "2025-01-24", committee: "政治改革に関する特別" } });
    assert.equal(got.sourceUrl, `${BASE}/keika/${S217}.htm`, "新しいページの sourceUrl を採っていない");
    // **第216回のページだけが書いた受理日は残る**（これが #1218 の修正そのもの）
    assert.deepEqual(got.received, { shugiin: "2024-12-09" });
  });

  test("addShugiinBillPage: 欄が空の最新ページを重ねても、前のページの事実が残る", () => {
    const bills = new Map<string, Bill>();
    addShugiinBillPage(bills, bill(S216));
    addShugiinBillPage(bills, bill(S220));
    const got = bills.get("216-衆法-9")!;
    assert.deepEqual(got.referral, { shugiin: { date: "2024-12-10", committee: "政治改革に関する特別" } });
    assert.deepEqual(got.result, { shugiin: "閉会中審査" });
  });

  test("addShugiinBillPage: 3 ページを順に重ねると、最後に書かれた付託日になる", () => {
    const bills = new Map<string, Bill>();
    for (const k of [S216, S217, S220]) addShugiinBillPage(bills, bill(k));
    const got = bills.get("216-衆法-9")!;
    // S220 は付託が空なので、最後に「書いた」のは S217
    assert.equal(got.referral?.shugiin?.date, "2025-01-24");
    // **引数が逆だと S216 の 2024-12-10 になる**
    assert.notEqual(got.referral?.shugiin?.date, "2024-12-10", "古いページが勝っている（引数順が逆）");
    assert.equal(bills.size, 1, "同じ id が 2 行になっている");
  });

  test("addShugiinBillPage: 初めて見る id はそのまま入る", () => {
    const bills = new Map<string, Bill>();
    addShugiinBillPage(bills, bill(T216));
    assert.deepEqual(bills.get("216-衆法-10"), bill(T216));
    assert.equal(bills.size, 1);
  });

  test("addShugiinBillPage: 重ねた回数を返す（cli のログが数を言えること）", () => {
    const bills = new Map<string, Bill>();
    assert.equal(addShugiinBillPage(bills, bill(S216)), false, "初出で true を返している");
    assert.equal(addShugiinBillPage(bills, bill(S217)), true, "衝突したのに false を返している");
  });

  test("cli.ts は addShugiinBillPage を使い、自分で set していない", () => {
    const src = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    assert.match(src, /addShugiinBillPage\(shugiinBills, b\)/, "cli.ts が addShugiinBillPage を呼んでいない");
    // **引数順を自前で書ける形（直接 set / 直接 merge）が残っていないこと**
    assert.doesNotMatch(src, /shugiinBills\.set\(/, "cli.ts が自分で shugiinBills.set している（引数順を取り違えられる）");
    assert.doesNotMatch(src, /mergeShugiinBill\(/, "cli.ts が自分で mergeShugiinBill を呼んでいる（引数順を取り違えられる）");
  });
});
