/**
 * /compare?m=id1,id2（最大4名、Issue #104）: 同じ採決・議案に対する複数議員の記録を横並びで見る。
 *
 * クエリ依存なのでプリレンダリングしない（SPA fallback で動く）。検索エンジンには noindex。
 * 議員の JSON はビルド時にバンドルせず（772 人分を1チャンクにはできない）、ビルドが build/client/data/members/
 * にコピーしたものを実行時に fetch する（scripts/copy-member-data.ts。nginx は /data/ を 1h キャッシュで配信）。
 * 一致率・スコア・おすすめは出さない。判は既存の Stamp、推定は est の判。
 */
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Stamp } from "../components";
import { SiteFooter } from "../components/SiteFooter";
import { COMPARE_MAX, type CompareRows, alignTimelines, parseCompareIds, readStoredCompareIds } from "../lib/compare";
import type { DatasetMeta, MemberDetail, StanceEntry } from "../lib/data-contract";
import { dataset } from "../lib/dataset";
import { formatDate, formatDateTime } from "../lib/format";
import { SITE_NAME } from "../lib/seo";
import "./compare.css";
import { membersSources } from "../lib/member-sources";

export const TITLE = "議員の記録を並べる";

/** クエリ依存のページなので canonical も OGP も付けず、noindex だけを出す。 */
export function meta() {
  return [
    { title: `${TITLE} ・ ${SITE_NAME}` },
    { name: "robots", content: "noindex" },
    { name: "description", content: "複数の国会議員について、同じ採決・議案に対する記録を横に並べます。評価や集計はしません。" },
  ];
}

export function memberDataUrl(id: string): string {
  return `/data/members/${encodeURIComponent(id)}.json`;
}

