/** 出典と取得日時。すべての記録はこの行を持つ。 */
export function SourceLine({ sourceUrl, sourceName, fetchedAt }: { sourceUrl: string; sourceName?: string; fetchedAt: string }) {
  return (
    <footer style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", padding: "8px 20px", color: "var(--muted)", fontSize: 12, borderTop: "1px solid var(--rule)" }}>
      <a href={sourceUrl} target="_blank" rel="noopener noreferrer">
        出典{sourceName ? `：${sourceName}` : ""}
      </a>
      <span>
        取得 <time dateTime={fetchedAt}>{fetchedAt}</time>
      </span>
    </footer>
  );
}
