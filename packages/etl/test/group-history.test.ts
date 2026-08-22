import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Member, MemberTerm } from "@seiji-kiroku/shared";
import { groupAt } from "../src/group-history.ts";

const term = (group: string, sessionFrom: number, sessionTo?: number): MemberTerm => ({ house: "sangiin", group, district: "東京", from: "", sessionFrom, ...(sessionTo !== undefined ? { sessionTo } : {}) });
const member = (terms: MemberTerm[]): Member => ({ id: "m_1", name: "一 郎", kana: "", house: "sangiin", terms, sourceUrl: "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/221/giin.htm" });

describe("groupAt: 採決の回次に効いている名簿の会派（名簿は会期後のスナップショット）", () => {
  // terms は mergeRosters の出力どおり新しい順
  const history = [term("いのちの党", 221, 221), term("れいわ新選組", 217, 220)];
  const cases: [string, MemberTerm[], number, string | undefined][] = [
    ["同じ回次の名簿があればそれ", history, 221, "いのちの党"],
    ["畳まれた範囲（sessionFrom〜sessionTo）の途中でも当たる", history, 219, "れいわ新選組"],
    ["範囲の端（sessionFrom）でも当たる", history, 217, "れいわ新選組"],
    ["同じ回次の名簿に無ければ直前の回次の名簿（会期中に退任）", [term("自由民主党・無所属の会", 217, 219)], 221, "自由民主党・無所属の会"],
    ["直前より前の回次しか無くても最も新しい過去の名簿", [term("公明党", 219, 219), term("日本維新の会", 217, 217)], 221, "公明党"],
    ["それより後の回次の名簿しか無ければ undefined（名簿に載る前の採決。推定しない）", [term("参政党", 221, 221)], 219, undefined],
    ["sessionTo が無い term は sessionFrom のみの名簿（parseMemberList 直後）", [term("社会民主党", 221)], 221, "社会民主党"],
    ["sessionTo が無い term でも過去の名簿として効く", [term("社会民主党", 219)], 221, "社会民主党"],
    ["terms が空なら undefined", [], 221, undefined],
  ];
  for (const [label, terms, session, expected] of cases) {
    test(label, () => assert.equal(groupAt(member(terms), session)?.group, expected));
  }

  test("入力の順序に依らない（古い順に並んでいても同じ）", () => {
    assert.equal(groupAt(member([...history].reverse()), 219)?.group, "れいわ新選組");
  });

  test("入力の terms を変更しない（純粋）", () => {
    const terms = [...history].reverse();
    groupAt(member(terms), 221);
    assert.deepEqual(terms.map((t) => t.group), ["れいわ新選組", "いのちの党"]);
  });
});
