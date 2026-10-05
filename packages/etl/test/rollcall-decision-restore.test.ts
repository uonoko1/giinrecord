import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RollCall, RollCallSummary } from "@seiji-kiroku/shared";
import { readCarried, restoreDecisions, lostDecisions } from "../src/sessions.ts";
import { summarizeRollCall } from "../src/aggregate.ts";
import { stableJson } from "../src/json.ts";

/**
 * **遡り（既定回次の外を取り直す実行）で、採決から判定の語が消える**（Issue #1206）。
 *
 * ## 何が起きたか（実測 2026-10-04、PR #1205 のレビューで PO が全数で確認）
 *
 * `pnpm etl 200 … 216` のあとに `data/rollcalls/index.json` の 380 行を基点と突き合わせた:
 *
 * ```
 * 語を持つ行: 348 → 347   （語が消えた 1 件 / 増えた 0 件 / 新規 0 件）
 * 209-1128-v010  可決（賛成 244・反対 0）  →  賛成 244・反対 0
 * ```
 *
 * **票数（賛成 244・反対 0）は残り、判定の語（可決）だけが落ちる。**
 * **読む人は「この採決がどうなったか」を読み取れなくなる。**
 *
 * ## 原因
 *
 * 判定の語は投票結果ページに無い（#26）。参院 議案情報の審議結果を案件名で突合して付けている。
 * `cli.ts` は突合できなかった採決について、**前回出力の `rollcalls/index.json` から語を戻していた**が、
 * その復元が **`carried`（今回取得しない回次）にしか効かない**:
 *
 * - `readCarried` が `decisions` に入れるのは `set.has(s.session)` の行だけ（carried の回次だけ）
 * - `cli.ts` の復元ループも `carried.rollCalls` だけを回す
 *
 * **遡りでは対象の回次が `targets` に入るので `carried` ではなくなり、復元が一切効かない。**
 * 209-1128-v010 は「租税特別措置法及び東日本大震災の被災者等に係る国税関係法律の臨時特例に関する
 * 法律の一部を改正する法律案（衆議院提出）」で、案件名が参院 議案情報の議案名と完全一致しないため突合に当たらない。
 * **日次 cron は既定 5 回次だけを触り、第209回は常に `carried` 側に居るので発火しない。**
 *
 * ## 復元元はどこに在るか（**コードを書く前に確かめた**）
 *
 * - **個票（`data/rollcalls/{session}/{id}.json`）には `result` が無い。** 実測: 先頭 40 件で 40/40 不在。
 *   キーは `date / groups / id / session / sourceUrl / title / totals / votes` だけ。
 *   **個票は復元元として使えない**（PO が Issue 本文で一度「個票から復元する」と書いたが撤回された）。
 * - **参院 議案情報は `data/` に永続化していない**（`data/bills/` は衆院 議案情報。別の出典）。
 * - **判定の語が在るのは `data/rollcalls/index.json` だけ。** だから復元元はそこしか無く、
 *   `readCarried` は既にそのファイルを全行読んでいて、**回次で捨てていただけ**だった。
 *
 * ## 「取り直して本当に変わった」場合と区別する（受け入れ条件 2）
 *
 * 復元は **今回の突合が何も見つけられなかった採決にだけ**効かせる。
 * 今回 `matchBillResults` が語を見つけたら、それが前回と違っても**今回の語を採る**
 * （参院 議案情報が訂正された場合に古い語を残さない）。`restoreDecisions` の第 1 引数が常に勝つ。
 */

const rc = (id: string, session: number, yes = 244, no = 0): RollCall => ({
  id, session, date: "2025-11-28", title: "日程第１　租税特別措置法の一部を改正する法律案（衆議院提出）",
  totals: { total: yes + no, yes, no }, groups: [{ group: "G", size: yes + no, yes, no }],
  votes: [{ memberId: "", nameText: "一 郎", group: "G", value: "賛成" }],
  sourceUrl: `https://www.sangiin.go.jp/japanese/touhyoulist/${session}/${id}.htm`,
});
const summary = (r: RollCall, result: string): RollCallSummary =>
  ({ id: r.id, session: r.session, date: r.date, title: r.title, totals: r.totals, result, sourceUrl: r.sourceUrl });

