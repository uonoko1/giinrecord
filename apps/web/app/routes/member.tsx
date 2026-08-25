import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { type LoaderFunctionArgs, type MetaArgs, useLoaderData } from "react-router";
import { CompareAdd } from "../components/CompareAdd";
import { SiteFooter } from "../components/SiteFooter";
import type { Assembly } from "@seiji-kiroku/shared";
import { assemblyPath, findAssembly, isLocalMember, joinVoteSubjects, localVoteTone, voteSubjectNote } from "../lib/assemblies";
import type { BillEntry, BillRole, DatasetMeta, LocalVoteEntry, MemberDetail, MemberSpeeches, QuestionEntry, SpeechEntry, StanceEntry, TimelineEntry, VoteEntry } from "../lib/data-contract";
import { defaultDataDir, readAssemblies, readLocalRollCallIndex, readMemberDetail, readMemberSpeechCount, readMeta } from "../lib/data-files";
import { formatDate, formatDateTime, formatYearMonth } from "../lib/format";
import { seoMeta } from "../lib/seo";
import "./member.css";

/* ---------- data (runs at build time only; ssr:false + prerender) ----------
 * routes.ts registers this route only when data/ exists, because under ssr:false a
 * `loader` is valid only on routes that are actually prerendered. The generated
 * `./+types/member` therefore cannot be relied on; argument types are declared by hand. */

/**
 * assembly は地方議員（#158）のときだけ引く（assemblies/index.json の行。無ければ null）。国会議員は null。
 * speechCount は `members/{id}/speeches.json` の行数（#242）。**発言そのものはここに載せない**:
 * 載せるとプリレンダーが HTML に全件焼き込み、分割した意味が無くなる（#263 の実測: HTML は元 JSON の 2.15 倍）。
 * 件数だけあればタブの件数と表紙の件数帯は出せるので、本文は発言タブを開いたときに実行時 fetch する。
 */
export type MemberLoaderData = { detail: MemberDetail; meta: DatasetMeta | null; assembly: Assembly | null; speechCount: number };

export async function loader({ params }: LoaderFunctionArgs): Promise<MemberLoaderData> {
  const dir = defaultDataDir();
  const id = params.id ?? "";
  const [detail, meta, speechCount] = await Promise.all([readMemberDetail(dir, id), readMeta(dir), readMemberSpeechCount(dir, id)]);
  if (!detail) throw new Response("Not Found", { status: 404 });
  if (!isLocalMember(detail)) return { detail, meta, assembly: null, speechCount };
  // 地方議員（#158）: 議会の行に加え、採決行の注記（#204）のために rollcalls/index.json の voteSubject / committeeReport を timeline に結合する
  const [assemblies, rollCallIndex] = await Promise.all([readAssemblies(dir), readLocalRollCallIndex(dir, detail.assemblyId ?? "")]);
  const assembly = findAssembly(assemblies ?? [], detail.assemblyId ?? "") ?? null;
  return { detail: { ...detail, timeline: joinVoteSubjects(detail.timeline, rollCallIndex) }, meta, assembly, speechCount };
}

/** 発言の実行時 fetch 先（#242）。nginx が gzip を掛ける application/json（deploy/nginx/site.conf）。 */
export function speechesDataUrl(id: string): string {
  return `/data/members/${encodeURIComponent(id)}/speeches.json`;
}

/** 発言タブを開いたときに取りに行く。404（発言 0 件でファイルが無い）は空として扱う（契約どおり。エラーにしない）。 */
async function fetchSpeeches(id: string): Promise<SpeechEntry[]> {
  const res = await fetch(speechesDataUrl(id));
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`${speechesDataUrl(id)}: HTTP ${res.status}`);
  return ((await res.json()) as MemberSpeeches).speeches ?? [];
}

/**
 * 「{氏名}（{院}・{選挙区}）の投票記録」: 検索語（氏名・院・選挙区）を含め、評価語は入れない。
 * 衆院は個人の投票記録が公開されていないので「投票記録」と言わず「記録」。
 */
