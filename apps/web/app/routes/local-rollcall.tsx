import type { ReactNode } from "react";
import { type LoaderFunctionArgs, Link, type MetaArgs, useLoaderData } from "react-router";
import { SourceLine } from "../components";
import { SiteFooter } from "../components/SiteFooter";
import { findAssembly, localVoteTone } from "../lib/assemblies";
import type { Assembly, LocalAssemblyMeta, LocalRollCall, LocalVote } from "../lib/data-contract";
import { defaultDataDir, readAssemblies, readLocalAssemblyMeta, readLocalRollCall } from "../lib/data-files";
import { formatDate, formatDateTime } from "../lib/format";
import { seoMeta } from "../lib/seo";
import "./rollcall.css";

/* ---------- data (build time only; ssr:false + prerender) ---------- */

type Vote = LocalRollCall["votes"][number];

export type LocalRollCallLoaderData = { rollCall: LocalRollCall; assembly: Assembly | undefined; meta: LocalAssemblyMeta | null };

export async function loader({ params }: LoaderFunctionArgs): Promise<LocalRollCallLoaderData> {
  const dir = defaultDataDir();
  const assemblyId = params.assemblyId ?? "";
  const [rollCall, assemblies, meta] = await Promise.all([readLocalRollCall(dir, assemblyId, params.id ?? ""), readAssemblies(dir), readLocalAssemblyMeta(dir, assemblyId)]);
  if (!rollCall) throw new Response("Not Found", { status: 404 });
  return { rollCall, assembly: findAssembly(assemblies ?? [], assemblyId), meta };
}

export function meta({ data, location }: MetaArgs<typeof loader>) {
  if (!data) return [{ title: "議員レコード" }];
  const { rollCall, assembly } = data;
  const name = assembly?.name ?? rollCall.assemblyId;
  // 事実だけ（#791）。賛成率のような集計・評価は書かない。
  // **空の欄は落とす**（#1003）。滋賀は 163 件すべて `number` が空で、素朴につなぐと
  // `（令和8年 4月招集会議・・可決）` のように中黒が 2 つ続く文字列が検索結果に出ていた（PO が本番で確認）。
  const fields = [rollCall.sessionLabel, rollCall.number, resultTextForMeta(rollCall)].filter((s) => s !== "");
  return seoMeta({
    title: rollCall.title,
    description: `${formatDate(rollCall.date)} ${name}本会議の表決（${fields.join("・")}）。各議員の表決を、表決結果の原文と凡例のまま、出典付きで並べます。`,
    pathname: location.pathname,
    type: "article",
  });
}

/**
 * description に書く議決結果（#1003）。**原文があればそのまま**、
 * **一次資料のその欄が空（`resultAbsent: true`）なら「議決結果の記載なし」**、
 * **`resultAbsent` の無い空**（本来 ETL が違反として弾く形）は**何も書かない**——
 * 「読めなかった」を「県が書いていない」と言い換えない（#569）。
 * **`counts` から「可決」を埋めない**（可否を多数決から推論しない。docs/DATA_CONTRACT.md）。
 */
export function resultTextForMeta(rollCall: Pick<LocalRollCall, "result" | "resultAbsent">): string {
  if (rollCall.result !== "") return rollCall.result;
  return rollCall.resultAbsent === true ? "議決結果の記載なし" : "";
}

export default function LocalRollCallRoute() {
  const { rollCall, assembly, meta } = useLoaderData<typeof loader>();
  return <LocalRollCallPage rollCall={rollCall} assembly={assembly} meta={meta} />;
}

/* ---------- page ---------- */

/**
 * 地方議会の表決 1 件（#791）。URL は `/assemblies/{assemblyId}/rollcalls/{id}`
 * （国会の `/rollcalls/{回次}/{id}` とは分ける。地方の会期 id は回次の数ではない。docs/DATA_CONTRACT.md）。
 *
 * **出すのは事実だけ**: 議案名・議決日・会期・議案番号・議決結果・各議員の表決（セルの原文と凡例）・一次資料。
 * **集計しない・順位をつけない・賛成率を出さない。** 人数は PDF の公表値（`counts`）だけを出し、
 * `votes` から数え直さない（公表値が無い議会では「公表記録にありません」と書く。#757）。
 */
