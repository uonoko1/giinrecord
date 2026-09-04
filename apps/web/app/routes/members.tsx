import { useEffect, useId, useMemo, useState } from "react";
import { Link, type MetaArgs, useSearchParams } from "react-router";
import type { Assembly, AssemblyId } from "@seiji-kiroku/shared";
import { CoverBrand } from "../components/CoverBrand";
import { SiteFooter } from "../components/SiteFooter";
import { MoreButton } from "../components/MoreButton";
import { DIET_ASSEMBLIES } from "../lib/data-contract";
import { type Dataset, dataset as bundled, type MemberSummary } from "../lib/dataset";
import { members as bundledMembers } from "../lib/members";
import { formatDateTime } from "../lib/format";
import {
  filterMembers,
  foldKanaGroups,
  MEMBERS_FOLD,
  formatTermEnd,
  groupByKanaRow,
  memberAssemblyId,
  membersDescription,
  membersHeading,
  type MembersScope,
  membersQueryString,
  membersScopeFromQuery,
} from "../lib/member-search";
import { metaIdentity, seoMeta, staleHeadTags } from "../lib/seo";
import "../styles/pages.css";
import "./members.css";

/**
 * #239: <title>・description・OGP も絞り込みを反映する。クエリはプリレンダーされないので、
 * ビルド時（クエリ無し）は「収録している議会の現職議員」、ブラウザで絞り込むと同じ meta が更新される。
 * 会派・選挙区は名簿と照合してから使う（存在しない名前を <title>・og:title に出さない）。
 * canonical は seoMeta が pathname だけから作る（クエリ違いを別ページにしない）。
 */
export function meta({ location }: MetaArgs) {
  const scope = membersScopeFromQuery(new URLSearchParams(location.search), bundled.assemblies ?? DIET_ASSEMBLIES, bundledMembers);
  return seoMeta({ title: membersHeading(scope), description: membersDescription(scope), pathname: location.pathname });
}

const collator = new Intl.Collator("ja");

/** 値の重複を除き、五十音順（日本語 collation）に並べる */
function distinctSorted(values: string[]): string[] {
  return [...new Set(values)].filter(Boolean).sort(collator.compare);
}

/**
 * #239: クエリ付きで直接開いた（＝ブックマーク・共有リンク・リロード）とき、プリレンダーの HTML が持つ
 * クエリ無しの description・og:* が head に残り、React が足した正しいものと二重になる（title は二重にならない）。
 * 同じ name/property が複数あるとき最後の1つ（＝React が今書いたもの）だけを残す。
 */
function useSingleHeadMeta(deps: unknown[]) {
  // deps は「meta() の出力が変わったか」の目印。変わるたびに head を掃除する。
  useEffect(() => {
    for (const el of staleHeadTags([...document.head.querySelectorAll("meta")], metaIdentity)) el.remove();
  }, deps);
}

/**
 * index.json はビルド時にバンドルされ、以降はブラウザ内だけで絞り込む（追加フェッチなし）。
 * データ取得前（0名）でも落ちない。
 */
/**
 * Issue 441: 名簿の全件（`members/index.json`）は `Dataset` から出して **lib/members.ts** に分けた
 * （数えるだけの `/`・`/assemblies`・`/coverage` まで gzip 40KB を読んでいたため）。
 * **この画面は従来どおり全件を読む**——一覧に `name`・`kana`・`group`・`district`・`termEnd` を全部出すので。
 */
