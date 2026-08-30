/**
 * Issue #325: catch-all（`*`）ルート。どのルートにも一致しなかった URL の画面。
 *
 * これが無いと、React Router は未知のパスに対して何も描かず、nginx が返した SPA fallback の
 * `<title>Loading...</title>` のまま止まっていた。nginx は同じ本文を **404** で返す
 * （deploy/nginx/site.conf の `try_files … =404` + `error_page 404 /__spa-fallback.html`）ので、
 * ステータスと画面の両方が「無い」を表すようになる。
 *
 * meta は /compare（#104）と同じく noindex だけ。canonical も OGP も出さない：
 * 存在しない URL に正規 URL は無く、出せば「実在するページ」の signal になってしまう。
 * 何が入っていて何が入っていないかは /coverage に書いてあるので、そこへ導線を置く。
 */
import { Link } from "react-router";
import { CoverBrand } from "../components/CoverBrand";
import { SiteFooter } from "../components/SiteFooter";
import { SITE_NAME } from "../lib/seo";
import "../styles/pages.css";

export const TITLE = "ページが見つかりません";

export function meta() {
  return [
    { title: `${TITLE} ・ ${SITE_NAME}` },
    { name: "robots", content: "noindex" },
    { name: "description", content: "指定された URL のページはありません。" },
  ];
}

export default function NotFound() {
  return (
    <>
      <main className="page">
        <header className="cover">
          <CoverBrand to="/" />
          <h1 className="cover__title">ページが見つかりません</h1>
          <p className="cover__lead">
            指定された URL のページはありません。アドレスの打ち間違いか、以前あった URL が変わったか、まだこのサイトに入っていない記録です。
          </p>
        </header>

        <section className="section">
          <h2 className="section__title">行き先</h2>
          <nav className="entry" aria-label="主なページ">
            <Link className="entry__link" to="/members">
              議員一覧から探す
            </Link>
            <Link className="entry__link" to="/coverage">
              収録範囲を見る（どの議会・回次が入っているか）
            </Link>
            <Link className="entry__link" to="/">
              トップへ戻る
            </Link>
          </nav>
          <p className="note">
            このサイトに入っている議会・回次・件数は<Link to="/coverage">収録範囲</Link>にすべて書いてあります。
          </p>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
