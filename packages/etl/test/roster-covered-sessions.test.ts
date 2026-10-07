import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
