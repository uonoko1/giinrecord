/** デザインキャンバス「このデータについて」の本文をそのまま使う。 */
const FACTS = [
  {
    kind: "事実",
    title: "参議院の記名・押しボタン投票",
    body: "議員本人が押したボタンの記録。参議院公式サイト「本会議投票結果」をそのまま転記。1998年（第142回国会）以降。",
  },
  {
    kind: "事実",
    title: "法案の提出者・賛成者、本会議発言",
    body: "衆参の議案情報と国会会議録検索システムより。発言は要約せず、原文へのリンクと冒頭の抜粋のみ。",
  },
  {
    kind: "推定",
    title: "衆議院の賛否（準備中）",
    body: "衆議院は起立採決が多く、個人の投票は公式に記録されません。所属会派の態度を「会派の態度」と明記して表示し、個人の賛否とは断定しません。",
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
    </section>
  );
}
