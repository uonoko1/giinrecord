import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Member, Speech } from "@seiji-kiroku/shared";
import { matchSpeeches } from "../src/match-speeches.ts";
import { parseSpeechPage } from "../src/sources/kokkai-speeches.ts";
import { parseMemberList } from "../src/sources/sangiin-members.ts";
import { decodeRosterPage, parseShugiinMemberList, ROSTER_PAGES } from "../src/sources/shugiin-members.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8");
const ROSTER = "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/221/giin.htm";

const member = (id: string, name: string, group: string, extra: Partial<Member> = {}): Member => ({
  id, name, kana: "", house: "sangiin",
  terms: [{ house: "sangiin", group, district: "", from: "", sessionFrom: 221 }],
  sourceUrl: ROSTER,
  ...extra,
});

const speech = (id: string, speakerText: string, group?: string, position?: string): Speech => ({
  id, session: 221, speakerText, ...(group ? { group } : {}), ...(position ? { position } : {}),
  house: "sangiin", meeting: "本会議 第1号", date: "2026-06-05", excerpt: "本文。", chars: 3,
  sourceUrl: `https://kokkai.ndl.go.jp/txt/${id.split("_")[0]}/${Number(id.split("_")[1])}`,
});

describe("matchSpeeches: 衆院本会議の発言を衆院名簿に突合する（Issue #73）", () => {
  const shugiinMember = (id: string, name: string, group: string): Member => ({
    id, name, kana: "", house: "shugiin",
    terms: [{ house: "shugiin", group, district: "", from: "", sessionFrom: 221 }],
    sourceUrl: "https://www.shugiin.go.jp/internet/itdb_annai.nsf/html/statics/syu/1giin.htm",
  });

  test("衆院名簿（正式名称の会派）に氏名＋会派で紐づき h_ の memberId が入る", () => {
    const s: Speech = { ...speech("h_001", "落合貴之", "中道改革連合・無所属"), house: "shugiin" };
    const { speeches, unmatched } = matchSpeeches([s], [shugiinMember("h_000001", "落合 貴之", "中道改革連合・無所属")], 221);
    assert.equal(speeches[0].memberId, "h_000001");
    assert.equal(speeches[0].house, "shugiin");
    assert.deepEqual(unmatched, []);
  });

  test("衆院の同姓同名はその回次の名簿の会派で分ける", () => {
    const members = [shugiinMember("h_1", "山田 太郎", "自由民主党・無所属の会"), shugiinMember("h_2", "山田 太郎", "日本維新の会")];
    const s: Speech = { ...speech("h_001", "山田太郎", "日本維新の会"), house: "shugiin" };
    assert.equal(matchSpeeches([s], members, 221).speeches[0].memberId, "h_2");
  });
});

