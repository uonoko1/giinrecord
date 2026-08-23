import type { MetaArgs } from "react-router";
import { CoverBrand } from "../components/CoverBrand";
import { SiteFooter } from "../components/SiteFooter";
import { REPO_URL } from "../lib/dataset";
import { seoMeta } from "../lib/seo";
import "../styles/pages.css";

/** この規約の最終更新日（YYYY-MM-DD）。本文を変えたら更新する。 */
export const TERMS_UPDATED = "2026-08-23";

const ISSUE_NEW_URL = `${REPO_URL}/issues/new`;

/**
 * 支援リンクの先（#174 で /about から移動）。
 * PLACEHOLDER: GitHub Sponsors は未有効化（uonoko1 アカウントでの人間の作業）。
 * 有効化後に `https://github.com/sponsors/uonoko1` へ差し替える。それまではリポジトリ URL で代替する。
 */
export const SUPPORT_URL = REPO_URL;
const CC_BY_URL = "https://creativecommons.org/licenses/by/4.0/deed.ja";

export function meta({ location }: MetaArgs) {
  return seoMeta({
    title: "利用規約",
    description: "議会ログの利用規約。公式記録の転記であること、正確性の扱い、データとコードのライセンス、運営費の方針、準拠法。",
    pathname: location.pathname,
  });
}

/** 利用規約（#167）。短く・平易に。評価語・運動語は書かない。 */
export default function Terms() {
  return (
    <>
      <main className="page">
        <header className="cover">
          <CoverBrand to="/" />
          <h1 className="cover__title">利用規約</h1>
          <p className="cover__lead">
            更新日 <time dateTime={TERMS_UPDATED}>{TERMS_UPDATED}</time>
          </p>
        </header>

        <section className="section" aria-labelledby="terms-what">
          <h2 id="terms-what" className="section__title">
            このサイトは何か
          </h2>
          <p className="body">
            議会ログは、参議院・衆議院・国立国会図書館が公開する公式記録を転記して並べたサイトです。記録をそのまま置くだけで、評価・採点・推薦はしません。すべての記録に出典へのリンクがあります。
          </p>
        </section>

        <section className="section" aria-labelledby="terms-accuracy">
          <h2 id="terms-accuracy" className="section__title">
            正確性について
          </h2>
          <p className="body">
            転記・整形の過程で誤りが入ることがあります。内容の正確性・完全性・最新性は保証しません。このサイトと一次資料（各院・国立国会図書館の公式記録）に相違がある場合は、一次資料が優先します。利用によって生じた損害について、運営者は責任を負いません。
          </p>
          <div className="links">
            <a href={ISSUE_NEW_URL} target="_blank" rel="noopener noreferrer">
              誤りを報告
            </a>
          </div>
        </section>

        <section className="section" aria-labelledby="terms-license">
          <h2 id="terms-license" className="section__title">
            ライセンス
          </h2>
          <ul className="plain">
            <li>
              データ（正規化済み JSON）：
              <a href={CC_BY_URL} target="_blank" rel="noopener noreferrer">
                CC BY 4.0
              </a>
              。出典として「議会ログ」と、元の一次資料へのリンクを表示してください。
            </li>
            <li>コード：MIT ライセンス。</li>
            <li>
              いずれも
              <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
                GitHub のリポジトリ
              </a>
              で公開しています。
            </li>
          </ul>
        </section>

        <section id="funding" className="section" aria-labelledby="terms-funding">
          <h2 id="terms-funding" className="section__title">
            運営費の方針
          </h2>
          <ul className="plain">
            <li>運営者の自費で運営しています。</li>
            <li>政党・候補者・業界団体からは受け取らない。</li>
            <li>
              支援や、政治カテゴリを除外した広告を受ける場合は、このページに明記します。
            </li>
          </ul>
          <div className="links">
            <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer">
              支援する
            </a>
          </div>
        </section>

        <section className="section" aria-labelledby="terms-law">
          <h2 id="terms-law" className="section__title">
            準拠法と変更
          </h2>
          <p className="body">
            この規約は日本法に従います。規約を変更した場合は、このページの内容と冒頭の更新日を改めます。個別の通知はしません。
          </p>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
