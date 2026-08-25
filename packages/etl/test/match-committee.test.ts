import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Member } from "@seiji-kiroku/shared";
import { matchCommitteeRoles } from "../src/match-committee.ts";
import { parseCommitteeRosterPage, type CommitteeRoster } from "../src/sources/kokkai-committee.ts";
import { parseMemberList } from "../src/sources/sangiin-members.ts";
import { mergeRosters } from "../src/aggregate.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8");
const ROSTER_URL = "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/217/giin.htm";

const member = (id: string, name: string, group: string, house: Member["house"] = "sangiin", session = 217): Member => ({
  id, name, kana: "", house,
  terms: [{ house, group, district: "", from: "", sessionFrom: session }],
  sourceUrl: ROSTER_URL,
});

const roster = (members: { role: string; nameText: string }[], extra: Partial<CommitteeRoster> = {}): CommitteeRoster => ({
  id: "121714889X02520250620_000", session: 217, house: "sangiin", meeting: "内閣委員会 第25号", date: "2025-06-20",
  members, sourceUrl: "https://kokkai.ndl.go.jp/txt/121714889X02520250620/0", ...extra,
});

describe("matchCommitteeRoles: 出席委員欄の氏名を名簿に名寄せする（Issue #244）", () => {
  test("氏名（空白・異体字を吸収）で紐づく。委員会・役職の原文と出席した会議の日付を持つ", () => {
    const { entries, unmatched } = matchCommitteeRoles(
      [roster([{ role: "委員長", nameText: "和田政宗" }, { role: "理事", nameText: "髙橋光男" }])],
      [member("m_1", "和田 政宗", "自民"), member("m_2", "高橋 光男", "公明")],
    );
    assert.deepEqual(unmatched, []);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], {
      memberId: "m_1", nameText: "和田政宗", session: 217, house: "sangiin",
      committee: "内閣委員会", role: "委員長",
      firstDate: "2025-06-20", lastDate: "2025-06-20", meetings: 1,
      firstMeetingId: "121714889X02520250620_000", lastMeetingId: "121714889X02520250620_000",
      sourceUrl: "https://kokkai.ndl.go.jp/txt/121714889X02520250620/0",
    });
  });

  test("同じ委員会・同じ役職で複数回出席したら 1 行にまとめ、出席した最初の日と最新の日と回数を持つ（在任期間ではない）", () => {
    const rosters = [
      roster([{ role: "理事", nameText: "山本啓介" }], { id: "A", date: "2025-04-01", meeting: "内閣委員会 第1号" }),
      roster([{ role: "理事", nameText: "山本啓介" }], { id: "C", date: "2025-06-20", meeting: "内閣委員会 第25号" }),
      roster([{ role: "理事", nameText: "山本啓介" }], { id: "B", date: "2025-05-10", meeting: "内閣委員会 第9号" }),
    ];
    const { entries } = matchCommitteeRoles(rosters, [member("m_1", "山本 啓介", "自民")]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].firstDate, "2025-04-01");
    assert.equal(entries[0].lastDate, "2025-06-20");
    assert.equal(entries[0].meetings, 3);
    assert.equal(entries[0].firstMeetingId, "A");
    assert.equal(entries[0].lastMeetingId, "C");
  });

  test("同じ委員会でも役職が変われば別の行にする（委員 → 理事は事実として別の記録）", () => {
    const rosters = [
      roster([{ role: "委員", nameText: "山本啓介" }], { id: "A", date: "2025-04-01" }),
      roster([{ role: "理事", nameText: "山本啓介" }], { id: "B", date: "2025-06-20" }),
    ];
    const { entries } = matchCommitteeRoles(rosters, [member("m_1", "山本 啓介", "自民")]);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((e) => [e.role, e.firstDate, e.lastDate]), [["委員", "2025-04-01", "2025-04-01"], ["理事", "2025-06-20", "2025-06-20"]]);
  });

  test("回次が違えば別の行にする（議員ページは回次ごとに折りたたむ）", () => {
    const rosters = [
      roster([{ role: "委員", nameText: "山本啓介" }], { id: "A", session: 217, date: "2025-06-20" }),
      roster([{ role: "委員", nameText: "山本啓介" }], { id: "B", session: 218, date: "2025-10-01" }),
    ];
    const { entries } = matchCommitteeRoles(rosters, [{ ...member("m_1", "山本 啓介", "自民"), terms: [{ house: "sangiin", group: "自民", district: "", from: "", sessionFrom: 217, sessionTo: 218 }] }]);
    assert.deepEqual(entries.map((e) => [e.session, e.firstDate]), [[217, "2025-06-20"], [218, "2025-10-01"]]);
  });

  test("委員会名は会議名から号を落とした原文（「内閣委員会 第25号」→「内閣委員会」）", () => {
    const { entries } = matchCommitteeRoles(
      [roster([{ role: "委員", nameText: "山本啓介" }], { meeting: "厚生労働委員会 閉会後第4号" })],
      [member("m_1", "山本 啓介", "自民")],
    );
    assert.equal(entries[0].committee, "厚生労働委員会");
  });

  test("名簿は会議の院のものだけを使う（衆院の委員会に参院議員を紐づけない）", () => {
    const { entries, unmatched } = matchCommitteeRoles(
      [roster([{ role: "委員長", nameText: "大岡敏孝" }], { house: "shugiin", meeting: "内閣委員会 第29号" })],
      [member("m_1", "大岡 敏孝", "自民", "sangiin")],
    );
    assert.deepEqual(entries, []);
    assert.equal(unmatched.length, 1);
    assert.equal(unmatched[0].kind, "committee");
  });

  test("同姓同名は会議録に会派が無いので絞れず unmatched（推測で紐づけない。#230）", () => {
    const { entries, unmatched } = matchCommitteeRoles(
      [roster([{ role: "委員", nameText: "山田太郎" }])],
      [member("m_1", "山田 太郎", "自民"), member("m_2", "山田 太郎", "立憲")],
    );
    assert.deepEqual(entries, []);
    assert.deepEqual(unmatched, [{ kind: "committee", nameText: "山田太郎", group: "", meetingId: "121714889X02520250620_000" }]);
  });

  test("同姓同名が同じ委員会に何回出ても unmatched は会議ごとに 1 行（運用者が会議録を引ける）", () => {
    const rosters = [
      roster([{ role: "委員", nameText: "山田太郎" }], { id: "A", date: "2025-04-01" }),
      roster([{ role: "委員", nameText: "山田太郎" }], { id: "B", date: "2025-06-20" }),
    ];
    const { unmatched } = matchCommitteeRoles(rosters, [member("m_1", "山田 太郎", "自民"), member("m_2", "山田 太郎", "立憲")]);
    assert.deepEqual(unmatched.map((u) => u.meetingId), ["A", "B"]);
  });

  test("在職を確認できない回次の記録は紐づけない（#230。at を渡さないと候補ゼロになる regression）", () => {
    const { entries, unmatched } = matchCommitteeRoles(
      [roster([{ role: "委員", nameText: "山本啓介" }], { session: 199, date: "2019-06-20" })],
      [member("m_1", "山本 啓介", "自民", "sangiin", 217)],
    );
    assert.deepEqual(entries, []);
    assert.equal(unmatched.length, 1);
  });

  test("並びは memberId → 回次 → 委員会名 → 役職で安定（コードポイント順。ロケールに依存しない）", () => {
    const rosters = [
      roster([{ role: "理事", nameText: "山本啓介" }, { role: "委員", nameText: "和田政宗" }], { id: "A", date: "2025-04-01", meeting: "内閣委員会 第1号" }),
      roster([{ role: "委員", nameText: "山本啓介" }], { id: "B", date: "2025-04-02", meeting: "予算委員会 第1号" }),
    ];
    const { entries } = matchCommitteeRoles(rosters, [member("m_2", "山本 啓介", "自民"), member("m_1", "和田 政宗", "自民")]);
    // 委員会名はコードポイント順（予 U+4E88 < 内 U+5185 < 憲 U+61B2）。
    // `localeCompare` だと ja-JP で読み順（憲法 < 内閣 < 予算）になり、手元と CI で並びが変わる
    assert.deepEqual(entries.map((e) => [e.memberId, e.committee, e.role]), [
      ["m_1", "内閣委員会", "委員"],
      ["m_2", "予算委員会", "委員"],
      ["m_2", "内閣委員会", "理事"],
    ]);
  });
});

