import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Member, MemberTerm } from "@seiji-kiroku/shared";
import { mergeRosters } from "../src/aggregate.ts";
import { parseMemberList } from "../src/sources/sangiin-members.ts";
import { parseCommitteeRosterPage } from "../src/sources/kokkai-committee.ts";
import { matchCommitteeRoles } from "../src/match-committee.ts";
import { rosterCoveredSessions, sessionsWithoutRoster, unmatchedMagnitudeExceeded, unmatchedMagnitudeLimit } from "../src/sessions.ts";

const fixture = (name: string, ext = "htm") => readFileSync(new URL(`./fixtures/${name}.${ext}`, import.meta.url), "utf-8");
const rosterUrl = (session: number) => `https://www.sangiin.go.jp/japanese/joho1/kousei/giin/${session}/giin.htm`;

/** 実物の参院名簿（公開されているのは第216回以降だけ。第215回以前の giin/{N}/giin.htm は 404）。 */
const PUBLISHED = [216, 217, 218, 219, 220, 221] as const;
const realRoster = (): Member[] =>
  mergeRosters(PUBLISHED.map((s) => ({ session: s, members: parseMemberList(fixture(`sangiin-giin-${s}`), rosterUrl(s), s) })));

const term = (sessionFrom: number, sessionTo?: number): MemberTerm =>
  ({ house: "sangiin", group: "自由民主党・無所属の会", district: "東京", from: "", to: "2028-07-25", sessionFrom, sessionTo });
const member = (id: string, terms: MemberTerm[]): Member =>
  ({ id, name: "一 郎", kana: "いち ろう", house: "sangiin", terms, sourceUrl: rosterUrl(221) });

/* ------------------------------------------------------------------------------------------------
 * 壊れ方の機序（Issue #1247）。
 *
 * `/coverage` が読む `data/unmatched.json` が 335 行 ⟷ 222,578 行で 6 週間振動していた。
 * **振動していたのは carried の再突合では無い**（実測: 突合済みの発言・委員会の役職の件数は
 * 健全な commit と壊れた commit で第216〜221回の同じ値。第200〜215回は**どちらでも 0 件**）。
 *
 * 機序は「**名簿が覆わない回次を targets に入れた実行**」である。
 * 参院名簿 `giin/{N}/giin.htm` は**第216回以降しか公開されていない**（第215回以前は 404）。
 * 遡り（`pnpm etl 200 … 216`）はその回次を targets に入れるので、`cli.ts` が会議録 API から
 * 発言と委員会名簿を取りに行く。だが `tenureVerified` はその回次の在職を名簿から確認できないので
 * **候補を 1 人も残さない**（#230。正しい振る舞い）。結果、取った氏名が**全件** unmatched に落ちる。
 * 発言（`speechId`）と委員会出席（`meetingId`）は回次を id から引けないので
 * `sessionOfUnmatched` が回次別ファイルに分けられず、**まるごと `unmatched.json` に入る**（#219 の設計どおり）。
 *
 * 衆院側には同じ規則が既に在る（`cli.ts`「過去回次を取っても tenureVerified が候補を落として
 * 全件 unmatched になるだけ。取りに行かない」）。**参院側に回次ごとの判定が無かった**だけである。
 * ---------------------------------------------------------------------------------------------- */

describe("壊れ方の再現（実物の fixture。ネットワークを使わない）", () => {
  test("同じ名簿・同じコードで、第204回は出席者の全件が unmatched になり第217回は全件が突合する", () => {
    const members = realRoster();
    const measure = (session: number, name: string) => {
      const page = parseCommitteeRosterPage(JSON.parse(fixture(name, "json")), session, "sangiin");
      const attendees = page.rosters.reduce((n, r) => n + r.members.length, 0);
      const matched = matchCommitteeRoles(page.rosters, members);
      return { attendees, matched: matched.entries.length, unmatched: matched.unmatched.length };
    };
    // 名簿が覆わない回次（第204回）: 氏名は取れているが 1 件も紐づかない
    assert.deepEqual(measure(204, "kokkai-committee-sangiin-204-p1"), { attendees: 117, matched: 0, unmatched: 117 });
    // 名簿が覆う回次（第217回）: 全件紐づく
    assert.deepEqual(measure(217, "kokkai-committee-sangiin-217-p1"), { attendees: 93, matched: 93, unmatched: 0 });
  });

  test("実物の名簿の term は第216回より前から始まらない（第215回以前を覆う名簿が存在しない）", () => {
    const members = realRoster();
    assert.equal(Math.min(...members.flatMap((m) => m.terms.map((t) => t.sessionFrom))), 216);
  });
});

