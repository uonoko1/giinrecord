import { useState } from "react";
import { type LoaderFunctionArgs, type MetaArgs, useLoaderData } from "react-router";
import { CompareAdd } from "../components/CompareAdd";
import type { BillEntry, BillRole, DatasetMeta, MemberDetail, QuestionEntry, StanceEntry, TimelineEntry, VoteEntry } from "../lib/data-contract";
import { defaultDataDir, readMemberDetail, readMeta } from "../lib/data-files";
import { formatDate, formatDateTime, formatYearMonth } from "../lib/format";
import { seoMeta } from "../lib/seo";
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

/**
 * 「{氏名}（{院}・{選挙区}）の投票記録」: 検索語（氏名・院・選挙区）を含め、評価語は入れない。
 * 衆院は個人の投票記録が公開されていないので「投票記録」と言わず「記録」。
 */
export function pageTitle(detail: MemberDetail): string {
  const term = currentTerm(detail);
  const where = [HOUSE_LABEL[detail.house], term?.district].filter(Boolean).join("・");
  return `${detail.name}（${where}）の${detail.house === "shugiin" ? "記録" : "投票記録"}`;
}

export function meta({ data, location }: MetaArgs<typeof loader>) {
  if (!data) return [{ title: "議会ログ" }];
  const { detail } = data;
  return seoMeta({
    title: pageTitle(detail),
    description:
      detail.house === "shugiin"
        ? `${affiliation(detail)}。提出法案・賛同法案・質問主意書・本会議発言と、所属会派の態度（推定）を公式記録から出典付きで並べます。`
        : `${affiliation(detail)}。本会議の採決・提出法案・質問主意書・発言を公式記録から出典付きで並べます。`,
    pathname: location.pathname,
    type: "article",
  });
}

export default function MemberRoute() {
  const loaderData = useLoaderData<typeof loader>();
  return <MemberPage detail={loaderData.detail} meta={loaderData.meta} />;
}

/* ---------- page ---------- */

type Tab = "all" | TimelineEntry["kind"];
/** 参院: 個人の記名採決がある。衆院: 個人投票は公開されていないので採決タブの代わりに「会派の態度」（推定）。 */
const TABS: Record<MemberDetail["house"], { id: Tab; label: string }[]> = {
  sangiin: [
    { id: "all", label: "すべて" },
    { id: "vote", label: "採決" },
    { id: "bill", label: "提出法案" },
    { id: "question", label: "質問主意書" },
    { id: "speech", label: "発言" },
  ],
  shugiin: [
    { id: "all", label: "すべて" },
    { id: "bill", label: "提出法案" },
    { id: "stance", label: "会派の態度" },
    { id: "question", label: "質問主意書" },
    { id: "speech", label: "発言" },
  ],
};

const HOUSE_LABEL = { sangiin: "参議院", shugiin: "衆議院" } as const;

/** 会派の態度（推定）は1人あたり100行前後になるので、最初は 20 件だけ出し「さらに表示」で残りを出す（#88）。 */
export const STANCE_FOLD = 20;

