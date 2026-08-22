import { useId, useMemo, useState } from "react";
import { Link, type MetaArgs } from "react-router";
import { type Dataset, dataset as bundled, type MemberSummary } from "../lib/dataset";
import { formatDateTime } from "../lib/format";
import { filterMembers, formatTermEnd, groupByKanaRow } from "../lib/member-search";
import { seoMeta } from "../lib/seo";
import "../styles/pages.css";
import "./members.css";

const DESCRIPTION = "参議院議員を五十音順に。氏名・ふりがな・会派・選挙区でさがせます。";

export function meta({ location }: MetaArgs) {
  return seoMeta({ title: "参議院議員一覧", description: DESCRIPTION, pathname: location.pathname });
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
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("");
  const [district, setDistrict] = useState("");
  const [includeFormer, setIncludeFormer] = useState(false);
  const searchId = useId();
  const formerId = useId();
  const groupId = useId();
  const districtId = useId();

  const sangiin = useMemo(() => data.members.filter((m) => m.house === "sangiin"), [data.members]);
  // 既定は現職（最新回次の名簿に載っている人）のみ。元職は事実として残っているので、トグルで同じ一覧に出す。
  const all = useMemo(() => (includeFormer ? sangiin : sangiin.filter((m) => m.current !== false)), [sangiin, includeFormer]);
  const groups = useMemo(() => distinctSorted(all.map((m) => m.group)), [all]);
  const districts = useMemo(() => distinctSorted(all.map((m) => m.district)), [all]);
  const hits = useMemo(() => filterMembers(all, { query, group, district }), [all, query, group, district]);
  const sections = useMemo(() => groupByKanaRow(hits), [hits]);

  return (
    <main className="page members">
      <header className="cover">
        <div className="cover__brand">
          <Link to="/">政治記録</Link>
        </div>
        <h1 className="cover__title">参議院議員</h1>
        <p className="cover__lead">{DESCRIPTION}</p>
      </header>

      {sangiin.length === 0 ? (
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
                      <MemberRow key={m.id} member={m} />
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
        <span>出典：参議院「議員一覧」。各議員ページに公式プロフィールへのリンクがあります。</span>
      </footer>
    </main>
  );
}

function MemberRow({ member }: { member: MemberSummary }) {
  const term = formatTermEnd(member.termEnd);
  return (
    <li className="members-item">
      <Link className="members-item__link" to={`/members/${member.id}`}>
        <span className="members-item__kana">{member.kana}</span>
        <span className="members-item__name">{member.name}</span>
      </Link>
      <span className="members-item__meta num">
        {[member.group, member.district, term, member.current === false ? "元職" : undefined].filter(Boolean).join(" ・ ")}
      </span>
    </li>
  );
}