describe("matchSpeeches: 発言者名＋会派で名寄せ（matchVotes と同じ正規化）", () => {
  test("API の氏名（空白なし）が名簿の氏名（空白あり）に一致し、memberId が入る", () => {
    const { speeches, unmatched } = matchSpeeches([speech("a_001", "青木一彦", "自由民主党・無所属の会")], [member("m_1", "青木 一彦", "自民")]);
    assert.equal(speeches[0].memberId, "m_1");
    assert.deepEqual(unmatched, []);
  });

  test("入力を変更しない（純粋）", () => {
    const input = [speech("a_001", "青木一彦", "自由民主党・無所属の会")];
    matchSpeeches(input, [member("m_1", "青木 一彦", "自民")]);
    assert.equal(input[0].memberId, undefined);
  });

  test("同姓同名は会派（speakerGroup）で分離する", () => {
    const members = [member("m_1", "山田 太郎", "自民"), member("m_2", "山田 太郎", "立憲")];
    const { speeches } = matchSpeeches([speech("a_001", "山田太郎", "立憲民主・無所属")], members);
    assert.equal(speeches[0].memberId, "m_2");
  });

  test("同姓同名は回次を渡すとその回次に効いている名簿の会派（groupAt）で分離する（Issue #24）", () => {
    const members = [
      member("m_1", "山田 太郎", "自民", { terms: [{ house: "sangiin", group: "立憲民主・無所属", district: "", from: "", sessionFrom: 221, sessionTo: 221 }, { house: "sangiin", group: "自由民主党・無所属の会", district: "", from: "", sessionFrom: 219, sessionTo: 220 }] }),
      member("m_2", "山田 太郎", "立憲", { terms: [{ house: "sangiin", group: "自由民主党・無所属の会", district: "", from: "", sessionFrom: 221, sessionTo: 221 }] }),
    ];
    const { speeches } = matchSpeeches([speech("a_001", "山田太郎", "立憲民主・無所属")], members, 221);
    assert.equal(speeches[0].memberId, "m_1");
    const older = matchSpeeches([speech("a_001", "山田太郎", "自由民主党・無所属の会")], members, 219);
    assert.equal(older.speeches[0].memberId, "m_1");
  });

  test("同姓同名で会派でも絞れなければ memberId なしで unmatched に載せる", () => {
    const members = [member("m_1", "山田 太郎", "自民"), member("m_2", "山田 太郎", "自民")];
    const { speeches, unmatched } = matchSpeeches([speech("a_001", "山田太郎", "自由民主党・無所属の会")], members);
    assert.equal(speeches[0].memberId, undefined);
    assert.deepEqual(unmatched, [{ nameText: "山田太郎", group: "自由民主党・無所属の会", speechId: "a_001" }]);
  });

  test("議長・大臣など position がある発言も名簿にいれば memberId が入り、position は保持する", () => {
    const { speeches } = matchSpeeches([speech("a_001", "関口昌一", "各派に属しない議員", "議長")], [member("m_1", "関口 昌一", "無所属")]);
    assert.equal(speeches[0].memberId, "m_1");
    assert.equal(speeches[0].position, "議長");
  });

  test("名簿にいない政府側（衆院議員の大臣など）は unmatched にしない（参院名簿に無いのが正常）", () => {
    const { speeches, unmatched } = matchSpeeches([speech("a_001", "高市早苗", "自由民主党・無所属の会", "内閣総理大臣")], [member("m_1", "青木 一彦", "自民")]);
    assert.equal(speeches[0].memberId, undefined);
    assert.deepEqual(unmatched, []);
  });

  test("position が無く名簿にもいない発言者は unmatched に載せる（運用者が確認する）", () => {
    const { unmatched } = matchSpeeches([speech("a_001", "存在しない人", "自由民主党・無所属の会")], [member("m_1", "青木 一彦", "自民")]);
    assert.deepEqual(unmatched, [{ nameText: "存在しない人", group: "自由民主党・無所属の会", speechId: "a_001" }]);
  });

  test("会派が無い（null）発言者でも氏名で1人に絞れれば紐づける", () => {
    const { speeches } = matchSpeeches([speech("a_001", "青木一彦")], [member("m_1", "青木 一彦", "自民")]);
    assert.equal(speeches[0].memberId, "m_1");
  });

  test("実データ: 第221回の発言1ページ目で、position の無い発言はすべて名簿に紐づく", () => {
    const members = parseMemberList(fixture("sangiin-giin-221.htm"), ROSTER, 221);
    const page = parseSpeechPage(JSON.parse(fixture("kokkai-speech-221-p1.json")));
    const { speeches, unmatched } = matchSpeeches(page.speeches, members);
    assert.deepEqual(unmatched, []);
    const plain = speeches.filter((s) => !s.position);
    assert.ok(plain.length > 20);
    assert.ok(plain.every((s) => s.memberId));
    assert.equal(speeches.find((s) => s.speakerText === "藤川政人")!.memberId, members.find((m) => m.name === "藤川 政人")!.id);
  });
});

describe("matchSpeeches: 実データ（第221回 衆院本会議 1ページ目 × 衆院名簿 2026-02-18、Issue #107）", () => {
  const members = ROSTER_PAGES.flatMap((p) =>
    parseShugiinMemberList(decodeRosterPage(readFileSync(new URL(`./fixtures/shugiin-giin-20260218-${p}.htm`, import.meta.url))), `https://www.shugiin.go.jp/internet/itdb_annai.nsf/html/statics/syu/${p}giin.htm`, 221));
  const page = parseSpeechPage(JSON.parse(fixture("kokkai-speech-shugiin-221-p1.json")), "shugiin");
  const { speeches, unmatched } = matchSpeeches(page.speeches, members, 221);

  test("position の無い発言はすべて衆院名簿（h_）に紐づき、unmatched は空", () => {
    assert.equal(members.length, 465);
    assert.deepEqual(unmatched, []);
    const plain = speeches.filter((s) => !s.position);
    assert.ok(plain.length > 10);
    assert.ok(plain.every((s) => s.memberId?.startsWith("h_")));
    assert.equal(speeches.find((s) => s.speakerText === "小寺裕雄")!.memberId, members.find((m) => m.name === "小寺 裕雄")!.id);
  });

  test("議長（会議録の会派は「無所属」）も氏名で紐づき、position を保持する", () => {
    const chair = speeches.find((s) => s.id === "122105254X03520260724_001")!;
    assert.equal(chair.position, "議長");
    assert.equal(chair.memberId, members.find((m) => m.name === "森 英介")!.id);
  });

  test("衆院名簿に参院の発言を渡しても紐づかない（院を取り違えない）", () => {
    const sangiin = parseSpeechPage(JSON.parse(fixture("kokkai-speech-221-p1.json")));
    const r = matchSpeeches(sangiin.speeches.filter((s) => s.speakerText === "藤川政人"), members, 221);
    assert.equal(r.speeches.length, 1);
    assert.ok(r.speeches.every((s) => !s.memberId));
  });
});
