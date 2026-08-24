import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import iconv from "iconv-lite";
import type { Member, Question } from "@seiji-kiroku/shared";
import { matchQuestions } from "../src/match-questions.ts";
import { buildDataset } from "../src/aggregate.ts";
import { parseShugiinQuestion, parseShugiinQuestionList, shugiinQuestionListUrl } from "../src/sources/shugiin-questions.ts";
import { parseSangiinQuestion } from "../src/sources/sangiin-questions.ts";

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

/*
 * #235 の回帰テスト: 実 HTML → parse → matchQuestions → buildDataset の一気通しで、
 * **どの議員のどの質問が議員ページに出るか**を名指しで固定する（件数だけのテストにしない。WORKING_AGREEMENT のテスト方針）。
 * 2026-08-24 に第217〜221回の質問 524 件が carried の取りこぼしで黙って消えた。件数の一致だけでは
 * 「別の質問が同じ数だけ入った」場合を検出できないので、questionId・件名・一次資料 URL まで固定する。
 */
describe("実HTML 一気通し: 質問主意書が名指しの議員の timeline に一次資料つきで出る（#235）", () => {
  const sjis = (name: string) => iconv.decode(readFileSync(new URL(`./fixtures/${name}.htm`, import.meta.url)), "Shift_JIS");
  const utf8 = (name: string) => readFileSync(new URL(`./fixtures/${name}.htm`, import.meta.url), "utf-8");
  const SHUGIIN = "https://www.shugiin.go.jp/internet/itdb_shitsumon.nsf/html/shitsumon";
  const SANGIIN = "https://www.sangiin.go.jp/japanese/joho1/kousei/syuisyo/221";

  // 衆院: 第221回の一覧の1件目（経過ページの実 HTML がある 221001）
  const item = parseShugiinQuestionList(sjis("shugiin-shitsumon-kaiji221_l"), shugiinQuestionListUrl(221))[0]!;
  const shugiinQuestion = parseShugiinQuestion(sjis("shugiin-shitsumon-221001"), `${SHUGIIN}/221001.htm`, item);
  // 参院: 第221回の詳細ページの実 HTML
  const sangiinQuestion = parseSangiinQuestion(utf8("sangiin-syuisyo-m221001"), `${SANGIIN}/meisai/m221001.htm`, {
    questionUrl: `${SANGIIN}/syuh/s221001.htm`, answerUrl: `${SANGIIN}/touh/t221001.htm`,
  });

  // 実際の提出者を名簿に置く（衆院は経過ページの会派名、参院は詳細ページに会派が無い）
  const shugiinMember = member("h_93effd86cb", shugiinQuestion.submitterNames[0]!, "shugiin", shugiinQuestion.group ?? "無所属");
  const sangiinMember = member("m_019003", sangiinQuestion.submitterNames[0]!, "sangiin", "立憲");
  const members = [sangiinMember, shugiinMember];
  const { questions, unmatched } = matchQuestions([shugiinQuestion, sangiinQuestion], members);

  test("実 HTML の提出者が名簿の議員に紐づく（両院とも未突合ゼロ）", () => {
    assert.deepEqual(unmatched, []);
    assert.deepEqual(questions.map((q) => [q.id, q.submitters]), [
      ["221-shugiin-1", ["h_93effd86cb"]],
      [sangiinQuestion.id, ["m_019003"]],
    ]);
  });

  test("衆院: 緒方 林太郎（h_93effd86cb）の timeline に 221-shugiin-1「行き過ぎた緊縮志向に関する質問主意書」が出る", () => {
    const ds = buildDataset(members, [], new Map(), [], [], [], questions);
    const detail = ds.details.find((d) => d.id === "h_93effd86cb")!;
    assert.equal(detail.name, "緒方 林太郎", "名簿の氏名（提出者の原文から作った）");
    const rows = detail.timeline.filter((e) => e.kind === "question");
    assert.deepEqual(rows, [{
      kind: "question", session: 221, date: "2026-02-19", questionId: "221-shugiin-1",
      title: "行き過ぎた緊縮志向に関する質問主意書", submitterText: "緒方 林太郎君", status: "答弁受理",
      answerDate: "2026-03-03",
      // 一次資料: 質問の経過ページ（提出日・提出者の出典）と答弁本文
      answerUrl: `${SHUGIIN}/b221001.htm`,
      sourceUrl: `${SHUGIIN}/221001.htm`,
    }]);
    assert.equal(ds.index.find((m) => m.id === "h_93effd86cb")!.counts.questions, 1);
  });

  test("参院: 石垣 のりこ（m_019003）の timeline に第221回の質問が一次資料つきで出る", () => {
    const ds = buildDataset(members, [], new Map(), [], [], [], questions);
    const detail = ds.details.find((d) => d.id === "m_019003")!;
    const rows = detail.timeline.filter((e) => e.kind === "question");
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.questionId, sangiinQuestion.id, "詳細ページの回次・番号から作った questionId");
    assert.equal(row.session, 221);
    assert.equal(row.title, sangiinQuestion.title, "件名は詳細ページの原文");
    // 一次資料: 参院の詳細ページ（提出日・提出者の出典）
    assert.equal(row.sourceUrl, `${SANGIIN}/meisai/m221001.htm`);
    assert.equal(row.answerUrl, `${SANGIIN}/touh/t221001.htm`);
    assert.equal(ds.index.find((m) => m.id === "m_019003")!.counts.questions, 1);
  });

  test("すべての question 行が session と一次資料 URL を持つ（carried で回次を落とさないための不変条件）", () => {
    const ds = buildDataset(members, [], new Map(), [], [], [], questions);
    const rows = ds.details.flatMap((d) => d.timeline).filter((e) => e.kind === "question");
    assert.equal(rows.length, 2, "両院ぶん");
    for (const r of rows) {
      assert.equal(typeof r.session, "number", `${r.questionId} に session が無い`);
      assert.ok(r.sourceUrl.startsWith("https://"), `${r.questionId} に一次資料 URL が無い`);
    }
  });
});
