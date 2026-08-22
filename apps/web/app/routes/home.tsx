export function meta() {
  return [{ title: "政治記録" }, { name: "description", content: "国会議員が本会議でどう投票し、どの法案を出し、何を発言したか。公式記録だけを、そのまま並べます。" }];
}

export default function Home() {
  return (
    <main style={{ padding: "24px 20px" }}>
      <h1 style={{ fontFamily: "var(--font-head)" }}>言ったことではなく、やったことを。</h1>
      <p>国会議員が本会議でどう投票し、どの法案を出し、何を発言したか。公式記録だけを、そのまま並べます。評価はしません。</p>
    </main>
  );
}
