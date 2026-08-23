import { Link, type MetaArgs, useParams } from "react-router";
import type { Assembly } from "@seiji-kiroku/shared";
import { CoverBrand } from "../components/CoverBrand";
import { SiteFooter } from "../components/SiteFooter";
import { bundledSessions, disclosureFor, findAssembly, isDietAssemblyId, VOTE_DISCLOSURE } from "../lib/assemblies";
import { type AssemblySession, DIET_ASSEMBLIES } from "../lib/data-contract";
import { type Dataset, dataset as bundled, type MemberSummary } from "../lib/dataset";
import { formatDate, formatDateTime } from "../lib/format";
import { memberAssemblyId } from "../lib/member-search";
import { seoMeta } from "../lib/seo";
import "../styles/pages.css";
import "./assemblies.css";

const KIND_LABEL = { national: "国会", prefectural: "都道府県議会", municipal: "政令指定都市議会" } as const;

export function pageTitle(assembly: Assembly | undefined): string {
  return assembly?.name ?? "議会";
}

export function meta({ location, params }: MetaArgs) {
  const assembly = findAssembly(bundled.assemblies ?? DIET_ASSEMBLIES, params.id ?? "");
  return seoMeta({
    title: pageTitle(assembly),
    description: assembly ? `${assembly.name}の議員一覧と会期。公式記録から出典つきで並べます。評価はしません。` : "議会ログの議会ページ。",
    pathname: location.pathname,
  });
}

/**
 * /assemblies/{id}（#158）。データは index.json をビルド時にバンドルし、URL の id で引く（loader 無し）。
 * 国会は既存の一覧（/members?assembly=）と採決（/rollcalls）へ送り、地方議会はここで議員と会期を並べる。
 */
export default function AssemblyRoute({ data = bundled, sessions }: { data?: Dataset; sessions?: ReadonlyMap<string, AssemblySession[]> }) {
  const { id = "" } = useParams();
  return <AssemblyPage id={id} data={data} sessions={sessions} />;
}

const collator = new Intl.Collator("ja");

export function AssemblyPage({ id, data = bundled, sessions = bundledSessions() }: { id: string; data?: Dataset; sessions?: ReadonlyMap<string, AssemblySession[]> }) {
  const assembly = findAssembly(data.assemblies ?? DIET_ASSEMBLIES, id);
  if (!assembly) return <NotFound />;
  const members = data.members.filter((m) => memberAssemblyId(m) === assembly.id);
  return (
    <>
      <main className="page assembly">
        <header className="cover">
          <CoverBrand to="/" />
          <h1 className="cover__title">{assembly.name}</h1>
          <p className="cover__lead">
            <span>{KIND_LABEL[assembly.kind]}</span>
            {" ・ "}
            <span className="num">{members.length.toLocaleString("ja-JP")} 名</span>
          </p>
          <p className="note">
            <a href={assembly.sourceUrl} target="_blank" rel="noopener noreferrer">
              議員名簿（公式）
            </a>
          </p>
        </header>
        {isDietAssemblyId(assembly.id) ? <DietSections assembly={assembly} data={data} /> : <LocalSections assembly={assembly} members={members} sessions={sessions.get(assembly.id)} />}
        <section className="section">
          <div className="links">
            <Link to="/assemblies">議会一覧</Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

function NotFound() {
  return (
    <>
      <main className="page assembly">
        <header className="cover">
          <CoverBrand to="/" />
          <h1 className="cover__title">この議会はありません</h1>
        </header>
        <section className="section">
          <div className="links">
            <Link to="/assemblies">議会一覧</Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

/** 国会: 議員は既存の一覧へ（議会の絞り込みつき）。参院は記名採決の一覧へ、衆院は個人票が無い事実を1文だけ */
function DietSections({ assembly, data }: { assembly: Assembly; data: Dataset }) {
  const sangiin = assembly.id === "diet-sangiin";
  return (
    <section className="section entry" aria-label="さがす">
      <Link className="entry__link" to={`/members?assembly=${assembly.id}`}>
        {assembly.name}の議員一覧
        <span className="entry__sub">　名前・ふりがな・会派・選挙区でさがす</span>
      </Link>
      {sangiin && data.rollcalls.length > 0 && (
        <Link className="entry__link" to="/rollcalls">
          本会議採決
          <span className="entry__sub">　{data.rollcalls.length.toLocaleString("ja-JP")} 件</span>
        </Link>
      )}
      {!sangiin && <p className="note">衆議院は個人の投票記録が公開されていません。所属会派の態度は「推定」として区別して示します。</p>}
    </section>
  );
}

function LocalSections({ assembly, members, sessions }: { assembly: Assembly; members: MemberSummary[]; sessions: AssemblySession[] | undefined }) {
  const disclosure = disclosureFor(assembly.id);
  const sorted = [...members].sort((a, b) => collator.compare(a.kana, b.kana));
  return (
    <>
      {disclosure && (
        <section className="section" aria-labelledby="assembly-disclosure-heading">
          <h2 id="assembly-disclosure-heading" className="section__title">
            個人別表決の公開状況
          </h2>
          <dl className="assembly-facts">
            <div className="assembly-facts__item">
              <dt>個人別表決</dt>
              <dd>
                {disclosure.status}
                {disclosure.statusNote && `（${disclosure.statusNote}）`}
              </dd>
            </div>
            <div className="assembly-facts__item">
              <dt>形式</dt>
              <dd>{disclosure.format}</dd>
            </div>
            <div className="assembly-facts__item">
              <dt>確認した会期・備考</dt>
              <dd>{disclosure.note}</dd>
            </div>
            <div className="assembly-facts__item">
              <dt>出典</dt>
              <dd>
                <a href={disclosure.sourceUrl} target="_blank" rel="noopener noreferrer">
                  確認したページ
                </a>
                {" ・ "}調査日 <span className="num">{formatDate(VOTE_DISCLOSURE.surveyedAt)}</span>
              </dd>
            </div>
          </dl>
        </section>
      )}

      <section className="section" aria-labelledby="assembly-members-heading">
        <h2 id="assembly-members-heading" className="section__title">
          議員
        </h2>
        {sorted.length === 0 ? (
          <p className="note">取得前です。</p>
        ) : (
          <ul className="assembly-members" aria-label="議員">
            {sorted.map((m) => (
              <li key={m.id} className="assembly-member">
                <Link className="assembly-member__link" to={`/members/${m.id}`}>
                  <span className="assembly-member__kana">{m.kana}</span>
                  <span className="assembly-member__name">{m.name}</span>
                </Link>
                <span className="assembly-member__meta">{[m.group, m.district, m.current === false ? "元職" : undefined].filter(Boolean).join(" ・ ")}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="section" aria-labelledby="assembly-sessions-heading">
        <h2 id="assembly-sessions-heading" className="section__title">
          会期
        </h2>
        {!sessions || sessions.length === 0 ? (
          <p className="note">会期の一覧は未取得です。</p>
        ) : (
          <div className="assemblies-table-wrap">
            <table className="assembly-sessions" aria-label="会期">
              <thead>
                <tr>
                  <th scope="col">会期</th>
                  <th scope="col">議決日</th>
                  <th scope="col">表決</th>
                  <th scope="col">出典</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td>{s.label}</td>
                    <td className="num">
                      <time dateTime={s.date}>{formatDate(s.date)}</time>
                    </td>
                    <td className="num">{s.rollcalls.toLocaleString("ja-JP")} 件</td>
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
    </>
  );
}
