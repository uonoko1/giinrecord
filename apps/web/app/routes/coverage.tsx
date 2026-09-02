import { Link, type MetaArgs, useLoaderData } from "react-router";
import { CoverBrand } from "../components/CoverBrand";
import { SiteFooter } from "../components/SiteFooter";
import { assemblyPath, bundledSessions } from "../lib/assemblies";
import { buildCoverage, type Coverage, type DietCoverage, formatLocalSessionRange, formatSessionRange, hasSessionGaps, linkedRecordCounts, type LocalCoverage, rosterlessSessions, rosterScope, sangiinUnlinkedVotes, type SangiinVoteLinkStats, type SessionRange, shugiinBillNameCoverage, type ShugiinBillNameStats, shugiinQuestionCoverage, speechCoverage, type UnmatchedSpeechStats, unmatchedSpeechCoverage } from "../lib/coverage";
import type { AssemblySession } from "../lib/data-contract";
import { defaultDataDir, readSangiinVoteLinkStats, readShugiinBillNameStats, readUnmatchedSpeechStats } from "../lib/data-files";
import { type Dataset, dataset as bundled } from "../lib/dataset";
import { bills as bundledBills } from "../lib/bills";
import { formatDate, formatDateTime } from "../lib/format";
import { seoMeta } from "../lib/seo";
import "../styles/pages.css";
import "./assemblies.css";

const DESCRIPTION = "このサイトに入っている議会・回次・会期と、採決件数・議員数・取得元。すべてデータセットから数えた件数です。";

/* ---------- data (build time only; ssr:false + prerender) ----------
 * 議会・回次・件数は index.json のバンドルから数えるので loader は要らないが、衆院の議案の提出者・賛成者の
 * 氏名（#251）は `bills/index.json` に無く、議案 1 件ずつの JSON にしかない。全部をブラウザに送らずに数えるため、
 * ビルド時に Node で数えた結果だけを loader で渡す（/coverage は prerender.ts の STATIC_PATHS にあるので loader を置ける）。 */

export type CoverageLoaderData = { shugiinBillNames: ShugiinBillNameStats | null; sangiinVotes: SangiinVoteLinkStats | null; unmatchedSpeeches: UnmatchedSpeechStats | null };

export async function loader(): Promise<CoverageLoaderData> {
  const dataDir = defaultDataDir();
  return {
    shugiinBillNames: await readShugiinBillNameStats(dataDir),
    sangiinVotes: await readSangiinVoteLinkStats(dataDir),
    unmatchedSpeeches: await readUnmatchedSpeechStats(dataDir),
  };
}

export function meta({ location }: MetaArgs) {
  return seoMeta({ title: "収録範囲", description: DESCRIPTION, pathname: location.pathname });
}

const n = (v: number) => v.toLocaleString("ja-JP");

const KIND_LABEL = { national: "国会", prefectural: "都道府県議会", municipal: "政令指定都市議会" } as const;

export default function CoverageRoute() {
  const { shugiinBillNames, sangiinVotes, unmatchedSpeeches } = useLoaderData<typeof loader>();
  return <CoveragePage shugiinBillNames={shugiinBillNames} sangiinVotes={sangiinVotes} unmatchedSpeeches={unmatchedSpeeches} />;
}

/**
 * /coverage（#218）: どの議会のどこまでが入っているかを data/ から数えて並べる。
 * 件数・範囲はすべて buildCoverage がデータを数えた値で、この画面には数値を書かない。評価・解釈は書かない。
 */
/**
 * Issue 408: `bills` は `dataset` に入っていない（gzip 60KB あり、使うのはこの画面だけ）。
 * **この画面だけが `lib/bills.ts` から読む**ので、他のページはそれを読まずに済む。
 * `data` を明示的に渡された場合（テスト）は、その中の `bills` を尊重する。
 */
const withBills = (d: Dataset): Dataset => (d.bills === undefined ? { ...d, bills: bundledBills } : d);

