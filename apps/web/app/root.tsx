import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import "./styles/tokens.css";
import { THEME_STORAGE_KEY } from "./components/ThemeToggle";
import { BRAND } from "./lib/brand-colors";

export const GOOGLE_FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@400;700;800&family=BIZ+UDPGothic:wght@400;700&display=swap";

export function links() {
  return [
    { rel: "preconnect", href: "https://fonts.googleapis.com" },
    { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" as const },
    { rel: "stylesheet", href: GOOGLE_FONTS_HREF },
    // #129: SVG ファビコン（ダーク対応）を優先し、ICO は旧ブラウザ向け。PNG/ICO はビルド時生成（scripts/brand-assets.ts）
    { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
    { rel: "icon", href: "/favicon.ico", sizes: "48x48" },
    { rel: "apple-touch-icon", href: "/apple-touch-icon.png", sizes: "180x180" },
    { rel: "manifest", href: "/site.webmanifest" },
  ];
}

/** ブラウザ UI の色（墨藍）。各ルートの meta() は親の meta を継がないので head に直接書く。 */
export const THEME_COLOR = BRAND.ink;

/** 保存済みテーマをハイドレーション前に html へ付与し、ちらつきを防ぐ。 */
const themeInit = `try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

export default function Root() {
  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content={THEME_COLOR} />
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
