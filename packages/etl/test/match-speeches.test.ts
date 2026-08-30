import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Member, Speech } from "@seiji-kiroku/shared";
import { matchSpeeches, speechRosters } from "../src/match-speeches.ts";
import { parseSpeechPage } from "../src/sources/kokkai-speeches.ts";
import { parseMemberList } from "../src/sources/sangiin-members.ts";
import { normalizeName } from "../src/match-votes.ts";
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
    const { speeches, unmatched } = matchSpeeches([s], [shugiinMember("h_000001", "落合 貴之", "中道改革連合・無所属")]);
    assert.equal(speeches[0].memberId, "h_000001");
    assert.equal(speeches[0].house, "shugiin");
    assert.deepEqual(unmatched, []);
  });

  test("衆院の同姓同名はその回次の名簿の会派で分ける", () => {
    const members = [shugiinMember("h_1", "山田 太郎", "自由民主党・無所属の会"), shugiinMember("h_2", "山田 太郎", "日本維新の会")];
    const s: Speech = { ...speech("h_001", "山田太郎", "日本維新の会"), house: "shugiin" };
    assert.equal(matchSpeeches([s], members).speeches[0].memberId, "h_2");
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

  test("同姓同名は発言の回次に効いている名簿の会派（groupAt）で分離する（Issue #24 / #230）", () => {
    const members = [
      member("m_1", "山田 太郎", "自民", { terms: [{ house: "sangiin", group: "立憲民主・無所属", district: "", from: "", sessionFrom: 221, sessionTo: 221 }, { house: "sangiin", group: "自由民主党・無所属の会", district: "", from: "", sessionFrom: 219, sessionTo: 220 }] }),
      member("m_2", "山田 太郎", "立憲", { terms: [{ house: "sangiin", group: "自由民主党・無所属の会", district: "", from: "", sessionFrom: 221, sessionTo: 221 }] }),
    ];
    const { speeches } = matchSpeeches([speech("a_001", "山田太郎", "立憲民主・無所属")], members);
    assert.equal(speeches[0].memberId, "m_1");
    // 発言そのものの回次（第219回）で引く。m_1 は第219〜220回の名簿で 自由民主党・無所属の会。
    // m_2 は第221回の名簿にしかおらず、第219回の在職を確認できないので候補から外れる（#230）。
    const older = matchSpeeches([{ ...speech("a_001", "山田太郎", "自由民主党・無所属の会"), session: 219, date: "2025-12-01" }], members);
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
  const { speeches, unmatched } = matchSpeeches(page.speeches, members);

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
    const r = matchSpeeches(sangiin.speeches.filter((s) => s.speakerText === "藤川政人"), members);
    assert.equal(r.speeches.length, 1);
    assert.ok(r.speeches.every((s) => !s.memberId));
  });
});

/*
 * Issue #313: 参議院の会議録には**衆院議員の発言も載る**（大臣・副大臣としての答弁、連合審査会など）。逆も同じ。
 * 参院側の発言を参院名簿だけに突合していたため、そこに出た衆院議員が全部落ちていた（`data/unmatched.json` 692 行はすべて参議院の会議録）。
 *
 * 直し方は matchSpeeches の規則を変えることではなく、**呼び出し側が両院の名簿を渡す**ことである。
 * 在職の確認（tenureVerified。#230）も同姓同名の扱いも resolveMember がそのまま効くので、名簿を足しても緩まない:
 *   - 衆院名簿は第221回しか覆っていないので、第217・219回の発言は候補が在職未確認で落ち unmatched に残る
 *   - 両院に同姓同名がいれば（実データで 7 組ある）会派で絞れなければ紐づけない
 */
