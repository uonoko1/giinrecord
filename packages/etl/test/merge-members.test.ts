import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Member, MemberTerm } from "@seiji-kiroku/shared";
import { mergeRosters, rosterSessionsFor } from "../src/aggregate.ts";
import { parseMemberList } from "../src/sources/sangiin-members.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.htm`, import.meta.url), "utf-8");
const roster = (session: number) => `https://www.sangiin.go.jp/japanese/joho1/kousei/giin/${session}/giin.htm`;

const term = (session: number, group: string, district = "東京", to = "2028-07-25"): MemberTerm => ({ house: "sangiin", group, district, from: "", to, sessionFrom: session });
const member = (id: string, session: number, name: string, group = "自由民主党・無所属の会", extra: Partial<Member> = {}): Member => ({
  id, name, kana: "かな", house: "sangiin", terms: [term(session, group)], sourceUrl: roster(session), ...extra,
});

describe("mergeRosters: 回次ごとの名簿をプロフィールIDで1人に統合する", () => {
  test("同じ id は1人になり、連続する回次で会派・選挙区・任期が同じなら1つの term（sessionFrom〜sessionTo）に畳む", () => {
    const merged = mergeRosters([
      { session: 217, members: [member("m_1", 217, "一 郎")] },
      { session: 218, members: [member("m_1", 218, "一 郎")] },
      { session: 219, members: [member("m_1", 219, "一 郎")] },
    ]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0].terms, [{ ...term(217, "自由民主党・無所属の会"), sessionTo: 219 }]);
  });

  test("会派が変わった回次から別の term になり、terms は新しい順", () => {
    const merged = mergeRosters([
      { session: 217, members: [member("m_1", 217, "一 郎", "自由民主党・無所属の会")] },
      { session: 218, members: [member("m_1", 218, "一 郎", "自由民主党・無所属の会")] },
      { session: 219, members: [member("m_1", 219, "一 郎", "立憲民主・無所属")] },
    ]);
    assert.deepEqual(merged[0].terms, [
      { ...term(219, "立憲民主・無所属"), sessionTo: 219 },
      { ...term(217, "自由民主党・無所属の会"), sessionTo: 218 },
    ]);
  });

  test("氏名・かな・本名・sourceUrl は最新の名簿の表記をとる", () => {
    const merged = mergeRosters([
      { session: 217, members: [member("m_1", 217, "旧 姓", "自由民主党・無所属の会", { kana: "きゅう せい" })] },
      { session: 221, members: [member("m_1", 221, "新 姓", "自由民主党・無所属の会", { kana: "しん せい", legalName: "本名 太郎" })] },
    ]);
    assert.equal(merged[0].name, "新 姓");
    assert.equal(merged[0].kana, "しん せい");
    assert.equal(merged[0].legalName, "本名 太郎");
    assert.equal(merged[0].sourceUrl, roster(221));
  });

  test("最新の名簿にいない人（辞職・任期満了）も Member として残り、term の sessionTo は最後にいた回次", () => {
    const merged = mergeRosters([
      { session: 217, members: [member("m_1", 217, "一 郎"), member("m_2", 217, "二 郎")] },
      { session: 221, members: [member("m_1", 221, "一 郎"), member("m_3", 221, "三 郎")] },
    ]);
    assert.deepEqual(merged.map((m) => [m.id, m.terms[0].sessionFrom, m.terms[0].sessionTo]), [["m_1", 217, 221], ["m_2", 217, 217], ["m_3", 221, 221]]);
  });

  test("現職は最新回次の名簿に載っている人（current）", () => {
    const merged = mergeRosters([
      { session: 217, members: [member("m_1", 217, "一 郎"), member("m_2", 217, "二 郎")] },
      { session: 221, members: [member("m_1", 221, "一 郎")] },
    ]);
    assert.deepEqual(merged.map((m) => [m.id, m.current]), [["m_1", true], ["m_2", false]]);
  });

  test("回次の順番に依存せず同じ結果（入力が降順でも）", () => {
    const a = mergeRosters([{ session: 217, members: [member("m_1", 217, "一 郎")] }, { session: 221, members: [member("m_1", 221, "一 郎")] }]);
    const b = mergeRosters([{ session: 221, members: [member("m_1", 221, "一 郎")] }, { session: 217, members: [member("m_1", 217, "一 郎")] }]);
    assert.deepEqual(a, b);
  });

  test("名簿が1つだけなら current と term の sessionTo が付くだけで、その他は parseMemberList の出力と同じ", () => {
    const [m] = mergeRosters([{ session: 221, members: [member("m_1", 221, "一 郎")] }]);
    assert.deepEqual(m, { ...member("m_1", 221, "一 郎"), current: true, terms: [{ ...term(221, "自由民主党・無所属の会"), sessionTo: 221 }] });
  });

  test("名簿が0件なら例外（黙って空にしない）", () => {
    assert.throws(() => mergeRosters([]), /no rosters/);
  });

  test("実HTML: 第217〜221回の名簿を統合すると 247 名より多く、第221回にいない人は current=false", () => {
    const sessions = [217, 218, 219, 220, 221];
    const merged = mergeRosters(sessions.map((s) => ({ session: s, members: parseMemberList(fixture(`sangiin-giin-${s}`), roster(s), s) })));
    const latest = new Set(parseMemberList(fixture("sangiin-giin-221"), roster(221), 221).map((m) => m.id));
    assert.ok(merged.length > 247, `merged ${merged.length}`);
    assert.equal(merged.filter((m) => m.current).length, 247);
    assert.ok(merged.every((m) => m.current === latest.has(m.id)));
    assert.ok(merged.every((m) => m.terms.every((t) => t.sessionTo !== undefined && t.sessionTo >= t.sessionFrom)));
    assert.ok(merged.every((m) => m.terms.every((t, i) => i === 0 || m.terms[i - 1].sessionFrom > t.sessionFrom)), "terms は新しい順");
  });
});

describe("rosterSessionsFor: 回次 N の採決を突合するのに要る名簿の回次", () => {
  // 名簿ページ giin/{N}/giin.htm は「第N回の終了後のある時点（次の回次の直前）」の名簿で、
  // 第217回の名簿（令和7年7月31日現在）は同年7月の通常選挙で退任した議員を含まない。
  // 第N回中の議員は「N-1 の名簿 ∪ N の名簿」で覆える。
  test("最小回次の1つ前の名簿も含める", () => {
    assert.deepEqual(rosterSessionsFor([217, 218, 219, 220, 221]), [216, 217, 218, 219, 220, 221]);
    assert.deepEqual(rosterSessionsFor([221]), [220, 221]);
  });

  test("実HTML: 第216回の名簿には第217回の名簿にいない議員（任期満了）が多数いて、統合後も元職として残る", () => {
    const merged = mergeRosters([216, 217].map((s) => ({ session: s, members: parseMemberList(fixture(`sangiin-giin-${s}`), roster(s), s) })));
    const former = merged.filter((m) => !m.current);
    assert.ok(former.length >= 40, `former ${former.length}`);
    assert.ok(former.every((m) => m.terms[0].sessionTo === 216));
  });
});