export function pageTitle(detail: MemberDetail, assembly: Assembly | null = null): string {
  const term = currentTerm(detail);
  // 地方議員（#158）: 「{氏名}（{議会名}・{選挙区}）の表決記録」。議会の公表は「表決」なので「投票」と言わない
  if (isLocalMember(detail)) return `${detail.name}（${[assemblyLabel(detail, assembly), term?.district].filter(Boolean).join("・")}）の表決記録`;
  const where = [HOUSE_LABEL[detail.house], term?.district].filter(Boolean).join("・");
  return `${detail.name}（${where}）の${detail.house === "shugiin" ? "記録" : "投票記録"}`;
}

export function meta({ data, location }: MetaArgs<typeof loader>) {
  if (!data) return [{ title: "議員レコード" }];
  const { detail, assembly = null } = data;
  return seoMeta({
    title: pageTitle(detail, assembly),
    description: isLocalMember(detail)
      ? `${affiliation(detail, assembly)}。本会議の表決を議会の公表（凡例付きの原文）から出典付きで並べます。`
      : detail.house === "shugiin"
        ? `${affiliation(detail)}。提出法案・賛同法案・質問主意書・本会議発言と、所属会派の態度（推定）を公式記録から出典付きで並べます。`
        : `${affiliation(detail)}。本会議の採決・提出法案・質問主意書・発言を公式記録から出典付きで並べます。`,
    pathname: location.pathname,
    type: "article",
  });
}

export default function MemberRoute() {
  const loaderData = useLoaderData<typeof loader>();
  return <MemberPage detail={loaderData.detail} meta={loaderData.meta} assembly={loaderData.assembly ?? null} speechCount={loaderData.speechCount ?? 0} loadSpeeches={fetchSpeeches} />;
}

/* ---------- page ---------- */

type Tab = "all" | TimelineEntry["kind"];

/**
 * タブのカテゴリ（#238）。分ける軸は「誰の行為か」— 本人が行ったことか、所属会派の記録から推定したことか。
 *
 * 「意思表示／提案／発言」のような行為の種類で分ける案も検討したが、採らなかった。理由は 2 つ:
 * 1. 衆院の「会派の態度」は本人の行為ではない。行為の種類で分けると「意思表示」の中で採決（参院・事実）と
 *    並び、推定が個人の行為と同列に見える。ページ全体（判・ラベル・冒頭の注記）が事実と推定を分けている
 *    意図（#73）と食い違う。
 * 2. 実データでは 1 カテゴリあたりのタブが 1 つになる場合が多く（参院の「発言」、地方の「表決」）、
 *    見出しだけ増えて選択肢は増えない。
 * 「本人の行為」か否かは、どの院でも、将来タブが増えても揺れない軸で、事実と推定の区別とも一致する。
 */
type TabCategory = "all" | "self" | "group";

/** カテゴリの見出し。推定であることは見出し自体に書く（タブのラベルからは読み取れないため） */
const CATEGORY_LABEL: Record<TabCategory, string> = {
  all: "",
  self: "本人の記録",
  group: "所属会派の記録（推定）",
};

/** カテゴリの説明。スクリーンリーダー向けに、見出しだけでは分からない「何が推定か」を 1 文で添える */
const CATEGORY_NOTE: Record<TabCategory, string | null> = {
  all: null,
  self: null,
  group: "本人の投票ではありません",
};

export interface TabDef {
  id: Tab;
  label: string;
  category: TabCategory;
  /** timeline のどの kind を数えるか。"all" は全件 */
  kind: TimelineEntry["kind"] | null;
}

/** 参院: 個人の記名採決がある。衆院: 個人投票は公開されていないので採決タブの代わりに「会派の態度」（推定）。 */
const TABS: Record<MemberDetail["house"], TabDef[]> = {
  sangiin: [
    { id: "all", label: "すべて", category: "all", kind: null },
    { id: "vote", label: "採決", category: "self", kind: "vote" },
    { id: "bill", label: "提出法案", category: "self", kind: "bill" },
    { id: "question", label: "質問主意書", category: "self", kind: "question" },
    { id: "speech", label: "発言", category: "self", kind: "speech" },
  ],
  shugiin: [
    { id: "all", label: "すべて", category: "all", kind: null },
    { id: "bill", label: "提出法案", category: "self", kind: "bill" },
    { id: "question", label: "質問主意書", category: "self", kind: "question" },
    { id: "speech", label: "発言", category: "self", kind: "speech" },
    { id: "stance", label: "会派の態度", category: "group", kind: "stance" },
  ],
};