describe("matchSpeeches: 他院の議員の発言を両院の名簿で突合する（Issue #313）", () => {
  const sangiinMember = (id: string, name: string, group: string, sessionFrom = 216, sessionTo: number | undefined = 221): Member => ({
    id, name, kana: "", house: "sangiin",
    terms: [{ house: "sangiin", group, district: "", from: "", sessionFrom, ...(sessionTo === undefined ? {} : { sessionTo }) }],
    sourceUrl: ROSTER,
  });
  const shugiinMember = (id: string, name: string, group: string): Member => ({
    id, name, kana: "", house: "shugiin",
    terms: [{ house: "shugiin", group, district: "", from: "", sessionFrom: 221 }],
    sourceUrl: "https://www.shugiin.go.jp/internet/itdb_annai.nsf/html/statics/syu/1giin.htm",
  });

  test("参議院の会議録に出た衆院議員（大臣）に、衆院名簿を渡せば h_ の memberId が入る", () => {
    const s = speech("a_001", "赤澤亮正", "自由民主党・無所属の会", "経済産業大臣");
    const both = [sangiinMember("m_1", "青木 一彦", "自民"), shugiinMember("h_1", "赤澤 亮正", "自由民主党・無所属の会")];
    assert.equal(matchSpeeches([s], both).speeches[0].memberId, "h_1");
    // 参院名簿だけなら紐づかない（これが 391 行の欠落。position があるので unmatched にも載らない）
    const sangiinOnly = matchSpeeches([s], [sangiinMember("m_1", "青木 一彦", "自民")]);
    assert.equal(sangiinOnly.speeches[0].memberId, undefined);
    assert.deepEqual(sangiinOnly.unmatched, []);
  });

  test("position の無い衆院議員の発言（連合審査会など）も両院の名簿で紐づき unmatched から消える", () => {
    const s = speech("a_002", "簗和生", "自由民主党・無所属の会");
    const both = [sangiinMember("m_1", "青木 一彦", "自民"), shugiinMember("h_2", "簗 和生", "自由民主党・無所属の会")];
    const r = matchSpeeches([s], both);
    assert.equal(r.speeches[0].memberId, "h_2");
    assert.deepEqual(r.unmatched, []);
    // 参院名簿だけなら unmatched に載る（いまの 692 行の出方）
    assert.deepEqual(matchSpeeches([s], [sangiinMember("m_1", "青木 一彦", "自民")]).unmatched,
      [{ nameText: "簗和生", group: "自由民主党・無所属の会", speechId: "a_002" }]);
  });

  test("衆議院の会議録に出た参院議員（大臣）も、参院名簿を渡せば m_ の memberId が入る（逆向きも要る）", () => {
    const s: Speech = { ...speech("h_003", "片山さつき", "自由民主党・無所属の会", "財務大臣"), house: "shugiin" };
    const both = [shugiinMember("h_1", "赤澤 亮正", "自由民主党・無所属の会"), sangiinMember("m_2", "片山 さつき", "自民")];
    assert.equal(matchSpeeches([s], both).speeches[0].memberId, "m_2");
    assert.equal(matchSpeeches([s], [shugiinMember("h_1", "赤澤 亮正", "自由民主党・無所属の会")]).speeches[0].memberId, undefined);
  });

  test("名簿が覆っていない回次は、両院の名簿を渡しても紐づかない（在職の確認は #230 のまま。第217回の 301 行は増えない）", () => {
    // 衆院名簿は第221回しか覆っていない。第217回の発言は tenureVerified の (a) も (b) も成り立たない
    const s: Speech = { ...speech("a_003", "世耕弘成", "自由民主党・無所属の会"), session: 217, date: "2025-06-17" };
    const both = [sangiinMember("m_1", "青木 一彦", "自民"), shugiinMember("h_3", "世耕 弘成", "自由民主党・無所属の会")];
    const r = matchSpeeches([s], both);
    assert.equal(r.speeches[0].memberId, undefined);
    assert.deepEqual(r.unmatched, [{ nameText: "世耕弘成", group: "自由民主党・無所属の会", speechId: "a_003" }]);
  });

  test("両院に同姓同名がいて会派でも絞れなければ紐づけない（unmatched に残す）", () => {
    const both = [sangiinMember("m_4", "鬼木 誠", "自由民主党・無所属の会"), shugiinMember("h_4", "鬼木 誠", "自由民主党・無所属の会")];
    const r = matchSpeeches([speech("a_004", "鬼木誠", "自由民主党・無所属の会")], both);
    assert.equal(r.speeches[0].memberId, undefined);
    assert.deepEqual(r.unmatched, [{ nameText: "鬼木誠", group: "自由民主党・無所属の会", speechId: "a_004" }]);
  });

  test("両院に同姓同名がいても、その回次に効いている名簿の会派が違えば分けられる", () => {
    const both = [sangiinMember("m_5", "和田 政宗", "自民"), shugiinMember("h_5", "和田 政宗", "日本維新の会")];
    assert.equal(matchSpeeches([speech("a_005", "和田政宗", "日本維新の会")], both).speeches[0].memberId, "h_5");
    assert.equal(matchSpeeches([speech("a_006", "和田政宗", "自由民主党・無所属の会")], both).speeches[0].memberId, "m_5");
  });
});

