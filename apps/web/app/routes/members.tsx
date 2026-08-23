import { useEffect, useId, useMemo, useState } from "react";
import { Link, type MetaArgs, useSearchParams } from "react-router";
import type { Assembly, AssemblyId } from "@seiji-kiroku/shared";
import { CoverBrand } from "../components/CoverBrand";
import { DIET_ASSEMBLIES } from "../lib/data-contract";
import { type Dataset, dataset as bundled, type MemberSummary } from "../lib/dataset";
import { formatDateTime } from "../lib/format";
import { filterMembers, formatTermEnd, groupByKanaRow, memberAssemblyId } from "../lib/member-search";
import { seoMeta } from "../lib/seo";
import "../styles/pages.css";
import "./members.css";

const DESCRIPTION = "参議院・衆議院の議員を五十音順に。氏名・ふりがな・議会・会派・選挙区でさがせます。";

export function meta({ location }: MetaArgs) {
  return seoMeta({ title: "国会議員一覧", description: DESCRIPTION, pathname: location.pathname });
}

const collator = new Intl.Collator("ja");

/** 値の重複を除き、五十音順（日本語 collation）に並べる */
function distinctSorted(values: string[]): string[] {
  return [...new Set(values)].filter(Boolean).sort(collator.compare);
}

/**
 * index.json はビルド時にバンドルされ、以降はブラウザ内だけで絞り込む（追加フェッチなし）。
 * データ取得前（0名）でも落ちない。
 */
export default function Members({ data = bundled }: { data?: Dataset }) {
  // #112: Home の郵便番号入力から /members?district=<名簿の表記> で来る。プリレンダーは既存のまま、クエリはクライアント側で読む。
  const [params, setParams] = useSearchParams();
  const districtParam = params.get("district") ?? "";
  const [query, setQuery] = useState("");
  // #156: 院（参院／衆院）の絞り込みを「議会」に一般化。選択肢は assemblies/index.json の並び（国会2＋将来の地方議会）。既定はすべて。
  const [assemblyId, setAssemblyId] = useState<AssemblyId | "">("");
  const [group, setGroup] = useState("");
  // #120: 初期値は "" にして useEffect で適用する。プリレンダーの HTML は「すべて」が選ばれたままで、hydration は
  // state が最初から districtParam だと DOM の selected を直さない（再描画が起きない）。マウント後に set して再描画させる。
  // 同じ理由でクエリが後から変わったとき（戻る／進む）も追従する。
  const [district, setDistrict] = useState("");
  useEffect(() => setDistrict(districtParam), [districtParam]);
  const [includeFormer, setIncludeFormer] = useState(false);
  const searchId = useId();
  const formerId = useId();
  const groupId = useId();
  const assemblyFieldId = useId();
  const districtId = useId();

  // 議会を切り替えると会派・選挙区の選択肢が変わる（参院の会派や選挙区はほぼ衆院に存在しない）ので、
  // 旧い選択を残すと select は「すべて」に見えるのに 0 名になる。議会の変更時はまとめてリセットする。
  function changeAssembly(next: AssemblyId | "") {
    setAssemblyId(next);
    setGroup("");
    clearDistrict();
  }

  function clearDistrict() {
    setDistrict("");
    if (districtParam) {
      const next = new URLSearchParams(params);
      next.delete("district");
      setParams(next, { replace: true });
    }
  }

  // assemblies/index.json が無い（#156 より前の）データは国会の2議会として扱う。
  const assemblies: readonly Assembly[] = data.assemblies ?? DIET_ASSEMBLIES;
  const assemblyName = useMemo(() => new Map(assemblies.map((a) => [a.id, a.name])), [assemblies]);
  // 既定はすべての議会・現職（最新回次の名簿に載っている人）のみ。元職は事実として残っているので、トグルで同じ一覧に出す。
  const all = useMemo(
    () => data.members.filter((m) => (!assemblyId || memberAssemblyId(m) === assemblyId) && (includeFormer || m.current !== false)),
    [data.members, assemblyId, includeFormer],
  );
  const groups = useMemo(() => distinctSorted(all.map((m) => m.group)), [all]);
  const districts = useMemo(() => distinctSorted(all.map((m) => m.district)), [all]);
  const hits = useMemo(() => filterMembers(all, { query, group, district }), [all, query, group, district]);
  const sections = useMemo(() => groupByKanaRow(hits), [hits]);

  return (
    <main className="page members">
      <header className="cover">
        <CoverBrand to="/" />
        <h1 className="cover__title">国会議員</h1>
        <p className="cover__lead">{DESCRIPTION}</p>
      </header>

      {data.members.length === 0 ? (
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
                <select id={groupId} className="members-select" value={group} onChange={(e) => setGroup(e.target.value)}>
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
                <select id={districtId} className="members-select" value={district} onChange={(e) => setDistrict(e.target.value)}>
                  <option value="">すべて</option>
                  {districts.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {districtParam && (
              <p className="members-chips" aria-label="絞り込み中">
                <span className="members-chip">
                  <span>選挙区：{districtParam}</span>
                  <button type="button" className="members-chip__clear" aria-label="選挙区の絞り込みを解除" onClick={clearDistrict}>
                    ×
                  </button>
                </span>
              </p>
            )}
            <label className="members-check" htmlFor={formerId}>
              <input id={formerId} type="checkbox" checked={includeFormer} onChange={(e) => setIncludeFormer(e.target.checked)} />
              <span>元職も含める</span>
            </label>
            <p className="members-count" aria-live="polite">
              <span className="num">{hits.length.toLocaleString("ja-JP")} 名</span>
              {hits.length !== all.length && <span className="members-count__of">／ {all.length.toLocaleString("ja-JP")} 名</span>}
            </p>
          </section>

          <section className="section" aria-label="議員一覧">
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