/** 地方議員のタブ（#158）: 表決だけ。国会の採決・提出法案・質問主意書・発言は地方の公表にはない */
const LOCAL_TABS: TabDef[] = [
  { id: "all", label: "すべて", category: "all", kind: null },
  { id: "localVote", label: "表決", category: "self", kind: "localVote" },
];

export interface TabGroup {
  category: TabCategory;
  /** 見出しを出すか。カテゴリが 1 つしか無いページ（参院・地方）では出さない（過剰な装飾をしない） */
  labelled: boolean;
  tabs: TabDef[];
}

/**
 * タブをカテゴリごとにまとめる。並びは TabDef の並びのまま。
 *
 * 見出しを出すのは「本人の記録」と「所属会派の記録（推定）」の両方があるページ（衆院）だけ。
 * 参院・地方は本人の記録しか無いので、見出しを出しても分類が情報を足さない（過剰な装飾をしない）。
 * 「すべて」は本人の記録と会派の記録の両方を含むので、どちらの見出しにも入れない（件数が見出しと合わなくなる）。
 */
export function groupTabs(tabs: TabDef[]): TabGroup[] {
  // 見出しを出すかどうかは、名前のあるカテゴリが 2 つ以上あるかで決まる
  const named = new Set(tabs.map((t) => t.category).filter((c) => c !== "all"));
  const labelled = named.size > 1;
  const groups: TabGroup[] = [];
  for (const t of tabs) {
    // 見出しを出さないページでは分類そのものを見せないので、タブ列は 1 本にまとめる（矢印キーも全タブを回る）
    const key = labelled ? t.category : "all";
    const last = groups[groups.length - 1];
    if (last && last.category === key) last.tabs.push(t);
    else groups.push({ category: key, labelled: labelled && key !== "all", tabs: [t] });
  }
  return groups;
}

const HOUSE_LABEL = { sangiin: "参議院", shugiin: "衆議院" } as const;

/** 地方議員の議会名。assemblies/index.json に無ければ assemblyId をそのまま（推定しない） */
function assemblyLabel(detail: MemberDetail, assembly: Assembly | null): string {
  return assembly?.name ?? detail.assemblyId ?? "";
}

/** 会派の態度（推定）は1人あたり100行前後になるので、最初は 20 件だけ出し「さらに表示」で残りを出す（#88）。 */
export const STANCE_FOLD = 20;

/** 回次ごとの折りたたみ（#103）: 直近この数の回次だけ展開し、それ以前は見出し（第N回国会・件数）だけにする。 */
export const EXPANDED_SESSIONS = 2;

export interface SessionGroup {
  /** 国会の回次。#103 以前のデータの行は回次を持たないので undefined（「回次不明」として最後にまとめる。推定しない） */
  session: number | undefined;
  entries: TimelineEntry[];
  expanded: boolean;
}

/**
 * timeline（日付降順）を回次ごとにまとめる。並びは回次の降順（timeline の並びは回次内でそのまま）、回次の無い行は最後。
 * 先頭 EXPANDED_SESSIONS 個だけ expanded。地方議員の行（localVote）は回次を持たないので 1 つの「回次不明」グループになるが、地方議員のページでは使わない。
 */
export function groupBySession(entries: TimelineEntry[]): SessionGroup[] {
  const map = new Map<number | undefined, TimelineEntry[]>();
  for (const e of entries) {
    const key = "session" in e && typeof e.session === "number" ? e.session : undefined;
    const list = map.get(key);
    if (list) list.push(e);
    else map.set(key, [e]);
  }
  const keys = [...map.keys()].sort((a, b) => (a === undefined ? 1 : b === undefined ? -1 : b - a));
  return keys.map((session, i) => ({ session, entries: map.get(session)!, expanded: i < EXPANDED_SESSIONS }));
}

