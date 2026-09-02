import { Link, type MetaArgs } from "react-router";
import { CoverBrand } from "../components/CoverBrand";
import { SiteFooter } from "../components/SiteFooter";
import { ZipLookup } from "../components/ZipLookup";
import { localAssemblies } from "../lib/assemblies";
import { type Dataset, dataset as bundled, formatSessions, REPO_URL } from "../lib/dataset";
import { formatDateTime } from "../lib/format";
import { seoMeta } from "../lib/seo";
import "../styles/pages.css";
import { isCurrentOf } from "../lib/members-count";

/**
 * トップページの lead と meta description。
 * #242 で発言の収録範囲が本会議だけでなく委員会も含むようになったので、投票と発言を文として分ける
 * （「本会議で」が 3 つの動詞に等しく係ると、発言まで本会議に限られると読めるため）。
 * 個人別の投票が公表されるのは本会議だけなので、そちらは「本会議で」を保つ。
 */
// トップのリード文であり、SEO の meta description でもある（seoMeta に渡している）。
// #358: 地方議会（7議会・285名・1,089件の表決）も収録しているので、国会だけを指す文言にしない。
const DESCRIPTION = "国会議員が本会議でどう投票したか、どの法案を出したか、本会議と委員会で何を発言したか。地方議会は議員ごとの表決を。公式記録だけを、そのまま並べます。評価はしません。";

export function meta({ location }: MetaArgs) {
  return seoMeta({ description: DESCRIPTION, pathname: location.pathname });
}

const RECENT_LIMIT = 4;
const PENDING = "［集計中］";

export default function Home({ data = bundled }: { data?: Dataset }) {
  const recent = [...data.rollcalls].sort((a, b) => b.date.localeCompare(a.date)).slice(0, RECENT_LIMIT);
  const latestSession = data.meta?.sessions.length ? Math.max(...data.meta.sessions) : undefined;
  // 数えるのは**現職だけ**（#351）。元職を足すと参院が 307 名になり、**定数248を超える**。
  // 読者は「参議院議員が307人いる」と読むし、`/members` の既定（現職のみ247名）とも食い違う。
  // 元職を収録していること自体は /coverage が「議員 307 名」として別に書いている。
  const sangiinCount = data.members.filter(isCurrentOf("sangiin")).length;
  const shugiinCount = data.members.filter(isCurrentOf("shugiin")).length;
  // #158: 地方議会の数（assemblies/index.json の national 以外）。index が無い古いデータでは集計中
  const localCount = data.assemblies ? localAssemblies(data.assemblies).length : undefined;

  return (
    <>
      <main className="page">
        <header className="cover">
          <CoverBrand />
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
          {/* #112: 郵便番号 → 選挙区。クライアント専用（JS 無しでは /members へのリンク） */}
          <ZipLookup />
          <Link className="entry__link" to="/assemblies">
            議会一覧
            <span className="entry__sub">　国会と地方議会、個人別表決の公開状況</span>
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
            <div className="figure">
              <div className="figure__num">{localCount === undefined ? PENDING : localCount.toLocaleString("ja-JP")}</div>
              <div className="figure__label">地方議会</div>
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
            <Link to="/terms#funding">支援する</Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
