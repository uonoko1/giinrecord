import { Link, type MetaArgs } from "react-router";
import { type Dataset, dataset as bundled, formatSessions, REPO_URL } from "../lib/dataset";
import { formatDateTime } from "../lib/format";
import { seoMeta } from "../lib/seo";
import "../styles/pages.css";

const DESCRIPTION = "国会議員が本会議でどう投票し、どの法案を出し、何を発言したか。公式記録だけを、そのまま並べます。評価はしません。";

export function meta({ location }: MetaArgs) {
  return seoMeta({ description: DESCRIPTION, pathname: location.pathname });
}

const RECENT_LIMIT = 4;
const PENDING = "［集計中］";

export default function Home({ data = bundled }: { data?: Dataset }) {
  const recent = [...data.rollcalls].sort((a, b) => b.date.localeCompare(a.date)).slice(0, RECENT_LIMIT);
  const latestSession = data.meta?.sessions.length ? Math.max(...data.meta.sessions) : undefined;
  const sangiinCount = data.members.filter((m) => m.house === "sangiin").length;
  const shugiinCount = data.members.filter((m) => m.house === "shugiin").length;

  return (
    <main className="page">
      <header className="cover">
        <div className="cover__brand">議会ログ</div>
        <h1 className="cover__title">
          言ったことではなく、
          <br />
          やったことを。
        </h1>
        <p className="cover__lead">{DESCRIPTION}</p>
      </header>

      <section className="section entry" aria-label="さがす">
        <Link className="entry__link" to="/members">
          議員一覧
          <span className="entry__sub">　名前・ふりがなでさがす</span>
        </Link>
      </section>

      {recent.length > 0 && (
        <section className="section" aria-labelledby="recent-heading">
          <h2 id="recent-heading" className="section__title">
            最近の本会議採決
          </h2>
          <ul className="list">
            {recent.map((rc) => (
              <li key={rc.id} className="list__item">
                <Link to={`/rollcalls/${rc.session}/${rc.id}`}>{rc.title}</Link>
                <div className="list__meta">
                  <b>{formatDateTime(rc.date)}</b>
                  {" ・ "}第{rc.session}回国会{" ・ "}
                  {rc.result}
                  {" ・ "}
                  {rc.totals.yes}–{rc.totals.no}
                </div>
              </li>
            ))}
          </ul>
          {latestSession !== undefined && (
            <Link className="list__more" to={`/rollcalls/${latestSession}`}>
              第{latestSession}回国会の採決 {data.rollcalls.filter((r) => r.session === latestSession).length}件すべて
            </Link>
          )}
        </section>
      )}

      <section className="section" aria-labelledby="scale-heading">
        <h2 id="scale-heading" className="section__title">
          このサイトにあるもの
        </h2>
        <div className="figures">
          <div className="figure">
            <div className="figure__num">{sangiinCount > 0 ? sangiinCount : PENDING}</div>
            <div className="figure__label">参議院議員</div>
          </div>
          <div className="figure">
            <div className="figure__num">{shugiinCount > 0 ? shugiinCount : PENDING}</div>
            <div className="figure__label">衆議院議員</div>
          </div>
          <div className="figure">
            <div className="figure__num">{data.rollcalls.length > 0 ? data.rollcalls.length : PENDING}</div>
            <div className="figure__label">本会議採決</div>
          </div>
          <div className="figure">
            <div className="figure__num">{data.meta ? (formatSessions(data.meta.sessions) ?? PENDING) : PENDING}</div>
            <div className="figure__label">国会</div>
          </div>
        </div>
        <p className="note">衆議院は個人の投票記録が公開されていないため、会派の態度として別に扱います。</p>
      </section>

      <section className="section" aria-labelledby="sources-heading">
        <h2 id="sources-heading" className="section__title">
          出典と更新
        </h2>
        {data.meta ? (
          <div className="rows">
            {data.meta.sources.map((s) => (
              <div key={s.url} className="row">
                <a href={s.url} rel="noreferrer">
                  {s.name}
                </a>
                <span>{formatDateTime(s.fetchedAt)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="note">取得前です。</p>
        )}
        <div className="links">
          <Link to="/about">このデータについて</Link>
          <a href={REPO_URL} rel="noreferrer">
            ソースコード
          </a>
          <Link to="/about#funding">支援する</Link>
        </div>
      </section>
    </main>
  );
}
