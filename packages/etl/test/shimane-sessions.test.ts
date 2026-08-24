import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSessionIndex, parseSessionPage, SESSION_ARCHIVE_URL, SESSION_INDEX_URL } from "../src/sources/local/shimane/sessions.ts";

// 島根県議会「最近の定例会の概要」（/gikai/ugoki/saikin/）・「過去の定例会の概要」（/gikai/ugoki/gikai_kako/）と
// 会期ページ（/gikai/ugoki/saikin/r0806/。2026-08-24 取得）。
// saikin には会期が 1 つだけ（会期が終わると gikai_kako へ移る）ので、両方を読んで新しい順に並べる（#221）。
const fixture = (name: string) => readFileSync(new URL(`./fixtures/shimane/${name}`, import.meta.url), "utf8");
const origin = "https://www.pref.shimane.lg.jp";

test("parseSessionIndex（最近の定例会の概要）: 通算回次つきのリンク文言から sessionId / sessionLabel を作る", () => {
  const index = parseSessionIndex(fixture("saikin.html"), SESSION_INDEX_URL);
  // 「令和８年６月定例会（第４９９回）の概要」→ id は通算回次（宮城と同じく回次が原文にある議会は回次を使う）
  assert.deepEqual(index, [
    { sessionId: "499", sessionLabel: "令和8年6月定例会（第499回）", year: 2026, month: 6, url: `${origin}/gikai/ugoki/saikin/r0806/` },
  ]);
});

test("parseSessionIndex（過去の定例会の概要）: 年見出しごとのリンクを新しい順に。回次が無いので id は {西暦}-{月2桁}（臨時会は -rinji）", () => {
  const index = parseSessionIndex(fixture("gikai_kako.html"), SESSION_ARCHIVE_URL);
  assert.deepEqual(index[0], {
    sessionId: "2026-02",
    sessionLabel: "令和8年2月定例会",
    year: 2026,
    month: 2,
    url: `${origin}/gikai/ugoki/gikai_kako/r0802/`,
  });
  // 令和7年の行は「2月／5月臨時会／6月／9月／11月」の順に並んでいるが、返すのは新しい順
  const r07 = index.filter((s) => s.year === 2025).map((s) => s.sessionId);
  assert.deepEqual(r07, ["2025-11", "2025-09", "2025-06", "2025-05-rinji", "2025-02"]);
  // 令和元年と平成31年はどちらも 2019 年。西暦＋月で一意（5月臨時会・2月定例会）
  assert.ok(index.some((s) => s.sessionId === "2019-05-rinji" && s.sessionLabel === "令和元年5月臨時会"));
  assert.ok(index.some((s) => s.sessionId === "2019-02" && s.sessionLabel === "平成31年2月定例会"));
  // id は一意で、全体が新しい順
  assert.equal(new Set(index.map((s) => s.sessionId)).size, index.length);
  for (let i = 1; i < index.length; i++) {
    const a = index[i - 1];
    const b = index[i];
    assert.ok(a.year * 100 + a.month >= b.year * 100 + b.month, `descending at ${b.sessionLabel}`);
  }
});

test("parseSessionPage: 「議決結果」の節の「議員別採決結果一覧」PDF を返す", () => {
  const url = `${origin}/gikai/ugoki/saikin/r0806/`;
  // 会期ページの h1 には通算回次が無い（「令和８年６月定例会の概要」）ので、index の回次を除いた文言と突き合わせる
  const page = parseSessionPage(fixture("r0806.html"), url, { sessionLabel: "令和8年6月定例会（第499回）" });
  assert.equal(page.sessionLabel, "令和8年6月定例会");
  // 議決結果一覧（総数のみ）ではなく議員別採決結果一覧だけを拾う（会議日程・委員長報告など他の PDF も拾わない）
  assert.deepEqual(page.pdfUrls, [`${url}index.data/r0806_giinbetu_kekka.pdf`]);
});

test("parseSessionPage: h1 と会期 index のリンク文言が食い違えば例外（別の会期のページを黙って読まない）", () => {
  const url = `${origin}/gikai/ugoki/saikin/r0806/`;
  assert.throws(() => parseSessionPage(fixture("r0806.html"), url, { sessionLabel: "令和8年2月定例会" }), /does not match/);
});

test("parseSessionPage: 議員別採決結果一覧の無い会期（会期中＝まだ議決していない）は pdfUrls 空。飛ばす側が判断する", () => {
  const url = `${origin}/gikai/ugoki/saikin/r0806/`;
  // 「議決結果」の節ごと無い状態（会期が始まったばかりのページ）を実 HTML から作る
  const html = fixture("r0806.html").replace(/<h4>議決結果<\/h4>[\s\S]*?<\/div>/, "");
  const page = parseSessionPage(html, url, { sessionLabel: "令和8年6月定例会（第499回）" });
  assert.deepEqual(page.pdfUrls, []);
});

test("parseSessionPage: 議員別採決結果一覧のリンク先が PDF でなければ例外（HTML を PDF として読まない）", () => {
  const url = `${origin}/gikai/ugoki/saikin/r0806/`;
  const html = fixture("r0806.html").replace("index.data/r0806_giinbetu_kekka.pdf", "index.data/r0806_giinbetu_kekka.html");
  assert.throws(() => parseSessionPage(html, url, { sessionLabel: "令和8年6月定例会（第499回）" }), /not a PDF/);
});