/** 発言の読み込み状態（#242）。タブを開くまでは "idle"（取りに行かない）。 */
type SpeechState = { status: "idle" | "loading" } | { status: "ready"; speeches: SpeechEntry[] } | { status: "error"; message: string };

/**
 * 議員ページ。
 *
 * 発言（#242）だけは `detail.timeline` に入っておらず、発言タブを開いたときに `loadSpeeches` で取りに行く。
 * プリレンダー（`ssr: false`）は timeline を折りたたんだ回次も含めて HTML に全件書き出すので
 * （#263 の実測: HTML は元 JSON の 2.15 倍）、発言を timeline に置いたままでは
 * ファイルを分けても転送量は 1 バイトも減らない。**プリレンダーから外すことが効き所**である。
 * 件数（`speechCount`）はビルド時に数えて渡すので、取りに行く前でもタブと表紙の件数は正しい。
 *
 * `loadSpeeches` を引数にしているのは compare.tsx（`load`）と同じ理由で、テストが fetch を差し替えられるようにするため。
 */
export function MemberPage({ detail, meta, assembly = null, speechCount = 0, loadSpeeches }: { detail: MemberDetail; meta: DatasetMeta | null; assembly?: Assembly | null; speechCount?: number; loadSpeeches?: (id: string) => Promise<SpeechEntry[]> }) {
  const local = isLocalMember(detail);
  const [tab, setTabState] = useState<Tab>("all");
  const [stanceExpanded, setStanceExpanded] = useState(false);
  const [speechState, setSpeechState] = useState<SpeechState>({ status: "idle" });
  const setTab = (t: Tab) => {
    setTabState(t);
    setStanceExpanded(false);
  };
  // 発言タブを最初に開いたときだけ取りに行く（開かなければ 1 バイトも取らない。他のタブへ移って戻っても取り直さない）。
  // 「取りに行ったか」は ref で持つ: state に持つと effect の依存が状態遷移で変わり、
  // idle → loading の再実行が自分自身の cleanup に当たって結果が捨てられる（loading のまま止まる）。
  const requested = useRef(false);
  useEffect(() => {
    if (tab !== "speech" || requested.current || !loadSpeeches || speechCount === 0) return;
    requested.current = true;
    let cancelled = false;
    setSpeechState({ status: "loading" });
    loadSpeeches(detail.id).then(
      (loaded) => { if (!cancelled) setSpeechState({ status: "ready", speeches: loaded }); },
      (err: unknown) => { if (!cancelled) setSpeechState({ status: "error", message: err instanceof Error ? err.message : String(err) }); },
    );
    return () => { cancelled = true; };
  }, [tab, loadSpeeches, speechCount, detail.id]);
  const speeches = speechState.status === "ready" ? speechState.speeches : [];
  const all = tab === "speech" ? speeches : tab === "all" ? detail.timeline : detail.timeline.filter((e) => e.kind === tab);
  const folded = tab === "stance" && !stanceExpanded && all.length > STANCE_FOLD;
  const entries = folded ? all.slice(0, STANCE_FOLD) : all;
  const counts = { ...countKinds(detail.timeline), speech: speechCount };

  return (
    <>
      <main className="member">
        <Cover detail={detail} counts={counts} assembly={assembly} />
        {local ? <LocalNotice detail={detail} assembly={assembly} /> : detail.house === "shugiin" && <ShugiinNotice />}
        <TabBar tabs={local ? LOCAL_TABS : TABS[detail.house]} current={tab} counts={counts} onSelect={setTab} />
        <section id="member-records" role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {tab === "stance" && <p className="member-tab-note">所属会派が議案情報の賛成会派・反対会派に載っていた記録です。会派の態度であり、本人の投票ではありません。</p>}
          {/* 発言は本会議だけでなく委員会も収録している（#242）。どこで発言したかは会議名を原文で各行に出す */}
          {tab === "speech" && speechCount > 0 && <p className="member-tab-note">本会議と委員会の発言です。会議名は会議録の原文をそのまま出します。</p>}
          {tab === "speech" && speechState.status === "loading" ? (
            <p className="member-empty">発言を読み込んでいます…</p>
          ) : tab === "speech" && speechState.status === "error" ? (
            <p className="member-empty">発言を読み込めませんでした。時間をおいて開き直してください。</p>
          ) : entries.length === 0 ? (
            <p className="member-empty">記録はありません。</p>
          ) : tab === "localVote" ? (
            <LocalVoteTable votes={entries.filter((e): e is LocalVoteEntry => e.kind === "localVote")} />
          ) : local ? (
            <Timeline entries={entries} />
          ) : (
            /* 国会議員: 回次ごとに折りたたむ（#103）。直近 EXPANDED_SESSIONS 回次は開き、それ以前は見出しだけ */
            groupBySession(entries).map((g) => (
              <details key={g.session ?? "none"} className="member-session" open={g.expanded}>
                <summary className="member-session-head">
                  <span className="member-session-name">{g.session === undefined ? "回次不明" : `第${g.session}回国会`}</span>
                  <span className="member-session-count num">{g.entries.length.toLocaleString("ja-JP")}件</span>
                </summary>
                {tab === "vote" ? (
                  <VoteTable votes={g.entries.filter((e): e is VoteEntry => e.kind === "vote")} />
                ) : tab === "bill" ? (
                  <BillTable bills={g.entries.filter((e): e is BillEntry => e.kind === "bill")} />
                ) : tab === "question" ? (
                  <QuestionTable questions={g.entries.filter((e): e is QuestionEntry => e.kind === "question")} />
                ) : (
                  <Timeline entries={g.entries} />
                )}
              </details>
            ))
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
      <SiteFooter />
    </>
  );
}

/* ---------- タブ（#238: カテゴリ分け） ---------- */

/**
 * タブの件数。timeline の kind の数で、表紙の件数帯と同じ数え方（同じ countKinds の結果を使う）。
 * 「すべて」は全件。提出法案は提出者・賛成者の両方を含む（表紙の「提出法案」と同じ）。
 */
function tabCount(t: TabDef, counts: Counts): number {
  if (t.kind === null) return counts.all;
  return counts[t.kind];
}

/**
 * タブ列（#238）。カテゴリが 2 つ以上あるときだけカテゴリ見出しを出し、tablist をカテゴリごとに分ける。
 *
 * 件数 0 のタブは隠さない。「無い」ことが情報だから: 衆院に個人の採決が無いのも、ある議員が
 * 質問主意書を 1 通も出していないのも、公表されている事実である。0 件は淡色（--muted）にして
 * 「選んでも空」だと分かるようにするだけで、選ぶことはできる（disabled にもしない。
 * 空のタブを開いたときの「記録はありません。」自体が答えになる）。
 *
 * キーボード: 左右矢印で同じカテゴリ内を移動、Home/End で端へ。tabindex は選択中のタブだけ 0（ロービングタブインデックス）。
 */
function TabBar({ tabs, current, counts, onSelect }: { tabs: TabDef[]; current: Tab; counts: Counts; onSelect: (t: Tab) => void }) {
  const groups = groupTabs(tabs);
  return (
    <div className="member-tabbar">
      {groups.map((g) => (
        <TabGroupBar key={g.category} group={g} current={current} counts={counts} onSelect={onSelect} />
      ))}
    </div>
  );
}

function TabGroupBar({ group, current, counts, onSelect }: { group: TabGroup; current: Tab; counts: Counts; onSelect: (t: Tab) => void }) {
  const headingId = `tabcat-${group.category}`;
  const note = CATEGORY_NOTE[group.category];

  /** 左右矢印・Home/End で同じカテゴリ内を移動する。移動先のタブを選び、フォーカスも移す（WAI-ARIA の tablist に合わせる） */
  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = group.tabs.length - 1;
    const next = e.key === "ArrowRight" ? index + 1 : e.key === "ArrowLeft" ? index - 1 : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (next === null) return;
    e.preventDefault();
    const target = group.tabs[next < 0 ? last : next > last ? 0 : next]!;
    onSelect(target.id);
    (e.currentTarget.parentElement?.querySelector(`#tab-${target.id}`) as HTMLElement | null)?.focus();
  }

  return (
    <div className="member-tabgroup" data-category={group.category}>
      {group.labelled && (
        <p className="member-tabcat" id={headingId}>
          {CATEGORY_LABEL[group.category]}
          {note && <span className="member-tabcat-note">{note}</span>}
        </p>
      )}
      <div className="member-tabs" role="tablist" {...(group.labelled ? { "aria-labelledby": headingId } : { "aria-label": group.category === "all" ? "記録の絞り込み" : "記録の種類" })}>
        {group.tabs.map((t, i) => {
          const n = tabCount(t, counts);
          const selected = current === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={selected}
              aria-controls="member-records"
              tabIndex={selected ? 0 : -1}
              className="member-tab"
              data-empty={n === 0 ? "true" : undefined}
              onClick={() => onSelect(t.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              <span className="member-tab-label">{t.label}</span>
              <span className="member-tab-count num">{n.toLocaleString("ja-JP")}件</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- cover ---------- */

function currentTerm(detail: MemberDetail) {
  return detail.terms.find((t) => !t.to) ?? detail.terms[detail.terms.length - 1];
}

function affiliation(detail: MemberDetail, assembly: Assembly | null = null): string {
  const term = currentTerm(detail);
  const where = isLocalMember(detail) ? assemblyLabel(detail, assembly) : HOUSE_LABEL[detail.house];
  return [where, term?.district, term?.group].filter(Boolean).join(" ・ ");
}

/**
 * 地方議員（#158）: どの議会の記録で、表決が何の原文かをページ冒頭で1文だけ示す（評価はしない）。
 * 出典は議会の公式ページ（assemblies/index.json の sourceUrl）と、このサイトの議会ページ。
 */
function LocalNotice({ detail, assembly }: { detail: MemberDetail; assembly: Assembly | null }) {
  const name = assemblyLabel(detail, assembly);
  return (
    <p className="member-notice">
      {name}の記録です。表決は議会が公表する表決結果の原文を凡例（○＝賛成 など）とともにそのまま示し、賛成・反対に丸めません。
      {assembly && (
        <>
          {" "}
          <ExternalLink href={assembly.sourceUrl}>{name}（公式）</ExternalLink>
        </>
      )}
      {detail.assemblyId && (
        <>
          {" ・ "}
          <a href={assemblyPath(detail.assemblyId)}>議会ページ</a>
        </>
      )}
    </p>
  );
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

/** 表紙の件数帯とタブの件数はこれ 1 つから作る（数がずれない）。all は timeline の全件、submitted/supported は bill の内訳 */
type Counts = Record<TimelineEntry["kind"], number> & { all: number; submitted: number; supported: number };

function Cover({ detail, counts, assembly }: { detail: MemberDetail; counts: Counts; assembly: Assembly | null }) {
  const term = currentTerm(detail);
  return (
    <header className="member-cover">
      <div className="member-cover-top">
        <a href="/">← 議員レコード</a>
      </div>
      <p className="member-kana">{detail.kana}</p>
      <h1 className="member-name">{detail.name}</h1>
      <p className="member-affil">{affiliation(detail, assembly)}</p>
      {term?.to && <p className="member-term num">任期満了 {formatYearMonth(term.to)}</p>}
      {isLocalMember(detail) ? (
        /* 地方議会（#158）: 公表されているのは表決だけ */
        <dl className="member-counts">
          <Count n={counts.localVote} label="表決" />
        </dl>
      ) : detail.house === "shugiin" ? (
        /* 衆院: 記名採決は存在しないので枠を出さない。提出者と賛成者を分けて数える（どちらも事実） */
        <dl className="member-counts">
          <Count n={counts.submitted} label="提出法案" />
          <Count n={counts.supported} label="賛同法案" />
          <Count n={counts.question} label="質問主意書" />
          <Count n={counts.speech} label="発言" />
        </dl>
      ) : (
        <dl className="member-counts">
          <Count n={counts.vote} label="記名採決" />
          <Count n={counts.bill} label="提出法案" />
          <Count n={counts.question} label="質問主意書" />
          <Count n={counts.speech} label="発言" />
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
  // speech は timeline に無い（#242。MemberPage が speechCount で上書きする）。all は timeline の全件で、発言は含まない
  const c: Counts = { vote: 0, bill: 0, stance: 0, question: 0, attendance: 0, speech: 0, localVote: 0, all: timeline.length, submitted: 0, supported: 0 };
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
    case "attendance":
      return `attendance:${e.meetingId}`;
    case "speech":
      return `speech:${e.speechId}`;
    case "localVote":
      return `localVote:${e.rollCallId}`;
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
    case "localVote":
      return <LocalVoteRow entry={entry} />;
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
    case "attendance":
      /* 委員会に発議者として出席した事実（#109）。出席した発議者は発議者全員ではないので、提出法案（提出の判）とは別の判「出席」で出し、
         その日の案件にあった参法を添える（複数ならどれの発議者かは会議録からは分からないので全部並べる）。 */
      return (
        <li className="member-row">
          <Stamp value="出席" />
          <div className="member-row-body">
            <p className="member-row-title">{`委員会に${entry.role}として出席（${entry.meeting}）`}</p>
            <p className="member-row-meta">
              <MetaLine parts={entry.bills.map((b) => `案件 ${b.title}`)} />
              <ExternalLink href={entry.sourceUrl}>会議録</ExternalLink>
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

/**
 * 地方議会の表決の行（#158）。判の文字は表決結果表の原文（○×議欠－棄白）、読み上げは「原文（凡例）」。
 * 色は凡例から国会の値に対応づけられた（mapped がある）行だけで、それ以外は中立。凡例は必ず添え、「投票なし」には丸めない。
 */
function LocalVoteRow({ entry }: { entry: LocalVoteEntry }) {
  return (
    <li className="member-row">
      <LocalStamp vote={entry.vote} />
      <div className="member-row-body">
        <p className="member-row-title">{entry.title}</p>
        <p className="member-row-meta">
          {/* 賛否の対象（#204）: 請願・陳情の ○ は委員長報告への賛成であって採択への賛成ではない。凡例の直後に添える */}
          <MetaLine parts={[legendText(entry.vote), voteSubjectNote(entry), entry.sessionLabel, entry.method, entry.result]} />
          <ExternalLink href={entry.sourceUrl}>表決結果</ExternalLink>
        </p>
      </div>
    </li>
  );
}

/** 「凡例 ○＝賛成」: セルの原文と、その議会の凡例での意味の原文 */
function legendText(vote: LocalVoteEntry["vote"]): string {
  return `凡例 ${vote.raw}＝${vote.legend}`;
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

/* ---------- 表決（地方議会）table ---------- */

function LocalVoteTable({ votes }: { votes: LocalVoteEntry[] }) {
  return (
    <div className="member-table-wrap">
      <table className="member-table">
        <thead>
          <tr>
            <th scope="col">日付</th>
            <th scope="col">案件</th>
            <th scope="col">表決</th>
            <th scope="col">方法</th>
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
              <td>
                {v.title}
                <span className="member-note">{v.sessionLabel}</span>
              </td>
              <td>
                <LocalStamp vote={v.vote} />
                <span className="member-note">{v.vote.legend}</span>
                {/* 賛否の対象（#204）: 請願・陳情の ○ は委員長報告への賛成であって採択への賛成ではない */}
                {voteSubjectNote(v) && <span className="member-note">{voteSubjectNote(v)}</span>}
              </td>
              <td>{v.method ?? "—"}</td>
              <td>{v.result ?? "—"}</td>
              <td>
                <ExternalLink href={v.sourceUrl}>表決結果</ExternalLink>
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

type StampValue = "賛成" | "反対" | "投票なし" | "提出" | "賛同" | "質問" | "出席" | "発言";
const STAMP_TONE: Record<StampValue, "yes" | "no" | "none" | "act"> = {
  賛成: "yes",
  反対: "no",
  投票なし: "none",
  提出: "act",
  賛同: "act",
  質問: "act",
  出席: "act",
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

/** 地方議会の表決の判（#158）。文字は原文、aria-label は「原文（凡例）」。色は mapped のある値だけ（localVoteTone）。 */
function LocalStamp({ vote }: { vote: LocalVoteEntry["vote"] }) {
  return (
    <span className="member-stamp" data-tone={localVoteTone(vote)} role="img" aria-label={`${vote.raw}（${vote.legend}）`}>
      {vote.raw}
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
