import { REPO_URL } from "../../lib/dataset";

/**
 * 支援リンクの先。
 * PLACEHOLDER: GitHub Sponsors は未有効化（uonoko1 アカウントでの人間の作業）。
 * 有効化後に `https://github.com/sponsors/uonoko1` へ差し替える。それまではリポジトリ URL で代替する。
 */
export const SUPPORT_URL = REPO_URL;

/** 現在の費用。数値が確定していない項目は推定せず、そのまま「未算出／取得予定」と書く。 */
const COSTS = [
  { item: "VPS（他の用途と共用）", amount: "月額の按分は未算出" },
  { item: "ドメイン", amount: "取得予定" },
] as const;

const NOT_ACCEPTED = ["政党・政治団体", "候補者・議員本人", "業界団体・ロビー団体"];

/** 節「運営費について」（#47）。 */
export function FundingSection() {
  return (
    <section id="funding" className="section" aria-labelledby="funding-heading">
      <h2 id="funding-heading" className="section__title">
        運営費について
      </h2>
      <p className="body">このサイトは個人が運営しています。費用は現在すべて運営者の自費で、収入はありません。</p>
      <div className="rows">
        {COSTS.map((c) => (
          <div key={c.item} className="row">
            <span>{c.item}</span>
            <span>{c.amount}</span>
          </div>
        ))}
      </div>
      <p className="body">
        政党・候補者・業界団体からは一切受け取りません。資金源と支出を公開します。受け取らないもの：
        {NOT_ACCEPTED.join("、")}。
      </p>
      <p className="body">任意の支援は GitHub を通じて受け付けます。支援の有無でデータや表示は変わりません。</p>
      <div className="links">
        <a href={SUPPORT_URL} rel="noreferrer">
          支援する
        </a>
      </div>
      <p className="note">将来、政治カテゴリを除外した広告を載せる可能性があります。その際は方針を事前にこのページに書きます。</p>
    </section>
  );
}
