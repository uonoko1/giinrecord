/**
 * ロゴ・ファビコン・manifest・theme-color で使うブランド色（#129）。
 * UI は tokens.css の変数を使う。ここは SVG/manifest のようにトークンを参照できない場所のための唯一の定数で、
 * 値が tokens.css と一致することはテスト（brand-assets.test.ts）が確認する。
 */
export const BRAND = {
  /** 墨藍 = --cover */
  ink: "#26364a",
  /** 紙 = --paper */
  paper: "#f5f2ec",
  /** 真鍮 = --brass-on-cover */
  brass: "#d8b86a",
} as const;

/** ダーク（「夜の台帳」）: 紙と墨が入れ替わり、真鍮は深くなる */
export const BRAND_DARK = {
  ink: "#1c1d21",
  paper: "#ece8df",
  brass: "#8a6a24",
} as const;
