import { useState } from "react";
import { type LoaderFunctionArgs, type MetaArgs, useLoaderData } from "react-router";
import type { BillEntry, BillRole, DatasetMeta, MemberDetail, TimelineEntry, VoteEntry } from "../lib/data-contract";
import { defaultDataDir, readMemberDetail, readMeta } from "../lib/data-files";
import { formatDate, formatDateTime, formatYearMonth } from "../lib/format";
import "./member.css";

/* ---------- data (runs at build time only; ssr:false + prerender) ----------
 * routes.ts registers this route only when data/ exists, because under ssr:false a
 * `loader` is valid only on routes that are actually prerendered. The generated
 * `./+types/member` therefore cannot be relied on; argument types are declared by hand. */

export type MemberLoaderData = { detail: MemberDetail; meta: DatasetMeta | null };

export async function loader({ params }: LoaderFunctionArgs): Promise<MemberLoaderData> {
  const dir = defaultDataDir();
  const [detail, meta] = await Promise.all([readMemberDetail(dir, params.id ?? ""), readMeta(dir)]);
  if (!detail) throw new Response("Not Found", { status: 404 });
  return { detail, meta };
}

export function meta({ data }: MetaArgs<typeof loader>) {
  if (!data) return [{ title: "政治記録" }];
  const { detail } = data;
  return [
    { title: `${detail.name} ・ 政治記録` },
    { name: "description", content: `${affiliation(detail)}。本会議の採決・提出法案・発言を公式記録から出典付きで並べます。` },
  ];
}

export default function MemberRoute() {
  const loaderData = useLoaderData<typeof loader>();
  return <MemberPage detail={loaderData.detail} meta={loaderData.meta} />;
}

/* ---------- page ---------- */

type Tab = "all" | "vote" | "bill" | "speech";
const TABS: { id: Tab; label: string }[] = [
  { id: "all", label: "すべて" },
  { id: "vote", label: "採決" },
  { id: "bill", label: "提出法案" },
  { id: "speech", label: "発言" },
];

const HOUSE_LABEL = { sangiin: "参議院", shugiin: "衆議院" } as const;

export function MemberPage({ detail, meta }: { detail: MemberDetail; meta: DatasetMeta | null }) {
  const [tab, setTab] = useState<Tab>("all");
  const entries = tab === "all" ? detail.timeline : detail.timeline.filter((e) => e.kind === tab);
  const counts = countKinds(detail.timeline);

  return (
    <main className="member">
      <Cover detail={detail} counts={counts} />
      <div className="member-tabs" role="tablist" aria-label="記録の種類">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="member-records"
            className="member-tab"
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <section id="member-records" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {entries.length === 0 ? (
          <p className="member-empty">記録はありません。</p>
        ) : tab === "vote" ? (
          <VoteTable votes={entries.filter((e): e is VoteEntry => e.kind === "vote")} />
        ) : tab === "bill" ? (
          <BillTable bills={entries.filter((e): e is BillEntry => e.kind === "bill")} />
        ) : (
          <Timeline entries={entries} />
        )}
      </section>
      <SourceLine meta={meta} />
    </main>
  );
}

/* ---------- cover ---------- */

function currentTerm(detail: MemberDetail) {
  return detail.terms.find((t) => !t.to) ?? detail.terms[detail.terms.length - 1];
}

function affiliation(detail: MemberDetail): string {
  const term = currentTerm(detail);
  return [HOUSE_LABEL[detail.house], term?.district, term?.group].filter(Boolean).join(" ・ ");
}

