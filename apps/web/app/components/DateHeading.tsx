/** 日付（真鍮）＋ラベル。`date` は ISO 日付（YYYY-MM-DD）。 */
export function DateHeading({ date, label }: { date: string; label?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "16px 20px 6px", borderBottom: "1px solid var(--rule)" }}>
      <time
        dateTime={date}
        style={{ color: "var(--brass)", fontFamily: "var(--font-head)", fontSize: 15, fontWeight: 700, letterSpacing: "0.06em", fontVariantNumeric: "tabular-nums" }}
      >
        {date}
      </time>
      {label ? <span style={{ color: "var(--muted)", fontSize: 13 }}>{label}</span> : null}
    </div>
  );
}
