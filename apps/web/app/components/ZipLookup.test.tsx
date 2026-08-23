/**
 * Home の郵便番号入力（Issue #112）。lookup / loadMeta は境界（fetch）なのでフィクスチャで差し替える。
 * 表示は事実のみ: 候補の選挙区と /members?district= へのリンク、複数候補の明示、出典と基準日。
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { DistrictsMeta, ZipDistricts } from "@seiji-kiroku/shared";
import byZipJson from "../test-fixtures/districts/by-zip.json";
import metaJson from "../test-fixtures/districts/meta.json";
import { ZipLookup } from "./ZipLookup";

const byZip = byZipJson as Record<string, ZipDistricts>;
const meta = metaJson as DistrictsMeta;

const lookup = vi.fn(async (zip: string) => byZip[zip] ?? null);
const loadMeta = vi.fn(async () => meta);

function renderLookup(props: Partial<Parameters<typeof ZipLookup>[0]> = {}) {
  return render(
    <MemoryRouter>
      <ZipLookup lookup={lookup} loadMeta={loadMeta} {...props} />
    </MemoryRouter>,
  );
}

async function search(zip: string) {
  const user = userEvent.setup();
  await user.clear(screen.getByRole("textbox", { name: /郵便番号/ }));
  await user.type(screen.getByRole("textbox", { name: /郵便番号/ }), zip);
  await user.click(screen.getByRole("button", { name: "選挙区をさがす" }));
}

describe("ZipLookup", () => {
  it("JS 無しの HTML には /members へのリンクがあり、マウント後に入力欄へ置き換わる", async () => {
    renderLookup();
    // useEffect でマウント済みになるので、入力欄が出る
    expect(await screen.findByRole("textbox", { name: /郵便番号/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /議員一覧/ })).not.toBeInTheDocument();
  });

  it("7桁の郵便番号で参院選挙区と衆院小選挙区を出し、それぞれ /members?district= にリンクする", async () => {
    renderLookup();
    await search("100-0001");
    const result = await screen.findByRole("region", { name: "郵便番号 1000001 の選挙区" });
    expect(within(result).getByRole("link", { name: "東京" })).toHaveAttribute("href", "/members?district=%E6%9D%B1%E4%BA%AC");
    expect(within(result).getByRole("link", { name: "東京1" })).toHaveAttribute("href", "/members?district=%E6%9D%B1%E4%BA%AC1");
    expect(result).toHaveTextContent("参議院");
    expect(result).toHaveTextContent("衆議院");
    expect(result).not.toHaveTextContent("複数の選挙区");
    expect(lookup).toHaveBeenCalledWith("1000001");
  });

  it("全角数字・〒 付きの入力も正規化して引く", async () => {
    renderLookup();
    await search("〒１００－０００１");
    expect(await screen.findByRole("region", { name: "郵便番号 1000001 の選挙区" })).toBeInTheDocument();
  });

  it("衆院の候補が複数なら「この郵便番号は複数の選挙区にまたがります」と全候補、分割市区町村の名前を出す", async () => {
    renderLookup();
    await search("1040031");
    const result = await screen.findByRole("region", { name: "郵便番号 1040031 の選挙区" });
    expect(result).toHaveTextContent("この郵便番号は複数の選挙区にまたがります");
    expect(result).toHaveTextContent("東京都中央区");
    expect(within(result).getByRole("link", { name: "東京1" })).toBeInTheDocument();
    expect(within(result).getByRole("link", { name: "東京2" })).toBeInTheDocument();
  });

  it("都道府県をまたぐ郵便番号は参院の候補も複数で、市区町村名は出さない（推定しない）", async () => {
    renderLookup();
    await search("4980000");
    const result = await screen.findByRole("region", { name: "郵便番号 4980000 の選挙区" });
    expect(within(result).getByRole("link", { name: "愛知" })).toBeInTheDocument();
    expect(within(result).getByRole("link", { name: "三重" })).toBeInTheDocument();
    expect(result).toHaveTextContent("この郵便番号は複数の選挙区にまたがります");
    expect(result).not.toHaveTextContent(/[市区町村]は複数/);
  });

  it("合区（鳥取・島根）は 1 つのリンク", async () => {
    renderLookup();
    await search("6800001");
    const result = await screen.findByRole("region", { name: "郵便番号 6800001 の選挙区" });
    expect(within(result).getByRole("link", { name: "鳥取・島根" })).toHaveAttribute("href", "/members?district=%E9%B3%A5%E5%8F%96%E3%83%BB%E5%B3%B6%E6%A0%B9");
  });

  it("出典（日本郵便・総務省）と基準日を出す", async () => {
    renderLookup();
    await search("1000001");
    const result = await screen.findByRole("region", { name: "郵便番号 1000001 の選挙区" });
    expect(within(result).getByRole("link", { name: /日本郵便/ })).toHaveAttribute("href", "https://www.post.japanpost.jp/zipcode/download.html");
    expect(within(result).getByRole("link", { name: /総務省/ })).toHaveAttribute("href", expect.stringContaining("soumu.go.jp"));
    expect(result).toHaveTextContent("2026.07.31");
    expect(result).toHaveTextContent("2022.12.28");
  });

  it("見つからなければ「該当する郵便番号が見つかりません」", async () => {
    renderLookup();
    await search("9999999");
    expect(await screen.findByRole("status")).toHaveTextContent("該当する郵便番号が見つかりません");
    expect(screen.queryByRole("region", { name: /の選挙区/ })).not.toBeInTheDocument();
  });

  it("7桁でなければ引かずに案内を出す", async () => {
    lookup.mockClear();
    renderLookup();
    await search("12345");
    expect(await screen.findByRole("status")).toHaveTextContent("郵便番号は7桁で入力してください");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("取得に失敗したら「取得に失敗しました」", async () => {
    renderLookup({ lookup: async () => Promise.reject(new Error("HTTP 500")) });
    await search("1000001");
    expect(await screen.findByRole("status")).toHaveTextContent("取得に失敗しました");
  });

  it("評価語・運動的な言葉を含まない", async () => {
    const { container } = renderLookup();
    await search("1040031");
    await screen.findByRole("region", { name: /の選挙区/ });
    for (const word of ["おすすめ", "ランキング", "一致率", "応援", "ぜひ"]) expect(container.textContent).not.toContain(word);
  });
});