function Cover({ detail, counts }: { detail: MemberDetail; counts: Record<TimelineEntry["kind"], number> }) {
  const term = currentTerm(detail);
  return (
    <header className="member-cover">
      <div className="member-cover-top">
        <a href="/">← 政治記録</a>
      </div>
      <p className="member-kana">{detail.kana}</p>
      <h1 className="member-name">{detail.name}</h1>
      <p className="member-affil">{affiliation(detail)}</p>
      {term?.to && <p className="member-term num">任期満了 {formatYearMonth(term.to)}</p>}
      <dl className="member-counts">
        <Count n={counts.vote} label="記名採決" />
        <Count n={counts.bill} label="提出法案" />
        <Count n={counts.speech} label="本会議発言" />
      </dl>
      <p className="member-profile">
        <ExternalLink href={detail.sourceUrl}>議員プロフィール（公式）</ExternalLink>
      </p>
    </header>
  );
}

function Count({ n, label }: { n: number; label: string }) {
  return (
    <div className="member-count">
      <dt>{label}</dt>
      <dd className="num">{n.toLocaleString("ja-JP")}</dd>
    </div>
  );
}

function countKinds(timeline: TimelineEntry[]) {
  const c = { vote: 0, bill: 0, speech: 0 };
  for (const e of timeline) c[e.kind] += 1;
  return c;
}

/* ---------- timeline ---------- */

