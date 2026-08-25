import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { committeePageUrl, parseCommitteeRosterPage, parseRosterHeader, parseShugiinLine } from "../src/sources/kokkai-committee.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf-8")) as unknown;

describe("committeePageUrl: 会議録API speech の URL（speaker=会議録情報。委員会の出席委員欄）", () => {
  test("院・回次・speaker=会議録情報・JSON・100件・startRecord。nameOfMeeting は付けない（全会議）", () => {
    const u = new URL(committeePageUrl(217, "shugiin", 101));
    assert.equal(u.origin + u.pathname, "https://kokkai.ndl.go.jp/api/speech");
    assert.equal(u.searchParams.get("nameOfHouse"), "衆議院");
    assert.equal(u.searchParams.get("speaker"), "会議録情報");
    assert.equal(u.searchParams.get("sessionFrom"), "217");
    assert.equal(u.searchParams.get("sessionTo"), "217");
    assert.equal(u.searchParams.get("recordPacking"), "json");
    assert.equal(u.searchParams.get("maximumRecords"), "100");
    assert.equal(u.searchParams.get("startRecord"), "101");
    assert.equal(u.searchParams.get("nameOfMeeting"), null);
    assert.equal(new URL(committeePageUrl(204, "sangiin")).searchParams.get("nameOfHouse"), "参議院");
  });
});

/* ---------------- 衆議院（1行2名の2段組。役職は氏名の前に付く） ---------------- */

