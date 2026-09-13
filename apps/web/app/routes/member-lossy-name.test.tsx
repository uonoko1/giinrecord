import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Assembly } from "@seiji-kiroku/shared";
import type { LossyNameMatch } from "../lib/lossy-name";
import type { MemberDetail } from "../lib/data-contract";
import assembliesFixture from "../test-fixtures/assemblies/index.json";
import localMember from "../test-fixtures/assemblies/member-local.json";
import meta from "../test-fixtures/meta";
import { MemberPage } from "./member";

/**
 * #800: **字が落ちたまま名簿に寄った氏名**（`meta.lossyNameMatches`）を議員ページに出す。
 *
 * 本番の奈良（`pref-29`）に 2 件ある。`西川` は PDF の文字層から `均` が落ちた形のまま
 * 名簿の `西川 均` に寄り、**125 票が本人のページに出ている**。
 * **寄せ方が正しいかを利用者も我々も確かめる手立てが無い**のに、
 * **その事実がどこにも出ていなかった**（`grep -rn lossyNameMatches apps/web` が 0 件だった）。
 *
 * **事実だけを書く。** 「たぶん正しい」「誤りの可能性がある」のような評価・推測は書かない。
 * **一次資料（表決結果の PDF・議員名簿）へのリンクを必ず添える**——
 * 利用者が自分で確かめられなければ、書いた意味が無い。
 */

const detail = localMember as MemberDetail;
const miyagi = (assembliesFixture as Assembly[])[2]!;
const EVALUATIVE_WORDS = ["おそらく", "たぶん", "可能性", "誤り", "間違", "正しく", "疑わ"];

/** 本番の奈良と同じ形。fixture の議員は表決 4 件なので、そのうち 3 件が lossy だった形にする */
const LOSSY: LossyNameMatch = { memberId: detail.id, nameText: "西川", rosterName: "西川 均", rollCalls: 3 };

const FETCHED_AT = "2026-09-04T22:17:32.500Z";
const SOURCES = [
  { name: "奈良県議会 議員名簿（五十音順）", url: "https://www.pref.nara.lg.jp/n161/52534.html", fetchedAt: FETCHED_AT },
  { name: "奈良県議会 議員別の議案等に対する表決結果（令和8年6月定例会 2026-07-02議決分）", url: "https://www.pref.nara.lg.jp/documents/24098/20260702_giinbetsu_hyoketsu.pdf", fetchedAt: FETCHED_AT },
];

const renderPage = (lossyNameMatch: LossyNameMatch | null = LOSSY) =>
  render(<MemberPage detail={detail} meta={meta} assembly={miyagi} localSources={SOURCES} lossyNameMatch={lossyNameMatch} />);

describe("議員ページ: 字が落ちたまま名簿に寄った氏名（#800）", () => {
  it("注記が出て、表決結果に印字されていた氏名と名簿の氏名の両方を原文で出す", () => {
    renderPage();
    const notice = screen.getByTestId("member-lossy-name");
    expect(notice).toHaveTextContent("西川");
    expect(notice).toHaveTextContent("西川 均");
  });

  it("件数と母数の両方を出す（#757。件数だけだと「このページの何件がそれか」が分からない）", () => {
    renderPage();
    const notice = screen.getByTestId("member-lossy-name");
    // 3 件（lossyNameMatches の rollCalls）／ 4 件（この議員の表決の総数＝母数）
    expect(notice).toHaveTextContent("3");
    expect(notice).toHaveTextContent("4");
  });

  it("一次資料へのリンクを添える（絶対原則。利用者が自分で確かめられること）", () => {
    renderPage();
    const notice = screen.getByTestId("member-lossy-name");
    const links = within(notice).getAllByRole("link");
    expect(links.length).toBeGreaterThan(0);
    const hrefs = links.map((a) => a.getAttribute("href"));
    expect(hrefs).toContain(SOURCES[1].url);
    for (const a of links) expect(a).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("評価・推測を書かない（事実だけ）", () => {
    const { container } = renderPage();
    const text = screen.getByTestId("member-lossy-name").textContent ?? "";
    for (const w of EVALUATIVE_WORDS) expect(text).not.toContain(w);
    expect(container.textContent).not.toContain("ランキング");
  });

  it("否定的対照: 該当しない議員（10 県ぶんの全員と、奈良の残り 38 人）には何も出さない", () => {
    renderPage(null);
    expect(screen.queryByTestId("member-lossy-name")).toBeNull();
  });

  it("否定的対照: 注記が無くても既存の表決の行は出たまま（記録を消さない）", () => {
    renderPage(null);
    expect(screen.getByLabelText("○（賛成）")).toBeInTheDocument();
  });
});
