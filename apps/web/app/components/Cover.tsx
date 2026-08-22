import type { House } from "@seiji-kiroku/shared";

export interface CoverProps {
  name: string;
  kana: string;
  house: House;
  group: string;
  district: string;
  counts: { rollcalls: number; bills: number; speeches: number };
}

const houseLabel: Record<House, string> = { sangiin: "参議院", shugiin: "衆議院" };

/** 墨藍の表紙。氏名・ふりがな・所属・件数帯。 */
export function Cover({ name, kana, house, group, district, counts }: CoverProps) {
  const items = [
    { label: "採決", n: counts.rollcalls },
    { label: "提出法案", n: counts.bills },
    { label: "発言", n: counts.speeches },
  ];
  return (
    <header style={{ background: "var(--cover)", color: "var(--cover-fg)", padding: 20, borderBottom: "1px solid var(--rule)" }}>
      <p style={{ margin: 0, fontSize: 13, letterSpacing: "0.1em", opacity: 0.85 }}>{kana}</p>
      <h1 style={{ margin: "4px 0 12px", fontFamily: "var(--font-head)", fontSize: 40, fontWeight: 800, lineHeight: 1.2 }}>{name}</h1>
      <p style={{ margin: 0, fontSize: 14 }}>
        {houseLabel[house]}・{group}・{district}
      </p>
      <ul
        aria-label="記録件数"
        style={{ display: "flex", gap: 24, listStyle: "none", margin: "16px 0 0", padding: "12px 0 0", borderTop: "1px solid var(--brass-on-cover)" }}
      >
        {items.map((it) => (
          <li key={it.label} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 12, color: "var(--brass-on-cover)", letterSpacing: "0.08em" }}>{it.label}</span>
            <span style={{ fontFamily: "var(--font-head)", fontSize: 24, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{it.n}</span>
          </li>
        ))}
      </ul>
    </header>
  );
}
