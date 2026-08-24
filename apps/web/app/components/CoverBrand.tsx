import { Link } from "react-router";

/**
 * ロゴマーク（案 D「時系列」、Issue 129）。public/logo.svg と同じ形。色は currentColor と真鍮トークンだけなので、
 * 表紙（--cover-fg / --brass-on-cover）でもダークでも tokens に従って反転する。装飾なので aria-hidden。
 */
export function LogoMark({ height = "1em" }: { height?: string | number }) {
  return (
    <svg viewBox="0 0 100 100" height={height} width={height} aria-hidden="true" focusable="false" style={{ display: "inline-block", verticalAlign: "-0.15em", flex: "none", color: "var(--cover-fg)" }}>
      <g strokeWidth="7" strokeLinecap="round">
        <line x1="30" y1="14" x2="30" y2="86" stroke="currentColor" />
        <line x1="48" y1="28" x2="84" y2="28" stroke="currentColor" />
        <line x1="48" y1="52" x2="76" y2="52" stroke="currentColor" />
        <line x1="48" y1="76" x2="68" y2="76" stroke="currentColor" />
      </g>
      <circle cx="30" cy="28" r="7" fill="currentColor" />
      <circle cx="30" cy="52" r="7" fill="currentColor" />
      <circle cx="30" cy="76" r="7" fill="var(--brass-on-cover)" />
    </svg>
  );
}

/** 表紙の「議員レコード」文字ロゴ。マークを 1em で横に添える。`to` があればリンク（トップ以外のページ）。 */
export function CoverBrand({ to }: { to?: string }) {
  const inner = (
    <>
      <LogoMark />
      <span>議員レコード</span>
    </>
  );
  return <div className="cover__brand">{to ? <Link to={to}>{inner}</Link> : inner}</div>;
}
