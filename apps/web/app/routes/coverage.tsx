import { Link, type MetaArgs } from "react-router";
import { CoverBrand } from "../components/CoverBrand";
import { SiteFooter } from "../components/SiteFooter";
import { assemblyPath, bundledSessions } from "../lib/assemblies";
import { buildCoverage, type Coverage, type DietCoverage, formatLocalSessionRange, formatSessionRange, type LocalCoverage } from "../lib/coverage";
import type { AssemblySession } from "../lib/data-contract";
import { type Dataset, dataset as bundled } from "../lib/dataset";
import { formatDate, formatDateTime } from "../lib/format";
import { seoMeta } from "../lib/seo";
import "../styles/pages.css";
import "./assemblies.css";

const DESCRIPTION = "このサイトに入っている議会・回次・会期と、採決件数・議員数・取得元。すべてデータセットから数えた件数です。";

export function meta({ location }: MetaArgs) {
  return seoMeta({ title: "収録範囲", description: DESCRIPTION, pathname: location.pathname });
}

const n = (v: number) => v.toLocaleString("ja-JP");

const KIND_LABEL = { national: "国会", prefectural: "都道府県議会", municipal: "政令指定都市議会" } as const;

/**
 * /coverage（#218）: どの議会のどこまでが入っているかを data/ から数えて並べる。
 * 件数・範囲はすべて buildCoverage がデータを数えた値で、この画面には数値を書かない。評価・解釈は書かない。
 */