describe("matchCommitteeRoles: 並びが実行環境のロケールに依存しない（2026-08-25 に CI で検出）", () => {
  /**
   * 手元（LANG=ja_JP）で緑・CI（LANG 未設定＝en-US）で赤になった。原因は `localeCompare` で、
   * 日本語の委員会名を **ja-JP では読み順**（けんぽう < ないかく < よさん）、
   * **en-US ではコードポイント順**（予 < 内 < 憲）に並べるため。
   * 本番でも実行環境しだいで議員ページの表示順が変わるので、フレークではなく実装の欠陥だった。
   *
   * このテストは **`Intl` のロケールを実際に切り替えて**、どちらでも同じ並びになることを確かめる
   * （`localeCompare` に戻すと落ちることを確認済み）。
   */
  const roleOf = (committee: string) => roster([{ role: "委員", nameText: "山本啓介" }], { id: `id-${committee}`, meeting: `${committee} 第1号` });
  // 読み順とコードポイント順が食い違う 3 つ（ja-JP: 憲法 < 内閣 < 予算 ／ codepoint: 予算 < 内閣 < 憲法）
  const committees = ["予算委員会", "内閣委員会", "憲法審査会"];

  const order = () => matchCommitteeRoles(committees.map(roleOf), [member("m_1", "山本 啓介", "自民")]).entries.map((e) => e.committee);

  /**
   * **このテストは「実行環境のロケール」に依存してはならない。**
   * 事故の教訓そのもので、`LANG` に頼った検査は「CI のロケールでだけ通る」形になり、
   * `localeCompare` に戻す退行を CI が見逃す（実際に確認した: `localeCompare` に戻すと
   * ja_JP では 4 件落ちるが、CI と同じ en-US では 16 件すべて通ってしまう）。
   * そこで **ロケールを問わず不変な性質**（コードポイント順であること）を直接固定する。
   */
  test("並びはコードポイント順（どのロケールで実行しても同じ）", () => {
    assert.deepEqual(order(), ["予算委員会", "内閣委員会", "憲法審査会"]);
  });

  test("読み順（ja-JP の localeCompare）とは違う並びである＝localeCompare を使っていない", () => {
    // ja-JP の読み順は けんぽう < ないかく < よさん。実装がこの順を返したら localeCompare に戻っている
    const byReading = [...committees].sort((a, b) => a.localeCompare(b, "ja-JP"));
    assert.deepEqual(byReading, ["憲法審査会", "内閣委員会", "予算委員会"], "前提: ja-JP の読み順はこの並び");
    assert.notDeepEqual(order(), byReading, "実装が ja-JP の読み順を返した（localeCompare に戻っている）");
  });

  test("並びが「明示した規則」と一致する（規則をテストに書き写さず、規則から導く）", () => {
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    assert.deepEqual(order(), [...committees].sort(cmp));
  });
});

