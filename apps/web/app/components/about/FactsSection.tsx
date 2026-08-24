import { Link } from "react-router";

/** デザインキャンバス「このデータについて」の本文をそのまま使う。 */
const FACTS = [
  {
    kind: "事実",
    title: "参議院の記名・押しボタン投票",
    body: "議員本人が押したボタンの記録。参議院公式サイト「本会議投票結果」をそのまま転記。この投票方式は1998年（第142回国会）に始まりました。",
  },
  {
    kind: "事実",
    title: "法案の提出者・賛成者、本会議発言",
    body: "衆参の議案情報と国会会議録検索システムより。発言は要約せず、原文へのリンクと冒頭の抜粋のみ。",
  },
  {
    kind: "推定",
    title: "衆議院の賛否",
    body: "衆議院は起立採決が多く、個人の投票は公式に記録されません。議員ページでは所属会派の態度を「会派の態度（推定）」として表示し、個人の賛否とは断定しません。",
  },
] as const;

/** 節「何が事実で、何が推定か」。 */
export function FactsSection() {
  return (
    <section className="section" aria-labelledby="facts-heading">
      <h2 id="facts-heading" className="section__title">
        何が事実で、何が推定か
      </h2>
      {FACTS.map((f) => (
        <article key={f.title} className="card">
          <div className="card__head">
            <span className={`tag ${f.kind === "事実" ? "tag--fact" : "tag--estimate"}`}>{f.kind}</span>
            <span>{f.title}</span>
          </div>
          <p className="card__body">{f.body}</p>
        </article>
      ))}
      {/* #218: この節はデータの種類と出典の性質を説明する。収録範囲（議会ごとの回次・会期・件数）はデータから数えた /coverage にあり、ここには書かない */}
      <p className="note">
        入っている議会・回次・会期と件数は<Link to="/coverage">収録範囲</Link>にあります。
      </p>
      {/* #251: 衆院の記録が議員ページに紐づく範囲（名簿が「現在」の 1 枚しかない）は数えた実数つきで /coverage にある。説明はそちらに 1 つだけ置き、ここからは導線だけ */}
      <p className="note">
        衆議院の提出法案・質問主意書・発言が議員ページに紐づく範囲は
        <Link to="/coverage#coverage-shugiin-roster-heading">収録範囲「衆議院の記録が議員ページに紐づく範囲」</Link>にあります。
      </p>
    </section>
  );
}