describe("rosterCoveredSessions: 名簿が在職を確認できる回次", () => {
  test("term の sessionFrom〜sessionTo の範囲を全部返す", () => {
    assert.deepEqual(rosterCoveredSessions([member("m_1", [term(216, 221)])]), [216, 217, 218, 219, 220, 221]);
  });

  test("sessionTo が無い term は sessionFrom の 1 回次だけ（将来の回次を勝手に覆ったことにしない）", () => {
    assert.deepEqual(rosterCoveredSessions([member("m_1", [term(221)])]), [221]);
  });

  test("複数の議員・複数の term の和集合を昇順で返す（重複しない）", () => {
    assert.deepEqual(
      rosterCoveredSessions([member("m_1", [term(216, 217)]), member("m_2", [term(217, 219)]), member("m_3", [term(221)])]),
      [216, 217, 218, 219, 221],
    );
  });

  test("名簿が空なら空（初回実行。『全回次を覆っている』に化けさせない）", () => {
    assert.deepEqual(rosterCoveredSessions([]), []);
  });

  test("実物の名簿では第216〜221回だけを返す（第200〜215回は 1 つも入らない）", () => {
    assert.deepEqual(rosterCoveredSessions(realRoster()), [216, 217, 218, 219, 220, 221]);
  });
});

describe("sessionsWithoutRoster: 取りに行っても全件 unmatched になる回次", () => {
  test("名簿が覆わない targets の回次を返す（遡りの第200〜215回）", () => {
    const targets = [200, 201, 215, 216, 217];
    assert.deepEqual(sessionsWithoutRoster(targets, realRoster()), [200, 201, 215]);
  });

  test("日次実行（既定の直近 5 回次）では 1 つも返さない——この計器は日次を止めない", () => {
    assert.deepEqual(sessionsWithoutRoster([217, 218, 219, 220, 221], realRoster()), []);
  });

  test("名簿が空なら targets を全部返す（名簿が取れていない実行で発言を取りに行かせない）", () => {
    assert.deepEqual(sessionsWithoutRoster([220, 221], []), [220, 221]);
  });

  test("targets が空なら空", () => {
    assert.deepEqual(sessionsWithoutRoster([], realRoster()), []);
  });

  test("回次の順に並べ、重複を畳む", () => {
    assert.deepEqual(sessionsWithoutRoster([215, 200, 215], realRoster()), [200, 215]);
  });
});

describe("unmatchedMagnitudeExceeded: /coverage が読む unmatched.json の桁の検査", () => {
  // `unmatched.ts` の docblock は「件数も小さい」と書いており、回次別に分けないのはそれが前提である。
  // 実測の壊れた値は健全な値の 3 桁ぶん大きい。桁が変わったら止める。
  test("上限を超えた行数では超過を返す", () => {
    assert.equal(unmatchedMagnitudeExceeded(222578), true);
  });

  test("健全な桁（実測の健全な状態と同じ規模）では超過しない", () => {
    assert.equal(unmatchedMagnitudeExceeded(335), false);
    assert.equal(unmatchedMagnitudeExceeded(549), false);
  });

  test("0 件でも超過しない（未突合が無いのは異常ではない）", () => {
    assert.equal(unmatchedMagnitudeExceeded(0), false);
  });

  test("境界: 上限そのものは通し、1 つ超えたら止める", () => {
    const limit = unmatchedMagnitudeLimit();
    assert.equal(unmatchedMagnitudeExceeded(limit), false);
    assert.equal(unmatchedMagnitudeExceeded(limit + 1), true);
  });

  test("上限は健全な実測値より十分上、壊れた実測値より十分下にある（どちらかに寄せた値にしない）", () => {
    const limit = unmatchedMagnitudeLimit();
    assert.ok(limit > 549 * 4, `上限 ${limit} は健全な実測 549 行に近すぎる`);
    assert.ok(limit < 222578 / 4, `上限 ${limit} は壊れた実測 222,578 行に近すぎる`);
  });
});

