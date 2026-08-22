export function meta() {
  return [{ title: "このデータについて ・ 政治記録" }];
}

export default function About() {
  return (
    <main style={{ padding: "24px 20px" }}>
      <h1 style={{ fontFamily: "var(--font-head)" }}>このデータについて</h1>
      <p>このサイトは国会の公式記録を整形して並べるだけです。評価・採点・推薦はしません。すべての行に出典があります。</p>
    </main>
  );
}