export function LocalRollCallPage({ rollCall, assembly, meta }: { rollCall: LocalRollCall; assembly: Assembly | undefined; meta: LocalAssemblyMeta | null }) {
  const name = assembly?.name ?? rollCall.assemblyId;
  const groups = groupVotes(rollCall.votes);
  return (
    <>
      <main className="rollcall">
        <header className="rollcall-cover">
          <div className="rollcall-cover-top">
            <Link to="/">← 議員レコード</Link>
            <Link to={`/assemblies/${rollCall.assemblyId}/rollcalls`}>{name}の採決</Link>
          </div>
          <p className="rollcall-date">
            <time className="num" dateTime={rollCall.date}>
              {formatDate(rollCall.date)}
            </time>
            <span>
              {name}本会議 ・ {rollCall.sessionLabel}
            </span>
          </p>
          <h1 className="rollcall-title">{rollCall.title}</h1>
          <p className="rollcall-note">
            {[rollCall.kind, rollCall.number, rollCall.method?.raw, rollCall.result].filter(Boolean).join(" ・ ")}
          </p>
          <ResultAbsentNote rollCall={rollCall} />
          {/* #204: 請願・陳情の ○ は委員長報告への賛成であって採択への賛成ではない。原文をそのまま添える */}
          {(rollCall.voteSubject || rollCall.committeeReport) && (
            <p className="rollcall-note">{[rollCall.voteSubject, rollCall.committeeReport && `委員長報告 ${rollCall.committeeReport}`].filter(Boolean).join(" ・ ")}</p>
          )}
          {rollCall.referredCommittees && rollCall.referredCommittees.length > 0 && <p className="rollcall-note">付託委員会 {rollCall.referredCommittees.join(" ・ ")}</p>}
          <Counts counts={rollCall.counts} />
          <p className="rollcall-note">判の文字は表決結果の原文です。凡例で意味の読めない記号は、賛成・反対に置き換えません。</p>
        </header>

        {groups.length === 0 ? (
          <p className="rollcall-empty">個人別の表決はありません。</p>
        ) : (
          groups.map((g, gi) => (
            <GroupSection key={`${g.name}-${gi}`} id={`group-${gi}`} name={g.name} votes={g.votes}>
              {g.votes.length}名
            </GroupSection>
          ))
        )}

        <SourceLine sourceUrl={rollCall.sourceUrl} sourceName={`${name} 表決結果（${rollCall.page} ページ目）`} fetchedAt={meta?.fetchedAt ? formatDateTime(meta.fetchedAt) : "未取得"} />
      </main>
      <SiteFooter />
    </>
  );
}

/**
 * **一次資料の議決結果の欄が空だったこと**（#1003 / ETL 側は #901）。
 *
 * **「書かれていない」と「読めなかった」を画面で分ける。** 直すまでは議決結果が**空セル**で出ていて、
 * 利用者には**サイトのバグ**にしか見えず、一次資料に当たっても「県も書いていない」ことが分からなかった。
 *
 * **書くのは「県の公表物を見れば確かめられる事実」だけ**——「一次資料のその欄が空」。
 * **`counts` はあるが「賛成多数だから可決」とは書かない**
 * （可否を多数決から推論しない。docs/DATA_CONTRACT.md）。推論した文字列を出せば、
 * 利用者からは「県がそう書いた」と見分けがつかない（#569）。
 *
 * **我々が何をしなかったかは、ここに書かない**（#1003 の PO 判断）。
 * 「人数から可否を補っていません」は**実装の説明であって一次資料の事実ではない**——
 * 利用者が知りたいのは「県が何を書いたか」で、「我々が何をしなかったか」ではない。
 * 書き始めると際限がない（「推測していません」「他の資料も当たっていません」…）。
 * **`counts` が出ているのに結果が空である理由**は、**`・・` が出ていた 174 ページに毎回ではなく
 * `/about` か `/coverage` に一度だけ書く**（別 PBI）。
 *
 * **この 174 は `number` が空で `・・` が出ていたページの数**（#1011 の実測。議会ごとに
 * `pref-02: 2 / pref-04: 4 / pref-05: 2 / pref-25: 163 / pref-31: 3` で計 174）。
 * **`resultAbsent` を持つ採決の数（3 件、すべて滋賀）とは別の母数である。**
 * **`・・` は `number` が空なら `resultAbsent` と無関係に出る**ので、滋賀以外の 4 議会にも出ていた。
 *
 * **PO が 2026-09-24 に、この 2 つを取り違えて「174 は誤り」と撤回しかけた**
 * （レビューで止まった。#1025 / #1026）。**数を書くときは、どちらの母数かを必ず添えること。**
 *
 * **`resultAbsent` の無い空の `result`（読み取り事故）には出さない。** ETL が今までどおり違反として弾く形なので、
 * ここで「記載なし」と書くと事故を県のせいにしてしまう。
 */
