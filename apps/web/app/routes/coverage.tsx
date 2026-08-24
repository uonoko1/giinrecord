import { Link, type MetaArgs } from "react-router";
import { CoverBrand } from "../components/CoverBrand";
import { SiteFooter } from "../components/SiteFooter";
import { assemblyPath, bundledSessions } from "../lib/assemblies";
import { buildCoverage, type Coverage, type DietCoverage, formatLocalSessionRange, formatSessionRange, hasSessionGaps, type LocalCoverage, rosterlessSessions, type SessionRange, shugiinQuestionCoverage } from "../lib/coverage";
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

        <RosterlessSection meta={data.meta} />
        <ShugiinQuestionsSection meta={data.meta} />

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
      <div className="figures coverage-totals">
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
        <div className="figure">
          <span className="figure__num">{n(totals.bills)}</span>
          <span className="figure__label">議案</span>
        </div>
      </div>
    </section>
  );
}

/**
 * 回次の範囲の表示。実際に行のあった回次が範囲より少ない（歯抜け）ときは実数を添える。
 * 例: 第200—221回のうち記名投票のある回次は 11（残りは起立採決などで個人票が無い）。連続収録と読ませない。
 */
function SessionRangeCell({ range, unit }: { range: SessionRange | null; unit: string }) {
  const text = formatSessionRange(range);
  if (!text || !range) return <>—</>;
  return (
    <>
      {text}
      {hasSessionGaps(range) && <span className="assemblies-status-note">うち{unit}のある回次 {n(range.count)}</span>}
    </>
  );
}

/**
 * 衆院の質問主意書が議員ページに紐づく回次（#235）。衆議院は回次ごとの議員名簿を公開しておらず「現在」の
 * 1 回次分しか無い（#71）ので、質問主意書は全回次を取得していても、提出者を名簿に名寄せできるのはその 1 回次だけ。
 * 取得済みだが議員ページに出ない質問があるという事実をそのまま書く（隠さない）。回次はデータ（meta）から数える。
 */
function ShugiinQuestionsSection({ meta }: { meta: Dataset["meta"] }) {
  const c = shugiinQuestionCoverage(meta);
  const fetched = formatSessionRange(c?.fetched ?? null);
  if (!c || !fetched || !c.linkedOnlyToRosterSession) return null;
  return (
    <section className="section" aria-labelledby="coverage-shugiin-questions-heading">
      <h2 id="coverage-shugiin-questions-heading" className="section__title">
        衆議院の質問主意書が議員ページに紐づく回次
      </h2>
      <p className="card__body">
        衆議院は<strong>回次ごとの議員名簿を公開しておらず、「現在」の 1 回次分しかありません</strong>。そのため、質問主意書は{" "}
        <span className="num">{fetched}</span> の一覧を取得していても、提出者を名簿に照合できるのは{" "}
        <span className="num">第{c.rosterSession}回</span>のぶんだけで、
        <strong>それ以外の回次の衆議院の質問主意書は議員ページに出ません</strong>。
        氏名だけを手がかりに議員を作ることはしていません（同姓同名の別人を 1 人にしないため）。
        参議院は回次ごとの名簿があるため、この制約はありません。
      </p>
    </section>
  );
}

/**
 * 名簿の無い回次（#219 / #230）。参議院の回次ごとの議員名簿は最古の 1 回次分より前が公開されていないので、
 * その回次の票はほとんどが議員ページに紐づかない。少数だけ現行名簿と氏名が一致して紐づくが、
 * 名簿に在職開始日が無く在職を確認できないため、それは**推定を含む紐づけ**である。
 * 事実として書き、評価しない。回次はデータ（meta）から数える（画面に数値を書かない）。
 */