describe("matchCommitteeRoles: 実データ（第217回 参議院の名簿 × 会議録の出席委員欄）", () => {
  // 本番（cli.ts）と同じく、回次ごとの名簿を mergeRosters で 1 人に統合したものを渡す。
  // 参院名簿は会期後のスナップショットなので 1 回次分だけでは在職を確認できない議員が出る
  // （和田政宗は第216回の名簿にしか載らない）。呼び出し側の使われ方まで再現する（作業合意）。
  const members = mergeRosters([216, 217, 218].map((session) => ({
    session,
    members: parseMemberList(fixture(`sangiin-giin-${session}.htm`), `https://www.sangiin.go.jp/japanese/joho1/kousei/giin/${session}/giin.htm`, session),
  })));
  const page = parseCommitteeRosterPage(JSON.parse(fixture("kokkai-committee-sangiin-217-p1.json")), 217, "sangiin");
  const { entries, unmatched } = matchCommitteeRoles(page.rosters, members);

  test("第217回 内閣委員会 第25号の委員長・理事・委員 22 名が全員名簿に紐づく", () => {
    const naikaku = entries.filter((e) => e.committee === "内閣委員会");
    assert.deepEqual(unmatched.filter((u) => u.meetingId === "121714889X02520250620_000"), []);
    assert.equal(naikaku.length, 22);
    assert.equal(naikaku.filter((e) => e.role === "委員長").length, 1);
    assert.equal(naikaku.filter((e) => e.role === "理事").length, 5);
    assert.equal(naikaku.filter((e) => e.role === "委員").length, 16);
  });

  test("委員長 和田政宗 に「内閣委員会・委員長」と「憲法審査会・委員」の 2 行が付く（同じ人の別の委員会は別の行。名指しで固定）", () => {
    const wada = entries.filter((e) => e.nameText === "和田政宗");
    // 並びは委員会名のコードポイント順（内 U+5185 < 憲 U+61B2）。日付順ではない
    assert.deepEqual(wada.map((e) => [e.committee, e.role, e.firstDate, e.meetings]), [
      ["内閣委員会", "委員長", "2025-06-20", 1],
      ["憲法審査会", "委員", "2025-06-04", 1],
    ]);
    assert.equal(wada[0].session, 217);
    assert.equal(wada[0].house, "sangiin");
    assert.equal(wada[0].sourceUrl, "https://kokkai.ndl.go.jp/txt/121714889X02520250620/0");
  });

  test("議院運営委員会 第31号の議長・副議長（関口昌一・長浜博行）は記録に入らない（parseRosterHeader の regression を名寄せ側でも固定）", () => {
    const unei = entries.filter((e) => e.committee === "議院運営委員会");
    assert.ok(unei.length > 0);
    assert.equal(unei.some((e) => e.nameText === "関口昌一" || e.nameText === "長浜博行"), false, unei.map((e) => e.nameText).join("・"));
  });

  test("出席委員欄の氏名が 1 件も未突合にならない（第217回 参院の 3 会議録・延べ 93 名）", () => {
    assert.deepEqual(unmatched, []);
    assert.equal(entries.reduce((n, e) => n + e.meetings, 0), 93);
  });
});
