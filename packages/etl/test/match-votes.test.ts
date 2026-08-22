import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Member, RollCall } from "@seiji-kiroku/shared";
import { matchVotes, normalizeName } from "../src/match-votes.ts";
import { parseRollCall } from "../src/sources/sangiin-votes.ts";
import { parseMemberList } from "../src/sources/sangiin-members.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.htm`, import.meta.url), "utf-8");
const BASE = "https://www.sangiin.go.jp/japanese/touhyoulist/221";

const member = (id: string, name: string, group: string, extra: Partial<Member> = {}): Member => ({
  id, name, kana: "", house: "sangiin",
  terms: [{ house: "sangiin", group, district: "", from: "", sessionFrom: 221 }],
  sourceUrl: "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/221/giin.htm",
  ...extra,
});

const rollCall = (votes: { nameText: string; group: string }[]): RollCall => ({
  id: "221-0605-v001", session: 221, date: "2026-06-05", title: "t",
  totals: { total: votes.length, yes: votes.length, no: 0 },
  groups: [],
  votes: votes.map((v) => ({ memberId: "", value: "賛成" as const, ...v })),
  sourceUrl: `${BASE}/221-0605-v001.htm`,
});

describe("normalizeName: 表記ゆれの吸収", () => {
  const cases: [string, string, string][] = [
    ["半角空白を除く", "青木 一彦", "青木一彦"],
    ["全角空白を除く", "青木　一彦", "青木一彦"],
    ["空白の連続を除く", "阿達 　 雅志", "阿達雅志"],
    ["空白なしはそのまま", "いんどう周作", "いんどう周作"],
    ["髙→高（はしご高）", "髙橋 克法", "高橋克法"],
    ["﨑→崎（たつさき）", "山﨑 正昭", "山崎正昭"],
    ["德→徳", "德永 エリ", "徳永エリ"],
    ["濵→浜", "濵田 聡", "浜田聡"],
    ["邊・邉→辺", "渡邊 渡邉", "渡辺渡辺"],
    ["全角英数は半角に（NFKC）", "Ａ１", "A1"],
  ];
  for (const [label, input, expected] of cases) {
    test(label, () => assert.equal(normalizeName(input), expected));
  }
});

