import { REPO_URL } from "../../lib/dataset";

/**
 * 支援リンクの先。
 * PLACEHOLDER: GitHub Sponsors は未有効化（uonoko1 アカウントでの人間の作業）。
 * 有効化後に `https://github.com/sponsors/uonoko1` へ差し替える。それまではリポジトリ URL で代替する。
 */
export const SUPPORT_URL = REPO_URL;

/** 方針3点。費目・金額は書かない（#160）。 */
const POLICIES = [
  "運営者の自費で運営しています。",
  "政党・候補者・業界団体からは受け取らない。",
  "支援や、政治カテゴリを除外した広告を受ける場合は、このページに明記します。",
] as const;

/** 節「運営費について」（#47, #160）。 */
export function FundingSection() {
  return (
    <section id="funding" className="section" aria-labelledby="funding-heading">
      <h2 id="funding-heading" className="section__title">
        運営費について
      </h2>
      <ul className="plain">
        {POLICIES.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <div className="links">
        <a href={SUPPORT_URL} rel="noreferrer">
          支援する
        </a>
      </div>
    </section>
  );
}
