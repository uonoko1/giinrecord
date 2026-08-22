import { type LoaderFunctionArgs, Link, type MetaArgs, useLoaderData } from "react-router";
import { SourceLine, Stamp } from "../components";
import type { DatasetMeta, RollCall } from "../lib/data-contract";
import { defaultDataDir, readMeta, readRollCall } from "../lib/data-files";
import { formatDate, groupsBySize, votesByGroup } from "../lib/rollcall";
import "./rollcall.css";

/* ---------- data (build time only; ssr:false + prerender) ----------
 * routes.ts registers this route only when data/rollcalls/index.json exists (a `loader`
 * under ssr:false is valid only on prerendered routes), so argument types are declared by hand. */

export type RollCallLoaderData = { rollCall: RollCall; meta: DatasetMeta | null };

export async function loader({ params }: LoaderFunctionArgs): Promise<RollCallLoaderData> {
  const dir = defaultDataDir();
  const [rollCall, meta] = await Promise.all([readRollCall(dir, params.session ?? "", params.id ?? ""), readMeta(dir)]);
  if (!rollCall) throw new Response("Not Found", { status: 404 });
  return { rollCall, meta };
}

export function meta({ data }: MetaArgs<typeof loader>) {
  if (!data) return [{ title: "政治記録" }];
  const { rollCall } = data;
  return [
    { title: `${rollCall.title} ・ 政治記録` },
    {
      name: "description",
      content: `${formatDate(rollCall.date)} 参議院本会議の記名投票。${tallyText(rollCall)}。全議員の票を会派ごとに、出典付きで並べます。`,
    },
  ];
}

export default function RollCallRoute() {
  const { rollCall, meta } = useLoaderData<typeof loader>();
  return <RollCallPage rollCall={rollCall} meta={meta} />;
}

/* ---------- page ---------- */

const SOURCE_NAME = "参議院 本会議投票結果";

function tallyText(rc: RollCall): string {
  return `賛成 ${rc.totals.yes} ・ 反対 ${rc.totals.no} ・ 投票総数 ${rc.totals.total}`;
}

export function RollCallPage({ rollCall, meta }: { rollCall: RollCall; meta: DatasetMeta | null }) {
  const groups = groupsBySize(rollCall.groups);
  const votes = votesByGroup(rollCall.votes);
  return (
    <main className="rollcall">
      <header className="rollcall-cover">
        <div className="rollcall-cover-top">
          <Link to="/">← 政治記録</Link>
          <Link to={`/rollcalls/${rollCall.session}`}>第{rollCall.session}回国会の採決</Link>
        </div>
        <p className="rollcall-date">
          <time className="num" dateTime={rollCall.date}>
            {formatDate(rollCall.date)}
          </time>
          <span>参議院本会議 ・ 記名投票</span>
        </p>
        <h1 className="rollcall-title">{rollCall.title}</h1>
        <p className="rollcall-tally num">{tallyText(rollCall)}</p>
        <p className="rollcall-note">「投票なし」は欠席と棄権を区別しません（公式記録に理由は載りません）。</p>
      </header>

      {groups.length === 0 ? (
        <p className="rollcall-empty">個人別の票はありません。</p>
      ) : (
        groups.map((g) => (
          <section key={g.group} className="rollcall-group" aria-labelledby={`group-${g.group}`}>
            <h2 id={`group-${g.group}`} className="rollcall-group-name">
              {g.group}
            </h2>
            <p className="rollcall-group-tally num">
              {g.size}名 ・ 賛成 {g.yes} ・ 反対 {g.no}
            </p>
            <ul className="rollcall-votes">
              {(votes.get(g.group) ?? []).map((v, i) => (
                <li key={`${v.memberId || v.nameText}-${i}`} className="rollcall-vote">
                  <Stamp value={v.value} />
                  {v.memberId ? <Link to={`/members/${v.memberId}`}>{v.nameText}</Link> : <span>{v.nameText}</span>}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      <SourceLine sourceUrl={rollCall.sourceUrl} sourceName={SOURCE_NAME} fetchedAt={meta?.fetchedAt ?? "未取得"} />
    </main>
  );
}