export function MemberPage({ detail, meta }: { detail: MemberDetail; meta: DatasetMeta | null }) {
  const [tab, setTabState] = useState<Tab>("all");
  const [stanceExpanded, setStanceExpanded] = useState(false);
  const setTab = (t: Tab) => {
    setTabState(t);
    setStanceExpanded(false);
  };
  const all = tab === "all" ? detail.timeline : detail.timeline.filter((e) => e.kind === tab);
  const folded = tab === "stance" && !stanceExpanded && all.length > STANCE_FOLD;
  const entries = folded ? all.slice(0, STANCE_FOLD) : all;
  const counts = countKinds(detail.timeline);

  return (
    <main className="member">
      <Cover detail={detail} counts={counts} />
      {detail.house === "shugiin" && <ShugiinNotice />}
      <div className="member-tabs" role="tablist" aria-label="記録の種類">
        {TABS[detail.house].map((t) => (
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
        {tab === "stance" && <p className="member-tab-note">所属会派が議案情報の賛成会派・反対会派に載っていた記録です。会派の態度であり、本人の投票ではありません。</p>}
        {entries.length === 0 ? (
          <p className="member-empty">記録はありません。</p>
        ) : tab === "vote" ? (
          <VoteTable votes={entries.filter((e): e is VoteEntry => e.kind === "vote")} />
        ) : tab === "bill" ? (
          <BillTable bills={entries.filter((e): e is BillEntry => e.kind === "bill")} />
        ) : tab === "question" ? (
          <QuestionTable questions={entries.filter((e): e is QuestionEntry => e.kind === "question")} />
        ) : (
          <Timeline entries={entries} />
        )}
        {folded && (
          <p className="member-more">
            <button type="button" className="member-more-button" onClick={() => setStanceExpanded(true)}>
              さらに表示（残り{(all.length - STANCE_FOLD).toLocaleString("ja-JP")}件）
            </button>
          </p>
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

/** 衆院は個人の投票記録が公開されていない事実を、ページ冒頭で1文だけ示す（評価はしない）。 */
function ShugiinNotice() {
  return (
    <p className="member-notice">
      衆議院は個人の投票記録が公開されていません。所属会派の態度は「推定」として区別して示します。
      <a href="/about#facts-heading">記録の範囲について</a>
    </p>
  );
}

type Counts = Record<TimelineEntry["kind"], number> & { submitted: number; supported: number };

function Cover({ detail, counts }: { detail: MemberDetail; counts: Counts }) {
  const term = currentTerm(detail);
  return (
    <header className="member-cover">
      <div className="member-cover-top">
        <a href="/">← 議会ログ</a>
      </div>
      <p className="member-kana">{detail.kana}</p>
      <h1 className="member-name">{detail.name}</h1>
      <p className="member-affil">{affiliation(detail)}</p>
      {term?.to && <p className="member-term num">任期満了 {formatYearMonth(term.to)}</p>}
      {detail.house === "shugiin" ? (
        /* 衆院: 記名採決は存在しないので枠を出さない。提出者と賛成者を分けて数える（どちらも事実） */
        <dl className="member-counts">
          <Count n={counts.submitted} label="提出法案" />
          <Count n={counts.supported} label="賛同法案" />
          <Count n={counts.question} label="質問主意書" />
          <Count n={counts.speech} label="本会議発言" />
        </dl>
      ) : (
        <dl className="member-counts">
          <Count n={counts.vote} label="記名採決" />
          <Count n={counts.bill} label="提出法案" />
          <Count n={counts.question} label="質問主意書" />
          <Count n={counts.speech} label="本会議発言" />
        </dl>
      )}
      <p className="member-profile">
        <ExternalLink href={detail.sourceUrl}>議員プロフィール（公式）</ExternalLink>
      </p>
      <CompareAdd memberId={detail.id} />
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

function countKinds(timeline: TimelineEntry[]): Counts {
  const c: Counts = { vote: 0, bill: 0, stance: 0, question: 0, speech: 0, submitted: 0, supported: 0 };
  for (const e of timeline) {
    c[e.kind] += 1;
    if (e.kind === "bill") c[e.role === "提出者" ? "submitted" : "supported"] += 1;
  }
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
    case "stance":
      return `stance:${e.billId}`;
    case "question":
      return `question:${e.questionId}`;
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
    case "stance":
      return <StanceRow entry={entry} />;
    case "question":
      /* 質問主意書（事実）。提出者欄の原文・経過状況（衆院）・答弁書受領日を出し、出典（衆院 経過ページ／参院 詳細ページ）と答弁本文にリンクする。 */
      return (
        <li className="member-row">
          <Stamp value="質問" />
          <div className="member-row-body">
            <p className="member-row-title">{entry.title}</p>
            <p className="member-row-meta">
              <MetaLine parts={[entry.submitterText, entry.status, answerLabel(entry)]} />
              <ExternalLink href={entry.sourceUrl}>質問主意書</ExternalLink>
              {entry.answerUrl && (
                <>
                  {" ・ "}
                  <ExternalLink href={entry.answerUrl}>答弁本文</ExternalLink>
                </>
              )}
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

/**
 * 【推定】会派の態度の行。判は est（破線＋薄地）で賛成・反対どちらも同じ色。ラベル「会派の態度（推定）」を常に添え、
 * meta には会派名・態度の原文（多数・少数・全会一致）・審議状況を出す。本人の賛否とは言わない。
 */
function StanceRow({ entry }: { entry: StanceEntry }) {
  return (
    <li className="member-row" data-estimated="true">
      <EstStamp stance={entry.stance} />
      <div className="member-row-body">
        <p className="member-row-title">
          <span className="member-est-label">会派の態度（推定）</span>
          {entry.title}
        </p>
        <p className="member-row-meta">
          <MetaLine parts={[`${entry.group}が${entry.stance}会派`, `会派態度 ${entry.stanceText}`, entry.status]} />
          <ExternalLink href={entry.sourceUrl}>議案情報</ExternalLink>
        </p>
      </div>
    </li>
  );
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

/* ---------- 質問主意書 table ---------- */

/** 答弁書受領日の表示。無ければ何も出さない（未受領と推定しない）。 */
function answerLabel(q: QuestionEntry): string | null {
  return q.answerDate ? `答弁書受領 ${formatDate(q.answerDate)}` : null;
}

function QuestionTable({ questions }: { questions: QuestionEntry[] }) {
  return (
    <div className="member-table-wrap">
      <table className="member-table">
        <thead>
          <tr>
            <th scope="col">日付</th>
            <th scope="col">件名</th>
            <th scope="col">答弁書</th>
            <th scope="col">出典</th>
          </tr>
        </thead>
        <tbody>
          {questions.map((q) => (
            <tr key={q.questionId}>
              <td className="num">
                <time dateTime={q.date}>{formatDate(q.date)}</time>
              </td>
              <td>
                {q.title}
                {q.submitterText && <span className="member-note">{q.submitterText}</span>}
                {q.status && <span className="member-note">{q.status}</span>}
              </td>
              <td>
                {q.answerDate ? (
                  <>
                    <time className="num" dateTime={q.answerDate}>{formatDate(q.answerDate)}</time>
                    {q.answerUrl && (
                      <>
                        {" "}
                        <ExternalLink href={q.answerUrl}>答弁本文</ExternalLink>
                      </>
                    )}
                  </>
                ) : (
                  "—"
                )}
              </td>
              <td>
                <ExternalLink href={q.sourceUrl}>質問主意書</ExternalLink>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- primitives (to be replaced by app/components from #5) ---------- */

type StampValue = "賛成" | "反対" | "投票なし" | "提出" | "賛同" | "質問" | "発言";
const STAMP_TONE: Record<StampValue, "yes" | "no" | "none" | "act"> = {
  賛成: "yes",
  反対: "no",
  投票なし: "none",
  提出: "act",
  賛同: "act",
  質問: "act",
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

/** 推定の判。aria-label にも「推定」を入れ、個人の票の判（賛成／反対）と読み上げでも区別する。 */
function EstStamp({ stance }: { stance: StanceEntry["stance"] }) {
  return (
    <span className="member-stamp" data-tone="est" data-estimated="true" role="img" aria-label={`会派の態度（推定）: ${stance}`}>
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