describe("matchSpeeches: 実データ（第221回 参議院 1ページ目 × 両院の名簿、Issue #313）", () => {
  const sangiin = parseMemberList(fixture("sangiin-giin-221.htm"), ROSTER, 221);
  const shugiin = ROSTER_PAGES.flatMap((p) =>
    parseShugiinMemberList(decodeRosterPage(readFileSync(new URL(`./fixtures/shugiin-giin-20260218-${p}.htm`, import.meta.url))), `https://www.shugiin.go.jp/internet/itdb_annai.nsf/html/statics/syu/${p}giin.htm`, 221));
  const page = parseSpeechPage(JSON.parse(fixture("kokkai-speech-221-p1.json")));

  test("参院名簿だけでは衆院議員の大臣答弁に memberId が入らない（欠落の再現）", () => {
    const { speeches } = matchSpeeches(page.speeches, sangiin);
    const takaichi = speeches.filter((s) => s.speakerText === "高市早苗");
    assert.ok(takaichi.length > 0);
    assert.ok(takaichi.every((s) => !s.memberId));
  });

  test("両院の名簿を渡すと衆院議員の発言に h_ の memberId が入り、参院議員の紐づけは変わらない", () => {
    const before = matchSpeeches(page.speeches, sangiin);
    const after = matchSpeeches(page.speeches, [...sangiin, ...shugiin]);

    // 参院名簿で紐づいていた行は 1 行も変わらない（両院の名簿を足しても既存の紐づけを奪わない）
    const beforeLinked = before.speeches.filter((s) => s.memberId);
    assert.ok(beforeLinked.length > 0);
    for (const s of beforeLinked) assert.equal(after.speeches.find((x) => x.id === s.id)!.memberId, s.memberId, s.id);

    // 増えるのは衆院議員（h_）の行だけ
    const gained = after.speeches.filter((s) => s.memberId && !before.speeches.find((x) => x.id === s.id)!.memberId);
    assert.ok(gained.length > 0);
    assert.ok(gained.every((s) => s.memberId!.startsWith("h_")), gained.map((s) => `${s.speakerText}:${s.memberId}`).join(","));
    assert.ok(gained.some((s) => s.speakerText === "高市早苗"));
    assert.equal(after.speeches.find((s) => s.speakerText === "高市早苗")!.memberId, shugiin.find((m) => m.name === "高市 早苗")!.id);

    // unmatched は増えない
    assert.ok(after.unmatched.length <= before.unmatched.length);
  });

  test("両院の名簿に同姓同名は実在する（この修正が同姓同名を新たに持ち込むことを示す）", () => {
    const dup = sangiin.filter((m) => shugiin.some((h) => normalizeName(h.name) === normalizeName(m.name)));
    assert.ok(dup.length > 0, "参院名簿と衆院名簿に同じ氏名の議員がいる");
    // 会派でも絞れなければ resolveMember は undefined を返す（上のユニットテストで確認済み）
  });

  /*
   * ここが #313 の本体。上のテストは matchSpeeches に何を渡すかを**テスト自身が決めている**ので、
   * cli.ts が片院の名簿に戻っても落ちない（#244 / #308 で「テストが偽の安心を与えた」のと同じ形）。
   * 落ちるようにするため、cli.ts が実際に渡す名簿（speechRosters）を通して同じことを確かめる。
   */
  test("speechRosters が返す名簿で突合すると、衆院議員の発言に h_ が入る（cli.ts が渡すもの）", () => {
    const { speeches } = matchSpeeches(page.speeches, speechRosters(sangiin, shugiin));
    const takaichi = speeches.filter((s) => s.speakerText === "高市早苗");
    assert.ok(takaichi.length > 0);
    assert.ok(takaichi.every((s) => s.memberId === shugiin.find((m) => m.name === "高市 早苗")!.id),
      "speechRosters が衆院名簿を落としている（参院の会議録に出た衆院議員が紐づかない）");
  });

  test("speechRosters は両院の全員を落とさずに並べる", () => {
    const both = speechRosters(sangiin, shugiin);
    assert.equal(both.length, sangiin.length + shugiin.length);
    assert.ok(sangiin.every((m) => both.includes(m)), "参院名簿が落ちている");
    assert.ok(shugiin.every((m) => both.includes(m)), "衆院名簿が落ちている");
  });
});

/*
 * cli.ts は行儀の良い関数ではなく import で走る手続きなので、テストから呼べない。
 * 渡している名簿が片院に戻っていないことは、他の cli.ts のテスト（sessions.test.ts の #236）と同じく原文で押さえる。
 */
describe("cli.ts: 発言の突合には両院の名簿を渡す（Issue #313）", () => {
  const src = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");

  test("参院・衆院どちらの発言も speechRosters が作った名簿に突合している", () => {
    assert.ok(/const speechMembers = speechRosters\(members, shugiin\.members\);/.test(src),
      "両院の名簿を speechRosters で 1 つにしていない");
    const calls = [...src.matchAll(/matchSpeeches\(await fetchSpeeches\([^)]*\), ([A-Za-z.]+)\)/g)].map((m) => m[1]);
    assert.deepEqual(calls, ["speechMembers", "speechMembers"],
      "発言の突合に片院の名簿を渡している（参院の会議録に出た衆院議員が落ちる。#313）");
  });
});
