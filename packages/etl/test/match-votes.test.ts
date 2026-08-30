import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Member, MemberTerm, RollCall } from "@seiji-kiroku/shared";
import { indexByName, matchVotes, normalizeName, resolveMember } from "../src/match-votes.ts";
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
      { nameText: "木村 英子", voteGroup: "れいわ新選組", memberId: "m_000005", rosterGroup: "い党", rollCallId: "221-0605-v001" },
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
      assert.ok(groupMismatch.every((g) => g.voteGroup === "れいわ新選組" && g.rosterGroup === "いのちの党"), JSON.stringify(groupMismatch));
      assert.ok(matched.votes.every((v) => v.memberId !== ""));
      assert.equal(new Set(matched.votes.map((v) => v.memberId)).size, matched.votes.length);
    });
  }
});

describe("matchVotes: 氏名＋採決時点の会派（groupAt）のマトリクス（Issue #24）", () => {
  const t = (group: string, sessionFrom: number, sessionTo = sessionFrom): MemberTerm => ({ house: "sangiin", group, district: "", from: "", sessionFrom, sessionTo });
  const withTerms = (id: string, name: string, terms: MemberTerm[]) => member(id, name, "", { terms });
  const vote = (nameText: string, group: string) => ({ nameText, group });
  type Case = { label: string; members: Member[]; vote: { nameText: string; group: string }; memberId: string; unmatched: boolean; mismatch?: string };
  const cases: Case[] = [
    { label: "一意な氏名・採決回次の会派が一致 → 一致、mismatch なし",
      members: [withTerms("m_1", "木村 英子", [t("いのちの党", 221), t("れいわ新選組", 217, 220)])],
      vote: vote("木村 英子", "いのちの党"), memberId: "m_1", unmatched: false },
    { label: "一意な氏名・採決回次の会派とは違うが別の回次の名簿と一致 → 一致、mismatch なし（第221回の れいわ新選組 票）",
      members: [withTerms("m_1", "木村 英子", [t("いのちの党", 221), t("れいわ新選組", 217, 220)])],
      vote: vote("木村 英子", "れいわ新選組"), memberId: "m_1", unmatched: false },
    { label: "一意な氏名・どの回次の会派とも違う → 氏名で一致させ、group-mismatch に採決回次の会派を記録",
      members: [withTerms("m_1", "木村 英子", [t("いのちの党", 221), t("れいわ新選組", 217, 220)])],
      vote: vote("木村 英子", "日本共産党"), memberId: "m_1", unmatched: false, mismatch: "いのちの党" },
    { label: "一意な氏名・名簿が後の回次にしかない → 未突合（在職を確認できない。#230）",
      members: [withTerms("m_1", "木村 英子", [t("いのちの党", 223), t("れいわ新選組", 222)])],
      vote: vote("木村 英子", "日本共産党"), memberId: "", unmatched: true },
    { label: "同姓同名・採決回次の会派で1人に絞れる → 一致",
      members: [withTerms("m_1", "鈴木 一郎", [t("自由民主党・無所属の会", 221)]), withTerms("m_2", "鈴木 一郎", [t("立憲民主・無所属", 221)])],
      vote: vote("鈴木 一郎", "立憲民主・無所属"), memberId: "m_2", unmatched: false },
    { label: "同姓同名・採決回次の会派は名簿の略称/旧称でも一致（自由民主党 ← 自民）",
      members: [withTerms("m_1", "鈴木 一郎", [t("自民", 221)]), withTerms("m_2", "鈴木 一郎", [t("立憲", 221)])],
      vote: vote("鈴木 一郎", "自由民主党"), memberId: "m_1", unmatched: false },
    { label: "同姓同名・片方は採決回次より後の名簿にしか無い（在職未確認）→ 覆っている側に一致",
      members: [withTerms("m_1", "鈴木 一郎", [t("立憲民主・無所属", 222)]), withTerms("m_2", "鈴木 一郎", [t("立憲民主・無所属", 219, 221)])],
      vote: vote("鈴木 一郎", "立憲民主・無所属"), memberId: "m_2", unmatched: false },
    { label: "同姓同名・採決回次の会派が両方に一致 → 未突合",
      members: [withTerms("m_1", "鈴木 一郎", [t("自由民主党・無所属の会", 221)]), withTerms("m_2", "鈴木 一郎", [t("自由民主党・無所属の会", 221)])],
      vote: vote("鈴木 一郎", "自由民主党・無所属の会"), memberId: "", unmatched: true },
    { label: "同姓同名・採決回次の会派がどちらにも一致しない → 未突合（別の回次の会派で推定しない）",
      members: [withTerms("m_1", "鈴木 一郎", [t("自由民主党・無所属の会", 221), t("公明党", 217, 220)]), withTerms("m_2", "鈴木 一郎", [t("立憲民主・無所属", 221)])],
      vote: vote("鈴木 一郎", "公明党"), memberId: "", unmatched: true },
  ];
  for (const c of cases) {
    test(c.label, () => {
      const { rollCall: rc, unmatched, groupMismatch } = matchVotes(rollCall([c.vote]), c.members);
      assert.equal(rc.votes[0].memberId, c.memberId);
      assert.equal(unmatched.length, c.unmatched ? 1 : 0);
      assert.deepEqual(groupMismatch, c.mismatch === undefined ? [] : [
        { memberId: c.memberId, nameText: c.vote.nameText, voteGroup: c.vote.group, rosterGroup: c.mismatch, rollCallId: "221-0605-v001" },
      ]);
    });
  }
});

