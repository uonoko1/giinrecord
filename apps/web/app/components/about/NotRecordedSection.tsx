const NOT_RECORDED = [
  "「投票なし」が欠席か棄権か",
  "委員会での採決（個人別記録なし）",
  "党議拘束の有無、投票の理由",
  "選挙公約との一致・不一致の判定",
  // #63: 議案情報・提出法律案 PDF・法制局・公報・会議録のいずれにも全員の氏名は無い（docs/research/sangiin-cosponsors.md）。
  "参議院の議員立法の共同発議者・賛成者名（一次資料に掲載なし）",
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
