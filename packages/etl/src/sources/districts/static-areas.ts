/**
 * 別表第一の単位を市区町村に展開するために要る、少数の「固定の事実」（Issue #111）。いずれも出典 URL 付き。
 * 推定ではなく条例・告知の原文に基づく。変わったら（支庁の再編・区の再編・合区の変更）ここを直す。
 */

/**
 * 東京都の支庁と所管区域。出典: 東京都支庁設置条例（昭和38年東京都条例第93号）
 * https://www.reiki.metro.tokyo.lg.jp/reiki/reiki_honbun/g101RG00000150.html（2026-08-23 確認）
 * 「東京都大島支庁 … 大島町、利島村、新島村及び神津島村の区域 / 東京都三宅支庁 … 三宅村及び御蔵島村の区域 /
 *   東京都八丈支庁 … 八丈町及び青ケ島村の区域並びに鳥島、須美寿島及びベヨネイス列岩 / 東京都小笠原支庁 … 小笠原村の区域」
 * KEN_ALL では「三宅島三宅村」「八丈島八丈町」「青ヶ島村」の表記（照合側が吸収する）。
 */
export const TOKYO_BRANCH_OFFICES: { source: string; areas: Record<string, string[]> } = {
  source: "https://www.reiki.metro.tokyo.lg.jp/reiki/reiki_honbun/g101RG00000150.html",
  areas: {
    東京都大島支庁管内: ["大島町", "利島村", "新島村", "神津島村"],
    東京都三宅支庁管内: ["三宅村", "御蔵島村"],
    東京都八丈支庁管内: ["八丈町", "青ケ島村"],
    東京都小笠原支庁管内: ["小笠原村"],
  },
};

/**
 * 別表第一の制定（令和4年改定）後に区の再編があり、別表の区名が KEN_ALL に無くなった市。
 * 別表の旧区 → 現在の区（`partial` は旧区の一部だけがその現在の区に入ったことを示す）。
 * 浜松市（2024-01-01）: 「中央区 = 旧 中区・東区・西区・南区 ＋ 旧 北区の三方原地区 / 浜名区 = 旧 北区（三方原地区以外）＋ 旧 浜北区 / 天竜区 = 変更なし」
 * 出典: 浜松市「行政区の再編について」 https://www.city.hamamatsu.shizuoka.jp/kikaku/kuseido/index.html（2026-08-23 確認）
 * 旧区が複数の小選挙区にまたがって現在の区に合流した場合（中央区 = 7区＋8区）、その区の郵便番号は候補を両方持つ（推定しない）。
 */
export const RENAMED_MUNICIPALITIES: { pref: string; source: string; former: Record<string, { name: string; partial?: boolean }[]> }[] = [
  {
    pref: "静岡県",
    source: "https://www.city.hamamatsu.shizuoka.jp/kikaku/kuseido/index.html",
    former: {
      浜松市中区: [{ name: "浜松市中央区" }],
      浜松市東区: [{ name: "浜松市中央区" }],
      浜松市西区: [{ name: "浜松市中央区" }],
      浜松市南区: [{ name: "浜松市中央区" }],
      浜松市北区: [{ name: "浜松市中央区", partial: true }, { name: "浜松市浜名区", partial: true }],
      浜松市浜北区: [{ name: "浜松市浜名区" }],
    },
  },
];

/**
 * 参議院の選挙区は都道府県。合区は公職選挙法 別表第三（平成27年改正）: 鳥取県・島根県、徳島県・高知県。
 * 名称は参院名簿（data/members/index.json の district）の表記に合わせる。
 * 出典: e-Gov 法令検索 公職選挙法 https://laws.e-gov.go.jp/law/325AC1000000100
 */
export const SANGIIN_MERGED_DISTRICTS: Record<string, string> = {
  鳥取県: "鳥取・島根",
  島根県: "鳥取・島根",
  徳島県: "徳島・高知",
  高知県: "徳島・高知",
};
