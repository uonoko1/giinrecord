import { type LoaderFunctionArgs, Link, type MetaArgs, useLoaderData } from "react-router";
import { SiteFooter } from "../components/SiteFooter";
import { CoverBrand } from "../components/CoverBrand";
import { findAssembly } from "../lib/assemblies";
import type { Assembly, LocalRollCallSummary } from "../lib/data-contract";
import { defaultDataDir, readAssemblies, readLocalRollCallSummaries } from "../lib/data-files";
import { formatDate } from "../lib/format";
import { seoMeta } from "../lib/seo";
import "../styles/pages.css";
import "./assemblies.css";

/* ---------- data (build time only; ssr:false + prerender) ---------- */

export type LocalRollCallsLoaderData = { assembly: Assembly | undefined; rollCalls: LocalRollCallSummary[] };

export async function loader({ params }: LoaderFunctionArgs): Promise<LocalRollCallsLoaderData> {
  const dir = defaultDataDir();
  const assemblyId = params.assemblyId ?? "";
  const [assemblies, rollCalls] = await Promise.all([readAssemblies(dir), readLocalRollCallSummaries(dir, assemblyId)]);
  if (!rollCalls) throw new Response("Not Found", { status: 404 });
  return { assembly: findAssembly(assemblies ?? [], assemblyId), rollCalls };
}

export function meta({ data, location }: MetaArgs<typeof loader>) {
  if (!data) return [{ title: "議員レコード" }];
  const name = data.assembly?.name ?? "議会";
  return seoMeta({
    title: `${name}の本会議表決`,
    description: `${name}の本会議の表決を、議決日・議案名・議決結果と出典つきで並べます。`,
    pathname: location.pathname,
  });
}

export default function LocalRollCallsRoute() {
  const { assembly, rollCalls } = useLoaderData<typeof loader>();
  return <LocalRollCallsPage assembly={assembly} rollCalls={rollCalls} />;
}

/* ---------- page ---------- */

/**
 * 地方議会の表決一覧（#791）。URL は `/assemblies/{assemblyId}/rollcalls`。
 *
 * **国会の `/rollcalls` には混ぜない。** あちらは `/rollcalls/{回次}` と回次の**数**で切る作りで、
 * 地方の会期 id は数ではない（宮城 `398`・佐賀 `2026-06-teirei-list06680`）。混ぜると
 * 「第 2026-06-teirei-list06680 回国会」のような意味の壊れた見出しになる。docs/DATA_CONTRACT.md 参照。
 *
 * **一次資料（`sourceUrl`）の無い行は出さない**（絶対原則）。出さなかった件数はページに書く——
 * 黙って落とすと「その表決は無かった」と読めてしまう。
 */
export function LocalRollCallsPage({ assembly, rollCalls }: { assembly: Assembly | undefined; rollCalls: readonly LocalRollCallSummary[] }) {
  const name = assembly?.name ?? "議会";
  const shown = rollCalls.filter((r) => hasSource(r));
  const omitted = rollCalls.length - shown.length;
  return (
    <>
      <main className="page assembly">
        <header className="cover">
          <CoverBrand to="/" />
          <h1 className="cover__title">{name}の本会議表決</h1>
          <p className="cover__lead" data-testid="local-rollcalls-total">
            {/* #757: 「0 件」と「1 件も読めていない」を同じ出力にしない */}
            {shown.length === 0 ? "表決の記録は取得していません" : <span className="num">{shown.length.toLocaleString("ja-JP")} 件</span>}
          </p>
          {omitted > 0 && (
            <p className="note" data-testid="local-rollcalls-omitted">
              出典の記録が無いため表に出していない行が <span className="num">{omitted.toLocaleString("ja-JP")} 件</span> あります。
            </p>
          )}
          {assembly && (
            <p className="note">
              <Link to={`/assemblies/${assembly.id}`}>{name}のページ</Link>
            </p>
          )}
        </header>

        {shown.length > 0 && (
          <section className="section" aria-labelledby="local-rollcalls-heading">
            <h2 id="local-rollcalls-heading" className="section__title">
              表決
            </h2>
            <div className="assemblies-table-wrap">
              <table className="assembly-sessions" aria-label="表決">
                <thead>
                  <tr>
                    <th scope="col">議決日</th>
                    <th scope="col">議案</th>
                    <th scope="col">会期</th>
                    <th scope="col">結果</th>
                    <th scope="col">出典</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.id}>
                      <td className="num">
                        <time dateTime={r.date}>{formatDate(r.date)}</time>
                      </td>
                      <td>
                        <Link to={`/assemblies/${r.assemblyId}/rollcalls/${r.id}`}>{r.title}</Link>
                        <span className="assemblies-status-note">{[r.kind, r.number].filter(Boolean).join(" ・ ")}</span>
                      </td>
                      <td>{r.sessionLabel}</td>
                      <td>
                        <ResultCell rollCall={r} />
                      </td>
                      <td>
                        <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer">
                          表決結果（公式）
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>
      <SiteFooter />
    </>
  );
}

/**
 * 「結果」列（#1003）。**原文があればそのまま出す。**
 *
 * **一次資料のその欄が空だった行（`resultAbsent: true`。ETL は #901）は、空セルにしない**——
 * 空セルは「県も書いていない」と「こちらの読み取りが壊れた」を同じ見た目にしてしまい、
 * 利用者には**サイトのバグ**にしか見えない。**「記載がありません」は事実なので書ける。**
 * **`counts` から可否を埋めない**（可否を多数決から推論しない。docs/DATA_CONTRACT.md）。
 *
 * **`resultAbsent` の無い空は、今までどおり空のまま**（ETL が違反として弾く形なので、
 * ここで「記載がありません」と書くと読み取り事故を県のせいにしてしまう）。
 */
function ResultCell({ rollCall }: { rollCall: Pick<LocalRollCallSummary, "result" | "resultAbsent"> }) {
  if (rollCall.result !== "") return <>{rollCall.result}</>;
  if (rollCall.resultAbsent !== true) return null;
  return (
    <span className="assemblies-status-note" data-testid="local-rollcalls-result-absent">
      一次資料に記載がありません
    </span>
  );
}

/** 一次資料があるか。**無い行は出さない**（絶対原則。https 以外も出さない）。 */
function hasSource(r: LocalRollCallSummary): boolean {
  return typeof r.sourceUrl === "string" && r.sourceUrl.startsWith("https://");
}
