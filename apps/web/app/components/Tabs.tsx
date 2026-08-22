export type TabKey = "all" | "vote" | "bill" | "speech";

export const TABS: { key: TabKey; label: string }[] = [
  { key: "all", label: "すべて" },
  { key: "vote", label: "採決" },
  { key: "bill", label: "提出法案" },
  { key: "speech", label: "発言" },
];

export function Tabs({ value, onChange }: { value: TabKey; onChange: (key: TabKey) => void }) {
  return (
    <div role="tablist" aria-label="記録の種類" style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--rule)", padding: "0 20px" }}>
      {TABS.map((t) => {
        const selected = t.key === value;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.key)}
            style={{
              appearance: "none",
              background: "none",
              border: 0,
              borderBottom: `2px solid ${selected ? "var(--brass)" : "transparent"}`,
              marginBottom: -1,
              padding: "10px 12px",
              color: selected ? "var(--ink)" : "var(--muted)",
              fontFamily: "var(--font-body)",
              fontSize: 14,
              fontWeight: selected ? 700 : 400,
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