function RosterlessSection({ meta }: { meta: Dataset["meta"] }) {
  const rosterless = rosterlessSessions(meta);
  const range = formatSessionRange(rosterless?.range ?? null);
  if (!rosterless || !range || rosterless.sessions.length === 0) return null;
  return (
    <section className="section" aria-labelledby="coverage-rosterless-heading">
      <h2 id="coverage-rosterless-heading" className="section__title">
        議員ページに紐づかない回次
      </h2>
      <p className="card__body">
        参議院の回次ごとの議員名簿は、<span className="num">第{rosterless.earliestRoster}回</span>より前が公開されていません。そのため{" "}
        <span className="num">{range}</span>（<span className="num">{n(rosterless.sessions.length)}</span> 回次）の票は、
        採決ページには氏名と当時の会派が載りますが、<strong>ほとんどが議員ページには紐づいていません</strong>。
        氏名だけを手がかりに議員を作ることはしていません（同姓同名の別人を 1 人にしないため）。
      </p>
      <p className="card__body">
        ただし、これらの回次の票のうち<strong>現在の名簿と氏名が一致する少数は、議員ページに紐づいています</strong>。
        名簿には任期満了日はありますが在職開始日にあたる項目が無く、その議員がその回次に在職していたことを一次資料から確認できません。
        つまりこの紐づけは<strong>推定を含みます</strong>。一律の見直しは作業中です（
        <a href="https://github.com/uonoko1/gikailog/issues/230" target="_blank" rel="noopener noreferrer">
          Issue #230
        </a>
        ）。
      </p>
    </section>
  );
}

/**
 * 国会: 院ごとに個人別の投票記録の有無・回次・件数・議員数。
 * 「個人票が無い」と「データが無い」は別の事実なので、衆院は個人票を「なし」としつつ議案の収録範囲を同じ表に出す。
 */
function DietSection({ diet, metaSessions }: { diet: DietCoverage[]; metaSessions: Coverage["metaSessions"] }) {
  const metaRange = formatSessionRange(metaSessions);
  return (
    <section className="section" aria-labelledby="coverage-diet-heading">
      <h2 id="coverage-diet-heading" className="section__title">
        国会
      </h2>
      {metaRange && metaSessions && (
        <p className="note">
          取得の対象にした回次: <span className="num">{metaRange}</span>（<span className="num">{n(metaSessions.count)}</span> 回次）。
          下の表は、その対象のうち実際に記録のある回次と件数です。
        </p>
      )}
      <div className="assemblies-table-wrap">
        <table className="assemblies-table" aria-label="国会の収録範囲">
          <thead>
            <tr>
              <th scope="col">院</th>
              <th scope="col">記録の種類</th>
              <th scope="col">回次</th>
              <th scope="col">件数</th>
              <th scope="col">議員</th>
              <th scope="col">出典</th>
            </tr>
          </thead>
          <tbody>
            {diet.map((d) => (
              <DietRows key={d.assemblyId} coverage={d} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">
        衆議院は本会議の個人別の投票記録を公表していません。議員ページに出る衆議院の会派の態度は、上の議案情報の「賛成会派／反対会派」に
        その議員の所属会派が載っていたことの記録で、<b>推定</b>として個人の賛否（事実）と分けて表示します。
      </p>
    </section>
  );
}

/**
 * 1 院ぶんの行。個人別の投票（参院のみ）と議案情報は別の記録なので行を分ける
 * （同じ行にすると「個人票が無い＝データが無い」と読めてしまう）。
 */
function DietRows({ coverage: d }: { coverage: DietCoverage }) {
  const rows = [
    {
      key: "votes",
      kind: d.individualVotes ? "個人別の投票（本会議の記名・押しボタン投票）" : "個人別の投票：なし（一次資料に個人票が無い）",
      range: d.rollcallSessions,
      unit: "記名投票",
      count: d.individualVotes ? d.rollcalls : null,
    },
    { key: "bills", kind: "議案情報（提出者・賛成者・各院の結果）", range: d.billSessions, unit: "議案", count: d.bills > 0 ? d.bills : null },
  ];
  return (
    <>
      {rows.map((r, i) => (
        <tr key={r.key}>
          {i === 0 && (
            <th scope="row" rowSpan={rows.length}>
              <Link to={assemblyPath(d.assemblyId)}>{d.name}</Link>
            </th>
          )}
          <td>{r.kind}</td>
          <td className="num">
            <SessionRangeCell range={r.range} unit={r.unit} />
          </td>
          <td className="num">{r.count === null ? "—" : `${n(r.count)} 件`}</td>
          {i === 0 && (
            <td className="num" rowSpan={rows.length}>
              {n(d.members)} 名
            </td>
          )}
          {i === 0 && (
            <td rowSpan={rows.length}>
              <a href={d.sourceUrl} target="_blank" rel="noopener noreferrer">
                議員一覧（公式）
              </a>
            </td>
          )}
        </tr>
      ))}
    </>
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