export default function Members({ data = bundled, members = bundledMembers }: { data?: Dataset; members?: readonly MemberSummary[] }) {
  // #112 / #158 / #239: 議会・会派・選挙区・元職の有無は URL のクエリに持つ（?assembly=&group=&district=&former=1）。
  // ブックマーク・共有・戻る／進むが効き、見出しと表示内容が必ず一致する。絞り込み自体はここまでにバンドル
  // 済みの index.json に対して行うので、URL が変わってもサーバーへの往復は増えない（fetch も loader も無い）。
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const searchId = useId();
  const formerId = useId();
  const listId = useId();
  const groupId = useId();
  const assemblyFieldId = useId();
  const districtId = useId();

  // assemblies/index.json が無い（#156 より前の）データは国会の2議会として扱う。
  const assemblies: readonly Assembly[] = data.assemblies ?? DIET_ASSEMBLIES;
  const assemblyName = useMemo(() => new Map<string, string>(assemblies.map((a) => [a.id, a.name])), [assemblies]);

  // #120: プリレンダーの HTML は「すべて」が選ばれたままで、hydration はクエリ由来の値を最初から持っていても
  // DOM の selected を直さない（再描画が起きない）。だから描画にはこの state を使い、マウント後・クエリ変更後
  // （戻る／進むを含む）に URL から同期して再描画させる。
  const queried = useMemo(() => membersScopeFromQuery(params, assemblies, members), [params, assemblies, members]);
  const [scope, setScope] = useState<MembersScope>({ assemblyId: "", assemblyName: undefined, group: "", district: "", includeFormer: false });
  useEffect(() => setScope(queried), [queried]);
  const { assemblyId, group, district, includeFormer } = scope;

  /** 絞り込みを state と URL の両方に書く。履歴に積むのでブラウザの戻る／進むで前の絞り込みに戻る。 */
  function applyScope(next: Pick<MembersScope, "assemblyId" | "group" | "district" | "includeFormer">) {
    setScope({ ...next, assemblyName: assemblyName.get(next.assemblyId) });
    setParams(membersQueryString(next));
  }

  // 議会を切り替えると会派・選挙区の選択肢が変わる（参院の会派や選挙区はほぼ衆院に存在しない）ので、
  // 旧い選択を残すと select は「すべて」に見えるのに 0 名になる。議会の変更時はまとめてリセットする。
  function changeAssembly(next: AssemblyId | "") {
    applyScope({ ...scope, assemblyId: next, group: "", district: "" });
  }

  function clearDistrict() {
    applyScope({ ...scope, district: "" });
  }

  // 元職を外すと、元職しかいない会派・選挙区は選択肢から消える。選んだままだと select は「すべて」に見えるのに
  // 0 名になるので、議会を切り替えたときと同じ理由でその絞り込みは落とす。
  function changeIncludeFormer(next: boolean) {
    applyScope(next ? { ...scope, includeFormer: true } : { ...scope, includeFormer: false, group: "", district: "" });
  }

  // 既定はすべての議会・現職（最新回次の名簿に載っている人）のみ。元職は事実として残っているので、トグルで同じ一覧に出す。
  const all = useMemo(
    () => members.filter((m) => (!assemblyId || memberAssemblyId(m) === assemblyId) && (includeFormer || m.current !== false)),
    [members, assemblyId, includeFormer],
  );
  const groups = useMemo(() => distinctSorted(all.map((m) => m.group)), [all]);
  const districts = useMemo(() => distinctSorted(all.map((m) => m.district)), [all]);
  const hits = useMemo(() => filterMembers(all, { query, group, district }), [all, query, group, district]);
  const allSections = useMemo(() => groupByKanaRow(hits), [hits]);
  // 絞り込んでいる間は折りたたまない（#340）。絞った結果が 200 名を超えることは稀で、
  // 絞った上でさらに「さらに表示」を押させるのは煩わしい。全件を眺めるときだけ効かせる。
  const filtering = query !== "" || group !== "" || district !== "";
  const [expanded, setExpanded] = useState(false);
  const fold = useMemo(
    () => (filtering || expanded ? { groups: allSections, hidden: 0 } : foldKanaGroups(allSections, MEMBERS_FOLD)),
    [allSections, filtering, expanded],
  );
  const sections = fold.groups;
  // 見出し・説明は「いま表示している一覧」そのもの。件数（hits.length）と同じ絞り込みから作る。
  const heading = membersHeading(scope);
  const description = membersDescription(scope);
  useSingleHeadMeta([description]);

  return (
    <>
      <main className="page members">
        <header className="cover">
          <CoverBrand to="/" />
          <h1 className="cover__title">{heading}</h1>
          <p className="cover__lead">{description}</p>
        </header>

        {members.length === 0 ? (
          <section className="section">
            <p className="note">取得前です。</p>
          </section>
        ) : (
          <>
            <section className="section members-controls" aria-label="絞り込み">
              <label className="members-field" htmlFor={searchId}>
                <span className="members-field__label">氏名・ふりがな</span>
                <input
                  id={searchId}
                  type="search"
                  className="members-input"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="例：ふじかわ"
                  autoComplete="off"
                />
              </label>
              <div className="members-selects">
                <label className="members-field" htmlFor={assemblyFieldId}>
                  <span className="members-field__label">議会</span>
                  <select id={assemblyFieldId} className="members-select" value={assemblyId} onChange={(e) => changeAssembly(e.target.value as AssemblyId | "")}>
                    <option value="">すべて</option>
                    {assemblies.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="members-field" htmlFor={groupId}>
                  <span className="members-field__label">会派</span>
                  <select id={groupId} className="members-select" value={group} onChange={(e) => applyScope({ ...scope, group: e.target.value })}>
                    <option value="">すべて</option>
                    {groups.map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="members-field" htmlFor={districtId}>
                  <span className="members-field__label">選挙区</span>
                  <select id={districtId} className="members-select" value={district} onChange={(e) => applyScope({ ...scope, district: e.target.value })}>
                    <option value="">すべて</option>
                    {districts.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {district && (
                <p className="members-chips" aria-label="絞り込み中">
                  <span className="members-chip">
                    <span>選挙区：{district}</span>
                    <button type="button" className="members-chip__clear" aria-label="選挙区の絞り込みを解除" onClick={clearDistrict}>
                      ×
                    </button>
                  </span>
                </p>
              )}
              <label className="members-check" htmlFor={formerId}>
                <input id={formerId} type="checkbox" checked={includeFormer} onChange={(e) => changeIncludeFormer(e.target.checked)} />
                <span>元職も含める</span>
              </label>
              {/*
                絞り込みを変えると <h1> とリード文が書き換わるが、見出しの差し替えは支援技術に通知されない。
                件数だけでは「いま何の一覧を見ているか」が変わったことが伝わらないので、見出しと件数を
                ひとつの文にして読み上げる。画面には出さない（見えている h1・件数と重複するため）。
              */}
              {/* 折りたたみ中は「該当◯名／表示◯名」を読み上げる。実 DOM に無い人数だけを伝えると、
                  直列に読む利用者は該当分を最後まで辿れると思って読み進めることになる（#340） */}
              <p className="members-status" role="status">
                {heading}　{hits.length.toLocaleString("ja-JP")} 名
                {fold.hidden > 0 && `（うち ${(hits.length - fold.hidden).toLocaleString("ja-JP")} 名を表示中）`}
              </p>
              <p className="members-count" aria-hidden="true">
                <span className="num">{hits.length.toLocaleString("ja-JP")} 名</span>
                {hits.length !== all.length && <span className="members-count__of">／ {all.length.toLocaleString("ja-JP")} 名</span>}
              </p>
            </section>

            <section className="section" aria-label="議員一覧" id={listId}>
              {sections.length === 0 ? (
                <p className="note">該当する議員はいません。</p>
              ) : (
                sections.map((s) => (
                  <div key={s.row} className="members-row-group">
                    <h2 className="members-row-heading" id={`row-${s.row}`}>
                      {s.row}
                    </h2>
                    <ul className="members-list" aria-labelledby={`row-${s.row}`}>
                      {s.members.map((m) => (
                        <MemberRow key={m.id} member={m} assemblyName={assemblyId === "" ? assemblyName : undefined} />
                      ))}
                    </ul>
                  </div>
                ))
              )}
              <MoreButton hidden={fold.hidden} unit="名" className="members" controls={listId} onExpand={() => setExpanded(true)} />
            </section>
          </>
        )}

        <footer className="section members-source">
          {data.meta ? (
            <span>
              取得 <time dateTime={data.meta.fetchedAt}>{formatDateTime(data.meta.fetchedAt)}</time>
            </span>
          ) : null}
          <span>出典：参議院「議員一覧」、衆議院「議員一覧」。各議員ページに公式プロフィールへのリンクがあります。</span>
        </footer>
      </main>
      <SiteFooter />
    </>
  );
}

/** すべての議会を表示しているとき（assemblyName あり）は各行に議会名を添える。名称は assemblies/index.json の原文。 */
function MemberRow({ member, assemblyName }: { member: MemberSummary; assemblyName?: ReadonlyMap<string, string> }) {
  const term = formatTermEnd(member.termEnd);
  const assembly = assemblyName?.get(memberAssemblyId(member));
  return (
    <li className="members-item">
      <Link className="members-item__link" to={`/members/${member.id}`}>
        <span className="members-item__kana">{member.kana}</span>
        <span className="members-item__name">{member.name}</span>
      </Link>
      <span className="members-item__meta num">
        {[assembly, member.group, member.district, term, member.current === false ? "元職" : undefined]
          .filter(Boolean)
          .join(" ・ ")}
      </span>
    </li>
  );
}
