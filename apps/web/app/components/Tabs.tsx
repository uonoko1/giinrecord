import { useEffect, useRef, type KeyboardEvent } from "react";

export type TabKey = "all" | "vote" | "bill" | "speech";

export const TABS: { key: TabKey; label: string }[] = [
  { key: "all", label: "すべて" },
  { key: "vote", label: "採決" },
  { key: "bill", label: "提出法案" },
  { key: "speech", label: "発言" },
];

/** APG Tabs pattern: Arrow keys wrap, Home/End jump to first/last. */
function nextIndex(key: string, current: number, count: number): number | null {
  switch (key) {
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

export function Tabs({ value, onChange }: { value: TabKey; onChange: (key: TabKey) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const selectedIndex = TABS.findIndex((t) => t.key === value);

  // Roving tabindex: when the selection moves via keyboard, keep focus on the selected tab.
  useEffect(() => {
    const list = listRef.current;
    if (list && list.contains(document.activeElement)) {
      refs.current[selectedIndex]?.focus();
    }
  }, [selectedIndex]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const target = nextIndex(e.key, selectedIndex, TABS.length);
    if (target === null) return;
    e.preventDefault();
    onChange(TABS[target].key);
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="記録の種類"
      style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--rule)", padding: "0 20px" }}
    >
      {TABS.map((t, i) => {
        const selected = i === selectedIndex;
        return (
          <button
            key={t.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.key)}
            onKeyDown={onKeyDown}
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