export function CoveragePage({
  data = withBills(bundled),
  sessions = bundledSessions(),
  shugiinBillNames = null,
  sangiinVotes = null,
  unmatchedSpeeches = null,
}: {
  data?: Dataset;
  sessions?: ReadonlyMap<string, AssemblySession[]>;
  shugiinBillNames?: ShugiinBillNameStats | null;
  sangiinVotes?: SangiinVoteLinkStats | null;
  unmatchedSpeeches?: UnmatchedSpeechStats | null;
}) {
  const coverage = buildCoverage(data, sessions);
  return (
    <>
      <main className="page assemblies">
        <header className="cover">
          <CoverBrand to="/" />
          <h1 className="cover__title">収録範囲</h1>
          <p className="cover__lead">{DESCRIPTION}</p>
          {data.meta && <p className="note">取得 {formatDateTime(data.meta.fetchedAt)}</p>}
        </header>

        <TotalsSection coverage={coverage} />
        <DietSection diet={coverage.diet} metaSessions={coverage.metaSessions} />
        <LocalSection local={coverage.local} />

        <SpeechSection data={data} unmatchedSpeeches={unmatchedSpeeches} />
        <RosterlessSection meta={data.meta} votes={sangiinVotes} />
        <ShugiinRosterSection data={data} billNames={shugiinBillNames} />

        <section className="section" aria-labelledby="coverage-not-recorded-heading">
          <h2 id="coverage-not-recorded-heading" className="section__title">
            記録にないこと
          </h2>
          <p className="card__body">
            一次資料に無いもの（参議院の議員立法の共同発議者・賛成者名、「投票なし」が欠席か棄権かの区別、委員会での採決など）は、このサイトにもありません。一覧は
            <Link to="/about#none-heading">このデータについて「記録にないこと」</Link>
            にあります。
          </p>
        </section>

        <section className="section">
          <div className="links">
            <Link to="/assemblies">議会一覧</Link>
            <Link to="/about">このデータについて</Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

/** 合計（議会数・議員数・採決件数）。すべて data/ の行数 */
function TotalsSection({ coverage }: { coverage: Coverage }) {
  const { totals } = coverage;
  return (
    <section className="section" aria-labelledby="coverage-totals-heading">
      <h2 id="coverage-totals-heading" className="section__title">
        合計
      </h2>
      <div className="figures coverage-totals">
        <div className="figure">
          <span className="figure__num">{n(totals.assemblies)}</span>
          <span className="figure__label">議会</span>
        </div>
        <div className="figure">
          <span className="figure__num">{n(totals.dietMembers + totals.localMembers)}</span>
          <span className="figure__label">議員</span>
        </div>
        <div className="figure">
          <span className="figure__num">{n(totals.dietRollcalls + totals.localRollcalls)}</span>
          <span className="figure__label">採決・表決</span>
        </div>
        <div className="figure">
          <span className="figure__num">{n(totals.bills)}</span>
          <span className="figure__label">議案</span>
        </div>
      </div>
    </section>
  );
}

/**
 * 回次の範囲の表示。実際に行のあった回次が範囲より少ない（歯抜け）ときは実数を添える。
 * 例: 第200—221回のうち記名投票のある回次は 11（残りは起立採決などで個人票が無い）。連続収録と読ませない。
 */
function SessionRangeCell({ range, unit }: { range: SessionRange | null; unit: string }) {
  const text = formatSessionRange(range);
  if (!text || !range) return <>—</>;
  return (
    <>
      {text}
      {hasSessionGaps(range) && <span className="assemblies-status-note">うち{unit}のある回次 {n(range.count)}</span>}
    </>
  );
}

/**
 * 衆院の記録が議員ページに紐づく範囲（#235 / #251）。#235（質問主意書）と #251（提出者・賛成者）は
 * 根本が同じ 1 つの事実（衆院の名簿は「現在」の 1 時点しかない）なので、節を分けずにまとめて 1 つの説明にする。
 *
 * 書くのは事実だけ:
 * 1. 名簿が公開されている範囲の違い（衆院は 1 時点、参院は回次ごと）。**参院を「制約が無い」とは書かない**:
 *    参院も最古の名簿より前は同じ制約下にあり、それはすぐ上の節（RosterlessSection）が書いている。
 *    ここで「参院にはこの制約が無い」と書くと同じページの隣の節と矛盾する（#259 レビュー）。
 * 2. そのため名簿の範囲外は氏名が一致しても本人と確認できないこと。氏名だけで紐づけない理由
 * 3. 名簿にいちばん多くの氏名が載る回次で、議案の氏名のうち現在の名簿にある数（実数）
 * 4. 種類ごとに議員ページに**実際に出ている件数**。取得した回次からの推論ではなく members/index.json の
 *    counts の合計なので、0 件なら 0 件と書く（「第N回のぶんだけ出る」のような代理値の主張はしない。#259 レビュー）
 * 数値はすべてデータを数えた値。評価・解釈は書かない。
 */
function ShugiinRosterSection({ data, billNames }: { data: Dataset; billNames: ShugiinBillNameStats | null }) {
  const scope = rosterScope(data.meta);
  const bills = shugiinBillNameCoverage(billNames);
  const linked = linkedRecordCounts(data.members, "shugiin");
  const questions = shugiinQuestionCoverage(data.meta);
  const questionsFetched = formatSessionRange(questions?.fetched ?? null);
  const sangiinRoster = formatSessionRange(scope.sangiin);
  if (!scope.shugiin && !bills) return null;
  return (
    <section className="section" aria-labelledby="coverage-shugiin-roster-heading">
      <h2 id="coverage-shugiin-roster-heading" className="section__title">
        衆議院の記録が議員ページに紐づく範囲
      </h2>
      <p className="card__body">
        議員名簿が公開されている範囲は院によって違います。衆議院が公開している議員名簿は
        <strong>「現在」の 1 時点だけで、回次ごとの名簿はありません</strong>。
        {scope.shugiin && (
          <>
            {" "}
            このサイトが持っている衆議院の名簿も
            <a href={scope.shugiin.url} target="_blank" rel="noopener noreferrer">
              議員一覧
            </a>
            の <span className="num">{formatDate(scope.shugiin.asOf)}</span> 現在の 1 枚です。
          </>
        )}
        {sangiinRoster && scope.sangiin && (
          <>
            {" "}
            参議院は回次ごとの名簿があり、このサイトが持っているのは <span className="num">{sangiinRoster}</span>（
            <span className="num">{n(scope.sangiin.count)}</span> 回次）のぶんです。
            <strong>それより前の回次に名簿が無いことは参議院も同じ</strong>で、上の「議員ページに紐づかない回次」に書いています。
          </>
        )}
      </p>
      <p className="card__body">
        名簿のある範囲の外では、議案の提出者・賛成者、質問主意書の提出者、会議録の発言者は、
        <strong>氏名がこの名簿と一致しても、その人本人であることを一次資料から確認できません</strong>。
        氏名だけを手がかりに議員に紐づけることはしていません（同姓同名の別人を 1 人にしないため）。
      </p>
      {/* #316: 衆院サイト以外の一次資料も調べたうえで無い、と書く。#274 が参院について「参議院のサイト以外の
          一次資料は調べていません」と主張の範囲を限定したのと対。robots.txt / 利用規約の話と WARP（#250 待ち）は
          利用者向けの情報ではないので書かない（docs/research/shugiin-tenure-sessions.md 7 節）。 */}
      <p className="card__body">
        回次ごとの名簿にあたるものが<strong>衆議院のサイト以外にもないか</strong>を調べました。
        <strong>国会会議録</strong>には発言者の会派が記録されていますが、記録されるのは発言した人だけで、
        その回次に議員だった人の一覧にはなりません。<strong>総選挙の結果</strong>（総務省）には当選した人の氏名がありますが、
        投票用紙に書く通称で記載されており、議員名簿の氏名とは別の表記です。比例代表の当選者は、
        資料の形の都合で当選・落選の別を機械的に読み取れません。<strong>官報</strong>は、
        発行から 90 日を過ぎた過去の分が公開の対象外です。
      </p>
      <p className="card__body">
        総選挙の結果が使えたとしても、それは<strong>その総選挙で当選した人</strong>であって、
        会期の途中の辞職・死去・補欠選挙・繰上補充は反映されません。
        このサイトは、確認できないものを推測で補うことはしていません。調査の記録は{" "}
        <a
          href="https://github.com/uonoko1/giinrecord/blob/main/docs/research/shugiin-tenure-sessions.md"
          target="_blank"
          rel="noopener noreferrer"
        >
          docs/research/shugiin-tenure-sessions.md
        </a>
        にあります。
      </p>
      {bills?.largest && (
        <p className="card__body">
          衆議院の議案にいちばん多くの氏名が載る<span className="num">第{bills.largest.session}回</span>では、議案に載る提出者・賛成者{" "}
          <span className="num">{n(bills.largest.names)}</span> 人のうち、現在の名簿にあるのは{" "}
          <span className="num">{n(bills.largest.inRoster)}</span> 人です。残りの氏名は現在の名簿にありません。
        </p>
      )}
      {bills && (
        <p className="card__body">
          衆議院の議案に載る提出者・賛成者の氏名は延べ <span className="num">{n(bills.names)}</span> 件あり、そのうち議員に紐づいているのは{" "}
          <span className="num">{n(bills.linked)}</span> 件です。残る <span className="num">{n(bills.unlinked)}</span>{" "}
          件の氏名は、議案のページには原文のまま載りますが、議員ページには出ません。
          {bills.rosterDuplicateNames === 0 && (
            <>
              {" "}
              現在の名簿 <span className="num">{n(bills.rosterMembers)}</span> 人のなかに同じ氏名の人はいません。
            </>
          )}
        </p>
      )}
      {linked && (
        <p className="card__body">
          いま衆議院の議員ページに出ている記録は、提出・賛成した議案が <span className="num">{n(linked.bills)}</span> 件、
          質問主意書が <span className="num">{n(linked.questions)}</span> 件、発言が{" "}
          <span className="num">{n(linked.speeches)}</span> 件です。
          {questionsFetched && linked.questions === 0 && (
            <>
              {" "}
              質問主意書は <span className="num">{questionsFetched}</span> の一覧を取得していますが、
              <strong>そのうち提出者を名簿に照合できたものはありません</strong>（取得した回次に載る氏名が、現在の名簿と照合できる回次のものではないため）。
            </>
          )}
          {questionsFetched && linked.questions > 0 && (
            <>
              {" "}
              質問主意書は <span className="num">{questionsFetched}</span> の一覧を取得しています。
            </>
          )}
        </p>
      )}
    </section>
  );
}

/**
 * 発言の収録範囲（#242）。書くのは 2 つの事実だけで、どちらもデータから読む（回次も件数もここには書かない）:
 *
 * 1. **どの会議まで取っているか**（本会議だけか、委員会も含むか）。`meta.sources` の会議録 API の URL に
 *    `nameOfMeeting` が付いているかで決まる（`speechCoverage`）。
 * 2. **議員ページに実際に出ている件数**（`linkedRecordCounts`。members/index.json の counts の合計）。
 *
 * 他院の議員の発言（#313）はここに書く。会議録の院は会議の院であって発言者の院ではないという、収録と突合の範囲の事実である。
 * 書くのは「紐づけるのは名簿が覆う回次だけ」であって、「活動がない」「発言していない」ではない（中立性の原則）。
 *
 * 「どこまで遡っているか」は院で違う（参院は回次ごとの名簿がある範囲、衆院は名簿が覆う 1 回次だけ）が、
 * それは名簿の範囲の話で、すぐ下の 2 節（RosterlessSection / ShugiinRosterSection）が既に書いている。
 * ここで回次を書くと同じことを 2 か所で言うことになるので、**そちらへ案内するだけ**にする。
 */
function SpeechSection({ data, unmatchedSpeeches }: { data: Dataset; unmatchedSpeeches: UnmatchedSpeechStats | null }) {
  const scopes = speechCoverage(data.meta);
  const unmatched = unmatchedSpeechCoverage(unmatchedSpeeches);
  if (scopes.length === 0) return null;
  const sangiin = linkedRecordCounts(data.members, "sangiin");
  const shugiin = linkedRecordCounts(data.members, "shugiin");
  const committees = scopes.filter((c) => c.committees).map((c) => (c.house === "sangiin" ? "参議院" : "衆議院"));
  const plenaryOnly = scopes.filter((c) => !c.committees).map((c) => (c.house === "sangiin" ? "参議院" : "衆議院"));
  return (
    <section className="section" aria-labelledby="coverage-speech-heading">
      <h2 id="coverage-speech-heading" className="section__title">
        発言をどの会議まで収録しているか
      </h2>
      <p className="card__body">
        発言は
        <a href={scopes[0].url} target="_blank" rel="noopener noreferrer">
          国会会議録検索システム 検索用API
        </a>
        から取っています。
        {committees.length > 0 && (
          <>
            {" "}
            <strong>{committees.join("・")}は本会議だけでなく委員会も収録しています</strong>
            （分科会・審査会・連合審査会・公聴会・調査会を含みます）。会議名は会議録の原文のまま各行に出すので、本会議か委員会かは議員ページで見分けられます。
          </>
        )}
        {plenaryOnly.length > 0 && <> {plenaryOnly.join("・")}は本会議だけを収録しています。</>}
      </p>
      <p className="card__body">
        委員会の会議録には、議員でない発言者（政府参考人・参考人・公述人など）も載ります。
        <strong>会派の記載がない発言者は議員に紐づけません</strong>（同姓同名の別人を議員にしないため）。
        議員に紐づかなかった発言は、会議録には残りますが議員ページには出ません。
      </p>
      <p className="card__body">
        会議録は<strong>会議の院</strong>で分かれますが、発言した人がその院の議員とは限りません。
        参議院の会議には<strong>他院の議員</strong>が大臣・副大臣として答弁に立ち、連合審査会にも出ます（逆も同じです）。
        こうした発言も、
        <strong>発言した議員の院の名簿がその回次を覆っている場合にかぎり議員ページに紐づけます</strong>。
        覆っていない回次の発言は、会議録には残りますが議員ページには出ません。
      </p>
      {/* Issue 370: 議案は「X 人のうち名簿にあるのは Y 人」と数を出しているのに、発言は数が無かった。
          データ（unmatched.json）を数えた実数だけを出す。割合も推定も出さない。 */}
      {unmatched && (
        <p className="card__body">
          いま議員ページに紐づけられていない発言は
          <span className="num"> {n(unmatched.speeches)} </span>件（
          <span className="num">{n(unmatched.speakers)}</span> 名分）です
          {unmatched.sessions.length > 0 && (
            <>
              （
              {unmatched.sessions.map((x, i) => (
                <span key={x.session}>
                  {i > 0 && "、"}第<span className="num">{x.session}</span>回 <span className="num">{n(x.speeches)}</span> 件
                </span>
              ))}
              ）
            </>
          )}
          。会議録には残っており、
          <a href={scopes[0].url} target="_blank" rel="noopener noreferrer">
            検索用API
          </a>
          からたどれます。
        </p>
      )}
      {(sangiin || shugiin) && (
        <p className="card__body">
          いま議員ページに出ている発言は、
          {sangiin && (
            <>
              参議院が <span className="num">{n(sangiin.speeches)}</span> 件
            </>
          )}
          {sangiin && shugiin && "、"}
          {shugiin && (
            <>
              衆議院が <span className="num">{n(shugiin.speeches)}</span> 件
            </>
          )}
          です。どの回次まで遡れるかは院ごとの議員名簿が公開されている範囲で決まります（下の 2 つの節）。
        </p>
      )}
    </section>
  );
}

/**
 * 名簿の無い回次（#219 / #230 / #274）。参議院の回次ごとの議員名簿は最古の 1 回次分より前が公開されていないので、
 * その回次の票の多くは議員ページに紐づかない。#230 より前は「現行名簿と氏名が一致する少数」が在職未確認のまま
 * 紐づいており、この節はそれを「推定を含む」と書いていた。#230 でその経路を塞いだ。
 *
 * #274 で足したのは 3 つで、どれも事実だけを書く:
 * 1. **在職開始日が参議院のどこに無いか**。名簿だけでなく議員個人ページにも無い（あるのは当選年で月日が無い）。
 *    調査は #274（`docs/research/sangiin-tenure.md`）。**主張の範囲は参議院のサイトに限る**: 他の一次資料は調べていないので、
 *    「どこにも無い」「回復できない」とは書かない（実態より強い主張をしない）。
 * 2. **紐づかない票の件数**。`readSangiinVoteLinkStats` が `rollcalls/{回次}/{id}.json` を数えた結果で、
 *    `memberId` の有無という突合結果そのもの。定数も代理値も書かない（データが変われば再ビルドで追随する）。
 *    件数には**測り方**（何を何で数えたか）を添える。
 *    書くのは数えた事実だけで、**個々の票がなぜ紐づいたか**は書かない: 数えているのは `memberId` の有無で、
 *    その理由は数えていない（`data/` の作り直し前は #230 より前の規則で紐づいた票が残っている。docs/ops/etl.md）。
 *    紐づく余地があること自体は突合の規則から言えるので、そちらは上の段落に**規則として**書く。
 * 3. **記録そのものは残る**こと。票以外（発言・議案・質問主意書）も同じで、一次資料へのリンクは生きている。
 *
 * 事実として書き、評価しない。回次も件数もデータから数える（画面に数値を書かない）。
 */
function RosterlessSection({ meta, votes }: { meta: Dataset["meta"]; votes: SangiinVoteLinkStats | null }) {
  const rosterless = rosterlessSessions(meta);
  const range = formatSessionRange(rosterless?.range ?? null);
  const counted = sangiinUnlinkedVotes(votes, rosterless);
  const countedRange = formatSessionRange(counted?.range ?? null);
  if (!rosterless || !range || rosterless.sessions.length === 0) return null;
  return (
    <section className="section" aria-labelledby="coverage-rosterless-heading">
      <h2 id="coverage-rosterless-heading" className="section__title">
        議員ページに紐づかない回次
      </h2>
      <p className="card__body">
        参議院の回次ごとの議員名簿は、<span className="num">第{rosterless.earliestRoster}回</span>より前が公開されていません。そのため{" "}
        <span className="num">{range}</span>（<span className="num">{n(rosterless.sessions.length)}</span> 回次）の票は、
        採決ページには氏名と当時の会派が載りますが、<strong>その多くが議員ページには紐づいていません</strong>。
        氏名だけを手がかりに議員に紐づけることはしていません（同姓同名の別人を 1 人にしないため）。
      </p>
      <p className="card__body">
        現在の名簿と氏名が一致する票も同じです。名簿には任期満了日はありますが<strong>在職開始日にあたる項目が無く</strong>、
        その議員がその回次に在職していたことを一次資料から確認できないためです。
        <strong>在職を確認できない氏名一致では紐づけません</strong>（
        <a href="https://github.com/uonoko1/giinrecord/issues/230" target="_blank" rel="noopener noreferrer">
          Issue #230
        </a>
        ）。名簿より前の回次でも、<strong>より前の回次の名簿に載っていて、任期満了日が採決の日以後である</strong>ことを
        名簿から確認できれば紐づけます。この確認ができる票がどれだけあるかは回次によって違うので、
        名簿より前の回次の票が一律に出ないわけではありません。
      </p>
      <p className="card__body">
        在職開始日は<strong>参議院の議員個人ページにもありません</strong>。個人ページに載る在職の手がかりは
        <span className="num">当選年</span>（「昭和61年、平成4年、10年…」）だけで、<strong>月日がありません</strong>。
        参議院の通常選挙は会期の途中に行われるので、当選した年には選挙の前の回次と後の回次の両方があり、
        年だけではどちらの回次から在職していたかが決まりません（
        <a href="https://github.com/uonoko1/giinrecord/issues/274" target="_blank" rel="noopener noreferrer">
          Issue #274
        </a>
        に調査の記録があります）。ここで書いているのは参議院のサイトに載っている情報についてで、
        <strong>参議院のサイト以外の一次資料は調べていません</strong>。
      </p>
      {counted && countedRange && counted.unlinked > 0 && (
        <p className="card__body">
          名簿より前の <span className="num">{countedRange}</span> にある票は延べ <span className="num">{n(counted.votes)}</span> 件で、
          そのうち議員に紐づいているのは <span className="num">{n(counted.linked)}</span> 件、
          残る <span className="num">{n(counted.unlinked)}</span> 件は<strong>議員ページに出ていません</strong>。
          この数は、いま配信しているデータの採決 1 件ずつを数えた結果です（票に議員の id が入っているかを数えています）。
        </p>
      )}
      <p className="card__body">
        紐づかなかった票も、氏名・当時の会派・採決ページへのリンクはそのまま残ります。
        <strong>発言・議案・質問主意書</strong>も同じで、議員に紐づかなかったものは各記録のページに原文のまま載り、
        一次資料へのリンクも残ります。
      </p>
    </section>
  );
}

/**
 * 国会: 院ごとに個人別の投票記録の有無・回次・件数・議員数。
 * 「個人票が無い」と「データが無い」は別の事実なので、衆院は個人票を「なし」としつつ議案の収録範囲を同じ表に出す。
 */
function DietSection({ diet, metaSessions }: { diet: DietCoverage[]; metaSessions: Coverage["metaSessions"] }) {
  const metaRange = formatSessionRange(metaSessions);
  return (
    <section className="section" aria-labelledby="coverage-diet-heading">
      <h2 id="coverage-diet-heading" className="section__title">
        国会
      </h2>
      {metaRange && metaSessions && (
        <p className="note">
          取得の対象にした回次: <span className="num">{metaRange}</span>（<span className="num">{n(metaSessions.count)}</span> 回次）。
          下の表は、その対象のうち実際に記録のある回次と件数です。
        </p>
      )}
      <div className="assemblies-table-wrap">
        <table className="assemblies-table" aria-label="国会の収録範囲">
          <thead>
            <tr>
              <th scope="col">院</th>
              <th scope="col">記録の種類</th>
              <th scope="col">回次</th>
              <th scope="col">件数</th>
              <th scope="col">議員</th>
              <th scope="col">出典</th>
            </tr>
          </thead>
          <tbody>
            {diet.map((d) => (
              <DietRows key={d.assemblyId} coverage={d} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">
        衆議院は本会議の個人別の投票記録を公表していません。議員ページに出る衆議院の会派の態度は、上の議案情報の「賛成会派／反対会派」に
        その議員の所属会派が載っていたことの記録で、<b>推定</b>として個人の賛否（事実）と分けて表示します。
      </p>
    </section>
  );
}

/**
 * 1 院ぶんの行。個人別の投票（参院のみ）と議案情報は別の記録なので行を分ける
 * （同じ行にすると「個人票が無い＝データが無い」と読めてしまう）。
 */
function DietRows({ coverage: d }: { coverage: DietCoverage }) {
  const rows = [
    {
      key: "votes",
      kind: d.individualVotes ? "個人別の投票（本会議の記名・押しボタン投票）" : "個人別の投票：なし（一次資料に個人票が無い）",
      range: d.rollcallSessions,
      unit: "記名投票",
      count: d.individualVotes ? d.rollcalls : null,
    },
    { key: "bills", kind: "議案情報（提出者・賛成者・各院の結果）", range: d.billSessions, unit: "議案", count: d.bills > 0 ? d.bills : null },
  ];
  return (
    <>
      {rows.map((r, i) => (
        <tr key={r.key}>
          {i === 0 && (
            <th scope="row" rowSpan={rows.length}>
              <Link to={assemblyPath(d.assemblyId)}>{d.name}</Link>
            </th>
          )}
          <td>{r.kind}</td>
          <td className="num">
            <SessionRangeCell range={r.range} unit={r.unit} />
          </td>
          <td className="num">{r.count === null ? "—" : `${n(r.count)} 件`}</td>
          {i === 0 && (
            <td className="num" rowSpan={rows.length}>
              {n(d.members)} 名
            </td>
          )}
          {i === 0 && (
            <td rowSpan={rows.length}>
              <a href={d.sourceUrl} target="_blank" rel="noopener noreferrer">
                議員一覧（公式）
              </a>
            </td>
          )}
        </tr>
      ))}
    </>
  );
}

/** 地方議会: 議会ごとに会期の範囲・表決数・議員数・会期ごとの取得元（一次資料） */
function LocalSection({ local }: { local: LocalCoverage[] }) {
  return (
    <section className="section" aria-labelledby="coverage-local-heading">
      <h2 id="coverage-local-heading" className="section__title">
        地方議会
      </h2>
      {local.length === 0 ? (
        <p className="note">地方議会のデータはまだありません。</p>
      ) : (
        local.map((a) => <LocalAssembly key={a.assemblyId} coverage={a} />)
      )}
    </section>
  );
}

function LocalAssembly({ coverage: a }: { coverage: LocalCoverage }) {
  const range = formatLocalSessionRange(a);
  return (
    <section className="coverage-assembly" aria-label={a.name}>
      <h3 className="coverage-assembly__name">
        <Link to={assemblyPath(a.assemblyId)}>{a.name}</Link>
      </h3>
      <dl className="assembly-facts">
        <div className="assembly-facts__item">
          <dt>種別</dt>
          <dd>{KIND_LABEL[a.kind]}</dd>
        </div>
        <div className="assembly-facts__item">
          <dt>会期</dt>
          <dd>{range ?? "会期の一覧は未取得です。"}</dd>
        </div>
        <div className="assembly-facts__item">
          <dt>表決</dt>
          <dd className="num">
            {n(a.rollcalls)} 件（{n(a.sessions)} 会期）
          </dd>
        </div>
        <div className="assembly-facts__item">
          <dt>議員</dt>
          <dd className="num">{n(a.members)} 名</dd>
        </div>
        <div className="assembly-facts__item">
          <dt>名簿</dt>
          <dd>
            <a href={a.sourceUrl} target="_blank" rel="noopener noreferrer">
              議員名簿（公式）
            </a>
          </dd>
        </div>
      </dl>
      {a.sources.length > 0 && (
        <div className="assemblies-table-wrap">
          <table className="assembly-sessions" aria-label={`${a.name}の取得元`}>
            <thead>
              <tr>
                <th scope="col">会期</th>
                <th scope="col">議決日</th>
                <th scope="col">表決</th>
                <th scope="col">取得元</th>
              </tr>
            </thead>
            <tbody>
              {a.sources.map((s) => (
                <tr key={s.id}>
                  <td>{s.label}</td>
                  <td className="num">
                    <time dateTime={s.date}>{formatDate(s.date)}</time>
                  </td>
                  <td className="num">{n(s.rollcalls)} 件</td>
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
  );
}
