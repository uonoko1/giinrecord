const NOT_RECORDED = [
  "「投票なし」が欠席か棄権か",
  "委員会での採決（個人別記録なし）",
  "党議拘束の有無、投票の理由",
  "選挙公約との一致・不一致の判定",
];

/** 節「記録にないこと」。 */
export function NotRecordedSection() {
  return (
    <section className="section" aria-labelledby="none-heading">
      <h2 id="none-heading" className="section__title">
        記録にないこと
      </h2>
      <ul className="plain">
        {NOT_RECORDED.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </section>
  );
}
