import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { CabinetRoleEntry, Member } from "@seiji-kiroku/shared";
import { buildDataset } from "../src/aggregate.ts";
import type { MatchedCabinetRole } from "../src/match-cabinet.ts";
import type { MatchedBill } from "../src/match-bills.ts";

/**
 * **閣僚等の役職を `data/` に出す**（Issue #1152。取得と名寄せは #1140 / PR #1149 で済んでいる）。
 *
 * ## このファイルが固定していること
 *
 * **`cabinetRole` は timeline の 8 番目の種別で、`session` を持たない唯一の国会の行である。**
 * **大臣の任免は内閣が行うので、国会の回次と結びつかない**（名簿に在るのは内閣の発足日だけ）。
 * **発足日から回次を逆算すると、一次資料に書かれていない値を作ることになる。**
 *
 * **終了日も持たない。** 「いつまで」は名簿に書かれておらず（#1141 の調査）、
 * 次のスナップショットとの差分からしか推定できない。**載せるのは現職だけ**なので要らない。
 */

const ROSTER = "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/221/giin.htm";
const MEIBO = "https://www.kantei.go.jp/jp/105/meibo/index.html";
const FUKU = "https://www.kantei.go.jp/jp/105/meibo/fukudaijin.html";

const member = (id: string, name: string, house: Member["house"] = "sangiin"): Member => ({
  id, name, kana: "", house,
  terms: [{ house, group: "自民", district: "東京", from: "", sessionFrom: 221 }],
  sourceUrl: ROSTER,
});

const role = (over: Partial<MatchedCabinetRole> = {}): MatchedCabinetRole => ({
  memberId: "m_1", nameText: "片山 さつき", kana: "かたやま さつき", house: "sangiin",
  kind: "閣僚等", role: "財務大臣", cabinet: 105,
  effectiveDate: "2026-09-17", effectiveDateText: "令和８年９月１７日発足",
  resolvedBy: "name", sourceUrl: MEIBO, ...over,
});

const cabinetRows = (members: readonly Member[], roles: readonly MatchedCabinetRole[]): CabinetRoleEntry[] => {
  const ds = buildDataset([...members], [], new Map(), [], [], [], [], [], [], [], roles);
  return ds.details.flatMap((d) => d.timeline.filter((e): e is CabinetRoleEntry => e.kind === "cabinetRole"));
};

describe("buildDataset: 閣僚等の役職（#1152）", () => {
  test("役職 1 件が cabinetRole 行 1 本になり、名簿の原文がそのまま載る", () => {
    const rows = cabinetRows([member("m_1", "片山 さつき")], [role()]);
    assert.deepEqual(rows, [{
      kind: "cabinetRole", estimated: false, date: "2026-09-17",
      section: "閣僚等", role: "財務大臣",
      effectiveDateText: "令和８年９月１７日発足", cabinet: 105, sourceUrl: MEIBO,
    }]);
  });

  test("session という欄を持たない（回次を発足日から逆算しない。#1152）", () => {
    const rows = cabinetRows([member("m_1", "片山 さつき")], [role()]);
    assert.equal(rows.length, 1);
    assert.equal("session" in rows[0], false, "cabinetRole に session が付いている（一次資料に無い回次を作っている）");
  });

  test("終了日を持たない（「いつまで」は名簿に書かれていない。#1141）", () => {
    const rows = cabinetRows([member("m_1", "片山 さつき")], [role()]);
    for (const k of ["endDate", "lastDate", "until", "toDate"]) {
      assert.equal(k in rows[0], false, `cabinetRole に ${k} が付いている（推定した終了日を事実の行に混ぜている）`);
    }
  });

  test("兼務は役職ごとに別の行になる（丸めない）", () => {
    const rows = cabinetRows([member("m_1", "赤澤 亮正", "shugiin")], [
      role({ memberId: "m_1", house: "shugiin", role: "経済産業大臣" }),
      role({ memberId: "m_1", house: "shugiin", role: "内閣府特命担当大臣（経済財政政策）" }),
    ]);
    assert.deepEqual(rows.map((r) => r.role), ["経済産業大臣", "内閣府特命担当大臣（経済財政政策）"]);
  });

  test("衆参どちらの議員にも付く（大臣は両院から出る）", () => {
    const rows = cabinetRows(
      [member("m_1", "片山 さつき", "sangiin"), member("h_1", "赤澤 亮正", "shugiin")],
      [role({ memberId: "m_1", house: "sangiin" }), role({ memberId: "h_1", house: "shugiin", role: "経済産業大臣" })],
    );
    assert.equal(rows.length, 2);
  });

  test("名簿の院と議員の院が食い違えば例外（名寄せの不整合を黙って捨てない）", () => {
    assert.throws(
      () => cabinetRows([member("m_1", "片山 さつき", "sangiin")], [role({ memberId: "m_1", house: "shugiin" })]),
      /cabinetRole .* house/,
    );
  });

  test("名簿に無い memberId は例外（黙って捨てない）", () => {
    assert.throws(() => cabinetRows([member("m_1", "片山 さつき")], [role({ memberId: "m_999" })]), /unknown memberId m_999/);
  });

  test("発足日はページごとに違う値がそのまま入る（閣僚 09-17 / 副大臣 09-18。1 つに丸めない）", () => {
    const rows = cabinetRows([member("m_1", "甲"), member("m_2", "乙")], [
      role({ memberId: "m_1", kind: "閣僚等", effectiveDate: "2026-09-17", effectiveDateText: "令和８年９月１７日発足", sourceUrl: MEIBO }),
      role({ memberId: "m_2", kind: "副大臣", role: "財務副大臣", effectiveDate: "2026-09-18", effectiveDateText: "令和８年９月１８日", sourceUrl: FUKU }),
    ]);
    assert.deepEqual(rows.map((r) => [r.date, r.effectiveDateText, r.section, r.sourceUrl]), [
      ["2026-09-17", "令和８年９月１７日発足", "閣僚等", MEIBO],
      ["2026-09-18", "令和８年９月１８日", "副大臣", FUKU],
    ]);
  });

  test("counts には数えない（counts は採決・議案・発言・質問主意書の 4 つのまま。#244 と同じ判断）", () => {
    const ds = buildDataset([member("m_1", "片山 さつき")], [], new Map(), [], [], [], [], [], [], [], [role()]);
    assert.deepEqual(ds.index[0].counts, { rollcalls: 0, bills: 0, speeches: 0, questions: 0 });
  });

  test("timeline の並びは日付降順のまま（発足日で他の行と混ざる）", () => {
    const bill = { memberId: "m_1", billId: "221-参法-1", date: "2026-10-01", title: "甲法案", role: "提出者", sourceUrl: "https://www.sangiin.go.jp/japanese/joho1/kousei/gian/221/meisai/m221080221001.htm" } satisfies MatchedBill;
    const ds = buildDataset([member("m_1", "片山 さつき")], [], new Map(), [], [bill], [], [], [], [], [], [role()]);
    assert.deepEqual(ds.details[0].timeline.map((e) => [e.kind, e.date]), [["bill", "2026-10-01"], ["cabinetRole", "2026-09-17"]]);
  });
});
