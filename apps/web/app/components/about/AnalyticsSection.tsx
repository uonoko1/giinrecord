/** 節「計測について」（#58）。 */
export function AnalyticsSection() {
  return (
    <section id="analytics" className="section" aria-labelledby="analytics-heading">
      <h2 id="analytics-heading" className="section__title">
        計測について
      </h2>
      <p className="body">
        閲覧数を知るために、サーバーのアクセスログを1日1回集計しています。記録するのは「日付・ページ・リファラ（リンク元のサイト名）・ページビュー数」だけです。Cookie
        は使わず、計測用のスクリプトも置いていません。IP アドレスとブラウザの種類はログに書かれません。集計結果は公開していません。
      </p>
    </section>
  );
}
