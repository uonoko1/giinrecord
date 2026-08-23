import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Member, Question } from "@seiji-kiroku/shared";
import { matchQuestions } from "../src/match-questions.ts";

const member = (id: string, name: string, house: Member["house"], group: string, sessionFrom = 221, sessionTo?: number): Member => ({
  id, name, kana: "", house,
  terms: [{ house, group, district: "比例", from: "", sessionFrom, ...(sessionTo !== undefined ? { sessionTo } : {}) }],
  sourceUrl: house === "sangiin" ? "https://www.sangiin.go.jp/japanese/joho1/kousei/giin/profile/x.htm" : "https://www.shugiin.go.jp/internet/itdb_giinprof.nsf/html/profile/x.htm",
});
const question = (q: Partial<Question> & { id: string; house: Question["house"]; submitterNames: string[] }): Question => ({
  session: 221, number: 1, title: `質問 ${q.id}`, date: "2026-02-20", submitterText: `${q.submitterNames[0]}君`,
  sourceUrl: q.house === "sangiin"
    ? "https://www.sangiin.go.jp/japanese/joho1/kousei/syuisyo/221/meisai/m221001.htm"
    : "https://www.shugiin.go.jp/internet/itdb_shitsumon.nsf/html/shitsumon/221001.htm",
  ...q,
});

describe("matchQuestions: 質問主意書の提出者を名簿に名寄せする（純粋関数、resolveMember）", () => {
  test("参院: 氏名が名簿の1人に一致すれば submitters に memberId が入る。参院の質問は参院名簿にだけ突合する", () => {
    const members = [member("m_1", "石垣 のりこ", "sangiin", "立憲"), member("h_1", "石垣 のりこ", "shugiin", "立憲民主党・無所属")];
    const { questions, unmatched } = matchQuestions([question({ id: "221-sangiin-1", house: "sangiin", submitterNames: ["石垣 のりこ"] })], members);
    assert.deepEqual(questions[0]?.submitters, ["m_1"]);
    assert.deepEqual(unmatched, []);
  });

  test("名簿に無い氏名は unmatched（kind: question, questionId 付き）に載り、例外にならない", () => {
    const { questions, unmatched } = matchQuestions([question({ id: "221-sangiin-2", house: "sangiin", submitterNames: ["存在しない 人"] })], [member("m_1", "石垣 のりこ", "sangiin", "立憲")]);
    assert.equal(questions[0]?.submitters, undefined);
    assert.deepEqual(unmatched, [{ kind: "question", nameText: "存在しない 人", group: "", questionId: "221-sangiin-2" }]);
  });

  test("同姓同名は会派（衆院 経過ページの会派名）で分け、分けられなければ unmatched（推測しない）", () => {
    const members = [member("h_1", "山田 太郎", "shugiin", "自由民主党・無所属の会"), member("h_2", "山田 太郎", "shugiin", "立憲民主党・無所属")];
    const { questions, unmatched } = matchQuestions([
      question({ id: "221-shugiin-1", house: "shugiin", submitterNames: ["山田 太郎"], group: "立憲民主党・無所属" }),
      question({ id: "221-shugiin-2", house: "shugiin", number: 2, submitterNames: ["山田 太郎"] }),
    ], members);
    assert.deepEqual(questions[0]?.submitters, ["h_2"]);
    assert.equal(questions[1]?.submitters, undefined);
    assert.deepEqual(unmatched, [{ kind: "question", nameText: "山田 太郎", group: "", questionId: "221-shugiin-2" }]);
  });

  test("衆院: 名簿が覆う回次の質問だけ名寄せする（衆院名簿は「現在」の1回次分。過去回次は紐づけず unmatched にも出さない）", () => {
    const members = [member("h_1", "緒方 林太郎", "shugiin", "無所属", 221)];
    const { questions, unmatched } = matchQuestions([
      question({ id: "217-shugiin-1", house: "shugiin", session: 217, submitterNames: ["緒方 林太郎"] }),
      question({ id: "221-shugiin-1", house: "shugiin", submitterNames: ["緒方 林太郎"] }),
    ], members);
    assert.equal(questions[0]?.submitters, undefined);
    assert.deepEqual(questions[1]?.submitters, ["h_1"]);
    assert.deepEqual(unmatched, []);
  });

  test("衆院の名簿が無ければ（house: shugiin が0人）衆院の質問は名寄せを試みず unmatched も出さない", () => {
    const { questions, unmatched } = matchQuestions([question({ id: "221-shugiin-1", house: "shugiin", submitterNames: ["緒方 林太郎"] })], [member("m_1", "緒方 林太郎", "sangiin", "立憲")]);
    assert.equal(questions[0]?.submitters, undefined);
    assert.deepEqual(unmatched, []);
  });

  test("参院: 回次ごとの名簿があるので、その回次に効いている名簿で突合する（辞職した旧議員も紐づく）", () => {
    const members = [member("m_old", "辞職 太郎", "sangiin", "立憲", 217, 218)];
    const { questions } = matchQuestions([question({ id: "217-sangiin-1", house: "sangiin", session: 217, submitterNames: ["辞職 太郎"] })], members);
    assert.deepEqual(questions[0]?.submitters, ["m_old"]);
  });
});