describe("parseRosterHeader 衆議院: 第217回 内閣委員会 第29号（2025-06-20）", () => {
  const page = parseCommitteeRosterPage(fixture("kokkai-committee-shugiin-217-p1"), 217, "shugiin");
  const naikaku = page.rosters.find((r) => r.meeting === "内閣委員会 第29号");

  test("会議録情報 1 件が 1 つの名簿になる（本会議は出席委員欄が無いので落ちる）", () => {
    assert.ok(naikaku);
    assert.equal(naikaku.id, "121704889X02920250620_000");
    assert.equal(naikaku.session, 217);
    assert.equal(naikaku.date, "2025-06-20");
    assert.equal(naikaku.house, "shugiin");
    assert.match(naikaku.sourceUrl, /^https:\/\/kokkai\.ndl\.go\.jp\//);
    assert.equal(page.rosters.some((r) => r.meeting === "本会議 第36号"), false);
  });

  test("委員長は 1 名（大岡敏孝）。原文の役職を保持する", () => {
    const chairs = naikaku!.members.filter((m) => m.role === "委員長");
    assert.deepEqual(chairs, [{ role: "委員長", nameText: "大岡敏孝" }]);
  });

  test("理事は 7 名。2段組の行が 1 名ずつに割れる（順序を名指しで固定）", () => {
    const directors = naikaku!.members.filter((m) => m.role === "理事").map((m) => m.nameText);
    assert.deepEqual(directors, ["黄川田仁志", "國場幸之助", "西銘恒三郎", "今井雅人", "本庄知史", "山岸一生", "市村浩一郎"]);
  });

  test("委員（役職見出しの無い行）は 31 名。2段組の左列→右列の順で並ぶ（名指しで固定）", () => {
    const plain = naikaku!.members.filter((m) => m.role === "委員").map((m) => m.nameText);
    assert.equal(plain.length, 31);
    // 「　　　　　　石原　宏高君　　　　井野　俊郎君」＝ 1 行 2 名。左が先、右が次
    assert.equal(plain[0], "石原宏高");
    assert.equal(plain[1], "井野俊郎");
    // 「　　　　　　梅谷　　守君　　　おおたけりえ君」＝ 段組の区切りが全角空白 3 つ、姓名の区切りが 2 つの行
    assert.equal(plain[14], "梅谷守");
    assert.equal(plain[15], "おおたけりえ");
    assert.equal(plain.at(-1), "緒方林太郎");
  });

  test("出席委員欄の外（国務大臣・大臣政務官・専門員・委員の異動）は名簿に入れない", () => {
    const names = naikaku!.members.map((m) => m.nameText);
    // 内閣府大臣政務官として同じ会議録に載る西野太亮・岸信千世は「委員」としても載っているので、
    // 「役職の重複が無い」ことで政務官欄を拾っていないことを示す
    assert.equal(names.filter((n) => n === "西野太亮").length, 1);
    assert.equal(names.filter((n) => n === "岸信千世").length, 1);
    // 内閣委員会専門員（田中仁）と、委員の異動の「辞任 水沼秀幸」は名簿に無い
    assert.equal(names.includes("田中仁"), false);
    assert.equal(names.includes("水沼秀幸"), false);
    assert.equal(naikaku!.members.length, 39);
  });
});

describe("parseRosterHeader 衆議院: 姓名の断片を拾わない（研究 doc が躓いた点）", () => {
  const page = parseCommitteeRosterPage(fixture("kokkai-committee-shugiin-217-p1"), 217, "shugiin");

  test("全角空白で区切られた姓名を 1 名にまとめる（安住　　淳 → 安住淳。「淳」だけを拾わない）", () => {
    const yosan = page.rosters.find((r) => r.meeting === "予算委員会 第26号")!;
    assert.deepEqual(yosan.members.filter((m) => m.role === "委員長"), [{ role: "委員長", nameText: "安住淳" }]);
    const names = yosan.members.map((m) => m.nameText);
    assert.equal(names.includes("淳"), false);
    assert.ok(names.includes("河野太郎"));
  });

  test("役職と氏名の間に空白が無い行も割れる（理事おおつき紅葉君。第217回 総務委員会 第17号）", () => {
    const soumu = page.rosters.find((r) => r.meeting === "総務委員会 第17号")!;
    const directors = soumu.members.filter((m) => m.role === "理事").map((m) => m.nameText);
    assert.ok(directors.includes("おおつき紅葉"), `理事: ${directors.join("・")}`);
    assert.equal(soumu.members.some((m) => m.nameText === "紅葉"), false);
  });
});

describe("parseRosterHeader 衆議院: 第204回（別の回次・別の作り）", () => {
  const page = parseCommitteeRosterPage(fixture("kokkai-committee-shugiin-204-p1"), 204, "shugiin");

  test("「委員長代理理事」という原文の役職も 1 名として割れる（第204回 厚生労働委員会 第12号 橋本岳）", () => {
    const kourou = page.rosters.find((r) => r.meeting === "厚生労働委員会 第12号")!;
    const hashimoto = kourou.members.filter((m) => m.nameText === "橋本岳");
    assert.deepEqual(hashimoto, [{ role: "委員長代理理事", nameText: "橋本岳" }]);
    assert.equal(kourou.members.some((m) => m.role === "委員長"), false);
  });

  test("氏名に「君」を含む議員（畑野君枝）を 2 名に割らない（第204回 科学技術・イノベーション推進特別委員会 第3号）", () => {
    const kagaku = page.rosters.find((r) => r.meeting === "科学技術・イノベーション推進特別委員会 第3号")!;
    const names = kagaku.members.map((m) => m.nameText);
    assert.ok(names.includes("畑野君枝"), names.join("・"));
    assert.equal(names.includes("畑野"), false);
    assert.equal(names.includes("枝"), false);
    // 同じ行の隣（吉田宣弘）も欠けない
    assert.ok(names.includes("吉田宣弘"));
  });
});

/* ---------------- 参議院（1行1名。役職は見出し行） ---------------- */

describe("parseRosterHeader 参議院: 第217回 内閣委員会 第25号（2025-06-20）", () => {
  const page = parseCommitteeRosterPage(fixture("kokkai-committee-sangiin-217-p1"), 217, "sangiin");
  const naikaku = page.rosters.find((r) => r.meeting === "内閣委員会 第25号")!;

  test("委員長は行内の役職（和田政宗）", () => {
    assert.deepEqual(naikaku.members.filter((m) => m.role === "委員長"), [{ role: "委員長", nameText: "和田政宗" }]);
  });

  test("「理　事」見出しの下の 5 名（順序を名指しで固定）", () => {
    assert.deepEqual(naikaku.members.filter((m) => m.role === "理事").map((m) => m.nameText),
      ["磯崎仁彦", "酒井庸行", "山本啓介", "木戸口英司", "竹谷とし子"]);
  });

  test("「委　員」見出しの下の 16 名（先頭・末尾を名指しで固定）", () => {
    const plain = naikaku.members.filter((m) => m.role === "委員").map((m) => m.nameText);
    assert.equal(plain.length, 16);
    assert.equal(plain[0], "青木一彦");
    assert.equal(plain.at(-1), "大島九州男");
  });

  test("事務局側（常任委員会専門員 岩波祐子）と「委員の異動」（臼井正一）は名簿に入れない", () => {
    const names = naikaku.members.map((m) => m.nameText);
    assert.equal(names.includes("岩波祐子"), false);
    assert.equal(names.includes("臼井正一"), false);
    assert.equal(naikaku.members.length, 22);
  });

  test("「委　員」の並びの後に区切りを挟んで続く議長・副議長は委員に入れない（議院運営委員会 第31号。関口昌一・長浜博行）", () => {
    const unei = page.rosters.find((r) => r.meeting === "議院運営委員会 第31号")!;
    const names = unei.members.map((m) => m.nameText);
    // 出席者欄には「　　　　　　　議長　　　　　　　関口　昌一君」がインデント 7 で載る（委員はインデント 15 以上）
    assert.equal(names.includes("関口昌一"), false, names.join("・"));
    assert.equal(names.includes("長浜博行"), false);
    assert.equal(names.some((n) => n.startsWith("議長") || n.startsWith("副議長")), false);
    // 委員長・理事・委員自体は取れている
    assert.equal(unei.members.filter((m) => m.role === "委員長").length, 1);
    assert.ok(unei.members.filter((m) => m.role === "理事").length >= 1);
  });

  test("憲法審査会は「会　長」「幹　事」という原文の役職（第217回 第5号）", () => {
    const kenpou = page.rosters.find((r) => r.meeting === "憲法審査会 第5号")!;
    assert.equal(kenpou.members.filter((m) => m.role === "会長").length, 1);
    assert.ok(kenpou.members.filter((m) => m.role === "幹事").length >= 1);
  });
});

describe("parseRosterHeader 参議院: 第204回（別の回次・別の作り）", () => {
  const page = parseCommitteeRosterPage(fixture("kokkai-committee-sangiin-204-p1"), 204, "sangiin");

  test("インデント 16 に収まらない長い氏名（インデント 15）も委員として拾う（三原じゅん子。厚生労働委員会 閉会後第4号）", () => {
    const kourou = page.rosters.find((r) => r.meeting === "厚生労働委員会 閉会後第4号")!;
    assert.deepEqual(kourou.members.filter((m) => m.nameText === "三原じゅん子"), [{ role: "委員", nameText: "三原じゅん子" }]);
  });

  test("委員長・理事・委員が揃う（文教科学委員会 第15号。委員長 太田房江・理事 4 名・委員 15 名）", () => {
    const bunkyo = page.rosters.find((r) => r.meeting === "文教科学委員会 第15号")!;
    assert.deepEqual(bunkyo.members.filter((m) => m.role === "委員長"), [{ role: "委員長", nameText: "太田房江" }]);
    assert.deepEqual(bunkyo.members.filter((m) => m.role === "理事").map((m) => m.nameText), ["赤池誠章", "上野通子", "吉川ゆうみ", "斎藤嘉隆"]);
    assert.equal(bunkyo.members.filter((m) => m.role === "委員").length, 15);
  });

  test("調査会も会長・理事の役職が付く（国際経済・外交に関する調査会 第8号）", () => {
    const chosa = page.rosters.find((r) => r.meeting === "国際経済・外交に関する調査会 第8号")!;
    assert.equal(chosa.members.filter((m) => m.role === "会長").length, 1);
    assert.ok(chosa.members.length > 10);
  });
});

/* ---------------- 本会議・審査会（#243 の調査 PR #278 が見つけた 2 つの罠） ---------------- */

describe("本会議の会議録情報から委員会の役職を作らない（#243 調査の罠1）", () => {
  const page = parseCommitteeRosterPage(fixture("kokkai-committee-shugiin-221-plenary"), 221, "shugiin");

  test("第221回 衆議院 本会議 第6号（2026-03-13）は名簿を 1 件も作らない（出席委員欄が無い）", () => {
    assert.deepEqual(page.rosters, []);
    assert.equal(page.numberOfRecords, 1);
  });

  test("議事日程・付した案件に出る「予算委員長坂本哲志君解任決議案」から役職を作らない", () => {
    // この本会議を仕切ったのは議長（森英介）で、坂本哲志は解任決議案の対象として案件名に出るだけ。
    // 出席委員欄の外を読むと「本会議の委員長 坂本哲志」という存在しない役職ができる（#243 調査 PR #278）。
    const names = page.rosters.flatMap((r) => r.members.map((m) => m.nameText));
    assert.equal(names.includes("坂本哲志"), false);
    assert.deepEqual(names, []);
  });
});

describe("審査会・調査会の役職は「会長」で、委員長に丸めない（#243 調査の罠2）", () => {
  test("参議院 憲法審査会は 会長・幹事・委員（委員長・理事にしない）", () => {
    const page = parseCommitteeRosterPage(fixture("kokkai-committee-sangiin-217-p1"), 217, "sangiin");
    const kenpou = page.rosters.find((r) => r.meeting === "憲法審査会 第5号")!;
    const roles = [...new Set(kenpou.members.map((m) => m.role))].sort();
    assert.deepEqual(roles, ["会長", "委員", "幹事"].sort());
    assert.equal(kenpou.members.some((m) => m.role === "委員長"), false);
    assert.equal(kenpou.members.some((m) => m.role === "理事"), false);
  });

  test("参議院 調査会は 会長・理事・委員（会長を委員長に丸めない）", () => {
    const page = parseCommitteeRosterPage(fixture("kokkai-committee-sangiin-204-p1"), 204, "sangiin");
    const chosa = page.rosters.find((r) => r.meeting === "国際経済・外交に関する調査会 第8号")!;
    assert.equal(chosa.members.filter((m) => m.role === "会長").length, 1);
    assert.equal(chosa.members.some((m) => m.role === "委員長"), false);
  });
});

describe("parseShugiinLine: 役職の剥がし方（INLINE_ROLES のホワイトリスト）", () => {
  test("役職と氏名の間に空白があってもなくても同じ 1 名になる", () => {
    assert.deepEqual(parseShugiinLine("　　　理事　おおつき紅葉君"), [{ role: "理事", nameText: "おおつき紅葉" }]);
    assert.deepEqual(parseShugiinLine("　　　理事おおつき紅葉君"), [{ role: "理事", nameText: "おおつき紅葉" }]);
  });

  test("役職を剥がした結果が空にならない（役職だけの行は例外にする。氏名を捏造しない）", () => {
    assert.throws(() => parseShugiinLine("　　　理事　君"), /氏名がありません/);
  });

  test("「君」で終わらない行は例外（黙って空を返さない）", () => {
    assert.throws(() => parseShugiinLine("　　　理事　黄川田仁志"), /「君」で終わらない/);
  });

  test("役職の無い行は「委員」になる（衆院の出席委員欄は委員の役職欄が空）", () => {
    assert.deepEqual(parseShugiinLine("　　　　　　石原　宏高君　　　　井野　俊郎君"), [
      { role: "委員", nameText: "石原宏高" },
      { role: "委員", nameText: "井野俊郎" },
    ]);
  });
});

describe("parseRosterHeader: 出席委員欄が無い本文は空を返す（例外にしない）", () => {
  test("本会議の会議録情報（議事日程だけ）は 0 名", () => {
    assert.deepEqual(parseRosterHeader("令和七年六月二十日（金曜日）\n○本日の会議に付した案件\n　閉会中審査に関する件\n", "shugiin"), []);
    assert.deepEqual(parseRosterHeader("", "sangiin"), []);
  });
});