async function fetchMemberDetail(id: string): Promise<MemberDetail | null> {
  const res = await fetch(memberDataUrl(id));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${memberDataUrl(id)}: HTTP ${res.status}`);
  return (await res.json()) as MemberDetail;
}

export default function CompareRoute() {
  const [params] = useSearchParams();
  const fromQuery = parseCompareIds(params.get("m"));
  // ?m が無ければ議員ページで「比較に追加」した保存リスト（localStorage）を使う。
  const ids = fromQuery.length > 0 ? fromQuery : readStoredCompareIds();
  return <ComparePage ids={ids} load={fetchMemberDetail} meta={dataset.meta ?? null} />;
}

/* ---------- page ---------- */

type Loaded = { members: MemberDetail[]; missing: string[] };
type State = { status: "loading" } | { status: "error"; message: string } | ({ status: "ready" } & Loaded);

export function ComparePage({ ids, load, meta }: { ids: string[]; load: (id: string) => Promise<MemberDetail | null>; meta: DatasetMeta | null }) {
  const key = ids.join(",");
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    Promise.all(ids.map((id) => load(id).then((m) => [id, m] as const)))
      .then((pairs) => {
        if (cancelled) return;
        const members = pairs.map(([, m]) => m).filter((m): m is MemberDetail => m !== null);
        const missing = pairs.filter(([, m]) => m === null).map(([id]) => id);
        setState({ status: "ready", members, missing });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
    // ids は配列なので文字列化したキーで比較する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, load]);

  return (
    <>
      <main className="compare">
        <header className="compare-cover">
          <p className="compare-cover-top">
            <Link to="/">← 議員レコード</Link>
          </p>
          <h1 className="compare-title">{TITLE}</h1>
          <p className="compare-lead">同じ採決・議案に対する記録を、議員ごとに横へ並べます。記録をそのまま置くだけで、評価や集計はしません。</p>
        </header>
        {state.status === "loading" ? (
          <p className="compare-empty">読み込み中…</p>
        ) : state.status === "error" ? (
          <p className="compare-empty">記録を読み込めませんでした（{state.message}）。</p>
        ) : (
          <Body members={state.members} missing={state.missing} />
        )}
        <Footer meta={meta} members={state.status === "ready" ? state.members : []} />
      </main>
      <SiteFooter />
    </>
  );
}

function Body({ members, missing }: Loaded) {
  const rows = alignTimelines(members);
  return (
    <>
      {missing.length > 0 && <p className="compare-note">{missing.join("、")} の記録は見つかりません。</p>}
      {members.length === 0 ? (
        <p className="compare-empty">
          並べる議員がいません。議員ページの「比較に追加」で最大{COMPARE_MAX}名まで選ぶか、
          <code>/compare?m=id1,id2</code> の形で指定してください。<Link to="/members">議員一覧へ</Link>
        </p>
      ) : members.length === 1 ? (
        <p className="compare-empty">
          <Link to={`/members/${members[0]!.id}`}>{members[0]!.name}</Link> だけが選ばれています。並べるにはもう1名以上を「比較に追加」してください。
          <Link to="/members">議員一覧へ</Link>
        </p>
      ) : (
        <Tables rows={rows} />
      )}
    </>
  );
}

const HOUSE_LABEL = { sangiin: "参議院", shugiin: "衆議院" } as const;

function Tables({ rows }: { rows: CompareRows }) {
  const hasSangiin = rows.columns.some((c) => c.house === "sangiin");
  const hasShugiin = rows.columns.some((c) => c.house === "shugiin");
  const mixed = hasSangiin && hasShugiin;
  return (
    <>
      {hasSangiin && (
        <section className="compare-section">
          {mixed && <h2 className="compare-kind">事実</h2>}
          <p className="compare-note">
            参議院本会議の記名投票。{mixed && "衆議院は個人の投票記録が公開されていないため、衆院議員の列は「記録なし」になります。"}
            「投票なし」は欠席と棄権を区別しません。
          </p>
          {rows.facts.length === 0 ? (
            <p className="compare-empty">2名以上に記録のある採決はありません。</p>
          ) : (
            <FactTable rows={rows} />
          )}
          <UnsharedNote rows={rows} />
        </section>
      )}
      {hasShugiin && (
        <section className="compare-section">
          {mixed && <h2 className="compare-kind">推定</h2>}
          <p className="compare-note compare-note-est">
            衆議院は個人の投票記録が公開されていません。所属会派が議案情報の賛成会派・反対会派に載っていたことを「会派の態度（推定）」として示します。本人の投票ではありません。
            <a href="/about#facts-heading">記録の範囲について</a>
          </p>
          {rows.estimated.length === 0 ? (
            <p className="compare-empty">2名以上の会派の態度を並べられる議案はありません。</p>
          ) : (
            <EstimatedTable rows={rows} />
          )}
        </section>
      )}
    </>
  );
}

function ColumnHeads({ rows }: { rows: CompareRows }) {
  return (
    <>
      {rows.columns.map((c) => (
        <th key={c.id} scope="col">
          <Link to={`/members/${c.id}`}>{c.name}</Link>
          <span className="compare-house">{HOUSE_LABEL[c.house]}</span>
        </th>
      ))}
    </>
  );
}

function FactTable({ rows }: { rows: CompareRows }) {
  return (
    <div className="compare-table-wrap">
      <table className="compare-table" aria-label="採決（事実）">
        <thead>
          <tr>
            <th scope="col">案件</th>
            <ColumnHeads rows={rows} />
            <th scope="col">出典</th>
          </tr>
        </thead>
        <tbody>
          {rows.facts.map((r) => {
            const source = r.cells.find((c) => c !== null)?.sourceUrl;
            return (
              <tr key={r.id}>
                <th scope="row">
                  <time className="num" dateTime={r.date}>
                    {formatDate(r.date)}
                  </time>
                  <span className="compare-case">{r.title}</span>
                  <span className="compare-result">{r.result}</span>
                </th>
                {r.cells.map((c, i) => (
                  <td key={rows.columns[i]!.id}>
                    {c ? (
                      <>
                        <Stamp value={c.value} />
                        {c.groupValue && c.groupValue !== c.value && <span className="compare-cell-note">会派は{c.groupValue}</span>}
                      </>
                    ) : (
                      <span className="compare-none">記録なし</span>
                    )}
                  </td>
                ))}
                <td>{source && <ExternalLink href={source}>参院投票結果</ExternalLink>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EstimatedTable({ rows }: { rows: CompareRows }) {
  return (
    <div className="compare-table-wrap">
      <table className="compare-table" aria-label="会派の態度（推定）">
        <thead>
          <tr>
            <th scope="col">議案</th>
            <ColumnHeads rows={rows} />
            <th scope="col">出典</th>
          </tr>
        </thead>
        <tbody>
          {rows.estimated.map((r) => {
            const source = r.cells.find((c) => c !== null)?.sourceUrl;
            return (
              <tr key={r.id}>
                <th scope="row">
                  <time className="num" dateTime={r.date}>
                    {formatDate(r.date)}
                  </time>
                  <span className="compare-case">{r.title}</span>
                </th>
                {r.cells.map((c, i) => (
                  <td key={rows.columns[i]!.id}>
                    {c ? (
                      <>
                        <EstStamp stance={c.stance} />
                        <span className="compare-cell-note">{c.group}</span>
                        <span className="compare-cell-note">会派態度 {c.stanceText}</span>
                      </>
                    ) : (
                      <span className="compare-none">記録なし</span>
                    )}
                  </td>
                ))}
                <td>{source && <ExternalLink href={source}>議案情報</ExternalLink>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 行にならなかった採決（他の誰にも記録が無い）の数。隠さず件数として残す。 */
function UnsharedNote({ rows }: { rows: CompareRows }) {
  const parts = rows.columns
    .map((c, i) => ({ c, n: rows.unsharedVotes[i] ?? 0 }))
    .filter(({ c, n }) => c.house === "sangiin" && n > 0);
  if (parts.length === 0) return null;
  return (
    <ul className="compare-unshared">
      {parts.map(({ c, n }) => (
        <li key={c.id}>
          {c.name}：他の人に記録のない採決 {n.toLocaleString("ja-JP")} 件（<Link to={`/members/${c.id}`}>議員ページ</Link>に載っています）
        </li>
      ))}
    </ul>
  );
}

/** 推定の判。賛成・反対で色を変えない（tokens の est）。aria-label にも「推定」を入れる。 */
function EstStamp({ stance }: { stance: StanceEntry["stance"] }) {
  return (
    <span className="compare-est" role="img" aria-label={`会派の態度（推定）: ${stance}`}>
      {stance}
    </span>
  );
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/**
 * 出典は**並べている議員が実際に使うものだけ**（#353、#339 と同じ考え方）。
 * 誰も選んでいなければ出典の行そのものを出さない——記録が1行も無いのに
 * 「出典」と称するリンクを33本並べるのは、全行に一次資料を付けるという約束に反する。
 */
function Footer({ meta, members }: { meta: DatasetMeta | null; members: MemberDetail[] }) {
  const sources = membersSources(meta?.sources ?? [], members.map((detail) => ({ detail })));
  return (
    <footer className="compare-source">
      {sources.length > 0 && (
      <p>
        出典：
        {sources.map((s, i) => (
          <span key={s.url}>
            {i > 0 && " ・ "}
            <ExternalLink href={s.url}>{s.name}</ExternalLink>
          </span>
        ))}
      </p>
      )}
      <p className="num">{meta ? `取得 ${formatDateTime(meta.fetchedAt)}` : "データ未取得"}</p>
      <p>評価はしません。記録をそのまま並べています。</p>
    </footer>
  );
}
