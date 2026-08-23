/**
 * Home の郵便番号入力（Issue #112）。lookup / loadMeta は境界（fetch）なのでフィクスチャで差し替える。
 * 表示は事実のみ: 候補の選挙区と /members?district= へのリンク、複数候補の明示、出典と基準日。
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DistrictsMeta, ZipDistricts } from "@seiji-kiroku/shared";
import byZipJson from "../test-fixtures/districts/by-zip.json";
import metaJson from "../test-fixtures/districts/meta.json";
import { ZipLookup, fetchDistrictsMeta, fetchZipDistricts } from "./ZipLookup";

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

  it("by-zip に市区町村名があれば候補が 1 つでも「東京都千代田区」と出す（#120）", async () => {
    renderLookup();
    await search("1000001");
    const result = await screen.findByRole("region", { name: "郵便番号 1000001 の選挙区" });
    expect(within(result).getByText("東京都千代田区")).toBeInTheDocument();
  });

  it("市区町村名が無い（#120 より前の by-zip）なら市区町村の行を出さない", async () => {
    renderLookup();
    await search("1000014");
    const result = await screen.findByRole("region", { name: "郵便番号 1000014 の選挙区" });
    expect(result).not.toHaveTextContent("市区町村：");
    expect(within(result).queryByText(/千代田区/)).not.toBeInTheDocument();
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
    expect(result).toHaveTextContent("東京都中央区は複数の小選挙区にまたがります");
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
    // 市区町村名は事実として両方並べる（どちらかを選ばない）
    expect(result).toHaveTextContent("愛知県弥富市、三重県桑名市");
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

  it("市区町村名が分かっても、分割市区町村でなければ「は複数の小選挙区にまたがります」とは言わない（札幌市厚別区＋清田区のような和集合）", async () => {
    renderLookup({ lookup: async () => ({ sangiin: ["北海道"], shugiin: ["北海道3", "北海道5"], municipalities: ["北海道札幌市厚別区", "北海道札幌市清田区"] }) });
    await search("0040000");
    const result = await screen.findByRole("region", { name: "郵便番号 0040000 の選挙区" });
    expect(result).toHaveTextContent("この郵便番号は複数の選挙区にまたがります");
    expect(result).not.toHaveTextContent(/[市区町村]は複数/);
    expect(result).toHaveTextContent("北海道札幌市厚別区、北海道札幌市清田区");
  });

  it("評価語・運動的な言葉を含まない", async () => {
    const { container } = renderLookup();
    await search("1040031");
    await screen.findByRole("region", { name: /の選挙区/ });
    for (const word of ["おすすめ", "ランキング", "一致率", "応援", "ぜひ"]) expect(container.textContent).not.toContain(word);
  });
});

describe("fetchZipDistricts / fetchDistrictsMeta（fetch の境界、#120）", () => {
  afterEach(() => vi.unstubAllGlobals());
  const response = (status: number, body: string, type = "application/json") =>
    new Response(body, { status, headers: { "content-type": type } });

  it("分割ファイルにその郵便番号があれば返す", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(200, JSON.stringify({ "1000001": byZip["1000001"] }))));
    expect(await fetchZipDistricts("1000001")).toEqual(byZip["1000001"]);
    expect(fetch).toHaveBeenCalledWith("/data/districts/zip/100.json");
  });

  it("404（分割ファイルが無い）・分割ファイルにその郵便番号が無い → null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(404, "not found", "text/html")));
    expect(await fetchZipDistricts("9990001")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => response(200, JSON.stringify({ "1000001": byZip["1000001"] }))));
    expect(await fetchZipDistricts("1000002")).toBeNull();
  });

  it("200 でも JSON でない応答（SPA フォールバックの HTML など）は「見つからない」扱い（null）で、取得失敗にしない", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(200, "<!doctype html><html></html>", "text/html; charset=utf-8")));
    expect(await fetchZipDistricts("1000001")).toBeNull();
    expect(await fetchDistrictsMeta()).toBeNull();
  });

  it("content-type が JSON でも本文が壊れていれば null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(200, "{not json")));
    expect(await fetchZipDistricts("1000001")).toBeNull();
  });

  it("5xx は取得失敗（例外）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(500, "error", "text/plain")));
    await expect(fetchZipDistricts("1000001")).rejects.toThrow(/HTTP 500/);
    await expect(fetchDistrictsMeta()).rejects.toThrow(/HTTP 500/);
  });

  it("meta.json は JSON なら返す", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(200, JSON.stringify(meta))));
    expect(await fetchDistrictsMeta()).toEqual(meta);
  });
});
