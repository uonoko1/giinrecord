import type { MetaArgs } from "react-router";
import { FactsSection, FundingSection, NotRecordedSection, PoliciesSection, UpdateSection, VerifySection } from "../components/about";
import { SiteFooter } from "../components/SiteFooter";
import { CoverBrand } from "../components/CoverBrand";
import { type Dataset, dataset as bundled } from "../lib/dataset";
import { seoMeta } from "../lib/seo";
import "../styles/pages.css";

export { SUPPORT_URL } from "../components/about";

export function meta({ location }: MetaArgs) {
  return seoMeta({
    title: "このデータについて",
    description: "このサイトが扱う記録の範囲と出典、事実と推定の区別、運営費の方針。参議院・衆議院・国立国会図書館の公式記録だけを使います。",
    pathname: location.pathname,
  });
}

/** 各節は app/components/about/*.tsx。ここでは並べるだけ（#69）。 */
export default function About({ data = bundled }: { data?: Dataset }) {
  return (
    <>
      <main className="page">
        <header className="cover">
          <CoverBrand to="/" />
          <h1 className="cover__title">このデータについて</h1>
          <p className="cover__lead">このサイトは国会の公式記録を整形して並べるだけです。評価・採点・推薦はしません。すべての行に出典があります。</p>
        </header>

        <FactsSection />
        <NotRecordedSection />
        <UpdateSection meta={data.meta} />
        <VerifySection />
        <FundingSection />
        <PoliciesSection />
      </main>
      <SiteFooter />
    </>
  );
}