function ResultAbsentNote({ rollCall }: { rollCall: Pick<LocalRollCall, "result" | "resultAbsent"> }) {
  if (rollCall.result !== "" || rollCall.resultAbsent !== true) return null;
  return (
    <p className="rollcall-note" data-testid="local-rollcall-result-absent">
      議決結果は、一次資料（表決結果）の欄が空のため記載がありません。
    </p>
  );
}

/**
 * 公表された人数（#757）。**`votes` から数え直さない。**
 * 公表していない議会（徳島・奈良・島根）では「公表記録にありません」と書く——
 * 自分で数えた値を出すと、公表値と数え直した値の区別がつかなくなる。
 */
function Counts({ counts }: { counts: LocalRollCall["counts"] }) {
  if (!counts) {
    return (
      <p className="rollcall-tally" data-testid="local-rollcall-counts">
        人数は公表記録にありません
      </p>
    );
  }
  const parts = [counts.present !== undefined ? `出席者数 ${counts.present}` : null, counts.voting !== undefined ? `表決者数 ${counts.voting}` : null, `賛成 ${counts.yes}`, `反対 ${counts.no}`].filter(Boolean);
  return (
    <p className="rollcall-tally num" data-testid="local-rollcall-counts">
      {parts.join(" ・ ")}
    </p>
  );
}

/** 会派ごとに、**表決結果の原文の並びのまま**まとめる（人数で並べ替えない＝公表記録の順を変えない）。 */
export function groupVotes(votes: readonly Vote[]): { name: string; votes: Vote[] }[] {
  const out: { name: string; votes: Vote[] }[] = [];
  const byName = new Map<string, { name: string; votes: Vote[] }>();
  for (const v of votes) {
    const name = v.group || "会派の記載がありません";
    let g = byName.get(name);
    if (!g) {
      g = { name, votes: [] };
      byName.set(name, g);
      out.push(g);
    }
    g.votes.push(v);
  }
  return out;
}

function GroupSection({ id, name, votes, children }: { id: string; name: string; votes: Vote[]; children: ReactNode }) {
  return (
    <section className="rollcall-group" aria-labelledby={id}>
      <h2 id={id} className="rollcall-group-name">
        {name}
      </h2>
      <p className="rollcall-group-tally num">{children}</p>
      <ul className="rollcall-votes">
        {votes.map((v, i) => (
          <li key={`${v.memberId || v.nameText}-${i}`} className="rollcall-vote">
            <LocalStamp vote={v.value} />
            {v.memberId ? <Link to={`/members/${v.memberId}`}>{v.nameText}</Link> : <span>{v.nameText}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 地方議会の表決の判。文字はセルの原文、読み上げは「原文（凡例）」。色は mapped のある値だけ。 */
function LocalStamp({ vote }: { vote: LocalVote }) {
  return (
    <span className="member-stamp" data-tone={localVoteTone(vote)} role="img" aria-label={`${vote.raw}（${vote.legend}）`}>
      {vote.raw}
    </span>
  );
}