/* ------------------------------------------------------------------------------------------------
 * 本番 `data/` に対する計測（計器が**壊れた状態で実際に鳴る**ことを示す）。
 *
 * `check-the-metric-moves-when-broken`: **壊れたときに動かない数は計器では無い。**
 * ここで見るのは「`unmatched.json` に入っている行の回次が、名簿が覆う範囲に在るか」である。
 * **健全な状態では覆う範囲しか現れず、壊れた状態では覆わない回次が大量に現れる。**
 *
 * **下限も上限も固定値を置かない**（#1175 が絶対値をやめた理由と同じ）。
 * 見るのは**比率ではなく「覆わない回次の行が在るか」という事実**で、
 * これは名簿（`members/`）と `unmatched.json` の両方から導出する。
 * ---------------------------------------------------------------------------------------------- */

const DATA = fileURLToPath(new URL("../../../data/", import.meta.url));

const readJsonFile = <T>(file: string): T => JSON.parse(readFileSync(file, "utf-8")) as T;

/** 本番 `data/members/` から国会の名簿を組み直す（index.json は terms を持たないので個票を読む）。 */
const publishedDietMembers = (): Member[] => {
  const index = readJsonFile<{ id: string; assemblyId?: string }[]>(join(DATA, "members/index.json"));
  const out: Member[] = [];
  for (const row of index) {
    if (!row.assemblyId?.startsWith("diet-")) continue;
    out.push(readJsonFile<Member>(join(DATA, "members", `${row.id}.json`)));
  }
  return out;
};

describe("本番 data/ の計測: unmatched.json の行が名簿の覆う回次に収まっているか", () => {
  const members = publishedDietMembers();
  const covered = new Set(rosterCoveredSessions(members));
  const rows = readJsonFile<{ speechId?: string; meetingId?: string; session?: number }[]>(join(DATA, "unmatched.json"));

  test("名簿は国会の回次をいくつか覆っている（名簿が読めていない実行をこの検査の緑に化けさせない）", () => {
    // 覆う回次が 0 なら下の検査は全部「覆わない」になって無意味に赤くなる。先に母数が在ることを確かめる。
    assert.ok(covered.size > 0, `名簿が 1 回次も覆っていない（members/ を読めていない）`);
  });

  test("**`unmatched.json` の発言の行に、名簿が覆わない回次が 1 つも無い**", () => {
    // **これが Issue #1247 の壊れた状態で鳴る検査である。**
    // 実測 2026-10-08（`origin/main` = eaff0d40 の時点）: 発言 157,222 行のうち **156,977 行**が
    // 名簿の覆わない回次（第200〜215回）だった。名簿が覆うのは第216回以降だけである。
    const offRoster = rows.filter((r) => r.speechId !== undefined && r.session !== undefined && !covered.has(r.session));
    const sessions = [...new Set(offRoster.map((r) => r.session))].sort((a, b) => (a ?? 0) - (b ?? 0));
    assert.deepEqual(
      { rows: offRoster.length, sessions },
      { rows: 0, sessions: [] },
      `名簿が覆わない回次の発言が unmatched.json に入っている（#1247）。名簿が覆うのは ${[...covered].sort((a, b) => a - b).join(" ")}`,
    );
  });

  test("**`/coverage` が読む `unmatched.json` の行数が桁の上限に収まっている**", () => {
    assert.equal(
      unmatchedMagnitudeExceeded(rows.length),
      false,
      `unmatched.json が ${rows.length} 行で上限 ${unmatchedMagnitudeLimit()} を超えている（#1247）`,
    );
  });
});

/* ------------------------------------------------------------------------------------------------
 * `cli.ts` の結線（`packages/etl/test/match-speeches.test.ts` と同じ形で原文を読む）。
 *
 * 純粋関数が正しくても `cli.ts` が使っていなければ計器は鳴らない。
 * 発言・委員会出席・委員会の役職の 3 つのループが `targets` のままだと壊れ方が戻るので、
 * **3 つ全部**を名前で確かめる（片側を直して対の側を忘れる形。`fix-one-side-check-the-mirror`）。
 * ---------------------------------------------------------------------------------------------- */