describe("matchVotes: 純粋関数", () => {
  test("氏名が一致し候補が1人なら memberId が入る", () => {
    const members = [member("m_000001", "青木 一彦", "自民")];
    const { rollCall: rc, unmatched } = matchVotes(rollCall([{ nameText: "青木　一彦", group: "自由民主党・無所属の会" }]), members);
    assert.equal(rc.votes[0].memberId, "m_000001");
    assert.deepEqual(unmatched, []);
  });

  test("入力の rollCall を変更しない（純粋）", () => {
    const input = rollCall([{ nameText: "青木 一彦", group: "自由民主党・無所属の会" }]);
    matchVotes(input, [member("m_000001", "青木 一彦", "自民")]);
    assert.equal(input.votes[0].memberId, "");
  });

  test("名簿が本名表記でも通称（legalName）で一致する", () => {
    const members = [member("m_000002", "山田 太郎", "自民", { legalName: "山田 花子" })];
    const { rollCall: rc } = matchVotes(rollCall([{ nameText: "山田 花子", group: "自由民主党・無所属の会" }]), members);
    assert.equal(rc.votes[0].memberId, "m_000002");
  });

  test("同姓同名は会派で分ける", () => {
    const members = [member("m_000003", "鈴木 一郎", "自民"), member("m_000004", "鈴木 一郎", "立憲")];
    const { rollCall: rc, unmatched } = matchVotes(rollCall([
      { nameText: "鈴木 一郎", group: "立憲民主・無所属" },
      { nameText: "鈴木 一郎", group: "自由民主党・無所属の会" },
    ]), members);
    assert.deepEqual(rc.votes.map((v) => v.memberId), ["m_000004", "m_000003"]);
    assert.deepEqual(unmatched, []);
  });

  test("同姓同名で会派でも分けられなければ未突合（memberId は空）", () => {
    const members = [member("m_000003", "鈴木 一郎", "自民"), member("m_000004", "鈴木 一郎", "自民")];
    const { rollCall: rc, unmatched } = matchVotes(rollCall([{ nameText: "鈴木 一郎", group: "自由民主党・無所属の会" }]), members);
    assert.equal(rc.votes[0].memberId, "");
    assert.deepEqual(unmatched, [{ nameText: "鈴木 一郎", group: "自由民主党・無所属の会", rollCallId: "221-0605-v001" }]);
  });

  test("氏名が名簿にない場合は未突合として列挙し、例外にしない", () => {
    const { rollCall: rc, unmatched } = matchVotes(rollCall([{ nameText: "存在 しない", group: "公明党" }]), [member("m_000001", "青木 一彦", "自民")]);
    assert.equal(rc.votes[0].memberId, "");
    assert.deepEqual(unmatched, [{ nameText: "存在 しない", group: "公明党", rollCallId: "221-0605-v001" }]);
  });

  test("氏名で1人に絞れるなら会派表記が名簿と異なっても一致するが、groupMismatch に載せて可視化する（採決後の会派改称）", () => {
    const members = [member("m_000005", "木村 英子", "い党")];
    const { rollCall: rc, unmatched, groupMismatch } = matchVotes(rollCall([{ nameText: "木村 英子", group: "れいわ新選組" }]), members);
    assert.equal(rc.votes[0].memberId, "m_000005");
    assert.deepEqual(unmatched, []);
    assert.deepEqual(groupMismatch, [
      { nameText: "木村 英子", group: "れいわ新選組", memberId: "m_000005", rosterGroup: "い党", rollCallId: "221-0605-v001" },
    ]);
  });

  test("候補1人で会派が一致（略称/正式名称）すれば groupMismatch は空", () => {
    const members = [member("m_000001", "青木 一彦", "自民")];
    const { groupMismatch } = matchVotes(rollCall([{ nameText: "青木 一彦", group: "自由民主党・無所属の会" }]), members);
    assert.deepEqual(groupMismatch, []);
  });

  test("votes が空なら unmatched・groupMismatch とも空", () => {
    const { rollCall: rc, unmatched, groupMismatch } = matchVotes(rollCall([]), [member("m_000001", "青木 一彦", "自民")]);
    assert.deepEqual(rc.votes, []);
    assert.deepEqual(unmatched, []);
    assert.deepEqual(groupMismatch, []);
  });

  test("1採決内で同じ memberId が2回出たら例外", () => {
    const members = [member("m_000001", "青木 一彦", "自民")];
    assert.throws(
      () => matchVotes(rollCall([
        { nameText: "青木 一彦", group: "自由民主党・無所属の会" },
        { nameText: "青木　一彦", group: "自由民主党・無所属の会" },
      ]), members),
      /m_000001/,
    );
  });
});

describe("実データ: 第221回の名簿と投票結果", () => {
  const members = parseMemberList(fixture("sangiin-giin-221"), "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/221/giin.htm", 221);
  for (const id of ["221-0605-v001", "221-0724-v001"]) {
    test(`${id}: 未突合 0 件、全票に memberId が入る`, () => {
      const rc = parseRollCall(fixture(id), `${BASE}/${id}.htm`, 221);
      const { rollCall: matched, unmatched, groupMismatch } = matchVotes(rc, members);
      assert.deepEqual(unmatched, []);
      // 第221回で会派不一致になりうるのは れいわ新選組 → いのちの党 の改称分のみ
      assert.ok(groupMismatch.every((g) => g.group === "れいわ新選組" && g.rosterGroup === "いのちの党"), JSON.stringify(groupMismatch));
      assert.ok(matched.votes.every((v) => v.memberId !== ""));
      assert.equal(new Set(matched.votes.map((v) => v.memberId)).size, matched.votes.length);
    });
  }
});
