import { render, screen } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import Privacy, { meta as privacyMeta, PRIVACY_UPDATED } from "./privacy";
import Terms, { meta as termsMeta, SUPPORT_URL, TERMS_UPDATED } from "./terms";

const EVALUATIVE_WORDS = ["おすすめ", "ランキング", "一致率", "評価します", "採点します"];
/** 運動的・煽り的な言葉。事実と依頼だけを書く（#47）。 */
const CAMPAIGN_WORDS = ["応援", "守る", "守ろう", "ぜひ", "お願いします", "あなたの力", "みんなで", "寄付をお願い"];

const pages = [
  { name: "利用規約", Page: Terms, meta: termsMeta, updated: TERMS_UPDATED, path: "/terms" },
  { name: "プライバシーポリシー", Page: Privacy, meta: privacyMeta, updated: PRIVACY_UPDATED, path: "/privacy" },
] as const;

function renderPage(Page: () => JSX.Element) {
  return render(
    <MemoryRouter>
      <Page />
    </MemoryRouter>,
  );
}

describe.each(pages)("$name（#167）", ({ name, Page, meta, updated, path }) => {
  it("見出しと更新日を出す", () => {
    renderPage(Page);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(name);
    expect(updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const time = screen.getByText(/^更新日/).querySelector("time");
    expect(time).toHaveAttribute("dateTime", updated);
  });

  it("評価語・運動語を含まない", () => {
    const { container } = renderPage(Page);
    for (const word of [...EVALUATIVE_WORDS, ...CAMPAIGN_WORDS]) {
      expect(container.textContent).not.toContain(word);
    }
  });

  it("外部リンクはすべて noopener noreferrer", () => {
    renderPage(Page);
    const external = screen.getAllByRole("link").filter((a) => a.getAttribute("href")?.startsWith("http"));
    expect(external.length).toBeGreaterThan(0);
    for (const a of external) expect(a).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("フッターに利用規約・プライバシーポリシーのリンクがある", () => {
    renderPage(Page);
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "利用規約" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "プライバシーポリシー" })).toHaveAttribute("href", "/privacy");
  });

  it("meta にタイトル・説明・canonical がある", () => {
    const tags = meta({ location: { pathname: path } } as never);
    expect(tags).toContainEqual({ title: `${name} ・ 議員レコード` });
    expect(tags).toContainEqual(expect.objectContaining({ tagName: "link", rel: "canonical", href: path }));
    expect(tags).toContainEqual(expect.objectContaining({ name: "description" }));
  });
});

describe("利用規約の内容", () => {
  it("転記のみ・正確性非保証・一次資料優先・ライセンス・運営費・準拠法を書く", () => {
    const { container } = renderPage(Terms);
    const text = container.textContent ?? "";
    expect(text).toContain("公式記録");
    expect(text).toContain("評価・採点・推薦はしません");
    expect(text).toContain("正確性");
    expect(text).toContain("一次資料");
    expect(text).toContain("CC BY 4.0");
    expect(text).toContain("MIT");
    expect(text).toContain("運営者の自費");
    expect(text).toContain("日本法");
    expect(screen.getByRole("link", { name: "誤りを報告" })).toHaveAttribute("href", "https://github.com/uonoko1/gikailog/issues/new");
  });
});

describe("利用規約の運営費（#174）", () => {
  it("id=funding の節に方針3点を書き、支援リンクは SUPPORT_URL（GitHub Sponsors 有効化までリポジトリ URL）を指す", () => {
    const { container } = renderPage(Terms);
    const section = container.querySelector("#funding");
    expect(section).not.toBeNull();
    expect(section).toHaveAttribute("aria-labelledby", "terms-funding");
    const items = Array.from(section?.querySelectorAll("li") ?? []).map((li) => li.textContent);
    expect(items).toHaveLength(3);
    expect(items[0]).toContain("運営者の自費で運営");
    expect(items[1]).toContain("政党・候補者・業界団体からは受け取っていません");
    expect(items[2]).toContain("政治カテゴリを除外した広告");
    expect(items[2]).toContain("このページに明記");
    expect(SUPPORT_URL).toBe("https://github.com/uonoko1/gikailog");
    expect(screen.getByRole("link", { name: "支援する" })).toHaveAttribute("href", SUPPORT_URL);
  });

  it("費目・金額・未確定・予告調の表現を含まず、/about#funding へは飛ばさない", () => {
    const { container } = renderPage(Terms);
    for (const word of ["VPS", "未算出", "取得予定", "月額", "将来", "可能性", "事前に", "予定"]) {
      expect(container.textContent).not.toContain(word);
    }
    expect(container.querySelector('a[href="/about#funding"]')).toBeNull();
    expect(container.querySelector("#funding ins, #funding iframe, #funding script")).toBeNull();
  });
});

describe("プライバシーポリシーの内容", () => {
  it("Cookie なし・IP なし・集計項目・localStorage・連絡先を書く", () => {
    const { container } = renderPage(Privacy);
    const text = container.textContent ?? "";
    expect(text).toContain("Cookie");
    expect(text).toContain("IP アドレス");
    expect(text).toContain("User-Agent");
    expect(text).toContain("リファラ");
    expect(text).toContain("localStorage");
    expect(screen.getByRole("link", { name: "GitHub Issues" })).toHaveAttribute("href", "https://github.com/uonoko1/gikailog/issues");
  });

  it("#189 staging の段落が無く、エラーログに接続元 IP が短期間残ることを注記し、更新日が 2026-08-24 以降", () => {
    const { container } = renderPage(Privacy);
    const text = container.textContent ?? "";
    expect(text).not.toContain("staging");
    expect(text).not.toContain("Cloudflare");
    expect(container.querySelector("#privacy-staging")).toBeNull();
    expect(text).toContain("エラー時の診断ログ");
    expect(text).toContain("接続元 IP");
    expect(text).toContain("短期間");
    expect(text).toContain("ログローテーション");
    expect(PRIVACY_UPDATED >= "2026-08-24").toBe(true);
  });

  it("#189 変更の節に、広告を入れるときは Cookie の記述と同意バナーを更新する運用ルールを書く（予告調ではない）", () => {
    const { container } = renderPage(Privacy);
    const text = container.textContent ?? "";
    expect(text).toContain("広告");
    expect(text).toContain("同意バナー");
    for (const word of ["予定", "将来", "可能性"]) expect(text).not.toContain(word);
  });

  it("第三者送信の注記が無い（フォントは自サイト配信 #168）", () => {
    const { container } = renderPage(Privacy);
    expect(container.textContent).not.toContain("Google");
    expect(container.textContent).toContain("第三者に送りません");
  });
});
