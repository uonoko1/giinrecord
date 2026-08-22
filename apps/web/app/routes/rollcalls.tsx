import { type LoaderFunctionArgs, Link, type MetaArgs, useLoaderData, useNavigate } from "react-router";
import type { DatasetMeta, RollCallSummary } from "../lib/data-contract";
import { defaultDataDir, readMeta, readRollCallIndex } from "../lib/data-files";
import { formatDate, formatDateTime } from "../lib/format";
import { sessionsDesc, sortByDateDesc } from "../lib/rollcall";
import { seoMeta } from "../lib/seo";
import "./rollcall.css";

/* ---------- data (build time only; ssr:false + prerender) ----------
 * `/rollcalls` and `/rollcalls/:session` share this route; both are prerendered
 * (app/lib/prerender.ts), which is what makes a `loader` legal under ssr:false. */

export type RollCallsLoaderData = { rollcalls: RollCallSummary[]; session: number | undefined; meta: DatasetMeta | null };

export async function loader({ params }: LoaderFunctionArgs): Promise<RollCallsLoaderData> {
  const dir = defaultDataDir();
  const [rollcalls, meta] = await Promise.all([readRollCallIndex(dir), readMeta(dir)]);
  const session = params.session === undefined ? undefined : Number(params.session);
  if (session !== undefined && !rollcalls.some((r) => r.session === session)) {
    throw new Response("Not Found", { status: 404 });
  }
  return { rollcalls, session, meta };
}

function pageTitle(session: number | undefined): string {
  return session === undefined ? "本会議採決" : `第${session}回国会の採決`;
}

export function meta({ data, location }: MetaArgs<typeof loader>) {
  if (!data) return [{ title: "議会ログ" }];
  return seoMeta({
    title: pageTitle(data.session),
    description: "参議院本会議の記名投票を日付順に並べます。各採決で全議員の票を会派ごとに見られます。",
    pathname: location.pathname,
  });
}

export default function RollCallsRoute() {
  const { rollcalls, session, meta } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  return (
    <RollCallsPage
      rollcalls={rollcalls}
      session={session}
      meta={meta}
      onSessionChange={(s) => navigate(s === undefined ? "/rollcalls" : `/rollcalls/${s}`)}
    />
  );
}

/* ---------- page ---------- */

export function RollCallsPage({
  rollcalls,
  session,
  onSessionChange,
  meta,
}: {
  rollcalls: RollCallSummary[];
  session: number | undefined;
  onSessionChange: (session: number | undefined) => void;
  meta: DatasetMeta | null;
}) {
  const sessions = sessionsDesc(rollcalls);
  const rows = sortByDateDesc(session === undefined ? rollcalls : rollcalls.filter((r) => r.session === session));

  return (
    <main className="rollcall">
      <header className="rollcall-cover">
        <div className="rollcall-cover-top">
          <Link to="/">← 議会ログ</Link>
        </div>
        <p className="rollcall-date">
          <span>参議院本会議 ・ 記名投票</span>
        </p>
        <h1 className="rollcall-title">{pageTitle(session)}</h1>
      </header>

      <div className="rollcalls-filter">
        <label>
          回次
          <select
            aria-label="回次"
            value={session === undefined ? "" : String(session)}
            onChange={(e) => onSessionChange(e.target.value === "" ? undefined : Number(e.target.value))}
          >
            <option value="">すべて</option>
            {sessions.map((s) => (
              <option key={s} value={String(s)}>
                第{s}回
              </option>
            ))}
          </select>
        </label>
        <span className="rollcalls-count num">{rows.length}件</span>
      </div>

      {rows.length === 0 ? (
        <p className="rollcall-empty">採決はありません。</p>
      ) : (
        <ul className="rollcalls-list">
          {rows.map((r) => (
            <li key={r.id} className="rollcalls-item">
              <Link to={`/rollcalls/${r.session}/${r.id}`}>{r.title}</Link>
              <p className="rollcalls-meta num">
                <time dateTime={r.date}>{formatDate(r.date)}</time>
                {" ・ "}第{r.session}回国会{" ・ "}
                {r.result}
              </p>
            </li>
          ))}
        </ul>
      )}

      <footer className="rollcall-source">
        <p className="num">{meta ? `取得 ${formatDateTime(meta.fetchedAt)}` : "データ未取得"}</p>
        <p>評価・採点はしません。記録をそのまま並べています。</p>
      </footer>
    </main>
  );
}