describe("readCarried: 判定の語は回次に関係なく全部読む（遡りの復元元）", () => {
  test("targets の回次の語も previousDecisions に入る（carried の語だけを読むと遡りで復元元が無くなる）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decision-restore-"));
    try {
      const carriedRc = rc("221-0605-v001", 221);
      const targetRc = rc("209-1128-v010", 209);
      await mkdir(join(dir, "rollcalls", "221"), { recursive: true });
      await writeFile(join(dir, "rollcalls", "221", "221-0605-v001.json"), stableJson(carriedRc));
      await writeFile(join(dir, "rollcalls", "index.json"), stableJson([
        summary(targetRc, "可決（賛成 244・反対 0）"),
        summary(carriedRc, "同意（賛成 244・反対 0）"),
        // 語を持たない行（人事案件など）は復元元にならない（推定しない）
        summary(rc("209-1128-v011", 209), "賛成 244・反対 0"),
      ]));

      // 遡り: targets = [209]、carried = [221]
      const carried = await readCarried(dir, [221]);

      // 従来の decisions は carried の回次だけ（既存の呼び出し元の意味を変えない）
      assert.deepEqual([...carried.decisions], [["221-0605-v001", "同意"]]);
      // 新しい previousDecisions は回次で捨てない。**ここが遡りの復元元**
      assert.deepEqual([...carried.previousDecisions].sort(), [
        ["209-1128-v010", "可決"],
        ["221-0605-v001", "同意"],
      ]);
      // 語を持たない行は入れない（「測れなかった」を「可決だった」に化けさせない。#1056）
      assert.equal(carried.previousDecisions.has("209-1128-v011"), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("前回出力が無ければ空（初回実行。復元元が無いことを 0 件として返す）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decision-restore-"));
    try {
      assert.deepEqual([...(await readCarried(dir, [221])).previousDecisions], []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("restoreDecisions: 今回の突合が勝ち、欠けた分だけ前回出力から戻す", () => {
  test("遡り（targets の回次）でも前回出力の語が戻る——これが #1206 の本体", () => {
    const fresh = new Map<string, string>();                      // matchBillResults が何も当てられなかった
    const previous = new Map([["209-1128-v010", "可決"]]);
    const r = restoreDecisions(fresh, previous, [rc("209-1128-v010", 209)]);
    assert.deepEqual([...r.decisions], [["209-1128-v010", "可決"]]);
    assert.deepEqual(r.restored, ["209-1128-v010"]);
    assert.deepEqual(r.stillMissing, []);
    // 公開される行が受け入れ条件 1 の逐語になる
    assert.equal(summarizeRollCall(rc("209-1128-v010", 209), r.decisions.get("209-1128-v010")).result, "可決（賛成 244・反対 0）");
  });

  test("今回の突合で語が変わったら今回の語を採る（古い語で上書きしない。受け入れ条件 2）", () => {
    const fresh = new Map([["209-1128-v010", "否決"]]);           // 参院 議案情報が訂正された
    const previous = new Map([["209-1128-v010", "可決"]]);
    const r = restoreDecisions(fresh, previous, [rc("209-1128-v010", 209)]);
    assert.deepEqual([...r.decisions], [["209-1128-v010", "否決"]]);
    assert.deepEqual(r.restored, [], "今回当たった採決は復元の対象にしない");
  });

  test("前回も今回も語が無い採決は語を持たない（人事案件・決議。推定しない）", () => {
    const r = restoreDecisions(new Map(), new Map(), [rc("209-1128-v011", 209)]);
    assert.deepEqual([...r.decisions], []);
    assert.deepEqual(r.stillMissing, ["209-1128-v011"]);
    assert.equal(summarizeRollCall(rc("209-1128-v011", 209), undefined).result, "賛成 244・反対 0");
  });

  test("今回の出力に無い採決の前回の語は持ち込まない（消えた採決を復活させない）", () => {
    const r = restoreDecisions(new Map(), new Map([["200-9999-v001", "可決"]]), [rc("209-1128-v010", 209)]);
    assert.equal(r.decisions.has("200-9999-v001"), false);
  });
});

describe("lostDecisions: 判定の語を持つ採決が前回より減っていないか（遡りを流さずに捕まえる）", () => {
  const before = [summary(rc("209-1128-v010", 209), "可決（賛成 244・反対 0）"), summary(rc("221-0605-v001", 221), "同意（賛成 244・反対 0）")];

  test("語が落ちた採決を名指しする——#1206 の実害の形", () => {
    const after = [summary(rc("209-1128-v010", 209), "賛成 244・反対 0"), summary(rc("221-0605-v001", 221), "同意（賛成 244・反対 0）")];
    assert.deepEqual(lostDecisions(before, after), [{ id: "209-1128-v010", session: 209, before: "可決", after: undefined }]);
  });

  test("語が別の語に変わっただけなら落とさない（訂正は正常。語を失ったときだけ止める）", () => {
    const after = [summary(rc("209-1128-v010", 209), "否決（賛成 244・反対 0）"), ...before.slice(1)];
    assert.deepEqual(lostDecisions(before, after), []);
  });

  test("採決そのものが今回の出力に無いのは対象外（回次の減少は lostSessionEntries の仕事）", () => {
    assert.deepEqual(lostDecisions(before, before.slice(0, 1)), []);
  });

  test("前回が空（初回実行・data/ を消した再構築）なら何も言わない", () => {
    assert.deepEqual(lostDecisions([], before), []);
  });

  test("語が増えるのは正常（突合が広がった）", () => {
    const b = [summary(rc("209-1128-v010", 209), "賛成 244・反対 0")];
    assert.deepEqual(lostDecisions(b, [summary(rc("209-1128-v010", 209), "可決（賛成 244・反対 0）")]), []);
  });
});
