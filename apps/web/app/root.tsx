import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import "./styles/tokens.css";
import { THEME_STORAGE_KEY } from "./components/ThemeToggle";
import { robotsMeta, siteOrigin } from "./lib/seo";

/** staging build (#127): every page carries noindex; null on production / origin-less builds. */
const robots = robotsMeta(siteOrigin());

export const GOOGLE_FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@400;700;800&family=BIZ+UDPGothic:wght@400;700&display=swap";

export function links() {
  return [
    { rel: "preconnect", href: "https://fonts.googleapis.com" },
    { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" as const },
    { rel: "stylesheet", href: GOOGLE_FONTS_HREF },
  ];
}

/** 保存済みテーマをハイドレーション前に html へ付与し、ちらつきを防ぐ。 */
const themeInit = `try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

export default function Root() {
  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {robots && <meta name={robots.name} content={robots.content} />}
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