describe("在職を確認できない氏名一致は紐づけない（#230）", () => {
  const t = (group: string, sessionFrom: number, sessionTo?: number, to?: string): MemberTerm =>
    ({ house: "sangiin", group, district: "", from: "", sessionFrom, ...(sessionTo === undefined ? {} : { sessionTo }), ...(to === undefined ? {} : { to }) });
  const withTerms = (id: string, name: string, terms: MemberTerm[]) => member(id, name, "", { terms });
  const rc221 = (nameText: string, group: string) => rollCall([{ nameText, group }]);

  test("(a) その回次を名簿が覆っている → 紐づく", () => {
    const members = [withTerms("m_1", "青木 一彦", [t("自由民主党・無所属の会", 216, 221)])];
    const { rollCall: rc } = matchVotes(rc221("青木 一彦", "自由民主党・無所属の会"), members);
    assert.equal(rc.votes[0].memberId, "m_1");
  });

  test("(b) 前の回次の名簿に載り、任期満了日が採決日以後 → 紐づく（会期中に名簿から消えた議員）", () => {
    // 第216回の名簿にいて任期満了 2026-07-28。第221回（2026-06-05）の採決の時点では任期内。
    const members = [withTerms("m_1", "山東 昭子", [t("自由民主党・無所属の会", 216, 216, "2026-07-28")])];
    const { rollCall: rc, unmatched } = matchVotes(rc221("山東 昭子", "自由民主党・無所属の会"), members);
    assert.equal(rc.votes[0].memberId, "m_1");
    assert.deepEqual(unmatched, []);
  });

  test("前の回次の名簿に載るが任期満了日が採決日より前 → 紐づけない（任期が切れている）", () => {
    const members = [withTerms("m_1", "山東 昭子", [t("自由民主党・無所属の会", 216, 216, "2026-01-31")])];
    const { rollCall: rc, unmatched } = matchVotes(rc221("山東 昭子", "自由民主党・無所属の会"), members);
    assert.equal(rc.votes[0].memberId, "");
    assert.equal(unmatched.length, 1);
  });

  test("名簿が後の回次にしか無い（採決より後に初当選）→ 紐づけない（在職を確認できない）", () => {
    const members = [withTerms("m_1", "鈴木 一郎", [t("自由民主党・無所属の会", 222, 223, "2032-07-25")])];
    const { rollCall: rc, unmatched } = matchVotes(rc221("鈴木 一郎", "自由民主党・無所属の会"), members);
    assert.equal(rc.votes[0].memberId, "");
    assert.equal(unmatched.length, 1);
  });

  test("任期満了日が名簿に無い過去の回次の票 → 紐づけない（推定しない）", () => {
    const members = [withTerms("m_1", "鈴木 一郎", [t("自由民主党・無所属の会", 222, 223)])];
    const { rollCall: rc } = matchVotes(rc221("鈴木 一郎", "自由民主党・無所属の会"), members);
    assert.equal(rc.votes[0].memberId, "");
  });

  test("紐づかなかった票は氏名と会派を事実として unmatched に残す（記録を失わない）", () => {
    const members = [withTerms("m_1", "鈴木 一郎", [t("自由民主党・無所属の会", 222)])];
    const { unmatched } = matchVotes(rc221("鈴木 一郎", "民友連"), members);
    assert.deepEqual(unmatched, [{ nameText: "鈴木 一郎", group: "民友連", rollCallId: "221-0605-v001" }]);
  });

  test("在職を確認できない候補は同姓同名の絞り込みからも外れる（会派が一致しても採らない）", () => {
    const members = [
      withTerms("m_1", "鈴木 一郎", [t("自由民主党・無所属の会", 222)]),          // 第221回には在職未確認
      withTerms("m_2", "鈴木 一郎", [t("自由民主党・無所属の会", 216, 221)]),      // 第221回を覆う
    ];
    const { rollCall: rc } = matchVotes(rc221("鈴木 一郎", "自由民主党・無所属の会"), members);
    assert.equal(rc.votes[0].memberId, "m_2");
  });

  // #320: 参院から衆院へ移った議員。参院の名簿の `to`（任期満了日）は**選挙で決まる任期**なので、
  // 途中で辞職して衆院へ移っても残る。そのため (b) が古い参院の行を「在職」と判定し、
  // 衆院の行（(a) で確認できる）と 2 候補になって絞れず、記録が紐づかなくなっていた。
  //
  // (a) は「その回次の議員一覧に載っている」という**直接の記載**、(b) は「前の回次に載っていて任期が残る」
  // という**推論**である。両方が立つときは (a) を採る。在職確認を緩めてはいない（どちらも確認済みの候補）。
  test("院を移った議員は、その回次の名簿に直接載っている側に紐づく（#320）", () => {
    const shugiinTerm: MemberTerm = { house: "shugiin", group: "自由民主党・無所属の会", district: "兵庫8", from: "", sessionFrom: 221 };
    const members = [
      withTerms("h_1", "青山 繁晴", [shugiinTerm]),                                        // (a) 第221回を直接覆う
      withTerms("m_1", "青山 繁晴", [t("自由民主党・無所属の会", 216, 218, "2028-07-25")]), // (b) 任期は残るが名簿は218まで
    ];
    const { rollCall: rc } = matchVotes(rc221("青山 繁晴", "自由民主党・無所属の会"), members);
    assert.equal(rc.votes[0].memberId, "h_1");
  });

  // #320 レビュー: (a) の優先を**会派で絞る前**に置くと、会派の違う別人が正しい候補を押しのける。
  // 会派は名簿に書いてある事実で、(a)/(b) の別より強い手がかりなので、必ず会派を先に見る。
  test("会派が違う同姓同名は、(a) の優先より会派で絞るほうが先（#320 の退行防止）", () => {
    const shugiinTerm: MemberTerm = { house: "shugiin", group: "立憲民主・無所属", district: "", from: "", sessionFrom: 221 };
    const members = [
      withTerms("m_1", "山田 太郎", [t("自由民主党・無所属の会", 216, 220, "2028-07-25")]), // (b) で立つ
      withTerms("h_1", "山田 太郎", [shugiinTerm]),                                          // (a) で立つが会派が違う
    ];
    // (b) 側の会派で照会したら (b) 側に紐づく。(a) を先に効かせると h_1 になってしまう
    assert.equal(matchVotes(rc221("山田 太郎", "自由民主党・無所属の会"), members).rollCall.votes[0].memberId, "m_1");
    assert.equal(matchVotes(rc221("山田 太郎", "立憲民主・無所属"), members).rollCall.votes[0].memberId, "h_1");
  });

  // 同姓同名の**別人**（任期が重なる。実在: 鬼木誠は衆院と参院に別人がいて会派も違う）。
  // どちらも (a) で立つので #320 の優先では絞れず、会派で絞る従来の手順に落ちる。
  test("両方が (a) で立つ同姓同名は、会派で絞る（#320 で変えない）", () => {
    const shugiinTerm: MemberTerm = { house: "shugiin", group: "自由民主党・無所属の会", district: "福岡2", from: "", sessionFrom: 221 };
    const members = [
      withTerms("h_1", "鬼木 誠", [shugiinTerm]),
      withTerms("m_1", "鬼木 誠", [t("立憲民主・無所属", 216, 221)]),
    ];
    assert.equal(matchVotes(rc221("鬼木 誠", "自由民主党・無所属の会"), members).rollCall.votes[0].memberId, "h_1");
    assert.equal(matchVotes(rc221("鬼木 誠", "立憲民主・無所属"), members).rollCall.votes[0].memberId, "m_1");
  });

  // 会派まで同じなら絞れない。推測で紐づけない（#230）。
  test("両方が (a) で立ち会派も同じなら紐づけない（#320 で変えない）", () => {
    const shugiinTerm: MemberTerm = { house: "shugiin", group: "自由民主党・無所属の会", district: "福岡2", from: "", sessionFrom: 221 };
    const members = [
      withTerms("h_1", "鬼木 誠", [shugiinTerm]),
      withTerms("m_1", "鬼木 誠", [t("自由民主党・無所属の会", 216, 221)]),
    ];
    const out = matchVotes(rc221("鬼木 誠", "自由民主党・無所属の会"), members);
    assert.equal(out.rollCall.votes[0].memberId, "");   // 紐づけない
    assert.equal(out.unmatched.length, 1);              // 記録は失わない（unmatched に載る）
  });

  test("回次の分からない呼び出し（議案ページなど）は名簿が覆う回次でしか紐づけない", () => {
    const covered = [withTerms("m_1", "青木 一彦", [t("自由民主党・無所属の会", 216, 221)])];
    const index = indexByName(covered);
    // session を渡さなければ「どの回次の記録か」が分からないので、在職確認のしようがない → 紐づけない
    assert.equal(resolveMember(index, "青木 一彦", undefined)?.id, undefined);
    // 回次を渡せば覆っているか確認できる
    assert.equal(resolveMember(index, "青木 一彦", undefined, { session: 221 })?.id, "m_1");
  });
});