export default function CoveragePage({ data = bundled, sessions = bundledSessions() }: { data?: Dataset; sessions?: ReadonlyMap<string, AssemblySession[]> }) {
  const coverage = buildCoverage(data, sessions);
  return (
    <>
      <main className="page assemblies">
        <header className="cover">
          <CoverBrand to="/" />
          <h1 className="cover__title">収録範囲</h1>
          <p className="cover__lead">{DESCRIPTION}</p>
          {data.meta && <p className="note">取得 {formatDateTime(data.meta.fetchedAt)}</p>}
        </header>

        <TotalsSection coverage={coverage} />
        <DietSection diet={coverage.diet} metaSessions={coverage.metaSessions} />
        <LocalSection local={coverage.local} />

        <section className="section" aria-labelledby="coverage-not-recorded-heading">
          <h2 id="coverage-not-recorded-heading" className="section__title">
            記録にないこと
          </h2>
          <p className="card__body">
            一次資料に無いもの（参議院の議員立法の共同発議者・賛成者名、「投票なし」が欠席か棄権かの区別、委員会での採決など）は、このサイトにもありません。一覧は
            <Link to="/about#none-heading">このデータについて「記録にないこと」</Link>
            にあります。
          </p>
        </section>

        <section className="section">
          <div className="links">
            <Link to="/assemblies">議会一覧</Link>
            <Link to="/about">このデータについて</Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

/** 合計（議会数・議員数・採決件数）。すべて data/ の行数 */
function TotalsSection({ coverage }: { coverage: Coverage }) {
  const { totals } = coverage;
  return (
    <section className="section" aria-labelledby="coverage-totals-heading">
      <h2 id="coverage-totals-heading" className="section__title">
        合計
      </h2>
      <div className="figures">
        <div className="figure">
          <span className="figure__num">{n(totals.assemblies)}</span>
          <span className="figure__label">議会</span>
        </div>
        <div className="figure">
          <span className="figure__num">{n(totals.dietMembers + totals.localMembers)}</span>
          <span className="figure__label">議員</span>
        </div>
        <div className="figure">
          <span className="figure__num">{n(totals.dietRollcalls + totals.localRollcalls)}</span>
          <span className="figure__label">採決・表決</span>
        </div>
      </div>
    </section>
  );
}

/** 国会: 院ごとに回次の範囲・採決件数・議員数。衆院の個人票が無いことは事実として 1 文 */
function DietSection({ diet, metaSessions }: { diet: DietCoverage[]; metaSessions: Coverage["metaSessions"] }) {
  const metaRange = formatSessionRange(metaSessions);
  return (
    <section className="section" aria-labelledby="coverage-diet-heading">
      <h2 id="coverage-diet-heading" className="section__title">
        国会
      </h2>
      {metaRange && (
        <p className="note">
          取得の対象にした回次: <span className="num">{metaRange}</span>
        </p>
      )}
      <div className="assemblies-table-wrap">
        <table className="assemblies-table" aria-label="国会の収録範囲">
          <thead>
            <tr>
              <th scope="col">院</th>
              <th scope="col">個人別の投票記録</th>
              <th scope="col">回次</th>
              <th scope="col">採決</th>
              <th scope="col">議員</th>
              <th scope="col">出典</th>
            </tr>
          </thead>
          <tbody>
            {diet.map((d) => (
              <tr key={d.assemblyId}>
                <th scope="row">
                  <Link to={assemblyPath(d.assemblyId)}>{d.name}</Link>
                </th>
                <td>{d.individualVotes ? "あり（本会議の記名・押しボタン投票）" : "なし"}</td>
                <td className="num">{formatSessionRange(d.rollcallSessions) ?? "—"}</td>
                <td className="num">{d.individualVotes ? `${n(d.rollcalls)} 件` : "—"}</td>
                <td className="num">{n(d.members)} 名</td>
                <td>
                  <a href={d.sourceUrl} target="_blank" rel="noopener noreferrer">
                    議員一覧（公式）
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">
        衆議院は本会議の個人別の投票記録を公表していません。議員ページに出る衆議院の会派の態度は、議案情報の「賛成会派／反対会派」にその議員の所属会派が載っていたことの記録で、
        <b>推定</b>として個人の賛否（事実）と分けて表示します。
      </p>
    </section>
  );
}

/** 地方議会: 議会ごとに会期の範囲・表決数・議員数・会期ごとの取得元（一次資料） */
function LocalSection({ local }: { local: LocalCoverage[] }) {
  return (
    <section className="section" aria-labelledby="coverage-local-heading">
      <h2 id="coverage-local-heading" className="section__title">
        地方議会
      </h2>
      {local.length === 0 ? (
        <p className="note">地方議会のデータはまだありません。</p>
      ) : (
        local.map((a) => <LocalAssembly key={a.assemblyId} coverage={a} />)
      )}
    </section>
  );
}

function LocalAssembly({ coverage: a }: { coverage: LocalCoverage }) {
  const range = formatLocalSessionRange(a);
  return (
    <section className="coverage-assembly" aria-label={a.name}>
      <h3 className="coverage-assembly__name">
        <Link to={assemblyPath(a.assemblyId)}>{a.name}</Link>
      </h3>
      <dl className="assembly-facts">
        <div className="assembly-facts__item">
          <dt>種別</dt>
          <dd>{KIND_LABEL[a.kind]}</dd>
        </div>
        <div className="assembly-facts__item">
          <dt>会期</dt>
          <dd>{range ?? "会期の一覧は未取得です。"}</dd>
        </div>
        <div className="assembly-facts__item">
          <dt>表決</dt>
          <dd className="num">
            {n(a.rollcalls)} 件（{n(a.sessions)} 会期）
          </dd>
        </div>
        <div className="assembly-facts__item">
          <dt>議員</dt>
          <dd className="num">{n(a.members)} 名</dd>
        </div>
        <div className="assembly-facts__item">
          <dt>名簿</dt>
          <dd>
            <a href={a.sourceUrl} target="_blank" rel="noopener noreferrer">
              議員名簿（公式）
            </a>
          </dd>
        </div>
      </dl>
      {a.sources.length > 0 && (
        <div className="assemblies-table-wrap">
          <table className="assembly-sessions" aria-label={`${a.name}の取得元`}>
            <thead>
              <tr>
                <th scope="col">会期</th>
                <th scope="col">議決日</th>
                <th scope="col">表決</th>
                <th scope="col">取得元</th>
              </tr>
            </thead>
            <tbody>
              {a.sources.map((s) => (
                <tr key={s.id}>
                  <td>{s.label}</td>
                  <td className="num">
                    <time dateTime={s.date}>{formatDate(s.date)}</time>
                  </td>
                  <td className="num">{n(s.rollcalls)} 件</td>
                  <td>
                    <a href={s.sourceUrl} target="_blank" rel="noopener noreferrer">
                      表決結果（公式）
                    </a>
                    <span className="assemblies-status-note">取得 {formatDateTime(s.fetchedAt)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