function Timeline({ entries }: { entries: TimelineEntry[] }) {
  const groups = groupByDate(entries);
  return (
    <div className="member-timeline">
      {groups.map(([date, rows]) => (
        <section key={date} className="member-day">
          <DateHeading date={date} />
          <ul className="member-rows">
            {rows.map((e) => (
              <Row key={entryKey(e)} entry={e} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function groupByDate(entries: TimelineEntry[]): [string, TimelineEntry[]][] {
  const map = new Map<string, TimelineEntry[]>();
  for (const e of entries) {
    const list = map.get(e.date);
    if (list) list.push(e);
    else map.set(e.date, [e]);
  }
  return [...map.entries()];
}

function entryKey(e: TimelineEntry): string {
  switch (e.kind) {
    case "vote":
      return `vote:${e.rollCallId}`;
    case "bill":
      return `bill:${e.billId}:${e.role}`;
    case "speech":
      return `speech:${e.speechId}`;
  }
}

function DateHeading({ date }: { date: string }) {
  return (
    <h2 className="member-date">
      <time className="num" dateTime={date}>
        {formatDate(date)}
      </time>
    </h2>
  );
}

function Row({ entry }: { entry: TimelineEntry }) {
  switch (entry.kind) {
    case "vote":
      return (
        <li className="member-row">
          <Stamp value={entry.value} />
          <div className="member-row-body">
            <p className="member-row-title">{entry.title}</p>
            <p className="member-row-meta">
              <MetaLine
                parts={[
                  entry.result,
                  entry.value === "投票なし" ? "投票なし（理由は記録されない）" : null,
                  entry.groupValue && entry.groupValue !== entry.value ? `会派は${entry.groupValue}` : null,
                ]}
              />
              <ExternalLink href={entry.sourceUrl}>参院投票結果</ExternalLink>
            </p>
          </div>
        </li>
      );
    case "bill":
      /* 発議者（提出者）は「提出」、賛成者は「賛同」の判。submitterText は議案ページの原文（「○○君 外N名」。外N名の氏名は公表されていない）。 */
      return (
        <li className="member-row">
          <Stamp value={BILL_STAMP[entry.role]} />
          <div className="member-row-body">
            <p className="member-row-title">{entry.title}</p>
            <p className="member-row-meta">
              <MetaLine parts={[entry.role, entry.submitterText, entry.status]} />
              <ExternalLink href={entry.sourceUrl}>議案情報</ExternalLink>
            </p>
          </div>
        </li>
      );
    case "speech":
      return (
        /* position は会議録の speakerPosition 原文（例: 議長・国土交通大臣）。役職として行った発言である事実をそのまま見せる。 */
        <li className="member-row" {...(entry.position ? { "data-position": entry.position } : {})}>
          <Stamp value="発言" />
          <div className="member-row-body">
            <p className="member-row-title">
              {entry.position && <span className="member-position">{entry.position}</span>}
              {entry.excerpt}
            </p>
            <p className="member-row-meta">
              <MetaLine parts={[entry.meeting, `${entry.chars.toLocaleString("ja-JP")}字`]} />
              <ExternalLink href={entry.sourceUrl}>会議録</ExternalLink>
            </p>
          </div>
        </li>
      );
  }
}

/** "A ・ B ・ " — separator-joined facts; the caller appends the source link. */
function MetaLine({ parts }: { parts: (string | null | undefined)[] }) {
  return <>{parts.filter(Boolean).map((p) => `${p} ・ `)}</>;
}

/* ---------- 採決 table ---------- */

function VoteTable({ votes }: { votes: VoteEntry[] }) {
  return (
    <div className="member-table-wrap">
      <table className="member-table">
        <thead>
          <tr>
            <th scope="col">日付</th>
            <th scope="col">案件</th>
            <th scope="col">本人</th>
            <th scope="col">会派</th>
            <th scope="col">結果</th>
            <th scope="col">出典</th>
          </tr>
        </thead>
        <tbody>
          {votes.map((v) => (
            <tr key={v.rollCallId}>
              <td className="num">
                <time dateTime={v.date}>{formatDate(v.date)}</time>
              </td>
              <td>{v.title}</td>
              <td>
                <Stamp value={v.value} />
                {v.value === "投票なし" && <span className="member-note">理由は記録されない</span>}
              </td>
              <td>{v.groupValue ?? "—"}</td>
              <td>{v.result}</td>
              <td>
                <ExternalLink href={v.sourceUrl}>参院投票結果</ExternalLink>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- 提出法案 table ---------- */

/** 役割ごとの判の文言。色はどちらも act（行為の記録）。賛成者を提出者より軽く見せる色分けはしない。 */
const BILL_STAMP: Record<BillRole, "提出" | "賛同"> = { 提出者: "提出", 賛成者: "賛同" };

function BillTable({ bills }: { bills: BillEntry[] }) {
  return (
    <div className="member-table-wrap">
      <table className="member-table">
        <thead>
          <tr>
            <th scope="col">日付</th>
            <th scope="col">件名</th>
            <th scope="col">立場</th>
            <th scope="col">審議状況</th>
            <th scope="col">出典</th>
          </tr>
        </thead>
        <tbody>
          {bills.map((b) => (
            <tr key={`${b.billId}:${b.role}`}>
              <td className="num">
                <time dateTime={b.date}>{formatDate(b.date)}</time>
              </td>
              <td>{b.title}</td>
              <td>
                <Stamp value={BILL_STAMP[b.role]} />
                {b.submitterText && <span className="member-note">{b.submitterText}</span>}
              </td>
              <td>{b.status ?? "—"}</td>
              <td>
                <ExternalLink href={b.sourceUrl}>議案情報</ExternalLink>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- primitives (to be replaced by app/components from #5) ---------- */

type StampValue = "賛成" | "反対" | "投票なし" | "提出" | "賛同" | "発言";
const STAMP_TONE: Record<StampValue, "yes" | "no" | "none" | "act"> = {
  賛成: "yes",
  反対: "no",
  投票なし: "none",
  提出: "act",
  賛同: "act",
  発言: "act",
};

/** 判. Meaning is carried by the text/aria-label; colour only distinguishes, never judges. */
function Stamp({ value }: { value: StampValue }) {
  return (
    <span className="member-stamp" data-tone={STAMP_TONE[value]} role="img" aria-label={value}>
      {value === "投票なし" ? "－" : value}
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

function SourceLine({ meta }: { meta: DatasetMeta | null }) {
  return (
    <footer className="member-source">
      <p>
        出典：
        {(meta?.sources ?? []).map((s, i) => (
          <span key={s.url}>
            {i > 0 && " ・ "}
            <ExternalLink href={s.url}>{s.name}</ExternalLink>
          </span>
        ))}
      </p>
      <p className="num">{meta ? `取得 ${formatDateTime(meta.fetchedAt)}` : "データ未取得"}</p>
      <p>評価・採点はしません。記録をそのまま並べています。</p>
    </footer>
  );
}
