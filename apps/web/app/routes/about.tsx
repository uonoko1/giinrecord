import { Link } from "react-router";
import { type Dataset, dataset as bundled, formatDateTime, REPO_URL } from "../lib/dataset";
import "../styles/pages.css";

export function meta() {
  return [{ title: "このデータについて ・ 政治記録" }];
}

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

const NOT_RECORDED = [
  "「投票なし」が欠席か棄権か",
  "委員会での採決（個人別記録なし）",
  "党議拘束の有無、投票の理由",
  "選挙公約との一致・不一致の判定",
];

export default function About({ data = bundled }: { data?: Dataset }) {
  return (
    <main className="page">
      <header className="cover">
        <div className="cover__brand">
          <Link to="/">政治記録</Link>
        </div>
        <h1 className="cover__title">このデータについて</h1>
        <p className="cover__lead">このサイトは国会の公式記録を整形して並べるだけです。評価・採点・推薦はしません。すべての行に出典があります。</p>
      </header>

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

      <section className="section" aria-labelledby="update-heading">
        <h2 id="update-heading" className="section__title">
          更新
        </h2>
        {data.meta ? (
          <div className="rows">
            {data.meta.sources.map((s) => (
              <div key={s.url} className="row">
                <span>{s.name}</span>
                <span>{formatDateTime(s.fetchedAt)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="note">取得前です。</p>
        )}
        <p className="note">会議録は国立国会図書館での公開まで約1か月かかります。</p>
      </section>

      <section className="section" aria-labelledby="verify-heading">
        <h2 id="verify-heading" className="section__title">
          検証する
        </h2>
        <p className="body">取得プログラムと整形済みデータはすべて公開しています。間違いを見つけたら、該当行の出典と一緒にお知らせください。</p>
        <div className="links">
          <a href={REPO_URL} rel="noreferrer">
            ソースコード
          </a>
          <a href={`${REPO_URL}/tree/main/data`} rel="noreferrer">
            データ一括取得
          </a>
          <a href={`${REPO_URL}/issues/new`} rel="noreferrer">
            誤りを報告
          </a>
        </div>
      </section>
    </main>
  );
}
