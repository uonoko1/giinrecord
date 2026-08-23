import { Link, type MetaArgs } from "react-router";
import type { Assembly } from "@seiji-kiroku/shared";
import { CoverBrand } from "../components/CoverBrand";
import { SiteFooter } from "../components/SiteFooter";
import { assemblyPath, DISCLOSURE_STATUSES, type DisclosureStatus, VOTE_DISCLOSURE, type VoteDisclosureRow } from "../lib/assemblies";
import { DIET_ASSEMBLIES } from "../lib/data-contract";
import { type Dataset, dataset as bundled } from "../lib/dataset";
import { formatDate } from "../lib/format";
import { memberAssemblyId } from "../lib/member-search";
import { seoMeta } from "../lib/seo";
import "../styles/pages.css";
import "./assemblies.css";

const DESCRIPTION = "参議院・衆議院と地方議会の一覧。各議会が議員ごとの表決をどの形で公開しているかを、確認したページの出典つきで並べます。評価はしません。";

export function meta({ location }: MetaArgs) {
  return seoMeta({ title: "議会一覧", description: DESCRIPTION, pathname: location.pathname });
}

/** 調査の 4 値の定義（docs/research/local-assemblies.md の表をそのまま）。評価語は入れない */
const STATUS_MEANING: Record<DisclosureStatus, string> = {
  公開: "議員の氏名ごとに賛否（○×など）が載る一次資料を確認した",
  会派別: "会派（および無所属議員）ごとの賛否だけを確認した。個人票は無い",
  総数のみ: "議案ごとの結果（可決・同意…）や件数だけ。賛否の内訳は無い",
  不明: "1〜2 ページの範囲で賛否の資料に到達できなかった。無いとは言っていない",
};

const KIND_LABEL = { prefectural: "都道府県議会", municipal: "政令指定都市議会" } as const;

/**
 * /assemblies: このサイトにある議会（assemblies/index.json。無ければ国会の2議会）と、
 * 47 都道府県 + 20 政令市の「個人別表決の公開状況」（#128 の調査表）。どちらも事実としてそのまま並べる。
 */
export default function Assemblies({ data = bundled }: { data?: Dataset }) {
  const assemblies: readonly Assembly[] = data.assemblies ?? DIET_ASSEMBLIES;
  const known = new Set(assemblies.map((a) => a.id));
  const memberCount = new Map<string, number>();
  for (const m of data.members) {
    const id = memberAssemblyId(m);
    memberCount.set(id, (memberCount.get(id) ?? 0) + 1);
  }

  return (
    <>
      <main className="page assemblies">
        <header className="cover">
          <CoverBrand to="/" />
          <h1 className="cover__title">議会</h1>
          <p className="cover__lead">{DESCRIPTION}</p>
        </header>

        <section className="section" aria-labelledby="assemblies-list-heading">
          <h2 id="assemblies-list-heading" className="section__title">
            このサイトにある議会
          </h2>
          <ul className="list" aria-label="このサイトにある議会">
            {assemblies.map((a) => (
              <li key={a.id} className="list__item">
                <Link to={assemblyPath(a.id)}>{a.name}</Link>
                <div className="list__meta">
                  {a.kind === "national" ? "国会" : KIND_LABEL[a.kind]}
                  {" ・ "}
                  <b className="num">{(memberCount.get(a.id) ?? 0).toLocaleString("ja-JP")} 名</b>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="section" aria-labelledby="disclosure-heading">
          <h2 id="disclosure-heading" className="section__title">
            個人別表決の公開状況（47 都道府県・20 政令市）
          </h2>
          <p className="note">
            各議会のサイトで実際に確認できたことだけを書いています（Issue #{VOTE_DISCLOSURE.issue} の調査、調査日 {formatDate(VOTE_DISCLOSURE.surveyedAt)}）。
            確認できなかった欄は「不明」です。
          </p>
          <dl className="assemblies-legend">
            {DISCLOSURE_STATUSES.map((s) => (
              <div key={s} className="assemblies-legend__item">
                <dt>{s}</dt>
                <dd>{STATUS_MEANING[s]}</dd>
              </div>
            ))}
          </dl>
          {(["prefectural", "municipal"] as const).map((kind) => (
            <DisclosureTable key={kind} caption={KIND_LABEL[kind]} rows={VOTE_DISCLOSURE.rows.filter((r) => r.kind === kind)} known={known} />
          ))}
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

function DisclosureTable({ caption, rows, known }: { caption: string; rows: VoteDisclosureRow[]; known: ReadonlySet<string> }) {
  return (
    <div className="assemblies-table-wrap">
      <table className="assemblies-table">
        <caption>個人別表決の公開状況 ・ {caption}</caption>
        <thead>
          <tr>
            <th scope="col">議会</th>
            <th scope="col">個人別表決</th>
            <th scope="col">形式</th>
            <th scope="col">出典</th>
            <th scope="col">確認した会期・備考</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.assemblyId}>
              <th scope="row">{known.has(r.assemblyId) ? <Link to={assemblyPath(r.assemblyId)}>{r.label}</Link> : r.label}</th>
              <td>
                <span className="assemblies-status" data-status={r.status}>
                  {r.status}
                </span>
                {r.statusNote && <span className="assemblies-status-note">（{r.statusNote}）</span>}
              </td>
              <td>{r.format}</td>
              <td>
                <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer">
                  確認したページ
                </a>
              </td>
              <td className="assemblies-note">{r.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