describe("cli.ts の結線: 名簿が覆わない回次へ氏名の突合を行かせない（#1247）", () => {
  const src = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");

  test("sessionsWithoutRoster の結果から nameMatchableTargets を作っている", () => {
    assert.ok(/const uncoveredTargets = sessionsWithoutRoster\(targets, members\);/.test(src),
      "sessionsWithoutRoster を targets と名簿で呼んでいない");
    assert.ok(/const nameMatchableTargets = targets\.filter\(\(s\) => !uncoveredTargets\.includes\(s\)\);/.test(src),
      "nameMatchableTargets を uncoveredTargets から作っていない");
  });

  test("参院の発言のループが nameMatchableTargets を回している（targets ではない）", () => {
    assert.ok(/for \(const session of nameMatchableTargets\) \{\n  const matched = matchSpeeches\(await fetchSpeeches\(session, "sangiin"/.test(src),
      "参院の発言を targets の全回次で取りに行っている（名簿が覆わない回次は全件 unmatched になる。#1247）");
  });

  test("委員会出席のループが nameMatchableTargets を回している", () => {
    assert.ok(/for \(const session of nameMatchableTargets\) \{\n  const meetings = await fetchCommitteeAttendance\(session\);/.test(src),
      "委員会出席を targets の全回次で取りに行っている（#1247）");
  });

  test("委員会の役職の参院側が nameMatchableTargets から作られている", () => {
    assert.ok(/\.\.\.nameMatchableTargets\.map\(\(s\): \[number, House, Member\[\]\] => \[s, "sangiin", members\]\)/.test(src),
      "委員会の役職の参院側を targets の全回次で取りに行っている（#1247）");
  });

  test("採決・議案・質問主意書のループは targets のまま（絞るのは氏名が unmatched.json に落ちる 3 種だけ）", () => {
    // **極性を間違えないこと**: これらの未突合は `rollCallId` / `billId` / `questionId` から回次を引けるので
    // 回次別ファイルに分かれ、**`/coverage` が読む `unmatched.json` には入らない**。
    // 第142〜199回の全票が未突合になるのは #217 からの設計で、**遡りの価値はそこに在る**。
    // ここを `nameMatchableTargets` に替えると、名簿の無い回次の採決が取れなくなる（#1247 の対象外）。
    //
    // **数を数えて固定する**: 絞らないループが 4 本在ることを確かめる。
    // 1 本でも `nameMatchableTargets` に替わったら落ちるし、新しい `targets` のループが
    // 黙って増えたときも落ちる（「0 件」と「数えていない」を区別する。#757 / #1056）。
    const targetLoops = [...src.matchAll(/for \(const session of targets\) \{/g)].length;
    const fetched = [
      /for \(const session of targets\) \{[\s\S]{0,400}?fetchBills\(session\)/,
      /for \(const session of targets\) \{[\s\S]{0,400}?fetchShugiinBills\(session\)/,
      /for \(const session of targets\) \{[\s\S]{0,400}?fetchShugiinQuestions\(session\)/,
    ];
    assert.equal(targetLoops, 4,
      `targets の全回次を回すループが ${targetLoops} 本（採決・議案・衆院議案・質問主意書の 4 本のはず）。` +
      "絞ったのなら遡りが取れなくなっていないか、増えたのならその種別の未突合が unmatched.json に入らないかを確かめること（#1247）");
    for (const re of fetched) {
      assert.ok(re.test(src), `targets で回していないループが在る: ${re.source.slice(-40)}（#1247 の対象外のはず）`);
    }
  });

  test("unmatched.json の行数が桁の上限を超えたら出力せずに止める", () => {
    assert.ok(/if \(unmatchedMagnitudeExceeded\(rest\.length\)\) \{/.test(src),
      "桁の検査を shardUnmatched の rest（= unmatched.json に書く行）に当てていない");
    // **`unmatched.length`（全部）ではなく `rest.length`（unmatched.json に書く分）を見ること。**
    // 全部を見ると、回次別ファイルに正しく分かれる第142〜199回の票の遡りで止まってしまう。
    assert.equal(/unmatchedMagnitudeExceeded\(unmatched\.length\)/.test(src), false,
      "桁の検査を未突合の総数に当てている（回次別に分かれる票の遡りを止めてしまう。#1247）");
    // **止めることまで確かめる。** 警告だけでは壊れた unmatched.json がそのまま /coverage に出る。
    // **行頭から見る**（`// process.exit(1);` をコメントアウトして黙らせた形を通さない。
    // ここは実際に変異で素通りした: `/process\.exit\(1\);/` だけだとコメントの中にも当たる）。
    const start = src.indexOf("if (unmatchedMagnitudeExceeded(");
    assert.notEqual(start, -1, "桁の検査そのものが無い");
    const guard = src.slice(start, src.indexOf("\n}", start));
    assert.ok(/^\s*process\.exit\(1\);\s*$/m.test(guard),
      "上限を超えても出力を止めていない（警告だけ・コメントアウト済み。壊れた unmatched.json が /coverage に出る）");
  });
});
